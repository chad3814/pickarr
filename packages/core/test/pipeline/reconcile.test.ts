import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { reconcileClient, MAX_MISSING_POLLS } from '../../src/pipeline/reconcile.ts';
import { downloadLabel, getDownload, type DownloadRow } from '../../src/db/downloads.ts';
import type { ClientSnapshot, DownloadClient } from '../../src/clients/types.ts';

const EMPTY: ClientSnapshot = { queue: [], history: [] };

function fakeClient(snapshot: ClientSnapshot, overrides: Partial<DownloadClient> = {}) {
  return {
    id: 'sab',
    importMode: 'move' as const,
    addUrl: async () => 'nzo_new',
    snapshot: async () => snapshot,
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
    { queue: [{ ref: 'nzo_orphan', name: downloadLabel(1), percentage: 5 }], history: [] },
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
          name: downloadLabel(1),
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
    { queue: [{ ref: 'nzo_orphan', name: downloadLabel(1), percentage: 1 }], history: [] },
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

test('a fresh addUrl call is given the download-derived label, not the release title', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'queued', clientRef: null });
  let seenLabel: string | undefined;
  const client = fakeClient(EMPTY, {
    addUrl: async (_url: string, label: string) => {
      seenLabel = label;
      return 'nzo_retry';
    },
  });

  await reconcileClient(deps(db, client));

  assert.equal(seenLabel, downloadLabel(1));
  db.close();
});
