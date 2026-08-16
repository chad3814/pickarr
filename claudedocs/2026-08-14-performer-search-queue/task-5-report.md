# Task 5 Report: Queue the search when a lookup settles

## What was implemented

- `packages/core/src/pipeline/performers.ts` (new): `PerformerEnqueueDeps`, `performerQueryFor`, `enqueuePerformerSearch` — exactly as given in the brief's Step 3, verbatim.
- `packages/core/src/pipeline/metadata.ts`: added the import of `enqueuePerformerSearch` and the one call site inside `runMetadataPass`, placed between the `try`/`catch` that assigns `outcome` and the counters that follow, gated on `outcome.kind !== 'deferred'` — verbatim from the brief's Step 4.
- `packages/core/test/pipeline/performers-enqueue.test.ts` (new): the seven tests from the brief's Step 1, copied verbatim (including the copied `seedGroup`/`giveCast` helpers).
- `packages/core/test/pipeline/metadata.test.ts`: added an import of `duePerformerQueue`, and filled in the four prose-sketch tests against the file's existing fixtures.

## TDD evidence

### RED

Command:
```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-enqueue.test.ts packages/core/test/pipeline/metadata.test.ts
```

Before `pipeline/performers.ts` existed and before the call site was wired:

- `performers-enqueue.test.ts` failed to load at all: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/pipeline/performers.ts'` — expected, since Step 3 had not run yet.
- `metadata.test.ts`: 20/22 passed, 2 failed:
  - `a confirmed scene that named nobody queues a performer search` — expected `[1]`, got `[]` (nothing populates `performer_queue` yet).
  - `a settled-as-none lookup queues a performer search` — same failure, same reason.
  - The other two new tests (`...supplied a cast...` and `a deferred row...`) trivially passed already, because they assert the queue is *empty*, which holds vacuously with no wiring at all. This is the expected, correct RED for this style of test: only the two "must queue" assertions can fail before implementation; the two "must not queue" assertions cannot go red from missing wiring, only from wiring that queues too eagerly (which Step 6 tests separately).

This matched expectations: the enqueue module's absence blocks the whole first test file, and the metadata pass has no path yet that ever calls into it.

### GREEN

Same command, after Steps 3 and 4:

```
ℹ tests 29
ℹ pass 29
ℹ fail 0
```

All 7 enqueue tests and all 22 metadata tests (18 original + 4 new) passed.

Full `npm run check` (oxlint, typecheck, all core + web tests):
```
ℹ tests 872
ℹ pass 872
ℹ fail 0
(core)
ℹ tests 165
ℹ pass 165
ℹ fail 0
(web)
```
Baseline was 861 core / 165 web; 872 - 861 = 11 = 7 (performers-enqueue.test.ts) + 4 (metadata.test.ts additions). oxlint reported only pre-existing warnings in unrelated files (`theporndb.ts`, `registry.ts`, `import.ts`, `load.ts`, `upgrade.ts` — all `preserve-caught-error`, none in files this task touched). Typecheck passed with no errors.

## The four metadata.test.ts tests

All four use: `openTestDatabase`, `makeGroup(db, 'A Scene', 'Some Site')`, `enqueueMetadata`, `candidate(...)`, `fakeSceneClient(...)`, `deps(...)`, `runMetadataPass`, `getGroupMetadata`, and the newly-imported `duePerformerQueue`. `defaultPluginFor` (unmodified, used implicitly via `deps()`'s default) resolves `'scenes'` to the real `scenesPlugin`, whose `performerQuery` is `scenePerformerQuery` — first two words of `display.title`, or `null` under two words.

Title chosen: **`'A Scene'`** for all four (already the file's own established convention for tests that don't care about a real-looking title, e.g. `'a search that matched nothing is cached as an answer'`). `'A Scene'.split(/\s+/)` yields 2 words, which meets `scenePerformerQuery`'s `WORDS = 2` floor, so every one of these groups gets a real, non-null query (`'A Scene'`) and is eligible to be enqueued whenever the call site's gate allows it. I deliberately did not reach for a one-word title anywhere in these four, per the brief's warning.

1. **`a confirmed scene that supplied a cast queues no performer search`** — `candidate({ ..., performers: [performer()] })`, `fakeSceneClient` returns it. After the pass: `getGroupMetadata(...)?.state === 'confirmed'`, `performersForGroups(...)` non-empty, `duePerformerQueue(db, 1_000, 10)` is `[]`. This exercises the `insertPerformerSearch`-refuses-a-cast path transitively through the call site — the call site itself has no cast check, so this proves that refusal actually engages.
2. **`a confirmed scene that named nobody queues a performer search`** — same shape, `performers: []` (the `candidate()` default). Asserts `state === 'confirmed'` and `duePerformerQueue(...).map(r => r.groupId)` deep-equals `[groupId]`. This is the case a `state = 'none'`-only rule would miss, per the brief.
3. **`a settled-as-none lookup queues a performer search`** — `fakeSceneClient(() => [])` (no candidates at all). Asserts `state === 'none'` and the group is in `duePerformerQueue`.
4. **`a deferred row queues nothing, because it has not settled`** — `fakeSceneClient` throws a plain `Error('ECONNREFUSED')` (not `RateLimited`), driving `deferOrGiveUp` to return `kind: 'deferred'`. Asserts `result.deferred === 1` and `duePerformerQueue(...)` is `[]`.

## Step 6: mutation evidence

Command used to mutate: changed
```ts
if (outcome.kind !== 'deferred') {
  enqueuePerformerSearch({ db: deps.db, pluginFor: deps.pluginFor, log: deps.log }, row.groupId, now);
}
```
to an unconditional call:
```ts
enqueuePerformerSearch({ db: deps.db, pluginFor: deps.pluginFor, log: deps.log }, row.groupId, now);
```

Ran:
```
node --import tsx --conditions development --test packages/core/test/pipeline/metadata.test.ts
```

Result: 21/22 passed, 1 failed exactly as predicted —

```
✖ a deferred row queues nothing, because it has not settled (12.450712ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  actual: [ { groupId: 1, requestedAt: 1000, attempts: 0, nextAt: 1000, lastError: null } ]
  expected: []
```

Restored the `if (outcome.kind !== 'deferred') { ... }` guard (confirmed via `git diff packages/core/src/pipeline/metadata.ts` showing only the intended net addition — the import plus the gated call site, nothing left over from the mutation). Re-ran:
```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-enqueue.test.ts packages/core/test/pipeline/metadata.test.ts
```
→ `29 pass, 0 fail`. Then re-ran the full `npm run check` a second time post-restore → `872 pass / 0 fail` core, `165 pass / 0 fail` web.

## Files changed

- `packages/core/src/pipeline/performers.ts` (new)
- `packages/core/src/pipeline/metadata.ts` (modified: one import, one call site)
- `packages/core/test/pipeline/performers-enqueue.test.ts` (new)
- `packages/core/test/pipeline/metadata.test.ts` (modified: one import, four tests appended)

## Self-review

- Completeness: all 7 brief-specified requirements steps done in order; both consumed interfaces (`insertPerformerSearch`/`groupHasCast`, `MediaTypePlugin.performerQuery`) used exactly as documented; no pass/runner/drain code added — confirmed `performers.ts` contains only the enqueue half, leaving Task 6 a clean file to append to.
- Quality: brief's code and comments used verbatim, since they were given as authoritative; the four metadata tests I wrote follow the existing file's idioms (fixture reuse, comment register, assertion style) rather than introducing a new pattern.
- Discipline: no scope creep — did not touch anything outside the two files the brief names, did not add a drain pass, did not add config knobs.
- Testing: TDD order followed (tests written first, watched fail, then implementation, then the exact call-site diff). Test output is pristine — no stray console output, no warnings from the new files. Confirmed the tests actually exercise behavior (Step 6's mutation proves the deferred-gate test is not vacuous), and confirmed via the confirmed-with-cast test that the "no second cast check at the call site" design decision is real, not assumed.

## Concerns

None. The brief's code compiled and worked as given; no discrepancies found between the brief and the actual codebase (types, fixtures, and call site all matched the brief's claims on inspection).

## Fix report (post-review round)

Review verdict: Spec ✅ / Approved, with one Important finding (a false claim inherited verbatim from the brief) and four Minor findings. All five addressed; two other Minors (duplicated `seedGroup`/`giveCast`, pre-existing `preserve-caught-error` warnings) were explicitly deferred by the reviewer and left untouched.

### Important: `metadata.ts:261`'s comment asserted a false invariant

The comment claimed "This is the only place a metadata row settles." False: `http/server.ts`'s `answerUnaskable(db, groupId, now)` call (lines 713-719) also settles a row — as `state = 'none'` — for a group whose `metadataAnswerability` is `'unaskable'`, and does not enqueue a performer search. Since `metadataAnswerability`'s condition (`sceneMetadataQuery` yields no query) and `scenePerformerQuery`'s condition (fewer than two title words) are different tests, a real scenes group can be metadata-unaskable yet performer-queryable — so that path can silently permanently skip a group this feature was meant to catch.

Fix: reworded the comment to claim only what is true — "the only place *this pass* settles a row" — and named the other settle path (`http/server.ts`'s `answerUnaskable`) and its asymmetry explicitly as unresolved rather than deliberate. Per the reviewer's instruction, `http/server.ts` itself was not touched; that's a spec-level call being escalated separately. Kept the `deriveUpgradeReleaseId` single-call-site argument, which is still sound.

### Minor 1: `performers.ts` returned the untrimmed query

`performerQueryFor` guarded on `query.trim().length === 0` but returned the original `query`, so `'  Jessica Jaymes  '` would have passed through with its padding intact — and Task 6 sends this string straight to a provider search. Changed the return to `query.trim()` so the guard and the returned value agree.

### Minor 2: the catch's log line misattributed a corrupt-`display` failure to the plugin

`JSON.parse(group.display)` sits inside the same `try` as `plugin.performerQuery(...)`, so a malformed `display` column threw the identical message shape as a genuine plugin bug: "plugin threw building the query." Per the reviewer's explicit instruction, only the wording changed — the parse was *not* moved outside the `try`, since `performerQueryFor` is called from inside `runMetadataPass`'s loop and a throw escaping it would abort the rest of the pass. New message: `"...skipped, building the query threw (plugin or malformed display): ..."`, with a comment explaining why both are named.

### Minor 3: the whitespace-only-query branch had no test

Added `'a plugin returning only whitespace is treated the same as no query'` to `performers-enqueue.test.ts`: a plugin returning `'   '` must make `performerQueryFor` return `null` and `enqueuePerformerSearch` return `false` with nothing queued. Verified this test is not vacuous by temporarily reverting to `return query === null ? null : query;` — no length/trim check — and confirming exactly this one new test fails (`AssertionError: expected null !== '   '`), then restoring.

### Minor 4: `metadata.test.ts` test 1 was not self-standing

`'a confirmed scene that supplied a cast queues no performer search'` would have passed even if the enqueue call site were deleted entirely, since an empty `duePerformerQueue` is also what "nothing ever enqueues" looks like — its meaning depended on the reader also holding test 2 (identical arrangement, no cast) in mind. Added an assertion before `runMetadataPass` runs: `performerQueryFor({ db, pluginFor: defaultPluginFor, log: () => undefined }, groupId)` equals `'A Scene'`, proving the group was eligible, so the subsequent empty queue can only be explained by the cast refusal, not by non-eligibility.

### Commands and output

Focused tests, after all five fixes:
```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-enqueue.test.ts packages/core/test/pipeline/metadata.test.ts
```
```
ℹ tests 30
ℹ pass 30
ℹ fail 0
```
(30 = 8 enqueue tests [7 original + 1 new whitespace test] + 22 metadata tests, all green, output pristine.)

Full suite:
```
npm run check
```
```
ℹ tests 873   (core; 872 + 1 new whitespace test)
ℹ pass 873
ℹ fail 0
ℹ tests 165   (web, unchanged)
ℹ pass 165
ℹ fail 0
```
oxlint and typecheck both clean (oxlint's only output was the same pre-existing `preserve-caught-error` warnings in files this task never touches, which the reviewer explicitly said to leave alone).

### Files changed in this round

- `packages/core/src/pipeline/metadata.ts` (comment only)
- `packages/core/src/pipeline/performers.ts` (trim fix + log wording + explanatory comment)
- `packages/core/test/pipeline/metadata.test.ts` (import + one added assertion in test 1)
- `packages/core/test/pipeline/performers-enqueue.test.ts` (one new test)

Commit: `90964c7` — "Fix task 5 review findings: correct a false invariant, trim the query, and widen a misattributed log line"

### Self-review of the fix round

- Followed the reviewer's explicit constraints exactly: did not touch `http/server.ts`, did not restructure the `try`/`catch` in `performers.ts`, kept the deferred Minors (duplicated fixtures, branch-level lint warnings) untouched.
- Verified the new whitespace test is load-bearing (not just present) by reverting the trim/length guard and watching it — and only it — fail.
- Re-ran the full check suite twice: once focused, once full, both clean.
