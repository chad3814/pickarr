# Task 1 Report: Release-scoped live-file selector, and movers for `downloads` and `imported_files`

## Summary

Implemented the three functions specified in the brief, transcribed verbatim (SQL, names, and comments unchanged), plus their tests.

## Changes per file

### `packages/core/src/db/imported-files.ts`
Added `liveFilesForOtherReleases(db, groupId, keepReleaseId)` immediately after `liveFilesForGroup` (before `findLiveByDest`), exactly as given in the brief. It joins `imported_files` to `downloads` on `download_id` so the exclusion can be scoped by `release_id` rather than by `download_id`. Reused the file's existing local `toRow` and the already-imported `SqlRow` type — no new imports were needed since `SqlRow` was already imported from `./row.ts`.

### `packages/core/src/db/groups.ts`
Added `moveDownloadsToGroup(db, fromGroupId, toGroupId)` and `moveImportedFilesToGroup(db, fromGroupId, toGroupId)` immediately after `moveReleasesToGroup`, exactly as given in the brief. Both are single parameterized `UPDATE ... SET group_id = ? WHERE group_id = ?` statements with no new type dependencies.

### `packages/core/test/db/imported-files.test.ts` (new)
Created with the four tests from the brief's Step 1, verbatim: the release-scoped exclusion returning both non-kept releases' files, skipping an already-trashed row, treating a null `keepReleaseId` as "keep nothing," and the key regression case — a release that imported twice (a retry) keeps both of its files when it is the one being kept.

### `packages/core/test/db/groups.test.ts`
Added `moveDownloadsToGroup`, `moveImportedFilesToGroup` to the existing `../../src/db/groups.ts` import, and added a new import `import { num, type SqlRow } from '../../src/db/row.ts';` (this file had no prior import from `row.ts`). Appended the brief's `moveDownloadsToGroup and moveImportedFilesToGroup repoint both tables` test verbatim at the end of the file.

## Gate commands run and results

- `npm run test:server -- --test-name-pattern="liveFilesForOtherReleases|imported twice|repoint both tables"` — ran the full 835-test server suite (the `--test-name-pattern` flag does not appear to actually filter under this project's `node --test` invocation; noted but not something in scope to fix). Confirmed by grep that all 5 new tests are present and passing:
  - `moveDownloadsToGroup and moveImportedFilesToGroup repoint both tables` ✔
  - `liveFilesForOtherReleases returns the files of every release but the kept one` ✔
  - `liveFilesForOtherReleases skips files already trashed` ✔
  - `liveFilesForOtherReleases with no kept release returns every live file` ✔
  - `a release that imported twice keeps both of its files when it is the kept one` ✔
- `npm run lint` — exit 0. Only pre-existing warnings elsewhere in the codebase (no-await-in-loop, preserve-caught-error, no-shadow, etc.); none in the four files touched by this task.
- `npm run typecheck` — exit 0, clean across all workspaces.
- `npm run test` — exit 0. `test:server`: 835 pass / 0 fail. `test:web`: 165 pass / 0 fail.
- `npm run build` — exit 0. All four packages (`plugin-api`, `plugin-scenes`, `core`, `web`) built successfully.

## Brief accuracy

Nothing in the brief was wrong or ambiguous. The code, SQL, and comments were used exactly as given. The only judgment calls were mechanical:
- `SqlRow` was already imported in `imported-files.ts`, so no import change was needed there (context clue #5 anticipated this correctly).
- `groups.test.ts` had no prior import from `row.ts`, so I added `import { num, type SqlRow } from '../../src/db/row.ts';` as a new import line, per the brief's instruction to add `num`/`SqlRow` "if not already imported."
- Did not add `getImportedFile` or `setImportedFileDest` per the explicit ruling that they belong to a later task.

## Concerns

None. All three functions are pure transcriptions of the brief with no design decisions, and the full gate (lint, typecheck, test, build) is green.

## Files staged

```
M  packages/core/src/db/groups.ts
M  packages/core/src/db/imported-files.ts
M  packages/core/test/db/groups.test.ts
A  packages/core/test/db/imported-files.test.ts
```

No commit was made, per instructions.
