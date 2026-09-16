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
 * **`feedId` and `downloadClientId` are carried through untouched.** Neither
 * resolves to a name from the replica alone -- `rss_feed` and
 * `download_client` are not synced, the latter deliberately (design spec
 * §2.4) -- so surfacing the bare id is this gatherer's entire obligation
 * toward either.
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
 * `@pickarr/contract`'s six `*SyncRead` interfaces are pinned to the
 * projections the host actually emits (`packages/host/test/sync/tables.test.ts`
 * is what keeps the two from drifting). One named assertion here rather than
 * one at each call site, and the same trust the host's own `readHostRows`
 * places on a raw row it cannot type any more precisely than this.
 */
function trusted<T>(value: unknown): T {
  return value as T;
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

async function gatherRelease(db: IDBDatabase, id: number, value: unknown): Promise<GatheredRelease> {
  const downloadRows = await byRssItem(db, id);
  const downloads: GatheredDownload[] = downloadRows.flatMap((row): GatheredDownload[] => {
    if (row.table === 'torrent_download') {
      return [{ table: 'torrent_download' as const, id: row.id, row: trusted<TorrentDownloadSyncRead>(row.value) }];
    }
    if (row.table === 'nzb_download') {
      return [{ table: 'nzb_download' as const, id: row.id, row: trusted<NzbDownloadSyncRead>(row.value) }];
    }
    return [];
  });
  return { id, row: trusted<RssItemSyncRead>(value), downloads };
}

function gatherRole(id: number, value: unknown, people: ReadonlyMap<number, unknown>): GatheredRole {
  const row = trusted<RoleSyncRead>(value);
  const personValue = people.get(row.personId);
  return { id, row, person: personValue === undefined ? undefined : trusted<PersonSyncRead>(personValue) };
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
  const mediaItem = trusted<MediaItemSyncRead>(mediaItemValue);

  const rows = await byMediaItem(db, mediaItemId);
  const releaseRows = rows.filter((row) => row.table === 'rss_item');
  const roleRows = rows.filter((row) => row.table === 'role');

  const personIds = [...new Set(roleRows.map((row) => trusted<RoleSyncRead>(row.value).personId))];
  const people = await getRows(db, 'person', personIds);

  const releases = await Promise.all(releaseRows.map((row) => gatherRelease(db, row.id, row.value)));
  const roles = roleRows.map((row) => gatherRole(row.id, row.value, people));
  const feedIds = [...new Set(releases.map((release) => release.row.feedId))].toSorted((a, b) => a - b);

  return { mediaItem, pluginId: mediaItem.pluginId, releases, roles, artwork: artworkUrls(mediaItemId), feedIds };
}
