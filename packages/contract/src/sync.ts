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
 * The six read shapes, one per synced plugin table.
 *
 * **Every one of them omits the row's own id, and that is not an
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
