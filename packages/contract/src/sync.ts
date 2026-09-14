import type { DatabaseSync } from 'node:sqlite';

/** A plugin-owned table a client replicates, and how to read it. */
export interface SyncedTable<T> {
  /** The table's name. Must carry the plugin's id as a prefix; see `assertSyncedTableName`. */
  readonly table: string;
  /** Current state for these row ids, in the shape the client receives. */
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, T>;
  /** This table's row ids belonging to those media items, so the backfill can hydrate a group. */
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[];
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

/** What a client receives for a television media item. */
export interface TvRead {
  kind: 'series' | 'season' | 'episode';
  seriesTitle: string;
  seriesRef: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/** What a client receives for a film media item. */
export interface MovieRead {
  runtimeMinutes: number | null;
  tagline: string | null;
}

/** What a client receives for an adult media item. */
export interface XxxRead {
  siteName: string | null;
  siteRef: string | null;
}
