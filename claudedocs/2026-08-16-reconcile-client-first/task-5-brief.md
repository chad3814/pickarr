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
