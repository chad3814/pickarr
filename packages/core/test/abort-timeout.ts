import type { TestContext } from 'node:test';

/**
 * Takes control of the deadline the code under test creates, by replacing
 * `AbortSignal.timeout` with a signal the test aborts on demand.
 *
 * The obvious tool is `t.mock.timers.enable({ apis: ['AbortSignal.timeout'] })`,
 * and that is what this used to be. It does not work: no Node build this
 * project runs on accepts that api name. Enumerated against v24.15.0, the
 * mock timer accepts `setTimeout`, `setInterval`, `setImmediate`, `Date` and
 * `scheduler.wait`, and rejects `AbortSignal.timeout` with
 * `ERR_INVALID_ARG_VALUE` before a single assertion runs. The previous helper
 * carried a comment claiming the runtime honoured it and only the `@types/node`
 * declarations lagged; the cast that comment justified silenced the type error
 * and left the runtime error, so all three tests using it failed for months
 * while reading as an upstream typings problem.
 *
 * Stubbing the static needs no timer mocking at all, and tests the same thing
 * more directly: production code still calls `AbortSignal.timeout(ms)`, still
 * gets a signal, and still aborts for exactly one reason — the test just
 * decides when. It also lets a test assert *which* deadline was asked for,
 * which ticking a clock never could.
 *
 * `fire()` aborts with a real `TimeoutError` DOMException, the same shape
 * `AbortSignal.timeout` aborts with, because `abortRejection` rejects with
 * `signal.reason` and callers inspect what they are given — a plain `Error`
 * here would make the tests pass against a rejection the production code can
 * never actually see.
 *
 * Every signal handed out is aborted together. A caller that creates one per
 * attempt (`searchSites` does, once per page) would otherwise leave earlier
 * signals live, and the test would be asserting against whichever one it
 * happened to still hold.
 *
 * The mock is registered through `t.mock`, so node:test restores the real
 * static when the test ends, whether it passed or threw.
 */
export interface StubbedAbortTimeout {
  /** Aborts every signal handed out so far, exactly as a real timeout would. */
  fire(): void;
  /** The deadlines the code under test asked for, in call order. */
  readonly requested: readonly number[];
}

export function stubAbortTimeout(t: TestContext): StubbedAbortTimeout {
  const requested: number[] = [];
  const controllers: AbortController[] = [];

  t.mock.method(AbortSignal, 'timeout', (milliseconds: number): AbortSignal => {
    requested.push(milliseconds);
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });

  return {
    requested,
    fire(): void {
      for (const controller of controllers) {
        controller.abort(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        );
      }
    },
  };
}
