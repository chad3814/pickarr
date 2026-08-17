### Task 11: End-to-end, the reported scenario in a browser

**Files:**
- Create: `packages/e2e/tests/identity-change.spec.ts`

**Interfaces:**
- Consumes: everything above, through the running app. Use `packages/e2e/src/harness.ts` exactly as `packages/e2e/tests/metadata.spec.ts` does.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from '@playwright/test';
// harness imports as in the existing specs

/**
 * The case this feature exists for. A dateless release is picked and imported;
 * a dated re-encode of the same scene arrives and lands in its own group,
 * because the date is part of the identity key. Adding the date to the picked
 * group is the correction that joins them, and it was refused outright until
 * the identity-change work of 2026-08-16.
 */
test('adding a date to a picked group merges it into the dated one', async ({ page }) => {
  // 1. Feed serves `SomeSite.TitleOfScene.1080p.MP4-WRB`; ingest; pick it;
  //    let the download complete and import.
  // 2. Feed serves `SomeSite.26.08.14.TitleOfScene.2160p.MP4-WRB`; ingest.
  //    Assert two separate cards exist.
  // 3. On Picks, open the picked group's edit form, set the anchor kind to
  //    `date` and the date to `2026-08-14`, and save.
  // 4. Assert the confirmation lists the merge target and the file rename.
  // 5. Confirm.
  // 6. Assert one group remains, holding both releases, with the 2160p flagged
  //    as an upgrade, and that the imported file now sits under the dated path.
});
```

Fill each numbered comment in with real Playwright steps using the harness's feed-serving and download-client fakes. Do not leave the comments as the test body.

- [ ] **Step 2: Run it**

Run: `npm run e2e -- identity-change`

Expected: PASS.

- [ ] **Step 3: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build && npm run e2e
git add packages/e2e/tests/identity-change.spec.ts
```

---

