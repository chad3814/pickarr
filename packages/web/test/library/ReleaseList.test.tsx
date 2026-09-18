import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup } from '@testing-library/react';
import type { NzbDownloadSyncRead, RssItemSyncRead, TorrentDownloadSyncRead } from '@pickarr/contract';
import { ReleaseList } from '../../src/library/ReleaseList.tsx';
import type { GatheredDownload, GatheredRelease } from '../../src/store/gather.ts';

afterEach(cleanup);

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

/** A `TorrentDownloadSyncRead` with everything but `id`, `status` and `percentage` defaulted. */
function torrent({
  id,
  status,
  percentage,
}: {
  id: number;
  status: string;
  percentage: number | null;
}): TorrentDownloadSyncRead {
  return {
    id,
    rssItemId: id,
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

/** An `NzbDownloadSyncRead` with everything but `id` and `status` defaulted. */
function nzb({ id, status }: { id: number; status: string }): NzbDownloadSyncRead {
  return {
    id,
    rssItemId: id,
    downloadClientId: 1,
    clientRef: null,
    status,
    attempts: 0,
    createdAt: 0,
    updatedAt: 0,
    percentage: null,
    absentSince: null,
    deliveredAt: null,
    reclaimedAt: null,
  };
}

function torrentDownload(row: TorrentDownloadSyncRead): GatheredDownload {
  return { table: 'torrent_download', id: row.id, row };
}

function nzbDownload(row: NzbDownloadSyncRead): GatheredDownload {
  return { table: 'nzb_download', id: row.id, row };
}

test('no releases still renders a releases list, with nothing inside it', () => {
  render(<ReleaseList releases={[]} />);
  assert.ok(screen.getByRole('list', { name: /releases/i }));
  assert.equal(screen.queryAllByRole('listitem').length, 0, 'no releases means no rows');
});

test('a release with a download shows its filename, resolution and download status', () => {
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.2160p.mkv', resolution: '2160p' }),
    downloads: [torrentDownload(torrent({ id: 9, status: 'downloading', percentage: 42 }))],
  };
  render(<ReleaseList releases={[release]} />);

  const item = screen.getByRole('listitem', { name: /the.thing.2160p.mkv/ });
  assert.ok(item.textContent?.includes('2160p'), 'the resolution is shown');
  assert.ok(item.textContent?.includes('downloading'), 'and the download status');
  assert.ok(item.textContent?.includes('42'), 'and how far along it is');
});

test('a release with no downloads shows no status label at all', () => {
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.1080p.mkv', resolution: '1080p' }),
    downloads: [],
  };
  render(<ReleaseList releases={[release]} />);

  const item = screen.getByRole('listitem', { name: /the.thing.1080p.mkv/ });
  assert.ok(item.textContent?.includes('1080p'));
  assert.ok(!/status/i.test(item.textContent ?? ''), 'no status label with nothing to put in it');
});

test('a release with a torrent and an nzb download shows both statuses', () => {
  // Two downloads for one release is not this slice's normal case, but
  // `GatheredRelease.downloads` is an array and nothing in `gatherMediaItem`
  // rules it out -- each download's own table+id keys its row (`downloadKey`
  // in `ReleaseList.tsx`), which this pins directly.
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.mkv', resolution: '1080p' }),
    downloads: [
      torrentDownload(torrent({ id: 9, status: 'downloading', percentage: 42 })),
      nzbDownload(nzb({ id: 11, status: 'queued' })),
    ],
  };
  render(<ReleaseList releases={[release]} />);

  const item = screen.getByRole('listitem', { name: /the.thing.mkv/ });
  assert.ok(item.textContent?.includes('downloading'), 'the torrent status is shown');
  assert.ok(item.textContent?.includes('queued'), 'and the nzb status alongside it');
});

test('a release with a download but no percentage shows the status without one', () => {
  const release: GatheredRelease = {
    id: 3,
    row: rssItem({ id: 3, filename: 'the.thing.720p.mkv', resolution: '720p' }),
    downloads: [torrentDownload(torrent({ id: 9, status: 'queued', percentage: null }))],
  };
  render(<ReleaseList releases={[release]} />);

  const item = screen.getByRole('listitem', { name: /the.thing.720p.mkv/ });
  assert.ok(item.textContent?.includes('queued'));
  assert.ok(!item.textContent?.includes('%'), 'nothing to show when the download carries no percentage');
});
