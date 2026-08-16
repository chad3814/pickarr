# Task 7 report: Wire it into the running process

## Commit

`554837c` — "Run the performer pass on the metadata tick"

Files changed:
- `packages/core/src/main.ts`
- `packages/core/test/main.test.ts`

## What I implemented

This dispatch overrode two defective instructions in the committed brief (task-7-brief.md). I followed the corrections, not the brief's literal text, on both points.

### Correction 1 — composed the tick as a pure, exported helper instead of extending `main()`'s untestable internals

Added an exported `composeMetadataTick(runScenes, runPerformers)` in `main.ts` (just above `main()`, next to the other small exported helpers `resolveArtworkDir` and `pluginById`):

```ts
export function composeMetadataTick(
  runScenes: () => Promise<void>,
  runPerformers: () => Promise<void>,
): () => Promise<void> {
  return async () => {
    await runScenes();
    await runPerformers();
  };
}
```

Used it at the call site inside the `else` branch (`main.ts:161-208`) to build `runMetadata`:

```ts
runMetadata = composeMetadataTick(runScenes, runPerformers);
```

`main.test.ts` now imports `composeMetadataTick` alongside the existing helpers and has two new tests exercising it directly — no config, no database, no fetch, no scheduler.

### Correction 2 — rewrote the ordering/rate comment to match actual behaviour

The brief's sketch comment claimed a row enqueued this tick is "searched on the next one." That's false: `insertPerformerSearch` sets `next_at = now`, `duePerformerQueue` selects `next_at <= ?`, and each runner reads its own `deps.now()` fresh when it runs — so a row the scene pass just enqueued is due and gets drained in the *same* tick. I replaced that sentence with the true mechanism, kept the true parts (one tick, no second interval, scenes before performers, shared rate-limited service), and added the stated consequence: worst-case provider requests per tick is the *sum* of both passes' `perTick`, not `perTick` itself. Final comment, at `main.ts:182-194`:

> One tick drives both passes, in order. No second interval: a second knob is a second thing to tune wrong, and both passes talk to the same rate-limited service, so sharing one cadence is what keeps the combined request rate predictable. "Predictable" is a bound, not a constant, though: the scene pass can enqueue up to `perTick` rows and the performer pass can then search them, so worst-case provider requests in one tick is the *sum* of both passes' `perTick`, not `perTick` itself. Scenes first — a performer search is the fallback for a scene lookup that settled without a cast, so the pass that produces those rows has to run before the pass that drains them. Each pass reads `now()` fresh when it runs, so a row the scene pass just enqueued (`next_at = now`) is already due by the time the performer pass reads the queue moments later — it is searched in this same tick, not the next one.

### Other changes per the brief (Step 3, verified accurate)

- Widened `tpdbClient`'s declared type at `main.ts:115` from `(SiteLookupClient & SceneLookupClient) | undefined` to `(SiteLookupClient & SceneLookupClient & PerformerLookupClient) | undefined`, and updated the doc comment above it. Confirmed `createTpdbClient`'s return type already includes `PerformerLookupClient` (`clients/theporndb.ts:521`).
- Built `runPerformers` via `createPerformerRunner` from the same `client`, `pluginFor`, `config.metadata.perTick`, `now: () => Date.now()`, `log` — copied from the live `createMetadataRunner` call site's argument shape (`db`, `client`, `pluginFor`, `perTick`, `now`, `log`; `artwork` omitted since `PerformerPassDeps` has no such field).
- `await`ed both runners in sequence inside `composeMetadataTick`, never `Promise.all`.
- Extended the "metadata: enabled..." log line to say `(performer search shares the same tick)`.
- `client` is passed to both runners with no cast — it satisfies `SceneLookupClient` and `PerformerLookupClient` simultaneously once the declaration was widened.
- Did not touch the scheduler's conditional spread (`main.ts:167-169` in the original, now further down) — `runMetadata` still stays `undefined` under the same two conditions as before, so an absent `runMetadata` still means "register no timer."
- Did not touch `pipeline/performers.ts`'s hardcoded `'theporndb'` upsert source, nor the `performers.ts` ↔ `metadata.ts` import cycle — both explicitly out of scope for this task.

## TDD evidence

### RED

Added the import and two tests to `main.test.ts` first, referencing `composeMetadataTick`, which did not yet exist:

```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
node --import tsx --conditions development --test packages/core/test/main.test.ts
```

Output:
```
SyntaxError: The requested module '../src/main.ts' does not provide an export named 'composeMetadataTick'
...
✖ packages/core/test/main.test.ts (489.852186ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

### GREEN

After adding `composeMetadataTick` to `main.ts` and wiring it in:

```
node --import tsx --conditions development --test packages/core/test/main.test.ts
```

Output (tail):
```
✔ composeMetadataTick runs the scene pass and then the performer pass, in order (1.872437ms)
✔ composeMetadataTick awaits the scene pass before starting the performer pass (0.442151ms)
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

## Mutation test

Swapped the two awaits inside `composeMetadataTick` (`runPerformers()` before `runScenes()`) and reran the same command. Both new tests failed as expected:

```
✖ composeMetadataTick runs the scene pass and then the performer pass, in order (6.629085ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    actual: [ 'performers', 'scenes' ]
    expected: [ 'scenes', 'performers' ]
✖ composeMetadataTick awaits the scene pass before starting the performer pass (0.937435ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
    actual: [ 'performers', 'scenes' ]
    expected: [ 'scenes', 'performers' ]
ℹ tests 11
ℹ pass 9
ℹ fail 2
```

Then restored the correct order (`runScenes()` then `runPerformers()`) and reran — back to 11/11 passing.

## Full verification (`npm run check` and `npm run build`)

Both run with `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"` first (confirmed `node -v` reaches v24.19.0).

### `npm run check`

Exit code 0. Lint: only pre-existing `warning` lines (no-shadow, no-await-in-loop, preserve-caught-error) across unrelated files — none introduced by this task, and none are errors. Typecheck: green across all five packages (`@pickarr/core`, `@pickarr/e2e`, `@pickarr/plugin-api`, `@pickarr/plugin-scenes`, `@pickarr/web`) — this is the check that would have caught a `tpdbClient` widening mistake at the `resolveSitesForBatch` call site (`main.ts:229-230`, still typed `client: tpdbClient`), and it passed.

Test summary:
```
ℹ tests 890
ℹ pass 890
ℹ fail 0
```
(core package — 888 baseline + 2 new `composeMetadataTick` tests)
```
ℹ tests 165
ℹ pass 165
ℹ fail 0
```
(web package — unchanged)

### `npm run build`

```
> @pickarr/plugin-api@0.1.0 build
  dist/index.js  900b
⚡ Done in 7ms

> @pickarr/plugin-scenes@0.1.0 build
  dist/index.js  47.6kb
⚡ Done in 15ms

> @pickarr/core@0.1.0 build
  dist/main.js  163.9kb
⚡ Done in 22ms

> @pickarr/web@0.1.0 build
vite v6.4.3 building for production...
✓ 58 modules transformed.
dist/index.html                   1.14 kB │ gzip:  0.41 kB
dist/assets/index-DXWmfbQi.css    3.64 kB │ gzip:  1.18 kB
dist/assets/index-CvUo4Mza.js   267.47 kB │ gzip: 83.19 kB
✓ built in 2.39s
```
Exit code 0 on both runs (ran twice — once before, once after a comment-only follow-up edit).

## Deferred tests — explicit statement

The brief's Step 1 specified three tests. Only the first (`one metadata tick runs the scene pass and then the performer pass`) is implementable, and per this dispatch's Correction 1 it was implemented as two focused tests against the new pure `composeMetadataTick` helper rather than against `main()` itself.

The other two brief tests — `metadata disabled runs neither pass` and `no provider client runs neither pass` — are **deferred as untestable without a refactor**. `main()` is a non-exported, zero-argument `async function` that reads config from disk, opens a real database, and uses the global `fetch`; there is no seam through which a test can inject a fake fetch, a fake db, or reach the `if (!config.metadata.enabled) / else if (tpdbClient === undefined) / else` branching that decides whether `runMetadata` gets built at all.

This is tolerable because this task's only change *inside* that branching is additive and confined to the pre-existing `else` branch (now `main.ts:161-208`): the `if (!config.metadata.enabled)` branch and the `else if (tpdbClient === undefined)` branch are byte-for-byte untouched by this diff. Their behavior — `runMetadata` stays `undefined`, the scheduler registers no timer, nothing is invoked — is preserved by construction (the branches were not touched), not verified by a new test. The pre-existing test suite that exercises `main.ts`'s other exported helpers continues to pass unchanged, and `npm run check`'s 890/890 confirms no regression was introduced anywhere reachable by the existing tests.

## Self-review findings

- First edit attempt duplicated the `createTpdbClient` import (I initially added a second import statement instead of extending the existing one at line 9); caught immediately by rereading the diff before running anything, and fixed by merging into one import block.
- First draft of the rate-predictability comment used an invented phrase ("predictable *per pass*") that read as internally contradictory. Reworded on self-review to state plainly: sharing one cadence keeps the combined rate *bounded and predictable*, but the bound is a sum, not `perTick` itself — matching exactly what the dispatch's Correction 2 asked to be stated, no more.
- Verified `PerformerPassDeps`'s actual shape (`db`, `pluginFor`, `log` from `PerformerEnqueueDeps`, plus `client`, `perTick`, `now`) against `pipeline/performers.ts:17-26,102-106` before writing the `createPerformerRunner` call — matches what I wrote, no `artwork` field to omit-by-mistake.
- Confirmed the widened `tpdbClient` type doesn't break the `resolveSitesForBatch` call site at what is now `main.ts:229-230` — widening only adds capabilities, and `npm run check`'s typecheck stage confirms no compile error there.
- Ran `npm run check` and `npm run build` twice — once before and once after the comment cleanup — both green both times, so the final committed state matches what was verified.
- No `any`, no `unknown`-as-shortcut anywhere in the diff. Two-space indent and semicolons preserved. `.ts` extensions kept on all import specifiers.
- Did not touch the two explicitly-deferred items (hardcoded `'theporndb'` upsert source in `pipeline/performers.ts`; the `performers.ts` ↔ `metadata.ts` import cycle) — confirmed by `git diff --stat` showing only `main.ts` and `main.test.ts` changed.
- Working tree is clean after the commit (`git status` shows nothing pending); did not push, did not create a branch.

## Concerns

None. The implementation is narrow, matches the corrected brief exactly, and both `npm run check` and `npm run build` — the two commands this task specifically calls out as catching different failure classes for the widened `tpdbClient` type — are green.
