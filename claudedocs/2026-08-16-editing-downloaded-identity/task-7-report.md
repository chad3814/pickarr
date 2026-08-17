# Task 7 report — the applier

## What changed, per file

### `packages/core/src/db/imported-files.ts`
Added the two functions the brief specifies, verbatim except for an extra
sentence of rationale on the setter:

- `getImportedFile(db, id): ImportedFileRow | null` — reuses the module's
  `SELECT` and `toRow`.
- `setImportedFileDest(db, id, destPath): void` — comment records *why* it is
  only ever called after the file has actually moved.

Placed above `findLiveByDest` so the plain-lookup functions sit together.

### `packages/core/src/manual/operations.ts`
`editGroup` replaced. It is now `async`, takes a fourth optional `planDigest`,
and returns `ManualResult<GroupEditOutcome>`; `GroupEditOutcome` is exported
from this module (`groupId`, `mergedInto`, `renamed`, `trashed`, `failed`).

Phases, in the order the safety argument requires:

- **Phase 0** — `planIdentityChange` is re-run (never trusted from the caller).
  `blockers` refuse with 409 *before* the digest is compared, so a confirmed
  digest is never permission to overwrite something that appeared since.
  `needsConfirmation` is `kind === 'merge' || renames.length > 0 ||
  trashing.length > 0` — the `renames`/`trashing` terms are what let a re-save
  finish an interrupted edit, whose `kind` is `'none'`.
- **Phase 1** — one synchronous transaction, database only. Releases, downloads
  and imported files move; the adopted pick is written with `markPicked`
  **before** `flagUpgrade`/`refreshUpgradeFlag` (Ruling B — **corrected** in the
  second fix section below: the ordering is right, but it is *not* load-bearing,
  and the comment no longer claims it is); `earnsListBump` is read **before**
  `moveReleasesToGroup`; metadata is cleared, the source deleted. The invariant
  ("after phase 1 the database is fully correct about grouping and every
  `dest_path` still truthfully names where its file is") is stated in the
  function's doc comment where a reader will hit it before the code.
- **Phase 2** — `trashFiles` over the rows named by `plan.trashing`, before any
  rename, with the `import.ts` rationale quoted in the comment.
- **Phase 3** — one `moveWithinLibrary` at a time, each row's `dest_path`
  written in its own small transaction immediately after its own file moved.

Failures in phases 2 and 3 are collected into `failed` and never rethrown.

Two deliberate departures from the brief's code, both explained below under
"what the brief got wrong": the filesystem work is skipped entirely when the
plan moves no files, and a `trashFiles` throw is reconciled against the rows
rather than blamed on `rows[0]`.

Imports: added `mkdir`/`realpath`, `resolve`, `markPicked`,
`moveDownloadsToGroup`, `moveImportedFilesToGroup`, `getImportedFile`,
`setImportedFileDest`, `ImportedFileRow`, `moveWithinLibrary`, `trashFiles`,
`planIdentityChange`, `resolveIdentityFor`. Removed `findGroup`,
`groupHistory`, `validateIdentity` and `PreparedIdentity`, which `editGroup` was
the only user of.

### `packages/core/src/http/server.ts`
One line: `await editGroup(...)`, plus a comment saying no digest is threaded
through yet and that Task 8 adds the plan route and the forwarded `planDigest`.
The response shape is untouched (`{ group, mergedInto }`), so `views.ts` and the
web client are unchanged. Consequence, by design of the task split: `PATCH
/api/groups/:id` now 409s for anything that moves releases or files until Task 8
lands.

### `packages/core/test/manual/operations.test.ts`
Two existing refusal tests inverted (below), fifteen existing tests made `async`
(and the merge ones given a real digest), and eight new tests added in a new
`--- Apply an identity change to the library ---` section.

New helper, used by every merge test:

```ts
async function applyPlanned(deps: ManualDeps, groupId: number, values: Record<string, string>) {
  const plan = ok(await planIdentityChange(deps, groupId, values));
  return editGroup(deps, groupId, values, plan.digest);
}
```

Per **Ruling A** there is no fifth parameter and no bypass: `editGroup` is
`(deps, groupId, values, planDigest?)`, and every test that applies something
that moves gets its digest from a real `planIdentityChange` call.

### `packages/core/test/http/manual.test.ts`
Two tests adjusted to the interim HTTP behaviour (below).

## The `ManualResult` import direction

Left as it is, and nothing had to move. `identity-plan.ts` imports `ManualDeps`
and `ManualResult` from `operations.ts` with `import type`, which is erased
entirely at emit, so `operations.ts` importing the *value* `planIdentityChange`
from `identity-plan.ts` creates no runtime cycle — only a type-level one, which
TypeScript resolves without complaint. `tsgo --noEmit` is clean and all 869
server tests (which load both modules under tsx) pass, so the shared type stayed
in `operations.ts` and `values.ts` was not touched. Moving it would have been
churn with no defect to point at.

## Existing tests touched, and exactly what changed

**Inverted (the record of a decision being reversed).** Both keep a doc comment
naming the message they used to assert and why the refusal was permanent.

1. `a merge is refused when the source group has a download`
   → `a source group with a download recorded against it now merges`.
   Same seed and same direction as before (source is group 2, target group 1,
   `insertDownload(db, 2, 2)`). Assertions inverted: `mergedInto === 1`,
   `getGroup(db, 2) === null`, group 1 now holds releases `[2, 1]`, and the
   `downloads` row that used to make this permanent now reads `group_id = 1`.
   Applied through `applyPlanned`, so it goes through the digest gate.

2. `a merge is refused when the source group has an imported file`
   → `a source group with an imported file recorded against it now merges`.
   Same seed (download against the target, `imported_files` row against the
   source at `/a` → `/b`). Two changes beyond inverting the assertions:
   - it uses `FILING` rather than the default `PLUGIN`, because `PLUGIN`'s
     `planImport` returns `null` and the planner (correctly) turns "the plugin
     will not place this live file under the new identity" into a *blocker*, so
     with `PLUGIN` this would still be a 409 — for a new reason that has nothing
     to do with the reversal being recorded;
   - it asserts the planner's `already gone from disk` warning first, because the
     row's `/b` does not exist, which is what keeps this test about the *row*
     travelling with the merge (`filesForGroup(db, 1)` → `[1]`). The file half
     is covered by the eight new tests.

**Mechanically updated for the async signature** (no assertion weakened):
`editing only the display…`, `editing the key to an unused one…`,
`editing the key to another group merges…`, `a merge bumps list_rank_at…`,
`a merge that brings in nothing better…`, `a merge that ties an already-flagged
upgrade…`, `a merge leaves the target group its own display…`,
`merging a group that has been browsed…`, `an identity edit forgets metadata…`,
`a save that changes nothing…`, `editGroup 404s…`, `editGroup reports the
plugin's own message…`, `editGroup 400s when the identity… fails validation`,
`a group can be edited under a plugin whose score throws`, `a plugin that throws
while prefilling…`, `a plugin with no manual hooks refuses all three edits…`.

Within that set, three kinds of change:

- every merge test now goes through `applyPlanned` (a real digest). The three
  `list_rank_at` ordering tests the brief asked to keep unchanged in *substance*
  keep their seeds, their comments and their assertions exactly; only the call
  changed.
- the four tests that did `assert.deepEqual(result, { groupId, mergedInto })`
  now compare against the full outcome including `renamed: 0, trashed: 0,
  failed: []`, which pins "this edit moved no files" rather than ignoring it.
- `a merge that fails at the delete leaves nothing behind` became
  `await assert.rejects(...)` instead of `assert.throws(() => ...)`, and plans
  first so it still passes through the digest gate. Its post-conditions
  (releases un-moved, `edited_at`/`upgrade_release_id` null on the target,
  source still present, `db.isTransaction === false`) are unchanged.

**HTTP, two tests** — these had to change because `PATCH /api/groups/:id` cannot
carry a digest until Task 8, so an unconfirmed merge is now a 409 whatever the
route does:

1. `a merge answers with the target group and names it in mergedInto`
   → `an unconfirmed merge is refused, and the two groups stand`. Asserts 409,
   `/must be confirmed first/`, and that *both* groups are untouched. Its doc
   comment says the success-path assertions (`mergedInto: 1`, the target's
   releases, the deleted source) belong with the route that can pass a digest —
   Task 8's own step-1 tests reinstate them — and that
   `operations.test.ts` covers the merge itself meanwhile.
2. `a merge refused for a group with a download is a 409 that says why`
   → `a download against the source is no longer its own refusal`. Same request,
   asserts 409 with `/must be confirmed first/` **and**
   `assert.doesNotMatch(..., /will not clear by waiting/)`, i.e. the download is
   no longer an obstruction of its own — the answer is now identical to the one
   a source with no download gets.

No test was deleted anywhere.

## New tests

`the reported scenario: correcting a picked group merges it into the other one`
(asserts `upgradeReleaseId === 2`; **corrected** — that assertion passes with the
flag calls in either order, because `markPicked` re-derives the flag itself, so it
does not pin the ordering as my first report claimed),
`a stale digest is refused and changes nothing`,
`a missing digest is refused when the plan moves anything`,
`a display-only edit still applies with no digest`,
`a blocked plan is refused`,
`a failing rename leaves the merge standing and reports the file`,
`re-saving after a failed rename finishes the remaining work`,
`a superseded pick is trashed before the survivors are renamed`.

The last one is stronger than the brief's version — see below.

## Gate

```
npm run lint       → exit 0 (warnings only; the new `await` in phase 3's loop
                     draws the same `no-await-in-loop` warning identity-plan.ts
                     already draws, and no new rule class)
npm run typecheck  → clean, all six projects
npm run test:server → tests 869, pass 869, fail 0
npm run test:web    → tests 165, pass 165, fail 0
npm run build      → clean (plugin-api, plugin-scenes, core, web)
```

`--test-name-pattern` was not used; both suites were run whole, as instructed.

## What the brief got wrong, and how it was resolved

1. **`editGroup(deps, 1, {...}, undefined, true)`** — the fifth "escape from the
   digest requirement" argument. Not implemented, per Ruling A. Tests plan and
   pass a real digest.

2. **`seedTwoGroups` in the shared fixtures** is really `seedMergePair`; and
   `operations.test.ts` has its own unrelated local `seedTwoGroups`. The brief's
   snippets that say `seedTwoGroups` were read as whichever the test actually
   needed: the new file-moving tests use `seedWithFile` from the fixtures, and
   the inverted refusal tests and the display-only test use the file's own local
   `seedTwoGroups` (untouched).

3. **Unconditional library-root resolution.** The brief resolves, `mkdir`s and
   `realpath`s the library root on every call, before phase 2. With the shared
   fixture's default `libraryRoot` of `/library` that is `mkdir('/library')`,
   which fails with EACCES for a non-root user — it would have broken every
   existing `editGroup` test. It is also wrong on its own terms: saving a title
   must not create a library root as a side effect, and must not be refusable
   because it could not. Resolution is now inside `if (plan.trashing.length > 0
   || plan.renames.length > 0)`.

4. **A `trashFiles` throw blamed on `rows[0]`.** `trashFiles` marks each row
   trashed immediately after moving that file and can throw after earlier rows
   moved fine, so the brief's `failed.push({ path: rows[0]?.destPath ?? '' })`
   could name a file that moved perfectly and hide one that did not. The rows are
   read back instead: each row that is now `trashed_at`-stamped counts toward
   `trashed`, each that is not is reported in `failed`.

5. **Failure to resolve the library root** is not a per-file failure and the
   brief does not say what to do with it. Throwing would give a 500 for an
   operation whose committed half succeeded — the exact failure mode phase
   ordering exists to prevent — so it is caught and reported as a `failed` entry
   for every path the plan wanted to move, since none of them can proceed.

6. **The trash-before-rename test does not test what its comment claims.** The
   brief's version gives the *target* the winning pick, so the source's file is
   trashed and nothing is renamed; the stray `k2/1080.mp4` it writes is never
   contended for. Rewritten so the *source's* pick survives (target release
   rescored to 500) and the target's file is the superseded one: the apply then
   does a trash **and** a rename, and the injected `deps.rename` checks from
   inside phase 3 that the superseded file was already gone — the ordering
   observed rather than asserted about. `trashDir` is a real `mkdtemp`
   directory, not the fixture's `/trash`, which is not writable.

## Concerns

1. **The planner pre-blocks the collision that phase 2 exists to clear.**
   `planIdentityChange` refuses any rename whose destination exists
   (`"is occupied by something this group did not put there"`) — *including* when
   the occupant is a file the same plan lists in `trashing`. So the production
   case that motivates trash-before-rename (a superseded file sitting exactly
   where a survivor is going) currently produces a blocker and a 409 rather than
   a successful apply. Phase 2 before phase 3 is still the right order and is now
   observably taken, but it cannot yet be reached through a *collision*. The fix
   belongs in the planner (treat a path it plans to trash as not an obstruction),
   and it changes the digest, so I did not make it inside Task 7. Flagging for
   the owner: this is a real functional gap in the feature, not a test artefact.

2. **`PATCH /api/groups/:id` cannot merge until Task 8.** Deliberate and
   task-ordered, but it is a genuine interim regression in the running app, and
   `packages/e2e/tests/manual.spec.ts`'s `editing a group into another merges it
   and leaves no card behind` will fail until Tasks 8–10 land (e2e is not part of
   the gate, so it did not surface here). Task 11 is the e2e task.

3. **`groupHistory` (and `GroupHistory`) in `db/groups.ts` is now dead
   production code** — only its own tests in `test/db/manual.test.ts` reference
   it. It is a correct, well-documented query and no later task brief mentions
   it, so I left it and its tests alone rather than expanding this task's diff.
   Worth a decision before the branch closes.

4. **`trashed` counts rows, not bytes moved.** A row whose file was already gone
   from disk is marked trashed by `trashFiles` with a null `trash_path` and
   counts toward `trashed`, which is the honest reading of "this row no longer
   describes a live file" but is not the same as "a file was moved". Consistent
   with how upgrade imports already report.

5. Temp directories created by the new tests are not removed, matching
   `identity-plan.test.ts`'s existing style.

---

## Fix section — coordinator rulings 1 and 2

### Ruling 1: the planner's occupied-destination blocker (concern 1, now fixed)

`packages/core/src/manual/identity-plan.ts`

- Added `trashedPaths`, a `Set` of the `doomed` rows' `destPath` values, built
  beside the existing `doomedIds` set at the same point (the trashing decision
  already precedes the rename loop, so no reordering was needed).
- The occupant check is now
  `if (occupant !== null && !trashedPaths.has(to))`. Every other occupant — an
  unrelated file, an operator's own, a directory — still blocks.
- Both the set and the check carry comments naming phase 2 of `editGroup`
  explicitly, stating that this is the *motivating* case for trash-before-rename
  rather than a corner of it, and saying outright not to simplify the exemption
  away.

The digest changes for plans in this shape, which is harmless: no plan is
persisted, and a digest only has to be stable between one plan call and its own
apply.

**Covering tests**

- `packages/core/test/manual/identity-plan.test.ts` —
  `a destination occupied by a file this plan is trashing is not a blocker`.
  Placed directly between the two tests it is the mirror of
  (`an occupied destination is a blocker`, `a destination occupied by a directory
  is a blocker`) so the three read as one rule. Target picked on a *same
  resolution, lower score* release, so its own file sits at exactly the path the
  surviving file will take. Asserts `blockers` is `[]`, and that the same plan
  carries the trash of that path and the rename into it.
- `packages/core/test/manual/operations.test.ts` —
  `a rename into the path a superseded file occupies succeeds`. The apply of that
  plan: `trashed: 1`, `renamed: 1`, `failed: []`, the contested path now holding
  the winner's bytes (`'data'`), the source path gone, the surviving row's
  `dest_path` caught up, the superseded row `trashed_at`-stamped and its
  `trash_path` still holding `'superseded'`, and the survivor's pick adopted.
- The existing ordering test (`a superseded pick is trashed before the survivors
  are renamed`, which observes from inside `deps.rename` that the superseded file
  is already gone) is kept unchanged, as instructed. The two are complementary:
  one proves phase 2 runs first, the other proves it matters.

### Ruling 2: `groupHistory` retained with a comment

`packages/core/src/db/groups.ts` — appended a paragraph to `groupHistory`'s doc
comment recording that its only production caller was `editGroup`'s merge
refusal, that the refusal is now the plan-and-confirm flow and `editGroup`'s four
phases, and that it is kept for the distinction it states (naming
`db/migrations.ts`'s "live file" contrast and `db/metadata.ts`'s reference) and
because its tests document that a *trashed* file still counts as history. The
function, its type and its four tests are untouched.

### Gate, after the fix

```
npm run lint        → exit 0 (warnings only, no new class)
npm run typecheck   → clean
npm run test:server → tests 871, pass 871, fail 0   (was 869; +2 new tests)
npm run test:web    → tests 165, pass 165, fail 0
npm run build       → clean
```

Both suites run whole; `--test-name-pattern` not used.

### Concern status after the rulings

- Concern 1 — **fixed**, with the two tests above. The feature's motivating merge
  now plans clean and applies.
- Concerns 2 and 3 — no action, per the coordinator.
- Concern 4 (`trashed` counts rows, not bytes) and concern 5 (temp dirs not
  cleaned) stand as written; both are consistency notes, not defects.
- Nothing new surfaced. No remaining concerns from me.

---

## Fix section 2 — review round (one Critical, two Important, two Minor)

### CRITICAL: a failed phase 2 could let phase 3 destroy the superseded file

Confirmed exactly as described. `transfer` (`pipeline/import.ts`) performs no
destination check — `importDownload` does that in its *own* loop before calling
it — and the exemption added in fix round 1 deliberately removes the planner's
blocker for precisely these paths. An unwritable or misconfigured `trashDir`
makes `trashFiles` throw at its first `mkdir` before touching anything, so every
doomed file is still on disk and phase 3 would have renamed over one.

`packages/core/src/manual/operations.ts`, phase 3: each iteration now `lstat`s
`move.to` first and, if anything is there, records a `failed` entry
(`"<to> is still occupied, so it was left where it is"`) and skips the rename.
No attempt is made to tell "our doomed file" from a stranger's, per the ruling —
the comment says why: if phase 2 did not clear it, phase 3 has no business
writing there, and re-saving after fixing the trash directory plans the same
moves again, so nothing is lost by refusing. The comment also records that this
is now the *only* remaining guard, and why (`transfer` has none, the planner's is
lifted on purpose).

Folded-in **Minor**: a doomed row that vanished between plan and apply was
silently dropped, leaving its path both occupied and exempted. Phase 2 now
collects the rows in an explicit loop and pushes a `failed` entry
(`"imported file N is no longer on record, so it was not trashed"`) for a missing
one instead of filtering it out.

**Covering test** — `packages/core/test/manual/operations.test.ts`,
`a rename is refused when phase 2 failed to clear its destination`. The collision
setup (both picks 1080p, target scoring lower) plus a `trashDir` that is a regular
file, so `trashFiles`' `mkdir` fails with ENOTDIR before moving anything. Asserts
`trashed: 0`, `renamed: 0`, two `failed` entries with `/still occupied/` on the
second, **both files still on disk with their original bytes**, both rows still
naming where their file actually is, the superseded row still un-trashed, and the
merge still standing. Verified as a real regression test: with the new guard
short-circuited the test fails (872/873) and passes with it.

The vanished-doomed-row branch has no test. It is reachable only under
concurrency — phase 0 re-plans, so a row deleted before the call simply produces a
different plan (and then the occupant blocker fires) rather than reaching that
branch. Testing it would need a hook inside the transaction; flagging rather than
inventing one.

### IMPORTANT: Ruling B was wrong — comment softened, record corrected

Verified: `markPicked` writes `upgrade_release_id` from `deriveUpgradeReleaseId`
itself, so running the flag calls first and `markPicked` second yields an
identical final row, and the reported-scenario test passes either way. My original
report repeated the ruling's claim; both places that did so are now marked
**corrected** in the body above.

`operations.ts` comment rewritten to say what is actually true: the ordering is
chosen so the flag is derived against the pick the group ends up with, the flag is
correct *because `markPicked` re-derives it*, the two orders produce the same row,
and anything that changes that — splitting `markPicked` into a pick-only setter —
would make the ordering load-bearing for real, so keep it as written rather than
relying on the overwrite. A second note at the flag calls records that
`flagUpgrade` adds only the bump over what `markPicked` already did, and that
`refreshUpgradeFlag` is only meaningfully reached when **no** pick survives.

### IMPORTANT: nothing pinned "no file I/O before phase 1 commits"

Correct — the existing phase-1 rollback test uses `seedTwoGroups`, which has no
files.

**Covering test** — `packages/core/test/manual/operations.test.ts`,
`a phase 1 failure leaves every file exactly where it was`. `seedWithFile` plus
the same delete-trigger technique; asserts the plan really does contain a rename
(so the test cannot pass vacuously), that `editGroup` **rejects**, that
`k1/1080.mp4` still holds its original `'data'`, that `k2/1080.mp4` does not
exist, that the row still names the old path, that the source group survives, and
that `db.isTransaction === false`.

### Minor: `deleteGroup`'s stale doc comment

`packages/core/src/db/groups.ts` — the "only when `groupHasHistory` said no"
sentence is replaced: it now names the three moves and `clearGroupMetadata` as
what empties the row of references, and records that the `groupHistory`-based
refusal used to be what kept the statement safe, pointing at `groupHistory` for
the rest.

### Gate, after this round

```
npm run lint        → exit 0 (warnings only, no new class)
npm run typecheck   → clean
npm run test:server → tests 873, pass 873, fail 0   (was 871; +2 new tests)
npm run test:web    → tests 165, pass 165, fail 0
npm run build       → clean
```

Both suites run whole; `--test-name-pattern` not used.

### Deferred, per the coordinator

`resolveIdentityFor` runs twice per edit (once inside the planner, once in the
applier). Noted, not changed.
