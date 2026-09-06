import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { JobHandler, JobRecord, PluginContext } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createRunner, wrapHandlerForBackoff } from '../../src/jobs/runner.ts';

/**
 * Covers `runner.ts`'s own new pieces that `runner.test.ts` -- frozen as
 * Task 7's evidence that the swap changed nothing it already tested --
 * cannot: `wrapHandlerForBackoff` is not reachable from `Runner.runOnce()`
 * in a way that observes its two documented properties (`run-job.ts`'s own
 * guards absorb both once wired through `runOnce`; see the doc on
 * `wrapHandlerForBackoff` itself), and the unhandled-kind branch's "never
 * claimed" answer has no assertion anywhere on this branch.
 */

/** A `PluginContext` whose capabilities all reject if called, the same shape `runner.test.ts` uses. */
const fakeCtx: PluginContext = {
  db: undefined,
  media: {
    createMediaItem: async () => { throw new Error('media.createMediaItem: not used by this test'); },
    updateMediaItem: async () => { throw new Error('media.updateMediaItem: not used by this test'); },
    claimProviderRef: async () => { throw new Error('media.claimProviderRef: not used by this test'); },
    relinkRssItem: async () => { throw new Error('media.relinkRssItem: not used by this test'); },
    dropMediaItem: async () => { throw new Error('media.dropMediaItem: not used by this test'); },
    attachPoster: async () => { throw new Error('media.attachPoster: not used by this test'); },
    attachBackground: async () => { throw new Error('media.attachBackground: not used by this test'); },
    attachLogo: async () => { throw new Error('media.attachLogo: not used by this test'); },
    upsertPerson: async () => { throw new Error('media.upsertPerson: not used by this test'); },
    attachRole: async () => { throw new Error('media.attachRole: not used by this test'); },
    setResolution: async () => { throw new Error('media.setResolution: not used by this test'); },
  },
  jobs: { enqueue: async () => { throw new Error('jobs.enqueue: not used by this test'); } },
  fetch: {
    json: async () => { throw new Error('fetch.json: not used by this test'); },
    bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  },
  downloads: { submit: async () => { throw new Error('downloads.submit: not used by this test'); } },
  log: () => {},
};

/** A row read back from `jobs`, narrowed the same way `runner.test.ts`'s own `readJob` does. */
function readJob(raw: DatabaseSync, id: number) {
  const row = raw.prepare(
    'SELECT state, attempts, run_at, last_error, started_at FROM jobs WHERE id = ?',
  ).get(id);
  assert.ok(row, `job ${id} has no row`);
  return row as {
    state: unknown; attempts: unknown; run_at: unknown; last_error: unknown; started_at: unknown;
  };
}

/** `wrapHandlerForBackoff` only ever reads `max_attempts` and writes on the row `runJob` already claimed -- this simulates that claim directly, without going through `runJob` itself. */
function insertClaimedJob(raw: DatabaseSync, opts: { attempts: number; maxAttempts: number; now: number }): number {
  const result = raw.prepare(`
    INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, started_at, last_error, created_at, updated_at)
    VALUES ('alpha', 'greet', '{}', ?, ?, ?, 'running', ?, NULL, ?, ?)
  `).run(opts.attempts, opts.maxAttempts, opts.now, opts.now, opts.now, opts.now);
  return Number(result.lastInsertRowid);
}

const boom: JobHandler = async () => { throw new Error('handler boom'); };

test('wrapHandlerForBackoff settles a rejecting handler itself, rather than letting the rejection reach its own caller', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const opts = { now: () => now, backoffMs: () => 5000, defaultMaxAttempts: 5 };
  const id = insertClaimedJob(raw, { attempts: 1, maxAttempts: 5, now });
  const job: JobRecord = { id, kind: 'greet', payload: {}, attempts: 1 };

  const wrapped = wrapHandlerForBackoff(raw, opts, boom);
  // If this rejects, the mutation ("rethrow instead of resolving") is back:
  // a wrapper whose whole point is to settle a rejection itself must not
  // hand it onward.
  await assert.doesNotReject(() => wrapped(job, fakeCtx, undefined));

  const row = readJob(raw, id);
  assert.equal(row.state, 'ready', 'not yet at max attempts, so this retries');
  assert.equal(row.run_at, now + 5000, 'run_at must come from the injected backoffMs, not run-job.ts\'s fixed curve');
  assert.equal(row.last_error, 'handler boom');
});

test('wrapHandlerForBackoff does not overwrite a row something else already settled', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const opts = { now: () => now, backoffMs: () => 5000, defaultMaxAttempts: 5 };
  const id = insertClaimedJob(raw, { attempts: 1, maxAttempts: 5, now });

  // Simulates a handler settling late, after something else -- `run-job.ts`'s
  // own timeout, in production -- already failed the row. Done directly
  // via `raw`, not by waiting on a real 5-minute timeout: the property under
  // test is the guard on `wrapHandlerForBackoff`'s own write, not the
  // timeout that would ordinarily produce this state.
  raw.prepare("UPDATE jobs SET state = 'dead', last_error = 'already handled elsewhere', run_at = 999999 WHERE id = ?")
    .run(id);

  const job: JobRecord = { id, kind: 'greet', payload: {}, attempts: 1 };
  const wrapped = wrapHandlerForBackoff(raw, opts, boom);
  await wrapped(job, fakeCtx, undefined);

  // If this changed, the mutation ("drop the `AND state = 'running'`
  // guard") is back: a late-settling handler must not be able to overwrite
  // an outcome something else already decided.
  const row = readJob(raw, id);
  assert.equal(row.state, 'dead', 'a row no longer running must not be reopened');
  assert.equal(row.last_error, 'already handled elsewhere', 'the earlier outcome must survive');
  assert.equal(row.run_at, 999999, 'the earlier outcome\'s run_at must survive');
});

test('a job whose kind has no handler is never claimed, through the runner\'s own copy of that branch', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 1000;
  const runner = createRunner(raw, { now: () => now, backoffMs: () => 0, defaultMaxAttempts: 3 });
  const id = runner.enqueue('alpha', { kind: 'mystery', payload: {} });

  const ran = await runner.runOnce(() => undefined, () => fakeCtx);

  assert.equal(ran, true);
  const row = readJob(raw, id);
  assert.equal(row.state, 'dead');
  // Never claimed: a kind nobody will ever register a handler for gains
  // nothing from an attempt charged against it, so this goes straight from
  // `ready` to `dead` without `run-job.ts`'s claim ever touching it.
  assert.equal(row.attempts, 0, 'an unhandled kind must not be charged an attempt it never ran');
  assert.equal(row.started_at, null, 'an unhandled kind was never started');
});
