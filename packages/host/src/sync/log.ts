import type { DatabaseSync } from 'node:sqlite';
import { readHostState, writeHostState } from '../db/host-state.ts';

/**
 * The three triggers that keep one `sync_log` row per changed row.
 *
 * Each deletes the row's existing entry before inserting a new one, and the
 * delete and the higher id are two separate things. The **delete** is what
 * `sync_log_row` requires: it is UNIQUE on `(table_name, row_id)`, so a
 * second entry for a row that already has one would conflict. The **higher
 * id** comes from `AUTOINCREMENT`, which issues `max_ever + 1` and never
 * reuses an id -- so the new entry lands above the cursor of a client already
 * past the old one, which is what makes the change visible to it.
 *
 * **The delete frees nothing, and an earlier wording here said it did.**
 * Measured on SQLite 3.53.4: with the log holding ids 1, 2 and 4, deleting
 * 1, 2 and 4 and inserting twice produces ids **5 and 6**, and
 * `sqlite_sequence.seq` only ever increases. That is the whole reason
 * `sync_log.id` is `AUTOINCREMENT` while every other table in this schema is
 * not -- `migrate.ts`'s `MIGRATION_15_DDL` says so twenty lines of schema
 * away, and the two claims cannot both be true.
 *
 * An upsert would keep one row per changed row too, and would keep the id --
 * measured in the design spec §2.10 -- which hides the change from exactly
 * the clients that need it. That is the alternative the delete-then-insert
 * rules out; freeing an id is not.
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

/**
 * One `upsert` entry per live row of each table, replacing whatever the log
 * held for it.
 *
 * **Why a log that indexes rows has to be seeded at all.** The triggers above
 * only log a row that *changes* after they exist, so a log created beside them
 * indexes the changes since it was created and nothing else. That is enough
 * for a cursor that walks current state and reads the log only to skip rows;
 * it is not enough for one that walks the log as an index of which rows exist
 * -- on a database that already holds rows, such a walk serves none of them,
 * permanently. Seeding is what makes `sync_log` hold exactly one entry per
 * live row, which is the invariant both cursors now read it for.
 *
 * **The `DELETE` first is required, and it is *only* required.** Required
 * because `sync_log_row` is UNIQUE on `(table_name, row_id)` (migration 15),
 * so a row that already has an entry would conflict. It does no other work:
 * the entries the insert writes land above every client's cursor because
 * `sync_log.id` is `AUTOINCREMENT` and never reuses an id, whether or not
 * anything was deleted first. Measured -- with the log holding ids 1, 2 and 4
 * and rows 1 and 2 live, this produces ids **5 and 6**, not the freed 1 and
 * 2. An earlier wording here, in spec §4 and in
 * `docs/database-migrations.md` said the delete "frees those `AUTOINCREMENT`
 * ids"; it does not, and `migrate.ts`'s own schema comment says as much. On a
 * table with no rows this is two statements that match nothing.
 *
 * `table` reaches the `FROM` clause as text, for the reason `syncTriggerSql`
 * above gives: a table's rows cannot be enumerated without naming it, and
 * SQLite binds no identifiers. Safety comes from the caller, which passes
 * either the `HOST_SYNCED_TABLES` literal or a name `assertSyncable`
 * (`sync/registry.ts`) has already checked. `table_name` *is* bound, both
 * here and in the delete: the value is a string, so nothing makes it text.
 */
export function seedSyncLog(raw: DatabaseSync, tables: readonly string[]): void {
  for (const table of tables) {
    raw.prepare('DELETE FROM sync_log WHERE table_name = ?').run(table);
    raw.prepare(
      `INSERT INTO sync_log (table_name, row_id, op, at)
         SELECT ?, id, 'upsert', CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM ${table}`,
    ).run(table);
  }
}

/**
 * `host_state` key recording that this table's live rows have been logged
 * once. One key per table rather than one per plugin: a plugin can add a
 * synced table in a later migration, populated by that migration, and a
 * per-plugin marker would skip the new table's seed forever.
 */
function seededKey(table: string): string {
  return `sync.seeded.${table}`;
}

/**
 * `seedSyncLog` for each table that has not been seeded before, recording
 * each one so a later boot does not do it again.
 *
 * **A guard, because reseeding is not harmless.** `host.ts`'s `register` runs
 * on every boot, and the seed re-logs every row at a fresh id -- so an
 * unguarded call would make every client re-read the whole library each time
 * the host restarts. The host's own six tables need no guard because
 * `migration15` seeds them inside a migration the runner skips once version
 * 15 is recorded; a plugin's declared table list has no version space of its
 * own, which is what this key stands in for.
 *
 * **Absent means seed**, which is the right way round for the transition this
 * closes: a database that has already booted with a plugin's triggers
 * installed and never been seeded has no key, so it is seeded on the next
 * boot. A predicate over the log instead -- "seed when the log holds nothing
 * for this table" -- reads more self-evident and is wrong in exactly that
 * case: one write to one row after the triggers were installed leaves the log
 * non-empty for the table, and every row that predates it unreachable for
 * good.
 *
 * The value stored is `at`, so a log being debugged by eye can be dated
 * against the seed that wrote it. Nothing reads it.
 */
export function seedSyncLogOnce(raw: DatabaseSync, tables: readonly string[], at: number): void {
  for (const table of tables) {
    if (readHostState(raw, seededKey(table)) !== null) continue;
    seedSyncLog(raw, [table]);
    writeHostState(raw, seededKey(table), String(at), at);
  }
}
