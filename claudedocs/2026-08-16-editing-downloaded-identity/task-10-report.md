# Task 10 report: Wire Browse and Picks

## Files changed

- `packages/web/src/routes/Picks.tsx` — added a `fields` state fetched once
  from `api.manualFields()` (Picks never fetched this before); an `applyEdit`
  implementing `useIdentityChange`'s `apply` contract; `identityChange =
  useIdentityChange(applyEdit, setError)`; an `editRelease` that reloads
  instead of patching; and rendering of `IdentityChangeConfirm` plus the
  `fields`/`onEditGroup`/`onEditRelease` props on `MediaCard`.
- `packages/web/src/routes/Browse.tsx` — renamed `editGroup` to `applyEdit`,
  added the `planDigest` parameter, changed its return to `Promise<ApplyOutcome>`,
  added `failed`-surfacing, added the 409→stale mapping, wired
  `useIdentityChange` and routed the card's `onEditGroup` through
  `identityChange.begin`; kept the existing list-patching body and the
  "Releases moved into …" notice untouched.
- `packages/web/test/Picks.test.tsx` — added `FIELDS`, `PICKED_GROUP`,
  `PLAN_NO_MOVES`, `PLAN_MERGE` fixtures and a `stubApi` helper (the file's
  existing `serve()` only ever answered picks + metadata, so a second helper
  was added for the endpoints editing touches — manual-fields, identity-plan,
  and PATCH — rather than overloading `serve()`'s thirteen existing call
  sites). Added the four tests from the brief, unmodified in intent, adapted
  to `stubApi`'s actual shape. Also added `/api/manual-fields` handling to
  `serve()` and to the two ad-hoc `globalThis.fetch` stubs in the polling
  tests and the Downloads-anchor test — Picks now fetches that endpoint
  unconditionally on mount, and without an explicit answer some of those
  stubs would have thrown "unexpected request" or (worse, in `serve()`)
  silently miscounted a `/api/manual-fields` call as a `/api/picks` load,
  scrambling the `first`/`reloaded` distinction several existing tests key on.
- `packages/web/test/Browse.test.tsx` — added `defaultPlan()` and
  `Options.identityPlan` so `serve()` answers `POST .../identity-plan` (a
  request Browse never made before); added `Options.refusalStatus` so a PATCH
  refusal can be made 400 instead of the hardcoded 409. Updated the three
  existing merge tests to stub a `kind: 'merge'` plan and click Confirm before
  asserting. Updated two refusal tests (see "brief vs. reality" below).

## How each page's `apply` detects staleness

Both `applyEdit` implementations follow the identical shape mandated by
`useIdentityChange.ts`'s own doc comment:

```ts
} catch (cause) {
  if (cause instanceof RequestError && cause.status === 409) return { saved: false, stale: true };
  setError((cause as Error).message);
  return { saved: false, stale: false };
}
```

409 is reported as `stale` with **no** `setError` call — that message is
deliberately withheld because `useIdentityChange.confirm()` silently re-plans
on `stale: true`; showing a banner for a failure the dialog is about to
correct on its own would be confusing. Every other status calls `setError`
and returns `stale: false`, which lets `useIdentityChange` close the dialog
(or, for a no-confirmation edit, just leaves the form open) with the message
already on screen.

## How `failed` is surfaced

Identical logic on both pages, run only on a successful `api.editGroup` call:

```ts
setError(
  failed.length === 0
    ? null
    : `Saved, but ${failed.length} file(s) could not be moved: ${failed
        .map((entry) => `${entry.path} (${entry.error})`)
        .join('; ')}`,
);
```

On Browse this sits alongside the merge `notice` (both can be shown at once —
a merge that also left files stranded says both things). On Picks it's the
same message; Picks has no separate `notice` state, so it uses `error` alone.

## Gate

- `npm run lint` — exit 0, only pre-existing warnings in files this task
  never touched (verified `no-unused-vars`/etc. produced nothing new).
- `npm run typecheck` — clean across all five workspaces + `scripts`, no
  errors.
- `npm run test` — server 876/876 pass, web 179/179 pass (0 fail across both).
- `npm run build` — all four buildable packages (`plugin-api`, `plugin-scenes`,
  `core`, `web`) built successfully.

## `git status --porcelain` check

Ran `git add packages/web/src/routes/Picks.tsx packages/web/src/routes/Browse.tsx
packages/web/test/Picks.test.tsx packages/web/test/Browse.test.tsx`, then
`git status --porcelain`. Every line begins with `A` or `M` in the first
column (confirmed via `awk '{print substr($0,1,1)}' | sort -u` → `A`, `M`
only) — nothing is unstaged. The listing includes earlier tasks' files
(core's `manual/`, `http/`, etc., and Task 9's `useIdentityChange.ts` /
`IdentityChangeConfirm.tsx`), which were already staged before this task
started; this task did not touch or need to touch any of them.

## Brief vs. reality — what was wrong and how it was resolved

1. **The brief's own `applyEdit` snippet (Step 3) returns `Promise<boolean>`
   and has no staleness handling at all**, which cannot satisfy
   `useIdentityChange`'s actual signature (`apply: (...) => Promise<ApplyOutcome>`,
   as written in `useIdentityChange.ts` from Task 9) — passing that snippet
   to `useIdentityChange(applyEdit, setError)` would not type-check. I
   followed the authoritative contract instead: `useIdentityChange.ts`'s own
   doc comment and the task's top-level instructions, both of which spell out
   the `{ saved: true } | { saved: false; stale: boolean }` shape and the
   409-only staleness rule.

2. **The brief's Picks snippet types `fields` as
   `Record<string, readonly ManualField[]>`.** `MediaCard`'s `fields` prop is
   `ManualField[] | undefined` (mutable), and `fields[group.plugin]` from a
   `readonly ManualField[]` map is not assignable to it — this would be a
   type error at the JSX call site. I used `Record<string, ManualField[]>`
   instead (matching `ManualFieldsResponse`, and Browse's own existing
   convention), which type-checks and is exactly what `api.manualFields()`
   already returns.

3. **Routing Browse's `onEditGroup` through `useIdentityChange` makes every
   group edit fetch a plan first**, which broke three of Browse's own
   existing merge tests (they clicked Save and asserted the merge landed with
   no confirmation step) and, more subtly, two refusal tests
   ("a refused merge says why…", "a card edit that lands clears the error the
   last one left") that mocked a PATCH refusal at **409**. Per the
   409-is-always-stale contract, that message would now be swallowed
   silently (no `setError`, no dialog re-render reason shown) rather than
   displayed — an accurate reflection of the new architecture, since I
   confirmed (via `packages/core/src/manual/operations.ts` and
   `values.ts`) that in the current server code a *reportable* group-edit
   refusal is 400 (a plugin rejecting values), while 409 is now reserved for
   "needs confirmation" / stale-digest / rare id-race cases. I updated those
   two tests to use `refusalStatus: 400` (a new option I added to `serve()`)
   with a message describing a plugin rejection, which is what they now
   actually exercise; renamed the first to "a refused group edit…" since it
   no longer involves a merge. The three genuine merge tests were updated to
   stub a `kind: 'merge'` plan and click Confirm before asserting — no
   assertions were removed, only the sequence needed to reach them changed.
   I also renamed "a merge says where the releases went" to "…, confirmation
   included" and added an assertion that the notice does *not* appear before
   Confirm is clicked, which serves as the requested pinning test for the
   merge notice surviving the new confirmation step, rather than adding a
   near-duplicate test alongside it.

## Concerns

- `useIdentityChange.begin`'s no-confirmation branch (`kind` other than
  `merge` with no renames/trashing) calls `apply` directly and does not
  retry on `stale: true` — that retry only exists in `confirm()`. In the very
  rare case where a plan legitimately needing no confirmation still nets a
  409 at apply time (a race where the server's own re-plan now disagrees), the
  failure is silently absorbed: no error shown, form just doesn't close. This
  is existing Task 9 hook behavior, not something Task 10 changed, and by my
  reading of `operations.ts` such a race is exceptionally rare in practice
  (no digest was ever required for that path) — flagging it rather than
  fixing it, since fixing it means changing `useIdentityChange.ts`, out of
  this task's stated scope.
- `packages/e2e/tests/manual.spec.ts` was not touched. It likely needs a
  small addition to click through the new confirmation dialog for its merge
  scenario(s); I did not investigate further since Task 11 owns the e2e spec
  and `npm run e2e` is expected red until then per the assignment.
