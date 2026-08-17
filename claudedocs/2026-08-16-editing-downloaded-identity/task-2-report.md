# Task 2 Report: Refactor `trashLiveFiles` to take the rows it should trash

## Status: DONE

## What changed, per file

### `packages/core/src/pipeline/upgrade.ts`
- Renamed `trashLiveFiles` to `trashFiles`.
- New signature: `trashFiles(db, files: readonly ImportedFileRow[], libraryRootReal, trashDir, groupId, now): Promise<string | null>`. It no longer derives its own list — the caller now supplies `files` directly, and the function no longer knows about `importingDownloadId` at all.
- Replaced the doc comment's opening section (the part explaining the exclusion rule that used to live here) with one explaining why the function now takes rows as a parameter: two callers (`liveFilesForGroup` for upgrade-retry safety, `liveFilesForOtherReleases` for the coming identity-merge case) ask genuinely different questions that are not special cases of one another, so deriving either inside `trashFiles` would be wrong for the other caller. Also added a short note on why `groupId` remains a parameter (naming the trash directory) rather than being read off the rows (the rows may be empty).
- Everything from `if (files.length === 0) return null;` through the end of the function — the loop body, the two refusals (non-regular-file, resolves-outside-library-root), the EXDEV copy/unlink fallback, `markTrashed`, and the outer catch that names `destinationDir` — is byte-for-byte unchanged except renaming the loop variable source from `live` to `files` (which was already the parameter name, so this was a no-op rename, not a behavior change).
- Swapped the `liveFilesForGroup` import for `type { ImportedFileRow }` from `../db/imported-files.ts`, since the function no longer calls `liveFilesForGroup` itself.

### `packages/core/src/pipeline/import.ts`
- Updated the one existing caller (in the `download.kind === 'upgrade'` branch of `importDownload`) to call `trashFiles(db, liveFilesForGroup(db, download.groupId, download.id), libraryRootReal, deps.trashDir, download.groupId, now)` — i.e. it now does explicitly, at the call site, exactly what `trashLiveFiles` used to do internally. This is bit-for-bit the same query with the same arguments (`download.groupId`, `download.id`), so the behavior for this caller is unchanged.
- Updated imports: `trashLiveFiles` → `trashFiles` from `./upgrade.ts`; added `liveFilesForGroup` to the existing `../db/imported-files.ts` import.
- Updated four rationale comments that named `trashLiveFiles` by name (two near the call site, two in the catch block) so they still refer to the function correctly. One of these comments explained the retry-safety exclusion rule that has now moved fully into `liveFilesForGroup`'s own docstring in `imported-files.ts`; I repointed that comment to `liveFilesForGroup` rather than `trashFiles`, since `trashFiles` itself no longer contains or explains that rule.

### `packages/core/src/db/imported-files.ts`
- One-line doc fix: `liveFilesForGroup`'s docstring named `trashLiveFiles` as its only caller; updated to `trashFiles` so the reference stays accurate. No code change.

### `packages/core/test/pipeline/upgrade.test.ts`
- Updated imports: `trashLiveFiles` → `trashFiles`; added `liveFilesForOtherReleases` to the `db/imported-files.ts` import; added `lstatOrNull` to the `pipeline/import.ts` import (needed by the brief's new tests).
- **Necessary deviation from the brief** (see "Brief issues" below): the five pre-existing tests in the "Direct unit tests against trashLiveFiles" section called `trashLiveFiles(db, 1, 1, libraryRootReal, trash, N)` directly, using the *old* signature (`groupId, importingDownloadId, ...`). Since the signature changed, these calls no longer compile as written. I updated each call site to `trashFiles(db, liveFilesForGroup(db, 1, 1), libraryRootReal, trash, 1, N)` — i.e., made explicit at the call site exactly what the old signature computed internally — without touching any assertions, fixture setup, or expected outcomes. Updated the section's header comment accordingly (referring to `trashFiles` and explaining the `liveFilesForGroup(db, 1, 1)` argument).
- Appended, verbatim per the brief: the `seedTwoImportedFiles` helper (one group, two releases, one download and one `imported_files` row each, release 1 owning `keep.mp4`) and the two new tests (`trashFiles moves exactly the rows it is given and marks them trashed`, `trashFiles given no rows creates no trash directory`), placed after `tempRoot` at the end of the file, along with a short section comment explaining why these tests exist (to exercise the "caller supplies the rows" call shape that `liveFilesForOtherReleases`/Task 7 will use).

## Gate commands and results

- `npm run lint` — exit 0. Only pre-existing warnings (e.g. `no-await-in-loop`, `preserve-caught-error`) across the codebase, including three pre-existing `no-await-in-loop` warnings in `upgrade.test.ts` at lines that predate this change (the `for` loop in the "trash paths are namespaced" test). No new lint errors or warnings introduced by this task's edits.
- `npm run typecheck` — exit 0, clean across all workspaces.
- `npm run test` (= `test:server` + `test:web`) — exit 0. Server: **837 passed, 0 failed**. Web: **165 passed, 0 failed**.
- `npm run build` — exit 0, all four packages (`plugin-api`, `plugin-scenes`, `core`, `web`) built successfully.

## Confirmation: pre-existing upgrade/import tests

- `packages/core/test/pipeline/import.test.ts` was **not modified at all** — it never called `trashLiveFiles`/`trashFiles` directly, only `liveFilesForGroup` for assertions, so it required no changes. All its tests pass.
- The five `importDownload`-level tests in `upgrade.test.ts` (lines ~74–294: "an upgrade trashes the old file...", "re-running the same upgrade import...", "trash paths are namespaced...", "a failure after trashing reports...", "an initial import trashes nothing...") were **not modified** — they call `importDownload`, not `trashLiveFiles`/`trashFiles`, directly. All five pass unchanged, which is the behavioral evidence that `import.ts`'s caller still produces the identical trash list and identical outcomes as before the refactor.
- The five direct-unit tests against the renamed function *did* need their call sites updated (see above), because they invoked the function's old parameter shape directly — this was unavoidable once the signature changed, and is called out explicitly as a deviation below. All five still pass, with assertions untouched, confirming the underlying try-block behavior is unchanged.
- Full server suite: 837/837 pass, including all 12 tests now in `upgrade.test.ts` (10 pre-existing + 2 new from the brief).

## Brief issues and how I resolved them

1. **The brief's Step 1/Step 5 framing ("the pre-existing upgrade and import tests must pass unchanged") is accurate for the five `importDownload`-driven tests and for `import.test.ts`, but cannot literally hold for the five direct-unit tests against the renamed function** — those call the function by its old name and old positional argument shape, which no longer exists after the rename. The brief's Step 3 (signature change) and Step 4 (update the one caller in `import.ts`) don't mention these five tests at all, but leaving them untouched would fail to compile. I treated "pass unchanged" as "preserve their setup, assertions, and expected behavior unchanged," and updated only the call expression to match the new signature (wrapping the old `groupId, importingDownloadId` pair in an explicit `liveFilesForGroup(db, groupId, importingDownloadId)` call, matching what the removed internal call used to do) — a mechanical, behavior-preserving adaptation, not a functional change. I flagged this rather than silently doing it because it's the one place the brief's instructions and the actual repo state didn't line up.
2. No other discrepancies found. The interface signature, test bodies, `seedTwoImportedFiles` shape, and file/line references in the brief matched the repo as found (the `liveFilesForOtherReleases` function from Task 1 was present exactly as described, `filesForGroup` and `lstatOrNull` were exported as stated).

## Concerns

- None outstanding. The `try` block contents were diffed line-by-line against the pre-change version and confirmed identical aside from the `live` → `files` variable rename (which was already required since `files` was the new parameter name).
- Per instructions, changes are staged (`git add`) but **not committed**.

## Files staged

- `packages/core/src/pipeline/upgrade.ts`
- `packages/core/src/pipeline/import.ts`
- `packages/core/src/db/imported-files.ts`
- `packages/core/test/pipeline/upgrade.test.ts`

(Task 1's already-staged files — `packages/core/src/db/groups.ts`, `packages/core/test/db/groups.test.ts`, `packages/core/test/db/imported-files.test.ts` — were left untouched.)
