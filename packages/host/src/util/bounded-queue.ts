/**
 * A limit of a caller's own choosing on how many `run()`ed tasks may be
 * executing at once. `active` counts tasks currently inside `task()`,
 * capped at the limit passed to `createBoundedQueue`; a task that arrives
 * once the cap is already hit waits in arrival order for a slot a finished
 * (or rejected) task frees.
 */
export interface BoundedQueue {
  /** Runs `task` when a slot is free. Rejects if `task` rejects. */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** How many are executing right now. */
  active(): number;
  /** Resolves when nothing is running or waiting. */
  idle(): Promise<void>;
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
export function createBoundedQueue(limit: number): BoundedQueue {
  assertValidLimit(limit);

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

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running >= limit) {
        await new Promise<void>((resolve) => { waiting.push(resolve); });
      }
      running += 1;
      try {
        return await task();
      } finally {
        // Runs whether `task` resolved or rejected. Drop either half of
        // this and a rejected task leaves its slot permanently occupied:
        // every later task either runs past the real limit (skip the
        // decrement) or waits on a wake that never comes (skip the wake) --
        // the queue is wedged forever, silently.
        running -= 1;
        const next = waiting.shift();
        if (next) {
          next();
        } else if (isIdle()) {
          settleIdleWaiters();
        }
      }
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
