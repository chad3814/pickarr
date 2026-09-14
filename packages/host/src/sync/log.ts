import type { DatabaseSync } from 'node:sqlite';

/**
 * The three triggers that keep one `sync_log` row per changed row.
 *
 * Each deletes the row's existing entry before inserting a new one. That is
 * not an optimisation: the delete is what frees the old `AUTOINCREMENT` id so
 * the insert allocates a higher one, and a higher id is what makes the change
 * visible to a client whose cursor is already past the old entry. An upsert
 * would keep one row per changed row too, and would keep the id -- measured
 * in the design spec §2.10 -- which hides the change from exactly the clients
 * that need it.
 *
 * `DROP TRIGGER IF EXISTS` first, so installation is idempotent: the host
 * calls this on every boot, for host tables and plugin tables alike.
 *
 * `table` reaches the SQL below as text, not as a bound parameter: a trigger
 * body is DDL, and SQLite binds no parameters there, so there is no
 * placeholder to put it in. That makes this function unsafe against an
 * arbitrary string -- safety here comes from the caller, not from anything
 * below this line.
 *
 * `installSyncTriggers`'s only caller today is still `migrate.ts`, which
 * passes the hardcoded `HOST_SYNCED_TABLES` literal -- never a
 * plugin-declared name reaches this function yet. But a plugin-declared name
 * is no longer unvalidated on its way here in principle: `createSyncRegistry`
 * (`sync/registry.ts`) runs every plugin's declared table through
 * `assertSyncedTableName`, plus a check that name does not collide with a
 * table the host already owns and that its primary key is a lone `id`
 * column, before ever adding it to what `SyncRegistry.tables()` returns.
 * Whatever a future caller passes from `registry.tables()` to
 * `installSyncTriggers` has therefore already passed that gate -- this
 * function itself still does nothing to enforce it, and remains unsafe
 * against a name that reaches it by some other route.
 */
export function syncTriggerSql(table: string): string {
  const [ins, upd, del] = syncedTriggerNames(table);
  const log = (rowId: string, op: string) =>
    `DELETE FROM sync_log WHERE table_name = '${table}' AND row_id = ${rowId};
     INSERT INTO sync_log (table_name, row_id, op, at)
       VALUES ('${table}', ${rowId}, '${op}', unixepoch() * 1000);`;
  return `
    DROP TRIGGER IF EXISTS ${ins};
    CREATE TRIGGER ${ins} AFTER INSERT ON ${table} BEGIN ${log('NEW.id', 'upsert')} END;
    DROP TRIGGER IF EXISTS ${upd};
    CREATE TRIGGER ${upd} AFTER UPDATE ON ${table} BEGIN ${log('NEW.id', 'upsert')} END;
    DROP TRIGGER IF EXISTS ${del};
    CREATE TRIGGER ${del} AFTER DELETE ON ${table} BEGIN ${log('OLD.id', 'delete')} END;
  `;
}

/** The three trigger names for a table, in insert/update/delete order. */
export function syncedTriggerNames(table: string): readonly [string, string, string] {
  return [`${table}_sync_ins`, `${table}_sync_upd`, `${table}_sync_del`];
}

/** Installs (or reinstalls) the triggers for each table. */
export function installSyncTriggers(raw: DatabaseSync, tables: readonly string[]): void {
  for (const table of tables) raw.exec(syncTriggerSql(table));
}
