# Job Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the polling pump with a timer-driven dispatcher that never awaits a handler, so a hung fetch cannot affect the jobs subsystem at all.

**Architecture:** A `setTimeout` armed for the next due job replaces the one-second idle poll. Firing selects due rows oldest-first, excludes ids already queued in memory, and hands them to a bounded queue without writing to the rows or awaiting anything. The queue worker owns the row: it marks `running`, stamps `started_at`, races the handler against a five-minute abort, and updates the row conditionally so a late settle cannot clobber a timeout.

**Tech Stack:** TypeScript on Node's `node:sqlite`, Drizzle 1.0-rc, `node:test`, `AbortSignal.timeout`, the existing bounded-queue primitive.

**Spec:** `docs/superpowers/specs/2026-09-04-job-dispatcher-design.md` — read it alongside this plan; the spec is the authority this plan argues from.

## Global Constraints

- Never the `any` type; never a cast to silence a type error.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly` all on. Indexed and `Map.get` access is checked, never `!`-asserted. Type-only imports must be `import type`. No enums.
- Ids are SQLite integer rowids.
- The host's reserved plugin id is `host`; it declares no tables.
- Prefer async APIs over sync twins — `fs.promises` over `fs.*Sync`. Inside an `async` function, `await` it.
- Handlers must be idempotent: a job re-run after a crash must not double-write.
- **Row updates from a handler's outcome are always conditional — `WHERE id = ? AND state = 'running'`.** A handler finishing after its timeout would otherwise overwrite the row the timeout already failed.
- A comment false about the code beside it is a defect equal to a wrong line of code.
- Pickarr 1.x (`packages/core`, `packages/plugin-api`, `packages/plugin-scenes`, `packages/web`, `packages/e2e`) is deployed and **must not be touched**. Read it for reference freely; change nothing.
- **Do not hardcode a cumulative test count.** Two earlier plans predicted totals and were wrong every time. Each task reports the count it started from and the count it ended with. `lint` must stay at **exactly 124 warnings** with **0 in `packages/contract` and `packages/host`**; if a change would add one, fix the cause rather than the count.
- Full gate, each redirected to a file and grepped — never pipe a test run through `grep`: `npm run typecheck`, `npm run test:server`, `npm run lint`, `npm run build`, `npm run test-hygiene`, `npm run e2e` (**25 passed**), `npm run test:web` (**377**).
- `packages/web`'s `Browse.test.tsx` has two **measured** flaky tests (`the selection clears when a term filters the selected group out`, and `picking costs one request, not a refetch`). `packages/web` is untouched by this slice — report either only if it fails **consistently**.

## Why the task order is what it is

Removing `Host.runOnce()` breaks **64 test call sites across four files at once** — `runner.test.ts` (18), `host.test.ts` (12), `flow.test.ts` (26), `main.test.ts` (8). A single swap task would be unreviewable.

So the dispatcher is built alongside the runner (Tasks 1–6, suite stays green because nothing is removed), then Task 7 swaps the runner's internals while **keeping `runOnce()` as a documented test-only adapter** meaning "fire now, then await idle". Tasks 8–11 migrate the four test files one at a time, each independently reviewable. Task 12 deletes the adapter. The adapter never becomes permanent dead code because its removal is a task, not an intention.

## File Structure

**Created**
- `packages/host/src/jobs/qpromise.ts` — `QPromise<T>` and `makeQPromise`, imported from outside the repo and cleaned.
- `packages/host/src/util/bounded-queue.ts` — the concurrency primitive, extracted from the fetch queue.
- `packages/host/src/jobs/dispatcher.ts` — the timer, the firing, the queued-id set, recovery.
- `packages/host/src/jobs/run-job.ts` — one job's lifecycle: mark, abort race, conditional update.

**Modified**
- `packages/host/src/fetch/queue.ts` — uses the extracted primitive instead of its own.
- `packages/host/src/db/migrate.ts`, `db/schema.ts` — `jobs.started_at`.
- `packages/host/src/jobs/runner.ts` — becomes the dispatcher's adapter, then shrinks to nothing.
- `packages/host/src/host.ts` — `runOnce`/`recover` give way to `start`/`stop`.
- `packages/host/src/main.ts` — loses the pump loop and the drain.

---

### Task 1: `QPromise` into the repo

**Files:**
- Create: `packages/host/src/jobs/qpromise.ts`
- Test: `packages/host/test/jobs/qpromise.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface QPromise<T> extends Promise<T> {
    isPending: () => boolean;
    isResolved: () => boolean;
    isRejected: () => boolean;
  }
  export function makeQPromise<T>(promise: Promise<T>): QPromise<T>;
  ```

The source currently sits at the **project directory root, outside the git repository**, at `../../qpromise.ts` relative to this worktree. Copy it in and fix two things on the way: `(e: any)` becomes `unknown` (this project forbids `any`), and the unused `type Proms<T>` is dropped.

**What it is, and is not.** Query-only. It exposes whether the wrapped promise is pending, resolved or rejected, and offers **no external resolve or reject**. The dispatcher therefore cannot reject a handler's promise to time it out — it can only observe that the handler is still pending and act on the row. Everything in Task 5 is written around that.

- [ ] **Step 1: Write the failing tests**

```ts
test('a pending promise reports pending and neither resolved nor rejected', async () => {});
test('a resolved promise reports resolved and passes its value through', async () => {});
test('a rejected promise reports rejected and still rejects its caller', async () => {
  // `makeQPromise` returns `promise.then(ok, err)` where the error path
  // RE-THROWS, so the returned promise rejects too. A caller that attaches no
  // `catch` gets an unhandled rejection -- which is why Task 5 always attaches
  // one. This test pins the re-throw so that requirement stays visible.
});
test('the flags are functions, not properties', () => {
  // `if (p.isPending)` is always truthy. An earlier sketch of the dispatcher
  // read it that way and would have timed out every job, so this asserts the
  // shape rather than trusting it.
  assert.equal(typeof makeQPromise(Promise.resolve()).isPending, 'function');
});
```

- [ ] **Step 2: Run and confirm failure** — the module does not exist.
- [ ] **Step 3: Copy the source in and apply the two fixes.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail** — make `isPending` a boolean property rather than a function; the shape test must fail. Swallow the rejection instead of re-throwing; the rejection test must fail.
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Bring QPromise into the repo so a handler's state can be observed without awaiting it"
```

---

### Task 2: Extract the bounded queue

**Files:**
- Create: `packages/host/src/util/bounded-queue.ts`
- Modify: `packages/host/src/fetch/queue.ts`
- Test: `packages/host/test/util/bounded-queue.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BoundedQueue {
    /** Runs `task` when a slot is free. Rejects if `task` rejects. */
    run<T>(task: () => Promise<T>): Promise<T>;
    /** How many are executing right now. */
    active(): number;
    /** Resolves when nothing is running or waiting. */
    idle(): Promise<void>;
  }
  export function createBoundedQueue(limit: number): BoundedQueue;
  ```

`packages/host/src/fetch/queue.ts` already holds this: a running count, a waiter list, and a validated limit, built and mutation-tested in the previous slice. Move it out and have the fetch queue keep one instance **per hostname** while the dispatcher gets one for itself. One implementation rather than two, and no new dependency — `async` is deliberately not added.

**Two properties must survive the move**, and both are already tested in `queue.test.ts`:

1. **A rejected task releases its slot.** The `finally` that decrements and wakes the next waiter is the whole reason a rejection cannot wedge a queue. Drop it and one failure stops that queue forever, silently.
2. **The limit is validated at construction** — an integer of at least 1, rejected loudly. A limit of `0` makes `active() >= limit` true forever, so every task waits on a promise nothing will settle.

`idle()` is new, and is what Task 8 onward use in place of awaiting a claim.

- [ ] **Step 1: Write the failing tests**

```ts
test('a limit of one runs tasks one at a time', async () => {});
test('a limit of two runs two at once and makes a third wait', async () => {
  // Assert by counting in-flight tasks, never by elapsed time.
});
test('a rejected task releases its slot, so the next task still runs', async () => {});
test('a rejected task rejects its own caller, not the queue', async () => {});
test('an invalid limit throws at construction, naming the value', async () => {});
test('idle resolves once nothing is running or waiting', async () => {});
test('idle resolves immediately on an untouched queue', async () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Extract the primitive**, then rewrite `createHostFetch` to hold a `Map<string, BoundedQueue>` keyed by hostname. **`queue.test.ts` must pass unchanged** — it is the evidence the move preserved behaviour. If a test there needs editing, stop and say why in your report rather than editing it.
- [ ] **Step 4: Run and confirm both suites pass.**
- [ ] **Step 5: Prove the tests can fail**
  - drop the decrement-and-wake from the `finally` → the rejection-releases-slot test must fail, and so must a `queue.test.ts` test
  - remove the limit validation → its test must fail
  - resolve `idle()` while a task is still waiting → its test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Extract the bounded queue so the fetch subsystem and the dispatcher share one implementation"
```

---

### Task 3: `jobs.started_at`

**Files:**
- Modify: `packages/host/src/db/migrate.ts`, `packages/host/src/db/schema.ts`
- Test: `packages/host/test/db/migrate.test.ts`, `packages/host/test/db/schema.test.ts`

**Interfaces:**
- Produces: `jobs.started_at INTEGER` — **nullable**, for every later task.

Add `HOST_MIGRATIONS` version 3:

```ts
const MIGRATION_3 = `
ALTER TABLE jobs ADD COLUMN started_at INTEGER;
`;
```

**It is nullable on purpose.** `started_at` is stamped by the queue worker when a job actually begins, so a row that has never run has none. No new `state` value is needed: `running` already exists alongside `ready`, `done` and `dead`, and it is exactly this state.

`migrateHost` is already atomic — each migration and its version record share a savepoint — so this needs no change there. `schema.test.ts` compares `schema.ts` against the DDL including every index's columns and uniqueness, and will fail until `schema.ts` matches. **That failure is the test working**; do not weaken the comparison.

- [ ] **Step 1: Write the failing test**

```ts
test('a migration to version 3 adds started_at to a populated jobs table', () => {
  // Migrate to 2, insert a job row, migrate to 3, and assert the existing row
  // survives with a null started_at. A migration tested only against an empty
  // database proves nothing about the case production will actually meet.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Add the migration and mirror it in `schema.ts`.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail** — omit `started_at` from `schema.ts` only; a `schema.test.ts` test must fail. Make the column `NOT NULL` without a default; the populated-table test must fail, because SQLite rejects that on a table with rows.
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Record when a job actually started, which is not when it was queued"
```

---

### Task 4: The dispatcher's timer and firing

**Files:**
- Create: `packages/host/src/jobs/dispatcher.ts`
- Test: `packages/host/test/jobs/dispatcher.test.ts`

**Interfaces:**
- Consumes: `createBoundedQueue` (Task 2); `jobs.started_at` (Task 3).
- Produces:
  ```ts
  export interface Timers {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  }
  export interface DispatcherOptions {
    now: () => number;
    timers: Timers;
    /** Max jobs executing at once. Defaults to DEFAULT_CONCURRENCY. */
    concurrency?: number;
  }
  export const DEFAULT_CONCURRENCY = 8;
  export const MAX_TIMER_MS = 60_000;
  export const SAFETY_INTERVAL_MS = 60_000;
  ```

This task builds the scheduling half only — arming, firing, the queued-id set — with a **stub runner** for what a fired job does. Task 5 replaces the stub with the real lifecycle. Splitting them keeps the timer logic reviewable on its own, because it is where the subtle failures live.

**Arming.** After anything that changes what is due, read the earliest `run_at` among `ready` rows and set one timeout for it. **Clamp the delay to `MAX_TIMER_MS`.** `setTimeout` beyond about 24.8 days fires immediately in Node, so an unclamped far-future or corrupt `run_at` produces a **hot loop** — fire, nothing due, re-arm with the same huge delay, fire again — rather than merely a late job. Clamping also means the safety interval and the timer share one upper bound.

**Firing.** Select `ready` rows whose `run_at` has passed, **oldest first** (`ORDER BY run_at, id`, which `jobs_ready` already indexes), up to `concurrency`, **excluding ids in the queued set**. Hand each to the queue. Write nothing to the rows and await nothing.

**The queued set is the load-bearing detail.** A dispatched job stays `ready` until a worker starts it (spec §5), so without an in-memory `Set<number>` of queued-but-not-started ids, the next fire — or the safety interval — re-selects it and dispatches a **second copy**. Add the id when queuing, remove it when the worker takes it. The set is in-memory only, deliberately: it dies with the process, and after a crash those rows should be selectable again.

- [ ] **Step 1: Write the failing tests**

```ts
test('arming sets one timeout for the earliest due job', async () => {});
test('enqueueing a job due sooner re-arms the timer', async () => {
  // Assert the old handle was cleared AND a new one set, not just that a
  // timer exists.
});
test('enqueueing a job due later leaves the existing timer alone', async () => {});
test('a delay beyond the clamp is capped rather than firing immediately', async () => {
  // The hot-loop guard. A run_at 30 days out must arm at MAX_TIMER_MS, not 0.
});
test('firing dispatches due jobs oldest first, up to the concurrency', async () => {});
test('firing leaves jobs beyond the concurrency ready for the next fire', async () => {});
test('a job already queued is not dispatched twice by a later fire', async () => {
  // The duplicate-dispatch guard. Fire, then fire again before the worker
  // takes the job, and assert one dispatch.
});
test('the safety interval re-derives the timeout', async () => {});
test('stop clears both the timer and the interval', async () => {});
```

- [ ] **Step 2: Run and confirm failure** — the module does not exist.
- [ ] **Step 3: Implement arming, firing and the queued set** with a stub for what runs a job (take it as an injected function so Task 5 can supply the real one and this task's tests can count dispatches).
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - remove the clamp → the clamp test must fail (expect a hang or a spin; report which)
  - skip the queued-set exclusion → the duplicate-dispatch test must fail
  - order by `id` instead of `run_at` → the oldest-first test must fail
  - dispatch everything due, ignoring the concurrency → the cap tests must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Arm one timer for the next due job, so an idle host sleeps instead of polling"
```

---

### Task 5: One job's lifecycle

**Files:**
- Create: `packages/host/src/jobs/run-job.ts`
- Modify: `packages/host/src/jobs/dispatcher.ts` (use it in place of the stub)
- Test: `packages/host/test/jobs/run-job.test.ts`

**Interfaces:**
- Consumes: `makeQPromise` (Task 1); `jobs.started_at` (Task 3); the dispatcher's injected runner slot (Task 4).
- Produces:
  ```ts
  export const JOB_TIMEOUT_MS = 300_000;
  export const ABORT_GRACE_MS = 2_000;
  export function runJob(deps: {
    raw: DatabaseSync; now: () => number;
    log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
    sleep: (ms: number) => Promise<void>;
  }, job: JobRecord, handler: JobHandler, ctx: PluginContext): Promise<void>;
  ```

The worker's first act is to claim the row — `state = 'running'`, `started_at = now()`, `attempts = attempts + 1` — because **that is the moment the job has actually been tried**. A crash before this leaves the row exactly as it was, `ready` at its original `run_at`, and charges it no attempt.

Then:

```ts
const signal = AbortSignal.timeout(JOB_TIMEOUT_MS);
const running = makeQPromise(handler(job, signal));

signal.addEventListener('abort', () => {
  // Wrapped rather than an `async` listener: an async listener that rejects
  // has nowhere to report, so its failure would surface as an unhandled
  // rejection instead of a failed row.
  void (async () => {
    await deps.sleep(ABORT_GRACE_MS);
    if (running.isPending()) failRow(job, new Error('job exceeded 5 minutes'));
  })().catch((err: unknown) => deps.log('job timeout handler failed', { err }));
}, { once: true });

try {
  await running;
  completeRow(job);
} catch (err: unknown) {
  failRow(job, err);
}
```

Four things this shape gets right, each of which an earlier sketch got wrong:

- **`isPending()` is called.** Reading `running.isPending` is always truthy and would time out every job.
- **The timeout writes a row; it never throws.** A `throw` on the timer's tick is uncatchable by any enclosing `try` and would kill the process.
- **`.catch` is attached.** `makeQPromise` re-throws on the error path, so a rejected handler with no catch is an unhandled rejection.
- **`completeRow` and `failRow` are conditional — `WHERE id = ? AND state = 'running'`.** `await running` resumes whenever the handler finally settles, even at six minutes, and would otherwise overwrite the row the timeout already failed. The conditional makes a late settle a no-op.

`failRow` keeps the existing backoff and dead-letter rules: a row at its last permitted attempt goes to `dead`, everything else back to `ready` with `run_at` recomputed.

- [ ] **Step 1: Write the failing tests**

```ts
test('the worker marks the row running and stamps started_at before calling the handler', async () => {});
test('the worker increments attempts, because reaching a worker is a try', async () => {});
test('a handler that resolves completes its row', async () => {});
test('a handler that rejects fails its row and reschedules with backoff', async () => {});
test('a handler at its last attempt is dead-lettered rather than rescheduled', async () => {});
test('a handler still pending past the timeout plus grace has its row failed', async () => {});
test('a handler that settles after its timeout does not overwrite the failed row', async () => {
  // The conditional-update guard. Time out the job, then let the handler
  // resolve, and assert the row is still the timeout's verdict.
});
test('a handler is given an AbortSignal', async () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `runJob` and wire it into the dispatcher.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - read `running.isPending` without calling it → the timeout test must fail (every job times out)
  - drop the `WHERE state = 'running'` guard → the late-settle test must fail
  - mark the row before incrementing attempts, or skip the increment → its test must fail
  - remove the `.catch` on the abort wrapper → report what happens; an unhandled rejection is a finding, not a pass
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Let the worker own a job's row, so a timeout can fail it and a late handler cannot undo that"
```

---

### Task 6: `start()` and recovery

**Files:**
- Modify: `packages/host/src/jobs/dispatcher.ts`
- Test: `packages/host/test/jobs/dispatcher.test.ts`

**Interfaces:**
- Produces:
  ```ts
  start(handlers: (pluginId: string, kind: string) => JobHandler | undefined,
        ctxFor: (pluginId: string) => PluginContext): number;
  stop(): void;
  idle(): Promise<void>;
  ```

`start()` sweeps, arms, and starts the safety interval, returning how many rows it touched — as `recover()` does today.

**Any `running` row at `start()` is by definition crashed**, since there is one process. And because Task 5 writes that state only when a worker begins, a `running` row also means the job was genuinely tried — which is what makes the sweep's attempt handling correct rather than punitive:

- A row already at its last permitted attempt goes to **`dead`**, not back to `ready`. This rule predates the slice and must survive it: a job kind that reliably kills the process would otherwise be readied on every boot and the host would never finish starting.
- Everything else returns to **`ready`** with `run_at` recomputed from the backoff curve, so a crash loop backs off rather than spinning.

**`stop()` does not drain.** It clears the timer and the interval and returns. In-flight handlers are abandoned deliberately: their rows stay `running`, and the next `start()` sweeps them. Waiting on a handler that may be hung is the exact coupling this slice removes, and the durable job table is what makes abandoning safe.

- [ ] **Step 1: Write the failing tests**

```ts
test('start returns a crashed running row to ready without losing its attempt', async () => {});
test('start dead-letters a running row already at its last attempt', async () => {
  // The infinite-boot-loop guard: a job kind that kills the process must not
  // be readied on every start.
});
test('start arms the timer from the earliest ready job', async () => {});
test('start returns how many rows it swept', async () => {});
test('stop does not wait for an in-flight handler', async () => {
  // Start a handler that never settles, call stop, and assert stop returns.
  // A stop that awaited it would reintroduce the shutdown hang.
});
test('a row left running by stop is swept by the next start', async () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement the sweep, the arming and the interval.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - ready every swept row, ignoring `max_attempts` → the dead-letter test must fail
  - await the queue's `idle()` inside `stop()` → the no-wait test must fail (expect a hang; report it)
  - skip the sweep entirely → the round-trip test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Sweep the rows a crash left running, dead-lettering the one that caused it"
```

---

### Task 7: Swap the runner's internals, keeping `runOnce` as a test adapter

**Files:**
- Modify: `packages/host/src/jobs/runner.ts`, `packages/host/src/host.ts`, `packages/host/src/index.ts`
- Test: `packages/host/test/jobs/runner.test.ts` (must still pass unchanged)

**Interfaces:**
- Produces on `Host`: `start(...)`, `stop()`, `idle()`, and — **temporarily** — `runOnce()`.

`createRunner` becomes a thin wrapper over the dispatcher. `enqueue(pluginId, job)` keeps its shape and its reason: a plugin's own `ctx.jobs` already knows which plugin it is, and trusting a plugin to name its own `pluginId` would let it enqueue work under another plugin's identity.

**`runOnce()` survives this task only, as a documented test adapter:**

```ts
/**
 * TEST ADAPTER, deleted in the task that removes the last caller. Fires the
 * dispatcher now and awaits the queue, so the 64 existing call sites keep
 * working while they are migrated file by file. Production must call
 * `start()`; a pump loop calling this would rebuild the coupling the
 * dispatcher exists to remove.
 */
runOnce(): Promise<boolean>;
```

It returns whether anything was dispatched. **`runner.test.ts` must pass unchanged** — that is the evidence the swap preserved behaviour. Tests that step through a chain one job at a time keep working because the adapter awaits the queue; where one truly depends on serial execution, set `concurrency: 1`.

- [ ] **Step 1: Run `runner.test.ts` and record the baseline.**
- [ ] **Step 2: Replace the runner's internals with the dispatcher**, adding `start`/`stop`/`idle` to `Host` and keeping `runOnce` as above.
- [ ] **Step 3: Run `runner.test.ts` unchanged.** If a test needs editing, **stop and report why** rather than editing it — an edit here hides a behaviour change.
- [ ] **Step 4: Prove the adapter is honest** — make `runOnce` return `true` unconditionally; a `runner.test.ts` test must fail.
- [ ] **Step 5: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Put the dispatcher behind the runner's shape, so the existing suite keeps its footing while it moves"
```

---

### Task 8: Migrate `runner.test.ts` to the dispatcher idiom

**Files:**
- Modify: `packages/host/test/jobs/runner.test.ts` (18 `runOnce` call sites)

**Interfaces:**
- Consumes: `Host.start(handlers, ctxFor)`, `Host.stop()`, `Host.idle()`, the injected `Timers`, and — for now — the temporary `runOnce()` adapter.
- Produces: nothing. This task moves a test file from one idiom to the other.

- [ ] **Step 1: Record the file's test count and run it green.** Report the number; it is the baseline your own change is measured against.

- [ ] **Step 2: Replace each `await host.runOnce()` with the dispatcher idiom** — advance the injected timer to fire, then `await host.idle()`. Where a test asserted `runOnce()` returned `true` or `false`, **assert the observable instead**: a row's state, a handler's call count, a job's `run_at`. A test that asserted a return value should now assert an effect, which is strictly stronger.

- [ ] **Step 3: Run both idioms against the same assertions once, and this is time-limited.** The adapter bypasses `Dispatcher` entirely, so `runOnce` passing proves only that the *adapter* preserves behaviour. Pick at least one test in this file, drive it **both** ways — old `runOnce`, then advance-timer-plus-`idle` — against identical assertions, and confirm they agree. Task 12 deletes the adapter and closes this window permanently, so the comparison is possible only while both exist. Report which test you used and what you observed.

- [ ] **Step 4: Where a test steps through a chain one job at a time, set `concurrency: 1`** rather than relying on the dispatcher being serial by nature. Say in your report which tests needed it — a test that needs serial execution is telling you something about the code it covers.

- [ ] **Step 5: Run the file green, then the full suite.**

- [ ] **Step 6: Prove nothing was weakened.** Pick the three tests whose assertions changed most, mutate the code each covers, and confirm each still fails. Report them by name with counts. If a migrated test can no longer fail, that is a finding — seven unpinned spots have already been found on this plan.

- [ ] **Step 7: Commit**

```bash
git commit -m "Drive runner.test.ts's jobs by advancing the clock rather than by claiming one at a time" -- packages/host/test/jobs/runner.test.ts
```

---

### Task 9: Migrate `host.test.ts` to the dispatcher idiom

**Files:**
- Modify: `packages/host/test/host.test.ts` (12 `runOnce` call sites)

**Interfaces:**
- Consumes: `Host.start(handlers, ctxFor)`, `Host.stop()`, `Host.idle()`, the injected `Timers`, and — for now — the temporary `runOnce()` adapter.
- Produces: nothing. This task moves a test file from one idiom to the other.

- [ ] **Step 1: Record the file's test count and run it green.** Report the number; it is the baseline your own change is measured against.

- [ ] **Step 2: Replace each `await host.runOnce()` with the dispatcher idiom** — advance the injected timer to fire, then `await host.idle()`. Where a test asserted `runOnce()` returned `true` or `false`, **assert the observable instead**: a row's state, a handler's call count, a job's `run_at`. A test that asserted a return value should now assert an effect, which is strictly stronger.

- [ ] **Step 3: Run both idioms against the same assertions once, and this is time-limited.** The adapter bypasses `Dispatcher` entirely, so `runOnce` passing proves only that the *adapter* preserves behaviour. Pick at least one test in this file, drive it **both** ways — old `runOnce`, then advance-timer-plus-`idle` — against identical assertions, and confirm they agree. Task 12 deletes the adapter and closes this window permanently, so the comparison is possible only while both exist. Report which test you used and what you observed.

- [ ] **Step 4: Where a test steps through a chain one job at a time, set `concurrency: 1`** rather than relying on the dispatcher being serial by nature. Say in your report which tests needed it — a test that needs serial execution is telling you something about the code it covers.

- [ ] **Step 5: Run the file green, then the full suite.**

- [ ] **Step 6: Prove nothing was weakened.** Pick the three tests whose assertions changed most, mutate the code each covers, and confirm each still fails. Report them by name with counts. If a migrated test can no longer fail, that is a finding — several unpinned spots have already been found on this plan.

- [ ] **Step 7: Commit**

```bash
git commit -m "Drive host.test.ts's jobs by advancing the clock rather than by claiming one at a time" -- packages/host/test/host.test.ts
```

---

### Task 10: Migrate `flow.test.ts` to the dispatcher idiom

**Files:**
- Modify: `packages/host/test/double/flow.test.ts` (26 `runOnce` call sites)

**Interfaces:**
- Consumes: `Host.start(handlers, ctxFor)`, `Host.stop()`, `Host.idle()`, the injected `Timers`, and — for now — the temporary `runOnce()` adapter.
- Produces: nothing. This task moves a test file from one idiom to the other.

- [ ] **Step 1: Record the file's test count and run it green.** Report the number; it is the baseline your own change is measured against.

- [ ] **Step 2: Replace each `await host.runOnce()` with the dispatcher idiom** — advance the injected timer to fire, then `await host.idle()`. Where a test asserted `runOnce()` returned `true` or `false`, **assert the observable instead**: a row's state, a handler's call count, a job's `run_at`. A test that asserted a return value should now assert an effect, which is strictly stronger.

- [ ] **Step 3: Run both idioms against the same assertions once, and this is time-limited.** The adapter bypasses `Dispatcher` entirely, so `runOnce` passing proves only that the *adapter* preserves behaviour. Pick at least one test in this file, drive it **both** ways — old `runOnce`, then advance-timer-plus-`idle` — against identical assertions, and confirm they agree. Task 12 deletes the adapter and closes this window permanently, so the comparison is possible only while both exist. Report which test you used and what you observed.

- [ ] **Step 4: Where a test steps through a chain one job at a time, set `concurrency: 1`** rather than relying on the dispatcher being serial by nature. Say in your report which tests needed it — a test that needs serial execution is telling you something about the code it covers.

- [ ] **Step 5: Run the file green, then the full suite.**

- [ ] **Step 6: Prove nothing was weakened.** Pick the three tests whose assertions changed most, mutate the code each covers, and confirm each still fails. Report them by name with counts. If a migrated test can no longer fail, that is a finding — several unpinned spots have already been found on this plan.

- [ ] **Step 7: Commit**

```bash
git commit -m "Drive flow.test.ts's jobs by advancing the clock rather than by claiming one at a time" -- packages/host/test/double/flow.test.ts
```

---

### Task 11: `main` loses its pump

**Files:**
- Modify: `packages/host/src/main.ts`
- Test: `packages/host/test/main.test.ts` (8 call sites)

**Interfaces:**
- `startPump` and `Pump` are **deleted**. `main` calls `host.start(...)` and returns; `SIGINT`/`SIGTERM` call `host.stop()` and exit.

Three properties the old pump's tests asserted still matter, and they move rather than disappear:

- **`recover` before scheduling.** `main` must sweep before `scheduleKnownFeeds`, or a crashed poll job is seen as `running`, declined, and then dead-lettered — leaving a feed silently stopped. `start()` now does the sweep, so `start()` must precede `scheduleKnownFeeds`. **Keep the test that fails when the two are swapped.**
- **A failing job does not stop the host.** Previously a rejected `runOnce` was caught in the loop; now `runJob` owns every handler's outcome and the dispatcher never awaits one, so this holds by construction. **Keep a test that proves it** — one job rejecting must not prevent the next from running.
- **Shutdown is prompt.** `stop()` clears timers and returns without waiting on in-flight work. **Assert a hung handler does not delay it**, which the old drain could not have passed.

- [ ] **Step 1: Write the failing tests** for the three properties above against the new surface.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Delete `startPump`, `Pump` and the drain; wire `main` to `start`/`stop`.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail** — call `scheduleKnownFeeds` before `start()`; the ordering test must fail. Await the queue inside the signal handler; the prompt-shutdown test must fail.
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Start the dispatcher instead of running a pump, so shutdown no longer waits on a handler"
```

---

### Task 12: Delete the adapter

**Files:**
- Modify: `packages/host/src/jobs/runner.ts`, `packages/host/src/host.ts`, `packages/host/src/index.ts`

**Interfaces:**
- `runOnce()` is **removed** from `Runner` and `Host`.

- [ ] **Step 1: Confirm no callers remain.** Search the whole repo for `runOnce`; the only hits should be prose. Paste the search into your report.
- [ ] **Step 2: Delete it**, along with any comment that described it.
- [ ] **Step 3: Run the full gate.** Nothing should change but the absence.
- [ ] **Step 4: Confirm the surface reads as intended** — `Host` exposes `register`, `notifyNewRssItems`, `requestDownload`, `schedulePoll`, `start`, `stop`, `idle`. If `idle()` has no non-test caller, say so in your report: it is a test affordance by design, and worth stating rather than leaving to be discovered.
- [ ] **Step 5: Commit**

```bash
git add packages/host
git commit -m "Remove the test adapter now that nothing claims one job at a time"
```

---

## Self-Review

**Spec coverage.** §1 why the pump was wrong → Tasks 11 and 12 remove it. §2 the deliverables → Tasks 4–6. §2.1's decisions → Global Constraints and the task carrying each: `running` not `in-progress` → Task 3; the safety interval → Task 4; `runOnce` becomes the initiator → Tasks 7 and 12; the five-minute cap → Task 5. §2.2's exclusions → no tasks, deliberately. §3 the dispatcher → Tasks 4 and 6. §4 enforcing the cap → Task 5. §5 concurrency → Tasks 2 and 4, with the queued-id set in Task 4. §6 recovery → Task 6. §6.1 what happens to `Runner` → Tasks 7 and 12. §7 schema → Task 3. §8 the test seam → Tasks 8–10, with `idle()` from Task 2. §9 `QPromise` → Task 1. §10's consequences → recorded, not work.

**Placeholder scan.** No "TBD", no "handle edge cases". Tasks 8–10 share a shape but each states its own steps and file rather than saying "as Task 8". Test cases are named skeletons with their fixtures and the reason each exists stated beside them; the load-bearing implementation carries real code.

**Type consistency.** `BoundedQueue.run/active/idle` is Task 2's and Tasks 4–6 consume it unchanged. `QPromise`'s flags are functions in Task 1 and called as functions in Task 5. `Timers` is Task 4's and Tasks 6, 8–11 inject it. `runJob`'s signature is Task 5's and the dispatcher's injected runner slot in Task 4 is what it fills. `start(handlers, ctxFor)` takes the same two arguments `Runner.runOnce` takes today, which is what makes Task 7's adapter possible.

**One thing recorded rather than resolved.** `idle()` exists for tests. Task 12 asks for that to be stated plainly if it still has no production caller, because a method whose only callers are tests is worth labelling before someone finds it and assumes it is load-bearing.
