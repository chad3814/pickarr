# Client-first reconcile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Pickarr failing healthy downloads because SABnzbd showed it a partial view, and make the surviving failure mode self-healing.

Design: `docs/superpowers/specs/2026-08-16-reconcile-client-first-design.md`. Read it before starting. Where this plan and the design disagree, the design wins and the disagreement is a bug in this plan.

## Why

On 2026-08-15 Pickarr failed 35 healthy downloads as `disappeared-from-client` in a 17-minute window. SABnzbd held every one of them; all 35 are in its history as `Completed` under the same `nzo_id` Pickarr recorded. None was imported, 33 completed directories still sit on disk, and because `activeDownloads` excludes `failed` while `knownRefs` has no status filter, the rows were invisible as both work and orphans.

The cause is not the 30-second budget. `mode=history` defaults `limit` to the user's `history_limit` (10 at the time) while `mode=queue` reads a missing `limit` as unlimited — so the queue was never truncated and history always was. Post-processing fills those slots first (peak 21 concurrent against 10, leaving zero for database history) and itself ran a median of 8.4 minutes. Pickarr concluded "absent, therefore gone" from a view it never established was complete.

## Global Constraints

- **Commit after each task**, on branch `reconcile-client-first`. The repo owner authorised this explicitly for this run. Use `--no-gpg-sign` only if signing fails. **Never push.**
- Node v24.15.0 is the shell default in this worktree; no PATH export needed.
- **Verify with `npm run check`** (lint + typecheck + test). `npm run build` runs no typechecker.
- Baseline: **830 server (827 pass, 3 pre-existing failures) / 165 web (all pass)**. The 3 failures are `AbortSignal.timeout` mock-timer tests in `clients/theporndb.test.ts` (×2) and `media/artwork.test.ts` (×1); they fail on this Node build for reasons unrelated to this work. **Do not fix them and do not count them as regressions.** Any *fourth* failure is yours.
- Never use `any`. tsconfig sets `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax`.
- In web tests **never** write `assert.equal(screen.queryByText(x), null)` — it deep-inspects a live DOM node to format the failure, burns ~75s and kills the run with no test named. Compare booleans; see `gone()` in `packages/web/test/Browse.test.tsx`.
- Comments explain *why*, not *what*. Match the density and voice of the surrounding file — this codebase documents its reasoning heavily and a terse patch will read as foreign.
- When a test claims to pin a property, mutate the source to break it and confirm the test fails. Report the evidence in the task summary.
- Do not "fix" adjacent things you notice. Note them for the final review instead.

## File Structure

```
packages/core/src/clients/types.ts          Task 1  snapshot contract
packages/core/src/clients/sabnzbd.ts        Task 1  paging, no category filter
packages/core/src/db/migrations.ts          Task 2  migration 8
packages/core/src/db/downloads.ts           Task 2  absent_since, ref lookup
packages/core/src/pipeline/reconcile.ts     Task 3  client-first tick
packages/core/src/http/views.ts             Task 4  absentSince on the view
packages/core/src/http/server.ts            Task 4  retry accepts absent
packages/web/src/api/client.ts              Task 5  absentSince on web type
packages/web/src/components/DownloadRow.tsx Task 5  surface absence
```

---

### Task 1: The snapshot knows whether it is complete

**Files:**
- Modify: `packages/core/src/clients/types.ts`
- Modify: `packages/core/src/clients/sabnzbd.ts`
- Test: extend `packages/core/test/clients/sabnzbd.test.ts`

This task is self-contained: adding a field to `ClientSnapshot` is additive, so `reconcile.ts` keeps compiling untouched.

**Steps:**

- [ ] In `types.ts`, add to `ClientSnapshot`: `complete: boolean`. Document it as the design does — a false snapshot may be used to advance rows it *does* contain, but may never be used to conclude something is absent.
- [ ] Add `category: string | null` to both `ClientQueueEntry` and `ClientHistoryEntry`.
- [ ] In `sabnzbd.ts`, add `const HISTORY_PAGE_SIZE = 500;` and `const MAX_HISTORY_PAGES = 20;` with comments explaining the sizes (a page far above realistic history sizes so the common case is one request; a cap that bounds a pathological client).
- [ ] Rewrite `snapshot()`:
  - Queue: `call('queue', { limit: '0' })` — **no `category`**. `limit=0` is explicit rather than omitted because the two endpoints read a missing `limit` differently and relying on that difference caused the incident. Say that in a comment.
  - History: page with `start` and `limit=HISTORY_PAGE_SIZE`, **no `category`**, accumulating until the collected count reaches the response's `noofslots`, a page returns no slots, or `MAX_HISTORY_PAGES` is hit.
  - `complete` is false if either endpoint returned fewer entries than its own `noofslots`, or if the page cap was hit. Otherwise true.
  - Read `noofslots` defensively (it is a number in practice; a missing or non-numeric value must not throw — treat it as "cannot verify" and set `complete = false`).
- [ ] Read category per entry: queue slots carry **`cat`**, history slots carry **`category`**. Map the literal string `"None"` (SABnzbd's spelling for "no category" on a queue slot) and the empty string to `null`. Use the existing `safeText` for both, as every other snapshot string already does.
- [ ] Keep every existing behaviour: `safeText` on all returned strings, `historyOutcome` mapping, skipping slots with an empty `nzo_id`, and throwing (not returning empty) when a request fails.

**Tests:**

- [ ] History spanning three pages is fully collected, and the requests carry increasing `start`.
- [ ] `complete === false` when the collected count is short of `noofslots`.
- [ ] `complete === false` when `MAX_HISTORY_PAGES` is exhausted.
- [ ] `complete === false` when `noofslots` is absent or not a number.
- [ ] `complete === true` on an ordinary single-page response.
- [ ] Neither request URL contains `category=`; the history URL contains an explicit `limit=`.
- [ ] Queue `cat` and history `category` both land on the entry; `"None"` and `""` become `null`.
- [ ] **Incident regression:** a fake endpoint that mimics SABnzbd — capping history at 10 unless a larger `limit` is passed — yields a snapshot of all 35 entries with `complete === true`. Name the test so it is obviously the incident.

**Verify:** `npm run check`. Commit.

---

### Task 2: Absence becomes an observation the database can hold

**Files:**
- Modify: `packages/core/src/db/migrations.ts`
- Modify: `packages/core/src/db/downloads.ts`
- Test: extend `packages/core/test/db/downloads.test.ts`, `packages/core/test/db/migrate.test.ts`

**Steps:**

- [ ] Add migration **version 8**: `ALTER TABLE downloads ADD COLUMN absent_since INTEGER;`. Comment it with why a poll counter was the wrong instrument: reconcile runs under `tryRun`, so ticks are dropped for the whole duration of a long import and "three polls" is not thirty seconds.
- [ ] Leave `missing_polls` in place. Do **not** drop the column — rewriting a live table buys nothing, and leaving it keeps the migration trivially reversible. Note on it that it is no longer read or written.
- [ ] `DownloadRow` gains `absentSince: number | null`; add `absent_since` to the `SELECT` list and map it with `maybeNum`.
- [ ] Add `markAbsent(db, id, now)` — sets `absent_since = ?` **only when it is currently NULL**, so the column records when absence *began* rather than when it was last noticed. A single statement with `WHERE id = ? AND absent_since IS NULL`; do not read-then-write.
- [ ] Add `clearAbsent(db, id)` — `UPDATE ... SET absent_since = NULL WHERE id = ? AND absent_since IS NOT NULL`, idempotent and a no-op when already clear, mirroring the existing `resetMissingPolls` shape.
- [ ] Add `downloadsByRef(db, clientId)` returning `Map<string, DownloadRow>` keyed on `client_ref`, for every row of this client with a non-null ref **except** `imported` — Task 3 needs `imported` handled separately by the cleanup pass, and including them here would invite a double import. Include `failed` rows; Task 3 decides which failures are eligible.
- [ ] Add `downloadsByLabel(db, clientId)` returning `Map<string, DownloadRow>` keyed on `downloadLabel(row.id)`, same row set. Building it in the db layer keeps Task 3's loop free of a second query.
- [ ] `resetForRetry` additionally clears `absent_since`. A retried download must not inherit a stale absence mark.
- [ ] Do **not** delete `bumpMissingPolls` / `resetMissingPolls` yet — Task 3 removes their last callers, and deleting them here breaks the build between commits.

**Tests:**

- [ ] `markAbsent` sets the timestamp, and a second call with a later `now` leaves the original value.
- [ ] `clearAbsent` clears it and is a no-op when already null.
- [ ] `absentSince` round-trips through `getDownload` as `null` and as a number.
- [ ] `downloadsByRef` includes `failed` and excludes `imported`; `downloadsByLabel` keys on `pickarr-<id>`.
- [ ] `resetForRetry` clears `absent_since`.
- [ ] Migration 8 on a database populated at version 7 adds the column with NULL for existing rows, following the existing style in `migrate.test.ts`.

**Verify:** `npm run check`. Commit.

---

### Task 3: The tick iterates the client first

**Files:**
- Modify: `packages/core/src/pipeline/reconcile.ts`
- Modify: `packages/core/src/db/downloads.ts` (delete the two now-unused missing-poll helpers)
- Test: rework `packages/core/test/pipeline/reconcile.test.ts`
- Test: drop the `bumpMissingPolls`/`resetMissingPolls` cases from `packages/core/test/db/downloads.test.ts`

The substance of the change. Follow §6 of the design exactly; the ordering constraints in it are each there because getting them wrong reintroduces a specific bug.

**Steps:**

- [ ] Delete `MAX_MISSING_POLLS` and every use of `bumpMissingPolls` / `resetMissingPolls`, then delete those two functions from `db/downloads.ts` now that their last callers are gone.
- [ ] Keep the snapshot first. Keep the existing `refByLabel` double-submit guard for rows with a null `client_ref` **exactly as it is** — it must still consult the already-fetched snapshot before calling `addUrl`, or a lost ref-write resubmits.
- [ ] Restructure the body into the two passes:

  **Pass A, over snapshot entries.** First collapse queue and history into one list keyed by `ref`, with the **queue entry winning** when a ref appears in both. Do not iterate the two lists in sequence: a job caught mid-transition appears in history as `Completed` *and* in the queue, and iterating history-then-queue would import it and then set it back to `downloading` in the same tick. One entry per ref, queue precedence (a job still in the queue is still active), then iterate once.
  - Resolve the entry to a row: `downloadsByRef` on `nzo_id` first, else `downloadsByLabel` on `extractLabel(entry.name)`. When both resolve and disagree, prefer the ref match and `console.warn` once (reuse the existing once-per-process warning pattern).
  - When only the label matched, write the entry's `nzo_id` to the row with `setClientRef` before continuing.
  - **No match, decided before any status branch.** A completed entry with no row must never reach the import branch. Two sub-cases, and conflating them regresses existing behaviour:
    - The ref *is* in `knownRefs` → it belongs to an `imported` row (the only status `downloadsByRef` omits). Skip it; the cleanup pass at the end of the tick owns it. It is ours, so it is **not** untracked.
    - Otherwise → untracked.
  - Row is `failed` with an error other than `disappeared-from-client` → skip entirely. Only `disappeared-from-client` is eligible for re-attachment; see §5 of the design.
  - Entry outcome `completed` → `setStoragePath(client.mapPath(...))`, `setStatus('completed')`, `clearAbsent`, then `attemptImport`. Guard the null storage path exactly as today (`'client reported success with no storage path'`).
  - Entry outcome `failed` → `failDownload` with the client's message, `clearAbsent`.
  - Otherwise (queued, downloading, post-processing `in-progress`) → `clearAbsent`; set status `downloading` only if it is not already, so `advanced` still counts real transitions.

  **Pass B, over rows that should be active and were not seen in Pass A:**
  - `completed` with a non-null `storage_path` → `attemptImport`. This is today's early branch and it must survive: SABnzbd prunes history on its own schedule, so a ready-to-import row may legitimately never appear again.
  - `snapshot.complete === false` → **do nothing**, and log once per tick that the absence sweep was skipped. This is the invariant the whole design exists for.
  - Otherwise → `markAbsent`. **Nothing fails a download for absence. There must be no `failDownload` call anywhere on an absence path.**
- [ ] Keep `ReconcileResult` shape. Add `absent: number` (rows marked absent this tick) so the tick log can say it. Keep `untracked`, `advanced`, `failed`, `imported`, `removed` meaning what they mean today.
- [ ] Filter `untracked` to entries whose `category` equals `config.category`; entries with a `null` category are not ours and are excluded. Matching our own rows stays category-blind, so a re-categorised job of ours is still found.
- [ ] `knownRefs` keeps its no-status-filter query — an imported row's job is still ours and must not be reported as an orphan.
- [ ] Keep the cleanup pass last and behaviourally unchanged.

**Tests:** rework the existing suite; keep every test that still describes true behaviour.

- [ ] **The incident, as a test:** a row `failed` with `disappeared-from-client` whose job is `Completed` in history is re-attached, marked completed and imported.
- [ ] A row failed with any other message (e.g. `Repair failed…`) whose job is `Completed` is left untouched.
- [ ] An entry matched only by `[pickarr-N]` repairs a null `client_ref`.
- [ ] A row absent from a **complete** snapshot gets `absent_since` set once; a second absent tick leaves the original timestamp.
- [ ] **A row absent from an incomplete snapshot is untouched** — no absence recorded, no status change. The single most important test in this plan.
- [ ] A previously-absent row seen again has `absent_since` cleared.
- [ ] **No download is ever failed for absence** — drive many absent ticks and assert the status never becomes `failed`.
- [ ] A `completed` row with a storage path still imports when missing from the snapshot.
- [ ] Untracked is filtered to our category; a job of ours re-categorised at the client is still matched and reconciled.
- [ ] A completed entry with no matching row is untracked, not an import attempt.
- [ ] Post-processing (`in-progress`) clears absence and does not change status.

**Verify:** `npm run check`. Commit.

---

### Task 4: The API exposes absence and retry accepts it

**Files:**
- Modify: `packages/core/src/http/views.ts`
- Modify: `packages/core/src/http/server.ts`
- Test: extend `packages/core/test/http/server.test.ts`

**Steps:**

- [ ] `DownloadView` gains `absentSince: number | null`; `toDownloadView` populates it.
- [ ] Widen the retry guard. It currently rejects anything not `failed`, which under a never-fail policy would leave a permanently-absent download with no escape hatch at all. Accept `failed` **or** `absentSince !== null`. Keep the 409 for everything else and reword its message so it names both acceptable states.
- [ ] Comment the guard with *why* it accepts an absent row — the reason is not obvious from the code and is the whole reason never-failing is safe.

**Tests:**

- [ ] `/api/downloads` includes `absentSince`, null and populated.
- [ ] Retry accepts a `downloading` download with `absent_since` set.
- [ ] Retry still 409s on a healthy `downloading` download.
- [ ] Retry still works on a `failed` download.

**Verify:** `npm run check`. Commit.

---

### Task 5: The UI shows a download that the client has lost

**Files:**
- Modify: `packages/web/src/api/client.ts`
- Modify: `packages/web/src/components/DownloadRow.tsx`
- Test: extend `packages/web/test/Downloads.test.tsx`, which already covers `DownloadRow`

An invisible stuck row is what made this incident expensive. A visible one is a work item.

**Steps:**

- [ ] Add `absentSince: number | null` to the web `DownloadView` in `api/client.ts` (it is a hand-maintained duplicate of the server type).
- [ ] In `DownloadRow.tsx`, when `absentSince !== null`, render a warning that the client has lost track of this download and roughly how long for (e.g. "missing from client for 3h"). Round to a coarse unit; do not render a live-updating clock.
- [ ] Offer the retry button for an absent row as well as a failed one, matching Task 4's widened guard. The two must agree or the button 409s.
- [ ] Follow the existing class-naming convention in that file (`download-status`, `download-error`).

**Tests:**

- [ ] An absent row renders the warning and a retry button.
- [ ] A healthy row renders neither.
- [ ] A failed row still renders its error and retry button.

**Verify:** `npm run check`. Commit.

---

## Notes for the controller

- Tasks are ordered by dependency: 1 is standalone, 2 is standalone, 3 needs both, 4 needs 2, 5 needs 4. Only 1 and 2 may run concurrently.
- The one behaviour to protect above all others: **absence never fails a download, and an incomplete snapshot never implies absence.** If a task's tests pass but either property is violated, the task is not done.
- Expect the reconcile test file to need real rework rather than additions. Tests asserting `disappeared-from-client` after three polls are pinning the bug; delete them and say so in the commit.
- The 35 stranded rows recover through Task 3's matching rule on the first tick after deploy. There is no repair script and none is wanted. Two of the 35 have no directory left and will fail their import with a real error — that is the correct outcome.
- After Task 5, run the final review against the design, not against this plan.
