# Task 12 report: Amend the older spec, and close the issue

Status: DONE

## Rulings applied

- **F19**: `docs/known-issues.md` had no `issues/2)` bullet (confirmed by
  `grep -n "issues/2)" docs/known-issues.md` → no output). Added a `**Closed: ...**`
  paragraph plus a `#2 is closed by this branch...` line to the end of the
  `## Manual metadata` section, following the `#39` precedent. Did not touch the
  existing `#39 is closed by this branch...` line.
- **F20**: Amended both stale §2 bullets — "Moving files already imported" and
  "Merging groups that have history" — not just the one the brief named.
- **F21**: Confirmed via the brief's own grep that the README has no section on
  editing a group's identity, and left it unchanged.

## Edit 1 — §2, "Moving files already imported" bullet

`docs/superpowers/specs/2026-08-07-manual-metadata-design.md`, in the Out-of-scope list.

Before:
```
- **Moving files already imported.** Changing a group's identity changes where *future*
  imports land. Files already on disk stay where they are. Renaming a live library is a
  separate feature with its own failure modes.
```

After:
```
- **Moving files already imported.** This held until 2026-08-16. Until then, changing a
  group's identity changed only where *future* imports land, and files already on disk
  stayed where they were. It does not hold any more: an identity change a human makes now
  renames the files that identity already placed — see
  `docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md`. Re-rendering
  the whole library after a `pathTemplate` change is a different thing, config-driven and
  library-wide rather than one group at a time, and remains out of scope (issue #22).
```

## Edit 2 — §2, "Merging groups that have history" bullet (F20, not named by the brief)

Before:
```
- **Merging groups that have history.** See §7.3.
```

After:
```
- **Merging groups that have history.** This held until 2026-08-16, and §7.3 below still
  records why it was the right call at the time. It does not hold any more — see §7.3's
  final paragraph and
  `docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md` §5: a merge
  with history now runs once the human confirms a read-only plan of its consequences,
  rather than being refused.
```

## Edit 3 — §7.3's final paragraph

The bold statement + its immediate reasoning sentence (why the refusal was sound) are
preserved verbatim in spirit, tensed into the past; the operative "refused... Lifting this
restriction later is a self-contained change" sentence is replaced with a pointer to §5 of
the new design doc.

Before:
```
**The merge is refused with 409 when the source group has any `downloads` row or any
`imported_files` row.** Those tables reference `group_id`; the target may already carry
its own pick, its own upgrade flag and its own imported files, and silently reconciling
two picks is a guess. The message names the obstruction. Lifting this restriction later
is a self-contained change.
```

After:
```
**The merge was refused with 409 when the source group had any `downloads` row or any
`imported_files` row.** Those tables reference `group_id`; the target may already carry
its own pick, its own upgrade flag and its own imported files, and silently reconciling
two picks is a guess. That reasoning was sound, and it is why the refusal was the right
call at the time — but nothing ever deletes a `downloads` row, so the refusal turned out
to be permanent for any group ever picked from, not a "try again later".

§5 of `docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md` replaces
the refusal: a merge with history now shows the user a read-only plan of every
consequence, and only a plan the user confirms is applied.
```

The reasoning that the original refusal avoided a guess is left in place, as the brief and
this repo's convention require; only the now-false "is refused" claim and the now-false
"lifting this later is self-contained" claim are replaced.

## Edit 4 — `docs/known-issues.md`, end of `## Manual metadata` (F19)

Added after the existing `#39 is closed by this branch and should be marked closed on
merge.` line (that line itself untouched):

```
**Closed: editing the identity of a group that had already been downloaded was refused
outright, and the refusal never lifted.** This was #2. `editGroup`'s merge branch answered
409 whenever the source group had any `downloads` or `imported_files` row, and because
nothing ever deletes a `downloads` row, that refusal was permanent for any group ever
picked from — the exact correction (joining a dateless group to the dated group that
supersedes it) that a human fixing metadata by hand most needs to make. The fix replaces
the refusal with a shown plan: a read-only planner works out every consequence of the
merge, the user confirms it, and only then does anything move or get renamed on disk. See
`docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md` for the design
and `docs/superpowers/specs/2026-08-07-manual-metadata-design.md` §7.3 and §2 for the
amended reasoning.

#2 is closed by this branch and should be marked closed on merge.
```

## README (Step 4 / Ruling F21)

Ran the brief's grep and the ruling's grep:

```
$ grep -n "^## " README.md
18:## Quick start
34:## Configuration
267:## Scene metadata
337:## Operational notes
356:## Building the image directly
374:## Development

$ grep -n "edit\|identity\|merge" README.md
24:# edit config/config.json: set your feed URL(s) and libraryRoot
74:The `Settings` tab is a form over `config/config.json`: it edits the same file described
149:Every value comes from the identity key or from the group's own record, never from the
195:Re-spelling a site does *not* move its identity key: the key holds the separator-free
201:grouping: the whole pre-date run still reaches the identity key either way, so two
202:different scenes can never merge because of how the split fell.
262:nothing: the identity key is separator-free, so the group stays put and only the
264:identity key of its scenes, so anything already picked reappears as a new entry rather
270:adds a poster, synopsis, and performer list to its card. **Nothing about identity or
```

No section describes the Edit form or a human editing a group's identity. Lines 139-141
describe `pathTemplate` not moving already-imported files (still true, still issue #22,
unrelated to a single-group edit). Lines 261-265 describe changing a site's *name in
config* re-keying its scenes (mass config-driven re-keying, not one group's edit via the
Edit form). Verified both passages stay accurate as written. Changed nothing in
`README.md`.

## Gate results

All run from `/Users/chad/Projects/pickarr/worktree/edit-picked-files`:

| Command | Exit | Notes |
|---|---|---|
| `npm run lint` | 0 | Warnings only (`no-await-in-loop`, `no-shadow`, `no-map-spread`, `consistent-function-scoping`, `no-array-sort`), all in source/test files untouched by this task and pre-existing. No errors. |
| `npm run typecheck` | 0 | Clean across all 5 workspaces (`core`, `e2e`, `plugin-api`, `plugin-scenes`, `web`). |
| `npm run test` | 0 | 182 passed (web), plus core/other suites; grepped for `fail [1-9]` and found none — all `ℹ fail 0`. |
| `npm run build` | 0 | `plugin-scenes`, `core`, `web` all built cleanly. |
| `npm run e2e` | 0 | Playwright: 15 passed, 6 workers, Chromium (already installed from Task 11). |

## Files changed

- `docs/superpowers/specs/2026-08-07-manual-metadata-design.md` (§2, two bullets; §7.3's
  final paragraph)
- `docs/known-issues.md` (`## Manual metadata` section, append only)
- `README.md`: unchanged

## Index integrity check

```
$ git status --porcelain | awk '{print substr($0,1,1)}' | sort -u
A
M
```

Only `A` and `M` — no unstaged (` `) and no untracked (`?`) entries. Confirmed both before
and after staging this task's two files. `git add docs/` was run (no need for `README.md`
since it is unchanged); both target files now show `M ` (staged, clean working tree) in
`git status --porcelain`.

## Concerns

None. No third stale place in the older spec was found beyond the two §2 bullets named in
Ruling F20 — I re-read §2, §7, and §7.3-§7.4 in full and did not find another passage this
branch contradicts. The "defect §7.3 did not name" (a picked, keyless-history group that
re-keys with no refusal at all, per the new design doc's §10 third amendment) is a claim
about a gap the *old* spec never made in the first place — there is nothing in the
2026-08-07 spec asserting the opposite of it — so it did not need a correction here, and I
left it to the new design doc's §10, where it already lives.

---

# Fix round 1

Review came back Needs fixes: the four original amendments were confirmed correct, but
three further passages in `docs/superpowers/specs/2026-08-07-manual-metadata-design.md`
still asserted the retired behaviour. Fixed all three, and read the whole file end to end
to check for a fourth.

## Full-file scan (section by section)

Read `docs/superpowers/specs/2026-08-07-manual-metadata-design.md` top to bottom this
round, not just the sections touched in the first pass:

- §1 What this adds — no claim about refusal, files, or merge scope. Clean.
- §2 Scope — already amended (round 1); re-read, still correct.
- §3 Where the data lives — describes identity/display as group-level, quality as
  release-level. No claim contradicted by this branch. Clean.
- §4 Plugin contract — the field-scope table and contract rules. Clean.
- §5 Identity construction — the round-trip property and `titleOrder`. Clean.
- §6 Data model — migration 3, `edited_at` columns. Clean.
- §7.1 Resolve — bump rule for arrivals. Clean.
- §7.2 Dismiss — Clean.
- §7.3 Edit a group — already amended (round 1); re-read, still correct.
- §7.4 Edit a release — "Anything already imported keeps the path it was given (§2)."
  Checked against the new design doc: this is a *quality* edit, which never changes the
  identity key, so the planner/applier this branch adds (which only fires on an identity
  change) never touches it. This claim is still true and needed no fix.
- §8 HTTP API — **Finding 3, fixed** (below).
- §9 Web UI — describes the Failed tab and Browse's Edit control patching cards from the
  response. Checked for the three retired claims (blanket refusal, files left behind,
  merge impossible for history) — asserts none of them. Not touched.
- §10 Testing — **Finding 2, fixed** (below).
- §11 Known risks — **Finding 1, fixed** (below); its other two bullets (wrong manual
  identity, `suggestManualValues` best-effort) assert neither retired claim. Not touched.

Also ran `grep -n "refus\|409\|left behind\|leaves .* behind\|old path\|already imported\|impossible"` over the whole file before and after fixing, to catch anything the section read missed. Before: the three findings' lines plus the already-amended §2/§7.3 lines and unrelated 404/409 lines for *other* operations (resolve, dismiss, no-plugin-for-feed) that were never about this branch. After: only the already-amended lines and those same unrelated 409s remain.

**Result: no fourth passage found.** The three named findings were the complete set of
drift in this document.

## Finding 1 — §11 Known risks

Before:
```
- **Editing a group with imported files leaves those files behind** under the old path,
  while future imports use the new one. The group's history then spans two layouts.
```

After:
```
- **Editing a group with imported files left those files behind**, under the old path,
  while future imports used the new one, and the group's history then spanned two
  layouts. This held until 2026-08-16. It does not hold any more: an identity change now
  renames the files that identity already placed, so the two layouts do not diverge. See
  `docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md` §5.
```

Tensed the retired claim to the past (matching the §2/§7.3 convention from round 1),
stated that it no longer holds, and pointed at the new design doc's §5 (the applier that
now does the renaming).

## Finding 2 — §10 Testing, **Core.** paragraph

Before:
```
**Core.** Resolve creating a group; resolve joining an existing group; resolve rejected
for an item that already parsed. Dismiss, and its 409. Group edit: display-only, key
change, merge, merge refused for a group with a download, merge refused for a group with
an imported file. The merge's bump rule and both of its boundaries: ...
```

After:
```
**Core.** Resolve creating a group; resolve joining an existing group; resolve rejected
for an item that already parsed. Dismiss, and its 409. Group edit: display-only, key
change, merge. The two tests that once asserted a 409 for a merge whose source held a
download or an imported file are rewritten, not deleted, to assert the replacement
behaviour — the plan/confirm/apply sequence of
`docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md` §9 — and stand
as the record that this was once refused. The merge's bump rule and both of its
boundaries: ...
```

Checked the new design doc's own §9 Testing (line 340-341) before writing this: "The two
existing tests asserting the `downloads` and `imported_files` 409s are rewritten to assert
the new behaviour, not deleted. They are the record that this was once refused." Reused
that framing directly rather than inventing a different one, since it is the authoritative
description of what actually happened to those two tests.

## Finding 3 (Minor) — §8 HTTP API table

Before:
```
| PATCH | `/api/groups/:id` | `{ values }` | `{ group: GroupView, mergedInto: number \| null }` |
```

After:
```
| PATCH | `/api/groups/:id` | `{ values, planDigest? }` | `{ group: GroupView, mergedInto: number \| null, renamed: number, trashed: number, failed: { path: string, error: string }[] }` |
```

Source of the shape: not re-derived from the new design doc's own (untyped) §7 table, but
read from the actual code to get exact types — `GroupEditResponse` in
`packages/core/src/http/views.ts:235-241` (`group: GroupView; mergedInto: number | null;
renamed: number; trashed: number; failed: readonly { path: string; error: string }[]`) and
`editBodySchema` / the `PATCH /api/groups/:id` handler in
`packages/core/src/http/server.ts:228-234,1022-1045` (`{ values, planDigest? }`). This
keeps the row consistent with this table's own existing style (inline TS-ish types) rather
than switching to the new doc's bare-name style.

## Gate

Not re-run this round, per the coordinator's instruction: the full five-command gate was
already controller-verified at this tree (lint 0, typecheck 0, server 876/0, web 182/0,
build 0, e2e 15 passed), and a docs-only edit cannot change that result.

## Re-staged

```
$ git add docs/
$ git status --porcelain | awk '{print substr($0,1,1)}' | sort -u
A
M
$ git status --porcelain docs/
M  docs/known-issues.md
M  docs/superpowers/specs/2026-08-07-manual-metadata-design.md
```

Only `A`/`M` — no unstaged or untracked entries. Both target files staged clean.

## Concerns

None. All three findings fixed; full-file re-read found no fourth passage asserting the
retired blanket refusal, files-left-behind, or merge-impossible-for-history behaviour.
README and line 410's `#39 is closed...` line were left untouched, as instructed.
