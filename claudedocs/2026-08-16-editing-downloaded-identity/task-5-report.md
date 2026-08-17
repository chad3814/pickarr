# Task 5 Report: The planner — classification, counts, and pick reconciliation

## Summary

Implemented the database half of the identity-change planner: `resolveIdentityFor`
in a new `values.ts` (holding the four helper functions moved out of
`operations.ts`), and `planIdentityChange` in a new `identity-plan.ts`. Test
fixtures shared across `operations.test.ts` and the new `identity-plan.test.ts`
live in a new `test/manual/fixtures.ts`, per Ruling 1. `reconcilePick` was
restructured with no non-null assertions, per Ruling 2. Full gate passes:
lint clean, typecheck clean, 850 server tests + 165 web tests pass, build
succeeds. All six files staged, nothing committed.

## Changes Per File

### `packages/core/src/manual/values.ts` (new)

Moved `buildRelease`, `mergedValues`, `editHooks`, `mediaFor` out of
`operations.ts` verbatim (comments included), added `export` to each. Added
`resolveIdentityFor(plugin, group, values)`, exactly as the brief specifies,
which runs the prefill → merge → rebuild → `validateIdentity` pipeline that
was previously inline in `editGroup`.

### `packages/core/src/manual/operations.ts` (modified)

- Deleted the four helper function bodies (now imported from `./values.ts`).
- Removed now-unused imports (`ParsedRelease`, `GroupRow`, `validateIdentity`
  stayed — still used by `editGroup` directly for the merge path's own
  identity check, unrelated to the planner).
- `editGroup` and `editRelease` are otherwise byte-identical; this was a pure
  relocation. Confirmed with a full `npm run test:server` run before adding
  any new code (840/840 passed, unchanged from before the move).

### `packages/core/src/manual/identity-plan.ts` (new)

`IdentityPlan`, `PlannedRename`, `PlannedTrash`, and `planIdentityChange`, as
specified. `renames`, `trashing`, `warnings`, `blockers` are empty arrays
(Task 6's job). Digest computed over the plan object via `crypto.subtle.digest`
in a fixed key order — comment in place explaining why that order must not
change or be built from a spread.

**Ruling 2 applied**: `reconcilePick`'s inner helper (renamed `heldScore`, kept
as a private function rather than a closure, since it needs `db` and no
outer-scope capture) now returns `{ releaseId: number; score: number } | null`
instead of a bare score. This eliminates every `!` in the original brief code.
One subtlety surfaced during typecheck: a single `if (sourceHeld === null &&
targetHeld === null)` guard followed by `if (targetHeld === null)` does **not**
let TypeScript narrow `sourceHeld` to non-null in the second branch — narrowing
via elimination only works within a single conditional expression that tests
the variable directly, not via boolean inference chained across two separate
`if` statements over two different variables. Restructured as nested
`if (sourceHeld === null) { ... } if (targetHeld === null) { ... }` — every
branch's non-null value is established by a direct check on that same
variable, so the final `.score` comparison and both surviving/superseded
literals are built from values TypeScript already knows are non-null. No `any`
or `unknown` used to route around it.

### `packages/core/test/manual/fixtures.ts` (new)

Exports `NOW`, `PLUGIN`, `registryFor`, `makeDeps`, `ok`, `failure`, and
`seedTwoGroups`. `registryFor(plugin, libraryRoot = '/library')` now takes an
optional root, threaded into both `libraryRoot()` and `libraryRootById()`.
`makeDeps(db, plugin = PLUGIN, libraryRoot = '/library')` passes it through
and includes `trashDir: '/trash'` (`ManualDeps` already requires it as of
Task 4). `NOW` is exported too, beyond the ruling's literal list — `makeDeps`'s
`now()` closure and `operations.test.ts`'s direct `assert.equal(x, NOW)`
assertions have to agree on the same literal, so leaving two separate `const
NOW = 5000` declarations around would have been exactly the kind of
duplication Ruling 1 objects to.

`seedTwoGroups` here is the brief's identity-plan merge fixture (titles A/B,
1080-vs-2160 scores, a `downloads` row on release 1) — used by
`identity-plan.test.ts` and, per your framing, by Task 7's applier tests
later.

**Deviation, flagged for your attention**: `operations.test.ts` already had
its own `seedTwoGroups` (different data: titles G1/G2, scores 720/2160,
`list_rank_at` 500/600, no `downloads` row), used by ~15 of its existing
tests with assertions calibrated to those exact values. This is a genuine
name collision, not duplication — the two functions seed different scenarios
for different purposes, and forcing both files onto one shared
`seedTwoGroups` would either break `operations.test.ts`'s existing,
calibrated assertions, or require rewriting ~15 tests well outside this
task's scope. I left `operations.test.ts`'s own `seedTwoGroups` in place,
local and unexported, and did **not** import the shared one into that file.
Ruling 1 said "have BOTH files import [PLUGIN, registryFor, makeDeps, ok,
failure, seedTwoGroups] from it" — I did that for the first five; for
`seedTwoGroups` specifically I judged that literal compliance would either
silently break sixteen passing tests or require an unauthorized rewrite of
an existing test file, so I kept `operations.test.ts`'s own version and
documented the conflict here instead of guessing which way you'd want it
resolved. Please confirm this is the right call, or tell me to rewrite
`operations.test.ts`'s assertions onto the shared fixture instead.

### `packages/core/test/manual/operations.test.ts` (modified)

Removed its local `PLUGIN`, `registryFor`, `makeDeps`, `ok`, `failure`, `NOW`
definitions; imports them from `./fixtures.ts` instead. Kept `THROWS_ON_SCORE`,
`THROWS_ON_PREFILL`, `BARE` (single-purpose plugin variants used only here),
and all of its own seed functions (`seedFeedItems`, `seedPickedGroup`, its own
`seedTwoGroups`, `seedWorseSource`, `seedFlaggedTarget`, `seedEditableReleases`,
`insertDownload`) untouched, per your instruction to leave single-purpose
fixtures where they are.

### `packages/core/test/manual/identity-plan.test.ts` (new)

The brief's eleven — actually ten, see below — tests, verbatim, importing
`makeDeps`, `ok`, `failure`, `seedTwoGroups` from `./fixtures.ts` instead of
copying them inline.

## ManualResult Import Direction

Kept as the brief specifies: `identity-plan.ts` imports `ManualDeps` and
`ManualResult` from `./operations.ts`. No circular import problem arose in
this task — `operations.ts` does not import anything from `identity-plan.ts`
yet (that will presumably happen in Task 7, when `operations.ts` or a new
apply function needs `planIdentityChange`). I did not preemptively move
`ManualResult` into `values.ts`, since doing so without a concrete need would
be a speculative structural change outside this task's file list. Flagging
this explicitly since Task 7 will need to revisit it: if Task 7's applier
lives in `operations.ts` (or is imported by it) and needs `IdentityPlan`,
the cycle the brief anticipated will materialize then, and `ManualResult`
should move to `values.ts` at that point.

## Gate Results

```
npm run lint        PASS (0 errors; pre-existing warnings elsewhere, none in new/changed files)
npm run typecheck   PASS (all 5 workspaces clean)
npm run test:server PASS — 850 tests, 0 failed (840 pre-existing + 10 new in identity-plan.test.ts)
npm run test:web    PASS — 165 tests, 0 failed
npm run build       PASS (all 4 workspace bundles built)
```

Ran `npm run test:server` twice: once immediately after Step 1 (the pure
relocation, before writing any planner code) to confirm it changed nothing —
840/840 passed, matching the pre-existing count exactly — and again at the
end with the new test file present, giving 850/850.

## Brief Discrepancies

1. **Test count**: Step 6 says "Expected: PASS, all eleven," but the test
   file the brief hands over verbatim contains exactly ten `test(...)` calls.
   Not a functional issue — just noting the arithmetic is off by one.
2. **`seedTwoGroups` naming collision** — covered above under Ruling 1;
   this is the substantive one, not just an arithmetic slip.

## Concerns

- The `seedTwoGroups` resolution above is a judgment call I made rather than
  a instruction I fully executed — please review it specifically.
- `ManualResult`'s eventual home (see above) is a decision deferred to
  Task 7, not resolved now; noting it so it isn't forgotten.

No commits were made. All six files (`values.ts`, `identity-plan.ts`,
`operations.ts`, `fixtures.ts`, `identity-plan.test.ts`, `operations.test.ts`)
are staged.

## Fix: renamed the shared fixture to `seedMergePair`

The coordinator ruled on the `seedTwoGroups` naming collision flagged above:
leaving two differently-shaped functions with the same name in two files is a
trap for Task 7, which adds tests to `operations.test.ts` that need the
fixtures version — importing it there would collide with that file's own
local `seedTwoGroups`. Ruling: rename the fixtures version, not the local one,
since nine of `operations.test.ts`'s existing tests reference the local name
by that name and one rename beats nine.

Changes made:

1. **`packages/core/test/manual/fixtures.ts`** — renamed the exported
   `seedTwoGroups` to `seedMergePair`. Extended its doc comment to state
   plainly what shape it seeds (a *merge-ready pair*: source group 1 picked on
   a 1080 release with a `downloads` row against it, unpicked target group 2
   holding a 2160 release) and to say explicitly that `operations.test.ts` has
   its own, unrelated local `seedTwoGroups` used by ~15 of its tests with
   their own calibrated scores/titles/`list_rank_at` values — and that the two
   must not be "unified" later.
2. **`packages/core/test/manual/identity-plan.test.ts`** — updated the import
   and all nine call sites from `seedTwoGroups` to `seedMergePair`. No other
   changes; the test bodies and assertions are unchanged.
3. **`packages/core/test/manual/operations.test.ts`** — left untouched, as
   instructed. Its local `seedTwoGroups` (line 85) still exists, unexported,
   with its own ~15 dependent tests.

### On the "test count off-by-one in the brief" note, spelled out for the reviewer

The brief's Step 6 says "Run and confirm it passes... Expected: PASS, all
eleven." But the code block the brief hands over verbatim in Step 3 (the
content of `identity-plan.test.ts`) contains exactly **ten** `test(...)`
calls, not eleven — I counted them individually: "an unchanged identity plans
nothing", "a changed display alone is display-only", "a key belonging to no
group is a rekey", "a key belonging to another group is a merge, and names
it", "an unpicked target adopts the source pick", "when both sides have a
pick the higher score wins", "a tie between two picks goes to the target", "a
pick naming a release the merged group will not hold counts as no pick", "the
digest changes when a displayed field changes", and "planning a group that
does not exist is 404". That is ten. This is purely a documentation
inconsistency in the brief's own count, not a sign that a test is missing —
the file was copied verbatim and every one of its ten tests passes.

### Gate re-run after the rename

```
npm run lint        PASS, exit 0 (pre-existing warnings only, none in changed files)
npm run typecheck   PASS, exit 0 (all 5 workspaces clean)
npm run test:server PASS, exit 0 — 850 tests, 0 failed
npm run test:web    PASS, exit 0 — 165 tests, 0 failed
npm run build       PASS, exit 0 (all 4 workspace bundles built)
```

Counts are unchanged from before the rename (850 server / 165 web), as
expected for a pure rename with no behavioural change. Both `fixtures.ts` and
`identity-plan.test.ts` are staged with `git add`. No commit was made.
