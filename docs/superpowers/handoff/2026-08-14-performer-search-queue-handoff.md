# Handoff — performer search queue, mid-SDD

Written 2026-08-14, suspending an in-progress subagent-driven-development run so it can
continue on another machine.

**This file exists because the SDD workspace is gitignored.** `.gitignore:15` ignores
`.superpowers/`, so the ledger, briefs and reports that the run depends on do not travel
with a push. Everything load-bearing from that workspace is reproduced here, and this file
is committed. When you resume, the workspace can be rebuilt from this file plus the
committed plan — see "How to resume" below.

> **Update, 2026-08-16: the run resumed, completed, and landed on `main`. Read the rest of
> this file as a historical record, not as instructions.**
>
> The "How to resume" section below is spent — Task 2 was picked up from it and tasks 2-7
> then ran to completion, so following it now would re-do finished work.
>
> **Every commit id in this file has been rewritten.** The branch was rebased twice before
> landing: once onto `14bef62`, and again onto `85639d2` after `main` moved 14 commits
> during the run. Both rewrites changed every SHA, and the originals are now unreachable.
> The ids throughout this file — including inside the reproduced ledger and report blocks —
> have been updated to the commits that actually exist on `main`, so they resolve. Nothing
> else in those blocks was touched; only the ids differ from what was written on 2026-08-14.
> `f8242f8` is left as-is: it was `main`'s tip at the time and is still reachable through
> `main`'s own history.
>
> One of those rebases collided on a migration number — `main` took `version: 8` for
> `downloads.absent_since` while this branch had it for `performer_queue`, so the queue
> table ships as `version: 9`. Any statement below about migration 8 refers to the original
> plan, not to what shipped.
>
> **The full record is committed and is better than this reproduction.** See
> `claudedocs/2026-08-14-performer-search-queue/` for the complete ledger — every ruling
> taken during the run with what it costs if wrong, the whole-branch review's triage of 20
> deferred findings, and all seven task briefs and implementer reports. This file reproduces
> only the fraction that existed when the run was suspended.

---

## Where things stand

Branch `feature/performer-search-queue`, worktree
`worktrees/performer-search-queue` (bare-repo + worktrees layout).

| Commit | What |
|---|---|
| `339a206` | Design spec |
| `d9d76dc` | Implementation plan (7 tasks) |
| `46cad3a` | Plan corrections — pre-flight findings A–D |
| `bf6c17a` | Plan fix — unterminated code fence (finding E) |
| `ddc97a1` | **Task 1 complete** — plugin `performerQuery` seam |

**Task 1 of 7 is done and its review is clean. Tasks 2–7 have not been started.**

Working tree was clean at suspend. Nothing is in flight — no subagent is running, and the
Task 2 implementer was **never dispatched** (see the correction note in the ledger below;
an earlier ledger line wrongly said it had been, written in the same message that was
interrupted before the dispatch happened).

Test state at `ddc97a1`: **819 core / 165 web, all green** (813 core baseline + 6 new).
`npm run build` also succeeded on the branch's earlier commits.

- Spec: `docs/superpowers/specs/2026-08-14-performer-search-queue-design.md`
- Plan: `docs/superpowers/plans/2026-08-14-performer-search-queue.md`

---

## How to resume

1. Get onto the branch in a worktree. In this bare-repo + worktrees project that means
   invoking the `add-worktree` skill with `feature/performer-search-queue`, or if the
   worktree already exists, `cd` into it. `git pull` first — `origin/feature/performer-search-queue`
   is authoritative now.
2. Confirm the baseline before trusting anything below:
   ```
   export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
   npm ci && npm run check
   ```
   Expect 819 core / 165 web green. If it differs, stop and work out why before dispatching
   anything — a plan executed against an unexplained baseline produces reviews nobody can
   trust.
3. Invoke `superpowers:subagent-driven-development` and rebuild the workspace:
   ```
   S="$HOME/.claude/plugins/cache/claude-plugins-official/superpowers/<ver>/skills/subagent-driven-development"
   "$S/scripts/sdd-workspace" docs/superpowers/plans/2026-08-14-performer-search-queue.md
   ```
   Copy the "Ledger contents" section below into `<workspace>/progress.md` verbatim, keeping
   its first line intact — the skill identifies a ledger by that line naming the plan file.
4. Re-extract the briefs. They are pure derivations of the committed plan, which is why they
   were not committed:
   ```
   for n in 1 2 3 4 5 6 7; do "$S/scripts/task-brief" docs/superpowers/plans/2026-08-14-performer-search-queue.md $n; done
   ```
   **Sanity-check the extraction:** `grep -c "Wire it into the running process" <workspace>/task-6-brief.md`
   must print `0`. If it prints `1`, a code fence in the plan has come unbalanced again and
   Task 6's brief is swallowing Task 7 — see finding E.
5. **Resume at Task 2.** BASE for its review package is `ddc97a1`. Do not re-dispatch Task 1;
   its commit is in git and its review was clean.

---

## Rulings made so far

Six, all pre-flight — decisions taken on the user's behalf while scanning the plan for
conflicts. Each is a defect in my own plan that I corrected rather than stopping to ask
about. Review them; rework anything I got wrong.

1. **Finding A — task independence claim was wrong.** Task 4 imports `PerformerSearchResult`
   from Task 3's module, in both its implementation and its test, so "Tasks 1–4 are
   independent" was false. Ruled: execute in strict numeric order 1→7, and correct the plan.
   Chose ordering over relocating the type, because the type belongs with the client that
   produces it. *Cost if wrong: none — strict order is a superset of the real constraint
   graph, and it only forgoes parallelism that SDD forbids for implementers anyway.*
2. **Finding B — double clock read.** Task 6's `deferOrGiveUp` called `deps.now()` again to
   compute `next_at`, after the pass had already captured `now`. Ruled: take `nextAt` as a
   parameter, matching `metadata.ts`'s own `deferOrGiveUp` signature. *Cost if wrong:
   negligible — a few milliseconds in one timestamp; the signature match is the real point.*
3. **Finding C1 — invented test helper.** Task 3's tests called a `jsonResponse(...)` that
   does not exist. Ruled: use the real `respondWith(body, init?)` at
   `packages/core/test/clients/theporndb.test.ts:39`. *Cost if wrong: the implementer would
   have written a duplicate fetch helper — a review finding, not a shipped defect.*
4. **Finding C2 — cast through `unknown`.** Task 5's plugin fixture used
   `as unknown as MediaTypePlugin`. Ruled: build the real minimal shape
   (`{id, displayName, parse, score, planImport}`, as `metadata.test.ts:577` does). The
   plan's own constraints forbid `any` and treat `unknown` as a shortcut to avoid, and a
   test fixture is not an exemption. *Cost if wrong: none — if `MediaTypePlugin` gains a
   required member the fixture stops compiling, which is the signal you want.*
5. **Finding D — configs that would not compile.** Every inline `{baseUrl, apiKey}` in Task
   3's test sketches omitted `type: 'theporndb'`, which `SiteLookupConfig` requires. Ruled:
   use the test file's existing `CONFIG` and `API_KEY`. *Cost if wrong: none — a straight
   correction of a wrong fixture.*
6. **Finding E — unterminated code fence.** Task 6's test block opened a ```` ```ts ````
   fence and never closed it. `scripts/task-brief` tracks fences to find task boundaries, so
   Task 6's brief ran on through Task 7 and the controller notes, and Task 7 could not be
   extracted at all. Ruled: close the fence, re-extract, verify by grep. *Cost if wrong:
   none — a markdown repair, verified by re-extraction.*

A seventh, procedural: **the corrections were applied to the plan document and committed**
rather than carried as dispatch prose, because briefs are extracted from the plan and an
implementer is told the brief is authoritative. A correction living only in my dispatch
message would be one the brief contradicts. *Cost if wrong: two extra doc commits.*

---

## Deferred minor findings

These do not block anything and never entered the fix loop. The final whole-branch review
must be pointed at them so it can triage what to fix before merge.

- **Task 1 — `.trim()` is unpinned.** In `packages/plugin-scenes/src/performer-query.ts`,
  `.trim()` is functionally redundant: `.split(/\s+/)` followed by
  `.filter((word) => word.length > 0)` already discards leading and trailing empties.
  Deleting `.trim()` would still pass all six tests, so that piece is unverified. Inherited
  from the brief's verbatim code, not an implementer error.
- **Task 1 — imprecise citation.** The `WORDS` comment (and its mirror in the test file)
  says `resolve-sites.ts` documents `Free.Use.Fantasy`. That file actually discusses the
  query `Free Use` finding the site `Freeuse Fantasy`, and separately reasons that a
  one-word retry would confirm the real-but-wrong site `Free`. The argument is sound; the
  literal citation is an extrapolation. Also inherited from the brief.

---

## What remains, and the traps in it

Tasks 2–7. Read the plan for the real detail; this is only what a resuming controller
should know before dispatching.

- **Task 2 — queue table + `clearGroupMetadata`.** The load-bearing part is §4.1 of the
  spec: `performer_queue` references `media_groups` with **no cascade**, which is exactly
  the trap `docs/known-issues.md` records shipping twice — a merge's `deleteGroup` returning
  a foreign-key 500 for a group holding an invisible queue row. The delete belongs *inside*
  `clearGroupMetadata`, not at its call sites. Its regression test is only meaningful because
  `openTestDatabase` really does set `PRAGMA foreign_keys = ON` (verified at
  `packages/core/src/db/open.ts:12`). Also: use migration `version: 8` and check first that
  nothing else has taken 8 — that file carries two long comments about branches colliding on
  a migration number, twice.
- **Task 3 — the client method.** Endpoint and response shape were supplied by the repo
  owner and are in the spec. The subtle part: `kind` comes from `is_parent`, and
  `readPerformers` must **not** be reused, because it derives `kind` from a nested `parent`
  that a top-level `/performers` result does not have — it *is* the parent. Reusing it would
  label every auto-linked performer `performer-site` and point them all at alias pages,
  invisibly until someone clicks one.
- **Task 4 — the match rule.** Pure function, own file, heaviest test coverage in the plan.
  Tiered: exact `name` match, then exact `aliases[]` match, nothing on doubt. A tie at the
  name tier must **not** fall through to aliases.
- **Task 5 — the enqueue.** One call site in `runMetadataPass`, gated on
  `outcome.kind !== 'deferred'`.
- **Task 6 — the drain.** The cast-emptiness re-check inside the writing transaction is the
  guard that stops a late one-name guess replacing a confirmed cast, since
  `setGroupPerformers` deletes before it inserts.
- **Task 7 — wiring.** Both passes share the existing metadata tick; scenes first, awaited
  in sequence, no new config knob.

Every task in the plan ends with a mandatory mutation step — break the source, confirm the
named test fails, restore, report the evidence. Do not let an implementer skip it; three of
these tests can pass against broken code without it.

**Expect this feature to link almost nothing at first.** That is designed, not a bug to fix
mid-plan: two words of a scene title are a guess, and the tiered rule exists so a wrong
guess writes nothing. Spec §12 lists the follow-ups in cost order.

---

## Ledger contents

Copy everything below the line into `<workspace>/progress.md`, keeping the first line
exactly as-is.

<!-- BEGIN LEDGER -->
```
# SDD ledger — plan: docs/superpowers/plans/2026-08-14-performer-search-queue.md

Spec: docs/superpowers/specs/2026-08-14-performer-search-queue-design.md (read, reachable)
Worktree: <rebuild on the new machine>
Branch: feature/performer-search-queue
Branch start (merge-base with main): f8242f8
Plan committed: d9d76dc · Spec committed: 339a206
Plan corrections committed: 46cad3a (pre-flight rulings A–D), bf6c17a (ruling E)

## Pre-flight conflict scan

Interface pairs checked (producer → consumer), all agreeing except where noted:
  T1 performerQuery? → T5 performerQueryFor: agrees
  T1 scenePerformerQuery → plugin index only, not consumed by core: agrees
  T2 insertPerformerSearch → T5 enqueuePerformerSearch: agrees
  T2 duePerformerQueue/deferPerformerSearch/removePerformerSearch/groupHasCast → T6: agrees
  T2 PerformerQueueRow → T6 deferOrGiveUp: agrees
  T3 PerformerSearchResult → T4 pickPerformer: FINDING A (T4 depends on T3)
  T3 PerformerSearchPage → T6 pass and test: agrees
  T3 PerformerLookupClient → T6 deps, T7 client type: agrees
  T4 pickPerformer → T6 (called as pickPerformer(query, page.results)): agrees
  T5 PerformerEnqueueDeps/performerQueryFor → T6 PerformerPassDeps extends: agrees
  T6 createPerformerRunner → T7 main.ts: agrees

Shared files checked:
  src/pipeline/performers.ts — T5 creates, T6 appends; ordered: agrees
  src/pipeline/metadata.ts — T5 call site, T6 export backoffFor; disjoint: agrees
  test/pipeline/metadata.test.ts — T5 only: agrees
  src/db/performer-queue.ts — T2 creates, T5/T6 consume: agrees
  src/clients/theporndb.ts — T3 only: agrees
  src/main.ts — T7 only: agrees

Per-task self-consistency:
  T1 — punctuation/collapse tests vs whitespace-only split: agrees
  T2 — FK lifecycle test needs PRAGMA foreign_keys = ON: VERIFIED ON at src/db/open.ts:12
  T3 — invented jsonResponse helper, inline config missing `type`: FINDINGS C1, D
  T4 — mutation steps map to real branches: agrees
  T5 — pluginWith cast through unknown: FINDING C2
  T6 — deferOrGiveUp re-read deps.now() for nextAt: FINDING B
  T6 — unterminated ```ts fence broke brief extraction: FINDING E
  T7 — copies arg list from the live call site: agrees

## Rulings (pre-flight)

Ruling: FINDING A — Task 4 is NOT independent of Task 3; its impl and test both import
PerformerSearchResult from clients/theporndb.ts. Execute in strict numeric order 1→7 and
correct the plan's independence claim. Chose ordering over moving the type because the type
belongs with the client that produces it. Cost if wrong: none — strict order is a superset
of the real constraint graph.

Ruling: FINDING B — deferOrGiveUp takes nextAt as a parameter computed from the pass's
captured now, matching metadata.ts's own signature, instead of calling deps.now() twice.
Cost if wrong: negligible — a few ms in one timestamp.

Ruling: FINDING C1 — Task 3's tests use the existing respondWith(body, init?) helper
(test/clients/theporndb.test.ts:39), not the invented jsonResponse. Cost if wrong: a
duplicate fetch helper, a review finding rather than a shipped defect.

Ruling: FINDING C2 — pluginWith builds a real minimal MediaTypePlugin
({id, displayName, parse, score, planImport}, as metadata.test.ts:577 does) rather than
double-casting through unknown. Cost if wrong: none — a missing required member then fails
to typecheck, which is correct.

Ruling: FINDING D — Task 3's tests use the file's existing CONFIG / API_KEY constants;
SiteLookupConfig requires type: 'theporndb', which every inline config in the sketches
omitted and which would not have compiled. Cost if wrong: none.

Ruling: FINDING E — Task 6's test block was missing its closing fence, so task-brief folded
Task 7 and the controller notes into Task 6's brief and could not extract Task 7 at all.
Fixed the fence, re-extracted, verified task-6-brief no longer contains Task 7's heading.
Cost if wrong: none — a markdown repair verified by re-extraction.

Ruling: the four plan corrections were applied to the plan file and committed before Task 1
dispatched, rather than carried as dispatch prose, because briefs are extracted from the
plan and the implementer is told the brief is authoritative. Cost if wrong: one extra doc
commit.

## Progress

Task 1: dispatched (implementer, sonnet) — BASE 46cad3a
Task 1: implementer DONE — commit ddc97a1 — 819 core (+6) / 165 web green; mutation
  WORDS 2→1 broke the named test (6 tests, 1 pass, 5 fail), restored to green
Task 1: task reviewer dispatched (sonnet) — package review-bf6c17a..ddc97a1.diff
Task 1: review clean — Spec ✅, quality Approved
Task 1: minor (deferred): .trim() in scenePerformerQuery is redundant given
  split(/\s+/)+filter, and no test pins it — deleting it would still pass all 6 tests.
  Inherited from the brief's verbatim code.
Task 1: minor (deferred): the WORDS comment cites Free.Use.Fantasy as appearing in
  resolve-sites.ts; that file actually discusses "Free Use" → "Freeuse Fantasy" and the
  one-word retry confirming "Free". Argument sound, literal citation is not. Mirrored in
  the test file comment.
Task 1: complete (commits bf6c17a..ddc97a1, review clean)

Task 2: NOT dispatched. An earlier ledger line claiming it was dispatched was written in
the same message that was interrupted, before the Agent call was ever made. No Task 2
implementer exists, no Task 2 work is in flight, no Task 2 commit exists. Resume here.
BASE for Task 2 when dispatched: ddc97a1.

Session suspended at the user's request to continue on another machine.
```
<!-- END LEDGER -->

---

## Task 1 implementer report, preserved

The briefs and the review diff are regenerable (from the plan, and from git). This report is
not — it holds the only record of the test and mutation evidence behind Task 1's approval.

<!-- BEGIN TASK 1 REPORT -->
```
Status: DONE

What changed:
1. packages/plugin-api/src/types.ts — added performerQuery?(identity: GroupIdentity):
   string | null to MediaTypePlugin, between metadataQuery and confirmMetadata, doc comment
   verbatim from the brief. GroupIdentity was already exported; no redefinition.
2. packages/plugin-scenes/src/performer-query.ts (new) — exports scenePerformerQuery, which
   trims display.title, splits on whitespace runs, drops empty tokens, returns the first two
   words joined by a space, or null if fewer than two remain. Verbatim from the brief,
   including WORDS = 2 and its comments.
3. packages/plugin-scenes/src/index.ts — added the import and
   performerQuery: (group) => scenePerformerQuery(group) directly after metadataQuery.
4. packages/plugin-scenes/test/performer-query.test.ts (new) — the 6 specified tests,
   verbatim.

No stripping logic added: display.title from buildRelease is already site-, date- and
quality-suffix-stripped.

Tests:
- Baseline before any change: npm run check exit 0, core 813/813, web 165/165 — matches the
  stated baseline exactly.
- New test file before implementation: ERR_MODULE_NOT_FOUND for src/performer-query.ts, as
  expected (1 test, 0 pass, 1 fail).
- New test file after implementation: 6 tests, 6 pass, 0 fail.
- Full check after implementation: exit 0, core 819/819 (813 + 6), web 165/165 unchanged.
  oxlint reported only pre-existing preserve-caught-error warnings in files this task did
  not touch (theporndb.ts, upgrade.ts, import.ts, registry.ts, load.ts).

Mutation evidence: changed WORDS from 2 to 1 → 6 tests, 1 pass, 5 fail. The brief's named
test failed as intended ("a one-word title yields nothing rather than a one-word query":
scenePerformerQuery(identity('Solo')) returned 'Solo' instead of null). Four others also
failed as expected side effects. Only "an empty or whitespace title yields nothing"
survived, since a title with zero words is unaffected by WORDS. Restored WORDS = 2 →
6/6 green, and full npm run check back to 819/165, confirming no residue.

Commit: ddc97a1, 4 files, 100 insertions. Not pushed.

Concerns about the brief: none. GroupIdentity already exported as described; the
types.ts doc register matched; the index.ts object literal matched the described
surrounding lines, so insertion was mechanical.
```
<!-- END TASK 1 REPORT -->

---

## Task 1 review verdict, preserved

Spec compliance **✅** — implements exactly the brief, nothing missing, nothing extra. No
queue, client, matching or linking code anywhere in the diff; only the four named files
changed; no `any`/`unknown`; correct `import type` for `verbatimModuleSyntax`; `.ts`
extensions throughout; one commit, clean tree, nothing pushed.

Task quality **Approved** — no Critical or Important findings. The two Minor findings are
listed under "Deferred minor findings" above. The reviewer independently traced `WORDS=1`
against all six assertions and confirmed the reported 1-pass/5-fail split, including which
test survives and why.

On file organisation, the reviewer judged a dedicated 34-line module reasonable: `score.ts`
is a comparable 51-line single-concern module in the same directory, and `performer-query`
shares no logic with `metadata.ts`'s `sceneMetadataQuery`/`confirmSceneMetadata`, so folding
it in would be co-location without cohesion.
