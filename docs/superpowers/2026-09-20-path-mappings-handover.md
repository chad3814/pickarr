# Path mappings — handover and decision record

For review on the repo owner's return. Built with standing authority to
decide forks, and — after the owner left mid-slice — to commit unsigned
when the signing agent was unavailable.

**Branch:** `path-mappings`, **24 commits**, based on `pickarr-2` at
`5dab78d`. **Not merged. Not pushed.**

**15 commits are unsigned** and need a rebase before this lands
anywhere shared. Rather than list them here — see below — get them
from the tree, which cannot go stale:

```
git log --format='%G? %h %s' 5dab78d..path-mappings | grep '^N '
```

*This block first said 23 commits and listed 14 unsigned, and was
wrong the moment it was committed, because committing it made a 24th.*
The identical failure it describes two sections down, reproduced by the
document describing it. Hence the command rather than a list: a
measured number is true of the tree it was measured against, and a
handover is written against a tree it is about to change.

**Gate:** lint 110 warnings / 0 errors (0 in
`contract`/`host`/`web`/`e2e`), typecheck / test-hygiene / build PASS,
`test:server` **2478** (from 2441), `test:web` **215** (from 170), e2e
**15** (from 14).

**Reviews:** every task reviewed; Tasks 1, 2 and the final wave also
re-reviewed after fixes. The whole-branch review recommended **merge
after fixes**; those fixes and a re-review are done.

---

## What it does

`filepath_mapping` translates a path a download client reports into one
the host can open. `clients/paths.ts` reads it, `clients/deliver.ts`
applies it on every delivery tick — and **nothing had ever written a
row**. This adds the writer: migration 19, three host capabilities,
three routes including this API's first `PATCH` and `DELETE`, and a
mappings list inside each download client's row on `/settings`.

---

## Decisions you may want to overturn

1. **Paths now reach the replica.** Spec §5 amends a rule that said
   `storagePath` is excluded "and never will be", by distinguishing
   *discovered* paths (a client reporting where it put a file) from
   *dictated* ones (what the operator typed into this screen). The
   `storagePath` exclusion is intact and was re-verified.
2. **`filepath_mapping` was rebuilt**, not merely altered, to drop a
   `DEFAULT 0` that would have let a future writer silently store epoch
   0. I first ruled a rebuild disproportionate and was talked out of it:
   the rebuild's usual hazard is dropped triggers, and migration 19
   installs triggers on the next line regardless.
3. **A unique index on `(download_client_id, from_path)`** — a
   correctness fix, not just duplicate detection. `mapClientPath`
   resolved ties between equal-length `from_path`s arbitrarily and said
   nothing should rely on it; the index makes the case **unreachable**,
   proven rather than asserted.
4. **Edit and delete shipped**, where the two previous settings slices
   were add-only. A wrong mapping makes `deliverCompleted` retry
   forever with no in-app exit, so a mistake here has no other escape.
5. **`deleteMapping` reads `response.status`**, breaking the rule that
   clients branch on the body's refusal code. Forced: a 204 has no body,
   so parsing first turns every success into a false `offline`. The rule
   is amended narrowly — refusals still never key on status.
6. **List order is ascending `id`**, not index order, so a row the
   operator just corrected does not jump on a screen whose only job is
   fixing a typo.
7. **No path-shape validation.** `D:\Downloads` must be accepted; the UI
   must not be stricter than a consumer that refuses `node:path`
   because these are foreign paths.

---

## What the process caught, and what it cost

**Eleven times an implementer or reviewer refused an instruction of
mine and was right** — including my `DEFAULT 0` cost estimate, a sweep
I scoped to `packages/host` that could not reach a live count in
`packages/web`, and the claim that `PATCH`/`DELETE` were "one line per
route" (true of dispatch, false of the body reader: a bodiless `DELETE`
hit `JSON.parse('')` and answered 400).

**Two measurement gradings of mine were wrong in opposite directions.**
I accused a correct measurement of being fabricated — a reviewer had
misattributed a `CREATE TABLE` error to `ALTER TABLE` — and separately
under-weighted a real one. The whole-branch review then re-ran **every**
quoted measurement in the slice and found them all true. A quoted
measurement is a claim exactly like a quoted reason.

**The most useful defect found:** a docblock claimed a float id
produced a 500. Measured, `node:sqlite` binds it without throwing —
and `Number('9007199254740993') === 9007199254740992`, so a `DELETE`
for one id removes the other. A **silent wrong-row write**, worse than
either the claimed 500 or the reviewer's predicted 404. Filed as #97
for `artworkAnswer`, which carries the identical claim on an unmeasured
path.

**A new defect shape appeared twice:** a comment contradicted by
*another comment* rather than by code — once across two lines of a
file, once within a single docblock. Reading the implementation cannot
catch it, because the implementation agrees with the other comment.

**And a count went stale inside its own fix wave** (`ce70e23`): the
commit adding a test landed two commits before the commit correcting
the test count, in the same batch. Nothing was mismeasured; the number
was correct when taken and stale when committed.

---

## Known gaps, all filed

- **#96** — nothing imports a finished download. `onDownloadedFile`
  only logs, so `delivered` means "a plugin was told", not "a file is in
  the library". **This slice makes the host able to *open* the file; it
  still puts it nowhere.**
- **#97** — `artworkAnswer` carries the same false id-check claim, on a
  path nobody has measured. Deliberately not fixed: correcting an
  unmeasured claim would repeat the error being corrected.
- **#95** — a dead `submitting` row wedges its release.
- **#93** — client selection is health-blind.
- **#94, #88** — the same copy-inheritance problem in two places.
- Not filed: `filepath_mapping_client` is now a redundant prefix index,
  measured and left.
