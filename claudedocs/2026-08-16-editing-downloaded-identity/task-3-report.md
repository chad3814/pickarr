# Task 3 Implementation Report

## Summary
Completed Task 3: Exposed the file mover for reuse inside the library. All changes transcribed from the brief exactly as specified. All tests passing, full gate successful.

## Changes Made

### packages/core/src/pipeline/import.ts

1. **Line 137: Added `export` keyword to `resolveDestination` function**
   - Changed: `function resolveDestination(...)` 
   - To: `export function resolveDestination(...)`
   - This function was already defined and now is exported for reuse by the rename path.

2. **Line 13: Verified `RenameLike` type is already exported**
   - Confirmed: `export type RenameLike = (source: string, destination: string) => Promise<void>;`
   - No change needed—already exported.

3. **Lines 299-307: Added new `moveWithinLibrary` function after `transfer`**
   - Exact transcription from brief with complete comment explaining the rationale
   - Thin named wrapper over `transfer` in 'move' mode
   - Default `renameImpl` parameter is the `rename` function from node:fs/promises
   - Delegates to `transfer` with mode='move' and injects libraryRootReal

### packages/core/test/pipeline/import.test.ts

1. **Updated imports (lines 1-12)**
   - Added `realpath` to the fs/promises destructuring
   - Added `lstatOrNull` and `moveWithinLibrary` to the import from pipeline/import.ts

2. **Added three test cases (lines 630-686)**
   - `moveWithinLibrary moves a file and keeps it inside the library root`: Verifies basic file movement with directory creation and validates file is gone from source.
   - `moveWithinLibrary falls back to copy when rename reports EXDEV`: Tests the cross-filesystem fallback path by providing a mock renameImpl that rejects with EXDEV, confirms file ends up at destination and source is removed.
   - `moveWithinLibrary refuses a destination outside the library root`: Validates containment check by attempting to move a file outside the library root and confirming rejection.

## Gate Results

All gates passed successfully:

```
npm run lint     → PASS (no new errors, pre-existing warnings only)
npm run typecheck → PASS (all packages)
npm run test     → PASS (165 web tests)
npm run test:server → PASS (840+ core tests, including 3 new moveWithinLibrary tests)
npm run build    → PASS (all packages)
```

### Test Summary
- **New Tests**: 3 (all passing)
  - ✔ moveWithinLibrary moves a file and keeps it inside the library root (5.203417ms)
  - ✔ moveWithinLibrary falls back to copy when rename reports EXDEV (6.285542ms)
  - ✔ moveWithinLibrary refuses a destination outside the library root (2.904834ms)
- **Total Core Tests**: 840 passing
- **Total Web Tests**: 165 passing

## Observations

1. **Brief Accuracy**: The brief was precise and complete. Code transcription was straightforward with no ambiguities.

2. **Pre-existing State**: Confirmed that:
   - `lstatOrNull` was already exported (line 46)
   - `RenameLike` was already exported (line 13)
   - Previous task's changes to `trashFiles` call in `importDownload` (line 375) were left untouched as instructed

3. **Type Safety**: All code maintains strict type safety—no use of `any` or `unknown` types. The `RenameLike` default parameter is correctly typed.

4. **Async Preference**: `moveWithinLibrary` uses async/await consistently with the rest of the pipeline module.

5. **Test Structure**: New tests follow existing patterns in the test file:
   - Use `mkdtemp` for isolation
   - Use `realpath` for library root anchor
   - Proper cleanup with `rm(..., { recursive: true, force: true })`
   - Clear assertion messages

## Files Staged
- `packages/core/src/pipeline/import.ts` (modified)
- `packages/core/test/pipeline/import.test.ts` (modified)

## Concerns
None. Implementation is complete, tests pass, types are correct, and all code quality gates pass.
