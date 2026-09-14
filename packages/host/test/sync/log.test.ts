import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { installSyncTriggers, syncedTriggerNames } from '../../src/sync/log.ts';

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
