# Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Advance a submitted download through the client's own view of it, and tell the owning plugin when the file lands.

**Architecture:** One job per download client polls a `snapshot()` of everything that client holds, then walks the snapshot — never the row set — advancing each row it can identify. Absence is recorded, never acted on. A completed download's path is mapped, measured, and handed to the plugin that owns its feed.

**Tech Stack:** TypeScript on Node 24, `node:sqlite` + Drizzle 1.0.0-rc.4, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-06-reconcile-design.md` — read it; the plan argues from it, and where they disagree the spec wins.

## Global Constraints

- Never the `any` type. Never a cast to silence a type error.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly` all on. Indexed access checked, never `!`-asserted. Type-only imports `import type`. No enums.
- Prefer async APIs over sync twins; inside an `async` function, `await` it. `node:sqlite` is synchronous — the expected exception.
- **Log the discriminant alone, never the object.** No message may interpolate a config, a row, a headers object, or a `JSON.stringify` of any of them.
- **Every state write is conditional on the state it expects:** `WHERE id = ? AND status = ?`.
- Adapters are tested against **fakes only**. No test reaches a real client. No query outside `readClientConfig` selects `api_key`, `username` or `password`.
- Pickarr 1.x (`packages/core`, `plugin-api`, `plugin-scenes`, `web`, `e2e`) is deployed and **must not be modified**. Read it freely — it is the reference for every client behaviour here — but never edit it and never import from it.
- A comment false about the code beside it is a defect equal to a wrong line of code.
- Baseline at the start: **1691** tests fail 0; lint exit 0 with exactly **124** warnings, **0** in `packages/contract` and `packages/host`.
- **Commit signed, and `git add -- <paths>` first** (`git commit -- <paths>` alone does not stage untracked files). Never edit `commit.gpgsign` or any other git config. Tasks 1-4 were committed unsigned while the signing agent was locked overnight and were re-signed afterwards in one `git rebase --exec` pass; that flag must not appear in any remaining task.

---

### Task 1: Migration 7 and the schema mirror

**Files:**
- Modify: `packages/host/src/db/migrate.ts`, `packages/host/src/db/schema.ts`
- Test: `packages/host/test/db/migrate.test.ts`

**Interfaces:**
- Produces, for every later task: `storage_path TEXT`, `percentage INTEGER`, `absent_since INTEGER`, `delivered_at INTEGER` on both `torrent_download` and `nzb_download`; indexes `torrent_download_status`, `nzb_download_status`.

`HOST_MIGRATIONS` is at version 6, so this is version 7.

```sql
ALTER TABLE torrent_download ADD COLUMN storage_path TEXT;
ALTER TABLE torrent_download ADD COLUMN percentage INTEGER;
ALTER TABLE torrent_download ADD COLUMN absent_since INTEGER;
ALTER TABLE torrent_download ADD COLUMN delivered_at INTEGER;

ALTER TABLE nzb_download ADD COLUMN storage_path TEXT;
ALTER TABLE nzb_download ADD COLUMN percentage INTEGER;
ALTER TABLE nzb_download ADD COLUMN absent_since INTEGER;
ALTER TABLE nzb_download ADD COLUMN delivered_at INTEGER;

CREATE INDEX torrent_download_status ON torrent_download (status);
CREATE INDEX nzb_download_status ON nzb_download (status);
```

Every column is nullable, so no `DEFAULT` is needed — `ADD COLUMN ... NOT NULL` would have required one. `storage_path` holds the **client's own** path; the mapped path is derived on demand and never stored, because a stored mapped path goes stale the moment a `filepath_mapping` row changes.

`schema.test.ts` compares name, SQL type, nullability **and default** for every column, plus every index's columns and uniqueness. It will fail until the Drizzle mirror matches; that failure is the test working.

- [ ] **Step 1: Write the failing tests**

```ts
test('a migration to version 7 adds the reconcile columns to both download tables', () => {});
test('the new columns are nullable, so an existing row needs no back-filled guess', () => {
  // Seed a row on the version-6 schema via a prefix of HOST_MIGRATIONS, then
  // migrate and assert the row still reads with nulls in the new columns.
});
test('both download tables carry a status index', () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Add `MIGRATION_7`, register it as version 7, mirror both tables in `schema.ts`.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - declare `percentage` `NOT NULL DEFAULT 0` in the DDL only → a `schema.test.ts` test must fail
  - drop the `nzb_download_status` index → the index test must fail
  - omit `delivered_at` from `schema.ts` only → a `schema.test.ts` test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Give a download row somewhere to record what the client says about it" -- packages
```

---

### Task 2: The snapshot contract

**Files:**
- Create: `packages/host/src/clients/snapshot.ts`
- Test: `packages/host/test/clients/snapshot.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ClientQueueEntry { ref: string; name: string; percentage: number; category: string | null }
  export interface ClientHistoryEntry {
    ref: string; name: string; category: string | null;
    outcome: 'completed' | 'failed' | 'in-progress';
    storagePath: string | null; failMessage: string | null;
  }
  export interface ClientSnapshot { queue: ClientQueueEntry[]; history: ClientHistoryEntry[]; complete: boolean }
  /** `''` and `'None'` both mean "no category". */
  export function normalizeClientCategory(category: string | null | undefined): string | null;
  ```

**`complete` is the load-bearing field.** A false snapshot may be used to advance rows it *contains*; it may **never** be used to conclude something is absent. Say that in its doc comment — every later task depends on it and one of them will be tempted.

`normalizeClientCategory` is the read half of the trap slice C fixed on the write half. `qbittorrent.ts` already has a `normalizeCategory` for the *send* side; this one takes `null | undefined` too, because a client may omit the field entirely. **Do not merge the two** — the send side maps to `string | null` for a config value that is always present, and conflating them would put `undefined` handling on a path that cannot produce it. Add a comment in each pointing at the other.

- [ ] **Step 1: Write the failing tests**

```ts
test("both '' and the literal 'None' read as no category", () => {});
test('an absent category reads as no category rather than throwing', () => {});
test('a real category is returned unchanged', () => {
  // Including one that merely contains "None", e.g. 'None-Of-The-Above'.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - match `'None'` by substring rather than equality → the real-category test must fail
  - drop the `undefined` arm → the absent-category test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Name what one poll of a download client returns" -- packages
```

---

### Task 3: SABnzbd's snapshot

**Files:**
- Modify: `packages/host/src/clients/sabnzbd.ts`
- Test: `packages/host/test/clients/sabnzbd.test.ts`

**Interfaces:**
- Consumes: `ClientSnapshot` (Task 2), `QueuedFetch`.
- Produces: `createSabnzbdClient(...)` gains `snapshot(): Promise<ClientSnapshot>` and `remove(ref: string): Promise<void>`.

```
GET {baseUrl}/api?mode=queue&limit=0&apikey=<key>&output=json
  → { queue: { noofslots: N, slots: [ { nzo_id, filename, percentage, cat } ] } }
GET {baseUrl}/api?mode=history&start=S&limit=500&apikey=<key>&output=json
  → { history: { noofslots: N, slots: [ { nzo_id, name, category, status, storage, fail_message } ] } }
GET {baseUrl}/api?mode=history&name=delete&value=<ref>&del_files=1&apikey=<key>&output=json
```

**No `cat` filter on either call.** `queue.noofslots` is the size of the whole queue regardless of what was requested, so a filtered result's length compared against it would report every snapshot incomplete forever. Filtering is the caller's job, on data that is provably everything. Pass `limit=0` explicitly rather than omitting it — the two endpoints read a missing `limit` differently.

**History is paged** (`HISTORY_PAGE_SIZE = 500`, `MAX_HISTORY_PAGES = 20`): request a page at a time starting after what has been collected, until `noofslots` is satisfied, a page returns no slots, or the cap is hit. Sequential, because each `start` depends on how much the previous page actually returned. Hitting the cap means `complete: false`.

**The three-way outcome.** Copy these sets verbatim; each name is a status a real server sends:

```ts
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'deleted']);
const IN_PROGRESS_STATUSES = new Set([
  'extracting', 'moving', 'repairing', 'verifying', 'fetching', 'running', 'queued', 'paused',
]);
```

`completed` → completed; a terminal-failure status → failed; an in-progress status → in-progress. **An unrecognised status reads as `failed`,** and that is deliberately the less forgiving of the two wrong guesses: in-progress means "wait and poll again" and nothing ever revisits it, so a terminal status this list does not know would hang forever with no signal, while a wrong failure is visible immediately and fixed by extending the list. Put that reasoning in the comment — **Task 4 defaults the opposite way for qBittorrent, and a reader who sees both without the reasons will think one is a bug.**

`deleted` belongs in the failure set: it means a person removed the job, and nothing will move it out of that state.

Compare statuses lowercased.

- [ ] **Step 1: Write the failing tests**

```ts
test('a queue slot becomes a queue entry with its percentage and normalised category', () => {});
test('a completed history slot carries its storage path', () => {});
test('a mid-unpack status is in-progress, not a failure', () => {
  // 'Extracting'. This exact reading cost 1.x a fix round: every one of these
  // used to be a terminal failure, so an ordinary multi-part download was
  // marked failed while SABnzbd was still unpacking it.
});
test('a status this client does not enumerate reads as failed, not in-progress', () => {});
test('history is paged until noofslots is satisfied', () => {
  // Two pages. Assert both requests and that every slot appears once.
});
test('hitting the page cap reports an incomplete snapshot rather than a whole one', () => {});
test('a queue call that fails reports an incomplete snapshot, not an empty client', () => {});
test('remove asks the client to delete the job and its files', () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - read an unknown status as in-progress → its test must fail
  - return `complete: true` when the cap is hit → the cap test must fail
  - stop after the first history page → the paging test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Poll everything SABnzbd holds, and say whether that was all of it" -- packages
```

---

### Task 4: qBittorrent's snapshot

**Files:**
- Modify: `packages/host/src/clients/qbittorrent.ts`
- Test: `packages/host/test/clients/qbittorrent.test.ts`

**Interfaces:**
- Produces: `createQbittorrentClient(...)` gains `snapshot(): Promise<ClientSnapshot>`. **It gains no `remove`.**

```
GET {baseUrl}/api/v2/torrents/info
  → [ { hash, name, category, state, progress, content_path } ]
```

One unfiltered GET. `progress` is 0..1 — multiply by 100 for `percentage`.

**A state decides which list an entry lands in.** Copy this table verbatim:

```ts
const STATE_READING: Record<string, 'queue' | 'completed' | 'failed'> = {
  downloading: 'queue', metaDL: 'queue', stalledDL: 'queue', queuedDL: 'queue',
  forcedDL: 'queue', allocating: 'queue', checkingDL: 'queue',
  checkingResumeData: 'queue', moving: 'queue', pausedDL: 'queue', stoppedDL: 'queue',
  uploading: 'completed', stalledUP: 'completed', queuedUP: 'completed',
  forcedUP: 'completed', checkingUP: 'completed', pausedUP: 'completed',
  stoppedUP: 'completed',
  error: 'failed', missingFiles: 'failed',
};
```

`queue` → a queue entry. `completed` → a history entry with outcome `completed` and `storagePath` from `content_path`. `failed` → a history entry with outcome `failed`.

**An unrecognised state reads as `queue`** — the opposite default from Task 3, and both are right. `torrents/info` covers the *whole* lifecycle including actively downloading, so an unknown state is most likely still-active, and `queue` is the one reading that concludes nothing: it neither completes a row nor fails one. SABnzbd's *history* only holds jobs that have left the queue, so an unknown status there is most likely terminal. **Write that contrast into the comment, naming Task 3's file** — this is the single most likely thing a reviewer will read as an inconsistency.

Warn once per unrecognised state, not once globally: the table is deliberately uncertain about `paused*` versus `stopped*`, so more than one could appear in a run. Export a test-only reset (`resetQbittorrentStateWarningsForTests`) because `node:test` shares one module instance across a file.

`snapshot()` is always `complete: true` — one unfiltered call returns everything or throws. Say so, so nobody later reads the constant as an oversight.

- [ ] **Step 1: Write the failing tests**

```ts
test('a downloading torrent becomes a queue entry with a percentage out of 100', () => {});
test('a seeding torrent is completed, not still queued', () => {
  // 'uploading' means the download finished. Reading it as queue would leave
  // the row downloading forever, since a seeding torrent never leaves that state.
});
test('an errored torrent is a failed history entry', () => {});
test('an unrecognised state reads as queue and warns once', () => {});
test('a torrent with no category reads as no category', () => {});
test('the adapter exposes no remove, so a torrent is never dropped', () => {
  // Asserted as the absence of the method. qBittorrent's delete stops the
  // seed and abandons the ratio whether or not deleteFiles is set, so the
  // correct number of calls is zero, and optionality is what makes the wrong
  // call impossible to write rather than merely discouraged.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - read `uploading` as `queue` → the seeding test must fail
  - default an unknown state to `failed` → its test must fail
  - add a `remove` method → the no-remove test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Read a torrent's state without ever concluding it failed by surprise" -- packages
```

---

### Task 5: Path mapping

**Files:**
- Create: `packages/host/src/clients/paths.ts`
- Test: `packages/host/test/clients/paths.test.ts`

**Interfaces:**
- Produces: `export function mapClientPath(raw: DatabaseSync, clientId: number, clientPath: string): string;`

`filepath_mapping` is `(download_client_id, from_path, to_path)`. Take the **longest** matching `from_path` prefix so a specific mapping beats a general one *regardless of row order*. No match is not an error — return the path unchanged, which is correct for a host sharing a filesystem with its client, the common single-machine setup.

Select only `from_path` and `to_path`, scoped by `download_client_id`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a matching prefix is replaced', () => {});
test('the longest matching prefix wins, whichever row was inserted first', () => {
  // Insert the general mapping second, then assert; then a fresh database with
  // the order reversed and assert the same answer. A first-match implementation
  // passes one and fails the other.
});
test('an unmapped path is returned unchanged rather than refused', () => {});
test("another client's mapping is not applied", () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - take the first match instead of the longest → the longest-prefix test must fail in one of its two orders
  - drop the `download_client_id` scope → the other-client test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Translate a client's path with the most specific mapping, not the first" -- packages
```

---

### Task 6: The download row store

**Files:**
- Create: `packages/host/src/clients/rows.ts`
- Test: `packages/host/test/clients/rows.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type DownloadStatus =
    'submitting' | 'submitted' | 'downloading' | 'completed' | 'delivered' | 'failed';
  export interface DownloadRow {
    id: number; table: 'torrent_download' | 'nzb_download';
    rssItemId: number; downloadClientId: number; clientRef: string | null;
    status: DownloadStatus; storagePath: string | null; absentSince: number | null;
    deliveredAt: number | null;
  }
  export function rowsForClient(raw: DatabaseSync, clientId: number): DownloadRow[];
  export function rowByRef(raw: DatabaseSync, clientId: number, ref: string): DownloadRow | undefined;
  export function advanceStatus(raw: DatabaseSync, row: DownloadRow, from: DownloadStatus, to: DownloadStatus, at: number): boolean;
  export function setRef(raw: DatabaseSync, row: DownloadRow, ref: string, at: number): boolean;
  export function setProgress(raw: DatabaseSync, row: DownloadRow, percentage: number, at: number): void;
  export function setStoragePath(raw: DatabaseSync, row: DownloadRow, storagePath: string, at: number): void;
  export function setAbsent(raw: DatabaseSync, row: DownloadRow, at: number | null): void;
  export function markDelivered(raw: DatabaseSync, row: DownloadRow, at: number): boolean;
  export function failRow(raw: DatabaseSync, row: DownloadRow, message: string, at: number): boolean;
  ```

Both tables have the same shape bar `infohash`, so one module serves both and every function takes the row (which names its own table). Build the statement from `row.table` against a **fixed allow-list of the two literal names** — never string-interpolate a caller-supplied table name.

**Every status transition is conditional on the state it expects** (`WHERE id = ? AND status = ?`) and returns whether it applied. The job-dispatcher slice shipped a blocking bug of exactly this shape: a guard that checked a row's identity but not its state let a late write decide a row a newer observation already owned. `failRow` and `markDelivered` are conditional too.

`setProgress`/`setStoragePath`/`setAbsent` are observations rather than transitions, so they are keyed on `id` alone and return nothing — but they must never move `status`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a lookup is keyed on the client and the ref together, never the ref alone', () => {
  // Two clients, one ref. A ref-only lookup returns the wrong row, and `ref`
  // is unique only within a client.
});
test('an advance from the wrong state changes nothing and says so', () => {});
test('an advance from the expected state applies and says so', () => {});
test('recording progress does not move the status', () => {});
test('clearing absence writes null rather than leaving the stamp', () => {});
test('a row from each table is advanced in its own table', () => {
  // One torrent row and one nzb row with the same id, advanced independently.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - drop `AND status = ?` from `advanceStatus` → the wrong-state test must fail
  - key `rowByRef` on `client_ref` alone → the two-client test must fail
  - have `setProgress` also write `status` → the progress test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Move a download row only from the state it was expected to be in" -- packages
```

---

### Task 7: Walking the snapshot

**Files:**
- Create: `packages/host/src/clients/reconcile.ts`
- Test: `packages/host/test/clients/reconcile.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 6.
- Produces:
  ```ts
  export interface ReconcileResult {
    advanced: number; completed: number; failed: number;
    untracked: number; absent: number; delivered: number; reclaimed: number;
  }
  export interface ReconcileDeps {
    raw: DatabaseSync; clientId: number; category: string | null;
    snapshot: ClientSnapshot; now: number;
    log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  }
  export function walkSnapshot(deps: ReconcileDeps): ReconcileResult;
  ```

This task is steps 1 and 3 of the spec's pass: given a snapshot already fetched, advance every row it can identify. Ref recovery is Task 8, the sweep Task 9, delivery Task 10.

**Client-first, and this is the whole point.** Iterate the snapshot's entries and look each one up; never iterate rows and search the snapshot. 1.x's row-first ordering is what made its 2026-08-15 incident unrecoverable rather than merely wrong — a row it had already failed was gone from the active set, so nothing ever asked the client about it again, though the client was still holding the finished job. Client-first means a job the client has is reconciled against whatever we believe, **including `failed`**, so a wrong verdict is recoverable.

Per entry:
- queue → `advanceStatus(row, row.status, 'downloading')` from `submitted` or `submitting`, and `setProgress`. Already `downloading`: just progress.
- history `completed` → `setStoragePath` when present, then advance to `completed` from any non-terminal state **and from `failed`**.
- history `failed` → `failRow` with the client's `failMessage` (or a stated default when null), **redacted**.
- history `in-progress` → nothing at all. Not a failure, not a completion.
- no matching row → `untracked += 1` and one log line. **Never written to the database:** SABnzbd prunes history on its own schedule, so persisted orphans would accumulate for the life of the installation.

A `delivered` row is left alone by every arm — it is past this machine.

- [ ] **Step 1: Write the failing tests**

```ts
test('a queue entry moves a submitted row to downloading and records its progress', () => {});
test('a completed history entry stores the client path and completes the row', () => {});
test('a failed history entry fails the row with the client\'s message, redacted', () => {});
test('an in-progress history entry leaves the row exactly where it was', () => {});
test('a completed job whose row we already failed is advanced anyway', () => {
  // Client-first's whole reason. Row-first iteration cannot reach this row,
  // so this test fails against that ordering.
});
test('an entry matching no row is counted untracked and never written', () => {
  // Assert the row count in both tables is unchanged.
});
test('a delivered row is left alone by every arm', () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - treat `in-progress` as a failure → its test must fail
  - refuse to advance a `failed` row → the wrong-verdict test must fail
  - insert a row for an untracked entry → its test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Reconcile what the client holds against what we believe, client first" -- packages
```

---

### Task 8: Recovering a lost ref

**Files:**
- Modify: `packages/host/src/clients/reconcile.ts`
- Test: `packages/host/test/clients/reconcile.test.ts`

**Interfaces:**
- Produces: `walkSnapshot` gains a recovery pass that runs **before** the snapshot walk, and `ReconcileResult` gains `recovered: number`.

A row can sit in `submitting` with a null `client_ref` two ways: an unresolved `.torrent` add (qBittorrent had not surfaced the torrent yet), or a submission whose response was lost. Both are recoverable the same way, and **neither may be resubmitted** — see the spec's §1.1.

2.0 dropped 1.x's per-installation label marker deliberately, which removed the mechanism 1.x recovered refs with. Slice C's §10 named the replacement: match on category and name.

For each `submitting` row with a null ref, **only when `snapshot.complete`**:
- candidates are entries (queue and history) whose `category` equals `deps.category` and whose `name` equals the `rss_item.filename` this row was submitted under;
- exactly one candidate → `setRef`, and let the walk advance it in this same tick;
- two or more → recover nothing, log the count. An ambiguous match resolved arbitrarily is worse than one left for a human;
- none → leave the row untouched.

An incomplete snapshot recovers nothing: a missing candidate would be indistinguishable from an unfetched page.

Recovery runs before the walk so a recovered row advances in the same tick rather than a poll later.

- [ ] **Step 1: Write the failing tests**

```ts
test('a null ref is recovered from the one entry matching our category and name', () => {});
test('a recovered row advances in the same tick', () => {
  // The entry is a queue slot, so the row should end at `downloading`, not
  // merely `submitted` with a ref.
});
test('two matching entries recover nothing and write nothing', () => {});
test('an incomplete snapshot recovers nothing, even on a single clean match', () => {});
test('an entry with our name in another category is not ours', () => {});
test('a row that already has a ref is not touched by recovery', () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - take the first of several matches → the ambiguous test must fail
  - recover from an incomplete snapshot → its test must fail
  - match on name alone → the other-category test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Recover a lost reference only when the client can prove which job it is" -- packages
```

---

### Task 9: The absence sweep

**Files:**
- Modify: `packages/host/src/clients/reconcile.ts`
- Test: `packages/host/test/clients/reconcile.test.ts`

**Interfaces:**
- Produces: `walkSnapshot` gains a sweep after the walk.

**Absence is an observation, never a verdict.** A non-terminal row the snapshot did not account for gets `absent_since` stamped if it is null; a row it did account for gets it cleared. **Nothing fails a row for being absent** — not in this slice, and the column exists so a later one can decide with a history rather than a single reading.

1.x arrived here the hard way: it once wrote a `disappeared-from-client` failure and then had to build a recovery path for the rows its own verdict had stranded. Starting from the observation costs one nullable column and avoids that path entirely.

**Only a complete snapshot sweeps.** An incomplete one neither stamps nor clears, because a missing row is indistinguishable from an unfetched page. `absent` counts every row currently stamped, not only newly stamped ones, so the number answers "how much does the client not have" rather than "how much changed" — and it is zero for an incomplete snapshot.

Rows in `delivered` or `failed` are terminal and never swept. A row whose ref is still null is not swept either: it was never claimed to be at the client.

- [ ] **Step 1: Write the failing tests**

```ts
test('a complete snapshot stamps a row it does not account for', () => {});
test('an incomplete snapshot stamps nothing and reports absent zero', () => {
  // And still advances a row it does contain — two assertions, one fake.
});
test('a row that reappears has its absence cleared', () => {});
test('an absent row is not failed', () => {
  // The whole point. Assert the status is untouched.
});
test('a stamp already set is not overwritten with a later time', () => {
  // The stamp is when it was first missed; overwriting it would erase the
  // only thing that makes a duration computable later.
});
test('a terminal row is never swept', () => {});
test('a row with no ref is never swept', () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - sweep on an incomplete snapshot → its test must fail
  - fail an absent row → the not-failed test must fail
  - overwrite an existing stamp → its test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Record that a client no longer has a download, without deciding what it means" -- packages
```

---

### Task 10: Delivery, and reclaim

**Files:**
- Create: `packages/host/src/clients/deliver.ts`
- Modify: `packages/host/src/host.ts`
- Test: `packages/host/test/clients/deliver.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6.
- Produces:
  ```ts
  export interface DeliverDeps {
    raw: DatabaseSync; clientId: number; now: number;
    stat: (path: string) => Promise<{ sizeBytes: number }>;
    deliver: (pluginId: string, file: DownloadedFile) => Promise<void>;
    remove?: (ref: string) => Promise<void>;
    log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  }
  export async function deliverCompleted(deps: DeliverDeps): Promise<{ delivered: number; reclaimed: number; unowned: number }>;
  ```

For each `completed` row with a `storage_path` and no `delivered_at`:
1. map the path (Task 5), `stat` it for `sizeBytes`;
2. find the owning plugin from `rss_item → rss_feed.plugin_id`;
3. call `deliver(pluginId, { path, sizeBytes, downloadClientId })`;
4. on return, `markDelivered` and advance to `delivered`.

**A throw leaves the row `completed`** and logs — the next tick tries again, forever, deliberately: a plugin that cannot accept a file is a bug to fix, not a row to abandon. **A missing file is a delivery failure, not a completion failure**, for the same reason: a `filepath_mapping` corrected later takes effect on the next tick with nothing needing to be un-failed.

A row whose plugin is not registered counts as `unowned` and is retried — the same shape and the same reporting as `notifyNewRssItems`.

Then, for each `delivered` row, if `deps.remove` is present, call it once and count `reclaimed`. **`remove` is absent for qBittorrent**, so a torrent is never dropped and never stops seeding.

`host.ts` gains a way to deliver to one plugin by id. `ownerPluginId(raw, rssItemId)` already exists there — reuse it rather than writing a second query.

- [ ] **Step 1: Write the failing tests**

```ts
test('a completed row is delivered to the plugin owning its feed', () => {
  // Assert the path is the mapped one and sizeBytes came from stat.
});
test('a delivered row is not delivered again', () => {});
test('a plugin that throws leaves the row completed for the next tick', () => {
  // And assert it is retried: run the pass twice and count two calls.
});
test('a file that is not there is a delivery failure, not a completion failure', () => {});
test('a row whose plugin is not registered is reported unowned and retried', () => {});
test('a delivered row is reclaimed when the adapter can reclaim', () => {});
test('a client with no remove reclaims nothing', () => {
  // The torrent case. Assert zero reclaimed and the row still `delivered`.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - mark delivered before the plugin returns → the throw test must fail
  - fail the row on a missing file → its test must fail
  - call `remove` when it is absent → the no-remove test must fail (a `TypeError` counts, but assert the count)
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Tell a plugin its file landed, and only then let the client forget it" -- packages
```

---

### Task 11: The reconcile job, and wiring

**Files:**
- Create: `packages/host/src/clients/reconcile-job.ts`
- Modify: `packages/host/src/main.ts`, `packages/host/src/index.ts`, `packages/host/src/host.ts`
- Test: `packages/host/test/clients/reconcile-job.test.ts`

**Interfaces:**
- Consumes: every earlier task.
- Produces:
  ```ts
  export const RECONCILE_INTERVAL_S = 60;
  export function createReconcileHandler(deps: {
    raw: DatabaseSync; fetch: QueuedFetch; now: () => number;
    log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
    deliver: (pluginId: string, file: DownloadedFile) => Promise<void>;
  }): JobHandler;
  export function scheduleReconcile(raw: DatabaseSync, jobs: JobQueue, clientId: number, runAt?: number): number;
  ```

One job per download client, kind `reconcile`, payload naming the client id. The handler: read the config (`readClientConfig`), build the adapter, `snapshot()`, `walkSnapshot`, `deliverCompleted`, then **re-enqueue itself** `RECONCILE_INTERVAL_S` later — the dispatcher owns timing, and a job that reschedules itself needs no second scheduler.

`main` schedules one reconcile job per configured `download_client` row on boot, the way it already schedules a poll per feed. Idempotent per client: a client that already has a `ready` or `running` reconcile job gets no second one.

**A tick that throws must still re-enqueue**, or one unreachable client silently stops reconciling forever. Wrap the body so the reschedule happens either way, and log the failure. The dispatcher's own retry would eventually dead-letter the row; rescheduling is what makes an unreachable client a recoverable condition rather than a terminal one.

Bound the whole tick with the handler's `AbortSignal` where the fetch accepts one; add no timeout of this task's own.

- [ ] **Step 1: Write the failing tests**

```ts
test('a tick advances a row and re-enqueues itself', () => {});
test('a tick whose snapshot throws still re-enqueues, and logs', () => {
  // Otherwise one unreachable client stops reconciling for good.
});
test('scheduling is idempotent per client', () => {});
test('main schedules one reconcile job per configured client', () => {});
test('a client whose row is gone does not re-enqueue', () => {
  // A deleted client must not leave a job rescheduling itself forever.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement and wire into `main`.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - re-enqueue only on success → the throwing test must fail
  - drop the idempotence guard → its test must fail
  - re-enqueue for a deleted client → its test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git add -- packages && git commit -m "Poll every configured client on a timer the dispatcher already owns" -- packages
```

---

## Self-Review

**Spec coverage.** §1's six deliverables → Tasks 3+4 (snapshot), 7+8+9 (the pass), 1 (state machine columns) + 6 (transitions), 10 (delivery and reclaim), 9 (absence). §1.1's five exclusions have no tasks, deliberately. §2's forks are each carried into the task that implements them, with the reasoning, because the reasoning is what a reviewer disagrees with. §3 → Task 1. §4 → Task 2, with the adapters in 3 and 4. §5's six steps → Tasks 7 (1, 3), 8 (2), 9 (4), 10 (5, 6). §6 → Task 5. §7's five failure modes → Task 10 (plugin throws, plugin hangs), Task 6 (two clients one ref), Task 9 (never-complete snapshot), Task 11 (client hangs). §8's eight properties → distributed, each named as a test. §9's consequences are recorded, not work.

**Placeholder scan.** No "TBD", no "handle errors", no "similar to Task N". Every code step carries real SQL, real signatures or a real status table; every test is a named case with the reason it exists beside it.

**Type consistency.** `ClientSnapshot`/`ClientQueueEntry`/`ClientHistoryEntry` are Task 2's and Tasks 3, 4, 7, 8, 9 consume them unchanged. `DownloadRow`/`DownloadStatus` are Task 6's and Tasks 7–10 consume them. `ReconcileResult` is Task 7's and grows in 8 (`recovered`) and 9 (`absent`) — stated in both. `DownloadedFile` is the contract's, unchanged. `mapClientPath` is Task 5's, called only by Task 10.

**One thing recorded rather than resolved.** `ReconcileResult` grows across three tasks, which means Task 7's reviewer sees a type that is not yet its final shape. The alternative — declaring all seven counters in Task 7 with three of them permanently zero — would put fields in a type that the task cannot produce, and a reviewer would rightly ask why. Growing it where each number becomes real is the lesser evil, and each task says so.

**A note on the two opposite defaults.** Task 3 reads an unknown status as `failed`; Task 4 reads an unknown state as `queue`. This will look like an inconsistency to anyone who reads the code and not the reasons, so both tasks are required to write the contrast into the comment and name the other file. If a reviewer flags it anyway, that is the system working — the answer is in both places.
