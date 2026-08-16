# Task 1 Report: The plugin says what to search for

## Status: DONE

## What changed and why

1. **`packages/plugin-api/src/types.ts`** — added `performerQuery?(identity: GroupIdentity): string | null;` to the `MediaTypePlugin` interface, positioned immediately after `metadataQuery` and before `confirmMetadata`, with the doc comment given verbatim in the brief. `GroupIdentity` was already exported from this file (line ~96), so no redefinition was needed.

2. **`packages/plugin-scenes/src/performer-query.ts`** (new) — exports `scenePerformerQuery(group: GroupIdentity): string | null`, which trims the group's `display.title`, splits on runs of whitespace, drops empty tokens, and returns the first two words joined by a single space, or `null` if fewer than two words remain. Transcribed verbatim from the brief, including the `WORDS = 2` constant and its comments.

3. **`packages/plugin-scenes/src/index.ts`** — added `import { scenePerformerQuery } from './performer-query.ts';` beside the other metadata imports, and added `performerQuery: (group) => scenePerformerQuery(group),` to the plugin object literal directly after `metadataQuery` (previously line 55, now line 56).

4. **`packages/plugin-scenes/test/performer-query.test.ts`** (new) — the 6 tests specified in the brief, transcribed verbatim.

No stripping logic was added to `scenePerformerQuery` — per the brief's context, `display.title` from `plugin-scenes`' `buildRelease` is already site-stripped, date-stripped, and quality-suffix-stripped, so the title is the scene title alone.

## Test commands and output summaries

**Baseline (before any change), full check:**
```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
npm run check
```
Result: exit 0. Core: `tests 813, pass 813, fail 0`. Web: `tests 165, pass 165, fail 0`. Matches the stated baseline exactly.

**Step 2 — new test file before implementation exists:**
```
TSX_TSCONFIG_PATH=packages/plugin-scenes/tsconfig.json node --import tsx --conditions development --test packages/plugin-scenes/test/performer-query.test.ts
```
Result: `ERR_MODULE_NOT_FOUND` for `packages/plugin-scenes/src/performer-query.ts`, as expected — `tests 1, pass 0, fail 1`.

**Step 6 — new test file after implementation:**
```
TSX_TSCONFIG_PATH=packages/plugin-scenes/tsconfig.json node --import tsx --conditions development --test packages/plugin-scenes/test/performer-query.test.ts
```
Result: `tests 6, pass 6, fail 0`. All six named tests passed, including the punctuation-preservation and whitespace-collapse cases.

**Step 6 — full check after implementation:**
```
npm run check
```
Result: exit 0. Core: `tests 819, pass 819, fail 0` (813 baseline + 6 new). Web: `tests 165, pass 165, fail 0` — unchanged. oxlint reported only pre-existing `preserve-caught-error` warnings in files this task did not touch (`theporndb.ts`, `upgrade.ts`, `import.ts`, `registry.ts`, `load.ts`) — not introduced by this change.

## Mutation-test evidence (Step 7)

Changed `const WORDS = 2;` to `const WORDS = 1;` in `packages/plugin-scenes/src/performer-query.ts`, then re-ran:
```
TSX_TSCONFIG_PATH=packages/plugin-scenes/tsconfig.json node --import tsx --conditions development --test packages/plugin-scenes/test/performer-query.test.ts
```
Result: `tests 6, pass 1, fail 5`. Failing tests included the one named in the brief:
- `✖ a one-word title yields nothing rather than a one-word query` — failed as `assert.equal(scenePerformerQuery(identity('Solo')), null)` now returned `'Solo'` instead of `null`.
- Also failed (expected side effects of a one-word query length): `the query is the first two words of the title`, `a two-word title is used whole`, `runs of whitespace collapse rather than producing an empty second word`, `punctuation inside a word is kept, because the provider matches on the name`.
- Only `an empty or whitespace title yields nothing` still passed, since an empty/whitespace title has zero words regardless of `WORDS`.

Restored `const WORDS = 2;`, re-ran the same command: `tests 6, pass 6, fail 0`. Confirmed the fix restored green. Also re-ran full `npm run check` after restoring: exit 0, `819`/`819` core, `165`/`165` web — matching the post-implementation state exactly, confirming no residual change from the mutation exercise.

## Commit

```
git add packages/plugin-api/src/types.ts packages/plugin-scenes/src/performer-query.ts \
        packages/plugin-scenes/src/index.ts packages/plugin-scenes/test/performer-query.test.ts
git commit -m "Ask the plugin what to search a performer directory for"
```
Commit SHA: `15a3070` on branch `feature/performer-search-queue`. 4 files changed, 100 insertions. Not pushed.

## Concerns about the brief

None found. The brief's code, test, and wiring instructions matched the codebase exactly as described:
- `GroupIdentity` was already exported as specified — no redefinition needed.
- `metadataQuery` and `siteCandidates` docs in `types.ts` follow the same argumentative comment register the brief asked to match; the new `performerQuery` doc was transcribed verbatim and reads consistently with its neighbors.
- The plugin object literal in `index.ts` matched the brief's description of surrounding lines (`siteCandidates`, `metadataQuery`, `confirmMetadata` at lines 54–56) precisely, so insertion was mechanical.
- The one-word mutation test bites exactly as claimed, and it is the most direct evidence that `WORDS` is load-bearing rather than decorative.

No design or requirements ambiguity encountered; this task was transcription plus verification as instructed, and no deviations from the brief's exact text were made.
