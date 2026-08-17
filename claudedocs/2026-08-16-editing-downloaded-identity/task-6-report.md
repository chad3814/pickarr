# Task 6 report: the planner — renames, trashing, blockers and warnings

## Files changed

- `packages/core/src/manual/identity-plan.ts` — filled in `renames`, `trashing`, `warnings`, `blockers`; fixed the `digestOf` doc comment; added `destinationFor` and `qualityForFile` helpers.
- `packages/core/test/manual/identity-plan.test.ts` — appended the brief's rename/trash/blocker/warning tests, plus one new test the brief did not have.
- `packages/core/test/manual/fixtures.ts` — added `FILING` and `seedWithFile`, exported for Task 7.

## The `doomed` fix

The brief's own `doomed` expression was wrong (and said so in a note): it used a `-1` sentinel group id and only ever asked the *source* group for files to trash, even though a superseded pick can be on either side of a merge.

Implemented instead as:

```ts
const doomed: ImportedFileRow[] =
  pick.superseded === null
    ? []
    : [
        ...liveFilesForOtherReleases(db, group.id, keepReleaseId),
        ...(merging ? liveFilesForOtherReleases(db, target.id, keepReleaseId) : []),
      ];
```

- Source group is always asked (a rekey's own losing releases, and a merge's source-side loss).
- Target group is asked only when merging (there is no target otherwise).
- No sentinel id anywhere.
- `target.id` type-checks inside the `merging ? ... : ...` ternary via the same aliased-condition narrowing TypeScript already relies on for the pre-existing `mergeInto: merging ? { id: target.id, ... } : null` line a few statements below — `merging`'s definition (`target !== null && target.id !== group.id`) is a compound narrowing expression TS treats as an alias for `target`'s non-nullness.

New test `a superseded pick on the target side has its files trashed too`: seeds the merge pair via `seedWithFile` (group 1/source picked, 1080p, file on disk), then gives the *target* (group 2) its own download, live imported file (`k2/2160.mp4`), bumps release 1's score above release 2's, and picks release 2 on group 2. This makes the source's pick the survivor and the target's the loser. Asserts `plan.pick.surviving`/`plan.pick.superseded` land as expected and that `plan.trashing` names the *target's* file (`k2/2160.mp4`, `importedFileId: 2`) — the case an unfixed, source-only `doomed` would have silently dropped.

## Second fix: the `digestOf` doc comment

The comment referenced reordering "the literal in `finish()` below" — no `finish()` function exists; the object (`withoutDigest`) is built inline in `planIdentityChange`. Corrected to name `withoutDigest` in `planIdentityChange` directly.

## Fixtures added to `fixtures.ts`

- `FILING`: a `MediaTypePlugin` (spread of `PLUGIN`) whose `planImport` actually places a file at `<key>/<resolution>.mp4`, needed because `PLUGIN`'s own `planImport` returns `null` (deliberately, a plugin that files nothing) and the file-half tests need a plugin that files something.
- `seedWithFile(db, libraryRoot)`: `seedMergePair(db)` plus one live `imported_files` row for group 1, with the file actually written to disk under `k1/1080.mp4`.

Both are exported (not local to `identity-plan.test.ts`) per the brief's own note that Task 7's applier tests need the same shape.

## Everything else implemented per the brief, unchanged

- `destinationFor` and `qualityForFile` helpers, verbatim per the brief (verified their types against `packages/core/src/pipeline/import.ts` for `resolveDestination`/`lstatOrNull`/`isContained` and `@pickarr/plugin-api`'s `MediaTypePlugin`/`ParsedRelease`/`DownloadedFile`/`ImportPlan` shapes).
- Trashing decided before renames, with a `doomedIds` set excluded from the rename loop, keeping the two arrays disjoint as required.
- The rename loop walks only `liveFilesForOtherReleases(db, group.id, null)` (the source's own files) — the target's files are already correctly placed under its own untouched identity, so only the source's can be stale.
- `registryFor` in fixtures already took the `libraryRoot` parameter Task 6 needed; no change required there beyond adding `FILING`/`seedWithFile`.

## Gate results

- `npm run lint` — exit 0. Only pre-existing warnings across the repo (none in the files this task touched); no errors.
- `npm run typecheck` — exit 0, no errors, across all workspaces.
- `npm run test:server` — **858 pass, 0 fail** (includes all 8 new/extended `identity-plan.test.ts` cases: the 6 from the brief plus the new target-side trashing test, plus `a live file the plugin refuses to place is a blocker`).
- `npm run test:web` — **165 pass, 0 fail**.
- `npm run build` — succeeds for `@pickarr/plugin-api`, `@pickarr/plugin-scenes`, `@pickarr/core`, `@pickarr/web`.

All pre-existing Task 5 planner tests in `identity-plan.test.ts` still pass unchanged (regression signal for point 5 in the assignment: a group with no live files produces no blockers regardless of plugin).

## Other brief issues found

None beyond the two the assignment already flagged (the `doomed` bug and the `finish()` doc comment). The rest of the brief's code (helpers, ordering, `destinationFor`, `qualityForFile`) matched the actual codebase's types and behaviour once verified against `import.ts`, `imported-files.ts`, `groups.ts`, `values.ts`, `operations.ts`, and `@pickarr/plugin-api`'s type definitions — no further corrections were needed.

## Concerns

- Not committed, per the standing instruction. All three files are `git add`-staged only.

## Fix: guard `destinationFor` against a throwing/escaping plugin

The coordinator ruled the throw-on-escape concern above in scope and directed a fix, citing `buildRelease` in `manual/values.ts` as the house pattern for untrusted plugin hooks.

**Change to `packages/core/src/manual/identity-plan.ts`:**

- `destinationFor` now returns `{ destination: string } | { refused: string } | null` instead of `string | null`. `null` still means "the plugin declined to place the file" (`planImport` returned nothing); `{ refused: string }` is new and means "the plugin tried and it could not be honoured" — carrying the reason so the caller can word a blocker that says why, not just that.
- Both `plugin.planImport(...)` and `resolveDestination(...)` are now called inside one `try`/`catch` inside `destinationFor`. A catch returns `{ refused: error.message }`. This covers two failure modes with one guard: `resolveDestination` throwing on an escaping destination, and `planImport` throwing outright on its own account (a bug in the plugin, unrelated to paths) — both are "something the plugin did that must not reach the caller as an exception."
- The doc comment on `destinationFor` now explains the guard, quoting the same rationale `buildRelease` gives for guarding `fromManualValues` ("would otherwise be a 500 ... rather than a message shown"), and notes `pipeline/import.ts`'s own statement that "a plugin is not trusted to police its own paths."
- The caller loop in `planIdentityChange` was updated for the new return shape: a `{ refused }` result pushes a blocker of the form `` `${file.destPath} could not be placed under the new identity: ${placed.refused}` `` — naming the file's current path and the reason, per the ruling's requirement 3. The `null` branch (declined) keeps its original wording. `renames`/`trashing` disjointness is untouched — the new branch is just another `continue` before a file is ever considered for a rename.

**Tests added to `packages/core/test/manual/identity-plan.test.ts`:**

- `a plugin destination that escapes the library root is a blocker, not a throw` — a plugin (spread of `FILING`) whose `planImport` returns a destination of `../../../escape.mp4`. Asserts via `assert.doesNotReject` that `planIdentityChange` resolves (not just that the test doesn't crash), then asserts exactly one blocker naming the file's current path (`k1/1080.mp4`) and matching `/escapes the library root/`, and that `renames` stays empty.
- `a plugin that throws while planning a file is a blocker, not a rejection` — a plugin whose `planImport` throws `new Error('plugin exploded')` outright. Same `assert.doesNotReject` pattern, then asserts one blocker naming the file's current path and matching `/plugin exploded/`.

Both tests use `assert.doesNotReject(async () => { result = await planIdentityChange(...); })` rather than a bare `await`, so the "resolves rather than rejects" property is an explicit assertion, per requirement 4, not an incidental effect of the test not crashing.

## Gate results after the fix

- `npm run lint` — exit 0. No new errors; the two `no-await-in-loop` warnings already present in this file shifted line numbers but are unchanged in kind.
- `npm run typecheck` — exit 0, no errors, across all workspaces.
- `npm run test:server` — **860 pass, 0 fail** (858 from before, plus the 2 new guard tests).
- `npm run test:web` — **165 pass, 0 fail** (unchanged).
- `npm run build` — succeeds for all four workspaces.

## Fix round 2: review findings

Review came back spec ✅, quality Approved with one Important finding and two Minors. All three addressed in this round.

### Important — the per-file quality join was untested

Every prior rename test gave a group exactly one live file, so that file's release quality and the group's pick's quality were always the same value — nothing distinguished `qualityForFile` reading each file's own release from a hypothetical regression that used the pick's quality for every file.

- **Fixture added:** `seedWithTwoQualityFiles(db, libraryRoot)` in `packages/core/test/manual/fixtures.ts` — `seedWithFile` plus a second release (id 3, 2160p) in group 1, with its own download (id 2) and its own live imported file, already on disk at `k1/2160.mp4`. Group 1's pick stays release 1 (1080p); only a second release and file are added. Exported alongside `seedWithFile`/`FILING` in case Task 7's applier tests need the same two-quality shape.
- **Test added:** `each live file is renamed under its own release quality, not the picks` in `packages/core/test/manual/identity-plan.test.ts`. Plans a rekey (`key: 'k9'`) over the two-file group and asserts the exact `renames` array — file 1 to `k9/1080.mp4`, file 2 to `k9/2160.mp4` — not merely that the two paths differ. A planner reading the pick's quality (1080p) for both files would produce `k9/1080.mp4` for file 2 as well, which this exact-match assertion catches; it would not be caught by an "are these two different" assertion, since a collision would still register as *some* difference in id-to-path pairing only by accident of iteration order.

### Minor 1 — `(error as Error).message` assumed an `Error` was thrown

In `destinationFor`'s catch block (`identity-plan.ts`), a plugin throwing a string or a plain non-`Error` object would read back as `undefined` through `(error as Error).message`. Fixed by narrowing instead of casting:

```ts
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  return { refused: reason };
}
```

No `any`/`unknown` type was written by hand — the catch binding's implicit type is left alone, and `instanceof Error` / `String(error)` narrow and stringify it without an explicit annotation.

### Minor 2 — target-side trashing test didn't assert `renames` disjointness

Added the missing assertion to `a superseded pick on the target side has its files trashed too` — but not as a bare `assert.deepEqual(plan.renames, [])`, because that would have been **factually wrong** for this scenario and the test suite would have caught it immediately (it did, on first run: 1 failure). Unlike the source-side sibling — where the group's *only* live file is the one being trashed, leaving nothing else to rename — in the target-side test group 1's file is the *winning* pick, and a merge legitimately relocates the winner's file into the target's directory (`k1/1080.mp4` → `k2/1080.mp4`) regardless of which side's pick lost. So the fix asserts the exact non-empty `renames` array the merge actually produces, plus an explicit disjointness check that the trashed file's id (2) never appears in it — which is the property Minor 2 was actually asking to confirm.

## Gate results after fix round 2

- `npm run lint` — exit 0, no errors (pre-existing warning count and kind unchanged).
- `npm run typecheck` — exit 0, no errors, across all workspaces.
- `npm run test:server` — **861 pass, 0 fail** (860 from round 1, plus the 1 new per-file-quality test). Covering test files: `packages/core/test/manual/identity-plan.test.ts` (all planner tests), exercising fixtures in `packages/core/test/manual/fixtures.ts`. Command: `npm run test:server`.
- `npm run test:web` — **165 pass, 0 fail** (unchanged). Command: `npm run test:web`.
- `npm run build` — succeeds for all four workspaces (`@pickarr/plugin-api`, `@pickarr/plugin-scenes`, `@pickarr/core`, `@pickarr/web`). Command: `npm run build`.
