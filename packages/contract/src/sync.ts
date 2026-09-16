import type { DatabaseSync } from 'node:sqlite';

/** A plugin-owned table a client replicates, and how to read it. */
export interface SyncedTable<T> {
  /** The table's name. Must carry the plugin's id as a prefix; see `assertSyncedTableName`. */
  readonly table: string;
  /** Current state for these row ids, in the shape the client receives. */
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, T>;
}

/** A plain SQL identifier: what may be interpolated into a trigger body. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * Refuses a table name that is malformed, or that does not carry the given
 * plugin id as a prefix.
 *
 * Two checks. The name must be a plain identifier, because it is
 * interpolated into a trigger body where SQLite binds no parameters
 * (`sync/log.ts`), so a name is the one place a plugin's declaration reaches
 * SQL as text -- that is the load-bearing one, refusing e.g.
 * `tv_a; DROP TABLE media_item`. And it must carry `pluginId` as a prefix,
 * the rule a plugin's migrations already follow.
 *
 * This checks shape and self-consistency only: given the *true* `pluginId`,
 * does the table it names look like one that plugin owns. It cannot check
 * more than that -- `packages/contract` has no business knowing the host's
 * table names, or any other plugin's -- so on its own it does **not** stop a
 * plugin claiming a table the host or another plugin already owns;
 * `assertSyncedTableName('media', 'media_item')` passes, because `media_item`
 * does carry `'media'` as a prefix. Refusing a table already owned elsewhere
 * is checked separately, by `sync/registry.ts` in the host, which is where
 * the host's own table names and every plugin's declared tables are actually
 * gathered.
 */
export function assertSyncedTableName(pluginId: string, table: string): void {
  if (!IDENTIFIER.test(table)) {
    throw new Error(`synced table ${JSON.stringify(table)} is not a plain identifier`);
  }
  if (!table.startsWith(`${pluginId}_`)) {
    throw new Error(
      `plugin ${JSON.stringify(pluginId)} declared synced table ${JSON.stringify(table)}, ` +
      `which does not carry its id as a prefix`,
    );
  }
}

/**
 * The six read shapes, one per synced **plugin** table. The host's own six
 * are below, under `MediaItemSyncRead`.
 *
 * **Every one of these six omits the row's own id, and that is not an
 * oversight.** A client keys a row by the `id` the host puts on the op that
 * carries it, beside `op` and `table`, never by a field a read shape
 * happened to remember to include -- so the key is the protocol's, not each
 * plugin author's. See `sync/tail.ts`'s `SyncOp` for why: an op whose id
 * lived inside `value` could not be matched against the delete that later
 * names the same row, and the three shapes here carried no id at all until
 * the op did, which made every plugin upsert unkeyable and every plugin
 * delete unappliable. `SyncOp` is also where the three op kinds
 * (`create`/`upsert`/`delete`) and the two rules a client applies them by
 * are stated.
 *
 * **The host's six do carry an `id`, and that does not contradict the
 * paragraph above.** `sync/tables.ts` projects `id` because its `SELECT`s
 * are the row and nothing maps them, and `readHostRows` keys its result by
 * that column -- so the field is there whether or not a client reads it. It
 * is redundant with the op's `id` rather than an alternative to it: the key a
 * client stores a row under is the op's on a host table exactly as on a
 * plugin one, because a `delete` op carries no `value` to read an id out of.
 *
 * The three *detail* shapes -- one row per media item -- do carry
 * `mediaItemId`, because grouping is a different question from keying: the
 * client has to attach a detail row to the media item it belongs to, and
 * `media_item.id` is not this row's key. The three *parent* shapes
 * (`TvSeasonRead`, `TvSeriesRead`, `XxxSiteRead`) carry no `mediaItemId`,
 * because their tables have no `media_item_id` column -- many episodes share
 * one season, many scenes one site -- and they are reached through the
 * detail rows that point at them.
 */

/** What a client receives for a television media item. */
export interface TvRead {
  /** The media item this release belongs to. Not this row's key; see the note above. */
  mediaItemId: number;
  kind: 'series' | 'season' | 'episode';
  seriesTitle: string;
  seriesRef: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/** What a client receives for a film media item. */
export interface MovieRead {
  /** The media item this detail row belongs to. Not this row's key; see the note above. */
  mediaItemId: number;
  runtimeMinutes: number | null;
  tagline: string | null;
}

/** What a client receives for an adult media item. */
export interface XxxRead {
  /** The media item this scene belongs to. Not this row's key; see the note above. */
  mediaItemId: number;
  siteName: string | null;
  siteRef: string | null;
}

/**
 * What a client receives for a television season, independent of any one
 * release.
 *
 * `seriesId` is a `tv_series.id`, which resolves against the `id` on the
 * `tv_series` op -- the op-level key described above is what makes this
 * reference land on a row the client actually holds.
 *
 * **It resolves eventually, not in order.** Declaration order used to be
 * emission order, because the backfill emitted a group's plugin tables in the
 * order the plugin listed them; it walks `sync_log` now, so emission order is
 * write order and a plugin has no handle on it. A client can therefore hold a
 * season whose `seriesId` names a series it has not received yet, and the
 * series arrives elsewhere in the same walk. That is the same tolerance a
 * client already needs for `rss_item.feed_id` and `download_client_id`, which
 * name tables that are never synced at all -- see `sync/backfill.ts` for the
 * property and why it was accepted.
 */
export interface TvSeasonRead {
  seriesId: number;
  seasonNumber: number | null;
  title: string | null;
}

/** What a client receives for a television series, independent of any one release. */
export interface TvSeriesRead {
  title: string;
  providerRef: string;
  firstAirDate: string | null;
  overview: string | null;
}

/** What a client receives for an adult site, independent of any one scene. */
export interface XxxSiteRead {
  name: string;
  providerRef: string;
}

/**
 * The six read shapes for the **host's** own synced tables --
 * `sync/tables.ts`'s `selectSql` projections, field for field.
 *
 * **Why `SyncRead` and not `Read`.** `MediaItemRead` and `RssItemRead` are
 * already taken, by `./media.ts`, and they are a different surface: those are
 * what `MediaReader` answers and what `/api/media` and `/api/rss-items`
 * serve, and neither matches its sync counterpart. `MediaItemRead` has no
 * `pluginId`; `RssItemRead` has `link` -- which this wire deliberately never
 * carries, since for a private tracker that url carries the passkey and a
 * replica is permanent -- and no `createdAt`, `updatedAt` or `rankingScore`.
 * Reusing
 * either would either leak a field or silently drop one. All six carry the
 * suffix rather than only the two that had to, so the family reads as one;
 * the plugin shapes above keep their bare `Read` because renaming them means
 * touching three plugin packages for no requirement.
 *
 * **These are not the wire's source of truth -- the projections are.** They
 * exist so a client types against a declaration instead of transcribing
 * `selectSql` by hand -- the field-name drift design spec §6 names, as
 * "the worst failure this design can have, moved from triggers to types"
 * after §3.7's silently diverging client. What keeps them from being a second
 * source of truth is
 * `packages/host/test/sync/tables.test.ts`: it reads each projection's key
 * set off a real row and compares it against a `Record<keyof …, true>`
 * witness per shape, so a column added to a `SELECT` and not to the shape
 * fails, and a field added here and not to the `SELECT` fails to compile.
 * That check is over *names*; a field's declared type is not mechanisable
 * from a TypeScript type at run time and is not covered.
 *
 * **Two fields name rows a client will never receive**, and they are called
 * out on the fields themselves rather than here, because a client that reads
 * only the field list is the one that needs to know.
 */

/**
 * A media item -- the group a client browses -- as the replica holds it.
 *
 * `id` is redundant with the op's; see the note above `TvRead`.
 */
export interface MediaItemSyncRead {
  id: number;
  /** Which plugin owns this item, and so which category it browses under. */
  pluginId: string;
  createdAt: number;
  updatedAt: number;
  /** Null while no lookup has claimed this item for a provider. */
  provider: string | null;
  /** Null with `provider`: the two are claimed together (`claimProviderRef`). */
  providerRef: string | null;
  title: string;
  releaseDate: string | null;
  description: string | null;
}

/** A release found in a feed, as the replica holds it. */
export interface RssItemSyncRead {
  id: number;
  /**
   * The `rss_feed` this release came from -- **an id a client can never
   * resolve to a name.** `rss_feed` is not synced and will not be: a feed row
   * holds the feed's url, which for a private tracker or indexer carries the
   * passkey, and no url may be copied into permanent client storage. So a
   * client may group releases by feed, and count them, and tell two feeds
   * apart; it cannot label either. Kept rather than dropped because an id is
   * not a url and grouping by it needs nothing else.
   */
  feedId: number;
  filename: string;
  createdAt: number;
  updatedAt: number;
  /**
   * `'torrent'` or `'nzb'` in every row this host writes, but typed `string`
   * rather than a union, because nothing narrows it on the way here. The
   * column is TEXT with no CHECK and `PluginContext.db` hands a plugin the
   * raw connection, so a row can hold any string; `/api/rss-items` gets its
   * `'torrent' | 'nzb'` from `downloadTypeOf`, a guard at that read boundary
   * which this projection has no equivalent of. A union here would be a
   * promise the wire does not keep.
   */
  downloadType: string;
  /** Null for a release no lookup has attached to a group yet. */
  mediaItemId: number | null;
  rankingScore: number | null;
  /**
   * What became of this release's identification -- `./media.ts`'s
   * `Resolution` vocabulary. `string` rather than that union for the reason
   * `downloadType` above gives: the column is unconstrained TEXT and nothing
   * narrows it between the `SELECT` and the wire.
   */
  resolution: string;
  resolutionDetail: string | null;
  deliveredAt: number | null;
}

/**
 * A pick submitted to a torrent client, as the replica holds it.
 *
 * Neither `storagePath` nor `lastError` is here, and neither ever will be:
 * `sync/tables.ts`'s `selectSql` doc has why a path and a partly-redacted
 * error string are served through `/api/downloads` and refused here.
 */
export interface TorrentDownloadSyncRead {
  id: number;
  rssItemId: number;
  /**
   * The `download_client` this was submitted to -- **an id a client can never
   * resolve to a name**, for a harder reason than `RssItemSyncRead.feedId`'s.
   * A `download_client` row holds a service's address and the names of its
   * secrets, so that table is not merely unsynced today, it will not be
   * synced. A client can group downloads by client; it cannot say which.
   */
  downloadClientId: number;
  /** Null until the client confirms the submission. */
  infohash: string | null;
  /** The client's own handle for this download. Null until it confirms. */
  clientRef: string | null;
  /** The host's own vocabulary, which grows; `string` for the reason `DownloadRead.status` gives. */
  status: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  percentage: number | null;
  absentSince: number | null;
  deliveredAt: number | null;
  reclaimedAt: number | null;
}

/**
 * A pick submitted to an nzb client, as the replica holds it: the torrent
 * shape minus `infohash`, which an nzb has no equivalent of.
 *
 * Declared in full rather than as `Omit<TorrentDownloadSyncRead, 'infohash'>`,
 * because the two projections are two `SELECT`s and the shapes are what the
 * key-set check compares them against one at a time. An `Omit` would make a
 * column added to one table and not the other look like a shape error in the
 * wrong place.
 */
export interface NzbDownloadSyncRead {
  id: number;
  rssItemId: number;
  /** See `TorrentDownloadSyncRead.downloadClientId`: never resolvable from the replica. */
  downloadClientId: number;
  clientRef: string | null;
  status: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  percentage: number | null;
  absentSince: number | null;
  deliveredAt: number | null;
  reclaimedAt: number | null;
}

/** Someone who appears in a media item, as the replica holds it. */
export interface PersonSyncRead {
  id: number;
  name: string;
  /** The provider's own person id, which is how lookups de-duplicate people. */
  providerRef: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * One person's part in one media item, as the replica holds it.
 *
 * **No `updatedAt`, because the column does not exist** -- `role` is written
 * by an upsert on `(media_item_id, person_id, role)` and has `created_at`
 * alone. Design spec §5.3 notes that neither client obligation needs a
 * per-row version, which is what makes that survivable on the wire.
 */
export interface RoleSyncRead {
  id: number;
  /** The media item this part is in. Not this row's key; the op carries that. */
  mediaItemId: number;
  /** The `person` this part belongs to, which *is* resolvable: `person` is synced. */
  personId: number;
  /** What they did -- the provider's word for it, e.g. `actor`. */
  role: string;
  /** The character's name, where the provider gives one. */
  name: string | null;
  billingOrder: number | null;
  createdAt: number;
}
