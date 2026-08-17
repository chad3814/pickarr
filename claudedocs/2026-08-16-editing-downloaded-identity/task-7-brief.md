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

