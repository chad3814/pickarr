# SDD ledger — plan: docs/superpowers/plans/2026-08-17-metadata-requery-button.md

Spec: none written (bounded change, design approved in chat 2026-08-17 and
transcribed into the plan's Why / Global Constraints / Out of scope sections).
Rulings below are therefore made against the plan text as the binding authority.

BASE for Task 1: 71423105b8169ce10af2315c1702089b04e5a894

## Pre-flight conflict scan

### Task pairs sharing a file or an interface

| Pair | Produces → consumes | Found |
|---|---|---|
| T1 → T2 | `requeueMetadata(db, ids, now): number` in `db/metadata.ts` → called once by the requery route, its return value becomes `requeued` | Agrees. T1 returns a count, T2 reports a count. |
| T1 → T2 | T1 assumes ids exist; T2 filters `missing` via `getGroup` before calling | Agrees, and the division is stated in both task texts. No double check, no gap. |
| T2 → T3 | `MetadataRequeryResponse` (4 counters) in `http/server.ts` → mirrored in `web/src/api/client.ts` | Agrees. Same four field names in both task texts. |
| T1 ↔ T3 | none — T1 is `packages/core/src/db`, T3 is `packages/web/src` | No shared file or interface. |
| T1 ↔ T2 test files | `test/db/metadata.test.ts` vs `test/http/metadata.test.ts` | Different files; no collision. See Ruling R1 for the one test whose home is ambiguous. |
| all | `enqueueMetadata`, `insertPerformerSearch`, the settle upsert | All three are read-only for this plan; Global Constraints forbid changing them. No task text proposes touching any. |

### Task self-consistency

| Task | Own text vs. own tests | Found |
|---|---|---|
| T1 | 4 behaviours described, 4 tests specified, one per behaviour | Consistent. |
| T2 | 4 ordered branches described, tests cover all 4 plus the cap plus 2 end-to-end cases | Consistent. Branch order matches the neighbouring route's existing order (missing → unavailable → unaskable). |
| T3 | 4 UI behaviours described, 4 tests specified | Consistent. Button-visibility rule ("settled only") does not collide with the lazy trigger, which handles the unsettled case. |

### Rulings from the scan

- **Ruling R1** — the end-to-end `performer_queue` tests in Task 2 may live in
  `packages/core/test/pipeline/metadata.test.ts`, where every existing
  `runMetadataPass` test already lives, rather than in `test/http/metadata.test.ts`.
  The route's own counter tests stay in the http file. Why: `runMetadataPass` needs a
  stubbed client and pass deps that the http tests do not build, and duplicating that
  harness into the http file to satisfy a filename would be the worse code. Cost if
  wrong: two tests sit one directory from where a reader might look first; moving them
  is a cut and paste.
- **Ruling R2** — Task 2 reuses `metadataRequestBodySchema` rather than declaring a
  second schema, since the body is identical (`{ groupIds }` capped at
  `MAX_PAGE_LIMIT = 100`). This is how the plan's "reuse the existing constant"
  constraint is satisfied most directly. Cost if wrong: if the two routes' bodies ever
  diverge, the shared schema has to be split into two — a rename and one new object.

## Progress

Task 1: implemented (commit ca36c98, `db/metadata.ts` +56, `test/db/metadata.test.ts` +59).
Controller re-verified independently rather than trusting the report: lint 0, typecheck 0,
test:server 1112/1112, test:web 192/192, and the src diff references `group_performers` /
`group_metadata` only inside comments. The implementer's "192/192 full npm test" phrasing
conflated the web count with the whole suite; the underlying claims hold.
Implementer raised two open judgment calls (return value is `groupIds.length` rather than a
written-row count; no mixed-batch test) — both handed to the task reviewer to rule on rather
than pre-judged.
Task 1: task review dispatched (sonnet) — package review-7142310..ca36c98.diff.
Task 1: review returned spec ✅, quality Approved, 0 Critical / 0 Important, 3 Minor.
Task 1: minor (deferred): duplicate-id assumption behind the `groupIds.length` return is not
  stated in the doc comment, only in the task report — the "counters sum to ids sent"
  constraint depends on it.
Task 1: minor (deferred): no mixed-batch test (one answered + one in-backoff group in a single
  call). Reviewer's judgment: low risk, SQL is per-row uniform with no shared state. Carried
  into Task 2's dispatch, where the endpoint's mixed-case test exercises a real multi-row batch.
Task 1: minor (deferred): `DO UPDATE SET` resets `attempts` and `next_at` but not `last_error`,
  so a freshly requeued row can carry a stale error string. Matches the SQL the brief dictated
  verbatim, so not a defect in execution. Only matters if a later task surfaces `last_error` in
  the UI — Task 3 does not, so it stays deferred.
Task 1: complete (commits 7142310..ca36c98, review clean)

BASE for Task 2: ca36c982f61ea809a79b4d60e508c860b9ef66b4

Task 2: implemented (commit a93ea95; `http/server.ts` +68, `http/views.ts` +34,
`test/http/metadata.test.ts` +145, `test/pipeline/metadata.test.ts` +59). Controller
re-verified: lint 0, typecheck 0, test:server 1120/1120 (+8 over Task 1), test:web 192/192.
Implementer raised two deviations from the plan text; both ruled on below rather than sent
into the fix loop, because in each case the plan text was the thing that was wrong.

- **Ruling R3** — the four counters sum to the number of *distinct* ids sent, not the raw
  array length, because the route dedups up front. The plan said "counters sum to the number
  of ids sent". Ruled for the implementation: Task 1's `requeueMetadata` returns
  `groupIds.length` and has no dedup, so a repeated id would otherwise inflate `requeued`
  past the rows actually written — a worse break of the same invariant than the one the plan
  literally asked for. The plan's stated purpose for the constraint ("a caller must be able
  to tell accepted from discarded") is preserved for every distinct id. Cost if wrong: a
  client that sends the same id twice sees a total below its array length. Negligible in
  practice — the button sends one id per click, and `useGroupMetadata` already batches from a
  Set.
- **Ruling R4** — the plan's "a request that mixes all four cases" is unachievable as
  written: `metadataAvailable` is a server-wide flag rather than a per-id fact, so
  `unavailable` cannot coexist with `unaskable` or `requeued` in one request. This is a defect
  in my plan text, not in the implementation. Ruled: coverage splits across two tests, which
  is how the existing `/api/metadata/request` tests already handle the same limitation. Cost
  if wrong: none material — the sum invariant is still asserted, just not in a single test.

Task 2: task review dispatched (sonnet) — package review-ca36c98..a93ea95.diff.
Task 2: review returned spec ✅, quality Approved, 0 Critical / 0 Important, 2 Minor. Reviewer
  independently endorsed R3 and R4 after checking `requeueMetadata`'s real contract and
  `ServerDeps.metadataAvailable`'s actual shape, and confirmed the two end-to-end tests assert
  on `duePerformerQueue` / `performersForGroups` state rather than on a log line.
Task 2: minor (deferred): `views.ts` doc comment calls the no-duplicates expectation
  `requeueMetadata`'s "precondition", but that function documents only an *existence*
  precondition and would tolerate duplicates (it would merely over-report). The dedup is this
  route's own convention. Pairs with Task 1's first deferred minor — fixing either one should
  settle the wording in both places.
Task 2: minor (deferred): `task-2-report.md` misquotes `requeueMetadata`'s docstring. Report
  only, not the shipped diff.
Task 2: complete (commits ca36c98..a93ea95, review clean)

BASE for Task 3: a93ea952f8f8fe8241f01047d0cafc446e36ab7e

Task 3: implemented (commit a6d5b4c; `client.ts` +46, `MediaCard.tsx` +145/-35, `styles.css` +5,
`MediaCard.test.tsx` +130). Controller re-verified: lint 0, typecheck 0, test:server 1120/1120,
test:web 197/197 across 5 consecutive runs — the implementer's unreproduced 196/197 did not recur.
Task 3: controller confirmed a defect by reading the render paths before dispatching review — the
  poster (`MediaCard.tsx:224`) and the whole title/synopsis/performers block (`:284`) are gated on
  `state === 'confirmed'`, so adopting a `pending` refetch blanks the card.
Task 3: task review dispatched (sonnet) — package review-a93ea95..a6d5b4c.diff.
Task 3: review returned spec ❌ — 2 Critical, 1 Important, 0 blocking Minor. Reviewer independently
  confirmed the blanking defect and judged it the likely production outcome rather than an edge case,
  and further found that none of the five new tests would fail against it (197/197 passes with the
  bug present).

- **Ruling R5** — the fix removes the direct `api` calls from `MediaCard` rather than taking the
  reviewer's suggested minimal guard. Reasoning: the reviewer identified the leaf's direct `api`
  access as the *cause* of the Critical, and the minimal guard (discard a less-settled answer) would
  satisfy the "no blanking" constraint while leaving the feature almost pointless in practice — the
  worker tick is 5s, so a click would show the user nothing, ever, without a manual reload, and the
  approved design promised "a fast answer appears without a reload". The house pattern for a card
  action already exists and is used three times over (`onPick`, `onEditGroup`, `onEditRelease`): the
  route owns the call, the card takes a callback. Routing the requery the same way lets the existing
  route-level poller in `useGroupMetadata` re-arm the id, which is machinery already written and
  tested (backoff, `nextAttemptAt`), instead of a second uncoordinated poller in a leaf. Cost if
  wrong: the fix touches `Browse.tsx`, `Picks.tsx` and `useGroupMetadata.ts`, which the Task 3 brief
  did not list, so it is a wider diff than the brief scoped and it risks disturbing the polling that
  every card depends on. That risk is why the re-review is scoped to the fix diff and why the
  existing 192 web tests have to stay green.

Task 3: fix round 1/5 dispatched to the original implementer (context intact), findings sent
  verbatim with ruling R5 as the binding approach.
Task 3: fix round 1/5 returned commit 10b686a — `useGroupMetadata.ts` +174, `MediaCard.tsx` +81/-,
  `Browse.tsx` +18, `Picks.tsx` +16, plus tests in `Browse.test.tsx` +110, `MediaCard.test.tsx`
  ±134, `useGroupMetadata.test.tsx` +83. Controller re-verified: lint 0, typecheck 0, test:server
  1120/1120, test:web 200/200 across 3 consecutive runs, and `MediaCard.tsx` now has a type-only
  import from `client.ts` with zero `api.` call sites. Implementer reports the new tests fail
  against pre-fix a6d5b4c (12 failures), which the scoped re-review was asked to judge rather than
  accept on faith.
Task 3: two new self-reported concerns carried into the re-review — (a) re-arming bumps a
  `generation` counter that restarts the whole poll effect, aborting an unrelated id's in-flight
  fetch and resetting its ladder, claimed as timing-only with no correctness change; (b)
  `sameMetadata` compares via `JSON.stringify` rather than a deep equal.
Task 3: scoped re-review dispatched (sonnet) — package review-a6d5b4c..10b686a.diff.
Task 3: fix round 1/5 (3 addressed, 0 open; commits a6d5b4c..10b686a). Re-reviewer verified the
  two regression tests against the pre-fix source with `git show a6d5b4c:...` rather than accepting
  the 12-failure claim, and confirmed both reproduce the actual defect shape rather than an
  incidental API mismatch. Part 2 found no new Critical/Important breakage: every new branch in
  `useGroupMetadata` is provably inert for an id never rearmed, and `generation` never changes on a
  page that never rearms, so the effect's dependency array behaves as before.
Task 3: minor (deferred): re-arming bumps `generation`, restarting the poll effect, so an unrelated
  id mid-poll has its in-flight fetch aborted and its backoff ladder reset to `START_DELAY_MS`.
  Re-reviewer confirmed no answer is lost and no id is left unwatched (`metadataRef` survives the
  restart and `run()` recomputes from it), so this is timing-only. An accepted consequence of R5's
  "reuse the machinery, no second poller" instruction.
Task 3: minor (deferred): `sameMetadata` uses `JSON.stringify` rather than a deep equal. Safe for
  `MetadataView`'s current fixed-key-order shape; if an array field ever gained non-deterministic
  ordering the only failure is stopping one poll early on semantically identical content, which
  `commit()`'s independent rank guard keeps from blanking or downgrading anything.
Task 3: complete (commits a93ea95..10b686a, review clean)

All three tasks complete. Dispatching the final whole-branch review (opus, most capable) over
merge-base 7142310..10b686a, pointed at the seven deferred minors above.

Final review returned **not ready to merge**: 5 Important, 5 Minor. It endorsed R1-R5 with the whole
branch visible. The db / route / pipeline half is sound; the SPA half is where the problems are.
Headline findings: a rearmed id polls every 8s forever in the *modal* outcome of a requery (the
answer is byte-identical, so the termination condition never fires); a refused requery
(`requeued: 0, unavailable: 1` — no TPDB key) reports success and rearms anyway, under a comment
claiming that case cannot exist; and the two re-arm tests stub a `pending` answer the real server
never emits for a settled group, so `sameMetadata` could be replaced with `() => false` and both
still pass while production regresses to "click does nothing until you reload".

- **Ruling R6** — finding 3 (a confirmed re-answer carrying an empty performer list replaces the cast
  through the pre-existing settle path, `db/metadata.ts:367-373`) is real, and this branch is what
  makes it user-triggerable on demand. Ruled: do **not** guard the shared settle path — that changes
  how the ordinary metadata pass treats every group, which is outside this branch and is Chad's call,
  not mine. Instead the dishonest test gets corrected and the plan's Global Constraint is narrowed to
  what the code actually guarantees (`requeueMetadata` does not touch `group_performers`), with the
  real behaviour recorded rather than silently assumed away. Cost if wrong: the shipped button can
  still replace a curated cast in one specific case — a confirmed re-answer with an empty cast — and
  that now stands as a known, documented behaviour instead of a fixed one. This is the one finding I
  am surfacing to Chad as a decision rather than closing myself.
- **Ruling R7** — add `last_error = NULL` to `requeueMetadata`'s `DO UPDATE` list, superseding the
  literal SQL the plan's Task 1 dictated. `dueMetadataQueue` reads `last_error` into
  `MetadataQueueRow.lastError`, so `attempts = 0` beside a stale `ECONNRESET` is a self-contradictory
  row. Cost if wrong: a requeued row loses the text of the failure that preceded it, which nothing
  currently displays.

Findings written to `final-review-findings.md`. ONE fix wave dispatched (opus) per the skill's
no-second-wave rule, with the not-in-scope section made as binding as the fixes.

Fix wave returned two commits — 5889d3d (core/db, pipeline test, plan doc) and 1003ba7 (the SPA
half) — claiming all 13 items addressed. Controller re-verified: lint 0 with 93 warnings matching
the pre-branch baseline and no new warning signatures, typecheck 0, test:server 1124/1124 (+4),
test:web 207/207 (+7) across 3 consecutive runs. The finding-1 bound is `REARM_WATCH_MS`, a
two-minute wall-clock deadline **per press**; when it lapses the card keeps its current answer,
polling stops, and the still-rendered button is the way out. New `web/test/requeryMetadata.test.ts`
is a `.ts` file, so it runs in the server suite per the existing `format.test.ts` convention —
that accounts for the +4/+7 split.

Scoped re-review of the fix wave dispatched (opus) — package review-10b686a..1003ba7.diff. It was
asked to verify finding 4's test property by reading the assertions rather than trusting the
implementer's experiment, and to confirm ruling R6 was neither undershot nor exceeded (no guard
added to `recordMetadataAnswer` / `setGroupPerformers`).

Fix-wave re-review: **ready to merge.** All 5 Important, 5 Minor and 3 promoted-deferred items
ADDRESSED with anchors. It verified finding 4's property by construction rather than on the
implementer's word — with `sameMetadata` forced to `() => false` the watch ends on call 2 and the
fresher-title `waitFor` times out — and confirmed the deadline test is non-vacuous in the other
direction too. R6 landed exactly on its line: `recordMetadataAnswer` / `setGroupPerformers` are
byte-identical to 10b686a, the overclaiming test is renamed and given an honest counterpart that
asserts the empty-cast re-confirm really does DELETE the cast, and the plan constraint is narrowed
with the real behaviour recorded. No regression to the shared `useGroupMetadata` path: `stillWatching`
reproduces the old pending semantics exactly and the sweep is a no-op delete for non-rearmed ids.

Three residual observations, none blocking, all parked rather than fixed — the skill allows no second
fix wave:

- Task 3: parked — a refusal message can auto-clear within ~8s in a narrow second-press scenario
  (`MediaCard.tsx:105-107` keys on view object identity, and `commit` installs a fresh object per
  response even when byte-identical). **Ruling:** real and cosmetic. The reason flashes and vanishes;
  no data is misrepresented and nothing breaks. Fixing it means keying on content rather than
  identity, which is a behaviour change to error display that Chad should choose. Cost if wrong: a
  user who trips a network blip on a second press may not read why it failed, and presses again.
- Task 3: parked — the 2-minute watch can be cut short by a co-pending group in the same poll, since
  `serverDelayFor` can sleep up to `MAX_SERVER_DELAY_MS` (5 min); background-tab throttling does the
  same. **Ruling:** acceptable, and inherent to sharing one poll loop, which is what R5 chose. A
  fresher answer arriving on that poll is still committed; otherwise the recourse is a second press
  or a reload, which is the documented behaviour. Cost if wrong: on a busy Picks page a requery may
  need a second press to be seen.
- Task 3: parked — the plan doc was untracked at branch head and this wave adds it whole (192 lines)
  as a new tracked file. **Ruling:** intended. It is the branch's design record and belongs in git,
  matching `docs/superpowers/plans/` for every prior feature.

Final: all tasks complete, final review clean after one fix wave. Artifacts copied to
`claudedocs/2026-08-17-metadata-requery-button/`, matching the convention the
`2026-08-14-performer-search-queue` feature already set in this repo, before the scratch workspace
is removed.
