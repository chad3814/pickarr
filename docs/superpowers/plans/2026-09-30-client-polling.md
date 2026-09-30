# Client Polling, Health and Stuck Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poll SAB/qBittorrent every 10 seconds with a reconcile cycle that can never dead-letter, record per-client health and prefer reachable clients, settle picks stuck in `submitting`, and back off imports that keep being refused.

**Architecture:** Host migration 25 adds two health columns to `download_client` (synced) and two import-backoff columns to both download tables (host-only). The reconcile handler catches every failure and reschedules itself: contact failures back off 10s→5min and update health, and local faults retry at 10s. `walkSnapshot` gains a final settle step, `deliverCompleted` skips rows not yet due and records refusals, saving a destination clears the wait, `selectClientForFeed` prefers reachable clients, and the settings list shows each client's health.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `node:sqlite`, `node:test`, React + `@testing-library/react` under jsdom, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-30-client-polling-design.md`

## Global Constraints

- Worktree `/Users/chad/Projects/pickarr/worktrees/phase2-client-polling`, branch `phase2-client-polling`. Never edit `worktrees/main`, never push, never merge, never use bare `git stash`.
- Host migration **25**, `ADD COLUMN` only.
- `RECONCILE_INTERVAL_S = 10`.
- Contact-failure reschedule delay: `min(10_000 × 2^(n−1), 300_000)` ms, where `n` = new `consecutive_failures`.
- Import-refusal retry delay: `min(10_000 × 2^(n−1), 3_600_000)` ms, where `n` = new `import_failures`.
- Unreachable means `consecutive_failures >= 3`: the constant `CLIENT_UNREACHABLE_AFTER_FAILURES = 3` in `@pickarr/contract`.
- A `submitting` row is settled when `created_at < now − 600_000`, with `last_error` = `the client never confirmed this submission`.
- Health is written only when it changes. A healthy client's successful tick writes nothing to `download_client`.
- No error text is stored in or replicated from `download_client`. Log errors through `redactText`.
- Settings text: `Reachable`, or `Unreachable since <local time> (<n> failed checks)`, as real visible text, never an `aria-label`.
- No `any`. Narrow instead of casting. Prefer async APIs. A comment must be true of the code beside it (`CLAUDE.md`).
- `CLAUDE.md`'s web testing hazards: `afterEach(cleanup)`, never hand a live DOM node to `node:assert`, no `t.mock.timers`.
- The gate is `npm run check` (redirect to a file and read `$?`). Every task ends green. One skipped server test is expected on some machines (uid-dependent).

## Review Focus

1. **A replica row from before migration 25.** A browser whose replica holds a `download_client` row with no `consecutiveFailures`/`unreachableSince` must list it as `Reachable`, not drop it or render `undefined`. Test in Task 1.
2. **A client deleted while it is failing.** Its cycle must end, not keep rescheduling against a missing row. Test in Task 2.
3. **A client that is down.** Its old `submitting` rows must not be failed, because without its list the tick can't tell whether they reached it. Test in Task 3.
4. **A client whose secret no longer resolves** (`readClientConfig` throws). This counts as a contact failure, and the cycle survives. Test in Task 2.
5. **A long outage.** The reschedule delay reaches the 5-minute cap and stays there, and no reconcile job ever reaches `dead`. Test in Task 2.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/host/src/db/migrate.ts`, `db/schema.ts` | migration 25; Drizzle columns | 1 |
| `packages/contract/src/sync.ts`, `download-clients.ts` (or the module holding `AddDownloadClientRefusalCode`), `index.ts` | `DownloadClientSyncRead` health fields; `CLIENT_UNREACHABLE_AFTER_FAILURES` | 1 |
| `packages/host/src/sync/tables.ts` | project the two health columns | 1 |
| `packages/host/src/jobs/backoff.ts` | `doublingDelayMs` | 1 |
| `packages/web/src/settings/useDownloadClients.ts` | tolerant row reading | 1 |
| `packages/host/src/clients/health.ts` (new) | health writes, reachability, reconcile delay | 2 |
| `packages/host/src/clients/reconcile-job.ts` | 10s interval; the never-dead tick | 2 |
| `packages/host/src/clients/rows.ts` | `failUnconfirmed`; `DownloadRow` import fields; `recordImportRefusal`; `clearImportWait` | 3, 4 |
| `packages/host/src/clients/reconcile.ts` | settle step and `unconfirmed` counter | 3 |
| `packages/host/src/clients/deliver.ts` | not-due skip; `refused` counter | 4 |
| `packages/host/src/media/destinations.ts` | clear the wait on save | 4 |
| `packages/host/src/clients/select.ts` | prefer reachable | 5 |
| `packages/web/src/settings/DownloadClients.tsx`, `packages/web/src/styles/settings.css` | health line | 6 |

---

### Task 1: Data layer (migration 25, contract, projection, tolerant web read, delay helper)

**Files:**
- Modify: `packages/host/src/db/migrate.ts` (new `MIGRATION_25` and a list entry after `{ version: 24, … }` at ~1439)
- Modify: `packages/host/src/db/schema.ts` (the `downloadClient`, `torrentDownload` and `nzbDownload` tables)
- Modify: `packages/contract/src/sync.ts:489-508` (`DownloadClientSyncRead`)
- Modify: the contract module that exports `AddDownloadClientRefusalCode` (find it with `grep -rn "AddDownloadClientRefusalCode" packages/contract/src`), plus `packages/contract/src/index.ts`
- Modify: `packages/host/src/sync/tables.ts:434-441`
- Modify: `packages/host/src/jobs/backoff.ts`
- Modify: `packages/web/src/settings/useDownloadClients.ts` (`isDownloadClient`, ~line 71)
- Test: `packages/host/test/db/migrate.test.ts`, `packages/host/test/sync/tables.test.ts`, `packages/host/test/jobs/backoff.test.ts` (create it if absent), `packages/web/test/settings/DownloadClients.test.tsx`

**Interfaces:**
- Produces:
  - Columns: `download_client.consecutive_failures INTEGER NOT NULL DEFAULT 0` and `download_client.unreachable_since INTEGER`. In both `torrent_download` and `nzb_download`: `import_failures INTEGER NOT NULL DEFAULT 0` and `import_retry_at INTEGER`.
  - `DownloadClientSyncRead.consecutiveFailures: number` and `DownloadClientSyncRead.unreachableSince: number | null`.
  - `export const CLIENT_UNREACHABLE_AFTER_FAILURES = 3` from `@pickarr/contract`.
  - `export function doublingDelayMs(attempt: number, baseMs: number, capMs: number): number` from `packages/host/src/jobs/backoff.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/host/test/db/migrate.test.ts`:

```ts
test('migration 25 adds client health and import backoff columns in place, with their defaults', () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 24));
  raw.exec(`
    INSERT INTO download_client (name, type, implementation, url, category, import_mode, created_at, updated_at)
      VALUES ('c', 'torrent', 'qbittorrent', 'https://c.example', 'movies', 'copy', 1, 1);
  `);
  migrateHost(raw);

  const columns = (table: string): Set<string> => new Set(
    raw.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()
      .map((row) => String((row as { name: unknown }).name)),
  );
  for (const column of ['consecutive_failures', 'unreachable_since']) {
    assert.ok(columns('download_client').has(column), `download_client.${column}`);
  }
  for (const table of ['torrent_download', 'nzb_download']) {
    for (const column of ['import_failures', 'import_retry_at']) {
      assert.ok(columns(table).has(column), `${table}.${column}`);
    }
  }
  const client = raw.prepare('SELECT consecutive_failures, unreachable_since FROM download_client WHERE name = ?').get('c');
  assert.deepEqual({ ...client }, { consecutive_failures: 0, unreachable_since: null }, 'an existing client starts healthy');

  // ADD COLUMN keeps the triggers (docs/database-migrations.md); prove it by writing through them.
  const maxLog = (): number => Number((raw.prepare('SELECT max(id) AS m FROM sync_log').get() as { m: unknown }).m ?? 0);
  const before = maxLog();
  raw.exec("UPDATE download_client SET consecutive_failures = 1 WHERE name = 'c'");
  assert.ok(maxLog() > before, 'an update to download_client after migration 25 still logs');
  raw.close();
});
```

Create or extend `packages/host/test/jobs/backoff.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doublingDelayMs } from '../../src/jobs/backoff.ts';

test('doublingDelayMs doubles from the base and holds at the cap', () => {
  const ladder = [1, 2, 3, 4, 5, 6, 7].map((n) => doublingDelayMs(n, 10_000, 300_000));
  assert.deepEqual(ladder, [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  assert.equal(doublingDelayMs(1, 10_000, 3_600_000), 10_000);
  assert.equal(doublingDelayMs(20, 10_000, 3_600_000), 3_600_000);
});
```

In `packages/host/test/sync/tables.test.ts`, find the assertion that lists `download_client`'s projected keys (search for `'implementation'`). Add `'consecutiveFailures'` and `'unreachableSince'` in the order the projection will emit them: after `category`, before `createdAt`.

In `packages/web/test/settings/DownloadClients.test.tsx`, give `clientOp` optional `consecutiveFailures`/`unreachableSince` parameters. When a parameter is `undefined`, **omit the key** from `value`, so the helper can build a pre-migration row. Then add:

```ts
test('a client row replicated before migration 25, with no health fields, is still listed', async () => {
  // Review Focus 1: ADD COLUMN touches no existing row, so a replica can hold
  // a download_client row with neither key until that row next changes.
  const db = await freshDb();
  await seed(db, [clientOp({ id: 1, name: 'Old row' })]); // no health keys
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);
  await waitFor(() => {
    assert.ok(screen.queryByRole('heading', { name: 'Old row' }), 'the row is not dropped');
  });
});
```

`freshDb`, `seed`, `sourceFor`, `neverSubmit` and `neverSubmitMapping` are this file's existing helpers.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/db/migrate.test.ts packages/host/test/jobs/backoff.test.ts packages/host/test/sync/tables.test.ts 2>&1 | grep -E "^not ok|✖" | head`
Expected: FAIL (the migration 25 columns are missing, `doublingDelayMs` is not exported, and the key-set is missing the new keys).

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/settings/DownloadClients.test.tsx 2>&1 | grep -E "^not ok|✖" | head`
Expected: the old-row test may already pass, because the guard does not read the new keys yet. That is fine. It is the guard for Step 7.

- [ ] **Step 3: Migration 25**

In `packages/host/src/db/migrate.ts`, after `MIGRATION_23`/`migration24`:

```ts
/**
 * Phase 2 (#93, #101): download-client health, and a per-row import backoff.
 *
 * `ADD COLUMN` only, so every sync trigger survives in place
 * (`docs/database-migrations.md`'s table).
 *
 * `download_client`'s two columns are synced: `sync/tables.ts` projects
 * them. The download tables' two are host-only; they are bookkeeping for
 * `clients/deliver.ts`, and no projection names them.
 *
 * A row replicated before this migration keeps its old shape in every
 * browser until the row next changes. `web/src/settings/useDownloadClients.ts`
 * reads a missing health field as "no failures".
 */
const MIGRATION_25 = `
ALTER TABLE download_client ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE download_client ADD COLUMN unreachable_since INTEGER;
ALTER TABLE torrent_download ADD COLUMN import_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE torrent_download ADD COLUMN import_retry_at INTEGER;
ALTER TABLE nzb_download ADD COLUMN import_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nzb_download ADD COLUMN import_retry_at INTEGER;
`;
```

Append `{ version: 25, up: (db) => db.exec(MIGRATION_25) },` to `HOST_MIGRATIONS`.

In `packages/host/src/db/schema.ts`, add each column to its Drizzle table, following the file's existing style (`integer('consecutive_failures').notNull().default(0)`, `integer('unreachable_since')`, and likewise for the other two). Give each a one-line comment pointing at migration 25.

- [ ] **Step 4: Contract fields and threshold**

In `packages/contract/src/sync.ts`, `DownloadClientSyncRead`, after `category`:

```ts
  /**
   * How many reconcile checks in a row have failed to reach this client, 0
   * when the last one succeeded. At `CLIENT_UNREACHABLE_AFTER_FAILURES` or
   * more the client is unreachable: selection passes it over when another
   * candidate is reachable, and settings says so. Written only when it
   * changes (`host/src/clients/health.ts`), so a healthy client causes no
   * sync traffic however often it is polled.
   */
  consecutiveFailures: number;
  /** When the current run of failures began, or `null` when the last check succeeded. */
  unreachableSince: number | null;
```

In the contract module that exports `AddDownloadClientRefusalCode`:

```ts
/**
 * The consecutive-failure count at which a download client is unreachable.
 * Here, in the contract, because two sides must agree on it and neither may
 * import the other: the host's `selectClientForFeed` passes such a client
 * over, and the web settings list labels it. If they disagreed, the screen
 * would call a client reachable while picks avoided it.
 */
export const CLIENT_UNREACHABLE_AFTER_FAILURES = 3;
```

Export it from `packages/contract/src/index.ts` beside that module's other value exports.

- [ ] **Step 5: Projection**

In `packages/host/src/sync/tables.ts`'s `download_client` case:

```ts
      return `SELECT id, name, type, implementation, url, username, category,
                      consecutive_failures AS consecutiveFailures,
                      unreachable_since AS unreachableSince,
                      created_at AS createdAt, updated_at AS updatedAt
                 FROM download_client WHERE id IN (${placeholders})`;
```

If `readHostRows` rebuilds `download_client` rows field by field, not by spreading, add the two fields there too, with `consecutiveFailures` read as a number. Let the tables test tell you.

- [ ] **Step 6: The delay helper**

Append to `packages/host/src/jobs/backoff.ts`:

```ts
/**
 * `baseMs` doubled once per attempt after the first, held at `capMs`:
 * attempt 1 is `baseMs`, attempt 2 is `2 × baseMs`, and so on. Shared by
 * the reconcile cycle's own backoff after a failed contact
 * (`clients/reconcile-job.ts`) and by the per-row import backoff
 * (`clients/deliver.ts`), which differ only in their base and cap.
 */
export function doublingDelayMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}
```

- [ ] **Step 7: Tolerant web read**

In `packages/web/src/settings/useDownloadClients.ts`, replace the `isDownloadClient` type guard with a reader that fills the two health fields when a pre-migration-25 row lacks them. Use it everywhere the guard was used: a `.filter(isDownloadClient)` becomes a map through it that drops `undefined`.

```ts
/**
 * A replica row as a `DownloadClientSyncRead`, or `undefined` when it is not
 * one. `consecutiveFailures` and `unreachableSince` may be missing from a row
 * replicated before host migration 25, because `ADD COLUMN` rewrites no row.
 * Such a row reads as having no failures, which is what the host holds for
 * it too (the column's default).
 */
function toDownloadClient(value: unknown): DownloadClientSyncRead | undefined {
  if (!isRecord(value)) return undefined;
  if (!(
    typeof value.id === 'number' &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    typeof value.implementation === 'string' &&
    typeof value.url === 'string' &&
    typeof value.category === 'string' &&
    (typeof value.username === 'string' || value.username === null) &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number'
  )) return undefined;
  const failures = value.consecutiveFailures;
  const since = value.unreachableSince;
  if (failures !== undefined && typeof failures !== 'number') return undefined;
  if (since !== undefined && since !== null && typeof since !== 'number') return undefined;
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    implementation: value.implementation,
    url: value.url,
    username: value.username,
    category: value.category,
    consecutiveFailures: failures ?? 0,
    unreachableSince: since ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
```

Match the old guard's exact field checks. If it checked fewer fields (for example, no `createdAt`), check the same set, so no row it used to accept is now refused. Reuse the file's existing `isRecord` or its equivalent. Keep the old guard's docblock reasoning, and fold in the paragraph above.

- [ ] **Step 8: Run the gate**

Run: `npm run check > /tmp/p2-t1.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)|error TS" /tmp/p2-t1.log | head; rm -f /tmp/p2-t1.log`
Expected: exit 0. Fix every `RssItemSyncRead`-style fixture the typecheck names for `DownloadClientSyncRead`: add `consecutiveFailures: 0, unreachableSince: null`.

- [ ] **Step 9: Commit**

```bash
git add -A packages && git commit -m "Add client health and import backoff columns, and project client health to the browser (#93, #101)"
```

---

### Task 2: A reconcile cycle that never dies, with client health

**Files:**
- Create: `packages/host/src/clients/health.ts`
- Test: `packages/host/test/clients/health.test.ts`
- Modify: `packages/host/src/clients/reconcile-job.ts` (module docblock `:1-42`, `RECONCILE_INTERVAL_S` `:63`, `createReconcileHandler` `:263-345`)
- Test: `packages/host/test/clients/reconcile-job.test.ts`

**Interfaces:**
- Consumes: the columns from Task 1, `doublingDelayMs`, and `CLIENT_UNREACHABLE_AFTER_FAILURES`.
- Produces (from `clients/health.ts`):
  - `recordContactSuccess(raw: DatabaseSync, clientId: number, at: number): void`
  - `recordContactFailure(raw: DatabaseSync, clientId: number, at: number): number` (returns the new count)
  - `reconcileRetryDelayMs(failures: number): number`
  - `isReachable(consecutiveFailures: number): boolean`

- [ ] **Step 1: Write the failing health unit test**

`packages/host/test/clients/health.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { isReachable, reconcileRetryDelayMs, recordContactFailure, recordContactSuccess } from '../../src/clients/health.ts';

function setup(): { raw: DatabaseSync; clientId: number } {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec(`INSERT INTO download_client (name, type, implementation, url, category, import_mode, created_at, updated_at)
            VALUES ('c', 'torrent', 'qbittorrent', 'https://c.example', 'movies', 'copy', 1, 1)`);
  return { raw, clientId: 1 };
}

function health(raw: DatabaseSync): Record<string, unknown> {
  return { ...raw.prepare('SELECT consecutive_failures, unreachable_since, updated_at FROM download_client WHERE id = 1').get() };
}

test('a failure counts up and stamps the start of the streak once', () => {
  const { raw, clientId } = setup();
  assert.equal(recordContactFailure(raw, clientId, 100), 1);
  assert.equal(recordContactFailure(raw, clientId, 200), 2);
  assert.deepEqual(health(raw), { consecutive_failures: 2, unreachable_since: 100, updated_at: 200 });
});

test('a success ends a streak, and a success with no streak writes nothing', () => {
  const { raw, clientId } = setup();
  recordContactSuccess(raw, clientId, 50);
  assert.deepEqual(health(raw), { consecutive_failures: 0, unreachable_since: null, updated_at: 1 }, 'healthy: no write at all');

  recordContactFailure(raw, clientId, 100);
  recordContactSuccess(raw, clientId, 300);
  assert.deepEqual(health(raw), { consecutive_failures: 0, unreachable_since: null, updated_at: 300 });
});

test('a healthy client polled repeatedly adds nothing to the sync log', () => {
  const { raw, clientId } = setup();
  const maxLog = (): number => Number((raw.prepare('SELECT max(id) AS m FROM sync_log').get() as { m: unknown }).m ?? 0);
  const before = maxLog();
  for (let at = 10; at <= 100; at += 10) recordContactSuccess(raw, clientId, at);
  assert.equal(maxLog(), before);
});

test('the retry ladder and the reachability threshold', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(reconcileRetryDelayMs), [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  assert.equal(isReachable(2), true);
  assert.equal(isReachable(3), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/host/test/clients/health.test.ts`
Expected: FAIL (`health.ts` not found).

- [ ] **Step 3: Write `health.ts`**

```ts
/**
 * A download client's health, as the reconcile cycle observes it (#93).
 *
 * **One writer.** Only `clients/reconcile-job.ts` calls these, once per
 * tick, and only on the outcome of contacting the client: reading its
 * config, building its adapter and taking its snapshot. A local fault after
 * a good snapshot says nothing about the client and is never recorded here.
 *
 * **Written only when it changes.** `download_client` is synced. A write on
 * every successful poll, every 10 seconds, would send an update to every
 * open browser forever. A success writes only when it ends a streak of
 * failures; a failure writes each time, and failures arrive at the
 * backed-off pace `reconcileRetryDelayMs` sets.
 */
import type { DatabaseSync } from 'node:sqlite';
import { CLIENT_UNREACHABLE_AFTER_FAILURES } from '@pickarr/contract';
import { doublingDelayMs } from '../jobs/backoff.ts';

/** The first retry after a failed contact, doubled per further failure. The same as the healthy interval, so one blip costs nothing extra. */
const CONTACT_RETRY_BASE_MS = 10_000;
/** The longest a failing client waits between checks. */
const CONTACT_RETRY_CAP_MS = 300_000;

export function recordContactSuccess(raw: DatabaseSync, clientId: number, at: number): void {
  raw.prepare(`
    UPDATE download_client SET consecutive_failures = 0, unreachable_since = NULL, updated_at = ?
     WHERE id = ? AND consecutive_failures > 0
  `).run(at, clientId);
}

/** Records one failed contact and answers the new consecutive-failure count (0 if the client row is gone). */
export function recordContactFailure(raw: DatabaseSync, clientId: number, at: number): number {
  raw.prepare(`
    UPDATE download_client
       SET consecutive_failures = consecutive_failures + 1,
           unreachable_since = coalesce(unreachable_since, ?),
           updated_at = ?
     WHERE id = ?
  `).run(at, at, clientId);
  const row = raw.prepare('SELECT consecutive_failures FROM download_client WHERE id = ?').get(clientId);
  const failures = row === undefined ? undefined : row['consecutive_failures'];
  return typeof failures === 'number' ? failures : 0;
}

/** How long to wait before contacting a client again after its `failures`th consecutive failure. */
export function reconcileRetryDelayMs(failures: number): number {
  return doublingDelayMs(failures, CONTACT_RETRY_BASE_MS, CONTACT_RETRY_CAP_MS);
}

export function isReachable(consecutiveFailures: number): boolean {
  return consecutiveFailures < CLIENT_UNREACHABLE_AFTER_FAILURES;
}
```

- [ ] **Step 4: Run the health test**

Run: `node --import tsx --conditions development --test packages/host/test/clients/health.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tick tests**

In `packages/host/test/clients/reconcile-job.test.ts`, **replace** the test `'a tick whose snapshot throws does not re-enqueue, and lets the dispatcher retry the same row'`: the behaviour it pins is the defect. Then add the following tests. `unreachableFetch` is this file's existing throwing `QueuedFetch` from the replaced test; lift it to module scope.

```ts
const unreachableFetch: QueuedFetch = {
  json: async () => { throw new Error('qbittorrent unreachable'); },
  bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  text: async () => { throw new Error('fetch.text: not used by this test'); },
};

function clientHealth(raw: DatabaseSync, clientId: number): { failures: number; since: unknown } {
  const row = raw.prepare('SELECT consecutive_failures, unreachable_since FROM download_client WHERE id = ?').get(clientId);
  return { failures: Number(row?.['consecutive_failures']), since: row?.['unreachable_since'] };
}

test('a client that cannot be reached is rescheduled with a doubling delay, never dead-lettered', async () => {
  // Review Focus 5. Before this, five failed attempts (about 15s) dead-lettered
  // the cycle and nothing re-enqueued it until a restart.
  const clock = createClock(1000);
  const { raw, host, setTimeoutCalls } = setup({ fetch: unreachableFetch, now: clock.now });
  const clientId = insertClient(raw, { type: 'torrent', implementation: 'qbittorrent' });
  await host.scheduleReconcile(clientId, 1000);
  host.start();

  const expected = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000];
  for (const [index, delay] of expected.entries()) {
    const due = reconcileJobRows(raw).find((r) => r.clientId === clientId && r.state === 'ready');
    assert.ok(due, `a job is pending before failure ${index + 1}`);
    clock.set(due.runAt);
    // eslint-disable-next-line no-await-in-loop -- each tick depends on the previous one's reschedule
    await runDue(host, setTimeoutCalls);
    const ready = reconcileJobRows(raw).filter((r) => r.clientId === clientId && r.state === 'ready');
    assert.equal(ready.length, 1, `exactly one pending job after failure ${index + 1}`);
    assert.equal(ready[0]?.runAt, due.runAt + delay, `failure ${index + 1} waits ${delay}ms`);
    assert.equal(clientHealth(raw, clientId).failures, index + 1);
  }
  assert.ok(reconcileJobRows(raw).every((r) => r.state !== 'dead'), 'no reconcile job ever dead-letters');
  assert.equal(clientHealth(raw, clientId).since, 1000, 'the streak began at the first failure');
});

test('the first good snapshot after failures resets health and returns to the 10s cadence', async () => {
  const clock = createClock(1000);
  let reachable = false;
  const good = sabnzbdFetch({ queueSlots: [] });
  const fetch: QueuedFetch = {
    json: async (url, init) => (reachable ? good.json(url, init) : unreachableFetch.json(url, init)),
    bytes: good.bytes,
    text: good.text,
  };
  const { raw, host, setTimeoutCalls } = setup({ fetch, now: clock.now });
  const clientId = insertClient(raw);
  await host.scheduleReconcile(clientId, 1000);
  host.start();
  await runDue(host, setTimeoutCalls);
  assert.equal(clientHealth(raw, clientId).failures, 1);

  reachable = true;
  const due = reconcileJobRows(raw).find((r) => r.clientId === clientId && r.state === 'ready');
  assert.ok(due);
  clock.set(due.runAt);
  await runDue(host, setTimeoutCalls);
  assert.deepEqual(clientHealth(raw, clientId), { failures: 0, since: null });
  const ready = reconcileJobRows(raw).filter((r) => r.clientId === clientId && r.state === 'ready');
  assert.equal(ready[0]?.runAt, due.runAt + RECONCILE_INTERVAL_S * 1000);
  assert.equal(RECONCILE_INTERVAL_S, 10);
});

test('a client whose secret no longer resolves counts as unreachable, and its cycle survives', async () => {
  // Review Focus 4: readClientConfig throws before any network call.
  const { raw, host, setTimeoutCalls } = setup({ fetch: sabnzbdFetch({ queueSlots: [] }) });
  const clientId = insertClient(raw);
  raw.prepare("UPDATE download_client SET api_key_secret_name = 'no-such-secret' WHERE id = ?").run(clientId);
  await host.scheduleReconcile(clientId, 1000);
  host.start();
  await runDue(host, setTimeoutCalls);
  assert.equal(clientHealth(raw, clientId).failures, 1);
  assert.equal(reconcileJobRows(raw).filter((r) => r.clientId === clientId && r.state === 'ready').length, 1);
});

test('a client deleted while failing ends its cycle', async () => {
  // Review Focus 2.
  const clock = createClock(1000);
  const { raw, host, setTimeoutCalls } = setup({ fetch: unreachableFetch, now: clock.now });
  const clientId = insertClient(raw, { type: 'torrent', implementation: 'qbittorrent' });
  await host.scheduleReconcile(clientId, 1000);
  host.start();
  await runDue(host, setTimeoutCalls);
  raw.prepare('DELETE FROM download_client WHERE id = ?').run(clientId);
  const due = reconcileJobRows(raw).find((r) => r.clientId === clientId && r.state === 'ready');
  assert.ok(due);
  clock.set(due.runAt);
  await runDue(host, setTimeoutCalls);
  assert.equal(reconcileJobRows(raw).filter((r) => r.clientId === clientId && r.state === 'ready').length, 0);
});
```

Check two things before running:
- **`sabnzbdFetch`'s return shape.** The second test assumes it returns a full `QueuedFetch`. If it doesn't, adapt it to however the file builds one.
- **The secret test.** It needs `readClientConfig` to throw for an unresolvable secret name. Read `makeSecrets` and `CLIENT_API_KEY_SECRET` to confirm, and adjust the test if the secret isn't read that way.

Also add a test that a local fault after a good snapshot reschedules at 10s and leaves health alone. Force the fault the way this file's delivery tests reach `deliverCompleted`: make `deps.deliver` throw from `setup`'s `createHost` options, if `setup` exposes it. Otherwise seed a `completed` row whose `rss_item` has no owning feed, so `ownerPluginId` is exercised. If neither path can make the tick throw after the snapshot, write the test against `createReconcileHandler` directly, with a `raw` whose `download_client` update trigger raises `ABORT` (the fault-injection technique in `CLAUDE.md`). Assert:
- health `failures` stays 0;
- the next run is at `+10_000`;
- the job's state is `done`, not `ready` with `attempts` > 0.

- [ ] **Step 6: Run the tick tests and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/clients/reconcile-job.test.ts 2>&1 | grep -E "^not ok|✖" | head`
Expected: FAIL. The delays are the dispatcher's 1s/2s…, health stays 0, and `RECONCILE_INTERVAL_S` is 60.

- [ ] **Step 7: The never-dead handler**

In `packages/host/src/clients/reconcile-job.ts`:
- `export const RECONCILE_INTERVAL_S = 10;` (update its one-line doc if needed).
- Import `recordContactFailure`, `recordContactSuccess` and `reconcileRetryDelayMs` from `./health.ts`, and `redactText` from `./redact.ts` (confirm the export name).
- Replace the handler body after the `clientRowExists` check:

```ts
    const outcome = await runTick(deps, clientId);
    const delayMs = outcome.kind === 'unreachable'
      ? reconcileRetryDelayMs(outcome.failures)
      : RECONCILE_INTERVAL_S * 1000;
    // The only reschedule, and every outcome reaches it: see the module doc.
    await scheduleReconcile(deps.raw, ctx.jobs, clientId, deps.now() + delayMs, job.id, deps.log);
```

and add, above `createReconcileHandler`:

```ts
type TickOutcome = { kind: 'ok' } | { kind: 'unreachable'; failures: number } | { kind: 'fault' };

/**
 * One tick, never throwing. Contacting the client (its config, its adapter,
 * its snapshot) is one phase, and a failure there is the client's: it is
 * recorded against its health and answered `unreachable`. Everything after a
 * good snapshot is this host's own work, and a fault there is logged and
 * answered `fault`, leaving health alone.
 */
async function runTick(deps: ReconcileHandlerDeps, clientId: number): Promise<TickOutcome> {
  let config: Awaited<ReturnType<typeof readClientConfig>>;
  let adapter: ReturnType<typeof buildReconcileAdapter>;
  let snapshot: ClientSnapshot;
  try {
    config = await readClientConfig(deps.raw, clientId, deps.secrets);
    adapter = buildReconcileAdapter(config, deps.fetch);
    snapshot = await adapter.snapshot();
  } catch (error) {
    const failures = recordContactFailure(deps.raw, clientId, deps.now());
    deps.log('could not reach the download client, will try again', {
      clientId,
      failures,
      error: error instanceof Error ? redactText(error.message) : String(error),
    });
    return { kind: 'unreachable', failures };
  }
  recordContactSuccess(deps.raw, clientId, deps.now());

  try {
    // …the existing body, unchanged: the unreadable log, walkSnapshot, deliverDeps, deliverCompleted, logTickSummary…
    return { kind: 'ok' };
  } catch (error) {
    deps.log('a reconcile tick failed after a good snapshot, will try again', {
      clientId,
      error: error instanceof Error ? redactText(error.message) : String(error),
    });
    return { kind: 'fault' };
  }
}
```

The `…existing body…` line means **move** the current code from `if (snapshot.unreadable.length > 0)` through `logTickSummary(...)` into that `try`, verbatim. Name the deps parameter type by extracting `createReconcileHandler`'s inline parameter type into `interface ReconcileHandlerDeps` (the same fields, docblocks kept). Import `ClientSnapshot` if it isn't already.

Rewrite the module docblock's "Rescheduling happens only after the whole tick resolves, never around a throw" paragraph. The new text must say that the tick never throws, so the dispatcher never retries a reconcile job, and that there is exactly one reschedule per run. The double-cycle hazard it described is therefore still avoided, and `scheduleReconcile`'s guard still defends against a crash re-run. Keep the other paragraphs.

- [ ] **Step 8: Run the tests**

Run: `node --import tsx --conditions development --test packages/host/test/clients/reconcile-job.test.ts packages/host/test/clients/health.test.ts`
Expected: PASS. Other tests in the file that assert `runAt` must now expect `+ RECONCILE_INTERVAL_S * 1000`, which reads the constant, so they keep passing. Any test that hardcodes 60 000 must change to the constant.

- [ ] **Step 9: Gate and commit**

Run: `npm run check > /tmp/p2-t2.log 2>&1; echo "exit $?"; rm -f /tmp/p2-t2.log`
Expected: exit 0.

```bash
git add -A packages && git commit -m "Poll download clients every 10s on a cycle that never dead-letters, and record each client's health (#93)"
```

---

### Task 3: Settle submissions the client never confirmed (#95)

**Files:**
- Modify: `packages/host/src/clients/rows.ts` (new `failUnconfirmed`)
- Modify: `packages/host/src/clients/reconcile.ts` (`ReconcileResult` `:48-89`, `walkSnapshot` `:563-581` and its docblock)
- Modify: `packages/host/src/clients/reconcile-job.ts` (`logTickSummary`, only if it lists counters by hand)
- Test: `packages/host/test/clients/rows.test.ts`, `packages/host/test/clients/reconcile.test.ts`, `packages/host/test/clients/reconcile-job.test.ts`

**Interfaces:**
- Produces:
  - `export const UNCONFIRMED_AFTER_MS = 600_000;`
  - `export const UNCONFIRMED_MESSAGE = 'the client never confirmed this submission';`
  - `export function failUnconfirmed(raw: DatabaseSync, clientId: number, createdBefore: number, at: number): number` (returns the rows failed, across both tables). All three live in `clients/rows.ts`.
  - `ReconcileResult.unconfirmed: number`.

- [ ] **Step 1: Write the failing tests**

In `packages/host/test/clients/rows.test.ts`, add a local helper that inserts with an explicit `created_at`. The file's `insertTorrentRow` hardcodes it to `1`, so either extend that helper with an optional `createdAt` or add an `UPDATE`:

```ts
test('failUnconfirmed fails only this client\'s submitting rows older than the bound, in both tables', () => {
  const raw = setup();
  const mine = seedClient(raw, { name: 'mine' });
  const other = seedClient(raw, { name: 'other' });
  const at = (id: number, table: 'torrent_download' | 'nzb_download', createdAt: number): number => {
    raw.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`).run(createdAt, id);
    return id;
  };
  const old = at(insertTorrentRow(raw, { rssItemId: seedRssItem(raw, 'a'), downloadClientId: mine }), 'torrent_download', 100);
  const fresh = at(insertTorrentRow(raw, { rssItemId: seedRssItem(raw, 'b'), downloadClientId: mine }), 'torrent_download', 900);
  const oldNzb = at(insertNzbRow(raw, { rssItemId: seedRssItem(raw, 'c'), downloadClientId: mine }), 'nzb_download', 100);
  const submitted = at(insertTorrentRow(raw, { rssItemId: seedRssItem(raw, 'd'), downloadClientId: mine, status: 'submitted' }), 'torrent_download', 100);
  const others = at(insertTorrentRow(raw, { rssItemId: seedRssItem(raw, 'e'), downloadClientId: other }), 'torrent_download', 100);

  assert.equal(failUnconfirmed(raw, mine, 500, 1000), 2);
  assert.equal(readColumn(raw, 'torrent_download', old, 'status'), 'failed');
  assert.equal(readColumn(raw, 'torrent_download', old, 'last_error'), UNCONFIRMED_MESSAGE);
  assert.equal(readColumn(raw, 'torrent_download', old, 'updated_at'), 1000);
  assert.equal(readColumn(raw, 'nzb_download', oldNzb, 'status'), 'failed');
  assert.equal(readColumn(raw, 'torrent_download', fresh, 'status'), 'submitting', 'younger than the bound');
  assert.equal(readColumn(raw, 'torrent_download', submitted, 'status'), 'submitted', 'only submitting rows');
  assert.equal(readColumn(raw, 'torrent_download', others, 'status'), 'submitting', 'another client\'s row');
});
```

In `packages/host/test/clients/reconcile.test.ts` (using its `setup`, `seedClient`, `seedRssItem`, `insertTorrentRow`, `queueEntry`, `deps` and `readColumn`):

```ts
test('walkSnapshot settles a submitting row the client never confirmed, after recovery has had its chance', () => {
  const raw = setup();
  const clientId = seedClient(raw);
  const now = 10_000_000;
  const stale = insertTorrentRow(raw, { rssItemId: seedRssItem(raw, 'never'), downloadClientId: clientId });
  const recoverable = insertTorrentRow(raw, { rssItemId: seedRssItem(raw, 'found'), downloadClientId: clientId });
  const young = insertTorrentRow(raw, { rssItemId: seedRssItem(raw, 'young'), downloadClientId: clientId });
  for (const id of [stale, recoverable]) raw.prepare('UPDATE torrent_download SET created_at = ? WHERE id = ?').run(now - 660_000, id);
  raw.prepare('UPDATE torrent_download SET created_at = ? WHERE id = ?').run(now - 540_000, young);

  // `found.mkv` is in the client's queue under our category, so recovery attaches its ref first.
  const result = walkSnapshot(deps(raw, clientId, {
    now,
    snapshot: { complete: true, queue: [queueEntry({ ref: 'ref-found', name: 'found.mkv' })], history: [], unreadable: [] },
  }));

  assert.equal(readColumn(raw, 'torrent_download', stale, 'status'), 'failed');
  assert.notEqual(readColumn(raw, 'torrent_download', recoverable, 'status'), 'failed', 'recovered in the same tick, not failed');
  assert.equal(readColumn(raw, 'torrent_download', young, 'status'), 'submitting', 'nine minutes old: left alone');
  assert.equal(result.unconfirmed, 1);
});
```

Adjust the `queueEntry`/`deps` fields to what the file's helpers actually take: `category` must match `deps`' category, and the name must match `seedRssItem`'s filename. Read one existing `recoverRefs` test in the file and copy its shape.

In `packages/host/test/clients/reconcile-job.test.ts`:

```ts
test('an unreachable client never has its submitting rows settled', async () => {
  // Review Focus 3: without the client's own list, "never arrived" and
  // "arrived, not yet seen" look the same.
  const clock = createClock(10_000_000);
  const { raw, host, setTimeoutCalls } = setup({ fetch: unreachableFetch, now: clock.now });
  const clientId = insertClient(raw, { type: 'torrent', implementation: 'qbittorrent' });
  const rssItemId = seedRssItem(raw, 'x');
  raw.prepare(`INSERT INTO torrent_download (rss_item_id, download_client_id, status, created_at, updated_at)
               VALUES (?, ?, 'submitting', 1, 1)`).run(rssItemId, clientId);
  await host.scheduleReconcile(clientId, 10_000_000);
  host.start();
  await runDue(host, setTimeoutCalls);
  const status = raw.prepare('SELECT status FROM torrent_download WHERE rss_item_id = ?').get(rssItemId);
  assert.equal(status?.['status'], 'submitting');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/clients/rows.test.ts packages/host/test/clients/reconcile.test.ts packages/host/test/clients/reconcile-job.test.ts 2>&1 | grep -E "^not ok|✖" | head`
Expected: FAIL (`failUnconfirmed` is not exported, and `unconfirmed` is undefined). The unreachable-client test may already pass, because nothing settles rows yet. It is the guard against Step 3 putting the call in the wrong place.

- [ ] **Step 3: Implement**

In `packages/host/src/clients/rows.ts`:

```ts
/** How long a pick may stay `submitting` before a successful snapshot settles it (#95). Long past the 30-second fetch timeout any submission is bounded by. */
export const UNCONFIRMED_AFTER_MS = 600_000;
export const UNCONFIRMED_MESSAGE = 'the client never confirmed this submission';

/**
 * Fails every `submitting` row on `clientId` created before `createdBefore`,
 * in both download tables, and answers how many. One statement per table,
 * guarded on `status = 'submitting'` in the statement itself, so a row that
 * something else settled first is left alone. Keyed on `created_at`, the
 * moment the pick was written; `updated_at` moves when `setRef` attaches a
 * ref to a row that is still `submitting`.
 *
 * Called only by `reconcile.ts`'s `walkSnapshot`, after its ref recovery
 * and only on a successful snapshot. See there.
 */
export function failUnconfirmed(raw: DatabaseSync, clientId: number, createdBefore: number, at: number): number {
  let failed = 0;
  for (const table of ['torrent_download', 'nzb_download'] as const) {
    failed += Number(raw.prepare(`
      UPDATE ${table} SET status = 'failed', last_error = ?, updated_at = ?
       WHERE download_client_id = ? AND status = 'submitting' AND created_at < ?
    `).run(UNCONFIRMED_MESSAGE, at, clientId, createdBefore).changes);
  }
  return failed;
}
```

In `packages/host/src/clients/reconcile.ts`:
- Add `unconfirmed: number;` to `ReconcileResult`, with a docblock saying it counts `submitting` rows failed because the client never confirmed them within `UNCONFIRMED_AFTER_MS` (#95).
- Initialise `unconfirmed: 0` in `walkSnapshot`.
- After `sweepAbsent(deps, result);`, add:

```ts
  // Last, after recovery has attached every ref the client's own list can
  // supply and the walk has advanced every row it can identify. A row still
  // `submitting` this long after its pick was never going to be confirmed,
  // and until it is settled migration 18's unique index refuses a re-pick
  // (#95). Reached only with a good snapshot: `walkSnapshot` is never called
  // for a client that could not be contacted.
  result.unconfirmed = failUnconfirmed(deps.raw, deps.clientId, deps.now - UNCONFIRMED_AFTER_MS, deps.now);
```

Extend `walkSnapshot`'s docblock with one sentence on the settle step's position.

If `logTickSummary` names counters by hand rather than iterating the object, add `unconfirmed`.

- [ ] **Step 4: Run the tests, gate, commit**

Run: `node --import tsx --conditions development --test packages/host/test/clients/rows.test.ts packages/host/test/clients/reconcile.test.ts packages/host/test/clients/reconcile-job.test.ts` — Expected: PASS. Fix any test that deep-equals a whole `ReconcileResult` by adding `unconfirmed: 0`.

Run: `npm run check > /tmp/p2-t3.log 2>&1; echo "exit $?"; rm -f /tmp/p2-t3.log` — Expected: exit 0.

```bash
git add -A packages && git commit -m "Fail a pick the client never confirmed once it is ten minutes old, so its release can be picked again (#95)"
```

---

### Task 4: Back off refused imports, and clear the wait when a destination is saved (#101)

**Files:**
- Modify: `packages/host/src/clients/rows.ts` (`DownloadRow` `:61-80`, `SELECT_COLUMNS` `:99-101`, `toRow` `:111+`; new `recordImportRefusal` and `clearImportWait`)
- Modify: `packages/host/src/clients/deliver.ts` (`DeliverResult` `:131-160`, `deliverOne`'s generic catch, `deliverCompleted`'s filter `:319+`)
- Modify: `packages/host/src/media/destinations.ts` (`saveDestination`'s success path)
- Test: `packages/host/test/clients/deliver.test.ts`, `packages/host/test/media/destinations.test.ts`, `packages/host/test/clients/rows.test.ts`

**Interfaces:**
- Consumes: `doublingDelayMs` (Task 1) and the `import_*` columns.
- Produces:
  - `DownloadRow.importFailures: number` and `DownloadRow.importRetryAt: number | null`
  - `export function recordImportRefusal(raw: DatabaseSync, row: DownloadRow, at: number): void`
  - `export function clearImportWait(raw: DatabaseSync, pluginId: string): void`
  - `export function importRetryDelayMs(failures: number): number`
  - `DeliverResult.refused: number`

- [ ] **Step 1: Write the failing tests**

In `packages/host/test/clients/rows.test.ts`:

```ts
test('importRetryDelayMs doubles from 10s to a one-hour cap', () => {
  assert.deepEqual([1, 2, 3].map(importRetryDelayMs), [10_000, 20_000, 40_000]);
  assert.equal(importRetryDelayMs(20), 3_600_000);
});

test('clearImportWait clears one plugin\'s waiting completed rows and keeps their failure count', () => {
  const raw = setup();
  const clientId = seedClient(raw);
  const alpha = insertTorrentRow(raw, { rssItemId: seedRssItem(raw, 'a'), downloadClientId: clientId, status: 'completed' });
  raw.prepare('UPDATE torrent_download SET import_failures = 3, import_retry_at = 999 WHERE id = ?').run(alpha);
  // A second plugin's feed, seeded directly: this file's seedRssItem always uses plugin 'alpha'.
  raw.exec("INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('beta', 'b-feed', 'https://example.test/b', 1, 1)");
  const betaFeed = Number((raw.prepare("SELECT id FROM rss_feed WHERE name = 'b-feed'").get() as { id: unknown }).id);
  const betaItem = Number(raw.prepare(`INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, lookup_state)
    VALUES (?, 'b.mkv', 'https://example.test/b.mkv', 1, 1, 'torrent', 'resolved')`).run(betaFeed).lastInsertRowid);
  const beta = insertTorrentRow(raw, { rssItemId: betaItem, downloadClientId: clientId, status: 'completed' });
  raw.prepare('UPDATE torrent_download SET import_failures = 2, import_retry_at = 999 WHERE id = ?').run(beta);

  clearImportWait(raw, 'alpha');
  assert.equal(readColumn(raw, 'torrent_download', alpha, 'import_retry_at'), null);
  assert.equal(readColumn(raw, 'torrent_download', alpha, 'import_failures'), 3, 'the count is kept');
  assert.equal(readColumn(raw, 'torrent_download', beta, 'import_retry_at'), 999, 'another plugin\'s row waits on');
});
```

In `packages/host/test/clients/deliver.test.ts`, using its `setup`, `seedClient`, `seedRssItem`, `insertTorrentRow`, `readColumn` and `baseDeps` (read `baseDeps` first to see how `deliver` and `now` are passed):

```ts
test('a refused import is counted, and waits on a doubling ladder before it is tried again', async () => {
  const raw = setup();
  const clientId = seedClient(raw);
  const rowId = insertTorrentRow(raw, { rssItemId: seedRssItem(raw, 'x'), downloadClientId: clientId, status: 'completed', storagePath: '/downloads/x.mkv' });
  let calls = 0;
  const refuse = async (): Promise<void> => { calls += 1; throw new Error('alpha: this download was not imported (destination-exists)'); };

  const first = await deliverCompleted(baseDeps(raw, clientId, { now: 1_000, deliver: refuse }));
  assert.equal(first.refused, 1);
  assert.equal(readColumn(raw, rowId, 'import_failures'), 1);
  assert.equal(readColumn(raw, rowId, 'import_retry_at'), 11_000);
  assert.equal(readColumn(raw, rowId, 'status'), 'completed', 'never terminal');

  const early = await deliverCompleted(baseDeps(raw, clientId, { now: 10_999, deliver: refuse }));
  assert.equal(early.refused, 0, 'not yet due: not attempted');
  assert.equal(calls, 1);

  const second = await deliverCompleted(baseDeps(raw, clientId, { now: 11_000, deliver: refuse }));
  assert.equal(second.refused, 1);
  assert.equal(readColumn(raw, rowId, 'import_retry_at'), 11_000 + 20_000);
});
```

Adapt `insertTorrentRow`'s parameter for the storage path, and `baseDeps`' override shape, to what the file actually provides. The existing tests already deliver `completed` rows with a path, so copy how they do it, including whatever `stat` stub makes the path exist.

In `packages/host/test/media/destinations.test.ts` (using its `setup` harness):

```ts
/** A completed torrent download on a `tv` feed, waiting out an import backoff. Returns its id. */
function seedWaitingImport(raw: DatabaseSync): number {
  raw.exec(`INSERT INTO download_client (name, type, implementation, url, category, import_mode, created_at, updated_at)
            VALUES ('c', 'torrent', 'qbittorrent', 'https://c.example', 'tv', 'copy', 1, 1)`);
  raw.exec("INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('tv', 'f', 'https://example.test/f', 1, 1)");
  const itemId = Number(raw.prepare(`INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, lookup_state)
    VALUES (1, 'x.mkv', 'https://example.test/x.mkv', 1, 1, 'torrent', 'resolved')`).run().lastInsertRowid);
  return Number(raw.prepare(`INSERT INTO torrent_download
      (rss_item_id, download_client_id, status, import_failures, import_retry_at, created_at, updated_at)
    VALUES (?, 1, 'completed', 4, 999999, 1, 1)`).run(itemId).lastInsertRowid);
}

function waitOf(raw: DatabaseSync, id: number): Record<string, unknown> {
  return { ...raw.prepare('SELECT import_failures, import_retry_at FROM torrent_download WHERE id = ?').get(id) };
}

test('saving a destination clears that plugin\'s waiting imports, so a fixed shape is tried on the next tick', () => {
  const harness = setup();
  const rowId = seedWaitingImport(harness.raw);
  const result = harness.save('tv', {});
  assert.ok('id' in result, 'the save itself succeeds');
  assert.deepEqual(waitOf(harness.raw, rowId), { import_failures: 4, import_retry_at: null });
});

test('a refused save leaves the waiting imports alone', () => {
  const harness = setup();
  const rowId = seedWaitingImport(harness.raw);
  const result = harness.save('tv', { shape: '{nope}.{ext}' });
  assert.ok('refusal' in result);
  assert.deepEqual(waitOf(harness.raw, rowId), { import_failures: 4, import_retry_at: 999999 });
});

test('saving one plugin\'s destination leaves another plugin\'s waiting imports alone', () => {
  const harness = setup();
  const rowId = seedWaitingImport(harness.raw);
  const result = harness.save('movie', {});
  assert.ok('id' in result);
  assert.deepEqual(waitOf(harness.raw, rowId), { import_failures: 4, import_retry_at: 999999 });
});
```

`setup()` is this file's harness: `save(pluginId, input)` fills `root: '/library'`, `shape: '{title}.{ext}'` and `unmatchedDir: undefined` by default. If `'{nope}.{ext}'` is not refused as `unknown-token` by this file's other tests' standards, use whichever unknown-token shape they use.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/clients/rows.test.ts packages/host/test/clients/deliver.test.ts packages/host/test/media/destinations.test.ts 2>&1 | grep -E "^not ok|✖" | head`
Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/host/src/clients/rows.ts`:
- Add `importFailures: number;` and `importRetryAt: number | null;` to `DownloadRow`, each with a one-line doc (see `clients/deliver.ts`'s backoff).
- Append `, import_failures, import_retry_at` to `SELECT_COLUMNS`.
- In `toRow`, read them in the file's existing style: `importFailures: Number(... ?? 0)`, and `importRetryAt` null-or-`Number`.
- Add:

```ts
/** The first wait after a refused import, doubled per further refusal. */
const IMPORT_RETRY_BASE_MS = 10_000;
/** The longest a refused import waits: an operator's fix is still picked up within the hour. */
const IMPORT_RETRY_CAP_MS = 3_600_000;

export function importRetryDelayMs(failures: number): number {
  return doublingDelayMs(failures, IMPORT_RETRY_BASE_MS, IMPORT_RETRY_CAP_MS);
}

/**
 * Records one refused import on `row`: one more failure, and no retry until
 * the backoff has passed (#101). Guarded on `status = 'completed'` like every
 * other writer here. `updated_at` is not moved: this is the host's own
 * bookkeeping, not a change to the download, and a client reading the row
 * would see nothing different.
 */
export function recordImportRefusal(raw: DatabaseSync, row: DownloadRow, at: number): void {
  const failures = row.importFailures + 1;
  raw.prepare(`UPDATE ${row.table} SET import_failures = ?, import_retry_at = ? WHERE id = ? AND status = 'completed'`)
    .run(failures, at + importRetryDelayMs(failures), row.id);
}

/**
 * Lets every `completed` row owned by `pluginId` be tried on the next tick,
 * by clearing its wait. Called when that plugin's destination is saved,
 * because a new destination or shape is the operator's likely fix for a
 * refused import. `import_failures` is kept, so a row refused again resumes
 * its ladder where it was.
 */
export function clearImportWait(raw: DatabaseSync, pluginId: string): void {
  for (const table of ['torrent_download', 'nzb_download'] as const) {
    raw.prepare(`
      UPDATE ${table} SET import_retry_at = NULL
       WHERE status = 'completed' AND import_retry_at IS NOT NULL
         AND rss_item_id IN (SELECT rss_item.id FROM rss_item JOIN rss_feed ON rss_feed.id = rss_item.feed_id
                              WHERE rss_feed.plugin_id = ?)
    `).run(pluginId);
  }
}
```

Import `doublingDelayMs` from `../jobs/backoff.ts`. If `scripts/check-test-hygiene.ts` rejects the `${table}` template, as it did for a similar statement in the #98 branch, split the loop into two literal statements.

`packages/host/src/clients/deliver.ts`:
- `DeliverResult` gains the following, and the initialiser gets `refused: 0`:

```ts
  /**
   * Imports refused (or thrown) this pass. Each such row stays `completed`
   * and waits `importRetryDelayMs` before it is tried again (#101). Counted
   * so a pass that lands nothing while imports are stuck does not look
   * identical to a quiet one.
   */
  refused: number;
```
- In `deliverOne`'s generic catch (the branch after `PluginNotRegisteredError`), before the log: `result.refused += 1; recordImportRefusal(deps.raw, row, deps.now);`. Add a sentence to the comment there saying the row now waits and is not retried every tick.
- In `deliverCompleted`'s filter, add `&& (row.importRetryAt === null || row.importRetryAt <= deps.now)`, and extend the comment above it by one sentence: a row inside its backoff is not attempted.
- The `stat`-missing path is inside the same `try`, so it backs off too. Say so in the catch's comment.

`packages/host/src/media/destinations.ts`: immediately before `saveDestination`'s successful `return { id … }`, call `clearImportWait(deps.raw, pluginId);`, with a two-line comment pointing at `clearImportWait`'s doc. Import it from `../clients/rows.ts`.

- [ ] **Step 4: Run the tests, gate, commit**

Run: `node --import tsx --conditions development --test packages/host/test/clients/rows.test.ts packages/host/test/clients/deliver.test.ts packages/host/test/media/destinations.test.ts packages/host/test/clients/reconcile-job.test.ts` — Expected: PASS. Fix every test that deep-equals a whole `DeliverResult` (add `refused: 0`) or builds a `DownloadRow` literal (add `importFailures: 0, importRetryAt: null`).

Run: `npm run check > /tmp/p2-t4.log 2>&1; echo "exit $?"; rm -f /tmp/p2-t4.log` — Expected: exit 0.

```bash
git add -A packages && git commit -m "Back off a refused import instead of retrying it every tick, count it, and clear the wait when its destination is saved (#101)"
```

---

### Task 5: Prefer a reachable client (#93)

**Files:**
- Modify: `packages/host/src/clients/select.ts` (`readCandidateClientIds` `:56-60` and the multi-candidate branch `:150-165`, plus the `#93` comment at `:167-173`)
- Test: `packages/host/test/clients/select.test.ts`

**Interfaces:**
- Consumes: `isReachable` from `./health.ts` (Task 2).

- [ ] **Step 1: Write the failing tests**

In `packages/host/test/clients/select.test.ts` (using its `setup`, `seedClient`, `seedFeed` and `refuseToChoose`):

```ts
function markFailures(raw: DatabaseSync, clientId: number, failures: number): void {
  raw.prepare('UPDATE download_client SET consecutive_failures = ? WHERE id = ?').run(failures, clientId);
}

test('an unreachable candidate is passed over when another is reachable', () => {
  const raw = setup();
  const dead = seedClient(raw, { name: 'dead' });
  const alive = seedClient(raw, { name: 'alive' });
  markFailures(raw, dead, 3);
  const feedId = seedFeed(raw);
  assert.equal(selectClientForFeed(raw, feedId, refuseToChoose), alive, 'one reachable candidate: no draw at all');
});

test('the draw is among the reachable candidates only', () => {
  const raw = setup();
  const a = seedClient(raw, { name: 'a' });
  const dead = seedClient(raw, { name: 'dead' });
  const b = seedClient(raw, { name: 'b' });
  markFailures(raw, dead, 7);
  const feedId = seedFeed(raw);
  const offered: number[] = [];
  const chosen = selectClientForFeed(raw, feedId, (count) => { offered.push(count); return 1; });
  assert.deepEqual(offered, [2], 'two reachable candidates offered');
  assert.equal(chosen, b);
  assert.notEqual(chosen, a);
});

test('with every candidate unreachable the draw is from all of them, so picks still go somewhere', () => {
  const raw = setup();
  const a = seedClient(raw, { name: 'a' });
  const b = seedClient(raw, { name: 'b' });
  markFailures(raw, a, 3);
  markFailures(raw, b, 3);
  const feedId = seedFeed(raw);
  const offered: number[] = [];
  selectClientForFeed(raw, feedId, (count) => { offered.push(count); return 0; });
  assert.deepEqual(offered, [2]);
});

test('two failures is still reachable', () => {
  const raw = setup();
  const flaky = seedClient(raw, { name: 'flaky' });
  seedClient(raw, { name: 'other' });
  markFailures(raw, flaky, 2);
  const feedId = seedFeed(raw);
  const offered: number[] = [];
  selectClientForFeed(raw, feedId, (count) => { offered.push(count); return 0; });
  assert.deepEqual(offered, [2]);
});

test('a feed that names an unreachable client still uses it', () => {
  const raw = setup();
  const named = seedClient(raw, { name: 'named' });
  seedClient(raw, { name: 'other' });
  markFailures(raw, named, 9);
  const feedId = seedFeed(raw, { downloadClientId: named });
  assert.equal(selectClientForFeed(raw, feedId, refuseToChoose), named);
});
```

Adjust `selectClientForFeed`'s return (an id, or a row with `.id`) to what the function actually returns.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/clients/select.test.ts 2>&1 | grep -E "^not ok|✖" | head`
Expected: the first three fail. The last two may pass already, and they guard the fallback and the named-client rule.

- [ ] **Step 3: Implement**

In `select.ts`, have the candidate read return each candidate's failure count:

```ts
/** Every `download_client` of `downloadType`, lowest id first, with its consecutive-failure count. */
function readCandidates(raw: DatabaseSync, downloadType: string): { id: number; consecutiveFailures: number }[] {
  return raw.prepare('SELECT id, consecutive_failures FROM download_client WHERE type = ? ORDER BY id').all(downloadType)
    .map((row) => ({ id: Number(row['id']), consecutiveFailures: Number(row['consecutive_failures']) }));
}
```

Where the unnamed-feed branch builds its candidate list, narrow it before counting:

```ts
  // Prefer a client the reconcile cycle can currently reach (#93), and fall
  // back to every candidate when none is: a health filter that could empty
  // the list would turn a wrong health reading into a refused pick.
  const reachable = all.filter((candidate) => isReachable(candidate.consecutiveFailures));
  const pool = (reachable.length > 0 ? reachable : all).map((candidate) => candidate.id);
```

The rest of the branch (one candidate used directly; more than one goes to `chooseIndex(pool.length)`; the error text) runs on `pool`, not the old list. Replace the `#93` "no health state exists to consult" comment with a sentence saying what is consulted now. Leave the named-client branch untouched.

- [ ] **Step 4: Run the tests, gate, commit**

Run: `node --import tsx --conditions development --test packages/host/test/clients/select.test.ts packages/host/test/clients/downloads.test.ts packages/host/test/clients/pick.test.ts` — Expected: PASS.

Run: `npm run check > /tmp/p2-t5.log 2>&1; echo "exit $?"; rm -f /tmp/p2-t5.log` — Expected: exit 0.

```bash
git add -A packages && git commit -m "Send a pick to a reachable download client when one is, and to any when none is (#93)"
```

---

### Task 6: Show each client's health in settings (#93)

**Files:**
- Modify: `packages/web/src/settings/DownloadClients.tsx:75-121`
- Modify: `packages/web/src/styles/settings.css`
- Test: `packages/web/test/settings/DownloadClients.test.tsx`

**Interfaces:**
- Consumes: `DownloadClientSyncRead.consecutiveFailures`/`unreachableSince` (Task 1), `CLIENT_UNREACHABLE_AFTER_FAILURES`.
- Produces: `export function healthLine(client: Pick<DownloadClientSyncRead, 'consecutiveFailures' | 'unreachableSince'>): string` from `DownloadClients.tsx`.

- [ ] **Step 1: Write the failing tests**

In `DownloadClients.test.tsx` (Task 1 gave `clientOp` its two optional health parameters):

```ts
test('a client under the threshold reads Reachable, and one at it reads Unreachable since, as visible text', async () => {
  const db = await freshDb();
  await seed(db, [
    clientOp({ id: 1, name: 'Flaky', consecutiveFailures: 2, unreachableSince: 1_700_000_000_000 }),
    clientOp({ id: 2, name: 'Down', consecutiveFailures: 3, unreachableSince: 1_700_000_000_000 }),
  ]);
  render(<DownloadClients source={sourceFor(db)} submit={neverSubmit} submitMapping={neverSubmitMapping} />);
  await waitFor(() => {
    assert.ok(screen.queryByRole('heading', { name: 'Down' }));
  });
  const itemText = (name: string): string =>
    screen.getByRole('heading', { name }).closest('li')?.textContent ?? '';
  assert.ok(itemText('Flaky').includes('Reachable'), 'two failures is still reachable');
  assert.match(itemText('Down'), /Unreachable since .+ \(3 failed checks\)/);
  const line = [...(screen.getByRole('heading', { name: 'Down' }).closest('li')?.querySelectorAll('p') ?? [])]
    .find((p) => (p.textContent ?? '').startsWith('Unreachable'));
  assert.ok(line !== undefined, 'the line is a real element');
  assert.ok(!line.hasAttribute('aria-label'), 'visible text, not an aria-label');
  assert.ok(line.classList.contains('client-health'), 'a class the stylesheet reaches');
});

test('healthLine names the failure count and the start of the streak', () => {
  assert.equal(healthLine({ consecutiveFailures: 0, unreachableSince: null }), 'Reachable');
  const text = healthLine({ consecutiveFailures: 4, unreachableSince: 1_700_000_000_000 });
  assert.ok(text.startsWith('Unreachable since '));
  assert.ok(text.endsWith('(4 failed checks)'));
});
```

Also assert that `packages/web/src/styles/settings.css` contains a `.client-health` rule. Read the file as text, the way `App.test.tsx` checks `base.css` for the session notice; copy that technique.

- [ ] **Step 2: Run them and watch them fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/settings/DownloadClients.test.tsx 2>&1 | grep -E "^not ok|✖" | head`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `DownloadClients.tsx`:

```ts
/**
 * One client's health as the settings list states it (#93). The threshold is
 * `CLIENT_UNREACHABLE_AFTER_FAILURES`, the same constant the host's
 * selection uses, so this line never calls a client reachable while picks
 * avoid it. The start of the streak is shown in local time, because it
 * answers "since when", which is what an operator looking at a dead client
 * asks first.
 */
export function healthLine(client: Pick<DownloadClientSyncRead, 'consecutiveFailures' | 'unreachableSince'>): string {
  if (client.consecutiveFailures < CLIENT_UNREACHABLE_AFTER_FAILURES) return 'Reachable';
  const since = client.unreachableSince === null ? 'an unknown time' : new Date(client.unreachableSince).toLocaleString();
  return `Unreachable since ${since} (${String(client.consecutiveFailures)} failed checks)`;
}
```

Render it directly after the `implementationLabel` paragraph:

```tsx
                <p className="client-health">{healthLine(client)}</p>
```

In `packages/web/src/styles/settings.css`, add a rule near the other download-client list rules. Match the file's layer and selector conventions. If it keys everything by structure and uses no classes, key this one by `ul[aria-label='download clients'] li > .client-health` or by what the file does, and update the test's class assertion to match.

```css
/*
 * A download client's reachability (#93): secondary detail, in the list's
 * dimmed meta text, like the lines around it.
 */
.client-health {
  color: var(--color-text-dim);
  font-size: var(--text-meta);
}
```

- [ ] **Step 4: Run the tests, gate, commit**

Run the web test file again — Expected: PASS.

Run: `npm run check > /tmp/p2-t6.log 2>&1; echo "exit $?"; rm -f /tmp/p2-t6.log` — Expected: exit 0.

```bash
git add -A packages && git commit -m "Show whether each download client is reachable in settings (#93)"
```

---

### Task 7: End to end, mutations, and closing the loop

- [ ] **Step 1: Full e2e**

Run: `npm run e2e > /tmp/p2-e2e.log 2>&1; echo "exit $?"; grep -E "passed|failed" /tmp/p2-e2e.log | tail -3; rm -f /tmp/p2-e2e.log`
Expected: exit 0. Some spec may wait on reconcile timing or on the settings list's exact text. If one fails for that reason, update it to the new behaviour, not the reverse.

- [ ] **Step 2: Mutations**

Apply each mutation alone. Run the named file and record the fail count, then restore it (`git checkout -- <file>` for a tracked file). A mutation that fails nothing is a missing test: write the test before continuing. A mutation that fails every test in a file is suspect (`CLAUDE.md`, "a mutant that crashes proves nothing"), so narrow it.

| Mutation | File | Tests |
|---|---|---|
| `runTick`'s contact `catch` rethrows instead of returning | `clients/reconcile-job.ts` | `reconcile-job.test.ts` |
| `recordContactSuccess` drops `AND consecutive_failures > 0` | `clients/health.ts` | `health.test.ts` |
| `CONTACT_RETRY_CAP_MS` becomes `3_600_000` | `clients/health.ts` | `reconcile-job.test.ts` |
| `UNCONFIRMED_AFTER_MS` becomes `0` | `clients/rows.ts` | `reconcile.test.ts` |
| `failUnconfirmed` drops `AND status = 'submitting'` | `clients/rows.ts` | `rows.test.ts` |
| the settle call moves before `recoverRefs(deps, result)` | `clients/reconcile.ts` | `reconcile.test.ts` |
| `deliverCompleted`'s not-due filter clause removed | `clients/deliver.ts` | `deliver.test.ts` |
| the `clearImportWait` call removed from `saveDestination` | `media/destinations.ts` | `destinations.test.ts` |
| the reachable filter removed (`pool = all`) | `clients/select.ts` | `select.test.ts` |
| the fallback removed (`pool = reachable`) | `clients/select.ts` | `select.test.ts` |
| `toDownloadClient` returns `undefined` when a health field is missing | `web/src/settings/useDownloadClients.ts` | `DownloadClients.test.tsx` |

- [ ] **Step 3: Final gate**

Run: `npm run check > /tmp/p2-final.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)" /tmp/p2-final.log; rm -f /tmp/p2-final.log`
Expected: exit 0, `fail 0`.

- [ ] **Step 4: Commit if anything changed**

```bash
git add -A packages && git commit -m "Pin phase 2's guards with the tests their mutations showed were missing (#93, #95, #101)" || true
```

Nothing is pushed or merged.
