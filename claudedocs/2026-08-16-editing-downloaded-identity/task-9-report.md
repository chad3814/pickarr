# Task 9 report: the web client, the hook, and the confirmation

## Fix round 2 (post-Task-10-review): the silent fast-path stale digest

Task 10's review found that `begin`'s no-confirmation fast path
(`useIdentityChange.ts`) swallowed a stale-digest failure: if a plan came back
needing no confirmation, `begin` applied with no digest, and if that apply
then reported `{ saved: false, stale: true }` (a concurrent change made the
edit a merge on the server between the plan and the apply), `begin` returned
`false` with nothing shown — a Save click that silently did nothing.

**Fix**, confined to `packages/web/src/api/useIdentityChange.ts` and its test
file, per the coordinator's instruction not to touch `MediaCard`, Browse, or
Picks:

- Extracted the merge/renames/trashing check into a top-level
  `needsConfirmation(plan)` helper, shared by `begin`'s two plan checks.
- `begin`'s fast path, on a stale apply, now re-plans (a second
  `api.identityPlan` call for the same group/values) and:
  - if the fresh plan needs confirmation, hands it to the same
    `setPending`/unresolved-promise path a merge would have taken — the user
    sees a dialog for what the situation became, rather than silence;
  - if the fresh plan still needs no confirmation, applies **once more** (not
    a loop) with no digest; if that second apply is also stale, calls
    `onError` with a message naming the identity key and resolves `false` —
    two identical races in a row is reported, not retried a third time;
  - if the re-plan itself throws, calls `onError` with its message and
    resolves `false` immediately, same as every other `identityPlan` failure
    in this hook.

**Tests added** to `packages/web/test/useIdentityChange.test.tsx` (3 new,
9 total in the file):
- `'the no-confirmation fast path going stale opens the confirmation with the
  re-planned plan, and does not resolve until answered'` — first apply call
  goes stale with `digest: undefined`, the re-plan comes back as a merge, the
  dialog shows it, `begin`'s promise stays unresolved (`result:pending`)
  until Confirm is clicked, and only then does the second apply call carry
  the merge plan's digest.
- `'a failing re-plan after a stale fast-path apply reports via onError and
  resolves false'` — the re-plan's `fetch` throws; `onError` receives its
  message, `begin` resolves `false`, no dialog ever appears, `apply` is
  called exactly once.
- `'a re-plan that still needs no confirmation, then goes stale again,
  surfaces an error rather than looping'` — both plans read as
  `display-only`; the second apply also reports `stale: true`; asserts
  `onError` was called exactly once, `apply` and `identityPlan` were each
  called exactly twice (no third attempt), `begin` resolves `false`, and no
  dialog ever appears.

**Gate after this fix round:**
- `npm run lint` — exit 0. Diffed the warning list against the pre-fix run:
  no new warnings from `useIdentityChange.ts` or the new test cases (the two
  `unicorn(consistent-function-scoping)` warnings on `useIdentityChange.test.tsx`
  lines 174/195 predate this round, on tests untouched by this fix).
- `npm run typecheck` — clean across all workspaces.
- `npm run test` — server 876/876 pass; web 182/182 pass (the file's own 9
  tests all pass in isolation too; the total grew beyond +3 because Task 10's
  reviewed changes to `Browse.tsx`/`Picks.tsx` and their test files are also
  present in this working tree).
- `npm run build` — all four packages build cleanly.

**Porcelain check:** `git status --porcelain | grep '^ '` matched nothing —
no tracked file has an unstaged change; every line's first column is a
status letter (`M`/`A`), never a space. Full `git status --porcelain` output
reviewed line by line as part of this check.

**Files staged for this round:** `packages/web/src/api/useIdentityChange.ts`,
`packages/web/test/useIdentityChange.test.tsx`. (Task 10's own files —
`Browse.tsx`, `Picks.tsx`, `Browse.test.tsx`, `Picks.test.tsx` — were already
staged/reviewed separately and are untouched by this fix.)

## Fix round 1 (post-Task-9-self-review)

Two issues raised in review, both fixed:

**1. Re-plan only on a stale digest, not on any failure.**
`packages/web/src/api/client.ts` now exports `RequestError extends Error`,
carrying the response's numeric `status`; `request` throws it instead of a
bare `Error`. Verified it does not disturb any existing `catch (cause) {
(cause as Error).message }` site — `RequestError` is an `Error` subclass, so
every such site keeps compiling and behaving unchanged (confirmed by a clean
`npm run typecheck` across all workspaces after the change).

`useIdentityChange`'s `apply` parameter is now typed
`(groupId, values, digest?) => Promise<ApplyOutcome>`, where
`ApplyOutcome = { saved: true } | { saved: false; stale: boolean }` (exported
from `useIdentityChange.ts`). This is the hook's own dependency contract, not
`MediaCard`'s — `begin` still returns `Promise<boolean>` to the card
unchanged, flattening `ApplyOutcome` via `.saved`. `confirm()` now re-plans in
place only when `outcome.stale` is `true`; any other failure
(`{ saved: false, stale: false }`) resolves the pending promise `false` and
closes the dialog immediately, leaving `apply`'s own error report (via its
caller's `onError`/`setError`, made before returning) as the sole account of
what went wrong.

**Contract Task 10 must implement:** the `apply` function passed into
`useIdentityChange` (built into Browse's and Picks' edit handlers) must catch
`RequestError` from `api.editGroup`, set `stale: cause.status === 409`, call
its own error-reporting path (e.g. `setError`) for every failure so the user
still learns what happened, and return `{ saved: false, stale }` — never let
a non-409 failure look stale. This is documented as a comment directly above
`ApplyOutcome` in `useIdentityChange.ts` for the next reader.

**2. `useIdentityChange` is now tested directly.**
Added `packages/web/test/useIdentityChange.test.tsx` with a `Probe` component
that renders the hook plus `IdentityChangeConfirm`, and a
`mockIdentityPlanFetch` helper that serves plan fixtures by call order. Six
tests:
- a `display-only` plan with empty `renames`/`trashing` applies immediately,
  no dialog, `apply` called with `digest: undefined`;
- a `merge` plan shows the dialog, `apply` is not called until Confirm is
  clicked, then called with the plan's exact digest;
- a `kind: 'none'` plan with a non-empty `renames` array still requires
  confirmation (the interrupted-rename-retry case a `kind`-only check would
  miss) and never calls `apply` before confirmation;
- Cancel resolves `false` and calls `apply` zero times;
- a `{ saved: false, stale: true }` outcome re-plans in place (a second
  `identity-plan` fetch fires) and keeps the dialog open, showing the fresh
  plan, with `begin`'s promise left unresolved;
- a `{ saved: false, stale: false }` outcome resolves `false`, closes the
  dialog, and triggers no second plan fetch.

**Gate after the fix round:** `npm run lint` exit 0, no new warnings from any
touched file; `npm run typecheck` clean across all workspaces;
`npm run test` — server 876/876 pass, web 175/175 pass (169 prior + 6 new in
`useIdentityChange.test.tsx`); `npm run build` succeeds for all four
packages.

## Files changed (original implementation)

- `packages/web/src/api/client.ts`
  - Added `IdentityPlanView` (mirroring `IdentityPlan` from
    `packages/core/src/manual/identity-plan.ts`, field-for-field, verified by
    reading that file directly), plus `PlannedRenameView` and `PlannedTrashView`
    helper interfaces for the `renames`/`trashing` arrays.
  - Extended `GroupEditResponse` with `renamed: number`, `trashed: number`,
    `failed: readonly { path: string; error: string }[]`, mirroring the
    server's `GroupEditResponse` in `packages/core/src/http/views.ts` (already
    shipped by an earlier task).
  - Gave `editGroup` a third optional `planDigest?: string` parameter, included
    in the request body only when defined (matches the `requestMetadata`
    precedent already in the file for optional-but-present-only-when-set
    fields, and respects `exactOptionalPropertyTypes`).
  - Added `api.identityPlan(groupId, values)` calling
    `POST /api/groups/:id/identity-plan`, using the existing `request` helper.
  - Left the pre-existing `no-shadow` lint warning on `request` inside
    `client.ts` untouched — did not fix it, did not add to it.

- `packages/web/src/api/useIdentityChange.ts` (new) — implemented exactly as
  given in the brief, with the doc comment expanded slightly to spell out the
  distinction from `useIdentityPreview` (per-keystroke key preview with no
  group, vs. this one-shot per-group plan).

- `packages/web/src/components/IdentityChangeConfirm.tsx` (new) — implemented
  as given in the brief.

- `packages/web/test/IdentityChangeConfirm.test.tsx` (new) — the four tests
  from the brief, verbatim, with the `afterEach(cleanup)` pattern from
  `ManualForm.test.tsx`.

- `packages/web/test/Browse.test.tsx` (modified, not in the brief's file
  list) — six existing mock `GroupEditResponse` literals needed
  `renamed: 0, trashed: 0, failed: []` added once the interface grew those
  required fields; see "brief issues" below.

## How the hook decides whether a confirmation is needed

`begin` always calls `api.identityPlan` first. It computes
`moves = plan.kind === 'merge' || plan.renames.length > 0 || plan.trashing.length > 0`.
When `moves` is false — `kind` is `'none'`, `'display-only'`, or a `'rekey'`
that moved no files — `begin` calls `apply(groupId, values, undefined)`
directly and returns that promise; no dialog is ever shown, and no digest is
sent (matching the server's own rule that a digest is required only when a
plan actually moves something). When `moves` is true, `begin` stores the plan
and a `resolve` callback in state and returns an unresolved promise; the
promise settles only when `confirm()` or `cancel()` is later called, which is
what lets `begin` satisfy `MediaCard`'s `onEditGroup(values) => Promise<boolean>`
contract unchanged.

## Stale-digest handling (superseded by the fix round above — kept for history)

Originally `confirm()` re-planned on any `apply` failure, since `apply`
returned a plain `boolean`. The fix round above replaced this: `apply` now
returns `ApplyOutcome`, and `confirm()` only re-fetches the plan and replaces
`pending.plan` in place when `outcome.stale` is `true`. Any other failure
resolves `false` and closes the dialog without re-planning. See "Fix round"
at the top for the current behaviour and the contract Task 10 must follow.

Blockers (`plan.blockers.length > 0`) disable the Confirm button in
`IdentityChangeConfirm`; warnings are rendered but never disable anything.

## Gate results

- `npm run lint` — exit 0. No new warnings from any of the changed/added
  files. The pre-existing `no-shadow` warning on `request` in `client.ts` is
  still exactly one occurrence.
- `npm run typecheck` — passes across all workspaces after the `Browse.test.tsx`
  fix (see below).
- `npm run test` — `npm run test:server` 876/876 pass; `npm run test:web`
  169/169 pass (includes the 4 new `IdentityChangeConfirm` tests).
- `npm run build` — all four packages build cleanly (`plugin-api`,
  `plugin-scenes`, `core`, `web`).

## Where the brief was incomplete

The brief's file list did not mention `packages/web/test/Browse.test.tsx`, but
extending `GroupEditResponse` with the three new required fields (as Step 1
directs, to keep the client type honest about what the server now returns)
broke six existing mock literals there (`TS2739: missing renamed, trashed,
failed`), since they construct `GroupEditResponse` values directly. I added
`renamed: 0, trashed: 0, failed: []` to each of the six mocks — the neutral
"nothing moved" values, consistent with what those tests are actually
exercising (plain group patches and merges with no file work). This was
necessary to satisfy the "full gate before done" requirement; no test
behavior changed, only the mock shape.

Everything else in the brief (interfaces, hook, component, test assertions)
was accurate against the server code as it stands, verified directly against
`packages/core/src/manual/identity-plan.ts`, `packages/core/src/http/views.ts`,
and `packages/core/src/http/server.ts`.

## Concerns (both resolved in the fix round — see top of this report)

- ~~`useIdentityChange`'s re-plan-on-failure branch treats *any* `apply`
  failure the same as a stale-digest 409...~~ Resolved: `RequestError` now
  carries `status`, `apply` returns `ApplyOutcome` distinguishing
  `stale`, and `confirm()` only re-plans when `stale` is `true`.
- ~~No test file for `useIdentityChange` itself...~~ Resolved: added
  `packages/web/test/useIdentityChange.test.tsx`, six tests, covering the
  no-dialog fast path, the merge confirmation path, the `kind: 'none'` with
  pending renames edge case, cancel, and both branches of the stale/non-stale
  `apply` outcome.

No outstanding concerns from this task.
