# Final fix wave — report

Branch: `fix/edit-picked-files`. This is the one fix wave for the final whole-branch
code review. Everything below is staged but **not committed** and **not pushed**.

## Important 1 — a blocked plan escaped the confirmation dialog

**Fix.** `packages/web/src/api/useIdentityChange.ts:51-58` (`needsConfirmation`): added
`plan.blockers.length > 0` to the condition, with a comment explaining why (a blocked
plan can have empty `renames`/`trashing`, and skipping the dialog sent it straight to
`apply`, which refuses 409 and is read by this hook's own contract as a stale digest —
so the blocker text never reached the user, and the failure was reported as "the group
kept changing underneath this edit" instead).

**Tests added:**
- `packages/web/test/useIdentityChange.test.tsx`: `'a blocked plan with no renames or
  trashing still requires confirmation'` — asserts the dialog opens, `apply` is never
  called, and the blocker text renders.
- `packages/web/test/Picks.test.tsx`: `'a blocked plan with no file work still shows its
  blocker and saves nothing'` — end to end through `Picks`, asserting the blocker text
  reaches the dialog, Confirm is disabled, and nothing is PATCHed.

Both pass:
```
✔ a blocked plan with no renames or trashing still requires confirmation
✔ a blocked plan with no file work still shows its blocker and saves nothing
```

## Important 2 — the planner's containment check used an unresolved library root

**Fix.** `packages/core/src/manual/identity-plan.ts`:
- Added `resolve` to the `node:path` import (line 1).
- At the read site (was line 257, now ~264): `const libraryRoot =
  resolve(deps.registry.libraryRootById(group.plugin));`, matching
  `pipeline/import.ts`'s `resolveDestination` and `manual/operations.ts`'s own
  `resolve(deps.registry.libraryRootById(group.plugin))`. A comment at the site explains
  why: the registry accepts any non-empty string, so an unresolved root with a trailing
  slash or a relative path made the raw `isContained` check compare against a string
  `file.destPath` could never start with, turning every rename into a false blocker.
- The `isContained` call at (was line 339, now further down) uses the same, now-resolved,
  `libraryRoot` variable, so both sites are fixed by the one change.

**Verified against escalation risk:** all existing tests use `mkdtemp` paths (already
absolute, no trailing slash), so `resolve()` is idempotent on them — no existing test
broke. Confirmed by temporarily reverting the fix and re-running
`identity-plan.test.ts`: only the new regression test below failed (2 blockers instead
of 1, the in-root file wrongly blocked), everything else still passed. Restored the fix
afterward.

**Test added:** `packages/core/test/manual/identity-plan.test.ts`:
`'an imported file recorded outside the library root is a blocker'` — passes
`libraryRoot + sep` to `makeDeps` (simulating a trailing-slash config value) alongside
one legitimate in-root file and one genuinely out-of-root file. Asserts exactly one
blocker (the out-of-root file) and that the in-root file still renames correctly. This
test fails without the fix (2 blockers) and passes with it.

## Important 3 — two rationale comments still asserted the retired refusal

**Fix.**
- `packages/core/src/db/metadata.ts:378-389`: rewrote the paragraph to past-tense the
  retired claim ("until the 2026-08-16 identity-edit design, `groupHistory` used the
  foreign key... That branch replaced the refusal with the shown decision in that
  design's §5: the rows now move to the survivor instead.") while keeping the
  conclusion intact — metadata is still cleared rather than moved, because it records no
  event.
- `packages/core/src/db/groups.ts:617-624`: rewrote "Why the merge refuses on a source
  with history is a fact about the target... but that is spec §7.3's rationale" to past
  tense ("Why that merge refused... was a fact about the target... but that was spec
  §7.3's rationale"), and added a forward pointer to the existing self-correcting note
  three lines later (which already says `groupHistory` has no production caller as of
  2026-08-16).

Did not delete `groupHistory` (F14 stands); did not restructure anything.

## Important 4 — test gaps

**identity-plan.ts blocker branches.** Added to
`packages/core/test/manual/identity-plan.test.ts`:
- `'the source file itself not being a regular file is a blocker'` — replaces the live
  file with a directory at the same path, covers the source-row-not-a-regular-file
  branch (was line 335).
- `'an imported file recorded outside the library root is a blocker'` — see Important 2
  above; this is the same test, since the finding explicitly asked for it to double as
  the regression test for that fix.

Full `identity-plan.test.ts` run: 24/24 pass (was 22 before this wave).

**The `failed` banner.** Added to `packages/web/test/Picks.test.tsx`:
`'a save that leaves files unmoved reports how many, and which'` — stubs
`GroupEditResponse.failed` with one entry and asserts the "Saved, but N file(s) could
not be moved" banner renders with the path and error. Placed in `Picks.test.tsx` rather
than `Browse.test.tsx`: Picks's existing `stubApi` fixture already models `groupEdit`
directly with no card-patching to also account for, so the test is a straight line to
the banner's exact text — Browse's `applyEdit` builds the identical message from the
identical `GroupEditResponse.failed` (see the comment on each route's `applyEdit`), so
covering it once here is sufficient without touching Browse's test file.

## Minor 8 — a stale digest silently replaced the plan

**Fix.** `packages/web/src/api/useIdentityChange.ts`:
- Added a `stale` boolean to the hook's internal state (`useState`), reset to `false`
  whenever a fresh dialog opens (`begin`'s two `setPending` sites) and on `cancel`, set
  to `true` only in `confirm`'s stale-digest re-plan branch, and returned from the hook.
- `packages/web/src/components/IdentityChangeConfirm.tsx`: added an optional `stale`
  prop; when true, renders one line above the plan ("This plan changed since you opened
  it, so it was refreshed below — check it again before confirming.").
- `packages/web/src/routes/Browse.tsx` and `packages/web/src/routes/Picks.tsx`: both pass
  `stale={identityChange.stale}` through to `IdentityChangeConfirm`.

**Test added:** `packages/web/test/useIdentityChange.test.tsx`:
`'a stale re-plan says why, not just what'` — confirms the line is absent before the
stale re-plan and present after.

## Minor 9 — Confirm clickable during the stale re-plan

**Fix.** `packages/web/src/api/useIdentityChange.ts`'s `confirm()`: moved `setBusy(false)`
out of the unconditional pre-branch position and into each branch after its own
`await`s complete (saved / stale-replan-success / stale-replan-failure / non-stale
failure), so `busy` (and therefore Confirm's `disabled`) stays true through the
re-plan's `await` instead of dropping false before it. One-line comment explaining why.
Covered incidentally by the existing `'a stale digest re-plans in place and keeps the
dialog open'` test and the new stale-message test, both of which still pass; no
dedicated new test was needed since Minor 9 has no separate observable effect beyond
`busy`'s value, which those tests already drive through the same code path.

## Minor 13 — discharged #39 instruction sat above the live #2 one

**Fix.** `docs/known-issues.md`: deleted the line
`#39 is closed by this branch and should be marked closed on merge.` (was line 410).
Left the `**Closed: a group ingested before its site was learned...**` paragraph above
it untouched (settled reasoning), and left the `#2 is closed by this branch...` line at
the end of the following paragraph untouched.

## Recommendation — interleaving risk recorded

**Fix.** `docs/superpowers/specs/2026-08-07-manual-metadata-design.md` §11 Known risks:
added a bullet ("A rename can interleave with a concurrent import for the same
survivor.") recording that `editGroup`'s phases 2/3 hold no lock across their `await`s
while `pipeline/scheduler.ts` runs in the same process (confirmed: `main.ts` starts one
scheduler in-process alongside the HTTP server that serves `editGroup`), so an upgrade
import for the survivor can interleave with a rename. Noted the traced worst case (a
failed rename reported in `failed`, row still truthful, covered by §5.1's failure model
and finished by §5.2's retry) and phrased it as a recorded risk, matching the voice of
the existing bullets, not a defect or a TODO.

## What was NOT touched

Per instructions: the six deferred Minors (`identity-plan.ts:350` wording,
`operations.ts:419-420` overcounting, pre-checking doomed rows, the duplicated
failure-message construction, the unmount-drops-`pending.resolve` case, `mkdtemp`
cleanup in tests), `groupHistory` deletion, planner/applier restructuring, the README,
and `as unknown as typeof fetch` in tests.

## Verification gate

```
npm run lint         → exit 0 (only pre-existing warnings, no errors — same as baseline)
npm run typecheck     → exit 0, all 5 workspaces clean
npm run test          → test:server 878 pass / 0 fail (baseline 876 + 2 new)
                        test:web    186 pass / 0 fail (baseline 182 + 4 new)
npm run build         → exit 0, all 4 packages built
npm run e2e           → 15 passed (unchanged from baseline)
```

New tests added this wave, by file:
- `packages/core/test/manual/identity-plan.test.ts`: +2
  (`'the source file itself not being a regular file is a blocker'`,
  `'an imported file recorded outside the library root is a blocker'`)
- `packages/web/test/useIdentityChange.test.tsx`: +2
  (`'a blocked plan with no renames or trashing still requires confirmation'`,
  `'a stale re-plan says why, not just what'`)
- `packages/web/test/Picks.test.tsx`: +2
  (`'a blocked plan with no file work still shows its blocker and saves nothing'`,
  `'a save that leaves files unmoved reports how many, and which'`)

## Staging check

```
git add -A
git status --porcelain | awk '{print substr($0,1,1)}' | sort -u
```
Output: `A` and `M` only — no untracked (`?`) or unstaged (leading space) entries.
Nothing was committed; nothing was pushed.

## Files touched this wave

- `packages/core/src/manual/identity-plan.ts`
- `packages/core/test/manual/identity-plan.test.ts`
- `packages/core/src/db/metadata.ts`
- `packages/core/src/db/groups.ts`
- `packages/web/src/api/useIdentityChange.ts`
- `packages/web/test/useIdentityChange.test.tsx`
- `packages/web/src/components/IdentityChangeConfirm.tsx`
- `packages/web/src/routes/Browse.tsx`
- `packages/web/src/routes/Picks.tsx`
- `packages/web/test/Picks.test.tsx`
- `docs/known-issues.md`
- `docs/superpowers/specs/2026-08-07-manual-metadata-design.md`
