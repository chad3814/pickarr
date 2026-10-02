# Activities Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `/activities` page showing, live, the host's jobs (running, waiting, dead, recently finished), its outbound fetch queue, and every download in progress — and `done` jobs pruned after 24 hours.

**Architecture:** A guarded `GET /api/activity` read route answers the job lists and a fetch-queue snapshot; `jobs` is never replicated. A second registered SQLite function, called by boot-installed triggers on `jobs`, and an `onChange` hook in the fetch queue feed a new `activity` event on the existing SSE hub; the leader tab relays it over the BroadcastChannel and every tab's hook refetches. Active downloads come from the replica with no host work. The dispatcher's safety sweep prunes `done` rows older than a day.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `node:sqlite`, `node:http`, `node:test`, React + `@testing-library/react` + `fake-indexeddb`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-activities-design.md`

## Global Constraints

- Worktree `/Users/chad/Projects/pickarr/worktrees/phase4-activities`, branch `phase4-activities`. Never edit `worktrees/main`, never push, never merge, never use bare `git stash`.
- Route `GET /api/activity`, `methods: ['GET']`, `open: false`. Body shape exactly `ActivityRead` (spec §1). **No `payload` or `payloadJson` key anywhere in the body.** `recent` ≤ 50, newest first; `waiting` soonest `runAt` first; `dead` newest first.
- `ActivityRequest.target` = `redactUrl(url)` with everything from the first `?` removed, computed once at enqueue. The raw URL is never stored in the queue.
- Second SQLite function `pickarr_activity_changed`, registered in `db/open.ts`'s `wrap` on every connection, **without** `directOnly`. Triggers `jobs_activity_ins`/`_upd`/`_del` installed at boot, not by a migration; their body is `SELECT pickarr_activity_changed();` only.
- SSE event name `activity`, no data line, coalesced per turn like `changed`.
- Migration **26**: `CREATE INDEX jobs_done_updated ON jobs (updated_at) WHERE state = 'done'`.
- Prune: `DELETE FROM jobs WHERE state = 'done' AND updated_at < now − 86_400_000`, in the dispatcher's safety interval.
- Browser: `/activities` route and `Activities` nav tab; hook fetches on mount, on `activity`, and every `30_000` ms; `activeDownloads()` excludes `delivered` and `failed`.
- Empty-state sentences verbatim: `Nothing running`, `Nothing waiting`, `No dead jobs`, `Nothing finished recently`, `No requests queued`, `No downloads in progress`. Loading: `Loading…`. Unreachable: `Couldn't reach Pickarr`.
- Nothing about a row in a log line; no URL, path or query string in a response body except `target` as defined.
- No `any`. Narrow instead of casting. A comment must be true of the code beside it (`CLAUDE.md`). Web hazards: `afterEach(cleanup)`, never hand a live DOM node to `node:assert`, no `t.mock.timers` (spy on `setInterval`'s arguments instead).
- Gate: `npm run check` (redirect to a file, read `$?`). `timeout` is not a macOS command. Signing: retry once, then `git -c commit.gpgsign=false commit …` and report UNSIGNED.

## Review Focus

1. **A job row with a state the page does not know** (a future `paused`). The route must not throw or drop the whole answer; the row is simply in none of the four lists. Test in Task 3.
2. **A URL the queue cannot parse** (`new URL` throws). `redactUrl` already falls back to `redactText`; `target` must still be computed and the request still queued. Test in Task 2.
3. **The page open while the replica resets** (generation change). `activeDownloads()` must re-read after `subscribeReset`, not keep a stale list. Test in Task 4.
4. **A download whose `rss_item` has not replicated yet** (log order is not row order). The list shows the row with `filename` as `unknown release` rather than dropping it. Test in Task 4.
5. **A dead job with a very long `lastError`.** Rendered in full in a `<pre>`-like element that wraps, never truncated silently, and never as an `aria-label`. Test in Task 4.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/contract/src/activity.ts` (new), `index.ts` | `ActivityRead`, `ActivityJob`, `ActivityHost`, `ActivityRequest` | 1 |
| `packages/host/src/db/open.ts` | `pickarr_activity_changed` + `setActivityChangedListener` | 1 |
| `packages/host/src/jobs/activity-triggers.ts` (new) | `installActivityTriggers(raw)` | 1 |
| `packages/host/src/db/migrate.ts` | migration 26 | 1 |
| `packages/host/src/jobs/dispatcher.ts` | prune in the safety interval | 1 |
| `packages/host/src/fetch/queue.ts` | request records, `snapshot()`, `onChange` | 2 |
| `packages/host/src/api/activity.ts` (new) | `readActivity(raw, snapshot)` | 3 |
| `packages/host/src/sync/events.ts` | `notifyActivity()`, `event: activity` | 3 |
| `packages/host/src/api/server.ts`, `main.ts`, `packages/e2e/src/harness-2.ts` | the route; wiring | 3 |
| `packages/web/src/auth/sendJson.ts` | `GET` | 4 |
| `packages/web/src/store/notify.ts`, `leader.ts`, `sync.ts`, `index.ts`, `rows.ts` | `subscribeActivity`/`emitActivity`, relay, `activeDownloads()` | 4 |
| `packages/web/src/activity/useActivity.ts`, `useActiveDownloads.ts`, `Activities.tsx` (new), `styles/activities.css` (new), `styles/index.css`, `shell/Shell.tsx` | the page | 4 |
| `packages/e2e/tests/activities.spec.ts` (new) | e2e | 5 |

Tasks 1 and 2 are independent and may run in parallel. Tasks 3 and 4 both depend on Task 1; Task 3 also depends on Task 2. Task 5 depends on everything.

---

### Task 1: Contract types, the activity function and triggers, migration 26, and pruning

**Files:**
- Create: `packages/contract/src/activity.ts`; modify `packages/contract/src/index.ts`
- Modify: `packages/host/src/db/open.ts` (~25-40, `wrap` ~50-70)
- Create: `packages/host/src/jobs/activity-triggers.ts`
- Modify: `packages/host/src/db/migrate.ts` (after `{ version: 25, … }` at ~1463)
- Modify: `packages/host/src/jobs/dispatcher.ts` (`start` ~355-362)
- Test: `packages/host/test/db/open.test.ts`, `packages/host/test/jobs/activity-triggers.test.ts` (new), `packages/host/test/db/migrate.test.ts`, `packages/host/test/jobs/dispatcher.test.ts`

**Interfaces:**
- Produces (contract):

```ts
export interface ActivityRequest { readonly method: string; readonly target: string; }
export interface ActivityHost {
  readonly hostname: string; readonly limit: number;
  readonly inFlight: readonly ActivityRequest[]; readonly waiting: readonly ActivityRequest[];
}
export interface ActivityJob {
  readonly id: number; readonly pluginId: string; readonly kind: string;
  readonly attempts: number; readonly maxAttempts: number;
  readonly runAt: number; readonly startedAt: number | null; readonly updatedAt: number;
  readonly lastError: string | null;
}
export interface ActivityRead {
  readonly jobs: {
    readonly running: readonly ActivityJob[]; readonly waiting: readonly ActivityJob[];
    readonly dead: readonly ActivityJob[]; readonly recent: readonly ActivityJob[];
  };
  readonly fetches: readonly ActivityHost[];
}
export const ACTIVITY_RECENT_LIMIT = 50;
```
- Produces (host): `setActivityChangedListener(raw, listener | undefined): void` from `db/open.ts`; `installActivityTriggers(raw: DatabaseSync): void` and `ACTIVITY_TRIGGER_NAMES` from `jobs/activity-triggers.ts`; `DONE_JOB_RETENTION_MS = 86_400_000` exported from `dispatcher.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/host/test/db/open.test.ts`:

```ts
test('every connection carries pickarr_activity_changed, and a listener hears each call until removed', () => {
  const { raw } = openTestDatabase();
  raw.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)');
  raw.exec('CREATE TRIGGER probe_act AFTER INSERT ON probe BEGIN SELECT pickarr_activity_changed(); END');
  assert.doesNotThrow(() => raw.exec('INSERT INTO probe DEFAULT VALUES'), 'no listener: a no-op, never a missing function');
  let calls = 0;
  setActivityChangedListener(raw, () => { calls += 1; });
  raw.exec('INSERT INTO probe DEFAULT VALUES; INSERT INTO probe DEFAULT VALUES');
  assert.equal(calls, 2);
  setActivityChangedListener(raw, undefined);
  raw.exec('INSERT INTO probe DEFAULT VALUES');
  assert.equal(calls, 2);
});
```

`packages/host/test/jobs/activity-triggers.test.ts`:

```ts
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
```

Append to `packages/host/test/db/migrate.test.ts`:

```ts
test('migration 26 indexes done jobs by updated_at, for the prune', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const index = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'jobs_done_updated'").get();
  assert.ok(index, 'the index exists');
  assert.match(String(index['sql']), /WHERE state = 'done'/);
});
```

Append to `packages/host/test/jobs/dispatcher.test.ts` (its helpers `insertReadyJob`, `createFakeTimers`, `noopLog`, `noopSleep`, `realAbortSignal`, `fakeCtx`, `noHandlers` exist):

```ts
test("the safety interval prunes done jobs older than a day and nothing else", () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const now = 10 * DONE_JOB_RETENTION_MS;
  const seed = (state: string, updatedAt: number): number => Number(raw.prepare(`
    INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, last_error, created_at, updated_at)
    VALUES ('t', 'noop', '{}', 1, 3, ?, ?, NULL, ?, ?)`).run(updatedAt, state, updatedAt, updatedAt).lastInsertRowid);
  const oldDone = seed('done', now - DONE_JOB_RETENTION_MS - 1);
  const freshDone = seed('done', now - DONE_JOB_RETENTION_MS + 60_000);
  const oldDead = seed('dead', now - 10 * DONE_JOB_RETENTION_MS);
  const oldReady = seed('ready', now - 10 * DONE_JOB_RETENTION_MS);
  const { timers, setIntervalCalls } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => now, timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(noHandlers, () => fakeCtx);
  const safety = setIntervalCalls.find((call) => call.ms === SAFETY_INTERVAL_MS);
  assert.ok(safety, 'the safety interval is armed');
  safety.fn();
  const ids = raw.prepare('SELECT id FROM jobs ORDER BY id').all().map((row) => Number(row['id']));
  assert.deepEqual(ids, [freshDone, oldDead, oldReady], `only the day-old done row is gone; ${String(oldDone)} was it`);
  dispatcher.stop();
});
```

Read the file's `createFakeTimers` return shape (it records `setIntervalCalls` with `{ handle, ms, fn }`) and `noHandlers` name before running; adapt names if they differ.

- [ ] **Step 2: Run and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/db/open.test.ts packages/host/test/jobs/activity-triggers.test.ts packages/host/test/db/migrate.test.ts packages/host/test/jobs/dispatcher.test.ts 2>&1 | grep -E "^not ok|✖|Cannot find" | head`
Expected: FAIL.

- [ ] **Step 3: Contract types**

`packages/contract/src/activity.ts`: the interfaces and constant from the Interfaces block, with this module docblock:

```ts
/**
 * What `GET /api/activity` answers: the host's own work, as an operator
 * reads it (design spec 2026-10-02 §1).
 *
 * **Never a payload.** A job's arguments are ids, and the artwork job's
 * carry people's names; the page has no use for either. `ActivityJob`
 * therefore has no payload field, and the route's `SELECT` never names
 * `payload_json`.
 *
 * **`target` is not a URL.** It is `redactUrl`'s output with the query
 * string removed -- origin and path, passkeys masked -- the same trust
 * level as the host's own log lines, which is the only reason a path
 * may appear in a response body at all.
 */
```

Export everything from `packages/contract/src/index.ts`.

- [ ] **Step 4: The function and the triggers**

`db/open.ts`: a second `WeakMap`, `activityListeners`, `setActivityChangedListener` mirroring `setSyncChangedListener` (docblock: fired by the `jobs` triggers `jobs/activity-triggers.ts` installs; inside the writing statement, so a listener only takes note), and in `wrap`, beside the sync function:

```ts
  raw.function('pickarr_activity_changed', () => {
    activityListeners.get(raw)?.();
    return null;
  });
```

`packages/host/src/jobs/activity-triggers.ts`:

```ts
/**
 * Three triggers on `jobs` that tell the host, in-process, that a job
 * changed -- the Activities page's wake signal (design spec 2026-10-02 §3).
 *
 * They write nothing: each body is one call to `pickarr_activity_changed()`,
 * which `db/open.ts` registers on every connection. Installed at boot like
 * the sync triggers (`sync/log.ts`), dropped and recreated each time, so
 * this is not a migration and changing a body here freezes nothing.
 * `jobs` is not a synced table and never will be (`sync/tables.ts`); these
 * are the only triggers it carries.
 */
import type { DatabaseSync } from 'node:sqlite';

export const ACTIVITY_TRIGGER_NAMES = ['jobs_activity_ins', 'jobs_activity_upd', 'jobs_activity_del'] as const;

export function installActivityTriggers(raw: DatabaseSync): void {
  const [ins, upd, del] = ACTIVITY_TRIGGER_NAMES;
  raw.exec(`
    DROP TRIGGER IF EXISTS ${ins};
    CREATE TRIGGER ${ins} AFTER INSERT ON jobs BEGIN SELECT pickarr_activity_changed(); END;
    DROP TRIGGER IF EXISTS ${upd};
    CREATE TRIGGER ${upd} AFTER UPDATE ON jobs BEGIN SELECT pickarr_activity_changed(); END;
    DROP TRIGGER IF EXISTS ${del};
    CREATE TRIGGER ${del} AFTER DELETE ON jobs BEGIN SELECT pickarr_activity_changed(); END;
  `);
}
```

- [ ] **Step 5: Migration 26 and the prune**

`migrate.ts`:

```ts
/** The prune's index (`jobs/dispatcher.ts`): `done` rows by age. `jobs` is not synced, so no trigger survives or needs to. */
const MIGRATION_26 = `
CREATE INDEX jobs_done_updated ON jobs (updated_at) WHERE state = 'done';
`;
```
and `{ version: 26, up: (db) => db.exec(MIGRATION_26) },`.

`dispatcher.ts`: export `DONE_JOB_RETENTION_MS = 86_400_000` with a docblock (a day of `recent` history for the Activities page; `dead` rows are never pruned, they are what an operator reads). Add:

```ts
  /** Deletes `done` rows older than the retention. Fires the `jobs` triggers, so the Activities page refreshes. */
  function prune(): void {
    raw.prepare("DELETE FROM jobs WHERE state = 'done' AND updated_at < ?").run(opts.now() - DONE_JOB_RETENTION_MS);
  }
```
and change the safety interval to `opts.timers.setInterval(() => { prune(); rearm(); }, SAFETY_INTERVAL_MS)`. Extend the `SAFETY_INTERVAL_MS` docblock by one sentence.

- [ ] **Step 6: Run, gate, commit**

Run the four test files — Expected: PASS. Then `npm run check > /tmp/p4-t1.log 2>&1; echo "exit $?"; rm -f /tmp/p4-t1.log` — Expected: exit 0.

```bash
git add -A packages && git commit -m "Let the host hear job changes, index done jobs, and prune them after a day"
```

---

### Task 2: Instrument the fetch queue

**Files:**
- Modify: `packages/host/src/fetch/queue.ts` (`QueuedFetch` ~19, `createHostFetch` ~175-330)
- Test: the file that tests `createHostFetch` (find it: `grep -rln "createHostFetch" packages/host/test`)

**Interfaces:**
- Consumes: `ActivityHost`, `ActivityRequest` from `@pickarr/contract` (Task 1). If Task 1 has not landed when this task starts, declare the two interfaces locally in `queue.ts` with a `// moves to @pickarr/contract` note and let Task 3 switch the import.
- Produces: `QueuedFetch.snapshot(): readonly ActivityHost[]`; `createHostFetch`'s deps gain `onChange?: () => void`.

- [ ] **Step 1: Write the failing tests**

In the queue test file, using its existing way of building a `createHostFetch` with a stub `fetch` (read one test first; there is a deferred-fetch helper or you can build one with a promise you resolve by hand):

```ts
test('snapshot shows waiting and in-flight requests by method and redacted target, and empties when they settle', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const changes: number[] = [];
  const fetch = createHostFetch({
    fetch: async (url) => { await gate; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); },
    limits: { default: 1 },
    onChange: () => { changes.push(1); },
  });
  const first = fetch.json('https://sab.example:8080/api?mode=queue&apikey=SECRETKEY', { method: 'GET' });
  const second = fetch.json('https://sab.example:8080/api?mode=history&apikey=SECRETKEY', { method: 'GET' });
  await new Promise((r) => setImmediate(r));
  const [host] = fetch.snapshot();
  assert.ok(host);
  assert.equal(host.hostname, 'sab.example');
  assert.equal(host.limit, 1);
  assert.deepEqual(host.inFlight, [{ method: 'GET', target: 'https://sab.example:8080/api' }]);
  assert.deepEqual(host.waiting, [{ method: 'GET', target: 'https://sab.example:8080/api' }]);
  assert.ok(!JSON.stringify(fetch.snapshot()).includes('SECRETKEY'), 'the key is nowhere in the snapshot');
  assert.ok(changes.length >= 2, 'onChange fired for each enqueue');
  release?.();
  await Promise.all([first, second]);
  assert.deepEqual(fetch.snapshot(), [], 'settled requests leave the snapshot');
});

test('a passkey in the path is masked in the target', async () => {
  const fetch = createHostFetch({ fetch: async () => new Response('x', { status: 200 }) });
  const url = 'https://tracker.example/announce/0123456789abcdef0123456789abcdef/download?id=1';
  // Observe the record before the request settles: hold the fetch open.
  let release: (() => void) | undefined;
  const slow = createHostFetch({ fetch: async () => { await new Promise<void>((r) => { release = r; }); return new Response('x'); } });
  const pending = slow.text(url);
  await new Promise((r) => setImmediate(r));
  const target = slow.snapshot()[0]?.inFlight[0]?.target ?? '';
  assert.ok(!target.includes('0123456789abcdef0123456789abcdef'), target);
  assert.ok(!target.includes('?'), 'no query string');
  release?.();
  await pending;
  void fetch;
});

test('an unparseable url still queues, with a target that is redacted text', async () => {
  // Review Focus 2.
  const fetch = createHostFetch({ fetch: async () => new Response('x') });
  await assert.rejects(fetch.text('not a url'));   // `new URL` throws inside fetched(); the rejection is the existing behaviour
});
```

Check two things against the real code before running: whether `fetched` computes `new URL(url).hostname` before or after a record could be made (if `new URL` throws, there is no hostname to file the record under; the test then only asserts the existing rejection, as written), and what `redactUrl` does to that tracker path (read `clients/redact.ts`'s `redactSecrets` and its tests; if a 32-hex path segment is not one of its patterns, use a passkey shape its tests show is masked). Default `method` is `GET` when `init.method` is absent.

- [ ] **Step 2: Run and watch them fail**

Run: `node --import tsx --conditions development --test <that file> 2>&1 | grep -E "^not ok|✖" | head` — Expected: FAIL (`snapshot` is not a function).

- [ ] **Step 3: Implement**

In `queue.ts`:
- `QueuedFetch` gains `snapshot(): readonly ActivityHost[];` with a doc: what each hostname's queue holds right now, by method and redacted target — the Activities page's view of this layer.
- `createHostFetch`'s deps gain `onChange?: () => void` (doc: called when a request is enqueued, starts or settles; `main.ts` wires the event hub).
- Per hostname keep `{ queue: BoundedQueue; limit: number; waiting: Set<ActivityRequest>; inFlight: Set<ActivityRequest> }`. In `fetched`, after `hostname` is known: `const record: ActivityRequest = { method: init?.method ?? 'GET', target: targetOf(url) }` where

```ts
/** `redactUrl`'s output with the query string gone: what a response body may say about a request. Computed once; the raw url is never kept. */
function targetOf(url: string): string {
  const redacted = redactUrl(url);
  const query = redacted.indexOf('?');
  return query === -1 ? redacted : redacted.slice(0, query);
}
```
  add it to `waiting` and call `deps.onChange?.()`; inside the queued task move it to `inFlight` (+`onChange`); in `finally` delete it from both (+`onChange`).
- `snapshot()` maps the hosts that have anything queued or in flight to `ActivityHost`, sorted by hostname, copying the sets to arrays.

- [ ] **Step 4: Run, gate, commit**

Run the test file — PASS. `npm run check > /tmp/p4-t2.log 2>&1; echo "exit $?"; rm -f /tmp/p4-t2.log` — exit 0.

```bash
git add -A packages && git commit -m "Let the fetch queue report what it holds, by method and redacted target"
```

---

### Task 3: The read route and the `activity` event, wired

**Files:**
- Create: `packages/host/src/api/activity.ts`
- Modify: `packages/host/src/sync/events.ts` (`SyncEvents`, `createSyncEvents`)
- Modify: `packages/host/src/api/server.ts` (`ReadServerDeps` ~455-482; `ROUTES` after `/api/sync/events`; module-doc route count)
- Modify: `packages/host/src/main.ts` (~837 after `installSyncTriggers`; ~859 the hub; ~942 `createHostFetch`; the `createReadServer` deps)
- Modify: `packages/e2e/src/harness-2.ts` (~648 `createHostFetch`, the hub, `createReadServer`)
- Test: `packages/host/test/api/activity.test.ts` (new), `packages/host/test/sync/events.test.ts`, `packages/host/test/api/server.test.ts`

**Interfaces:**
- Consumes: Task 1's function, triggers and types; Task 2's `snapshot()`.
- Produces: `readActivity(raw: DatabaseSync, snapshot: () => readonly ActivityHost[]): ActivityRead`; `SyncEvents.notifyActivity(): void`; `ReadServerDeps.fetchSnapshot: () => readonly ActivityHost[]`.

- [ ] **Step 1: Write the failing tests**

`packages/host/test/api/activity.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { ACTIVITY_RECENT_LIMIT } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { readActivity } from '../../src/api/activity.ts';

function seed(raw: DatabaseSync, state: string, at: number, extra: { runAt?: number; lastError?: string | null; payload?: string } = {}): number {
  return Number(raw.prepare(`
    INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, last_error, created_at, updated_at)
    VALUES ('alpha', 'noop', ?, 1, 3, ?, ?, ?, ?, ?)`)
    .run(extra.payload ?? '{"secret":"never-shown"}', extra.runAt ?? at, state, extra.lastError ?? null, at, at).lastInsertRowid);
}

test('the four lists, in their orders, with no payload anywhere', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const running = seed(raw, 'running', 100);
  const later = seed(raw, 'ready', 100, { runAt: 900 });
  const sooner = seed(raw, 'ready', 100, { runAt: 500 });
  const deadOld = seed(raw, 'dead', 100, { lastError: 'boom' });
  const deadNew = seed(raw, 'dead', 200, { lastError: 'bang' });
  seed(raw, 'done', 300);
  const read = readActivity(raw, () => []);
  assert.deepEqual(read.jobs.running.map((j) => j.id), [running]);
  assert.deepEqual(read.jobs.waiting.map((j) => j.id), [sooner, later], 'soonest run first');
  assert.deepEqual(read.jobs.dead.map((j) => j.id), [deadNew, deadOld], 'newest first');
  assert.equal(read.jobs.dead[0]?.lastError, 'bang');
  assert.equal(read.jobs.waiting[0]?.lastError, null);
  assert.ok(!JSON.stringify(read).includes('never-shown'), 'no payload travels');
  assert.ok(!/payload/i.test(JSON.stringify(read)), 'not even the key');
});

test('recent is capped and newest first', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  for (let i = 1; i <= ACTIVITY_RECENT_LIMIT + 5; i += 1) seed(raw, 'done', i);
  const { recent } = readActivity(raw, () => []).jobs;
  assert.equal(recent.length, ACTIVITY_RECENT_LIMIT);
  assert.equal(recent[0]?.updatedAt, ACTIVITY_RECENT_LIMIT + 5);
});

test('a job in a state this build does not know is in none of the lists, and nothing throws', () => {
  // Review Focus 1.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  seed(raw, 'paused', 100);
  const read = readActivity(raw, () => []);
  assert.deepEqual([read.jobs.running, read.jobs.waiting, read.jobs.dead, read.jobs.recent].map((l) => l.length), [0, 0, 0, 0]);
});

test('fetches is the snapshot, passed through', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const hosts = [{ hostname: 'h', limit: 1, inFlight: [], waiting: [{ method: 'GET', target: 'https://h/x' }] }];
  assert.deepEqual(readActivity(raw, () => hosts).fetches, hosts);
});
```

Append to `packages/host/test/sync/events.test.ts` (using its `harness()`/`fakeResponse()` helpers):

```ts
test('notifyActivity publishes one `activity` event per turn, with no data line', () => {
  const { events, runDeferred } = harness();
  const r = fakeResponse();
  events.attach(r.response);
  const len = r.body().length;
  events.notifyActivity(); events.notifyActivity(); events.notifyActivity();
  runDeferred();
  assert.equal(r.body().slice(len), 'event: activity\ndata:\n\n');
});
```

Append to `packages/host/test/api/server.test.ts` (using `startSignedIn`, `get`, `originOf`):

```ts
test('GET /api/activity is guarded session-first and answers the activity shape', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const { server, cookie } = await startSignedIn(raw, db, () => undefined, {
    fetchSnapshot: () => [{ hostname: 'h', limit: 1, inFlight: [], waiting: [{ method: 'GET', target: 'https://h/x' }] }],
  });
  try {
    const anonymous = await fetch(`${originOf(server)}/api/activity`);
    assert.equal(anonymous.status, 401);
    const post = await fetch(`${originOf(server)}/api/activity`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 405);
    const ok = await get(server, '/api/activity', cookie);
    assert.equal(ok.status, 200);
    const body: unknown = await ok.json();
    assert.ok(typeof body === 'object' && body !== null && 'jobs' in body && 'fetches' in body);
    assert.ok(!/payload/i.test(JSON.stringify(body)));
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/api/activity.test.ts packages/host/test/sync/events.test.ts packages/host/test/api/server.test.ts 2>&1 | grep -E "^not ok|✖|Cannot find" | head` — Expected: FAIL.

- [ ] **Step 3: `readActivity`**

`packages/host/src/api/activity.ts`:

```ts
/**
 * `GET /api/activity`'s answer: the host's jobs, in four lists, and the
 * fetch queue's snapshot (design spec 2026-10-02 §1).
 *
 * **The `SELECT` names its columns and never `payload_json`.** That is the
 * whole of how "no payload travels" is enforced; `activity.test.ts` pins it
 * by seeding a payload and asserting its text is absent from the answer.
 *
 * A row whose `state` is none of the four this build knows is in no list.
 * The dispatcher's vocabulary may grow; this reader must not fail the page
 * when it does.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ACTIVITY_RECENT_LIMIT, type ActivityHost, type ActivityJob, type ActivityRead } from '@pickarr/contract';

const COLUMNS = 'id, plugin_id, kind, attempts, max_attempts, run_at, state, last_error, updated_at, started_at';

function toJob(row: Record<string, unknown>): ActivityJob {
  const num = (key: string): number => { const v = row[key]; return typeof v === 'number' ? v : 0; };
  const text = (key: string): string => String(row[key] ?? '');
  const lastError = row['last_error'];
  const startedAt = row['started_at'];
  return {
    id: num('id'), pluginId: text('plugin_id'), kind: text('kind'),
    attempts: num('attempts'), maxAttempts: num('max_attempts'), runAt: num('run_at'), updatedAt: num('updated_at'),
    startedAt: typeof startedAt === 'number' ? startedAt : null,
    lastError: typeof lastError === 'string' ? lastError : null,
  };
}

function list(raw: DatabaseSync, state: string, order: string, limit?: number): readonly ActivityJob[] {
  const sql = `SELECT ${COLUMNS} FROM jobs WHERE state = ? ORDER BY ${order}${limit === undefined ? '' : ` LIMIT ${String(limit)}`}`;
  return raw.prepare(sql).all(state).map(toJob);
}

export function readActivity(raw: DatabaseSync, snapshot: () => readonly ActivityHost[]): ActivityRead {
  return {
    jobs: {
      running: list(raw, 'running', 'started_at, id'),
      waiting: list(raw, 'ready', 'run_at, id'),
      dead: list(raw, 'dead', 'updated_at DESC, id DESC'),
      recent: list(raw, 'done', 'updated_at DESC, id DESC', ACTIVITY_RECENT_LIMIT),
    },
    fetches: snapshot(),
  };
}
```

`node:sqlite` rows are `Record<string, SQLOutputValue>`, which is assignable to the `Record<string, unknown>` parameter — no cast. If the repo's hygiene script objects to the interpolated `ORDER BY`/`LIMIT` (they are constants, never input), write the four statements out literally instead.

- [ ] **Step 4: The hub's second event**

`events.ts`: a second flag `activityPending`, `function publishActivity()` mirroring `publish` (same `closed` and `isTransaction` handling — a job write inside a transaction is as early as a sync write), writing `'event: activity\ndata:\n\n'`; `notifyActivity()` on the interface and the object; `close()` unchanged. Docblock: the second event the page listens for; it carries nothing, because the page refetches `GET /api/activity` rather than trusting an event's contents.

- [ ] **Step 5: Route and wiring**

`server.ts`: `ReadServerDeps.fetchSnapshot: () => readonly ActivityHost[]` (doc: the fetch layer's `snapshot`; a test hands in a constant). Route after `/api/sync/events`:

```ts
  {
    path: '/api/activity',
    methods: ['GET'],
    open: false,
    // The host's own work is as private as the library it works on.
    answer: ({ deps }) => json(200, readActivity(deps.raw, deps.fetchSnapshot)),
  },
```
Route count in the module doc: 20 (run its `grep -c`).

`main.ts`: after `installSyncTriggers(raw, HOST_SYNCED_TABLES);` add `installActivityTriggers(raw);`. After the hub is built: `setActivityChangedListener(raw, () => { events.notifyActivity(); });`. Build the hub **before** `createHostFetch` (move if needed) and pass `onChange: () => { events.notifyActivity(); }` to `createHostFetch`. Pass `fetchSnapshot: () => fetch.snapshot()` into `createReadServer`. Mirror all four in `harness-2.ts`. In `server.test.ts`'s `start` helper, default `fetchSnapshot: () => []` unless overridden.

- [ ] **Step 6: Run, gate, commit**

Run the three test files — PASS. `npm run check > /tmp/p4-t3.log 2>&1; echo "exit $?"; rm -f /tmp/p4-t3.log` — exit 0. Then the e2e suite once (`npm run e2e > /tmp/p4-t3-e2e.log 2>&1; echo $?`), since the harness changed; delete the log.

```bash
git add -A packages && git commit -m "Serve GET /api/activity, and push an activity event when a job or a queued request changes"
```

---

### Task 4: The page

**Files:**
- Modify: `packages/web/src/auth/sendJson.ts` (`SendJsonInit.method` gains `'GET'`)
- Modify: `packages/web/src/store/notify.ts` (`subscribeActivity`, `emitActivity`), `leader.ts` (`ChannelMessage` gains `{ type: 'activity' }`), `sync.ts` (listener + relay), `index.ts` (`Store.subscribeActivity`, `Store.activeDownloads`), `rows.ts` (`activeDownloads`)
- Create: `packages/web/src/activity/useActivity.ts`, `useActiveDownloads.ts`, `Activities.tsx`, `packages/web/src/styles/activities.css`; modify `styles/index.css`, `shell/Shell.tsx`
- Test: `packages/web/test/store/notify.test.ts`, `sync.test.ts`, `rows.test.ts`, `packages/web/test/activity/Activities.test.tsx` (new), `useActivity.test.tsx` (new), `shell/Shell.test.tsx`

**Interfaces:**
- Consumes: `ActivityRead` etc. from `@pickarr/contract` (Task 1); `SESSION_EXPIRED_MESSAGE`, `sendJson`.
- Produces:

```ts
// notify.ts
export function subscribeActivity(cb: () => void): () => void;
export function emitActivity(): void;
// rows.ts
export interface ActiveDownload {
  readonly table: 'torrent_download' | 'nzb_download'; readonly id: number;
  readonly status: string; readonly percentage: number | null;
  readonly filename: string;      // 'unknown release' when the rss_item has not replicated
  readonly title: string | null;  // null = unmatched, or media_item not replicated
  readonly clientName: string;    // 'unknown client' when absent
  readonly updatedAt: number;
}
export async function activeDownloads(db: IDBDatabase): Promise<readonly ActiveDownload[]>;
// activity/useActivity.ts
export type ActivityState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly read: ActivityRead; readonly unreachable: boolean };
export interface ActivitySource { subscribeActivity: Store['subscribeActivity']; }
export type ActivityFetch = () => Promise<SendJsonResult>;   // default: () => sendJson('/api/activity', { method: 'GET' })
export function useActivity(source: ActivitySource, fetchActivity: ActivityFetch, onExpired: () => void, intervalMs?: number): ActivityState;
export const ACTIVITY_POLL_MS = 30_000;
// Activities.tsx
export interface ActivitiesProps { source: ActivitiesSource; fetchActivity: ActivityFetch; onExpired: () => void; }
```

- [ ] **Step 1: Write the failing tests**

`notify.test.ts`:
```ts
test('subscribeActivity hears emitActivity until unsubscribed', () => {
  let heard = 0;
  const off = subscribeActivity(() => { heard += 1; });
  emitActivity();
  off();
  emitActivity();
  assert.equal(heard, 1);
});
```

`sync.test.ts` (fake-stream helpers exist from phase 3; add an `'activity'` type to the fake's listener map):
```ts
test('an activity event on the leader emits locally and relays over the channel; a follower emits on the relay', async () => {
  const db = await freshDb();
  await seedMeta(db, { since: 10, before: null }, 'gen-1');
  const quiet = routes({ '/api/sync?since=10': ok({ ops: [], cursor: 10, generation: 'gen-1' }) });
  const { events, opened } = fakeStreams();
  let local = 0;
  const off = subscribeActivity(() => { local += 1; });
  cleanups.push(off);
  const seen: ChannelMessage[] = [];
  cleanups.push(onMessage((m) => { seen.push(m); }));
  start(db, stubFetch(quiet).fetch, grantedLease(), { events });
  await settle();
  opened[0]?.activity();
  await settle();
  assert.equal(local, 1, 'the leader wakes its own page');
  assert.deepEqual(seen.filter((m) => m.type === 'activity'), [{ type: 'activity' }], 'and relays it');
});
```
Follower half: start a second `startSync` with a never-granted `manualLease()` in the same process, `broadcast({ type: 'activity' })`, and assert its `subscribeActivity` listener fires. Read how `onMessage`'s shared channel dedups within one context (`leader.ts` ~282-300) before asserting counts.

`rows.test.ts`:
```ts
test('activeDownloads lists every non-terminal download with its filename, title and client, and copes with missing joins', async () => {
  const db = await freshDb();
  await applyBatch(db, [
    { op: 'upsert', table: 'download_client', id: 1, value: { id: 1, name: 'Seedbox', type: 'torrent', implementation: 'qbittorrent', url: '', username: null, category: '', consecutiveFailures: 0, unreachableSince: null, createdAt: 1, updatedAt: 1 } },
    { op: 'upsert', table: 'media_item', id: 5, value: { id: 5, pluginId: 'tv', title: 'A Show', createdAt: 1, updatedAt: 1, provider: null, providerRef: null, releaseDate: null, description: null } },
    { op: 'upsert', table: 'rss_item', id: 7, value: { id: 7, feedId: 1, filename: 'a.mkv', createdAt: 1, updatedAt: 1, downloadType: 'torrent', mediaItemId: 5, rankingScore: null, lookupState: 'resolved', lookupStateDetail: null, lookupJson: null, videoResolution: null, deliveredAt: null } },
    { op: 'upsert', table: 'torrent_download', id: 11, value: { id: 11, rssItemId: 7, downloadClientId: 1, infohash: null, clientRef: 'r', status: 'downloading', attempts: 1, createdAt: 1, updatedAt: 9, percentage: 42, absentSince: null, deliveredAt: null, reclaimedAt: null } },
    { op: 'upsert', table: 'torrent_download', id: 12, value: { id: 12, rssItemId: 7, downloadClientId: 1, infohash: null, clientRef: 'd', status: 'delivered', attempts: 1, createdAt: 1, updatedAt: 9, percentage: 100, absentSince: null, deliveredAt: 9, reclaimedAt: null } },
    { op: 'upsert', table: 'nzb_download', id: 13, value: { id: 13, rssItemId: 99, downloadClientId: 2, clientRef: null, status: 'submitting', attempts: 0, createdAt: 1, updatedAt: 3, percentage: null, absentSince: null, deliveredAt: null, reclaimedAt: null } },
  ], { since: 1, before: null });
  const rows = await activeDownloads(db);
  assert.deepEqual(rows.map((r) => [r.table, r.id, r.status, r.filename, r.title, r.clientName, r.percentage]), [
    ['torrent_download', 11, 'downloading', 'a.mkv', 'A Show', 'Seedbox', 42],
    ['nzb_download', 13, 'submitting', 'unknown release', null, 'unknown client', null],   // Review Focus 4
  ]);
});
```
Order: newest `updatedAt` first. Check `MediaItemSyncRead`/`RssItemSyncRead` field names against `@pickarr/contract` before running and fix the fixture rather than the code.

`useActivity.test.tsx`: a `Harness` rendering the hook's phase; tests: loading → ready after the first answer; an `emitActivity()` refetches (count the stub's calls); `setInterval` is called with `30_000` (spy `globalThis.setInterval` and restore in `afterEach`); an `offline` result after a `ready` keeps the last read and sets `unreachable`; an `expired` result calls `onExpired` once; unmount clears the interval and unsubscribes.

`Activities.test.tsx`: render with a stub source and stub fetch answering a fixed `ActivityRead`; assert the six headings by `getByRole('heading', { name })`, the empty sentences for empty lists, a job line text `alpha noop` with `attempt 1 of 3`, a dead job's `lastError` text present and in an element with no `aria-label` and a class/structure the stylesheet reaches (Review Focus 5: a 2 000-character error renders in full — assert `textContent.length >= 2000`), the fetch block `h · 0 in flight, 1 waiting, limit 1` and `GET https://h/x`, and the download line; `Loading…` before the answer; `Couldn't reach Pickarr` after an `offline` result. Assert `activities.css` has a rule for the error element the way `App.test.tsx` reads `base.css`.

`Shell.test.tsx`: `/activities` renders the page's `data-testid="activities"`; the nav has a link named `Activities`.

- [ ] **Step 2: Run and watch them fail** (web runner for `.tsx`, server runner for `.ts` store tests). Expected: FAIL.

- [ ] **Step 3: Implement**

- `sendJson.ts`: `method: 'GET' | 'POST' | …`; a `GET` never has a body (assert in code: throw if `init.body !== undefined && init.method === 'GET'` — a programming error, not a runtime path).
- `notify.ts`: `const activitySubscribers = new Set<RowListener>()`; `subscribeActivity`/`emitActivity` like `subscribeReset`/`emitReset`. Module doc: the sixth registry; it keys on nothing because the Activities page refetches rather than reading a row.
- `leader.ts`: `| { type: 'activity' }` on `ChannelMessage`, with a doc line.
- `sync.ts`: `SyncEventStream.addEventListener(type: 'activity', listener: () => void)` overload; in `openStream`: `stream?.addEventListener('activity', () => { emitActivity(); broadcast({ type: 'activity' }); });` — the leader wakes its own page and relays; in `onMessage`: `if (msg.type === 'activity') { emitActivity(); return; }` before the `changed` branch (followers only, since `if (leading) return` is first).
- `index.ts`: `subscribeActivity: Store['subscribeActivity']` wired to notify's; `activeDownloads(): Promise<readonly ActiveDownload[]>` wired to rows'.
- `rows.ts`: `activeDownloads(db)`: `listByTable` both download tables (`direction: 'prev'`, `limit: 500`), filter `status !== 'delivered' && status !== 'failed'`, then one `getRows` per referenced table for `rss_item`, `media_item`, `download_client` ids; build `ActiveDownload`s; sort by `updatedAt` desc. Narrow every value; a missing join yields the stated fallbacks.
- `activity/useActivity.ts`: `useState<ActivityState>({ phase: 'loading' })`; `refetch` through `fetchActivity`: `answered` with status 200 and a body narrowed by an `isActivityRead` guard → `ready, unreachable: false`; `offline` or a non-200 or an unrecognisable body → keep the last read if any and set `unreachable: true` (or stay `loading` if none yet); `expired` → `onExpired()`. Effect: refetch on mount, `const off = source.subscribeActivity(refetch)`, `const handle = setInterval(refetch, intervalMs ?? ACTIVITY_POLL_MS)`; cleanup both; `cancelled` flag like every other hook.
- `activity/useActiveDownloads.ts`: `source.activeDownloads()` on mount and on `subscribeTable('torrent_download')`, `subscribeTable('nzb_download')` and `subscribeReset` (Review Focus 3).
- `activity/Activities.tsx`: `<section data-testid="activities" aria-labelledby="activities-heading">`, six `<section>`s each with an `<h3>` and a `<ul aria-label="…">`, or the empty sentence in a `<p>`. A dead job's error in `<pre>` (so it wraps with `white-space: pre-wrap` from the stylesheet). Times via `new Date(x).toLocaleString()`.
- `styles/activities.css` in the `components` layer, imported from `index.css` after `settings.css`; structural selectors only (`settings.css`'s rule): `section[aria-labelledby='activities-heading'] …`, `pre { white-space: pre-wrap; overflow-wrap: anywhere; }` scoped under it.
- `Shell.tsx`: `<Route path="activities" element={store === undefined ? null : <Activities source={store} fetchActivity={fetchActivity} onExpired={() => onUnauthenticated('expired')} />} />` and a nav `<li><NavLink to="/activities">Activities</NavLink></li>` between Unmatched and Settings. `fetchActivity` is `() => sendJson('/api/activity', { method: 'GET' })`, defined in `activity/fetchActivity.ts` and wired here like the other real I/O functions.

- [ ] **Step 4: Run, gate, commit**

All named test files PASS. `npm run check > /tmp/p4-t4.log 2>&1; echo "exit $?"; rm -f /tmp/p4-t4.log` — exit 0.

```bash
git add -A packages && git commit -m "Add the Activities page: jobs, the fetch queue and downloads in progress, live"
```

---

### Task 5: End to end, mutations, gate

- [ ] **Step 1: e2e spec** — `packages/e2e/tests/activities.spec.ts`, using `claimInstall`-style sign-in copied from `shell.spec.ts` (export the helper or copy it) and `harness.seedPickableRelease({ …, withDownloadClient: true })` (read its signature in `harness-2.ts`):

```ts
test('Activities shows a waiting or running reconcile job for a seeded client, and a download in progress', async ({ page, harness }) => {
  await harness.seedPickableRelease({ pluginId: 'movie', title: 'A Movie', filename: 'A.Movie.2024.1080p.mkv', lookupState: 'resolved', withDownloadClient: true });
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await page.getByRole('link', { name: 'Activities' }).click();
  await expect(page.getByRole('heading', { name: 'Activities' })).toBeVisible();
  // Adding a client schedules its reconcile; at a 10 s cadence it is nearly always waiting.
  await expect(page.getByText(/reconcile/).first()).toBeVisible({ timeout: 5_000 });
});
```
For the download half, drive a pick the way `shell.spec.ts`'s pick spec does (its fake qBittorrent accepts the add), then navigate to Activities and expect the filename under `Downloads in progress` within 5 s. Keep every step timeout under the budget script's allowance.

- [ ] **Step 2: Run the full e2e suite** (`npm run e2e > /tmp/p4-e2e.log 2>&1; echo $?`; read the tail; delete).

- [ ] **Step 3: Mutations** (apply one at a time; restore with `git checkout -- <file>`; a mutant that reddens nothing is a missing test):

| Mutation | File | Tests |
|---|---|---|
| add `payload_json` to `COLUMNS` and copy it into the job | `host/src/api/activity.ts` | `activity.test.ts` |
| remove the `LIMIT` on `recent` | `host/src/api/activity.ts` | `activity.test.ts` |
| `targetOf` keeps the query string | `host/src/fetch/queue.ts` | the queue test file |
| `targetOf` skips `redactUrl` | `host/src/fetch/queue.ts` | the queue test file |
| the prune deletes `dead` too (`state IN ('done','dead')`) | `host/src/jobs/dispatcher.ts` | `dispatcher.test.ts` |
| the prune ignores age (drop the `updated_at <` clause) | `host/src/jobs/dispatcher.ts` | `dispatcher.test.ts` |
| the route gets `open: true` | `host/src/api/server.ts` | `server.test.ts` |
| `notifyActivity` publishes `changed` instead | `host/src/sync/events.ts` | `events.test.ts` |
| the leader does not `broadcast` the activity relay | `web/src/store/sync.ts` | `sync.test.ts` |
| `activeDownloads` includes `delivered` | `web/src/store/rows.ts` | `rows.test.ts` |
| the hook's interval is `3_000` | `web/src/activity/useActivity.ts` | `useActivity.test.tsx` |
| `offline` after `ready` drops the last read | `web/src/activity/useActivity.ts` | `useActivity.test.tsx` |

- [ ] **Step 4: Final gate** — `npm run check > /tmp/p4-final.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)" /tmp/p4-final.log; rm -f /tmp/p4-final.log` — exit 0, `fail 0`.

```bash
git add -A packages && git commit -m "Pin the Activities page end to end" || true
```

Nothing is pushed or merged.
