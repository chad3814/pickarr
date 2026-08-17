# Task 8 report — HTTP: the plan route, and the digest rule on PATCH

## Files changed

### `packages/core/src/http/server.ts`
- Added `import { planIdentityChange } from '../manual/identity-plan.ts';`.
- Added `type IdentityPlanResponse` to the `views.ts` import list.
- Added `editBodySchema = z.object({ values: z.record(z.string(), z.string()), planDigest: z.string().optional() })`, with a comment explaining `planDigest` is optional at the schema level only — `editGroup` decides which edits actually need one.
- Added `POST /api/groups/:id/identity-plan`, placed between the existing `dismiss` route and `PATCH /api/groups/:id` (inside the block the pre-existing comment covers about routes carrying their own status). Body/params parsed with the existing `valuesBodySchema`/`idParamsSchema`; calls `planIdentityChange(manual, params.data.id, body.data.values)`; on refusal replies with the result's own `status`; on success returns `result.ok` typed as `IdentityPlanResponse`. Comment explains the POST-vs-GET choice (form's worth of fields belong in a body) and cross-references `/api/manual-preview`'s existing GET-vs-POST rationale, per the brief's instruction.
- Updated the umbrella comment above the four-then-five status-carrying routes: "Each of the **five** routes below carries the status the operation chose..." (now covers resolve, dismiss, identity-plan, PATCH group, PATCH release).
- Updated `PATCH /api/groups/:id`: body now parsed with `editBodySchema`; call is now `editGroup(manual, params.data.id, body.data.values, body.data.planDigest)`; response now includes `renamed`, `trashed`, `failed` alongside `group` and `mergedInto`. Removed the interim comment about "no digest is threaded through yet."

### `packages/core/src/http/views.ts`
- Imported `type { IdentityPlan }` from `../manual/identity-plan.ts`.
- Extended `GroupEditResponse` with `renamed: number; trashed: number; failed: readonly { path: string; error: string }[];`, with a comment explaining these mirror `GroupEditOutcome` so a 200 never hides a per-file failure.
- Added `export type IdentityPlanResponse = IdentityPlan;` with a comment explaining it's a naming-consistency alias (every route here is typed through a `*Response` name), not a reshape — the planner's result is returned verbatim because the preview and the apply must not disagree.

### `packages/core/test/http/manual.test.ts`
- Added `import type { FastifyInstance } from 'fastify';`.
- Added helper `planDigestFor(server, groupId, values)` that POSTs to the new plan route and returns the digest, so tests exercise the same two-request round trip the SPA will make.
- **Restored the two interim tests Task 7 parked**, per the brief:
  1. `an unconfirmed merge is refused, and the two groups stand` → **split into two tests**:
     - `PATCH /api/groups/:id refuses a merge with no digest` — keeps the 409-with-no-digest assertion (this is real, permanent behaviour, not an interim stand-in), and
     - `a merge answers with the target group and names it in mergedInto` — the **restored original test**, now fetching the plan digest first and passing it as `planDigest`. Asserts `mergedInto: 1`, `group.id: 1`, `releases` order `[2, 1]`, `renamed: 0`, `trashed: 0`, `failed: []`, and that group 2 is gone. This is the exact assertion set the original pre-Task-7 test made (recovered from `git diff HEAD`), plus the three new outcome fields.
  2. `a download against the source is no longer its own refusal` → **restored to `a download against the source no longer blocks a confirmed merge`**. Now fetches the digest, PATCHes with it, and asserts `200` / `mergedInto: 1` / group 2 gone — i.e. a download recorded against the source is no obstruction at all once the merge is confirmed, not even the "must be confirmed first" 409 the interim version asserted.
  - No test in the file now asserts a merge over HTTP is a 409; both interim comments were removed.
- Added two new tests for the plan route itself (from the brief's Step 1, adapted to the file's real helpers rather than the invented `harness()`):
  - `POST /api/groups/:id/identity-plan describes a merge without performing it` — asserts `200`, `kind: 'merge'`, `mergeInto.id: 1`, a non-empty `digest`, and that both groups still exist afterward (nothing done).
  - `POST /api/groups/:id/identity-plan is 404 for a group that does not exist`.

I did **not** add a separate "applies a merge with a matching digest" test distinct from the restored one above — the restored `a merge answers with the target group and names it in mergedInto` test already is that test (plan → digest → PATCH → 200), and duplicating it under a different name would just be the same assertions twice. I also didn't add a redundant "display-only edit needs no digest" test — `patching a group returns it rewritten, with no merge` (pre-existing, untouched) already covers exactly that: no `planDigest` in the payload, `200` back.

## Brief corrections
- The brief's Step 1 tests call an invented `harness()` and a bare `getGroup(db, 1)` — neither exists in this file. Used the file's real `buildServer(deps(db))` / `seedTwoGroups(db)` pattern instead, per your correction.
- The brief's `seedTwoGroups(db)` fixture assumption (`{ values: { key: 'k2', title: 'A' } }` on group `1` merging into group `2`) does not match this file's actual `seedTwoGroups`: here group 1 is `k1` (picked, 720) and group 2 is `k2` (2160, unpicked) — the reverse of `test/manual/fixtures.ts`'s `seedMergePair`. I kept this file's existing convention (edit group 2 with `{ key: 'k1' }` to merge 2 into 1) rather than inventing a new seed, since that's what every pre-existing merge test in this file already assumed and it's what the restored tests needed to match their original (pre-Task-7) assertions.
- The umbrella "four routes" comment needed updating to "five" once the plan route was inserted inside its scope — not mentioned in the brief, but leaving it unstated would decouple the comment from the code it's counting.

## Gate results
- `npm run lint` — exit 0, only pre-existing warnings (`no-await-in-loop`, `preserve-caught-error`, etc. — none touch files I changed except one pre-existing `no-await-in-loop` warning at `manual.test.ts:446`, unrelated to my edits).
- `npm run typecheck` — exit 0, clean across all workspaces.
- `npm run test:server` — **876 pass, 0 fail**.
- `npm run test:web` — **165 pass, 0 fail**.
- `npm run test` (both suites together) — 876 + 165 = 1041 pass, 0 fail.
- `npm run build` — all four packages build cleanly (`plugin-api`, `plugin-scenes`, `core`, `web`).
- `npm run e2e` was not run — per instructions, it's expected to fail until Task 10 finishes the UI and is excluded from this gate.

Ran `packages/core/test/http/manual.test.ts` directly too (`npx tsx --test`) to confirm the six new/restored tests individually: all pass, including `PATCH /api/groups/:id refuses a merge with no digest`, `a merge answers with the target group and names it in mergedInto`, `a download against the source no longer blocks a confirmed merge`, and the two new `identity-plan` tests.

## Staged files
```
M packages/core/src/http/server.ts
M packages/core/src/http/views.ts
M packages/core/test/http/manual.test.ts
```
(Plus the pre-existing staged changes from Tasks 5-7, untouched: `db/groups.ts`, `db/imported-files.ts`, `main.ts`, `manual/identity-plan.ts`, `manual/operations.ts`, `manual/values.ts`, `pipeline/import.ts`, `pipeline/upgrade.ts`, and their tests, plus `e2e/src/harness.ts`.)

## Concerns
- None outstanding. The digest rule is now pinned at the HTTP layer from both directions: a no-digest merge attempt gets 409, and the plan→PATCH round trip with the correct digest succeeds, including the case where the source group carries a live download (previously its own separate 409, now folded entirely into the digest gate).
- Not committed, per instructions — files are staged only.
