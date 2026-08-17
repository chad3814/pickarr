# Editing the Identity of an Already-Downloaded Group — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human correct the identity of a group that has already been downloaded or imported — including merging it into an existing group — showing every consequence for confirmation first, and renaming the files already in the library to match.

**Architecture:** `editGroup` splits into a read-only async **planner** (`manual/identity-plan.ts`) that works out every consequence and stats the filesystem, and an **applier** that runs four ordered phases: re-plan and compare digests, one synchronous database transaction, trash the superseded pick's files, then rename surviving files one at a time. The database is truthful at every instant, because phase 1 commits before anything on disk moves and each later file updates its own row immediately after its own move.

**Tech Stack:** TypeScript (ESM, Node ≥24), `node:sqlite` (synchronous), Fastify, Zod, React 19 + Vite, `node:test` via tsx, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md`

## Global Constraints

- **Never use the `any` or `unknown` TypeScript types.** Where a value's shape is genuinely open, define an interface for it.
- 2-space indent; always terminate statements with semicolons.
- Prefer the async form of any API over its synchronous twin. Specifically: `crypto.subtle.digest`, not `createHash`; `fs.promises`, not `fs.*Sync`. The one exception is `node:sqlite`, which has no async form — its transactions are synchronous by nature, which is *why* the design keeps file I/O outside them.
- Tests are `node:test` + `node:assert/strict`. Server tests: `npm run test:server`. Web tests: `npm run test:web`. Both: `npm run test`.
- Full gate before any task is called done: `npm run lint`, `npm run typecheck`, `npm run test` (all three via `npm run check`), plus `npm run build`. The e2e task additionally runs `npm run e2e`.
- Comments in this codebase explain **why**, not what. Match that density — every non-obvious ordering decision gets a comment giving its reason.
- Do **not** commit unless the human has explicitly approved it. Each task's final step stages the files and *stops*, reporting what is ready.

---

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

### Task 2: Refactor `trashLiveFiles` to take the rows it should trash

**Files:**
- Modify: `packages/core/src/pipeline/upgrade.ts:86-95` (signature and the `liveFilesForGroup` call)
- Modify: `packages/core/src/pipeline/import.ts:368-375` (the one existing caller)
- Test: `packages/core/test/pipeline/upgrade.test.ts` (extend)

**Interfaces:**
- Consumes: `liveFilesForOtherReleases` from Task 1 (used by Task 7, not here).
- Produces: `trashFiles(db, files: readonly ImportedFileRow[], libraryRootReal: string, trashDir: string, groupId: number, now: number): Promise<string | null>` — returns the trash directory it created, or `null` when `files` is empty.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/pipeline/upgrade.test.ts`. Follow the file's existing `mkdtemp` setup for `libraryRoot`/`trashDir`.

```ts
test('trashFiles moves exactly the rows it is given and marks them trashed', async () => {
  const db = openTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'pickarr-trash-'));
  const libraryRoot = join(root, 'library');
  const trashDir = join(root, 'trash');
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(join(libraryRoot, 'keep.mp4'), 'keep');
  await writeFile(join(libraryRoot, 'go.mp4'), 'go');

  seedTwoImportedFiles(db, join(libraryRoot, 'keep.mp4'), join(libraryRoot, 'go.mp4'));
  const libraryRootReal = await realpath(libraryRoot);
  const doomed = liveFilesForOtherReleases(db, 1, 1);

  const destination = await trashFiles(db, doomed, libraryRootReal, trashDir, 1, 7000);

  assert.notEqual(destination, null);
  assert.equal(await lstatOrNull(join(libraryRoot, 'keep.mp4')) === null, false, 'keep.mp4 stays');
  assert.equal(await lstatOrNull(join(libraryRoot, 'go.mp4')), null, 'go.mp4 is gone');
  const rows = filesForGroup(db, 1);
  assert.equal(rows.find((row) => row.destPath.endsWith('keep.mp4'))?.trashedAt, null);
  assert.equal(rows.find((row) => row.destPath.endsWith('go.mp4'))?.trashedAt, 7000);
});

test('trashFiles given no rows creates no trash directory', async () => {
  const db = openTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'pickarr-trash-'));
  const trashDir = join(root, 'trash');

  const destination = await trashFiles(db, [], root, trashDir, 1, 7000);

  assert.equal(destination, null);
  assert.equal(await lstatOrNull(trashDir), null, 'nothing to trash means no directory');
});
```

Write `seedTwoImportedFiles(db, keepPath, goPath)` in that file: one group, two releases (1 and 2), one download each, one `imported_files` row each pointing at the two paths, release 1 owning `keep.mp4`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:server -- --test-name-pattern="trashFiles"`

Expected: FAIL — `trashFiles` is not exported from `upgrade.ts`.

- [ ] **Step 3: Change the signature**

In `packages/core/src/pipeline/upgrade.ts`, replace the `trashLiveFiles` declaration and its first two lines. Everything inside the `try` block stays exactly as it is — the loop body, the two refusals, the EXDEV fallback, `markTrashed`, and the catch.

```ts
/**
 * Moves the given files out of the library and marks their rows trashed.
 *
 * Takes rows rather than deriving them, because two callers need two different
 * questions answered and neither is a special case of the other. An upgrade
 * import trashes everything live in the group *except its own download's* files
 * (`liveFilesForGroup`), since on a retry those describe files it just placed.
 * An identity change trashes the files of every release *except the surviving
 * pick's* (`liveFilesForOtherReleases`) — and a release that imported twice
 * makes those two questions give different answers, so deriving either one in
 * here would be wrong for the other caller.
 *
 * `groupId` is now only used to name the trash directory. It is still a
 * parameter rather than read off the rows: the rows may be empty, and a caller
 * that knows the group should not have to prove it by finding a row.
 */
export async function trashFiles(
  db: DatabaseSync,
  files: readonly ImportedFileRow[],
  libraryRootReal: string,
  trashDir: string,
  groupId: number,
  now: number,
): Promise<string | null> {
  if (files.length === 0) return null;

  const destinationDir = join(trashDir, String(groupId), String(now));
  await mkdir(destinationDir, { recursive: true });

  try {
    for (const file of files) {
      // ... existing loop body, unchanged ...
```

Rename the loop's iteration source from `live` to `files`. Add `import type { ImportedFileRow } from '../db/imported-files.ts';` and drop the `liveFilesForGroup` import if nothing else in the file uses it.

- [ ] **Step 4: Update the one existing caller**

In `packages/core/src/pipeline/import.ts`, replace the `trashLiveFiles` call at ~line 368:

```ts
      trashedTo = await trashFiles(
        db,
        // Unchanged in effect: everything live in this group except this
        // download's own files, which on a retry are ones this import already
        // placed. See trashFiles for why the selector now lives at the call
        // site.
        liveFilesForGroup(db, download.groupId, download.id),
        libraryRootReal,
        deps.trashDir,
        download.groupId,
        now,
      );
```

Update the imports at the top of `import.ts`: `trashFiles` from `./upgrade.ts`, and add `liveFilesForGroup` to the existing `../db/imported-files.ts` import.

- [ ] **Step 5: Run the affected suites**

Run: `npm run test:server -- --test-name-pattern="trashFiles|upgrade|import"`

Expected: PASS. The pre-existing upgrade and import tests must pass **unchanged** — that is the evidence the refactor preserved behaviour.

- [ ] **Step 6: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/pipeline/upgrade.ts packages/core/src/pipeline/import.ts \
        packages/core/test/pipeline/upgrade.test.ts
```

---

### Task 3: Expose the file mover for reuse inside the library

The rename must not grow a second file mover — `transfer` already handles the atomic rename, the EXDEV fallback, and the real-path containment check.

**Files:**
- Modify: `packages/core/src/pipeline/import.ts:137` (`resolveDestination`), `:272` (`transfer`)
- Test: `packages/core/test/pipeline/import.test.ts` (extend)

**Interfaces:**
- Produces:
  - `export function resolveDestination(libraryRoot: string, destination: string): string` (add `export` to the existing function)
  - `export async function moveWithinLibrary(from: string, to: string, libraryRootReal: string, renameImpl?: RenameLike): Promise<void>`
  - `export type RenameLike` (already defined in this file; add `export` if absent)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/pipeline/import.test.ts`:

```ts
test('moveWithinLibrary moves a file and keeps it inside the library root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickarr-move-'));
  const libraryRoot = join(root, 'library');
  await mkdir(join(libraryRoot, 'Old'), { recursive: true });
  await writeFile(join(libraryRoot, 'Old', 'scene.mp4'), 'data');
  const libraryRootReal = await realpath(libraryRoot);

  await moveWithinLibrary(
    join(libraryRoot, 'Old', 'scene.mp4'),
    join(libraryRoot, 'New', '2026-08-14 - Title.mp4'),
    libraryRootReal,
  );

  assert.equal(await readFile(join(libraryRoot, 'New', '2026-08-14 - Title.mp4'), 'utf8'), 'data');
  assert.equal(await lstatOrNull(join(libraryRoot, 'Old', 'scene.mp4')), null);
});

test('moveWithinLibrary falls back to copy when rename reports EXDEV', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickarr-move-'));
  const libraryRoot = join(root, 'library');
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(join(libraryRoot, 'a.mp4'), 'data');
  const libraryRootReal = await realpath(libraryRoot);

  await moveWithinLibrary(
    join(libraryRoot, 'a.mp4'),
    join(libraryRoot, 'b.mp4'),
    libraryRootReal,
    () => Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' })),
  );

  assert.equal(await readFile(join(libraryRoot, 'b.mp4'), 'utf8'), 'data');
  assert.equal(await lstatOrNull(join(libraryRoot, 'a.mp4')), null, 'the source is removed');
});

test('moveWithinLibrary refuses a destination outside the library root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickarr-move-'));
  const libraryRoot = join(root, 'library');
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(join(libraryRoot, 'a.mp4'), 'data');
  const libraryRootReal = await realpath(libraryRoot);

  await assert.rejects(
    moveWithinLibrary(join(libraryRoot, 'a.mp4'), join(root, 'escaped.mp4'), libraryRootReal),
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:server -- --test-name-pattern="moveWithinLibrary"`

Expected: FAIL — not exported.

- [ ] **Step 3: Add `export` and the named wrapper**

In `packages/core/src/pipeline/import.ts`, add `export` to `resolveDestination` and to the `RenameLike` type if it is not already exported. Then, immediately after `transfer`:

```ts
/**
 * Moves a file from one place in the library to another.
 *
 * A thin, named wrapper over `transfer` in `'move'` mode, and named because the
 * caller's intent matters: an identity change relocates a file that is *already*
 * in the library, so the mode is never a configuration question. `importMode`
 * decides how a file arrives from the download volume; copying inside the
 * library would leave two copies of one file and a record of one.
 */
export async function moveWithinLibrary(
  from: string,
  to: string,
  libraryRootReal: string,
  renameImpl: RenameLike = rename,
): Promise<void> {
  await transfer(from, to, 'move', renameImpl, libraryRootReal);
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm run test:server -- --test-name-pattern="moveWithinLibrary"`

Expected: PASS (all three).

- [ ] **Step 5: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/pipeline/import.ts packages/core/test/pipeline/import.test.ts
```

---

### Task 4: Give the manual operations a library to write to

The planner and applier need `trashDir` and an injectable `rename`. `ServerDeps` does not carry `trashDir` today; `config.trashDir` exists and `main.ts` is where it is read.

**Files:**
- Modify: `packages/core/src/manual/operations.ts:32-37` (`ManualDeps`)
- Modify: `packages/core/src/http/server.ts:63-90` (`ServerDeps`), `:320-325` (the `manual` object)
- Modify: `packages/core/src/main.ts:293-312` (the `buildServer` call)
- Test: `packages/core/test/manual/operations.test.ts:102-109` (`makeDeps`), `packages/core/test/http/server.test.ts` (its `buildServer` fixture)

**Interfaces:**
- Produces: `ManualDeps` gains `trashDir: string` and `rename?: RenameLike`; `ServerDeps` gains `trashDir: string`.

- [ ] **Step 1: Extend `ManualDeps`**

```ts
export interface ManualDeps {
  db: DatabaseSync;
  registry: PluginRegistry;
  pluginForFeed(feedId: string): MediaTypePlugin | null;
  now(): number;
  /**
   * Where a superseded pick's files go when an identity change merges two
   * groups. The same directory an upgrade import trashes into, and for the same
   * reason: one scene ends up with one owned file, and the other is recoverable
   * by hand rather than deleted.
   */
  trashDir: string;
  /** Injectable so a test can fail one rename mid-loop. Defaults to `fs.rename`. */
  rename?: RenameLike;
}
```

Add `import type { RenameLike } from '../pipeline/import.ts';`.

- [ ] **Step 2: Extend `ServerDeps` and the `manual` object**

In `server.ts`, add to `ServerDeps`:

```ts
  /**
   * `config.trashDir`, passed in rather than re-read here for the same reason
   * `artworkDir` is: this module has no other business knowing the config
   * document's shape, and a second read is how the two copies drift.
   */
  trashDir: string;
```

and to the `manual` object at line 320:

```ts
  const manual: ManualDeps = {
    db,
    registry: deps.registry,
    pluginForFeed: (feedId) => deps.pluginForFeed(feedId),
    now: () => deps.now(),
    trashDir: deps.trashDir,
  };
```

- [ ] **Step 3: Wire it in `main.ts`**

Add `trashDir: config.trashDir,` to the `buildServer({ … })` object, beside `artworkDir`.

- [ ] **Step 4: Update the two test fixtures**

In `packages/core/test/manual/operations.test.ts`, `makeDeps` gains `trashDir: '/trash'`. In `packages/core/test/http/server.test.ts`, the `buildServer` fixture gains `trashDir`. Use the temp directory the file already creates if it has one; otherwise `'/trash'` is fine, because no test in this task's scope reaches it.

- [ ] **Step 5: Confirm nothing broke**

Run: `npm run typecheck && npm run test`

Expected: PASS. This task adds no behaviour; a green suite is the whole assertion.

- [ ] **Step 6: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/manual/operations.ts packages/core/src/http/server.ts \
        packages/core/src/main.ts packages/core/test/manual/operations.test.ts \
        packages/core/test/http/server.test.ts
```

---

### Task 5: The planner — classification, counts, and pick reconciliation

Database-only. `renames` and `trashing` come back empty until Task 6; `blockers` and `warnings` empty; the digest is already real.

**Files:**
- Create: `packages/core/src/manual/values.ts`
- Create: `packages/core/src/manual/identity-plan.ts`
- Modify: `packages/core/src/manual/operations.ts` (delete the four helpers now in `values.ts`, import them instead)
- Test: `packages/core/test/manual/identity-plan.test.ts` (create)

**Interfaces:**
- Consumes: `getGroup`, `findGroup`, `releasesForGroup`, `releaseScore` (existing db functions).
- Produces:
  - `values.ts`: `buildRelease`, `mergedValues`, `editHooks`, `mediaFor` — moved verbatim from `operations.ts`, plus
    `resolveIdentityFor(plugin: MediaTypePlugin, group: GroupRow, values: Record<string, string>): { identity: PreparedIdentity } | { error: string; status: 400 | 409 }`
  - `identity-plan.ts`: `IdentityPlan`, `PlannedRename`, `PlannedTrash`, and
    `planIdentityChange(deps: ManualDeps, groupId: number, values: Record<string, string>): Promise<ManualResult<IdentityPlan>>`

- [ ] **Step 1: Move the four helpers into `values.ts`**

Create `packages/core/src/manual/values.ts`. Move `buildRelease`, `mergedValues`, `editHooks` and `mediaFor` out of `operations.ts` **verbatim, comments and all** — they are not being rewritten, only relocated so two modules can share them. Add `export` to each. Then add:

```ts
/**
 * The identity a group would have if these values were saved.
 *
 * The three steps — prefill, merge, rebuild, validate — were inline in
 * `editGroup` when it was the only caller. The planner and the applier must
 * agree exactly about what a set of values *means*, and the cheapest way to
 * guarantee that is for there to be one function that decides.
 *
 * `mediaFor(group, '{}')` passes an empty quality deliberately: a group holds
 * none of its own — quality is release-level — and the plugin contract requires
 * a correct key and display from the identity-scoped values alone.
 */
export function resolveIdentityFor(
  plugin: MediaTypePlugin,
  group: GroupRow,
  values: Record<string, string>,
): { identity: PreparedIdentity } | { error: string; status: 400 | 409 } {
  const hooks = editHooks(plugin);
  if (hooks === null) {
    return { error: `plugin ${plugin.id} does not support manual editing`, status: 409 };
  }

  const merged = mergedValues(plugin, hooks.to, mediaFor(group, '{}'), values);
  if ('error' in merged) return { error: merged.error, status: 400 };

  const built = buildRelease(plugin, hooks.from, merged.values);
  if ('error' in built) return { error: built.error, status: 400 };

  const validated = validateIdentity(built.media);
  if ('error' in validated) return { error: validated.error, status: 400 };

  return { identity: validated.identity };
}
```

In `operations.ts`, import `buildRelease`, `mergedValues`, `editHooks`, `mediaFor` from `./values.ts` — `resolveFeedItem` and `editRelease` still use them.

- [ ] **Step 2: Run the suite to confirm the move changed nothing**

Run: `npm run test:server -- --test-name-pattern="editGroup|editRelease|resolve"`

Expected: PASS, unchanged. A pure relocation that breaks a test means it was not pure.

- [ ] **Step 3: Write the failing planner test**

Create `packages/core/test/manual/identity-plan.test.ts`. Reuse the `PLUGIN`, `registryFor` and `makeDeps` shapes from `operations.test.ts` — copy them in; a shared fixture module is not worth it for two files, and `operations.test.ts` already keeps its own.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { planIdentityChange } from '../../src/manual/identity-plan.ts';
// PLUGIN, makeDeps, ok, failure: copied from operations.test.ts

/**
 * Group 1 is keyed `k1`, picked on release 1 (1080). Group 2 is keyed `k2`,
 * state new, holding release 2 (2160). This is the reported scenario in
 * miniature: correcting group 1's key to `k2` must merge it into group 2.
 */
function seedTwoGroups(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"A","fields":[]}', 'a', 'picked', 1,    100, 100),
            (2, 'test', 'k2', '{"title":"B","fields":[]}', 'b', 'new',    NULL, 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://i.invalid/1.nzb', 100),
            (2, 'f', 'g2', 'T2', 'https://i.invalid/2.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":1080}', 1080, 100),
            (2, 2, 2, '{"resolution":2160}', 2160, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
}

test('an unchanged identity plans nothing', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k1', title: 'A' }));

  assert.equal(plan.kind, 'none');
  assert.equal(plan.mergeInto, null);
  assert.deepEqual(plan.renames, []);
});

test('a changed display alone is display-only', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k1', title: 'Renamed' }));

  assert.equal(plan.kind, 'display-only');
});

test('a key belonging to no group is a rekey', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k9', title: 'A' }));

  assert.equal(plan.kind, 'rekey');
  assert.equal(plan.mergeInto, null);
});

test('a key belonging to another group is a merge, and names it', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.equal(plan.kind, 'merge');
  assert.deepEqual(plan.mergeInto, { id: 2, title: 'B' });
  assert.equal(plan.releasesMoving, 1);
  assert.equal(plan.downloadsMoving, 1);
});

test('an unpicked target adopts the source pick', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.deepEqual(plan.pick.surviving, { releaseId: 1, score: 1080, side: 'source' });
  assert.equal(plan.pick.superseded, null);
});

test('when both sides have a pick the higher score wins', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.deepEqual(plan.pick.surviving, { releaseId: 2, score: 2160, side: 'target' });
  assert.deepEqual(plan.pick.superseded, { releaseId: 1, score: 1080 });
});

test('a tie between two picks goes to the target', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  db.prepare('UPDATE releases SET score = 1080 WHERE id = 2').run();
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.deepEqual(plan.pick.surviving, { releaseId: 2, score: 1080, side: 'target' });
});

test('a pick naming a release the merged group will not hold counts as no pick', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  db.prepare('UPDATE media_groups SET picked_release_id = 999 WHERE id = 1').run();

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.equal(plan.pick.surviving, null);
  assert.equal(plan.pick.superseded, null);
});

test('the digest changes when a displayed field changes', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const first = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (3, 'f', 'g3', 'T3', 'https://i.invalid/3.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (3, 1, 3, '{"resolution":720}', 720, 100)`,
  ).run();
  const second = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.equal(second.releasesMoving, 2);
  assert.notEqual(first.digest, second.digest, 'one more release moving is a material change');
});

test('planning a group that does not exist is 404', async () => {
  const db = openTestDatabase();

  assert.equal(failure(await planIdentityChange(makeDeps(db), 77, { key: 'k1' })).status, 404);
});
```

- [ ] **Step 4: Run and confirm it fails**

Run: `npm run test:server -- --test-name-pattern="plan"`

Expected: FAIL — `identity-plan.ts` does not exist.

- [ ] **Step 5: Implement the planner's database half**

Create `packages/core/src/manual/identity-plan.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { findGroup, getGroup, type GroupRow } from '../db/groups.ts';
import { releasesForGroup } from '../db/releases.ts';
import type { ManualDeps, ManualResult } from './operations.ts';
import { resolveIdentityFor } from './values.ts';

/** One file to be moved because the identity that placed it has changed. */
export interface PlannedRename {
  importedFileId: number;
  from: string;
  to: string;
}

/** One file to be trashed because the release that owns it lost the pick. */
export interface PlannedTrash {
  importedFileId: number;
  path: string;
}

export interface IdentityPlan {
  groupId: number;
  identityKey: string;
  /**
   * `none` — the key and the display both survive the edit.
   * `display-only` — the key survives, the display does not.
   * `rekey` — the key changes and belongs to no other group.
   * `merge` — the key belongs to another group, which will absorb this one.
   */
  kind: 'none' | 'display-only' | 'rekey' | 'merge';
  mergeInto: { id: number; title: string } | null;
  releasesMoving: number;
  downloadsMoving: number;
  pick: {
    surviving: { releaseId: number; score: number; side: 'source' | 'target' } | null;
    superseded: { releaseId: number; score: number } | null;
  };
  renames: readonly PlannedRename[];
  trashing: readonly PlannedTrash[];
  /** Shown, and does not stop the apply. */
  warnings: readonly string[];
  /** Shown, and refuses the apply. */
  blockers: readonly string[];
  digest: string;
}

/**
 * `JSON.stringify` over an object built in a fixed key order, which is what
 * makes this stable — do not reorder the literal in `finish()` below, and do not
 * build it from a spread of something whose order is not fixed.
 *
 * `crypto.subtle`, not `createHash`: this runs on the request path, and the
 * async form is the house rule for anything that would otherwise block the
 * loop.
 */
async function digestOf(plan: Omit<IdentityPlan, 'digest'>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function titleOf(group: GroupRow): string {
  const display = JSON.parse(group.display) as { title?: string };
  return display.title ?? group.identityKey;
}

function countDownloads(db: DatabaseSync, groupId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM downloads WHERE group_id = ?')
    .get(groupId) as { n: number } | undefined;
  return row === undefined ? 0 : Number(row.n);
}

/**
 * The pick the merged group ends up with, and the one it does not.
 *
 * Higher score wins; a tie goes to the target, matching migration 4's rule that
 * the survivor's pick stands. A pick naming a release the merged group will not
 * hold counts as no pick at all — `holds()` in `db/migrations.ts` makes the same
 * call, for the same reason: a dangling pick is already broken, and a merge is
 * the one moment it could be spread rather than merely tolerated.
 */
function reconcilePick(
  db: DatabaseSync,
  source: GroupRow,
  target: GroupRow | null,
): IdentityPlan['pick'] {
  const heldScore = (releaseId: number | null, groupId: number): number | null => {
    if (releaseId === null) return null;
    const row = db
      .prepare('SELECT score FROM releases WHERE id = ? AND group_id = ?')
      .get(releaseId, groupId) as { score: number } | undefined;
    return row === undefined ? null : Number(row.score);
  };

  const sourceScore = heldScore(source.pickedReleaseId, source.id);
  const targetScore = target === null ? null : heldScore(target.pickedReleaseId, target.id);

  if (sourceScore === null && targetScore === null) return { surviving: null, superseded: null };
  if (targetScore === null) {
    return {
      surviving: { releaseId: source.pickedReleaseId!, score: sourceScore!, side: 'source' },
      superseded: null,
    };
  }
  if (sourceScore === null) {
    return {
      surviving: { releaseId: target!.pickedReleaseId!, score: targetScore, side: 'target' },
      superseded: null,
    };
  }

  return sourceScore > targetScore
    ? {
        surviving: { releaseId: source.pickedReleaseId!, score: sourceScore, side: 'source' },
        superseded: { releaseId: target!.pickedReleaseId!, score: targetScore },
      }
    : {
        surviving: { releaseId: target!.pickedReleaseId!, score: targetScore, side: 'target' },
        superseded: { releaseId: source.pickedReleaseId!, score: sourceScore },
      };
}

/**
 * Everything an identity change would do, and nothing done.
 *
 * Reads the database and stats the filesystem; writes neither. Both the preview
 * route and the apply call this, which is the point: the plan a user confirms
 * and the plan that runs are the same computation, so they cannot drift.
 */
export async function planIdentityChange(
  deps: ManualDeps,
  groupId: number,
  values: Record<string, string>,
): Promise<ManualResult<IdentityPlan>> {
  const { db } = deps;
  const group = getGroup(db, groupId);
  if (group === null) return { error: `no such group: ${groupId}`, status: 404 };

  const plugin = deps.registry.byId(group.plugin);
  if (plugin === undefined) {
    return { error: `no plugin loaded for id ${group.plugin}`, status: 409 };
  }

  const resolved = resolveIdentityFor(plugin, group, values);
  if ('error' in resolved) return { error: resolved.error, status: resolved.status };
  const identity = resolved.identity;

  const target =
    identity.identityKey === group.identityKey
      ? null
      : findGroup(db, group.plugin, identity.identityKey);
  const merging = target !== null && target.id !== group.id;

  const kind: IdentityPlan['kind'] = merging
    ? 'merge'
    : identity.identityKey !== group.identityKey
      ? 'rekey'
      : identity.displayJson !== group.display
        ? 'display-only'
        : 'none';

  const pick = merging
    ? reconcilePick(db, group, target)
    : reconcilePick(db, group, null);

  const withoutDigest: Omit<IdentityPlan, 'digest'> = {
    groupId,
    identityKey: identity.identityKey,
    kind,
    mergeInto: merging ? { id: target.id, title: titleOf(target) } : null,
    releasesMoving: merging ? releasesForGroup(db, group.id).length : 0,
    downloadsMoving: merging ? countDownloads(db, group.id) : 0,
    pick,
    renames: [],
    trashing: [],
    warnings: [],
    blockers: [],
  };

  return { ok: { ...withoutDigest, digest: await digestOf(withoutDigest) } };
}
```

Note on the non-null assertions in `reconcilePick`: each is guarded by the `heldScore` result immediately above it — a non-null score can only have come from a non-null release id. If the reviewer prefers, restructure `heldScore` to return `{ releaseId, score } | null`; do **not** reach for `any` or `unknown` to silence it.

- [ ] **Step 6: Run and confirm it passes**

Run: `npm run test:server -- --test-name-pattern="plan"`

Expected: PASS, all eleven.

- [ ] **Step 7: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/manual/values.ts packages/core/src/manual/identity-plan.ts \
        packages/core/src/manual/operations.ts packages/core/test/manual/identity-plan.test.ts
```

---

### Task 6: The planner — renames, trashing, blockers and warnings

**Files:**
- Modify: `packages/core/src/manual/identity-plan.ts` (fill in the four empty arrays)
- Test: `packages/core/test/manual/identity-plan.test.ts` (extend)

**Interfaces:**
- Consumes: `liveFilesForOtherReleases` (Task 1), `resolveDestination` (Task 3), `lstatOrNull` (already exported from `import.ts`).
- Produces: no new exported names; `IdentityPlan.renames`, `.trashing`, `.warnings` and `.blockers` become populated.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/manual/identity-plan.test.ts`. These need a plugin whose `planImport` actually places a file — `PLUGIN` returns `null`, which is correct for a plugin that files nothing and is why the earlier tests were unaffected.

```ts
/**
 * A plugin that files a scene at `<key>/<resolution>.mp4`, so a key change moves
 * every file the group owns and a resolution difference keeps two files apart.
 */
const FILING: MediaTypePlugin = {
  ...PLUGIN,
  planImport: (media, files) => {
    const file = files[0];
    if (file === undefined) return null;
    return {
      files: [
        {
          source: file.absolutePath,
          destination: `${media.identityKey}/${media.quality.resolution ?? 0}.mp4`,
        },
      ],
    };
  },
};

/** Group 1 picked on release 1, with release 1s file imported under `k1/`. */
async function seedWithFile(db: DatabaseSync, libraryRoot: string): Promise<void> {
  seedTwoGroups(db);
  await mkdir(join(libraryRoot, 'k1'), { recursive: true });
  await writeFile(join(libraryRoot, 'k1', '1080.mp4'), 'data');
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (1, 1, 1, '/dl/a.mp4', ?, 4, 100)`,
  ).run(join(libraryRoot, 'k1', '1080.mp4'));
}

test('a merge plans a rename for each live file, under its own releases quality', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.deepEqual(plan.renames, [
    {
      importedFileId: 1,
      from: join(libraryRoot, 'k1', '1080.mp4'),
      to: join(libraryRoot, 'k2', '1080.mp4'),
    },
  ]);
  assert.deepEqual(plan.blockers, []);
});

test('a rename that would not move the file is dropped', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k1', title: 'Renamed' }),
  );

  assert.equal(plan.kind, 'display-only');
  assert.deepEqual(plan.renames, [], 'the template does not read the title, so nothing moves');
});

test('an occupied destination is a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);
  await mkdir(join(libraryRoot, 'k2'), { recursive: true });
  await writeFile(join(libraryRoot, 'k2', '1080.mp4'), 'someone else');

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0]!, /occupied/);
});

test('a destination occupied by a directory is a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);
  await mkdir(join(libraryRoot, 'k2', '1080.mp4'), { recursive: true });

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.equal(plan.blockers.length, 1);
});

test('a file already gone from disk warns and is not renamed', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);
  await rm(join(libraryRoot, 'k1', '1080.mp4'));

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.deepEqual(plan.renames, []);
  assert.equal(plan.warnings.length, 1);
  assert.deepEqual(plan.blockers, []);
});

test('a superseded pick has its files trashed, not renamed', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);
  // Target picks release 2 (2160), which outscores the source's 1080.
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();

  const plan = ok(
    await planIdentityChange(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.deepEqual(plan.trashing, [
    { importedFileId: 1, path: join(libraryRoot, 'k1', '1080.mp4') },
  ]);
  assert.deepEqual(plan.renames, [], 'a file about to be trashed is never also renamed');
});

test('a live file the plugin refuses to place is a blocker', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-plan-'));
  await seedWithFile(db, libraryRoot);

  const plan = ok(
    await planIdentityChange(makeDeps(db, PLUGIN, libraryRoot), 1, { key: 'k2', title: 'A' }),
  );

  assert.equal(plan.blockers.length, 1, 'a file with nowhere to go must not be left stranded');
});
```

`makeDeps` gains a third parameter for the library root: `registryFor` currently hard-codes `'/library'`, so extend it to `registryFor(plugin, libraryRoot = '/library')` and thread it through.

- [ ] **Step 2: Run and confirm they fail**

Run: `npm run test:server -- --test-name-pattern="rename|blocker|trashed, not renamed|gone from disk"`

Expected: FAIL — every array still comes back empty.

- [ ] **Step 3: Implement the file half of the planner**

Add to `identity-plan.ts`:

```ts
/**
 * Where a file already in the library would go under a new identity.
 *
 * Asked of the plugin rather than computed here, and asked per file. The
 * destination must come from the same `planImport` a fresh import would use, or
 * a renamed file and a newly imported one can disagree about where the same
 * scene belongs — and the plugin needs *that file's own release's* quality,
 * because a merged group can hold a 1080p and a 2160p file at once and the path
 * template renders resolution. Using the pick's quality for both would move a
 * file to a path naming a resolution it is not.
 */
function destinationFor(
  plugin: MediaTypePlugin,
  identity: PreparedIdentity,
  quality: string,
  libraryRoot: string,
  file: ImportedFileRow,
): string | null {
  const media: ParsedRelease = {
    identityKey: identity.identityKey,
    display: JSON.parse(identity.displayJson) as ParsedRelease['display'],
    quality: JSON.parse(quality) as ParsedRelease['quality'],
  };
  const plan = plugin.planImport(media, [
    {
      relativePath: basename(file.destPath),
      absolutePath: file.destPath,
      sizeBytes: file.sizeBytes,
    },
  ]);
  const planned = plan?.files[0];
  return planned === undefined ? null : resolveDestination(libraryRoot, planned.destination);
}
```

Then, in `planIdentityChange` after `pick` is computed and before `withoutDigest`, build the four arrays. The ordering inside matters: decide what is trashed first, so a trashed row is excluded from the rename set.

```ts
  const renames: PlannedRename[] = [];
  const trashing: PlannedTrash[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  const libraryRoot = deps.registry.libraryRootById(group.plugin);
  const keepReleaseId = pick.surviving?.releaseId ?? null;

  // Trashing is decided first: a row about to leave the library is not also a
  // row to rename, and moving a file to its new name only to move it to
  // trashDir would report two actions against one file.
  const doomed =
    pick.superseded === null
      ? []
      : liveFilesForOtherReleases(db, pick.superseded.releaseId === keepReleaseId ? -1 : group.id, keepReleaseId);
  for (const file of doomed) {
    trashing.push({ importedFileId: file.id, path: file.destPath });
  }
  const doomedIds = new Set(doomed.map((file) => file.id));

  // Every live file the surviving group will own, from both sides for a merge.
  // The target's own files are already at paths its identity produced — and a
  // merge leaves the target's identity alone — so only the source's can be
  // stale. A rekey has only the one group's.
  for (const file of liveFilesForOtherReleases(db, group.id, null)) {
    if (doomedIds.has(file.id)) continue;

    const quality = qualityForFile(db, file);
    if (quality === null) {
      warnings.push(`imported file ${file.id} has no release on record; leaving it where it is`);
      continue;
    }

    const to = destinationFor(plugin, identity, quality, libraryRoot, file);
    if (to === null) {
      blockers.push(
        `plugin ${plugin.id} will not place ${file.destPath} under the new identity, ` +
          'so renaming it is impossible and leaving it would strand it',
      );
      continue;
    }
    if (to === file.destPath) continue;

    const source = await lstatOrNull(file.destPath);
    if (source === null) {
      warnings.push(`${file.destPath} is already gone from disk; nothing to move`);
      continue;
    }
    if (!source.isFile()) {
      blockers.push(`${file.destPath} is not a regular file; refusing to move it`);
      continue;
    }
    if (!isContained(libraryRoot, file.destPath, false)) {
      blockers.push(`${file.destPath} resolves outside the library root; refusing to move it`);
      continue;
    }

    const occupant = await lstatOrNull(to);
    if (occupant !== null) {
      blockers.push(`${to} is occupied by something this group did not put there`);
      continue;
    }

    renames.push({ importedFileId: file.id, from: file.destPath, to });
  }
```

with one more helper:

```ts
/** The quality of the release an imported file belongs to, through its download. */
function qualityForFile(db: DatabaseSync, file: ImportedFileRow): string | null {
  const row = db
    .prepare(
      `SELECT r.quality AS quality
         FROM downloads d JOIN releases r ON r.id = d.release_id
        WHERE d.id = ?`,
    )
    .get(file.downloadId) as { quality: string } | undefined;
  return row === undefined ? null : String(row.quality);
}
```

Then swap the four empty arrays in `withoutDigest` for `renames`, `trashing`, `warnings`, `blockers`.

Note for the implementer: the `doomed` expression above is deliberately awkward and should be simplified — `liveFilesForOtherReleases(db, groupId, keepReleaseId)` must be asked of **both** the source and the target for a merge, because the superseded pick can be on either side. Restructure it as two calls whose results are concatenated (source always; target only when merging), and drop the `-1` sentinel. The tests in Step 1 cover the source side; add one where the *target* holds the losing pick before you finish.

- [ ] **Step 4: Run and confirm they pass**

Run: `npm run test:server`

Expected: PASS. Existing planner tests from Task 5 must still pass — a group with no `imported_files` rows plans no renames regardless of plugin.

- [ ] **Step 5: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/manual/identity-plan.ts packages/core/test/manual/identity-plan.test.ts
```

---

### Task 7: The applier

**Files:**
- Modify: `packages/core/src/manual/operations.ts:226-360` (`editGroup`)
- Test: `packages/core/test/manual/operations.test.ts` (extend; rewrite two existing tests)

**Interfaces:**
- Consumes: `planIdentityChange`, `IdentityPlan` (Tasks 5-6); `moveDownloadsToGroup`, `moveImportedFilesToGroup`, `liveFilesForOtherReleases` (Task 1); `trashFiles` (Task 2); `moveWithinLibrary` (Task 3).
- Produces: `editGroup(deps, groupId, values, planDigest?): Promise<ManualResult<GroupEditOutcome>>` where

```ts
export interface GroupEditOutcome {
  groupId: number;
  mergedInto: number | null;
  renamed: number;
  trashed: number;
  failed: readonly { path: string; error: string }[];
}
```

- [ ] **Step 1: Rewrite the two tests that assert the old refusals**

In `packages/core/test/manual/operations.test.ts`, find the two tests asserting 409 when the source group has a `downloads` row and when it has an `imported_files` row. Keep their names' subject but invert the assertion, and leave a comment saying what they used to assert — they are the record that this was once refused.

```ts
/**
 * Was a 409 until the identity-change design of 2026-08-16. The refusal was
 * permanent, because nothing deletes a `downloads` row, so a group ever picked
 * from could never be corrected. It now merges, and the download moves with it.
 */
test('a source group with a download recorded against it now merges', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const outcome = ok(await editGroup(makeDeps(db), 1, { key: 'k2', title: 'A' }, undefined, true));

  assert.equal(outcome.mergedInto, 2);
  assert.equal(getGroup(db, 1), null, 'the emptied source is deleted');
  assert.equal(
    num(db.prepare('SELECT group_id FROM downloads WHERE id = 1').get() as SqlRow, 'group_id'),
    2,
  );
});
```

The fifth argument in that call is a test-only escape from the digest requirement; see Step 3 for its real form — pass the digest from a `planIdentityChange` call instead if you prefer, and prefer that if the reviewer objects to a bypass flag.

- [ ] **Step 2: Write the failing tests for the new behaviour**

```ts
test('the reported scenario: adding a date to a picked group merges it into the dated one', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  const deps = makeDeps(db, FILING, libraryRoot);

  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));
  const outcome = ok(await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest));

  assert.equal(outcome.mergedInto, 2);
  assert.equal(outcome.renamed, 1);
  assert.deepEqual(outcome.failed, []);

  const survivor = getGroup(db, 2);
  assert.equal(survivor?.state, 'picked');
  assert.equal(survivor?.pickedReleaseId, 1, 'the target adopts the source pick');
  assert.equal(survivor?.upgradeReleaseId, 2, 'the 2160 release is now a flagged upgrade');
  assert.deepEqual(releasesForGroup(db, 2).map((r) => r.id).sort(), [1, 2]);

  assert.equal(await readFile(join(libraryRoot, 'k2', '1080.mp4'), 'utf8'), 'data');
  assert.equal(await lstatOrNull(join(libraryRoot, 'k1', '1080.mp4')), null);
  const files = filesForGroup(db, 2);
  assert.equal(files[0]?.destPath, join(libraryRoot, 'k2', '1080.mp4'), 'dest_path caught up');
});

test('a stale digest is refused and changes nothing', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  const deps = makeDeps(db, FILING, libraryRoot);

  const result = await editGroup(deps, 1, { key: 'k2', title: 'A' }, 'not-the-digest');

  assert.equal(failure(result).status, 409);
  assert.notEqual(getGroup(db, 1), null, 'the source group is untouched');
  assert.equal(await lstatOrNull(join(libraryRoot, 'k1', '1080.mp4')) === null, false);
});

test('a missing digest is refused when the plan moves anything', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);

  const result = await editGroup(makeDeps(db, FILING, libraryRoot), 1, { key: 'k2', title: 'A' });

  assert.equal(failure(result).status, 409);
});

test('a display-only edit still applies with no digest', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const outcome = ok(await editGroup(makeDeps(db), 1, { key: 'k1', title: 'Renamed' }));

  assert.equal(outcome.mergedInto, null);
  assert.equal(
    JSON.parse(getGroup(db, 1)!.display).title,
    'Renamed',
    'a typo fix must still save in one click',
  );
});

test('a blocked plan is refused', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  await mkdir(join(libraryRoot, 'k2'), { recursive: true });
  await writeFile(join(libraryRoot, 'k2', '1080.mp4'), 'someone else');
  const deps = makeDeps(db, FILING, libraryRoot);
  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));

  assert.equal(failure(await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest)).status, 409);
  assert.notEqual(getGroup(db, 1), null);
});

test('a failing rename leaves the merge standing and reports the file', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  const deps: ManualDeps = {
    ...makeDeps(db, FILING, libraryRoot),
    // EPERM, not EXDEV: EXDEV has a copy fallback that would succeed.
    rename: () => Promise.reject(Object.assign(new Error('nope'), { code: 'EPERM' })),
  };
  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));

  const outcome = ok(await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest));

  assert.equal(outcome.mergedInto, 2, 'the merge committed before any file moved');
  assert.equal(outcome.renamed, 0);
  assert.equal(outcome.failed.length, 1);
  assert.equal(
    filesForGroup(db, 2)[0]?.destPath,
    join(libraryRoot, 'k1', '1080.mp4'),
    'dest_path still names where the file actually is',
  );
});

test('re-saving after a failed rename finishes the remaining work', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  const failing: ManualDeps = {
    ...makeDeps(db, FILING, libraryRoot),
    rename: () => Promise.reject(Object.assign(new Error('nope'), { code: 'EPERM' })),
  };
  const firstPlan = ok(await planIdentityChange(failing, 1, { key: 'k2', title: 'A' }));
  await editGroup(failing, 1, { key: 'k2', title: 'A' }, firstPlan.digest);

  // Same values, working filesystem, and the group is now group 2.
  const deps = makeDeps(db, FILING, libraryRoot);
  const plan = ok(await planIdentityChange(deps, 2, { key: 'k2', title: 'B' }));
  assert.equal(plan.kind, 'none', 'the merge already happened');
  assert.equal(plan.renames.length, 1, 'but the file is still at its old path');

  const outcome = ok(await editGroup(deps, 2, { key: 'k2', title: 'B' }, plan.digest));

  assert.equal(outcome.renamed, 1);
  assert.equal(await readFile(join(libraryRoot, 'k2', '1080.mp4'), 'utf8'), 'data');
});

test('a superseded pick is trashed before the survivors are renamed', async () => {
  const db = openTestDatabase();
  const libraryRoot = await mkdtemp(join(tmpdir(), 'pickarr-edit-'));
  await seedWithFile(db, libraryRoot);
  // The target picks release 2 and owns a file at the exact path the source's
  // file is about to be renamed to. Trash-first is what makes this succeed.
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();
  await mkdir(join(libraryRoot, 'k2'), { recursive: true });
  await writeFile(join(libraryRoot, 'k2', '1080.mp4'), 'loser');
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (2, 2, 2, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO imported_files (id, download_id, group_id, source_path, dest_path,
                                 size_bytes, created_at)
     VALUES (2, 2, 2, '/dl/b.mp4', ?, 5, 100)`,
  ).run(join(libraryRoot, 'k2', '2160.mp4'));

  const deps = makeDeps(db, FILING, libraryRoot);
  const plan = ok(await planIdentityChange(deps, 1, { key: 'k2', title: 'A' }));
  const outcome = ok(await editGroup(deps, 1, { key: 'k2', title: 'A' }, plan.digest));

  assert.equal(outcome.trashed, 1);
  assert.deepEqual(outcome.failed, []);
  assert.equal(getGroup(db, 2)?.pickedReleaseId, 2, 'the higher-scoring pick stands');
});
```

Also keep, unchanged, the existing tests that a merge bringing something better bumps `list_rank_at` and one bringing only also-rans does not. If they call `editGroup` without a digest and now trip the digest rule, thread a `planIdentityChange` digest through them rather than weakening the rule.

- [ ] **Step 3: Run and confirm they fail**

Run: `npm run test:server -- --test-name-pattern="reported scenario|stale digest|missing digest|display-only edit|blocked plan|failing rename|re-saving|trashed before"`

Expected: FAIL — `editGroup` is synchronous and takes three arguments.

- [ ] **Step 4: Rewrite `editGroup`**

Replace the whole function. `inTransaction` stays exactly as it is and is used for phase 1 and for each per-file `dest_path` write.

```ts
/**
 * Corrects a group's identity and display, which is to say every release in it,
 * every future import that lands in it, and — now — the files it has already
 * placed in the library.
 *
 * Four phases, and the order is the safety argument rather than an incidental
 * sequence. See the design doc of 2026-08-16 §5.
 */
export async function editGroup(
  deps: ManualDeps,
  groupId: number,
  values: Record<string, string>,
  planDigest?: string,
): Promise<ManualResult<GroupEditOutcome>> {
  const { db } = deps;

  // Phase 0. The plan is recomputed rather than trusted: between the preview
  // and this call a release may have ingested or a queued download may have
  // imported, and the user must not confirm a plan that no longer holds.
  const planned = await planIdentityChange(deps, groupId, values);
  if (!('ok' in planned)) return planned;
  const plan = planned.ok;

  if (plan.blockers.length > 0) {
    return refuse(409, `cannot apply this identity change: ${plan.blockers.join('; ')}`);
  }

  // A plan that moves nothing needs no confirmation, which is what keeps a typo
  // fix on a display field a one-click save exactly as it always was.
  const needsConfirmation =
    plan.kind === 'merge' || plan.renames.length > 0 || plan.trashing.length > 0;
  if (needsConfirmation && planDigest !== plan.digest) {
    return refuse(
      409,
      planDigest === undefined
        ? 'this change moves releases or files and must be confirmed first'
        : 'what this change would do has altered since it was shown; review it again',
    );
  }

  const now = deps.now();
  const group = getGroup(db, groupId);
  if (group === null) return refuse(404, `no such group: ${groupId}`);
  const plugin = deps.registry.byId(group.plugin);
  if (plugin === undefined) return refuse(409, `no plugin loaded for id ${group.plugin}`);
  const resolved = resolveIdentityFor(plugin, group, values);
  if ('error' in resolved) return refuse(resolved.status, resolved.error);
  const identity = resolved.identity;

  const target = plan.mergeInto === null ? null : getGroup(db, plan.mergeInto.id);
  if (plan.mergeInto !== null && target === null) {
    return refuse(409, `group ${plan.mergeInto.id} no longer exists`);
  }

  // Phase 1. One transaction, database only. Nothing on disk has moved, so
  // every `dest_path` still names where its file actually is — the database is
  // never briefly lying, which is what makes a failure in phase 2 or 3
  // recoverable rather than a puzzle.
  const survivorId = inTransaction(db, () => {
    if (target !== null) {
      // Read before the move, and it has to be: once these releases sit under
      // the target they are part of what it already knows about, and
      // `releasesForGroup(source)` is empty besides.
      const best = releasesForGroup(db, group.id)[0];
      const bumps = best !== undefined && earnsListBump(db, target, best.score);

      moveReleasesToGroup(db, group.id, target.id);
      moveDownloadsToGroup(db, group.id, target.id);
      moveImportedFilesToGroup(db, group.id, target.id);

      // A pick names a release the user owns a file for. That release changed
      // groups, it did not disappear, so the survivor takes the pick the plan
      // chose — dropping it would tell the user they no longer have a file they
      // do. `state` travels with it: a row holding a pick while still reading
      // 'new' is off Picks and back in Browse, the same loss in a different hat.
      if (plan.pick.surviving !== null) {
        markPicked(db, target.id, plan.pick.surviving.releaseId);
      }

      if (bumps) flagUpgrade(db, target.id, now);
      else refreshUpgradeFlag(db, target.id);
      markGroupEdited(db, target.id, now);
      clearGroupMetadata(db, group.id);
      deleteGroup(db, group.id);
      return target.id;
    }

    const questionChanged =
      identity.identityKey !== group.identityKey || identity.displayJson !== group.display;
    updateGroupIdentity(db, {
      id: group.id,
      identityKey: identity.identityKey,
      display: identity.displayJson,
      searchText: identity.searchText,
    });
    markGroupEdited(db, group.id, now);
    if (questionChanged) clearGroupMetadata(db, group.id);
    return group.id;
  });

  const failed: { path: string; error: string }[] = [];
  const libraryRoot = deps.registry.libraryRootById(group.plugin);
  await mkdir(resolve(libraryRoot), { recursive: true });
  const libraryRootReal = await realpath(resolve(libraryRoot));

  // Phase 2, before phase 3 and for the reason import.ts gives for trashing
  // ahead of its own transfer loop: a superseded file frequently occupies the
  // exact path a renamed file wants, so it has to leave first.
  let trashed = 0;
  if (plan.trashing.length > 0) {
    const rows = plan.trashing
      .map((entry) => getImportedFile(db, entry.importedFileId))
      .filter((row): row is ImportedFileRow => row !== null);
    try {
      await trashFiles(db, rows, libraryRootReal, deps.trashDir, survivorId, now);
      trashed = rows.length;
    } catch (error) {
      failed.push({ path: rows[0]?.destPath ?? '', error: (error as Error).message });
    }
  }

  // Phase 3. One file at a time, each row updated straight after its own move,
  // so a crash leaves every moved file recorded at its new path and every
  // unmoved one at its old.
  let renamed = 0;
  for (const move of plan.renames) {
    try {
      await moveWithinLibrary(move.from, move.to, libraryRootReal, deps.rename);
      inTransaction(db, () => setImportedFileDest(db, move.importedFileId, move.to));
      renamed += 1;
    } catch (error) {
      // Collected, never rethrown. The merge is already committed and was
      // correct; abandoning the remaining files would only strand more of them.
      failed.push({ path: move.from, error: (error as Error).message });
    }
  }

  return {
    ok: {
      groupId: survivorId,
      mergedInto: target === null ? null : target.id,
      renamed,
      trashed,
      failed,
    },
  };
}
```

Two small db functions this needs — add to `packages/core/src/db/imported-files.ts`:

```ts
export function getImportedFile(db: DatabaseSync, id: number): ImportedFileRow | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id);
  return row === undefined ? null : toRow(row as SqlRow);
}

/**
 * Written only after the file has actually moved, one row per move. That is
 * what keeps the table describing the library rather than describing an
 * intention.
 */
export function setImportedFileDest(db: DatabaseSync, id: number, destPath: string): void {
  db.prepare('UPDATE imported_files SET dest_path = ? WHERE id = ?').run(destPath, id);
}
```

- [ ] **Step 5: Run and confirm they pass**

Run: `npm run test:server`

Expected: PASS.

- [ ] **Step 6: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/manual/operations.ts packages/core/src/db/imported-files.ts \
        packages/core/test/manual/operations.test.ts
```

---

### Task 8: HTTP — the plan route, and the digest rule on PATCH

**Files:**
- Modify: `packages/core/src/http/server.ts:987-1001` (`PATCH /api/groups/:id`), and add the new route beside it
- Modify: `packages/core/src/http/views.ts` (`GroupEditResponse`, plus a plan view type)
- Test: `packages/core/test/http/manual.test.ts` (extend)

**Interfaces:**
- Consumes: `planIdentityChange`, `IdentityPlan`, `editGroup` (Tasks 5-7).
- Produces: `POST /api/groups/:id/identity-plan` → `IdentityPlan`; `PATCH /api/groups/:id` accepting `{ values, planDigest? }` and returning `{ group, mergedInto, renamed, trashed, failed }`.

- [ ] **Step 1: Write the failing route tests**

Append to `packages/core/test/http/manual.test.ts`, following that file's existing `server.inject` style:

```ts
test('POST /api/groups/:id/identity-plan describes a merge without performing it', async () => {
  const { server, db } = await harness();
  seedTwoGroups(db);

  const response = await server.inject({
    method: 'POST',
    url: '/api/groups/1/identity-plan',
    payload: { values: { key: 'k2', title: 'A' } },
  });

  assert.equal(response.statusCode, 200);
  const plan = response.json();
  assert.equal(plan.kind, 'merge');
  assert.equal(plan.mergeInto.id, 2);
  assert.ok(typeof plan.digest === 'string' && plan.digest.length > 0);
  assert.notEqual(getGroup(db, 1), null, 'planning changed nothing');
});

test('POST /api/groups/:id/identity-plan is 404 for a group that does not exist', async () => {
  const { server } = await harness();

  const response = await server.inject({
    method: 'POST',
    url: '/api/groups/77/identity-plan',
    payload: { values: { key: 'k1' } },
  });

  assert.equal(response.statusCode, 404);
});

test('PATCH /api/groups/:id refuses a merge with no digest', async () => {
  const { server, db } = await harness();
  seedTwoGroups(db);

  const response = await server.inject({
    method: 'PATCH',
    url: '/api/groups/1',
    payload: { values: { key: 'k2', title: 'A' } },
  });

  assert.equal(response.statusCode, 409);
});

test('PATCH /api/groups/:id applies a merge with a matching digest', async () => {
  const { server, db } = await harness();
  seedTwoGroups(db);
  const plan = (
    await server.inject({
      method: 'POST',
      url: '/api/groups/1/identity-plan',
      payload: { values: { key: 'k2', title: 'A' } },
    })
  ).json();

  const response = await server.inject({
    method: 'PATCH',
    url: '/api/groups/1',
    payload: { values: { key: 'k2', title: 'A' }, planDigest: plan.digest },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.mergedInto, 2);
  assert.equal(body.renamed, 0);
  assert.deepEqual(body.failed, []);
});

test('PATCH /api/groups/:id still applies a display-only edit with no digest', async () => {
  const { server, db } = await harness();
  seedTwoGroups(db);

  const response = await server.inject({
    method: 'PATCH',
    url: '/api/groups/1',
    payload: { values: { key: 'k1', title: 'Renamed' } },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mergedInto, null);
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npm run test:server -- --test-name-pattern="identity-plan|digest"`

Expected: FAIL — no such route; PATCH ignores `planDigest`.

- [ ] **Step 3: Add the route and extend the body schema**

In `server.ts`, beside the existing `valuesBodySchema`, add:

```ts
const editBodySchema = z.object({
  values: z.record(z.string(), z.string()),
  planDigest: z.string().optional(),
});
```

Then the new route, next to `PATCH /api/groups/:id`:

```ts
  /**
   * Everything an identity change would do, and nothing done. Writes nothing —
   * a POST only because the values are a form's worth of fields and belong in a
   * body, not because anything changes.
   *
   * The statuses are the operation's own, carried rather than re-derived, for
   * the reason the four routes above state.
   */
  server.post('/api/groups/:id/identity-plan', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = valuesBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const result = await planIdentityChange(manual, params.data.id, body.data.values);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });
    return result.ok;
  });
```

and change the PATCH handler's body parse to `editBodySchema` and its call to

```ts
    const result = await editGroup(manual, params.data.id, body.data.values, body.data.planDigest);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });

    const group = groupAfter(result.ok.groupId);
    if (group === null) return reply.code(404).send({ error: 'No such group' });
    const response: GroupEditResponse = {
      group,
      mergedInto: result.ok.mergedInto,
      renamed: result.ok.renamed,
      trashed: result.ok.trashed,
      failed: result.ok.failed,
    };
    return response;
```

In `views.ts`, extend `GroupEditResponse` with `renamed: number; trashed: number; failed: readonly { path: string; error: string }[];`.

- [ ] **Step 4: Run and confirm they pass**

Run: `npm run test:server`

Expected: PASS.

- [ ] **Step 5: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/http/server.ts packages/core/src/http/views.ts \
        packages/core/test/http/manual.test.ts
```

---

### Task 9: The web client, the hook, and the confirmation

**Files:**
- Modify: `packages/web/src/api/client.ts` (`editGroup`, add `identityPlan`, add the plan types)
- Create: `packages/web/src/api/useIdentityChange.ts`
- Create: `packages/web/src/components/IdentityChangeConfirm.tsx`
- Test: `packages/web/test/IdentityChangeConfirm.test.tsx` (create)

**Interfaces:**
- Produces:
  - `api.identityPlan(groupId: number, values: Record<string, string>): Promise<IdentityPlanView>`
  - `api.editGroup(groupId: number, values: Record<string, string>, planDigest?: string): Promise<GroupEditResponse>`
  - `useIdentityChange(apply: (groupId: number, values: Record<string, string>, digest?: string) => Promise<boolean>)` returning `{ begin, plan, confirm, cancel, busy }`
  - `<IdentityChangeConfirm plan={…} onConfirm={…} onCancel={…} />`

- [ ] **Step 1: Add the client calls and types**

In `packages/web/src/api/client.ts`, mirror the server's `IdentityPlan` as `IdentityPlanView` (same field names and types; no `any`), then:

```ts
  async identityPlan(groupId: number, values: Record<string, string>): Promise<IdentityPlanView> {
    return request<IdentityPlanView>(`/api/groups/${groupId}/identity-plan`, {
      method: 'POST',
      body: JSON.stringify({ values }),
    });
  },
```

and give `editGroup` a third optional `planDigest`, included in the body only when defined.

Follow whatever `request`/fetch helper the file already uses rather than introducing a second one.

- [ ] **Step 2: Write the failing confirmation test**

Create `packages/web/test/IdentityChangeConfirm.test.tsx`, following the render/assert style of `packages/web/test/ManualForm.test.tsx`:

```tsx
const MERGE: IdentityPlanView = {
  groupId: 1,
  identityKey: 'site:2026-08-14:title',
  kind: 'merge',
  mergeInto: { id: 2, title: 'Title Of Scene' },
  releasesMoving: 1,
  downloadsMoving: 1,
  pick: { surviving: { releaseId: 1, score: 1080, side: 'source' }, superseded: null },
  renames: [{ importedFileId: 1, from: '/library/Old/a.mp4', to: '/library/New/a.mp4' }],
  trashing: [],
  warnings: [],
  blockers: [],
  digest: 'abc',
};

test('it names the group being merged into and every file that moves', () => {
  render(<IdentityChangeConfirm plan={MERGE} onConfirm={() => {}} onCancel={() => {}} />);

  assert.ok(screen.getByText(/Title Of Scene/));
  assert.ok(screen.getByText('/library/Old/a.mp4'));
  assert.ok(screen.getByText('/library/New/a.mp4'));
});

test('it reports which pick survives and which is superseded', () => {
  render(
    <IdentityChangeConfirm
      plan={{
        ...MERGE,
        pick: {
          surviving: { releaseId: 2, score: 2160, side: 'target' },
          superseded: { releaseId: 1, score: 1080 },
        },
        trashing: [{ importedFileId: 1, path: '/library/Old/a.mp4' }],
        renames: [],
      }}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(screen.getByText(/2160/));
  assert.ok(screen.getByText(/1080/));
  assert.ok(screen.getByText('/library/Old/a.mp4'));
});

test('confirm is disabled while the plan has blockers', () => {
  render(
    <IdentityChangeConfirm
      plan={{ ...MERGE, blockers: ['/library/New/a.mp4 is occupied'] }}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

  const confirm = screen.getByRole('button', { name: /confirm/i });
  assert.equal((confirm as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText(/is occupied/));
});

test('cancel calls back without confirming', () => {
  let confirmed = false;
  let cancelled = false;
  render(
    <IdentityChangeConfirm
      plan={MERGE}
      onConfirm={() => {
        confirmed = true;
      }}
      onCancel={() => {
        cancelled = true;
      }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

  assert.equal(cancelled, true);
  assert.equal(confirmed, false);
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `npm run test:web -- --test-name-pattern="merged into|superseded|blockers|cancel calls"`

Expected: FAIL — the component does not exist.

- [ ] **Step 4: Implement the component**

Create `packages/web/src/components/IdentityChangeConfirm.tsx`. Full `from → to` paths are rendered rather than basenames: a plan the user cannot read is a guess with extra steps.

```tsx
import type { IdentityPlanView } from '../api/client.ts';

interface Props {
  plan: IdentityPlanView;
  onConfirm(): void;
  onCancel(): void;
  busy?: boolean;
}

export function IdentityChangeConfirm({ plan, onConfirm, onCancel, busy = false }: Props) {
  const blocked = plan.blockers.length > 0;

  return (
    <div className="confirm" role="dialog" aria-label="Confirm identity change">
      {plan.mergeInto !== null ? (
        <p>
          This will merge into <strong>{plan.mergeInto.title}</strong>, moving{' '}
          {plan.releasesMoving} release(s) and {plan.downloadsMoving} download(s).
        </p>
      ) : (
        <p>
          This will re-key the group to <code>{plan.identityKey}</code>.
        </p>
      )}

      {plan.pick.surviving !== null && (
        <p>
          Picked release: {plan.pick.surviving.releaseId} (score {plan.pick.surviving.score}
          {plan.pick.surviving.side === 'target' ? ', already picked here' : ', moved in'}).
        </p>
      )}
      {plan.pick.superseded !== null && (
        <p className="warning">
          Release {plan.pick.superseded.releaseId} (score {plan.pick.superseded.score}) is no
          longer picked; its files are trashed below.
        </p>
      )}

      {plan.renames.length > 0 && (
        <>
          <h3>Files renamed</h3>
          <ul>
            {plan.renames.map((move) => (
              <li key={move.importedFileId}>
                <code>{move.from}</code> → <code>{move.to}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {plan.trashing.length > 0 && (
        <>
          <h3>Files trashed</h3>
          <ul>
            {plan.trashing.map((entry) => (
              <li key={entry.importedFileId}>
                <code>{entry.path}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {plan.warnings.map((warning) => (
        <p className="warning" key={warning}>
          {warning}
        </p>
      ))}
      {plan.blockers.map((blocker) => (
        <p className="error" key={blocker}>
          {blocker}
        </p>
      ))}

      <button type="button" onClick={onConfirm} disabled={blocked || busy}>
        Confirm
      </button>
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Implement the hook**

Create `packages/web/src/api/useIdentityChange.ts`:

```ts
import { useState } from 'react';
import { api, type IdentityPlanView } from './client.ts';

interface Pending {
  plan: IdentityPlanView;
  values: Record<string, string>;
  resolve(saved: boolean): void;
}

/**
 * The plan → confirm → apply sequence, in one place so Browse and Picks cannot
 * disagree about it.
 *
 * `begin` fulfils `MediaCard`'s `onEditGroup(values) => Promise<boolean>`
 * contract, so the card stays presentational — the same reason
 * `useIdentityPreview` was factored out of it. Not to be confused with that
 * hook: it previews the identity *key* per keystroke and knows nothing about a
 * group.
 *
 * A plan that moves nothing resolves without ever showing a confirmation, which
 * is what keeps a typo fix a one-click save.
 */
export function useIdentityChange(
  apply: (groupId: number, values: Record<string, string>, digest?: string) => Promise<boolean>,
  onError: (message: string) => void,
) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin(groupId: number, values: Record<string, string>): Promise<boolean> {
    let plan: IdentityPlanView;
    try {
      plan = await api.identityPlan(groupId, values);
    } catch (cause) {
      onError((cause as Error).message);
      return false;
    }

    const moves =
      plan.kind === 'merge' || plan.renames.length > 0 || plan.trashing.length > 0;
    if (!moves) return apply(groupId, values, undefined);

    return new Promise<boolean>((resolve) => {
      setPending({ plan, values, resolve });
    });
  }

  async function confirm(): Promise<void> {
    if (pending === null) return;
    setBusy(true);
    const saved = await apply(pending.plan.groupId, pending.values, pending.plan.digest);
    setBusy(false);
    // A stale digest comes back 409 and `apply` reports it. Re-plan in place so
    // the user reads what changed instead of losing their position.
    if (!saved) {
      try {
        const fresh = await api.identityPlan(pending.plan.groupId, pending.values);
        setPending({ ...pending, plan: fresh });
        return;
      } catch (cause) {
        onError((cause as Error).message);
      }
    }
    pending.resolve(saved);
    setPending(null);
  }

  function cancel(): void {
    if (pending === null) return;
    pending.resolve(false);
    setPending(null);
  }

  return { begin, plan: pending?.plan ?? null, confirm, cancel, busy };
}
```

- [ ] **Step 6: Run the web suite**

Run: `npm run test:web`

Expected: PASS.

- [ ] **Step 7: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/web/src/api/client.ts packages/web/src/api/useIdentityChange.ts \
        packages/web/src/components/IdentityChangeConfirm.tsx \
        packages/web/test/IdentityChangeConfirm.test.tsx
```

---

### Task 10: Wire Browse and Picks

**Files:**
- Modify: `packages/web/src/routes/Browse.tsx:100-116` (route through the hook), and its render
- Modify: `packages/web/src/routes/Picks.tsx` (fetch fields, pass the edit handlers, render the confirmation)
- Test: `packages/web/test/Picks.test.tsx` (extend), `packages/web/test/Browse.test.tsx` (extend)

**Interfaces:**
- Consumes: `useIdentityChange`, `IdentityChangeConfirm` (Task 9).
- Produces: no new exports.

- [ ] **Step 1: Write the failing Picks tests**

Append to `packages/web/test/Picks.test.tsx`, following that file's existing fetch-stub pattern:

```tsx
test('a picked group offers an edit form', async () => {
  stubApi({ picks: [PICKED_GROUP], manualFields: { test: FIELDS } });
  render(<Picks />);

  assert.ok(await screen.findByRole('button', { name: /edit/i }));
});

test('a display-only edit saves without a confirmation', async () => {
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { test: FIELDS },
    identityPlan: { ...PLAN_NO_MOVES },
  });
  render(<Picks />);

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fixed' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));

  await waitFor(() => assert.equal(stub.patched.length, 1));
  assert.equal(stub.patched[0]?.planDigest, undefined);
  assert.equal(screen.queryByRole('dialog'), null);
});

test('a merge shows the confirmation and only saves once confirmed', async () => {
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { test: FIELDS },
    identityPlan: PLAN_MERGE,
  });
  render(<Picks />);

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'k2' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));

  const dialog = await screen.findByRole('dialog');
  assert.ok(dialog);
  assert.equal(stub.patched.length, 0, 'nothing is saved before confirmation');

  fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

  await waitFor(() => assert.equal(stub.patched.length, 1));
  assert.equal(stub.patched[0]?.planDigest, PLAN_MERGE.digest);
});

test('a merge reloads the list rather than patching it', async () => {
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { test: FIELDS },
    identityPlan: PLAN_MERGE,
  });
  render(<Picks />);

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'k2' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));

  // Two: the initial load, then the reload after the merge. Which list a group
  // belongs to after a merge is the server's answer, not one to reconstruct.
  await waitFor(() => assert.equal(stub.pickCalls, 2));
});
```

Define `PLAN_NO_MOVES` (`kind: 'display-only'`, empty `renames`/`trashing`) and `PLAN_MERGE` (as in Task 9) at the top of the file.

- [ ] **Step 2: Run and confirm they fail**

Run: `npm run test:web -- --test-name-pattern="picked group offers|display-only edit saves|merge shows|reloads the list"`

Expected: FAIL — Picks renders no edit affordance.

- [ ] **Step 3: Wire Picks**

```tsx
  const [fields, setFields] = useState<Record<string, readonly ManualField[]>>({});

  useEffect(() => {
    void (async () => {
      try {
        setFields(await api.manualFields());
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  /**
   * Reloads rather than patching the list, unlike Browse. A merge can take a
   * group off Picks entirely — when the survivor holds no pick — or bring one
   * onto it, and which list a group belongs to is the server's answer to give.
   */
  async function applyEdit(
    groupId: number,
    values: Record<string, string>,
    planDigest?: string,
  ): Promise<boolean> {
    try {
      const { failed } = await api.editGroup(groupId, values, planDigest);
      await reload();
      setError(
        failed.length === 0
          ? null
          : `Saved, but ${failed.length} file(s) could not be moved: ${failed
              .map((entry) => `${entry.path} (${entry.error})`)
              .join('; ')}`,
      );
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    }
  }

  const identityChange = useIdentityChange(applyEdit, setError);
```

Then in the render, pass `fields={fields[group.plugin]}`, `onEditGroup={(values) => identityChange.begin(group.id, values)}` and `onEditRelease={…}` to `MediaCard`, and render the confirmation when there is one:

```tsx
      {identityChange.plan !== null && (
        <IdentityChangeConfirm
          plan={identityChange.plan}
          onConfirm={() => void identityChange.confirm()}
          onCancel={identityChange.cancel}
          busy={identityChange.busy}
        />
      )}
```

Add an `editRelease` mirroring Browse's, reloading instead of patching for the same reason.

- [ ] **Step 4: Route Browse through the same hook**

In `Browse.tsx`, rename the existing `editGroup` to `applyEdit`, give it the third `planDigest` parameter and pass it to `api.editGroup`, keep its existing list-patching body and its merge notice, and surface `failed` the way Picks does. Then `const identityChange = useIdentityChange(applyEdit, setError);`, change the card's `onEditGroup` to `identityChange.begin`, and render `IdentityChangeConfirm` as above.

Add one Browse test asserting a merge still shows its "Releases moved into …" notice after confirmation, so the existing behaviour is pinned.

- [ ] **Step 5: Run the web suite**

Run: `npm run test:web`

Expected: PASS.

- [ ] **Step 6: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/web/src/routes/Picks.tsx packages/web/src/routes/Browse.tsx \
        packages/web/test/Picks.test.tsx packages/web/test/Browse.test.tsx
```

---

### Task 11: End-to-end, the reported scenario in a browser

**Files:**
- Create: `packages/e2e/tests/identity-change.spec.ts`

**Interfaces:**
- Consumes: everything above, through the running app. Use `packages/e2e/src/harness.ts` exactly as `packages/e2e/tests/metadata.spec.ts` does.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
// harness imports as in the existing specs

/**
 * The case this feature exists for. A dateless release is picked and imported;
 * a dated re-encode of the same scene arrives and lands in its own group,
 * because the date is part of the identity key. Adding the date to the picked
 * group is the correction that joins them, and it was refused outright until
 * the identity-change work of 2026-08-16.
 */
test('adding a date to a picked group merges it into the dated one', async ({ page }) => {
  // 1. Feed serves `SomeSite.TitleOfScene.1080p.MP4-WRB`; ingest; pick it;
  //    let the download complete and import.
  // 2. Feed serves `SomeSite.26.08.14.TitleOfScene.2160p.MP4-WRB`; ingest.
  //    Assert two separate cards exist.
  // 3. On Picks, open the picked group's edit form, set the anchor kind to
  //    `date` and the date to `2026-08-14`, and save.
  // 4. Assert the confirmation lists the merge target and the file rename.
  // 5. Confirm.
  // 6. Assert one group remains, holding both releases, with the 2160p flagged
  //    as an upgrade, and that the imported file now sits under the dated path.
});
```

Fill each numbered comment in with real Playwright steps using the harness's feed-serving and download-client fakes. Do not leave the comments as the test body.

- [ ] **Step 2: Run it**

Run: `npm run e2e -- identity-change`

Expected: PASS.

- [ ] **Step 3: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build && npm run e2e
git add packages/e2e/tests/identity-change.spec.ts
```

---

### Task 12: Amend the older spec, and close the issue

The design doc records that it amends the manual-metadata spec; this task makes the amendment where a reader of that spec will actually find it.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-07-manual-metadata-design.md:33-44` (§2 Out of scope), `:264-312` (§7.3)
- Modify: `docs/known-issues.md`
- Modify: `README.md` if it documents the edit behaviour

- [ ] **Step 1: Amend §2 of the manual-metadata spec**

Replace the "Moving files already imported" bullet with a note that it held until 2026-08-16, that an identity change a human makes now renames the files that identity placed, and that re-rendering the whole library after a `pathTemplate` change remains out of scope (issue #22). Point at the new design doc.

- [ ] **Step 2: Amend §7.3**

Leave the reasoning for the original refusal in place — it is settled reasoning about why the conservative choice was right at the time — and replace the final paragraph ("The merge is refused with 409 when …") with a pointer to §5 of the new design doc, noting what replaced it: a shown plan the user confirms.

- [ ] **Step 3: Update `docs/known-issues.md`**

That file's own preamble says a bulleted link is tracked work and a paragraph is settled reasoning. Issue #2 is now done, so remove or amend its bullet accordingly, following the convention already in the file.

- [ ] **Step 4: Check the README**

Run: `grep -n "edit\|identity\|merge" README.md`

If the README describes editing a group's identity, add that an edit which moves files now asks for confirmation and renames what it placed. If it says nothing about editing, change nothing.

- [ ] **Step 5: Final full gate**

```bash
npm run lint && npm run typecheck && npm run test && npm run build && npm run e2e
```

- [ ] **Step 6: Stage, and prepare to close the issue**

```bash
git add docs/ README.md
```

Report to the human that the work is complete, and that closing issue #2 needs their say-so. Do not run `gh issue close` and do not commit or push without explicit approval.

---

## Self-Review Notes

Checked against the spec, section by section:

- §3's two findings (import-time destination derivation, reusable path derivation) — Task 6's `destinationFor` and its comment; no separate task needed because in-flight downloads require no code.
- §4.1 per-file quality — Task 6, `qualityForFile` + the "a merge plans a rename … under its own releases quality" test.
- §4.2 no-move renames dropped — Task 6, "a rename that would not move the file is dropped".
- §4.3 blockers and the one warning — Task 6, four tests.
- §4.4 pick reconciliation — Task 5, four tests.
- §4.5 release-scoped trashing — Task 1, including the two-downloads case.
- §5 phases 0-3 and §5.1 failure model — Task 7.
- §5.2 retry path — Task 7, "re-saving after a failed rename finishes the remaining work".
- §6 no schema change — no migration task exists, deliberately.
- §7 HTTP and the digest rule — Task 8.
- §8 UI — Tasks 9 and 10.
- §9 testing — distributed across every task; e2e is Task 11.
- §10 amendments — Task 12.
- §11 risks — no code; the confirmation UI in Task 9 is the mitigation for the first.

Two known roughnesses left for the implementer to resolve rather than papered over:

1. **Task 6's `doomed` expression is wrong as written** and says so: the superseded pick can sit on either side of a merge, so it needs a call for the source and a call for the target, concatenated. Flagged inline with the extra test to add.
2. **Task 5's non-null assertions in `reconcilePick`** are guarded but ugly. The note offers the restructure (`heldScore` returning a pair) and forbids reaching for `any`/`unknown`.
