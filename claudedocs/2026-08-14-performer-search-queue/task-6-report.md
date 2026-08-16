# Task 6 report — Drain the queue

Commit: `ed14b65` Drain the performer queue, linking only an unambiguous match
Branch: `feature/performer-search-queue` (not pushed). Working tree clean.

## What I implemented

Appended the drain half to `packages/core/src/pipeline/performers.ts`, beside task 5's
enqueue half (which I did not touch):

- `MAX_PERFORMER_ATTEMPTS = 50`, with the `MAX_METADATA_ATTEMPTS` reasoning restated
  for this queue (nine attempts to the six-hour cap, fifty ≈ ten days past the ramp).
- `PerformerPassDeps extends PerformerEnqueueDeps` (adds `client`, `perTick`, `now`),
  and `PerformerPassResult`.
- `recordPerformerOutcome` — one `BEGIN`/`COMMIT` holding the `groupHasCast` re-check,
  `upsertPerformers` + `setGroupPerformers`, and `removePerformerSearch`; `ROLLBACK`
  and rethrow on failure. No nested transaction, per the contract both `db/performers.ts`
  helpers document.
- `deferOrGiveUp` — a fresh statement outside whatever transaction just rolled back;
  removes the row at `MAX_PERFORMER_ATTEMPTS`, otherwise `deferPerformerSearch`.
- `runPerformerPass` — returns early with no reads when `client === undefined`; drains
  `duePerformerQueue` sequentially; settles a row whose query has gone away without a
  search; logs a truncated page; `break`s on `RateLimited` setting `cooldownUntil` and
  leaving the row's `attempts`/`next_at` alone; defers on any other error using the
  pass's captured `now` plus `backoffFor(row.attempts)`.
- `createPerformerRunner` — `createMetadataRunner`'s closure with the names, pass and
  log prefix changed: holds `cooldownUntil` and `loggedSkip`, makes no provider request
  inside a cooldown (never calls `runPerformerPass`, so `duePerformerQueue` is not read),
  logs the skip once per cooldown, and `?? 0` clears a lapsed cooldown.

`backoffFor` in `packages/core/src/pipeline/metadata.ts` is now exported, with a doc
comment saying the performer pass shares the curve rather than keeping a second copy.

Test file created: `packages/core/test/pipeline/performers-pass.test.ts` (13 tests),
with `seedGroup`, `giveCast` and `pluginWith` copied in from `performers-enqueue.test.ts`
as the brief directs.

## TDD evidence

### RED (Step 2, before any implementation)

```
$ node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
packages/core/test/pipeline/performers-pass.test.ts:10
  MAX_PERFORMER_ATTEMPTS,
  ^
SyntaxError: The requested module '../../src/pipeline/performers.ts' does not provide an export named 'MAX_PERFORMER_ATTEMPTS'
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Expected: the module under test exports none of `MAX_PERFORMER_ATTEMPTS`,
`runPerformerPass`, `createPerformerRunner` or `PerformerPassDeps` yet, so the file
cannot even link — an ESM link error is the earliest and most honest red for a test
file written against an API that does not exist.

### GREEN (Step 6, after Steps 3–5 and the defect-1 fix)

```
$ node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
✔ a single exact match is linked and the row is settled
✔ an alias-only match is linked, since that is what the filename carried
✔ no match settles the row without writing anything
✔ an ambiguous result settles the row without writing anything
✔ a cast that appeared between enqueue and drain is not clobbered
✔ a 429 breaks the pass, leaving the rows behind it untouched
✔ an ordinary failure defers the row with its message
✔ a row that has failed too often is given up on rather than deferred forever
✔ a row whose own write throws still has its attempts bumped
✔ a query that has gone away settles the row rather than retrying forever
✔ a truncated page is judged, and the truncation is logged rather than silent
✔ no client means no pass and no reads
✔ createPerformerRunner makes no request inside a cooldown, and says so once
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

### Full check

```
$ npm run check          # oxlint && typecheck && tests
ℹ tests 886   ℹ pass 886   ℹ fail 0     (core)
ℹ tests 165   ℹ pass 165   ℹ fail 0     (web)
```

886 = the verified 873 baseline + the 13 new tests. Lint and typecheck both passed
(the chain is `&&`). No oxlint warning names either file I touched — I grepped the
captured output for `pipeline/(performers|metadata)` and it matched nothing. Node
v24.19.0 throughout, so none of the three `AbortSignal.timeout` mock failures appeared.

## Empirical check of brief defect 1

Ran the poison-row test exactly as the brief wrote it (group 2 answered
`found('Someone Else')`, an exact match for its own query `Someone Else`):

```
✖ a row whose own write throws still has its attempts bumped
  AssertionError [ERR_ASSERTION]: the failing row deferred rather than throwing
  2 !== 1
  actual: 2, expected: 1
```

`result.deferred` was **2**, confirming the dispatch's analysis: the `no_link` trigger
refuses *every* `group_performers` insert, so group 2's own link write aborted too and
both rows deferred.

Fix applied, as directed: group 2's supplied answer is now `found('Nobody At All')`,
which matches neither its name nor an alias, so group 2 settles `unmatched` with no
`group_performers` write and never reaches the trigger. Both `calls` assertions are
untouched (`['Jessica Jaymes', 'Someone Else']` still proves group 2 was reached), the
`attempts === 1` assertion on group 1 is untouched, and no assertion was edited to fit
observed behaviour. I added a short comment above the answers explaining why group 2's
answer deliberately matches nothing, so a later reader does not "correct" it back into
a match and silently weaken the test.

## Step 7 mutation evidence (the clobber guard)

The clobber-guard test is the **fifth** in the file, `a cast that appeared between
enqueue and drain is not clobbered`, as the dispatch notes (not "test 4").

Mutation: `if (performer !== null && !groupHasCast(deps.db, groupId))` →
`if (performer !== null)` in `recordPerformerOutcome`.

```
$ node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
✖ a cast that appeared between enqueue and drain is not clobbered
  AssertionError [ERR_ASSERTION]: the confirmed cast must survive
  + actual - expected
    [
  +   'Jessica Jaymes'
  -   'Someone'
    ]
ℹ tests 13   ℹ pass 12   ℹ fail 1
```

The confirmed cast `['Someone']` was replaced by the one-name guess
`['Jessica Jaymes']` — precisely the clobber the guard exists to prevent, and only that
test failed. Guard restored; re-ran the file: `ℹ tests 13  ℹ pass 13  ℹ fail 0`.

## Files changed

- `packages/core/src/pipeline/performers.ts` — appended the pass, runner, write and
  deferral (+231 lines); imports extended.
- `packages/core/src/pipeline/metadata.ts` — `backoffFor` exported, doc comment added
  (no behaviour change).
- `packages/core/test/pipeline/performers-pass.test.ts` — new, 13 tests.

## Self-review findings

- Checked I did not rewrite task 5's half: the diff on `performers.ts` is import lines
  plus a pure append below `enqueuePerformerSearch`.
- Confirmed the transaction shape has exactly one `BEGIN` and no nested one, matching
  what `upsertPerformers` and `setGroupPerformers` document.
- Confirmed `deferOrGiveUp` runs outside the failed transaction — the poison-row test
  proves the bump commits after the `ROLLBACK` and that the row behind it was reached.
- Confirmed the 429 path bumps nothing: the test asserts `attempts === 0` and that the
  second row was never asked.
- No `any`, no `unknown` shortcut, no optional property assigned `undefined`.

## Concerns (minor, both brief-literal; flagging rather than deviating)

1. **`recordPerformerOutcome` hardcodes `'theporndb'`** as the `upsertPerformers`
   source, per the brief's literal code, where `db/metadata.ts:315` passes the client's
   own `source` instead. `client.source` is in hand at the call site, so this is a
   one-line change if a second performer directory is ever added; today there is one
   provider and the value is correct. I kept the brief's code rather than quietly
   changing a signature it specified.
2. **A module cycle now exists**: `performers.ts` imports `backoffFor` from
   `metadata.ts`, which imports `enqueuePerformerSearch` from `performers.ts`. This is
   what the brief and dispatch require (share the curve, don't copy it), and it is safe
   at runtime — both bindings are hoisted function declarations used only inside
   function bodies, never during module evaluation — and the whole suite confirms it.
   Worth knowing it is there; the clean alternative would be moving `backoffFor` and
   `MAX_BACKOFF_MS` to a small shared module, which is outside this task's scope.
3. **[FIXED — see the fix round below]** The runner test's
   `logged.filter(line => line.includes('cooldown')).length === 1`
   passes because the *pass summary* line says "cooldown until" while the skip line
   says "cooling down until" (`createMetadataRunner`'s wording, copied as instructed).
   The behavioural half of that test — `calls` proving only the first tick asked — is
   the assertion doing the real work. Noting it because the string count is more
   incidental than it reads.

---

# Fix round 1 — the cooldown assertion counted the wrong line

Commit: `28e5885` Count the skip line, so the cooldown test pins once-per-cooldown
(not pushed). Working tree clean. Review findings 1 and 2 (hardcoded `'theporndb'`,
the `performers.ts` ↔ `metadata.ts` cycle) were deferred to the whole-branch review and
I changed neither.

## What changed

`packages/core/test/pipeline/performers-pass.test.ts`, test
`createPerformerRunner makes no request inside a cooldown, and says so once` — test file
only, **no source change**: `git diff -- packages/core/src` is empty against `ed14b65`.

- The count now filters on `'cooling down'`, the substring the skip line actually
  carries, instead of `'cooldown'`, which only the pass's summary line carries. The old
  filter matched the summary and would have held at 1 however often the skip fired, so
  it could not distinguish once-per-cooldown from once-per-tick — the exact property the
  test's name claims.
- Added an assertion message, `'the skip is announced once per cooldown, not once per
  tick'`, so a future failure names the invariant rather than printing a bare `2 !== 1`.
- Rewrote the comment to state what the three ticks are for (pass + 429, the tick that
  announces, the tick that must stay silent) and to record why `'cooldown'` is the wrong
  substring to match, so the filter is not "simplified" back into a no-op.
- The `calls` assertion is untouched: it still pins "no provider request inside a
  cooldown" and is independent of the skip-line count.

Counts land where predicted: tick 1 runs the pass and logs the summary
(`", cooldown until ..."`), tick 2 skips and logs `"cooling down"` once, tick 3 skips
silently → corrected filter sees exactly 1.

## Covering test and output

Corrected run:

```
$ node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
✔ createPerformerRunner makes no request inside a cooldown, and says so once (4.265234ms)
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

Mutation — `loggedSkip` guard removed from `createPerformerRunner` so the skip logs on
every tick (`if (!loggedSkip) { … }` unwrapped to an unconditional `deps.log(...)`):

```
$ node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
✖ createPerformerRunner makes no request inside a cooldown, and says so once (9.355246ms)
  AssertionError [ERR_ASSERTION]: the skip is announced once per cooldown, not once per tick

  2 !== 1

    actual: 2, expected: 1
ℹ tests 13
ℹ pass 12
ℹ fail 1
```

Only that test failed, and it failed on the skip-line count with the message naming the
invariant — evidence the assertion now pins the `loggedSkip` flag rather than something
incidental. (For contrast, this same mutation left the *old* `'cooldown'` filter green,
which is why the fix was needed.)

Guard restored, re-ran the file: `ℹ tests 13  ℹ pass 13  ℹ fail 0`, and
`git diff -- packages/core/src` empty, confirming the restore is byte-identical.

Full check after restore:

```
$ npm run check          # oxlint && typecheck && tests
exit=0
ℹ tests 886   ℹ pass 886   ℹ fail 0     (core)
ℹ tests 165   ℹ pass 165   ℹ fail 0     (web)
```

886 core and 165 web, unchanged as expected for an assertion change. No oxlint warning
names `performers-pass.test.ts`.

---

# Fix round 2 — four Minor review findings

Commit: `8f43d37` Measure the performer cooldown from when the 429 landed, and pin the
runner's cooldown bookkeeping (not pushed). Working tree clean. The two deferred items
(hardcoded `'theporndb'`, the `performers.ts` ↔ `metadata.ts` cycle) are untouched.

## 1. Cooldown computed from a stale clock — fixed, and pinned by a test

`packages/core/src/pipeline/performers.ts`: `result.cooldownUntil = now + error.retryAfterMs`
→ `deps.now() + error.retryAfterMs`, with a comment pointing at `lookUpOne`, which reads
the clock again for the same stated reason. The deferral path still computes `nextAt` from
the pass's captured `now`, per the standing pre-flight ruling; the new comment names that
split explicitly so the two clocks do not read as an inconsistency.

**It is pinned by a test, not left to inspection.** New test
`the cooldown is measured from when the 429 landed, not from when the pass began`
substitutes a client that advances the clock by 4s before throwing `RateLimited(120_000)`,
so a fresh read gives 125_000 and a stale one 121_000 — measurably different.

Mutation A, reverting to `now + error.retryAfterMs`:

```
$ node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
✖ the cooldown is measured from when the 429 landed, not from when the pass began
  AssertionError [ERR_ASSERTION]: the full 120s from when the 429 landed
    actual: 121000, expected: 125000
ℹ tests 15  ℹ pass 14  ℹ fail 1
```

The existing frozen-clock 429 test stays green either way (its `now` never moves), which
is exactly why it could not catch this.

## 2. Comment claiming a signature match that does not exist — reworded

The deferral comment no longer appeals to "`metadata.ts`'s own `deferOrGiveUp` signature"
(theirs is `(deps, row, now, message, nextAt, cooldownUntil)`, mine is
`(deps, row, message, nextAt)`, and theirs does take a `now`). It now states the invariant
itself — compute `nextAt` from the clock the pass captured, do not re-read inside the
helper — and contrasts it with the 429 path, with no checkable cross-reference to be
wrong about.

## 3a. `no client means no pass and no reads` — pinned, and renamed to what it pins

I chose to **pin it** rather than narrow the name away, because the property is worth
holding: the whole point of that early return is that a missing client costs nothing at
all. The queue table is parked under another name across the call
(`ALTER TABLE performer_queue RENAME TO performer_queue_parked`, renamed back after), so a
pass that reached `duePerformerQueue` throws `no such table` instead of answering zeros.
Renamed to `no client means no pass and no queue read` — "no reads" would still overclaim,
since this establishes nothing about other tables, and I would rather the name be exactly
true.

Mutation B, moving the `client === undefined` check below the queue read:

```
✖ no client means no pass and no queue read
  Error: no such table: performer_queue
ℹ tests 15  ℹ pass 14  ℹ fail 1
```

## 3b. Poison-row test now asserts group 2 *settled*, not merely that it was asked

Added `assert.deepEqual(duePerformerQueue(db, 9_999_999_999, 10).map(row => row.groupId), [1], …)`.

Mutation C, settling only a linked row (`if (linked) removePerformerSearch(...)`), isolates
it — within the poison-row test the `deferred`, `attempts` and `calls` assertions all still
passed and only the new one caught it:

```
  AssertionError [ERR_ASSERTION]: group 1 is still queued for its retry; group 2 is gone, settled
  + actual - expected
    [
      1,
  +   2
    ]
ℹ tests 15  ℹ pass 11  ℹ fail 4
```

(Three other tests fail under that mutation too, as expected — it breaks settling
generally. The point is that the poison-row test now fails on this specific claim, where
before the mutation was invisible to it.)

## 4. Cooldown-expiry path — new test with an advancing clock

New test `the runner asks again once a cooldown lapses, and announces the next one afresh`:
tick at 1000 takes a 429; tick at 60_000 is inside the cooldown (no request, one skip
line); tick at 200_000 is past it and asks again, taking a second 429; tick at 250_000
holds and announces the *second* cooldown, so the `'cooling down'` count reaches 2. Both
halves bite:

Mutation D, dropping `loggedSkip = false`:

```
✖ the runner asks again once a cooldown lapses, and announces the next one afresh
  AssertionError: the second cooldown is announced too, not swallowed by the first
    actual: 1, expected: 2
ℹ tests 15  ℹ pass 14  ℹ fail 1
```

Mutation E, making a cooldown never lapse (`if (now < cooldownUntil)` → `if (cooldownUntil > 0)`):

```
✖ the runner asks again once a cooldown lapses, and announces the next one afresh
  AssertionError: the cooldown lapsed, so the row was asked again
ℹ tests 15  ℹ pass 14  ℹ fail 1
```

**One honest gap, stated plainly: the `?? 0` in `cooldownUntil = result.cooldownUntil ?? 0`
is not pinned, and I do not believe it can be through this interface.** A pass only runs
when `now >= cooldownUntil`, so any cooldown still held at that moment is already in the
past; with a monotonic clock, keeping a lapsed value instead of zeroing it is
unobservable — `now < cooldownUntil` is false either way, forever after. `?? 0` is
defensive hygiene rather than a behaviour, and I did not manufacture a non-monotonic clock
to fake coverage of it. The two invariants that *are* observable — resumption after lapse,
and re-arming the announcement — are pinned above.

## Verification

All five mutations restored; `git diff` against `28e5885` shows the source change is
exactly the two intended edits (fresh clock + reworded comment) and nothing else.

```
$ node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
ℹ tests 15   ℹ pass 15   ℹ fail 0

$ npm run check          # oxlint && typecheck && tests
exit=0
ℹ tests 888   ℹ pass 888   ℹ fail 0     (core)
ℹ tests 165   ℹ pass 165   ℹ fail 0     (web)
```

888 core = 886 + the 2 new tests. No oxlint warning names either file.

## Files changed in this round

- `packages/core/src/pipeline/performers.ts` — fresh clock for the cooldown; deferral
  comment reworded.
- `packages/core/test/pipeline/performers-pass.test.ts` — 2 tests added (13 → 15); the
  no-client test pinned and renamed; the poison-row test gained the settled assertion.
