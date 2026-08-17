# Final whole-branch review findings — one fix wave

Branch `metadata-requery-button`, commits 7142310..10b686a. Verdict was **not ready to merge**:
the db / route / pipeline half is sound, the SPA half needs work.

Fix all of the following in one pass. Numbering is the review's.

## Important

### 1. A rearmed id polls forever in the most likely outcome of a requery
`packages/web/src/api/useGroupMetadata.ts:255-290`. `stillUnresolved` keeps an id alive for as
long as `sameMetadata(view, snapshot)` holds — no attempt cap, no deadline — and the ladder
saturates at `MAX_DELAY_MS` = 8s. `metadataViewOf` (`views.ts:150-186`) exposes no `fetched_at`,
and `recordMetadataAnswer` (`db/metadata.ts:298-307`) either writes an identical row or, for a
confirmed group whose re-answer is `none`, declines the write entirely. So the *modal* outcomes of
a requery — the provider says the same thing, a `none` group re-settles `none`, a bad confirmation
is re-confirmed identically — all produce a byte-identical view, and the hook then issues one
`GET /api/metadata` every 8 seconds for the life of the mounted route, with the user never told
anything.

`rearmedSnapshotsRef`'s own doc at lines 174-176 claims the id "leaves the map the moment a poll
sees a genuinely different answer" — a termination condition that in the common case never fires.

Give it a bound: N rounds or a wall-clock deadline, after which the snapshot is dropped and
polling stops. Say in the UI or in the comment what the user is left with when the bound is hit.

### 2. A refused requery is indistinguishable from an accepted one, and rearms anyway
`packages/web/src/routes/Browse.tsx:35-38` and `packages/web/src/routes/Picks.tsx:32-35` discard
the response and call `rearmMetadata` unconditionally. A 200 carrying
`{ requeued: 0, unavailable: 1 }` — no ThePornDB key configured, the single most likely refusal —
leaves the user with a button that reported success, no error, no new answer ever, plus the
8-second loop from finding 1.

`MediaCard.tsx:28-31` asserts this cannot happen: "there is no boolean outcome … because there is
no 'landed but was refused' case here — it either reached the server or it did not." The route has
three counters that are exactly that case, so the comment is false.

Check `requeued === 1` before rearming, and surface a refusal through the error path the card
already has. If you instead conclude the silent no-op is right, the comment must be corrected —
but do not leave the comment as written.

### 3. "A requery never unlinks a group's cast" is not guaranteed end to end
`packages/core/src/db/metadata.ts:367-373`: on a re-settle where the upsert does write
(`changes > 0`), `setGroupPerformers` replaces the cast wholesale, and a confirmed answer carrying
`performers === []` makes that a DELETE. This branch is what makes that path user-triggerable on
demand. The pipeline test at `test/pipeline/metadata.test.ts:880-909` asserts the cast survives but
stubs the client to return *the same performer*, so it does not test the guarantee it names.

**Controller ruling (R6) — the scope of your fix here is deliberately narrow.** Do **not** add a
guard to the shared settle path: that would change how the ordinary metadata pass treats every
group, which is beyond this branch and is a decision for the repo owner rather than for us. Do
exactly two things:
1. Make the test honest. It must stop claiming to prove an invariant it does not test. Either
   rename it to what it actually covers, or extend it to assert the real behaviour when a
   confirmed re-answer carries an empty cast — whichever is truthful.
2. Narrow the plan's Global Constraint in
   `docs/superpowers/plans/2026-08-17-metadata-requery-button.md` to what the code actually
   guarantees: `requeueMetadata` does not touch `group_performers`. Add a short note recording
   that a *confirmed re-answer with an empty performer list* will replace the cast through the
   pre-existing settle path, so the narrowing is on the record rather than silently applied.

### 4. The production post-requery sequence is never tested; a broken comparison passes
`packages/web/test/useGroupMetadata.test.tsx:344-354` and `packages/web/test/Browse.test.tsx:657-659`
both stub the answer sequence as `[settled, pending, fresher]`. The real server never emits
`pending` for an already-answered group — `metadataViewOf` short-circuits on the answer row — so
the sequence that actually happens is `[old, old, …, new]`, which neither test exercises. Replace
`sameMetadata` with `() => false` and both tests still pass, because the artificial `pending` keeps
the poll alive, while production regresses to "click does nothing until you reload".

Add a test driving `[original, original, fresher]`. The review called this the single
highest-value addition in the branch. It must fail if `sameMetadata` is broken.

### 5. Rearming before the hook's first answer lands strands the id
`useGroupMetadata.ts:335-342`: with no entry in `metadataRef` no snapshot is stored, so the
generation bump gets `run` to fetch once (`known === undefined`), the settled answer arrives,
`stillUnresolved` is empty, and polling stops — the requery's eventual answer needs a reload. The
window is real: `MediaCard` renders the button from browse's own `metadata`, so it is clickable
before the hook's first `GET` completes, and again for each "Load more" page. The comment at lines
337-339 asserts the opposite. Store a sentinel snapshot so the id stays unresolved.

Note from the review's triage of minor 6: seed that sentinel in a way that does not hand
`sameMetadata` a client-constructed `MetadataView`, because its `JSON.stringify` comparison is only
safe while both operands come from the server's own JSON.

## Minor — fix in the same pass

6. `useGroupMetadata.ts:76-84` quotes `requeueMetadata`'s doc as saying "the answer … never
   changes". That string is not in it. Fix the citation.
7. `packages/web/src/api/client.ts:620-624` claims "a settled group is never in the id list that
   hook builds, so there is no overlap between the two to reconcile" — false: `run`'s filter admits
   every id with `known === undefined`, so on first mount the hook POSTs `/api/metadata/request`
   for settled ids too, which is why the branch's own Browse test stubs
   `alreadyAnswered: body.groupIds.length`.
8. `MediaCard.tsx:190-196` with `styles.css:32`: while the identity form is open on a plugin with
   no Requery button, `(canEdit || settled)` renders an empty `.card-actions` div and 1rem of stray
   margin. The CSS comment claims the rule was checked with either button alone and with both — the
   neither case is the one it misses.
9. `Picks.tsx:32-35` is a verbatim copy of Browse's callback with no test on that route. Cover it,
   or share the callback so there is one implementation to test.
10. `requeryError` is never cleared when a fresher answer arrives, so a failed requery's message
    sits under a card that has since updated.

## From the deferred-minor triage — also fix in this pass

- **Deferred 1 + 4 together:** `requeueMetadata`'s doc comment
  (`packages/core/src/db/metadata.ts:151-178`) states its ids-must-exist precondition but not the
  no-duplicates expectation its `groupIds.length` return depends on — while `views.ts:131-133` and
  `server.ts:773-780` both cite it as that function's documented precondition. One sentence in
  `requeueMetadata`'s doc makes all three agree.
- **Deferred 3:** add `last_error = NULL` to `requeueMetadata`'s `ON CONFLICT ... DO UPDATE` list.
  `dueMetadataQueue` reads `last_error` into `MetadataQueueRow.lastError`, and `attempts = 0`
  beside a stale `ECONNRESET` is a self-contradictory row. **Controller ruling (R7):** this
  departs from the literal SQL the plan's Task 1 dictated; the plan text is superseded here.

## Explicitly NOT in scope

- A bulk requery. Deliberately excluded by the plan.
- A guard in the shared settle path (see R6 above).
- The `O(n²)` `stillUnresolved.includes` noted in minor 10's second half — the review itself called
  it irrelevant at Picks' scale. Leave it unless your bound from finding 1 makes it trivial to
  drop.
- The two unreproducible web-suite failures. No cause was found across three independent
  investigations and eight consecutive clean runs. Do not go hunting.
