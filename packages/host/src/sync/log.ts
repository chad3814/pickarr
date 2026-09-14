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
 * `DROP TRIGGER IF EXISTS` first, so installation is idempotent, which is
 * what lets `main.ts` call `installSyncTriggers(raw, HOST_SYNCED_TABLES)` on
 * every boot immediately after `migrateHost`, and `host.ts`'s `register`
 * call it on every boot for each plugin's declared tables. Both really do
 * run per boot; the third call site does not. `db/migrate.ts`'s
 * `migration15` installs the host's six tables' triggers too, and
 * `migrateHostWith` skips that migration once version 15 is recorded, so on
 * an existing database the migration never runs again.
 *
 * **The per-boot reinstall is defensive, not corrective: a trigger does not
 * need reinstalling in order to work.** Measured on SQLite 3.53.4 -- a
 * trigger created on one connection is in `sqlite_master` on the next
 * connection to the same file and fires there with nothing reinstalled, the
 * same as any other schema object. So a database migrated to version 15 last
 * month logs correctly today whether or not `main.ts` calls this. What the
 * per-boot call buys is the one case that would otherwise be unrecoverable:
 * a later migration that rebuilds a synced table by SQLite's
 * create-copy-drop-rename pattern drops that table's three triggers along
 * with the old table, and, migration 15 having been recorded long ago,
 * nothing else would ever put them back. The symptom is every client
 * silently missing every subsequent change to that table, with nothing
 * failing at runtime -- which is why the repair is unconditional here rather
 * than conditional on noticing.
 *
 * **`at` is `unixepoch('subsec')`, not `unixepoch()`.** Both mean "now" --
 * `'now'` is `unixepoch`'s default timespec -- but the bare form is whole
 * seconds, so multiplying by 1000 produced a number that looked like
 * milliseconds and was accurate to a thousand of them. Measured on SQLite
 * 3.53.4: `unixepoch('subsec') * 1000` equals `Date.now()` and advances per
 * millisecond, where `unixepoch() * 1000` repeats the same value for a
 * second. The `CAST` is explicit rather than left to the column's INTEGER
 * affinity, which converts the float anyway; measured, both store `integer`.
 *
 * Nothing reads this column today -- ordering is by `id`, which is what the
 * cursors compare -- so this is for whoever first debugs a log by eye, and
 * a column that lies to them by three orders of magnitude is worse than no
 * column.
 *
 * `table` reaches the SQL below as text, not as a bound parameter: a trigger
 * body is DDL, and SQLite binds no parameters there, so there is no
 * placeholder to put it in. That makes this function unsafe against an
 * arbitrary string -- safety here comes from the caller, not from anything
 * below this line.
 *
 * `installSyncTriggers` has three real callers, and only one of them
 * reaches this function with a name that needs validating. `migrate.ts`'s
 * `migration15` and `main.ts`'s boot call both pass the hardcoded
 * `HOST_SYNCED_TABLES` literal, which needs no runtime validation -- it is
 * a fixed list the host's own schema defines. `host.ts`'s `register` passes
 * a plugin's own declared table names, and *does* reach this function with
 * a name nothing here has validated: `register` calls
 * `sync/registry.ts`'s `assertSyncable` -- name shape
 * (`assertSyncedTableName`), the host-collision check, and the lone-`id`
 * primary-key check -- for each of a plugin's declared tables, immediately
 * before calling this function with them. `createSyncRegistry` calls the
 * same `assertSyncable` for the same reason, when a running host later
 * builds the registry its read API serves from -- so a name reaching any
 * real caller of `installSyncTriggers` has already passed that gate. This
 * function itself still does nothing to enforce any of it, and remains
 * unsafe against a name that reaches it by some other route.
 */
export function syncTriggerSql(table: string): string {
  const [ins, upd, del] = syncedTriggerNames(table);
  const log = (rowId: string, op: string) =>
    `DELETE FROM sync_log WHERE table_name = '${table}' AND row_id = ${rowId};
     INSERT INTO sync_log (table_name, row_id, op, at)
       VALUES ('${table}', ${rowId}, '${op}', CAST(unixepoch('subsec') * 1000 AS INTEGER));`;
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
