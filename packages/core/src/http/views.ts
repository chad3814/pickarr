import type { DatabaseSync } from 'node:sqlite';
import type {
  DisplayFields,
  MediaTypePlugin,
  ParsedRelease,
  QualityTokens,
} from '@pickarr/plugin-api';
import { failedReleaseIds, type GroupRow } from '../db/groups.ts';
import { releasesForGroup } from '../db/releases.ts';
import type { DownloadRow } from '../db/downloads.ts';
import type { FeedItemRow } from '../db/feed-items.ts';
import type { GroupMetadata } from '../db/metadata.ts';
import type { UntrackedEntry } from '../pipeline/reconcile.ts';
import { str, type SqlRow } from '../db/row.ts';

/**
 * What browse (and `GET /api/metadata`) can say about a group's scene
 * metadata. `'pending'` and `'absent'` only ever come from the standalone
 * metadata endpoint — it is the only caller that also consults
 * `metadata_queue` to tell "asked, not yet answered" from "never asked" —
 * while `metadataViewOf` answers browse's simpler question (is there a
 * recorded answer at all) from `group_metadata` alone.
 */
export type MetadataView =
  | {
      state: 'confirmed';
      title: string | null;
      performers: string[];
      releaseDate: string | null;
      durationSeconds: number | null;
      synopsis: string | null;
      hasPoster: boolean;
    }
  | { state: 'none' }
  | { state: 'pending' }
  | { state: 'absent' };

/**
 * `metadata` is what `metadataForGroups` found for this one group, already
 * read for the whole page in a single query — never fetched here per group,
 * which is exactly the `/api/downloads` defect (issue #31) this file must not
 * reacquire. `queued` is only meaningful to a caller that has also checked
 * `metadata_queue`; browse never does; the default keeps its groups reading
 * `'absent'` rather than a `'pending'` it has no evidence for.
 */
export function metadataViewOf(metadata: GroupMetadata | undefined, queued = false): MetadataView {
  if (metadata === undefined) return queued ? { state: 'pending' } : { state: 'absent' };
  if (metadata.state === 'none') return { state: 'none' };
  return {
    state: 'confirmed',
    title: metadata.title,
    performers: metadata.performers,
    releaseDate: metadata.releaseDate,
    durationSeconds: metadata.durationSeconds,
    synopsis: metadata.synopsis,
    hasPoster: metadata.posterPath !== null,
  };
}

export interface ReleaseView {
  id: number;
  score: number;
  quality: QualityTokens;
  releaseName: string;
  publishedAt: number | null;
  /** The quality half of an edit form, prefilled. Absent when the plugin has no `toManualValues`. */
  manualValues?: Record<string, string>;
  /**
   * True when this release's most recent download failed, and **absent**
   * otherwise — never `false`. Per release rather than per group because the
   * card has to say *which* version failed: the group flag only gets the user
   * to the card.
   */
  downloadFailed?: boolean;
}

export interface GroupView {
  id: number;
  plugin: string;
  display: DisplayFields;
  state: 'new' | 'picked';
  pickedReleaseId: number | null;
  upgradeReleaseId: number | null;
  listRankAt: number;
  releases: ReleaseView[];
  metadata: MetadataView;
  /** The identity half of an edit form, prefilled. Absent when the plugin has no `toManualValues`. */
  manualValues?: Record<string, string>;
  // No group-level "something here failed" field. There was one, and nothing
  // read it: the card marks rows from `ReleaseView.downloadFailed`, and the
  // ordering it would have explained is decided in SQL by `pickedGroups`, which
  // the client never re-derives. A payload field whose only exercise is a test
  // asserting something no screen consumes is a field to add when a screen
  // wants it.
}

export interface BrowseResponse {
  groups: GroupView[];
  nextCursor: string | null;
}

/** One name the parser refused, and everything a human needs to describe it. */
export interface FailedItemView {
  id: number;
  feedId: string;
  /** The plugin id, so the SPA picks the right schema. Empty when the feed has left configuration. */
  plugin: string;
  rawTitle: string;
  link: string;
  parseError: string;
  firstSeenAt: number;
  publishedAt: number | null;
  suggestedValues: Record<string, string>;
  dismissedAt: number | null;
}

export interface FailedResponse {
  items: FailedItemView[];
  nextCursor: string | null;
}

export interface ResolveResponse {
  group: GroupView;
  joinedExisting: boolean;
}

/**
 * `group` is the *surviving* group, which on a merge is the target rather than
 * the one that was patched. `mergedInto` names it, and is null when nothing
 * merged; the client knows the source id because it sent it, so those two
 * together are what let it drop one card and replace another.
 */
export interface GroupEditResponse {
  group: GroupView;
  mergedInto: number | null;
}

/**
 * `group` is the edited release's group as the browse list sees it afterwards,
 * and null means it left: rescoring re-derives the upgrade flag, and a picked
 * group listed only because something better was on offer drops out when the
 * edit takes that away. Same contract as `PickResponse`, for the same reason —
 * a client that cannot be told keeps showing a card whose Pick queues an
 * upgrade over the file it just downgraded.
 */
export interface ReleaseEditResponse {
  group: GroupView | null;
}

export interface DownloadView {
  id: number;
  groupId: number;
  releaseId: number;
  title: string;
  kind: 'initial' | 'upgrade';
  status: string;
  error: string | null;
  attempts: number;
  updatedAt: number;
}

export interface DownloadsResponse {
  tracked: DownloadView[];
  untracked: UntrackedEntry[];
}

/**
 * `group` is the picked group's standing in the *browse* list afterwards: its
 * refreshed view, or `null` when the pick took it out of that list. It lets a
 * paginated browse patch the one card that changed instead of refetching, and
 * refetching was not a harmless shortcut — it threw away every page past the
 * first, so picking anything after "Load more" snapped the list back to one
 * page.
 *
 * The server answers this because the server owns the rule (`BROWSABLE` in
 * db/groups.ts). A client deciding for itself from `state` and
 * `upgradeReleaseId` would be a second copy of that rule, free to drift.
 */
export interface PickResponse {
  download: DownloadView;
  group: GroupView | null;
}

/**
 * An edit form's prefill, or nothing at all.
 *
 * Nothing, rather than an empty object, for a plugin that cannot read values
 * back: the field's absence is how the SPA decides whether to offer an Edit
 * control, so an empty object would put a form in front of a plugin that has
 * no `fromManualValues` to save it with.
 *
 * The catch is not the guard `suggestManualValues` needs — that hook's contract
 * forbids throwing — but the one this call site needs. `toManualValues` makes
 * no such promise, and it is called here once per group and once per release on
 * every browse page: unguarded, one plugin that throws on one stored record
 * takes down the whole list rather than one card's Edit button.
 */
function manualValuesFor(
  plugin: MediaTypePlugin | undefined,
  media: ParsedRelease,
): Record<string, string> | undefined {
  const toValues = plugin?.toManualValues;
  if (plugin === undefined || toValues === undefined) return undefined;
  try {
    return toValues.call(plugin, media);
  } catch {
    return undefined;
  }
}

/**
 * `plugin` is the one registered for `group.plugin`, or undefined when no
 * plugin claims that id any more — a group outlives the package that made it.
 *
 * The prefill values are assembled here rather than nearer the rows they
 * describe because `toManualValues` takes a whole `ParsedRelease`: a release
 * carries only the quality half, and the identity half lives on the group. This
 * is the only place both are in hand.
 */
export function toGroupView(
  db: DatabaseSync,
  group: GroupRow,
  plugin: MediaTypePlugin | undefined,
  metadata: GroupMetadata | undefined,
): GroupView {
  const display = JSON.parse(group.display) as DisplayFields;

  // Asked once for the group, not once per release, and by the same query
  // `pickedGroups` sorts on — so a card hoisted to the top of Picks always has
  // the row on it that explains why.
  const failed = failedReleaseIds(db, group.id);

  const releases = releasesForGroup(db, group.id).map((release) => {
    const feedItem = db
      .prepare('SELECT raw_title, published_at FROM feed_items WHERE id = ?')
      .get(release.feedItemId);
    const quality = JSON.parse(release.quality) as QualityTokens;
    const manualValues = manualValuesFor(plugin, {
      identityKey: group.identityKey,
      display,
      quality,
    });
    const view: ReleaseView = {
      id: release.id,
      score: release.score,
      quality,
      releaseName: feedItem === undefined ? '' : str(feedItem as SqlRow, 'raw_title'),
      publishedAt:
        feedItem === undefined || (feedItem as SqlRow)['published_at'] === null
          ? null
          : Number((feedItem as SqlRow)['published_at']),
      // Present only when true, as `manualValues` is: absent means "not
      // failed", so a healthy release serialises to exactly what it always did.
      ...(failed.has(release.id) ? { downloadFailed: true } : {}),
    };
    // Set only when there is one. Never assigned `undefined`: the field is
    // absent or it is a value, and the SPA reads the difference.
    if (manualValues !== undefined) view.manualValues = manualValues;
    return view;
  });

  // An empty quality, because a group has none — quality is release-level — and
  // because `editGroup` hands the plugin exactly the same empty one when it
  // merges the submitted values over the current record. A prefill built from
  // anything else would not round-trip through the save it feeds.
  const manualValues = manualValuesFor(plugin, {
    identityKey: group.identityKey,
    display,
    quality: {},
  });

  const view: GroupView = {
    id: group.id,
    plugin: group.plugin,
    display,
    state: group.state,
    pickedReleaseId: group.pickedReleaseId,
    upgradeReleaseId: group.upgradeReleaseId,
    listRankAt: group.listRankAt,
    releases,
    metadata: metadataViewOf(metadata),
  };
  if (manualValues !== undefined) view.manualValues = manualValues;
  return view;
}

/**
 * A prefill guess for a name the parser refused, or nothing at all.
 *
 * The hook's contract says it must never throw — and the guard is here anyway,
 * for the same reason `manualValuesFor` has one: a contract states what a
 * plugin owes, not what it does, and this call site is the one that pays. It
 * runs once per row on the Failed page, so a single plugin throwing on a
 * single refused name would 500 the whole endpoint and take down the worklist
 * of broken names — the one screen a broken plugin most needs to be visible
 * on, and the only route from a refusal to a correction.
 *
 * An empty object rather than `undefined`, because unlike `manualValues` this
 * field is not a signal: the SPA offers the Fix form from the plugin's field
 * schema, and a missing suggestion just means an empty form.
 */
function suggestedValuesFor(
  plugin: MediaTypePlugin | null,
  rawTitle: string,
): Record<string, string> {
  const suggest = plugin?.suggestManualValues;
  if (plugin === null || suggest === undefined) return {};
  try {
    return suggest.call(plugin, rawTitle);
  } catch {
    return {};
  }
}

/**
 * `plugin` is the one configured for the item's feed, or null when that feed
 * has left configuration.
 */
export function toFailedItemView(
  row: FeedItemRow,
  plugin: MediaTypePlugin | null,
): FailedItemView {
  return {
    id: row.id,
    feedId: row.feedId,
    plugin: plugin?.id ?? '',
    rawTitle: row.rawTitle,
    link: row.link,
    // Never null in practice: `failedFeedItems` selects on `parse_error IS NOT
    // NULL`. The fallback keeps that guarantee out of the wire format.
    parseError: row.parseError ?? '',
    firstSeenAt: row.firstSeenAt,
    publishedAt: row.publishedAt,
    suggestedValues: suggestedValuesFor(plugin, row.rawTitle),
    dismissedAt: row.dismissedAt,
  };
}

export function toDownloadView(db: DatabaseSync, download: DownloadRow): DownloadView {
  const group = db.prepare('SELECT display FROM media_groups WHERE id = ?').get(download.groupId);
  const display =
    group === undefined
      ? { title: `Group ${download.groupId}`, fields: [] }
      : (JSON.parse(str(group as SqlRow, 'display')) as DisplayFields);

  return {
    id: download.id,
    groupId: download.groupId,
    releaseId: download.releaseId,
    title: display.title,
    kind: download.kind,
    status: download.status,
    error: download.error,
    attempts: download.attempts,
    updatedAt: download.updatedAt,
  };
}
