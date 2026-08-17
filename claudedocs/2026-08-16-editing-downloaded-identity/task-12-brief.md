### Task 12: Amend the older spec, and close the issue

The design doc records that it amends the manual-metadata spec; this task makes the amendment where a reader of that spec will actually find it.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-07-manual-metadata-design.md:33-44` (§2 Out of scope), `:264-312` (§7.3)
- Modify: `docs/known-issues.md`
- Modify: `README.md` if it documents the edit behaviour

- [ ] **Step 1: Amend §2 of the manual-metadata spec**

Replace the "Moving files already imported" bullet with a note that it held until 2026-08-16, that an identity change a human makes now renames the files that identity placed, and that re-rendering the whole library after a `pathTemplate` change remains out of scope (issue #22). Point at the new design doc.

- [ ] **Step 2: Amend §7.3**

Leave the reasoning for the original refusal in place — it is settled reasoning about why the conservative choice was right at the time — and replace the final paragraph ("The merge is refused with 409 when …") with a pointer to §5 of the new design doc, noting what replaced it: a shown plan the user confirms.

- [ ] **Step 3: Update `docs/known-issues.md`**

That file's own preamble says a bulleted link is tracked work and a paragraph is settled reasoning. Issue #2 is now done, so remove or amend its bullet accordingly, following the convention already in the file.

- [ ] **Step 4: Check the README**

Run: `grep -n "edit\|identity\|merge" README.md`

If the README describes editing a group's identity, add that an edit which moves files now asks for confirmation and renames what it placed. If it says nothing about editing, change nothing.

- [ ] **Step 5: Final full gate**

```bash
npm run lint && npm run typecheck && npm run test && npm run build && npm run e2e
```

- [ ] **Step 6: Stage, and prepare to close the issue**

```bash
git add docs/ README.md
```

Report to the human that the work is complete, and that closing issue #2 needs their say-so. Do not run `gh issue close` and do not commit or push without explicit approval.

---

## Self-Review Notes

Checked against the spec, section by section:

- §3's two findings (import-time destination derivation, reusable path derivation) — Task 6's `destinationFor` and its comment; no separate task needed because in-flight downloads require no code.
- §4.1 per-file quality — Task 6, `qualityForFile` + the "a merge plans a rename … under its own releases quality" test.
- §4.2 no-move renames dropped — Task 6, "a rename that would not move the file is dropped".
- §4.3 blockers and the one warning — Task 6, four tests.
- §4.4 pick reconciliation — Task 5, four tests.
- §4.5 release-scoped trashing — Task 1, including the two-downloads case.
- §5 phases 0-3 and §5.1 failure model — Task 7.
- §5.2 retry path — Task 7, "re-saving after a failed rename finishes the remaining work".
- §6 no schema change — no migration task exists, deliberately.
- §7 HTTP and the digest rule — Task 8.
- §8 UI — Tasks 9 and 10.
- §9 testing — distributed across every task; e2e is Task 11.
- §10 amendments — Task 12.
- §11 risks — no code; the confirmation UI in Task 9 is the mitigation for the first.

Two known roughnesses left for the implementer to resolve rather than papered over:

1. **Task 6's `doomed` expression is wrong as written** and says so: the superseded pick can sit on either side of a merge, so it needs a call for the source and a call for the target, concatenated. Flagged inline with the extra test to add.
2. **Task 5's non-null assertions in `reconcilePick`** are guarded but ugly. The note offers the restructure (`heldScore` returning a pair) and forbids reaching for `any`/`unknown`.
