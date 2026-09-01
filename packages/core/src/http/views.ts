import type { DatabaseSync } from 'node:sqlite';
import type {
  DisplayFields,
  MediaTypePlugin,
  ParsedRelease,
  QualityTokens,
} from '@pickarr/plugin-api';
import type { EditableConfig } from '../config/editable.ts';
import { displayJsonForGroups, type GroupRow } from '../db/groups.ts';
import { releasesForGroup } from '../db/releases.ts';
import { latestDownloadsForGroup, type DownloadRow, type DownloadStatus, type LatestDownload } from '../db/downloads.ts';
import type { FeedItemRow } from '../db/feed-items.ts';
import type { GroupMetadata } from '../db/metadata.ts';
import type { IdentityPlan } from '../manual/identity-plan.ts';
import type { PerformerRow } from '../db/performers.ts';
import type { UntrackedEntry } from '../pipeline/reconcile.ts';
import { str, type SqlRow } from '../db/row.ts';

const TPDB_BASE = 'https://theporndb.net';

/**
 * The link for one performer, built server-side so the two-namespace rule
 * lives in one place. Sending `kind` to the browser instead would mean the
 * client re-deriving a mapping it has no other reason to know, and two
 * derivations that can disagree.
 *
 * The slug is escaped because it is the provider's string, not ours. Nothing
 * here is exploitable — it lands in an `href` the browser resolves, not in
 * markup — but a slug carrying `?`, `#` or a space silently builds a
 * different URL than the one intended: everything after a `#` becomes a
 * fragment, everything after a `?` a query. `encodeURIComponent` is a no-op
 * on the slugs the provider actually sends, which is the point — it costs
 * nothing and removes the need to be sure of that.
 */
function performerUrl(performer: PerformerRow): string {
  const namespace = performer.kind === 'performer-site' ? 'performer-sites' : 'performers';
  return `${TPDB_BASE}/${namespace}/${encodeURIComponent(performer.slug)}`;
}

/** One performer as the browser needs it: a name, a link, and whether an avatar or full image is cached. */
export interface PerformerView {
  id: number;
  name: string;
  url: string;
  hasAvatar: boolean;
  hasImage: boolean;
}

/**
 * A group's cast, which is a fact about the *group* and not about the scene
 * answer — which is why it sits beside `state` rather than inside any one
 * variant of it.
 *
 * That distinction is load-bearing, not tidiness. `group_performers` is keyed by
 * group and has two independent writers: the scene answer's own performer list,
 * and `runPerformerPass`, whose entire purpose is to find a cast for a group
 * whose scene lookup settled *without* one. The commonest form of that is
 * `state: 'none'` — no scene matched at all — so a cast modelled inside the
 * `'confirmed'` variant is unreachable in exactly the case the performer search
 * exists to serve. It was: `metadataViewOf` returned a bare `{ state: 'none' }`
 * and discarded the performers it had been handed, and no endpoint anywhere else
 * serves a cast, so the search's whole output was invisible on those groups.
 *
 * `'absent'` and `'pending'` carry a cast for the same reason: a
 * `group_metadata` row is not a precondition for a `group_performers` row.
 */
export interface CastView {
  performers: PerformerView[];
  /**
   * The legacy cast, as plain names, for a group whose cast has no rows in
   * `group_performers` yet — migration 7 queued every already-answered group for
   * a refetch, but they drain at the worker's own rate. Never populated at the
   * same time as `performers`: a caller that had to choose between the two lists
   * could choose differently in two places.
   *
   * Only ever non-empty alongside `state: 'confirmed'`, since the names come off
   * the recorded scene answer — but it lives here rather than in that variant so
   * that a reader never has to narrow the union to ask who is in a group.
   */
  performerNames: string[];
}

/**
 * What browse (and `GET /api/metadata`) can say about a group's scene metadata,
 * plus the group's cast beside it. `'pending'` and `'absent'` only ever come
 * from the standalone metadata endpoint — it is the only caller that also
 * consults `metadata_queue` to tell "asked, not yet answered" from "never
 * asked" — while `metadataViewOf` answers browse's simpler question (is there a
 * recorded answer at all) from `group_metadata` alone.
 *
 * An intersection rather than four variants each repeating the cast: the cast is
 * readable without narrowing, and adding a fifth state cannot forget it.
 */
export type MetadataView = CastView &
  (
    | {
        state: 'confirmed';
        title: string | null;
        releaseDate: string | null;
        durationSeconds: number | null;
        synopsis: string | null;
        hasPoster: boolean;
        hasBackground: boolean;
        sceneUrl: string | null;
      }
    | { state: 'none' }
    | { state: 'pending'; nextAttemptAt: number }
    | { state: 'absent' }
  );

/**
 * The answer to `POST /api/metadata/request`. Five counters: an id naming a
 * group that no longer exists is neither queued, answered, nor waiting, and
 * folding it into any of those would claim something false (`alreadyAnswered`
 * asserts a settled answer that was never recorded; `queued` is simply untrue
 * — nothing was inserted). `missing` names it instead.
 *
 * `unavailable` is the fifth, and is a different kind of non-answer again: it
 * counts ids that were skipped only because there is currently no worker
 * running to ever drain a queue row for them (`ServerDeps.metadataAvailable`
 * is false), not because anything is known about the group itself. It is
 * deliberately not folded into `alreadyAnswered` — nothing was answered, and
 * nothing was cached, so a later request once metadata is available again
 * must be free to queue the same id.
 *
 * The five counters are an honest partition of the request:
 * `queued + alreadyAnswered + pending + missing + unavailable` always equals
 * the number of ids sent. `refreshed` below is a list, not a sixth bucket, and
 * deliberately overlaps them rather than adding to them.
 */
export interface MetadataRequestResponse {
  queued: number;
  alreadyAnswered: number;
  pending: number;
  missing: number;
  unavailable: number;
  /**
   * The ids that already had a `'none'` answer old enough to be worth asking
   * again, and now have a re-ask outstanding.
   *
   * A list rather than a counter, and the only one here, because its consumer
   * needs to know *which* ids rather than how many. The SPA stops watching an id
   * the moment it reads a settled answer, so a group re-queued behind its back
   * would have its new answer sit unread until the next page load;
   * `useGroupMetadata` rearms exactly these.
   *
   * Not a sixth bucket in the partition above — it cuts across it. Every id here
   * is also counted in `queued` or in `pending` (pending when the worker already
   * had a row for it), so `queued + alreadyAnswered + pending + missing +
   * unavailable` still equals the number of ids sent.
   */
  refreshed: number[];
}

/**
 * The answer to `POST /api/metadata/requery`. Only four counters, not five:
 * being already answered is this route's precondition rather than something
 * it refuses, so there is no `alreadyAnswered`/`pending` pair here the way
 * `MetadataRequestResponse` has one — a group in either state is exactly as
 * eligible for `requeued` as one that was never asked at all.
 *
 * `missing` and `unavailable` mean exactly what they mean on
 * `MetadataRequestResponse`, for the same reasons: an id naming a group that
 * no longer exists is not the same non-answer as one this server is
 * currently configured not to look up, and folding either into `requeued`
 * would claim a queue row was written when it was not.
 *
 * `unaskable` replaces `MetadataRequestResponse`'s implicit fold of the same
 * case into `alreadyAnswered` — `POST /api/metadata/request` answers an
 * unaskable group with `answerUnaskable` and reports it as settled, which is
 * honest there because the row had no answer yet. Here the group is already
 * settled, so calling `answerUnaskable` again would just rewrite `fetched_at`
 * for no reason; `unaskable` names the id as its own outcome instead of
 * reusing a counter that would imply a write that never happened.
 *
 * The four counters are an honest partition of the request, the same way
 * `MetadataRequestResponse`'s five are: `requeued + missing + unavailable +
 * unaskable` always equals the number of distinct ids sent (a request naming
 * the same id twice counts it once, matching `requeueMetadata`'s own
 * precondition that its input hold no duplicates).
 */
export interface MetadataRequeryResponse {
  requeued: number;
  missing: number;
  unavailable: number;
  unaskable: number;
}

/**
 * `performers` is this group's cast, read by the caller with
 * `performersForGroups` for the whole page it is building — never one query
 * per group, the mistake issue #31 already records for `/api/downloads`.
 *
 * `queuedNextAt` is this group's `metadata_queue.next_at`, or `undefined` when
 * there is no row — the caller (browse's `toGroupView`) never has one to pass,
 * since browse does not consult the queue at all, so its groups always read
 * `'absent'` rather than a `'pending'` they have no evidence for. Only
 * `GET /api/metadata` looks the queue up and passes a real value through.
 */
export function metadataViewOf(
  metadata: GroupMetadata | undefined,
  performers: readonly PerformerRow[],
  queuedNextAt?: number,
): MetadataView {
  // Built once, before the state is decided, and spread into every branch —
  // which is the whole point of `CastView`. Computing it inside one branch is
  // what made the performer search invisible on the groups it exists for: the
  // `'none'` branch returned early and the cast it had been handed went nowhere.
  const cast: CastView = {
    performers: performers.map((performer) => ({
      id: performer.id,
      name: performer.name,
      url: performerUrl(performer),
      hasAvatar: performer.facePath !== null,
      hasImage: performer.imagePath !== null,
    })),
    // Only when there is nothing better, and only a recorded scene answer has
    // any: the two fields are never both populated, because a caller that had to
    // choose between them could choose differently in two places.
    performerNames:
      performers.length > 0 || metadata === undefined ? [] : metadata.performers,
  };

  if (metadata === undefined) {
    return queuedNextAt === undefined
      ? { ...cast, state: 'absent' }
      : { ...cast, state: 'pending', nextAttemptAt: queuedNextAt };
  }
  if (metadata.state === 'none') return { ...cast, state: 'none' };
  return {
    ...cast,
    state: 'confirmed',
    title: metadata.title,
    releaseDate: metadata.releaseDate,
    durationSeconds: metadata.durationSeconds,
    synopsis: metadata.synopsis,
    hasPoster: metadata.posterPath !== null,
    hasBackground: metadata.backgroundPath !== null,
    // Escaped for the reason `performerUrl` gives: same provider, same kind
    // of string, same way of quietly building the wrong link.
    sceneUrl:
      metadata.sceneSlug === null
        ? null
        : `${TPDB_BASE}/scenes/${encodeURIComponent(metadata.sceneSlug)}`,
  };
}

/** The part of a download a card shows. Mirrors `LatestDownload` in db/downloads.ts. */
export interface ReleaseDownloadView {
  downloadId: number;
  status: DownloadStatus;
  error: string | null;
  absentSince: number | null;
}

/**
 * Group id → (release id → that release's latest download).
 *
 * Nested rather than flat because the client polls by group and renders by
 * release, and a flat list keyed by release id would make "this group has
 * nothing" unrepresentable — which is the state that stops the poll.
 */
export type ReleaseDownloadsResponse = Record<number, Record<number, ReleaseDownloadView>>;

export interface ReleaseView {
  id: number;
  score: number;
  quality: QualityTokens;
  releaseName: string;
  publishedAt: number | null;
  /** The quality half of an edit form, prefilled. Absent when the plugin has no `toManualValues`. */
  manualValues?: Record<string, string>;
  /**
   * This release's most recent download, absent when it has never had one.
   *
   * Per release rather than per group because the card has to say *which*
   * version is downloading or failed: an upgrade deliberately leaves
   * `picked_release_id` on the old release until the replacement imports (see
   * `pickRelease`), so the row to mark is frequently not the current one.
   *
   * Widened from a `downloadFailed?: boolean`, which was exactly
   * `download?.status === 'failed'`. The boolean could not say `downloading`,
   * and the screen that could was deleted.
   */
  download?: ReleaseDownloadView;
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
  // read it: the card marks rows from `ReleaseView.download`, and the
  // ordering it would have explained is decided in SQL by `pickedGroups`, which
  // the client never re-derives. A payload field whose only exercise is a test
  // asserting something no screen consumes is a field to add when a screen
  // wants it.
}

/**
 * One row of the merged Browse list: a browsable group or a name the parser
 * refused, tagged so the SPA can render each under its own card without
 * guessing from which fields happen to be present.
 */
export type BrowseItem =
  | { kind: 'group'; group: GroupView }
  | { kind: 'failed'; item: FailedItemView };

export interface BrowseResponse {
  items: BrowseItem[];
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
 *
 * `renamed`, `trashed` and `failed` mirror `GroupEditOutcome` from
 * `manual/operations.ts` — carried through rather than folded away, because a
 * 200 that hid a per-file failure would tell the user their edit fully
 * succeeded when a file it promised to move or trash is not where the plan
 * said it would be.
 */
export interface GroupEditResponse {
  group: GroupView;
  mergedInto: number | null;
  renamed: number;
  trashed: number;
  failed: readonly { path: string; error: string }[];
}

/**
 * The plan route answers the planner's own result verbatim — the whole point
 * of `planIdentityChange` is that the preview and the apply run the same
 * computation, so a view that reshaped it here could show the user something
 * the apply then disagreed with. The alias exists so this file's routes are
 * typed consistently through a `*Response` name like every other route,
 * rather than because the shape needs to differ from `IdentityPlan`.
 */
export type IdentityPlanResponse = IdentityPlan;

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
  /** When the client first stopped reporting this download, or null while it is seen. */
  absentSince: number | null;
}

export interface DownloadsResponse {
  tracked: DownloadView[];
  untracked: UntrackedEntry[];
  /**
   * The next page of `tracked`, or null at the end of the list. `untracked` is
   * whole on every page — it is the client's live queue rather than a slice of
   * this table — so a reader paging back through history keeps seeing it.
   */
  nextCursor: string | null;
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

/** `downloads`'s entry for `releaseId`, as the card needs it — dropping `releaseId` itself, which the caller already has as the map key. */
function downloadViewOf(
  downloads: Map<number, LatestDownload>,
  releaseId: number,
): ReleaseDownloadView | undefined {
  const latest = downloads.get(releaseId);
  if (latest === undefined) return undefined;
  return {
    downloadId: latest.downloadId,
    status: latest.status,
    error: latest.error,
    absentSince: latest.absentSince,
  };
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
  performers: readonly PerformerRow[],
): GroupView {
  const display = JSON.parse(group.display) as DisplayFields;

  // Asked once for the group, not once per release. It marks rows and nothing
  // else: `pickedGroups` used to order on this same predicate and no longer
  // does, because a per-release fact that clears only when that release is
  // retried made a permanent sort key out of a group the user had already dealt
  // with.
  const downloads = latestDownloadsForGroup(db, group.id);

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
    };
    // Set only when there is one. Never assigned `undefined`: the field is
    // absent or it is a value, and the SPA reads the difference.
    if (manualValues !== undefined) view.manualValues = manualValues;
    // Same discipline as `manualValues` just above: absent means "never
    // downloaded", so a release that has never been picked serialises to
    // exactly what it always did.
    const download = downloadViewOf(downloads, release.id);
    if (download !== undefined) view.download = download;
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
    metadata: metadataViewOf(metadata, performers),
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

/**
 * A whole page of downloads, with one query for the groups they belong to
 * rather than one per row.
 *
 * This function is the fix for issue #31's second half. `toDownloadView` opened
 * with `SELECT display FROM media_groups WHERE id = ?`, and `/api/downloads`
 * called it once per row: 500 downloads meant 501 statements, every three
 * seconds, for the life of an open tab. `/api/browse` already refuses to do
 * this — `metadataForGroups` and `performersForGroups` exist for exactly that
 * reason, and `viewOf`'s doc comment in `server.ts` names this route as the
 * defect not to repeat.
 *
 * Duplicate group ids in the batch cost nothing worth removing: `IN (?, ?, …)`
 * accepts them, the map collapses them, and two downloads of one group is the
 * ordinary case (an initial and its later upgrade).
 *
 * The `Group N` stand-in for a group the map has no entry for is the fallback
 * this function inherited, unchanged. With the foreign key on it is
 * unreachable by ordinary writes, and that is the point of keeping it: a
 * database that got there anyway lists the download awkwardly instead of not
 * at all.
 */
export function toDownloadViews(
  db: DatabaseSync,
  downloads: readonly DownloadRow[],
): DownloadView[] {
  const displays = displayJsonForGroups(
    db,
    downloads.map((download) => download.groupId),
  );

  return downloads.map((download) => {
    const json = displays.get(download.groupId);
    const display =
      json === undefined
        ? { title: `Group ${download.groupId}`, fields: [] }
        : (JSON.parse(json) as DisplayFields);

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
      absentSince: download.absentSince,
    };
  });
}

/**
 * The single-row form, for the pick and retry routes — each of which already
 * answers about one download and so is not the per-page loop above exists to
 * avoid.
 *
 * Implemented through `toDownloadViews` rather than beside it so there is one
 * parse of `display` and one fallback, not two that can drift. The empty branch
 * cannot be taken — `map` over a one-element array yields one element — and is
 * the type system's, not a real one; the same shape `failDownload` uses for the
 * same impossibility.
 */
export function toDownloadView(db: DatabaseSync, download: DownloadRow): DownloadView {
  const [view] = toDownloadViews(db, [download]);
  if (view === undefined) throw new Error(`toDownloadView: no view for download ${download.id}`);
  return view;
}

/**
 * The Settings screen's whole view of configuration.
 *
 * `portOverride` is `PICKARR_PORT`, reported so the form can say the port field
 * is currently being overridden at runtime rather than presenting a value the
 * running service is not using. `restartRequired` is whether the file on disk
 * has diverged from the document this process booted with — without it, the
 * "restart to apply" notice would vanish on a page reload and leave a
 * saved-but-unapplied config with nothing on screen saying so.
 */
export interface ConfigResponse {
  config: EditableConfig;
  portOverride: number | null;
  restartRequired: boolean;
}

/**
 * `restartRequired` is computed the same way `ConfigResponse.restartRequired`
 * is — against the document this process booted from — so the two routes
 * never contradict each other. A save that writes back exactly what boot saw
 * (the common case for a form that only touched a field it then reverted, or
 * one that only re-confirmed a secret) needs no restart; anything else does.
 */
export interface ConfigSaveResponse {
  savedAt: number;
  restartRequired: boolean;
}
