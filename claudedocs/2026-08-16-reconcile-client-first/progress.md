# SDD ledger — plan: docs/superpowers/plans/2026-08-16-reconcile-client-first.md

Spec: docs/superpowers/specs/2026-08-16-reconcile-client-first-design.md (read; binding authority)
Branch: reconcile-client-first
Baseline: 830 server (827 pass, 3 pre-existing failures), 165 web (all pass)
Known-failing (NOT regressions): AbortSignal.timeout mock-timer tests —
  clients/theporndb.test.ts x2, media/artwork.test.ts x1.
Commits: authorised by repo owner for this unattended run; unsigned via
  /tmp/pkcommit.sh when the 1Password agent is unavailable. NEVER push.

## Pre-flight conflict scan

### Task pairs sharing a file or an interface

| A | B | A produces | B consumes | Finding |
|---|---|---|---|---|
| 1 | 3 | `ClientSnapshot.complete`, `entry.category` | absence sweep gate, untracked filter | OK — additive to src; see F1 for tests |
| 2 | 3 | `absentSince`, `markAbsent`, `clearAbsent`, `downloadsByRef/ByLabel` | Pass A/B | OK |
| 2 | 3 | `db/downloads.ts` (only shared source file) | T2 adds, T3 deletes `bumpMissingPolls`/`resetMissingPolls` | OK — T2 explicitly defers deletion to T3, so the build is green at both commits |
| 2 | 4 | `DownloadRow.absentSince` | retry guard, `toDownloadView` | OK |
| 4 | 5 | `DownloadView.absentSince` | web type + row rendering | OK — web type is a hand-maintained duplicate; T5 must edit it separately |
| 1 | 2 | — | — | Disjoint file sets; may run concurrently, will not (single worktree) |

### Task self-consistency

| Task | Checked | Finding |
|---|---|---|
| 1 | tests named vs code specified; files created vs later touched | OK |
| 2 | adds helpers T3 deletes; migration version vs existing max (7 → 8) | OK, verified max is 7 |
| 3 | deletes helpers T2 added; file list vs steps | Was missing `db/downloads.ts` and the downloads test from its file list — corrected in the plan before commit 3ca6a69 |
| 4 | retry guard depends on T2 column | OK |
| 5 | test target exists | Was "create DownloadRow.test.tsx if none" — `Downloads.test.tsx` already covers it; corrected before commit |

### Findings and rulings

**F1 — Adding required fields to `ClientSnapshot`/entries breaks six test files.**
`complete: boolean` and `category: string | null` are required, so every existing
fake snapshot fails typecheck: `clients/sabnzbd.test.ts`, `http/manual.test.ts`,
`http/metadata.test.ts`, `http/server.test.ts`, `pipeline/pick.test.ts`,
`pipeline/reconcile.test.ts`. Task 1 as written would leave `npm run check` red.

Ruling: keep both fields **required** and have Task 1 mechanically update all six
fakes (`complete: true`, `category: null`) even though two of those files belong to
later tasks. Optional-with-default was the alternative and is rejected: a forgotten
`complete` would default to "complete", which is the unsafe direction — it would let
an unverified snapshot drive an absence conclusion, the exact fault being fixed.
Required means the compiler asks the question at every construction site.
Cost if wrong: Task 1's diff is wider than its file list suggests, and touches test
files Task 3 then reworks. Cheap, mechanical, and visible in review.

**F2 — Untracked vs imported.** Recorded during plan review, already corrected in
both documents (spec §5, Task 3 Pass A): an entry whose ref is absent from the match
set but present in `knownRefs` belongs to an imported row and is skipped, not
reported untracked.

**F3 — Queue/history double-processing.** Recorded during plan review, already
corrected in both documents: entries collapse to one per ref with the queue winning.

Ruling on F2/F3: both were fixed in the documents before execution, so no task
carries a contradiction. Cost if wrong: none — they are now stated identically in
spec and plan.

## Progress

Task 1: implemented (commit 0f8e0f3, "Make the client snapshot say whether it is the whole picture")
  Tests 838 server / 835 pass / 3 known-failing (baseline 830); 165 web pass. +8 tests.
  Implementer widened scope to packages/e2e/src/harness.ts and packages/e2e/tests/retry.spec.ts,
  which also construct ClientSnapshot. Consistent with ruling F1; accepted.
Task 1: controller finding (to fold into the fix round if the reviewer does not raise it):
  when history `noofslots` is unreadable, the loop pages to MAX_HISTORY_PAGES (20 requests)
  every tick instead of stopping. Ruling: stop after the first page and set complete=false —
  if completeness cannot be verified, hammering the client 20x buys nothing and the sweep is
  skipped either way. Cost if wrong: a client that omits noofslots but does paginate would
  fetch only its first page, and its absence sweep would be permanently skipped (safe
  direction: no false failures, just no absence detection for that client).
Task 1: fix round 1/5 (2 addressed, 0 open — unhandled queue rejection; page-to-cap on
  unreadable noofslots; commits 0f8e0f3..0698b91). Re-review: both ADDRESSED, no new breakage.
  Regression test confirmed load-bearing (needs a setImmediate macrotask boundary to catch
  the bug; implementer found its first version passed against broken code and fixed it).
Task 1: complete (commits 3ca6a69..0698b91, review clean)
Task 2: interrupted by the human's SSH drop before commit; work verified intact by the
  controller (guard restored, not left mutated; lint/typecheck 0; 846/843/3 known-failing),
  then the same agent resumed to redo the mutation evidence, report, and commit.
Task 2: implemented (commit 7ceff3f, "Replace the missed-poll counter with an absence timestamp", SIGNED)
  846 server / 843 pass / 3 known-failing; 165 web pass. Mutation evidence: removing the
  `AND absent_since IS NULL` guard makes the covering test fail (9 !== 5), restored passes.
Task 2: review — spec PASS, quality PASS, two Important notes.
Task 2: Ruling: fix the downloadsByRef/downloadsByLabel query duplication now, as one
  function running one query and returning both maps. Task 3 has not been written yet, so
  this is the cheapest moment; deferring would bake the two-call shape into its caller.
  Cost if wrong: a slightly wider Task 2 diff.
Task 2: parked — clearAbsent omits resetMissingPolls' existence-check-and-throw —
  Ruling: correct as-is, and the reviewer's "defensible" understates it. resetMissingPolls
  only pays for its getDownload probe on the rare changes===0 path; for clearAbsent the
  no-op path is the COMMON case (most rows are not absent), so the probe would become a
  per-row-per-tick query guarding a condition that cannot arise — every id passed in was
  just read from the database by the caller. Comment added to record this.
  Cost if wrong: a caller that someday passes a bad id gets a silent no-op, not a throw.
Task 2: fix round 1/5 (1 addressed, 0 open — query duplication collapsed into
  indexDownloadsForClient; commits 7ceff3f..2898853, SIGNED). Re-review: ADDRESSED, parked
  finding handled as comment-only, no new breakage. The "one query" test proves itself by
  reference equality between the two maps' entries, which a two-query build would fail.
Task 2: complete (commits 0698b91..2898853, review clean, 1 parked)
NOTE for Task 3: downloadsByRef/downloadsByLabel NO LONGER EXIST. Use
  indexDownloadsForClient(db, clientId) -> { byRef, byLabel }. The task-3 brief predates this.
Task 3: implemented (commit 6026f9d, "Iterate the client, and demote absence from a verdict
  to an observation", SIGNED). 855 server / 852 pass / 3 known-failing; 165 web. 7 mutations
  applied, all 7 killed, including both outranking properties.
Task 3: review — spec PASS, quality PASS. Reviewer verified both outranking properties and
  all six ordering constraints in code; confirmed the duplicate-entry-guard hole is created
  by the inversion (not pre-existing); judged the implementer's `importing` concern
  over-stated (such a row self-heals in-tick via the completed branch, not only at restart).
Task 3: Ruling: fix the double `advanced` increment + redundant status write on the
  re-attachment path. One recovery must be one write and one increment; otherwise the first
  post-deploy tick reports 70 advanced for 35 recovered rows. Cost if wrong: a counter and a
  wasted write, no state corruption.
Task 3: Ruling: OVERRIDE the implementer's "out of scope" on the unread `result.absent`.
  reconcilePass logs only failures today, so a tick that marks 30 rows absent prints
  nothing — which reproduces the exact invisibility that made this incident expensive (35
  failures over 17 minutes, nothing said so). Add a summary log for non-quiet ticks only.
  Cost if wrong: one more log line per active tick.
Task 3: Ruling: the ref-vs-label winner is Map-insertion-order dependent when two entries
  share one label. Behaviour unchanged (ambiguous input, no data loss either way, spec
  silent); comment added so it is not mistaken for an oversight. Cost if wrong: on such
  input the client_ref repoints to the label match instead of the ref match.
Task 3: parked — `result.absent` counts every swept row, not only newly-marked ones —
  Ruling: better semantics than the brief's wording and documented, not silent; stands.
Task 3: parked — warnIfLabelMismatch widened to every matched entry — Ruling: harmless,
  still once per process, more useful; stands, with its comment noting the wider scope.
Task 3: fix round 1/5 (3 addressed, 0 open — double advance/write; unread absent counter;
  map-order comment; commits 6026f9d..8e661c1, SIGNED). Re-review: all ADDRESSED, parked
  items untouched, properties (a)/(b) undisturbed, no new breakage.
Task 3: parked — the new log dedup keys on the rendered counter string, so an event whose
  counters coincidentally match the previous tick's is suppressed until the text changes —
  Ruling: accept. Perfect fidelity needs row-set diffing, which is out of scope for a
  summary line; the failure mode is bounded (only same-shaped, only while non-quiet) and is
  strictly better than today's total silence. Cost if wrong: one class of same-shaped
  absence change goes unlogged until the numbers move.
Task 3: complete (commits 2898853..8e661c1, review clean, 3 parked)
Ruling: BATCH tasks 4 and 5 into one dispatch. The plan itself warns their two halves must
  agree ("the retry button and the widened guard must agree or the button 409s"); putting a
  review boundary between them invites exactly that disagreement, and both are small.
  Cost if wrong: one review covers two layers, so a UI-only defect gets less isolated
  attention than it would alone.
Tasks 4+5: implemented (commits af36497 API, fdba758 UI, batched per ruling above).
  862 server / 859 pass / 3 known-failing; 168 web pass (baseline 165). Mutation evidence for
  both the widened retry guard and the UI's matching condition.
FINDING (pre-existing, NOT introduced by this branch, for the final review + the human):
  `npm run check` chains `test:server && test:web`, so the 3 known-failing AbortSignal.timeout
  tests make it exit before test:web ever runs. `npm run check` therefore cannot pass on this
  machine at all, and has never exercised the web suite here. Every task in this plan verified
  by running the suites separately instead. This is a tooling defect predating the branch.
Tasks 4+5: review — spec PASS, quality PASS, no Critical/Important. Two-halves agreement
  verified by hand (De Morgan equivalence between the UI's `retryable` and the API's 409
  condition); both DownloadView declarations updated; duration is a pure floored render, no
  live clock.
Tasks 4+5: parked — one new web test uses queryByRole + assert.equal(...,null) rather than
  the gone() boolean helper — Ruling: not the banned queryByText form, and it mirrors two
  pre-existing untouched instances in the same file; converting them is unrelated cleanup.
  Cost if wrong: if that assertion ever fails it formats slowly, on one test.
Tasks 4+5: complete (commits 8e661c1..fdba758, review clean, 1 parked)
ALL FIVE TASKS COMPLETE. Proceeding to final whole-branch review.

## Final whole-branch review

Verdict: safe to merge, no Critical/Important. Traced the 35-row recovery end to end and
confirmed it happens on the first tick with no repair script: 35 advanced, 33 imported,
2 failing their import with a real filesystem error (correct — their directories are gone).
Both outranking properties verified across the branch. missing_polls retirement coherent.
No new retry race (clearAbsent runs before the import, so a mid-import row still 409s).
All 7 parked items triaged SHIP.

Ruling: ONE fix wave for 4 of the 6 minors. Two are comment-truth fixes the reviewer asked
  be folded in first (a comment claiming "seven failDownload call sites" when there are five;
  an unstated deliberate omission on markAbsent/clearAbsent not bumping updated_at). One is a
  supersession pointer on the superseded 2026-08-04 design doc (historical record, so a
  pointer, never a rewrite). The fourth is substantive and I am taking it because it tightens
  the branch's own central invariant: a slot dropped for an unreadable nzo_id still counted
  toward noofslots, so a snapshot genuinely missing one of our jobs could report
  complete === true, which property (b) would then let mark that job absent. Now any dropped
  slot makes the snapshot incomplete, which also makes the paging-vs-mutating-history skip
  visible. Cost if wrong: a client that routinely returns unreadable slots would keep its
  absence sweep permanently disabled — the safe direction (no false failures).
Ruling: the remaining 2 minors ship untouched — the uncapped untracked panel (rows are never
  deleted and knownRefs has no status filter, so a healthy install reports zero) and the
  queryByRole test style (pre-existing convention in that file).
Final fix wave: complete (commit 30605d0, SIGNED). Re-review: all 4 ADDRESSED, zero/zero
  completeness case confirmed still true (idle installs keep their absence sweep),
  leave-alone list held, no new breakage.
Controller's own final verification: lint 0, typecheck 0, server 864/861/3 known-failing,
  web 168/168, working tree clean.
BRANCH COMPLETE. Not pushed; not merged. Awaiting the human.
