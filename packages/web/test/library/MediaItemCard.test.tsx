import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type {
  MediaItemSyncRead,
  NzbDownloadSyncRead,
  RssItemSyncRead,
  TorrentDownloadSyncRead,
} from '@pickarr/contract';
import { MediaItemCard } from '../../src/library/MediaItemCard.tsx';
import type { GatheredSource } from '../../src/library/useGatheredItem.ts';
import type { GatheredDownload, GatheredItem, GatheredRelease } from '../../src/store/gather.ts';

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
  getRow: async (): Promise<unknown> => undefined,
};

/** A `GatheredSource` returning one bare gathered item, for tests that do not care what expanding shows. */
const stubSource: GatheredSource = {
  ...quietInserts,
  gatherMediaItem: async (id: number) => gathered({ id, title: 'The Thing' }),
  subscribe: () => () => {},
};

test('a card shows its title as a real heading', () => {
  // CLAUDE.md's longest hazard: the accessible name must come from a visible
  // heading, not an aria-label, or a query passes against an unstyled block.
  render(<MediaItemCard source={stubSource} item={summary({ id: 7, title: 'The Thing' })} />);
  const heading = screen.getByRole('heading', { name: 'The Thing' });
  assert.equal(heading.textContent, 'The Thing');
});

test('expanding gathers the item once, and collapsing does not re-gather', async () => {
  let gathers = 0;
  const source: GatheredSource = {
    ...quietInserts,
    gatherMediaItem: async (id: number) => {
      gathers += 1;
      return gathered({ id, title: 'The Thing' });
    },
    subscribe: () => () => {},
  };
  render(<MediaItemCard source={source} item={summary({ id: 7, title: 'The Thing' })} />);
  assert.equal(gathers, 0, 'a collapsed card costs nothing');

  fireEvent.click(screen.getByRole('button', { name: /The Thing/ }));
  await waitFor(() => {
    assert.ok(screen.getByRole('list', { name: /releases/i }));
  });
  assert.equal(gathers, 1);

  fireEvent.click(screen.getByRole('button', { name: /The Thing/ }));
  fireEvent.click(screen.getByRole('button', { name: /The Thing/ }));
  await waitFor(() => {
    assert.ok(screen.getByRole('list', { name: /releases/i }));
  });
  assert.equal(gathers, 1, 'reopening reuses what was already gathered');
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
  render(<MediaItemCard source={source} item={summary({ id: 7, title: 'The Thing' })} />);
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
  render(<MediaItemCard source={source} item={summary({ id: 7, title: 'The Thing' })} />);
  fireEvent.click(screen.getByRole('button', { name: /The Thing/ }));

  const release = await screen.findByRole('listitem', { name: /the.thing.1080p.mkv/ });
  assert.ok(release.textContent?.includes('1080p'));
  assert.ok(!/status/i.test(release.textContent ?? ''), 'no status label with nothing to put in it');
});

test('a card whose artwork 404s still renders', () => {
  // Artwork is not replicated: the client asks `/api/artwork/:kind/:id` and
  // handles a 404 (host `sync/tables.ts`). Most items will have no poster for
  // a while, so a missing one must not blank the card.
  render(<MediaItemCard source={stubSource} item={summary({ id: 7, title: 'The Thing' })} />);
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
