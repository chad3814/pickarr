# Client sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a browser client a replica of the rows it needs, through one append-only-then-collapsed log and two concurrent cursors, with each plugin declaring which of its tables take part.

**Architecture:** Triggers on every synced table maintain `sync_log`, one row per changed row, deleting the row's previous entry so a fresh `AUTOINCREMENT` id is allocated on every change. `GET /api/sync` tails the log from a cursor and resolves each op to current state. `GET /api/sync/backfill` walks current state backwards, newest media item first, emitting each group's dependent rows with it. The two run concurrently and converge because ops are idempotent.

**Tech Stack:** TypeScript (nodenext, strict), `node:sqlite` (SQLite 3.53.4), `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-14-client-sync-design.md` — read it with this plan. Section numbers below cite it.

## Global Constraints

- Never the `any` type. Never a cast to silence a type error.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules` all on. Indexed access checked, never `!`-asserted. Type-only imports `import type`. No enums.
- Prefer async APIs over sync twins; inside an `async` function, `await` it. `node:sqlite` is synchronous — the documented exception.
- **Log the discriminant alone, never the object.** No log line and **no HTTP response body** may carry a url, a path, a query string, a credential, a session token or a password hash. A `sync_log` row holds a table name and a row id and nothing else (spec §7.17).
- **Only `secrets/store.ts` may select `secret.value`**; `CREDENTIAL_ALLOW_LIST` holds exactly two entries. The credential tables are never synced.
- **No SQL in an HTTP handler.** **No import cycles** — nothing under `src/api`, `src/clients`, `src/jobs`, `src/media`, `src/config`, `src/secrets` or `src/sync` may import `host.ts`.
- `migrateHostWith`'s atomicity — each migration sharing a savepoint with its version record, with a matching `RELEASE` on both paths — **must not be touched**.
- Pickarr 1.x (`packages/core`, `plugin-api`, `plugin-scenes`, `web`, `e2e`) must not be modified.
- A comment false about the code beside it is a defect equal to a wrong line of code. When you change a thing, grep for its **name**, including in `docs/`.
- Baseline at the start: **2104** tests fail 0; lint exit 0 with exactly **124** warnings, **0** in `packages/contract` and `packages/host`; `npm run build` 0; `npm run test-hygiene` 0.
- Commit signed, `git add -- <paths>` first, explicit pathspec, never a bare `git commit`. Note `git commit -- <pathspec>` commits the **working tree** for those paths, and does not stage an untracked file.

## Verification method

Every task names at least one mutation and the kill it must produce.

- **Apply the mutation, run the focused test, confirm it fails by name**, then restore.
- **If a mutation's plain form fails `typecheck`, it measures the compiler.** Build `x as unknown as T` instead.
- **Restore by copy-aside and `md5 -q`, never `git checkout --`.** With uncommitted work in the file, `git checkout` reverts to the committed state and destroys it, and the passing run afterwards looks exactly like success.
- **Check every kill landed on its own assertion**, not on a SQLite error, a binding-arity error or a compile error.
- If a mutation cannot isolate a change, **say so** rather than inventing a kill. If a prediction here does not hold, trace why and report the trace.

## File structure

| File | Responsibility |
|---|---|
| `packages/host/src/sync/log.ts` | The trigger SQL for one table, and the enumeration of what is synced. No HTTP, no reads. |
| `packages/host/src/sync/tables.ts` | The host's own synced tables and how to read a row of each as the client receives it. |
| `packages/host/src/sync/tail.ts` | Ops above a cursor, resolved to current state. Pure SQL over the raw handle. |
| `packages/host/src/sync/backfill.ts` | The backwards walk over current state, hydrated per media item. |
| `packages/host/src/sync/registry.ts` | Host tables plus every plugin's declared tables, as one lookup. |
| `packages/host/src/api/sync-route.ts` | The two route answers, calling `tail.ts`/`backfill.ts`. No SQL of its own. |
| `packages/host/src/db/migrate.ts` | `MIGRATION_15`: `sync_log`, its unique index, the host tables' triggers and their `(created_at, id)` indexes. |
| `packages/host/src/db/open.ts` | `PRAGMA recursive_triggers = ON`. |
| `packages/host/src/db/schema.ts` | The `sync_log` mirror. |
| `packages/contract/src/sync.ts` | `SyncedTable<T>`, and the three read shapes. |
| `packages/plugin-{tv,movie,xxx}/src/sync.ts` | Each plugin's declared tables and read shapes. |

---

### Task 1: `sync_log`, the pragma, and the id that must never be reused

**Files:**
- Modify: `packages/host/src/db/migrate.ts` (add `MIGRATION_15`, register version 15)
- Modify: `packages/host/src/db/open.ts:29-31` (add the pragma inside `wrap`)
- Modify: `packages/host/src/db/schema.ts` (mirror `sync_log`)
- Test: `packages/host/test/db/migrate.test.ts`, `packages/host/test/db/open.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `sync_log` table; `PRAGMA recursive_triggers = ON` on every connection; the Drizzle export `syncLog`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/host/test/db/migrate.test.ts`:

```ts
test('migration 15 creates sync_log with a monotonic id and a unique row key', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const columns = raw.prepare('PRAGMA table_info(sync_log)').all()
    .map((row) => String((row as { name: unknown }).name));
  assert.deepEqual(columns, ['id', 'table_name', 'row_id', 'op', 'at']);

  // AUTOINCREMENT is what makes the cursor safe. SQLite records it by
  // creating `sqlite_sequence`; a bare INTEGER PRIMARY KEY does not.
  const seq = raw.prepare(
    "SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'",
  ).get();
  assert.equal(Number((seq as { c: unknown }).c), 1, 'sync_log must be AUTOINCREMENT');

  const idx = raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='sync_log_row'").get();
  assert.match(String((idx as { sql: unknown }).sql), /UNIQUE/, 'the row key must be unique');
});

test('a sync_log id is never handed out twice, though every change deletes a row', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const insert = raw.prepare('INSERT INTO sync_log (table_name, row_id, op, at) VALUES (?, ?, ?, ?)');
  const remove = raw.prepare('DELETE FROM sync_log WHERE table_name = ? AND row_id = ?');

  insert.run('media_item', 1, 'upsert', 1);
  const first = Number(raw.prepare('SELECT id FROM sync_log WHERE row_id = 1').get()?.id);
  remove.run('media_item', 1);
  insert.run('media_item', 1, 'upsert', 2);
  const second = Number(raw.prepare('SELECT id FROM sync_log WHERE row_id = 1').get()?.id);

  assert.ok(second > first, `a re-logged row must take a higher id, got ${second} after ${first}`);
});
```

Add to `packages/host/test/db/open.test.ts`:

```ts
test('recursive triggers are on, so a displacing REPLACE logs the deletion it causes', () => {
  const { raw } = openTestDatabase();
  assert.equal(Number(raw.prepare('PRAGMA recursive_triggers').get()?.recursive_triggers), 1);
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `node --import tsx --conditions development --test packages/host/test/db/migrate.test.ts packages/host/test/db/open.test.ts`
Expected: FAIL — `PRAGMA table_info(sync_log)` returns `[]`, and `recursive_triggers` reads 0.

- [ ] **Step 3: Add `MIGRATION_15`**

In `packages/host/src/db/migrate.ts`, after `MIGRATION_14`'s definition:

```ts
/**
 * The client's replication log: one row per row that has changed, not one per
 * change. Every trigger deletes this row's previous entry before inserting a
 * new one, so the log collapses as it is written and there is no compaction
 * job (design spec §3.5).
 *
 * `id` is `AUTOINCREMENT`, unlike every other table in this schema, and
 * deliberately. Deleting the previous entry frees its id, and a bare
 * `INTEGER PRIMARY KEY` would hand it straight back -- on every change, not
 * occasionally -- so a client whose cursor is past that id would never see
 * the row change again. Measured in the design spec §2.1 and §2.10. Do not
 * "tidy" this to match the other tables.
 */
const MIGRATION_15 = `
  CREATE TABLE sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    row_id     INTEGER NOT NULL,
    op         TEXT NOT NULL,
    at         INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX sync_log_row ON sync_log (table_name, row_id);
`;
```

Register it after the version 14 entry:

```ts
  { version: 15, up: (db) => db.exec(MIGRATION_15) },
```

- [ ] **Step 4: Add the pragma**

In `packages/host/src/db/open.ts`, inside `wrap`, after the WAL line:

```ts
  // Without this, an `INSERT OR REPLACE` that displaces a different row
  // through a unique-index conflict fires the insert trigger and not the
  // delete one -- so the displaced row's deletion never reaches `sync_log`
  // and every client keeps it forever, with nothing failing. Measured in the
  // design spec §2.9. It costs nothing on the common path: an
  // `ON CONFLICT DO UPDATE` logs identically with it on or off.
  raw.exec('PRAGMA recursive_triggers = ON');
```

- [ ] **Step 5: Mirror it in `schema.ts`**

At the end of `packages/host/src/db/schema.ts`:

```ts
/**
 * The client replication log. One row per changed row: a trigger deletes the
 * previous entry before inserting, so this table is bounded by how many rows
 * have ever changed rather than by how often they changed.
 *
 * `id` is `AUTOINCREMENT` in the DDL. Drizzle's `.primaryKey({ autoIncrement:
 * true })` is what mirrors that; a bare `.primaryKey()` would compare equal
 * on name and type while meaning something the cursor cannot survive.
 */
export const syncLog = sqliteTable('sync_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  tableName: text('table_name').notNull(),
  rowId: integer('row_id').notNull(),
  op: text('op').notNull(),
  at: integer('at').notNull(),
}, (t) => [
  uniqueIndex('sync_log_row').on(t.tableName, t.rowId),
]);
```

- [ ] **Step 6: Run the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 2107 pass 0 fail (2104 + 3); lint 0 with exactly 124 warnings; build 0; hygiene 0.

`schema.test.ts` compares every mirrored table against the migrated database automatically — adding the export is what puts `sync_log` under that comparison. Do not edit that test. If it reports a mismatch on `id`, the `autoIncrement: true` is missing.

- [ ] **Step 7: Mutation A — prove AUTOINCREMENT is load-bearing**

Copy `migrate.ts` aside (`cp packages/host/src/db/migrate.ts /tmp/m15.bak`), change `id INTEGER PRIMARY KEY AUTOINCREMENT` to `id INTEGER PRIMARY KEY`, run the focused test.
Expected: **both** new migration tests fail — the `sqlite_sequence` assertion, and `a sync_log id is never handed out twice` with `second` equal to `first` rather than greater.
Restore with `cp /tmp/m15.bak packages/host/src/db/migrate.ts`, `md5 -q` both paths, confirm they match, re-run.

- [ ] **Step 8: Mutation B — prove the pragma is load-bearing**

Copy `open.ts` aside. Delete the `recursive_triggers` line, run the focused test.
Expected: `recursive triggers are on…` fails, reading 0.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 9: Commit**

```bash
git add -- packages/host/src/db/migrate.ts packages/host/src/db/open.ts packages/host/src/db/schema.ts packages/host/test/db/migrate.test.ts packages/host/test/db/open.test.ts
git commit -m "Add the replication log, with the id that must never be reused" -- packages/host/src/db/migrate.ts packages/host/src/db/open.ts packages/host/src/db/schema.ts packages/host/test/db/migrate.test.ts packages/host/test/db/open.test.ts
```

---

### Task 2: The triggers, and the check that none is missing

**Files:**
- Create: `packages/host/src/sync/log.ts`
- Test: `packages/host/test/sync/log.test.ts`

**Interfaces:**
- Consumes: the `sync_log` table from Task 1.
- Produces:
  - `syncTriggerSql(table: string): string` — the three `DROP`/`CREATE TRIGGER` pairs for one table.
  - `installSyncTriggers(raw: DatabaseSync, tables: readonly string[]): void`
  - `syncedTriggerNames(table: string): readonly [string, string, string]`

- [ ] **Step 1: Write the failing tests**

Create `packages/host/test/sync/log.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { installSyncTriggers, syncedTriggerNames } from '../../src/sync/log.ts';

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT, created_at INTEGER NOT NULL)');
  installSyncTriggers(raw, ['probe']);
  return raw;
};
const ops = (raw: ReturnType<typeof open>) =>
  raw.prepare('SELECT table_name, row_id, op FROM sync_log ORDER BY id').all()
    .map((r) => `${String((r as { op: unknown }).op)}:${Number((r as { row_id: unknown }).row_id)}`);

test('an insert, an update and a delete each log one op', () => {
  const raw = open();
  raw.prepare('INSERT INTO probe (id, v, created_at) VALUES (1, ?, 1)').run('a');
  assert.deepEqual(ops(raw), ['upsert:1']);
  raw.prepare('UPDATE probe SET v = ? WHERE id = 1').run('b');
  assert.deepEqual(ops(raw), ['upsert:1'], 'a second change replaces the entry rather than adding one');
  raw.prepare('DELETE FROM probe WHERE id = 1').run();
  assert.deepEqual(ops(raw), ['delete:1']);
});

test('a row changed twice takes a higher id the second time', () => {
  const raw = open();
  raw.prepare('INSERT INTO probe (id, v, created_at) VALUES (1, ?, 1)').run('a');
  const first = Number(raw.prepare('SELECT id FROM sync_log WHERE row_id = 1').get()?.id);
  raw.prepare('UPDATE probe SET v = ? WHERE id = 1').run('b');
  const second = Number(raw.prepare('SELECT id FROM sync_log WHERE row_id = 1').get()?.id);
  assert.ok(second > first, `expected a higher id, got ${second} after ${first}`);
});

test('the log holds one row per changed row, not one per change', () => {
  const raw = open();
  for (let id = 1; id <= 5; id += 1) raw.prepare('INSERT INTO probe (id, v, created_at) VALUES (?, ?, 1)').run(id, 'a');
  for (let round = 0; round < 8; round += 1) {
    for (let id = 1; id <= 5; id += 1) raw.prepare('UPDATE probe SET v = ? WHERE id = ?').run(`v${round}`, id);
  }
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM sync_log').get()?.c), 5);
});

test('a displacing REPLACE logs the deletion it causes', () => {
  const raw = openTestDatabase().raw;
  migrateHost(raw);
  raw.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, k TEXT UNIQUE, created_at INTEGER NOT NULL)');
  installSyncTriggers(raw, ['probe']);
  raw.prepare('INSERT INTO probe (id, k, created_at) VALUES (1, ?, 1)').run('dup');
  raw.prepare('INSERT OR REPLACE INTO probe (id, k, created_at) VALUES (2, ?, 1)').run('dup');
  assert.deepEqual(
    raw.prepare('SELECT row_id, op FROM sync_log ORDER BY row_id').all()
      .map((r) => `${String((r as { op: unknown }).op)}:${Number((r as { row_id: unknown }).row_id)}`),
    ['delete:1', 'upsert:2'],
    'row 1 was displaced and must be logged as deleted',
  );
});

test('installing twice is a no-op rather than an error', () => {
  const raw = open();
  assert.doesNotThrow(() => { installSyncTriggers(raw, ['probe']); });
});

test('every named trigger exists after installation', () => {
  const raw = open();
  const present = new Set(
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()
      .map((r) => String((r as { name: unknown }).name)),
  );
  for (const name of syncedTriggerNames('probe')) assert.ok(present.has(name), `missing ${name}`);
});
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `node --import tsx --conditions development --test packages/host/test/sync/log.test.ts`
Expected: FAIL — `Cannot find module '../../src/sync/log.ts'`.

- [ ] **Step 3: Write `log.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';

/**
 * The three triggers that keep one `sync_log` row per changed row.
 *
 * Each deletes the row's existing entry before inserting a new one. That is
 * not an optimisation: the delete is what frees the old `AUTOINCREMENT` id so
 * the insert allocates a higher one, and a higher id is what makes the change
 * visible to a client whose cursor is already past the old entry. An upsert
 * would keep one row per changed row too, and would keep the id -- measured
 * in the design spec §2.10 -- which hides the change from exactly the clients
 * that need it.
 *
 * `DROP TRIGGER IF EXISTS` first, so installation is idempotent: the host
 * calls this on every boot, for host tables and plugin tables alike.
 */
export function syncTriggerSql(table: string): string {
  const [ins, upd, del] = syncedTriggerNames(table);
  const log = (rowId: string, op: string) =>
    `DELETE FROM sync_log WHERE table_name = '${table}' AND row_id = ${rowId};
     INSERT INTO sync_log (table_name, row_id, op, at)
       VALUES ('${table}', ${rowId}, '${op}', unixepoch() * 1000);`;
  return `
    DROP TRIGGER IF EXISTS ${ins};
    CREATE TRIGGER ${ins} AFTER INSERT ON ${table} BEGIN ${log('NEW.id', 'upsert')} END;
    DROP TRIGGER IF EXISTS ${upd};
    CREATE TRIGGER ${upd} AFTER UPDATE ON ${table} BEGIN ${log('NEW.id', 'upsert')} END;
    DROP TRIGGER IF EXISTS ${del};
    CREATE TRIGGER ${del} AFTER DELETE ON ${table} BEGIN ${log('OLD.id', 'delete')} END;
  `;
}

/** The three trigger names for a table, in insert/update/delete order. */
export function syncedTriggerNames(table: string): readonly [string, string, string] {
  return [`${table}_sync_ins`, `${table}_sync_upd`, `${table}_sync_del`];
}

/** Installs (or reinstalls) the triggers for each table. */
export function installSyncTriggers(raw: DatabaseSync, tables: readonly string[]): void {
  for (const table of tables) raw.exec(syncTriggerSql(table));
}
```

The table name is interpolated rather than bound because a trigger's body is
DDL and SQLite binds no parameters there. Task 4 is what constrains the set of
names that can reach this function.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --conditions development --test packages/host/test/sync/log.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 2113 pass 0 fail (2107 + 6); lint 0 at exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 6: Mutation A — prove the delete-then-insert is what advances the id**

Copy `log.ts` aside. Replace the `log` helper's body with an upsert:

```ts
    `INSERT INTO sync_log (table_name, row_id, op, at)
       VALUES ('${table}', ${rowId}, '${op}', unixepoch() * 1000)
     ON CONFLICT (table_name, row_id) DO UPDATE SET op = excluded.op, at = excluded.at;`;
```

Run the focused test.
Expected: `a row changed twice takes a higher id the second time` FAILS with the two ids equal. Note that `an insert, an update and a delete each log one op` and the one-row-per-changed-row test still **pass** — the upsert collapses correctly and is still wrong, which is the whole point of having the id assertion separately.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 7: Mutation B — prove the delete trigger is reached by a displacing REPLACE**

This one depends on Task 1's pragma, so mutate that instead. Copy `open.ts` aside, delete the `recursive_triggers` line, run the focused test.
Expected: `a displacing REPLACE logs the deletion it causes` FAILS, with `['upsert:2']` where `['delete:1', 'upsert:2']` was expected.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 8: Commit**

```bash
git add -- packages/host/src/sync/log.ts packages/host/test/sync/log.test.ts
git commit -m "Keep one log row per changed row, freeing the id so the next change outranks the last" -- packages/host/src/sync/log.ts packages/host/test/sync/log.test.ts
```

---

### Task 3: The host's own synced tables

**Files:**
- Create: `packages/host/src/sync/tables.ts`
- Modify: `packages/host/src/db/migrate.ts` (extend `MIGRATION_15` with the host triggers and the `(created_at, id)` indexes)
- Test: `packages/host/test/sync/tables.test.ts`

**Interfaces:**
- Consumes: `installSyncTriggers`, `syncedTriggerNames` from `sync/log.ts`.
- Produces: `HOST_SYNCED_TABLES: readonly string[]` and `readHostRows(raw, table, ids): Record<number, unknown>`.

**The set, and why each is in or out.** In: `media_item`, `rss_item`, `torrent_download`, `nzb_download`, `person`, `role`. Out, with reasons the file must state: every `auth_*` table, `host_state` and `secret` hold credentials; `download_client` holds a service's address and its secret names; `jobs` is machinery; `poster`/`background`/`logo` are reachable through `/api/artwork/:kind/:id`, so the client asks for an image and handles a 404 rather than replicating rows about files; `alias`, `external_reference` and `filepath_mapping` have no consumer in slice 2; `deleted_media_item` is slice E's tombstone table, superseded here but not removed (spec §4).

- [ ] **Step 1: Write the failing test**

Create `packages/host/test/sync/tables.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { HOST_SYNCED_TABLES } from '../../src/sync/tables.ts';
import { syncedTriggerNames } from '../../src/sync/log.ts';

test('every host synced table has all three triggers after migration', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const present = new Set(
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()
      .map((r) => String((r as { name: unknown }).name)),
  );
  for (const table of HOST_SYNCED_TABLES) {
    for (const name of syncedTriggerNames(table)) {
      assert.ok(present.has(name), `${table} is synced but ${name} does not exist`);
    }
  }
});

test('no credential-bearing table is synced', () => {
  for (const forbidden of ['auth_user', 'auth_session', 'auth_account', 'auth_verification', 'host_state', 'secret', 'download_client']) {
    assert.ok(!HOST_SYNCED_TABLES.includes(forbidden), `${forbidden} must never be synced`);
  }
});

test('every synced table has an integer primary key named id', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  for (const table of HOST_SYNCED_TABLES) {
    const pk = raw.prepare(`PRAGMA table_info(${table})`).all()
      .filter((r) => Number((r as { pk: unknown }).pk) > 0)
      .map((r) => String((r as { name: unknown }).name));
    assert.deepEqual(pk, ['id'], `${table}'s primary key must be a single column named id`);
  }
});

test('a log row can hold nothing but a table name, a row id, an op and a time', () => {
  // Spec 7.17. Structural rather than behavioural: the guarantee that no
  // credential or url reaches the log is the table's shape, so assert the
  // shape. A column added here later would need this test changed, which is
  // the point.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  assert.deepEqual(
    raw.prepare('PRAGMA table_info(sync_log)').all().map((r) => String((r as { name: unknown }).name)),
    ['id', 'table_name', 'row_id', 'op', 'at'],
  );
});

test('every synced table can be paged by an immutable key', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  for (const table of HOST_SYNCED_TABLES) {
    const columns = raw.prepare(`PRAGMA table_info(${table})`).all()
      .map((r) => String((r as { name: unknown }).name));
    assert.ok(columns.includes('created_at'), `${table} needs created_at for the backfill's keyset`);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/sync/tables.test.ts`
Expected: FAIL — `Cannot find module '../../src/sync/tables.ts'`.

- [ ] **Step 3: Write `tables.ts`**

```ts
/**
 * The host's own tables that a client replicates, and the reason each of the
 * others is absent.
 *
 * **In:** the group (`media_item`), the releases under it (`rss_item`), what
 * was submitted for them (`torrent_download`, `nzb_download`), and who is in
 * them (`person`, `role`).
 *
 * **Out, and why:** `auth_user`, `auth_session`, `auth_account`,
 * `auth_verification`, `host_state` and `secret` hold credentials, and no
 * credential leaves this process. `download_client` holds a service's address
 * and the names of its secrets. `jobs` is machinery a client has no use for.
 * `poster`, `background` and `logo` describe files already reachable at
 * `/api/artwork/:kind/:mediaItemId`, so a client asks for the image and
 * handles a 404 rather than replicating rows about files it cannot read.
 * `alias`, `external_reference` and `filepath_mapping` have no consumer.
 * `deleted_media_item` is slice E's tombstone table: the log's delete ops
 * supersede it, and it stays because `/api/deletions` still serves it.
 */
export const HOST_SYNCED_TABLES: readonly string[] = [
  'media_item',
  'rss_item',
  'torrent_download',
  'nzb_download',
  'person',
  'role',
];
```

- [ ] **Step 4: Extend `MIGRATION_15`**

`role` has no `created_at`… **check this before writing the migration.** Run:

```bash
node --import tsx --conditions development -e "
import { openTestDatabase } from './packages/host/src/db/open.ts';
import { migrateHost } from './packages/host/src/db/migrate.ts';
const { raw } = openTestDatabase(); migrateHost(raw);
for (const t of ['media_item','rss_item','torrent_download','nzb_download','person','role']) {
  const cols = raw.prepare(\`PRAGMA table_info(\${t})\`).all().map((r) => String(r.name));
  console.log(t.padEnd(18), 'created_at:', cols.includes('created_at'), '| id pk:', cols.includes('id'));
}"
```

Every table that reports `created_at: false` needs the column added in `MIGRATION_15` before its index — `ALTER TABLE <t> ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`, with a comment saying the default is what makes the column legal to add to a table that already holds rows, and that a 0 sorts those rows to the end of a newest-first walk, which is where rows of unknown age belong. Report what you found.

Then append to `MIGRATION_15`'s SQL:

```sql
  CREATE INDEX media_item_created ON media_item (created_at, id);
  CREATE INDEX rss_item_created ON rss_item (created_at, id);
  CREATE INDEX torrent_download_created ON torrent_download (created_at, id);
  CREATE INDEX nzb_download_created ON nzb_download (created_at, id);
  CREATE INDEX person_created ON person (created_at, id);
  CREATE INDEX role_created ON role (created_at, id);
```

and, at the end of the migration's `up`, install the triggers. `MIGRATION_15` becomes a function rather than a SQL string, like `migration14`:

```ts
function migration15(db: DatabaseSync): void {
  db.exec(MIGRATION_15_DDL);
  installSyncTriggers(db, HOST_SYNCED_TABLES);
}
```

registered as `{ version: 15, up: (db) => migration15(db) }`.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 2118 pass 0 fail (2113 + 5); lint 0 at exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 6: Mutation — prove the enumeration test would catch a table added without triggers**

Copy `tables.ts` aside. Add `'alias'` to `HOST_SYNCED_TABLES` without adding its triggers to the migration, run the focused test.
Expected: `every host synced table has all three triggers after migration` FAILS naming `alias_sync_ins`. This is the test that stops a future table being synced in name only, which would diverge a client silently.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 7: Commit**

```bash
git add -- packages/host/src/sync/tables.ts packages/host/src/db/migrate.ts packages/host/test/sync/tables.test.ts
git commit -m "Name the host tables a client replicates, and the reason each other one is absent" -- packages/host/src/sync/tables.ts packages/host/src/db/migrate.ts packages/host/test/sync/tables.test.ts
```

---

### Task 4: The contract change

**Files:**
- Create: `packages/contract/src/sync.ts`
- Modify: `packages/contract/src/plugin.ts` (add `synced` to `MediaPlugin`)
- Modify: `packages/contract/src/index.ts` (export the new types)
- Test: `packages/contract/test/sync.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SyncedTable<T> { readonly table: string; read(raw: DatabaseSync, ids: readonly number[]): Record<number, T>; rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[] }`
  - `MediaPlugin.synced: readonly SyncedTable<unknown>[]`
  - `assertSyncedTableName(pluginId: string, table: string): void`
  - `TvRead`, `MovieRead`, `XxxRead`

`read` and `rowsFor` are synchronous and take the raw handle, matching every other read path in this repo — `node:sqlite` is synchronous and `reads.ts` is too.

- [ ] **Step 1: Write the failing test**

Create `packages/contract/test/sync.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSyncedTableName } from '../src/sync.ts';

test('a plugin may only declare tables carrying its own id as a prefix', () => {
  assert.doesNotThrow(() => { assertSyncedTableName('tv', 'tv_series'); });
  assert.doesNotThrow(() => { assertSyncedTableName('tv', 'tv_release'); });
  for (const table of ['media_item', 'movie_detail', 'sync_log', 'secret', 'tvseries']) {
    assert.throws(() => { assertSyncedTableName('tv', table); }, /prefix/, `${table} must be refused`);
  }
});

test('a table name that is not a plain identifier is refused', () => {
  // The name reaches a trigger body as text, where SQLite binds no parameters.
  for (const table of ['tv_a; DROP TABLE media_item', 'tv_a"b', 'tv_a b', 'tv_a-b', '']) {
    assert.throws(() => { assertSyncedTableName('tv', table); }, /identifier|prefix/, `${table} must be refused`);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/contract/test/sync.test.ts`
Expected: FAIL — `Cannot find module '../src/sync.ts'`.

- [ ] **Step 3: Write `sync.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';

/** A plugin-owned table a client replicates, and how to read it. */
export interface SyncedTable<T> {
  /** The table's name. Must carry the plugin's id as a prefix; see `assertSyncedTableName`. */
  readonly table: string;
  /** Current state for these row ids, in the shape the client receives. */
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, T>;
  /** This table's row ids belonging to those media items, so the backfill can hydrate a group. */
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[];
}

/** A plain SQL identifier: what may be interpolated into a trigger body. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * Refuses a table a plugin may not claim.
 *
 * Two checks, and the second is the load-bearing one. A plugin's tables must
 * carry its id as a prefix, which is the rule its migrations already follow --
 * that stops one plugin replicating another's rows, or the host's. And the
 * name must be a plain identifier, because it is interpolated into a trigger
 * body where SQLite binds no parameters (`sync/log.ts`), so a name is the one
 * place a plugin's declaration reaches SQL as text.
 */
export function assertSyncedTableName(pluginId: string, table: string): void {
  if (!IDENTIFIER.test(table)) {
    throw new Error(`synced table ${JSON.stringify(table)} is not a plain identifier`);
  }
  if (!table.startsWith(`${pluginId}_`)) {
    throw new Error(
      `plugin ${JSON.stringify(pluginId)} declared synced table ${JSON.stringify(table)}, ` +
      `which does not carry its id as a prefix`,
    );
  }
}

/** What a client receives for a television media item. */
export interface TvRead {
  kind: 'series' | 'season' | 'episode';
  seriesTitle: string;
  seriesRef: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
}

/** What a client receives for a film media item. */
export interface MovieRead {
  runtimeMinutes: number | null;
  tagline: string | null;
}

/** What a client receives for an adult media item. */
export interface XxxRead {
  siteName: string | null;
  siteRef: string | null;
}
```

Add to `MediaPlugin` in `packages/contract/src/plugin.ts`, after `jobs`:

```ts
  /**
   * The tables this plugin contributes to a client's replica. Empty means the
   * plugin adds nothing beyond the host's own tables.
   *
   * The host owns the triggers for these, not the plugin: a trigger a plugin
   * forgot would diverge every client with nothing failing, so it is not left
   * to a caller.
   */
  readonly synced: readonly SyncedTable<unknown>[];
```

Export both from `packages/contract/src/index.ts`.

- [ ] **Step 4: Run the tests and the gate**

Run: `node --import tsx --conditions development --test packages/contract/test/sync.test.ts`
Expected: PASS, 2 tests.

Run: `npm run typecheck`
Expected: **FAIL.** Adding a required member to `MediaPlugin` breaks every implementation. Add `synced: []` to each of `packages/plugin-tv/src/index.ts`, `packages/plugin-movie/src/index.ts`, `packages/plugin-xxx/src/index.ts` and any test double the compiler names — Task 7 fills them in. Then re-run until 0.

Run: `npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: tests 2120 pass 0 fail (2118 + 2); lint 0 at exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 5: Mutation — prove the prefix check is what refuses another plugin's table**

Copy `sync.ts` aside. Delete the `startsWith` block, run the focused test.
Expected: `a plugin may only declare tables carrying its own id as a prefix` FAILS on `media_item` — which is the case that matters, because it is the host's own table.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 6: Commit**

```bash
git add -- packages/contract/src/sync.ts packages/contract/src/plugin.ts packages/contract/src/index.ts packages/contract/test/sync.test.ts packages/plugin-tv/src/index.ts packages/plugin-movie/src/index.ts packages/plugin-xxx/src/index.ts
git commit -m "Let a plugin declare the tables it replicates, and refuse the ones it may not" -- packages/contract/src/sync.ts packages/contract/src/plugin.ts packages/contract/src/index.ts packages/contract/test/sync.test.ts packages/plugin-tv/src/index.ts packages/plugin-movie/src/index.ts packages/plugin-xxx/src/index.ts
```

Include every other file the compiler required in both the `add` and the `commit` pathspec.

---

### Task 5: The tail

**Files:**
- Create: `packages/host/src/sync/registry.ts`, `packages/host/src/sync/tail.ts`
- Test: `packages/host/test/sync/tail.test.ts`

**Interfaces:**
- Consumes: `HOST_SYNCED_TABLES`, `SyncedTable`.
- Produces:
  - `createSyncRegistry(plugins: readonly MediaPlugin[]): SyncRegistry` with `tables(): readonly string[]` and `readRows(raw, table, ids): Record<number, unknown>`
  - `interface SyncOp { op: 'upsert' | 'delete'; table: string; value?: unknown; id?: number }`
  - `tailSince(raw: DatabaseSync, registry: SyncRegistry, since: number, limit: number): { ops: readonly SyncOp[]; cursor: number }`

- [ ] **Step 1: Write the failing test**

Create `packages/host/test/sync/tail.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { tailSince } from '../../src/sync/tail.ts';

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return { raw, registry: createSyncRegistry(raw, []) };
};
const addItem = (raw: ReturnType<typeof open>['raw'], id: number, title: string) =>
  raw.prepare(
    'INSERT INTO media_item (id, plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'tv', id, id, title);

test('a client at zero receives one op per row that exists', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 'a'); addItem(raw, 2, 'b');
  const page = tailSince(raw, registry, 0, 100);
  assert.deepEqual(page.ops.map((o) => o.op), ['upsert', 'upsert']);
  assert.ok(page.cursor > 0);
});

test('a client at the head receives nothing and keeps its cursor', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 'a');
  const first = tailSince(raw, registry, 0, 100);
  const second = tailSince(raw, registry, first.cursor, 100);
  assert.deepEqual(second.ops, []);
  assert.equal(second.cursor, first.cursor, 'an empty page must not move the cursor backwards');
});

test('a row changed after a cursor is delivered to a client holding it', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 'a');
  const first = tailSince(raw, registry, 0, 100);
  raw.prepare('UPDATE media_item SET title = ? WHERE id = 1').run('b');
  const second = tailSince(raw, registry, first.cursor, 100);
  assert.equal(second.ops.length, 1);
  assert.equal((second.ops[0]?.value as { title: string } | undefined)?.title, 'b');
});

test('a deleted row arrives as a delete carrying only its id', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 'a');
  const first = tailSince(raw, registry, 0, 100);
  raw.prepare('DELETE FROM media_item WHERE id = 1').run();
  const page = tailSince(raw, registry, first.cursor, 100);
  assert.deepEqual(page.ops.map((o) => o.op), ['delete']);
  assert.equal(page.ops[0]?.id, 1);
  assert.equal(page.ops[0]?.value, undefined, 'a delete carries no row');
});

test('a row changed many times is delivered once', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 'a');
  for (let i = 0; i < 10; i += 1) raw.prepare('UPDATE media_item SET title = ? WHERE id = 1').run(`v${i}`);
  const page = tailSince(raw, registry, 0, 100);
  assert.equal(page.ops.length, 1, 'the log collapses on write, so the tail needs no GROUP BY');
});

test('the tail pages, and the cursor resumes exactly where it stopped', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 5; id += 1) addItem(raw, id, `t${id}`);
  const first = tailSince(raw, registry, 0, 2);
  assert.equal(first.ops.length, 2);
  const second = tailSince(raw, registry, first.cursor, 2);
  assert.equal(second.ops.length, 2);
  const ids = [...first.ops, ...second.ops].map((o) => (o.value as { id: number }).id);
  assert.deepEqual(ids, [1, 2, 3, 4], 'no row repeated, none skipped');
});

test('the same cursor twice yields the same ops', () => {
  // Spec 7.3. The client's idempotence rests on this: a page re-fetched after
  // a dropped connection must not differ, or a retry would diverge a replica.
  const { raw, registry } = open();
  addItem(raw, 1, 'a'); addItem(raw, 2, 'b');
  assert.deepEqual(tailSince(raw, registry, 0, 100), tailSince(raw, registry, 0, 100));
});

test('a write through the Drizzle handle logs an op, as a raw write does', () => {
  // Spec 7.12. The host writes both ways; a trigger is SQLite's, so both must
  // reach it -- but asserting it stops a future bulk path being added that
  // does not.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  // `openTestDatabase()` returns `{ raw, db }` over ONE connection. Use that
  // pair, not two calls: write through `db` (Drizzle) and read the log
  // through `raw`. Insert a media_item via `db.insert(mediaItem).values(...)`
  // and assert the tail sees exactly one op.
  assert.equal(tailSince(raw, registry, 0, 100).ops.length, 1);
});

test('no op carries a table the registry does not know', () => {
  const { raw, registry } = open();
  raw.prepare('INSERT INTO sync_log (table_name, row_id, op, at) VALUES (?, ?, ?, ?)')
    .run('secret', 7, 'upsert', 1);
  addItem(raw, 1, 'a');
  const page = tailSince(raw, registry, 0, 100);
  assert.deepEqual(page.ops.map((o) => o.table), ['media_item'], 'an unknown table must be skipped, not served');
  assert.ok(page.cursor > 0, 'and the cursor must still advance past it');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/sync/tail.test.ts`
Expected: FAIL — `Cannot find module '../../src/sync/registry.ts'`.

- [ ] **Step 3: Write `registry.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { MediaPlugin, SyncedTable } from '@pickarr/contract';
import { assertSyncedTableName } from '@pickarr/contract';
import { HOST_SYNCED_TABLES } from './tables.ts';
import { readHostRows } from './tables.ts';

export interface SyncRegistry {
  /** Every synced table, host and plugin, in a stable order. */
  tables(): readonly string[];
  /** Current state for these ids of one table, or an empty record for a table nobody owns. */
  readRows(raw: DatabaseSync, table: string, ids: readonly number[]): Record<number, unknown>;
}

/**
 * Host tables plus every plugin's declared tables, as one lookup.
 *
 * A table nobody declares reads as empty rather than throwing: `sync_log` can
 * hold a row for a table that was synced by a plugin since removed, and a
 * client asking for it should be told nothing rather than be refused.
 */
export function createSyncRegistry(raw: DatabaseSync, plugins: readonly MediaPlugin[]): SyncRegistry {
  const owned = new Map<string, SyncedTable<unknown>>();
  for (const plugin of plugins) {
    for (const table of plugin.synced) {
      assertSyncedTableName(plugin.id, table.table);
      const claimed = owned.get(table.table);
      if (claimed !== undefined) {
        throw new Error(`two plugins declare synced table ${JSON.stringify(table.table)}`);
      }
      assertIntegerIdKey(raw, table.table);
      owned.set(table.table, table);
    }
  }
  const all = [...HOST_SYNCED_TABLES, ...owned.keys()];

  return {
    tables: () => all,
    readRows(raw, table, ids) {
      if (HOST_SYNCED_TABLES.includes(table)) return readHostRows(raw, table, ids);
      const plugin = owned.get(table);
      return plugin === undefined ? {} : plugin.read(raw, ids);
    },
  };
}
```

`assertIntegerIdKey(raw, table)` reads `PRAGMA table_info` and throws unless
the table's primary key is exactly one column named `id`. The triggers read
`NEW.id`/`OLD.id`, so a table keyed otherwise would install triggers that fail
at write time rather than at declaration — spec §7.16 asks for the refusal to
happen where it can be understood. `createSyncRegistry` therefore takes the
raw handle as its first parameter: `createSyncRegistry(raw, plugins)`.

`readHostRows(raw, table, ids)` belongs in `tables.ts` from Task 3 — add it there
if Task 3 did not, selecting each table's columns explicitly. **It must never
`SELECT *`**: the hygiene check reads a star over a credential table as a
violation, and an explicit list is what keeps a future column from reaching a
client by accident.

- [ ] **Step 4: Write `tail.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { SyncRegistry } from './registry.ts';

export interface SyncOp {
  op: 'upsert' | 'delete';
  table: string;
  /** Present on an upsert: the row as the client receives it. */
  value?: unknown;
  /** Present on a delete: the row id that no longer exists. */
  id?: number;
}

/**
 * Ops above `since`, resolved to current state.
 *
 * No `GROUP BY`: the log already holds one entry per changed row, because
 * every trigger deletes the previous entry before inserting (design spec
 * §3.5). This is a primary-key range scan.
 *
 * An entry whose row has since vanished becomes a `delete` even if the entry
 * says `upsert` -- the log records that a row changed, and current state is
 * the authority on what it changed to. That is also what makes a torn read
 * impossible: there is one query for the entries and one per table for the
 * rows, and a row deleted between them simply reads as absent.
 */
export function tailSince(
  raw: DatabaseSync,
  registry: SyncRegistry,
  since: number,
  limit: number,
): { ops: readonly SyncOp[]; cursor: number } {
  const entries = raw.prepare(
    'SELECT id, table_name, row_id FROM sync_log WHERE id > ? ORDER BY id LIMIT ?',
  ).all(since, limit).map((row) => ({
    id: Number((row as { id: unknown }).id),
    table: String((row as { table_name: unknown }).table_name),
    rowId: Number((row as { row_id: unknown }).row_id),
  }));

  if (entries.length === 0) return { ops: [], cursor: since };

  const byTable = new Map<string, number[]>();
  for (const entry of entries) {
    const ids = byTable.get(entry.table);
    if (ids === undefined) byTable.set(entry.table, [entry.rowId]);
    else ids.push(entry.rowId);
  }

  const rows = new Map<string, Record<number, unknown>>();
  for (const [table, ids] of byTable) rows.set(table, registry.readRows(raw, table, ids));

  const known = new Set(registry.tables());
  const ops: SyncOp[] = [];
  for (const entry of entries) {
    if (!known.has(entry.table)) continue;
    const value = rows.get(entry.table)?.[entry.rowId];
    ops.push(value === undefined
      ? { op: 'delete', table: entry.table, id: entry.rowId }
      : { op: 'upsert', table: entry.table, value });
  }

  const last = entries[entries.length - 1];
  return { ops, cursor: last === undefined ? since : last.id };
}
```

- [ ] **Step 5: Run the tests and the gate**

Run: `node --import tsx --conditions development --test packages/host/test/sync/tail.test.ts`
Expected: PASS, 9 tests.

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 2129 pass 0 fail (2120 + 9); lint 0 at exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 6: Mutation A — prove an unknown table cannot be served**

Copy `tail.ts` aside. Delete the `if (!known.has(entry.table)) continue;` line, run the focused test.
Expected: `no op carries a table the registry does not know` FAILS with `['secret', 'media_item']`. That the forbidden name is `secret` is the point: the check is what stops a stale or hostile log row turning into a served credential.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 7: Mutation B — prove the cursor advances past a skipped entry**

Copy aside. Change the returned cursor to the last *served op's* entry id rather than the last entry id (track it alongside `ops`), run the focused test.
Expected: `no op carries a table the registry does not know` FAILS its `page.cursor > 0` assertion when the only unknown entry is the newest — a client would ask for the same skipped entry forever. If the existing test does not provoke it, add a case where the unknown entry is last, and say you did.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 8: Commit**

```bash
git add -- packages/host/src/sync/registry.ts packages/host/src/sync/tail.ts packages/host/src/sync/tables.ts packages/host/test/sync/tail.test.ts
git commit -m "Serve ops above a cursor as current state, skipping any table nobody declared" -- packages/host/src/sync/registry.ts packages/host/src/sync/tail.ts packages/host/src/sync/tables.ts packages/host/test/sync/tail.test.ts
```

---

### Task 6: The backfill

**Files:**
- Create: `packages/host/src/sync/backfill.ts`
- Test: `packages/host/test/sync/backfill.test.ts`

**Interfaces:**
- Consumes: `SyncRegistry`, `SyncOp`.
- Produces: `backfillBefore(raw, registry, before: { createdAt: number; id: number } | null, limit: number): { ops: readonly SyncOp[]; cursor: { createdAt: number; id: number } | null; watermark: number }`

A null `cursor` in the result means current state is exhausted and the client retires this cursor. `watermark` is the log's high-water mark, returned on every page so a client that starts mid-way still gets one.

- [ ] **Step 1: Write the failing test**

Create `packages/host/test/sync/backfill.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { backfillBefore } from '../../src/sync/backfill.ts';
import { tailSince } from '../../src/sync/tail.ts';

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return { raw, registry: createSyncRegistry(raw, []) };
};
const addItem = (raw: ReturnType<typeof open>['raw'], id: number, createdAt: number) =>
  raw.prepare('INSERT INTO media_item (id, plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'tv', createdAt, createdAt, `t${id}`);
const addRelease = (raw: ReturnType<typeof open>['raw'], id: number, mediaItemId: number, createdAt: number) =>
  raw.prepare(`INSERT INTO rss_item (id, feed_id, filename, link, created_at, updated_at, download_type, media_item_id, resolution)
               VALUES (?, 1, ?, ?, ?, ?, 'torrent', ?, '1080p')`)
    .run(id, `f${id}`, `l${id}`, createdAt, createdAt, mediaItemId);

test('the newest media item comes first', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 100); addItem(raw, 2, 300); addItem(raw, 3, 200);
  const page = backfillBefore(raw, registry, null, 10);
  const items = page.ops.filter((o) => o.table === 'media_item')
    .map((o) => (o.value as { id: number }).id);
  assert.deepEqual(items, [2, 3, 1], 'newest created_at first');
});

test('a group arrives with its releases, and the group before them', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 100);
  addRelease(raw, 10, 1, 100); addRelease(raw, 11, 1, 100);
  const page = backfillBefore(raw, registry, null, 10);
  const order = page.ops.map((o) => o.table);
  assert.equal(order[0], 'media_item', 'the group must precede anything referencing it');
  assert.equal(order.filter((t) => t === 'rss_item').length, 2);
});

test('paging is stable, and resuming skips nothing and repeats nothing', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 6; id += 1) addItem(raw, id, id * 10);
  const first = backfillBefore(raw, registry, null, 2);
  assert.ok(first.cursor !== null);
  const second = backfillBefore(raw, registry, first.cursor, 2);
  const seen = [...first.ops, ...second.ops]
    .filter((o) => o.table === 'media_item').map((o) => (o.value as { id: number }).id);
  assert.deepEqual(seen, [6, 5, 4, 3]);
});

test('an exhausted walk returns a null cursor', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 100);
  const page = backfillBefore(raw, registry, null, 10);
  assert.equal(page.cursor, null);
});

test('the first page carries the watermark, so the tail can start without a round trip', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 100);
  const page = backfillBefore(raw, registry, null, 10);
  assert.ok(page.watermark > 0);
  assert.deepEqual(tailSince(raw, registry, page.watermark, 10).ops, [], 'the tail at the watermark is empty');
});

test('a row changed during the walk reaches the client on the tail, not the walk', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 4; id += 1) addItem(raw, id, id * 10);
  const first = backfillBefore(raw, registry, null, 2);      // sees 4 and 3
  raw.prepare('UPDATE media_item SET title = ? WHERE id = 1').run('touched');
  const rest = backfillBefore(raw, registry, first.cursor, 10);
  const tail = tailSince(raw, registry, first.watermark, 100);
  const walked = [...first.ops, ...rest.ops].filter((o) => o.table === 'media_item')
    .map((o) => (o.value as { id: number }).id);
  assert.deepEqual(walked, [4, 3, 2, 1], 'the walk is ordered by created_at, which the update did not change');
  assert.ok(tail.ops.some((o) => (o.value as { id: number } | undefined)?.id === 1),
    'and the tail carries the change regardless');
});

test('a row created during the walk is never reached by it, and arrives on the tail', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 3; id += 1) addItem(raw, id, id * 10);
  const first = backfillBefore(raw, registry, null, 2);      // sees 3 and 2
  addItem(raw, 9, 999);                                       // newer than the walk's start
  const rest = backfillBefore(raw, registry, first.cursor, 10);
  const walked = [...first.ops, ...rest.ops].filter((o) => o.table === 'media_item')
    .map((o) => (o.value as { id: number }).id);
  assert.ok(!walked.includes(9), 'the backwards walk can never reach a row newer than its start');
  assert.ok(tailSince(raw, registry, first.watermark, 100).ops
    .some((o) => (o.value as { id: number } | undefined)?.id === 9), 'the tail delivers it');
});

test('a row deleted before the walk reaches it is never sent as a create', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 3; id += 1) addItem(raw, id, id * 10);
  const first = backfillBefore(raw, registry, null, 1);       // sees 3
  raw.prepare('DELETE FROM media_item WHERE id = 1').run();
  const rest = backfillBefore(raw, registry, first.cursor, 10);
  const walked = [...first.ops, ...rest.ops].filter((o) => o.table === 'media_item')
    .map((o) => (o.value as { id: number }).id);
  assert.ok(!walked.includes(1));
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/sync/backfill.test.ts`
Expected: FAIL — `Cannot find module '../../src/sync/backfill.ts'`.

- [ ] **Step 3: Write `backfill.ts`**

Page media items by `(created_at DESC, id DESC)` using a row-value keyset —
`WHERE (created_at, id) < (?, ?)` — which slice E measured to seek where the
`OR` form scans. For each page of items, emit the item, then its releases,
then its downloads, then its people and roles, then each plugin table's rows
for those items. Return the last item's `(created_at, id)` as the cursor, or
`null` when fewer than `limit` items came back.

`watermark` is `SELECT coalesce(max(id), 0) FROM sync_log`, read **before** the
items are selected, so that anything changing during the page is above it.

- [ ] **Step 4: Run the tests and the gate**

Run: `node --import tsx --conditions development --test packages/host/test/sync/backfill.test.ts`
Expected: PASS, 8 tests.

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 2137 pass 0 fail (2129 + 8); lint 0 at exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 5: Mutation A — prove the ordering is by an immutable key**

Copy `backfill.ts` aside. Change the ordering to `updated_at DESC, id DESC` and the keyset to match, run the focused test.
Expected: `a row changed during the walk reaches the client on the tail, not the walk` FAILS — the touched row moves to the head of the ordering and the walk's sequence is no longer `[4, 3, 2, 1]`. This is the mutation that proves §3.4, and the reason the walk cannot use the column that changes.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 6: Mutation B — prove the watermark is read before the page**

**Correction, recorded here so the next reader does not repeat the mistake:**
this step originally read "this may not fail — a single synchronous statement
sequence leaves no window for a change to land between the two reads, so the
test cannot observe the difference," and instructed reporting the mutation as
unobservable. That is wrong about the mechanism. There is no *thread* that can
interleave with a synchronous function, but `backfillBefore` takes `raw` as a
parameter, and nothing stops a test from handing it a `raw` whose `.prepare`
does something besides preparing a statement. A plain `Proxy` around the real
handle, intercepting `.prepare` and inserting a new row through the *real*
handle the moment the page's `rss_item` lookup runs, lands a write inside
exactly the window between "read the watermark" and "finish gathering the
page" — no `db.function()`, no worker thread, ordinary dependency injection on
a parameter the function already takes.

Write that test rather than skipping it: seed two media items, wrap `raw` in
such a `Proxy`, and inside the wrapped `.prepare`, on the first call whose SQL
touches `rss_item`, insert a third media item (`created_at` newer than
either) through the unwrapped handle. Assert two things — asserting only the
second would pass for the wrong reason if the walk happened to pick the row up
on its own:
1. the returned `watermark` is strictly below the concurrent write's
   `sync_log` row id;
2. `tailSince` from that `watermark` delivers the concurrently-created row.

Measured against this implementation: correct code (watermark read first)
gives `watermark: 2` against the concurrent write's log id `3`, and the tail
from `watermark: 2` delivers it. With the watermark read moved to after the
page and its dependents are gathered, the same scenario gives `watermark: 3`
— at, not below, the concurrent write's log id — and the first assertion
above fails cleanly (`watermark (3) must be captured before the concurrent
write (log id 3), not after`), not a SQLite error or a crash.

Copy aside. Move the watermark read to after the items are selected and their
dependents gathered, run the focused test.
Expected: the test above FAILS on its first assertion, as measured. Restore
by copy-aside, `md5 -q`, re-run.

- [ ] **Step 7: Commit**

```bash
git add -- packages/host/src/sync/backfill.ts packages/host/test/sync/backfill.test.ts
git commit -m "Walk current state newest first, hydrating each group before anything references it" -- packages/host/src/sync/backfill.ts packages/host/test/sync/backfill.test.ts
```

---

### Task 7: The three plugins declare their tables

**Files:**
- Create: `packages/plugin-tv/src/sync.ts`, `packages/plugin-movie/src/sync.ts`, `packages/plugin-xxx/src/sync.ts`
- Modify: each plugin's `src/index.ts` (replace `synced: []`)
- Test: `packages/plugin-tv/test/sync.test.ts`, and the same for movie and xxx

**Interfaces:**
- Consumes: `SyncedTable<T>`, `TvRead`, `MovieRead`, `XxxRead`, `assertSyncedTableName`.
- Produces: `TV_SYNCED`, `MOVIE_SYNCED`, `XXX_SYNCED`, each a `readonly SyncedTable<…>[]`.

**What each declares.** TV: `tv_release`, `tv_season`, `tv_series`. Movie: `movie_detail`. XXX: `xxx_scene`, `xxx_site`. `details_json` is projected away in every read (spec §3.9) — a read returns the named fields of its `*Read` type and nothing else.

- [ ] **Step 1: Write the failing test for TV**

Create `packages/plugin-tv/test/sync.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TV_SYNCED } from '../src/sync.ts';
import { TV_PLUGIN_ID } from '../src/index.ts';

test('every declared table carries the plugin id as its prefix', () => {
  for (const table of TV_SYNCED) {
    assert.ok(table.table.startsWith(`${TV_PLUGIN_ID}_`), `${table.table} must be prefixed`);
  }
});

test('the declared set is exactly the tables the migrations create', () => {
  assert.deepEqual(
    TV_SYNCED.map((t) => t.table).toSorted(),
    ['tv_release', 'tv_season', 'tv_series'],
  );
});

test('a read never returns details_json', () => {
  for (const table of TV_SYNCED) {
    assert.ok(!JSON.stringify(table).includes('details_json'),
      `${table.table} must project details_json away`);
  }
});
```

The third assertion is weak — it inspects the declaration, not a result. Replace
it with a real one once `read` has a database to run against: insert a row whose
`details_json` is a recognisable marker, call `read`, and assert the marker
appears nowhere in the returned value. **Do that rather than keeping the weak
form**, and say so in the report.

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/plugin-tv/test/sync.test.ts`
Expected: FAIL — `Cannot find module '../src/sync.ts'`.

- [ ] **Step 3: Write the three `sync.ts` files**

Each exports an array of `SyncedTable`. A TV example, which the other two follow:

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { SyncedTable, TvRead } from '@pickarr/contract';

/**
 * What a client receives for a television item, and what it does not.
 *
 * `details_json` is projected away: it is the metadata provider's answer
 * verbatim, unbounded, and nothing in a view reads it (design spec §3.9).
 * Every field below is named, so a column added to `tv_release` later reaches
 * no client until someone decides it should.
 */
const release: SyncedTable<TvRead> = {
  table: 'tv_release',
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, TvRead> {
    if (ids.length === 0) return {};
    const holes = ids.map(() => '?').join(',');
    const rows = raw.prepare(`
      SELECT r.media_item_id AS mediaItemId, r.kind, r.episode_number AS episodeNumber,
             s.title AS seriesTitle, s.provider_ref AS seriesRef, n.season_number AS seasonNumber
      FROM tv_release r
      JOIN tv_series s ON s.id = r.series_id
      LEFT JOIN tv_season n ON n.id = r.season_id
      WHERE r.media_item_id IN (${holes})
    `).all(...ids);
    // … map each row into TvRead, keyed by mediaItemId …
  },
  rowsFor(raw, mediaItemIds) { /* … ids of tv_release rows for those media items … */ },
};

export const TV_SYNCED: readonly SyncedTable<unknown>[] = [release /*, season, series */];
```

Fill in the mapping and `rowsFor` for each table. Then replace `synced: []` in
each plugin's `createLookupPlugin({ … })` call with the exported array.

- [ ] **Step 4: Run the tests and the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 2146 pass 0 fail (2137 + 9, three per plugin); lint 0 at exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 5: Mutation — prove the projection is real**

Copy `packages/plugin-tv/src/sync.ts` aside. Add `details_json` to the `SELECT` and to the mapped object, run the focused test.
Expected: the strengthened `details_json` test FAILS, finding the marker in the returned value. If you kept the weak declaration-inspecting form, this mutation will **not** fail — which is why step 1 asks you to replace it.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 6: Commit**

```bash
git add -- packages/plugin-tv/src packages/plugin-tv/test packages/plugin-movie/src packages/plugin-movie/test packages/plugin-xxx/src packages/plugin-xxx/test
git commit -m "Declare each plugin's replicated tables, projecting the provider's raw answer away" -- packages/plugin-tv/src packages/plugin-tv/test packages/plugin-movie/src packages/plugin-movie/test packages/plugin-xxx/src packages/plugin-xxx/test
```

---

### Task 8: The two routes, and the triggers for plugin tables

**Files:**
- Create: `packages/host/src/api/sync-route.ts`
- Modify: `packages/host/src/api/server.ts` (two route entries, `SyncRegistry` on `ReadServerDeps`)
- Modify: `packages/host/src/host.ts:502` (install plugin triggers after `migratePlugin`)
- Modify: `packages/host/src/main.ts` (build the registry, pass it to the server)
- Test: `packages/host/test/api/sync-route.test.ts`, `packages/host/test/host.test.ts`

**Interfaces:**
- Consumes: `tailSince`, `backfillBefore`, `createSyncRegistry`, `installSyncTriggers`.
- Produces: `GET /api/sync?since=<n>` and `GET /api/sync/backfill?before=<createdAt>.<id>`, both `open: false`.

- [ ] **Step 1: Write the failing tests**

Add to a new `packages/host/test/api/sync-route.test.ts`, following the existing `server.test.ts` harness for starting a guarded server and signing in:

```ts
test('both sync routes require a session', async () => {
  // anonymous GET /api/sync and /api/sync/backfill each answer 401
});

test('the tail answers ops and a cursor', async () => {
  // sign in, seed a media item, GET /api/sync?since=0, expect one upsert
});

test('the backfill answers a page, a cursor and a watermark', async () => {
  // sign in, seed three items, GET /api/sync/backfill, expect newest first
});

test('a malformed cursor is refused rather than treated as zero', async () => {
  for (const since of ['abc', '-1', '1.5', '']) {
    // GET /api/sync?since=<since> answers 400, never a full resync
  }
});

test('plugin tables gain their triggers when the plugin is registered', () => {
  // a host built with a plugin declaring a synced table has that table's three triggers
});
```

Write these out fully against the existing harness — the shapes above name the
assertions, and `server.test.ts` shows how to start a server, sign in and issue
a guarded request.

- [ ] **Step 2: Run them to confirm they fail**

Run: `node --import tsx --conditions development --test packages/host/test/api/sync-route.test.ts`
Expected: FAIL — the routes answer the unknown-route 404.

- [ ] **Step 3: Write `sync-route.ts` and add the entries**

`sync-route.ts` parses and validates the cursors and calls `tailSince`/`backfillBefore`. **No SQL in it** — that is the constraint, and the reason this file exists rather than the logic living in `server.ts`.

A malformed `since` is a `400`, never a silent `0`: treating a bad cursor as the beginning would hand a client a full resync it never asked for, and it would look like success.

Two entries in `ROUTES`, both `open: false`:

```ts
  { path: '/api/sync', open: false, answer: ({ deps, params }) => syncAnswer(deps, params) },
  { path: '/api/sync/backfill', open: false, answer: ({ deps, params }) => backfillAnswer(deps, params) },
```

Check how `ROUTES` matches `/api/artwork/:kind/:mediaItemId` segment by segment
before adding `/api/sync/backfill` — confirm that a two-segment path under an
existing one-segment route does not shadow it, and say what you found.

- [ ] **Step 4: Install plugin triggers**

At `packages/host/src/host.ts:502`, after `migratePlugin(deps.raw, plugin.id, plugin.migrations)`:

```ts
      installSyncTriggers(deps.raw, plugin.synced.map((table) => table.table));
```

Triggers go in after the plugin's migrations, because the tables must exist
first. Installation is idempotent (`DROP TRIGGER IF EXISTS`), so a plugin
registered on every boot reinstalls rather than failing.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests pass 0 fail; lint 0 at exactly 124 warnings; build 0; hygiene 0. Report the final count.

- [ ] **Step 6: Mutation A — prove a malformed cursor is refused**

Copy `sync-route.ts` aside. Make the parse fall back to `0` on a bad value, run the focused test.
Expected: `a malformed cursor is refused rather than treated as zero` FAILS, answering 200 where 400 was expected.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 7: Mutation B — prove the guard covers both routes**

Copy `server.ts` aside. Change `/api/sync` to `open: true`, run the focused test.
Expected: `both sync routes require a session` FAILS, the anonymous request answering 200 with rows. That this leaks a replica of the library to an unauthenticated caller is why the assertion exists.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 8: Run the host for real**

Building is not running. Boot the host against a temp database, sign in, and fetch both routes:

```bash
D=$(mktemp -d)
printf '%s\n' '{"server":{"host":"127.0.0.1","port":8899},"database":{"path":"'"$D"'/pickarr.db"},"secrets":{"baseDir":"'"$D"'/secrets"}}' > "$D/pickarr.config.json"
mkdir -p "$D/secrets"
PICKARR_CONFIG="$D/pickarr.config.json" node --import tsx --conditions development packages/host/src/bin.ts &
sleep 3
curl -sS -o /dev/null -w 'health %{http_code}\n' http://127.0.0.1:8899/api/health
curl -sS -o /dev/null -w 'sync anonymous %{http_code}\n' http://127.0.0.1:8899/api/sync
kill %1
```

Expected: `health 200`, `sync anonymous 401`. Note `bin.ts`, not `main.ts` — `main.ts` runs nothing at module scope. Report what you saw and clean up `$D`.

- [ ] **Step 9: Commit**

```bash
git add -- packages/host/src/api/sync-route.ts packages/host/src/api/server.ts packages/host/src/host.ts packages/host/src/main.ts packages/host/test/api/sync-route.test.ts packages/host/test/host.test.ts
git commit -m "Serve the two cursors behind the session guard, and give a plugin's tables their triggers" -- packages/host/src/api/sync-route.ts packages/host/src/api/server.ts packages/host/src/host.ts packages/host/src/main.ts packages/host/test/api/sync-route.test.ts packages/host/test/host.test.ts
```

---

## After the last task

Check whether `docs/known-issues.md`, the auth spec's §6 configuration table, or the read-api spec now say something false — the sync routes are new guarded routes, and `/api/deletions` now overlaps the log's delete ops. Check, do not assume.
