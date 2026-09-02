# Pickarr 2.0 Plugin Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 2.0 plugin contract, the host services behind it, and the durable job runner that carries a multi-hop flow across a restart — validated by a test-double plugin rather than a real one.

**Architecture:** Two new workspace packages. `@pickarr/contract` is types only, so a plugin can depend on the contract without pulling in the host. `@pickarr/host` owns the shared Drizzle schema, the migration runner, the job runner, the per-hostname fetch queue, and `MediaWriter` — the single writer for shared rows. 1.x (`core`, `plugin-api`, `plugin-scenes`, `web`) is untouched and keeps working.

**Tech Stack:** TypeScript, `node:sqlite`, Drizzle ORM 1.0-rc with its `node-sqlite` driver, `node:test`, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-02-plugin-contract-design.md`

## Global Constraints

- Never use the `any` type. Never widen a type with a cast to silence an error.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on. Indexed and `Map.get` access is checked, never `!`-asserted — a deleted bounds check must be a compile error, not a runtime crash.
- `verbatimModuleSyntax` is on: type-only imports must be `import type`.
- `erasableSyntaxOnly` is on: **no enums, no namespaces, no parameter properties.** Use union types and plain assignments.
- `allowImportingTsExtensions` is on: intra-package imports carry the `.ts` extension, e.g. `from './jobs.ts'`.
- Prefer async APIs over sync twins. Inside an `async` function, `await` it.
- A comment false about the code beside it is a defect equal to a wrong line of code.
- Tests must be able to fail. Prove each by mutation, and **the mutation must change observable behaviour** — removing a guard whose behaviour is secured downstream cannot fail and does not count.
- **Ids are SQLite integer rowids** (`id INTEGER PRIMARY KEY`), never uuids. The read API's keyset pagination depends on monotonic orderable ids. Provider uuids are stored as references, never adopted as keys.
- **Every job handler must be idempotent.** Crash recovery returns claimed jobs to `ready`, so any handler may run twice.
- **Pin the exact Drizzle rc.** `node:sqlite` support exists only on the 1.0 pre-release line; `latest` (0.45.2) has no such driver.
- `drizzle({ client: myDatabaseSync })` — pass the client in the config object. Passing a `DatabaseSync` positionally silently opens a *separate* database, which with `:memory:` produces a baffling "no such table".
- Baseline to hold: `npm run lint` exit 0 with **124** warnings, `npm run typecheck` clean, `npm run test:server` **1450** passing, `npm run test:web` **377** passing, `npm run test-hygiene` exit 0. New tests add to `test:server`; nothing here may move `test:web`.
- Gate commands run from the repo root. **Redirect each to a file and grep the file** — piping a test run through `grep` hides the failing test's name and output.
- Commit messages: one declarative sentence, no `feat:`/`fix:` prefix, no trailer, no trailing period.

---

## File Structure

**`packages/contract/`** — types only, zero runtime, zero dependencies.
- `src/index.ts` — re-exports.
- `src/plugin.ts` — `MediaPlugin`, `PluginContext`, `MediaType`.
- `src/jobs.ts` — `JobHandler`, `JobQueue`, `JobRecord`.
- `src/media.ts` — `MediaWriter` and its `*Init` types, `Resolution`.
- `src/fetch.ts` — `HostFetch`.
- `src/migrations.ts` — `Migration`.

**`packages/host/`** — the runtime.
- `src/db/schema.ts` — Drizzle schema for shared tables.
- `src/db/open.ts` — opens `DatabaseSync`, applies PRAGMAs, wraps in Drizzle.
- `src/db/migrate.ts` — host migrations plus per-plugin tracking.
- `src/jobs/runner.ts` — claim, retry, backoff, dead-letter, crash recovery.
- `src/fetch/queue.ts` — per-hostname serialisation.
- `src/media/writer.ts` — `MediaWriter` implementation.
- `src/host.ts` — registration and dispatch.
- `src/index.ts` — re-exports.

Tests live in `packages/<name>/test/**/*.test.ts`, which the root `test:server`
glob already covers — no script change needed for tests. The root `build` script
lists packages explicitly and **must** gain both new ones.

---

### Task 1: The contract package

**Files:**
- Create: `packages/contract/package.json`, `packages/contract/tsconfig.json`, `packages/contract/src/{index,plugin,jobs,media,fetch,migrations}.ts`
- Test: `packages/contract/test/compose.test.ts`
- Modify: root `package.json` (add to the `build` script)

**Interfaces:**
- Consumes: nothing.
- Produces: everything below. Later tasks import these names exactly.

**A types-only package's test is a typecheck.** There is no runtime to assert on,
so the test is a fixture that implements `MediaPlugin` fully; if the contract does
not compose, `npm run typecheck` fails. That is a real assertion, not a formality —
it is what catches a `MediaWriter` method whose return type no handler can consume.

- [ ] **Step 1: Create the package files**

`packages/contract/package.json` — mirrors `packages/plugin-api/package.json`:

```json
{
  "name": "@pickarr/contract",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/index.js",
    "typecheck": "tsgo --noEmit -p tsconfig.json"
  }
}
```

`packages/contract/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

- [ ] **Step 2: Write the types**

`src/migrations.ts` — deliberately the same shape 1.x already uses
(`packages/core/src/db/migrations.ts`), so the mechanism is familiar:

```ts
import type { DatabaseSync } from 'node:sqlite';

/**
 * One schema change. The same shape 1.x uses, so a plugin author reading
 * either codebase sees one idea.
 *
 * `version` is per plugin, not global: two plugins may both have a version 1,
 * and the host tracks them separately (see `plugin_migrations`).
 */
export interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}
```

`src/media.ts`:

```ts
/**
 * What became of an rss item's identification.
 *
 * `refused` and `unresolved` are different and neither is an error. A refusal
 * is the parser service successfully identifying a non-media file — a subtitle
 * or sidecar — and is terminal: retrying it forever, or showing it to a reader
 * as a problem, are both wrong. `unresolved` means the name was not
 * recognised, which is the state a human might fix.
 */
export type Resolution = 'pending' | 'resolved' | 'refused' | 'unresolved';

export interface MediaItemInit {
  /** Which plugin owns this item. */
  pluginId: string;
  title: string;
  releaseDate: string | null;
  description: string | null;
}

export interface PosterInit {
  title: string | null;
  language: string | null;
  url: string;
  width: number;
  height: number;
}

export interface BackgroundInit {
  title: string | null;
  description: string | null;
  language: string | null;
  url: string;
  width: number;
  height: number;
}

export interface PersonInit {
  name: string;
  /** The provider's own person id, for de-duplicating across lookups. */
  providerRef: string;
}

export interface RoleInit {
  personId: number;
  role: string;
  /** The character's name where the provider gives one. */
  name: string | null;
  billingOrder: number | null;
}

/** The outcome of claiming a provider reference. See `MediaWriter`. */
export interface ProviderClaim {
  /** The media item that now owns the reference. */
  kept: number;
  /** The caller's item, if it lost and must not be used again. */
  dropped: number | null;
}

/**
 * The only way a plugin writes shared rows.
 *
 * Plugins use Drizzle freely on their own tables; shared tables have exactly
 * one writer so that the two invariants below cannot drift between plugins.
 */
export interface MediaWriter {
  createMediaItem(init: MediaItemInit): Promise<number>;

  /**
   * Claims `(provider, ref)` for `mediaItemId`, or reports who already holds it.
   *
   * This is the dedup step, and it is a race whenever two rss items resolve to
   * the same reference at once. A unique index on `(provider, provider_ref)`
   * makes losing the race a constraint violation this method resolves, rather
   * than something four plugins each have to lose gracefully.
   */
  claimProviderRef(mediaItemId: number, provider: string, ref: string): Promise<ProviderClaim>;

  /** Repoints an rss item at a different media item. */
  relinkRssItem(rssItemId: number, mediaItemId: number): Promise<void>;

  /** Deletes a media item that lost a provider-ref claim. */
  dropMediaItem(mediaItemId: number): Promise<void>;

  attachPoster(mediaItemId: number, poster: PosterInit): Promise<void>;
  attachBackground(mediaItemId: number, background: BackgroundInit): Promise<void>;
  upsertPerson(person: PersonInit): Promise<number>;
  attachRole(mediaItemId: number, role: RoleInit): Promise<void>;
  setResolution(rssItemId: number, resolution: Resolution, detail: string | null): Promise<void>;
}
```

`src/jobs.ts`:

```ts
export interface JobEnqueue {
  kind: string;
  payload: unknown;
  /** Epoch ms. Absent means as soon as a worker is free. */
  runAt?: number;
  /** Absent takes the host's default. */
  maxAttempts?: number;
}

export interface JobQueue {
  enqueue(job: JobEnqueue): Promise<number>;
}

export interface JobRecord {
  id: number;
  kind: string;
  payload: unknown;
  /** 1 on the first run. A handler seeing >1 is a retry or a crash recovery. */
  attempts: number;
}
```

`src/fetch.ts`:

```ts
/**
 * The only way a plugin reaches the network.
 *
 * Requests are serialised per hostname — one active at a time — and the
 * hostname is derived from the url, so a plugin cannot opt out. That is what
 * makes "one at a time per host" a property of the system rather than a habit.
 */
export interface HostFetch {
  json<T>(url: string, init?: RequestInit): Promise<T>;
  bytes(url: string, init?: RequestInit): Promise<Uint8Array>;
}
```

`src/plugin.ts`:

```ts
import type { HostFetch } from './fetch.ts';
import type { JobQueue, JobRecord } from './jobs.ts';
import type { MediaWriter } from './media.ts';
import type { Migration } from './migrations.ts';

export type MediaType = 'tv' | 'movie' | 'xxx' | 'book';

export interface DownloadedFile {
  path: string;
  sizeBytes: number;
  downloadClientId: number;
}

export interface PluginContext {
  /**
   * Drizzle over this plugin's own tables. Typed from the plugin's own schema,
   * which is why the host cannot type it: only the plugin knows the shape.
   */
  db: unknown;
  media: MediaWriter;
  jobs: JobQueue;
  fetch: HostFetch;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

export type JobHandler = (job: JobRecord, ctx: PluginContext) => Promise<void>;

/**
 * A media plugin.
 *
 * Three entry points, none optional: a plugin that cannot answer all three is
 * not a plugin. This does **not** reduce the number of entry points — `jobs` is
 * open-ended, so a plugin with eleven job kinds has eleven of them, behind
 * `JobHandler` rather than in this interface. What changes is that the host's
 * coupling is fixed at three, the handlers are uniform in shape, and a job kind
 * enqueued but not handled is a visible dead-letter row rather than a silently
 * absent method.
 */
export interface MediaPlugin {
  /** Also the required prefix for every table this plugin declares. */
  readonly id: string;
  readonly mediaType: MediaType;
  readonly migrations: readonly Migration[];
  readonly jobs: Readonly<Record<string, JobHandler>>;

  onNewRssItems(ids: readonly number[], ctx: PluginContext): Promise<void>;
  onDownloadedFile(file: DownloadedFile, ctx: PluginContext): Promise<void>;
  onDownloadRequest(rssItemId: number, ctx: PluginContext): Promise<void>;
}
```

`src/index.ts` re-exports all six modules with `export type { … } from './x.ts'`.

**On `PluginContext.db: unknown`** — the host cannot type a plugin's own Drizzle
handle, because the shape comes from the plugin's schema and the host has never
seen it. `unknown` forces the plugin to narrow it once, at its own boundary,
which is the honest place for that cast. Write that reason in the comment; a
reader will otherwise assume it is laziness.

- [ ] **Step 3: Write the composition test**

`packages/contract/test/compose.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobHandler, MediaPlugin, PluginContext } from '../src/index.ts';

/**
 * A full implementation of the contract, existing to prove the contract
 * composes. If a `MediaWriter` method returns something no handler can consume,
 * or an entry point's signature disagrees with `JobHandler`'s, this file stops
 * compiling — which is the assertion. `npm run typecheck` is the gate.
 */
const lookup: JobHandler = async (job, ctx) => {
  // The rss item id comes from the payload, not from `job.id`. Both are
  // numbers, so passing the job's own id would compile and be wrong — it would
  // set the resolution of whatever rss item happens to share that rowid. A
  // handler's payload is the only thing that knows which item it is about.
  const { rssItemId } = job.payload as { rssItemId: number };

  const mediaItemId = await ctx.media.createMediaItem({
    pluginId: 'fixture', title: 'A Title', releaseDate: null, description: null,
  });
  const claim = await ctx.media.claimProviderRef(mediaItemId, 'tmdb', 'movie:1');
  if (claim.dropped !== null) {
    await ctx.media.dropMediaItem(claim.dropped);
    await ctx.media.relinkRssItem(rssItemId, claim.kept);
  }
  const personId = await ctx.media.upsertPerson({ name: 'Someone', providerRef: 'p1' });
  await ctx.media.attachRole(claim.kept, { personId, role: 'cast', name: null, billingOrder: 0 });
  await ctx.media.setResolution(rssItemId, 'resolved', null);
};

const fixture: MediaPlugin = {
  id: 'fixture',
  mediaType: 'movie',
  migrations: [{ version: 1, up: () => {} }],
  jobs: { lookup },
  onNewRssItems: async (ids, ctx: PluginContext) => {
    await ctx.jobs.enqueue({ kind: 'lookup', payload: { ids } });
  },
  onDownloadedFile: async () => {},
  onDownloadRequest: async () => {},
};

test('the contract composes into a whole plugin', () => {
  // The compile is the assertion; this keeps the fixture from being pruned as
  // unused and states what the file is for.
  assert.equal(fixture.id, 'fixture');
  assert.equal(Object.keys(fixture.jobs).length, 1);
});
```

- [ ] **Step 4: Wire the package into the build and run the gate**

Add `-w @pickarr/contract` to the root `build` script. Then, each redirected to a
file and grepped from the file:

```bash
npm install > /tmp/t1i.log 2>&1; echo "install:$?"
npm run typecheck > /tmp/t1tc.log 2>&1; echo "typecheck:$?"
npm run test:server > /tmp/t1s.log 2>&1; grep -E "^ℹ (pass|fail)" /tmp/t1s.log
npm run lint > /tmp/t1l.log 2>&1; echo "lint:$?"; grep -c warning /tmp/t1l.log
npm run build > /tmp/t1b.log 2>&1; echo "build:$?"
```

Expected: typecheck clean, `test:server` 1450 + 1 = 1451 with `fail 0`, lint exit
0 at **124** warnings, build clean.

- [ ] **Step 5: Mutation-prove the composition test**

Change `MediaWriter.createMediaItem` to return `Promise<void>`. `npm run
typecheck` must fail in `compose.test.ts` at the `claimProviderRef(mediaItemId,
…)` call. Restore, confirm clean. Report both runs — a types-only package whose
test cannot fail is a file that does nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/contract package.json package-lock.json
git commit -m "Define the 2.0 plugin contract as types a plugin can depend on without the host"
```

---

### Task 2: The host package, shared schema, and migrations

**Files:**
- Create: `packages/host/package.json`, `packages/host/tsconfig.json`, `packages/host/src/db/{schema,open,migrate}.ts`, `packages/host/src/index.ts`
- Test: `packages/host/test/db/migrate.test.ts`
- Modify: root `package.json` (`build` script), root dependencies (Drizzle)

**Interfaces:**
- Consumes: `Migration` from `@pickarr/contract`.
- Produces:
  ```ts
  export function openDatabase(path: string): { raw: DatabaseSync; db: HostDb };
  export function openTestDatabase(): { raw: DatabaseSync; db: HostDb };
  export function migrateHost(raw: DatabaseSync): void;
  export function migratePlugin(raw: DatabaseSync, pluginId: string, migrations: readonly Migration[]): number;
  ```
  `HostDb` is the Drizzle instance type; export it as
  `export type HostDb = ReturnType<typeof drizzle>`.

**Install Drizzle pinned.** `node:sqlite` support exists only on the 1.0
pre-release line — `latest` is `0.45.2` and exports no such driver.

```bash
npm install drizzle-orm@1.0.0-rc.4 --save-exact
npm install -D drizzle-kit@1.0.0-rc.4 --save-exact
```

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost, migratePlugin } from '../../src/db/migrate.ts';

test('host migrations create the shared tables and are idempotent', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map((r) => String((r as { name: unknown }).name));
  for (const t of ['rss_feed', 'rss_item', 'media_item', 'person', 'role', 'jobs']) {
    assert.ok(names.includes(t), `missing ${t}`);
  }
  // Running again must not throw: the runner has to skip applied versions
  // rather than re-running CREATE TABLE.
  migrateHost(raw);
});

test('a plugin migration is tracked under its own id, so two plugins may both have version 1', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const applied = migratePlugin(raw, 'alpha', [
    { version: 1, up: (db) => db.exec('CREATE TABLE alpha_thing (id INTEGER PRIMARY KEY)') },
  ]);
  const alsoApplied = migratePlugin(raw, 'beta', [
    { version: 1, up: (db) => db.exec('CREATE TABLE beta_thing (id INTEGER PRIMARY KEY)') },
  ]);
  assert.equal(applied, 1);
  assert.equal(alsoApplied, 1, 'beta version 1 must apply even though alpha version 1 did');
});

test('a plugin migration added later applies only itself', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const first = [{ version: 1, up: (db: DatabaseSync) => db.exec('CREATE TABLE g_a (id INTEGER PRIMARY KEY)') }];
  migratePlugin(raw, 'gamma', first);
  let secondRan = 0;
  const both = [
    ...first,
    { version: 2, up: (db: DatabaseSync) => { secondRan += 1; db.exec('CREATE TABLE g_b (id INTEGER PRIMARY KEY)'); } },
  ];
  const applied = migratePlugin(raw, 'gamma', both);
  assert.equal(applied, 1, 'only version 2 was outstanding');
  assert.equal(secondRan, 1);
});

test('a plugin table not prefixed with the plugin id is refused', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  // Prefixing is what keeps two plugins from colliding on a table name, so it
  // is enforced rather than documented.
  assert.throws(
    () => migratePlugin(raw, 'delta', [
      { version: 1, up: (db) => db.exec('CREATE TABLE not_prefixed (id INTEGER PRIMARY KEY)') },
    ]),
    /prefix/i,
  );
});
```

- [ ] **Step 2: Run and confirm failure.**

Run: `npm run test:server > /tmp/t2.log 2>&1; grep -nE "migrate|not a function" /tmp/t2.log | head`

- [ ] **Step 3: Write the schema**

`src/db/schema.ts`, Drizzle over the shared tables the spec's §6 names. Include
the unique index `claimProviderRef` depends on:

```ts
import { sqliteTable, integer, text, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const mediaItem = sqliteTable('media_item', {
  id: integer('id').primaryKey(),
  pluginId: text('plugin_id').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  provider: text('provider'),
  providerRef: text('provider_ref'),
  title: text('title').notNull(),
  releaseDate: text('release_date'),
  description: text('description'),
}, (t) => [
  // The dedup's whole basis. Nullable while a lookup is outstanding, and
  // SQLite treats NULLs as distinct, so unclaimed rows do not collide.
  uniqueIndex('media_item_provider_ref').on(t.provider, t.providerRef),
]);

export const rssItem = sqliteTable('rss_item', {
  id: integer('id').primaryKey(),
  feedId: integer('feed_id').notNull().references(() => rssFeed.id),
  filename: text('filename').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  downloadType: text('download_type').notNull(),
  mediaItemId: integer('media_item_id').references(() => mediaItem.id),
  rankingScore: integer('ranking_score'),
  resolution: text('resolution').notNull(),
  resolutionDetail: text('resolution_detail'),
}, (t) => [
  // The client's update flow asks "what changed since", so updated_at leads.
  index('rss_item_updated').on(t.updatedAt, t.id),
]);
```

Write `rssFeed`, `person`, `role`, `alias`, `externalReference`, `poster`,
`background`, `logo`, `downloadClient`, `filepathMapping` and `jobs` in the same
style. `poster`/`background`/`logo` get tables here even though nothing populates
them until the image slice, because `MediaWriter.attachPoster` needs a
destination.

- [ ] **Step 4: Write `open.ts`**

```ts
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';

export type HostDb = ReturnType<typeof drizzle>;

/**
 * `{ client: raw }`, not `drizzle(raw)`. Passing the handle positionally is not
 * a supported form: it falls through to opening a *new* database, which with
 * `:memory:` gives two databases and a baffling "no such table".
 */
function wrap(raw: DatabaseSync): { raw: DatabaseSync; db: HostDb } {
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA journal_mode = WAL');
  return { raw, db: drizzle({ client: raw }) };
}

export function openDatabase(path: string): { raw: DatabaseSync; db: HostDb } {
  return wrap(new DatabaseSync(path));
}

export function openTestDatabase(): { raw: DatabaseSync; db: HostDb } {
  return wrap(new DatabaseSync(':memory:'));
}
```

- [ ] **Step 5: Write `migrate.ts`**

Host migrations as a numbered array, exactly 1.x's shape. Plus:

```ts
const PLUGIN_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS plugin_migrations (
  plugin_id  TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, version)
)`;

/**
 * Applies a plugin's outstanding migrations and returns how many ran.
 *
 * Versions are per plugin, so two plugins may both ship a version 1 — the
 * primary key is `(plugin_id, version)` rather than `version` alone.
 *
 * Table names must start with `<pluginId>_`. Enforced rather than documented,
 * because the failure it prevents is two plugins silently sharing a table.
 */
export function migratePlugin(
  raw: DatabaseSync,
  pluginId: string,
  migrations: readonly Migration[],
): number {
  raw.exec(PLUGIN_MIGRATIONS);
  const done = new Set(
    raw.prepare('SELECT version FROM plugin_migrations WHERE plugin_id = ?')
      .all(pluginId).map((r) => Number((r as { version: unknown }).version)),
  );
  let ran = 0;
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(migration.version)) continue;
    const before = tableNames(raw);
    migration.up(raw);
    for (const name of tableNames(raw)) {
      if (before.has(name)) continue;
      if (!name.startsWith(`${pluginId}_`)) {
        throw new Error(
          `plugin ${pluginId} migration ${migration.version} created table ${name}, ` +
          `which lacks the required ${pluginId}_ prefix`,
        );
      }
    }
    raw.prepare('INSERT INTO plugin_migrations (plugin_id, version, applied_at) VALUES (?, ?, ?)')
      .run(pluginId, migration.version, Date.now());
    ran += 1;
  }
  return ran;
}
```

`tableNames(raw)` returns a `Set<string>` from `sqlite_master`. Note the prefix
check runs **after** `up`, comparing before and after, so it catches a table
whatever statement created it rather than parsing SQL.

- [ ] **Step 6: Run the gate** — expect `test:server` 1451 + 4 = 1455, `fail 0`,
lint 124, typecheck clean.

- [ ] **Step 7: Mutation-prove all four**

- Skip the `done.has` check → the idempotency test fails on a duplicate `CREATE TABLE`.
- Make the primary key `version` alone → the two-plugins test fails.
- Return `migrations.length` instead of `ran` → the added-later test fails.
- Drop the prefix check → the refusal test fails.

- [ ] **Step 8: Commit**

```bash
git add packages/host package.json package-lock.json
git commit -m "Open the 2.0 database and apply host and per-plugin migrations under separate version tracks"
```

---

### Task 3: The job runner

**Files:**
- Create: `packages/host/src/jobs/runner.ts`
- Test: `packages/host/test/jobs/runner.test.ts`

**Interfaces:**
- Consumes: `openTestDatabase`, `migrateHost` (Task 2); `JobHandler`, `JobRecord` (Task 1).
- Produces:
  ```ts
  export interface RunnerOptions {
    now: () => number;                 // injected clock, so backoff is testable
    backoffMs: (attempts: number) => number;
    defaultMaxAttempts: number;
  }
  export function createRunner(raw: DatabaseSync, opts: RunnerOptions): Runner;
  export interface Runner {
    enqueue(pluginId: string, job: JobEnqueue): number;
    /** Claims and runs at most one job. Returns false when none was ready. */
    runOnce(handlers: (pluginId: string, kind: string) => JobHandler | undefined,
            ctxFor: (pluginId: string) => PluginContext): Promise<boolean>;
    /** Returns jobs left `running` by a crashed process to `ready`. */
    recover(): number;
  }
  ```

**The claim is one statement**, so two workers cannot take the same job even
though this is single-process today:

```sql
UPDATE jobs SET state = 'running', updated_at = :now
 WHERE id = (SELECT id FROM jobs
              WHERE state = 'ready' AND run_at <= :now
              ORDER BY run_at, id LIMIT 1)
RETURNING id, plugin_id, kind, payload_json, attempts, max_attempts
```

Verified working through Drizzle's `db.all<T>(sql\`…\`)` on the same handle.

- [ ] **Step 1: Write the failing tests**

```ts
test('a ready job is claimed, run, and marked done', async () => {});
test('a job whose run_at is in the future is not claimed', async () => {});
test('a throwing handler is retried with backoff written to run_at', async () => {
  // Assert on run_at, not on elapsed time: the clock is injected.
});
test('a handler that always throws reaches dead after max_attempts, and its row remains', async () => {
  // Dead-lettering means the row stays with last_error set. A job that
  // vanishes on failure is a job nobody can diagnose.
});
test('recover returns a job left running to ready', async () => {
  // Simulates a crash: claim a job, never finish it, start a new runner.
});
test('a job whose kind has no handler goes dead rather than silently vanishing', async () => {
  // This is what makes an unhandled job kind visible — the spec's argument for
  // why three entry points plus an open job map is safer than optional methods.
});
test('claiming takes the earliest run_at, then the lowest id', async () => {});
```

Write real bodies using `openTestDatabase()` and an injected `now` that the test
advances by assignment. Every test asserts on rows read back from `jobs`, never
on wall-clock time.

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement the runner**, with `attempts` incremented before the
handler runs so a crash still counts as an attempt — otherwise a handler that
crashes the process retries forever.
- [ ] **Step 4: Run the gate** — `test:server` 1455 + 7 = 1462.
- [ ] **Step 5: Mutation-prove all seven.** Notably: increment `attempts` *after*
the handler instead of before → the dead-letter test still passes but the
crash-recovery test loops; assert on `attempts` in the recovery test so the
difference is visible.
- [ ] **Step 6: Commit**

```bash
git add packages/host
git commit -m "Run plugin jobs durably, so a flow interrupted by a restart resumes instead of vanishing"
```

---

### Task 4: The per-hostname fetch queue

**Files:**
- Create: `packages/host/src/fetch/queue.ts`
- Test: `packages/host/test/fetch/queue.test.ts`

**Interfaces:**
- Consumes: `HostFetch` (Task 1).
- Produces: `export function createHostFetch(deps: { fetch: typeof globalThis.fetch }): HostFetch;`

Injecting `fetch` is what makes this testable without a server.

- [ ] **Step 1: Write the failing tests**

```ts
test('two requests to one hostname do not overlap', async () => {
  // Assert on observed concurrency, not on elapsed time: record enter/exit
  // around a deferred fetch and assert the max concurrent count was 1.
});
test('requests to different hostnames do overlap', async () => {
  // The whole point of keying the queue by host rather than globally.
});
test('a rejected request does not wedge its hostname queue', async () => {
  // The failure that would silently stop a plugin forever.
});
test('a non-2xx response rejects rather than returning a body', async () => {});
test('the queue is keyed by hostname, not by full url', async () => {
  // Two different paths on one host still serialise.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement** — a `Map<string, Promise<unknown>>` of per-host tails,
each request chaining onto its host's tail with `finally` releasing it so a
rejection cannot wedge the queue.
- [ ] **Step 4: Run the gate** — `test:server` 1462 + 5 = 1467.
- [ ] **Step 5: Mutation-prove all five.** Notably: key the map by full url → the
keyed-by-hostname test fails; drop the `finally` → the rejection test fails.
- [ ] **Step 6: Commit**

```bash
git add packages/host
git commit -m "Serialise outbound requests per hostname, so one slow host delays only its own queue"
```

---

### Task 5: MediaWriter

**Files:**
- Create: `packages/host/src/media/writer.ts`
- Test: `packages/host/test/media/writer.test.ts`

**Interfaces:**
- Consumes: Task 1's `MediaWriter` and `*Init` types; Task 2's schema and `HostDb`.
- Produces: `export function createMediaWriter(db: HostDb, now: () => number): MediaWriter;`

**`claimProviderRef` is the load-bearing method.** A UNIQUE violation on
`(provider, provider_ref)` surfaces from `node:sqlite` with **`errcode: 2067`**
(`SQLITE_CONSTRAINT_UNIQUE`), which is distinct from `errcode: 1` for a generic
logic error — verified. Catch **2067 specifically**; catching every
`ERR_SQLITE_ERROR` would swallow real failures as though they were lost races.

- [ ] **Step 1: Write the failing tests**

```ts
test('claiming an unheld provider ref keeps the caller and drops nothing', async () => {});
test('claiming a held provider ref keeps the holder and reports the caller as dropped', async () => {
  // The dedup. The caller must be told which id survived so it can relink.
});
test('a non-unique sqlite failure is not mistaken for a lost race', async () => {
  // Provoke a different constraint and assert the error propagates rather than
  // being reported as a dropped claim. Catching every ERR_SQLITE_ERROR here
  // would turn a real bug into a silent no-op.
});
test('two unclaimed items do not collide, because NULL refs are distinct in SQLite', async () => {});
test('relinkRssItem repoints the item and bumps updated_at', async () => {
  // updated_at is what the client's "what changed since" flow reads.
});
test('setResolution records refused and unresolved as different states', async () => {});
test('upsertPerson returns the same id for a repeated providerRef', async () => {});
test('dropMediaItem removes the loser and leaves the keeper', async () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** `claimProviderRef` attempts the update inside a
transaction; on 2067 it reads back the current holder and returns
`{ kept: holder, dropped: mediaItemId }`. Every mutating method sets
`updated_at` from the injected clock.
- [ ] **Step 4: Run the gate** — `test:server` 1467 + 8 = 1475.
- [ ] **Step 5: Mutation-prove all eight.** Notably: catch every
`ERR_SQLITE_ERROR` rather than 2067 → the non-unique-failure test fails; skip the
`updated_at` bump → the relink test fails.
- [ ] **Step 6: Commit**

```bash
git add packages/host
git commit -m "Give shared rows one writer, so the provider-ref dedup and the rss relink cannot drift between plugins"
```

---

### Task 6: Registration and dispatch

**Files:**
- Create: `packages/host/src/host.ts`
- Test: `packages/host/test/host.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export function createHost(deps: {
    raw: DatabaseSync; db: HostDb; fetch: HostFetch; now: () => number;
  }): Host;
  export interface Host {
    /** Applies the plugin's migrations and registers its handlers. */
    register(plugin: MediaPlugin): void;
    /** Dispatches to the plugin owning the feed those items came from. */
    notifyNewRssItems(ids: readonly number[]): Promise<void>;
    requestDownload(rssItemId: number): Promise<void>;
    runOnce(): Promise<boolean>;
    recover(): number;
  }
  ```

Plugins are **wired explicitly** — `register` is called from startup, not
discovered from a directory. That is what keeps `drizzle-kit`'s repo-scoped glob
sufficient.

- [ ] **Step 1: Write the failing tests**

```ts
test('registering a plugin applies its migrations', async () => {});
test('new rss items are dispatched to the plugin owning their feed', async () => {
  // Two plugins, two feeds: assert each sees only its own ids.
});
test('two plugins may register the same job kind without colliding', async () => {
  // Handlers are keyed by (pluginId, kind), which is why a job row carries
  // plugin_id at all.
});
test('a download request reaches the plugin owning that item\'s feed', async () => {});
test('registering two plugins with the same id is refused', async () => {});
test('an rss item whose feed has no registered plugin is reported, not silently skipped', async () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** `register` calls `migratePlugin` then stores handlers
under `(pluginId, kind)`. Dispatch reads each item's `feed_id`, maps feed →
plugin, and groups ids per plugin so each plugin's `onNewRssItems` is called once
with its own ids rather than once per item.
- [ ] **Step 4: Run the gate** — `test:server` 1475 + 6 = 1481.
- [ ] **Step 5: Mutation-prove all six.** Notably: key handlers by `kind` alone →
the same-job-kind test fails; call `onNewRssItems` once per item → the dispatch
test fails on the received array length.
- [ ] **Step 6: Commit**

```bash
git add packages/host
git commit -m "Register plugins explicitly and dispatch each feed's items to the plugin that owns it"
```

---

### Task 7: The test-double plugin and the five flow outcomes

**Files:**
- Create: `packages/host/test/double/plugin.ts`, `packages/host/test/double/flow.test.ts`
- Test: as above

**Interfaces:**
- Consumes: everything.
- Produces: nothing — this task is the contract's validation.

**This is what makes slice A honest.** The contract was designed before any real
plugin, so its only consumer here is a double. It therefore has to exercise every
outcome, not the happy path: a double that only proves a resolved lookup works
would leave four untested branches for the first real plugin to discover.

The double declares one table (`double_media`), one migration, and job kinds
`lookup` and `poll`. Its fake parser service returns a scripted batch response.

**The batch response shape matters and is easy to get wrong.** A batch **always
answers HTTP 200**, with each entry carrying its own `status` and `partial` flag —
so the response arriving tells you nothing about whether the answers did. Scan
each entry individually; the `202` never reaches us at the HTTP level because we
always batch.

- [ ] **Step 1: Write the failing tests**

```ts
test('a resolved entry writes the media item, its provider ref, its people, and resolution resolved', async () => {});
test('a refused entry is terminal: resolution refused, no retry enqueued, no media rows', async () => {
  // A refusal is a successful identification of a non-media file. Retrying it
  // forever, or surfacing it as a failure, are both wrong.
});
test('an unresolved entry records resolution unresolved and does not enqueue a retry', async () => {});
test('a partial entry enqueues a poll job carrying its lookupId, and its siblings proceed immediately', async () => {
  // The hop the original flow description had no step for. Assert both halves:
  // the poll exists, and the non-partial entries in the same batch are already
  // resolved rather than waiting for it.
});
test('the poll job completes the item once the fake service answers', async () => {});
test('two rss items resolving to one provider ref end up sharing one media item', async () => {
  // The dedup end to end: one media item survives, the loser is dropped, and
  // both rss items point at the survivor.
});
test('the whole flow resumes after a simulated crash mid-lookup', async () => {
  // Claim the lookup job, discard the runner, recover, run to completion, and
  // assert the result is identical to the uninterrupted run. This is what the
  // durable table is for and the only test that proves it.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement the double and its fake service.**
- [ ] **Step 4: Run the full gate** including `npm run build`, `npm run e2e` and
`npm run test-hygiene`. `test:server` 1481 + 7 = **1488**; `test:web` **377**
unchanged; `e2e` **25 passed** — nothing here touches 1.x, so any movement in
those two is a finding.
- [ ] **Step 5: Mutation-prove all seven.** Notably: treat `partial` as resolved →
the partial test fails; make the batch reader look at an HTTP status rather than
per-entry `status` → the partial test fails differently, and say which.
- [ ] **Step 6: Commit**

```bash
git add packages/host
git commit -m "Prove the contract composes by running every lookup outcome through a test-double plugin"
```

---

## Self-Review

**Spec coverage.** §1.1's six decisions → Global Constraints and Tasks 1-2. §1.2's
exclusions → no tasks, deliberately; `onDownloadedFile` exists in Task 1's type
with no caller, as the spec says. §2's evidence → Task 1's doc comments. §3 the
contract → Task 1. §4 `PluginContext`/`MediaWriter` → Tasks 1 and 5. §5 the job
runner → Task 3. §6 the fetch queue → Task 4. §7 persistence → Task 2, with the
verified Drizzle facts in Global Constraints. §8's three findings → Task 1's
`Resolution`, Task 7's partial and refusal tests. §9's flows → Tasks 6 and 7.
§10's testing → distributed, with Task 7 owning the five outcomes. §11's
consequences → the idempotency constraint is in Global Constraints; the rest are
consequences rather than work.

**Placeholder scan.** Tasks 3-7 list test *cases* as one-line skeletons with the
fixtures and assertion targets named, and say so. Every production step carries
real code except Task 2 step 3, which writes eleven more tables "in the same
style" as two fully-specified examples — repeating all eleven would be
transcription rather than instruction, and the two shown fix the idiom including
the unique index and the `updated_at` index. Tasks 3-6's implementation steps
describe behaviour with the exact SQL, signatures and error codes given rather
than full bodies. No "TBD", no "handle edge cases", no "similar to Task N".

**Type consistency.** `Migration { version, up(db) }` is Task 1's and Task 2
consumes it unchanged. `MediaWriter`'s methods in Task 1 are exactly what Task 5
implements and Task 7 calls. `JobEnqueue`/`JobRecord` are Task 1's; Task 3's
`Runner.enqueue` takes `(pluginId, JobEnqueue)` because the row carries
`plugin_id` — Task 1's `JobQueue.enqueue` takes only `JobEnqueue` because the
context already knows which plugin it belongs to. That asymmetry is deliberate
and is the one place two similar names differ; if it reads as a mistake, it needs
a comment rather than a rename.

**One thing recorded rather than resolved.** `PluginContext.db` is typed
`unknown`. The host genuinely cannot type a plugin's own Drizzle handle — the
shape lives in the plugin's schema, which the host has never seen — so the plugin
narrows it once at its own boundary. It is the weakest point in the contract's
typing and the first thing the first real plugin will complain about. The
alternative, making `MediaPlugin` generic over its schema, was not taken because
it would infect every host signature that touches a plugin with a type parameter
the host cannot supply.
