import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  reconcileClient,
  MAX_MISSING_POLLS,
  resetLabelMismatchWarningForTests,
} from '../../src/pipeline/reconcile.ts';
import {
  clientJobName,
  downloadLabel,
  extractLabel,
  getDownload,
  setStatus,
  type DownloadRow,
} from '../../src/db/downloads.ts';
import type { ClientSnapshot, DownloadClient } from '../../src/clients/types.ts';

const EMPTY: ClientSnapshot = { queue: [], history: [] };

function fakeClient(snapshot: ClientSnapshot, overrides: Partial<DownloadClient> = {}) {
  return {
    id: 'sab',
    importMode: 'move' as const,
    addUrl: async () => 'nzo_new',
    snapshot: async () => snapshot,
    remove: async () => {},
    mapPath: (path: string) => path.replace('/sab', '/pickarr'),
    ...overrides,
  } satisfies DownloadClient;
}

function seedDownload(
  db: DatabaseSync,
  fields: { id: number; status: string; clientRef: string | null; missingPolls?: number },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g', 'T', 'https://indexer.invalid/1.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{}', 't', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, client_ref, kind, status,
                            missing_polls, created_at, updated_at)
     VALUES (?, 1, 1, 'sab', ?, 'initial', ?, ?, 1, 1)`,
  ).run(fields.id, fields.clientRef, fields.status, fields.missingPolls ?? 0);
}

function deps(db: DatabaseSync, client: DownloadClient, imported: DownloadRow[] = []) {
  return {
    db,
    client,
    now: () => 1000,
    importDownload: async (download: DownloadRow) => {
      imported.push(download);
    },
  };
}

test('a download in the queue stays downloading and resets missing_polls', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1', missingPolls: 2 });
  const client = fakeClient({
    queue: [{ ref: 'nzo_1', name: 'R', percentage: 50 }],
    history: [],
  });

  await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'downloading');
  assert.equal(download.missingPolls, 0);
  db.close();
});

test('a completed download gets its mapped storage path and is imported', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [],
    history: [
      {
        ref: 'nzo_1',
        name: 'R',
        outcome: 'completed',
        storagePath: '/sab/complete/R',
        failMessage: null,
      },
    ],
  });

  await reconcileClient(deps(db, client, imported));

  assert.equal(getDownload(db, 1)?.storagePath, '/pickarr/complete/R');
  assert.equal(imported.length, 1);
  assert.equal(imported[0]?.storagePath, '/pickarr/complete/R');
  db.close();
});

// A `completed` row with a storage path has nothing left to learn from the
// client: the download is done and the only remaining step is the import. The
// client's history is not a durable record — SABnzbd prunes it on its own
// schedule — so an import that is driven purely by observing the entry in
// history stops happening the moment the entry ages out, and the row is then
// indistinguishable from one that vanished mid-download. Imports are therefore
// driven from the row's own state.
test('a completed row with a storage path is imported even when the client has pruned its history', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'completed', clientRef: 'nzo_1' });
  db.prepare("UPDATE downloads SET storage_path = '/pickarr/complete/R' WHERE id = 1").run();
  const imported: DownloadRow[] = [];
  const client = fakeClient(EMPTY);

  // More ticks than it takes to be declared missing: a completed row is
  // waiting on us, not on the client, so it is exempt from that accounting.
  for (let tick = 0; tick <= MAX_MISSING_POLLS; tick += 1) {
    await reconcileClient(deps(db, client, imported));
  }

  assert.equal(imported.length, MAX_MISSING_POLLS + 1);
  assert.equal(imported[0]?.storagePath, '/pickarr/complete/R');
  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'completed');
  assert.equal(download.missingPolls, 0);
  db.close();
});

test('an import failure on a completed row fails the download rather than retrying forever', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'completed', clientRef: 'nzo_1' });
  db.prepare("UPDATE downloads SET storage_path = '/pickarr/complete/R' WHERE id = 1").run();

  await reconcileClient({
    db,
    client: fakeClient(EMPTY),
    now: () => 1000,
    importDownload: async () => {
      throw new Error('no-importable-files');
    },
  });

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  assert.match(download.error ?? '', /no-importable-files/);
  db.close();
});

test('a failed download records the fail message', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient({
    queue: [],
    history: [
      {
        ref: 'nzo_1',
        name: 'R',
        outcome: 'failed',
        storagePath: null,
        failMessage: 'Out of retention',
      },
    ],
  });

  await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  assert.match(download.error ?? '', /Out of retention/);
  db.close();
});

// A history entry in a transient post-processing state (extracting, moving,
// verifying...) is neither a failure nor a completion — the client is still
// working on it. The bug this guards: the old two-way outcome read every
// such state as a terminal failure, so an ordinary multi-part download got
// marked failed while SABnzbd was still unpacking it.
test('a download in a transient client state is left alone, but its missing-poll count is still reset', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1', missingPolls: 2 });
  const client = fakeClient({
    queue: [],
    history: [
      { ref: 'nzo_1', name: 'R', outcome: 'in-progress', storagePath: null, failMessage: null },
    ],
  });

  const result = await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'downloading');
  assert.equal(download.error, null);
  assert.equal(download.missingPolls, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.imported, 0);
  db.close();
});

test('a download with a genuine terminal failure status still fails, distinct from in-progress', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient({
    queue: [],
    history: [
      { ref: 'nzo_1', name: 'R', outcome: 'failed', storagePath: null, failMessage: 'Failed' },
    ],
  });

  await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  db.close();
});

test('a completed download with no storage path fails rather than importing nothing', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [],
    history: [
      { ref: 'nzo_1', name: 'R', outcome: 'completed', storagePath: null, failMessage: null },
    ],
  });

  await reconcileClient(deps(db, client, imported));

  assert.equal(getDownload(db, 1)?.status, 'failed');
  assert.equal(imported.length, 0);
  db.close();
});

test('a download missing from both lists fails only after three consecutive polls', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient(EMPTY);

  for (let poll = 1; poll < MAX_MISSING_POLLS; poll += 1) {
    await reconcileClient(deps(db, client));
    assert.equal(getDownload(db, 1)?.status, 'downloading', `poll ${poll}`);
  }

  await reconcileClient(deps(db, client));
  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  assert.match(download.error ?? '', /disappeared-from-client/);
  db.close();
});

test('reappearing resets the missing counter', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });

  await reconcileClient(deps(db, fakeClient(EMPTY)));
  await reconcileClient(
    deps(db, fakeClient({ queue: [{ ref: 'nzo_1', name: 'R', percentage: 1 }], history: [] })),
  );
  await reconcileClient(deps(db, fakeClient(EMPTY)));
  await reconcileClient(deps(db, fakeClient(EMPTY)));

  assert.equal(getDownload(db, 1)?.status, 'downloading');
  db.close();
});

test('a queued download with no client ref is retried', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'queued', clientRef: null });
  const client = fakeClient(EMPTY, { addUrl: async () => 'nzo_retry' });

  await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'downloading');
  assert.equal(download.clientRef, 'nzo_retry');
  db.close();
});

test('addurl retries stop after the attempt cap', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'queued', clientRef: null });
  const client = fakeClient(EMPTY, {
    addUrl: async () => {
      throw new Error('still down');
    },
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await reconcileClient(deps(db, client));
  }

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  assert.match(download.error ?? '', /addurl-failed/);
  assert.ok(download.attempts <= 5);
  db.close();
});

test('entries with no matching row are reported as untracked and never imported', async () => {
  const db = openTestDatabase();
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [{ ref: 'foreign_1', name: 'Someone Elses', percentage: 12 }],
    history: [
      {
        ref: 'foreign_2',
        name: 'Also Not Ours',
        outcome: 'completed',
        storagePath: '/sab/complete/X',
        failMessage: null,
      },
    ],
  });

  const result = await reconcileClient(deps(db, client, imported));

  assert.equal(imported.length, 0);
  assert.equal(result.untracked.length, 2);
  assert.deepEqual(
    result.untracked.map((entry) => entry.state).sort(),
    ['completed', 'downloading'],
  );
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM downloads').get()?.['n']), 0);
  db.close();
});

test('an already-imported download still in history is not reported as untracked', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'imported', clientRef: 'nzo_1' });
  const client = fakeClient({
    queue: [],
    history: [
      { ref: 'nzo_1', name: 'R', outcome: 'completed', storagePath: '/sab/x', failMessage: null },
    ],
  });

  const result = await reconcileClient(deps(db, client));

  assert.equal(result.untracked.length, 0);
  db.close();
});

test('an import failure fails the download rather than throwing out of the tick', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient({
    queue: [],
    history: [
      { ref: 'nzo_1', name: 'R', outcome: 'completed', storagePath: '/sab/x', failMessage: null },
    ],
  });

  await reconcileClient({
    db,
    client,
    now: () => 1000,
    importDownload: async () => {
      throw new Error('disk full');
    },
  });

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  assert.match(download.error ?? '', /disk full/);
  db.close();
});

// --- Double-submission / orphan-recovery -----------------------------------
//
// A `queued` row with a null client_ref is ambiguous: it looks the same
// whether addUrl was never attempted, or it succeeded and only the write of
// the ref was lost (a crash, or the persist failure pick.ts distinguishes in
// its error text). The tests above ("no client ref is retried" / "attempt
// cap") only exercise the case where addUrl genuinely was never attempted.
// These tests exercise the ambiguous case: the client already accepted the
// job — proven here by a fake addUrl that is never allowed to be called
// again — and reconcile must recover the existing ref from the client's own
// queue/history rather than submitting a second time.

test('a queued download whose addUrl already succeeded is recovered from the queue, not resubmitted', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'queued', clientRef: null });
  let addUrlCalls = 0;
  const client = fakeClient(
    // Recovery has to extract the marker out of a name that also carries the
    // release title (see clientJobName), not match on the bare label alone.
    { queue: [{ ref: 'nzo_orphan', name: clientJobName('Some.Release.Title', 1), percentage: 5 }], history: [] },
    {
      addUrl: async () => {
        addUrlCalls += 1;
        return 'nzo_should_never_be_returned';
      },
    },
  );

  const result = await reconcileClient(deps(db, client));

  assert.equal(addUrlCalls, 0);
  const download = getDownload(db, 1)!;
  assert.equal(download.clientRef, 'nzo_orphan');
  assert.equal(download.status, 'downloading');
  assert.equal(result.untracked.length, 0);
  db.close();
});

test('a queued download whose addUrl already succeeded and finished is recovered from history and imported in the same tick', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'queued', clientRef: null });
  const imported: DownloadRow[] = [];
  let addUrlCalls = 0;
  const client = fakeClient(
    {
      queue: [],
      history: [
        {
          ref: 'nzo_finished',
          name: clientJobName('Some.Release.Title', 1),
          outcome: 'completed',
          storagePath: '/sab/complete/R',
          failMessage: null,
        },
      ],
    },
    {
      addUrl: async () => {
        addUrlCalls += 1;
        return 'nzo_should_never_be_returned';
      },
    },
  );

  await reconcileClient(deps(db, client, imported));

  assert.equal(addUrlCalls, 0);
  const download = getDownload(db, 1)!;
  assert.equal(download.clientRef, 'nzo_finished');
  assert.equal(download.status, 'completed');
  assert.equal(download.storagePath, '/pickarr/complete/R');
  assert.equal(imported.length, 1);
  db.close();
});

test('recovering a ref by label does not consume an addurl attempt, unlike a real retry', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'queued', clientRef: null });
  db.prepare('UPDATE downloads SET attempts = 4 WHERE id = 1').run();
  let addUrlCalls = 0;
  const client = fakeClient(
    { queue: [{ ref: 'nzo_orphan', name: clientJobName('Some.Release.Title', 1), percentage: 1 }], history: [] },
    {
      addUrl: async () => {
        addUrlCalls += 1;
        return 'nzo_should_never_be_returned';
      },
    },
  );

  await reconcileClient(deps(db, client));

  assert.equal(addUrlCalls, 0);
  const download = getDownload(db, 1)!;
  assert.equal(download.attempts, 4);
  assert.equal(download.clientRef, 'nzo_orphan');
  db.close();
});

// seedDownload's feed item carries raw_title 'T', so a retry's addUrl call
// should send a name built from that title with the download's own label
// appended as a bracketed marker (see clientJobName) — readable in the
// client's UI, and still recoverable by extractLabel regardless of what the
// title looks like.
test('a fresh addUrl call sends a name carrying the release title, with the label recoverable as a marker', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'queued', clientRef: null });
  let seenName: string | undefined;
  const client = fakeClient(EMPTY, {
    addUrl: async (_url: string, name: string) => {
      seenName = name;
      return 'nzo_retry';
    },
  });

  await reconcileClient(deps(db, client));

  assert.ok(seenName !== undefined);
  assert.match(seenName ?? '', /^T /);
  assert.equal(extractLabel(seenName ?? ''), downloadLabel(1));
  db.close();
});

// --- Label-mismatch observability --------------------------------------
//
// Recovery depends entirely on the client surfacing the label a download was
// submitted under verbatim as that entry's name. If a real server doesn't
// (renames jobs once it has parsed the actual nzb, say), refByLabel simply
// never matches and every retry regresses to the pre-fix double-submit risk
// — with no test failure, since the fakes here stub the name directly rather
// than round-tripping it through a real client. The warning below is what
// turns that silent regression into a visible one.

test('a tracked download whose client-side name does not match its label warns exactly once, not once per tick', async () => {
  resetLabelMismatchWarningForTests();
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient({
    queue: [{ ref: 'nzo_1', name: 'Some.Release.Name', percentage: 10 }],
    history: [],
  });
  const warnMock = mock.method(console, 'warn', () => {});

  try {
    await reconcileClient(deps(db, client));
    await reconcileClient(deps(db, client));
    await reconcileClient(deps(db, client));

    assert.equal(warnMock.mock.callCount(), 1);
    const message = String(warnMock.mock.calls[0]?.arguments[0] ?? '');
    assert.match(message, /download 1/);
    assert.match(message, /Some\.Release\.Name/);
    assert.match(message, /pickarr-1/);
  } finally {
    warnMock.mock.restore();
  }
  db.close();
});

test('a tracked download whose client-side name matches its label never warns', async () => {
  resetLabelMismatchWarningForTests();
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient({
    // A real client reports the title-plus-marker name, not the bare label.
    queue: [{ ref: 'nzo_1', name: clientJobName('T', 1), percentage: 10 }],
    history: [],
  });
  const warnMock = mock.method(console, 'warn', () => {});

  try {
    await reconcileClient(deps(db, client));
    assert.equal(warnMock.mock.callCount(), 0);
  } finally {
    warnMock.mock.restore();
  }
  db.close();
});

// --- Cleanup after a successful import ---------------------------------------

function removalTracking(): { removed: { ref: string; deleteFiles: boolean }[]; remove: DownloadClient['remove'] } {
  const removed: { ref: string; deleteFiles: boolean }[] = [];
  return {
    removed,
    remove: (ref: string, deleteFiles: boolean) => {
      removed.push({ ref, deleteFiles });
      return Promise.resolve();
    },
  };
}

test('an imported download is removed from the client, with its files', async () => {
  // Nothing ever told SABnzbd the job was finished with, so its history grew
  // without bound and the download directory was never reclaimed.
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'imported', clientRef: 'nzo-done' });
  const { removed, remove } = removalTracking();
  const client = fakeClient(
    {
      queue: [],
      history: [{ ref: 'nzo-done', name: 'Scene [pickarr-1]', outcome: 'completed', storagePath: '/sab/x', failMessage: null }],
    },
    { remove },
  );

  await reconcileClient({ db, client, now: () => 2000, importDownload: async () => {} });
  assert.deepEqual(removed, [{ ref: 'nzo-done', deleteFiles: true }]);
});

test('a download still running is left alone', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo-live' });
  const { removed, remove } = removalTracking();
  const client = fakeClient(
    { queue: [{ ref: 'nzo-live', name: 'Scene [pickarr-1]', percentage: 40 }], history: [] },
    { remove },
  );

  await reconcileClient({ db, client, now: () => 2000, importDownload: async () => {} });
  assert.deepEqual(removed, [], 'a running job must survive the tick');
});

test('a failed download is left in the client for inspection', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'failed', clientRef: 'nzo-bad' });
  const { removed, remove } = removalTracking();
  const client = fakeClient(
    { queue: [], history: [{ ref: 'nzo-bad', name: 'Scene [pickarr-1]', outcome: 'failed', storagePath: null, failMessage: null }] },
    { remove },
  );

  await reconcileClient({ db, client, now: () => 2000, importDownload: async () => {} });
  assert.deepEqual(removed, [], 'deleting a failure destroys the evidence for it');
});

test('an untracked entry is never removed, however finished it looks', async () => {
  const db = openTestDatabase();
  const { removed, remove } = removalTracking();
  const client = fakeClient(
    {
      queue: [],
      history: [{ ref: 'nzo-stranger', name: 'Someone Elses Job', outcome: 'completed', storagePath: '/sab/y', failMessage: null }],
    },
    { remove },
  );

  await reconcileClient({ db, client, now: () => 2000, importDownload: async () => {} });
  assert.deepEqual(removed, [], 'the category may be shared, and that data is not ours');
});

test('a download imported during this same tick is cleaned up in it', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo-now' });
  const { removed, remove } = removalTracking();
  const client = fakeClient(
    {
      queue: [],
      history: [{ ref: 'nzo-now', name: 'Scene [pickarr-1]', outcome: 'completed', storagePath: '/sab/x', failMessage: null }],
    },
    { remove },
  );

  await reconcileClient({
    db,
    client,
    now: () => 2000,
    importDownload: async (download) => {
      setStatus(db, download.id, 'imported', 2000);
    },
  });
  assert.deepEqual(removed, [{ ref: 'nzo-now', deleteFiles: true }]);
});

test('a removal that fails does not undo the import, and is retried next tick', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'imported', clientRef: 'nzo-done' });
  let attempts = 0;
  const client = fakeClient(
    {
      queue: [],
      history: [{ ref: 'nzo-done', name: 'Scene [pickarr-1]', outcome: 'completed', storagePath: '/sab/x', failMessage: null }],
    },
    {
      remove: () => {
        attempts += 1;
        return Promise.reject(new Error('connection refused'));
      },
    },
  );

  const first = await reconcileClient({ db, client, now: () => 2000, importDownload: async () => {} });
  assert.equal(getDownload(db, 1)?.status, 'imported', 'the file is already in place');
  assert.equal(first.failed, 0, 'a cleanup failure is not an import failure');

  // Self-healing with no extra bookkeeping: while the entry is still in the
  // client's history it is still ours and still imported, so the next tick
  // tries again.
  await reconcileClient({ db, client, now: () => 3000, importDownload: async () => {} });
  assert.equal(attempts, 2);
});
