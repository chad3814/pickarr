import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { NzbDownloadSyncRead, RssItemSyncRead, TorrentDownloadSyncRead } from '@pickarr/contract';
import { useGatheredItem, type GatheredSource } from '../../src/library/useGatheredItem.ts';
import type { GatheredDownload, GatheredItem, GatheredRelease } from '../../src/store/gather.ts';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that threw before its own call would leave `Harness` mounted, and every
 * channel it holds -- its stub `subscribe`, and now the two stub
 * `subscribeInserts` -- still "registered".
 */
afterEach(cleanup);

/** A real timer, not fake ones -- fake timers hang this suite (`CLAUDE.md`). */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 15);
  });
}

/**
 * The two members the download-insert tests below drive, defaulted for every
 * test that does not: an insert subscription nothing ever fires, and a
 * replica holding no row. Spelled once here rather than in each stub, so a
 * test that cares overrides exactly the member it cares about and a reader
 * can tell the difference at a glance.
 */
const quietInserts = {
  subscribeInserts: (): (() => void) => () => {},
  getRows: async (): Promise<Map<number, unknown>> => new Map(),
};

/** An `RssItemSyncRead` with everything but `id` defaulted -- this suite reads none of the rest. */
function rssItem(id: number): RssItemSyncRead {
  return {
    id,
    feedId: 1,
    filename: `release-${String(id)}.mkv`,
    createdAt: 0,
    updatedAt: 0,
    downloadType: 'torrent',
    mediaItemId: null,
    rankingScore: null,
    lookupState: 'resolved',
    lookupStateDetail: null,
    lookupJson: null,
    deliveredAt: null,
  };
}

/** A `TorrentDownloadSyncRead` as the replica holds it -- the row `getRows` answers with below. */
function torrentRow(id: number, rssItemId: number): TorrentDownloadSyncRead {
  return {
    id,
    rssItemId,
    downloadClientId: 1,
    infohash: null,
    clientRef: null,
    status: 'queued',
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    percentage: null,
    absentSince: null,
    deliveredAt: null,
    reclaimedAt: null,
  };
}

/** The torrent shape minus `infohash`, which an nzb has no equivalent of. */
function nzbRow(id: number, rssItemId: number): NzbDownloadSyncRead {
  return {
    id,
    rssItemId,
    downloadClientId: 1,
    clientRef: null,
    status: 'queued',
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    percentage: null,
    absentSince: null,
    deliveredAt: null,
    reclaimedAt: null,
  };
}

function release(id: number, downloads: readonly GatheredDownload[]): GatheredRelease {
  return { id, row: rssItem(id), downloads };
}

/** A bare `GatheredItem` naming only what this suite reads back: the title, and its releases' downloads. */
function stubItem(id: number, title: string, releases: readonly GatheredRelease[] = []): GatheredItem {
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
    releases,
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
  return (
    <>
      <div data-testid="result">{gathered === undefined ? 'none' : gathered.mediaItem.title}</div>
      <div data-testid="downloads">
        {(gathered?.releases ?? [])
          .flatMap((each) => each.downloads)
          .map((download) => `${download.table}:${String(download.id)}`)
          .join(',')}
      </div>
    </>
  );
}

function resultText(): string {
  return screen.getByTestId('result').textContent ?? '';
}

/** Every download the hook currently reports, as `table:id` -- what `ReleaseList` reads a status off. */
function downloadsText(): string {
  return screen.getByTestId('downloads').textContent ?? '';
}

test('a disabled hook never gathers, and reads as undefined', () => {
  let gathers = 0;
  const source: GatheredSource = {
    ...quietInserts,
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

test('enabling gathers once, and re-enabling shows the cached result and gathers again behind it', async () => {
  // **This test used to end `assert.equal(gathers, 1, 'reopening reused
  // the cache instead of gathering again')`**, which pinned the stale
  // read as desirable. Both subscriptions are torn down while collapsed,
  // so a download row replicating in during that window is not noticed,
  // and answering from the cache alone meant a re-expanded card rendered
  // a live `Pick` button for a release that already had a download. The
  // cache is kept and the pin is inverted: the cached title must still
  // appear (that is what the cache is for), and a gather must follow it.
  let gathers = 0;
  const source: GatheredSource = {
    ...quietInserts,
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
  assert.equal(gathers, 1, 'and collapsing itself gathers nothing');

  rerender(<Harness source={source} mediaItemId={7} enabled />);
  // No `waitFor` around this one: the cached title is rendered by the
  // effect that runs on re-enable, before any promise resolves, which is
  // the whole difference between a placeholder and an empty flash. A
  // `waitFor` here would also pass against a hook that only showed it
  // once the fresh gather landed.
  assert.equal(resultText(), 'Title', 'the cached result is shown at once');
  await waitFor(() => {
    assert.equal(gathers, 2, 'and a fresh gather runs behind it');
  });
});

test('a download that lands while a card is collapsed is visible when it reopens', async () => {
  // The case the pin above hid, written the way a browser meets it: a
  // release with no download is gathered and rendered, the card is
  // collapsed, the pick's row replicates in while nothing is listening,
  // and the card reopens. Before the re-gather this rendered the release
  // with no downloads indefinitely -- a live `Pick` button on a release
  // the host would refuse, and on a multi-client install a second real
  // download.
  //
  // `downloadsText` and not `resultText`: the title is identical either
  // way, so an assertion on it could not tell a stale gather from a fresh
  // one. The download list is the thing that changed.
  let gathers = 0;
  const source: GatheredSource = {
    ...quietInserts,
    gatherMediaItem: async (id: number) => {
      gathers += 1;
      return gathers === 1
        ? stubItem(id, 'Title', [release(3, [])])
        : stubItem(id, 'Title', [release(3, [{ table: 'torrent_download', id: 11, row: torrentRow(11, 3) }])]);
    },
    subscribe: () => () => {},
  };
  const { rerender } = render(<Harness source={source} mediaItemId={7} enabled />);
  await waitFor(() => {
    assert.equal(resultText(), 'Title');
  });
  assert.equal(downloadsText(), '', 'nothing is picked yet');

  // Collapsed: no subscription is listening, so the row that lands here
  // wakes nothing. Nothing is simulated -- the hook simply is not told.
  rerender(<Harness source={source} mediaItemId={7} enabled={false} />);

  rerender(<Harness source={source} mediaItemId={7} enabled />);

  await waitFor(() => {
    assert.equal(downloadsText(), 'torrent_download:11');
  });
});

test("a notification on the item's own row, while enabled, replaces the cached result with a fresh gather", async () => {
  let gathers = 0;
  let notify: (() => void) | undefined;
  let subscribedTable: string | undefined;
  let subscribedId: number | undefined;
  const source: GatheredSource = {
    ...quietInserts,
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
  assert.equal(
    subscribedTable,
    'media_item',
    "with nothing picked, the per-row channel names the media item and only it -- a download that does not exist yet has no id to name here, so it is caught through subscribeInserts instead",
  );
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
    ...quietInserts,
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
  // The cached late result is what puts the title on screen -- the second
  // gather this reopen also starts is still unresolved, since nothing has
  // called `resolveGather` for it, so the title can only have come from
  // the cache. That is the property this test is named for, and it is now
  // pinned by the second gather *not* having answered rather than by it
  // not having happened.
  assert.equal(gathers, 2, 'reopening re-gathers, and the cache is what renders until it lands');
});

/**
 * A source whose first gather finds release 3 with nothing picked and every
 * later one finds `arrival` under it -- the sequence a pick produces -- over
 * a replica in which `arrival`'s row is the only thing `getRows` answers
 * with -- an id it does not name is simply absent from the map, which is
 * `store/rows.ts`'s own contract for a tombstone or a row never
 * replicated. `fire` is the `subscribeInserts` callback the hook registered for
 * `table`, or `undefined` if it registered none, so a test can tell a
 * subscription that did not fire from one that was never made.
 */
function pickHarness(
  arrival: GatheredDownload,
  storedRow: unknown,
): {
  source: GatheredSource;
  gathers: () => number;
  fire: (table: string, ids: readonly number[]) => void;
} {
  let gathers = 0;
  const callbacks = new Map<string, (ids: readonly number[]) => void>();
  const source: GatheredSource = {
    gatherMediaItem: async (id: number) => {
      gathers += 1;
      return stubItem(id, 'Title', [release(3, gathers === 1 ? [] : [arrival])]);
    },
    subscribe: () => () => {},
    subscribeInserts: (table: string, cb: (ids: readonly number[]) => void) => {
      callbacks.set(table, cb);
      return () => {
        callbacks.delete(table);
      };
    },
    getRows: async (table: string, ids: readonly number[]) =>
      new Map(
        ids.flatMap((id): [number, unknown][] =>
          table === arrival.table && id === arrival.id ? [[id, storedRow]] : [],
        ),
      ),
  };
  return {
    source,
    gathers: () => gathers,
    fire: (table, ids) => {
      const cb = callbacks.get(table);
      assert.ok(cb !== undefined, `nothing is subscribed to ${table} inserts`);
      cb(ids);
    },
  };
}

test("a torrent_download insert for one of this item's releases re-gathers, and the new download appears", async () => {
  const row = torrentRow(11, 3);
  const { source, gathers, fire } = pickHarness({ table: 'torrent_download', id: 11, row }, row);
  render(<Harness source={source} mediaItemId={7} enabled />);
  await waitFor(() => {
    assert.equal(resultText(), 'Title');
  });
  assert.equal(downloadsText(), '', 'nobody has picked this release yet');

  fire('torrent_download', [11]);
  await waitFor(() => {
    assert.equal(downloadsText(), 'torrent_download:11');
  });
  assert.equal(gathers(), 2, 'the insert drove a fresh gather off the replica, not a refetch');
});

test("an nzb_download insert for one of this item's releases re-gathers, and the new download appears", async () => {
  const row = nzbRow(12, 3);
  const { source, gathers, fire } = pickHarness({ table: 'nzb_download', id: 12, row }, row);
  render(<Harness source={source} mediaItemId={7} enabled />);
  await waitFor(() => {
    assert.equal(resultText(), 'Title');
  });
  assert.equal(downloadsText(), '');

  fire('nzb_download', [12]);
  await waitFor(() => {
    assert.equal(downloadsText(), 'nzb_download:12');
  });
  assert.equal(gathers(), 2, 'the nzb table is watched too, not only the torrent one');
});

test("a download insert for another media item's release does not re-gather", async () => {
  // Without the filter this hook would re-gather on every download inserted
  // anywhere in the replica, on every mounted card, on all three browse
  // screens. The inserted row here names release 999, which this item does
  // not hold.
  const row = torrentRow(11, 999);
  const { source, gathers, fire } = pickHarness({ table: 'torrent_download', id: 11, row }, row);
  render(<Harness source={source} mediaItemId={7} enabled />);
  await waitFor(() => {
    assert.equal(resultText(), 'Title');
  });
  assert.equal(gathers(), 1);

  fire('torrent_download', [11]);
  await settle();
  assert.equal(gathers(), 1, 'a stranger’s download woke nothing');
  assert.equal(downloadsText(), '', 'and nothing of theirs was shown under this item');
});

test('unmounting takes down the download insert subscriptions as well as the row one', async () => {
  // A subscription that survives unmount is how the store gets touched after
  // it closes -- the race `isStoreClosed` exists for, and one this hook
  // should not be creating more of.
  const live = new Set<string>();
  const source: GatheredSource = {
    gatherMediaItem: async (id: number) => stubItem(id, 'Title'),
    subscribe: (table: string, id: number) => {
      const key = `${table}:${String(id)}`;
      live.add(key);
      return () => {
        live.delete(key);
      };
    },
    subscribeInserts: (table: string) => {
      const key = `inserts:${table}`;
      live.add(key);
      return () => {
        live.delete(key);
      };
    },
    getRows: async () => new Map(),
  };
  const { unmount } = render(<Harness source={source} mediaItemId={7} enabled />);
  await waitFor(() => {
    assert.equal(resultText(), 'Title');
  });
  assert.deepEqual(
    [...live].toSorted(),
    ['inserts:nzb_download', 'inserts:torrent_download', 'media_item:7'],
    'all three channels are up while the card is open',
  );

  unmount();
  assert.deepEqual([...live], [], 'and all three are down again, leaving nothing to touch a closed store');
});

/**
 * A source whose every gather finds release 3 with torrent 11 under it, at
 * the status and percentage `states` holds for that gather -- the sequence
 * a download's progress produces. `subscribe` records every per-row
 * listener by `table:id`, so a test can fire one exactly as `store/notify.ts`
 * would for an update, and can see which rows are watched.
 */
function progressHarness(states: readonly { status: string; percentage: number | null }[]): {
  source: GatheredSource;
  gathers: () => number;
  live: () => string[];
  fire: (key: string) => void;
} {
  let gathers = 0;
  const listeners = new Map<string, Set<() => void>>();
  const source: GatheredSource = {
    ...quietInserts,
    gatherMediaItem: async (id: number) => {
      const state = states[Math.min(gathers, states.length - 1)];
      gathers += 1;
      assert.ok(state !== undefined);
      const row = { ...torrentRow(11, 3), ...state };
      return stubItem(id, 'Title', [release(3, [{ table: 'torrent_download', id: 11, row }])]);
    },
    subscribe: (table: string, id: number, cb: () => void) => {
      const key = `${table}:${String(id)}`;
      let set = listeners.get(key);
      if (set === undefined) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(cb);
      return () => {
        listeners.get(key)?.delete(cb);
        if (listeners.get(key)?.size === 0) listeners.delete(key);
      };
    },
  };
  return {
    source,
    gathers: () => gathers,
    live: () => [...listeners.keys()].toSorted(),
    fire: (key) => {
      const set = listeners.get(key);
      assert.ok(set !== undefined, `nothing is subscribed to ${key}`);
      for (const cb of set) cb();
    },
  };
}

function ProgressHarness({ source }: { source: GatheredSource }): ReactElement {
  const gathered = useGatheredItem(source, 7, true);
  return (
    <div data-testid="progress">
      {(gathered?.releases ?? [])
        .flatMap((each) => each.downloads)
        .map((download) => `${download.row.status}:${String(download.row.percentage)}`)
        .join(',')}
    </div>
  );
}

test("an update to a download this item already shows re-gathers, so its progress moves", async () => {
  // The defect: `subscribeInserts` fires only for a row that *became*
  // visible, so once a pick's row had arrived nothing re-gathered on its
  // progress, and the card sat at its first percentage until collapsed and
  // reopened.
  const { source, gathers, fire } = progressHarness([
    { status: 'downloading', percentage: 10 },
    { status: 'downloading', percentage: 55 },
    { status: 'delivered', percentage: 55 },
  ]);
  render(<ProgressHarness source={source} />);
  await waitFor(() => {
    assert.equal(screen.getByTestId('progress').textContent, 'downloading:10');
  });

  fire('torrent_download:11');
  await waitFor(() => {
    assert.equal(screen.getByTestId('progress').textContent, 'downloading:55');
  });

  // And again: the subscription is re-made for the fresh gather, not left
  // pointing at the first one's closure.
  fire('torrent_download:11');
  await waitFor(() => {
    assert.equal(screen.getByTestId('progress').textContent, 'delivered:55');
  });
  assert.equal(gathers(), 3);
});

test('the per-download subscriptions follow the gather and come down on unmount', async () => {
  const { source, live } = progressHarness([{ status: 'downloading', percentage: 10 }]);
  const { unmount } = render(<ProgressHarness source={source} />);
  await waitFor(() => {
    assert.deepEqual(live(), ['media_item:7', 'torrent_download:11']);
  });
  unmount();
  assert.deepEqual(live(), [], 'nothing is left subscribed once the card is gone');
});
