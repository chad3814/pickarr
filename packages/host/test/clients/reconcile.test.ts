import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { walkSnapshot } from '../../src/clients/reconcile.ts';
import type { ReconcileDeps } from '../../src/clients/reconcile.ts';
import type { ClientHistoryEntry, ClientQueueEntry, ClientSnapshot } from '../../src/clients/snapshot.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/** Inserts one `download_client` row and returns its id. Mirrors `rows.test.ts`'s own `seedClient`. */
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
 * the foreign keys both download tables require. Mirrors `rows.test.ts`'s
 * own `seedRssItem`.
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

/**
 * Inserts an `rss_item` with a caller-chosen filename on a fresh feed, for
 * the one case `seedRssItem` cannot express: two items whose `filename`
 * matches while their feeds differ, because `rss_feed.url` is unique.
 */
function seedRssItemOnNewFeed(raw: DatabaseSync, feedName: string, filename: string): number {
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at)
    VALUES ('alpha', ?, ?, 1, 1)
  `).run(feedName, `https://example.test/${feedName}`);
  const feedId = Number((raw.prepare('SELECT id FROM rss_feed WHERE name = ?').get(feedName) as { id: unknown }).id);
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (?, ?, ?, 1, 1, 'torrent', '1080p')
  `).run(feedId, filename, `https://example.test/${feedName}/${filename}`);
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

/** Inserts one `nzb_download` row and returns its id -- the same shape as `insertTorrentRow`, minus `infohash`, which nzbs do not have. */
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

/** Counts every row currently in `table`, for the untracked test's "nothing was written" assertion. */
function countRows(raw: DatabaseSync, table: 'torrent_download' | 'nzb_download'): number {
  const row = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: unknown };
  return Number(row.n);
}

const emptySnapshot: ClientSnapshot = { queue: [], history: [], complete: true, unreadable: [] };

function queueEntry(overrides: Partial<ClientQueueEntry> = {}): ClientQueueEntry {
  return { ref: 'ref-1', name: 'movie.mkv', percentage: 0, category: 'movies', ...overrides };
}

function historyEntry(overrides: Partial<ClientHistoryEntry> = {}): ClientHistoryEntry {
  return {
    ref: 'ref-1', name: 'movie.mkv', category: 'movies',
    outcome: 'completed', storagePath: null, failMessage: null,
    ...overrides,
  };
}

function deps(raw: DatabaseSync, clientId: number, overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    raw, clientId, category: 'movies', snapshot: emptySnapshot, now: 500,
    log: () => {},
    ...overrides,
  };
}

test('a queue entry moves a submitted row to downloading and records its progress', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'submitted' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: { ...emptySnapshot, queue: [queueEntry({ ref: 'ref-1', percentage: 37 })] },
  }));

  assert.deepEqual(result, {
    advanced: 1, completed: 0, failed: 0, untracked: 0, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'downloading');
  assert.equal(readColumn(raw, 'torrent_download', id, 'percentage'), 37);
});

test('a completed history entry stores the client path and completes the row', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'downloading' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: {
      ...emptySnapshot,
      history: [historyEntry({ ref: 'ref-1', outcome: 'completed', storagePath: '/downloads/movie.mkv' })],
    },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 1, failed: 0, untracked: 0, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'completed');
  assert.equal(readColumn(raw, 'torrent_download', id, 'storage_path'), '/downloads/movie.mkv');
});

test('a failed history entry fails the row with the client\'s message, redacted', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'downloading' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: {
      ...emptySnapshot,
      history: [historyEntry({
        ref: 'ref-1', outcome: 'failed',
        failMessage: 'fetch failed for https://sab.example.com/api?apikey=super-secret&mode=queue',
      })],
    },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 1, untracked: 0, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'failed');
  assert.equal(
    readColumn(raw, 'torrent_download', id, 'last_error'),
    'fetch failed for https://sab.example.com/api?apikey=***&mode=queue',
  );
});

test('an in-progress history entry leaves the row exactly where it was', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'downloading' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: { ...emptySnapshot, history: [historyEntry({ ref: 'ref-1', outcome: 'in-progress', storagePath: null })] },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 0, untracked: 0, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'downloading');
  assert.equal(readColumn(raw, 'torrent_download', id, 'last_error'), null);
  assert.equal(readColumn(raw, 'torrent_download', id, 'storage_path'), null);
});

test('a completed job whose row we already failed is advanced anyway', () => {
  // Client-first's whole reason. Row-first iteration cannot reach this row,
  // so this test fails against that ordering.
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'failed' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: {
      ...emptySnapshot,
      history: [historyEntry({ ref: 'ref-1', outcome: 'completed', storagePath: '/downloads/movie.mkv' })],
    },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 1, failed: 0, untracked: 0, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'completed');
  assert.equal(readColumn(raw, 'torrent_download', id, 'storage_path'), '/downloads/movie.mkv');
});

test('an entry matching no row is counted untracked and never written', () => {
  const raw = setup();
  // Seeded so a mutation that tries to write an untracked entry anyway has a
  // valid `rss_item_id` to write against, and so fails the row-count
  // assertion below rather than an unrelated foreign-key error.
  seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const torrentCountBefore = countRows(raw, 'torrent_download');
  const nzbCountBefore = countRows(raw, 'nzb_download');

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: {
      ...emptySnapshot,
      queue: [queueEntry({ ref: 'unknown-queue-ref' })],
      history: [historyEntry({ ref: 'unknown-history-ref', outcome: 'completed' })],
    },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 0, untracked: 2, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(countRows(raw, 'torrent_download'), torrentCountBefore, 'no torrent row must be inserted');
  assert.equal(countRows(raw, 'nzb_download'), nzbCountBefore, 'no nzb row must be inserted');
});

test('a delivered row is left alone by every arm', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const queueId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-queue', status: 'delivered' });
  const completedId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-completed', status: 'delivered' });
  const failedId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-failed', status: 'delivered' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: {
      ...emptySnapshot,
      queue: [queueEntry({ ref: 'ref-queue', percentage: 99 })],
      history: [
        historyEntry({ ref: 'ref-completed', outcome: 'completed', storagePath: '/downloads/movie.mkv' }),
        historyEntry({ ref: 'ref-failed', outcome: 'failed', failMessage: 'boom' }),
      ],
    },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 0, untracked: 0, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', queueId, 'status'), 'delivered');
  assert.equal(readColumn(raw, 'torrent_download', queueId, 'percentage'), null);
  assert.equal(readColumn(raw, 'torrent_download', completedId, 'status'), 'delivered');
  assert.equal(readColumn(raw, 'torrent_download', completedId, 'storage_path'), null);
  assert.equal(readColumn(raw, 'torrent_download', failedId, 'status'), 'delivered');
  assert.equal(readColumn(raw, 'torrent_download', failedId, 'last_error'), null);
});

test('a null ref is recovered from the one entry matching our category and name', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'movie');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: null, status: 'submitting' });

  // outcome 'in-progress' so the walk that follows recovery leaves the row
  // exactly where recovery put it -- this test is about recovery alone.
  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: { ...emptySnapshot, history: [historyEntry({ ref: 'ref-1', outcome: 'in-progress', storagePath: null })] },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 0, untracked: 0, recovered: 1, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'client_ref'), 'ref-1');
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'submitting');
});

test('a recovered row advances in the same tick', () => {
  // The entry is a queue slot, so the row should end at `downloading`, not
  // merely `submitted` with a ref.
  const raw = setup();
  const itemId = seedRssItem(raw, 'movie');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: null, status: 'submitting' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: { ...emptySnapshot, queue: [queueEntry({ ref: 'ref-1', percentage: 12 })] },
  }));

  assert.deepEqual(result, {
    advanced: 1, completed: 0, failed: 0, untracked: 0, recovered: 1, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'client_ref'), 'ref-1');
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'downloading');
  assert.equal(readColumn(raw, 'torrent_download', id, 'percentage'), 12);
});

test('two matching entries recover nothing and write nothing', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'movie');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: null, status: 'submitting' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: {
      ...emptySnapshot,
      queue: [queueEntry({ ref: 'ref-a' }), queueEntry({ ref: 'ref-b' })],
    },
  }));

  // Neither ref matches any existing row, so both queue entries are counted
  // untracked by the walk that follows -- recovery itself wrote nothing.
  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 0, untracked: 2, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'client_ref'), null);
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'submitting');
});

test('a ref another row already holds is never attached, and the rest of the tick still runs', () => {
  // The route the claim pass alone does not close: `refCandidates` matched on
  // (category, name), which says nothing about ownership. One `downloading`
  // row already holds nzo-1; a second row for the same `rss_item.filename`
  // sees that one job as its single unambiguous candidate. Writing it is a
  // `client_ref` unique-index violation, and the throw took the whole tick
  // with it -- so this asserts both that nothing was written to the claiming
  // row and that an unrelated row still advanced.
  const raw = setup();
  const itemId = seedRssItem(raw, 'movie');
  const otherItemId = seedRssItem(raw, 'other');
  const clientId = seedClient(raw);
  const holderId = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: 'nzo-1', status: 'downloading',
  });
  const claimantId = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: null, status: 'submitting',
  });
  const bystanderId = insertTorrentRow(raw, {
    rssItemId: otherItemId, downloadClientId: clientId, clientRef: 'ref-other', status: 'submitted',
  });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: {
      ...emptySnapshot,
      queue: [
        queueEntry({ ref: 'nzo-1', name: 'movie.mkv', percentage: 55 }),
        queueEntry({ ref: 'ref-other', name: 'other.mkv', percentage: 5 }),
      ],
    },
  }));

  assert.deepEqual(result, {
    advanced: 1, completed: 0, failed: 0, untracked: 0, recovered: 0, absent: 0,
    refsAlreadyHeld: 1, recoverFailures: 0,
  });
  // Nothing at all was written to the claiming row: not the ref, not the
  // status, not even `updated_at`, which every write in `rows.ts` moves.
  assert.equal(readColumn(raw, 'torrent_download', claimantId, 'client_ref'), null);
  assert.equal(readColumn(raw, 'torrent_download', claimantId, 'status'), 'submitting');
  assert.equal(readColumn(raw, 'torrent_download', claimantId, 'updated_at'), 1);
  // The row that actually holds nzo-1 keeps it, and the tick's other work
  // happened -- which it could not have if recovery had thrown.
  assert.equal(readColumn(raw, 'torrent_download', holderId, 'client_ref'), 'nzo-1');
  assert.equal(readColumn(raw, 'torrent_download', holderId, 'percentage'), 55);
  assert.equal(readColumn(raw, 'torrent_download', bystanderId, 'status'), 'downloading');
  assert.equal(readColumn(raw, 'torrent_download', bystanderId, 'percentage'), 5);
});

test('a ref held by a row in the other download table is not a candidate either', () => {
  // `client_ref`'s unique index is per-table, so this write would be
  // *accepted* -- and then it would be the worse outcome, not the harmless
  // one: `rowByRef` searches `torrent_download` first, so the torrent row
  // would shadow the nzb row that actually holds the job, and every later
  // tick would reconcile the client's answer about it into the wrong row. A
  // ref is taken or it is not; which table took it is not the question
  // recovery is asking. Held by the *nzb* row deliberately -- the direction
  // that fails if `heldRefs` reads only the table it is writing to.
  const raw = setup();
  const itemId = seedRssItem(raw, 'movie');
  const clientId = seedClient(raw);
  const nzbHolderId = insertNzbRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: 'nzo-1', status: 'downloading',
  });
  const torrentClaimantId = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: null, status: 'submitting',
  });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: { ...emptySnapshot, queue: [queueEntry({ ref: 'nzo-1', name: 'movie.mkv', percentage: 12 })] },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 0, untracked: 0, recovered: 0, absent: 0,
    refsAlreadyHeld: 1, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', torrentClaimantId, 'client_ref'), null);
  assert.equal(readColumn(raw, 'torrent_download', torrentClaimantId, 'updated_at'), 1);
  assert.equal(readColumn(raw, 'nzb_download', nzbHolderId, 'client_ref'), 'nzo-1');
  assert.equal(readColumn(raw, 'nzb_download', nzbHolderId, 'percentage'), 12);
});

test('the same rss_item requested twice recovers neither row, with no second feed involved', () => {
  // The claim pass's own case, reached without `seedRssItemOnNewFeed`: two
  // download rows on one `rss_item` read the identical filename, so one
  // client job is the single unambiguous candidate for both. Nothing needs
  // two feeds, or two releases, to produce this.
  const raw = setup();
  const itemId = seedRssItem(raw, 'movie');
  const clientId = seedClient(raw);
  const firstId = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: null, status: 'submitting',
  });
  const secondId = insertTorrentRow(raw, {
    rssItemId: itemId, downloadClientId: clientId, clientRef: null, status: 'submitting',
  });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: { ...emptySnapshot, queue: [queueEntry({ ref: 'ref-shared', name: 'movie.mkv' })] },
  }));

  // `ref-shared` matches no row, so the walk counts it untracked -- recovery
  // itself wrote nothing, and threw nothing.
  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 0, untracked: 1, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  for (const id of [firstId, secondId]) {
    assert.equal(readColumn(raw, 'torrent_download', id, 'client_ref'), null);
    assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'submitting');
    assert.equal(readColumn(raw, 'torrent_download', id, 'updated_at'), 1);
  }
});

test('one client job claimed by two same-named downloads recovers neither', () => {
  // Ambiguity from the job's side, which "exactly one candidate for this
  // row" does not catch: two rows whose rss_item.filename is the same each
  // see the same single queue entry and each would claim it. Attaching one
  // job to two rows is wrong on its face -- and it would not fail quietly,
  // because `client_ref`'s partial unique index rejects the second write and
  // that throw would escape walkSnapshot and abandon the rest of the tick.
  const raw = setup();
  // Two rss_items sharing a filename but on different feeds -- `rss_feed.url`
  // is unique, so the shared helper cannot seed this shape. The duplicate
  // filename is the whole point: it is what makes one client job match both.
  const firstItem = seedRssItem(raw, 'movie');
  const secondItem = seedRssItemOnNewFeed(raw, 'second-feed', 'movie.mkv');
  const clientId = seedClient(raw);
  const firstId = insertTorrentRow(raw, { rssItemId: firstItem, downloadClientId: clientId, clientRef: null, status: 'submitting' });
  const secondId = insertTorrentRow(raw, { rssItemId: secondItem, downloadClientId: clientId, clientRef: null, status: 'submitting' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: { ...emptySnapshot, queue: [queueEntry({ ref: 'ref-shared', name: 'movie.mkv' })] },
  }));

  assert.equal(result.recovered, 0, 'neither row may claim a job both match');
  assert.equal(readColumn(raw, 'torrent_download', firstId, 'client_ref'), null);
  assert.equal(readColumn(raw, 'torrent_download', secondId, 'client_ref'), null);
  assert.equal(readColumn(raw, 'torrent_download', firstId, 'status'), 'submitting');
  assert.equal(readColumn(raw, 'torrent_download', secondId, 'status'), 'submitting');
});

test('an incomplete snapshot recovers nothing, even on a single clean match', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'movie');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: null, status: 'submitting' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: { ...emptySnapshot, complete: false, queue: [queueEntry({ ref: 'ref-1' })] },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 0, untracked: 1, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'client_ref'), null);
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'submitting');
});

test('an entry with our name in another category is not ours', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'movie');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: null, status: 'submitting' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: { ...emptySnapshot, queue: [queueEntry({ ref: 'ref-1', category: 'tv' })] },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 0, untracked: 1, recovered: 0, absent: 0,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'client_ref'), null);
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'submitting');
});

test('a row that already has a ref is not touched by recovery', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'movie');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'existing-ref', status: 'submitting' });

  const result = walkSnapshot(deps(raw, clientId, {
    snapshot: { ...emptySnapshot, queue: [queueEntry({ ref: 'new-ref' })] },
  }));

  assert.deepEqual(result, {
    advanced: 0, completed: 0, failed: 0, untracked: 1, recovered: 0, absent: 1,
    refsAlreadyHeld: 0, recoverFailures: 0,
  });
  assert.equal(readColumn(raw, 'torrent_download', id, 'client_ref'), 'existing-ref');
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'submitting');
  // existing-ref is never mentioned by the snapshot's one entry (new-ref), so
  // the sweep that now runs at the end of walkSnapshot stamps it absent.
  assert.equal(readColumn(raw, 'torrent_download', id, 'absent_since'), 500);
});

test('a complete snapshot stamps a row it does not account for', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'downloading' });

  const result = walkSnapshot(deps(raw, clientId, { now: 900 }));

  assert.equal(result.absent, 1);
  assert.equal(readColumn(raw, 'torrent_download', id, 'absent_since'), 900);
});

test('an incomplete snapshot stamps nothing and reports absent zero', () => {
  // And still advances a row it does contain -- two assertions, one fake.
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const missingId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-missing', status: 'downloading' });
  const presentId = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-present', status: 'submitted' });

  const result = walkSnapshot(deps(raw, clientId, {
    now: 900,
    snapshot: { ...emptySnapshot, complete: false, queue: [queueEntry({ ref: 'ref-present', percentage: 40 })] },
  }));

  assert.equal(result.absent, 0);
  assert.equal(readColumn(raw, 'torrent_download', missingId, 'absent_since'), null);
  assert.equal(readColumn(raw, 'torrent_download', presentId, 'status'), 'downloading');
});

test('a row that reappears has its absence cleared', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'downloading' });
  raw.prepare('UPDATE torrent_download SET absent_since = ? WHERE id = ?').run(100, id);

  const result = walkSnapshot(deps(raw, clientId, {
    now: 900,
    snapshot: { ...emptySnapshot, queue: [queueEntry({ ref: 'ref-1', percentage: 10 })] },
  }));

  assert.equal(result.absent, 0);
  assert.equal(readColumn(raw, 'torrent_download', id, 'absent_since'), null);
});

test('an absent row is not failed', () => {
  // The whole point. Assert the status is untouched.
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'downloading' });

  const result = walkSnapshot(deps(raw, clientId, { now: 900 }));

  assert.equal(result.absent, 1);
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'downloading');
});

test('a stamp already set is not overwritten with a later time', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'downloading' });
  raw.prepare('UPDATE torrent_download SET absent_since = ? WHERE id = ?').run(100, id);

  const result = walkSnapshot(deps(raw, clientId, { now: 900 }));

  assert.equal(result.absent, 1);
  assert.equal(readColumn(raw, 'torrent_download', id, 'absent_since'), 100);
});

test('a terminal row is never swept', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'delivered' });

  const result = walkSnapshot(deps(raw, clientId, { now: 900 }));

  assert.equal(result.absent, 0);
  assert.equal(readColumn(raw, 'torrent_download', id, 'absent_since'), null);
});

test('a row with no ref is never swept', () => {
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: null, status: 'submitting' });

  const result = walkSnapshot(deps(raw, clientId, { now: 900 }));

  assert.equal(result.absent, 0);
  assert.equal(readColumn(raw, 'torrent_download', id, 'absent_since'), null);
});

// --- The failed arm, guarded the way the completed arm always was ----------

test('a failed entry does not re-fail a row already failed for that reason, across three ticks', () => {
  // The unguarded arm issued one UPDATE per failed history entry per tick,
  // forever -- once a minute per client for as long as the client kept the
  // entry. `updated_at` is the assertion that catches it: SABnzbd prunes
  // history on its own schedule, so a failed job can sit there for weeks,
  // and every tick would have rewritten the one column that answers "when
  // did this row last change".
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'downloading' });

  const snapshot: ClientSnapshot = {
    ...emptySnapshot,
    history: [historyEntry({ ref: 'ref-1', outcome: 'failed', failMessage: 'unpack failed' })],
  };

  const first = walkSnapshot(deps(raw, clientId, { snapshot, now: 500 }));
  assert.equal(first.failed, 1, 'the first tick is the one that actually fails the row');
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'failed');
  assert.equal(readColumn(raw, 'torrent_download', id, 'last_error'), 'unpack failed');
  assert.equal(readColumn(raw, 'torrent_download', id, 'updated_at'), 500);

  const second = walkSnapshot(deps(raw, clientId, { snapshot, now: 600 }));
  const third = walkSnapshot(deps(raw, clientId, { snapshot, now: 700 }));

  assert.equal(second.failed, 0, 'a second tick has nothing to fail -- the verdict is already recorded');
  assert.equal(third.failed, 0);
  assert.equal(
    readColumn(raw, 'torrent_download', id, 'updated_at'),
    500,
    'updated_at must still be the tick that failed the row, not the last tick that looked at it',
  );
  assert.equal(readColumn(raw, 'torrent_download', id, 'last_error'), 'unpack failed');
});

test('a failed entry whose reason has changed is written, because that is a new fact', () => {
  // The guard is "same status and same reason", not "already failed": a
  // client that refines its own message on a later poll still reaches
  // `last_error`.
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'failed' });
  raw.prepare("UPDATE torrent_download SET last_error = 'unpack failed', updated_at = 500 WHERE id = ?").run(id);

  const result = walkSnapshot(deps(raw, clientId, {
    now: 600,
    snapshot: {
      ...emptySnapshot,
      history: [historyEntry({ ref: 'ref-1', outcome: 'failed', failMessage: 'unpack failed: no par2 volumes' })],
    },
  }));

  assert.equal(result.failed, 1);
  assert.equal(readColumn(raw, 'torrent_download', id, 'last_error'), 'unpack failed: no par2 volumes');
  assert.equal(readColumn(raw, 'torrent_download', id, 'updated_at'), 600);
});

test('a failed row still advances when the client later reports it completed, guard or no guard', () => {
  // `failed` is explicitly not terminal -- `ADVANCES_TO_COMPLETED` includes
  // it, because a wrong verdict staying recoverable is this module's
  // headline property and the whole lesson of 1.x's 2026-08-15 incident.
  // The guard above declines to rewrite a verdict with itself; it must not
  // have made `failed` a state a row cannot leave. This is the same
  // property as 'a completed job whose row we already failed is advanced
  // anyway' above, asserted against a row that reached `failed` through
  // this walk's own guarded arm rather than being inserted that way.
  const raw = setup();
  const itemId = seedRssItem(raw, 'a');
  const clientId = seedClient(raw);
  const id = insertTorrentRow(raw, { rssItemId: itemId, downloadClientId: clientId, clientRef: 'ref-1', status: 'downloading' });

  walkSnapshot(deps(raw, clientId, {
    now: 500,
    snapshot: {
      ...emptySnapshot,
      history: [historyEntry({ ref: 'ref-1', outcome: 'failed', failMessage: 'unpack failed' })],
    },
  }));
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'failed', 'precondition: the row is failed');

  const recovered = walkSnapshot(deps(raw, clientId, {
    now: 900,
    snapshot: {
      ...emptySnapshot,
      history: [historyEntry({ ref: 'ref-1', outcome: 'completed', storagePath: '/downloads/movie.mkv' })],
    },
  }));

  assert.equal(recovered.completed, 1, 'the client\'s later verdict must still reach the row');
  assert.equal(readColumn(raw, 'torrent_download', id, 'status'), 'completed');
  assert.equal(readColumn(raw, 'torrent_download', id, 'storage_path'), '/downloads/movie.mkv');
  assert.equal(readColumn(raw, 'torrent_download', id, 'updated_at'), 900);
});
