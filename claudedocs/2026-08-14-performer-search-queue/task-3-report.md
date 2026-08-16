# Task 3 Report: Ask the provider

## What I implemented

In `packages/core/src/clients/theporndb.ts`:

1. **New interfaces** (near `SceneLookupClient`, line 146): `PerformerSearchResult`, `PerformerSearchPage`, `PerformerLookupClient` — verbatim from the brief.
2. **Extracted `readPerformerFields`** — the shared five-field reader, parameterised on `kind` and an optional `nameFallback`. This is the load-bearing refactor: it does not derive `kind` itself, so the caller decides whether to look at `parent` (scene performers) or `is_parent` (search results).
3. **Rewrote `readPerformers`'s loop body** to call `readPerformerFields(source, parent === null ? 'performer-site' : 'performer', site)`, preserving its existing doc comment and all prior behaviour.
4. **Added `readPerformerPage`** (beside `readScenes`) — reads `data[]` via `readPerformerFields` keyed on `is_parent === true`, reads `aliases` (empty-array fallback), and computes `truncated` from `meta.last > 1`.
5. **Added `searchPerformers`** beside `searchScenes` — one page, `PER_PAGE=100`, `RateLimited` on 429, `redactToken` on both catch paths, `timedOut` race on both the fetch and the JSON parse. Copied `searchScenes`'s error handling verbatim except for the URL, the "performer search" noun, and swapping `readScenes` for `readPerformerPage`.
6. Widened `createTpdbClient`'s return type to `SiteLookupClient & SceneLookupClient & PerformerLookupClient`.

In `packages/core/test/clients/theporndb.test.ts`: appended the brief's 9 tests verbatim, using the existing `respondWith`/`CONFIG`/`API_KEY` fixtures — no new fixtures invented.

## TDD evidence

### RED

Command:
```
node --import tsx --conditions development --test packages/core/test/clients/theporndb.test.ts
```

Result: `47 pass, 9 fail`. All 9 failures were the new tests, each failing with:
```
TypeError: client.searchPerformers is not a function
```
This is the expected failure — the method did not exist yet.

### GREEN

Same command after implementation:
```
ℹ tests 56
ℹ pass 56
ℹ fail 0
```

## Step 3 checkpoint (refactor only, before the new method existed)

After extracting `readPerformerFields` and rewriting `readPerformers`'s loop body, and *before* adding `searchPerformers`/`readPerformerPage`/the interfaces, ran the full server test suite:

```
npm run test:server
```

Result:
```
ℹ tests 852
ℹ pass 843
ℹ fail 9
```

The 9 failures were exactly the 9 new (not-yet-implemented) performer-search tests (`client.searchPerformers is not a function`). All 843 pre-existing tests passed, including every scene-metadata test that exercises `readPerformers` (e.g. "a performer is read from its parent, which is where the images are", "a parentless performer falls back to itself and is a site performer", "a performer with no usable identity is dropped, not half-read"). This is the proof the refactor changed no behaviour.

## Step 6: mutation evidence (both directions)

### Direction 1 — force `kind` to always `'performer'`

Changed the search call site's `readPerformerFields` call to pass the literal `'performer'` instead of `row['is_parent'] === true ? 'performer' : 'performer-site'`.

Command:
```
node --import tsx --conditions development --test packages/core/test/clients/theporndb.test.ts
```

Result: `55 pass, 1 fail`. Exactly `'a result without is_parent is a site alias, not a canonical performer'` failed:
```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected
+ 'performer'
- 'performer-site'
```

### Direction 2 — force `kind` to always `'performer-site'`

Changed the same call site to pass the literal `'performer-site'`.

Result: `55 pass, 1 fail`. Exactly `'searchPerformers reads a top-level result as a canonical performer'` failed:
```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
{
  ...
+ kind: 'performer-site',
- kind: 'performer',
  ...
}
```

### Restore

Restored the line to `row['is_parent'] === true ? 'performer' : 'performer-site'`. Re-ran:
```
ℹ tests 56
ℹ pass 56
ℹ fail 0
```

Both directions produced a distinct, single, expected failure — proving the `is_parent`-based branch is load-bearing and not replaceable by a constant.

## Final verification

```
npm run check
```
Exit code 0. `oxlint` reported only pre-existing warnings (no errors) in unrelated files. `typecheck` passed across all workspaces. Test totals:
```
ℹ tests 852   (packages/*/test/**/*.test.ts)
ℹ pass 852
ℹ fail 0

ℹ tests 165   (packages/web/test/**/*.test.tsx)
ℹ pass 165
ℹ fail 0
```
852 = 843 baseline + 9 new. 165 web unchanged. Output pristine — no stray noise beyond the pre-existing eslint warnings unrelated to this file.

## Files changed

- `packages/core/src/clients/theporndb.ts` (+172/-14 per `git diff --stat`; net new code plus the `readPerformers` refactor)
- `packages/core/test/clients/theporndb.test.ts` (+155, purely additive)

## Self-review

- **Completeness:** All 7 brief steps done in order. Both interfaces, the shared reader, the search method, and the page reader match the brief's code verbatim (checked by diff against the brief text). `createTpdbClient`'s return type widened as specified.
- **Quality:** Followed the file's existing patterns exactly — two-space indent, semicolons, `.ts` import extensions, no `any`, no gratuitous `undefined` assignment to optional fields (interfaces here use required-or-null fields, not optional properties, so `exactOptionalPropertyTypes` wasn't in play for this file's shapes).
- **Discipline:** No queue writes, no matching logic, no pipeline wiring — confirmed by `git diff --stat` showing only `theporndb.ts` and its test file touched. Did not touch `BACKGROUND_CROP_MARKER`, `isBackgroundCrop`, or `readPosterUrl`, which sit between the refactor site and my new code.
- **Testing:** Followed the brief's TDD order precisely — tests first, watched them fail for the right reason, refactored and re-verified with a full-suite checkpoint isolating the refactor's safety, then implemented, then ran the focused suite and `npm run check`, then proved the guard bites in both directions before restoring. Test output is pristine — no stray warnings from the new code.

## Concerns

None. The corrected line numbers in the task prompt matched the actual file exactly, `MetadataPerformer`'s shape (`plugin-api/src/types.ts:128`) matched the brief's assumptions, and every mutation in Step 6 produced exactly one distinct, expected failure — confirming the `is_parent` branch is genuinely load-bearing rather than passing by coincidence with a constant.
