# Slice B Implementation Plan — The Feed Reader and Artwork

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give slice A's contract a producer — poll a feed, insert what is new, notify the owning plugin — and prove the artwork path by having the test double fetch predetermined images.

**Architecture:** Jobs are the scheduler: a `poll` job per feed re-enqueues itself at `now + interval`, so nothing about the schedule lives in memory and a restart resumes mid-cycle. Fetch concurrency is the fetch subsystem's business, not the runner's — per-hostname queues with a configurable limit — so jobs stay serial behind one pump. `MediaWriter` gains the artwork bytes and writes the file and the row together.

**Tech Stack:** TypeScript on Node's `node:sqlite`, Drizzle 1.0-rc, `node:test`, `fast-xml-parser` for RSS, `image-size` for measuring artwork.

**Spec:** `docs/superpowers/specs/2026-09-03-feed-reader-artwork-design.md` — read it alongside this plan; the spec is the authority this plan argues from.

## Global Constraints

- Never the `any` type; never a cast to silence a type error.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly` are all on. Indexed and `Map.get` access is checked, never `!`-asserted. Type-only imports must be `import type`. No enums.
- Ids are SQLite integer rowids. Provider uuids and feed guids are stored as references, never adopted as keys.
- Plugin tables are prefixed with the plugin id. The host's reserved plugin id is `host` and it declares no tables.
- Prefer async APIs over sync twins — `fs.promises` over `fs.*Sync`. Inside an `async` function, `await` it.
- A comment false about the code beside it is a defect equal to a wrong line of code.
- Pickarr 1.x (`packages/core`, `packages/plugin-api`, `packages/plugin-scenes`, `packages/web`, `packages/e2e`) is deployed and **must not be touched**. Read it for reference freely; change nothing.
- Handlers must be idempotent: a job re-run after a crash must not double-write. Every shared-row attach is an upsert onto a unique index.
- **Do not hardcode a cumulative test count.** Slice A's plan predicted totals three times and was wrong three times, because tasks added tests the plan had not foreseen. Each task reports the count it started from and the count it ended with. `lint` must stay at **exactly 124 warnings** with **0 in `packages/contract` and `packages/host`**; if a change would add one, fix the cause rather than the count.
- Full gate, each redirected to a file and grepped — never pipe a test run through `grep`: `npm run typecheck`, `npm run test:server`, `npm run lint`, `npm run build`, `npm run test-hygiene`, `npm run e2e` (**25 passed**), `npm run test:web` (**377**).
- `packages/web`'s `Browse.test.tsx` has two **measured** flaky tests — `the selection clears when a term filters the selected group out` (about one run in three) and `picking costs one request, not a refetch`. `packages/web` is untouched by this slice, so report either only if it fails **consistently**.

## File Structure

**Modified**
- `packages/host/src/db/migrate.ts` — `migrateHost` becomes atomic; `HOST_MIGRATIONS` gains version 2.
- `packages/host/src/db/schema.ts` — mirrors the new columns and indexes; `schema.test.ts` compares the two and will fail if they drift.
- `packages/host/src/fetch/queue.ts` — the gate chain becomes real per-hostname queues.
- `packages/contract/src/fetch.ts` — the doc comment promising "one active at a time" becomes accurate.
- `packages/contract/src/media.ts` — artwork methods take bytes; `attachLogo` is added.
- `packages/host/src/media/writer.ts` — measures, caches, and deletes files with rows.
- `packages/host/src/host.ts` — reserves the `host` plugin id and registers host-owned handlers.
- `packages/host/test/double/plugin.ts` — gains an `artwork` job.

**Created**
- `packages/host/src/feeds/parse-rss.ts` — pure XML text → entries. No I/O.
- `packages/host/src/feeds/reader.ts` — poll one feed: fetch, parse, insert, notify.
- `packages/host/src/artwork/store.ts` — measure bytes, write and delete cache files.
- `packages/host/src/main.ts` — the runnable process: migrate, register, recover, pump, drain.
- `scripts/seed-feed.ts` — insert an `rss_feed` row so a fresh install has something to poll.

---

### Task 1: Make `migrateHost` atomic, then add version 2

**Files:**
- Modify: `packages/host/src/db/migrate.ts`
- Modify: `packages/host/src/db/schema.ts`
- Test: `packages/host/test/db/migrate.test.ts`, `packages/host/test/db/schema.test.ts`

**Interfaces:**
- Consumes: `migrateHost(raw: DatabaseSync): void`, `Migration { version: number; up(db: DatabaseSync): void }`.
- Produces: the same signature, plus these columns for every later task — `rss_item.guid TEXT`, `rss_feed.download_type TEXT NOT NULL` (`'torrent' | 'usenet'`), `rss_feed.poll_interval_s INTEGER NOT NULL`, and `path TEXT` on `poster`, `background` and `logo`.

**Why atomicity first.** `migrateHost` currently runs `migration.up(raw)` and then `record.run(...)` as two statements. SQLite's DDL autocommits, so a crash between them leaves the schema applied and the version unrecorded — and every later boot then dies on `table download_client already exists`. Slice A recorded this as a condition with two triggers: a production startup calling `openDatabase`, or `HOST_MIGRATIONS` gaining a version 2. This task is both.

- [ ] **Step 1: Write the failing atomicity test**

```ts
test('a host migration that throws leaves no trace of itself', () => {
  const raw = new DatabaseSync(':memory:');
  const boom: Migration[] = [
    { version: 1, up: (db) => db.exec('CREATE TABLE kept (id INTEGER PRIMARY KEY)') },
    { version: 2, up: (db) => {
      db.exec('CREATE TABLE half_done (id INTEGER PRIMARY KEY)');
      throw new Error('migration 2 failed');
    } },
  ];
  assert.throws(() => migrateHostWith(raw, boom), /migration 2 failed/);

  // Version 1 stands. Version 2 left neither its table nor its version row,
  // so the next boot re-runs it rather than skipping it as applied.
  assert.deepEqual(tableNamesFor(raw).filter((n) => n === 'kept' || n === 'half_done'), ['kept']);
  const versions = raw.prepare('SELECT version FROM host_migrations ORDER BY version').all();
  assert.deepEqual(versions.map((r) => Number((r as { version: unknown }).version)), [1]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/db/migrate.test.ts > /tmp/t1.log 2>&1; grep -E '^ℹ (pass|fail)' /tmp/t1.log`
Expected: the `half_done` assertion fails — the table survives the throw.

- [ ] **Step 3: Wrap each host migration in a savepoint**

Mirror `migratePlugin`'s existing fix exactly, including the `ROLLBACK TO` **and** `RELEASE` pair — `ROLLBACK TO` undoes the work but leaves the savepoint on the stack, so without the `RELEASE` the connection stays inside a transaction nothing will close.

```ts
for (const migration of list.toSorted((a, b) => a.version - b.version)) {
  if (applied.has(migration.version)) continue;
  raw.exec('SAVEPOINT host_migration');
  try {
    migration.up(raw);
    record.run(migration.version, now());
  } catch (err) {
    raw.exec('ROLLBACK TO host_migration');
    raw.exec('RELEASE host_migration');
    throw err;
  }
  raw.exec('RELEASE host_migration');
}
```

Take an injected clock while you are here: `migrateHost(raw, now: () => number = Date.now)`. The host currently stamps `applied_at` with `Date.now()` directly, which is the second clock slice A recorded against `PluginContext`. **Add the parameter only if a test uses it** — an unused optional parameter is a smell an earlier review already flagged on this exact function. If your atomicity test does not need it, leave the signature alone and say so in your report.

Export a test-only seam so the test above can supply its own list, rather than making the real `HOST_MIGRATIONS` throw:

```ts
/** Exported for tests: `migrateHost` is this with the real migration list. */
export function migrateHostWith(raw: DatabaseSync, list: readonly Migration[], now?: () => number): void
export function migrateHost(raw: DatabaseSync): void { migrateHostWith(raw, HOST_MIGRATIONS); }
```

- [ ] **Step 4: Run it and confirm it passes**

- [ ] **Step 5: Add version 2**

```ts
const MIGRATION_2 = `
ALTER TABLE rss_item ADD COLUMN guid TEXT;
CREATE UNIQUE INDEX rss_item_feed_guid ON rss_item (feed_id, guid);

ALTER TABLE rss_feed ADD COLUMN download_type   TEXT    NOT NULL DEFAULT 'torrent';
ALTER TABLE rss_feed ADD COLUMN poll_interval_s INTEGER NOT NULL DEFAULT 900;

ALTER TABLE poster     ADD COLUMN path TEXT;
ALTER TABLE background ADD COLUMN path TEXT;
ALTER TABLE logo       ADD COLUMN path TEXT;
CREATE UNIQUE INDEX logo_media_item_url ON logo (media_item_id, url);
`;
```

Four things to get right, each with a reason:

1. **`ALTER TABLE ... ADD COLUMN` with `NOT NULL` requires a `DEFAULT`** in SQLite. `'torrent'` and `900` are those defaults; they exist so the statement is legal on a table that already holds seeded rows, not because they are good values to inherit silently.
2. **`guid` is nullable.** SQLite treats NULLs as distinct in a unique index, so pre-existing rows with no guid do not collide. The reader always writes one (§4 falls back to the link), so a NULL means a row predating this migration.
3. **`logo` gains `UNIQUE (media_item_id, url)`** to match `poster` and `background`. It is the one artwork table slice A left with no unique index and no writer, and that index is what makes a re-run idempotent instead of duplicating rows.
4. **The old `logo_media_item` plain index stays.** Dropping it is unrelated to this slice, and the new unique index has the same leading column so it can serve the same lookups — say in your report if you dropped it and why.

- [ ] **Step 6: Mirror the change in `schema.ts`**

`packages/host/test/db/schema.test.ts` compares `schema.ts` against the DDL — every table, every column name/type/nullability, and every index including its column order and uniqueness. It will fail until `schema.ts` matches. **That failure is the test working**; do not weaken the comparison to make it pass.

- [ ] **Step 7: Prove the new tests can fail**

Apply each mutation, run, restore byte-for-byte, confirm with `git status`, and report pass/fail counts by name:
- remove the `SAVEPOINT`/`ROLLBACK TO` pair → the atomicity test fails
- omit `guid` from `schema.ts` only → a `schema.test.ts` test fails
- make `logo`'s new index non-unique in `schema.ts` only → a `schema.test.ts` test fails

- [ ] **Step 8: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Make a host migration atomic before adding one, so a crash mid-migration cannot poison every later boot"
```

---

### Task 2: Per-hostname queues with a configurable limit

**Files:**
- Modify: `packages/host/src/fetch/queue.ts`, `packages/contract/src/fetch.ts`
- Test: `packages/host/test/fetch/queue.test.ts`

**Interfaces:**
- Consumes: `HostFetch { json<T>(url, init?): Promise<T>; bytes(url, init?): Promise<Uint8Array> }` — unchanged.
- Produces:
  ```ts
  export interface FetchLimits {
    /** Applied to any hostname without a specific entry. */
    default: number;
    /** Keyed by exact hostname, e.g. `{ 'cdn.example.com': 10 }`. */
    perHost?: Readonly<Record<string, number>>;
  }
  export function createHostFetch(deps: {
    fetch: typeof globalThis.fetch;
    limits?: FetchLimits;
  }): HostFetch;
  ```

**Why a rewrite rather than a tweak.** Today `tails: Map<string, Promise<unknown>>` chains each request onto the previous one's gate. A chain expresses "after the last one" and cannot express "while fewer than N are running", so raising the limit is not a parameter change. Replace it with a per-hostname record holding a running count and a queue of waiters.

- [ ] **Step 1: Write the failing tests**

```ts
test('two requests to one hostname do not overlap at the default limit of one', async () => {});
test('a rejected request still releases its slot, so the next request to that hostname runs', async () => {
  // The wedge this guards: if the slot is released only on success, one
  // rejection stops that hostname forever and nothing reports it.
});
test('a per-host limit of two lets two run at once and makes a third wait', async () => {
  // Assert by counting in-flight calls, never by elapsed time.
});
test('a hostname with no entry takes the default limit', async () => {});
test('the limit is keyed by hostname, so two hosts proceed in parallel', async () => {});
test('the hostname comes from the url, so a caller cannot opt out of its limit', async () => {});
```

Use a tracking stub that records concurrency directly, rather than sleeping:

```ts
function trackingFetch() {
  let active = 0;
  const seen: number[] = [];
  const gates: Array<() => void> = [];
  const fetch = async (): Promise<Response> => {
    active += 1;
    seen.push(active);
    await new Promise<void>((resolve) => gates.push(resolve));
    active -= 1;
    return new Response('{}', { status: 200 });
  };
  return { fetch, seen, gates, maxActive: () => Math.max(...seen) };
}
```

- [ ] **Step 2: Run and confirm failure.** The per-host-limit tests fail because the option does not exist yet.

- [ ] **Step 3: Implement the queues**

```ts
interface HostQueue { running: number; limit: number; waiting: Array<() => void> }

function queueFor(hostname: string): HostQueue { /* create with resolved limit on first sight */ }

async function enqueue<T>(hostname: string, task: () => Promise<T>): Promise<T> {
  const q = queueFor(hostname);
  if (q.running >= q.limit) await new Promise<void>((resolve) => q.waiting.push(resolve));
  q.running += 1;
  try {
    return await task();
  } finally {
    // Runs whether `task` resolved or rejected. The decrement and the wake
    // are the same hazard slice A's `finally` guarded: skip them on the
    // rejection path and that hostname's queue drains to a permanent stall,
    // silently, with every later request waiting on a promise nothing will
    // settle.
    q.running -= 1;
    q.waiting.shift()?.();
  }
}
```

**The default limit is 1**, so every existing behaviour is unchanged until someone raises it. Nothing in this slice sets `perHost`.

- [ ] **Step 4: Run and confirm the tests pass.**

- [ ] **Step 5: Correct the contract's doc comment**

`packages/contract/src/fetch.ts` currently says requests are serialised per hostname, "one active at a time", and that this "makes 'one at a time per host' a property of the system rather than a habit". The limit is now configurable, so rewrite it: the *hostname* is still derived from the url and still not something a caller can opt out of, but the number in flight is a host-level setting that defaults to one.

- [ ] **Step 6: Prove the tests can fail**

Report counts by name for each:
- drop the `q.running -= 1` and the wake from the `finally` → the rejection test fails
- key the queue map by the full url instead of the hostname → the parallel-hosts and non-overlap tests fail
- ignore `perHost` and always use the default → the limit-of-two test fails

- [ ] **Step 7: Run the full gate, then commit**

```bash
git add packages/contract packages/host
git commit -m "Give each hostname a real queue with a limit, so a CDN and an API need not share one pace"
```

---

### Task 3: The RSS parser

**Files:**
- Create: `packages/host/src/feeds/parse-rss.ts`
- Modify: `packages/host/package.json` (add `fast-xml-parser`)
- Test: `packages/host/test/feeds/parse-rss.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FeedEntry {
    /** The feed's own identity for this item. Falls back to `link` when absent. */
    guid: string;
    /** The release name. 1.x calls this `title`; a row stores it as `filename`. */
    filename: string;
    link: string;
  }
  export function parseRss(xml: string): readonly FeedEntry[];
  ```

A pure function from text to entries — no fetching, no database, no clock. That is what makes it cheap to test against real feed samples. 1.x's `packages/core/src/feeds/parse-rss.ts` uses `fast-xml-parser` and yields `{ guid, title, link, publishedAt }`; read it for the parser options it settled on, and do not modify it.

**`published_at` is deliberately not parsed.** Nothing orders by it, and `rss_item.created_at` records when we first saw an item. A field nothing reads is the smell this project keeps finding.

- [ ] **Step 1: Write the failing tests**

```ts
test('an item yields its guid, filename and link', () => {});
test('an item with no guid falls back to its link, because RSS does not require one', () => {
  // Identity must exist for every entry or the dedup index cannot hold.
});
test('a single-item feed parses as one entry, not as a bare object', () => {
  // fast-xml-parser collapses a one-element list into an object unless told
  // otherwise. Left unhandled, a feed with exactly one new item parses as
  // nothing -- and a feed's quiet day is precisely when that happens.
});
test('CDATA around a title is unwrapped', () => {});
test('an item missing a link is skipped rather than stored without one', () => {
  // `rss_item.link` is NOT NULL, so an entry with nothing to download is not
  // a row -- and inventing an empty string would make it one.
});
test('a feed with no items yields an empty list rather than throwing', () => {});
test('xml that is not a feed at all yields an empty list', () => {
  // An indexer serving an html error page with status 200 must not look like
  // a feed that went empty.
});
```

- [ ] **Step 2: Run and confirm failure** — the module does not exist.

- [ ] **Step 3: Implement, then add the dependency**

Add `"fast-xml-parser"` to `packages/host/package.json` dependencies, matching the version 1.x already pins so the repo holds one copy. Run `npm install` at the repo root and commit the lockfile change with this task.

The single-item collapse is the one parser option that matters: configure the parser so `item` is always an array, or normalise it yourself immediately after parsing.

- [ ] **Step 4: Run and confirm the tests pass.**

- [ ] **Step 5: Prove the tests can fail**

- remove the single-item array handling → the one-item test fails
- return the guid without the link fallback → the fallback test fails
- keep entries with no link → the skip test fails

- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host package.json package-lock.json
git commit -m "Parse a feed into entries that always carry an identity, so the dedup index has something to hold"
```

---

### Task 4: The reader — insert what is new, notify only that

**Files:**
- Create: `packages/host/src/feeds/reader.ts`
- Test: `packages/host/test/feeds/reader.test.ts`

**Interfaces:**
- Consumes: `parseRss(xml): readonly FeedEntry[]` (Task 3); `HostFetch.json`/`bytes` (Task 2); `rss_item.guid` and `rss_feed.download_type` (Task 1); `Host.notifyNewRssItems(ids): Promise<NotifyOutcome>` where `NotifyOutcome = { unowned: readonly number[]; failures: readonly { pluginId: string; error: unknown }[] }`.
- Produces:
  ```ts
  export interface PollResult {
    /** Rows this poll created. Already handed to `notifyNewRssItems`. */
    inserted: readonly number[];
    /** Entries the feed still lists that we already had. */
    skipped: number;
  }
  export function createFeedReader(deps: {
    raw: DatabaseSync;
    fetchText: (url: string) => Promise<string>;
    notify: (ids: readonly number[]) => Promise<NotifyOutcome>;
    now: () => number;
    log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  }): { pollFeed(feedId: number): Promise<PollResult> };
  ```

`HostFetch` has `json` and `bytes` but no `text`, and a feed is XML. Pass `fetchText` in rather than widening the contract for one caller — and route it through the same per-hostname queue, so a feed's host is paced like any other. Say in your report how you did that.

**This task is the correctness core of the slice.** A poll that re-notifies everything it sees re-runs a lookup for the whole feed every cycle, against a paid service.

- [ ] **Step 1: Write the failing tests**

```ts
test('a first poll inserts every entry and hands all of their ids over', async () => {});
test('a second poll of an unchanged feed inserts nothing and notifies with an empty list', async () => {
  // The whole point. Assert BOTH halves: no new rss_item rows, and the
  // notify call received []. Asserting only the row count would pass under an
  // implementation that re-notifies ids it did not insert.
});
test('a poll of a feed with one added entry hands over exactly that one id', async () => {
  // Poll, add an entry, poll again. The second call must receive a
  // one-element list holding the new row's id -- not the whole feed.
});
test('an entry whose guid is absent is identified by its link', async () => {});
test('a row carries the feed download_type, since an entry does not name one', async () => {});
test('unowned ids are logged rather than dropped', async () => {
  // A feed naming an unregistered plugin is a seeding error. Slice A recorded
  // a condition that this caller must read BOTH outcome fields.
});
test('a plugin failure is logged rather than dropped', async () => {});
```

- [ ] **Step 2: Run and confirm failure** — the module does not exist.

- [ ] **Step 3: Implement the insert path**

Insert one entry at a time with a prepared statement and take what it returns. `node:sqlite` is synchronous, so this loop has no `await` in it and does not trip `no-await-in-loop`:

```ts
const insert = deps.raw.prepare(`
  INSERT INTO rss_item (feed_id, filename, link, guid, download_type, resolution, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  ON CONFLICT (feed_id, guid) DO NOTHING
  RETURNING id
`);

const inserted: number[] = [];
let skipped = 0;
for (const entry of entries) {
  const row = insert.get(feedId, entry.filename, entry.link, entry.guid, feed.downloadType, at, at);
  if (row === undefined) { skipped += 1; continue; }
  inserted.push(Number((row as { id: unknown }).id));
}
```

**Verify `RETURNING` behaves this way before relying on it** — probe `node:sqlite` directly and confirm that a conflicting insert returns `undefined` from `.get()` rather than a row or a throw. Slice A's culture is that a fact in a comment was checked, not assumed; record what you observed.

Then notify, and read both fields:

```ts
const outcome = await deps.notify(inserted);
if (outcome.unowned.length > 0) {
  deps.log('feed items have no registered plugin', { feedId, ids: outcome.unowned });
}
for (const failure of outcome.failures) {
  deps.log('plugin failed on new items', { feedId, pluginId: failure.pluginId, error: String(failure.error) });
}
```

- [ ] **Step 4: Run and confirm the tests pass.**

- [ ] **Step 5: Prove the tests can fail**

Report counts by name:
- collect ids by re-selecting the feed's rows instead of taking `RETURNING` → the unchanged-feed and one-added-entry tests fail
- notify with every parsed entry's id rather than the inserted ones → the same two fail
- drop the `unowned` log → its test fails
- drop the `failures` loop → its test fails

- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Notify only the rows a poll actually created, so a quiet feed costs nothing"
```

---

### Task 5: Host-owned jobs, and a poll that reschedules itself

**Files:**
- Modify: `packages/host/src/host.ts`
- Test: `packages/host/test/host.test.ts`

**Interfaces:**
- Consumes: `createFeedReader` (Task 4); `Runner.enqueue(pluginId, job)`; `JobEnqueue { kind, payload, runAt?, maxAttempts? }`.
- Produces:
  ```ts
  /** The host's own plugin id. No plugin may claim it, and it declares no tables. */
  export const HOST_PLUGIN_ID = 'host';
  /** Enqueues the first `poll` job for a feed. Idempotent per feed. */
  schedulePoll(feedId: number, runAt?: number): number;
  ```

**Why a reserved id.** `jobs.plugin_id` is `NOT NULL` and handlers are keyed by `(pluginId, kind)`, so a job with no plugin cannot be expressed. Rather than adding a parallel dispatch path for host jobs, the host claims `host` and registers handlers under it. `plugin_id` keeps meaning "whose handler runs this" for every row. `runOnce`'s `ctxFor` must therefore answer for `host` as well — build it the same way as any plugin's.

- [ ] **Step 1: Write the failing tests**

```ts
test('registering a plugin whose id is the reserved host id is refused', async () => {
  // Otherwise a plugin silently captures the host's own handlers.
});
test('a poll job dispatches to the host handler, not to a plugin', async () => {});
test('a poll job re-enqueues itself at now plus the feed interval', async () => {
  // Assert the NEW job's run_at, not merely that a job exists: an
  // immediate re-enqueue would spin the feed continuously.
});
test('a poll that loses its re-enqueue leaves the feed with no future job', async () => {
  // The silent-stop failure. A self-rescheduling job that drops its own
  // re-enqueue stops that feed forever and nothing else notices, and a suite
  // where every job succeeds cannot see it. This test is the only guard.
});
test('a poll job that throws is retried rather than dead-lettered on its first attempt', async () => {});
test('a poll for a feed that no longer exists stops rescheduling instead of looping', async () => {
  // Deleting a feed row must end its poll cycle. Without this the job
  // reschedules forever against a row that is gone, and `recover()` will
  // faithfully keep it alive across every restart.
});
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement**

Refuse the reserved id in `register`:

```ts
if (plugin.id === HOST_PLUGIN_ID) {
  throw new Error(`plugin id ${HOST_PLUGIN_ID} is reserved for the host`);
}
```

Register the poll handler under `HOST_PLUGIN_ID`, and make rescheduling the handler's **last** act, after the poll has succeeded — so a failed poll retries through the runner's backoff instead of skipping a cycle:

```ts
const pollHandler: JobHandler = async (job) => {
  const { feedId } = readPollPayload(job.payload);
  await reader.pollFeed(feedId);
  const row = raw.prepare('SELECT poll_interval_s FROM rss_feed WHERE id = ?').get(feedId);
  if (row === undefined) return;   // the feed was deleted; stop rescheduling it
  const seconds = Number((row as { poll_interval_s: unknown }).poll_interval_s);
  runner.enqueue(HOST_PLUGIN_ID, { kind: 'poll', payload: { feedId }, runAt: now() + seconds * 1000 });
};
```

Parse the payload rather than casting it. `JobRecord.payload` is `unknown` because it came back from JSON, and a `payload as { feedId: number }` would compile while being wrong for a malformed row.

- [ ] **Step 4: Run and confirm the tests pass.**

- [ ] **Step 5: Prove the tests can fail**

- remove the re-enqueue → the reschedule and silent-stop tests fail
- re-enqueue with no `runAt` → the reschedule test fails on `run_at`
- allow the reserved id in `register` → its test fails
- reschedule *before* awaiting `pollFeed` → the retry test fails

- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Let the host own its own jobs under a reserved id, so polling needs no second dispatch path"
```

---

### Task 6: `MediaWriter` measures and caches artwork

**Files:**
- Modify: `packages/contract/src/media.ts`, `packages/host/src/media/writer.ts`
- Create: `packages/host/src/artwork/store.ts`
- Modify: `packages/host/package.json` (add `image-size`)
- Test: `packages/host/test/media/writer.test.ts`, `packages/host/test/artwork/store.test.ts`

**Interfaces:**
- Consumes: `path` columns and `logo`'s unique index (Task 1).
- Produces:
  ```ts
  export interface ImageInit {
    /** Where it came from, kept so a re-fetch is possible. */
    url: string;
    title: string | null;
    language: string | null;
    /** Measured here; never supplied. */
    bytes: Uint8Array;
  }
  attachPoster(mediaItemId: number, image: ImageInit): Promise<void>;
  attachBackground(mediaItemId: number, image: ImageInit): Promise<void>;
  attachLogo(mediaItemId: number, image: ImageInit): Promise<void>;
  // store.ts
  export function createArtworkStore(dir: string): {
    put(url: string, bytes: Uint8Array): Promise<{ path: string; width: number; height: number }>;
    remove(path: string): Promise<void>;
  };
  ```

`width` and `height` leave the init types entirely: because the writer measures, a caller cannot supply a wrong dimension. `background.description` stays unwritten rather than gaining a field no caller would fill.

- [ ] **Step 1: Write the failing tests**

```ts
// store.test.ts
test('putting an image writes a file and returns its measured dimensions', async () => {});
test('putting the same url twice writes one file at the same path', async () => {
  // Idempotency. The path is derived from the url, so a re-run overwrites
  // rather than accumulating.
});
test('bytes that are not an image are refused rather than stored', async () => {
  // An html error page served with status 200, or a truncated download. 1.x
  // guessed in this situation and needed a repair script; refusing means the
  // job retries instead.
});

// writer.test.ts
test('attaching a poster stores the row with the measured width and height', async () => {});
test('attaching a logo stores a row, which slice A had no way to do', async () => {});
test('attaching the same url twice leaves one row and one file', async () => {});
test('dropping a media item deletes its artwork rows and their files', async () => {
  // An orphaned file leaks; an orphaned row is worse, because something will
  // try to serve it.
});
test('a portrait image and a landscape image are stored as given, not reclassified', async () => {
  // The caller chose the method. Measuring supplies dimensions; it does not
  // move an image between tables.
});
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement the store**

Name the file from a hash of the **url**, so re-attaching the same url resolves to the same path — that is what makes the unique index on `(media_item_id, url)` and the file agree. Use `crypto.subtle.digest`, not a blocking hash:

```ts
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
const name = [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
```

Measure with `image-size`, which also reports the type — use it for the extension. `imageSize` **throws** on bytes it cannot read, and returns width/height possibly `undefined`; treat both as a refusal, exactly as 1.x's `classifyArtwork` does (`packages/core/src/media/classify.ts` — read it, do not modify it).

Use `fs.promises`. `mkdir(dir, { recursive: true })` before the first write.

**Deletion order matters.** Read the paths, delete the rows, then unlink the files best-effort. A failed unlink after the row is gone leaks a file; a failed row delete after the unlink leaves a row pointing at nothing, which is the worse of the two. Say in your report which you chose and why.

- [ ] **Step 4: Add the dependency and wire the writer**

Add `"image-size"` to `packages/host/package.json`, matching the version 1.x pins (`^2.0.2`). `createMediaWriter` needs the store, so it takes an artwork directory or a store instance — thread it from `createHost`, and note in your report that `MediaWriter` now performs filesystem I/O, which is the cost of one writer for the row-and-file pair.

- [ ] **Step 5: Run and confirm the tests pass.**

- [ ] **Step 6: Prove the tests can fail**

- return invented dimensions instead of measuring → the measured-dimensions test fails
- store unmeasurable bytes with `0 x 0` → the refusal test fails
- name the file from a random value instead of the url hash → the same-url-twice tests fail
- skip the file unlink in `dropMediaItem` → its test fails

For test images, the cheapest valid fixture is a GIF: `image-size` reads width and height straight out of the logical screen descriptor, so `'GIF89a'` followed by little-endian 16-bit width and height is measurable without constructing CRCs the way a PNG needs. **Probe that before building fixtures on it**, and if it does not hold, write a small PNG builder instead and say so.

- [ ] **Step 7: Run the full gate, then commit**

```bash
git add packages/contract packages/host package.json package-lock.json
git commit -m "Measure an image on the way in and cache it beside its row, so the two cannot disagree"
```

---

### Task 7: The double fetches predetermined images

**Files:**
- Modify: `packages/host/test/double/plugin.ts`
- Test: `packages/host/test/double/flow.test.ts`

**Interfaces:**
- Consumes: `attachPoster`/`attachBackground`/`attachLogo` with `ImageInit` (Task 6); `HostFetch.bytes` with per-host limits (Task 2).

The double's fake service gains an image list per resolved entry. On resolving, the double enqueues an `artwork` job carrying the media item id and the urls; the handler fetches each through `ctx.fetch.bytes` and calls the matching attach. This is the first code to call `attachPoster` and `attachBackground` at all — slice A shipped both with **no test calling them**.

- [ ] **Step 1: Write the failing tests**

```ts
test('a resolved entry gets its poster, background and logo attached', async () => {});
test('artwork runs as its own job, so a failed image does not undo a resolved item', async () => {
  // Retry isolation: exhausting the artwork job must leave a media item with
  // no artwork, never no media item.
});
test('images on different hosts are fetched in parallel', async () => {
  // The first workload where the per-hostname limits matter. Assert by
  // counting in-flight requests per host, never by timing.
});
test('an image the service offers but the host cannot measure leaves the other two attached', async () => {});
test('re-running the artwork job attaches nothing new', async () => {
  // Idempotency end to end: same rows, same files.
});
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement the artwork job in the double**

- [ ] **Step 4: Run and confirm the tests pass.**

- [ ] **Step 5: Prove the tests can fail**

- attach with the artwork inline in the `lookup` handler rather than as its own job → the retry-isolation test fails
- serialise the image fetches → the parallel test fails
- let an unmeasurable image abort the whole job → the leaves-the-other-two test fails

- [ ] **Step 6: Run the full gate, then commit**

```bash
git add packages/host
git commit -m "Give the double an artwork step, so the attach methods have a caller and the fetch limits have a workload"
```

---

### Task 8: The runnable process

**Files:**
- Create: `packages/host/src/main.ts`, `scripts/seed-feed.ts`
- Modify: `packages/host/package.json` (a `start` script), `packages/host/src/index.ts`
- Test: `packages/host/test/main.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export interface Pump { stop(): void; done: Promise<void> }
  /** Claims jobs until stopped. Sleeps when nothing is ready. */
  export function startPump(host: Host, deps: { idleMs?: number; sleep?: (ms: number) => Promise<void> }): Pump;
  export async function main(argv: readonly string[]): Promise<void>;
  ```

`runOnce` returns `false` when nothing was ready, which is what makes sleeping correct rather than a guess. Default `idleMs` to 1000 and inject `sleep` so tests need not wait on wall time.

- [ ] **Step 1: Write the failing tests**

```ts
test('the pump runs ready jobs until none remain, then sleeps', async () => {});
test('stopping the pump lets the in-flight job finish before done resolves', async () => {
  // Draining. A job killed mid-flight is safe -- recover() handles it -- but
  // the common case should be clean.
});
test('startup calls recover before the pump claims anything', async () => {
  // Otherwise a job left running by a crash is never returned to ready, and
  // the queue is permanently one job short.
});
test('the pump keeps running after a job throws', async () => {
  // A handler's failure is the runner's business. A pump that exits on the
  // first rejection turns one bad job into an outage.
});
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement the pump and `main`**

```ts
while (running) {
  if (!(await host.runOnce())) await sleep(idleMs);
}
```

`main` opens the database at `PICKARR_DATABASE ?? '/config/pickarr.db'`, runs `migrateHost`, builds the fetch subsystem and the artwork store (defaulting the directory to `artwork/` beside the database file, matching 1.x's `resolveArtworkDir`), registers plugins, calls `recover()`, schedules a `poll` for every `rss_feed` row, then starts the pump. `SIGINT` and `SIGTERM` call `stop()` and await `done`.

- [ ] **Step 4: Write the seed script**

`scripts/seed-feed.ts` inserts one `rss_feed` row from arguments — plugin id, name, url, download type, interval — because there is no config surface and a fresh install polls nothing until a feed exists. Follow the shape of the existing scripts in `scripts/`, which take `--database=`.

- [ ] **Step 5: Run and confirm the tests pass.**

- [ ] **Step 6: Prove the tests can fail**

- exit the loop when `runOnce` returns false → the until-none-remain test fails
- skip `recover()` at startup → its test fails
- let a rejected `runOnce` escape the loop → the keeps-running test fails
- resolve `done` without awaiting the in-flight job → the drain test fails

- [ ] **Step 7: Run the full gate, then commit**

```bash
git add packages/host scripts
git commit -m "Run the host as a process, so jobs run because it is up rather than because a test asked"
```

---

## Self-Review

**Spec coverage.** §1 the four deliverables → Tasks 2, 4, 6-7, 8. §1.1's decisions → Global Constraints and the task that carries each: feeds-as-rows → Task 8's seed script; identity → Tasks 1 and 4; fetch concurrency → Task 2; artwork to disk → Tasks 1 and 6; one writer for row-and-file → Task 6; jobs-as-scheduler → Task 5; still-the-double → Task 7. §1.2's exclusions → no tasks, deliberately. §2 the fetch subsystem → Task 2. §3 the reader → Tasks 3 and 4. §4 identity and insert → Task 4. §5 the pump → Task 8. §6 artwork → Task 6. §7 the writer surface → Task 6. §8 migration and the condition → Task 1. §9 the flows → Tasks 4, 5 and 7 together. §10's two headline properties → Task 4's second test and Task 2's rejection test. §11's consequences → recorded, not work.

**Placeholder scan.** No "TBD", no "handle edge cases", no "similar to Task N". Test cases are named one-line skeletons with their fixtures and assertion targets stated, and the reason each exists is written beside it; the load-bearing implementation steps carry real code. Three steps deliberately ask the implementer to **probe before relying on a fact** — `RETURNING` on a conflicting insert (Task 4), GIF measurability (Task 6), and whether an injected clock in `migrateHost` earns its parameter (Task 1) — rather than asserting things I have not run.

**Type consistency.** `FeedEntry { guid, filename, link }` is Task 3's and Task 4 consumes it unchanged. `ImageInit` is Task 6's and Task 7 calls it. `NotifyOutcome` is slice A's, spelled the same in Task 4. `HOST_PLUGIN_ID` is Task 5's and Task 8 schedules under it. `createArtworkStore`'s `put` returns `{ path, width, height }`, which is what Task 6's writer inserts. `parseRss` is named the same in Tasks 3 and 4 — 1.x has a function of the same name in `packages/core`, which must not be imported or modified.

**One thing recorded rather than resolved.** `PluginContext` still has no clock, so the double stamps its own rows from its own clock while `MediaWriter` stamps from the host's. Task 1 offers to fix `migrateHost`'s `Date.now()` only if a test needs the parameter. Closing this properly means adding `now` to the contract, which is a slice A change this plan deliberately does not make.
