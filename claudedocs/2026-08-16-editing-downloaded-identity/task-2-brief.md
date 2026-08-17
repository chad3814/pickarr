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

