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

  function run<T>(work: () => Promise<T>): Promise<T> {
    pending += 1;
    const result = tail.then(work);
    // Swallow rejections on the chain itself so one failure cannot wedge it,
    // and always release the pending count once this job has truly settled
    // (not merely been handed off) so a later tryRun sees the mutex as free
    // again. `result` — returned to the caller unmodified — still carries
    // the original rejection.
    tail = result.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      pending -= 1;
    });
    return result;
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
