/**
 * The host-owned gatherer: everything common to one media item, assembled
 * from the row-level replica in `store/rows.ts` (design spec §7).
 *
 * **Plugin-blind by construction.** This module names exactly six tables --
 * `media_item`, `rss_item`, `torrent_download`, `nzb_download`, `person` and
 * `role` -- and no others. `byMediaItem` hands back every row belonging to a
 * media item across *every* synced table, plugin ones included; this
 * gatherer simply does not recognise a table it did not name and leaves it
 * out. A plugin's own `compose.ts` reads the rows this one ignores. That
 * split is what makes a new plugin a new directory rather than an edit here.
 *
 * **No artwork rows.** Artwork is not replicated (design spec §1.2, #79); the
 * three urls below are the whole of what this gatherer can say about it.
 *
 * **`feedId` and `downloadClientId` are carried through untouched, and both
 * are now resolvable by someone -- just not here.** This paragraph used to
 * record an asymmetry: `rss_feed` was synced and `download_client` was not
 * (the storage design spec's §2.4), so surfacing a bare `downloadClientId`
 * was the whole of what this gatherer owed it. The download clients slice
 * ended that -- `download_client` joined `HOST_SYNCED_TABLES` and
 * `DownloadClientSyncRead` is its projection -- so both ids now name a row
 * the replica actually holds. Neither is resolved here all the same, for
 * the reason the paragraph above gives rather than for want of a row: this
 * gatherer names six tables and neither of those two is among them.
 * Resolving either is a caller's join against `store/rows.ts` directly --
 * `settings/useDownloadClients.ts` reads `download_client` exactly that
 * way -- not this module's job.
 */
import type {
  MediaItemSyncRead,
  NzbDownloadSyncRead,
  PersonSyncRead,
  RoleSyncRead,
  RssItemSyncRead,
  TorrentDownloadSyncRead,
} from '@pickarr/contract';
import { byMediaItem, byRssItem, getRow, getRows } from './rows.ts';

/**
 * Trusts a replica value to be the shape its table's `*SyncRead` contract
 * interface declares.
 *
 * `store/rows.ts` deliberately returns `unknown`: the row-level surface does
 * not know what shape any table holds, by design (that knowledge belongs to
 * this module and to a plugin's `compose.ts`, never to the store itself).
 * This gatherer does know, for exactly the six tables it names, because
 * `@pickarr/contract`'s `*SyncRead` interface for each of those six -- one
 * of eight now that `rss_feed` and `download_client` have joined the synced
 * set, neither of the other two named anywhere in this module -- is pinned
 * to the projection the host actually emits for it (`packages/host/test/sync/tables.test.ts` is what keeps the
 * two from drifting).
 *
 * **Knowing the shape is not the same as having checked it, so these check.**
 * An earlier version of this module asserted instead -- one `trusted<T>`
 * helper casting `unknown` to each interface, seven times -- which the plan's
 * Global Constraints forbid and which review rated blocking. The constraint
 * is right, and not only on principle: a replica *persists across client
 * builds*. `SCHEMA_VERSION` rebuilds it when the store's own schema changes
 * and the generation token rebuilds it when the server's database changes,
 * but neither fires when a **wire shape** changes -- a renamed field, a new
 * required one -- so a row written by build N is read by build N+1 against
 * whatever `*SyncRead` means by then. A cast makes that a crash somewhere
 * downstream; a check makes it a row this gatherer declines to assemble.
 *
 * **Each predicate checks the fields this module itself dereferences, and no
 * more.** That is `pluginId` on a media item, `feedId` on a release, and
 * `personId` on a role -- the three values the gatherer reads rather than
 * forwards. Everything else is passed through to a consumer, which is
 * trusting `@pickarr/contract` exactly as it did before; verifying fields
 * nobody here touches would only move that trust, at the cost of rejecting
 * rows over a field no screen reads.
 *
 * Note also what a stored value does **not** carry: the row's `id` lives on
 * the op envelope and is the store's key, never inside `value` (storage
 * design §2.2, sync design's `SyncOp`). So no predicate looks for one -- an
 * earlier draft of these did, and rejected every well-formed fixture in the
 * suite.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMediaItem(value: unknown): value is MediaItemSyncRead {
  return isRecord(value) && typeof value.pluginId === 'string';
}

function isRssItem(value: unknown): value is RssItemSyncRead {
  return isRecord(value) && typeof value.feedId === 'number';
}

function isTorrentDownload(value: unknown): value is TorrentDownloadSyncRead {
  return isRecord(value);
}

function isNzbDownload(value: unknown): value is NzbDownloadSyncRead {
  return isRecord(value);
}

function isPerson(value: unknown): value is PersonSyncRead {
  return isRecord(value);
}

function isRole(value: unknown): value is RoleSyncRead {
  return isRecord(value) && typeof value.personId === 'number';
}

/** `poster`, `background` or `logo` -- the three kinds a media item has artwork for (design spec §1.2, #79). */
export type ArtworkKind = 'poster' | 'background' | 'logo';

/** Where to fetch a media item's artwork, keyed by kind -- urls, never rows. */
export type ArtworkUrls = Readonly<Record<ArtworkKind, string>>;

function artworkUrls(mediaItemId: number): ArtworkUrls {
  return {
    poster: `/api/artwork/poster/${String(mediaItemId)}`,
    background: `/api/artwork/background/${String(mediaItemId)}`,
    logo: `/api/artwork/logo/${String(mediaItemId)}`,
  };
}

/** One download under a release, tagged by which of the two host tables it came from. */
export type GatheredDownload =
  | { readonly table: 'torrent_download'; readonly id: number; readonly row: TorrentDownloadSyncRead }
  | { readonly table: 'nzb_download'; readonly id: number; readonly row: NzbDownloadSyncRead };

/** One release and the downloads submitted for it. */
export interface GatheredRelease {
  readonly id: number;
  readonly row: RssItemSyncRead;
  readonly downloads: readonly GatheredDownload[];
}

/**
 * One role, paired with the person it belongs to where that person has
 * already arrived.
 *
 * `person` is `undefined` rather than the role being left out when it has
 * not: log order is not group order (sync spec §5.2), so mid-backfill a role
 * can land in the replica before the person it names does. Dropping a role
 * the replica cannot yet resolve would make the cast silently short instead
 * of merely incomplete -- a caller that wants to hide an unresolved role can
 * filter on `person === undefined`, but this gatherer will not decide that
 * for it.
 */
export interface GatheredRole {
  readonly id: number;
  readonly row: RoleSyncRead;
  readonly person: PersonSyncRead | undefined;
}

/** Everything common to one media item -- the host's half of design spec §7's join. */
export interface GatheredItem {
  readonly mediaItem: MediaItemSyncRead;
  /** `mediaItem.pluginId`, hoisted: what a `plugins/<id>/compose.ts` selects on (design spec §7). */
  readonly pluginId: string;
  readonly releases: readonly GatheredRelease[];
  readonly roles: readonly GatheredRole[];
  readonly artwork: ArtworkUrls;
  /** The distinct `feedId`s across `releases`, for a caller that wants the set without walking them. */
  readonly feedIds: readonly number[];
}

/**
 * A release and its downloads, or `undefined` when the release row does not
 * match its contract shape -- see the predicates above for when that happens
 * and why declining beats asserting.
 */
async function gatherRelease(
  db: IDBDatabase,
  id: number,
  value: unknown,
): Promise<GatheredRelease | undefined> {
  if (!isRssItem(value)) return undefined;
  const downloadRows = await byRssItem(db, id);
  const downloads: GatheredDownload[] = downloadRows.flatMap((row): GatheredDownload[] => {
    if (row.table === 'torrent_download' && isTorrentDownload(row.value)) {
      return [{ table: 'torrent_download' as const, id: row.id, row: row.value }];
    }
    if (row.table === 'nzb_download' && isNzbDownload(row.value)) {
      return [{ table: 'nzb_download' as const, id: row.id, row: row.value }];
    }
    return [];
  });
  return { id, row: value, downloads };
}

function gatherRole(
  id: number,
  value: unknown,
  people: ReadonlyMap<number, unknown>,
): GatheredRole | undefined {
  if (!isRole(value)) return undefined;
  const personValue = people.get(value.personId);
  // A role whose person has not arrived is kept, because log order is not
  // group order (sync design §5.2) and dropping it makes a cast silently
  // short. A person that arrived *malformed* is treated the same way as one
  // that has not arrived: absent, rather than a reason to drop the role.
  return {
    id,
    row: value,
    person: personValue !== undefined && isPerson(personValue) ? personValue : undefined,
  };
}

/**
 * Everything common to media item `mediaItemId`, in the shape a plugin's
 * `compose.ts` builds a card on top of -- or `undefined` when the replica
 * holds no such item, whether that is a tombstone or a row that has not
 * arrived yet (`getRow`'s own doc on why those two are, and must stay, the
 * same answer).
 *
 * One `byMediaItem` query supplies the item's releases and roles together;
 * only the downloads under each release need a query of their own, one per
 * release, over `byRssItem`.
 */
export async function gatherMediaItem(db: IDBDatabase, mediaItemId: number): Promise<GatheredItem | undefined> {
  const mediaItemValue = await getRow(db, 'media_item', mediaItemId);
  if (mediaItemValue === undefined) return undefined;
  // A media item that does not match its contract shape is answered the same
  // way as one that is not there. The alternative is handing a caller an
  // object it will read `pluginId` off and get `undefined` from, which fails
  // somewhere else entirely.
  if (!isMediaItem(mediaItemValue)) return undefined;
  const mediaItem = mediaItemValue;

  const rows = await byMediaItem(db, mediaItemId);
  const releaseRows = rows.filter((row) => row.table === 'rss_item');
  const roleRows = rows.filter((row) => row.table === 'role');

  const personIds = [...new Set(
    roleRows.flatMap((row) => (isRole(row.value) ? [row.value.personId] : [])),
  )];
  const people = await getRows(db, 'person', personIds);

  const gathered = await Promise.all(releaseRows.map((row) => gatherRelease(db, row.id, row.value)));
  const releases = gathered.filter((release): release is GatheredRelease => release !== undefined);
  const roles = roleRows
    .map((row) => gatherRole(row.id, row.value, people))
    .filter((role): role is GatheredRole => role !== undefined);
  const feedIds = [...new Set(releases.map((release) => release.row.feedId))].toSorted((a, b) => a - b);

  return { mediaItem, pluginId: mediaItem.pluginId, releases, roles, artwork: artworkUrls(mediaItemId), feedIds };
}
