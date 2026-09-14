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
 * `DROP TRIGGER IF EXISTS` first, so installation is idempotent **for the
 * same table name**, which is what lets `main.ts` call
 * `installSyncTriggers(raw, HOST_SYNCED_TABLES)` on
 * every boot immediately after `migrateHost`, and `host.ts`'s `register`
 * call it on every boot for each plugin's declared tables. Both really do
 * run per boot; the third call site does not. `db/migrate.ts`'s
 * `migration15` installs the host's six tables' triggers too, and
 * `migrateHostWith` skips that migration once version 15 is recorded, so on
 * an existing database the migration never runs again.
 *
 * **"For the same table name" is the whole of the qualification, and
 * `ALTER TABLE ... RENAME TO` is what walks through it.** The rename rewrites
 * a trigger's `ON <table>` clause and renames neither the trigger nor the
 * `table_name` string literal in its body, so the old three keep firing under
 * the old name -- and because the names below are derived from the table,
 * installing for the *new* name drops three triggers that do not exist and
 * creates a second set beside the surviving ones. Measured: after
 * `ALTER TABLE plug RENAME TO plug2` and `installSyncTriggers(raw, ['plug2'])`
 * one insert logs `[1: plug2/7 upsert, 2: plug/7 upsert]`, and does so for
 * the rest of that database's life. Drop the old triggers by name -- that is
 * what `syncedTriggerNames` is exported for -- before renaming.
 * `docs/database-migrations.md` has the rule and
 * `test/sync/log.test.ts` pins it. The create-copy-drop-rename rebuild is
 * safe: `DROP TABLE` takes the old triggers with it.
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
 * One `upsert` entry for each live row of each table **the log does not
 * already know about**. It indexes; it does not re-index.
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
 * **There is no `DELETE` here, and there was, and it destroyed tombstones.**
 * The earlier form was `DELETE FROM sync_log WHERE table_name = ?` followed
 * by a re-log of every live row. A `delete` entry names a row the table no
 * longer has, so the delete removed it and the `INSERT ... SELECT` over live
 * rows could not put it back: every client whose cursor sat below that entry
 * kept the deleted row for good. Reproduced end to end through `tailSince` --
 * three rows logged at 1, 2, 3, the third deleted at 4, the seed leaving
 * `5:upsert/1 6:upsert/2` and a client at cursor 3 never told row 3 went
 * away. Reachable on exactly the databases `seedSyncLogOnce`'s "absent means
 * seed" guard below exists for, since those have had triggers running and so
 * may already hold tombstones. `test/sync/log.test.ts` pins it.
 *
 * The anti-join is strictly better than deleting only the non-tombstones
 * would have been: it leaves every existing entry's id alone, so no client
 * re-reads a row it already holds, and indexing the unindexed is exactly what
 * this function is *for*. Announcing *changed content* is a different job and
 * `relogSyncedTables` below is the function for it.
 *
 * **It rests on one invariant: no live row holds a `delete` entry**, since
 * such a row would be skipped here and stay invisible. Confirmed two ways.
 * `sync_log_row` is UNIQUE on `(table_name, row_id)`, so a row has at most
 * one entry; and the insert trigger deletes that entry before writing its
 * own, so re-inserting a row at a previously deleted id replaces the
 * tombstone with an `upsert` -- measured, `2:delete/3` becomes `3:upsert/3`.
 * The one way to break it is to recreate a row at a deleted row's id while
 * the triggers are absent, which is the id reuse
 * `docs/database-migrations.md` forbids outright under "a row's `id` is
 * immutable", and which breaks the log as an index whatever this function
 * does.
 *
 * `table` reaches the `FROM` clause as text, for the reason `syncTriggerSql`
 * above gives: a table's rows cannot be enumerated without naming it, and
 * SQLite binds no identifiers. Safety comes from the caller, which passes
 * either the `HOST_SYNCED_TABLES` literal or a name `assertSyncable`
 * (`sync/registry.ts`) has already checked. `table_name` *is* bound, in both
 * the outer statement and the subquery: the value is a string, so nothing
 * makes it text.
 *
 * Measured plan, over `media_item`: `SCAN media_item USING COVERING INDEX
 * media_item_sync` -- every row has to be considered, which is what a seed
 * is -- and the anti-join as a `LIST SUBQUERY` built once from
 * `SEARCH sync_log USING COVERING INDEX sync_log_row (table_name=?)`, with a
 * `CREATE BLOOM FILTER` over it. So the subquery is one seek into this
 * table's slice of the log, not a lookup per row and not a second scan.
 */
export function seedSyncLog(raw: DatabaseSync, tables: readonly string[]): void {
  for (const table of tables) {
    raw.prepare(
      `INSERT INTO sync_log (table_name, row_id, op, at)
         SELECT ?, id, 'upsert', CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM ${table}
          WHERE id NOT IN (SELECT row_id FROM sync_log WHERE table_name = ?)`,
    ).run(table, table);
  }
}

/**
 * One *fresh* `upsert` entry per live row of each table, so every client
 * re-reads them -- what a migration owes after a rebuild that changed row
 * content.
 *
 * **Not the seed, and the difference is the point.** `seedSyncLog` above
 * answers "which rows exist", and a row the log already indexes needs nothing
 * from it. This answers "these rows are not what you were told they were",
 * which only a new, higher entry can say: the copy inside a
 * create-copy-drop-rename rebuild runs against a table whose triggers were
 * dropped with the old one, so nothing logged it and no client ever learns.
 * `docs/database-migrations.md` is where a migration author meets this.
 *
 * **`AND op != 'delete'` is why this does not have the seed's old defect.**
 * `DROP TABLE` does not fire the `AFTER DELETE` trigger -- measured earlier in
 * this slice -- so a row deleted *before* the rebuild still has its `delete`
 * entry in the log, and that entry is still owed to every client below it. An
 * unscoped `DELETE FROM sync_log WHERE table_name = ?` takes those with it and
 * the re-log cannot regenerate them, because the rows are not there to select.
 *
 * The scoped delete leaves exactly the tombstones behind, so the insert
 * conflicts with `sync_log_row` if a *live* row still holds one. That cannot
 * happen -- `seedSyncLog`'s doc has the two reasons -- and if it ever does,
 * this raises inside the migration's savepoint and the boot fails, which is
 * the loud end of a defect whose quiet end is a client missing a row forever.
 *
 * `table` reaches the `FROM` clause as text for `syncTriggerSql`'s reason;
 * `table_name` is bound in both statements.
 */
export function relogSyncedTables(raw: DatabaseSync, tables: readonly string[]): void {
  for (const table of tables) {
    raw.prepare("DELETE FROM sync_log WHERE table_name = ? AND op != 'delete'").run(table);
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
 * **A cost guard, and only that.** `host.ts`'s `register` runs on every boot,
 * and `seedSyncLog` is a scan of the whole table with a `sync_log` seek per
 * row; the key is what keeps a library-sized anti-join out of every restart.
 * The host's own six tables need no guard because `migration15` seeds them
 * inside a migration the runner skips once version 15 is recorded; a plugin's
 * declared table list has no version space of its own, which is what this key
 * stands in for.
 *
 * **It was a correctness guard, and it is not any more.** While the seed
 * re-logged every row at a fresh id, an unguarded call made every client
 * re-read the whole library on every restart; the seed only indexes rows the
 * log does not know about now, so calling it twice is a no-op and the guard
 * buys work avoided rather than damage avoided. It stays because the work is
 * real and because the key also records *that* a table made the transition,
 * which nothing else does.
 *
 * **Absent means seed**, which is the right way round for the transition this
 * closes: a database that has already booted with a plugin's triggers
 * installed and never been seeded has no key, so it is seeded on the next
 * boot. A table-level predicate over the log instead -- "seed when the log
 * holds nothing for this table" -- reads more self-evident and is wrong in
 * exactly that case: one write to one row after the triggers were installed
 * leaves the log non-empty for the table, and every row that predates it
 * unreachable for good. The seed's own `NOT IN` is that predicate asked per
 * *row*, which is the form that is actually right; this key only decides
 * whether to ask it at all.
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
