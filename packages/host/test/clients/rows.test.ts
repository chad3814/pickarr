import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import {
  advanceStatus,
  failRow,
  markDelivered,
  markReclaimed,
  rowByRef,
  rowsForClientByStatus,
  rowsForClientByStatusSql,
  setAbsent,
  setProgress,
  setRef,
  setStoragePath,
  unreclaimedRowsForClient,
  unreclaimedRowsForClientSql,
} from '../../src/clients/rows.ts';
import type { DownloadRow } from '../../src/clients/rows.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/**
 * Inserts one `download_client` row and returns its id. Mirrors
 * `downloads.test.ts`'s own `seedClient`, minus the credential: nothing in this
 * file reads the row through `readClientConfig`, and since migration 14 the
 * row would hold only a `secret` name, so a name here would be one nothing
 * ever resolves. `paths.test.ts` and `select.test.ts` seed the same way.
 */
function seedClient(raw: DatabaseSync, overrides: { name?: string; type?: string } = {}): number {
  const row = { name: 'Client', type: 'torrent', ...overrides };
  raw.prepare(`
    INSERT INTO download_client
      (name, type, implementation, url, api_key_secret_name, username, password_secret_name,
       category, import_mode, created_at, updated_at)
    VALUES (?, ?, 'qbittorrent', 'https://client.example.com', NULL, NULL, NULL, 'movies', 'copy', 1, 1)
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
  params: {
    rssItemId: number;
    downloadClientId: number;
    clientRef?: string | null;
    status?: string;
    reclaimedAt?: number | null;
  },
): number {
  const status = params.status ?? 'submitting';
  const result = raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, client_ref, status, reclaimed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1)
  `).run(params.rssItemId, params.downloadClientId, params.clientRef ?? null, status, params.reclaimedAt ?? null);
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
    clientRef: null, status: 'submitted', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
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
    clientRef: null, status: 'downloading', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
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
    clientRef: null, status: 'submitted', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
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
    clientRef: null, status: 'downloading', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
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
    clientRef: null, status: 'downloading', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
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
    clientRef: null, status: 'downloading', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
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
    clientRef: null, status: 'completed', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
  };

  const staleApplied = markDelivered(raw, staleRow, 900);

  assert.equal(staleApplied, false, 'the row is actually downloading, not completed as staleRow believes');
  assert.equal(readColumn(raw, 'torrent_download', staleId, 'status'), 'downloading');
  assert.equal(readColumn(raw, 'torrent_download', staleId, 'delivered_at'), null);

  const freshId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'completed' });
  const freshRow: DownloadRow = {
    id: freshId, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'completed', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
  };

  const freshApplied = markDelivered(raw, freshRow, 900);

  assert.equal(freshApplied, true);
  assert.equal(readColumn(raw, 'torrent_download', freshId, 'status'), 'delivered');
  assert.equal(readColumn(raw, 'torrent_download', freshId, 'delivered_at'), 900);
});

test('markReclaimed applies once and refuses a row already marked', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'delivered',
  });
  const row: DownloadRow = {
    id, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: 'ref-1', status: 'delivered', storagePath: null, absentSince: null, deliveredAt: 500, reclaimedAt: null, lastError: null,
  };

  const firstApplied = markReclaimed(raw, row, 900);

  assert.equal(firstApplied, true);
  assert.equal(readColumn(raw, 'torrent_download', id, 'reclaimed_at'), 900);
  assert.equal(readColumn(raw, 'torrent_download', id, 'updated_at'), 900);

  // Same row, called again: reclaimed_at is no longer null, so the guard
  // must refuse it -- this is the whole fix for a delivered row's `remove`
  // being called forever.
  const secondApplied = markReclaimed(raw, row, 1200);

  assert.equal(secondApplied, false, 'a row already reclaimed must not be reclaimed again');
  assert.equal(readColumn(raw, 'torrent_download', id, 'reclaimed_at'), 900, 'the original stamp must survive');
  assert.equal(readColumn(raw, 'torrent_download', id, 'updated_at'), 900, 'a refused write must not move updated_at');
});

test('markReclaimed refuses a row that is not delivered', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'completed',
  });
  const row: DownloadRow = {
    id, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: 'ref-1', status: 'completed', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
  };

  const applied = markReclaimed(raw, row, 900);

  assert.equal(applied, false, 'a row that is not delivered has nothing to reclaim');
  assert.equal(readColumn(raw, 'torrent_download', id, 'reclaimed_at'), null);
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'completed');
});

test('failRow applies only from the status the row was read with, and reports which happened', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const staleId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'submitted' });
  const staleRow: DownloadRow = {
    id: staleId, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'downloading', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
  };

  const staleApplied = failRow(raw, staleRow, 'client unreachable', 900);

  assert.equal(staleApplied, false, 'the row is actually submitted, not downloading as staleRow believes');
  assert.equal(readColumn(raw, 'torrent_download', staleId, 'status'), 'submitted');
  assert.equal(readColumn(raw, 'torrent_download', staleId, 'last_error'), null);

  const freshRow: DownloadRow = {
    id: staleId, table: 'torrent_download', rssItemId: itemId, downloadClientId: clientId,
    clientRef: null, status: 'submitted', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
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
    clientRef: null, status: 'submitting', storagePath: null, absentSince: null, deliveredAt: null, reclaimedAt: null, lastError: null,
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

test('rowsForClientByStatus reads rows from both tables, tagged with which table each came from', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const otherClientId = seedClient(raw, { name: 'Other' });
  const torrentId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'downloading' });
  const nzbId = insertNzbRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'submitted' });
  // A row on a different client must not show up in this client's list.
  insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: otherClientId, status: 'downloading' });

  const rows = rowsForClientByStatus(raw, clientId, ['submitted', 'downloading']);

  assert.deepEqual(
    rows.map((row) => ({ id: row.id, table: row.table, status: row.status })).toSorted((a, b) => a.id - b.id),
    [
      { id: torrentId, table: 'torrent_download', status: 'downloading' },
      { id: nzbId, table: 'nzb_download', status: 'submitted' },
    ].toSorted((a, b) => a.id - b.id),
  );
});

test('rowsForClientByStatus returns only the statuses asked for', () => {
  // The whole point of the SQL predicate: a client's finished history must
  // not come back at all, rather than come back and be filtered afterwards.
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const liveId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'completed' });
  insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'delivered' });
  insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'failed' });
  insertNzbRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'delivered' });

  const rows = rowsForClientByStatus(raw, clientId, ['completed']);

  assert.deepEqual(rows.map((row) => ({ id: row.id, table: row.table, status: row.status })), [
    { id: liveId, table: 'torrent_download', status: 'completed' },
  ]);
});

test('rowsForClientByStatus returns rows in id order, which is the order deliveries are promised in', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  // Inserted so that reading through the status index -- which orders by
  // status value first -- would interleave them differently from id order.
  const first = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'submitting' });
  const second = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'downloading' });
  const third = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'submitting' });
  const fourth = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'completed' });

  const rows = rowsForClientByStatus(raw, clientId, ['submitting', 'submitted', 'downloading', 'completed']);

  assert.deepEqual(rows.map((row) => row.id), [first, second, third, fourth]);
});

test('rowsForClientByStatus asked for no statuses returns nothing, and does not build an invalid query', () => {
  // `IN ()` is not valid SQLite, so the empty case is answered without a
  // query at all -- and `[]` is the correct answer, not a degenerate one: no
  // row's status is a member of the empty set.
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'completed' });

  assert.deepEqual(rowsForClientByStatus(raw, clientId, []), []);
});

test('rowsForClientByStatus is served by the status index on both tables, not by a table scan', () => {
  // The measurement this query exists for: without the status predicate the
  // plan is `SCAN torrent_download`, one full pass over every row this client
  // has ever had, on every tick -- 153 ms of blocked event loop at 20,000
  // finished rows, because `node:sqlite` is synchronous. Asserting the plan
  // rather than a duration is what keeps that from silently regressing:
  // migration 7 added `torrent_download_status`/`nzb_download_status` for
  // this query and nothing used them until now.
  const raw = setup();

  for (const table of ['torrent_download', 'nzb_download'] as const) {
    // The statement the module itself builds, not one restated here: a plan
    // assertion against a lookalike would prove nothing about this query.
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${rowsForClientByStatusSql(table, 2)}`)
      .all(1, 'completed', 'downloading')
      .map((step) => String((step as { detail: unknown }).detail))
      .join('\n');

    assert.match(plan, new RegExp(`USING INDEX ${table}_status`), `${table} must be searched through its status index`);
    assert.doesNotMatch(plan, new RegExp(`SCAN ${table}`), `${table} must not be scanned`);
  }
});

test('unreclaimedRowsForClient returns only delivered rows nothing has reclaimed yet', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const otherClientId = seedClient(raw, { name: 'Other' });
  const pendingId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'delivered' });
  const pendingNzbId = insertNzbRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'delivered' });
  const reclaimedId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'delivered' });
  raw.prepare('UPDATE torrent_download SET reclaimed_at = ? WHERE id = ?').run(700, reclaimedId);
  // Neither a row on another client nor one that never reached `delivered`.
  insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: otherClientId, status: 'delivered' });
  insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, status: 'completed' });

  const rows = unreclaimedRowsForClient(raw, clientId);

  assert.deepEqual(rows.map((row) => ({ id: row.id, table: row.table })), [
    { id: pendingId, table: 'torrent_download' },
    { id: pendingNzbId, table: 'nzb_download' },
  ]);
});

test('unreclaimedRowsForClient is served by the status index too, not by a table scan', () => {
  // A `delivered` row stays `delivered` forever, so this read is the one that
  // would keep growing with lifetime history if only `status` were narrowed:
  // 20,000 already-reclaimed rows measured 18-32 ms as a status-only select
  // against 1.8 ms with `reclaimed_at IS NULL` stated in SQL.
  const raw = setup();

  for (const table of ['torrent_download', 'nzb_download'] as const) {
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${unreclaimedRowsForClientSql(table)}`)
      .all(1)
      .map((step) => String((step as { detail: unknown }).detail))
      .join('\n');

    assert.match(plan, new RegExp(`USING INDEX ${table}_status`), `${table} must be searched through its status index`);
    assert.doesNotMatch(plan, new RegExp(`SCAN ${table}`), `${table} must not be scanned`);
  }
});
