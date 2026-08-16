# SDD ledger — plan: docs/superpowers/plans/2026-08-14-performer-search-queue.md

Spec: docs/superpowers/specs/2026-08-14-performer-search-queue-design.md (read, reachable)
Worktree: /home/chad/Projects/pickarr/worktrees/performer-search-queue (resumed here 2026-08-16;
  the macOS path above was the suspending machine's)
Branch: feature/performer-search-queue
Branch start (merge-base with main): f8242f8
Plan committed: 1f75efb · Spec committed: 1f2bcce

## Pre-flight conflict scan

### Interface pairs (producer → consumer)

| Producer | Consumer | Produces vs consumes | Finding |
|---|---|---|---|
| T1 `performerQuery?(GroupIdentity): string \| null` | T5 `performerQueryFor` | calls `plugin.performerQuery({identityKey, display})` | agrees |
| T1 `scenePerformerQuery` | T1 plugin index only | not consumed by core | agrees |
| T2 `insertPerformerSearch(db,id,now): boolean` | T5 `enqueuePerformerSearch` | returns its result directly | agrees |
| T2 `duePerformerQueue/deferPerformerSearch/removePerformerSearch/groupHasCast` | T6 pass | all four called | agrees |
| T2 `PerformerQueueRow` | T6 `deferOrGiveUp(deps, row, msg)` | row type matches | agrees |
| T3 `PerformerSearchResult` | **T4 `pickPerformer`** | T4's impl AND test import the type from T3's module | **FINDING A** |
| T3 `PerformerSearchPage` | T6 pass + T6 test | `page.results`, `page.truncated` | agrees |
| T3 `PerformerLookupClient` | T6 deps, T7 client type | same name both sides | agrees |
| T4 `pickPerformer(query, results)` | T6 | called as `pickPerformer(query, page.results)` | agrees |
| T5 `PerformerEnqueueDeps`/`performerQueryFor` | T6 `PerformerPassDeps extends` | extension declared in T6 Interfaces | agrees |
| T6 `createPerformerRunner` | T7 main.ts | same name | agrees |

### Shared files

| File | Tasks | Finding |
|---|---|---|
| `src/pipeline/performers.ts` | T5 creates, T6 appends | ordered T5→T6 in plan; agrees |
| `src/pipeline/metadata.ts` | T5 (call site), T6 (`export backoffFor`) | disjoint edits, sequential; agrees |
| `test/pipeline/metadata.test.ts` | T5 only | agrees |
| `src/db/performer-queue.ts` | T2 creates; T5/T6 consume | agrees |
| `src/clients/theporndb.ts` | T3 only | agrees |
| `src/main.ts` | T7 only | agrees |

### Per-task self-consistency

| Task | Tests vs code it specifies | Finding |
|---|---|---|
| T1 | punctuation-preserved test vs whitespace-only split; collapse test vs `split(/\s+/)+filter` | agrees |
| T2 | FK lifecycle test needs `PRAGMA foreign_keys = ON` — **verified ON** at `src/db/open.ts:12` | agrees |
| T3 | tests call a `jsonResponse(...)` helper and inline `{baseUrl, apiKey}` config | **FINDINGS C1, D** |
| T4 | mutation steps map to real branches in the given impl | agrees |
| T5 | `pluginWith` uses `as unknown as MediaTypePlugin` | **FINDING C2** |
| T6 | `deferOrGiveUp` reads `deps.now()` again for nextAt after the pass captured `now` | **FINDING B** |
| T7 | copies arg list from the live call site rather than the sketch | agrees |

## Rulings (pre-flight)

Ruling: FINDING A — Task 4 is NOT independent of Task 3; its implementation and its
test both import `PerformerSearchResult` from `clients/theporndb.ts`. Execute tasks in
strict numeric order 1→7, which satisfies every dependency, and correct the plan's
"Tasks 1–4 are independent" claim. Chose ordering over moving the type into Task 4
because the type belongs with the client that produces it. Cost if wrong: none — strict
order is a superset of the real constraint graph; it only forgoes parallelism that this
skill forbids for implementers anyway.

Ruling: FINDING B — `deferOrGiveUp` takes `nextAt` as a parameter computed by the caller
from the pass's captured `now`, matching `metadata.ts`'s own `deferOrGiveUp(deps, row,
now, message, nextAt)` shape, instead of calling `deps.now()` a second time. Two clock
reads while handling one row can stamp `next_at` from a later instant than the row was
judged at, and the existing pass does not do that. Cost if wrong: negligible — a
few-millisecond difference in one timestamp; the shape change is what matters for
matching the sibling pass.

Ruling: FINDING C1 — Task 3's tests use the test file's existing `respondWith(body,
init?)` helper (returns `FetchImpl & { urls: string[] }`), not the invented
`jsonResponse`. Verified at `test/clients/theporndb.test.ts:39`. Cost if wrong: the
implementer would have written a second, near-duplicate fetch helper — a review finding,
not a defect in shipped behaviour.

Ruling: FINDING C2 — `pluginWith` builds a real minimal `MediaTypePlugin`
(`{id, displayName, parse, score, planImport}`, the shape `metadata.test.ts:577` uses)
rather than double-casting through `unknown`. The plan's own Global Constraints forbid
`any` and treat `unknown` as a shortcut to avoid; a test fixture is not an exemption.
Cost if wrong: none — if `MediaTypePlugin` gains a required member the fixture fails to
typecheck, which is the correct signal.

Ruling: FINDING D — Task 3's tests use the file's existing `CONFIG` / `API_KEY`
constants. `SiteLookupConfig` requires `type: 'theporndb'`, which every inline config in
the plan's test sketches omits — those would not typecheck. Cost if wrong: none; this is
a straight correction of a wrong fixture.

Ruling: the four plan corrections above are applied to the plan file and committed before
Task 1 dispatches, rather than carried as dispatch prose. Briefs are extracted from the
plan by `scripts/task-brief`, so a correction that lives only in my dispatch message is a
correction the brief contradicts — and the brief is what the implementer is told is
authoritative. Cost if wrong: one extra commit on the plan document.

## Progress

Plan corrections committed: e3cd1da (pre-flight rulings A–D applied to the plan document)

Task 1: dispatched (implementer, sonnet) — BASE e3cd1da — brief task-1-brief.md, report task-1-report.md

Ruling: FINDING E (found while pre-extracting briefs) — Task 6's test code block was
missing its closing fence, so `scripts/task-brief` (which tracks fences to find task
boundaries) folded Task 7 and the controller notes into Task 6's brief and could not
extract Task 7 at all. Fixed the fence and re-extracted both briefs; verified task-6-brief
no longer contains Task 7's heading. Committed as a doc-only change. Cost if wrong: none —
this is a markdown syntax repair, verified by re-extraction.
Task 1: implementer DONE — commit 15a3070 — 819 core (+6) / 165 web green; mutation WORDS 2→1 broke the named test, restored
Task 1: task reviewer dispatched (sonnet) — package review-685a7e5..15a3070.diff
Task 1: review clean — Spec ✅, quality Approved
Task 1: minor (deferred): `.trim()` in scenePerformerQuery is redundant given split(/\s+/)+filter, and no test pins it — deleting it would still pass all 6 tests. Inherited from the brief's verbatim code.
Task 1: minor (deferred): the WORDS comment cites `Free.Use.Fantasy` as appearing in resolve-sites.ts; that file actually discusses "Free Use" → "Freeuse Fantasy" and the one-word retry confirming "Free". Argument is sound, literal citation is not. Mirrored in the test file comment.
Task 1: complete (commits 685a7e5..15a3070, review clean)

Task 2: NOT dispatched. The ledger line claiming it was dispatched was written in the same
message that was interrupted, before the Agent call was ever made. No Task 2 implementer
exists, no Task 2 work is in flight, and no Task 2 commit exists. Resume here.
BASE for Task 2 when it is dispatched: 15a3070 (current HEAD).

Session suspended at the user's request to continue on another machine. See
docs/superpowers/handoff/2026-08-14-performer-search-queue-handoff.md, which is the
committed copy of this ledger plus continuation instructions — this workspace is
gitignored and does not travel with a push.

## Resume, 2026-08-16 (Linux machine)

Workspace survived the trip intact, so nothing had to be rebuilt from the handoff. Verified
rather than assumed: all seven briefs regenerate from the committed plan byte-identical to
the preserved copies, and the finding-E grep on task-6-brief.md prints 0 (Task 7 still
extracts as its own brief, 117 lines).

Ruling: RESUME-1 — installed Node v24.19.0 (nvm) rather than accepting this machine's
v24.15.0. On 24.15.0 the baseline was 816/819 core with 3 failures, all one cause:
`mock.timers.enable({apis: ['AbortSignal.timeout']})` throws ERR_INVALID_ARG_VALUE because
that api is not mockable until later in 24.x — confirmed directly by calling it on both
versions, and the 3 tests are pre-existing (they live at the merge-base, untouched by this
branch). v24.19.0 is what the plan's own Global Constraints name (plan line 16), and two of
the three failures are in `test/clients/theporndb.test.ts`, the file Task 3 edits — leaving
them red would have every later implementer reporting failures it did not cause, and Task 3's
implementer chasing them. Cost if wrong: a Node install on this machine; no repo change.

Baseline on resume, Node v24.19.0: `npm ci && npm run check` exit 0, 819 core / 165 web all
green. Matches the suspending machine exactly.

Ruling: RESUME-2 — BASE for Task 2's review package is ee9009b (current HEAD), not the
15a3070 the suspend note names. 15a3070 predates the handoff doc commit ee9009b, so a package
cut from it would put 356 lines of handoff prose into Task 2's review diff. The suspend note
was written before that commit existed. Cost if wrong: none — the two differ only by a
gitignored-workspace doc commit that touches no code.

Divergence noted: main has advanced one commit past this branch's merge-base (f8242f8 →
14bef62, "Prefer a scene's background over ThePornDB's portrait crop of it"). It touches two
files remaining tasks also touch, and both overlaps are textually disjoint:
  src/db/metadata.ts   — main appends postersMatching/setPosterImage after line 410;
                         Task 2 edits clearGroupMetadata at line 387. Disjoint.
  src/clients/theporndb.ts + its test — main changes readPosterUrl and adds tests;
                         Task 3 adds searchPerformers. Disjoint, but line citations shift
                         (respondWith moves 39 → 42, which ruling C1 cites).
  src/pipeline/*       — untouched by main. Tasks 4-7 unaffected.
Migration numbering checked for the Task 2 trap: main added no migration, so `version: 8` is
free on both branch and main. Highest taken is 7.

### Decisions the repo owner made on resume (asked, not ruled)

1. Per-task commits for Tasks 2-7 are authorized; pushes are not. Unchanged from the plan's
   Global Constraints, and now confirmed directly rather than inferred from the plan text.
2. Rebase the branch onto main rather than merging or deferring. Done below.

### Rebase onto main, 2026-08-16

`git rebase main` — six commits replayed, zero conflicts, as the disjointness analysis above
predicted (main's files and Task 1's files do not intersect at all). Pre-rebase tip is kept
at tag `pre-rebase-2026-08-16` (ee9009b) so the old history is recoverable; `origin/` still
holds the pre-rebase copy, so landing this branch will need a force-push the repo owner
approves.

SHA map — every commit the ledger and the handoff doc name has moved:

| Old | New | What |
|---|---|---|
| 1f2bcce | a979f3b | Spec |
| 1f75efb | 13c05ed | Plan |
| e3cd1da | 6784602 | Plan corrections (rulings A-D) |
| 685a7e5 | 407fb7c | Fence fix (ruling E) |
| 15a3070 | 651085d | **Task 1** |
| ee9009b | eb4fa0f | Handoff doc |

Branch start (merge-base with main) is now **14bef62**, not f8242f8 — the final whole-branch
review package must be cut from 14bef62.

Baseline after rebase, Node v24.19.0: `npm run check` exit 0, **836 core / 165 web all green**.
This supersedes 819/165 for every remaining task: main's commit brought 17 core tests
(theporndb +99 lines of tests, repair-posters +222). An implementer told to expect 819 would
report a mismatch it did not cause, so 836 is the number carried into Task 2's dispatch.

Briefs re-extracted post-rebase and still byte-identical to the preserved copies — the plan's
content did not change, only its commit id.

Anchor recheck after rebase (the briefs cite line numbers, and main shifted one):
  `respondWith` in test/clients/theporndb.test.ts: **39 → 42**. Ruling C1 cites 39, so Task 3's
    dispatch must carry the corrected line. CONFIG/API_KEY now at 31/29.
  `PRAGMA foreign_keys = ON` in src/db/open.ts: still line 12 — Task 2's FK lifecycle test
    depends on this and is unaffected.
  `clearGroupMetadata` in src/db/metadata.ts: still line 387; main appended its two new
    functions after 410.
  Highest migration version: still 7, so Task 2's `version: 8` is free.

Ruling: RESUME-2 is superseded — BASE for Task 2's review package is **eb4fa0f** (the rebased
handoff commit, current HEAD), not ee9009b, which is no longer on the branch.

## Task 2

Task 2: dispatched (implementer, sonnet) — BASE eb4fa0f — brief task-2-brief.md, report task-2-report.md
Task 2: implementer DONE_WITH_CONCERNS — commit f11f545 — 843 core (836 + 7) / 165 web green,
  5 files, tree clean. Two concerns raised, both handled below.

Ruling: TASK2-A — the implementer edited `test/db/migrate.test.ts`, one line outside the brief's
stated file list, and that stands. `migration 6 is idempotent across a second run` asserts the
full applied-version list literally (`assert.deepEqual(applied, [1..7])` at line 941), so any
real migration regresses it; the fix is the identical one-line bump every prior migration made.
Verified myself: the commit touches exactly 2 lines there, +1/-1, and nothing else in that file.
The alternative — leaving a pre-existing test red — contradicts the task's own instruction that
the pre-existing suite stay green. Cost if wrong: a one-line revert, and then migration 8 cannot
ship without some other accommodation in that test.

Task 2: Step 7 mutation — the brief predicted the lifecycle test would fail on its
  `DELETE FROM media_groups` line with a foreign-key error. It actually fails one assertion
  earlier, on `assert.deepEqual(duePerformerQueue(db, 9999, 10), [])`, because the leftover row is
  caught by the test's own row check before the FK path is reached. The implementer did not paper
  over the discrepancy: it isolated the FK path in a throwaway script (deleted, not committed) and
  reproduced `FOREIGN KEY constraint failed` / errcode 787 exactly as the brief describes. So the
  mutation step did its job — the test bites, one line sooner than predicted, which is a stronger
  signal than the brief expected rather than a weaker one. No action; noted because the brief's
  Step 7 text is now known to mispredict the failure line.
Task 2: task reviewer dispatched (sonnet) — package review-eb4fa0f..f11f545.diff
Task 2: review clean — Spec ✅, quality Approved. No Critical, no Important. The reviewer
  independently confirmed the doc comment's "five tables" count against the five deletes, that
  `groupHasCast`'s `SELECT 1 ... LIMIT 1` idiom matches metadata.ts:122-123 rather than being
  invented, and that `assertUniqueVersions` (migrate.ts:47-51) really does enforce the migration
  collision guard the brief only claimed. It also independently reached the same conclusion I did
  on the out-of-brief `migrate.test.ts` line — reached without being told, which is what makes it
  worth anything.
Task 2: ⚠️ resolved by controller — the reviewer flagged that it had not re-run the suite, so
  "843 core / 165 web green" was an unverified report claim. I ran `npm run check` myself at
  f11f545: exit 0, 843/843 core, 165/165 web. The two oxlint warnings in migrate.test.ts are at
  lines 11 and 263, not the line 941 this task changed, so they are pre-existing.
Task 2: minor (deferred): `performer-queue.ts` compares `Number(result.changes) > 0` where the
  sibling in metadata.ts:311 compares `written.changes > 0` directly (both correct — JS permits
  `bigint > 0`). Inherited verbatim from the brief, not an implementer choice. Worth normalising
  if the function is revisited.
Task 2: complete (commits eb4fa0f..f11f545, review clean)

## Task 3

Anchor drift from the rebase, all verified against the working tree before dispatch. Main's commit
added ~138 lines to `theporndb.ts` above `readPerformers`, so every src citation in Task 3's brief
moved; the corrected table went into the dispatch:
  respondWith        brief test:39   → test:42
  CONFIG             brief test:28   → test:31 (API_KEY at 29)
  readPerformers     brief src:205-254 → src:348-377, doc comment from 326
  SceneLookupClient  brief src:146   → src:146, unchanged
Also supplied: createTpdbClient/return type 433, searchScenes 512, readScenes 386, str 321,
PER_PAGE 43, PROVIDER_REQUEST_TIMEOUT_MS 87, redactToken 141, RateLimited 160, retryAfterMs 171.

Two things checked so the implementer would not have to, both clean:
  - `readPerformers` is untouched by main's commit (its hunks land at 173/181/196, all above), so
    the brief's refactor description still matches the code exactly — reads slug/id/name from
    `parent ?? site`, name falls back to `str(site,'name')`, kind from whether `parent` is null.
  - `FetchImpl` is `(url: string, init?: RequestInit) => Promise<Response>`, so the brief's
    one-argument `respondWith({data: []})(url)` fixture call compiles. This is the finding-D class
    of defect (fixtures that would not typecheck) and this one is fine.

Task 3: dispatched (implementer, sonnet) — BASE f11f545 — brief task-3-brief.md, report task-3-report.md
Task 3: implementer DONE (no concerns) — commit e74aad4 — 852 core (843 + 9) / 165 web green,
  2 files, tree clean.
Task 3: controller structural checks before review, all pass — the commit touches only the two
  files the brief names; it does not modify main's BACKGROUND_CROP_MARKER / isBackgroundCrop /
  readPosterUrl (grepped the diff for them, empty); all three interfaces are exported
  (PerformerSearchResult 152, PerformerSearchPage 157, PerformerLookupClient 169); the return type
  is widened to `SiteLookupClient & SceneLookupClient & PerformerLookupClient` (521); and
  `readPerformerFields` (364) is genuinely called by both paths — readPerformers at 412 and
  readPerformerPage at 496 — so the shared reader was extracted rather than copied.
Task 3: task reviewer dispatched (opus, a tier up from Task 2's sonnet) — package
  review-f11f545..e74aad4.diff. Higher tier because this is the task whose failure mode is
  invisible in production: a wrong `kind` silently points every auto-linked performer at an alias
  page, and the diff also carries token-redaction and rate-limit paths that must match searchScenes
  verbatim.
Task 3: review — Spec ✅, quality Approved. One Important (plan-mandated), five Minor. The
  reviewer verified the things that mattered rather than asserting them: it read searchScenes
  (600-643) against searchPerformers (658-698) line by line to confirm the error handling is
  verbatim including both redactToken paths, the single shared `timedOut` race and RateLimited on
  429; it confirmed the Step 3 extraction deleted the old block rather than mirroring it; it
  checked `MetadataPerformer['kind']` is exactly the two intended values; and it traced the
  refactor's name-fallback equivalence by hand (old `str(source,'name') ?? str(site,'name')` vs new
  `?? (nameFallback === null ? null : str(nameFallback,'name'))` with `site` always passed).

Ruling: TASK3-A — the Important finding stands as a finding, and the plan's tradeoff stands for
this task. `searchPerformers` is a third verbatim copy of the ~40-line request/error block already
in `searchScenes` and largely in `searchSites`; Step 4 mandated exactly that ("Do not paraphrase
it"). I am not dismissing it because the plan said so — the reviewer is right that three sites must
now change together and the drift would be silent in the copy nobody remembered. I am deferring it
because the fix is out of scope *here*: extracting a `requestJson(url, noun)` helper edits
`searchSites` and `searchScenes`, neither of which is in Task 3's file structure, and it would
rewrite the rate-limit and redaction paths that Task 6's drain has not yet been written against.
A cross-cutting extraction belongs at the whole-branch review, where all three call sites and their
tests are in one diff. Carried there explicitly. Cost if wrong: three copies ship, and the next
change to redaction, timeout or 429 handling must be made in three places or drift in one.

Task 3: ⚠️ carried forward (real, not a defect here) — `src/main.ts:92` still declares
  `let tpdbClient: (SiteLookupClient & SceneLookupClient) | undefined;`. Verified myself; it
  compiles today because the wider return type is assignable, but nothing can reach
  `searchPerformers` through that annotation. **Task 7 owns main.ts and must widen it**, and Task 6
  must not assume the client it receives is already widened. Added to Task 7's dispatch.
Task 3: ⚠️ spans tasks — whether tasks 4/6 consume `truncated` and `aliases` as intended. Resolved
  by executing those tasks; Task 4's brief consumes `aliases`, Task 6's consumes `truncated`.
Task 3: minor (deferred): no test pins the request URL. `respondWith` records `urls` precisely so
  tests can assert the query string, and the existing `site_id=` tests do, but none of the 9 new
  tests looks at it. The method's own doc comment argues at length that `per_page=100` is a
  *correctness* requirement rather than throughput — yet a typo to `10`, a dropped
  `encodeURIComponent`, or `/performer` for `/performers` would leave all 9 green. Highest-value
  item on this list: one assertion on `fetch.urls[0]` would pin the paragraph's claim.
Task 3: minor (deferred): `is_parent`'s non-boolean cases are argued in a comment ("a provider that
  starts sending `"true"`, `1` or `null`") but not pinned — both tests use real booleans, so
  `=== true` could relax to `Boolean(...)` and stay green. Same for the alias filter's
  `alias.length > 0`: nothing pins that `aliases: ['', 'x']` yields `['x']`.
Task 3: minor (deferred): the report mischaracterised its own lint output, claiming the warnings
  were "pre-existing and in unrelated files". Verified by running oxlint myself: 673 and 694 are
  **new** `preserve-caught-error` warnings from this change, joining four identical pre-existing
  ones at 554/572/617/638. The reviewer's judgement that they must NOT be "fixed" is correct and I
  agree — attaching the original error as `cause` would re-expose the unredacted provider message
  `redactToken` just stripped. The file's convention confirms it: it carries inline
  `eslint-disable-next-line` with justifications for `no-await-in-loop` but deliberately leaves
  these four unsuppressed. So: code correct, report inaccurate about its own evidence.
Task 3: minor (deferred): theporndb.ts:198-201 duplicates `readTotal`'s meta narrowing (124-130) —
  two lines, brief-verbatim, different fields read (`last` vs `total`). Noted for completeness.
Task 3: minor (deferred): a record dropped for a missing slug/uuid shrinks the candidate set with
  no signal, the same class of risk `truncated` exists to report — if the one exact match is the
  unreadable row, the caller sees a clean "no match" rather than a partial judgement. Dropping is
  mandated and correct; whether the match rule needs to distinguish "nothing matched" from
  "something was unreadable" is a Task 4/6 design question. Flagged into Task 4's dispatch as
  context, not as a requirement.
Task 3: complete (commits f11f545..e74aad4, review clean)

## Task 4

Fixture pre-check (the finding-D class, and this plan has produced two already): `MetadataPerformer`
(plugin-api/src/types.ts:128-137) has exactly the six fields Task 4's test fixture supplies, and
`faceUrl`/`imageUrl` are `string | null` and **required**, so `faceUrl: null` is correct rather than
an `exactOptionalPropertyTypes` trap. `PerformerSearchResult` shipped from Task 3 at
clients/theporndb.ts:152 in exactly the shape the brief consumes. The fixture compiles.

Task 4: dispatched (implementer, sonnet) — BASE e74aad4 — brief task-4-brief.md, report task-4-report.md
  Dispatch carried an explicit scope boundary: Task 3's review observed that a result dropped for a
  missing slug/uuid is invisible to the caller, so `pickPerformer` cannot tell "nothing matched"
  from "one candidate was unreadable". Told the implementer that is not theirs to solve and the
  signature is fixed, because tasks 5 and 6 are written against it — inviting a reason code or a
  thrown error here would break both. Asked them to raise it in concerns instead if they disagree.
Task 4: implementer DONE_WITH_CONCERNS — commit 84acf52 — 861 core (852 + 9) / 165 web green.
  Two concerns, both real, both about defects in my own plan rather than in the implementation.
  I reproduced each independently with node before ruling.

Ruling: TASK4-A — the implementer's deviation from the brief's literal `normalise` stands. **The
brief's code fails the brief's own test.** Verified: `normalise('Katie ONeil')` → `katie oneil`
while `normalise("Katie O'Neil")` → `katie o neil`, because folding `[^a-z0-9]+` to a *space* turns
an apostrophe into a word break. The shipped fix strips apostrophes first, then folds the rest:
  .toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
That satisfies all three punctuation cases the test names and matches the doc comment's stated
intent (`ONeil` ≡ `O'Neil`), and I confirmed it still keeps `Anna Bell` and `Annabelle` distinct, so
it does not manufacture the tie the next test guards against. Cost if wrong: an apostrophe that
genuinely separates two words would merge them rather than split them; no name in the spec or tests
does that, and the comment explicitly asks for the merging behaviour.

Ruling: TASK4-B — the brief's mutation 3 is unfalsifiable, not merely unlucky, so I replaced it
rather than accepting an unproven test. Verified: adding `.replace(/\s+/g, '')` gives `annabell` vs
`annabelle` — they differ by a letter, not by spacing, so the test cannot fail no matter what. That
left `normalisation does not collapse two genuinely different people into a tie` unproven, and this
plan's global constraint is explicit that such a test must be shown to fail against broken code.
That test guards the direction of over-normalisation that silently destroys real matches (a
manufactured tie discards a genuine single match), so it is worth proving. Resumed the implementer
with `.replace(/\s+/g, '').replace(/e$/, '')` appended, which collapses both sides to `annabell` and
must therefore fail. Evidence only — no new commit, code already correct. Cost if wrong: one test
documents an intent no mutation demonstrates.

Task 4: evidence round dispatched (resumed original implementer) — corrected mutation 3, no commit
  expected, tree must stay clean.
Task 4: evidence round DONE — corrected mutation 3 failed exactly and only
  `normalisation does not collapse two genuinely different people into a tie` (8/9), reverted, green
  again, tree clean, no new commit. I confirmed the revert myself: `normalise` in the working tree is
  the committed four-step version with no `\s+`/`e$` residue. TASK4-B's evidence gap is closed.
Task 4: task reviewer dispatched (sonnet) — package review-e74aad4..84acf52.diff. The dispatch
  discloses both rulings and explicitly invites the reviewer to overturn TASK4-A: it is told to judge
  whether stripping apostrophes is correct, minimal and still honestly described by the comment, and
  that my ruling does not foreclose its finding. A ruling that only I have checked is a ruling with
  one reviewer.
Task 4: review — Spec ✅, quality Approved. One Important, two Minor. The reviewer took up the
  invitation and **independently re-derived TASK4-A** rather than deferring to it: it traced all four
  pairs through the shipped code by hand (`Katie ONeil`/`Katie O'Neil` → both `katie oneil`;
  `Anne Marie`/`Anne-Marie` → both `anne marie smith`; `Anna Bell`/`Annabelle` → still distinct) and
  agreed the apostrophe-strip is correct and minimal. It also hand-traced the corrected mutation 3 to
  confirm both sides really do collapse to `annabell`, i.e. that the reported failure was real rather
  than fabricated. It confirmed the name-tier short-circuit is a genuine early return at
  pick-performer.ts:76-77 — `byAlias` is never even constructed — rather than a computed-then-ignored
  filter, which is the thing that could have satisfied the test while missing its point.
Task 4: fix round 1/5 dispatched (resumed original implementer) — one Important finding, verbatim:
  `normalise`'s doc comment still lumps apostrophes in with hyphens as "punctuation that separates
  words", but the code now elides apostrophes and separates on hyphens. The comment is the only thing
  standing between the next reader and a "simplification" that deletes the apostrophe-strip and
  silently reintroduces the `Katie O'Neil` bug — the line looks redundant beside the general fold
  unless you know why it is there. Comment-only change; told them explicitly not to touch either
  Minor.
Task 4: minor (deferred): `.replace(/'/g, '')` strips only U+0027, not the typographic U+2019. A
  query and a provider name disagreeing on the glyph would normalise apart (`o neil` vs `oneil`) and
  silently miss a real match — the over-cautious failure direction the brief itself worries about.
  The reviewer grepped the client and its fixtures and found no curly apostrophes, so it is
  speculative rather than demonstrated. Deferred deliberately: changing matching behaviour with no
  test and no demonstrated need does not belong in a comment fix.
Task 4: minor (deferred): the `?? null` fallbacks at pick-performer.ts:76,84 are unreachable given
  the preceding length checks — defensive against `noUncheckedIndexedAccess`, harmless, but they
  obscure that the branch cannot be taken.
Task 4: fix round 1/5 — comment-only fix committed 658d9a2 (19+/4-, one file). Verified myself
  before re-review: the diff contains no non-comment changed line, and it left both deferred Minors
  untouched. Fix report carries covering tests, command and output. Scoped re-review dispatched
  (sonnet) — package review-84acf52..658d9a2.diff, told to treat any behaviour change smuggled into a
  documentation round as new breakage.

Task 4: fix round 1/5 re-review — finding ADDRESSED, no new breakage, no out-of-scope observations.
  The re-reviewer confirmed the new comment *argues* the distinction rather than restating it (hyphen
  sits between words so folding to a space preserves equality; apostrophe sits inside one word so
  folding would split `oneil` into `o neil` and never match), that it states the ordering requirement
  and names the regression a deletion would cause, and that the over-normalisation paragraph survived
  verbatim. It also verified byte-identity of the function body, the `/'/g` regex and both `?? null`
  fallbacks against the pre-fix commit — so nothing was smuggled into a documentation round.
Task 4: complete (commits e74aad4..658d9a2, review clean after 1 fix round)

## Task 5/6 prep (verified while the re-review ran)

Ruling C2's cited fixture checks out exactly: `metadata.test.ts:577` is the `bare: MediaTypePlugin`
literal with `{id, displayName, parse, score, planImport}`, and `MediaTypePlugin`'s required members
(types.ts:172-176) are precisely those five — everything else, including the `performerQuery?` Task 1
added, is optional. So C2's "build the real minimal shape" instruction is complete and Task 5's
fixture will typecheck without a cast through `unknown`.

Anchors for the two remaining pipeline tasks: `runMetadataPass` at pipeline/metadata.ts:222,
`kind: 'deferred'` constructed at 206, `backoffFor` at 26 and **currently not exported** — Task 6's
brief requires exporting it, which the pre-flight scan already recorded as a shared-file edit
disjoint from Task 5's call site. `pipeline/performers.ts` does not exist yet, as expected.

Seams verified for Task 5, all clean: `getGroup` (groups.ts:54) returns `GroupRow` carrying
plugin/identityKey/display; `MetadataPassDeps` (metadata.ts:44-57) has db/pluginFor/log so the
brief's call-site object literal compiles as written; `DisplayFields` is exported from the
`@pickarr/plugin-api` root via `export *` and metadata.ts:150 already uses the exact
`JSON.parse(group.display) as DisplayFields` pattern the brief copies; `MetadataQueueRow` has
`groupId`; `now` is in scope at metadata.ts:231.

Exact insertion point pinned for the dispatch, because "after `outcome` is assigned" spans a
try/catch: line 238 declares `let outcome`, 239-253 assign it on both paths (the catch ends with
`deferOrGiveUp` at 252), 255 starts the counters. The call goes **between 253 and 255**. The
cooldown `break` at 265 sits after the counters and needs no reasoning about — a 429 row is
`deferred`, which the gate already excludes.

Task 5: dispatched (implementer, sonnet) — BASE 658d9a2 — brief task-5-brief.md, report task-5-report.md
  Carried one interaction the brief could not know: `metadata.test.ts`'s `defaultPluginFor` (line 26)
  returns the **real** scenes plugin, which Task 1 gave a working `performerQuery`. So in the four
  tests the implementer must write, whether a group queues depends on the title passed to `makeGroup`
  — a one-word title yields no query and nothing queues, which would fail the two "queues a search"
  tests for a reason unrelated to what they test. Also flagged that four of the eleven tests in this
  task are prose sketches rather than given code, and named the fixtures to build them on.
Task 5: implementer DONE (no concerns) — commit b231bcf — 872 core (861 + 11) / 165 web green,
  4 files, 300 insertions, no deletions, tree clean.
Task 5: controller structural checks before review, all pass — the call site sits at metadata.ts:262-264,
  exactly between the try/catch that assigns `outcome` and the counters at 266, gated on
  `outcome.kind !== 'deferred'` with the brief's comment intact; `pipeline/performers.ts` exports only
  `PerformerEnqueueDeps`, `performerQueryFor` and `enqueuePerformerSearch`, so Task 6's pass and runner
  have not been built early; all four named metadata tests exist (778, 797, 814, 829) and
  `duePerformerQueue` is referenced five times in that file.
Task 5: task reviewer dispatched (opus) — package review-658d9a2..b231bcf.diff. Higher tier, and the
  dispatch names the reason: four of this task's eleven tests were authored from prose sketches rather
  than transcribed, and those four are the **only** evidence the gate fires on the right outcomes. The
  reviewer is required to answer, per test, whether it would survive the opposite behaviour — the two
  "queues" tests against the enqueue never running, the two "queues nothing" tests against it running
  unconditionally — and to check each arrangement really produces the state it claims, since a
  confirmed-with-cast test that failed to attach a cast, or a settled-as-none row that actually
  deferred, would pass for the wrong reason. Step 6's mutation only covers the deferred case, so the
  other three are unproven by mutation. Granted one focused exception to read that test file's existing
  fixtures outside the diff, since judging authored tests requires seeing what they call.
Task 5: review — Spec ✅ (with one ❌ noted below), quality Approved. One Important, seven Minor.
  The reviewer answered the vacuity question per test and did the work to earn the answers: it
  established that `insertPerformerSearch` gates only on `groupHasCast` and `duePerformerQueue`
  filters only on `next_at`, so no group-state default could make an assertion pass for the wrong
  reason; it traced `'A Scene'` through the real `scenePerformerQuery` to confirm all four groups are
  query-eligible; and it verified each test asserts its own arrangement (`state === 'confirmed'`/
  `'none'`, `result.deferred === 1`, cast non-empty) before asserting the outcome. Verdict: tests 2,
  3 and 4 fail under the opposite behaviour on their own; test 1 is non-vacuous only in combination
  with test 2. It also confirmed the Step 6 mutation evidence is coherent with the code — the reported
  row shape and stamps match what `insertPerformerSearch(db, 1, 1000)` would write — rather than
  fabricated.

**Ruling: TASK5-A — the spec contains a false factual premise, and it propagated into the code as a
comment asserting an invariant that does not hold.** Spec §5 says: "`runMetadataPass` is the only
place a metadata row settles, so every settle path inherits the enqueue by construction." That is
wrong. `http/server.ts:713-719` also settles a row, via `answerUnaskable`, and queues nothing. I
verified the gap is reachable rather than theoretical: `metadataAnswerability` returns `'unaskable'`
when `sceneMetadataQuery` yields no query, whereas `scenePerformerQuery` needs only two words in the
title — different conditions, so a real scenes group can be metadata-unaskable and performer-queryable
simultaneously. Because `answerUnaskable` records a *permanent* answer, the worker never revisits, so
that group silently never gets a performer search. Whether it gets one therefore depends on whether a
browse request or the worker reached it first — exactly the failure the spec's own
`deriveUpgradeReleaseId` argument exists to prevent.

Split the ruling deliberately:
  (a) **Fixed now, in scope:** the comment at metadata.ts:261 must stop asserting a falsehood, and
      must name the other settle path so the next reader looks. A false load-bearing invariant is
      worse than no comment — it actively stops the check that would find the gap.
  (b) **NOT fixed now, escalated:** adding an enqueue at `http/server.ts:717`. That file appears in no
      task's file structure anywhere in this plan, the change alters an HTTP request path, and the
      defect is in the spec rather than the plan — so it is the repo owner's call, not a fix-round
      decision. Carried to the whole-branch review and to the final rulings list.
Cost if wrong: (a) none, it is strictly more truthful. (b) the feature keeps a silent hole — castless
groups settled by a browse before the worker sees them never get a performer search, which reads as
"the feature links almost nothing" and is indistinguishable from the low link rate spec §12 already
predicts. That last point is why it must be written down rather than left to be noticed.

Ruling: TASK5-B — I bundled four Minors into the fix round rather than deferring all of them, which
departs from "Minors never enter the loop". Reason: each is a one- or two-line change in files the
implementer already owns, and the first is consumed directly by Task 6, so fixing it after Task 6
builds on it costs more. Bundled: the untrimmed return (`return query` where the guard tested
`query.trim()`, and Task 6 sends this to a provider URL); the log message that blames the plugin for
corrupt `display` JSON; the untested whitespace-query branch; and test 1's undocumented dependence on
test 2. Explicitly told the implementer **not** to move `JSON.parse` outside the `try` — the enqueue
call sits outside `runMetadataPass`'s own try/catch, so a throw escaping `performerQueryFor` would
abort the entire pass, making the "obvious" fix a regression. Cost if wrong: a slightly larger fix
diff to re-review.

Task 5: minor (deferred): `performers-enqueue.test.ts` duplicates `seedGroup`/`giveCast` verbatim from
  `test/db/performer-queue.test.ts`. Plan-mandated (brief line 34 chose the copy over a shared module)
  and defensible at two copies — recording it so a third copy is recognised as the moment to extract.
Task 5: minor (deferred, branch-level not task-level): `npm run check` is not pristine at branch
  level — pre-existing `preserve-caught-error` warnings in theporndb.ts, registry.ts, import.ts,
  load.ts, upgrade.ts. None in files this task touched. For the final review to triage.
Task 5: fix round 1/5 dispatched (resumed original implementer) — one Important (false invariant
  comment, reword only, `http/server.ts` explicitly off limits) plus four bundled Minors.
Task 5: fix round 1/5 — commit 90964c7 (4 files, 34+/3-). All five findings ADDRESSED, no new
  breakage. Re-reviewer explicitly confirmed the two things that could have gone wrong: `http/server.ts`
  is absent from the diff, and `JSON.parse` is still inside the `try` rather than hoisted out (which
  would have made a corrupt `display` row abort the whole pass). I verified both independently too, and
  confirmed `http/server.ts` is untouched across the entire branch (14bef62..HEAD).
Task 5: complete (commits 658d9a2..90964c7, review clean after 1 fix round)

## Task 6

Dependencies verified: `upsertPerformers(db, source, performers, now): number[]` (performers.ts:66) and
`setGroupPerformers(db, groupId, ids)` (109) both document "no transaction of its own ... meant to be
called from inside one", and note `node:sqlite` throws on a nested `BEGIN` — so the brief's single
`BEGIN`/`COMMIT` in `recordPerformerOutcome` is the right shape and must not be nested.
`performersForGroups` returns `Map<number, PerformerRow[]>` as the `castOf` helper assumes.
`createMetadataRunner` is at metadata.ts:311 (the brief says "296 onward"), `MAX_METADATA_ATTEMPTS` at
43, and `backoffFor` at 26 is indeed unexported — Task 6's Step 3 adds the `export`.

**Two defects found in Task 6's brief before dispatch. Both would have cost a fix round.**

Ruling: TASK6-A — the brief's poison-row test cannot pass as written, and I am directing a minimal
intent-preserving correction rather than letting an implementer discover it mid-task. The test
`a row whose own write throws still has its attempts bumped` installs
`CREATE TRIGGER no_link BEFORE INSERT ON group_performers ... RAISE(ABORT)`, seeds two groups, and
asserts `result.deferred === 1` with the comment "Group 2 was still reached in this same pass, and
settled normally". But group 2 is seeded `'Someone Else Entirely'` → query `'Someone Else'`, and its
supplied answer is `found('Someone Else')` — an exact name match. So group 2 *also* attempts a link,
and I confirmed `setGroupPerformers` (performers.ts:122-126) issues `INSERT INTO group_performers`,
which the trigger aborts. Both rows therefore defer: `result.deferred` is 2, the assertion fails, and
the comment is false. Minimal fix that keeps the test's actual purpose (the failing row's attempts
bump, and the pass still reaches the row behind it): make group 2's answer a **non-matching** name, so
it settles `unmatched` with no `group_performers` write and is untouched by the trigger. Told the
implementer to verify empirically first and report the deviation. Cost if wrong: a test whose second
row proves reachability by settling rather than by failing — strictly the case the comment already
claims it is testing.

Ruling: TASK6-B — Step 7's "test 4 must fail" is off by one. The clobber-guard test
(`a cast that appeared between enqueue and drain is not clobbered`) is the **fifth** test in the file;
the fourth is the ambiguous-result test. Removing the in-transaction `groupHasCast` re-check would not
make the fourth test fail, so an implementer following the number literally would report the mutation
"not reproducing" and have to be sent back. Dispatch names the test by title instead of by number.
Cost if wrong: none — the title is unambiguous where the number is not.

Task 6: dispatched (implementer, opus) — BASE 90964c7 — brief task-6-brief.md, report task-6-report.md
Task 6: implementer DONE_WITH_CONCERNS — commit ed14b65 — 886 core (873 + 13) / 165 web green, tree
  clean. TASK6-A confirmed empirically: as written the poison-row test gave `result.deferred` = **2**,
  exactly as predicted. The implementer fixed the cause (group 2's answer → `found('Nobody At All')`,
  so it settles unmatched and never reaches the trigger) and explicitly did not edit the assertion.
  TASK6-B's title-not-number instruction worked: removing the in-transaction `groupHasCast` re-check
  failed only `a cast that appeared between enqueue and drain is not clobbered`, with `['Someone']`
  replaced by `['Jessica Jaymes']` — the clobber is real and the guard is what stops it.

**Ruling: TASK6-C — a fourth brief defect: the runner's cooldown-log assertion is vacuous, and it is
worse than the implementer framed it.** The test asserts
`logged.filter((line) => line.includes('cooldown')).length === 1`. The skip line (performers.ts:298)
reads "performer pass: skipped, **cooling down** until …", which does not contain the substring
`cooldown`; the line that does is the pass summary at :271 (", cooldown until …"), logged once on the
first tick. So the single match is the summary, and the count would still be 1 even if the skip fired
on every tick — the assertion cannot distinguish once-per-cooldown from once-per-tick, which is the
only property the test's name claims. I checked the implementation: `loggedSkip` (performers.ts:292,
296-304) is correct, so the behaviour is right and only the evidence was missing. Directed a fix now
rather than at review, because an untested flag is one a future refactor deletes as dead weight:
filter on `'cooling down'`, and prove it by removing the `loggedSkip` guard so the skip logs every tick
and the corrected assertion fails 2-where-1-expected. Cost if wrong: none — strictly more evidence for
behaviour that is already correct.

Ruling: TASK6-D — deferring the hardcoded upsert source rather than fixing it. `recordPerformerOutcome`
passes the literal `'theporndb'` (performers.ts:150) where the sibling `db/metadata.ts:315` passes the
client's own `input.source`. A genuine inconsistency, correctly raised. Deferred because the code is
correct today (ThePornDB is the only performer client), `PerformerLookupClient.source` is not reachable
inside that function without re-narrowing `deps.client` or adding a parameter, and the spec scopes this
feature to one provider — changing a signature for a hypothetical second is speculative. Cost if wrong:
a second performer provider would write rows under the wrong `source`, and since `upsertPerformers`
conflicts on `(source, source_uuid)` those rows would not collide with the real ones but would be
mis-attributed. For the final review to triage.

Ruling: TASK6-E — deferring the import cycle, with its fragility recorded. `pipeline/performers.ts`
imports `backoffFor` from `pipeline/metadata.ts`, which imports `enqueuePerformerSearch` back from
`performers.ts`. Created by the plan's own Step 3 "share, don't copy" instruction, so not the
implementer's doing. Safe today for a specific and losable reason: both bindings across the cycle are
hoisted **function declarations**, so each is defined before the other calls it. It would break if
either became a `const` arrow or a module-level value evaluated at import time. The clean resolution —
moving `backoffFor` into a neutral module both import — spans both files and belongs in the
whole-branch review, not a fix round scoped to one task. Cost if wrong: a future refactor of either
binding's declaration form turns a working import into a `TypeError` at startup.

Task 6: fix round 1/5 dispatched (resumed original implementer) — TASK6-C only, with mutation proof
  required; told explicitly not to touch the two deferred concerns.
Task 6: fix round 1/5 — commit 28e5885, test-file only (`git diff ed14b65..28e5885` touches only
  performers-pass.test.ts; I verified). The assertion now filters `'cooling down'`. Mutation evidence is
  the decisive part: unwrapping the `loggedSkip` guard fails the corrected assertion 2-where-1-expected,
  **and left the old `'cooldown'` filter green** — which is the direct demonstration that the original
  assertion was vacuous rather than merely fragile. Guard restored, 13/13 green.
Task 6: task reviewer dispatched (opus) — package review-90964c7..28e5885.diff (2 commits). Dispatch
  discloses TASK6-A/B/C and invites the reviewer to overturn any of them, names the two deferred
  concerns so they are not re-litigated as blocking, and requires an explicit verdict on each of the
  four correctness properties (in-transaction cast re-check; deferral outside the failed transaction;
  429 breaks without bumping attempts; runner makes no request inside a cooldown). Also told to hunt for
  further vacuous tests given one was already found here.

Task 6: review — Spec ✅, quality Approved. No Critical, no Important, four Minor. All four correctness
  properties verified against the code rather than the report: one `BEGIN` at :152 with the cast
  re-check at :155 and all three writes inside it; **no nested `BEGIN` anywhere in the helpers** (the
  reviewer grepped `db/performer-queue.ts` and `db/performers.ts` — the only hits are two prose lines in
  a doc comment); `deferOrGiveUp` genuinely outside the rolled-back transaction, issuing bare statements;
  429 writing nothing at all before `break`; runner returning before `runPerformerPass` so
  `duePerformerQueue` is never read. It also re-derived why each of the 13 tests discriminates and found
  no second vacuous assertion after TASK6-C.

  It endorsed TASK6-A with a better argument than mine: because `recordPerformerOutcome` runs `BEGIN`
  *before* branching on `performer !== null`, group 2's non-matching answer still executes a full
  BEGIN/remove/COMMIT cycle — so the test continues to prove that group 1's `ROLLBACK` left the
  connection clean, since otherwise group 2's `BEGIN` would throw "cannot start a transaction within a
  transaction". The only property lost is "a *link* write succeeds after a rollback", which is untestable
  under a trigger that refuses every link. That is a stronger reading of the fix than I had.

**Correction to ruling TASK6-D, on the reviewer's better information.** I wrote that reaching the real
upsert source needed "re-narrowing `deps.client` or adding a parameter", implying both were awkward. The
reviewer points out `client` is *already* narrowed to non-undefined at :220-221 and is in scope at the
:249 call site, so `recordPerformerOutcome(deps, client.source, row.groupId, …)` is a one-parameter
addition — no re-narrowing, no touching `deps.client`. My stated cost was overstated. Keeping it deferred
per the reviewer's own recommendation that the branch review simply take it, but the branch review should
know it is a two-line change rather than a refactor.

Ruling: TASK6-F — bundling all four Minors into a second fix round. Minors 1 and 2 are not polish: 1 is a
silent behavioural divergence from a decision `metadata.ts:402-407` documents in prose ("a cooldown
computed from a stale timestamp would expire earlier than the provider intended"), and 2 is a comment
whose checkable claim is false — the same species as Task 5's false invariant, which this plan has now
produced three times. 3 and 4 close evidence gaps in the same files. Told the implementer explicitly
that fixing the cooldown clock does **not** conflict with pre-flight FINDING B: the deferral backoff uses
the captured clock, the cooldown re-reads it, and `metadata.ts` makes exactly that split. Also asked them
to state plainly whether fix 1 ends up pinned by a test or rests on inspection, rather than let me assume
coverage. Cost if wrong: a larger fix diff to re-review.

Task 6: minor (deferred, cross-cutting, for the final review): the reviewer noticed that **metadata's**
  429 path (`metadata.ts:407`) *does* call `deferOrGiveUp`, bumping a row's attempts toward
  `MAX_METADATA_ATTEMPTS` for a fault that is not the row's — where the performer pass deliberately does
  not (correctness property 3). Its judgement, which I share: the performer behaviour is the better of
  the two and metadata is the one that should eventually change. Out of scope for this branch; recorded
  because it is exactly the kind of asymmetry that is invisible until a long rate-limited outage burns
  through a row's attempt budget.
Task 6: fix round 2/5 dispatched (resumed original implementer) — four bundled Minors.
Task 6: fix round 2/5 — commit 8f43d37 (2 files, 100+/7-), 888 core (886 + 2) / 165 web green, tree
  clean. `result.cooldownUntil = deps.now() + error.retryAfterMs` at :260. Both deferred items verified
  still present and unchanged (`'theporndb'` at :150, the `./metadata.ts` import at :14).

  Fix 1 turned out to be **pinnable after all**, contrary to my expectation when I dispatched it: a
  client stub that advances the clock 4s before throwing the 429 makes fresh (125_000) and stale
  (121_000) measurably different, and reverting the line fails with `actual: 121000`. I asked for an
  honest statement of whether it was pinned or resting on inspection and got a test instead — the better
  outcome.

  Fix 3a is the neatest of the four: rather than assert "no reads" indirectly, the implementer **parks the
  queue table across the call**, so any queue read would throw `no such table` — the mechanism cannot be
  satisfied by luck. It also narrowed the test's name to `no queue read`, on the grounds that "no reads"
  would still overclaim even once the queue read is pinned. That is the right instinct about names: a
  test name is a claim, and this plan has now produced three comments and one assertion that made claims
  their code did not support.

Task 6: honest gap, accepted pending re-review adjudication — the `?? 0` stale-cooldown clear
  (performers.ts:317) is **not** pinned, and the implementer judges it unpinnable through this interface
  with a monotonic clock: a pass only runs once the cooldown is already past, so keeping the old value
  versus zeroing it is unobservable from outside. I checked the argument and it holds — `cooldownUntil`
  is only compared as `now < cooldownUntil`, and any stale value that permitted the pass to run is by
  definition already behind `now`, so a monotonic clock can never distinguish the two. The `?? 0` is
  therefore defensive clarity rather than live behaviour. It declined to fabricate coverage and said so,
  which is the response I wanted; the re-reviewer is asked to adjudicate the claim independently rather
  than credit it for being volunteered.
Task 6: fix round 2/5 re-review dispatched (sonnet) — package review-28e5885..8f43d37.diff.
Task 6: fix round 2/5 re-review — all five findings ADDRESSED, no new breakage. It confirmed the two
  things that could have gone wrong: the deferral backoff still uses the pass's captured clock
  (`now + backoffFor(row.attempts)`, unchanged), so the cooldown/deferral split survives; and both
  deferred items are absent from the diff. It independently verified fix 1's test is discriminating
  rather than decorative — noting the pre-existing frozen-clock 429 test *cannot* catch the stale read,
  which is why the new advancing-clock test was needed — and traced fix 4's four ticks to confirm they
  exercise resumption *and* re-arming rather than only one.

**Correction to my own ledger entry above.** I wrote that I had checked the `?? 0` unpinnability argument
and "it holds". That was too strong, and the re-reviewer caught it. The argument holds *conditional on a
monotonic clock*, and that scoping does real work: `now` is an injected `() => number`, so the interface
does not guarantee monotonicity, and real wall clocks violate it under NTP correction or a DST shift. A
test that distinguishes the two behaviours does exist: set a cooldown, advance past it, run a pass that
returns no new rate limit (which zeroes `cooldownUntil` under the fix but leaves 121000 stale under the
bug), then **rewind** the clock to 50000 and tick — under the bug `50000 < 121000` skips wrongly with no
request; under the fix `50000 < 0` proceeds. So the honest statement is "unpinnable only if you assume a
monotonic clock", not "unpinnable". Both the implementer and I scoped it as absolute when it is
conditional.
Task 6: minor (deferred, for the final review): the `?? 0` stale-cooldown clear at performers.ts:317 has
  no test, and the rewind-the-clock test above would cover it. Low value while the clock is `Date.now()`;
  worth knowing that the defensive line is defending against a real, if rare, condition rather than an
  impossible one.
Task 6: complete (commits 90964c7..8f43d37, review clean after 2 fix rounds)

Task 7: dispatched (implementer, sonnet) — BASE 8f43d37 — brief task-7-brief.md, report task-7-report.md
  Dispatch carried both TASK7-A (Step 1 unimplementable; build a small exported composition helper and
  pin the pass order with it; the other two tests deferred as unreachable) and TASK7-B (the ordering
  comment states the opposite of the code; write what happens, and state the perTick-sum consequence).
Task 7: implementer DONE (no concerns) — commit 554837c — 890 core (888 + 2) / 165 web green,
  **`npm run build` succeeded, all 4 packages** — the load-bearing check for this task, since it widens a
  shared type declaration and `npm run build` runs no typechecker.
Task 7: controller structural checks before review, all pass — `tpdbClient` widened to
  `(SiteLookupClient & SceneLookupClient & PerformerLookupClient) | undefined` (main.ts:118, shifted from
  92 by the helper insertion), closing the ⚠️ that had been outstanding since Task 3; `composeMetadataTick`
  exported at :76 awaiting in sequence at :81-82 with a comment at :70 arguing against `Promise.all`; the
  log line extended at :206; the scheduler's conditional spread unchanged at :219-221, so the
  "absent runMetadata means register no timer" contract survives.
Task 7: the corrected ordering comment reads accurately now — it states that each pass reads `now()`
  fresh so a just-enqueued row (`next_at = now`) is already due when the performer pass reads the queue
  "moments later", searched **in this same tick, not the next one**, and it qualifies the brief's
  "predictable" claim explicitly: "a bound, not a constant ... worst-case provider requests in one tick is
  the *sum* of both passes' `perTick`, not `perTick` itself." Both of TASK7-B's corrections landed.
Task 7: task reviewer dispatched (sonnet) — package review-8f43d37..554837c.diff. Dispatch discloses both
  rulings and invites reversal, and specifically asks the reviewer to verify the deferral justification
  for the two unreachable tests — that the diff adds code only inside the existing `else` branch, leaving
  the other two branches untouched — rather than take my word for it.
Task 7: review — Spec ✅, quality Approved. No Critical, no Important, two Minor. Both rulings verified
  **sound and independently re-derived**, not taken on faith:
    - Ruling 1: it confirmed the missing fixtures itself, judged `composeMetadataTick` genuinely small and
      pure (two functions in, one out, no captured deps), and — the part I asked for — confirmed the two
      unreachable branches at main.ts:154-160 carry **zero `+`/`-` diff lines**, so "preserved by
      construction" holds as stated rather than as a hope.
    - Ruling 2: it traced the mechanism through the real code (`insertPerformerSearch` binding both
      `requested_at` and `next_at` to the same `now` at performer-queue.ts:50; `duePerformerQueue`'s
      `next_at <= ?` at :69; both runners calling `deps.now()` fresh) and confirmed same-tick draining.
  It also traced the **microtask interleaving** to confirm the ordering test would genuinely fail under a
  `Promise.all` implementation (which would invoke `runPerformers()` before `runScenes`'s internal await
  resolved, producing `['performers','scenes']`) — that is the constraint this task actually had to
  honour, and the test discriminates it rather than merely observing that both ran. And it checked the
  type widening against the *other* call site (`resolveSitesForBatch`, whose
  `client: SiteLookupClient | undefined` still accepts the wider type) rather than assuming.
Task 7: minor (deferred): the call-site comment is 14 lines carrying four distinct claims, so a skimmer
  meets three other points before the load-bearing one (same-tick draining). Judged not worth resplitting
  given this codebase's established long-argued-comment register.
Task 7: minor (deferred): of the two ordering tests, only the second discriminates sequential-await from
  `Promise.all` — the first has no internal await in either stub, so it would also pass under
  `Promise.all` or fire-and-forget. Harmless, but the second test carries the real weight and should not
  be the one trimmed if either ever is.
Task 7: complete (commits 8f43d37..554837c, review clean)

## All seven tasks complete. Final whole-branch review next.

Branch: 14bef62 (merge-base with main, post-rebase) → 554837c. Seven task commits plus the doc/handoff
commits. Final verification at HEAD recorded below before the review is dispatched.

Final verification, run by the controller at 554837c on Node v24.19.0:
  `npm run check` exit 0 — **890 core / 890 pass / 0 fail; 165 web / 165 pass / 0 fail**
  `npm run build` exit 0 — all four packages
Test growth across the branch: 836 at the rebase baseline → 890. +54 (T1 6, T2 7, T3 9, T4 9, T5 12,
T6 15, T7 2 — T5 and T6 include their fix-round additions).

Final whole-branch review dispatched (opus, the most capable tier, per the skill's instruction that this
review specifically gets it) — package review-14bef62..554837c.diff, 16 commits, 247 KB. Told the
reviewer roughly 2,500 lines of that are the committed spec/plan/handoff markdown and listed the files
that actually hold code, so the signal is not lost in documentation.

Its primary assignment is triaging all **20 deferred findings**, each enumerated in the dispatch with its
ruling, plus the ledger path so it can read every decision taken on the repo owner's behalf. It is also
asked to judge four things independently of that list: the no-cascade migration against the
`docs/known-issues.md` defect that shipped twice; the `recordPerformerOutcome` transaction; whether any
path exists by which the feature can write a wrong or clobbering cast; and whether the shared-tick
request-rate behaviour is coherent against a rate-limited provider given the metadata/performer 429
asymmetry. It was told explicitly that six defects were already found in this plan's own briefs, so
treating the plan as authoritative would be a mistake.

## Final review returned: "Ready to merge — with fixes". No Critical. Five Important.

**Correction to ruling TASK5-A: my escalation's mechanism was wrong, and I verified the correction
myself.** I claimed the `http/server.ts` settle-path gap was "reachable rather than theoretical",
reasoning that `metadataAnswerability` returns `'unaskable'` when `sceneMetadataQuery` yields no query
while `scenePerformerQuery` needs only two words. The reviewer traced every `'unaskable'` route and found
the overlap **empty** for the scenes plugin. Checked directly:
  - `sceneMetadataQuery` (plugin-scenes/src/metadata.ts:18-22) returns null only when `subtitle` is
    undefined/empty **or** `title` is empty.
  - `subtitle` can never be empty: `buildRelease` refuses an empty site slug (parse.ts:855-856) and
    `sceneFromManualValues` requires a site, so every parsed or hand-entered release carries one.
  - An empty `title` makes `scenePerformerQuery` return null too, so that route has no overlap either.
  - `plugin === null` → `performerQueryFor` also returns null. Missing hooks → scenes has both.
So the gap is **latent**, gated behind a legacy/hand-written `display` row with no subtitle, or a future
plugin implementing `performerQuery` without the two metadata hooks (which would get zero performer
searches — the case that should justify the eventual fix). I overstated reachability; the ruling to
escalate rather than fix in-task still stands, but on weaker grounds than I gave.

**The committed spec is false in two places and that IS a merge blocker.** §5's "only place a metadata row
settles" and §9's "a row enqueued this tick is searched on the next one" are both now contradicted *in
writing* by code comments on this same branch (metadata.ts:268-271 and main.ts:190-201). A design document
its own code calls wrong is worse than no document.

**New finding no task review could reach — and it may nullify the feature.** `pickPerformer` never filters
on `kind`. I verified: neither pick-performer.ts nor performers.ts mentions `kind` anywhere. So:
  - A canonical parent plus one or more identically-named `is_parent: false` site entities in the same
    page are **two exact name matches** → tier 1 ties → nothing is linked. If `/performers?q=` returns
    parent and site entities together (which the code plainly expects — Task 3's own test models
    `slug: '6061-alice-maze'` with `is_parent: false`), the commonest correct query links nothing.
  - With no parent present, a lone `is_parent: false` match **is** linked — producing exactly what
    `readPerformerFields`' doc comment warns about: "every linked performer pointed at an alias page, and
    nothing to notice it by".
  - No test covers a mixed payload; `found()` in performers-pass.test.ts always sets `kind: 'performer'`.
The irony is sharp: Task 3's entire refactor existed to derive `kind` correctly from `is_parent`, and then
nothing consumes it.

Ruling: FINAL-A — filtering to `kind === 'performer'` is **implementing the spec, not changing the
design**, so it goes in the fix wave rather than to the repo owner. Spec §7 states outright that
`site_performers` is "deliberately not a match source ... names belonging to `performer-site` entities,
which are a different identity than the one being linked". Linking a `performer-site` entity from
`/performers` contradicts that in substance while honouring it in letter. The filter belongs in
`pickPerformer`, not in `readPerformerPage`: the client should keep faithfully reporting what the provider
said (and Task 3's tests pin that), while the match rule owns the policy about which identity is
linkable. Cost if wrong: if TPDB never returns site entities from `/performers`, the filter is a no-op
that removes a class of wrong link that cannot occur.

Ruling: FINAL-B — the spec-§11 lifecycle gap goes in the wave too. §11 asked for two tests, a merge and a
plain identity edit, both through `editGroup`. What shipped covers `clearGroupMetadata` directly. Worse,
the pre-existing merge test at test/manual/operations.test.ts:640 inserts a `metadata_queue` row
*specifically* so the fix is proved against every table, and its assertion comment still says "in any of
the four tables" — there are now five. That is the same defect the file's own comment warns about, quietly
reintroduced. No task review could catch it: task reviews check brief compliance, and the brief never
asked for it. Cost if wrong: four lines of test and a corrected comment.

## Final fix wave (the single one the process allows)

Dispatched as ONE agent with all seven fixes plus an explicit nine-item out-of-scope list, so nothing
unreviewed lands in the last commits before merge. Four commits:
  22f276c  Link only a canonical performer, never a site-scoped namesake
  54f9ba5  Share the backoff curve from a leaf module instead of across a cycle
  2e63a4a  Pin the performer search url, and the fifth table a merge must clear
  2b0f90c  Correct two spec statements the code on this branch contradicts

Controller verification at 2b0f90c, run myself: `npm run check` exit 0, **895/895 core, 165/165 web**;
`npm run build` exit 0. Lint warnings unchanged at 73, zero errors. Structural checks: the `kind` filter
is at pick-performer.ts:92 and applied **once before tiering** (so a site entity cannot win on an alias
either); `performers.ts:14` now imports `backoffFor` from `./backoff.ts` and no longer from `metadata.ts`,
so the cycle is one-directional; `upsertPerformers(deps.db, source, …)` at performers.ts:158 takes the
threaded value.

Fix 1's mutation evidence is the piece that matters: dropping the filter fails **exactly the two new
tests while all nine pre-existing ones pass**. That is the shape you want — it proves the new tests pin
the filter *and* that filtering did not change any behaviour the nine already covered, including the
alias tier.

Fix 6 extended the two existing `editGroup` tests rather than adding new ones, because they already drove
both paths — which is why the count is 895 and not ~897. Its mutation: dropping the `performer_queue`
delete fails exactly those two tests.

Fix 5: the only other importer of `MAX_BACKOFF_MS` was `metadata.test.ts`, updated; no re-export from
`metadata.ts`, on the grounds that `packages/core/src` has no barrel so nothing outside could have
depended on the old location.

Follow-up noted by the fix agent, unactioned and correctly so (outside the prose-only §5/§9 scope):
spec §2 says "See §6" for `site_performers` where the reasoning actually lives in §7. Pre-existing.

One scoped re-review of the wave dispatched (opus — the last gate before merge, and the wave contains a
behaviour change to the match rule plus a module extraction). It is told the out-of-scope list and asked
to treat any appearance of those items as new breakage, to confirm the cycle is gone **in both
directions**, and to check that the new §5 prose does not overstate reachability the way my original
escalation did.

## Fix-wave re-review: all seven ADDRESSED, no new breakage, **Ready to merge: Yes**

It verified rather than accepted, on every point that mattered:
  - The `kind` filter runs before **both** tiers, and the ordering is pinned by a test rather than only by
    a comment (a `performer-site` whose *alias* matches returns null).
  - All nine pre-existing pick-performer test bodies are **byte-identical**; the only `-` lines are in the
    `result()` helper, whose two changes are inert for them (`kind` defaults to `'performer'`, and no test
    asserts on `sourceUuid`).
  - It validated fix 1's mutation evidence **by decision rather than by re-running** — `pickPerformer` is
    pure, so the mutant's effect on all 11 tests is decidable from the source — and derived the same
    9-pass/2-fail split. It did not mutate the checkout.
  - Blast radius outside the unit: grep found no pass-level or e2e test that depended on a site entity
    being linked.
  - The cycle is gone **transitively**, not just directly: `grep '\.\./pipeline/' src/db src/clients` is
    empty, so nothing `performers.ts` imports can route back to `metadata.ts`.
  - It re-derived spec §5's whole reachability chain itself (server.ts:713 → metadataAnswerability →
    sceneMetadataQuery → parse.ts's site-slug refusal → performer-query's two-word floor) and confirmed
    "latent, not reachable" is accurate. One looseness noted: a sentence about "a plugin that has both
    metadata hooks" silently means the scenes plugin — narrower than its wording, not false.
  - Out-of-scope list: **none of the nine touched.** Confirmed file by file, including that metadata's 429
    attempt-bumping is untouched and the duplicated test fixtures were left duplicated.

Two residual notes, both adjudicated here rather than in a second wave (the process allows none):

Ruling: FINAL-C — parking the `operations.test.ts:618` vacuity risk. The new `group_performers`
assertion on the identity-edit path is non-vacuous **today** only because the fixture's `performers` array
is non-empty; unlike the merge test, that path has no pre-assertion that the row existed first. If the
fixture is ever emptied the assertion passes for the wrong reason — which is precisely the failure mode
the merge test's own comment was written to prevent, so the file now contains one instance of the pattern
it warns about. Parked rather than fixed: it is correct as it stands, a second fix wave is not available,
and the cost of being wrong is bounded — a future fixture edit silently weakens one assertion on a path
whose sibling test still covers the same delete. Recorded so the next editor of that fixture knows.

Ruling: FINAL-D — parking the URL test's encoding-shape pin. `theporndb.test.ts:427` asserts
`q=Jessica%20Jaymes` literally, so a future refactor to `URLSearchParams` — which encodes a space as `+`,
also valid — would fail the test even though the request would be correct. Deliberate per the test's own
comment, and the stricter reading is defensible for a claim the method's doc comment calls a correctness
requirement. Cost if wrong: one test to update if anyone ever switches encoders, with a comment already
explaining why it is strict.

## Workspace deliberately NOT deleted

The skill deletes the workspace once the final review is clean **and its fixes are merged**. The fixes are
committed; the branch is **not merged** and must not be — the repo owner approves every merge and every
push, and `origin/feature/performer-search-queue` still holds the pre-rebase history, so landing this
needs a force-push they authorise. Deleting the ledger now would destroy the recovery record while the
work is still in flight, and this run already demonstrated why that record matters: it survived a
cross-machine handoff and was the only reason Task 2 was not re-dispatched against a phantom agent.
Delete it after the branch lands.

## BLOCKER found at the finish gate: main moved again, and took migration 8

main advanced from 14bef62 to **85639d2 — 14 commits** while this run executed (the
`reconcile-client-first` branch landed, plus a test-infrastructure fix). merge-base is still 14bef62, so
this branch is 20 ahead / 14 behind.

Four files overlap. One is the trap this plan's own migration file documents happening **twice**:

**`packages/core/src/db/migrations.ts` — both main and this branch took `version: 8`.** Verified: main's
new migration is `version: 8`, and so is `performer_queue`'s. Merging as-is yields two entries numbered 8,
which `assertUniqueVersions` (migrate.ts:47-51) turns into a hard startup failure — loud rather than
silent, which is the good outcome, but it means the merged result does not run until this branch's
migration is renumbered to 9 and `migrate.test.ts`'s applied-versions array follows. This is not a defect
in the work; it is the cost of a long-running branch, and it is exactly why that file carries two long
comments about branches colliding on a number.

**My `docs/known-issues.md` entry (fix 7) is now obsolete.** main's commit 52c2d6d — "Stub
AbortSignal.timeout rather than asking Node to mock it" — replaced `mock.timers.enable({apis:
['AbortSignal.timeout']})` with a direct stub in a new `test/abort-timeout.ts`, so the three tests no
longer depend on the Node version at all. My entry documents a problem main has fixed by a different and
better route, and it should be dropped in the integration rather than carried.

Worth noting for accuracy, since this branch has been strict about checkable claims: main's new helper
comment asserts "no Node build this project runs on accepts that api name", enumerated against v24.15.0.
That is too broad — I verified empirically that v24.19.0 **does** accept `AbortSignal.timeout` in
`mock.timers.enable`, which is why this branch's suite went green there. Their fix is still the better one
because it is version-independent; only the claim overreaches. Not this branch's business to correct.

Other overlaps, ordinary textual conflicts to resolve at integration: `pipeline/scheduler.ts` (main's
reconcile work vs this branch's `metadata tick failed` reword), `test/db/migrate.test.ts` (the
applied-versions array), `test/clients/theporndb.test.ts` (main's abort-timeout refactor vs this branch's
nine new performer tests).

Presented all of this to the repo owner with the finishing menu rather than choosing an integration path —
the renumber's correct value depends on whether further migrations land first, and a merge, a rebase and a
PR each resolve these differently. Not a decision to take on their behalf.

## Repo owner's instruction: renumber to 9, rebase on local main, run the suite, ask again

Safety ref `pre-rebase2-2026-08-16` tags the pre-rebase tip (2b0f90c). `pre-rebase-2026-08-16` from the
first rebase is still present, so both prior shapes are recoverable.

Renumbered `performer_queue` to `version: 9` with a comment matching the register of the file's two
existing collision notes, and pointing at `assertUniqueVersions`' own instruction — "versions are a total
order, not labels" — as the reason the later arrival moves. Committed, verified green, then rebased.

**Rebase onto main (85639d2): 21 commits replayed, one conflict, resolved.** Only `migrations.ts` conflicted
— main's `version: 8` (`downloads.absent_since`) against this branch's, both appended after 7. Resolved by
keeping both, main's 8 first and `performer_queue` as 9. The three other anticipated conflicts auto-merged
cleanly and I verified each result rather than assuming: `scheduler.ts` kept the `metadata tick failed`
reword (:217); `theporndb.test.ts` holds both main's `stubAbortTimeout` import and this branch's 15
`searchPerformers` references; `migrate.test.ts` merged its applied-versions assertion.

Caught during resolution: my renumber commit's comment claimed "9 with no 8 ... the gap is deliberate".
Post-rebase there **is** an 8 — main's — so versions are contiguous 1-9 and that comment would have been
false. Rewritten during the conflict resolution rather than carried, and the applied-versions array set to
`[1..9]` rather than the `[1..7, 9]` the pre-rebase commit used. That commit then became redundant and was
skipped (`git rebase --skip`), since its whole intent was incorporated correctly upstream of it. Had I
carried it, this branch would have shipped a **fifth** false checkable claim, in the very commit whose
subject is about getting a number right.

**Verified on the rebased result:** `npm ci` exit 0, `npm run check` exit 0 — **929/929 core, 168/168 web**
— and `npm run build` exit 0. Twenty commits on top of main, zero behind.

Now stale, and raised rather than removed unasked: my `docs/known-issues.md` entry about three tests
needing a Node newer than `package.json` asks for. main's commit 52c2d6d replaced `t.mock.timers` with a
direct `stubAbortTimeout` helper, so those tests no longer depend on the Node version at all —
`grep -c 'mock.timers.enable' theporndb.test.ts` is now 0. The entry documents a problem main has already
solved by a better route and should be deleted. Also noticed: main's own change left an *earlier* sentence
in that same file (around line 577) still claiming `t.mock.timers` with `AbortSignal.timeout` "is what
bounds the fetch-timeout tests" — stale for the same reason, and not this branch's to fix.

`origin/feature/performer-search-queue` is now 6 behind / 35 ahead of local — diverged by two rebases — so
any push needs a force the repo owner authorises explicitly.

## Landed

Repo owner chose: delete the stale `docs/known-issues.md` entry **and** fix the earlier sentence main's own
change had left stale. Done in 24478c1 — the Node-version entry removed (it described a failure that no
longer exists once nothing bounds those tests with `mock.timers`), and the surviving sentence in the
web-timer entry corrected rather than deleted, because the contrast it draws with the web tests is still
the useful part and only its mechanism was out of date.

Then: **merged to main locally, fast-forward.** `worktrees/main` was clean and local `main` was identical to
`origin/main` (0/0), so nothing needed pulling and `--ff-only` guaranteed no surprise merge commit. main
moved 85639d2 → 24478c1, gaining 21 commits.

Verified **on merged main, in its own worktree with a fresh `npm ci`** rather than trusting the feature
worktree's state: `npm run check` exit 0 — **929/929 core, 168/168 web** — and `npm run build` exit 0.

Nothing was pushed. `origin/main` is untouched and now 21 behind local main; pushing that is the repo
owner's call, as is deleting the two `pre-rebase*-2026-08-16` safety tags, which still pin the pre-rebase
shapes and keep those orphaned commits reachable.

This record is committed to `claudedocs/2026-08-14-performer-search-queue/` at the repo owner's direction,
matching what `claudedocs/2026-08-16-reconcile-client-first/` did for the run that landed before it — the
markdown only, since that record commits briefs, reports and the ledger but not review diffs, which git
can regenerate. The gitignored workspace and the feature worktree are removed after this copy.

## Task 7 prep — the plan's last task, and its brief is the worst of the six defects

Anchors all verified and, unusually, all still accurate: `let tpdbClient: (SiteLookupClient &
SceneLookupClient) | undefined;` at main.ts:92 exactly as the brief says; the `runMetadata` branch at
127-157; `createMetadataRunner`'s live argument list at 147-155 (the brief's own citation, correct); the
`metadata: enabled, every Ns, N per tick` log at 156; `client` bound at 136, `pluginFor` at 142,
`artwork` at 137-141. The Task 3 ⚠️ I carried forward is confirmed still outstanding: line 92 must be
widened or nothing can reach `searchPerformers`.

**Ruling: TASK7-A — Task 7's Step 1 is not implementable as written, and I am not authorising a test
harness for the process entry point to make it so.** The brief says to extend `main.test.ts` "following
its existing style — read how that file builds a config and stubs the scheduler ... and reuse those
fixtures". No such fixtures exist. That file is 124 lines and tests three *pure exported helpers*
(`pluginById`, `resolveArtworkDir`, `entryFromArgv`). It builds no config, opens no database, stubs no
scheduler and stubs no fetch. Worse, `main()` is a **non-exported, zero-argument** `async function`
spanning main.ts:60-324 that reads config from disk, opens a real database, uses **global** `fetch`
(main.ts:96, :139) and calls `createScheduler` itself — so a test cannot call it, cannot inject a fetch,
and cannot reach `runMetadata`. The brief anticipated the missing scheduler seam and offered a fallback
— "assert instead on the request paths the fetch stub recorded" — but that fallback depends on the same
absent fixture. Both routes are closed.

Ruled: implement the wiring (Step 3), which is well-specified and verified by typecheck and build; and
pin the one property the brief says is the reason to assert rather than assume — **the order of the two
passes** — by extracting the composition into a tiny exported helper taking the two runners as
arguments, tested with two recording stubs. That needs no config, database, fetch or scheduler. It is
technically "inventing a seam", which the brief forbade, but the prohibition was plainly aimed at
avoiding a large scheduler harness; a four-line pure composition helper is the opposite, and it matches
exactly what `main.test.ts` already is — a file of small exported helpers. The brief's other two tests
(`metadata disabled runs neither pass`, `no provider client runs neither pass`) exercise `main()`'s
branching and stay unreachable; they are deferred as untestable without the refactor, and it is worth
recording *why* that is tolerable: Task 7 adds code only **inside** the existing `else` branch, so both
of those branches are unchanged by this task and their behaviour is preserved by construction.
Cost if wrong: one four-line exported helper that would not otherwise exist, and two branches whose
"does nothing" behaviour rests on the diff not touching them rather than on a test.

**Ruling: TASK7-B — a sixth brief defect: the ordering comment states the opposite of what the code
does.** The brief's comment says "A row enqueued this tick is therefore searched on the next one." It is
searched on the *same* tick. `insertPerformerSearch` sets `next_at = now` (performer-queue.ts, VALUES
(?, ?, 0, ?) with `now` twice), `duePerformerQueue` selects `next_at <= ?`, and each runner captures its
own `deps.now()` = `Date.now()` — so the performer pass's `now` is at or after the scene pass's, the
just-enqueued row is due, and it is drained immediately. Scenes-first therefore produces same-tick
draining, not next-tick. Directing the comment be written to match the code, not the code to match the
comment: same-tick linking is faster and harmless in itself, and changing it would need a deliberate
`next_at` offset, which is a design decision outside this plan. One consequence worth recording, because
the brief's "sharing one cadence keeps the combined request rate predictable" glosses over it: in a
single tick the scene pass may enqueue up to `perTick` rows and the performer pass may then search all
of them, so the worst-case provider requests per tick is the sum of both passes, not `perTick`. For the
final review and the repo owner to judge. Cost if wrong: a comment that is merely accurate instead of
reassuring, and a request-rate characteristic written down rather than discovered under a rate limit.
