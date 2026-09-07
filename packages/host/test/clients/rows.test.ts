import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import {
  advanceStatus,
  failRow,
  markDelivered,
  rowByRef,
  rowsForClient,
  setAbsent,
  setProgress,
  setRef,
  setStoragePath,
} from '../../src/clients/rows.ts';
import type { DownloadRow } from '../../src/clients/rows.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/** Inserts one `download_client` row and returns its id. Mirrors `downloads.test.ts`'s own `seedClient`. */
function seedClient(raw: DatabaseSync, overrides: { name?: string; type?: string } = {}): number {
  const row = { name: 'Client', type: 'torrent', ...overrides };
  raw.prepare(`
    INSERT INTO download_client
      (name, type, implementation, url, api_key, username, password, category, import_mode, created_at, updated_at)
    VALUES (?, ?, 'qbittorrent', 'https://client.example.com', 'key', NULL, NULL, 'movies', 'copy', 1, 1)
  `).run(row.name, row.type);
  const inserted = raw.prepare('SELECT id FROM download_client WHERE name = ?').get(row.name);
  return Number((inserted as { id: unknown }).id);
}

/**
 * Inserts one `rss_feed` and one `rss_item` row and returns the item's id --
 * the foreign keys both download tables require. Mirrors `migrate.test.ts`'s
 * own `seedDownloadTarget`, which is private to that file.
 */
function seedRssItem(raw: DatabaseSync, name: string): number {
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES ('alpha', ?, ?, 1, 1)
  `).run(name, `https://example.test/${name}`);
  const feedId = Number((raw.prepare('SELECT id FROM rss_feed WHERE name = ?').get(name) as { id: unknown }).id);
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (?, ?, ?, 1, 1, 'torrent', '1080p')
  `).run(feedId, `${name}.mkv`, `https://example.test/${name}.mkv`);
  return Number(result.lastInsertRowid);
}

/** Inserts one `torrent_download` row and returns its id. */
function insertTorrentRow(
  raw: DatabaseSync,
  params: { rssItemId: number; downloadClientId: number; clientRef?: string | null; status?: string },
): number {
  const status = params.status ?? 'submitting';
  const result = raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, client_ref, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1)
  `).run(params.rssItemId, params.downloadClientId, params.clientRef ?? null, status);
  return Number(result.lastInsertRowid);
}

/** Inserts one `nzb_download` row and returns its id. */
function insertNzbRow(
  raw: DatabaseSync,
  params: { rssItemId: number; downloadClientId: number; clientRef?: string | null; status?: string },
): number {
  const status = params.status ?? 'submitting';
  const result = raw.prepare(`
    INSERT INTO nzb_download (rss_item_id, download_client_id, client_ref, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1)
  `).run(params.rssItemId, params.downloadClientId, params.clientRef ?? null, status);
  return Number(result.lastInsertRowid);
}

/** Reads one raw column back off `table`, for assertions that must not trust the module under test. */
function readColumn(raw: DatabaseSync, table: 'torrent_download' | 'nzb_download', id: number, column: string): unknown {
  const row = raw.prepare(`SELECT ${column} FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
  return row[column];
}

test('a lookup is keyed on the client and the ref together, never the ref alone', () => {
  const raw = setup();
  const itemA = seedRssItem(raw, 'a');
  const itemB = seedRssItem(raw, 'b');
  const clientOne = seedClient(raw, { name: 'One' });
  const clientTwo = seedClient(raw, { name: 'Two' });
  insertTorrentRow(raw, { rssItemId: itemA, downloadClientId: clientOne, clientRef: 'shared-ref', status: 'submitted' });
  const rowOnTwoId = insertTorrentRow(
    raw, { rssItemId: itemB, downloadClientId: clientTwo, clientRef: 'shared-ref', status: 'submitted' },
  );

  const found = rowByRef(raw, clientTwo, 'shared-ref');

  assert.ok(found, 'expected a row on client two holding the shared ref');
  assert.deepEqual(
    { id: found.id, downloadClientId: found.downloadClientId },
    { id: rowOnTwoId, downloadClientId: clientTwo },
  );
});

test('an advance from the wrong state changes nothing and says so', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'submitted' });
  const row: DownloadRow = {
    id, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'submitted', storagePath: null, absentSince: null, deliveredAt: null,
  };

  const applied = advanceStatus(raw, row, 'downloading', 'completed', 500);

  assert.equal(applied, false);
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'submitted', 'the row must be unchanged');
  assert.equal(readColumn(raw, 'torrent_download', id, 'updated_at'), 1, 'updated_at must be unchanged too');
});

test('an advance from the expected state applies and says so', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'downloading' });
  const row: DownloadRow = {
    id, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'downloading', storagePath: null, absentSince: null, deliveredAt: null,
  };

  const applied = advanceStatus(raw, row, 'downloading', 'completed', 500);

  assert.equal(applied, true);
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'completed');
  assert.equal(readColumn(raw, 'torrent_download', id, 'updated_at'), 500);
});

test('recording progress does not move the status', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  // Deliberately not 'downloading': a `setProgress` that hard-coded a move to
  // 'downloading' would pass this test undetected if the row already started
  // there, so the row starts in a status `setProgress` has no business
  // writing at all.
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'submitted' });
  const row: DownloadRow = {
    id, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'submitted', storagePath: null, absentSince: null, deliveredAt: null,
  };

  setProgress(raw, row, 42, 500);

  assert.equal(readColumn(raw, 'torrent_download', id, 'percentage'), 42);
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'submitted', 'status must not have moved');
});

test('clearing absence writes null rather than leaving the stamp', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'downloading' });
  const row: DownloadRow = {
    id, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'downloading', storagePath: null, absentSince: null, deliveredAt: null,
  };

  setAbsent(raw, row, 900, 900);
  assert.equal(readColumn(raw, 'torrent_download', id, 'absent_since'), 900, 'setup: the row must read absent first');

  setAbsent(raw, row, null, 1200);

  assert.equal(readColumn(raw, 'torrent_download', id, 'absent_since'), null);
  // A clear is a change, so it moves `updated_at` exactly as a stamp does.
  // With the value and the clock folded into one argument, `updated_at`
  // would advance or not depending on which value was being written, and a
  // row that went absent and came back would report the stamp's time as the
  // last thing that happened to it.
  assert.equal(readColumn(raw, 'torrent_download', id, 'updated_at'), 1200);
});

test('a row from each table is advanced in its own table', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const torrentId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'downloading' });
  const nzbId = insertNzbRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'downloading' });
  // Both rows land on id 1 -- each table has its own autoincrement space --
  // which is exactly the case a table-name mixup would get wrong silently.
  assert.equal(torrentId, nzbId);

  const torrentRow: DownloadRow = {
    id: torrentId, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'downloading', storagePath: null, absentSince: null, deliveredAt: null,
  };

  const applied = advanceStatus(raw, torrentRow, 'downloading', 'completed', 500);

  assert.equal(applied, true);
  assert.equal(readColumn(raw, 'torrent_download', torrentId, 'status'), 'completed');
  assert.equal(readColumn(raw, 'nzb_download', nzbId, 'status'), 'downloading', 'the nzb row must be untouched');
});

test('setStoragePath records the client\'s path without moving the status', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'downloading' });
  const row: DownloadRow = {
    id, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'downloading', storagePath: null, absentSince: null, deliveredAt: null,
  };

  setStoragePath(raw, row, '/downloads/movie.mkv', 700);

  assert.equal(readColumn(raw, 'torrent_download', id, 'storage_path'), '/downloads/movie.mkv');
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'downloading');
});

test('markDelivered applies only from the status the row was read with, and reports which happened', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const staleId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'downloading' });
  const staleRow: DownloadRow = {
    id: staleId, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'completed', storagePath: null, absentSince: null, deliveredAt: null,
  };

  const staleApplied = markDelivered(raw, staleRow, 900);

  assert.equal(staleApplied, false, 'the row is actually downloading, not completed as staleRow believes');
  assert.equal(readColumn(raw, 'torrent_download', staleId, 'status'), 'downloading');
  assert.equal(readColumn(raw, 'torrent_download', staleId, 'delivered_at'), null);

  const freshId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'completed' });
  const freshRow: DownloadRow = {
    id: freshId, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'completed', storagePath: null, absentSince: null, deliveredAt: null,
  };

  const freshApplied = markDelivered(raw, freshRow, 900);

  assert.equal(freshApplied, true);
  assert.equal(readColumn(raw, 'torrent_download', freshId, 'status'), 'delivered');
  assert.equal(readColumn(raw, 'torrent_download', freshId, 'delivered_at'), 900);
});

test('failRow applies only from the status the row was read with, and reports which happened', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const staleId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'submitted' });
  const staleRow: DownloadRow = {
    id: staleId, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'downloading', storagePath: null, absentSince: null, deliveredAt: null,
  };

  const staleApplied = failRow(raw, staleRow, 'client unreachable', 900);

  assert.equal(staleApplied, false, 'the row is actually submitted, not downloading as staleRow believes');
  assert.equal(readColumn(raw, 'torrent_download', staleId, 'status'), 'submitted');
  assert.equal(readColumn(raw, 'torrent_download', staleId, 'last_error'), null);

  const freshRow: DownloadRow = {
    id: staleId, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'submitted', storagePath: null, absentSince: null, deliveredAt: null,
  };

  const freshApplied = failRow(raw, freshRow, 'client unreachable', 900);

  assert.equal(freshApplied, true);
  assert.equal(readColumn(raw, 'torrent_download', staleId, 'status'), 'failed');
  assert.equal(readColumn(raw, 'torrent_download', staleId, 'last_error'), 'client unreachable');
});

test('setRef applies only from the status the row was read with, and reports which happened', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'submitted' });
  const staleRow: DownloadRow = {
    id, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'submitting', storagePath: null, absentSince: null, deliveredAt: null,
  };

  const staleApplied = setRef(raw, staleRow, 'ref-1', 900);

  assert.equal(staleApplied, false, 'the row is actually submitted, not submitting as staleRow believes');
  assert.equal(readColumn(raw, 'torrent_download', id, 'client_ref'), null);

  const freshRow: DownloadRow = { ...staleRow, status: 'submitted' };
  const freshApplied = setRef(raw, freshRow, 'ref-1', 900);

  assert.equal(freshApplied, true);
  assert.equal(readColumn(raw, 'torrent_download', id, 'client_ref'), 'ref-1');
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'submitted', 'setRef must not move status');
});

test('rowsForClient reads rows from both tables, tagged with which table each came from', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const otherClientId = seedClient(raw, { name: 'Other' });
  const torrentId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'downloading' });
  const nzbId = insertNzbRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'submitted' });
  // A row on a different client must not show up in this client's list.
  insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: otherClientId, status: 'downloading' });

  const rows = rowsForClient(raw, clientId);

  assert.deepEqual(
    rows.map((row) => ({ id: row.id, table: row.table, status: row.status })).toSorted((a, b) => a.id - b.id),
    [
      { id: torrentId, table: 'torrent_download', status: 'downloading' },
      { id: nzbId, table: 'nzb_download', status: 'submitted' },
    ].toSorted((a, b) => a.id - b.id),
  );
});
