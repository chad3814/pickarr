# Task 3 report — the button

## What was implemented

`packages/web/src/api/client.ts`
- Added `MetadataRequeryResponse` (four required numeric fields: `requeued`,
  `missing`, `unavailable`, `unaskable`), mirroring core's type of the same
  name, with a doc comment following the file's existing convention for
  duplicated-not-imported types (see `PerformerView`/`MetadataView`'s notes)
  and explaining the counter partition the way `MetadataRequestResponse`'s
  comment does.
- Added `api.requeryMetadata(groupIds, signal?)`, modelled directly on the
  neighbouring `api.requestMetadata`: same `RequestInit` shape, same optional
  `AbortSignal` threading, POSTs to `/api/metadata/requery`.

`packages/web/src/components/MediaCard.tsx`
- Added a "Requery metadata" button, rendered in a new `.card-actions` row
  beside the existing Edit button, visible only when the card's effective
  metadata is settled (`state === 'confirmed' || state === 'none'`).
- Added three pieces of local state: `requerying` (bool), `requeryError`
  (`string | null`), and `refetchedMetadata` (`MetadataView | null`).
- All rendering that used to read `group.metadata` now reads a local
  `metadata` constant, `refetchedMetadata ?? group.metadata` — see "decision"
  below for why.
- `requery()`: calls `api.requeryMetadata([group.id])`, then immediately
  calls `api.metadata([group.id])` and stores whatever comes back in
  `refetchedMetadata`. Both calls share one try/catch: on any failure,
  `requeryError` is set to the caught error's message and nothing else
  changes. `finally` always clears `requerying`, so the button re-enables on
  both success and failure.
- The button label is `Requery metadata` normally, `Requerying…` (and
  `disabled`) while `requerying` is true. A failure renders `requeryError` in
  a `<p className="error">`, reusing the app's existing error-text class
  rather than inventing a new one.

`packages/web/src/styles.css`
- Added `.card-actions` (`display: flex; gap: 0.5rem; align-items: center;
  margin: 0.5rem 0;`), the same row-of-buttons shape as the existing
  `.failed-actions`/`.manual-actions` rules — no new layout system.

`packages/web/test/MediaCard.test.tsx`
- Added a local `jsonResponse` helper (matching the one already duplicated
  per-file in `useGroupMetadata.test.tsx`/`Browse.test.tsx`).
- Four new tests, one per brief bullet:
  1. `the Requery button renders only once metadata is settled` — asserts
     absence for `absent`/`pending`, presence for `none`/`confirmed`, via
     `rerender`.
  2. `clicking the Requery button disables it and shows in-flight text` —
     holds the `/api/metadata/requery` response on a controlled promise,
     asserts the in-flight button is disabled, then resolves and waits for
     the button to return to idle (so no promise is left dangling into the
     next test).
  3. `the card keeps its title and cast on screen while a requery is in
     flight` — same held-promise setup, asserts the heading text, a cast
     `<li>`, and the synopsis are all still present while `requerying`.
  4. `a rejected requery re-enables the button, shows the error, and keeps
     the existing metadata` — answers `/api/metadata/requery` with a 400
     `{ error: 'Invalid request' }` (the server's own documented shape for a
     malformed/over-cap body), asserts the error text appears, the button is
     re-enabled, and the heading/synopsis are unchanged.
- A fifth test beyond the brief's four: `a successful requery shows the
  fresher answer without a reload` — answers both calls successfully with a
  changed synopsis, and asserts the new synopsis replaces the old one with no
  remount. Added because "on success, refetch that group's metadata so a
  fast answer appears without a reload" is the feature's stated point and
  none of the four listed tests exercise it.

All absence assertions use the existing file's `!screen.queryByRole(...)` /
`assert.ok(!...)` pattern (never `assert.equal(x, null)`), matching the
`gone()` trap warning at the top of the file — no new helper was needed for
the button-specific cases since role queries were checked with boolean
negation rather than direct equality.

## Verification

- `npm run typecheck` — clean, all five workspaces.
- `npm run lint` — exits 0; the warnings present are all pre-existing and in
  files this task did not touch (verified by diffing the warning list against
  `git diff --stat`).
- `npm run test:web` — 197/197 pass, including the 5 new tests (re-run after
  adding the fifth).
- `npm test` (server + web) — 1120 + 197 = 1317/1317 pass (re-run after adding
  the fifth).
- One `npm test` invocation (run back-to-back after `lint` and `typecheck` in
  the same shell command) reported 196/197 on the web suite instead of
  197/197, with no captured detail on which test or why. Re-ran the full
  suite 3 more times, the web suite alone 5 more times, and the `MediaCard`
  test file alone 10 more times in a tight loop — all 18 of those were clean.
  I could not reproduce it and have no log of the one failure, so I'm
  reporting it rather than either dismissing it or claiming it's fixed:
  possibly sandbox scheduling jitter from the preceding lint+typecheck run
  colliding with a `waitFor`'s default timeout, but that's a guess, not a
  diagnosis.

## Decisions the brief left open

**How the refetch actually reaches the screen.** The brief only names
`client.ts` and `MediaCard.tsx` as files to touch — not `Browse.tsx` or
`Picks.tsx`. Both routes only ever merge metadata through
`useGroupMetadata`'s map, and that hook stops asking about an id the instant
it first resolves to `confirmed` or `none` — exactly the state this button
requires before it renders. So once a card's `group.metadata` prop is
settled, nothing upstream will ever refresh it again, with or without this
button. Threading a new callback prop through both routes to let a route
patch its own `groups` state was the alternative; I did not do that, because
(a) it would touch two files the brief didn't mention, (b) it would be the
only case in the whole app where a route calls two endpoints for one user
action instead of one, and (c) `MediaCard` already renders every other piece
of metadata by reading `group.metadata` directly with no round-trip through
a route callback for *reading* data (only mutations — pick, edit — go through
callback props). I instead gave `MediaCard` its own `refetchedMetadata`
override, populated by a direct `api.requeryMetadata` + `api.metadata` call
inside the component, and rendering `refetchedMetadata ?? group.metadata`
everywhere. This is the one place `MediaCard` now imports `api` directly
where it previously imported nothing from `client.ts` but types — worth a
reviewer's attention, since it's a small architectural precedent (every other
network call in this app lives in a route component, not a leaf component).

**What happens if the immediate refetch comes back `pending`.** This is the
likely case in production: `requeueMetadata` only resets the queue row, it
does not wait for the worker's tick. When that happens, `refetchedMetadata`
becomes `{ state: 'pending' }`, the button disappears (it only renders when
settled), and — because of the same `useGroupMetadata` freeze described
above — *nothing on the page polls that id again*. The card is stuck showing
"pending" until a reload. I judged this acceptable and in-scope-as-written:
the brief's four tests don't exercise this path, "a bulk requery" and
ongoing-polling machinery are explicitly out of scope, and the alternative
(teaching `MediaCard` to poll on its own account) is real new machinery the
brief never asked for. I documented this tradeoff in `requery()`'s doc
comment rather than silently building a false impression that the button
guarantees an eventual answer. Flagging this because it's the one place the
implementation's behavior could plausibly surprise a user: click the button,
see "pending" appear, and then nothing happens without a manual reload — even
though the worker did, at its own pace, eventually answer it.

**Placement relative to the Edit button.** "Beside the existing Edit button"
was read as "in the same actions row," not "adjacent to whatever the Edit
button currently is" (a button in the non-editing state, or the whole
`IdentityForm` while editing). I render `.card-actions` — containing Edit
(only when not editing and the plugin supports it) and Requery (only when
settled) — as an unconditional sibling to the `IdentityForm`/no-form block,
so Requery stays visible and independently clickable even while the identity
form is open for a different edit. Nothing in the brief said whether Requery
should hide during an identity edit; I chose "no" since the two are
unrelated corrections to unrelated data.

## Uncertain / worth a second look

- The `MetadataRequeryResponse` doc comment in `client.ts` explains the
  counter partition but doesn't literally discuss "tolerating an older
  server" the way `MetadataView`'s optional fields do — I concluded that
  convention doesn't apply here (there's no field on this response type that
  a pre-existing server build could have omitted; the whole route is new,
  and a pre-route server would 404 the whole call, handled already by
  `request()`'s existing `RequestError` path). If the intent was something
  else, worth confirming.

## Fix round 1 — review response

The review came back spec ❌ with 2 Critical and 1 Important, and the
coordinator issued a binding architecture ruling on how to fix it (not the
minimal guard the reviewer floated). This section covers that fix.

### What was wrong

Both Criticals traced to the same root cause the reviewer named as Important
3: `MediaCard` calling `api` directly and keeping its own
`refetchedMetadata` override meant this card was a *second*, uncoordinated
place a group's metadata answer could live, alongside `useGroupMetadata`'s
own map (which `Browse`/`Picks` already merge into `group.metadata`). The
card's own one-shot re-fetch had no way to keep watching if the immediate
answer was not yet fresh, and nothing stopped a regressed answer from
reaching the screen.

I re-derived what the *server* actually does here before designing the fix,
rather than trusting my own (as it turned out, wrong) doc comment from round
1: `requeueMetadata`'s own doc, and a task-2 test literally titled "a
requery must never touch `group_metadata`", both confirm the row `GET
/api/metadata` reads is untouched by a requery until the worker's own
`recordMetadataAnswer` overwrites it — so a real server never actually
answers a rearmed, previously-confirmed id with `pending`. That does not
make the reviewer's finding moot, though: the coordinator's ruling is right
that the invariant has to hold *by construction*, not by leaning on a
same-file server-side coincidence a later change to that file could quietly
break, with nothing on the client side positioned to catch it.

### What changed, file by file

**`packages/web/src/api/useGroupMetadata.ts`** — the hook gained a way to
watch a settled id again, and a hard downgrade guard, both reusing the
existing poll loop rather than adding a second one:

- `useGroupMetadata` now returns `{ metadata, rearm }` instead of a bare
  `Map`. `rearm(groupId)` snapshots that id's current answer into a new
  `rearmedSnapshotsRef` map and bumps a `generation` state, which is now a
  dependency of the same effect `key` already drove — bumping it re-runs
  `run()`, which is the *existing* mechanism this hook has always used to
  decide what to poll, not a parallel one.
- `run()`'s `unresolved` filter grew a third condition:
  `rearmedSnapshotsRef.current.has(id)`, alongside the original "never seen"
  and "still `pending`" conditions. A rearmed id is included even though its
  last known state is `confirmed`/`none`.
- `poll()`'s stopping condition (`stillPending` → renamed `stillUnresolved`)
  now also treats a rearmed id as unresolved for as long as its fetched
  answer is *structurally identical* (`sameMetadata`, a `JSON.stringify`
  comparison) to the snapshot taken at the moment of the rearm. This is the
  piece that makes "fast answer without a reload" actually work despite the
  server never reporting an interim `pending` for an already-answered
  group: the only signal available is "did the content change," so the poll
  keeps asking (on the ordinary ladder, since there is no `nextAttemptAt` to
  trust for this case) until it does, then stops — the same way it always
  stopped once a genuinely-`pending` id turned `confirmed`.
- `commit()` gained the hard invariant: it now skips writing an incoming
  view into the shared map if doing so would lower `rank(view)` below the
  map's current entry for that id (`rank`: confirmed/none = 2, pending = 1,
  absent = 0). For the ordinary lazy-trigger path this is a no-op — an
  already-settled id is never re-fetched by that path, so `commit` never
  even sees a downgrade for one — but for the rearm path it is real
  protection, and it no longer depends on the server behaving as documented
  to hold.

**Why this cannot disturb the lazy-trigger path for a card that was never
requeried:** every existing code path (the `unresolved` filter's first two
conditions, `ensureRequested`, `fetchStates`, the ladder/`serverDelayFor`
scheduling) is untouched — I extended the *filters* `run()`/`poll()` already
apply, and added a guard *inside* `commit()` that is provably inert unless
`rank(current) > rank(incoming)`, which never happens for an id this hook
settled through its own normal flow. The one honest exception, stated
plainly rather than glossed over: bumping `generation` re-runs the *whole*
effect, including its cleanup — so if some *other*, unrelated id happens to
be genuinely `pending` and mid-poll at the exact moment a rearm fires
elsewhere on the same page, that id's in-flight fetch is aborted and its
poll restarts from `START_DELAY_MS` rather than continuing from wherever its
ladder or server-driven wait had reached. This does not change what answer
that id eventually settles on, only the timing of its next one or two polls,
and it only happens on the coincidence of a rearm and another id's poll
landing in the same instant. I chose to accept this rather than build a
second, fully independent poller per rearmed id, because the ruling
explicitly asked for the former and ruled out the latter ("reuse that
machinery... do not write a second poller anywhere").

**`packages/web/src/components/MediaCard.tsx`** — reverted to owning nothing
about metadata content:

- Removed the `api` import, `refetchedMetadata` state, and the two-call
  `requery()` implementation entirely.
- Added `onRequeryMetadata?(groupId: number): Promise<void>` as a fourth
  action prop, alongside `onPick`/`onEditGroup`/`onEditRelease`. The card's
  `requery()` now only calls this prop and manages its own
  `requerying`/`requeryError` display state — the same division `save` has
  with `onEditGroup`.
- The Requery button's visibility (`settled`) now also requires
  `onRequeryMetadata !== undefined`, mirroring `canEdit`'s gate on
  `onEditGroup` — a caller with nowhere to send a requery gets no button,
  the same as a caller with nowhere to send an edit gets no Edit button.
- `metadata` is now simply `group.metadata`, destructured, with every prior
  reference unchanged in spirit.

**`packages/web/src/routes/Browse.tsx` and `Picks.tsx`** — each gained a
`requeryMetadata(groupId)` async function (identical shape in both,
matching the pattern their own `applyEdit`/`editRelease` already set): calls
`api.requeryMetadata([groupId])`, and only on success calls the hook's
`rearm(groupId)`. Wired to `MediaCard` as `onRequeryMetadata`. `useGroupMetadata`'s
return is destructured as `{ metadata: liveMetadata, rearm: rearmMetadata }`;
every existing use of `liveMetadata` (the merge into each card's `group`
prop) is unchanged.

### Tests

**`packages/web/test/useGroupMetadata.test.tsx`** — `Consumer` updated to
destructure `{ metadata, rearm }` and render a `rearm-<id>` button per id
(kept *outside* the `<ul>` so it cannot fold into any existing
`getByText('N:state')` assertion's `textContent`). One new test:

- `rearm re-polls a settled id rather than leaving it unwatched, and never
  shows it as less settled than it already was` — feeds the mocked
  `GET /api/metadata` three answers in sequence (the original confirmed
  answer, then a `pending` — the shape the bug blanked over — then a
  genuinely different confirmed answer), clicks the id's `rearm` button, and
  asserts: (1) a further `GET /api/metadata` call actually happens after the
  rearm (proof the id is watched again, not orphaned), (2) the rendered
  state never shows `pending` even though the mock answered with it, and (3)
  once the third, genuinely-different answer lands, polling stops (no
  further calls after that).

**`packages/web/test/MediaCard.test.tsx`** — the five tests from round 1
that mocked `globalThis.fetch` directly no longer apply (the card calls no
`api` function any more); rewritten against the new `onRequeryMetadata`
prop instead:

- `the Requery button renders only once metadata is settled, and only with
  a handler to call` — extends the round-1 version with the no-handler case.
- `clicking Requery calls the handler with this group's id` — new; pins the
  prop's contract directly.
- `clicking Requery disables it and shows in-flight text until the handler
  settles` — same shape as round 1, driven by a controlled promise returned
  from the prop instead of a held `fetch`.
- `the card keeps its title and cast on screen while a requery is in
  flight` — unchanged in intent, same controlled-promise mechanism.
- `a rejected requery re-enables the button, shows the error, and keeps the
  existing metadata` — the prop now rejects directly instead of a mocked 400.
- `the card never overrides group.metadata itself — a fresher prop is what
  has to change what is shown` — new; replaces round 1's fetch-mocked
  "successful requery" test, and pins the actual invariant the fix
  introduces: nothing inside this card can override a fresher `group` prop,
  because nothing inside it holds an override any more.

**`packages/web/test/Browse.test.tsx`** — one new end-to-end test,
`clicking Requery re-arms the poll end to end: no blanking on a pending
answer, and a fresher one lands without a reload`, with its own
self-contained `fetch` mock (not the shared `serve()` helper, since it needs
per-call-count control over `GET /api/metadata`'s answer that `serve()`
doesn't offer). It renders the real `Browse` route, clicks the real button,
and drives the mocked `GET /api/metadata` through the same three-answer
sequence as the hook test above — this is the one that exercises the actual
wiring (`Browse`'s `requeryMetadata` → `api.requeryMetadata` →
`rearmMetadata` → the hook's `run()`/`poll()`) rather than any single piece
of it in isolation.

**Verified these fail against the pre-fix code**, per the ruling's
requirement. I copied the four production files (`useGroupMetadata.ts`,
`MediaCard.tsx`, `Browse.tsx`, `Picks.tsx`) back to their state at commit
`a6d5b4c` (the reviewed commit), left every test file at its current
(fixed) content, and ran:

```
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx --import ./packages/web/test/setup.ts \
  --conditions development --test "packages/web/test/Browse.test.tsx" \
  "packages/web/test/MediaCard.test.tsx" "packages/web/test/useGroupMetadata.test.tsx"
```

Result: 49 pass, 12 fail. Failing, as expected: the new Browse integration
test (`clicking Requery re-arms the poll end to end...`), two of the
rewritten `MediaCard` tests that depend on the new prop
(`onRequeryMetadata`) existing at all, the rejected-requery test (times out
differently with no `fetch` mock installed against code that calls `fetch`
directly), and every `useGroupMetadata` test (the whole file's `Consumer`
now destructures `{ metadata, rearm }`, which the old hook doesn't return —
confirms the API-shape change is real, not cosmetic). I then restored the
four files to the fix and re-verified the full suite (below) before
committing.

### Verification (post-fix)

- `npm run lint` — exit 0. Only two warnings in touched files, both
  pre-existing `eslint(no-await-in-loop)` on the unchanged `fetchStates`/
  `ensureRequested` bodies (confirmed by diffing against the same lines in
  the pre-fix commit). Fixed two warnings my own new code introduced along
  the way: a `no-shadow` on `setGeneration`'s callback param (renamed to
  `previous`), and a `consistent-function-scoping` on a test's `noop`
  (hoisted to module scope).
- `npm run typecheck` — clean across all five workspaces.
- `npm run test:web` — 200/200 (was 197 before this round; net +3: the
  `useGroupMetadata` rearm test, minus one round-1 `MediaCard` test folded
  into the "renders only once settled" test's no-handler case, plus one new
  `MediaCard` invariant test, plus the new `Browse` integration test).
- `npm test` (server + web) — 1120 + 200 = 1320/1320.
- Ran the full suite 3 times and `test:web` alone 4 times back to back after
  landing the fix; all 1320/1320 clean every time, including the two
  timing-sensitive new tests (`rearm re-polls...`, ~2.0s; the `Browse`
  integration test, ~0.5s) — no repeat of round 1's single unreproduced
  flake.

### What I'm not fully certain of

- The `rearm`-triggered effect restart's collateral effect on a
  coincidentally-mid-poll unrelated id (described above) is real but
  untested directly — I judged it low-value to chase with a test given how
  narrow the timing window is (would need two ids racing a poll and a rearm
  in the same tick), and the ruling's own risk acceptance language reads as
  anticipating exactly this kind of narrow, non-correctness-affecting
  side effect rather than asking for it to be eliminated. Flagging it again
  here in case that reading is wrong.
- `sameMetadata`'s `JSON.stringify` comparison assumes both values were
  constructed by the same server code path in the same field order (true
  today — `metadataViewOf` always builds the confirmed object literal with
  the same key order) — it is not a general-purpose deep-equal. If that
  object-literal shape ever grows a field ordered non-deterministically
  (e.g. spread from a `Map` with insertion-order-dependent iteration), this
  comparison could over-report "changed" (harmless: stops polling one poll
  early) or under-report it in a way I can't currently construct (any
  reordering still changes the string). I did not add a proper structural
  comparator for this because nothing else in this hook needed one before,
  and it would be new machinery to solve a problem that does not exist in
  the current shape of `MetadataView`.
