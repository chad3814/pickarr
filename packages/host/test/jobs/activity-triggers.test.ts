import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase, setActivityChangedListener } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { ACTIVITY_TRIGGER_NAMES, installActivityTriggers } from '../../src/jobs/activity-triggers.ts';
import { createRunner } from '../../src/jobs/runner.ts';

test('the jobs triggers call the activity function on insert, update and delete, and reinstall idempotently', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  installActivityTriggers(raw);
  assert.doesNotThrow(() => { installActivityTriggers(raw); });
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs' ORDER BY name").all()
    .map((row) => String(row['name']));
  assert.deepEqual(names, [...ACTIVITY_TRIGGER_NAMES].toSorted());
  let calls = 0;
  setActivityChangedListener(raw, () => { calls += 1; });
  const runner = createRunner(raw, { now: () => 1000, defaultMaxAttempts: 3 });
  const id = runner.enqueue('alpha', { kind: 'noop', payload: {} });
  assert.equal(calls, 1, 'insert');
  raw.prepare("UPDATE jobs SET state = 'done' WHERE id = ?").run(id);
  assert.equal(calls, 2, 'update');
  raw.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  assert.equal(calls, 3, 'delete');
  const bodies = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs'").all().map((row) => String(row['sql']));
  for (const body of bodies) assert.ok(!/INSERT|UPDATE|DELETE/.test(body.split('BEGIN')[1] ?? ''), `writes nothing: ${body}`);
});
