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

