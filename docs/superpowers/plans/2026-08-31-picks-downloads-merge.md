# Picks ⊕ Downloads Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Downloads tab, showing each tracked download's state on the release row it belongs to inside its group's card on Picks, with the download client's untracked queue at the foot of that screen.

**Architecture:** A release's download arrives twice, exactly as metadata already does on this screen — statically on `/api/picks`, and live from a new group-keyed endpoint polled by a new hook that overrides the static value. State is keyed by release id, not by the pick, because an in-flight upgrade deliberately belongs to a release that is not `picked_release_id`.

**Tech Stack:** TypeScript, React 19, react-router 7, Fastify + zod, `node:sqlite`, `node:test`, happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-31-picks-downloads-merge-design.md`

## Global Constraints

- Never use the `any` type. Never widen a type with a cast to make an error go away.
- `noUncheckedIndexedAccess` is on. Indexed access is checked, never `!`-asserted or cast past — deleting a bounds check must become a compile error, not a runtime `TypeError`.
- Prefer async APIs over sync twins. Inside an `async` function, `await` it.
- A comment or spec sentence false about the code beside it is a defect equal to a wrong line of code.
- Tests must be able to fail. Prove each new or repaired test by mutation: break the one thing it covers, confirm that test and no other fails, restore.
- Never hand a live DOM element to `node:assert`'s formatting assertions (`assert.equal` and friends) — it serialises the whole DOM and has caused multi-minute hangs and an OOM kill. Use `packages/web/test/dom.ts`; `scripts/check-test-hygiene.ts` enforces it by AST.
- No new lint warnings. Baseline is exactly: lint exit 0 with **125 warnings**, typecheck clean, `test:web` **340**, `test:server` **1421**, `e2e` **25**.
- Gate commands: `npm run lint`, `npm run typecheck`, `npm run test:web`, `npm run test:server`, and e2e is `npm run e2e` (**not** `test:e2e`). **Redirect each to a file and grep the file** — piping a test run through `grep` hides the failing test's name and output.
- Commit messages: one declarative sentence, no `feat:`/`fix:` prefix, no trailer, no trailing period.

---

## File Structure

**Core (server):**
- `packages/core/src/db/downloads.ts` — add the "latest download per release" queries, one per group and one batched across groups.
- `packages/core/src/http/views.ts` — add `ReleaseDownloadView` and `ReleaseDownloadsResponse`; replace `ReleaseView.downloadFailed` with `ReleaseView.download`.
- `packages/core/src/http/server.ts` — add `GET /api/downloads/for-groups`.

**Web:**
- `packages/web/src/api/client.ts` — mirror the two new types, drop `downloadFailed`, add `api.releaseDownloads`.
- `packages/web/src/api/useGroupDownloads.ts` — **new.** The live half.
- `packages/web/src/components/ReleaseRow.tsx` — the span's precedence, the detail line, `Pick` suppression, `Retry`.
- `packages/web/src/components/MediaCard.tsx` — pass the download and an `onRetry` through.
- `packages/web/src/routes/Picks.tsx` — wire the hook, patch on retry, render untracked at the foot.
- `packages/web/src/styles/rows.css` — the detail line.
- `packages/web/src/api/anchors.ts` — delete `groupAnchorHref`, correct the file comment.
- `packages/web/src/App.tsx` — drop the nav link and the route.

**Deleted:** `packages/web/src/routes/Downloads.tsx`, `packages/web/src/components/DownloadRow.tsx`, `packages/web/test/Downloads.test.tsx`.

---

### Task 1: The latest download per release, in SQL

**Files:**
- Modify: `packages/core/src/db/downloads.ts`
- Test: `packages/core/test/db/downloads.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface LatestDownload {
    downloadId: number;
    releaseId: number;
    status: DownloadStatus;
    error: string | null;
    absentSince: number | null;
  }
  /** Release id → its most recent download, for one group. */
  export function latestDownloadsForGroup(db: DatabaseSync, groupId: number): Map<number, LatestDownload>;
  /** Group id → (release id → its most recent download), for many groups in one query. */
  export function latestDownloadsForGroups(db: DatabaseSync, groupIds: readonly number[]): Map<number, Map<number, LatestDownload>>;
  ```

**Context you need.** "Most recent download" already has one spelling in this
codebase and you must reuse it, not invent a second. `latestDownloadFailed` in
`packages/core/src/db/groups.ts:160-167` is `ORDER BY id DESC LIMIT 1`, and its
doc comment above it says why in terms you should not contradict: download ids
are monotonic so the highest is the latest attempt, and `updated_at` is
deliberately **not** used because "it moves on every poll, so a stalled retry
could be stamped older than the failure it replaced." Re-picking a failed release
inserts a second `downloads` row rather than reviving the first, which is how a
release recovers.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/db/downloads.test.ts`. Use the file's existing
fixture helpers for making a group, a release and a download; read the top of the
file first and follow whatever it already does rather than building a new harness.

```ts
test('the latest download of a release is the highest id, not the newest updated_at', () => {
  const db = freshDb();
  const { groupId, releaseId } = seedRelease(db);
  // The failure is the *earlier* attempt and is stamped LATER, which is exactly
  // the shape `updated_at` gets wrong: a stalled retry polls, so its updated_at
  // can trail the failure it replaced.
  const first = seedDownload(db, { groupId, releaseId, status: 'failed', updatedAt: 9_000 });
  const second = seedDownload(db, { groupId, releaseId, status: 'downloading', updatedAt: 1_000 });
  assert.ok(second > first, 'ids are monotonic');

  const latest = latestDownloadsForGroup(db, groupId).get(releaseId);
  assert.equal(latest?.downloadId, second);
  assert.equal(latest?.status, 'downloading');
});

test('a release with no download is absent from the map rather than present and empty', () => {
  const db = freshDb();
  const { groupId, releaseId } = seedRelease(db);
  const map = latestDownloadsForGroup(db, groupId);
  assert.equal(map.has(releaseId), false);
  assert.equal(map.size, 0);
});

test('error and absentSince come back as null rather than undefined when unset', () => {
  const db = freshDb();
  const { groupId, releaseId } = seedRelease(db);
  seedDownload(db, { groupId, releaseId, status: 'queued' });
  const latest = latestDownloadsForGroup(db, groupId).get(releaseId);
  // null, not undefined: the view type says `string | null`, and a JSON payload
  // carrying undefined drops the key entirely.
  assert.equal(latest?.error, null);
  assert.equal(latest?.absentSince, null);
});

test('the batched form answers many groups in one query and keeps them apart', () => {
  const db = freshDb();
  const a = seedRelease(db);
  const b = seedRelease(db);
  seedDownload(db, { groupId: a.groupId, releaseId: a.releaseId, status: 'imported' });
  seedDownload(db, { groupId: b.groupId, releaseId: b.releaseId, status: 'failed' });

  const map = latestDownloadsForGroups(db, [a.groupId, b.groupId]);
  assert.equal(map.get(a.groupId)?.get(a.releaseId)?.status, 'imported');
  assert.equal(map.get(b.groupId)?.get(b.releaseId)?.status, 'failed');
  // A group asked about but holding nothing gets an entry, so a caller can tell
  // "asked, nothing there" from "never asked".
  assert.equal(map.get(a.groupId)?.has(b.releaseId), false);
});

test('the batched form asked about nothing returns an empty map without touching the db', () => {
  const db = freshDb();
  assert.equal(latestDownloadsForGroups(db, []).size, 0);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm run test:server > /tmp/t1.log 2>&1; grep -n "latest download\|not fail\|fail" /tmp/t1.log | head`
Expected: failures naming `latestDownloadsForGroup is not a function`.

- [ ] **Step 3: Implement**

In `packages/core/src/db/downloads.ts`. `IN (...)` needs one placeholder per id;
build them rather than interpolating ids into SQL.

```ts
/** One release's most recent download attempt, as the API exposes it. */
export interface LatestDownload {
  downloadId: number;
  releaseId: number;
  status: DownloadStatus;
  error: string | null;
  absentSince: number | null;
}

/*
 * `ORDER BY id DESC LIMIT 1` per release, the same spelling of "latest attempt"
 * as `latestDownloadFailed` in db/groups.ts — see its comment. Ids are
 * monotonic, so the highest is the newest; `updated_at` moves on every poll and
 * would let a stalled retry read as older than the failure it replaced.
 *
 * Expressed as a correlated `NOT EXISTS` rather than a window function or a
 * `GROUP BY` with `MAX(id)`: it keeps the whole row without a second lookup,
 * and it is one statement for any number of groups.
 */
const LATEST_PER_RELEASE = `
  SELECT d.id, d.group_id, d.release_id, d.status, d.error, d.absent_since
    FROM downloads d
   WHERE NOT EXISTS (
     SELECT 1 FROM downloads later
      WHERE later.release_id = d.release_id AND later.id > d.id
   )`;

function toLatest(row: SqlRow): LatestDownload {
  return {
    downloadId: num(row, 'id'),
    releaseId: num(row, 'release_id'),
    status: str(row, 'status') as DownloadStatus,
    error: maybeStr(row, 'error'),
    absentSince: maybeNum(row, 'absent_since'),
  };
}

export function latestDownloadsForGroup(
  db: DatabaseSync,
  groupId: number,
): Map<number, LatestDownload> {
  const rows = db.prepare(`${LATEST_PER_RELEASE} AND d.group_id = ?`).all(groupId);
  const map = new Map<number, LatestDownload>();
  for (const row of rows) {
    const latest = toLatest(row as SqlRow);
    map.set(latest.releaseId, latest);
  }
  return map;
}

export function latestDownloadsForGroups(
  db: DatabaseSync,
  groupIds: readonly number[],
): Map<number, Map<number, LatestDownload>> {
  const map = new Map<number, Map<number, LatestDownload>>();
  // Every requested group gets an entry, empty or not, so a caller can tell
  // "asked, nothing downloading" from "never asked".
  for (const id of groupIds) map.set(id, new Map());
  if (groupIds.length === 0) return map;

  const holes = groupIds.map(() => '?').join(',');
  const rows = db.prepare(`${LATEST_PER_RELEASE} AND d.group_id IN (${holes})`).all(...groupIds);
  for (const row of rows) {
    const sql = row as SqlRow;
    const latest = toLatest(sql);
    // Present because the loop above seeded it, and checked rather than
    // `!`-asserted because `Map.get` is typed `V | undefined` whatever seeded
    // the map. The check is not what protects the seeding loop — deleting that
    // loop compiles and does not crash, it just returns a map missing the
    // groups that have no downloads, which is what the "entry, empty or not"
    // test exists to catch.
    const forGroup = map.get(num(sql, 'group_id'));
    if (forGroup !== undefined) forGroup.set(latest.releaseId, latest);
  }
  return map;
}
```

The row readers are already imported at the top of this file — line 4 is
`import { maybeNum, maybeStr, num, str, type SqlRow } from './row.ts';` — so
`toLatest` above needs no new imports.

- [ ] **Step 4: Run them and confirm they pass**

Run: `npm run test:server > /tmp/t1.log 2>&1; grep -cE "^# (pass|fail)" /tmp/t1.log; grep -E "^# (pass|fail)" /tmp/t1.log`
Expected: `# fail 0`, and pass count 1421 + 5.

- [ ] **Step 5: Mutation-prove each new test**

For each of the five: make the one change it should catch, run only that file,
confirm that test fails and the others in the file do not, restore.
- Change `ORDER`/`NOT EXISTS` to pick the *lowest* id → test 1 fails.
- Seed an entry for every release regardless of downloads → test 2 fails.
- Return `?? undefined` instead of null → test 3 fails.
- Drop the `group_id IN` clause → test 4 fails.
- Remove the `length === 0` early return → test 5 still passes, and **not** for
  the reason first written here. `WHERE x IN ()` does not throw in this SQLite
  build; it silently matches nothing and returns zero rows. The test passes
  because the seeding loop above also has nothing to iterate when `groupIds` is
  empty, so both paths produce the same empty map. The early return is therefore
  an optimisation — one saved query — not a guard against a crash, and test 5
  pins the observable contract rather than the guard. Record that; do not
  redesign the test to make the mutation bite.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/db/downloads.ts packages/core/test/db/downloads.test.ts
git commit -m "Read each release's most recent download so a card can say more than whether it failed"
```

---

### Task 2: `ReleaseView.download` replaces `downloadFailed`

**Files:**
- Modify: `packages/core/src/http/views.ts:256-262` (the field), `:449` and `:472` (the producer)
- Modify: `packages/web/src/api/client.ts:60-65` (the mirror), `:238-244` (the `GroupView` comment referring to it)
- Modify: `packages/web/src/components/MediaCard.tsx:452-461` (the consumer)
- Test: `packages/core/test/http/*` (whichever covers `/api/picks`), `packages/web/test/MediaCard.test.tsx:187-190`, `packages/web/test/Picks.test.tsx:70`

**Interfaces:**
- Consumes: `latestDownloadsForGroup` from Task 1.
- Produces:
  ```ts
  export interface ReleaseDownloadView {
    downloadId: number;
    status: DownloadStatus;
    error: string | null;
    absentSince: number | null;
  }
  // on ReleaseView, replacing `downloadFailed?: boolean`
  download?: ReleaseDownloadView;
  ```
  `MediaCard` passes `download={release.download}` to `ReleaseRow`; the
  `hasFailed` prop is gone.

**This task changes no behaviour.** It is a widening of one field plus the
rewiring of its single consumer, and every existing assertion about `Failed`
rows must still pass. `downloadFailed` was exactly `download?.status ===
'failed'`.

- [ ] **Step 1: Write the failing test**

In whichever core test file already asserts `/api/picks` release fields (find it
with `grep -rln "downloadFailed" packages/core/test`):

```ts
test('a release carries its latest download, not merely whether it failed', async () => {
  // Build a picked group whose release has a *downloading* attempt — a state the
  // old boolean could not express at all, so this cannot pass by accident.
  const { app, groupId, releaseId } = await pickedGroupWithDownload({ status: 'downloading' });
  const body = await app.inject({ method: 'GET', url: '/api/picks' }).then((r) => r.json());
  const group = body.groups.find((candidate: { id: number }) => candidate.id === groupId);
  const release = group.releases.find((candidate: { id: number }) => candidate.id === releaseId);
  assert.equal(release.download.status, 'downloading');
  assert.equal(release.download.error, null);
  assert.equal(release.download.absentSince, null);
  assert.equal('downloadFailed' in release, false);
});

test('a release with no download omits the key entirely', async () => {
  const { app, groupId, releaseId } = await pickedGroupWithDownload({ status: null });
  const body = await app.inject({ method: 'GET', url: '/api/picks' }).then((r) => r.json());
  const group = body.groups.find((candidate: { id: number }) => candidate.id === groupId);
  const release = group.releases.find((candidate: { id: number }) => candidate.id === releaseId);
  // Absent, not null: the field is absent or it is a value, matching how
  // `manualValues` behaves on the same type.
  assert.equal('download' in release, false);
});
```

Use the fixture builders the file already has rather than the invented
`pickedGroupWithDownload` if an equivalent exists — read the file first and match
its idiom. If nothing equivalent exists, write that helper beside the tests.

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test:server > /tmp/t2.log 2>&1; grep -n "latest download\|no download omits" -A 4 /tmp/t2.log | head -20`
Expected: `release.download` is undefined.

- [ ] **Step 3: Change the view type and its producer**

In `views.ts`, replace the `downloadFailed` field (`:256-262`) with:

```ts
  /**
   * This release's most recent download, absent when it has never had one.
   *
   * Per release rather than per group because the card has to say *which*
   * version is downloading or failed: an upgrade deliberately leaves
   * `picked_release_id` on the old release until the replacement imports (see
   * `pickRelease`), so the row to mark is frequently not the current one.
   *
   * Widened from a `downloadFailed?: boolean`, which was exactly
   * `download?.status === 'failed'`. The boolean could not say `downloading`,
   * and the screen that could was deleted.
   */
  download?: ReleaseDownloadView;
```

and add above `ReleaseView`:

```ts
/** The part of a download a card shows. Mirrors `LatestDownload` in db/downloads.ts. */
export interface ReleaseDownloadView {
  downloadId: number;
  status: DownloadStatus;
  error: string | null;
  absentSince: number | null;
}
```

At `:449`, replace `const failed = failedReleaseIds(db, group.id);` with
`const downloads = latestDownloadsForGroup(db, group.id);` and at `:472` replace
the spread with:

```ts
      // Present only when there is one, as `manualValues` is: absent means
      // "never downloaded", so a release that has never been picked serialises
      // to exactly what it always did.
      ...(downloads.has(release.id) ? { download: downloadViewOf(downloads, release.id) } : {}),
```

where `downloadViewOf` drops `releaseId` (it is the key the caller already has):

```ts
function downloadViewOf(
  downloads: Map<number, LatestDownload>,
  releaseId: number,
): ReleaseDownloadView | undefined {
  const latest = downloads.get(releaseId);
  if (latest === undefined) return undefined;
  return {
    downloadId: latest.downloadId,
    status: latest.status,
    error: latest.error,
    absentSince: latest.absentSince,
  };
}
```

Then check whether `failedReleaseIds` still has callers
(`grep -rn "failedReleaseIds" packages/core/src`). If it does not, delete it and
`failedReleasesOf` with it, and check whether `latestDownloadFailed` still has
callers before deleting that too — it is also used by `hasUnfailedDownload`'s
neighbours, so read before cutting. **If you delete `failedReleasesOf`, its long
doc comment goes with it; do not leave a comment describing a function that no
longer exists.**

- [ ] **Step 4: Rewire the mirror and the consumer**

In `client.ts`, replace `downloadFailed?: boolean` (`:65`) with the same
`download?: ReleaseDownloadView` plus a local `ReleaseDownloadView` interface
carrying the same doc, and export it. The `GroupView` comment at `:238-244`
names `ReleaseView.downloadFailed` — update that reference.

In `MediaCard.tsx:452-461`, replace `hasFailed={release.downloadFailed}` with
`download={release.download}` and rewrite the comment beside it so it describes
the new prop. `ReleaseRow`'s `hasFailed` prop is replaced in Task 5; for **this**
task keep `ReleaseRow` compiling by deriving the old prop at the call site:

```ts
            download={release.download}
```

and in `ReleaseRow`, accept `download?: ReleaseDownloadView | undefined` and set
`const hasFailed = download?.status === 'failed';` internally, leaving every
other line of its render alone. That keeps this task behaviour-identical and
leaves the whole span/detail-line change to Task 5.

- [ ] **Step 5: Update the web fixtures**

`MediaCard.test.tsx:187-190`'s helper builds `downloadFailed: true`; it becomes
`download: { downloadId: 1, status: 'failed', error: null, absentSince: null }`.
Same at `Picks.test.tsx:70`. Do not weaken any assertion — every test that
asserted a row reads `Failed` must still assert that.

- [ ] **Step 6: Run the whole gate**

```bash
npm run typecheck > /tmp/t2tc.log 2>&1; echo "tc:$?"
npm run test:server > /tmp/t2s.log 2>&1; grep -E "^# (pass|fail)" /tmp/t2s.log
npm run test:web > /tmp/t2w.log 2>&1; grep -E "^ℹ (pass|fail)" /tmp/t2w.log
npm run lint > /tmp/t2l.log 2>&1; echo "lint:$?"; grep -c warning /tmp/t2l.log
```
Expected: typecheck clean, `# fail 0`, web `fail 0`, lint exit 0 with 125 warnings.

- [ ] **Step 7: Mutation-prove the two new tests**

Make `views.ts` emit `download` only when the status is `'failed'` → the
`downloading` test fails, the omission test passes. Then make it always emit the
key → the omission test fails. Restore.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Carry a release's whole latest download in the picks payload instead of a boolean that could only say it failed"
```

---

### Task 3: `GET /api/downloads/for-groups`

**Files:**
- Modify: `packages/core/src/http/views.ts` (response type), `packages/core/src/http/server.ts` (route)
- Modify: `packages/web/src/api/client.ts` (mirror + method)
- Test: the core http test file that covers `/api/metadata`'s validation

**Interfaces:**
- Consumes: `latestDownloadsForGroups` (Task 1), `ReleaseDownloadView` (Task 2).
- Produces:
  ```ts
  /** Group id → (release id → that release's latest download). */
  export type ReleaseDownloadsResponse = Record<number, Record<number, ReleaseDownloadView>>;
  ```
  Client: `api.releaseDownloads(ids: number[], signal?: AbortSignal): Promise<ReleaseDownloadsResponse>`

**Mirror `GET /api/metadata` exactly** — read `server.ts:1012-1029` and copy its
shape: `metadataQuerySchema.safeParse(request.query)` → 400 `{ error: 'Invalid
query' }`; `parseIds(...)` → 400 `{ error: 'Invalid ids' }`; then a fixed number
of queries regardless of id count. `parseIds` (`server.ts:258-268`) already caps
at `MAX_PAGE_LIMIT` (100, `:168`) and returns null past it, so the cap is free.

- [ ] **Step 1: Write the failing tests**

```ts
test('the route answers a release download per group, keyed both ways', async () => {
  const { app, first, second } = await twoPickedGroupsWithDownloads();
  const res = await app.inject({
    method: 'GET',
    url: `/api/downloads/for-groups?ids=${first.groupId},${second.groupId}`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body[first.groupId][first.releaseId].status, 'downloading');
  assert.equal(body[second.groupId][second.releaseId].status, 'failed');
});

test('a group with nothing downloaded answers an empty object rather than being missing', async () => {
  const { app, groupId } = await pickedGroupWithDownload({ status: null });
  const body = await app
    .inject({ method: 'GET', url: `/api/downloads/for-groups?ids=${groupId}` })
    .then((r) => r.json());
  // Present-and-empty, not absent: the client tells "asked, nothing there" from
  // "not asked" and stops polling on the former.
  assert.deepEqual(body[groupId], {});
});

test('it returns terminal downloads too, not only in-flight ones', async () => {
  const { app, groupId, releaseId } = await pickedGroupWithDownload({ status: 'imported' });
  const body = await app
    .inject({ method: 'GET', url: `/api/downloads/for-groups?ids=${groupId}` })
    .then((r) => r.json());
  // If this ever returns only in-flight rows, a download that imports while the
  // tab is open drops out of the live map and the row reads `downloading`
  // forever, falling back to a static value captured at page load.
  assert.equal(body[groupId][releaseId].status, 'imported');
});

test('a malformed or oversized id list is a 400, not a partial answer', async () => {
  const { app } = await pickedGroupWithDownload({ status: 'queued' });
  const missing = await app.inject({ method: 'GET', url: '/api/downloads/for-groups' });
  assert.equal(missing.statusCode, 400);
  const junk = await app.inject({ method: 'GET', url: '/api/downloads/for-groups?ids=1,abc' });
  assert.equal(junk.statusCode, 400);
  const tooMany = Array.from({ length: 101 }, (_, index) => index + 1).join(',');
  const over = await app.inject({ method: 'GET', url: `/api/downloads/for-groups?ids=${tooMany}` });
  assert.equal(over.statusCode, 400);
});
```

- [ ] **Step 2: Run and confirm failure** — expect 404s.

Run: `npm run test:server > /tmp/t3.log 2>&1; grep -n "for-groups" -A 3 /tmp/t3.log | head -20`

- [ ] **Step 3: Add the response type and the route**

In `views.ts`:

```ts
/**
 * Group id → (release id → that release's latest download).
 *
 * Nested rather than flat because the client polls by group and renders by
 * release, and a flat list keyed by release id would make "this group has
 * nothing" unrepresentable — which is the state that stops the poll.
 */
export type ReleaseDownloadsResponse = Record<number, Record<number, ReleaseDownloadView>>;
```

In `server.ts`, beside the `/api/metadata` handler:

```ts
  server.get('/api/downloads/for-groups', async (request, reply) => {
    const query = metadataQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });
    const ids = parseIds(query.data.ids);
    if (ids === null) return reply.code(400).send({ error: 'Invalid ids' });

    // One query for however many ids were asked about, never a query per id —
    // the same discipline `GET /api/metadata` above states for itself.
    const byGroup = latestDownloadsForGroups(db, ids);
    const response: ReleaseDownloadsResponse = {};
    for (const id of ids) {
      const releases: Record<number, ReleaseDownloadView> = {};
      // Every requested id gets an object, empty or not: see the type's comment.
      for (const [releaseId, latest] of byGroup.get(id) ?? new Map()) {
        releases[releaseId] = {
          downloadId: latest.downloadId,
          status: latest.status,
          error: latest.error,
          absentSince: latest.absentSince,
        };
      }
      response[id] = releases;
    }
    return response;
  });
```

If reusing `metadataQuerySchema` for a non-metadata route reads badly, rename it
to something route-neutral (`idsQuerySchema`) and update both call sites — but do
not copy it into a second identical schema.

- [ ] **Step 4: Add the client method**

In `client.ts`, beside `metadata` (`:746-750`):

```ts
  /** `ids` is joined the same `"1,2,3"` way `/api/downloads/for-groups` expects. */
  releaseDownloads: (ids: number[], signal?: AbortSignal) =>
    request<ReleaseDownloadsResponse>(
      `/api/downloads/for-groups?ids=${ids.join(',')}`,
      signal === undefined ? undefined : { signal },
    ),
```

and mirror `ReleaseDownloadsResponse` in the same file.

- [ ] **Step 5: Run and confirm passing** — gate as in Task 2 Step 6.

- [ ] **Step 6: Mutation-prove**

- Return only non-terminal rows → the `imported` test fails.
- Skip groups with no rows → the empty-object test fails.
- Drop the `parseIds` null check → the 400 test fails.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Answer the latest download for a batch of groups so a card list can watch what it is showing"
```

---

### Task 4: `useGroupDownloads`

**Files:**
- Create: `packages/web/src/api/useGroupDownloads.ts`
- Test: `packages/web/test/useGroupDownloads.test.tsx`

**Interfaces:**
- Consumes: `api.releaseDownloads`, `ReleaseDownloadView` (Task 3).
- Produces:
  ```ts
  export interface GroupDownloadsHandle {
    /** Group id → (release id → download). Empty until the first poll lands. */
    downloads: Map<number, Map<number, ReleaseDownloadView>>;
    /** Write a retry's response in immediately, without waiting for a poll. */
    patch(download: DownloadView): void;
  }
  export function useGroupDownloads(
    watched: readonly number[],
  ): GroupDownloadsHandle;
  ```
  `watched` is the **bounded** list — the caller passes only groups it believes
  hold a non-terminal download. Deciding that is the caller's job (Task 6).

**Read `packages/web/src/api/useGroupMetadata.ts` first** and follow its
structure: a `useRef` mirroring the state so the effect can read the latest
without depending on what it sets, `chunk(ids, BATCH_LIMIT)` with
`BATCH_LIMIT = 100`, and an `AbortSignal` on the request. Two deliberate
differences, both of which belong in comments:

- A flat `POLL_MS = 3000` interval, not the metadata hook's backoff ladder.
  Status advances on the scheduler's reconcile tick, so there is no `next_at` to
  honour and nothing for a ladder to be built from. 3000ms is what
  `Downloads.tsx` used for the same data.
- No `requestedRef` and no give-up deadline. Those exist in the metadata hook
  because an answer may never come; here every watched group has a row already
  and the poll is reading a column that changes.

- [ ] **Step 1: Write the failing tests**

```tsx
test('an empty watch list issues no request at all', async (t) => {
  const calls: number[][] = [];
  stubReleaseDownloads(t, (ids) => { calls.push(ids); return {}; });
  renderHook(() => useGroupDownloads([]));
  await tick(50);
  assert.deepEqual(calls, []);
});

test('the first poll lands and is keyed group then release', async (t) => {
  stubReleaseDownloads(t, () => ({ 7: { 70: dl({ status: 'downloading' }) } }));
  const handle = renderHook(() => useGroupDownloads([7]));
  await waitFor(() => assert.equal(handle.current.downloads.get(7)?.get(70)?.status, 'downloading'));
});

test('more than a hundred ids are chunked rather than sent in one request', async (t) => {
  const calls: number[][] = [];
  stubReleaseDownloads(t, (ids) => { calls.push(ids); return {}; });
  renderHook(() => useGroupDownloads(Array.from({ length: 250 }, (_, i) => i + 1)));
  await waitFor(() => assert.equal(calls.length, 3));
  assert.deepEqual(calls.map((batch) => batch.length), [100, 100, 50]);
});

test('a patch shows immediately and is not lost by the next poll', async (t) => {
  let answer: ReleaseDownloadsResponse = { 7: { 70: dl({ status: 'failed' }) } };
  stubReleaseDownloads(t, () => answer);
  const handle = renderHook(() => useGroupDownloads([7]));
  await waitFor(() => assert.equal(handle.current.downloads.get(7)?.get(70)?.status, 'failed'));

  // The retry's own response, patched in rather than waited for — this is the
  // whole reason `patch` exists: a poll is up to 3s away and the button must
  // not look like it did nothing.
  handle.current.patch({ id: 1, groupId: 7, releaseId: 70, status: 'queued' } as DownloadView);
  assert.equal(handle.current.downloads.get(7)?.get(70)?.status, 'queued');

  answer = { 7: { 70: dl({ status: 'queued' }) } };
  await tick(POLL_MS + 50);
  assert.equal(handle.current.downloads.get(7)?.get(70)?.status, 'queued');
});
```

Use whatever `renderHook`/`waitFor`/fake-timer helpers this repo's web tests
already use — read `packages/web/test/` for the existing idiom and the shared
`dom.ts` helper before inventing any. `stubReleaseDownloads`, `dl` and `tick` are
local helpers you write at the top of this test file.

- [ ] **Step 2: Run and confirm failure.**

Run: `npm run test:web > /tmp/t4.log 2>&1; grep -n "useGroupDownloads" -A 3 /tmp/t4.log | head`

- [ ] **Step 3: Implement the hook.** Follow `useGroupMetadata`'s structure as
described above. `patch` locates its target with the `groupId` and `releaseId`
the `DownloadView` already carries, and writes a new `Map` rather than mutating
the existing one so React sees the change.

- [ ] **Step 4: Run and confirm passing.**

- [ ] **Step 5: Mutation-prove each of the four** — delete the empty-list guard
(test 1 fails), key by release only (test 2 fails), raise `BATCH_LIMIT` past 250
(test 3 fails), make `patch` a no-op (test 4 fails). Restore after each.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/api/useGroupDownloads.ts packages/web/test/useGroupDownloads.test.tsx
git commit -m "Poll the downloads of the groups a card list is watching, at a flat interval and only while something is in flight"
```

---

### Task 5: The release row says what its download is doing

**Files:**
- Modify: `packages/web/src/components/ReleaseRow.tsx`, `packages/web/src/components/MediaCard.tsx`, `packages/web/src/styles/rows.css`
- Test: `packages/web/test/MediaCard.test.tsx`, and the four re-homed tests from `packages/web/test/Downloads.test.tsx:67,83,96,110`

**Interfaces:**
- Consumes: `ReleaseDownloadView` (Task 2).
- Produces: `ReleaseRow` props gain `download?: ReleaseDownloadView | undefined`
  and `onRetry?: ((downloadId: number) => void) | undefined`. `hasFailed` is
  gone. `MediaCard` gains `onRetry?: ((downloadId: number) => void) | undefined`
  and passes it through.

**The precedence table, from spec §4** — implement exactly this order:

| Condition | Text |
|---|---|
| `download.status === 'failed'` | `Failed`, red |
| status is `queued`/`downloading`/`completed`/`importing` | the status word |
| picked release, no download or `imported` | `Current` |
| other release, no download | nothing — the `Pick` button stands alone |

`Pick` is suppressed **only** while a download is in flight — present and not in
`['imported', 'failed']`. A failed alternative keeps its `Pick`, deliberately:
`ReleaseRow`'s existing comment is right that this is the user's way out of a
failure, and it now sits beside a `Retry` that re-submits the same download.

Retry is offered when `status === 'failed' || absentSince !== null`, copied from
`DownloadRow.tsx:14` and for the reason stated there — it must accept exactly
what the API accepts, or it becomes a 409 on click.

- [ ] **Step 1: Write the failing tests**

In `MediaCard.test.tsx`, plus the four re-homed ones. Every branch of the table
gets its own test, because a single test covering "the span shows something" is
worthless:

```tsx
test('a picked release with no download reads Current', () => { /* assert 'Current' */ });
test('a picked release whose download imported still reads Current, not imported', () => {
  // The reader has the file, which is what `Current` has always meant here.
});
test('a release downloading reads its status, whether or not it is the pick', () => {
  // Both cases in one test on purpose: the rule is that status is keyed by
  // release, and an in-flight *upgrade* is by definition not the pick
  // (`pickRelease` leaves picked_release_id on the old release).
});
test('a failed release reads Failed rather than its status word', () => { /* precedence */ });
test('an alternative with no download reads nothing and offers Pick', () => {});
test('Pick is suppressed while a download is in flight and restored once it fails', () => {});
test('the detail line is absent when there is nothing to put on it', () => {
  // A healthy downloading row: no error, not absent, so no second line at all.
});
test('a failed release shows its error and a Retry button on the detail line', () => {});
test('an absent release warns how long it has been missing and offers Retry', () => {});
test('Retry is offered for exactly the statuses the API guard accepts', () => {
  // Re-homed from Downloads.test.tsx:110. This is the load-bearing one: it pins
  // `status === 'failed' || absentSince !== null` against the server's guard.
});
```

Write real bodies for all ten using the existing `MediaCard.test.tsx` fixtures
and `packages/web/test/dom.ts` — the skeletons above are the cases, not the code.

- [ ] **Step 2: Run and confirm they fail.**

- [ ] **Step 3: Implement `ReleaseRow`.** Replace the `hasFailed` block and the
`isCurrent` ternary with the precedence above; add the detail line as a sibling
element after the row's spans, rendered only when
`download?.error !== null && download?.error !== undefined`, `absentSince !==
null`, or Retry is offered. Move the `formatElapsed` import from the deleted
`DownloadRow` — the `missing from client for X` wording and the reason
`DownloadRow.tsx:33-40` gives for it come across intact.

Rewrite the existing comment at `ReleaseRow.tsx:54-65`. It currently says a retry
"belongs to the Downloads tab, which has a Retry control for it" — that tab is
being deleted and the sentence becomes false about the file it sits in.

- [ ] **Step 4: Style the detail line** in `rows.css`. `.release-row` is one flex
line (`:33-40`); the detail line is a second row under it, so give the release a
wrapper or use `flex-wrap` with a full-width child — whichever reads better
against the existing file. Reuse `.download-error` (`:108`) and
`.download-absent` (`:113`) colours rather than defining new ones, renaming them
if they no longer sit beside a `.download-row`.

- [ ] **Step 5: Run the gate** (typecheck, test:web, lint) as in Task 2 Step 6.

- [ ] **Step 6: Mutation-prove all ten** — each test dies to exactly one targeted
change. In particular: swap the `failed`/in-flight precedence (the `Failed` test
fails, nothing else); make `imported` render its status word (that test fails);
suppress `Pick` on failed rows too (that test fails).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Say on the release row what its download is doing, and offer the retry the deleted tab used to hold"
```

---

### Task 6: Picks watches its downloads

**Files:**
- Modify: `packages/web/src/routes/Picks.tsx`
- Test: `packages/web/test/Picks.test.tsx`, plus re-homed `Downloads.test.tsx:171,188,223,364`

**Interfaces:**
- Consumes: `useGroupDownloads` (Task 4), `MediaCard`'s `onRetry` (Task 5).
- Produces: nothing later tasks depend on.

**The watch list is the point of this task.** `useGroupDownloads` is handed only
groups the static payload says hold a non-terminal download:

```ts
/**
 * The groups worth polling: those whose static payload shows a download that is
 * neither `imported` nor `failed`.
 *
 * Bounded deliberately. Watching every picked group would be one request per
 * hundred of them every three seconds for a library where almost nothing is
 * downloading; this is normally one request per tick, which is what the screen
 * this replaces cost.
 *
 * The cost is that a download created in another tab is not noticed until this
 * screen reloads — the static payload is what seeds this list. `pickRelease`
 * has one caller, so a download only ever starts from a human clicking Pick
 * somewhere, and a click *here* already runs `reload()`.
 */
const watched = groups
  .filter((group) =>
    group.releases.some(
      (release) =>
        release.download !== undefined &&
        release.download.status !== 'imported' &&
        release.download.status !== 'failed',
    ),
  )
  .map((group) => group.id);
```

`MediaCard` gets its download state merged live over static, per release, the
same shape `Picks.tsx:210` already uses for metadata.

- [ ] **Step 1: Write the failing tests**

```tsx
test('only groups with something in flight are polled', async (t) => {
  // Two groups: one imported, one downloading. Assert the request carries the
  // downloading group's id and NOT the imported one's.
});
test('a live status overrides the one the payload arrived with', async (t) => {});
test('a download that imports mid-poll stops being watched', async (t) => {
  // Otherwise the poll runs forever on a finished download.
});
test('a refused retry surfaces instead of vanishing', async (t) => {
  // Re-homed from Downloads.test.tsx:188.
});
test('retry refreshes the row immediately, without waiting on the poll', async (t) => {
  // Re-homed from Downloads.test.tsx:223 — via the hook's `patch`.
});
test('a bodyless retry request carries no json content-type', async (t) => {
  // Re-homed from Downloads.test.tsx:171. Keep it: it is the regression guard
  // for the bug that broke retry from the day it shipped (client.ts:449-452).
});
test('a poll landing does not clear the search term or unfilter the cards', async (t) => {
  // Re-homed from Downloads.test.tsx:364, and newly relevant: this is the first
  // poll Picks has ever had, so it is the first thing that could do this to it.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** Add the `watched` derivation, call the hook, merge
per release into the `group` handed to `MediaCard`, and add a `retry` that calls
`api.retry` and hands the response to `patch` — patching rather than reloading,
because `reload()` here refetches every picked group's releases and metadata to
learn one row (the reasoning `Downloads.tsx:109-119` gives).
- [ ] **Step 4: Run the gate.**
- [ ] **Step 5: Mutation-prove all seven.** Notably: drop the `!== 'imported'`
filter → the stops-being-watched test fails; replace `patch` with `reload` →
the immediate-refresh test still passes but the request count changes, so assert
on requests, not just on the rendered row.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Watch the picks that are actually downloading and patch a retry in from its own response"
```

---

### Task 7: The untracked queue moves to the foot of Picks

**Files:**
- Modify: `packages/web/src/routes/Picks.tsx`, `packages/web/src/styles/rows.css`
- Test: `packages/web/test/Picks.test.tsx`, re-homed `Downloads.test.tsx:277,328`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing.

Picks calls `api.downloads(null)` once on mount for its `untracked` half and
discards `tracked`. That waste is deliberate and belongs in a comment: the
response carries the client's whole live queue on every page rather than a slice,
so one call gets all of it, and a second endpoint for one list on one screen is
not worth its route.

Carry across verbatim:
- the composite `${clientId}:${ref}` key, because a `ref` is unique only within
  one client and two clients (#34) can present the same one — React's answer to a
  duplicate key is that children "may be duplicated and/or omitted"
- the heading hiding when a term has excluded every entry, because the heading is
  the whole of what says these downloads are not Pickarr's

Untracked entries are **not** refreshed by the download poll — they are not keyed
by group, so they do not fit the group-keyed endpoint. Say so in a comment.

- [ ] **Step 1: Write the failing tests** — re-home three from
`Downloads.test.tsx`, retargeted at Picks: `:277` (untracked renders inert and
labelled), `:328` (a term filters them and takes the heading with them), and
`:555` (two entries from different clients sharing a `ref` are keyed apart).
`:555` is the only guard on the composite key this task carries across — without
it, keying on `ref` alone passes every other test in the file. Add one new test
for a term filtering cards and untracked entries together, since that pairing
does not exist today.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** Render below the cards. Keep `ul.downloads.untracked`
and `li.download-row.untracked` so `rows.css:115` still applies; if the
`.download-row` name now reads oddly with no `DownloadRow` component, rename the
class in both places rather than leaving a comment explaining the mismatch.
- [ ] **Step 4: Run the gate.**
- [ ] **Step 5: Mutation-prove** — render the heading unconditionally → the
filter test fails; key on `ref` alone → add an assertion with two clients
presenting the same `ref` and confirm it fails.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Move the download client's unmanaged queue to the foot of Picks, where the tracked list used to sit above it"
```

---

### Task 8: Delete the Downloads screen

**Files:**
- Delete: `packages/web/src/routes/Downloads.tsx`, `packages/web/src/components/DownloadRow.tsx`, `packages/web/test/Downloads.test.tsx`
- Modify: `packages/web/src/App.tsx:15,44`, `packages/web/src/api/anchors.ts`
- Modify: `packages/e2e/tests/retry.spec.ts`, `packages/e2e/tests/theme.spec.ts:181`

**Interfaces:** consumes everything above; produces nothing.

**Do this last**, so the screen stays working until its replacement is complete
and each earlier task's tests could run against both.

- [ ] **Step 1: Confirm every re-homed test exists**

Before deleting `Downloads.test.tsx`, check off each item in spec §8 against the
new locations:

```bash
grep -c "^test(" packages/web/test/Downloads.test.tsx
grep -n "^test(" packages/web/test/Picks.test.tsx packages/web/test/MediaCard.test.tsx
```

**Twelve** tests remain in the old file at this point. It held sixteen when the
plan was written; Task 5 moved four of them (`:67`, `:83`, `:96`, `:110`) to
`MediaCard.test.tsx` and deleted the originals, so the arithmetic below counts
what is left rather than what was there. They split three ways:

- **Seven must still have a home**, all of them going to `Picks` (Tasks 6-7):
  a bodyless retry request carrying no JSON content-type; a refused retry
  surfacing instead of vanishing; a retry refreshing its row without waiting on
  the poll; untracked entries rendering inert and labelled; a term filtering
  untracked entries and taking their heading with them; a poll landing not
  clearing the term; and two untracked entries from different clients sharing a
  `ref` being keyed apart. Match them by name — the line numbers moved when
  Task 5 removed four tests from the middle of the file.
- **Four die with the thing they test.** `:134` and `:162` assert a download row
  links to its group, and the linker is deleted. `:488` and `:522` are about
  `usePagedList` and `mergeNewestPage` driving the tracked list; Picks is
  unpaginated, so there is no page two to keep on screen.
- **One is dropped on purpose.** `:310`, tracked-row filtering — Picks already
  filters cards by term and that is already tested.

Count the eleven off by name against the new files. If any is missing, stop and
add it before deleting anything. Do not accept "an equivalent assertion exists
somewhere" for `:110` or `:555` specifically: `:110` pins the retryable rule
against the server's guard, and `:555` is the only guard on the composite
`${clientId}:${ref}` key.

- [ ] **Step 2: Delete the route, the component, and the old test file**

```bash
git rm packages/web/src/routes/Downloads.tsx packages/web/src/components/DownloadRow.tsx packages/web/test/Downloads.test.tsx
```

- [ ] **Step 3: Drop the nav link and the route** — `App.tsx:15` and `:44`. Nav
becomes Browse, Picks, Failed, Settings.

- [ ] **Step 4: Delete `groupAnchorHref` and fix its file's comment**

`anchors.ts` keeps `groupAnchor` (`MediaCard` carries the id it builds; two tests
import it) and loses `groupAnchorHref`, whose only caller was `DownloadRow`. The
file's doc comment says the two places that must agree are "the card that carries
the id and the Downloads row that links to it" — with the second gone that
sentence is false about its own file. Rewrite it; do not leave it standing.

Keep Picks' `#group-N` landing effect (`Picks.tsx:88-94`). Nothing generates such
a link now, but the effect handles a fragment arriving from a bookmark or an
external link, which does not depend on this app having produced it.

- [ ] **Step 5: Update the e2e specs**

`retry.spec.ts` moves to Picks: its `.download-status` assertions (`:78`, `:87`)
become assertions on the release row's span, and Retry is found on the release's
detail line. `theme.spec.ts:181` drops `/downloads` from its route sweep — that
array becomes `['/', '/picks', '/failed', '/settings']`.

Leave `identity-change.spec.ts` alone. It should pass untouched: its surviving
row's release has an imported download (`:66`), so it reads `Current` under the
new precedence, and its upgrade row is never picked (`:35` is the spec's only
`Pick` click) so it has no download and keeps its `Pick`. If either breaks, the
precedence table is wrong — fix the table, not the test.

- [ ] **Step 6: Run the full gate including e2e**

```bash
npm run lint > /tmp/t8l.log 2>&1; echo "lint:$?"; grep -c warning /tmp/t8l.log
npm run typecheck > /tmp/t8tc.log 2>&1; echo "tc:$?"
npm run test:web > /tmp/t8w.log 2>&1; grep -E "^ℹ (tests|pass|fail)" /tmp/t8w.log
npm run test:server > /tmp/t8s.log 2>&1; grep -E "^# (pass|fail)" /tmp/t8s.log
npm run build > /tmp/t8b.log 2>&1; echo "build:$?"
npm run e2e > /tmp/t8e.log 2>&1; grep -iE "passed|failed" /tmp/t8e.log | tail -3
```
Expected: lint exit 0 with **125** warnings, typecheck clean, `fail 0` on both
unit suites, build clean, **e2e 25 passed**. If the e2e count changed, say which
spec and why.

- [ ] **Step 7: Confirm nothing references the deleted screen**

```bash
grep -rn "DownloadRow\|routes/Downloads\|groupAnchorHref\|downloadFailed\|'/downloads'" packages/ --include=*.ts --include=*.tsx | grep -v "api/downloads"
```
Expected: no output. `api/downloads` survives as an endpoint and is excluded.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Delete the Downloads screen now that a pick's card carries everything it showed"
```

---

## Self-Review

**Spec coverage.** §1 → Tasks 5-8. §1.1 (no pagination, no server search) → not
implemented by design; Task 6's watch list is the only new polling. §2
(status keyed by release) → Tasks 1, 2, 5, asserted directly by Task 5's
"whether or not it is the pick" test. §3 static half → Task 2; live endpoint →
Task 3; hook → Task 4. §3.1 (what the bounded watch list gives up) → Task 6's
comment. §4 precedence table and detail line → Task 5. §5 retry → Tasks 5 and 6.
§6 untracked → Task 7. §7 routes/nav/links → Task 8. §8 testing → distributed,
with Task 8 Step 1 as the gate that no re-homed test was lost. §9 consequences →
no task; they are consequences, not work.

**Placeholder scan.** Task 5 Step 1 and Task 6 Step 1 list test *cases* as
one-line skeletons rather than full bodies, and each says so explicitly and names
the fixtures to build them from. Every code step that produces production code
carries the actual code. No "TBD", no "handle edge cases", no "similar to Task N".

**Type consistency.** `LatestDownload` (Task 1, with `releaseId`) vs
`ReleaseDownloadView` (Task 2, without — it is the map key) is a deliberate
difference, and Task 2's `downloadViewOf` is where one becomes the other.
`ReleaseDownloadsResponse` is `Record<number, Record<number,
ReleaseDownloadView>>` in Tasks 3 and 4 alike; the hook's in-memory form is
`Map<number, Map<number, ReleaseDownloadView>>`, converted on receipt. `patch`
takes a `DownloadView` because that is what `api.retry` returns (`client.ts:659`),
not a `ReleaseDownloadView`. `onRetry(downloadId: number)` is spelled the same in
`ReleaseRow`, `MediaCard` and `Picks`.

**One gap I am recording rather than fixing.** `/api/picks` already runs one
query per group for release-level download state — `views.ts:449` calls
`failedReleaseIds(db, group.id)` inside the per-group loop, and Task 2 replaces it
with `latestDownloadsForGroup`, preserving that shape. Task 1 provides a batched
form that would fix it, but rewiring the picks view to build all groups from one
query is a change to how that response is assembled and is not this plan's
subject. Task 2 must not make it worse; it also does not make it better.
