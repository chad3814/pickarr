# Final fix wave — 2026-08-16

Applying the single fix wave from the final whole-branch review. All four findings were
Minor; the branch was already judged safe to merge before this wave.

## Fix 1 — wrong call-site count in a comment

`packages/core/src/db/downloads.ts:355` (in `failDownload`'s docstring) said "the seven
`failDownload` call sites in reconcile.ts." Counted the actual call sites in
`packages/core/src/pipeline/reconcile.ts`:

```
316:      failDownload(db, row.id, message, now);
388:      failDownload(db, download.id, 'addurl-failed: release has no link', now);
402:        failDownload(db, download.id, `addurl-failed after ${attempts} attempts: ${message}`, now);
529:      failDownload(db, download.id, entry.failMessage ?? 'download failed at client', now);
537:        failDownload(db, download.id, 'client reported success with no storage path', now);
```

Five, not seven. Changed "seven" to "five" in the comment. No behavior change.

## Fix 2 — completeness must account for dropped slots

`packages/core/src/clients/sabnzbd.ts`, `snapshot()`. `queue`/`history` entries are built by
filtering the client's raw slots, dropping any slot whose `nzo_id` reads as empty (queue
around what is now line 472-483, history around line 503-508) — correct, since the ref is
the only thing reconcile can key a slot to a `downloads` row on. But the old completeness
check compared *raw* slot counts (`queueSlots.length` / `historySlots.length`) against the
client's reported `noofslots` — a slot that got dropped was still counted toward that raw
total, so a snapshot missing one of our jobs could still report `complete === true`. Per
property (b) (an incomplete snapshot must never imply absence), that let a real job get
swept as absent.

Changed:
- Track `droppedQueueSlots = queueSlots.length - queue.length` and
  `droppedHistorySlots = historySlots.length - history.length` — raw slot count minus
  accepted-entry count, for each endpoint independently.
- `queueComplete` and the new `historyIsComplete` both now require the dropped count to be
  zero, in addition to the existing raw-count-vs-`noofslots` check.
- Added `warnDroppedSlotOnce` (mirroring the existing `warnUnrecognizedStatusOnce` pattern:
  global-once flag, `resetDroppedSlotWarningForTests` test-only reset) so a client silently
  dropping a slot is logged once rather than passing unnoticed — the same silent-failure
  shape as the original 35-download incident.
- Comments at both call sites explain why comparing only against `noofslots` (the "naive
  reading") is insufficient, and for history specifically why raw vs. accepted must stay
  two separate counts: each history page's `start` is derived from the raw count
  (`historySlots.length`), not the accepted one, so folding "accepted" into that arithmetic
  would break paging itself.

Did **not** change the two `continue` sites that drop unreadable-`nzo_id` slots from
`queue`/`history` — those are correct as-is; the only change is that a drop now also flips
`complete` to `false` and logs once.

### Tests added (`packages/core/test/clients/sabnzbd.test.ts`)

- `a queue slot with an unreadable nzo_id makes the snapshot incomplete, without losing the
  slots that were readable` — a 2-slot queue response where one slot has `nzo_id: ''`.
  Asserts `snapshot.queue.length === 1` (the readable slot still comes through) and
  `snapshot.complete === false`.
- `a history slot with an unreadable nzo_id makes the snapshot incomplete, without losing
  the slots that were readable` — same shape, on the history side.

Both import and call the new `resetDroppedSlotWarningForTests` test hook.

### Mutation evidence

Temporarily reverted just the two completeness formulas to the pre-fix behavior (kept
everything else — the drop-counting variables, the warn function, the exports — intact so
the test file's imports still resolved):

```ts
// mutated queueComplete
const queueComplete =
  typeof queueNoofslots === 'number' &&
  queueSlots.length >= queueNoofslots; // dropped-slots check removed

// mutated historyIsComplete
const historyIsComplete = historyComplete; // dropped-slots check removed
```

Ran only the two new tests against the mutated source:

```
node --experimental-strip-types --test-name-pattern="unreadable nzo_id" packages/core/test/clients/sabnzbd.test.ts
```

Result: both failed, each on the `complete` assertion (`actual: true, expected: false`) —
exactly the bug the fix closes: a dropped slot went undetected and the snapshot still
reported itself complete.

Restored the two formulas to their fixed form (`grep MUTATION` over the diff came back
empty, confirming a clean restore), then re-ran the same targeted test command: both passed.

## Fix 3 — document the deliberate `updated_at` omission

`packages/core/src/db/downloads.ts`, `markAbsent` (~line 421) and `clearAbsent`
(~line 445) do not bump `updated_at`, and that is correct: `updated_at` means "when this
download's own state last changed," and absence/its clearing are observations about the
*client*, not a state change in the download row itself. Added one short paragraph to each
function's existing docstring stating this explicitly, so a future reader does not "fix" it
by adding the bump. No behavior change — pure comment addition.

## Fix 4 — supersession note in the dated design doc

`docs/superpowers/specs/2026-08-04-pickarr-design.md`, in the "Reconcile" section (the
category-filtered snapshot bullets, `missing_polls`, and the three-consecutive-misses rule,
around what is now lines 322-337). Left every word of the existing description untouched
(it is a historical record) and inserted a two-line blockquote immediately after the bullet
list and before the "**Import**" section:

> **Superseded.** The category-filtered snapshot, `missing_polls`, and the
> three-consecutive-misses rule above are historical; see
> `docs/superpowers/specs/2026-08-16-reconcile-client-first-design.md` for current
> reconcile behaviour.

Nothing else in the file was touched.

## Test evidence (full suites, after Fix 2 was restored to its fixed form)

```
npm run typecheck   # all workspaces clean
npm run lint         # exit 0; only pre-existing warnings (no-await-in-loop, no-shadow,
                      # unicorn rules) on lines this wave did not touch
npm run test:server  # tests 864, pass 861, fail 3 (the 3 known pre-existing
                      # AbortSignal.timeout mock-timer failures in
                      # clients/theporndb.test.ts x2 and media/artwork.test.ts x1 —
                      # unchanged from baseline, not touched by this wave)
npm run test:web     # tests 168, pass 168, fail 0
```

Baseline was 862 server tests (859 pass, 3 known failures); this wave added exactly the 2
new sabnzbd tests (864 total, 861 pass), with no new (4th) failure.

## Deliberately left alone (per the brief's DO NOT list)

`clearAbsent` having no bad-id throw; `result.absent` counting every swept row;
`warnIfLabelMismatch`'s widened scope; the scheduler log dedup; the ref-vs-label
Map-order dependence; the web test using `queryByRole`; and `npm run check`'s script
chaining (`test:server && test:web`, which is why the 3 known server failures alone would
otherwise stop the web suite from running — ran them as separate commands here instead of
via `npm run check`, per the brief).

## Files touched

- `packages/core/src/db/downloads.ts` (Fix 1, Fix 3)
- `packages/core/src/clients/sabnzbd.ts` (Fix 2)
- `packages/core/test/clients/sabnzbd.test.ts` (Fix 2 — new tests)
- `docs/superpowers/specs/2026-08-04-pickarr-design.md` (Fix 4)
