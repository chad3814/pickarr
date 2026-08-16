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

