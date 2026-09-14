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
}

/**
 * Every table the host's own schema declares, host and plugin alike.
 *
 * `HOST_SYNCED_TABLES` only names the *synced* subset of the host's own
 * tables -- `sync_log` itself, `auth_user`, `secret` and the rest are just as
 * real, and just as much the host's to refuse a plugin claiming. This is
 * what `createSyncRegistry` checks a plugin's declared table against, so a
 * plugin cannot claim any table the host already has, synced or not.
 *
 * Read from `schema.ts`'s own exported table objects via `getTableName`,
 * not from `sqlite_master`: by the time a real plugin's tables exist in
 * `sqlite_master` too, having already run `migratePlugin`, so a snapshot of
 * "what tables currently exist" would wrongly flag a plugin's own table as
 * a host collision. `schema.ts` is a fixed, host-only set regardless of
 * what has migrated.
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
 * Host tables plus every plugin's declared tables, as one lookup.
 *
 * A table nobody declares reads as empty rather than throwing: `sync_log` can
 * hold a row for a table that was synced by a plugin since removed, and a
 * client asking for it should be told nothing rather than be refused.
 *
 * This is also where a plugin's declared table name is finally checked
 * against reality, not just against its own id. `assertSyncedTableName`
 * (`@pickarr/contract`) only knows whether a name carries the *given*
 * plugin's id as a prefix -- it has no business knowing the host's table
 * names, so `assertSyncedTableName('sync', 'sync_log')` passes; nothing in
 * `packages/contract` can see that `sync_log` is already the host's. This
 * function can, because it is the one place both sets -- the host's own
 * tables (`schema.ts`) and every plugin's declared tables -- are actually
 * gathered, so it refuses a plugin table that collides with either.
 */
export function createSyncRegistry(raw: DatabaseSync, plugins: readonly MediaPlugin[]): SyncRegistry {
  const hostTables = hostSchemaTableNames();
  const owned = new Map<string, SyncedTable<unknown>>();

  for (const plugin of plugins) {
    for (const table of plugin.synced) {
      assertSyncedTableName(plugin.id, table.table);
      if (hostTables.has(table.table)) {
        throw new Error(
          `plugin ${JSON.stringify(plugin.id)} declared synced table ${JSON.stringify(table.table)}, ` +
          `which the host already owns`,
        );
      }
      const claimed = owned.get(table.table);
      if (claimed !== undefined) {
        throw new Error(`two plugins declare synced table ${JSON.stringify(table.table)}`);
      }
      assertIntegerIdKey(raw, table.table);
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
