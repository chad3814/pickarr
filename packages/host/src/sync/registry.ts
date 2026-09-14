import type { DatabaseSync } from 'node:sqlite';
import { getTableName, isTable } from 'drizzle-orm';
import type { MediaPlugin, SyncedTable } from '@pickarr/contract';
import { assertSyncedTableName } from '@pickarr/contract';
import * as schema from '../db/schema.ts';
import { HOST_SYNCED_TABLES, readHostRows } from './tables.ts';

export interface SyncRegistry {
  /** Every synced table, host and plugin, in a stable order. */
  tables(): readonly string[];
  /** Current state for these ids of one table, or an empty record for a table nobody owns. */
  readRows(raw: DatabaseSync, table: string, ids: readonly number[]): Record<number, unknown>;
  /**
   * A plugin table's own row ids for these media items, or an empty array for
   * a host table or a table nobody owns.
   *
   * Dispatches to the declaring plugin's own `SyncedTable.rowsFor` --
   * `registry.ts` has no schema knowledge of a plugin table of its own, which
   * is exactly why that method exists on the contract rather than being
   * derived here the way `readHostRows` derives the host's six. The backfill
   * (`sync/backfill.ts`) is the caller: it knows a host row's relations
   * directly (`rss_item.media_item_id` and the rest), but a plugin table's are
   * only ever reachable through the plugin's own declaration.
   */
  rowsFor(raw: DatabaseSync, table: string, mediaItemIds: readonly number[]): readonly number[];
}

/**
 * Every table the host's own schema declares, host and plugin alike.
 *
 * `HOST_SYNCED_TABLES` only names the *synced* subset of the host's own
 * tables -- `sync_log` itself, `auth_user`, `secret` and the rest are just as
 * real, and just as much the host's to refuse a plugin claiming. This is
 * what `assertSyncable` below checks a plugin's declared table against, so a
 * plugin cannot claim any table the host already has, synced or not.
 *
 * Read from `schema.ts`'s own exported table objects via `getTableName`,
 * not from `sqlite_master`. `sqlite_master` answers "what tables exist in
 * this database", and by the time this check runs a plugin's own tables
 * exist there too -- `migratePlugin` has already created them. Checking a
 * plugin's declared table against that set would flag its own table as a
 * host collision. `schema.ts` answers the question actually being asked,
 * "what tables does the host declare", and answers it identically whatever
 * has migrated.
 */
function hostSchemaTableNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (isTable(value)) names.add(getTableName(value));
  }
  return names;
}

/**
 * Refuses a table whose primary key is not exactly one column named `id`.
 *
 * `syncTriggerSql` (`sync/log.ts`) reads `NEW.id`/`OLD.id` unconditionally --
 * a table keyed by something else, or by more than one column, would install
 * triggers that compile today and throw the first time a row actually
 * changes. Checking here means that failure happens at declaration, in a
 * place a developer is looking, rather than at a write nobody suspected
 * (design spec §7.16).
 */
export function assertIntegerIdKey(raw: DatabaseSync, table: string): void {
  const pk = raw.prepare(`PRAGMA table_info(${table})`).all()
    .filter((row) => Number((row as { pk: unknown }).pk) > 0)
    .map((row) => String((row as { name: unknown }).name));
  if (pk.length !== 1 || pk[0] !== 'id') {
    throw new Error(
      `synced table ${JSON.stringify(table)}'s primary key must be a single column named id, ` +
      `got ${JSON.stringify(pk)}`,
    );
  }
}

/**
 * The full declaration gate for one plugin-declared synced table: its name
 * carries the plugin's id as a prefix and is a plain identifier
 * (`assertSyncedTableName`, `@pickarr/contract`), it does not collide with a
 * table the host already owns, synced or not, and its primary key is a lone
 * `id` column (`assertIntegerIdKey` above).
 *
 * **One function, two real call sites, on purpose.** `createSyncRegistry`
 * below is one; `host.ts`'s `register` is the other, immediately before it
 * calls `installSyncTriggers` -- a boot that never builds a registry at all
 * still validates before it installs a single trigger. Duplicating the
 * *checks* at two call sites is cheap; duplicating the *definitions* is what
 * drifts, which is the whole reason this exists as one exported function
 * rather than two copies that could disagree about what "syncable" means.
 * `sync/log.ts`'s own doc names both callers.
 *
 * This does **not** refuse two plugins declaring the same table -- that
 * check needs the whole plugin set at once (`createSyncRegistry`'s own
 * `owned` map), which a single call validating one plugin's one table has no
 * way to see. `host.register` registers one plugin at a time and has no
 * cheaper way to learn about a table a *different*, not-yet-registered
 * plugin will later declare, so that check stays where the full set is
 * actually gathered.
 */
export function assertSyncable(raw: DatabaseSync, pluginId: string, table: string): void {
  assertSyncedTableName(pluginId, table);
  if (hostSchemaTableNames().has(table)) {
    throw new Error(
      `plugin ${JSON.stringify(pluginId)} declared synced table ${JSON.stringify(table)}, ` +
      `which the host already owns`,
    );
  }
  assertIntegerIdKey(raw, table);
}

/**
 * Host tables plus every plugin's declared tables, as one lookup.
 *
 * A table nobody declares reads as empty rather than throwing: `sync_log` can
 * hold a row for a table that was synced by a plugin since removed, and a
 * client asking for it should be told nothing rather than be refused.
 *
 * Every plugin table here has already passed `assertSyncable` -- name shape,
 * the host-collision check and the lone-`id` primary key -- and this is also
 * where the one check `assertSyncable` cannot do alone runs: two plugins
 * declaring the same table, which needs every plugin's declaration gathered
 * at once rather than checked one at a time.
 */
export function createSyncRegistry(raw: DatabaseSync, plugins: readonly MediaPlugin[]): SyncRegistry {
  const owned = new Map<string, SyncedTable<unknown>>();

  for (const plugin of plugins) {
    for (const table of plugin.synced) {
      assertSyncable(raw, plugin.id, table.table);
      const claimed = owned.get(table.table);
      if (claimed !== undefined) {
        throw new Error(`two plugins declare synced table ${JSON.stringify(table.table)}`);
      }
      owned.set(table.table, table);
    }
  }
  const all = [...HOST_SYNCED_TABLES, ...owned.keys()];

  return {
    tables: () => all,
    readRows(rawHandle, table, ids) {
      if (HOST_SYNCED_TABLES.includes(table)) return readHostRows(rawHandle, table, ids);
      const plugin = owned.get(table);
      return plugin === undefined ? {} : plugin.read(rawHandle, ids);
    },
    rowsFor(rawHandle, table, mediaItemIds) {
      const plugin = owned.get(table);
      return plugin === undefined ? [] : plugin.rowsFor(rawHandle, mediaItemIds);
    },
  };
}
