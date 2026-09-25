import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type {
  MediaItemSyncRead,
  NzbDownloadSyncRead,
  RssItemSyncRead,
  TorrentDownloadSyncRead,
} from '@pickarr/contract';
import { MediaItemCard } from '../../src/library/MediaItemCard.tsx';
import type { PickSubmit } from '../../src/library/postPick.ts';
import type { GatheredSource } from '../../src/library/useGatheredItem.ts';
import type { GatheredDownload, GatheredItem, GatheredRelease } from '../../src/store/gather.ts';
import type { PluginRows } from '@pickarr/plugin-ui';

/**
 * What `library/Category.tsx` hands a card whose plugin declared no tables.
 * The plugin's card then renders `item.title`, with no headline built from
 * anything.
 *
 * `MediaItemCard` does not read `rows` itself -- it forwards them to the
 * plugin's `Card` -- so the only test here that seeds any is the TV
 * headline one below; the rule that builds the headline is pinned against
 * literals in `packages/plugin-tv/test/headline.test.ts`.
 */
const NO_ROWS: PluginRows = {};

/**
 * A `tv_release` row as `plugin-tv`'s card narrows it (`TvRead`'s
 * `seriesTitle`, `seasonNumber` and `episodeNumber`), under the table name
 * `tvBrowser.tables` declares.
 */
function tvRows(row: { seriesTitle: string; seasonNumber: number | null; episodeNumber: number | null }): PluginRows {
  return { tv_release: [row] };
}

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that threw before its own call would leave a card mounted, still
 * subscribed to `media_item` through its stub `subscribe` and to both
 * download tables through its stub `subscribeInserts`.
 */
afterEach(cleanup);

/** A `MediaItemSyncRead` with everything but `id` and `title` defaulted -- this suite never reads the rest. */
function summary({ id, title }: { id: number; title: string }): MediaItemSyncRead {
  return {
    id,
    pluginId: 'tv',
    createdAt: 0,
    updatedAt: 0,
    provider: null,
    providerRef: null,
    title,
    releaseDate: null,
    description: null,
  };
}

/** An `RssItemSyncRead` with everything but `id`, `filename` and `resolution` defaulted. */
function rssItem({ id, filename, resolution }: { id: number; filename: string; resolution: string }): RssItemSyncRead {
  return {
    id,
    feedId: 1,
    filename,
    createdAt: 0,
    updatedAt: 0,
    downloadType: 'torrent',
    mediaItemId: null,
    rankingScore: null,
    resolution,
    resolutionDetail: null,
    lookupJson: null,
    deliveredAt: null,
  };
}

/** A `TorrentDownloadSyncRead` with everything but `rssItemId`, `status` and `percentage` defaulted. */
function torrent({
  rssItemId,
  id = rssItemId,
  status,
  percentage,
}: {
  rssItemId: number;
  id?: number;
  status: string;
  percentage: number | null;
}): TorrentDownloadSyncRead {
  return {
    id,
    rssItemId,
    downloadClientId: 1,
    infohash: null,
    clientRef: null,
    status,
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    percentage,
    absentSince: null,
    deliveredAt: null,
    reclaimedAt: null,
  };
}

/**
 * A download built for `gathered()`'s shorthand: `kind` names which of the
 * two host tables the row belongs to, matched to the row type it carries so
 * a `torrent` row can never be tagged `nzb` or vice versa.
 */
type DownloadInput =
  | { kind: 'torrent'; row: TorrentDownloadSyncRead }
  | { kind: 'nzb'; row: NzbDownloadSyncRead };

function toGatheredDownload(input: DownloadInput): GatheredDownload {
  return input.kind === 'torrent'
    ? { table: 'torrent_download', id: input.row.id, row: input.row }
    : { table: 'nzb_download', id: input.row.id, row: input.row };
}

interface ReleaseInput {
  id: number;
  row: RssItemSyncRead;
  downloads?: readonly DownloadInput[];
}

/** A `GatheredItem` for one media item, with `releases` defaulting to none -- the normal case for a release nobody has picked, per `ReleaseList.tsx`'s own doc. */
function gathered({
  id,
  title,
  releases = [],
}: {
  id: number;
  title: string;
  releases?: readonly ReleaseInput[];
}): GatheredItem {
  const mediaItem = summary({ id, title });
  const mappedReleases: GatheredRelease[] = releases.map((release) => ({
    id: release.id,
    row: release.row,
    downloads: (release.downloads ?? []).map(toGatheredDownload),
  }));
  return {
    mediaItem,
    pluginId: mediaItem.pluginId,
    releases: mappedReleases,
    roles: [],
    artwork: {
      poster: `/api/artwork/poster/${String(id)}`,
      background: `/api/artwork/background/${String(id)}`,
      logo: `/api/artwork/logo/${String(id)}`,
    },
    feedIds: [...new Set(mappedReleases.map((release) => release.row.feedId))].toSorted((a, b) => a - b),
  };
}

/**
 * `useGatheredItem`'s two download-insert members, defaulted: no card in
 * this file exercises a pick arriving, so an insert subscription nothing
 * fires and a replica holding no row are what they should see. That hook's
 * own test file drives both properly.
 */
const quietInserts = {
  subscribeInserts: (): (() => void) => () => {},
  getRows: async (): Promise<Map<number, unknown>> => new Map(),
};

/**
 * A `submit` that accepts, for the cards in this file that are not about
 * picking. Spelled at every call site rather than defaulted inside the
 * component: a default that performed network I/O would give a test that
 * forgot the prop a real `fetch` under jsdom (`ReleaseList.tsx`'s doc).
 */
const acceptsPick: PickSubmit = () => Promise.resolve({ accepted: true });

/** A `GatheredSource` returning one bare gathered item, for tests that do not care what expanding shows. */
const stubSource: GatheredSource = {
  ...quietInserts,
  gatherMediaItem: async (id: number) => gathered({ id, title: 'The Thing' }),
  subscribe: () => () => {},
};

test('a card shows its title as a real heading', () => {
  // CLAUDE.md's longest hazard: the accessible name must come from a visible
  // heading, not an aria-label, or a query passes against an unstyled block.
  render(<MediaItemCard source={stubSource} item={summary({ id: 7, title: 'The Thing' })} rows={NO_ROWS} submit={acceptsPick} />);
  const heading = screen.getByRole('heading', { name: 'The Thing' });
  assert.equal(heading.textContent, 'The Thing');
});

test('a card gathers nothing until it is opened, and opening it gathers once', async () => {
  let gathers = 0;
  const source: GatheredSource = {
    ...quietInserts,
    gatherMediaItem: async (id: number) => {
      gathers += 1;
      return gathered({ id, title: 'The Thing' });
    },
    subscribe: () => () => {},
  };
  render(<MediaItemCard source={source} item={summary({ id: 7, title: 'The Thing' })} rows={NO_ROWS} submit={acceptsPick} />);
  assert.equal(gathers, 0, 'an unopened card costs nothing');

  fireEvent.click(screen.getByRole('button', { name: /The Thing/ }));
  await waitFor(() => {
    assert.ok(screen.getByRole('list', { name: /releases/i }));
  });
  assert.equal(gathers, 1);
});

test('closing a card tears its subscriptions down, and reopening gathers again behind the cache', async () => {
  // **The behaviour `CardProps.onExpandedChange` exists to make possible.**
  // The seam first shipped with only an `onExpand`, so web could not learn
  // a card had closed and passed `useGatheredItem` a latch instead. Fix
  // round 1's review measured what that cost -- 72 live subscriptions for
  // 24 cards opened and closed again, and 24 IndexedDB transactions for one
  // `torrent_download` insert with nothing open on screen -- and the seam
  // gained a collapse signal. This is the original pre-seam behaviour,
  // restored: the count of 2 is the review-mandated re-gather (I2), because
  // a download row landing while the card was collapsed was not watched for
  // and must not be answered from the cache alone.
  //
  // The teardown is asserted directly, not inferred from the count: a
  // gather count of 2 would also be produced by a card that re-gathered
  // while *keeping* its subscriptions, which is the regression this pins
  // shut.
  let gathers = 0;
  let liveSubscriptions = 0;
  const source: GatheredSource = {
    ...quietInserts,
    subscribeInserts: () => {
      liveSubscriptions += 1;
      return () => {
        liveSubscriptions -= 1;
      };
    },
    gatherMediaItem: async (id: number) => {
      gathers += 1;
      return gathered({ id, title: 'The Thing' });
    },
    subscribe: () => {
      liveSubscriptions += 1;
      return () => {
        liveSubscriptions -= 1;
      };
    },
  };
  render(<MediaItemCard source={source} item={summary({ id: 7, title: 'The Thing' })} rows={NO_ROWS} submit={acceptsPick} />);
  assert.equal(liveSubscriptions, 0, 'a card nobody has opened watches nothing');

  fireEvent.click(screen.getByRole('button', { name: /The Thing/ }));
  await waitFor(() => {
    assert.ok(screen.getByRole('list', { name: /releases/i }));
  });
  assert.equal(gathers, 1);
  // One on `media_item`, one per download table (`useGatheredItem`'s own
  // `DOWNLOAD_TABLES`, which holds two).
  assert.equal(liveSubscriptions, 3, 'an open card watches its own row and both download tables');

  // `{ expanded: true }`, not just the name: `MediaDetails` now renders a
  // poster `<button>` whose accessible name is also "The Thing" (from its
  // `<img alt>`), so a bare name match resolves to two buttons once the
  // gather has landed. `aria-expanded` is unique to the toggle `CardHeading`
  // owns.
  fireEvent.click(screen.getByRole('button', { name: /The Thing/, expanded: true }));
  assert.ok(!screen.queryByRole('list', { name: /releases/i }), 'the card is closed again');
  assert.equal(gathers, 1, 'collapsing gathers nothing');
  assert.equal(liveSubscriptions, 0, 'and the close tore every subscription down, which the latch could not');

  fireEvent.click(screen.getByRole('button', { name: /The Thing/ }));
  await waitFor(() => {
    assert.ok(screen.getByRole('list', { name: /releases/i }));
  });
  assert.equal(gathers, 2, 'reopening re-gathers behind the cache, since the collapsed window was unwatched');
  assert.equal(liveSubscriptions, 3, 'and watches again');
});

test("a TV item's card is the tv plugin's, and its headline names the series and the episode", async () => {
  // Design spec acceptance 1, at the seam web owns. The registry is what
  // turns `item.pluginId` into a card; until it was wired, every row
  // rendered `item.title` no matter which plugin wrote it, which is the
  // defect the whole slice exists to fix. The headline *rule* is
  // `plugin-tv`'s and is pinned there -- what this asserts is that web
  // reached that card at all and handed it the rows it was given.
  render(
    <MediaItemCard
      source={stubSource}
      item={summary({ id: 7, title: "Dio's World(3)" })}
      rows={tvRows({ seriesTitle: "Jo Jo's Bizarre Adventure", seasonNumber: 2, episodeNumber: 47 })}
      submit={acceptsPick}
    />,
  );

  const heading = await screen.findByRole('heading', {
    name: "Jo Jo's Bizarre Adventure S02E47 Dio's World(3)",
  });
  assert.equal(heading.textContent, "Jo Jo's Bizarre Adventure S02E47 Dio's World(3)");
});

test('an item whose plugin this build does not carry still shows its poster and its title', () => {
  // **A defensive branch, pinned as one**, and the fixture below says so:
  // `pluginId: 'book'` is a value no screen in this build can deliver.
  // `Category` gets its `pluginId` from the registry and `useMediaItems`
  // lists through a key range scoped to that one id, so every item reaching
  // `MediaItemCard` in the app carries a registered id -- `MediaItemCard`'s
  // own comment on the branch has the full call graph. An earlier version
  // of this comment claimed the branch was reachable; it is not.
  //
  // What it is worth pinning anyway is that rendering a card stays a total
  // function over replica data. A `media_item` row's `pluginId` comes from
  // IndexedDB, which persists across client builds and was written by
  // whatever plugins the host had registered, so the value is of open range
  // even though no current caller can widen it past the registry. Throwing
  // would take the whole paged list down; rendering nothing would leave a
  // poster with no name under it.
  const item: MediaItemSyncRead = { ...summary({ id: 7, title: 'The Thing' }), pluginId: 'book' };
  render(<MediaItemCard source={stubSource} item={item} rows={NO_ROWS} submit={acceptsPick} />);

  assert.ok(screen.getByRole('heading', { name: 'The Thing' }), 'the row is still identifiable');
  assert.ok(screen.getByRole('img', { name: 'The Thing' }), 'and web still renders the poster it owns');
  assert.ok(!screen.queryByRole('button'), 'with no expander, because there is no card body to expand into');
});

test('a release shows its resolution and its download status', async () => {
  const source: GatheredSource = {
    ...quietInserts,
    gatherMediaItem: async () =>
      gathered({
        id: 7,
        title: 'The Thing',
        releases: [
          {
            id: 3,
            row: rssItem({ id: 3, filename: 'the.thing.2160p.mkv', resolution: '2160p' }),
            downloads: [{ kind: 'torrent', row: torrent({ rssItemId: 3, status: 'downloading', percentage: 42 }) }],
          },
        ],
      }),
    subscribe: () => () => {},
  };
  render(<MediaItemCard source={source} item={summary({ id: 7, title: 'The Thing' })} rows={NO_ROWS} submit={acceptsPick} />);
  fireEvent.click(screen.getByRole('button', { name: /The Thing/ }));

  const release = await screen.findByRole('listitem', { name: /the.thing.2160p.mkv/ });
  assert.ok(release.textContent?.includes('2160p'), 'the resolution is shown');
  assert.ok(release.textContent?.includes('downloading'), 'and the download status');
  assert.ok(release.textContent?.includes('42'), 'and how far along it is');
});

test('a release with no download row shows no status rather than a blank one', async () => {
  // A release nobody has picked has no torrent_download or nzb_download row
  // at all. That must read as "not picked", not as an empty status field --
  // this slice cannot pick, so every release starts here.
  const source: GatheredSource = {
    ...quietInserts,
    gatherMediaItem: async () =>
      gathered({
        id: 7,
        title: 'The Thing',
        releases: [{ id: 3, row: rssItem({ id: 3, filename: 'the.thing.1080p.mkv', resolution: '1080p' }), downloads: [] }],
      }),
    subscribe: () => () => {},
  };
  render(<MediaItemCard source={source} item={summary({ id: 7, title: 'The Thing' })} rows={NO_ROWS} submit={acceptsPick} />);
  fireEvent.click(screen.getByRole('button', { name: /The Thing/ }));

  const release = await screen.findByRole('listitem', { name: /the.thing.1080p.mkv/ });
  assert.ok(release.textContent?.includes('1080p'));
  assert.ok(!/status/i.test(release.textContent ?? ''), 'no status label with nothing to put in it');
});

test('a card whose artwork 404s still renders', () => {
  // Artwork is not replicated: the client asks `/api/artwork/:kind/:id` and
  // handles a 404 (host `sync/tables.ts`). Most items will have no poster for
  // a while, so a missing one must not blank the card.
  render(<MediaItemCard source={stubSource} item={summary({ id: 7, title: 'The Thing' })} rows={NO_ROWS} submit={acceptsPick} />);
  const image = screen.getByRole('img', { name: /The Thing/ });
  fireEvent.error(image);
  assert.ok(screen.getByRole('heading', { name: 'The Thing' }), 'the card survives its poster failing');
  // Review round 1: the heading assertion above holds whether or not the
  // image is ever removed, since the heading is never conditioned on it --
  // deleting `onError`/`posterFailed` outright left every test green. This
  // observes what the handling actually does: the failed `<img>` comes out
  // of the DOM rather than sitting there broken. A boolean comparison, never
  // `assert.equal(image, ...)` against the live node itself (`CLAUDE.md`).
  assert.ok(screen.queryByRole('img', { name: /The Thing/ }) === null, 'the failed poster is removed, not left broken');
});

test('the submit a card is handed is the one its Pick button calls', async () => {
  // `Shell` wires `postPick` and `Category` forwards it; neither calls it,
  // and nor does this component. A card that dropped the prop on the floor
  // would still render, still expand and still show a button -- so the only
  // thing that pins the wire is pressing the button and seeing which release
  // the injected `submit` was asked for (`CLAUDE.md`: pinning a function
  // does not pin that anyone calls it).
  const asked: number[] = [];
  const source: GatheredSource = {
    ...quietInserts,
    gatherMediaItem: async (id: number) =>
      gathered({
        id,
        title: 'The Thing',
        releases: [{ id: 31, row: rssItem({ id: 31, filename: 'the.thing.mkv', resolution: '1080p' }) }],
      }),
    subscribe: () => () => {},
  };
  render(
    <MediaItemCard
      source={source}
      item={summary({ id: 7, title: 'The Thing' })}
      rows={NO_ROWS}
      submit={(rssItemId) => {
        asked.push(rssItemId);
        return Promise.resolve({ accepted: true });
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'The Thing' }));

  const row = await screen.findByRole('listitem', { name: 'the.thing.mkv' });
  fireEvent.click(within(row).getByRole('button'));

  await waitFor(() => {
    assert.deepEqual(asked, [31], 'the release the operator pressed, through the submit the card was given');
  });
});
