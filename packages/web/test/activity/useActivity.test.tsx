import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ActivityRead } from '@pickarr/contract';
import { emitActivity, subscribeActivity } from '../../src/store/notify.ts';
import { ACTIVITY_POLL_MS, useActivity, type ActivityFetch } from '../../src/activity/useActivity.ts';
import type { SendJsonResult } from '../../src/auth/sendJson.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): the hook
 * owns a real interval, and a test that threw before its own cleanup would
 * leave it running and hang the file.
 */
afterEach(cleanup);

const realSetInterval = globalThis.setInterval;
afterEach(() => {
  globalThis.setInterval = realSetInterval;
});

const EMPTY: ActivityRead = { jobs: { running: [], waiting: [], dead: [], recent: [] }, fetches: [] };

function readWithRunning(kind: string): ActivityRead {
  return {
    ...EMPTY,
    jobs: {
      ...EMPTY.jobs,
      running: [
        { id: 1, pluginId: 'p', kind, attempts: 1, maxAttempts: 3, runAt: 1, startedAt: 2, updatedAt: 3, lastError: null },
      ],
    },
  };
}

function answered(body: unknown, status = 200): SendJsonResult {
  return { outcome: 'answered', status, body };
}

/** A fetch that answers from `results` in order, repeating the last one, and counts its calls. */
function sequence(results: readonly SendJsonResult[]): { fetch: ActivityFetch; calls: () => number } {
  let n = 0;
  return {
    fetch: () => {
      const result = results[Math.min(n, results.length - 1)];
      n += 1;
      if (result === undefined) throw new Error('sequence needs at least one result');
      return Promise.resolve(result);
    },
    calls: () => n,
  };
}

/** One object for the life of the file: the hook re-subscribes when its source changes, as `Shell`'s single `Store` never does. */
const SOURCE = { subscribeActivity };

function Harness({
  fetch,
  onExpired,
  intervalMs,
}: {
  fetch: ActivityFetch;
  onExpired: () => void;
  intervalMs?: number;
}): ReactElement {
  const state = useActivity(SOURCE, fetch, onExpired, intervalMs);
  if (state.phase === 'loading') return <p>loading</p>;
  if (state.phase === 'unreachable') return <p>failed first</p>;
  const running = state.read.jobs.running.map((j) => j.kind).join(',');
  return <p>{`ready ${running} ${state.unreachable ? 'unreachable' : 'reachable'}`}</p>;
}

test('loading until the first answer, then ready', async () => {
  const s = sequence([answered(readWithRunning('noop'))]);
  render(<Harness fetch={s.fetch} onExpired={() => {}} />);
  assert.ok(screen.getByText('loading'), 'nothing has answered yet');
  await waitFor(() => {
    assert.ok(screen.getByText('ready noop reachable'));
  });
});

test('an activity event refetches', async () => {
  const s = sequence([answered(readWithRunning('first')), answered(readWithRunning('second'))]);
  render(<Harness fetch={s.fetch} onExpired={() => {}} />);
  await waitFor(() => {
    assert.ok(screen.getByText('ready first reachable'));
  });
  assert.equal(s.calls(), 1);
  act(() => {
    emitActivity();
  });
  await waitFor(() => {
    assert.ok(screen.getByText('ready second reachable'));
  });
  assert.equal(s.calls(), 2);
});

test('the safety-net poll is armed at 30 000 ms by default and at the given interval otherwise', () => {
  const delays: unknown[] = [];
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    delays.push(args[1]);
    return realSetInterval(...args);
  }) as typeof setInterval;
  const s = sequence([answered(EMPTY)]);
  const first = render(<Harness fetch={s.fetch} onExpired={() => {}} />);
  assert.equal(ACTIVITY_POLL_MS, 30_000);
  assert.ok(delays.includes(30_000), 'the default cadence is the literal 30 000');
  first.unmount();
  render(<Harness fetch={s.fetch} onExpired={() => {}} intervalMs={1234} />);
  assert.ok(delays.includes(1234), 'an explicit interval is honoured');
});

test('an offline answer after a ready one keeps the last read and flags unreachable; a good answer clears the flag', async () => {
  const s = sequence([
    answered(readWithRunning('kept')),
    { outcome: 'offline' },
    answered(readWithRunning('back')),
  ]);
  render(<Harness fetch={s.fetch} onExpired={() => {}} />);
  await waitFor(() => {
    assert.ok(screen.getByText('ready kept reachable'));
  });
  act(() => {
    emitActivity();
  });
  await waitFor(() => {
    assert.ok(screen.getByText('ready kept unreachable'), 'the last read survives');
  });
  act(() => {
    emitActivity();
  });
  await waitFor(() => {
    assert.ok(screen.getByText('ready back reachable'));
  });
});

test('a failure before any read is the unreachable phase, and a later good read makes it ready', async () => {
  const s = sequence([{ outcome: 'offline' }, answered({ error: 'boom' }, 500), answered({ jobs: 'nope' }), answered(readWithRunning('ok'))]);
  render(<Harness fetch={s.fetch} onExpired={() => {}} />);
  await waitFor(() => {
    assert.ok(screen.getByText('failed first'), 'offline');
  });
  for (const calls of [2, 3]) {
    act(() => {
      emitActivity();
    });
    await waitFor(() => {
      assert.equal(s.calls(), calls);
    });
    assert.ok(screen.getByText('failed first'), 'a 500 and a body of the wrong shape are failures too');
  }
  act(() => {
    emitActivity();
  });
  await waitFor(() => {
    assert.ok(screen.getByText('ready ok reachable'));
  });
});

test('an expired answer calls onExpired once', async () => {
  const s = sequence([{ outcome: 'expired' }]);
  let expired = 0;
  render(
    <Harness
      fetch={s.fetch}
      onExpired={() => {
        expired += 1;
      }}
    />,
  );
  await waitFor(() => {
    assert.equal(expired, 1);
  });
  assert.ok(screen.getByText('loading'));
});

test('an inline onExpired does not restart the subscription on every render', async () => {
  const s = sequence([answered(readWithRunning('noop'))]);
  const { rerender } = render(<Harness fetch={s.fetch} onExpired={() => {}} />);
  await waitFor(() => {
    assert.ok(screen.getByText('ready noop reachable'));
  });
  rerender(<Harness fetch={s.fetch} onExpired={() => {}} />);
  rerender(<Harness fetch={s.fetch} onExpired={() => {}} />);
  assert.equal(s.calls(), 1, 'a new callback identity is not a reason to refetch');
});

test('unmount clears the interval and unsubscribes', async () => {
  const cleared: unknown[] = [];
  const made: unknown[] = [];
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    made.push(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    cleared.push(handle);
    realClear(handle);
  }) as typeof clearInterval;
  try {
    const s = sequence([answered(EMPTY)]);
    const view = render(<Harness fetch={s.fetch} onExpired={() => {}} />);
    await waitFor(() => {
      assert.ok(screen.getByText('ready reachable'));
    });
    const before = s.calls();
    view.unmount();
    assert.ok(made.length > 0 && made.every((h) => cleared.includes(h)), 'every interval the hook made was cleared');
    emitActivity();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
    assert.equal(s.calls(), before, 'an event after unmount refetches nothing');
  } finally {
    globalThis.clearInterval = realClear;
  }
});
