export interface Mutex {
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Runs only if the mutex is free; returns false when it was busy. */
  tryRun(work: () => Promise<void>): Promise<boolean>;
}

export function createMutex(): Mutex {
  let tail: Promise<void> = Promise.resolve();
  // Count of runs enqueued but not yet finished, rather than a plain boolean
  // flipped inside the queued work itself. `run` must mark the mutex busy the
  // instant it is called — synchronously, before the microtask queue even
  // gets a turn — because `tryRun` reads this state synchronously too. If
  // "busy" were only set once a queued job actually starts executing, a
  // `run()` immediately followed by a synchronous `tryRun()` (exactly what
  // the "skips instead of queueing when busy" test does) would observe the
  // mutex as free and queue in behind it instead of skipping.
  let pending = 0;
  // True only while a job's `work()` is actually running (from just before
  // it is invoked to just after it settles) — distinct from `pending`, which
  // also counts jobs merely queued behind it. Used solely to reject
  // same-mutex re-entrancy: a job calling `run()` on the very mutex it is
  // currently executing under would otherwise queue behind itself and never
  // proceed, since `tail` cannot advance past the inner acquisition until
  // the outer one — which is waiting on the inner — finishes.
  let executing = false;

  function run<T>(work: () => Promise<T>): Promise<T> {
    if (executing) {
      return Promise.reject(
        new Error(
          'Mutex.run: reentrant acquisition — a job running under this mutex tried to acquire ' +
            'the same mutex again. This would deadlock permanently (the outer job cannot finish ' +
            'until the inner one does, and the inner one cannot even start until the outer job ' +
            "finishes), so it's rejected instead of silently queued.",
        ),
      );
    }

    pending += 1;
    const outcome = tail.then(async () => {
      executing = true;
      try {
        return await work();
      } finally {
        executing = false;
      }
    });
    // Swallow rejections on this internal chain so one failure cannot wedge
    // it — `tail` must always end up resolved so the next `run` call's
    // `tail.then(...)` is guaranteed to fire.
    tail = outcome.then(
      () => undefined,
      () => undefined,
    );
    // The promise handed back to the caller is derived from `outcome`, not
    // `outcome` itself, so the pending count can be released in the very
    // continuation that produces the caller's value or rethrows their error.
    // That guarantees the release is visible no later than the caller's own
    // `await` resumes — one microtask hop, not the two it would take to
    // decrement via a chain built off the (already-swallowed) `tail`. The
    // original outcome — value or rejection — is preserved untouched either
    // way; only the pending bookkeeping is added around it.
    return outcome.then(
      (value) => {
        pending -= 1;
        return value;
      },
      (error) => {
        pending -= 1;
        throw error;
      },
    );
  }

  return {
    run,
    async tryRun(work) {
      if (pending > 0) return false;
      await run(work);
      return true;
    },
  };
}
