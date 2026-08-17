# Task 4 Report: Give the manual operations a library to write to

## Summary

Successfully implemented pure plumbing to pass `trashDir` and an injectable `rename` function through `ManualDeps` and `ServerDeps`. All 8 files modified, full test gate passing (165 tests), typecheck clean, build successful.

## Changes Per File

### Source Files

1. **packages/core/src/manual/operations.ts**
   - Added import: `import type { RenameLike } from '../pipeline/import.ts';`
   - Extended `ManualDeps` interface with:
     - `trashDir: string` — the directory where superseded files are moved
     - `rename?: RenameLike` — injectable rename for test failure injection

2. **packages/core/src/http/server.ts**
   - Added to `ServerDeps` interface:
     - `trashDir: string` — passed through from config, not re-read here
   - Updated `manual` object in `buildServer()` function:
     - Added `trashDir: deps.trashDir,` to wire through the dependency

3. **packages/core/src/main.ts**
   - Updated `buildServer()` call:
     - Added `trashDir: config.trashDir,` beside `artworkDir` for consistency

4. **packages/e2e/src/harness.ts**
   - Updated `buildServer()` call in e2e test harness:
     - Added `trashDir,` to match the interface requirement (discovered during typecheck)

### Test Fixture Files

5. **packages/core/test/manual/operations.test.ts**
   - Updated `makeDeps()` helper:
     - Added `trashDir: '/trash',` to `ManualDeps` construction

6. **packages/core/test/http/server.test.ts**
   - Updated `deps()` fixture function:
     - Added `trashDir: '/trash',` to `ServerDeps` construction

7. **packages/core/test/http/manual.test.ts**
   - Updated `deps()` fixture function:
     - Added `trashDir: '/trash',` to `ServerDeps` construction

8. **packages/core/test/http/metadata.test.ts**
   - Updated `deps()` fixture function:
     - Added `trashDir: '/trash',` to `ServerDeps` construction

## ServerDeps Construction Sites Found

The brief's file list was incomplete. Full survey via `grep -rln "ServerDeps" packages/core/test` found **4 total construction sites** (3 initially listed, plus 1 in e2e):

1. ✅ packages/core/test/http/server.test.ts — `deps()` function
2. ✅ packages/core/test/http/manual.test.ts — `deps()` function
3. ✅ packages/core/test/http/metadata.test.ts — `deps()` function
4. ✅ packages/e2e/src/harness.ts — `buildServer()` call (discovered during typecheck)

All four updated with the new `trashDir` field.

## Gate Test Results

```
npm run lint    ✅ PASS (warnings pre-existing, not new)
npm run typecheck ✅ PASS (all 5 workspaces clean)
npm run test    ✅ PASS (165 tests passed)
npm run build   ✅ PASS (all bundles built successfully)
```

### Test Count: 165 total, 0 failed

Tests include:
- 1 core package typecheck
- 1 e2e package typecheck  
- 3 plugin package typechecks
- 1 web package typecheck
- All manual operations tests
- All HTTP server, manual, and metadata endpoint tests
- All web UI tests

## Ambiguities Resolved

1. **Missing e2e harness update** — Brief noted only 3 test files; grep and typecheck revealed e2e/src/harness.ts also constructs ServerDeps. Added `trashDir,` there.

2. **Test fixture trash directory** — Brief said `'/trash'` is fine if tests don't reach filesystem. Confirmed: no test in this task's scope uses the trashDir value for actual filesystem operations.

3. **Order of trashDir in buildServer object** — Brief showed `trashDir` addition with no position specified. Placed alongside `requestRestart` (last field) to maintain alphabetical grouping with other administrative fields.

## No Concerns

- No prior work was reverted (pipeline/import.ts, pipeline/upgrade.ts, db/groups.ts, db/imported-files.ts remain untouched)
- RenameLike import exists and is correctly sourced
- config.trashDir already exists in schema and is validated in main.ts
- makeDeps helper in operations.test.ts updated alongside ServerDeps fixtures
- Full gate passes with zero new errors or warnings

All staged, no commits created per instructions.
