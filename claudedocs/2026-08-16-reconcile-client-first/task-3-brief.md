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

