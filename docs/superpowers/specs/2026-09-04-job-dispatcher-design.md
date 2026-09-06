# Pickarr 2.0 — The Job Dispatcher

Replaces the polling pump with a timer-driven dispatcher that does not wait on
the handlers it starts. The point is stated as a requirement rather than a
target: **a hung fetch must not be able to affect the jobs subsystem at all.**

## 1. Why the pump was wrong

`startPump` claims one job and `await`s its handler, in a loop. Every property
that follows from that is a defect:

- A handler that blocks blocks **every** job — artwork, lookups for unrelated
  plugins, polls of healthy feeds. Slice B added a 30 second fetch timeout,
  which put a ceiling on each episode and decoupled nothing.
- `pump.done` awaits the in-flight handler, so shutdown inherits the same
  ceiling. That trades the crash-recovery sweep — a mechanism built precisely
  to handle jobs killed mid-flight — for the appearance of a clean drain.
- The loop sleeps 1000ms when nothing is ready, so the system polls its own
  database to discover time has passed.

The fix is not more concurrency. It is **not awaiting the handler**: dispatch
becomes fire-and-forget, so nothing the handler does can stall the dispatcher.
Once that holds, a timer replaces the idle poll, because the dispatcher can
sleep until something is actually due rather than asking every second.

## 2. What this delivers

- A **timer-driven dispatcher**. An in-memory `setTimeout` for the next due
  job, re-armed whenever a job is enqueued that is due sooner.
- **Fire-and-forget dispatch**, as built `void queue.run(...).catch(...)`.
  The handler's own callbacks update its row, and the `catch` is the only
  channel that surfaces a failure the row cannot record — most notably the
  claim guard's throw.
- **A five-minute ceiling per job**, enforced by the dispatcher rather than
  requested of the handler.
- **Bounded concurrency**, so a batch coming due together cannot dispatch
  without limit.
- **Crash recovery** that preserves the dead-letter rule.

### 2.1 Decisions taken before this spec

- **`running`, not `in-progress`.** `jobs.state` already uses `running` for
  exactly this state. Two names for one state is drift, so this is a rename of
  the idea, not a new value.
- **A safety interval as well as the timer.** Every minute, re-derive the
  timeout from the earliest due job. Belt and suspenders: a lost, mis-computed
  or overflowed timer costs at most a minute of latency instead of wedging the
  subsystem.
- **`runOnce()` becomes the initiator.** The old "claim and run one job" seam
  disappears; what tests and `main` call is the dispatcher's start, which
  sweeps `running` rows and arms the timer.
- **The five-minute cap is `AbortSignal.timeout(300_000)`**, handed to every
  handler, with a two second grace period after abort before the dispatcher
  gives up on it.

### 2.2 What this slice is not

- **No change to what handlers do.** The feed reader, the lookup and the
  artwork job keep their logic; they gain a `signal` parameter.
- **No removal of the 30 second fetch timeout.** It stays as defence in depth,
  and it is what makes an orphaned handler eventually unwind — for the request
  that holds a hostname's slot. It is armed *before* the per-hostname queue, so
  the budget is measured from the call and covers the wait for a slot as well
  as the request; armed inside the queued task, as it originally was, a waiter
  had no deadline of its own and a caller's wall clock was
  `(its queue position) × 30 seconds` — bounded, since each task ahead does
  release within its own 30 seconds, but bounded by a depth nothing limits.
- **No cancellation of a running handler.** Nothing can kill a JavaScript
  function mid-execution. The dispatcher bounds the *row*, not the work.

## 3. The dispatcher

```ts
export interface Dispatcher {
  /** Re-derives the timer from the earliest ready, not-yet-queued `run_at`. */
  rearm(): void;
  /** Sweeps `running` rows, arms the timer, starts the safety interval. */
  start(
    handlers: (pluginId: string, kind: string) => JobHandler | undefined,
    ctxFor: (pluginId: string) => PluginContext,
  ): number;
  /** Stops the timer and the interval. Does not wait for in-flight handlers. */
  stop(): void;
  /** Resolves when nothing is in flight. For tests, not for shutdown. */
  idle(): Promise<void>;
}
```

**As built, `enqueue` is not here.** It stayed on `Runner` (see §6.1), and what
the dispatcher gained instead is `rearm()` — the seam a caller that has just
written a `jobs` row uses to say "what is due may have changed". `Host` owns
both sides: it calls `runner.enqueue` and then `dispatcher.rearm()`. `start`
also takes the two arguments `Runner.runOnce` used to, because a `JobRecord`
carries no plugin id and only the raw row does.

**Arming.** After a change to what is due, the dispatcher reads the earliest
`run_at` among `ready` rows and sets a single timeout for it. As built the
callers are `start()`, every timer fire, the safety interval, and `Host` on
each enqueue — **not** a job completing. Nothing is missed: a fire re-arms
after dispatching, and the earliest not-yet-queued `run_at` is already in the
past whenever a backlog remains, so the timer chains at zero delay and drains
a batch per macrotask. **The delay is clamped to at most 60 seconds.**
`setTimeout` beyond about 24.8 days fires immediately in Node, so an unclamped
far-future or corrupt `run_at` produces a hot loop rather than a late job.
Clamping also collapses the timer and the safety interval into one mechanism:
the interval becomes the upper bound the timer already respects.

**Firing.** Select every `ready` row whose `run_at` has passed, **oldest
first**, up to the dispatch cap, **excluding ids already queued in memory**
(§5). Hand each to the queue and re-arm. Nothing is written to the rows here
and nothing is awaited — the queue worker owns both the row and the waiting.

**Shutdown does not drain.** `stop()` clears the timer and returns. In-flight
handlers are abandoned deliberately: their rows stay `running`, and the next
`start()` sweeps them. That is what the durable job table is for, and waiting
on a handler that may be hung is the very coupling this slice removes.

## 4. Enforcing the five-minute cap

The handler receives a `signal` from `AbortSignal.timeout(300_000)`. Nothing
compels a handler to honour it, so the dispatcher does not rely on that:

```ts
async function runJob(job: JobRecord, handler: JobHandler): Promise<void> {
  const signal = AbortSignal.timeout(300_000);
  const running = makeQPromise(handler(job, signal));

  signal.addEventListener('abort', () => {
    // Two seconds for a cooperative handler to unwind on its own. Wrapped
    // rather than `async` directly: an async listener that rejects has
    // nowhere to report, so its failure would surface as an unhandled
    // rejection instead of a failed row.
    void (async () => {
      await sleep(2000);
      if (running.isPending()) failRow(job, new Error('job exceeded 5 minutes'));
    })().catch((err: unknown) => log('job timeout handler failed', { err }));
  }, { once: true });

  try {
    await running;
    completeRow(job);
  } catch (err: unknown) {
    failRow(job, err);
  }
}
```

`await running` inside a `try` is what makes one `catch` cover both paths —
without the `await`, a rejection lands on a later tick where no enclosing
`try` can see it. The `await` is safe precisely because **the dispatcher never
awaits `runJob`**; the queue worker does, and the queue's concurrency bounds
how many slots a hung handler can hold.

Three details, each of which was wrong in an earlier sketch of this:

- **`isPending()` is a function.** Reading `running.isPending` is always
  truthy, which would time out every job.
- **The timeout writes a row; it does not throw.** A `throw` on the timer's
  tick is uncatchable by any enclosing `try` and would kill the process.
- **Row updates are conditional: `WHERE id = ? AND state = 'running' AND
  attempts = ?`.** A handler that finishes at six minutes would otherwise
  overwrite the row the timeout already failed — because `await running`
  resumes and calls `completeRow` regardless. The conditional makes a late
  settle a no-op, the same shape the atomic claim already uses.

  **The state alone is not enough, and the attempt half is why.** The timeout
  returns the row to `ready` one backoff step out; the timer picks it up and a
  second worker legitimately claims it back to `running`. The first handler is
  still pending, so a state-only test matches again while every value in its
  closure describes an attempt that is over. Measured both ways: a late resolve
  marked the row `done` while attempt 2 was mid-flight, and a late reject
  readied it under attempt 1's stale count, putting a third copy of the same
  job in flight. The claim's `attempts` is the discriminator because that
  statement is the only writer of the column, one increment per attempt, so two
  attempts can never share a value. The dispatcher's queued-id set (§5) cannot
  see any of this: the row is legitimately `ready` with nothing queued for it.

The orphaned handler keeps running. It unwinds when its fetch hits the 30
second timeout, which is the other half of why that timeout stays.

## 5. Concurrency

A batch coming due together — 200 feeds, or everything after a day of downtime
— must not dispatch 200 handlers at once. The per-hostname fetch queue bounds
requests *per host*; it does not bound the total, so sockets and memory would
be unbounded.

**The default cap is 8**, chosen so a batch of feeds proceeds in parallel
across different hosts while a pathological batch cannot open hundreds of
sockets. It is a constant rather than a knob, on the same reasoning as the
fetch limits: nothing sets it yet, and a parameter nothing uses is a smell this
project keeps finding. Jobs beyond the cap stay `ready` in the database and are
picked up on the next fire — prompt because a fire that leaves a backlog
re-arms on an already-past `run_at`, not because anything re-arms on
completion. One consequence to know: that zero-delay chain pulls every due row
into the queued-id set and the bounded queue's own waiter list within a few
macrotasks, so for the "everything after a day of downtime" case the *database*
is paced but the in-memory waiter list is not.

**The bounded queue already exists.** `packages/host/src/fetch/queue.ts` holds
a queue with a running count, a waiter list and a validated limit, built and
mutation-tested in slice B. **Extract it as a shared primitive** rather than
adding the `async` package: the fetch subsystem keeps one instance per
hostname, and the dispatcher uses a single instance with its own concurrency.
One implementation, already proven, no new dependency.

**A queued job stays `ready` until a worker starts it.** The row is not
touched at dispatch. Marking it early would mean `running` covered both "a
handler is executing" and "this was taken but never began", and on a crash the
second kind would wrongly have its `attempts` incremented for a try that never
happened.

> **Decision.** Nothing is written to the row at dispatch. The **queue worker**
> sets `state = 'running'` and stamps `started_at` as its first act, because
> that is the moment the job has actually been tried. A crash before a worker
> reaches a queued job therefore leaves it exactly as it was — `ready`, at its
> original `run_at` — and the next `start()` simply finds it due again.

That has a consequence which must be built, not assumed: **the dispatcher keeps
an in-memory set of job ids it has queued but not yet started, and excludes
them from selection.** Without it, the next timer fire — or the 60 second
safety interval — re-selects a row that is still `ready` and dispatches a
second copy of a job already waiting in the queue. The set is deliberately
in-memory only: it dies with the process, which is correct, since after a crash
those rows *should* be selectable again.

## 6. Crash recovery

Since there is one process, **any `running` row at `start()` is by definition
crashed** — and because §5 writes that state only when a worker begins, a
`running` row also means the job was genuinely tried. That is what makes
incrementing `attempts` correct rather than punitive. Recovery is not a
restart:

- Leave `attempts` alone. (This bullet read "increment `attempts`" before the
  claim was folded into a single statement that marks `running`, stamps
  `started_at` and consumes the attempt together. The crashed attempt was
  therefore already charged, and incrementing again here would double-charge
  it. The code is right; this line was stale.)
- A row already at its last permitted attempt goes to `dead`, not back to
  `ready`. This rule exists because a job kind that reliably kills the process
  would otherwise be readied on every boot and the host would never finish
  starting. It predates this slice and must survive it.
- Everything else returns to `ready` with its `run_at` recomputed from the
  backoff curve, so a crash loop backs off rather than spinning.

`start()` returns how many rows it touched — the count `main` logs on boot.

## 6.1 What happens to `Runner`

`Dispatcher` **replaces** `Runner`'s execution half rather than wrapping it.
`Runner.enqueue` keeps its `(pluginId, job)` shape and its reason — a plugin's
own `ctx.jobs` already knows which plugin it is, and trusting a plugin to name
its own `pluginId` would let it enqueue work under another plugin's identity.
As built it also keeps its *home*: `enqueue` stayed on `Runner`, which shrank
to that one method, and `Dispatcher` gained `rearm()` instead (§3). `Host` is
what pairs them.

`Runner.runOnce(handlers, ctxFor)` and `Runner.recover()` both disappear.
(Both did, in the end: `recover()` outlived `runOnce` by a fix wave, dead and
disagreeing about backoff the whole time.) Their
work moves into `start()`, which needs the same two arguments: the handler
lookup keyed by `(pluginId, kind)`, and the context factory. `Host`'s surface
changes with them — `runOnce()` and `recover()` give way to `start()` and
`stop()`, and `main` loses its pump loop entirely.

## 7. Schema

`HOST_MIGRATIONS` gains a version: `jobs.started_at INTEGER` — nullable, for
the reason in §5. No new state value; `running` already exists alongside
`ready`, `done` and `dead`.

## 8. The test seam

This is the largest practical cost of the slice, and the reason to design it
rather than discover it. Roughly 1572 tests exist; the job-driving ones call
`runOnce()` and rely on it awaiting the handler.

- **The timer is injected**, alongside the `now` already injected: the
  dispatcher takes `setTimeout`/`clearTimeout` equivalents so a test can
  advance time without waiting on it.
- **`idle()` replaces awaiting a claim.** A test dispatches, then awaits
  `idle()`, which resolves when the queue has nothing running or waiting. This
  is a test affordance and must not be used for shutdown, where waiting on
  in-flight work is precisely the defect being removed.
- **Every test that called `runOnce()` to run exactly one job changes shape**,
  from "run one" to "advance time, then await idle". Where a test genuinely
  depends on one-at-a-time ordering, it sets the dispatcher's concurrency to 1
  rather than relying on the dispatcher being serial by nature.

## 9. `QPromise`

`qpromise.ts` currently sits at the project directory root, **outside the git
repository**. It moves into the repo, and two things are fixed on the way in:
`(e: any)` becomes `unknown`, since this project forbids `any`; and the unused
`Proms<T>` type is dropped.

Note what it is: a query-only wrapper. It exposes `isPending()`, `isResolved()`
and `isRejected()`, and offers no external resolve or reject. The dispatcher
therefore cannot reject a handler's promise to time it out — it can only
observe that the handler is still pending and act on the row. §4 is written
around that.

## 10. Consequences

- **The idle poll disappears.** A host with nothing due does nothing, rather
  than waking every second to ask.
- **Ordering across jobs is no longer guaranteed.** Concurrent dispatch means
  two jobs may interleave at their `await` points. `node:sqlite` is
  synchronous, so database work is still serialized on the event loop and no
  write can tear; what changes is that a handler cannot assume it is the only
  one between two of its own awaits. Handlers are already required to be
  idempotent, which is what makes this safe.
- **A hung handler costs one queue slot for as long as the process runs** —
  not five minutes, which an earlier draft of this line claimed. §4's
  `await running` is unconditional: there is no `Promise.race`, so the abort
  listener writes the *row* at five minutes and the worker keeps waiting. The
  bounded queue frees a slot only when its task settles. What the five minutes
  bounds is the row, exactly as §2.2's third bullet says. The subsystem's
  ceiling is therefore `concurrency` never-settling handlers — eight, at the
  default — after which `idle()` never resolves and no job of any kind runs.
  The 30 second fetch timeout is what keeps that hypothetical, since it makes
  any handler blocked on a request unwind; a handler blocked on anything else
  has no such floor.
  It does not delay other jobs until the slots are gone, does not delay
  shutdown, and does not prevent the next boot from cleaning up after it.
- **`main`'s drain goes away**, and with it the reason `SIGTERM` could hang.
