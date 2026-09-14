import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import {
  installSyncTriggers,
  relogSyncedTables,
  seedSyncLog,
  seedSyncLogOnce,
  syncedTriggerNames,
} from '../../src/sync/log.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { tailSince } from '../../src/sync/tail.ts';

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT, created_at INTEGER NOT NULL)');
  installSyncTriggers(raw, ['probe']);
  return raw;
};
const ops = (raw: ReturnType<typeof open>) =>
  raw.prepare('SELECT table_name, row_id, op FROM sync_log ORDER BY id').all()
    .map((r) => `${String((r as { op: unknown }).op)}:${Number((r as { row_id: unknown }).row_id)}`);

test('an insert, an update and a delete each log one op', () => {
  const raw = open();
  raw.prepare('INSERT INTO probe (id, v, created_at) VALUES (1, ?, 1)').run('a');
  assert.deepEqual(ops(raw), ['upsert:1']);
  raw.prepare('UPDATE probe SET v = ? WHERE id = 1').run('b');
  assert.deepEqual(ops(raw), ['upsert:1'], 'a second change replaces the entry rather than adding one');
  raw.prepare('DELETE FROM probe WHERE id = 1').run();
  assert.deepEqual(ops(raw), ['delete:1']);
});

test('at is a millisecond timestamp, not a second one multiplied by a thousand', () => {
  const raw = open();
  // Captured immediately either side of the write, and compared as a range
  // rather than by `at % 1000 !== 0`: a genuine millisecond stamp lands on a
  // whole second one time in a thousand, which would be a 0.1% flake. The
  // range is what the resolution actually changes. `unixepoch() * 1000`
  // floors to the second, so it falls *below* `before` unless the write
  // happened in the first millisecond of a second -- it fails this 999 times
  // in 1000 -- while `unixepoch('subsec') * 1000` cannot, since both sides
  // read the same wall clock.
  const before = Date.now();
  raw.prepare('INSERT INTO probe (id, v, created_at) VALUES (1, ?, 1)').run('a');
  const after = Date.now();

  const at = Number((raw.prepare('SELECT at FROM sync_log').get() as { at: unknown }).at);
  // `- 1` for the `CAST`'s truncation toward zero, which can shave a
  // millisecond off a stamp taken in the same millisecond as `before`.
  assert.ok(at >= before - 1, `at ${at} is below the time before the write (${before})`);
  assert.ok(at <= after, `at ${at} is above the time after the write (${after})`);
});

test('deleting log entries frees no id, which is the claim the column carries AUTOINCREMENT for', () => {
  // Pins the mechanism the triggers and the seed actually rely on, because an
  // earlier docblock in `sync/log.ts`, spec §4 and
  // `docs/database-migrations.md` all named the wrong one -- "the DELETE frees
  // those AUTOINCREMENT ids" -- and the schema comment twenty lines from the
  // DDL says the opposite. Only one of the two can be true.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const insert = (rowId: number) =>
    raw.prepare("INSERT INTO sync_log (table_name, row_id, op, at) VALUES ('t', ?, 'upsert', 0)").run(rowId);
  for (const rowId of [1, 2, 3, 4]) insert(rowId);
  raw.exec('DELETE FROM sync_log WHERE id IN (1, 2, 4)');
  insert(10);
  insert(11);

  assert.deepEqual(
    raw.prepare('SELECT id FROM sync_log ORDER BY id').all().map((r) => Number((r as { id: unknown }).id)),
    [3, 5, 6],
    'the next ids are max_ever + 1, not the freed 1, 2 and 4',
  );
});

test('a row changed twice takes a higher id the second time', () => {
  const raw = open();
  raw.prepare('INSERT INTO probe (id, v, created_at) VALUES (1, ?, 1)').run('a');
  const first = Number(raw.prepare('SELECT id FROM sync_log WHERE row_id = 1').get()?.id);
  raw.prepare('UPDATE probe SET v = ? WHERE id = 1').run('b');
  const second = Number(raw.prepare('SELECT id FROM sync_log WHERE row_id = 1').get()?.id);
  assert.ok(second > first, `expected a higher id, got ${second} after ${first}`);
});

test('the log holds one row per changed row, not one per change', () => {
  const raw = open();
  for (let id = 1; id <= 5; id += 1) raw.prepare('INSERT INTO probe (id, v, created_at) VALUES (?, ?, 1)').run(id, 'a');
  for (let round = 0; round < 8; round += 1) {
    for (let id = 1; id <= 5; id += 1) raw.prepare('UPDATE probe SET v = ? WHERE id = ?').run(`v${round}`, id);
  }
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM sync_log').get()?.c), 5);
});

test('a displacing REPLACE logs the deletion it causes', () => {
  const raw = openTestDatabase().raw;
  migrateHost(raw);
  raw.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, k TEXT UNIQUE, created_at INTEGER NOT NULL)');
  installSyncTriggers(raw, ['probe']);
  raw.prepare('INSERT INTO probe (id, k, created_at) VALUES (1, ?, 1)').run('dup');
  raw.prepare('INSERT OR REPLACE INTO probe (id, k, created_at) VALUES (2, ?, 1)').run('dup');
  assert.deepEqual(
    raw.prepare('SELECT row_id, op FROM sync_log ORDER BY row_id').all()
      .map((r) => `${String((r as { op: unknown }).op)}:${Number((r as { row_id: unknown }).row_id)}`),
    ['delete:1', 'upsert:2'],
    'row 1 was displaced and must be logged as deleted',
  );
});

test('installing twice is a no-op rather than an error', () => {
  const raw = open();
  assert.doesNotThrow(() => { installSyncTriggers(raw, ['probe']); });
  // Not throwing proves reinstallation is legal; it does not prove the
  // triggers still behave. Confirm the effect too: a write after the second
  // install still produces exactly one log row, not two -- which is what
  // would happen if reinstalling left the old triggers firing alongside the
  // new ones instead of replacing them.
  raw.prepare('INSERT INTO probe (id, v, created_at) VALUES (1, ?, 1)').run('a');
  assert.deepEqual(ops(raw), ['upsert:1'], 'a reinstalled trigger must not log the same change twice');
});

test('every named trigger exists after installation', () => {
  const raw = open();
  const present = new Set(
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()
      .map((r) => String((r as { name: unknown }).name)),
  );
  for (const name of syncedTriggerNames('probe')) assert.ok(present.has(name), `missing ${name}`);
});

test('a renamed table logs twice until the old triggers are dropped by name', () => {
  // `ALTER TABLE ... RENAME TO` rewrites a trigger's `ON <table>` clause and
  // renames neither the trigger nor the string literal in its body. So the
  // old triggers keep firing under the old table_name, and
  // `installSyncTriggers` -- which drops only the names it is about to
  // create -- adds a second set beside them rather than replacing them.
  // Every write then logs twice, for the rest of that database's life.
  // `docs/database-migrations.md` carries the rule this pins.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec('CREATE TABLE plug (id INTEGER PRIMARY KEY, v TEXT)');
  installSyncTriggers(raw, ['plug']);
  raw.exec('ALTER TABLE plug RENAME TO plug2');
  assert.deepEqual(
    raw.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'plug%'").all()
      .map((r) => `${String((r as { name: unknown }).name)}@${String((r as { tbl_name: unknown }).tbl_name)}`),
    ['plug_sync_ins@plug2', 'plug_sync_upd@plug2', 'plug_sync_del@plug2'],
    'the rename moves the triggers to the new table and leaves their names and bodies alone',
  );

  installSyncTriggers(raw, ['plug2']);
  raw.exec("INSERT INTO plug2 (id, v) VALUES (7, 'x')");
  assert.deepEqual(
    raw.prepare('SELECT table_name, row_id FROM sync_log ORDER BY id').all()
      .map((r) => `${String((r as { table_name: unknown }).table_name)}/${Number((r as { row_id: unknown }).row_id)}`),
    ['plug2/7', 'plug/7'],
    'one write, two entries -- the reinstall added a set rather than replacing one',
  );

  // The rule: drop the old triggers by name. Doing it after the fact repairs
  // an existing database as well as it prevents a new one.
  for (const name of syncedTriggerNames('plug')) raw.exec(`DROP TRIGGER IF EXISTS ${name}`);
  raw.exec('DELETE FROM sync_log');
  raw.exec("INSERT INTO plug2 (id, v) VALUES (8, 'y')");
  assert.deepEqual(
    raw.prepare('SELECT table_name, row_id FROM sync_log ORDER BY id').all()
      .map((r) => `${String((r as { table_name: unknown }).table_name)}/${Number((r as { row_id: unknown }).row_id)}`),
    ['plug2/8'],
    'and one write is one entry again',
  );
});

test('the seed logs one entry per live row, and nothing for a row that is gone', () => {
  // Rows inserted before the triggers exist, which is the state a migration
  // that created and populated a table in one step leaves behind.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec(`
    CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT, created_at INTEGER NOT NULL);
    INSERT INTO probe (id, v, created_at) VALUES (1, 'a', 1), (2, 'b', 1), (3, 'c', 1);
    DELETE FROM probe WHERE id = 2;
  `);
  installSyncTriggers(raw, ['probe']);
  assert.deepEqual(ops(raw), [], 'no trigger existed while those rows were written');

  seedSyncLog(raw, ['probe']);
  assert.deepEqual(ops(raw), ['upsert:1', 'upsert:3'],
    'one entry per row the table holds now -- the log indexes live rows, not history');
});

test('the seed leaves a tombstone alone, so a client below it is still told the row went away', () => {
  // The blocking defect, end to end and through the real tail. The seed used
  // to `DELETE FROM sync_log WHERE table_name = ?` and re-log live rows: a
  // `delete` entry names a row the table no longer has, so the delete removed
  // it and the `INSERT ... SELECT` could not put it back. Every client whose
  // cursor sat below that entry kept the deleted row for good -- reachable on
  // exactly the databases `seedSyncLogOnce`'s "absent means seed" guard was
  // written for, since those have had triggers running and so may already hold
  // tombstones.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  const addPerson = (id: number) => raw.prepare(
    'INSERT INTO person (id, name, provider_ref, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  ).run(id, `p${id}`, `ref${id}`);

  addPerson(1); addPerson(2); addPerson(3);
  // The cursor a client that has fully synced all three holds.
  const cursor = Number(raw.prepare('SELECT max(id) m FROM sync_log').get()?.m);
  raw.prepare('DELETE FROM person WHERE id = 3').run();

  seedSyncLogOnce(raw, ['person'], 999);

  const delivered = tailSince(raw, registry, cursor, 100).ops;
  assert.ok(
    delivered.some((op) => op.op === 'delete' && op.table === 'person' && op.id === 3),
    `the tombstone for person 3 must survive the seed, got ${JSON.stringify(delivered.map((o) => `${o.op}/${o.id}`))}`,
  );
});

test('a reseed leaves every entry it already holds at the id it already has', () => {
  // The seed indexes rows the log does not know about; it does not re-index.
  // Re-reading a row a client already holds costs that client a full re-read
  // for nothing, and the previous shape did it to every row of every table on
  // the boot after a plugin's triggers were installed.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec(`
    CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT, created_at INTEGER NOT NULL);
    INSERT INTO probe (id, v, created_at) VALUES (1, 'a', 1), (2, 'b', 1);
  `);
  seedSyncLog(raw, ['probe']);
  const entries = () => raw.prepare("SELECT id, row_id FROM sync_log WHERE table_name = 'probe' ORDER BY id").all()
    .map((r) => `${Number((r as { id: unknown }).id)}:${Number((r as { row_id: unknown }).row_id)}`);
  const first = entries();
  assert.deepEqual(first, ['1:1', '2:2'], 'fixture: two rows, two entries');

  // A third row arrives with no trigger to log it -- the case a second seed is
  // actually for.
  raw.exec("INSERT INTO probe (id, v, created_at) VALUES (3, 'c', 1)");
  seedSyncLog(raw, ['probe']);
  assert.deepEqual(entries(), ['1:1', '2:2', '3:3'],
    'the new row is indexed and the two already indexed keep their ids');
});

test('the relog re-announces every live row and still leaves a tombstone alone', () => {
  // `relogSyncedTables` is the other half, and it is not the seed: a rebuild
  // that rewrote a column has to tell every client the content changed, so it
  // does re-log live rows at fresh ids. Scoping its `DELETE` with
  // `op != 'delete'` is what keeps it from taking the tombstones with them --
  // `DROP TABLE` fires no delete trigger, so a row deleted before the rebuild
  // still has its entry in the log and is still owed to a client below it.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT, created_at INTEGER NOT NULL)');
  installSyncTriggers(raw, ['probe']);
  raw.exec(`
    INSERT INTO probe (id, v, created_at) VALUES (1, 'a', 1), (2, 'b', 1), (3, 'c', 1);
    DELETE FROM probe WHERE id = 3;
  `);
  const top = Number(raw.prepare('SELECT max(id) m FROM sync_log').get()?.m);
  assert.deepEqual(ops(raw), ['upsert:1', 'upsert:2', 'delete:3'], 'fixture: two live rows and one tombstone');

  relogSyncedTables(raw, ['probe']);

  assert.deepEqual(ops(raw), ['delete:3', 'upsert:1', 'upsert:2'],
    'the tombstone stays, at the id it already had, and the two live rows are re-announced above it');
  const relogged = raw.prepare("SELECT min(id) m FROM sync_log WHERE op = 'upsert'").get();
  assert.ok(Number((relogged as { m: unknown }).m) > top,
    'a re-announced row must land above every id the log held, or no client re-reads it');
});

test('seedSyncLogOnce seeds a table once and leaves the log alone on every boot after', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec(`
    CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT, created_at INTEGER NOT NULL);
    INSERT INTO probe (id, v, created_at) VALUES (1, 'a', 1), (2, 'b', 1);
  `);

  seedSyncLogOnce(raw, ['probe'], 1000);
  const ids = () => raw.prepare("SELECT id FROM sync_log WHERE table_name = 'probe' ORDER BY id").all()
    .map((r) => Number((r as { id: unknown }).id));
  const afterFirst = ids();
  assert.equal(afterFirst.length, 2, 'the first call seeds');

  seedSyncLogOnce(raw, ['probe'], 2000);
  seedSyncLogOnce(raw, ['probe'], 3000);
  assert.deepEqual(ids(), afterFirst,
    'the same entries at the same ids, so no client is told anything changed');
});

test('seedSyncLogOnce still seeds a table whose log entries were written by a trigger', () => {
  // The case a "seed when the log is empty for this table" predicate gets
  // wrong, and the reason the guard is a recorded marker instead. One write
  // after the triggers were installed leaves the log non-empty for the table
  // while every row that predates it is still unindexed.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec(`
    CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT, created_at INTEGER NOT NULL);
    INSERT INTO probe (id, v, created_at) VALUES (1, 'a', 1), (2, 'b', 1);
  `);
  installSyncTriggers(raw, ['probe']);
  raw.prepare('UPDATE probe SET v = ? WHERE id = 2').run('edited');
  assert.deepEqual(ops(raw), ['upsert:2'], 'fixture: the log holds one entry and row 1 has none');

  seedSyncLogOnce(raw, ['probe'], 1000);
  // Ordered by log id, so the order is itself the assertion: row 2's entry
  // stays where the trigger put it and row 1's is appended above. The seed
  // used to re-log both and would have answered `upsert:1, upsert:2` here.
  assert.deepEqual(ops(raw), ['upsert:2', 'upsert:1'],
    'row 1 must be indexed too, without moving the entry row 2 already had');
});
