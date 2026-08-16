# Task 1 report: The snapshot knows whether it is complete

## What changed and why

`packages/core/src/clients/types.ts`:

- `ClientSnapshot` gained a required `complete: boolean`, documented exactly as
  the design specifies: false means the snapshot may still be used to advance
  rows it contains, but never to conclude something is absent.
- `ClientQueueEntry` and `ClientHistoryEntry` each gained a required
  `category: string | null`, documented with the "None"/empty-string mapping
  rule so a future reader does not have to rediscover it from the SABnzbd
  client.
- `DownloadClient.snapshot()`'s doc comment ("one poll of everything in this
  client's configured category") was now actively wrong given the change
  below, so I corrected it to describe the unfiltered contract and point at
  `ClientSnapshot.complete` for why.

Both new fields are required, not optional-with-default, per the controller's
decision: a forgotten `complete` defaulting to "complete" is the unsafe
direction.

`packages/core/src/clients/sabnzbd.ts`:

- Added `HISTORY_PAGE_SIZE = 500` and `MAX_HISTORY_PAGES = 20`, each with a
  comment on why that number.
- Added `readCategory()`, a thin wrapper over the existing `safeText` that
  maps SABnzbd's two different "no category" spellings (`"None"` on a queue
  slot, `""` on a history slot) to `null`.
- Rewrote `snapshot()`:
  - Queue is requested with `limit: '0'` and no `category`. The comment
    explains both: the missing-category drop is required for completeness
    (SABnzbd's `noofslots` on the queue is the whole-queue count regardless of
    what was requested — filtering would make every snapshot look
    permanently incomplete), and `limit=0` is explicit because the two
    endpoints read a missing `limit` differently, which is what caused the
    incident.
  - History is paged sequentially (`start` computed from what has already
    been collected, `limit=HISTORY_PAGE_SIZE`), continuing until the running
    total reaches the response's own `noofslots`, a page returns no slots, or
    `MAX_HISTORY_PAGES` is exhausted. A single boolean flag, set `true` only
    on the "reached noofslots" exit, naturally covers all three completeness
    conditions from the brief (short count, empty page, page cap) without
    separate bookkeeping for each.
  - `noofslots` is read defensively on both endpoints: `typeof x === 'number'`
    gates every use, so a missing or non-numeric value degrades to "cannot
    verify" (`complete = false`) rather than throwing.
  - Queue and history slots are now read from the accumulated arrays
    (`queueSlots`, `historySlots`) rather than reprocessing each raw body,
    and each entry now carries `category: readCategory(slot['cat'])` (queue)
    or `readCategory(slot['category'])` (history).
  - The final `complete` is `queueComplete && historyComplete`.
  - Every existing behaviour was left alone: `safeText` on all returned
    strings, `historyOutcome` mapping, skipping empty `nzo_id`, and a failed
    request still throwing (queue and history requests are still
    independent — `queuePromise` is started before the history loop and
    awaited afterward, so a queue failure still surfaces, it is just no
    longer literally inside `Promise.all`).

I did not touch `packages/core/src/pipeline/reconcile.ts` — the new field is
additive, and reconcile keeps compiling and ignoring `complete` as instructed.

## Test changes

`packages/core/test/clients/sabnzbd.test.ts` — extended, not just patched:

- Added `noofslots` to every existing history fixture that previously had
  none, so those tests keep exercising exactly one HTTP call instead of
  incidentally paging to the cap now that "no `noofslots`" means "keep
  paging until something stops it."
- Rewrote the old category-filter test as
  `snapshot reads queue and history, unfiltered, and reports complete`
  (drops the `category=` assertion, adds `noofslots`, asserts mapped
  `category` on both entry kinds, asserts `complete === true`).
- Added new tests matching every bullet in the brief's Tests section:
  - `neither request filters by category, and the history request states its
    limit explicitly` — asserts no URL contains `category=`, queue URL has
    `limit=0`, history URL has `limit=500`.
  - `queue "cat" and history "category" both land on the entry, and
    "None"/"" become null`.
  - `history spanning three pages is fully collected, with increasing start
    on each request` — a fake endpoint that actually respects `start`/`limit`
    over 1,100 entries; asserts the three `start` values recorded are
    `[0, 500, 1000]`.
  - `complete is false when the collected count falls short of noofslots`.
  - `complete is false when MAX_HISTORY_PAGES is exhausted before noofslots
    is reached` — asserts exactly 20 history requests were made.
  - `complete is false when noofslots is absent or not a number, on either
    endpoint`.
  - `complete is true on an ordinary single-page response`.
  - `incident regression: a client that caps history at 10 unless a larger
    limit is passed still yields all 35 entries, complete` — named
    obviously, per the brief.
- Updated `snapshot tolerates missing slots` (renamed to also state the new
  expectation) to assert `complete: false`, since an empty `{}` response
  reports no `noofslots` on either endpoint and is therefore unverifiable,
  not automatically "complete."

The five other named test files needed only the minimal compile-fix the
controller specified (add `complete: true` / `category: null` to constructed
`ClientSnapshot`/entry literals), with one exception I found while running
`npm run check`: **`packages/e2e/src/harness.ts` and
`packages/e2e/tests/retry.spec.ts`** also construct `ClientSnapshot` /
`ClientHistoryEntry` literals and failed typecheck the same way. These
weren't in the brief's or controller's file list, but `npm run check` is a
global constraint, so I fixed them with the same minimal pattern (add
`complete: true`, `category: null`).

## Test evidence

`npm run check` from the worktree root:

- lint: no errors (only pre-existing warnings, unrelated to this change).
- typecheck: clean across all workspaces (`core`, `e2e`, `plugin-api`,
  `plugin-scenes`, `web`).
- `npm run test:server`: **838 tests, 835 pass, 3 fail** — the same three
  pre-existing `AbortSignal.timeout` mock-timer failures in
  `clients/theporndb.test.ts` (×2) and `media/artwork.test.ts` (×1) named in
  the baseline. No fourth failure. (Baseline was 830/827/3; the +8 net new
  tests come from the sabnzbd completeness/category tests added minus none
  removed.)
- `npm run test:web`: **165/165 pass**, matching baseline exactly. (Run
  separately because `npm run test` is `test:server && test:web`, and the
  three known-bad server tests make the chain report a nonzero exit before
  `test:web` runs — this is pre-existing, not something this change
  introduced.)

## Mutation-testing evidence

Three separate mutations, each applied to the restored (correct) source,
confirmed to fail tests, then reverted:

1. `return { queue, history, complete: queueComplete && historyComplete };`
   → `complete: true` (always). Caught by 4 tests: `complete is false when
   the collected count falls short of noofslots`, `... MAX_HISTORY_PAGES is
   exhausted ...`, `... noofslots is absent or not a number ...`, and
   `snapshot tolerates missing slots, but reports itself incomplete ...`.
2. `readCategory()` body changed to `return raw;` (dropping the "None"/""
   → `null` mapping). Caught by
   `queue "cat" and history "category" both land on the entry, and
   "None"/"" become null` (`'None' !== null`).
3. Queue call changed back to
   `call('queue', { limit: '0', category: config.category })` (reintroducing
   the category filter). Caught by
   `neither request filters by category, and the history request states its
   limit explicitly` (URL contained `category=pickarr`).

All three mutations were reverted immediately after confirming the failure;
`npm run typecheck` and the full `sabnzbd.test.ts` suite were green again
afterward.

## Deliberately not done

- Did not touch `pipeline/reconcile.ts` — out of scope for this task by
  design (additive change, later task consumes `complete`).
- Did not fix the pre-existing `AbortSignal.timeout` mock-timer test
  failures; confirmed they are identical to the baseline and unrelated to
  this change.
- Did not restructure `packages/core/test/pipeline/reconcile.test.ts` beyond
  the mechanical `complete: true` / `category: null` additions needed to
  compile, per the controller's instruction that a later task reworks it.
- Noticed but did not touch: `packages/core/src/http/views.ts:331` has an
  unrelated oxlint `no-map-spread` warning, and several `no-await-in-loop`
  warnings exist throughout the codebase (including one at
  `sabnzbd.test.ts:671` in a pre-existing test loop I extended with one
  `noofslots` field, not introduced by me). None of these are regressions
  from this change.

## Concerns

- The "cannot verify, so keep paging" behavior (continuing to request more
  history pages when a page has data but no readable `noofslots`) means a
  SABnzbd installation that never reports `noofslots` at all would page all
  the way to `MAX_HISTORY_PAGES` (20 requests) every single tick, forever,
  rather than settling into a cheap steady state. This matches the letter of
  the brief ("stop at MAX_HISTORY_PAGES... or noofslots is absent... sets
  complete = false") but is worth the controller's attention if a real
  SABnzbd version is known to omit `noofslots` under some configuration —
  I have no evidence that happens in practice; it's a defensive path, not
  something the incident exercised.

---

# Fix round 1

Two findings from review. Both addressed in `packages/core/src/clients/sabnzbd.ts`
and `packages/core/test/clients/sabnzbd.test.ts`.

## Finding 1 (Important): unhandled promise rejection race

The reviewer was right: `queuePromise = call('queue', { limit: '0' })` was
created and then left un-awaited across the entire sequential history-paging
loop, each iteration of which awaits a real network call. `Promise.all`
(the old code) attaches handlers to both promises synchronously at creation;
my restructuring didn't preserve that, so a queue-side rejection could sit
with no handler attached across several real event-loop turns — exactly
Node's definition of "unhandled," which by default terminates the process
instead of letting `snapshot()` reject cleanly.

Fix: attach a handler to `queuePromise` at the same point it is created,
mirroring the existing idiom already in this codebase
(`packages/core/src/abort.ts`'s `rejection.catch(() => undefined)`):

```ts
const queuePromise = call('queue', { limit: '0' });
let queueFailed = false;
queuePromise.catch(() => {
  queueFailed = true;
});
```

This does two things at once, addressing both the correctness issue and the
related waste the reviewer flagged:

- The `.catch` attached here is a real handler from the moment the promise
  exists, so Node never has a window in which it looks unhandled — the
  eventual `await queuePromise` further down still rejects for real callers
  with the original error (attaching a `.catch` elsewhere does not consume
  or alter what a later `await` on the same promise observes; this is the
  same reasoning `abort.ts` documents).
- The history loop's condition became `page < MAX_HISTORY_PAGES && !queueFailed`,
  so a queue failure detected mid-loop stops further page requests instead
  of running to the cap against a client that already told us it was
  unreachable.

Added a regression test: `a queue rejection while history paging is still in
progress surfaces as a clean snapshot() rejection, never an unhandled one`.
It registers a `process.on('unhandledRejection', ...)` listener for the
duration of the test (removed in a `finally`), uses a deferred promise to
pin the queue rejection to strictly after the first history page has been
requested (no reliance on wall-clock timers for ordering), and — critically —
inserts a genuine macrotask boundary (`await new Promise(resolve => setImmediate(resolve))`)
inside the fake history fetch on every page.

That last point mattered in practice, not just in theory: my first attempt
at this test used only promise-chain (microtask) delays with no macrotask
boundary, and it passed even with the bug still present, because with no
real event-loop turn, the entire `snapshot()` call (history loop + the final
`await queuePromise`) completed within one Node tick, before Node's
unhandled-rejection detector got a chance to run at all — so the test could
not tell fixed code from broken code. I verified this by reverting the fix
and re-running: the original (microtask-only) test still passed; only after
adding the `setImmediate` boundary did reverting the fix make the test fail
with `PromiseRejectionHandledWarning` / a caught unhandled rejection. Details
in the mutation-testing section below.

## Finding 2 (controller ruling): don't page to the cap when completeness is unverifiable

Ruling: when `noofslots` is absent or non-numeric, stop after the first page
and set `complete = false`, rather than continuing to `MAX_HISTORY_PAGES` as
the brief's literal text says. Implemented as:

```ts
const noofslots = historyRecord?.['noofslots'];
if (typeof noofslots !== 'number') break;
if (historySlots.length >= noofslots) {
  historyComplete = true;
  break;
}
if (pageSlots.length === 0) break;
```

(Previously the "unreadable" and "reached total" checks were combined into
one `if`, which is exactly what let an unreadable `noofslots` on a
*non-empty* page fall through to keep looping — the empty-page exit didn't
fire because the page had data, and the reached-total exit didn't fire
because the total couldn't be read.) A comment at the call site records that
this supersedes the brief's paging text for this one case and why, so it
isn't quietly "fixed" back later.

Updated the existing test (renamed to
`complete is false when noofslots is absent or not a number, on either
endpoint, and history does not page to the cap chasing it`) to use
*non-empty* history slots — the original fixture used `slots: []`, which
already stopped after one page for an unrelated reason (the empty-page exit)
and could never have caught this bug — and to assert both `complete ===
false` and that exactly one history request was made, for both the
missing-`noofslots` and non-numeric-`noofslots` cases.

## Test evidence

Full suite, after both fixes and with all mutations reverted:

```
$ npm run lint    # exit 0, warnings only, none new
$ npm run typecheck    # exit 0, clean across core/e2e/plugin-api/plugin-scenes/web
$ npm run test:server
...
ℹ tests 839
ℹ suites 0
ℹ pass 836
ℹ fail 3
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The 3 failures are the same pre-existing `AbortSignal.timeout` mock-timer
failures named in the baseline (`theporndb.test.ts` x2, `artwork.test.ts`
x1) — confirmed by name in the output, not just count. 839 = previous 838
plus the one new regression test; no fourth failure.

```
$ npm run test:web
...
ℹ tests 165
ℹ pass 165
ℹ fail 0
```

165/165, matching baseline exactly.

Targeted run covering just the amended file:

```
$ node --import tsx --conditions development --test packages/core/test/clients/sabnzbd.test.ts
...
ℹ tests 36
ℹ pass 36
ℹ fail 0
```

## Mutation-testing evidence (fix round 1)

Three mutations applied to the fixed source, confirmed to fail, then reverted
(diffed back to the known-good backup to confirm exact restoration):

1. **Finding 1's fix removed**: replaced
   `let queueFailed = false; queuePromise.catch(() => { queueFailed = true; });`
   with `const queueFailed = false;` (no handler attached, flag never set).
   - With the *first* version of the regression test (microtask-only, no
     `setImmediate`), this mutation was **not caught** — the test passed
     regardless. This is what led me to add the macrotask boundary.
   - With the corrected test (macrotask boundary added), this mutation
     failed the test with:
     ```
     ✖ a queue rejection while history paging is still in progress surfaces as a clean snapshot() rejection, never an unhandled one
       Error: SABnzbd queue request failed
       ...
     (node:...) PromiseRejectionHandledWarning: Promise rejection was handled asynchronously (rejection id: 10)
     ```
     confirming the test genuinely observes the unhandled-rejection race.
2. **Finding 2's fix removed**: merged the split check back into
   `if (typeof noofslots === 'number' && historySlots.length >= noofslots)`
   (the pre-fix-round-1 shape). Caught by
   `complete is false when noofslots is absent or not a number, on either
   endpoint, and history does not page to the cap chasing it`:
   `Expected values to be strictly equal: 20 !== 1` (request count).

Both mutations were reverted by restoring from a saved copy of the fixed
file and confirming byte-for-byte identity (`diff` reported no differences)
before re-running the full suite, which passed clean (36/36 in the targeted
file; 836/165 in the full server/web suites as above).

## Still open / concerns

- None new. The concern already on record from the initial report (a
  SABnzbd install that never reports `noofslots` at all would still cost one
  history request every tick, forever, rather than a fully steady-state
  zero-cost path) is unchanged by this ruling — it's now bounded to one
  request instead of twenty, which is the controller's explicit ruling, not
  a gap.
