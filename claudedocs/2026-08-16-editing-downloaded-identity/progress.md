# SDD ledger — plan: docs/superpowers/plans/2026-08-16-editing-downloaded-identity.md

Spec: docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md (read; binding authority)
Branch: fix/edit-picked-files
Base commit: 7ed6d21 (spec + plan). Two rebases rewrote every commit id this run produced; every id in this
file is a live one, and the dead pre-rebase ids are listed under "Commit ids in this file" at the end, each
tied to the tag that still reaches it.

## Pre-flight conflict scan

### Cross-task: every pair sharing a file or interface

| Tasks | Produces → Consumes | Finding |
|---|---|---|
| 1 → 6 | `liveFilesForOtherReleases(db, groupId, keepReleaseId)` → planner's trashing + live-file walk (`null` = keep nothing) | T6's `doomed` expression is wrong as written — see F3 |
| 1 → 7 | `moveDownloadsToGroup`, `moveImportedFilesToGroup` → applier phase 1 | names and arity agree — clean |
| 2 → 7 | `trashFiles(db, files, libraryRootReal, trashDir, groupId, now)` → phase 2 call | arg order agrees positionally — clean |
| 2 → import.ts | rows-in refactor → existing upgrade-import caller | caller rewritten in same task — clean |
| 3 → 6 | `resolveDestination` export → `destinationFor` | clean |
| 3 → 7 | `moveWithinLibrary(from, to, libraryRootReal, renameImpl?)` → phase 3 | clean |
| 4 → 7 | `ManualDeps.trashDir`, `.rename` → phases 2 and 3 | clean |
| 4 → all http tests | `ServerDeps.trashDir` → every ServerDeps construction site | T4 names only one of three test sites — see F10 |
| 5 → 6 | `identity-plan.ts` with empty arrays → arrays populated | same file, sequential — clean |
| 5 → 7 | `planIdentityChange`, `IdentityPlan`, `resolveIdentityFor` | clean |
| 5 → 8 | `planIdentityChange` → plan route | clean |
| 6 → 7 | populated plan → applier reads `renames`/`trashing`/`blockers`/`digest` | clean |
| 7 → 8 | `editGroup(deps, id, values, planDigest?)`, `GroupEditOutcome` → PATCH route | T7 test text implies a 5th arg — see F2 |
| 1 → 7 | both modify `db/imported-files.ts` | sequential, no conflict — see F5 |
| 8 → 9 | `GroupEditResponse` + both routes → client methods | clean |
| 9 → 10 | `useIdentityChange`, `IdentityChangeConfirm` → Browse + Picks | clean |
| 10 → 11 | UI → e2e spec | clean |
| 12 | docs only, consumes nothing | clean |

### Per-task self-consistency

| Task | Tests vs code it specifies | Finding |
|---|---|---|
| 1 | seeds omit `edited_at`/`upgrade_release_id` | both nullable, `state` has a default — valid (F7) |
| 2 | `trashFiles` tests vs rows-in signature | agrees |
| 3 | three mover tests vs `moveWithinLibrary` | agrees |
| 4 | no behaviour, green suite is the assertion | agrees, but file list incomplete (F10) |
| 5 | `reconcilePick` non-null assertions | contestable style — F4 |
| 5 | test fixtures declared "copy them in, no shared module" | refuted by T7 needing them — F1 |
| 6 | `doomed` expression | self-declared wrong — F3 |
| 7 | tests use `FILING`/`seedWithFile` from T6's file | cross-file fixture reference — F1 |
| 7 | `markPicked` before `flagUpgrade`/`refreshUpgradeFlag` | load-bearing ordering, verified — F6 |
| 8 | tests call an invented `harness()` | file uses `buildServer(deps(db))` — F9 |
| 9 | `api.manualFields()`, `api.editGroup` | both exist (client.ts:435, :452) — clean |
| 10 | Picks wiring vs MediaCard props | MediaCard already accepts them — clean |
| 11 | e2e body is numbered comments | plan already forbids leaving them — clean |
| 12 | doc edits vs spec §10 | agrees |

### Rulings made before execution

Ruling: F1 — extract shared test fixtures (`PLUGIN`, `FILING`, `registryFor`, `makeDeps`, `ok`, `failure`, `seedTwoGroups`, `seedWithFile`) into `packages/core/test/manual/fixtures.ts` in Task 5, imported by both `identity-plan.test.ts` and `operations.test.ts` — Task 5's note saying a shared module "is not worth it for two files" is refuted by Task 7, which provably needs the same fixtures in a second file; the spec does not speak to test layout, so this is decided on engineering grounds — if wrong, cost is one extra small module that could have been duplicated instead.

Ruling: F2 — `editGroup` takes exactly four parameters and there is no test-only digest bypass; tests that need to apply a moving plan first call `planIdentityChange` and pass its real digest — a bypass flag would put a hole in the confirmation gate that is the feature's whole safety argument, and the plan's own text already disowns the fifth argument — if wrong, cost is slightly longer test setup.

Ruling: F3 — the planner's superseded-file lookup is two `liveFilesForOtherReleases` calls concatenated (the source group always; the target group only when merging), each keeping the surviving pick's release, with the `-1` sentinel deleted; Task 6 additionally gets a test where the *target* holds the losing pick — the superseded pick can sit on either side of a merge and the plan's single source-side call cannot see the target's — if wrong, cost is a wrong file trashed or a stale file left, which the task's own tests should catch.

Ruling: F4 — restructure `heldScore` to return `{ releaseId: number; score: number } | null` so `reconcilePick` needs no non-null assertions — the global constraint bans `any`/`unknown` and assertions guarded three lines away are exactly what the reviewer will flag — if wrong, cost is nil; it is a pure refactor of unshipped code.

Ruling: F5 — `getImportedFile` and `setImportedFileDest` stay in Task 7 rather than moving to Task 1 — adding them in Task 1 would land two exports with no caller, which reads as YAGNI to a task reviewer — if wrong, cost is `db/imported-files.ts` appearing in two tasks' diffs.

Ruling: F6 — the order `markPicked` → `flagUpgrade`/`refreshUpgradeFlag` in Task 7 phase 1 is load-bearing and must not be "simplified": both flag functions re-read the group and derive from its *current* `picked_release_id` (groups.ts:288-317), so deriving before the adopted pick is written would flag against the wrong pick — carried into Task 7's dispatch as a named constraint.

Ruling: F9 — Task 8's route tests use the existing `buildServer(deps(db))` pattern and the `seedTwoGroups` already in `test/http/manual.test.ts`, not an invented `harness()` — the plan's `harness()` does not exist in that file — if wrong, cost is test boilerplate differing in style from neighbours.

Ruling: F10 — Task 4 must update **all three** `ServerDeps` construction sites in tests (`test/http/server.test.ts`, `test/http/manual.test.ts`, `test/http/metadata.test.ts`), not just the one the plan names; the implementer runs `grep -rln "ServerDeps" packages/core/test` and fixes every hit — the plan's file list was incomplete and typecheck would fail without this — if wrong, cost is nil.

## Task log
Ruling: commits — implementers stage only; SDD's per-task commit ranges are replaced by
`git write-tree` index snapshots, and review packages are tree-to-tree diffs. The project owner's
standing instruction ("NEVER make a commit without my explicit approval", in both CLAUDE.md and
INIT.md) overrides the skill's assumption of a commit per task; user instructions outrank skills.
Tree snapshots preserve everything the skill actually needs from commits — an exact reviewable
range per task, and a recovery record — without committing. Cost if wrong: the ledger's tree SHAs
are only reachable while the index and object store survive; a `git gc --prune=now` plus a reset
would lose the per-task boundaries (the working tree itself would still hold all the work).

Task 1 tree snapshots: before dd3ebd48, after 67a74bce.
Task 1: complete (trees dd3ebd48..67a74bce, review clean — spec OK, quality Approved)
Task 1: minor (deferred): comments transcribed verbatim from the brief rather than independently authored
Task 1: minor (deferred): `--test-name-pattern` does not filter under this project's `node --test` invocation, so red-before-green was inferred from the full-suite pass rather than a targeted run
Task 1: resolved ⚠️ — reviewer could not verify the three functions have a caller; that caller is Task 7's deliverable, so it is not a Task 1 gap.
Task 2: complete (trees 67a74bce..55748a61, review clean — spec OK, quality Approved)
Task 2: minor (deferred): `db/imported-files.ts:35` edited outside the brief's file list (stale `trashLiveFiles` comment reference); justified, since leaving the stale name would itself be a defect
Task 2: minor (deferred): `upgrade.ts` merged `markTrashed` + `type ImportedFileRow` into one import rather than a separate `import type` line
Task 2: resolved ⚠️ — reviewer could not verify `liveFilesForOtherReleases`' selection logic from this diff; it was reviewed and approved under Task 1.
Task 3: complete (trees 55748a61..be963625, review clean — spec OK, quality Approved)
Task 3: minor (deferred): report cited line 299-307 for the new function body, which is actually its JSDoc; cosmetic reporting slip only
Task 3: resolved ⚠️ — reviewer did not re-run the gate; that was instructed, since the implementer's report carries test evidence.
Task 4: complete (trees be963625..7b0bbf5b, review clean — spec OK, quality Approved, zero findings)
Task 4: note — a FOURTH ServerDeps construction site existed in packages/e2e/src/harness.ts, which my
  pre-flight F10 grep missed because I scoped it to packages/core/test. The implementer found it via
  typecheck and the reviewer confirmed repo-wide that nothing else remains. F10's ruling held; its
  enumeration was short by one.
Task 4: controller-verified gate at tree 7b0bbf5b — server 840/840, web 165/165, lint/typecheck/build exit 0
  (dispatched because the implementer reported only the web count, and this task's whole assertion is a green suite).
Task 4: resolved ⚠️ — `ManualDeps.rename` has no consumer yet; Task 7 consumes it, so absence is expected.
Task 5: fix round 1/5 pre-review (controller-ordered, before the review rather than after: the concern was
  scope-shaped and would have broken Task 7) — renamed the shared merge fixture to `seedMergePair`
Ruling: F11 — the shared merge fixture is named `seedMergePair`, not `seedTwoGroups`, and
  `operations.test.ts` keeps its own differently-shaped local `seedTwoGroups` — the implementer found that
  the two seeds are incompatible (titles A/B + 1080/2160 + a downloads row, versus G1/G2 + 720/2160 + none)
  and that nine existing tests have assertions calibrated to the local one; renaming the new shared fixture
  is one edit where unifying them would have been nine rewrites, and the name now says what it actually
  seeds — if wrong, cost is two similarly-named seed helpers in one directory, which the fixture's own
  comment now warns about.
Task 5: complete (trees 7b0bbf5b..96ec51f6, review clean — spec OK, quality Approved)
Task 5: minor (deferred): `identity-plan.ts:48` doc comment refers to reordering "the literal in `finish()`",
  but no `finish()` exists — the object is built inline in `planIdentityChange`. Originates in my own plan
  text. FOLDED INTO TASK 6's dispatch, since Task 6 edits that exact literal.
Task 5: reviewer misread, corrected — it flagged `registryFor`/`makeDeps` gaining an optional `libraryRoot`
  as scope creep "not requested by the brief or either ruling". It WAS requested, in my Ruling 1 dispatch text,
  precisely so Task 6 can point a fixture at a real temp directory. Not creep; not deferred.
Task 5: resolved ⚠️ — reviewer did not re-run the suite (instructed); it did independently run
  `tsgo --noEmit` on packages/core, which passed.
Task 6: fix round 1/5 (3 addressed, 0 open — per-file-quality test gap [Important], non-Error throw message,
  target-side disjointness assertion; trees 6a9f6b75..a1512f63)
Task 6: complete (trees 96ec51f6..a1512f63, review clean — spec OK, quality Approved after one fix round)
Ruling: F12 — my own fix instruction was wrong and I accepted the implementer's correction. I asked the
  target-side trashing test to assert `plan.renames` is EMPTY. It is not: the rename loop walks the SOURCE
  group's live files regardless of which side loses the pick, so in a target-superseded merge the source's
  winning file is legitimately renamed into the target's directory. The implementer's first test run failed,
  it substituted an exact non-empty array plus an explicit "trashed id absent from renames" check, and the
  re-reviewer independently verified the claim against identity-plan.ts:283-333. Cost if wrong: none —
  the substitution is strictly stronger than what I asked for.
Task 6: minor (deferred): the `assert.ok(!plan.renames.some(...))` disjointness line is logically redundant
  with the `deepEqual` above it — redundant, not weaker.
Task 6: resolved ⚠️ — reviewer did not re-run the gate (instructed).
Task 7: fix round 1/5 pre-review (controller-ordered) — collision-blocker exemption for a plan's own trashed
  occupant + groupHistory retention comment (trees a1512f63..29f8e847)
Ruling: F13 — the planner must NOT block a rename whose destination is occupied by a file that the SAME plan
  lists in `trashing`. My spec worded the blocker as "occupied by something that is not the file being moved",
  which failed to exempt a file phase 2 is about to remove — making phase 2 unreachable via a real collision
  and 409-ing the exact case the design cites as its motivation. Found by the Task 7 implementer, which
  correctly declined to fix it unilaterally. Cost if wrong: an over-broad exemption would let the applier
  overwrite a stranger's file, so the exemption is keyed strictly on the trashed paths set and was re-reviewed
  for narrowness.
Ruling: F14 — keep `groupHistory`/`GroupHistory` despite having no production caller after the refusal was
  removed, with a comment recording that `editGroup`'s merge refusal was its only caller. Deleting it would
  orphan two rationale comments that cite it (db/migrations.ts:298-299, db/metadata.ts:381) as the reference
  point for "has anything ever happened to this group" versus "whose name is on a live file", and this repo
  deliberately preserves settled reasoning. Its four tests also document that a trashed file still counts as
  history. Cost if wrong: ~10 lines of tested-but-unused code. SURFACE TO OWNER as a deletion they may want.
Task 7: fix round 2/5 post-review (1 Critical, 2 Important, 2 Minor — all addressed; trees 29f8e847..70004d9f)
Ruling: F15 — I WAS WRONG, and the record is corrected. My Ruling B told Task 7 that the
  `markPicked`-before-`flagUpgrade`/`refreshUpgradeFlag` ordering was load-bearing and test-enforced. It is
  neither: `markPicked` re-derives `upgrade_release_id` itself, so either order yields an identical row, and
  no test fails on a reorder. The reviewer proved it. The ordering is retained as preferable (the flag is
  derived against the adopted pick rather than relying on an overwrite) but the comment now says only what is
  true, because an overstated invariant is what licenses a real reorder later. Cost of my error if it had
  stood: a comment promising protection that does not exist.
Task 7: complete (trees a1512f63..70004d9f, review clean after two fix rounds — spec OK, quality Approved)
Task 7: minor (deferred): the vanished-doomed-row branch has no test. The implementer said it needs an
  in-transaction hook; the re-reviewer showed that is wrong — an `AFTER UPDATE ON imported_files` trigger
  reproduces it with no concurrency, the same technique two other tests already use. Cheap and worth adding;
  its only effect is one `failed` entry. FLAG TO FINAL REVIEW.
Task 7: minor (deferred): two comment wording nitpicks — "the only thing flagUpgrade adds that markPicked did
  not" is untrue in the degenerate case of a target picked on a since-deleted release; and deleteGroup's
  "rows that have no foreign key to insist on it" reads as if the metadata tables lack an FK, which they have.
Task 7: minor (deferred): new tests leave their `mkdtemp` directories behind.
Task 7: minor (deferred): `resolveIdentityFor` runs twice per edit (once in the planner, once in the applier),
  so untrusted plugin hooks are invoked twice; collapsing it means widening IdentityPlan with
  displayJson/searchText.
Task 7: NOTE FOR TASK 8 — Task 7 rewrote two tests in test/http/manual.test.ts to assert an interim 409,
  because PATCH cannot carry a digest until Task 8. Task 8 MUST restore them to success assertions.
  packages/e2e/tests/manual.spec.ts also stays red until Tasks 8-10; e2e is not in the gate.
Task 8: complete (trees 70004d9f..b705579c, review clean — spec OK, quality Approved)
Task 8: DEBT REPAID — both interim-409 tests Task 7 parked are restored to assert a real plan->digest->PATCH
  merge (target returned, source group gone), the interim comments are removed, and no test now asserts that
  an otherwise-valid merge over HTTP is a 409. The remaining 409 test is the correct permanent
  missing/stale-digest refusal.
Task 8: minor (deferred): the new route's comment cites `/api/manual-preview` as the GET-vs-POST
  method-honesty precedent, but that route's comment only explains why it writes nothing; the real precedents
  are at server.ts:583 and server.ts:681. Imprecise cross-reference only.

## INCIDENT — index unstaged during Task 9 (recovered, no work lost)

During Task 9 the *modifications to tracked files* from Tasks 1-8 were unstaged (git status showed them
as ` M`: index matching HEAD, content live in the working tree). Files ADDED by earlier tasks stayed
staged (`A `), so this was not a blanket `git reset` — most likely a path-scoped unstage.

Detected because the Task 9 review package's tree diff showed Tasks 1-8 additions being REMOVED
(operations.ts -424, operations.test.ts -602, views.ts -20, main.ts -1) rather than web files being added.
Caught before any reviewer saw the bogus diff.

No work was lost: all content was intact in the working tree; every new file still existed; the gate ran
green against the working tree throughout. Recovered with `git add -A` (no untracked strays; the workspace
is gitignored). Corrected T9 = e05a6fb4, and T8->T9 is now exactly the six expected web files, additive.
Controller re-verified the gate afterwards: server 876/876, web 175/175, lint/typecheck/build exit 0.

This is the failure mode my earlier commits ruling flagged as the cost of tree snapshots instead of commits.
Hardening for the rest of the run: after every task, assert the index is complete (`git status --porcelain`
has no line whose FIRST column is a space) BEFORE calling write-tree, and sanity-check that the new tree's
diff against the previous one is confined to the files that task was scoped to.
Task 9 tree snapshots: before b705579c, after e05a6fb4 (corrected).
Task 9: fix round 1/5 pre-review (controller-ordered) — RequestError carrying `status` so a stale-digest 409
  is distinguishable, widened `apply` contract to `ApplyOutcome`, and six direct tests for the hook
Ruling: F16 — `request` in client.ts now throws `RequestError extends Error` with a numeric `status`, and the
  hook's `apply` callback returns `{ saved: true } | { saved: false; stale: boolean }`. Before this the helper
  threw a bare Error with only a message, so the hook re-planned on EVERY failure — a 500 or a dropped
  connection would have left the user cycling in a dialog with no idea what went wrong, when re-planning in
  place exists solely for the stale-digest case. MediaCard's `onEditGroup(values) => Promise<boolean>` is
  untouched, so the card stays presentational. Cost if wrong: one new exported error class; existing
  `(cause as Error).message` call sites keep working because it is an Error subclass.
Ruling: F17 — accept `as unknown as typeof fetch` in the new web test. It violates the project's blanket
  no-`unknown` rule as literally stated, but it is the established repo-wide idiom for stubbing
  `globalThis.fetch`, already present unmodified in ~18 places across Settings/Failed/Downloads/ManualForm/
  Picks/useGroupMetadata tests. Matching the surrounding code beats diverging in one new file. Cost if wrong:
  one more instance of an existing pattern. SURFACE TO OWNER — a typed fetch-stub test helper would remove
  all ~20 occurrences at once if he wants the rule enforced literally.
Task 9: complete (trees b705579c..e05a6fb4, review clean — spec OK, quality Approved)
Task 9: controller-verified gate at tree e05a6fb4 — server 876/876, web 175/175, lint/typecheck/build exit 0
Task 9: resolved ⚠️ — reviewer could not verify MediaCard still compiles against `begin`'s Promise<boolean>,
  since MediaCard is untouched here; Task 10 wires it and its gate will prove it.
Task 10: complete (trees e05a6fb4..72dc5591, review clean — spec OK, quality Approved)
Task 10: fix round 1/5 post-review — the one Important finding was in Task 9's hook, not Task 10's diff;
  fixed there (trees 72dc5591..f893d19b), re-reviewed ADDRESSED with a bounded-termination proof
  (at most 2 identityPlan calls and 2 apply calls, no loop, no recursion).
Ruling: F18 — fix the silent no-op rather than ticket it, even though the reviewer called it a follow-up.
  `begin`'s no-confirmation fast path swallowed a stale 409 entirely: no dialog, no error, the user clicked
  Save and got silence. Every other refusal in this flow is shown; this feature's whole argument is that
  consequences are shown rather than swallowed, so a silent Save was not something to defer. Bounded to at
  most one re-plan and one retry, then report — an unbounded retry would have been worse than the no-op it
  replaced. Cost if wrong: ~70 lines in the hook and three tests for a race that needs concurrent ingest.
Task 10: verified — the two refusal tests restubbed 409->400 did NOT weaken. Blocker-based merge refusals now
  surface at PLAN time (Confirm is disabled), so they never reach PATCH; the only PATCH-time refusal a user
  should read is a 400 from resolveIdentityFor, which is what those tests now exercise, and the
  "refusal reaches the user" assertion is intact.
Task 10: verified — the Picks reload test counts requests (pickCalls === 2), so it distinguishes a reload from
  a patch rather than passing either way; and a test asserts patched.length === 0 before confirmation, so
  "does not save before confirming" is pinned, not just "saves after".

## Session resumed 2026-08-17 (new controller context)

Task 11 tree snapshots: before f893d19b, after 962a9319.
Task 11: implemented and reported (task-11-report.md), NOT yet reviewed — no review package existed when this
  context picked the run up, and the ledger had no Task 11 line. Post-task hardening checks re-run here and
  both pass: `git status --porcelain` first column is `A`/`M` only (index complete, nothing unstaged, nothing
  untracked), and tree f893d19b..962a9319 touches exactly the three files Task 11 was scoped to
  (packages/e2e/src/harness.ts, packages/e2e/tests/identity-change.spec.ts, packages/e2e/tests/manual.spec.ts).
Task 11: implementer reported the full gate green at 962a9319 — lint 0, typecheck 0, test server 876/876 and
  web 182/182, build 0, e2e 15/15 (including the new identity-change spec and the repaired manual merge test).
Task 11: DEBT REPAID — Task 10's note said manual.spec.ts's merge test would go red once a merge always needs
  confirming. Task 11 added the dialog click; the e2e run above covers it.
Task 11: implementer concern to carry into review — `KNOWN_SITES = ['SomeSite']` seeded into
  packages/e2e/src/harness.ts is shared-fixture state, added because `parseDatelessForm` refuses a dateless
  release whose leading run is not an already-known site, so the bug's own shape was unreachable in the
  harness. Scoped to a site name no other spec uses.
Task 11: review package built at task-11-review-package.md (tree f893d19b..962a9319), reviewer dispatched.
Task 11: complete (trees f893d19b..962a9319, review clean — spec OK, quality Approved, zero Critical/Important)
Task 11: the reviewer independently verified the KNOWN_SITES concern rather than taking the report's word for
  it, and it holds: `parseDatelessForm` genuinely refuses without a matched site (plugin-scenes/src/parse.ts:
  1305-1306), while `parseDateAtEndForm` (:1169-1170) and the dated path (:1376 via canonicalSiteName
  :1263-1272) both fall back to the release's own text, so seeding `sites: ['SomeSite']` cannot change parsing
  for any dated release. It also grepped every other e2e spec's release strings — Vixen/Tushy/Blacked/Tailend/
  Padding, no collision with `SomeSite`.
Task 11: the reviewer also cross-checked the spec's literal expected library paths against `templateValues`/
  `renderSegment` (plugin-scenes/src/path-template.ts:143-175,207-246) and every dialog/release-row selector
  against IdentityChangeConfirm.tsx:23,26,50,54,80 and ReleaseRow.tsx:46,67,72 — the assertions are grounded
  in real markup and real derivations, not invented selectors.
Task 11: minor (deferred): identity-change.spec.ts is one 158-line six-step scenario; a second scenario added
  to that file would want steps 1-2 factored into a helper. Not a defect now.


### Pre-dispatch check of Task 12's brief (docs-only task; I read all three target files first)

Ruling: F19 — Task 12's Step 3 is premised on a bullet that does not exist. The brief says "Issue #2 is now
  done, so remove or amend its bullet accordingly", but `docs/known-issues.md` has NO `issues/2)` link
  anywhere (its tracked links run #3-#40; verified with `grep -n "issues/2)"` → no match). Issue #2 —
  "Allow editing the identity of a group that has already been downloaded", still OPEN on GitHub — is the
  issue this whole branch closes, and it was never listed in that file. The step therefore becomes: follow
  the file's OWN established convention for an issue a branch closes, which is documented by the #39
  precedent at line 410 — the bullet is replaced by the line
  `#N is closed by this branch and should be marked closed on merge.`, placed at the end of the section whose
  reasoning it belongs to. For #2 that section is `## Manual metadata` (lines 380-411), which is where the
  merge-refusal reasoning lives. Since #2 has no bullet to replace, Task 12 ADDS the closure line there,
  preceded by a short `**Closed: ...**` paragraph matching the #39 entry's shape, pointing at the new design
  doc rather than restating it. Cost if wrong: one paragraph in the wrong section of a docs file, trivially
  moved.

Ruling: F20 — §2 of the manual-metadata spec has a SECOND out-of-scope bullet this work invalidates, and the
  brief names only the first. The brief says to replace "**Moving files already imported.**" (lines 33-36);
  it does not mention "**Merging groups that have history.** See §7.3." (line ~44), which is the out-of-scope
  entry pointing at the very refusal §7.3 no longer performs. Amending one and leaving the other would leave
  the spec asserting, in the same list, that merging a group with history is out of scope — the exact claim
  this branch retires. Task 12 amends BOTH bullets. Authority: the design doc's own §10 says it amends §2 and
  §7.3, and this bullet is §2 text about §7.3's refusal. Cost if wrong: one extra amended bullet in a spec
  that the design doc already declares it is amending.

Ruling: F21 — Task 12's Step 4 (the README) resolves to "change nothing", and I resolved it myself rather
  than spend an implementer round on it. The README has no section describing the Edit form or editing a
  group's identity (`grep -n "^## "` → Quick start, Configuration, Scene metadata, Operational notes,
  Building the image directly, Development; no Edit/manual-metadata section). Its two nearby passages both
  stay true: lines 138-141 describe `pathTemplate` not moving already-imported files, which remains out of
  scope (issue #22), and lines 260-265 describe changing a site's name in CONFIG re-keying scenes, which is
  mass config-driven re-keying, not a single group edit. The implementer still runs the brief's grep to
  confirm. Cost if wrong: a README that under-documents a feature, fixable in one line.

Task 12 tree snapshots: before 962a9319, after dbb44b46. Index verified complete (`A`/`M` only) and the diff is
  confined to the two docs files Task 12 was scoped to (docs/known-issues.md +14, the 2026-08-07 spec +28/-7).
  README correctly untouched, per F21.
Task 12: review package built at task-12-review-package.md, reviewer dispatched.
Task 12: controller-verified gate at tree dbb44b46 — lint exit 0, typecheck exit 0, test:server 876 pass /
  0 fail, test:web 182 pass / 0 fail, build exit 0. Dispatched because the implementer's status line reported
  the count vaguely as "182+ passed" and named only the web suite; the server count is now pinned. (My first
  attempt at this measured nothing — `PIPESTATUS` read after an `echo`, and node's reporter prints `ℹ pass`
  rather than `# pass`, so both the exit codes and the greps came back empty. Re-run with correct capture.)
Task 12: controller-verified e2e at tree dbb44b46 — exit 0, 15 passed in 8.4s. So the FULL five-command gate
  is controller-verified at the final tree, not merely implementer-reported: lint, typecheck, test (876+182),
  build, e2e.

Task 12: review returned spec ❌ / Needs fixes — 2 Important + 2 Minor. The four required amendments were all
  judged present, accurate and well-voiced, and F20 (amending the second §2 bullet) was independently confirmed
  correct. The failure is elsewhere in the SAME document: §11 Known risks (~line 453) still asserts "Editing a
  group with imported files leaves those files behind", and §10 Testing (~431-434) still lists "merge refused
  for a group with a download / with an imported file" as expected coverage. I verified both against the file
  myself before dispatching the fix — they are real, and they are exactly the one-paragraph-fixed-neighbour-
  left-contradicting failure this task existed to prevent.
Task 12: the implementer's "Concerns: None" was unsupported — its report claimed it re-read "§2, §7, and
  §7.3-§7.4" and found no third stale passage, but §8, §10 and §11 were outside that set and all three drift.
  The fix dispatch therefore orders a section-by-section read of the WHOLE spec with a checkable list, not
  just repairs to the three places named.
Ruling: F22 — I folded the Minor §8 finding (the `PATCH /api/groups/:id` table row still shows `{ values }` →
  `{ group, mergedInto }`, omitting `planDigest` and the `renamed`/`trashed`/`failed` response fields) into
  this Important fix round, rather than deferring it as the skill's default says to do with Minors. The rule's
  purpose is to stop polish from EXTENDING a loop; this round is already running for two Importants, the
  finding is the same drift in the same document, and the fix is one table row whose corrected shape the new
  design doc's §7 already states. Deferring it would hand the final whole-branch review a one-line reopen of
  a file we are editing right now. Cost if wrong: one extra table row in a fix round that was happening anyway.
Task 12: Minor 4 (thin test-count evidence in the report) needs no fix — already superseded by the
  controller-verified gate recorded above, which pins all five commands and both suite counts.
Task 12: fix round 1/5 dispatched (resumed the original implementer, per rounds 1-3 = resume).
Task 12: fix round 1/5 (4 addressed, 0 open — §11 stale bullet, §10 stale test list, §8 table row, and the
  checkable whole-document scan; trees dbb44b46..dfaa7f34). Re-review found no new breakage and no
  out-of-scope observations.
Task 12: controller spot-checked the fix rather than taking the re-review on trust, because I ran that
  re-review on a cheap model. All three amendments are real and correctly voiced (spec:457-461, :431-437,
  :348), `grep` for "merge refused|leaves those files behind|is refused with 409" over the whole spec now
  returns nothing, and the §8 table row matches the real `GroupEditResponse` field-for-field
  (http/views.ts:235-241 — the docs table omits only `readonly`, which is right for a docs table).
Task 12: complete (trees 962a9319..dfaa7f34, review clean after one fix round — spec OK, quality Approved)
Task 12: the gate recorded above was controller-verified at dbb44b46, one prose-only fix round earlier than
  the final tree dfaa7f34. Prose cannot move lint/typecheck/test/build/e2e, so it stands; the final review
  package is built at dfaa7f34.

## ALL 12 TASKS COMPLETE — final whole-branch review next

Final review dispatched on the most capable model (per Model Selection: the final whole-branch review is an
architecture-tier task). Package: final-review-package.md, base 7ed6d21 → tree dfaa7f34, 34 files,
+4021/-392, ~6900 diff lines. Base is deliberately the spec+plan commit rather than the merge-base: 14bef62..
7ed6d21 adds only the two authority documents, so 7ed6d21..index is exactly all 12 tasks' implementation,
and the design doc is handed to the reviewer as binding authority to read rather than as a diff to review.
The dispatch carries the deferred-minor/parked list for triage, points at this ledger for the 21 rulings,
tells the reviewer the gate is already controller-verified so it does not re-run it, and names the four
cross-task questions no task-scoped review could answer (digest ↔ plan agreement, the §5 phase/failure model
and whether §5.2's retry converges, the F13 collision exemption's narrowness, and pick reconciliation across
a merge).

### Integration risk found while Task 12 ran — SURFACE TO OWNER, do not act on mid-run

The branch is based on `14bef62` and `main` has moved **37 commits** ahead of that base (the
performer-search-queue and reconcile-client-first runs). The branch itself carries ONE commit (7ed6d21,
spec + plan) plus 33 files of staged-uncommitted work, so this is not a stale-branch nuisance — it is an
integration step that has to happen before this work can land, and it cannot be rebased as-is, because a
rebase needs the work committed first and committing needs the owner's approval.

Files both sides changed (11 today, 12 once Task 12 lands), with main-side vs branch-side churn:

| File | main | this branch |
|---|---|---|
| packages/core/test/manual/operations.test.ts | +38 | +602 |
| packages/web/test/Picks.test.tsx | +1 | +276 |
| packages/core/test/http/manual.test.ts | +3 | +123 |
| packages/web/test/Browse.test.tsx | +1 | +118 |
| packages/web/src/api/client.ts | +2 | +108 |
| packages/core/src/http/server.ts | +32/-? | +54 |
| packages/core/src/http/views.ts | +3 | +20 |
| packages/e2e/src/harness.ts | +15 | +16/-1 |
| packages/core/test/http/server.test.ts | +56 | +1 |
| packages/core/src/main.ts | +70 | +1 |
| packages/core/test/http/metadata.test.ts | +3 | +1 |

`packages/e2e/src/harness.ts` is the likeliest genuine conflict: main rewrote ~15 lines of it, and Task 11
edited it too (the `KNOWN_SITES` seed), in a file Task 4's ledger note already identified as holding a fourth
`ServerDeps` construction site — which is exactly the kind of thing main's reconcile-client-first work would
have touched. `server.ts` and `operations.test.ts` are the next two.

`docs/known-issues.md` is NOT a conflict risk despite both sides touching it: main's only hunk there is at
~line 573, and Task 12 edits lines 380-411. Verified against main's copy, which still has `## Manual metadata`
at 380, the `#39` line at 410, and still no `issues/2)` bullet anywhere — so rulings F19 and the residue
observation below hold against main as well as against this branch.

Observation for the final review (NOT dispatched, out of Task 12's scope): line 410's
  `#39 is closed by this branch and should be marked closed on merge.` is now residue — #39 is CLOSED on
  GitHub, so that instruction was discharged by an earlier branch. Deliberately not folded into Task 12;
  it is pre-existing debt in a file Task 12 happens to touch, and quietly cleaning it would blur Task 12's
  reviewable diff.

## Final whole-branch review — verdict: With fixes (4 Important, 0 Critical, 9 Minor)

It confirmed the four cross-task properties I asked about, with evidence rather than assurance: phase 0's
re-plan through phase 1's transaction contains NO `await`, so in this single-threaded process nothing can change
the DB between the digest comparison and the writes — the gate is airtight in-process, a stronger property than
the spec claims; F13's exemption is strictly `trashedPaths`-keyed off the doomed rows' own `dest_path`s and
cannot exempt an unrelated or merely-nearby file; §5.2's retry genuinely converges (operations.test.ts:1076
re-plans to `kind: 'none'` and finishes the remaining rename); and `earnsListBump` is read pre-move against the
target's own pick with all three bump boundaries tested. It found no containment hole and no data-loss path.

Findings entering the ONE fix wave the skill allows:

- **Important 1 — the feature's own thesis fails in one case.** `useIdentityChange.ts:38-40`'s
  `needsConfirmation` ignores `plan.blockers`. A blocked plan with no file work (`renames: []`, `trashing: []`,
  `blockers: [1]`) takes the one-click path; the applier 409s on the blocker; `applyEdit` maps EVERY 409 to
  `stale: true` without calling `setError`; the hook re-plans, re-applies, and finally reports "the group kept
  changing underneath this edit. Try again." The blocker text never reaches the user and the reason given is
  false. The reviewer reproduced this end to end against the real planner and applier rather than reasoning
  about it. Fix is `|| plan.blockers.length > 0` plus two tests.
- **Important 2 — `identity-plan.ts:257,339` passes an UNRESOLVED library root to `isContained`**, unlike every
  other containment check in the codebase (`import.ts:138`, `operations.ts:378` both resolve first).
  `loadPlugins` accepts any non-empty string, so a configured root of `"/media/scenes/"` or a relative path
  makes every rename a false blocker and the whole feature refuses, blaming the library. Latent (documented
  examples have no trailing slash), one-line fix.
- **Important 3 — two in-code rationale comments still assert the removed refusal.** `db/metadata.ts:378-385`
  claims the foreign key "refuses the merge outright"; `db/groups.ts:617-622` says "Why the merge refuses on a
  source with history". Both false now. This is exactly Task 12's drift, left in `.ts` because Task 12 was
  scoped to `.md` — and it matters more than usual because F14 keeps `groupHistory` SPECIFICALLY on the strength
  of those two citations.
- **Important 4 — test gaps on paths this branch introduced.** Two of §4.3's three blocker branches are
  untested (`identity-plan.ts:335` not-a-regular-file, `:339` resolves-outside-root — and :339 is exactly where
  Important 2 lives, which is why nothing caught it). No web test covers the `failed` → "Saved, but N file(s)
  could not be moved" banner, which §5.1 requires and which is the only thing telling a user their library is
  in two layouts; it is duplicated in Browse and Picks and exercised in neither.

Ruling: F23 — I am including three of the nine Minors in the fix wave and deferring six. IN: Minor 13 (the
  discharged `#39 is closed by this branch` line, which the reviewer itself triaged "fix here" now that it sits
  directly above the new #2 line — two identical instructions in adjacent paragraphs defeats a convention whose
  whole job is to be read at merge time); Minor 8 (a stale digest silently replaces the plan in place, where §8
  says "and says why" — a spec gap, in the same function as Important 1); Minor 9 (`setBusy(false)` before the
  stale re-plan `await`, one line, same function again). OUT: 5, 6, 7, 10, 11, 12 — recorded below for the
  owner. Rationale: the skill allows exactly ONE fix wave and no second, so a Minor that is a one-line edit
  inside a function the wave already opens is cheaper now than as a follow-up, while a Minor needing its own
  judgment or its own test surface is not. Cost if wrong: three extra small edits in a wave that was happening
  anyway, and a slightly wider re-review scope.

Ruling: F24 — I am also folding in the reviewer's Recommendation 3: a §11 Known-risks bullet recording that
  `editGroup`'s phases 2 and 3 hold no lock while the scheduled import pipeline runs in the same process, so an
  upgrade import for the survivor group can interleave with a rename across those awaits. The reviewer traced
  the outcomes and the worst case is a failed rename reported in `failed` with the row still truthful — so this
  is a risk to record, not a defect to fix. Folded in because the wave is already amending docs and an
  unrecorded interleaving risk is the kind of thing that gets rediscovered as a bug report. Cost if wrong: one
  bullet in a Known-risks list.

Minors DEFERRED to the owner, not dispatched (final review's numbering):
  5. `identity-plan.ts:350` "occupied by something this group did not put there" is inaccurate when the occupant
     IS one of the group's own live files that this plan is not trashing — reachable in a merge where the
     target's pick is dangling. The refusal is right; the wording sends the operator hunting a stranger's file.
  6. `operations.ts:419-420` `trashed = rows.length` counts rows whose file was already gone, so the reported
     count can overstate what moved. The catch branch already reads `trashedAt` back; the success branch could.
  7. The planner does not pre-check DOOMED rows for the two conditions `trashFiles` throws on, so those surface
     as an apply-time abort plus `failed` entries rather than a shown blocker. No data loss (phase 3's occupant
     check holds). §4.3 arguably scopes its list to renames.
  10. The eight-line failure-message construction is duplicated in `Browse.tsx:129-137` and `Picks.tsx:109-117`.
  11. `useIdentityChange.ts:78-80` — unmounting with a dialog open drops `pending.resolve`, so MediaCard's save
     promise never settles.
  12. New tests leave ~20 `mkdtemp` directories behind per full run.

Reviewer's triage of the earlier deferred minors, accepted as recorded: T7's vanished-doomed-row test optional;
  F14 keep `groupHistory` BUT fix its citations (now Important 3); T7's double `resolveIdentityFor` accepted with
  the caveat that the applier writes the identity from its SECOND call while the digest matched the FIRST, so a
  nondeterministic plugin could apply an identity the plan never described — collapse it next time IdentityPlan
  changes; F17's `as unknown as typeof fetch` accepted (28 occurrences across 8 files already; a typed helper is
  its own change); T6's redundant assertion and T11's single e2e scenario both accepted.

### Final fix wave (the ONE the skill allows) — trees dfaa7f34..f7dbd238

Dispatched as a single agent with the complete findings list (Important 1-4, Minors 8/9/13, plus F24's risk
bullet), not one fixer per finding. Reported DONE, nothing committed, index verified `A`/`M` only.
Diff is 12 files, +314/-28, and its scope matches the findings exactly:
  docs/known-issues.md -2 (the discharged #39 line, Minor 13)
  2026-08-07 spec +7 (F24's §11 no-lock interleaving risk bullet)
  db/groups.ts +14/-, db/metadata.ts +16/- (Important 3, the two false rationale comments)
  manual/identity-plan.ts +11 (Important 2, the resolved library root)
  test/manual/identity-plan.test.ts +73 (Important 4, the two untested §4.3 blocker branches)
  web/src/api/useIdentityChange.ts +58, components/IdentityChangeConfirm.tsx +22,
    routes/Browse.tsx +1, routes/Picks.tsx +1 (Important 1, Minors 8 and 9)
  web/test/Picks.test.tsx +89, web/test/useIdentityChange.test.tsx +48 (Important 1 and 4's web tests)
The implementer chose Picks over Browse for the `failed`-banner test, which it was permitted to do provided it
said which — it did.
Implementer-reported gate: lint 0, typecheck 0, test:server 878 pass (was 876), test:web 186 pass (was 182),
build 0, e2e 15 passed. The +2/+4 split is consistent with the tests the diff actually adds.
Scoped re-review dispatched (exactly one, per the skill — there is no second fix wave). Its dispatch names the
deferred six explicitly as NOT gaps, so the re-reviewer cannot re-open them, and it is told the single most
valuable check is whether each new test would actually FAIL against the old code — especially Important 4's
`:339` test, which must be one that would have caught Important 2.
Controller-verified gate at the final tree f7dbd238 — lint exit 0, typecheck exit 0, test:server 878 pass /
  0 fail, test:web 186 pass / 0 fail, build exit 0, e2e exit 0 with 15 passed. Independently reproduces the
  implementer's claimed counts exactly. This is the tree the owner will act on, so the numbers are mine, not
  merely reported.

Fix-wave re-review: **all findings addressed, no new Critical/Important breakage.** It did the check that
mattered rather than reading for plausibility — it reverted the `resolve()` call and re-ran the suite, watched
the new outside-the-root test fail exactly as predicted (2 blockers instead of 1, the in-root file wrongly
blocked), then pass again once restored. So Important 4's `:339` test is a genuine regression test for
Important 2, not coverage theatre. It also substantiated F24's risk bullet against `main.ts:159,318-320`
(one Scheduler started in the same process as the HTTP server that serves `editGroup`) rather than taking the
claim on trust, and confirmed the widened `needsConfirmation` cannot spuriously demand confirmation.

Task note — the re-review report OMITTED a verdict for Important 1, the most consequential finding of the
  eight. Rather than spend a round-trip on a formality I verified it myself, with better evidence than a
  restated verdict would have carried: `useIdentityChange.ts:56` now has the `plan.blockers.length > 0` clause
  with a why-comment naming the exact bug; `useIdentityChange.test.tsx:152` pins that a blocked plan with no
  renames or trashing still requires confirmation; and `Picks.test.tsx:758` asserts the blocker text reaches
  the user, that Confirm is disabled, and that `stub.patched.length === 0` — that last assertion is one the
  old code would have failed outright, since it PATCHed. Important 1 is ADDRESSED. The omission was in the
  report, not in the work.

Ruling: F25 — I am NOT deleting this workspace, though the skill's Finish step says to. That instruction is
  premised on "the git history is the record now", and here it is not: nothing on this branch is committed, so
  the git history contains only the spec and the plan. This ledger is the ONLY record of 25 rulings, of the
  incident during Task 9, of the deferred minors, and of the per-task tree snapshots this run substituted for
  commits. Deleting it before the owner has approved a commit would destroy the entire decision record of the
  run and every per-task review boundary with it. The workspace comes down once the work is committed, not
  before. Cost if wrong: a git-ignored scratch directory survives longer than the skill intends.

## RUN COMPLETE — all 12 tasks, final review, one fix wave, one scoped re-review.

## Owner decisions received (2026-08-17)

Owner chose: commit, then rebase onto main. Issue #2 stays OPEN until the work actually merges, since the
docs line says "on merge". Committing was explicitly approved; pushing was NOT, and nothing has been pushed.

Feature commit, as first written: 35 files, +4336/-414, SSH-signed, verified `%G?` = G. It is **6bc0ff9** now,
after two rebases and one amend; it was `e44daee` at this point, which survives only as the target of the tag
below. One commit rather than twelve reconstructed from the tree snapshots: rebasing one commit over 37 is a
single conflict resolution where twelve would be twelve, and the per-task boundaries are preserved in this
ledger and in the briefs/reports either way.
Safety tag before the rebase: `pre-rebase-edit-picked-files-2026-08-17`, at the dead `e44daee`.

Rebased onto main (486b501). Textually CLEAN — zero conflicts, despite 12 files touched on both sides. Verified
that this was legitimate rather than lucky for the file I flagged as likeliest to conflict: main's harness change
is confined to `createFakeClient` (a new `category` parameter and `complete: true`), while Task 11's is
`KNOWN_SITES` at :44 and the plugins config at :217 — genuinely disjoint regions. This first rebase produced
`27375bb` (spec+plan) then `18c351f` (the feature); both are dead ids, superseded by the second rebase below.
`27375bb` is still reachable through `pre-rebase2-edit-picked-files-2026-08-17`; `18c351f` is reachable from
no ref at all, because the amend below replaced it.

**A clean rebase was NOT a correct one — the gate caught a semantic conflict types-only.** `npm run typecheck`
exited 1: `tests/identity-change.spec.ts(54,7): error TS2741: Property 'category' is missing in type ... but
required in type 'ClientHistoryEntry'`. Main's reconcile-client-first work added a required `category` to
`ClientHistoryEntry` and a required `complete` to `ClientSnapshot`; Task 11's new e2e spec was written before
those existed. Note what did NOT catch it: lint 0, build 0, **e2e 15/15 green**, server and web suites green.
The e2e run passes because tsx erases types at runtime, so only typecheck could ever have seen this. Fixed by
supplying both fields exactly as main's own `retry.spec.ts:59-72` does (`category: null`, `complete: true`) —
`null` rather than the harness's real `'pickarr-e2e'` category, because the spec has been passing with the field
absent and matching main's precedent keeps this a type repair rather than a silent behaviour change to a
green test. TypeScript reported only the nested `category` mismatch, not the outer missing `complete`; both were
fixed and typecheck re-run to zero errors rather than trusting the single reported error to be the whole set.

Post-rebase test counts rise as expected from main's own work, not from anything of ours: server 878 -> 977,
web 186 -> 189.

Full gate GREEN on the rebased tree, controller-run: lint 0, typecheck 0, test:server 977 pass / 0 fail,
test:web 189 pass / 0 fail, build 0, e2e 15 passed.

The type repair was folded into the feature commit with `--amend` rather than added as a follow-up commit,
because leaving it separate would leave the feature commit (`18c351f` at the time) as a commit that does not
typecheck — breaking `git bisect` and any per-commit CI. Nothing had been pushed, so the amend is safe. The
amend produced `3e890b9`, itself since rebased to the live **6bc0ff9**; SSH-signed, `%G?` = G, working tree
clean.

Superseding F25: this repo's own convention is to COMMIT the SDD record to `claudedocs/<plan-name>/` —
precedent at 0d9cc64 ("Keep the performer-search-queue SDD record": the ledger, the task briefs and their
implementer reports, and the final fix report; review diffs left out because git regenerates them from the
commit range) and 486b501, which explicitly records that relying on the gitignored workspace surviving
"stopped holding when that workspace was committed to claudedocs/...". So the durable answer to F25's concern
is not "leave the scratch directory alone", it is "commit the record" — which is what the repo already does
and what makes the 25 rulings and the deferred-findings backlog survive this worktree.

## Second rebase — main moved again mid-session

While the record was being prepared, `main` advanced one commit to 03cf4db, "Detach a release group attached
with the name's own separator" — a PARSER change (`dottedGroupRun` as the counterpart to `hyphenGroupRun`, so a
dot-attached multi-token release group detaches too). That mattered more than an ordinary one-commit drift,
because Task 11's e2e spec asserts the exact rendered library paths for two literal release names, so a parser
change is exactly the kind of thing that could invalidate them. Rebased onto it (safety tag
`pre-rebase2-edit-picked-files-2026-08-17` first) and re-ran the FULL gate rather than assuming the fixtures
were unaffected: both fixtures attach their group with a hyphen (`MP4-WRB`), so the widened dotted rule does
not reach them.

Gate GREEN on the twice-rebased tree: lint 0, typecheck 0, test:server 986 pass / 0 fail, test:web 189 pass /
0 fail, build 0, e2e 15 passed. Server rose 977 -> 986 purely from main's own new parser tests.

### Commit ids in this file, and why they are the ones they are

Two rebases and two amends rewrote every SHA this run produced. This is the same trap main's own 486b501 was
written to fix ("Point the handoff doc's commit ids at commits that still exist"), so every id elsewhere in
this file is a LIVE one, and the dead ids are collected here with what — if anything — still reaches them.

Live:

  base main:   03cf4db  Detach a release group attached with the name's own separator
  spec + plan: 7ed6d21  Design editing the identity of a group already downloaded
  feature:     6bc0ff9  Edit the identity of a downloaded group behind a plan you confirm
  SDD record:  the tip commit that adds claudedocs/2026-08-16-editing-downloaded-identity/ — deliberately not
               cited by SHA, because this file is inside it and cannot name its own commit.

Dead, with what still reaches each (verified with `git merge-base --is-ancestor` against both tags, not
assumed):

  7fea1b3  spec + plan, pre-rebase        → tag pre-rebase-edit-picked-files-2026-08-17
  e44daee  feature, as first committed    → tag pre-rebase-edit-picked-files-2026-08-17
  27375bb  spec + plan, after rebase 1    → tag pre-rebase2-edit-picked-files-2026-08-17
  3e890b9  feature, after the type-fix amend → tag pre-rebase2-edit-picked-files-2026-08-17
  533fdc6  SDD record, after rebase 1     → tag pre-rebase2-edit-picked-files-2026-08-17
  18c351f  feature, after rebase 1        → NOTHING. The amend replaced it; no ref reaches it.
  cb1585c  SDD record, after rebase 2     → NOTHING. The amend replaced it; no ref reaches it.

The last two are reflog-only and will vanish at the next `git gc`. Nothing depends on them — each was
superseded by an amend seconds later — and they are listed so a reader who finds one of these ids in an older
note knows it is gone rather than hunting for it.

Both safety tags should be deleted once this work lands; until then they are the only thing keeping the five
reachable dead commits alive.

The PER-TASK tree snapshots recorded throughout this file are unaffected by both rebases — they are tree
objects, not commits, so they still describe exactly the content each task produced. What they no longer
correspond to is any commit on this branch, since the twelve tasks landed as one commit.

## The deferred findings are now tracked issues (2026-08-17, owner-requested)

The eight deferred items were grouped by area and filed, and each is linked from
`docs/known-issues.md` under the section it belongs to, per that file's own convention that a bulleted link is
tracked work and a paragraph is settled reasoning:

  #58  A typed fetch-stub helper would retire 28 uses of `as unknown as typeof fetch`   (was ruling F17)
  #59  An identity change reports two things imprecisely: blocker wording, trashed count (was minors 5 + 6)
  #60  Trashing failures surface at apply time instead of as blockers, and the
       vanished-row branch is untested                        (was minor 7 + a Task 7 deferred minor)
  #61  Identity-change UI: failure message built twice; unmount hangs the card's save   (was minors 10 + 11)
  #62  `resolveIdentityFor` runs twice, so the applied identity comes from a different
       call than the digest matched                                  (was a Task 7 deferred minor)
  #63  Tests leave their `mkdtemp` directories behind                (was minor 12 + a Task 7 minor)

Grouping rationale: 5+6 are both "the sentence or the number is not what happened"; 10+11 are both in the
Browse/Picks + `useIdentityChange` seam; minor 7 and Task 7's untested vanished-row branch are both phase-2
trashing failure paths closed by the same test technique. F17 and minor 12 stayed separate because one is a
type-system question across 8 files and the other is temp-directory cleanup — adjacent only in that both live
in tests.

Two review findings are NOT filed, deliberately: Task 6's redundant `assert.ok(!plan.renames.some(...))` line
(redundant with the `deepEqual` above it but it names the invariant, and the review accepted it) and Task 11's
single 158-line e2e scenario (refactoring for a second scenario that does not exist yet is speculative, and
the seam is already commented). Filing either would be filing a preference as a defect.

Note that ruling F14's open question — whether `groupHistory` should now be deleted, having no production
caller — is deliberately NOT an issue either. Its two citing comments were repaired by the final fix wave, so
the code is coherent as it stands; deleting it is a judgment call for the owner, not tracked work.

## HANDOFF STATE

Four commits on `fix/edit-picked-files` above 03cf4db, all SSH-signed, working tree clean. Pushed to
`origin/fix/edit-picked-files` and opened as **PR #64** against `main` on owner approval (2026-08-17), with
`Closes #2` in the body — verified linked via `gh pr view --json closingIssuesReferences`, so #2 closes on
merge and the `#2 is closed by this branch and should be marked closed on merge.` line this run added to
`docs/known-issues.md` is discharged automatically rather than by hand.

Issue #2 therefore stays OPEN until the merge, which is what the owner chose and what that docs line says.

Still outstanding for the owner:
  - Merging the PR (CI runs three jobs: lint/typecheck/unit, browser tests, container image).
  - Deleting the two safety tags, `pre-rebase-edit-picked-files-2026-08-17` and
    `pre-rebase2-edit-picked-files-2026-08-17`, once the merge lands. They are local-only — never pushed — and
    they are the sole thing keeping five dead pre-rebase commits reachable.
  - Ruling F14's open question: whether `groupHistory` should be deleted now that nothing calls it. Raised in
    the PR body as a note for the reviewer rather than filed as an issue, because the code is coherent as it
    stands and removal is a judgment call.
  - Ruling F17's question, now filed as #58: whether a typed fetch-stub helper should retire the 28
    `as unknown as typeof fetch` casts so the no-`unknown` constraint holds literally.
