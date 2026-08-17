# Final fix wave — report

Branch `metadata-requery-button`, one pass over
`.superpowers/sdd/2026-08-17-metadata-requery-button/final-review-findings.md`.
All 5 Important, all 5 Minor and all 3 promoted-deferred items are addressed. Nothing in the
"explicitly not in scope" section was touched.

## Verification

| Gate | Result |
| --- | --- |
| `npm run lint` | exit 0, **93 warnings — identical to the branch-head baseline** (measured by `git stash push -u` → lint → pop). No new warning, by file+rule signature. |
| `npm run typecheck` | exit 0. |
| `npm run test:server` | **1124/1124** (baseline 1120 + 3 new `requeryMetadata.test.ts` + 1 new pipeline test). |
| `npm run test:web` | **207/207**, three consecutive runs, all green (baseline 200 + 3 hook + 2 MediaCard + 1 Browse + 1 Picks). **Stable** — no flake, no test-ordering effect, and none of the two unreproducible failures the findings warned about appeared. |

Note on suite placement: `packages/web/test/requeryMetadata.test.ts` is a `.ts` file, so it runs in
the **server** suite — that is the existing repo convention (`packages/web/test/format.test.ts`
does the same). `test:web`'s glob is `*.test.tsx` only, and this test has no DOM.

## The `sameMetadata` experiment (finding 4)

`sameMetadata` was temporarily replaced with `return false;` and both affected suites were run.

Before (with the real `sameMetadata`), `useGroupMetadata.test.tsx`:

```
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

After (`sameMetadata` → `() => false`), same file:

```
✔ rearm re-polls a settled id rather than leaving it unwatched, and never shows it as less settled than it already was
✖ a rearmed id polls through an unchanged answer and lands the fresher one — the sequence the real server emits
✖ a rearm gives up after its deadline instead of polling an unchanged answer forever, and a second press re-arms it
ℹ tests 11
ℹ pass 9
ℹ fail 2
```

And `Browse.test.tsx` under the same break:

```
✔ clicking Requery re-arms the poll end to end: no blanking on a pending answer, and a fresher one lands without a reload
✖ clicking Requery survives the answer sequence the real server emits: the same answer, then a fresher one
ℹ tests 21
ℹ pass 20
ℹ fail 1
```

This confirms the finding exactly: the **pre-existing** `[settled, pending, fresher]` tests pass
with the comparison broken outright (the artificial `pending` keeps the poll alive on its own),
while the two new `[original, original, fresher]` tests fail. `sameMetadata` was then restored from
a pre-experiment copy and the file re-verified (`JSON.stringify(a) === JSON.stringify(b)` present,
11/11 passing again).

Two more negative checks were run the same way, because a test that cannot fail is worthless:

- Reverting `.card-actions` to `(canEdit || settled)` and emptying the new `useEffect` →
  `MediaCard.test.tsx` 33/35, with exactly the two new tests failing.
- Reverting `rearm` to the old "only snapshot when an answer exists" →
  `useGroupMetadata.test.tsx` 10/11, with exactly the finding-5 test failing.

## Important

### 1. A rearmed id polls forever — bounded

**Bound chosen: a wall-clock deadline of two minutes per press** (`REARM_WATCH_MS` in
`packages/web/src/api/useGroupMetadata.ts`), captured at the moment of the rearm and checked when
each poll's answer lands. A round cap was the alternative and was rejected in the comment: the
ladder's steps are unequal (500ms → 8s), so "N rounds" means a different amount of wall-clock
patience depending on how many steps preceded the cap.

Implementation: `rearmedSnapshotsRef` now maps an id to a `RearmedWatch { baseline, until }`
instead of a bare `MetadataView`. `poll`'s filter (now the named `stillWatching`) drops an id whose
`Date.now() >= watch.until`, and the pre-existing sweep loop below it deletes the map entry — so no
new bookkeeping and no second poller.

**What the user is left with when the bound is hit:** the card keeps showing the answer it already
had (nothing blanked, nothing claimed to have changed), polling for that id stops, and the Requery
button — which is still rendered, since the group is still settled — is the way out: a second press
stores a fresh baseline and a fresh deadline. The bound is therefore per press, not per session.
A fresher answer written after the deadline lapsed appears on the next reload or the next press.
This is stated in `REARM_WATCH_MS`'s doc comment; no new UI was added for it (the hook's whole
interface is the map, and giving it a "gave up" channel would mean a new per-id state threaded
through both routes and the card — out of proportion to the finding).

`rearmedSnapshotsRef`'s own doc no longer claims the only exit is "a poll sees a genuinely
different answer"; it names both exits and says the deadline is the *ordinary* one.

Two web tests cover it (bound reached, then a second press lands the fresher answer).

### 2. A refused requery is now distinguishable, and does not rearm

New `packages/web/src/api/requeryMetadata.ts` exports `requeryOneGroup(groupId, rearm)`: it reads
the response counters, and on `requeued === 0` throws a message naming the reason
(`unavailable` → "no metadata provider is configured", `unaskable` → "its plugin builds no metadata
query for it", `missing` → "This group no longer exists", plus a fallback for counters that do not
add up). `rearm` runs only on `requeued > 0`. The card's existing catch renders the message, so the
refusal reaches the user through the channel that already existed.

`MediaCard`'s `onRequeryMetadata` doc no longer says there is no "landed but was refused" case; it
says the opposite, and names `requeryOneGroup` as what converts it into a rejection.

Covered by `packages/web/test/requeryMetadata.test.ts` (4 refusal shapes + accept + transport
failure), each asserting that nothing was rearmed and that the call did reach the server.

### 3. The cast guarantee (controller ruling R6 — narrow, no settle-path guard)

No guard was added to the shared settle path. Exactly the two permitted things were done:

1. `packages/core/test/pipeline/metadata.test.ts`: the mis-named test is now
   *"a requery re-answered with the same cast keeps it linked and gains no performer_queue row"*
   — scoped to what its stub actually does — with a comment saying it does **not** prove the broader
   invariant and pointing at its honest counterpart. That counterpart is a new test,
   *"a requery re-confirmed with an empty cast replaces the cast, through the pre-existing settle
   path"*, which asserts the real behaviour I verified by running it: the empty cast in the fresh
   answer **replaces** the old one (`setGroupPerformers([])` is a DELETE), and the now-castless
   group **does** get a `performer_queue` row, because `enqueuePerformerSearch` runs after the
   answer is written and `groupHasCast` is false by then. Both assertions passed as written on the
   first run, so this is observed behaviour, not a guess.
2. `docs/superpowers/plans/2026-08-17-metadata-requery-button.md`: the first Global Constraint is
   narrowed to "**`requeueMetadata` does not touch `group_performers`**", dated, with an explicit
   "what does not hold" paragraph recording the confirmed-re-answer-with-empty-cast case, that it
   is pre-existing shared-settle-path behaviour this branch only makes user-triggerable, that
   guarding it is deliberately out of scope, and which test pins it.

The plan doc was untracked at branch head; it is committed here (every other file under
`docs/superpowers/plans/` is tracked, and the narrowing is worthless uncommitted).

### 4. The production post-requery sequence is now tested

Two new tests drive `[original, original, fresher]`:

- `packages/web/test/useGroupMetadata.test.tsx` — *"a rearmed id polls through an unchanged answer
  and lands the fresher one — the sequence the real server emits"*.
- `packages/web/test/Browse.test.tsx` — *"clicking Requery survives the answer sequence the real
  server emits: the same answer, then a fresher one"*.

Both fail with `sameMetadata` broken (output above). The existing `[settled, pending, fresher]`
tests were kept — they cover the never-blank defence — but both now carry a comment saying the
`pending` is defensive and never emitted by the server, and Browse's inline fetch stub was
extracted into `serveSettledGroup(answers)` so the two tests differ in nothing but the sequence.

The hook's `Consumer` gained `title-<id>` lines: a requery's answer is `confirmed` before and
after, so `state` alone cannot tell a fresher answer from the one it replaced.

### 5. Rearming before the hook's first answer no longer strands the id

`rearm` now always stores an entry. With no known answer it stores a **sentinel** —
`baseline: undefined` — and the first answer a poll sees *becomes* the baseline (that answer is the
pre-requery one the server is still reporting). Per the review's note on minor 6, no fabricated
`MetadataView` is handed to `sameMetadata`: the baseline is always server JSON, which is the only
condition under which its `JSON.stringify` comparison is safe. `sameMetadata`'s own doc now says so.
The comment that asserted the opposite is gone.

Covered by *"rearming before the hook has any answer of its own still watches the id"*, which holds
the first `GET` in flight until the rearm's effect re-run aborts it.

## Minor

6. `useGroupMetadata.ts`'s `serverDelayFor` doc no longer quotes a string that is not in
   `requeueMetadata`'s doc. It now quotes what is there ("does not read or write
   `group_metadata`") and adds the second half of the reason, which I verified by reading
   `views.ts`: `metadataViewOf` short-circuits on the answer row, so a group with an answer never
   reads back as `'pending'` whatever its queue row says.
7. `client.ts`'s `requeryMetadata` doc no longer claims settled ids are absent from the hook's
   list. It now says settled ids *do* reach `POST /api/metadata/request` (the hook asks about every
   id it has not resolved, which on first mount is all of them) and that the server refuses them as
   `alreadyAnswered` — which is why the branch's own Browse test stubs exactly that.
8. `MediaCard`'s actions row is now gated per *button*: `((canEdit && !editing) || settled)`. The
   empty-div-plus-margin case (identity form open, no Requery button) can no longer render. The
   `styles.css` comment now says the empty case is not that rule's problem because the div is only
   rendered when a button is going in it. New MediaCard test, asserted on the node with
   `=== null` rather than `assert.equal(node, null)` — the #40 trap applies to DOM nodes too.
9. Picks' callback is no longer a copy: both routes now delegate to `requeryOneGroup`, so there is
   one implementation and one place to test it. In addition, a Picks route test proves the wiring
   (the prop reaches the card and the id sent is that card's, not the first group's) — layered over
   the file's existing `serve()`, whose blanket POST branch would otherwise swallow the requery.
10. `requeryError` is cleared by a `useEffect` keyed on the `metadata` view object, which is the
    parent map's identity for "a new answer arrived". New MediaCard test. The `O(n²)`
    `stillUnresolved.includes` was left alone as instructed — the bound did not make it trivial to
    drop, since the sweep still has to distinguish "resolved this round" from "still watched".

## From the deferred-minor triage

- **Deferred 1 + 4:** `requeueMetadata`'s doc now states the no-duplicates expectation and why it
  matters (the return value is `groupIds.length`, not rows touched, so a repeated id would inflate
  the count), and names the endpoint that dedups for it. `views.ts` and `server.ts` now cite a
  precondition that is actually written down.
- **Deferred 3 (controller ruling R7):** `last_error = NULL` added to `requeueMetadata`'s
  `ON CONFLICT ... DO UPDATE`, with a doc paragraph on why (`attempts = 0` beside a stale
  `ECONNRESET` is a self-contradictory row). The existing db test was extended and renamed; it
  asserts `null` (not `undefined`) because `maybeStr` folds a NULL column to `null` — the first
  spelling failed, which is how I know the assertion is real. The plan's Task 1 SQL was updated
  in place with a dated note recording that this supersedes the literal SQL it had dictated.

## Not in scope — untouched

No bulk requery. No guard in the shared settle path. The `O(n²)` `includes` left as-is. No hunt for
the two unreproducible web failures (which did not appear across three full runs plus many
per-file runs).

## Files changed

Core: `packages/core/src/db/metadata.ts`, `packages/core/test/db/metadata.test.ts`,
`packages/core/test/pipeline/metadata.test.ts`,
`docs/superpowers/plans/2026-08-17-metadata-requery-button.md`.

Web: `packages/web/src/api/requeryMetadata.ts` (new), `packages/web/src/api/useGroupMetadata.ts`,
`packages/web/src/api/client.ts`, `packages/web/src/components/MediaCard.tsx`,
`packages/web/src/routes/Browse.tsx`, `packages/web/src/routes/Picks.tsx`,
`packages/web/src/styles.css`, `packages/web/test/requeryMetadata.test.ts` (new),
`packages/web/test/useGroupMetadata.test.tsx`, `packages/web/test/Browse.test.tsx`,
`packages/web/test/Picks.test.tsx`, `packages/web/test/MediaCard.test.tsx`.
