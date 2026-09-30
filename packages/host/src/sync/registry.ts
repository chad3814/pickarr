import type { DatabaseSync } from 'node:sqlite';
import { getTableName, isTable } from 'drizzle-orm';
import type { MediaPlugin, SyncedTable } from '@pickarr/contract';
import { assertSyncedTableName } from '@pickarr/contract';
import * as schema from '../db/schema.ts';
import { HOST_SYNCED_TABLES, readHostRows } from './tables.ts';

export interface SyncRegistry {
  /** Every synced table, host and plugin, in a stable order. */
  tables(): readonly string[];
  /**
   * Current state for these ids of one table, or an empty record for a table
   * nobody owns.
   *
   * **The only question either cursor asks of a plugin table.** There used to
   * be a second, `rowsFor` -- "which of your rows belong to these media
   * items" -- which the backfill needed because it paged `media_item` and had
   * to find each group's dependent rows itself. The backfill walks `sync_log`
   * now, so the ids arrive with the log entries and no relation has to be
   * traversed: a plugin declares what its rows *are*, and never how to reach
   * them from a media item.
   */
  readRows(raw: DatabaseSync, table: string, ids: readonly number[]): Record<number, unknown>;
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
 *
 * **A no-op for a table that does not exist at all, since issue #102 widened
 * this to run on every `HOST_SYNCED_TABLES` entry too.** `PRAGMA table_info`
 * on a missing table answers zero rows -- indistinguishable, from here, from
 * a real table with no declared primary key -- but a missing table already
 * fails its own way, undisguised: `CREATE TRIGGER ... ON <table>` and any
 * query against it throw SQLite's own `no such table`, which names the exact
 * problem with no help needed. This guard's job is the table that exists and
 * is keyed wrong, not the one that is not there yet --
 * `sync/tables.ts`'s `readHostRows` draws the same line, for the same
 * reason, with its own early return for an empty id list.
 */
export function assertIntegerIdKey(raw: DatabaseSync, table: string): void {
  const exists = raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return;
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
 * This does **not** refuse the same table declared twice -- that check needs
 * the whole plugin set at once (`createSyncRegistry`'s own `owned` map),
 * which a single call validating one plugin's one table has no way to see.
 *
 * **And the prefix check above is why that other guard is narrower than it
 * looks.** Measured: two plugins with *different* ids can never collide on a
 * table name, because `assertSyncedTableName` requires the table to start
 * with `<pluginId>_` and one name cannot start with two different prefixes --
 * the second plugin is refused here, for the wrong prefix, before the
 * duplicate check is ever consulted. So `createSyncRegistry`'s guard is
 * reachable only by one plugin listing a table twice in its own `synced`
 * array, or by two plugins sharing an id (which `host.register` refuses
 * separately, but this function's caller does not). That is why its message
 * names the table rather than blaming two plugins, and
 * `test/sync/registry.test.ts` pins all three cases -- replacing a test that
 * claimed to cover the duplicate guard, never reached it, and passed on this
 * prefix error instead.
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
 * where the one check `assertSyncable` cannot do alone runs: the same table
 * declared twice, which needs every plugin's declaration gathered at once
 * rather than checked one at a time. The message does not say "two plugins",
 * because one plugin listing a table twice in its own `synced` array trips
 * this too.
 *
 * **`HOST_SYNCED_TABLES` gets the lone-`id` check too, not only a plugin's
 * tables.** Issue #102: `assertSyncable`'s loop above only ever sees
 * `plugin.synced`, so a host table keyed by something other than `id` used
 * to reach `installSyncTriggers` unchecked and fail only at the first
 * `INSERT`, with SQLite's own `no such column: NEW.id` naming neither the
 * table nor the reason. Every shipped entry in `HOST_SYNCED_TABLES` does
 * have a lone `id` column today -- this is a guard against the list ever
 * gaining one that does not, not a fix for a reachable failure.
 */
export function createSyncRegistry(raw: DatabaseSync, plugins: readonly MediaPlugin[]): SyncRegistry {
  for (const table of HOST_SYNCED_TABLES) assertIntegerIdKey(raw, table);

  const owned = new Map<string, SyncedTable<unknown>>();

  for (const plugin of plugins) {
    for (const table of plugin.synced) {
      assertSyncable(raw, plugin.id, table.table);
      const claimed = owned.get(table.table);
      if (claimed !== undefined) {
        throw new Error(`synced table ${JSON.stringify(table.table)} declared twice`);
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
  };
}
