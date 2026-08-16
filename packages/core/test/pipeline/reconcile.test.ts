import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  reconcileClient,
  resetReconcileWarningsForTests,
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

const EMPTY: ClientSnapshot = { queue: [], history: [], complete: true };

/** What every fake client here submits under, so `OURS` is what it polls. */
const OURS = 'pickarr';

function fakeClient(snapshot: ClientSnapshot, overrides: Partial<DownloadClient> = {}) {
  return {
    id: 'sab',
    importMode: 'move' as const,
    category: OURS,
    addUrl: async () => 'nzo_new',
    snapshot: async () => snapshot,
    remove: async () => {},
    mapPath: (path: string) => path.replace('/sab', '/pickarr'),
    ...overrides,
  } satisfies DownloadClient;
}

function seedDownload(
  db: DatabaseSync,
  fields: {
    id: number;
    status: string;
    clientRef: string | null;
    error?: string;
    storagePath?: string;
    absentSince?: number;
  },
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
                            error, storage_path, absent_since, created_at, updated_at)
     VALUES (?, 1, 1, 'sab', ?, 'initial', ?, ?, ?, ?, 1, 1)`,
  ).run(
    fields.id,
    fields.clientRef,
    fields.status,
    fields.error ?? null,
    fields.storagePath ?? null,
    fields.absentSince ?? null,
  );
}

function deps(
  db: DatabaseSync,
  client: DownloadClient,
  imported: DownloadRow[] = [],
  now = 1000,
) {
  return {
    db,
    client,
    now: () => now,
    importDownload: async (download: DownloadRow) => {
      imported.push(download);
    },
  };
}

/** A queue slot in our own category, which is the ordinary case. */
function queued(ref: string, name = 'R', percentage = 50) {
  return { ref, name, percentage, category: OURS };
}

function finished(ref: string, storagePath: string | null, name = 'R') {
  return {
    ref,
    name,
    outcome: 'completed' as const,
    storagePath,
    failMessage: null,
    category: OURS,
  };
}

test('a download in the queue stays downloading and any absence mark is retracted', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1', absentSince: 500 });
  const client = fakeClient({ queue: [queued('nzo_1')], history: [], complete: true });

  const result = await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'downloading');
  assert.equal(download.absentSince, null);
  assert.equal(result.absent, 0);
  db.close();
});

test('a completed download gets its mapped storage path and is imported', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [],
    history: [finished('nzo_1', '/sab/complete/R')],
    complete: true,
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
  seedDownload(db, {
    id: 1,
    status: 'completed',
    clientRef: 'nzo_1',
    storagePath: '/pickarr/complete/R',
  });
  const imported: DownloadRow[] = [];
  const client = fakeClient(EMPTY);

  // Several ticks of total absence: a completed row is waiting on us, not on
  // the client, so its absence from the snapshot is the expected steady state
  // and is not recorded as absence at all.
  for (let tick = 0; tick < 4; tick += 1) {
    await reconcileClient(deps(db, client, imported));
  }

  assert.equal(imported.length, 4);
  assert.equal(imported[0]?.storagePath, '/pickarr/complete/R');
  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'completed');
  assert.equal(download.absentSince, null);
  db.close();
});

test('an import failure on a completed row fails the download rather than retrying forever', async () => {
  const db = openTestDatabase();
  seedDownload(db, {
    id: 1,
    status: 'completed',
    clientRef: 'nzo_1',
    storagePath: '/pickarr/complete/R',
  });

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

test('an import failure says so in the log, not only in the row', async () => {
  // The row is what the UI reads; the log is what an operator watching a
  // deployment reads. The first single-file storage path failed every pick
  // silently — the reason was visible on one screen and nowhere else.
  const db = openTestDatabase();
  seedDownload(db, {
    id: 1,
    status: 'completed',
    clientRef: 'nzo_1',
    storagePath: '/pickarr/complete/R',
  });

  const lines: string[] = [];
  await reconcileClient({
    db,
    client: fakeClient(EMPTY),
    now: () => 1000,
    log: (message) => lines.push(message),
    importDownload: async () => {
      throw new Error('ENOTDIR: not a directory, scandir ...');
    },
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /import failed for download 1: ENOTDIR/);
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
        category: OURS,
      },
    ],
    complete: true,
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
test('a download in a transient client state keeps its status, and its absence mark is retracted', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1', absentSince: 500 });
  const client = fakeClient({
    queue: [],
    history: [
      {
        ref: 'nzo_1',
        name: 'R',
        outcome: 'in-progress',
        storagePath: null,
        failMessage: null,
        category: OURS,
      },
    ],
    complete: true,
  });

  const result = await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'downloading');
  assert.equal(download.error, null);
  assert.equal(download.absentSince, null);
  assert.equal(result.failed, 0);
  assert.equal(result.imported, 0);
  assert.equal(result.absent, 0);
  db.close();
});

test('a download with a genuine terminal failure status still fails, distinct from in-progress', async () => {
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
        failMessage: 'Failed',
        category: OURS,
      },
    ],
    complete: true,
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
    history: [finished('nzo_1', null)],
    complete: true,
  });

  await reconcileClient(deps(db, client, imported));

  assert.equal(getDownload(db, 1)?.status, 'failed');
  assert.equal(imported.length, 0);
  db.close();
});

// A job mid-transition is listed in history as `Completed` while the queue
// still holds it. Iterating history and then the queue would import it on the
// history reading and set the very same row back to `downloading` on the queue
// reading, in one tick. The queue wins instead: acting a tick late on a
// completion is harmless, acting early on one is not.
test('a job listed in both the queue and history is read as still queued, not imported', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [queued('nzo_1')],
    history: [finished('nzo_1', '/sab/complete/R')],
    complete: true,
  });

  const result = await reconcileClient(deps(db, client, imported));

  assert.equal(imported.length, 0);
  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'downloading');
  assert.equal(download.storagePath, null);
  assert.equal(result.imported, 0);
  db.close();
});

// --- Absence is an observation, never a verdict -----------------------------
//
// The tests these replace asserted that a download missing from the client for
// three consecutive polls was failed as `disappeared-from-client`. That is the
// behaviour of the 2026-08-15 incident, not a property worth keeping: SABnzbd
// was holding all 35 of those jobs, and the list they were "missing" from had
// been silently truncated to ten entries.

test('a row absent from a complete snapshot records when the absence began, once', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient(EMPTY);

  const first = await reconcileClient(deps(db, client, [], 1000));
  assert.equal(getDownload(db, 1)?.absentSince, 1000);
  assert.equal(first.absent, 1);

  // Still missing a tick later. The mark answers "when did this begin", so the
  // original timestamp stands — a plain assignment would make a download that
  // has been gone for hours read as gone for ten seconds, forever.
  const second = await reconcileClient(deps(db, client, [], 9000));
  assert.equal(getDownload(db, 1)?.absentSince, 1000);
  assert.equal(second.absent, 1, 'still counted as missing, even though the mark is unchanged');
  assert.equal(getDownload(db, 1)?.status, 'downloading');
  db.close();
});

// The single most important test in this change. An incomplete snapshot is
// exactly what the incident was: a view Pickarr could not prove was the whole
// picture, read as evidence that 35 downloads had disappeared. A snapshot that
// does not know itself to be complete may advance the rows it *does* contain
// and may never be read as saying anything is missing.
test('a row absent from an INCOMPLETE snapshot is left completely alone', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const lines: string[] = [];

  const result = await reconcileClient({
    db,
    client: fakeClient({ queue: [], history: [], complete: false }),
    now: () => 1000,
    log: (message) => lines.push(message),
    importDownload: async () => {},
  });

  const download = getDownload(db, 1)!;
  assert.equal(download.absentSince, null, 'an unprovable view cannot establish absence');
  assert.equal(download.status, 'downloading');
  assert.equal(download.error, null);
  assert.equal(result.absent, 0);
  assert.equal(result.failed, 0);
  // Silently skipping the sweep would make an incomplete snapshot look exactly
  // like a complete one in which nothing was missing.
  assert.match(lines.join('\n'), /snapshot incomplete, skipping the absence sweep/);
  db.close();
});

test('an absence mark already standing survives an incomplete snapshot rather than being cleared', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1', absentSince: 500 });

  await reconcileClient(deps(db, fakeClient({ queue: [], history: [], complete: false }), [], 1000));

  assert.equal(getDownload(db, 1)?.absentSince, 500);
  db.close();
});

test('a previously absent row seen again has its absence mark cleared', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });

  await reconcileClient(deps(db, fakeClient(EMPTY), [], 1000));
  assert.equal(getDownload(db, 1)?.absentSince, 1000);

  await reconcileClient(
    deps(db, fakeClient({ queue: [queued('nzo_1')], history: [], complete: true }), [], 2000),
  );

  assert.equal(getDownload(db, 1)?.absentSince, null, 'reappearing retracts the observation');
  assert.equal(getDownload(db, 1)?.status, 'downloading');
  db.close();
});

test('no number of absent ticks ever fails a download', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient(EMPTY);

  for (let tick = 0; tick < 25; tick += 1) {
    const result = await reconcileClient(deps(db, client, [], 1000 + tick));
    const download = getDownload(db, 1)!;
    assert.equal(download.status, 'downloading', `tick ${tick}`);
    assert.equal(download.error, null, `tick ${tick}`);
    assert.equal(result.failed, 0, `tick ${tick}`);
  }

  // And the row is still active, so it is still looked for: absence leaves the
  // download recoverable forever rather than terminating it.
  assert.equal(getDownload(db, 1)?.absentSince, 1000);
  db.close();
});

// --- Recovering a download the client turns out to have all along -----------

test('the incident: a row failed as disappeared-from-client is re-attached to its finished job and imported', async () => {
  const db = openTestDatabase();
  seedDownload(db, {
    id: 1,
    status: 'failed',
    clientRef: 'nzo_1',
    error: 'disappeared-from-client',
    absentSince: 500,
  });
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [],
    history: [finished('nzo_1', '/sab/complete/R')],
    complete: true,
  });

  const result = await reconcileClient(deps(db, client, imported));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'completed');
  assert.equal(download.storagePath, '/pickarr/complete/R');
  assert.equal(download.error, null, 'the failure that stranded it is retracted, not left standing');
  assert.equal(download.absentSince, null);
  assert.equal(imported.length, 1);
  assert.equal(result.imported, 1);
  db.close();
});

test('recovering a stranded download is one status write and one advance, not two', async () => {
  // The re-attachment corrects the ref and the error; the status it lands in is
  // whatever the client says, written once. Routing it through `downloading`
  // first would write a status no reader ever observes and would report the
  // first tick after deploy as 70 advances for 35 recovered downloads.
  //
  // Observed with a trigger rather than by inspection, because the intermediate
  // write is invisible from the outside: it is overwritten within the same tick,
  // so only something watching the column can tell one write from two.
  const db = openTestDatabase();
  seedDownload(db, {
    id: 1,
    status: 'failed',
    clientRef: 'nzo_1',
    error: 'disappeared-from-client',
  });
  db.exec('CREATE TABLE status_writes (status TEXT)');
  db.exec(`CREATE TRIGGER record_status AFTER UPDATE OF status ON downloads
           BEGIN INSERT INTO status_writes (status) VALUES (NEW.status); END`);
  const client = fakeClient({
    queue: [],
    history: [finished('nzo_1', '/sab/complete/R')],
    complete: true,
  });

  const result = await reconcileClient(deps(db, client));

  assert.deepEqual(
    db
      .prepare('SELECT status FROM status_writes')
      .all()
      .map((row) => String(row['status'])),
    ['completed'],
    'straight to what the client says it is, with no intermediate downloading write',
  );
  assert.equal(result.advanced, 1, 'one recovery is one advance');
  assert.equal(getDownload(db, 1)?.error, null, 'and the stranding error is still retracted');
  assert.equal(getDownload(db, 1)?.clientRef, 'nzo_1');
  db.close();
});

test('a row that failed for any other reason is left failed, however finished its job looks', async () => {
  const db = openTestDatabase();
  const reason = 'Repair failed, not enough repair blocks (92 short)';
  seedDownload(db, { id: 1, status: 'failed', clientRef: 'nzo_1', error: reason });
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [],
    history: [finished('nzo_1', '/sab/complete/R')],
    complete: true,
  });

  const result = await reconcileClient(deps(db, client, imported));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'failed');
  assert.equal(download.error, reason, 'untouched: resurrecting this is a different decision');
  assert.equal(download.storagePath, null);
  assert.equal(imported.length, 0);
  // Ours, so not an orphan either — recognised and deliberately left alone.
  assert.equal(result.untracked.length, 0);
  db.close();
});

test('a client ref that no longer matches is corrected from the label rather than being fatal', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_stale' });
  const client = fakeClient({
    queue: [queued('nzo_current', clientJobName('Some.Release.Title', 1))],
    history: [],
    complete: true,
  });

  const result = await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.clientRef, 'nzo_current');
  assert.equal(download.status, 'downloading');
  assert.equal(result.untracked.length, 0, 'a job of ours is never an orphan');
  db.close();
});

test('two entries carrying one label import that download once, not twice', async () => {
  // Only reachable for jobs submitted before the double-submit guard existed,
  // but the cost of getting it wrong is high: the second import would run
  // against files the first had already moved and would fail a download that
  // had in fact just succeeded.
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_a' });
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [],
    history: [
      finished('nzo_a', '/sab/complete/R'),
      finished('nzo_b', '/sab/complete/R', clientJobName('Some.Release.Title', 1)),
    ],
    complete: true,
  });

  const result = await reconcileClient(deps(db, client, imported));

  assert.equal(imported.length, 1);
  assert.equal(result.imported, 1);
  assert.equal(getDownload(db, 1)?.clientRef, 'nzo_a', 'the ref match wins');
  assert.equal(result.untracked.length, 0, 'the duplicate is ours, not an orphan');
  db.close();
});

test('a ref and a label naming different downloads takes the ref, and says so once', async () => {
  resetReconcileWarningsForTests();
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  seedDownload(db, { id: 2, status: 'downloading', clientRef: 'nzo_2' });
  const client = fakeClient({
    // The ref belongs to download 1; the label claims download 2.
    queue: [queued('nzo_1', clientJobName('Some.Release.Title', 2))],
    history: [],
    complete: true,
  });
  const warnMock = mock.method(console, 'warn', () => {});

  try {
    await reconcileClient(deps(db, client, [], 1000));
    await reconcileClient(deps(db, client, [], 2000));

    const disagreements = warnMock.mock.calls
      .map((call) => String(call.arguments[0] ?? ''))
      .filter((message) => message.includes('by ref but download'));
    assert.equal(disagreements.length, 1, 'once per process, not once per tick');
    assert.match(disagreements[0] ?? '', /job nzo_1 matches download 1 by ref but download 2/);
  } finally {
    warnMock.mock.restore();
  }

  // Download 1 keeps the ref that is genuinely its own, and download 2 is not
  // silently re-pointed at someone else's job.
  assert.equal(getDownload(db, 1)?.clientRef, 'nzo_1');
  assert.equal(getDownload(db, 2)?.clientRef, 'nzo_2');
  db.close();
});

test('a queued download with no client ref is retried', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'queued', clientRef: null });
  const client = fakeClient(EMPTY, { addUrl: async () => 'nzo_retry' });

  const result = await reconcileClient(deps(db, client));

  const download = getDownload(db, 1)!;
  assert.equal(download.status, 'downloading');
  assert.equal(download.clientRef, 'nzo_retry');
  // The ref was minted after the snapshot was taken, so the snapshot's silence
  // about it says nothing and must not be recorded as absence.
  assert.equal(download.absentSince, null);
  assert.equal(result.absent, 0);
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

// --- Untracked entries ------------------------------------------------------

test('entries with no matching row are reported as untracked and never imported', async () => {
  const db = openTestDatabase();
  const imported: DownloadRow[] = [];
  const client = fakeClient({
    queue: [{ ref: 'foreign_1', name: 'Someone Elses', percentage: 12, category: OURS }],
    // A completed entry with no matching row must be decided unknown *before*
    // anything looks at what the client says happened to it: taking the
    // completed branch would try to import a download that does not exist.
    history: [finished('foreign_2', '/sab/complete/X', 'Also Not Ours')],
    complete: true,
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

test('untracked reporting is filtered to our own category', async () => {
  // The snapshot is unfiltered — that is what makes its completeness checkable
  // — so it holds every job on the server. Reporting all of it as orphaned
  // Pickarr work would make the untracked panel useless on a shared client.
  const db = openTestDatabase();
  const client = fakeClient({
    queue: [
      { ref: 'ours', name: 'Ours', percentage: 5, category: OURS },
      { ref: 'theirs', name: 'Radarr Job', percentage: 5, category: 'movies' },
      { ref: 'nobodys', name: 'Hand Dropped Nzb', percentage: 5, category: null },
    ],
    history: [],
    complete: true,
  });

  const result = await reconcileClient(deps(db, client));

  assert.deepEqual(
    result.untracked.map((entry) => entry.ref),
    ['ours'],
  );
  db.close();
});

test('a job of ours re-categorised at the client is still matched and reconciled', async () => {
  // Matching is category-blind on purpose: a job moved to another category is
  // still the job this download submitted, and the incident's own root cause
  // was trusting a category-filtered view.
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
        category: 'somebody-elses-category',
      },
    ],
    complete: true,
  });

  const result = await reconcileClient(deps(db, client, imported));

  assert.equal(getDownload(db, 1)?.storagePath, '/pickarr/complete/R');
  assert.equal(imported.length, 1);
  assert.equal(result.untracked.length, 0);
  db.close();
});

test('an already-imported download still in history is not reported as untracked', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'imported', clientRef: 'nzo_1' });
  const client = fakeClient({
    queue: [],
    history: [finished('nzo_1', '/sab/x')],
    complete: true,
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
    history: [finished('nzo_1', '/sab/x')],
    complete: true,
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
    {
      queue: [queued('nzo_orphan', clientJobName('Some.Release.Title', 1), 5)],
      history: [],
      complete: true,
    },
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
        finished('nzo_finished', '/sab/complete/R', clientJobName('Some.Release.Title', 1)),
      ],
      complete: true,
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
    {
      queue: [queued('nzo_orphan', clientJobName('Some.Release.Title', 1), 1)],
      history: [],
      complete: true,
    },
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
// (renames jobs once it has parsed the actual nzb, say), the label match
// simply never fires and every retry regresses to the pre-fix double-submit
// risk — with no test failure, since the fakes here stub the name directly
// rather than round-tripping it through a real client. The warning below is
// what turns that silent regression into a visible one.

test('a tracked download whose client-side name does not match its label warns exactly once, not once per tick', async () => {
  resetReconcileWarningsForTests();
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient({
    queue: [queued('nzo_1', 'Some.Release.Name', 10)],
    history: [],
    complete: true,
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
  resetReconcileWarningsForTests();
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'downloading', clientRef: 'nzo_1' });
  const client = fakeClient({
    // A real client reports the title-plus-marker name, not the bare label.
    queue: [queued('nzo_1', clientJobName('T', 1), 10)],
    history: [],
    complete: true,
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
      history: [finished('nzo-done', '/sab/x', 'Scene [pickarr-1]')],
      complete: true,
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
    {
      queue: [queued('nzo-live', 'Scene [pickarr-1]', 40)],
      history: [],
      complete: true,
    },
    { remove },
  );

  await reconcileClient({ db, client, now: () => 2000, importDownload: async () => {} });
  assert.deepEqual(removed, [], 'a running job must survive the tick');
});

test('a failed download is left in the client for inspection', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'failed', clientRef: 'nzo-bad', error: 'Out of retention' });
  const { removed, remove } = removalTracking();
  const client = fakeClient(
    {
      queue: [],
      history: [
        {
          ref: 'nzo-bad',
          name: 'Scene [pickarr-1]',
          outcome: 'failed',
          storagePath: null,
          failMessage: null,
          category: OURS,
        },
      ],
      complete: true,
    },
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
      history: [finished('nzo-stranger', '/sab/y', 'Someone Elses Job')],
      complete: true,
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
      history: [finished('nzo-now', '/sab/x', 'Scene [pickarr-1]')],
      complete: true,
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

/** Records what the cleanup pass asked the filesystem to delete. */
function directoryTracking(): {
  deleted: string[];
  rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
} {
  const deleted: string[] = [];
  return {
    deleted,
    rm: (path) => {
      deleted.push(path);
      return Promise.resolve();
    },
  };
}

function importedWithStorage(db: DatabaseSync, storagePath: string): void {
  seedDownload(db, { id: 1, status: 'imported', clientRef: 'nzo-done', storagePath });
}

const DONE = {
  queue: [],
  history: [finished('nzo-done', '/sab/x', 'Scene [pickarr-1]')],
  complete: true,
};

test('the job directory goes too — the client empties it but leaves it standing', async () => {
  const db = openTestDatabase();
  importedWithStorage(db, '/downloads/Scene.1080p [pickarr-1]');
  const { deleted, rm } = directoryTracking();

  await reconcileClient({
    db,
    client: fakeClient(DONE, { remove: async () => {} }),
    now: () => 2000,
    rm,
    importDownload: async () => {},
  });

  assert.deepEqual(deleted, ['/downloads/Scene.1080p [pickarr-1]']);
  db.close();
});

test('a storage path naming the file removes the directory holding it', async () => {
  // The single-file shape SABnzbd reports for a one-video job.
  const db = openTestDatabase();
  importedWithStorage(db, '/downloads/Scene.1080p [pickarr-1]/scene.mp4');
  const { deleted, rm } = directoryTracking();

  await reconcileClient({
    db,
    client: fakeClient(DONE, { remove: async () => {} }),
    now: () => 2000,
    rm,
    importDownload: async () => {},
  });

  assert.deepEqual(deleted, ['/downloads/Scene.1080p [pickarr-1]']);
  db.close();
});

test('an unlabelled directory is never deleted, and the refusal is logged', async () => {
  // A client configured without per-job folders puts completed files straight
  // into the category directory, shared with every other job. Deleting that
  // parent because it happens to hold our file would take everything with it.
  const db = openTestDatabase();
  importedWithStorage(db, '/downloads/complete/scene.mp4');
  const { deleted, rm } = directoryTracking();
  const lines: string[] = [];

  await reconcileClient({
    db,
    client: fakeClient(DONE, { remove: async () => {} }),
    now: () => 2000,
    rm,
    log: (message) => lines.push(message),
    importDownload: async () => {},
  });

  assert.deepEqual(deleted, []);
  assert.match(lines.join('\n'), /left its directory in place/);
  db.close();
});

test("another download's label is not this one's licence to delete", async () => {
  const db = openTestDatabase();
  importedWithStorage(db, '/downloads/Other.Scene [pickarr-99]');
  const { deleted, rm } = directoryTracking();

  await reconcileClient({
    db,
    client: fakeClient(DONE, { remove: async () => {} }),
    now: () => 2000,
    rm,
    importDownload: async () => {},
  });

  assert.deepEqual(deleted, []);
  db.close();
});

test('a directory is only removed once the client has let the job go', async () => {
  // Order matters: the client deletes the files it knows about, and only then
  // is the folder ours to remove. A removal that never happened leaves the
  // directory alone so the next tick can try the whole sequence again.
  const db = openTestDatabase();
  importedWithStorage(db, '/downloads/Scene.1080p [pickarr-1]');
  const { deleted, rm } = directoryTracking();

  await reconcileClient({
    db,
    client: fakeClient(DONE, { remove: () => Promise.reject(new Error('connection refused')) }),
    now: () => 2000,
    rm,
    importDownload: async () => {},
  });

  assert.deepEqual(deleted, []);
  db.close();
});

test('a directory that will not delete is logged, not fatal', async () => {
  const db = openTestDatabase();
  importedWithStorage(db, '/downloads/Scene.1080p [pickarr-1]');
  const lines: string[] = [];

  const result = await reconcileClient({
    db,
    client: fakeClient(DONE, { remove: async () => {} }),
    now: () => 2000,
    rm: () => Promise.reject(new Error('EACCES')),
    log: (message) => lines.push(message),
    importDownload: async () => {},
  });

  assert.equal(result.removed, 1, 'the client entry did go');
  assert.equal(getDownload(db, 1)?.status, 'imported');
  assert.match(lines.join('\n'), /could not remove \/downloads\/Scene\.1080p \[pickarr-1\]: EACCES/);
  db.close();
});

test('the real filesystem, with no injected rm and a directory that is not empty', async () => {
  // Everything above fakes `rm`. This exercises the default — what actually
  // runs on a server — and on a directory with leftovers in it, which is the
  // state SABnzbd leaves behind when `del_files` misses something.
  const root = await mkdtemp(join(tmpdir(), 'pickarr-cleanup-'));
  try {
    const jobDir = join(root, 'Scene.1080p [pickarr-1]');
    await mkdir(jobDir, { recursive: true });
    await writeFile(join(jobDir, 'leftover.nzb'), 'x');

    const db = openTestDatabase();
    importedWithStorage(db, join(jobDir, 'scene.mp4'));

    await reconcileClient({
      db,
      client: fakeClient(DONE, { remove: async () => {} }),
      now: () => 2000,
      importDownload: async () => {},
    });

    const survived = await stat(jobDir).then(
      () => true,
      () => false,
    );
    assert.equal(survived, false);
    // And only that directory: its parent is untouched.
    assert.deepEqual(await readdir(root), []);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a removal that fails does not undo the import, and is retried next tick', async () => {
  const db = openTestDatabase();
  seedDownload(db, { id: 1, status: 'imported', clientRef: 'nzo-done' });
  let attempts = 0;
  const client = fakeClient(
    {
      queue: [],
      history: [finished('nzo-done', '/sab/x', 'Scene [pickarr-1]')],
      complete: true,
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
