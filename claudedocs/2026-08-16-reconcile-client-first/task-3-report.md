# Task 3 report — the tick iterates the client first

## What changed

### `packages/core/src/pipeline/reconcile.ts` (rewritten body, comments preserved/extended)

The tick is now, in order:

1. `client.snapshot()`.
2. **Submission.** Over `activeDownloads`, rows with a null `client_ref` only. The
   `refByLabel` double-submit guard is unchanged and still consults the
   already-fetched snapshot before calling `addUrl`. Rows that went through an
   actual `addUrl` call are recorded in a `submitted` set (their refs postdate the
   snapshot, so the snapshot's silence about them means nothing). A ref *adopted*
   from the snapshot is deliberately not in that set, so step 3 reconciles it in
   the same tick, exactly as before.
3. **Matching, over the client.** `collapse()` reduces queue+history to one
   `SnapshotEntry` per ref with the **queue winning**. `indexDownloadsForClient`
   and `knownRefs` are both read *after* step 2, so an adopted or minted ref is
   already in them and no manual `knownRefs.add` bookkeeping is needed. Per entry:
   - `resolve()` — `byRef` first, `byLabel` fallback; on disagreement the ref wins
     and a new once-per-process `console.warn` fires.
   - **no match decided before any status branch**: ref in `knownRefs` → it is an
     `imported` row, skip (cleanup owns it, not untracked); otherwise untracked,
     filtered to `entry.category === client.category`.
   - a second entry resolving to an already-processed row is skipped (see
     "Beyond the brief" below).
   - `failed` with an error other than exactly `disappeared-from-client` → skip.
   - re-attachment via `setClientRef` when the ref disagrees or the row is
     (recoverably) failed: it corrects the ref, clears the stranding error and
     restores a live status in one write.
   - outcome `failed` → `failDownload(client's message)` + `clearAbsent`;
     `completed` → null-path guard unchanged, else map/set path, `setStatus`
     (guarded so `advanced` counts real transitions), `clearAbsent`,
     `attemptImport`; otherwise → `clearAbsent` and `downloading` if not already.
4. **Sweep, over `activeDownloads` re-read fresh.** Rows not seen in step 3:
   - `completed` with a `storage_path` → `attemptImport` (today's early branch,
     preserved with its comment; still exempt from absence accounting).
   - null ref, or submitted this tick → skip.
   - `snapshot.complete === false` → **nothing at all**, logged once per tick.
   - otherwise → `markAbsent` and `result.absent += 1`. **No `failDownload` is
     reachable from any absence path** (verified by inspection: the only five
     `failDownload` call sites are import failure, `addurl` no-link, `addurl`
     attempt cap, client-reported failure, and completed-with-no-path).
5. **Cleanup**, last, behaviourally unchanged.

`MAX_MISSING_POLLS` deleted. `ReconcileResult` gained `absent: number`;
`untracked`/`advanced`/`failed`/`imported`/`removed` keep their meanings.
`resetLabelMismatchWarningForTests` was renamed `resetReconcileWarningsForTests`
since it now resets both once-per-process flags.

### Other source changes

- `db/downloads.ts`: `bumpMissingPolls` and `resetMissingPolls` deleted.
  `missing_polls` is no longer selected, no longer on `DownloadRow`, and no longer
  written by `resetForRetry` — the column stays in the schema (no migration), and
  migration 8's comment was corrected to say so truthfully rather than promising a
  future commit that has now happened. `clearAbsent`'s doc no longer refers to a
  function that does not exist, keeping the reasoning.
- `clients/types.ts` + `clients/sabnzbd.ts`: `DownloadClient` gained
  `readonly category: string`. Reconcile needs `config.category` to filter
  untracked entries, and reading it off the client (which is what `addUrl` submits
  under) makes it impossible for the filter and the submission to disagree —
  passing it separately through `ReconcileDeps` would have introduced exactly that
  possibility.
- `clients/sabnzbd.ts`: two comments that explained reasoning in terms of
  `missing_polls` were reworded to the absence observation; they still say the same
  thing. One stale reference to the renamed test helper fixed.
- Test-only: `category` added to the four other `DownloadClient` fakes
  (`http/manual`, `http/metadata`, `http/server`, `pipeline/pick`), `absent: 0`
  added to `scheduler.test.ts`'s `ReconcileResult` literals, `category` threaded
  into `packages/e2e/src/harness.ts`'s fake client from the harness's own config.

## Tests deleted, and why they were pinning the bug

`packages/core/test/pipeline/reconcile.test.ts`:

1. **`a download missing from both lists fails only after three consecutive polls`**
   — asserted `status === 'failed'` and `error === 'disappeared-from-client'` after
   `MAX_MISSING_POLLS` ticks. That is the incident's behaviour, asserted as a
   requirement. Deleted, not adapted; replaced by the absence-mark tests and by
   `no number of absent ticks ever fails a download`.
2. **`reappearing resets the missing counter`** — drove absent/present/absent/absent
   and asserted the row was still `downloading`, which only held because the counter
   had been reset. Under the new rule the row is *always* still `downloading`, so
   the test could no longer fail for the reason it existed. Replaced by
   `a previously absent row seen again has its absence mark cleared`, which asserts
   the observable fact (`absent_since` goes from set to null).

Reworked rather than deleted (still describing true behaviour): the queue and
in-progress tests now assert `absent_since` retraction instead of
`missing_polls === 0`; the pruned-history import test loops a fixed 4 ticks instead
of `MAX_MISSING_POLLS + 1`.

`packages/core/test/db/downloads.test.ts`: deleted
`bumpMissingPolls throws on a bad id…`, `resetMissingPolls throws on a bad id`, and
`resetMissingPolls on a real row whose missing_polls is already 0…` (their subjects
no longer exist); narrowed
`bumpAttempts and bumpMissingPolls increment…` to `bumpAttempts increments…`.

## Tests added

`a job listed in both the queue and history is read as still queued, not imported`;
`a row absent from a complete snapshot records when the absence began, once`;
`a row absent from an INCOMPLETE snapshot is left completely alone`;
`an absence mark already standing survives an incomplete snapshot rather than being cleared`;
`a previously absent row seen again has its absence mark cleared`;
`no number of absent ticks ever fails a download` (25 ticks);
`the incident: a row failed as disappeared-from-client is re-attached to its finished job and imported`;
`a row that failed for any other reason is left failed, however finished its job looks`;
`a client ref that no longer matches is corrected from the label rather than being fatal`;
`two entries carrying one label import that download once, not twice`;
`a ref and a label naming different downloads takes the ref, and says so once`;
`untracked reporting is filtered to our own category`;
`a job of ours re-categorised at the client is still matched and reconciled`.
The existing untracked test now doubles as the "completed entry with no matching row
is untracked, not an import attempt" case and says so in a comment.

## Test evidence

```
npm run lint        → exit 0 (warnings only, all pre-existing categories)
npm run typecheck   → exit 0, clean
npm run test:server → ℹ tests 855  ℹ pass 852  ℹ fail 3
npm run test:web    → ℹ tests 165  ℹ pass 165  ℹ fail 0
```

The 3 failures are the known pre-existing `AbortSignal.timeout` mock-timer ones
(`clients/theporndb.test.ts` ×2, `media/artwork.test.ts` ×1). Baseline was 847
server tests; 855 now (13 added, 5 removed here and elsewhere reworked).
`packages/core/test/pipeline/reconcile.test.ts` alone: 46 tests, 46 pass.

`npm run check` stops at `test:server`'s non-zero exit (as it did before this
change, for the same three tests), so `test:web` was run separately.

## Mutation evidence

Each mutation was applied to `src/pipeline/reconcile.ts`, the reconcile file was
run alone, and the source restored from a pristine copy afterwards. All seven were
killed:

| Mutation | Test that failed |
| --- | --- |
| `if (!snapshot.complete)` neutered (property **b**) | `a row absent from an INCOMPLETE snapshot is left completely alone` |
| absence path also calls `failDownload('disappeared-from-client')` (property **a**) | `no number of absent ticks ever fails a download` + `a row absent from a complete snapshot records when the absence began, once` |
| `collapse` order reversed, so history wins | `a job listed in both the queue and history is read as still queued, not imported` |
| eligibility check neutered, so any `failed` row re-attaches | `a row that failed for any other reason is left failed…` |
| `knownRefs.has(entry.ref)` case neutered | `an already-imported download still in history is not reported as untracked` |
| duplicate-row guard (`seen.has`) neutered in step 3 | `two entries carrying one label import that download once, not twice` |
| untracked category filter neutered | `untracked reporting is filtered to our own category` |

Note on the incomplete-snapshot mutation: only the *unmarked* row test fails, not
`an absence mark already standing survives an incomplete snapshot`, because
`markAbsent` leaves an existing mark alone either way. That is expected; the first
test is the one that pins the guard.

## Beyond the brief (deliberate additions)

- **Duplicate-entry guard.** Two snapshot entries can resolve to one row (the
  client holding two jobs carrying one `[pickarr-N]` label — possible for jobs
  submitted before the double-submit guard existed). Without a guard the second
  entry would import the same download twice in one tick; the second attempt runs
  against files the first already moved, so it would `failDownload` a row that had
  just succeeded. The first entry wins and later ones wait for a later tick. The
  old database-driven loop was structurally immune to this, so the guard is new
  work the inversion created rather than a pre-existing hole.
- **Storage-path write condition.** In the completed branch the path is written
  whenever it disagrees with the client rather than only on the status transition,
  so a row that reached `completed` without a path (crash between the two writes)
  still gets one instead of failing its import forever.
- **`missing_polls` fully retired** from the row mapping and `resetForRetry`, as
  described above. The column and its data are untouched.

## Deliberately not done

- No migration; `missing_polls` stays in the schema.
- No changes to `/api/downloads`, `toDownloadView`, or the retry route — tasks 4
  and 5 own §11 of the design.
- No scheduler tick log for `absent`: `reconcilePass` currently logs nothing about
  a reconcile result at all, so adding a log line there was outside this task. The
  field is on `ReconcileResult` and ready for it.
- `packages/e2e` was not run to completion: Playwright's browser binary is not
  installed in this environment (`Executable doesn't exist at …chrome-headless-shell`),
  so all 14 specs fail before loading the app, on this branch and independently of
  this change. The e2e package typechecks, and its harness change is a field
  addition threaded from config.

## Concerns

1. **Category comparison is exact and case-sensitive** (`entry.category !==
   client.category`), per §9 of the design. If a client normalises category names
   (SABnzbd's own UI encourages lowercase), a configured `Pickarr` against a
   reported `pickarr` would drop *our* entries from the untracked list. This
   affects only the informational untracked panel — matching our own rows is
   category-blind — but it is a real way for that panel to under-report. A
   case-insensitive compare would fix it and would deviate from the spec, so I left
   it exact and am flagging it.
2. **A genuinely deleted job now sits as `downloading` forever**, blocking its
   release via `inFlightForRelease`. Accepted by §7, and the mitigation (surfacing
   `absent_since`, widening retry) lands in tasks 4 and 5 — until then there is no
   escape hatch for such a row, since retry still refuses anything that is not
   `failed`.
3. **A crashed import leaves a row `importing`**, and such a row is now
   absence-marked rather than eventually failed. It never imports on its own (the
   sweep's import branch requires `completed`). This was not made worse
   deliberately — the old code would have failed it as
   `disappeared-from-client` — but the never-fail rule means it now needs the
   widened retry from task 4 to move. Worth a look when that lands.
4. **Spec vs brief on post-processing.** Brief line 49 says an `in-progress` entry
   "does not change status"; brief line 26 and design §6 say the otherwise-branch
   marks the row `downloading`. I followed the spec (mark `downloading` when it is
   not already), which satisfies the brief's test as written because the row in it
   is already `downloading`. This is the only place the two documents read
   differently, and no other spec/brief disagreement was found.

---

# Fix round 1

## Item 1 — one recovery is one status write and one increment

`db/downloads.ts` gained `reattachClientRef(db, id, clientRef, now)`: the two
corrections a re-attachment actually needs (point the row at its job, retract the
error that stranded it) with **no status write**. Step 3's re-attachment calls that
instead of `setClientRef` and no longer touches `advanced`; the status a recovered
row lands in is now written exactly once, by whichever outcome branch owns it, and
that branch's existing guarded increment is the only one. `download.status` is read
directly in those guards, so the local `status` shadow that carried the forced
`'downloading'` is gone.

Consequences worth stating: for the incident row the first tick after deploy now
reports 35 advances for 35 recovered downloads, not 70. A ref-only correction on an
otherwise healthy row no longer increments `advanced` at all, which is the right
reading — `advanced` means transitions, and a corrected ref is not one.

`setClientRef` is untouched and step 2 still counts its recovery, because
`queued` → `downloading` on a row that had no ref at all is a real transition. Its
comment now says which case is which and that it is explicitly not a licence for
step 3 to count itself, per the ruling.

## Item 2 — the tick now says what it did

`pipeline/scheduler.ts`: `logReconcileResult` mirrors `logIngestResult`'s shape and
voice, called from `reconcilePass` next to the `untracked.set`. It prints
`reconcile <client>: N advanced, N imported, N failed, N cleaned up, N missing from
client, N untracked`.

Two suppressions, both documented in place:

- A tick with nothing to report prints nothing (`advanced + failed + imported +
  removed + absent + untracked` is zero), so a 10-second timer cannot flood.
- Consecutive identical summaries are deduplicated per client via
  `lastReconcileSummary`. This is what makes logging `absent` safe at all: absence
  is sticky by design, so `absent` is non-zero on *every* tick until the situation
  changes, and without dedupe "5 missing from client" would print every ten seconds
  forever. A genuinely quiet tick clears the memory, so a situation that recurs
  later is reported afresh rather than mistaken for a repeat.

## Item 3 — ordering dependence recorded

Comment added at the re-attachment condition: which of two entries sharing one
`[pickarr-N]` label gets to correct the ref depends on `collapse`'s Map insertion
order (history, then queue), the first one wins via the `seen` guard, and that is
known and accepted rather than overlooked — the input is ambiguous, so there is no
right answer, and neither choice loses anything.

## Parked items

`result.absent` semantics unchanged. `warnIfLabelMismatch`'s comment now records
that checking every matched entry (rather than only the null-ref guard path) is
deliberate: the label is a general matching key under this design, so a
name-mangling client breaks more than resubmission, and the warning is still
once per process so the wider scope costs no log volume.

## Covering tests and output

```
$ node --import tsx --conditions development --test \
    packages/core/test/pipeline/reconcile.test.ts \
    packages/core/test/pipeline/scheduler.test.ts
ℹ tests 58
ℹ pass 58
ℹ fail 0
```

New: `recovering a stranded download is one status write and one advance, not two`
(reconcile), plus three scheduler tests — `a reconcile tick that did something logs
its counters, absence included`, `a quiet reconcile tick logs nothing, because a
line every ten seconds is a line nobody reads`, and `an unchanged reconcile
situation is stated once, and again only when it changes`.

The Item 1 test observes the status column with a SQLite trigger
(`AFTER UPDATE OF status ON downloads` → a scratch table), because the intermediate
write is overwritten inside the same tick and is invisible from the outside
otherwise. The trigger idiom is the one `db/downloads.test.ts` already uses for
`failDownload`'s atomicity.

Whole suite:

```
$ npm run test:server → ℹ tests 859  ℹ pass 856  ℹ fail 3   (the 3 known AbortSignal.timeout ones)
$ npm run test:web    → ℹ tests 165  ℹ pass 165  ℹ fail 0
$ npm run lint        → exit 0 (warnings only)
$ npm run typecheck   → exit 0, clean
```

## Mutation evidence for Item 1

Reverted step 3's re-attachment to the pre-fix `setClientRef(...)` +
`result.advanced += 1`, ran the reconcile file alone, restored from a pristine copy:

```
✖ recovering a stranded download is one status write and one advance, not two
  AssertionError: straight to what the client says it is, with no intermediate downloading write
  + actual - expected
    [
  +   'downloading',
      'completed'
    ]
ℹ pass 46  ℹ fail 1
```

The status-write assertion fails before the `advanced` one is reached; both halves
of the double-count are covered by the same test (the trigger sees the extra write,
`result.advanced` would read 2).

## Still open

- Concern 1 from the original report stands: the untracked category comparison is
  exact and case-sensitive, per §9.
- Concern 3 withdrawn, on the reviewer's correction: an `importing` row whose job is
  still in history takes the completed branch and self-heals in-tick, not only after
  a restart. Concern 2 (a genuinely deleted job blocks its release until tasks 4/5
  land) stands as the design accepts it.
- e2e still not runnable here (no Playwright browser binary); unchanged from the
  first report.
