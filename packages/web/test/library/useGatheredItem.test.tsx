import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useGatheredItem, type GatheredSource } from '../../src/library/useGatheredItem.ts';
import type { GatheredItem } from '../../src/store/gather.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that threw before its own call would leave `Harness` mounted and its
 * stub `subscribe` still "registered".
 */
afterEach(cleanup);

/** A real timer, not fake ones -- fake timers hang this suite (`CLAUDE.md`). */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 15);
  });
}

/** A bare `GatheredItem` naming only what this suite reads back: the title. */
function stubItem(id: number, title: string): GatheredItem {
  return {
    mediaItem: {
      id,
      pluginId: 'tv',
      createdAt: 0,
      updatedAt: 0,
      provider: null,
      providerRef: null,
      title,
      releaseDate: null,
      description: null,
    },
    pluginId: 'tv',
    releases: [],
    roles: [],
    artwork: { poster: '', background: '', logo: '' },
    feedIds: [],
  };
}

function Harness({
  source,
  mediaItemId,
  enabled,
}: {
  source: GatheredSource;
  mediaItemId: number;
  enabled: boolean;
}): ReactElement {
  const gathered = useGatheredItem(source, mediaItemId, enabled);
  return <div data-testid="result">{gathered === undefined ? 'none' : gathered.mediaItem.title}</div>;
}

function resultText(): string {
  return screen.getByTestId('result').textContent ?? '';
}

test('a disabled hook never gathers, and reads as undefined', () => {
  let gathers = 0;
  const source: GatheredSource = {
    gatherMediaItem: async (id: number) => {
      gathers += 1;
      return stubItem(id, 'Title');
    },
    subscribe: () => () => {},
  };
  render(<Harness source={source} mediaItemId={7} enabled={false} />);
  assert.equal(resultText(), 'none');
  assert.equal(gathers, 0, 'a collapsed card costs nothing');
});

test('enabling gathers once, and disabling then re-enabling reuses the cached result', async () => {
  let gathers = 0;
  const source: GatheredSource = {
    gatherMediaItem: async (id: number) => {
      gathers += 1;
      return stubItem(id, 'Title');
    },
    subscribe: () => () => {},
  };
  const { rerender } = render(<Harness source={source} mediaItemId={7} enabled={false} />);
  assert.equal(gathers, 0);

  rerender(<Harness source={source} mediaItemId={7} enabled />);
  await waitFor(() => {
    assert.equal(resultText(), 'Title');
  });
  assert.equal(gathers, 1);

  rerender(<Harness source={source} mediaItemId={7} enabled={false} />);
  assert.equal(resultText(), 'none', 'collapsing hides the cached result rather than clearing it');

  rerender(<Harness source={source} mediaItemId={7} enabled />);
  await waitFor(() => {
    assert.equal(resultText(), 'Title');
  });
  assert.equal(gathers, 1, 'reopening reused the cache instead of gathering again');
});

test("a notification on the item's own row, while enabled, replaces the cached result with a fresh gather", async () => {
  let gathers = 0;
  let notify: (() => void) | undefined;
  let subscribedTable: string | undefined;
  let subscribedId: number | undefined;
  const source: GatheredSource = {
    gatherMediaItem: async (id: number) => {
      gathers += 1;
      return stubItem(id, gathers === 1 ? 'First' : 'Second');
    },
    subscribe: (table: string, id: number, cb: () => void) => {
      subscribedTable = table;
      subscribedId = id;
      notify = cb;
      return () => {
        notify = undefined;
      };
    },
  };
  render(<Harness source={source} mediaItemId={7} enabled />);
  await waitFor(() => {
    assert.equal(resultText(), 'First');
  });
  assert.equal(subscribedTable, 'media_item', 'this hook watches the media item row, not a release or a download');
  assert.equal(subscribedId, 7);

  notify?.();
  await waitFor(() => {
    assert.equal(resultText(), 'Second');
  });
  assert.equal(gathers, 2, 'the notification triggered a fresh gather rather than reusing the cache');
});

test('a gather still in flight when the card collapses does not surface, but its result is cached for the next reopen', async () => {
  let gathers = 0;
  let resolveGather: ((item: GatheredItem) => void) | undefined;
  const source: GatheredSource = {
    gatherMediaItem: () => {
      gathers += 1;
      return new Promise<GatheredItem>((resolve) => {
        resolveGather = (item) => {
          resolve(item);
        };
      });
    },
    subscribe: () => () => {},
  };
  const { rerender } = render(<Harness source={source} mediaItemId={7} enabled />);
  await waitFor(() => {
    assert.ok(resolveGather !== undefined, 'the gather is in flight');
  });
  assert.equal(gathers, 1);

  rerender(<Harness source={source} mediaItemId={7} enabled={false} />);
  assert.equal(resultText(), 'none', 'collapsed before the gather resolved');

  resolveGather?.(stubItem(7, 'Title'));
  await settle();
  assert.equal(resultText(), 'none', 'a result that arrives after collapse does not surface');

  rerender(<Harness source={source} mediaItemId={7} enabled />);
  await waitFor(() => {
    assert.equal(resultText(), 'Title');
  });
  assert.equal(gathers, 1, 'the late result was cached, so reopening did not gather again');
});
