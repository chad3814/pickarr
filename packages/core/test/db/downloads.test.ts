import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { installLabelToken } from '../../src/db/app-state.ts';
import {
  openDatabase,
  openTestDatabase,
  TEST_LABEL_TOKEN,
  TEST_LABEL_TOKEN_MINTED_AT,
} from '../../src/db/open.ts';
import {
  bumpAttempts,
  clearAbsent,
  clientJobName,
  type DownloadStatus,
  downloadLabel,
  extractLabel,
  failDownload,
  getDownload,
  indexDownloadsForClient,
  insertDownload,
  labelsFor,
  latestDownloadsForGroup,
  latestDownloadsForGroups,
  markAbsent,
  pageOfDownloads,
  recordError,
  resetForRetry,
  setClientRef,
  setImportPlan,
  setStatus,
  setStoragePath,
} from '../../src/db/downloads.ts';
import { getGroup } from '../../src/db/groups.ts';

const BAD_ID = 9999;

/** What `openTestDatabase` pre-mints, as `labelsFor` and friends want it. */
const SCHEME = { token: TEST_LABEL_TOKEN, mintedAt: TEST_LABEL_TOKEN_MINTED_AT };

function seed(db: DatabaseSync): number {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g', 'Title', 'https://indexer.invalid/1.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES (1, 'test', 'k', '{}', 't', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 100, 1)`,
  ).run();
  return insertDownload(db, {
    releaseId: 1,
    groupId: 1,
    clientId: 'sab',
    kind: 'initial',
    createdAt: 1,
  });
}

test('setClientRef throws by name and id rather than silently no-opping on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => setClientRef(db, BAD_ID, 'nzo_1', 2), /setClientRef.*9999/);
  db.close();
});

test('setStatus throws on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => setStatus(db, BAD_ID, 'imported', 2), /setStatus.*9999/);
  db.close();
});

test('setStoragePath throws on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => setStoragePath(db, BAD_ID, '/tmp/x', 2), /setStoragePath.*9999/);
  db.close();
});

test('failDownload throws on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => failDownload(db, BAD_ID, 'boom', 2), /failDownload.*9999/);
  db.close();
});

test('failDownload also re-derives the group upgrade flag, so a failed release stops being advertised', () => {
  const db = openTestDatabase();
  const id = seed(db);
  // A second, better release, flagged as the upgrade on offer.
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (2, 'f', 'g2', 'Better', 'https://indexer.invalid/2.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (2, 1, 2, '{}', 200, 1)`,
  ).run();
  db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = 1, upgrade_release_id = 2 WHERE id = 1",
  ).run();
  const upgrade = insertDownload(db, {
    releaseId: 2,
    groupId: 1,
    clientId: 'sab',
    kind: 'upgrade',
    createdAt: 2,
  });

  failDownload(db, upgrade, 'Repair failed, not enough repair blocks (92 short)', 3);

  // Not at some later unrelated write: at the moment of failure. Advertising
  // "Upgrade available" for a release that has just proved undownloadable is
  // the loop this closes.
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, null);
  assert.equal(getDownload(db, id)?.status, 'queued', 'the unrelated download is untouched');
  db.close();
});

test('failDownload moves the group to the top of the list by stamping list_rank_at', () => {
  const db = openTestDatabase();
  const id = seed(db);
  db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = 1 WHERE id = 1",
  ).run();

  failDownload(db, id, 'Repair failed, not enough repair blocks (92 short)', 3);

  // The failure's own timestamp, not a sentinel and not left alone. This is how
  // the group becomes findable on Picks — the list orders on this column and
  // nothing else, so a failure that did not write it would leave the group
  // wherever it already was, which for a group picked weeks ago is nowhere the
  // user will look. And because it is a timestamp rather than a flag, every
  // later event that stamps another group moves this one down; see
  // `test/db/picks-order.test.ts` for that half.
  assert.equal(getGroup(db, 1)?.listRankAt, 3);
  db.close();
});

test('failDownload is atomic: a failure re-deriving the flag rolls the status write back', () => {
  // The status write and the re-derivation are two statements, and the comment
  // on `failDownload` claims they are one instant. Without a transaction that
  // is false for a crash landing between them, which is exactly the stale-flag
  // state the re-derivation exists to prevent — the download reads `failed`
  // while the group still advertises the release that failed.
  //
  // The abort is injected at the database rather than by stubbing, because the
  // second statement is reached through an import that no seam exposes. A
  // trigger that raises on the `media_groups` update is the same shape of
  // failure a crash produces: the first statement has run, the second cannot.
  const db = openTestDatabase();
  const id = seed(db);
  db.prepare(
    "UPDATE media_groups SET state = 'picked', picked_release_id = 1 WHERE id = 1",
  ).run();
  db.exec(`CREATE TRIGGER no_flag BEFORE UPDATE ON media_groups
           BEGIN SELECT RAISE(ABORT, 'flag write refused'); END`);

  assert.throws(() => failDownload(db, id, 'Repair failed', 3), /flag write refused/);

  // Rolled back whole. Left un-transacted this reads 'failed'.
  assert.equal(getDownload(db, id)?.status, 'queued');
  assert.equal(getDownload(db, id)?.error, null);
  db.close();
});

test('recordError throws on a bad id', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => recordError(db, BAD_ID, 'boom', 2), /recordError.*9999/);
  db.close();
});

test('bumpAttempts throws on a bad id instead of returning 0', () => {
  const db = openTestDatabase();
  seed(db);
  assert.throws(() => bumpAttempts(db, BAD_ID, 2), /bumpAttempts.*9999/);
  db.close();
});

test('bumpAttempts increments and returns the new count for a real row', () => {
  const db = openTestDatabase();
  const id = seed(db);
  assert.equal(bumpAttempts(db, id, 2), 1);
  assert.equal(bumpAttempts(db, id, 3), 2);
  db.close();
});

// --- absent_since: absence as an observation, not a verdict ----------------

/**
 * A second download on the same group, for tests that need more than one
 * row. A separate feed item and release because `releases.feed_item_id` is
 * NOT NULL UNIQUE, same as `seed`'s.
 */
function seedSecond(db: DatabaseSync, id: number): number {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, 'Title', ?, 1)`,
  ).run(id, `g${id}`, `https://indexer.invalid/${id}.nzb`);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (?, 1, ?, '{}', 100, 1)`,
  ).run(id, id);
  return insertDownload(db, {
    releaseId: id,
    groupId: 1,
    clientId: 'sab',
    kind: 'initial',
    createdAt: 1,
  });
}

test('markAbsent sets absent_since, and a second call with a later now leaves the original value', () => {
  const db = openTestDatabase();
  const id = seed(db);
  markAbsent(db, id, 5);
  assert.equal(getDownload(db, id)?.absentSince, 5);

  // The `WHERE absent_since IS NULL` guard is the entire point of this
  // function: without it, every tick a job stays missing would push the
  // timestamp forward, and "how long has this been gone" would always read
  // "just now".
  markAbsent(db, id, 9);
  assert.equal(getDownload(db, id)?.absentSince, 5, 'the original absence time is preserved');
  db.close();
});

test('clearAbsent clears absent_since and is a no-op when already null', () => {
  const db = openTestDatabase();
  const id = seed(db);

  assert.doesNotThrow(() => clearAbsent(db, id));
  assert.equal(getDownload(db, id)?.absentSince, null);

  markAbsent(db, id, 5);
  clearAbsent(db, id);
  assert.equal(getDownload(db, id)?.absentSince, null);
  db.close();
});

test('absentSince round-trips through getDownload as null and as a number', () => {
  const db = openTestDatabase();
  const id = seed(db);
  assert.equal(getDownload(db, id)?.absentSince, null);
  markAbsent(db, id, 42);
  assert.equal(getDownload(db, id)?.absentSince, 42);
  db.close();
});

test('resetForRetry clears absent_since so a retry does not inherit a stale absence mark', () => {
  const db = openTestDatabase();
  const id = seed(db);
  markAbsent(db, id, 5);
  resetForRetry(db, id, 10);
  assert.equal(getDownload(db, id)?.absentSince, null);
  db.close();
});

const PLAN = '[{"source":"/complete/Release/scene.mp4","destination":"scene.mp4"}]';

test('setStoragePath drops a committed import plan, because the plan named the old directory', () => {
  const db = openTestDatabase();
  const id = seed(db);
  setStoragePath(db, id, '/complete/Release', 2);
  setImportPlan(db, id, PLAN);

  // Reconcile rewrites the path whenever the client disagrees with the row —
  // a remote-path mapping corrected in config is enough. Every source in a
  // committed plan is an absolute path into the directory it was resolved
  // against, so a plan surviving that rewrite would be applied to a directory
  // it does not describe.
  setStoragePath(db, id, '/mnt/complete/Release', 3);

  assert.equal(getDownload(db, id)?.importPlan, null);
  db.close();
});

test('resetForRetry keeps a committed import plan when the download directory survives', () => {
  const db = openTestDatabase();
  const id = seed(db);
  setStoragePath(db, id, '/complete/Release', 2);
  setImportPlan(db, id, PLAN);
  failDownload(db, id, 'killed mid-import', 3);

  const reset = resetForRetry(db, id, 10);

  // A storage path means only the import has to be redone, against the same
  // directory the plan was resolved from — which is the whole case a stored
  // plan exists for.
  assert.equal(reset?.status, 'completed');
  assert.equal(reset?.importPlan, PLAN);
  db.close();
});

test('resetForRetry drops a committed import plan when the files will be fetched again', () => {
  const db = openTestDatabase();
  const id = seed(db);
  setImportPlan(db, id, PLAN);
  failDownload(db, id, 'disappeared-from-client', 3);

  const reset = resetForRetry(db, id, 10);

  // No storage path, so the client downloads again and the directory the
  // stored plan names is not the one the next import will read. Keeping it
  // would mean applying a plan to the wrong directory.
  assert.equal(reset?.status, 'queued');
  assert.equal(reset?.importPlan, null);
  db.close();
});

test('indexDownloadsForClient.byRef includes failed rows and excludes imported rows, keyed on client_ref', () => {
  const db = openTestDatabase();
  const kept = seed(db); // will be 'downloading'
  const failed = seedSecond(db, 2);
  const imported = seedSecond(db, 3);

  setClientRef(db, kept, 'nzo_kept', 1);
  setClientRef(db, failed, 'nzo_failed', 1);
  failDownload(db, failed, 'disappeared-from-client', 2);
  setClientRef(db, imported, 'nzo_imported', 1);
  setStatus(db, imported, 'imported', 2);

  const { byRef } = indexDownloadsForClient(db, 'sab', SCHEME);
  assert.deepEqual([...byRef.keys()].toSorted(), ['nzo_failed', 'nzo_kept']);
  assert.equal(byRef.get('nzo_kept')?.id, kept);
  assert.equal(byRef.get('nzo_failed')?.id, failed);
  assert.equal(byRef.has('nzo_imported'), false);
  db.close();
});

test('indexDownloadsForClient.byLabel keys on the salted label for the same row set as byRef', () => {
  const db = openTestDatabase();
  const kept = seed(db);
  const imported = seedSecond(db, 2);

  setClientRef(db, kept, 'nzo_kept', 1);
  setClientRef(db, imported, 'nzo_imported', 1);
  setStatus(db, imported, 'imported', 2);

  const { byLabel } = indexDownloadsForClient(db, 'sab', SCHEME);
  assert.deepEqual([...byLabel.keys()], [downloadLabel(TEST_LABEL_TOKEN, kept)]);
  assert.equal(byLabel.get(downloadLabel(TEST_LABEL_TOKEN, kept))?.id, kept);
  db.close();
});

test('indexDownloadsForClient builds both maps from one query: a kept row is the same object in byRef and byLabel', () => {
  const db = openTestDatabase();
  const kept = seed(db);
  setClientRef(db, kept, 'nzo_kept', 1);

  const { byRef, byLabel } = indexDownloadsForClient(db, 'sab', SCHEME);
  // Strict identity, not just equal values: this is what a single query
  // building both maps from one row array actually guarantees, and what a
  // second, separately-run query could not — two queries would give two
  // distinct row objects with the same field values, and this assertion
  // would still pass on that broken version if it only checked deepEqual.
  assert.equal(byRef.get('nzo_kept'), byLabel.get(downloadLabel(TEST_LABEL_TOKEN, kept)));
  db.close();
});

// --- The per-installation salt ------------------------------------------
//
// A label used to be `pickarr-<id>` and nothing else, so its whole namespace
// was one database's rowid sequence. These pin the three properties the salt
// has to have for #28 to stay closed: it is stable within an installation,
// distinct between installations, and it does not strand the jobs already at
// the client when it first appears.

test('installLabelToken mints once and answers the same token on every later call', () => {
  const db = openDatabase(':memory:');
  const first = installLabelToken(db, 1_700_000_000_000);
  const second = installLabelToken(db, 1_700_000_999_999);

  assert.equal(second.token, first.token);
  // `mintedAt` matters more than the token: it is what bounds legacy-label
  // acceptance, so a second call re-stamping it would quietly make every
  // existing row legacy-eligible again.
  assert.equal(second.mintedAt, first.mintedAt);
  assert.equal(first.mintedAt, 1_700_000_000_000);
  assert.match(first.token, /^[0-9a-f]{8}$/);
  db.close();
});

test('two databases mint different tokens, which is the whole of what the salt buys', () => {
  // Not `openTestDatabase`: that pre-mints a fixed token so job names stay
  // writable as literals, and a fixed token is exactly what this is about.
  const a = openDatabase(':memory:');
  const b = openDatabase(':memory:');

  assert.notEqual(installLabelToken(a, 1).token, installLabelToken(b, 1).token);
  a.close();
  b.close();
});

test('a marker written before the salt existed still parses', () => {
  // The read pattern has to keep accepting the unsalted shape or every job
  // already at the client becomes unrecognisable the moment this ships.
  // Whether an unsalted label is *believed* is `labelsFor`'s decision, not
  // this one.
  assert.equal(
    extractLabel(clientJobName(TEST_LABEL_TOKEN, 'T', 7)),
    downloadLabel(TEST_LABEL_TOKEN, 7),
  );
  assert.equal(extractLabel('T [pickarr-7]'), 'pickarr-7');
});

test('labelsFor admits the legacy label only for a row older than the token', () => {
  const db = openTestDatabase();
  const id = seed(db);

  const before = { ...getDownload(db, id)!, createdAt: TEST_LABEL_TOKEN_MINTED_AT - 1 };
  assert.deepEqual(labelsFor(SCHEME, before), [
    downloadLabel(TEST_LABEL_TOKEN, id),
    `pickarr-${id}`,
  ]);

  // Exactly one, and this assertion is the cheap alarm on the bound: a row
  // created after the token was minted was submitted under a salted label, so
  // an unsalted marker naming its id came from somewhere else. If `mintedAt`
  // is ever overwritten, or the comparison loosened, this is what fails.
  const after = { ...getDownload(db, id)!, createdAt: TEST_LABEL_TOKEN_MINTED_AT + 1 };
  assert.deepEqual(labelsFor(SCHEME, after), [downloadLabel(TEST_LABEL_TOKEN, id)]);
});

// --- The job-name round trip --------------------------------------------
//
// `extractLabel` is anchored at the end of whatever name the client reports
// and has no way to tell one occurrence of the marker shape from another, so
// the write side owes the read side an invariant: no name Pickarr sends a
// client carries the marker shape anywhere except as its own trailing
// marker. Once that holds, a client that truncates a name can only ever cut
// the marker off — `extractLabel` answers null, the unrecognised-entry case
// `warnIfLabelMismatch` exists for — and can never expose a second one.

const HOSTILE_TITLES = [
  // The dangerous position: a title that itself ends in the marker shape, so
  // a truncation at exactly the title's own length reads as a whole job name
  // belonging to download 2.
  'Site.25.01.02.Scene [pickarr-2]',
  // The same shape mid-string. Not the issue's case, and worth keeping
  // because it turns out not to be safe either: a deeper truncation, one
  // that also removes the text after the decoy, leaves the decoy trailing
  // just the same. Position in the title only decides which offset is
  // dangerous, not whether one exists.
  'A [pickarr-2] B',
  // A title that is nothing but the shape.
  '[pickarr-77]',
  // Spaces inside the brackets, which `LABEL_MARKER_PATTERN` does not read.
  // This offends nothing today; it is here to pin that the sanitiser is
  // deliberately wider than the pattern it defends.
  'Weird [ pickarr-3 ] thing',
  'Ordinary.Site.25.01.02.Scene.1080p',
];

test('no truncation of a job name can read as a label other than the one it was minted for', () => {
  for (const title of HOSTILE_TITLES) {
    const name = clientJobName(TEST_LABEL_TOKEN, title, 1);
    // Every prefix rather than one hand-picked offset: the claim is about
    // truncation in general, not about the one offset the issue reported.
    for (let end = 0; end <= name.length; end += 1) {
      const prefix = name.slice(0, end);
      const label = extractLabel(prefix);
      assert.ok(
        label === null || label === downloadLabel(TEST_LABEL_TOKEN, 1),
        `${JSON.stringify(name)} truncated to ${JSON.stringify(prefix)} reads as ${label}`,
      );
    }
  }
});

test('a title already ending in the marker shape has it removed rather than escaped', () => {
  assert.equal(
    clientJobName(TEST_LABEL_TOKEN, 'Site.25.01.02.Scene [pickarr-2]', 1),
    'Site.25.01.02.Scene [pickarr-7e57ab1e-1]',
  );
});

test('a marker shape removed from the middle of a title leaves no double space behind', () => {
  assert.equal(
    clientJobName(TEST_LABEL_TOKEN, 'A [pickarr-2] B', 1),
    'A B [pickarr-7e57ab1e-1]',
  );
});

test('a title that was nothing but a marker shape becomes the bare marker, still recoverable', () => {
  assert.equal(clientJobName(TEST_LABEL_TOKEN, '[pickarr-77]', 1), '[pickarr-7e57ab1e-1]');
  assert.equal(
    extractLabel(clientJobName(TEST_LABEL_TOKEN, '[pickarr-77]', 1)),
    downloadLabel(TEST_LABEL_TOKEN, 1),
  );
});

// The cheapest signal that the sanitiser has not started eating ordinary
// titles: this name is byte-identical to what the unsanitised version sent.
test('an ordinary title pays nothing: its job name is the title and the marker', () => {
  assert.equal(
    clientJobName(TEST_LABEL_TOKEN, 'Ordinary.Release.1080p', 1),
    'Ordinary.Release.1080p [pickarr-7e57ab1e-1]',
  );
});

/**
 * Three more downloads on top of `seed`'s, each on a release of its own: ids 2
 * and 3 share `created_at` 5, id 4 sits alone at 4, and `seed`'s id 1 at 1.
 *
 * The tie is the whole point. It is the only arrangement that can tell this
 * list's descending id tiebreak from the ascending one `browseGroups` uses,
 * and getting that wrong skips or repeats a row silently rather than failing
 * anywhere a reader would see.
 */
function seedForPaging(db: DatabaseSync): void {
  for (const [id, createdAt] of [
    [2, 5],
    [3, 5],
    [4, 4],
  ] as const) {
    db.prepare(
      `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
       VALUES (?, 'f', ?, 'Title', 'https://indexer.invalid/n.nzb', 1)`,
    ).run(id, `g${id}`);
    db.prepare(
      `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
       VALUES (?, 1, ?, '{}', 100, 1)`,
    ).run(id, id);
    db.prepare(
      `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                              attempts, created_at, updated_at)
       VALUES (?, ?, 1, 'sab', 'initial', 'downloading', 0, ?, ?)`,
    ).run(id, id, createdAt, createdAt);
  }
}

test('pageOfDownloads breaks a created_at tie on descending id', () => {
  const db = openTestDatabase();
  seed(db);
  seedForPaging(db);

  const first = pageOfDownloads(db, { cursor: null, limit: 1 });
  assert.deepEqual(first.map((download) => download.id), [3], 'newest first, highest id in a tie');

  // The cursor names the tie's higher id, so the row after it is the *lower*
  // one sharing that `created_at`. `browseGroups` and `dismissedFeedItems`
  // both compare `id >` inside a tie and this list has to compare `id <`; a copy of
  // either would answer id 4 here and lose id 2 for good.
  const second = pageOfDownloads(db, { cursor: { createdAt: 5, id: 3 }, limit: 2 });
  assert.deepEqual(second.map((download) => download.id), [2, 4]);
  db.close();
});

test('paging pageOfDownloads one row at a time visits every row exactly once', () => {
  // The tie test above says which row comes next; this one says the walk as a
  // whole neither skips nor repeats, which is the failure a wrong tiebreak
  // actually produces for a reader.
  const db = openTestDatabase();
  seed(db);
  seedForPaging(db);

  const seen: number[] = [];
  let cursor: { createdAt: number; id: number } | null = null;
  for (;;) {
    const page = pageOfDownloads(db, { cursor, limit: 1 });
    const row = page[0];
    if (row === undefined) break;
    seen.push(row.id);
    cursor = { createdAt: row.createdAt, id: row.id };
  }

  assert.deepEqual(seen, [3, 2, 4, 1]);
  db.close();
});

test('pageOfDownloads returns at most limit rows and nothing past the end', () => {
  const db = openTestDatabase();
  seed(db);
  seedForPaging(db);

  assert.equal(pageOfDownloads(db, { cursor: null, limit: 2 }).length, 2);
  assert.equal(pageOfDownloads(db, { cursor: null, limit: 99 }).length, 4);
  // The oldest row's own cursor: there is nothing older, and an empty page is
  // how the route learns to answer `nextCursor: null`.
  assert.deepEqual(pageOfDownloads(db, { cursor: { createdAt: 1, id: 1 }, limit: 99 }), []);
  db.close();
});

// --- latestDownloadsForGroup / latestDownloadsForGroups ------------------

let seedReleaseSeq = 0;

/**
 * A group and a release, each on a feed item of its own — `seed` and
 * `seedSecond` above hardcode a single group's ids, but the batched-form
 * tests below need several independent groups in the same database, so this
 * lets SQLite assign every id via rowid instead of naming them.
 */
function seedRelease(db: DatabaseSync): { groupId: number; releaseId: number } {
  seedReleaseSeq += 1;
  const n = seedReleaseSeq;
  const feedItemResult = db
    .prepare(
      `INSERT INTO feed_items (feed_id, guid, raw_title, link, first_seen_at)
       VALUES ('f', ?, 'Title', ?, 1)`,
    )
    .run(`latest-${n}`, `https://indexer.invalid/latest-${n}.nzb`);
  const feedItemId = Number(feedItemResult.lastInsertRowid);

  const groupResult = db
    .prepare(
      `INSERT INTO media_groups (plugin, identity_key, display, search_text, created_at, list_rank_at)
       VALUES ('test', ?, '{}', 't', 1, 1)`,
    )
    .run(`latest-${n}`);
  const groupId = Number(groupResult.lastInsertRowid);

  const releaseResult = db
    .prepare(
      `INSERT INTO releases (group_id, feed_item_id, quality, score, created_at)
       VALUES (?, ?, '{}', 100, 1)`,
    )
    .run(groupId, feedItemId);
  const releaseId = Number(releaseResult.lastInsertRowid);

  return { groupId, releaseId };
}

/**
 * A download row with an explicit status and `updated_at`, for tests that
 * need to control both independently of `insertDownload`'s always-`'queued'`-
 * at-`createdAt` shape.
 */
function seedDownload(
  db: DatabaseSync,
  opts: { groupId: number; releaseId: number; status: DownloadStatus; updatedAt?: number },
): number {
  const result = db
    .prepare(
      `INSERT INTO downloads (release_id, group_id, client_id, kind, status, created_at, updated_at)
       VALUES (?, ?, 'sab', 'initial', ?, 1, ?)`,
    )
    .run(opts.releaseId, opts.groupId, opts.status, opts.updatedAt ?? 1);
  return Number(result.lastInsertRowid);
}

test('the latest download of a release is the highest id, not the newest updated_at', () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seedRelease(db);
  // The failure is the *earlier* attempt and is stamped LATER, which is exactly
  // the shape `updated_at` gets wrong: a stalled retry polls, so its updated_at
  // can trail the failure it replaced.
  const first = seedDownload(db, { groupId, releaseId, status: 'failed', updatedAt: 9_000 });
  const second = seedDownload(db, { groupId, releaseId, status: 'downloading', updatedAt: 1_000 });
  assert.ok(second > first, 'ids are monotonic');

  const latest = latestDownloadsForGroup(db, groupId).get(releaseId);
  assert.equal(latest?.downloadId, second);
  assert.equal(latest?.status, 'downloading');
  db.close();
});

test('a release with no download is absent from the map rather than present and empty', () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seedRelease(db);
  const map = latestDownloadsForGroup(db, groupId);
  assert.equal(map.has(releaseId), false);
  assert.equal(map.size, 0);
  db.close();
});

test('error and absentSince come back as null rather than undefined when unset', () => {
  const db = openTestDatabase();
  const { groupId, releaseId } = seedRelease(db);
  seedDownload(db, { groupId, releaseId, status: 'queued' });
  const latest = latestDownloadsForGroup(db, groupId).get(releaseId);
  // null, not undefined: the view type says `string | null`, and a JSON payload
  // carrying undefined drops the key entirely.
  assert.equal(latest?.error, null);
  assert.equal(latest?.absentSince, null);
  db.close();
});

test('the batched form answers many groups in one query and keeps them apart', () => {
  const db = openTestDatabase();
  const a = seedRelease(db);
  const b = seedRelease(db);
  seedDownload(db, { groupId: a.groupId, releaseId: a.releaseId, status: 'imported' });
  seedDownload(db, { groupId: b.groupId, releaseId: b.releaseId, status: 'failed' });

  const map = latestDownloadsForGroups(db, [a.groupId, b.groupId]);
  assert.equal(map.get(a.groupId)?.get(a.releaseId)?.status, 'imported');
  assert.equal(map.get(b.groupId)?.get(b.releaseId)?.status, 'failed');
  // A group asked about but holding nothing gets an entry, so a caller can tell
  // "asked, nothing there" from "never asked".
  assert.equal(map.get(a.groupId)?.has(b.releaseId), false);
  db.close();
});

test('the batched form asked about nothing returns an empty map without touching the db', () => {
  const db = openTestDatabase();
  assert.equal(latestDownloadsForGroups(db, []).size, 0);
  db.close();
});

test('a group asked about with no downloads at all gets an empty entry, not a missing one', () => {
  const db = openTestDatabase();
  const withDownload = seedRelease(db);
  const withNothing = seedRelease(db);
  seedDownload(db, {
    groupId: withDownload.groupId,
    releaseId: withDownload.releaseId,
    status: 'downloading',
  });

  const map = latestDownloadsForGroups(db, [withDownload.groupId, withNothing.groupId]);
  // Present and empty — not absent. A caller distinguishes "asked, nothing
  // downloading" from "never asked" on exactly this, and Task 6 stops polling
  // a group on the strength of it.
  assert.equal(map.has(withNothing.groupId), true);
  assert.equal(map.get(withNothing.groupId)?.size, 0);
  db.close();
});
