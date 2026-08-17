### Task 1: Release-scoped live-file selector, and movers for `downloads` and `imported_files`

The merge has to move two more tables than `moveReleasesToGroup` covers, and it has to trash files belonging to *a release* rather than to *all-but-one-download*.

**Files:**
- Modify: `packages/core/src/db/imported-files.ts` (add after `liveFilesForGroup`, ~line 95)
- Modify: `packages/core/src/db/groups.ts` (add beside `moveReleasesToGroup`, ~line 545)
- Test: `packages/core/test/db/imported-files.test.ts` (create)
- Test: `packages/core/test/db/groups.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `liveFilesForOtherReleases(db: DatabaseSync, groupId: number, keepReleaseId: number | null): ImportedFileRow[]`
  - `moveDownloadsToGroup(db: DatabaseSync, fromGroupId: number, toGroupId: number): void`
  - `moveImportedFilesToGroup(db: DatabaseSync, fromGroupId: number, toGroupId: number): void`

- [ ] **Step 1: Write the failing test for the release-scoped selector**

Create `packages/core/test/db/imported-files.test.ts`. The critical case is the last one — it is the reason this function exists instead of reusing `liveFilesForGroup`'s download-scoped exclusion.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { liveFilesForOtherReleases } from '../../src/db/imported-files.ts';

/**
 * Group 1 holds releases 1 and 2. Release 1 imported twice — downloads 1 and 3,
 * a retry — which is the whole point of this fixture: a release-scoped question
 * must keep *both* of release 1's files, and a download-scoped one cannot.
 */
function seed(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"T","fields":[]}', 't', 'picked', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://i.invalid/1.nzb', 100),
            (2, 'f', 'g2', 'T2', 'https://i.invalid/2.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":1080}', 1080, 100),
            (2, 1, 2, '{"resolution":2160}', 2160, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'initial', 'imported', 100, 100),
            (2, 2, 1, 'sab', 'upgrade', 'imported', 100, 100),
            (3, 1, 1, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, trashed_at, created_at)
     VALUES (1, 1, 1, '/dl/a.mp4', '/library/a.mp4', 10, NULL, 100),
            (2, 2, 1, '/dl/b.mp4', '/library/b.mp4', 20, NULL, 100),
            (3, 3, 1, '/dl/c.mp4', '/library/c.mp4', 30, NULL, 100),
            (4, 1, 1, '/dl/d.mp4', '/library/d.mp4', 40, 500,  100)`,
  ).run();
}

test('liveFilesForOtherReleases returns the files of every release but the kept one', () => {
  const db = openTestDatabase();
  seed(db);

  const rows = liveFilesForOtherReleases(db, 1, 2);

  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 3],
  );
});

test('liveFilesForOtherReleases skips files already trashed', () => {
  const db = openTestDatabase();
  seed(db);

  const rows = liveFilesForOtherReleases(db, 1, 2);

  assert.ok(!rows.some((row) => row.id === 4), 'row 4 is trashed and must not be returned');
});

test('liveFilesForOtherReleases with no kept release returns every live file', () => {
  const db = openTestDatabase();
  seed(db);

  const rows = liveFilesForOtherReleases(db, 1, null);

  assert.deepEqual(
    rows.map((row) => row.id),
    [1, 2, 3],
  );
});

/**
 * The bug that ruled out reusing `liveFilesForGroup(db, groupId, downloadId)`.
 * Release 1 imported across downloads 1 and 3; excluding one download would
 * offer up the other's file for trashing, and that file belongs to the release
 * being kept.
 */
test('a release that imported twice keeps both of its files when it is the kept one', () => {
  const db = openTestDatabase();
  seed(db);

  const rows = liveFilesForOtherReleases(db, 1, 1);

  assert.deepEqual(
    rows.map((row) => row.id),
    [2],
    'only release 2s file is trashable; both of release 1s must survive',
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:server -- --test-name-pattern="liveFilesForOtherReleases|imported twice"`

Expected: FAIL — `liveFilesForOtherReleases` is not exported from `imported-files.ts`.

- [ ] **Step 3: Implement the selector**

In `packages/core/src/db/imported-files.ts`, after `liveFilesForGroup`:

```ts
/**
 * Live files in a group belonging to any release *other* than the one named.
 *
 * Scoped by release, not by download, and that distinction is the reason this
 * exists alongside `liveFilesForGroup`'s `excludeDownloadId`. A release that
 * imported twice — a retry — has two `downloads` rows, so excluding one of them
 * would hand back the other's file as trashable even though it belongs to the
 * release being kept. The join is what makes the question answerable at all:
 * `imported_files` records the download, and only `downloads` knows the release.
 *
 * A null `keepReleaseId` keeps nothing, which is the honest reading of "there is
 * no surviving pick" — every live file in the group is then superseded.
 */
export function liveFilesForOtherReleases(
  db: DatabaseSync,
  groupId: number,
  keepReleaseId: number | null,
): ImportedFileRow[] {
  const sql = `
    SELECT f.id, f.download_id, f.group_id, f.source_path, f.dest_path, f.size_bytes,
           f.trashed_at, f.trash_path, f.created_at
      FROM imported_files f
      JOIN downloads d ON d.id = f.download_id
     WHERE f.group_id = ? AND f.trashed_at IS NULL
       AND (? IS NULL OR d.release_id != ?)
     ORDER BY f.id
  `;
  return db
    .prepare(sql)
    .all(groupId, keepReleaseId, keepReleaseId)
    .map((row) => toRow(row as SqlRow));
}
```

- [ ] **Step 4: Write the failing test for the two movers**

Append to `packages/core/test/db/groups.test.ts`:

```ts
test('moveDownloadsToGroup and moveImportedFilesToGroup repoint both tables', () => {
  const db = openTestDatabase();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"A","fields":[]}', 'a', 'picked', 100, 100),
            (2, 'test', 'k2', '{"title":"B","fields":[]}', 'b', 'new',    100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://i.invalid/1.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{}', 1080, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (1, 1, 1, '/dl/a.mp4', '/library/a.mp4', 10, 100)`,
  ).run();

  moveDownloadsToGroup(db, 1, 2);
  moveImportedFilesToGroup(db, 1, 2);

  assert.equal(num(db.prepare('SELECT group_id FROM downloads WHERE id = 1').get() as SqlRow, 'group_id'), 2);
  assert.equal(
    num(db.prepare('SELECT group_id FROM imported_files WHERE id = 1').get() as SqlRow, 'group_id'),
    2,
  );
});
```

Add `moveDownloadsToGroup`, `moveImportedFilesToGroup` to the existing `../../src/db/groups.ts` import in that file, and `num`/`SqlRow` from `../../src/db/row.ts` if not already imported.

- [ ] **Step 5: Run it and confirm it fails**

Run: `npm run test:server -- --test-name-pattern="repoint both tables"`

Expected: FAIL — neither mover is exported.

- [ ] **Step 6: Implement the movers**

In `packages/core/src/db/groups.ts`, immediately after `moveReleasesToGroup`:

```ts
/**
 * The rest of a merge, and the reason the merge is now allowed at all.
 *
 * `moveReleasesToGroup` alone leaves `downloads` and `imported_files` pointing at
 * a group that is about to be deleted, which is exactly what made the old
 * refusal necessary. Both tables reference `group_id`, so both must move before
 * `deleteGroup` — and both belong in the same transaction as the release move
 * for the reason stated above it.
 *
 * Migration 4 already moves these three tables together when it collapses
 * re-keyed clusters, so this is the established write pattern rather than a new
 * one.
 */
export function moveDownloadsToGroup(
  db: DatabaseSync,
  fromGroupId: number,
  toGroupId: number,
): void {
  db.prepare('UPDATE downloads SET group_id = ? WHERE group_id = ?').run(toGroupId, fromGroupId);
}

/**
 * `dest_path` deliberately stands. This repoints the *record*; where the file
 * actually is on disk is unchanged by it, and phase 3 of the identity change is
 * what reconciles the two. Rewriting the path here would make the row lie for
 * as long as it took the rename to happen.
 */
export function moveImportedFilesToGroup(
  db: DatabaseSync,
  fromGroupId: number,
  toGroupId: number,
): void {
  db.prepare('UPDATE imported_files SET group_id = ? WHERE group_id = ?').run(
    toGroupId,
    fromGroupId,
  );
}
```

- [ ] **Step 7: Run the full server suite**

Run: `npm run test:server`

Expected: PASS, with the four new selector tests and the mover test included.

- [ ] **Step 8: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test
git add packages/core/src/db/imported-files.ts packages/core/src/db/groups.ts \
        packages/core/test/db/imported-files.test.ts packages/core/test/db/groups.test.ts
```

Report the staged files. Do not commit without explicit approval.

---

