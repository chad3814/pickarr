# Editing the identity of a group you have already downloaded — Design

Date: 2026-08-16
Status: approved for planning
Branch: `fix/edit-picked-files`
Closes: issue #2

## 1. What this adds

The ability to correct the identity of a group that has history — a `downloads` row, an
`imported_files` row, or both — including when the corrected identity belongs to another
group and the two must merge. When that correction changes where the group's files would
live, the files already in the library are renamed to match.

The reported case, which is the shape this is designed against:

- `SomeSite.TitleOfScene.1080p.MP4-WRB` parses with no date, and is picked, downloaded and
  imported.
- `SomeSite.26.08.14.TitleOfScene.2160p.MP4-WRB` arrives later. It is the same scene, but
  the date puts it in a different identity key, so it becomes its own group.
- The two cannot be joined. Adding the date to the picked group is the correction that
  would do it, and that is exactly what is refused.

## 2. Scope

In scope:

- Lifting `editGroup`'s refusal to merge a source group that has history.
- Reconciling two picks, and trashing the files of the pick that loses.
- Renaming imported files when an identity change moves where they belong — on the merge
  branch *and* on the plain re-key branch.
- A confirmation step that shows exactly what will happen before anything moves.
- An edit affordance on Picks, which has none today.

Out of scope:

- **Re-parsing.** Unchanged from the manual-metadata spec: nothing re-runs the parser over
  existing items.
- **A general library-rename pass.** This renames files whose group's identity a human just
  changed. Re-rendering the whole library after a `pathTemplate` change is issue #22 and
  stays there.
- **Un-merging.** A merge is not reversible in the UI. The trashed files are recoverable by
  hand from `trashDir`, which is the same guarantee an upgrade import gives.

This spec **amends the manual-metadata spec (2026-08-07)** in two places; see §10.

## 3. Why the refusal existed, and what replaces it

§7.3 of the manual-metadata spec refused the merge with 409 whenever the source group had
any `downloads` or `imported_files` row. The stated reason was sound: those tables
reference `group_id`, the target may already carry its own pick and its own files, and
silently reconciling two picks is a guess.

What made it untenable is that nothing ever deletes a `downloads` row. The refusal is
therefore **permanent** for any group ever picked from — not a "try again later", though
the message had to be written to say so out loud precisely because a user would otherwise
wait for it to clear.

The replacement is not a guess but a **shown decision**: a read-only planner works out
every consequence, the user confirms it, and only then does anything move. The guess the
old refusal was avoiding is still avoided; it is just answered by a human looking at the
answer rather than by a default nobody sees.

Two facts found while reading made this cheaper than issue #2 estimated, and both are
load-bearing enough to record:

- **In-flight downloads need no special handling.** `importDownload` derives the
  destination from the group's identity *at import time* (`pipeline/import.ts`), not at
  pick time. Once a queued job's `downloads.group_id` points at the survivor, it lands at
  the new path by itself.
- **Path derivation is already reusable.** `planSceneImport` computes a destination from
  `media` and the file's extension only — never from the source filename. So a rename
  re-derives through `plugin.planImport`, and no second path renderer comes into
  existence. This matters more than convenience: the one place a destination is computed
  must stay the one place, or a renamed file and a freshly imported one can disagree about
  where the same scene belongs.

## 4. The planner

New file, `packages/core/src/manual/identity-plan.ts`. `manual/operations.ts` already
carries four operations in 409 lines; the planner is a separate responsibility with its
own types.

The planner is **async and read-only**. It reads the database and stats the filesystem. It
writes neither. It returns:

```
kind:        'none' | 'display-only' | 'rekey' | 'merge'
mergeInto:   { id, title } | null
releasesMoving, downloadsMoving: number
pick:        { surviving: { releaseId, score, side } | null,
               superseded: { releaseId, score } | null }
renames:     [{ importedFileId, from, to }]
trashing:    [{ importedFileId, path }]
warnings:    string[]
blockers:    string[]
digest:      string
```

`warnings` are shown and do not block. `blockers` are shown and refuse the apply.

`renames` and `trashing` are disjoint: a row about to be trashed is never also renamed.
Moving a file to its new name and then immediately moving it to `trashDir` would be work
done to no end, and would report two actions against one file in the confirmation.

### 4.1 Rename destinations are computed per file, from that file's own release

For each live `imported_files` row, the new destination is
`plugin.planImport(newMedia, [theFile])`, where `newMedia` pairs the *new* identity and
display with **that file's own release's quality** — reached through
`imported_files.download_id` → `downloads.release_id`.

Not the pick's quality. A merged group can hold a 1080p file and a 2160p file at once, and
the path template renders resolution; using one release's quality for both would move a
file to a path naming a resolution it is not.

### 4.2 A rename that moves nothing is dropped

If the recomputed destination equals the current `dest_path`, the row does not enter
`renames`. A display-only edit, or a template that does not reference the field that
changed, must not present the user with a confirmation claiming work that will not happen.

### 4.3 Blockers, and the one thing that only warns

Blockers, each matching a refusal the import and upgrade paths already make for the same
reason:

- The destination is occupied by something that is not the file being moved
  (`pipeline/import.ts` refuses an unrecognised occupant rather than adopting it).
- The occupant, or the source row's own file, is not a regular file — a directory or a
  symlink (`pipeline/upgrade.ts` refuses these by name).
- The row's `dest_path` resolves outside the library root
  (`pipeline/upgrade.ts`, same check).

A warning, not a blocker: an `imported_files` row whose file is **already gone from disk**.
`trashLiveFiles` already decided this case — the row no longer describes a live file, so
there is nothing to move and nowhere honest to point at — and a merge should not be held up
by a file someone deleted by hand.

### 4.4 The pick is decided in the planner

Higher score wins. A tie goes to the target, matching migration 4's rule that the
survivor's pick stands. A `picked_release_id` naming a release the merged group will not
hold counts as no pick at all, exactly as `holds()` decides in `db/migrations.ts`: a
dangling pick is already broken, and a merge is the one moment it could be made worse.

When a pick is superseded, the live files of **its release** are trashed. One scene, one
owned file — the same outcome an upgrade import produces, reached by the same
`trashDir` route, and recoverable by hand from there.

### 4.5 Trashing is scoped by release, not by download

`trashLiveFiles` today derives its own file list through
`liveFilesForGroup(db, groupId, excludeDownloadId)` — every live file in the group *except
one download's*. That exclusion cannot express what a merge needs. A release that imported
across two download rows (a retry) has two, so excluding one would trash files belonging to
the release being **kept**.

So `trashLiveFiles` is refactored to take the rows it should trash. The import path passes
`liveFilesForGroup(db, groupId, downloadId)`, unchanged in effect; the merge passes a new
release-scoped selector that joins `imported_files` to `downloads` and keeps the surviving
release's files. One file-trashing implementation, two selectors.

## 5. The applier

`editGroup` becomes `async` and runs four phases. The ordering is the whole safety
argument, so it is stated as an ordering rather than as steps that happen to be in this
sequence.

### Phase 0 — re-plan, and compare digests

Run the same planner again. If the fresh plan requires a digest (§7) and the one the client
sent is absent or does not match, refuse with 409 and return the fresh plan: the user
re-reads a plan that changed rather than confirming one that no longer holds. If the fresh
plan carries blockers, refuse. A plan that requires no digest skips the comparison and
proceeds — that is the display-only edit, which has always saved in one click.

The digest covers **everything the confirmation displayed**, counts included. A release
ingesting into the source group between the plan and the confirm means more releases move
than were shown, and that is a material change even though it breaks nothing. The rule is
deliberately blunt — digest what was displayed — so that no future field has to be argued
about.

Computed with `crypto.subtle.digest('SHA-256', …)` over a stable serialization. The async
form, because this runs on the request path.

### Phase 1 — one synchronous transaction, database only

Re-check preconditions, then move releases, downloads and imported files to the survivor;
reconcile the pick; derive the upgrade flag; stamp `edited_at` on the survivor; clear the
source's metadata and delete it.

`earnsListBump` is still read **before** the move, for the reason §7.3 already gives: once
the releases sit under the target they are part of what it already knows about, and
`releasesForGroup(source)` is empty besides.

This phase buys the invariant the rest of the design rests on:

> After phase 1 the database is fully correct about grouping, and every `dest_path` still
> truthfully points at where its file actually is — because nothing on disk has moved yet.

The database never lies, at any instant, including part-way through.

### Phase 2 — trash the superseded release's files

Before any rename, and for the reason `pipeline/import.ts` gives for trashing ahead of its
own transfer loop: a superseded file frequently occupies the exact path a renamed file
wants, so it has to leave first. Each row is marked trashed immediately after its file
moves, so the file-by-file truthfulness of phase 1 continues.

### Phase 3 — rename, one file at a time

For each row in `renames`: `transfer(from, to, 'move', …)`, then a small transaction
updating that one row's `dest_path`.

Always `'move'`, never `deps.importMode`. A copy inside the library would leave two copies
of one file and a record of one.

A crash anywhere in this loop leaves every moved file recorded at its new path and every
unmoved file recorded at its old one.

### 5.1 Failure model

A throw in phase 1 rolls back, and nothing has moved.

A failure in phase 2 or 3 must **not** abort the rest. The merge is already committed and
was correct; abandoning the remaining files would only strand more of them. Per-file
failures are collected and returned as `{ renamed, trashed, failed: [{ path, error }] }`,
and the UI lists them.

### 5.2 The retry path, which falls out rather than being built

Re-submitting the same values after a partial failure classifies as `kind: 'none'` for
grouping — the merge already happened — but the planner still sees files at stale paths and
still offers those renames.

So: **the applier does the file work whenever `renames` or `trashing` is non-empty,
regardless of `kind`.**

That one rule makes finishing an interrupted rename the same operation as the edit, rather
than a second operation that could disagree with it. It also means a group whose files were
stranded by some *earlier* silent re-key is repaired by opening its edit form and saving it
unchanged — which matters, because that silent re-key has been possible all along (§10).

## 6. Data model

**No schema change.** No migration.

`downloads` and `imported_files` already reference `group_id`, and the merge moves those
references — which is exactly what migration 4 did when it collapsed re-keyed clusters, so
the write pattern is established rather than new.

New database functions only: a release-scoped live-file selector in `db/imported-files.ts`,
and movers for `downloads` and `imported_files` in `db/groups.ts` alongside the existing
`moveReleasesToGroup`.

## 7. HTTP API

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/groups/:id/identity-plan` | `{ values }` | the plan, with its digest |
| PATCH | `/api/groups/:id` | `{ values, planDigest? }` | `{ group, mergedInto, renamed, trashed, failed }` |

`identity-plan` writes nothing. Its statuses are `editGroup`'s own — 404 for no such
group, 409 for no plugin loaded or no manual hooks, 400 for values the plugin refuses —
carried from the operation's result rather than restated in the route, for the reason the
existing four manual routes already state: a second copy of that rule here would be free to
drift from it.

A POST rather than a GET, despite changing nothing: the values are a form's worth of fields
and belong in a body.

**When `planDigest` is required:**

> A plan with no merge and no file work applies without one. Anything that moves releases
> or files requires a matching one.

So correcting a typo in a display field still saves in a single click, exactly as it does
today, and confirmation is demanded precisely when something moves. This also keeps every
existing edit test and e2e spec meaningful rather than rewritten around a new modal.

`planDigest` is not required to be *present* on a plan that needs one so much as required
to *match*: a missing digest and a stale digest are the same refusal, because both mean the
user did not confirm this plan.

## 8. Web UI

**Picks gains the edit affordance** by passing `fields` and `onEditGroup`/`onEditRelease` to
`MediaCard` the way Browse does. `MediaCard` already accepts them, so the card itself needs
no change; Picks fetches `/api/manual-fields` as Browse does.

Picks **reloads** after an edit rather than patching its list. A merge can move a group off
Picks entirely — when the survivor holds no pick — or onto it, and which list a group
belongs to is the server's answer, not one to reconstruct on the client.

**`useIdentityChange`** holds the plan → confirm → apply sequence, so it exists once rather
than once per route. It calls the plan endpoint, resolves immediately when there is nothing
to confirm, otherwise holds the plan in state until the confirmation answers, then PATCHes
with the digest. `MediaCard`'s `onEditGroup(values) => Promise<boolean>` contract is
unchanged — the hook is what fulfils it — so the card stays presentational, which is why
`useIdentityPreview` was factored out of it in the first place.

Not to be confused with `useIdentityPreview`, which debounces a per-keystroke preview of
the identity *key* while the form is being typed into and involves no group. Different
question, different lifetime; the names are kept apart deliberately.

**`IdentityChangeConfirm`** renders the plan: the group it merges into, how many releases
and downloads move, which pick survives and which is superseded, each rename as
`from → to`, each file to be trashed, the warnings, and the blockers. Confirm is disabled
while there are blockers. A 409 from a stale digest replaces the plan in place and says
why, rather than closing and losing the user's position.

## 9. Testing

`node --test` via tsx, as everywhere else. `mkdtemp` against a real library root, as
`test/pipeline/import.test.ts` and `test/pipeline/upgrade.test.ts` already do — the renames
are tested against actual files.

**`test/manual/identity-plan.test.ts`** (new): the four classifications; a pick adopted when
only the source has one; higher score winning when both do; a tie going to the target; a
dangling pick treated as none; each blocker in §4.3; a missing file warning rather than
blocking; a `to == from` rename dropped; a group holding a 1080p and a 2160p file rendering
each under its own release's quality; and the digest changing when any displayed field
changes.

**`test/manual/operations.test.ts`** (extended): the reported scenario end to end, asserting
one surviving group holding both releases, the download and imported-file rows moved, the
pick adopted, the upgrade flagged, and the file renamed on disk with `dest_path` updated.
Then a stale digest refused with nothing changed; a missing digest refused where one is
required; **a display-only edit still applying with no digest**, guarding today's behaviour;
trash-before-rename when a superseded file occupies a renamed file's destination; and
`earnsListBump` still read before the move, so a merge bringing something better bumps and
one bringing only also-rans does not.

Partial failure gets two tests, with a failing rename injected the way `import.test.ts`
already injects `deps.rename`: a mid-loop failure leaves the merge standing, names the file
in `failed`, and leaves the database truthful; and re-submitting the same values afterwards
finishes the remainder through §5.2.

The two existing tests asserting the `downloads` and `imported_files` 409s are **rewritten
to assert the new behaviour**, not deleted. They are the record that this was once refused.

Also: `test/db/imported-files.test.ts` for the release-scoped selector, specifically that a
release with two download rows keeps **both** its files when it survives — the case that
ruled out reusing the download-scoped exclusion (§4.5). `test/pipeline/upgrade.test.ts` for
the rows-in refactor leaving the import path unchanged. `test/http/manual.test.ts` for the
new route's statuses and the digest rule. `test/Picks.test.tsx` for the affordance,
reload-on-merge, and modal-only-when-there-is-file-work.
`test/IdentityChangeConfirm.test.tsx` for the rendered plan, confirm disabled on blockers,
and a stale 409 replacing the plan in place.

**E2E**: the reported scenario through the browser — pick the dateless 1080p, ingest the
dated 2160p, add the date to the picked group, confirm, and see one group with the upgrade
flagged.

Nothing is done before `npm run check`, `npm run build` and `npm run e2e` all pass.

## 10. Amendments to the manual-metadata spec (2026-08-07)

**§2, "Moving files already imported" moves out of Out of scope.** It said changing a
group's identity changes where *future* imports land while files already on disk stay where
they are, and that renaming a live library is a separate feature with its own failure
modes. The second half stands and is now issue #22's — re-rendering the whole library after
a template change. The first half does not survive this spec: an identity change a human
made now renames the files that identity already placed.

**§7.3's merge refusal is replaced by §5 of this document.** The reasoning for the refusal
was not wrong and is preserved in §3; what changed is that the guess it avoided is now
shown to a human instead of made by a default.

**A defect §7.3 did not name, fixed here.** The history check lives only inside the merge
branch. A picked group whose corrected key collides with *nothing* is re-keyed with no
refusal at all — and a picked group is reachable in Browse whenever it carries an upgrade
flag. So re-keying a downloaded group has always been possible, and has always stranded its
files at paths the new identity would never produce, silently. The renames in §5 apply to
that branch too, and §5.2 repairs groups it has already happened to.

## 11. Known risks

**A merge is not undoable.** Phase 1 deletes the source group. The releases, downloads and
imported files survive under the survivor, and the trashed files are recoverable from
`trashDir` — but the two groups do not become two again. The confirmation step is the
mitigation, which is why the digest is strict about what it covers.

**A rename is not atomic across files.** A group with several files can end up part-renamed
if the filesystem fails mid-loop. The database stays truthful about it and §5.2 finishes the
job, but between the failure and the retry the library holds one scene under two layouts.

**`trashDir` still fills up.** Unchanged and pre-existing (issue #36): nothing empties it.
A merge that supersedes a pick adds to it.

**The confirmation is only as good as its rendering.** A plan the user cannot read is a
guess with extra steps. The rename list shows full `from → to` paths for that reason, even
though they are long.
