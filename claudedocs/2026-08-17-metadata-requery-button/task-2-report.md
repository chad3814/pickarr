# Task 2 report — `POST /api/metadata/requery`

## What was implemented

- `MetadataRequeryResponse` added to `packages/core/src/http/views.ts`, next to
  `MetadataRequestResponse`, with a doc comment explaining why it has four
  counters instead of five (being answered is this route's precondition, not
  something it refuses) and why `unaskable` exists as its own counter rather
  than folding into anything `answerUnaskable` would imply.
- `POST /api/metadata/requery` added to `packages/core/src/http/server.ts`,
  immediately after `POST /api/metadata/request`. It:
  1. Parses the body with the *same* `metadataRequestBodySchema` `/request`
     already uses (R2) — no second schema was declared.
  2. Dedupes the incoming `groupIds` with a `Set` before classifying anything
     (see "Decision the brief did not settle" below).
  3. For each unique id, in order: `getGroup` null → `missing`;
     `!deps.metadataAvailable` → `unavailable`; `metadataAnswerability(...) ===
     'unaskable'` → `unaskable` (deliberately *not* calling `answerUnaskable`,
     per the brief); otherwise collected into `askable`.
  4. Calls `requeueMetadata(db, askable, now)` once and assigns its return
     value directly to `result.requeued`.
- No changes to `enqueueMetadata`, the existing `/api/metadata/request` route,
  `group_performers`, or the settle upsert's `WHERE` guard. Grepped the diff
  to confirm `group_performers` is untouched by this task's changes.

## Decision the brief did not settle: deduping the input list

Task 1's brief note states `requeueMetadata` has no per-id existence check and
no dedup, and returns `groupIds.length` directly, so "a duplicate id in the
list would inflate the `requeued` counter and break the 'counters sum to ids
sent' constraint," and that avoiding both is Task 2's job.

Working through the arithmetic: if a duplicate id is *not* deduped and both
occurrences are classified consistently (they always are — existence,
`metadataAvailable`, and answerability are stateless per id, unlike
`enqueueMetadata`'s `waiting` check), then `requeueMetadata([id, id, ...])`
returns `2`, and the raw-body-length sum invariant technically still holds:
each of the two array *positions* landed in a counter. The real defect a
duplicate causes is semantic, not arithmetic: `requeued` would overstate how
many *distinct* groups were actually touched (`requeueMetadata`'s own doc
comment calls its return "how many groups will be asked again").

Given Task 1's explicit instruction to keep duplicates out of the list handed
to `requeueMetadata`, and given that a client button legitimately sending the
same id twice in one call is not a case this feature needs to support, I
deduped the request's `groupIds` once, up front, before any classification —
treating a repeated id as one id from the caller's perspective. Counters then
honestly sum to the number of *distinct* ids in the request, not the raw
array length. This is documented in `MetadataRequeryResponse`'s doc comment
and covered by a dedicated test (below). I flag this because the brief's
literal wording — "every id lands in exactly one counter" — could be read
either way (array position vs. distinct id), and I chose the distinct-id
reading to satisfy Task 1's precondition without inventing a fifth counter.

## On R2 (reusing `metadataRequestBodySchema`)

No reason found for the two bodies to differ — both are "a page's worth of
group ids," and the id cap the brief specifies is explicitly "the same cap the
neighbouring routes use." Reused as instructed.

## Test coverage

### `packages/core/test/http/metadata.test.ts` (route/counter tests, run standalone: 30/30 pass)

- `a settled group is requeried and its group_metadata row is untouched` —
  covers brief bullet 1.
- `missing, unaskable and requeued ids are each counted, and the counters sum
  to the ids sent` — sends one askable id, one no-hooks (unaskable) id, and one
  nonexistent id in a single request; asserts the exact counter object and the
  sum. Also asserts the unaskable id is *not* answered (`getGroupMetadata` is
  `undefined`), directly testing the "do not call `answerUnaskable`" rule.
  Note: `unavailable` cannot join this same request, because
  `deps.metadataAvailable` is a server-wide flag, not per-id — the same
  limitation `/api/metadata/request`'s own equivalent branch has. I documented
  this in the test and covered `unavailable` in a separate test instead,
  mirroring how the existing `/request` tests already split "unavailable"
  into its own test rather than mixing it with `queued`/`missing`. I flag this
  because the brief literally says "a request that mixes all four cases,"
  which is not achievable in one HTTP call given this (inherited) design.
- `metadata unavailable server-wide: the requery endpoint does not requeue` —
  covers the `unavailable` counter, and additionally asserts the standing
  `confirmed` answer is undisturbed.
- `a duplicate id in a requery is requeued once, not double-counted` — direct
  regression test for the dedup decision above.
- `an oversized id list is refused for requery too` and
  `a malformed requery body is refused` — cover the cap and malformed-body 400s.

### `packages/core/test/pipeline/metadata.test.ts` (R1 end-to-end tests, run standalone: 24/24 pass)

- `a group requeried after settling none with no cast ends up with a
  performer_queue row` — settles a group directly via `recordMetadataAnswer`
  (simulating a group answered before a queue row ever existed for it, so
  there is no pre-existing `performer_queue` row either), calls
  `requeueMetadata`, runs `runMetadataPass` with a client that matches
  nothing, and asserts the resulting `performer_queue` row — this is the
  brief's required "assert on the queue row, not a log line."
- `a group requeried after settling with a cast gains no performer_queue row,
  and keeps its cast` — settles with a cast, requeries, runs the pass again
  with a client that reconfirms the same cast, and asserts both that
  `performer_queue` stays empty (`groupHasCast` still refuses it) and that the
  cast is still linked afterward via `performersForGroups`.

These two tests are freshly written for this task (not reused from an
existing case), so they do not by themselves close Task 1's deferred
"mixed batch" minor (one already-answered group + one in-backoff group in a
single `requeueMetadata` call) — that scenario is about `requeueMetadata`
itself handling a batch with mixed starting states, which none of my new
tests exercise (mine each use a single group). I did not add a test for it
since it was explicitly noted as deferred to a separate tracked item, not
assigned to Task 2.

## Verification run at commit time

- `npm run lint` — exit 0; only pre-existing warnings in files this task did
  not touch (`no-await-in-loop`, `preserve-caught-error`, etc.), no errors, no
  warnings in `server.ts`/`views.ts`/either test file.
- `npm run typecheck` — clean across all workspaces.
- `npm test` — `1120` server tests pass (0 fail), `192` web tests pass (0 fail).
  The two targeted files were also run standalone: `http/metadata.test.ts`
  30/30, `pipeline/metadata.test.ts` 24/24.

## Things I am not fully certain about

- Whether the dedup-before-classification reading above is what the plan's
  author intended, versus a design that adds a fifth counter (e.g.
  `duplicate`) or otherwise handles repeats differently. I judged dedup-and-
  silently-treat-as-one to be the simplest reading consistent with Task 1's
  instruction and did not find a place in the brief that contradicts it, but
  it is a judgment call, not something the brief states outright.
- The "mixes all four cases" test wording — addressed above by splitting
  `unavailable` into its own test, matching the existing `/request` route's
  own test structure, since the server-wide flag makes literal one-request
  mixing of all four impossible.
