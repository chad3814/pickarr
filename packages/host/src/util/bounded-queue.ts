/**
 * A limit of a caller's own choosing on how many `run()`ed tasks may be
 * executing at once. `active` counts tasks currently inside `task()`,
 * capped at the current limit (the one passed to `createBoundedQueue`, or the
 * last `setLimit`); a task that arrives
 * once the cap is already hit waits in arrival order for a slot a finished
 * (or rejected) task frees.
 */
export interface BoundedQueue {
  /** Runs `task` when a slot is free. Rejects if `task` rejects. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /**
   * How many are executing right now. A test affordance: no production caller
   * exists in this repo, and the two consumers (`fetch/queue.ts` and
   * `jobs/dispatcher.ts`) never read it. It is what lets a test assert on
   * overlap directly rather than inferring concurrency from timing.
   */
  active(): number;
  /**
   * Resolves when nothing is running or waiting. **A test affordance too, and
   * it must not be used for shutdown**: `Dispatcher.stop()` abandons in-flight
   * work deliberately, and awaiting this instead would reintroduce the
   * shutdown hang the job dispatcher exists to remove.
   */
  idle(): Promise<void>;
  /** The number of tasks allowed to run at once, as of the last `setLimit` or construction. */
  limit(): number;
  /**
   * Changes the ceiling for every task from now on. Raising it starts as
   * many waiting tasks as the new headroom allows; lowering it starts
   * none and cancels none -- running tasks finish, and `run` opens no new
   * slot until `active()` is below the new limit. Refuses the same values
   * the constructor does.
   */
  setLimit(limit: number): void;
}

/**
 * The one definition of what a concurrency limit may be. Exported because the
 * fetch subsystem validates the same property against its own config shape
 * and needs to name the offending key in its message -- two messages, one
 * predicate. Duplicating the comparison instead is how the two drift when
 * only one of them is ever tightened.
 */
export function isValidLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/**
 * A limit of 0 or below is not "run nothing" -- it is `running >= limit`
 * (e.g. `0 >= 0`) true before any task has ever run, so the very first
 * `run()` queues behind a slot nothing will ever grant. Nothing later would
 * observe that: no error, no timeout, just a promise that never settles.
 * Reject it here, at construction, loudly and by value, rather than clamp
 * it -- clamping would silently substitute behaviour nobody asked for,
 * rather than let it surface invisibly whenever the first task happens to
 * be run.
 */
function assertValidLimit(value: number): void {
  if (!isValidLimit(value)) {
    throw new Error(`bounded queue limit must be an integer of at least 1, got ${value}`);
  }
}

/**
 * One shared implementation of "run at most `limit` of these at once,"
 * used both per-hostname by the fetch subsystem and once, unkeyed, by the
 * job dispatcher. A running count, a FIFO of waiters woken one at a time as
 * slots free, and an `idle()` that resolves only once both are empty.
 */
export function createBoundedQueue(initialLimit: number): BoundedQueue {
  assertValidLimit(initialLimit);
  let limit = initialLimit;

  let running = 0;
  const waiting: Array<() => void> = [];
  const idleWaiters: Array<() => void> = [];

  function isIdle(): boolean {
    return running === 0 && waiting.length === 0;
  }

  function settleIdleWaiters(): void {
    while (idleWaiters.length > 0) {
      idleWaiters.shift()?.();
    }
  }

  /** Starts waiters while there is headroom. One waiter per free slot; each one is counted in `running` here, before it resumes. */
  function release(): void {
    while (running < limit && waiting.length > 0) {
      running += 1;
      waiting.shift()?.();
    }
    if (isIdle()) settleIdleWaiters();
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running >= limit) {
        // Resumed by `release`, which has already counted this task.
        await new Promise<void>((resolve) => { waiting.push(resolve); });
      } else {
        running += 1;
      }
      try {
        return await task();
      } finally {
        // Runs whether `task` resolved or rejected. Drop either half of
        // this and a rejected task leaves its slot permanently occupied:
        // every later task either runs past the real limit (skip the
        // decrement) or waits on a wake that never comes (skip the wake) --
        // the queue is wedged forever, silently.
        running -= 1;
        release();
      }
    },

    limit(): number {
      return limit;
    },

    setLimit(next: number): void {
      assertValidLimit(next);
      limit = next;
      release();
    },

    active(): number {
      return running;
    },

    idle(): Promise<void> {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => { idleWaiters.push(resolve); });
    },
  };
}
