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

