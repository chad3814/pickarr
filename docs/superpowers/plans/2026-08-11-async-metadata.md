# Asynchronous scene metadata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich a browse card with canonical title, performers, date, running time, synopsis and cover art from ThePornDB, fetched off the ingest path and never touching the identity key.

**Architecture:** The SPA asks for metadata for the groups it rendered, over an explicit `POST`. Core queues those groups, and a scheduler-driven worker drains the queue sequentially, rate-limited, storing one answer per group forever — including "no match", which is what stops a lazy trigger re-asking. The plugin owns what to search for and what counts as a match; core owns the queue, the worker, the HTTP surface and the artwork cache.

**Tech Stack:** Node 24, TypeScript 7 (`tsgo`, typecheck only), `node:sqlite`, Fastify, React + Vite, `node:test` + tsx, Playwright, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-11-async-metadata-design.md`. Read it before Task 1; every "why" lives there and is not repeated here.

## Global Constraints

- **Do not commit.** Leave work in the working tree; the repo owner approves every commit.
- Node 24 is not the shell default: `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.
- **Verify with `npm run check`** (lint + typecheck + test). `npm run build` runs no typechecker.
- Baseline: **577 server / 62 web**, all green.
- Never use `any`, and never `unknown` as a declared field type — `unknown` is permitted only as the parameter of a defensive reader that narrows immediately, as `readSites` does.
- tsconfig sets `exactOptionalPropertyTypes`: an optional property must be **omitted**, not set to `undefined`. This bites when building `MetadataQuery`.
- Prefer async APIs. `fs.promises`, never `fs.*Sync` — the artwork writer shares an event loop with Fastify.
- Comments explain *why*, not *what*.
- When a test claims to pin a property, mutate the source to break it and confirm the test fails. Report the evidence.
- Web tests must not use `assert.equal(screen.queryByText(x), null)` — issue #40 records it OOM-killing the run. Use `assert.ok(!screen.queryByText(x))` instead.
- **`openTestDatabase()` already runs `migrate`.** Test snippets below do not call it again; where one does, it is deliberately testing a repeat run.

## Constants fixed by the spec

Copy these values exactly; do not re-derive them.

| Constant | Value | Where |
|---|---|---|
| `DATE_TOLERANCE_DAYS` | `2` | Task 6 |
| `MAX_POSTER_BYTES` | `5 * 1024 * 1024` | Task 8 |
| `POSTER_CONTENT_TYPES` | `image/jpeg`, `image/png`, `image/webp` | Task 8 |
| `MAX_BACKOFF_MS` | `6 * 60 * 60 * 1000` | Task 9 |
| `metadata.intervalSeconds` default | `5` | Task 10 |
| `metadata.perTick` default | `5` | Task 10 |

---

### Task 1: Migration 5 — the tables

**Files:**
- Modify: `packages/core/src/db/migrations.ts`
- Test: `packages/core/test/db/migrate.test.ts`

**Interfaces:**
- Produces: tables `group_metadata`, `metadata_queue`, `metadata_candidates`; column `discovered_sites.source_id`.

Migration 4 is `rekeySiteSegments` and is already applied. This is version **5**.

- [ ] **Step 1: Write the failing test**

```ts
test('migration 5 creates the metadata tables and the site id column', () => {
  const db = openTestDatabase();

  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row['name'])),
  );
  assert.ok(tables.has('group_metadata'));
  assert.ok(tables.has('metadata_queue'));
  assert.ok(tables.has('metadata_candidates'));

  const columns = db
    .prepare('PRAGMA table_info(discovered_sites)')
    .all()
    .map((row) => String(row['name']));
  assert.ok(columns.includes('source_id'));
});

test('migration 5 is idempotent across a second run', () => {
  // `openTestDatabase` already migrates, so this is the second run.
  const db = openTestDatabase();
  migrate(db);
  const applied = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => Number(row['version']));
  assert.deepEqual(applied, [1, 2, 3, 4, 5]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:server 2>&1 | grep -A5 "migration 5"`
Expected: FAIL — no `group_metadata` table.

- [ ] **Step 3: Add the migration**

In `migrations.ts`, after `DERIVE_UPGRADE_FLAG`:

```ts
/**
 * Metadata a group has been given by a remote service, and the queue of
 * groups still waiting to be asked about.
 *
 * A `group_metadata` row means *answered*. `state = 'none'` is a real answer —
 * "the service was asked and knows no such scene" — and is what stops a lazy,
 * browse-driven trigger from re-asking the same question on every page view.
 * The reasoning is `discovered_sites`', one table up, applied to scenes.
 *
 * `state` is a column rather than something inferred from `source_uuid IS
 * NULL`, because `discovered_sites` had to make its uuid nullable for a
 * provider that publishes no identifier: nullability there already means
 * "no identifier", so it cannot also mean "no match".
 *
 * A queue row is deleted the moment an answer is written, so the table stays
 * proportional to outstanding work rather than to history, and *pending* is
 * exactly *has a queue row*.
 *
 * `metadata_candidates` holds what was rejected and why. Nothing displays it.
 * It exists so a later merge-suggestion feature has evidence, and so the
 * confirmation rule can be measured rather than argued about.
 *
 * `discovered_sites.source_id` is the site's *integer* id. Migration 2 stored
 * only the uuid, reasoning that `GET /sites/<id>` and `GET /sites/<uuid>`
 * return the same record so a second column would be two columns for one
 * fact. True of fetching a site; not true of filtering scenes, where
 * `GET /scenes?site_id=` accepts only the integer. Nullable, and backfilled
 * for free from the `site` object embedded in any scene response.
 */
const SCENE_METADATA = `
CREATE TABLE group_metadata (
  group_id     INTEGER PRIMARY KEY REFERENCES media_groups (id),
  state        TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  source_uuid  TEXT,
  title        TEXT,
  performers   TEXT,
  release_date TEXT,
  duration_s   INTEGER,
  synopsis     TEXT,
  poster_url   TEXT,
  poster_path  TEXT,
  fetched_at   INTEGER NOT NULL
);

CREATE TABLE metadata_queue (
  group_id     INTEGER PRIMARY KEY REFERENCES media_groups (id),
  requested_at INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      INTEGER NOT NULL,
  last_error   TEXT
);
CREATE INDEX metadata_queue_due ON metadata_queue (next_at);

CREATE TABLE metadata_candidates (
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES media_groups (id),
  source      TEXT    NOT NULL,
  source_uuid TEXT,
  title       TEXT    NOT NULL,
  scene_date  TEXT,
  reason      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX metadata_candidates_group ON metadata_candidates (group_id);

ALTER TABLE discovered_sites ADD COLUMN source_id INTEGER;
`;
```

And append to the `migrations` array:

```ts
  {
    version: 5,
    up(db) {
      db.exec(SCENE_METADATA);
    },
  },
```

- [ ] **Step 4: Run and confirm green**

Run: `npm run test:server`
Expected: PASS, 579 tests.

- [ ] **Step 5: Report** — do not commit. Note the new test count.

---

### Task 2: Storage accessors

**Files:**
- Create: `packages/core/src/db/metadata.ts`
- Test: `packages/core/test/db/metadata.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's tables; `MetadataCandidate` from Task 4 — **implement Task 4 first if working out of order.**
- Produces:
  - `getGroupMetadata(db, groupId): GroupMetadata | undefined`
  - `metadataForGroups(db, groupIds: readonly number[]): Map<number, GroupMetadata>`
  - `enqueueMetadata(db, groupIds: readonly number[], now: number): EnqueueResult`
  - `dueMetadataQueue(db, now: number, limit: number): MetadataQueueRow[]`
  - `recordMetadataAnswer(db, input: MetadataAnswerInput): void`
  - `deferMetadata(db, groupId: number, error: string, nextAt: number): void`
  - `setPosterPath(db, groupId: number, posterPath: string): void`
  - types `GroupMetadata`, `MetadataQueueRow`, `EnqueueResult`, `MetadataAnswerInput`

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrate } from '../../src/db/migrate.ts';
import {
  dueMetadataQueue, enqueueMetadata, getGroupMetadata, metadataForGroups,
  recordMetadataAnswer, deferMetadata, setPosterPath,
} from '../../src/db/metadata.ts';

function withGroups(count: number) {
  const db = openTestDatabase();
  const insert = db.prepare(
    `INSERT INTO media_groups (plugin, identity_key, display, search_text, created_at, list_rank_at)
     VALUES ('@pickarr/plugin-scenes', ?, '{}', '', 0, 0)`,
  );
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    insert.run(`key-${i}`);
    ids.push(Number(db.prepare('SELECT last_insert_rowid() AS id').get()?.['id']));
  }
  return { db, ids };
}

test('enqueueing is idempotent and never re-asks an answered group', () => {
  const { db, ids } = withGroups(3);

  const first = enqueueMetadata(db, ids, 1_000);
  assert.deepEqual(first, { queued: 3, alreadyAnswered: 0, pending: 0 });

  // Same ids again: all three are already queued, none re-inserted.
  const second = enqueueMetadata(db, ids, 2_000);
  assert.deepEqual(second, { queued: 0, alreadyAnswered: 0, pending: 3 });

  // A negative answer is still an answer.
  recordMetadataAnswer(db, {
    groupId: ids[0]!, source: 'theporndb', confirmed: null, nearMisses: [], now: 3_000,
  });
  const third = enqueueMetadata(db, [ids[0]!], 4_000);
  assert.deepEqual(third, { queued: 0, alreadyAnswered: 1, pending: 0 });
});

test('an answer replaces the queue row in one transaction', () => {
  const { db, ids } = withGroups(1);
  const groupId = ids[0]!;
  enqueueMetadata(db, [groupId], 1_000);

  recordMetadataAnswer(db, {
    groupId,
    source: 'theporndb',
    confirmed: {
      sourceUuid: 'scene-uuid', title: 'A Scene', siteUuid: 'site-uuid', siteId: 1,
      siteName: 'Naughty Office', date: '2021-11-15', performers: ['Silvia Saige'],
      durationSeconds: 1000, synopsis: 'A synopsis', posterUrl: 'https://example.test/p.jpg',
    },
    nearMisses: [],
    now: 2_000,
  });

  assert.equal(dueMetadataQueue(db, 9_999, 10).length, 0);
  const stored = getGroupMetadata(db, groupId);
  assert.equal(stored?.state, 'confirmed');
  assert.deepEqual(stored?.performers, ['Silvia Saige']);
  assert.equal(stored?.durationSeconds, 1000);
});

test('near-misses are written with the answer and are not the answer', () => {
  const { db, ids } = withGroups(1);
  const groupId = ids[0]!;
  enqueueMetadata(db, [groupId], 1_000);

  recordMetadataAnswer(db, {
    groupId,
    source: 'theporndb',
    confirmed: null,
    nearMisses: [
      {
        candidate: {
          sourceUuid: 'other', title: 'Another Scene', siteUuid: null, siteId: null,
          siteName: 'Elsewhere', date: '2021-11-20', performers: [], durationSeconds: null,
          synopsis: null, posterUrl: null,
        },
        reason: 'date outside window',
      },
    ],
    now: 2_000,
  });

  assert.equal(getGroupMetadata(db, groupId)?.state, 'none');
  const rows = db
    .prepare('SELECT reason, title FROM metadata_candidates WHERE group_id = ?')
    .all(groupId);
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0]?.['reason']), 'date outside window');
});

test('a deferral keeps the queue row, counts the attempt, and moves next_at', () => {
  const { db, ids } = withGroups(1);
  const groupId = ids[0]!;
  enqueueMetadata(db, [groupId], 1_000);

  deferMetadata(db, groupId, 'ECONNRESET', 60_000);

  assert.equal(dueMetadataQueue(db, 30_000, 10).length, 0, 'not due yet');
  const due = dueMetadataQueue(db, 60_000, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.attempts, 1);
  assert.equal(due[0]?.lastError, 'ECONNRESET');
  assert.equal(getGroupMetadata(db, groupId), undefined, 'a failure is not an answer');
});

test('metadataForGroups reads a page in one query', () => {
  const { db, ids } = withGroups(3);
  for (const id of ids) {
    recordMetadataAnswer(db, {
      groupId: id, source: 'theporndb', confirmed: null, nearMisses: [], now: 1_000,
    });
  }
  const found = metadataForGroups(db, ids);
  assert.equal(found.size, 3);
  assert.equal(metadataForGroups(db, []).size, 0, 'no ids must not build an empty IN ()');
});

test('a poster path is set independently of the answer', () => {
  const { db, ids } = withGroups(1);
  const groupId = ids[0]!;
  recordMetadataAnswer(db, {
    groupId, source: 'theporndb', confirmed: null, nearMisses: [], now: 1_000,
  });
  setPosterPath(db, groupId, '7.jpg');
  assert.equal(getGroupMetadata(db, groupId)?.posterPath, '7.jpg');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run test:server 2>&1 | grep -B2 -A6 "metadata.test"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `db/metadata.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { MetadataCandidate, MetadataRejection } from '@pickarr/plugin-api';
import { maybeNum, maybeStr, num, str, type SqlRow } from './row.ts';

export interface GroupMetadata {
  groupId: number;
  state: 'confirmed' | 'none';
  source: string;
  sourceUuid: string | null;
  title: string | null;
  performers: string[];
  releaseDate: string | null;
  durationSeconds: number | null;
  synopsis: string | null;
  posterUrl: string | null;
  posterPath: string | null;
  fetchedAt: number;
}

export interface MetadataQueueRow {
  groupId: number;
  requestedAt: number;
  attempts: number;
  nextAt: number;
  lastError: string | null;
}

export interface EnqueueResult {
  queued: number;
  alreadyAnswered: number;
  pending: number;
}

export interface MetadataAnswerInput {
  readonly groupId: number;
  readonly source: string;
  readonly confirmed: MetadataCandidate | null;
  readonly nearMisses: readonly MetadataRejection[];
  readonly now: number;
}

/**
 * Performers round-trip as JSON rather than a delimited string because a
 * performer's name may contain any separator worth choosing.
 */
function readPerformers(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    // A row we cannot read is not a reason to fail a page of browse.
    return [];
  }
}

function toMetadata(row: SqlRow): GroupMetadata {
  const state = str(row, 'state');
  return {
    groupId: num(row, 'group_id'),
    state: state === 'confirmed' ? 'confirmed' : 'none',
    source: str(row, 'source'),
    sourceUuid: maybeStr(row, 'source_uuid'),
    title: maybeStr(row, 'title'),
    performers: readPerformers(maybeStr(row, 'performers')),
    releaseDate: maybeStr(row, 'release_date'),
    durationSeconds: maybeNum(row, 'duration_s'),
    synopsis: maybeStr(row, 'synopsis'),
    posterUrl: maybeStr(row, 'poster_url'),
    posterPath: maybeStr(row, 'poster_path'),
    fetchedAt: num(row, 'fetched_at'),
  };
}

const COLUMNS = `group_id, state, source, source_uuid, title, performers, release_date,
                 duration_s, synopsis, poster_url, poster_path, fetched_at`;

export function getGroupMetadata(db: DatabaseSync, groupId: number): GroupMetadata | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM group_metadata WHERE group_id = ?`).get(groupId);
  return row === undefined ? undefined : toMetadata(row as SqlRow);
}

/**
 * One query for a whole page. Issue #31 records `/api/downloads` issuing a
 * query per row and polling it every three seconds; browse must not acquire
 * the same defect while gaining this field.
 */
export function metadataForGroups(
  db: DatabaseSync,
  groupIds: readonly number[],
): Map<number, GroupMetadata> {
  const found = new Map<number, GroupMetadata>();
  if (groupIds.length === 0) return found;
  const holes = groupIds.map(() => '?').join(', ');
  for (const row of db
    .prepare(`SELECT ${COLUMNS} FROM group_metadata WHERE group_id IN (${holes})`)
    .all(...groupIds)) {
    const metadata = toMetadata(row as SqlRow);
    found.set(metadata.groupId, metadata);
  }
  return found;
}

/**
 * Queues only what has never been answered and is not already waiting.
 *
 * `alreadyAnswered` covers `state = 'none'` as much as a confirmation: the
 * service was asked and said no, and asking again on the next browse is
 * exactly the loop a lazy trigger invites.
 */
export function enqueueMetadata(
  db: DatabaseSync,
  groupIds: readonly number[],
  now: number,
): EnqueueResult {
  const result: EnqueueResult = { queued: 0, alreadyAnswered: 0, pending: 0 };
  if (groupIds.length === 0) return result;

  const answered = db.prepare('SELECT 1 AS hit FROM group_metadata WHERE group_id = ?');
  const waiting = db.prepare('SELECT 1 AS hit FROM metadata_queue WHERE group_id = ?');
  const insert = db.prepare(
    `INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at)
     VALUES (?, ?, 0, ?) ON CONFLICT (group_id) DO NOTHING`,
  );

  db.exec('BEGIN');
  try {
    for (const groupId of groupIds) {
      if (answered.get(groupId) !== undefined) {
        result.alreadyAnswered += 1;
        continue;
      }
      if (waiting.get(groupId) !== undefined) {
        result.pending += 1;
        continue;
      }
      insert.run(groupId, now, now);
      result.queued += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return result;
}

export function dueMetadataQueue(
  db: DatabaseSync,
  now: number,
  limit: number,
): MetadataQueueRow[] {
  return db
    .prepare(
      `SELECT group_id, requested_at, attempts, next_at, last_error
       FROM metadata_queue WHERE next_at <= ? ORDER BY requested_at, group_id LIMIT ?`,
    )
    .all(now, limit)
    .map((raw) => {
      const row = raw as SqlRow;
      return {
        groupId: num(row, 'group_id'),
        requestedAt: num(row, 'requested_at'),
        attempts: num(row, 'attempts'),
        nextAt: num(row, 'next_at'),
        lastError: maybeStr(row, 'last_error'),
      };
    });
}

/**
 * Writes the answer, its rejected candidates, and the removal of the queue row
 * as one transaction. A group is answered exactly once, so the candidate rows
 * cannot accumulate across retries.
 */
export function recordMetadataAnswer(db: DatabaseSync, input: MetadataAnswerInput): void {
  const { confirmed } = input;
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO group_metadata (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (group_id) DO NOTHING`,
    ).run(
      input.groupId,
      confirmed === null ? 'none' : 'confirmed',
      input.source,
      confirmed?.sourceUuid ?? null,
      confirmed?.title ?? null,
      confirmed === null ? null : JSON.stringify(confirmed.performers),
      confirmed?.date ?? null,
      confirmed?.durationSeconds ?? null,
      confirmed?.synopsis ?? null,
      confirmed?.posterUrl ?? null,
      input.now,
    );

    const candidate = db.prepare(
      `INSERT INTO metadata_candidates
         (group_id, source, source_uuid, title, scene_date, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const miss of input.nearMisses) {
      candidate.run(
        input.groupId,
        input.source,
        miss.candidate.sourceUuid,
        miss.candidate.title,
        miss.candidate.date,
        miss.reason,
        input.now,
      );
    }

    db.prepare('DELETE FROM metadata_queue WHERE group_id = ?').run(input.groupId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * A lookup that could not be made learned nothing, so no answer is written —
 * only the attempt counted and the retry pushed out. Caching a failure as a
 * negative would make an outage permanent, which is the rule
 * `resolveSitesForBatch` already follows for site lookups.
 */
export function deferMetadata(
  db: DatabaseSync,
  groupId: number,
  error: string,
  nextAt: number,
): void {
  db.prepare(
    `UPDATE metadata_queue SET attempts = attempts + 1, last_error = ?, next_at = ?
     WHERE group_id = ?`,
  ).run(error, nextAt, groupId);
}

export function setPosterPath(db: DatabaseSync, groupId: number, posterPath: string): void {
  db.prepare('UPDATE group_metadata SET poster_path = ? WHERE group_id = ?').run(
    posterPath,
    groupId,
  );
}
```

- [ ] **Step 4: Run and confirm green**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 5: Break one on purpose**

Change `enqueueMetadata` so `alreadyAnswered` also enqueues. Confirm the first test fails. Revert. Report the evidence.

---

### Task 3: The site's integer id

**Files:**
- Modify: `packages/core/src/db/sites.ts`
- Modify: `packages/core/src/clients/theporndb.ts` (`SiteSearchResult`, `readSites`)
- Test: `packages/core/test/db/sites-id.test.ts` (create)
- Test: `packages/core/test/clients/theporndb.test.ts` (extend)

**Interfaces:**
- Produces:
  - `DiscoveredSite.sourceId: number | null` and `DiscoveredSiteInput.sourceId?: number | null`
  - `siteIdForName(db, siteName: string): number | null`
  - `rememberSiteId(db, siteName: string, sourceId: number): void`
  - `SiteSearchResult.sourceId: number | null`

- [ ] **Step 1: Write the failing tests**

```ts
test('a discovered site remembers its integer id and answers by name', () => {
  const db = openTestDatabase();
  recordDiscoveredSite(
    db, 'naughty office',
    { site: 'Naughty Office', sourceUuid: 'site-uuid', sourceId: 1 },
    'theporndb', 1_000,
  );
  assert.equal(siteIdForName(db, 'Naughty Office'), 1);
  assert.equal(siteIdForName(db, 'Nobody'), null);
});

test('a site discovered before the column existed learns its id later', () => {
  const db = openTestDatabase();
  recordDiscoveredSite(db, 'bang bros', { site: 'Bang Bros', sourceUuid: 'u' }, 'theporndb', 1_000);
  assert.equal(siteIdForName(db, 'Bang Bros'), null);

  rememberSiteId(db, 'Bang Bros', 42);
  assert.equal(siteIdForName(db, 'Bang Bros'), 42);
});

test('rememberSiteId does not invent a row for a site nobody discovered', () => {
  const db = openTestDatabase();
  rememberSiteId(db, 'Configured Only', 7);
  assert.equal(siteIdForName(db, 'Configured Only'), null);
});
```

And in `theporndb.test.ts`:

```ts
test('a site search captures the integer id alongside the uuid', async () => {
  const client = createTpdbClient(CONFIG, fakeFetch({
    data: [{ name: 'Naughty Office', short_name: 'naughtyoffice', uuid: 'site-uuid', id: 1 }],
  }));
  const [site] = await client.searchSites('naughty office');
  assert.equal(site?.sourceUuid, 'site-uuid');
  assert.equal(site?.sourceId, 1);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm run test:server 2>&1 | grep -A6 "integer id"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `clients/theporndb.ts`, add to `SiteSearchResult`:

```ts
  /**
   * The service's *integer* id for this site. `GET /scenes?site_id=` accepts
   * only this form, never the uuid, which is why both are kept.
   */
  readonly sourceId: number | null;
```

and inside `readSites`'s loop, alongside `sourceUuid`:

```ts
    const rawId = (record as { id?: unknown }).id;
    const sourceId = typeof rawId === 'number' && Number.isInteger(rawId) ? rawId : null;
```

adding `sourceId` to the pushed object. Widen the `record` cast to include `id?: unknown`.

In `db/sites.ts`: add `sourceId: number | null` to `DiscoveredSite`, `sourceId?: number | null` to `DiscoveredSiteInput`, select and write `source_id` in the two existing functions (`found.sourceId ?? null`), map it with `maybeNum`, and add:

```ts
/**
 * The integer id for a site, by its canonical name.
 *
 * Keyed on `site` rather than `prefix` because several prefixes can confirm
 * one site — `bangbros ass` and `bangbros` both land on `Bang Bros` — and any
 * of their rows carries the same id. A site that came from configuration
 * rather than discovery has no row at all, and answers null: that group
 * searches with `q=` alone and is filtered on the result's own site object.
 */
export function siteIdForName(db: DatabaseSync, siteName: string): number | null {
  const row = db
    .prepare('SELECT source_id FROM discovered_sites WHERE site = ? AND source_id IS NOT NULL LIMIT 1')
    .get(siteName);
  return row === undefined ? null : Number(row['source_id']);
}

/**
 * Backfills the integer id from a scene response, which embeds the whole site
 * object. Deliberately does not insert: a site nobody has discovered has no
 * confirmed name to key on, and inventing a row here would record a discovery
 * that never happened.
 */
export function rememberSiteId(db: DatabaseSync, siteName: string, sourceId: number): void {
  db.prepare('UPDATE discovered_sites SET source_id = ? WHERE site = ? AND source_id IS NULL').run(
    sourceId,
    siteName,
  );
}
```

- [ ] **Step 4: Run and confirm green**

Run: `npm run check`
Expected: PASS. Existing `resolve-sites.test.ts` fakes construct `SiteSearchResult` — add `sourceId: null` to them.

- [ ] **Step 5: Report** — do not commit.

---

### Task 4: The plugin contract

**Files:**
- Modify: `packages/plugin-api/src/types.ts`
- Modify: `packages/plugin-api/src/index.ts` (re-export)
- Test: `packages/plugin-api/test/smoke.test.ts`

**Interfaces:**
- Produces: `GroupIdentity`, `MetadataQuery`, `MetadataCandidate`, `MetadataRejection`, `MetadataVerdict`, and the two optional hooks. Every later task depends on these names.

- [ ] **Step 1: Add the types**

```ts
/** A group as a metadata lookup sees it: its key, and what it displays. */
export interface GroupIdentity {
  readonly identityKey: string;
  readonly display: DisplayFields;
}

/**
 * What to ask a scene-metadata service about a group, and the axes an answer
 * must corroborate.
 *
 * The same shape of seam as `siteCandidates`: the plugin says what to ask and
 * what would count, the host decides how and when to ask. A group with no site
 * yields `null` rather than a title-only query — searching a title across every
 * site a service knows is how you confirm the wrong scene.
 */
export interface MetadataQuery {
  /** Search strings to try, in order. The first yielding a confirmation wins. */
  readonly queries: readonly string[];
  /** Canonical site name. The host resolves it to a provider id from its own cache. */
  readonly siteName?: string;
  /** The group's own date, ISO `yyyy-mm-dd`, when it has one. */
  readonly date?: string;
}

/** One scene as the metadata service describes it. */
export interface MetadataCandidate {
  readonly sourceUuid: string | null;
  readonly title: string;
  readonly siteUuid: string | null;
  readonly siteId: number | null;
  readonly siteName: string;
  readonly date: string | null;
  readonly performers: readonly string[];
  readonly durationSeconds: number | null;
  readonly synopsis: string | null;
  readonly posterUrl: string | null;
}

/** A candidate that was not believed, and the reason it was not. */
export interface MetadataRejection {
  readonly candidate: MetadataCandidate;
  readonly reason: string;
}

/**
 * `confirmed: null` with a populated `nearMisses` is the interesting outcome:
 * the service answered, nothing was believed, and the reasons are recorded so
 * the rule can be measured instead of argued about.
 */
export interface MetadataVerdict {
  readonly confirmed: MetadataCandidate | null;
  readonly nearMisses: readonly MetadataRejection[];
}
```

On `MediaTypePlugin`, after `learnSites`:

```ts
  /**
   * What to ask a scene-metadata service about this group. `null` means the
   * group cannot be looked up — no site, typically — and it is then never
   * queued.
   *
   * Unlike `siteCandidates`, nothing here reaches the identity key, which is
   * what makes the lookup safe to perform long after the group was created.
   */
  metadataQuery?(group: GroupIdentity): MetadataQuery | null;

  /**
   * Which candidate, if any, is this group's scene.
   *
   * Must be strict: a wrong confirmation puts another scene's performers on a
   * card and never says so, while a missed one merely leaves the card as it is
   * today. Rejections are returned rather than discarded.
   */
  confirmMetadata?(
    candidates: readonly MetadataCandidate[],
    query: MetadataQuery,
  ): MetadataVerdict;
```

- [ ] **Step 2: Re-export** from `packages/plugin-api/src/index.ts` alongside the existing type exports.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Report** — do not commit.

---

### Task 5: The scenes plugin says what to ask

**Files:**
- Create: `packages/plugin-scenes/src/metadata.ts`
- Modify: `packages/plugin-scenes/src/index.ts` (wire the hook)
- Test: `packages/plugin-scenes/test/metadata-query.test.ts` (create)

**Interfaces:**
- Consumes: Task 4's types.
- Produces: `sceneMetadataQuery(group: GroupIdentity): MetadataQuery | null`; `siteSegmentOf(identityKey: string): string`.

`display.subtitle` is the canonical site name (`parse.ts:859`), `display.title` the scene title, `display.date` an ISO date **only** when the anchor was a date — an episode number never populates it.

- [ ] **Step 1: Write the failing tests**

```ts
const DATED: GroupIdentity = {
  identityKey: 'naughtyoffice:2021-11-15:smokin-hot-brunette',
  display: {
    title: 'Smokin Hot Brunette', subtitle: 'Naughty Office', date: '2021-11-15',
    fields: [],
  },
};

test('a dated group asks by title, narrowed by site and date', () => {
  const query = sceneMetadataQuery(DATED);
  assert.deepEqual(query?.queries, ['Smokin Hot Brunette']);
  assert.equal(query?.siteName, 'Naughty Office');
  assert.equal(query?.date, '2021-11-15');
});

test('a group with no site is not askable', () => {
  const query = sceneMetadataQuery({
    identityKey: ':2021-11-15:x',
    display: { title: 'Some Scene', fields: [] },
  });
  assert.equal(query, null, 'a title-only search across every site confirms the wrong scene');
});

test('a dateless group still asks, and omits date rather than sending undefined', () => {
  const query = sceneMetadataQuery({
    identityKey: 'bralessforever::emma-g',
    display: { title: 'Emma G And Rocky Beach Days', subtitle: 'Braless Forever', fields: [] },
  });
  assert.equal(query?.date, undefined);
  assert.ok(!('date' in (query ?? {})), 'exactOptionalPropertyTypes: omit, do not set undefined');
});

test('the key exposes the site segment in comparison-key form', () => {
  assert.equal(siteSegmentOf('naughtyoffice:2021-11-15:x'), 'naughtyoffice');
  assert.equal(siteSegmentOf('::x'), '');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npm test -w @pickarr/plugin-scenes 2>&1 | grep -A4 "askable"` — or the workspace's test command.
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { GroupIdentity, MetadataQuery } from '@pickarr/plugin-api';

/**
 * The key's site segment, which since migration 4 is exactly the
 * comparison-key form — lowercased, alphanumerics only. `parse.ts` builds it
 * with the same expression `siteComparisonKey` uses, so a provider's site name
 * can be compared against it with no normalisation on our side.
 */
export function siteSegmentOf(identityKey: string): string {
  return identityKey.split(':')[0] ?? '';
}

/**
 * A group is askable only when it has a site. `display.subtitle` is that site's
 * canonical name; a group without one came from a release whose site could not
 * be settled, and those are exactly the names the README says need a configured
 * site list to file correctly. Searching such a group's title across every site
 * the service knows would return same-titled scenes from elsewhere, and the
 * confirmation rule would be left with nothing to corroborate against.
 */
export function sceneMetadataQuery(group: GroupIdentity): MetadataQuery | null {
  const siteName = group.display.subtitle;
  if (siteName === undefined || siteName.length === 0) return null;

  const title = group.display.title.trim();
  if (title.length === 0) return null;

  // Built by spreading rather than assigning `undefined`: tsconfig sets
  // `exactOptionalPropertyTypes`, so an absent date must be an absent property.
  const date = group.display.date;
  return {
    queries: [title],
    siteName,
    ...(date === undefined ? {} : { date }),
  };
}
```

Wire into `index.ts` alongside the other hooks:

```ts
    metadataQuery: (group) => sceneMetadataQuery(group),
```

- [ ] **Step 4: Run and confirm green**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Report** — do not commit.

---

### Task 6: The confirmation rule

**Files:**
- Modify: `packages/plugin-scenes/src/metadata.ts`
- Modify: `packages/plugin-scenes/src/index.ts`
- Test: `packages/plugin-scenes/test/confirm-metadata.test.ts` (create)

**Interfaces:**
- Produces: `confirmSceneMetadata(candidates, query): MetadataVerdict`, `DATE_TOLERANCE_DAYS`.

This is the correctness core of the feature and gets the most cases. Spec §6.

- [ ] **Step 1: Write the failing tests**

```ts
const NAUGHTY = { siteUuid: 'site-uuid', siteId: 1, siteName: 'Naughty Office' };

function candidate(over: Partial<MetadataCandidate> = {}): MetadataCandidate {
  return {
    sourceUuid: 'scene-1', title: 'Smokin Hot Brunette', date: '2021-11-15',
    performers: ['Silvia Saige'], durationSeconds: 1000, synopsis: null, posterUrl: null,
    ...NAUGHTY, ...over,
  };
}

const DATED: MetadataQuery = {
  queries: ['Smokin Hot Brunette'], siteName: 'Naughty Office', date: '2021-11-15',
};

test('an exact site and date confirms', () => {
  const verdict = confirmSceneMetadata([candidate()], DATED);
  assert.equal(verdict.confirmed?.sourceUuid, 'scene-1');
  assert.equal(verdict.nearMisses.length, 0);
});

test('a date inside the window confirms; one outside does not', () => {
  const inside = confirmSceneMetadata([candidate({ date: '2021-11-17' })], DATED);
  assert.equal(inside.confirmed?.sourceUuid, 'scene-1');

  const outside = confirmSceneMetadata([candidate({ date: '2021-11-18' })], DATED);
  assert.equal(outside.confirmed, null);
  assert.equal(outside.nearMisses[0]?.reason, 'date outside window');
});

test('a different site is rejected however well the title matches', () => {
  const verdict = confirmSceneMetadata(
    [candidate({ siteUuid: 'other', siteId: 2, siteName: 'Elsewhere' })],
    DATED,
  );
  assert.equal(verdict.confirmed, null);
  assert.equal(verdict.nearMisses[0]?.reason, 'site differed');
});

test('site names match on the comparison key, not on spelling', () => {
  const verdict = confirmSceneMetadata(
    [candidate({ siteUuid: null, siteId: null, siteName: 'naughty-office' })],
    { queries: ['x'], siteName: 'Naughty Office', date: '2021-11-15' },
  );
  assert.equal(verdict.confirmed?.sourceUuid, 'scene-1');
});

test('an exact date beats a nearer-titled neighbour inside the window', () => {
  const verdict = confirmSceneMetadata(
    [
      candidate({ sourceUuid: 'neighbour', date: '2021-11-14', title: 'Smokin Hot Brunette' }),
      candidate({ sourceUuid: 'exact', date: '2021-11-15', title: 'Something Else' }),
    ],
    DATED,
  );
  assert.equal(verdict.confirmed?.sourceUuid, 'exact');
  assert.equal(verdict.nearMisses.length, 1, 'the loser is still recorded');
});

test('with no exact date the closest wins', () => {
  const verdict = confirmSceneMetadata(
    [
      candidate({ sourceUuid: 'far', date: '2021-11-17' }),
      candidate({ sourceUuid: 'near', date: '2021-11-16' }),
    ],
    DATED,
  );
  assert.equal(verdict.confirmed?.sourceUuid, 'near');
});

test('equally close candidates are broken by title', () => {
  const verdict = confirmSceneMetadata(
    [
      candidate({ sourceUuid: 'wrong-title', date: '2021-11-14', title: 'Another Thing' }),
      candidate({ sourceUuid: 'right-title', date: '2021-11-16', title: 'Smokin Hot Brunette' }),
    ],
    DATED,
  );
  assert.equal(verdict.confirmed?.sourceUuid, 'right-title');
});

test('two indistinguishable candidates confirm nothing', () => {
  const verdict = confirmSceneMetadata(
    [
      candidate({ sourceUuid: 'a', date: '2021-11-14', title: 'Neither Matches' }),
      candidate({ sourceUuid: 'b', date: '2021-11-16', title: 'Nor Does This' }),
    ],
    DATED,
  );
  assert.equal(verdict.confirmed, null, 'a daily-publishing site must not be guessed at');
  assert.equal(verdict.nearMisses.length, 2);
  assert.ok(verdict.nearMisses.every((m) => m.reason.startsWith('ambiguous: 2 candidates')));
});

test('a dateless group needs the title to match exactly', () => {
  const query: MetadataQuery = { queries: ['Emma G'], siteName: 'Naughty Office' };
  const matching = confirmSceneMetadata([candidate({ title: 'Emma G', date: null })], query);
  assert.equal(matching.confirmed?.sourceUuid, 'scene-1');

  const not = confirmSceneMetadata([candidate({ title: 'Emma H', date: null })], query);
  assert.equal(not.confirmed, null);
  assert.equal(not.nearMisses[0]?.reason, 'title differed');
});

test('a candidate with no date cannot satisfy a dated query', () => {
  const verdict = confirmSceneMetadata([candidate({ date: null })], DATED);
  assert.equal(verdict.confirmed, null);
  assert.equal(verdict.nearMisses[0]?.reason, 'date outside window');
});

test('no candidates is a clean negative, not an error', () => {
  const verdict = confirmSceneMetadata([], DATED);
  assert.equal(verdict.confirmed, null);
  assert.equal(verdict.nearMisses.length, 0);
});
```

- [ ] **Step 2: Run and watch them fail**

Expected: FAIL — `confirmSceneMetadata` not defined.

- [ ] **Step 3: Implement**

```ts
/**
 * How far a scene's published date may sit from the date in the release name.
 *
 * Scene dates are wiggly. The date a release name carries is the one whoever
 * packaged it used, which is not reliably the date the site published under:
 * timezones, staggered regional releases and a site's own backdating each move
 * it by a day or two.
 *
 * This is a filter, not a decision. A site publishing daily has five scenes
 * inside this window, so the window narrows the field and the tiebreak settles
 * it — and where the tiebreak cannot, nothing is confirmed.
 */
export const DATE_TOLERANCE_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function comparisonKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Whole days between two ISO dates, or `null` if either is unusable. */
function daysApart(left: string | null, right: string | null): number | null {
  if (left === null || right === null) return null;
  const a = Date.parse(`${left}T00:00:00Z`);
  const b = Date.parse(`${right}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.abs(a - b) / MS_PER_DAY;
}

function sameSite(candidate: MetadataCandidate, query: MetadataQuery): boolean {
  const wanted = query.siteName;
  if (wanted === undefined) return false;
  return comparisonKey(candidate.siteName) === comparisonKey(wanted);
}

export function confirmSceneMetadata(
  candidates: readonly MetadataCandidate[],
  query: MetadataQuery,
): MetadataVerdict {
  const nearMisses: MetadataRejection[] = [];
  const onSite: MetadataCandidate[] = [];

  for (const candidate of candidates) {
    if (sameSite(candidate, query)) onSite.push(candidate);
    else nearMisses.push({ candidate, reason: 'site differed' });
  }

  // Dateless group: the title is the only axis left, so it must be exact.
  if (query.date === undefined) {
    const wanted = comparisonKey(query.queries[0] ?? '');
    const hit = onSite.find((c) => comparisonKey(c.title) === wanted);
    for (const candidate of onSite) {
      if (candidate !== hit) nearMisses.push({ candidate, reason: 'title differed' });
    }
    return { confirmed: hit ?? null, nearMisses };
  }

  const inWindow: { candidate: MetadataCandidate; distance: number }[] = [];
  for (const candidate of onSite) {
    const distance = daysApart(candidate.date, query.date);
    if (distance === null || distance > DATE_TOLERANCE_DAYS) {
      nearMisses.push({ candidate, reason: 'date outside window' });
    } else {
      inWindow.push({ candidate, distance });
    }
  }

  if (inWindow.length === 0) return { confirmed: null, nearMisses };
  if (inWindow.length === 1) {
    return { confirmed: inWindow[0]!.candidate, nearMisses };
  }

  // Several plausible scenes. Narrow by closest date, then by title; confirm
  // only if exactly one survives. Picking by position in the response would
  // attach another scene's performers to the card and never say so.
  const closest = Math.min(...inWindow.map((entry) => entry.distance));
  let finalists = inWindow.filter((entry) => entry.distance === closest);

  if (finalists.length > 1) {
    const wanted = comparisonKey(query.queries[0] ?? '');
    const titled = finalists.filter((entry) => comparisonKey(entry.candidate.title) === wanted);
    if (titled.length > 0) finalists = titled;
  }

  const reason = `ambiguous: ${inWindow.length} candidates within date window`;
  if (finalists.length !== 1) {
    for (const entry of inWindow) nearMisses.push({ candidate: entry.candidate, reason });
    return { confirmed: null, nearMisses };
  }

  const winner = finalists[0]!.candidate;
  for (const entry of inWindow) {
    if (entry.candidate !== winner) nearMisses.push({ candidate: entry.candidate, reason });
  }
  return { confirmed: winner, nearMisses };
}
```

Wire into `index.ts`:

```ts
    confirmMetadata: (candidates, query) => confirmSceneMetadata(candidates, query),
```

- [ ] **Step 4: Run and confirm green**

Run: `npm run check`

- [ ] **Step 5: Break one on purpose**

Raise `DATE_TOLERANCE_DAYS` to 3 and confirm "a date inside the window confirms; one outside does not" fails. Revert. Then delete the `finalists.length !== 1` guard and confirm the ambiguity test fails. Revert. Report both.

---

### Task 7: Scene search

**Files:**
- Modify: `packages/core/src/clients/theporndb.ts`
- Test: `packages/core/test/clients/theporndb.test.ts`

**Interfaces:**
- Produces: `SceneLookupClient { source: string; searchScenes(query: string, siteId: number | null): Promise<readonly MetadataCandidate[]> }`; the `RateLimited` error class; `createTpdbClient` returns `SiteLookupClient & SceneLookupClient`.

Spec §7. Use the payload from the spec as the fixture.

- [ ] **Step 1: Write the failing tests**

```ts
const SCENE_BODY = {
  data: [{
    id: 'd284e2a0-789d-4e6c-beb9-6e61c24e8b84',
    _id: 0,
    title: 'Smokin Hot Brunette Silvia Saige',
    description: "Silvia Saige has been Sam\\'s therapist for a while",
    date: '2021-11-15',
    duration: 1000,
    poster: 'https://thumb.theporndb.net/office-couch.jpg',
    posters: { full: 'https://cdn/full.jpg', large: 'https://cdn/large.jpg' },
    image: 'https://images1.naughtycdn.com/h.jpg',
    performers: [{ name: 'Jessica Jaymes', full_name: 'Jessica Jaymes (2005)' }],
    site: { uuid: 'site-uuid', id: 1, name: 'Naughty Office', short_name: 'naughtyoffice' },
  }],
  meta: { total: 1, per_page: 25, current_page: 1, last: 1 },
};

test('a scene search maps the documented payload', async () => {
  const client = createTpdbClient(CONFIG, fakeFetch(SCENE_BODY));
  const [scene] = await client.searchScenes('Smokin Hot Brunette', 1);

  assert.equal(scene?.sourceUuid, 'd284e2a0-789d-4e6c-beb9-6e61c24e8b84',
    'a scene id is the uuid string; _id is the integer');
  assert.equal(scene?.siteId, 1);
  assert.equal(scene?.siteUuid, 'site-uuid');
  assert.equal(scene?.date, '2021-11-15');
  assert.equal(scene?.durationSeconds, 1000);
  assert.deepEqual(scene?.performers, ['Jessica Jaymes'],
    'name, not full_name, which carries a disambiguation suffix');
  assert.equal(scene?.posterUrl, 'https://cdn/large.jpg', 'posters.large is preferred');
});

test('the site id narrows the query and is omitted when unknown', async () => {
  const withId = fakeFetch(SCENE_BODY);
  const client = createTpdbClient(CONFIG, withId);
  await client.searchScenes('x', 1);
  assert.ok(withId.urls[0]?.includes('site_id=1'));

  const without = fakeFetch(SCENE_BODY);
  await createTpdbClient(CONFIG, without).searchScenes('x', null);
  assert.ok(!without.urls[0]?.includes('site_id'));
});

test('only one page is requested', async () => {
  const full = { ...SCENE_BODY, meta: { total: 210, per_page: 25, current_page: 1, last: 10 } };
  const fetchImpl = fakeFetch(full);
  await createTpdbClient(CONFIG, fetchImpl).searchScenes('x', 1);
  assert.equal(fetchImpl.urls.length, 1,
    'a title plus a site filter ranks the match on page one or the rule rejects it anyway');
});

test('a structurally broken entry yields no candidate rather than a partial one', async () => {
  const client = createTpdbClient(CONFIG, fakeFetch({ data: [{ id: 5 }, null, 'nonsense'] }));
  assert.deepEqual(await client.searchScenes('x', null), []);
});

test('a scene search failure redacts the bearer token', async () => {
  const client = createTpdbClient(CONFIG, () => {
    throw new Error(`connect failed with Bearer ${CONFIG.apiKey}`);
  });
  await assert.rejects(client.searchScenes('x', null), (error: Error) => {
    assert.ok(!error.message.includes(CONFIG.apiKey));
    return true;
  });
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement**

Add to `theporndb.ts`:

```ts
export interface SceneLookupClient {
  readonly source: string;
  /** `siteId` narrows the search; null when the site's integer id is unknown. */
  searchScenes(query: string, siteId: number | null): Promise<readonly MetadataCandidate[]>;
}

/**
 * A rate limit, distinguished from every other failure by its own type.
 *
 * The worker treats it differently: an ordinary failure defers one group, while
 * this one stops the whole pass. Five rows each spending a request to discover
 * the same limit is the thing being avoided, so the caller has to be able to
 * tell the two apart without parsing a message.
 */
export class RateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`rate limited for ${retryAfterMs}ms`);
    this.name = 'RateLimited';
  }
}

/** `Retry-After` in seconds, defaulting to a minute when absent or unreadable. */
function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;
}

/**
 * Poster sources in preference order.
 *
 * TPDB's own CDN first: the studio CDN fields (`image`, `poster_image`) point
 * at the site's own hosting, which is likelier to rotate paths or refuse a
 * foreign referrer. The documented `image` is 1279x719, so nothing downstream
 * may assume a portrait aspect ratio.
 */
function readPosterUrl(record: Record<string, unknown>): string | null {
  const posters = record['posters'];
  if (posters !== null && typeof posters === 'object') {
    for (const size of ['large', 'full'] as const) {
      const url = (posters as Record<string, unknown>)[size];
      if (typeof url === 'string' && url.length > 0) return url;
    }
  }
  for (const key of ['poster', 'image'] as const) {
    const url = record[key];
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}

function readPerformerNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    // `name`, never `full_name` — the latter carries a disambiguation suffix
    // such as `Jessica Jaymes (2005)`.
    const name = (entry as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  return names;
}

/**
 * Reads scenes out of a response body, tolerating everything we do not use.
 *
 * Note the id naming, which is inverted between the two objects and is not a
 * mistake to correct: on a **scene**, `id` is the uuid string and `_id` is the
 * integer; on the nested **site**, `uuid` is the uuid and `id` is the integer.
 */
function readScenes(body: unknown): MetadataCandidate[] {
  if (body === null || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const scenes: MetadataCandidate[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;

    const title = record['title'];
    if (typeof title !== 'string' || title.length === 0) continue;

    const site = record['site'];
    const siteRecord = site !== null && typeof site === 'object'
      ? (site as Record<string, unknown>)
      : {};
    const siteName = siteRecord['name'];
    const siteUuid = siteRecord['uuid'];
    const siteId = siteRecord['id'];
    const uuid = record['id'];
    const date = record['date'];
    const duration = record['duration'];
    const synopsis = record['description'];

    scenes.push({
      sourceUuid: typeof uuid === 'string' && uuid.length > 0 ? uuid : null,
      title,
      siteUuid: typeof siteUuid === 'string' && siteUuid.length > 0 ? siteUuid : null,
      siteId: typeof siteId === 'number' && Number.isInteger(siteId) ? siteId : null,
      siteName: typeof siteName === 'string' ? siteName : '',
      date: typeof date === 'string' && date.length > 0 ? date : null,
      performers: readPerformerNames(record['performers']),
      durationSeconds:
        typeof duration === 'number' && Number.isFinite(duration) ? duration : null,
      synopsis: typeof synopsis === 'string' && synopsis.length > 0 ? synopsis : null,
      posterUrl: readPosterUrl(record),
    });
  }
  return scenes;
}
```

And inside the object `createTpdbClient` returns, whose type becomes
`SiteLookupClient & SceneLookupClient`:

```ts
    /**
     * One page only, unlike `searchSites`. That walks up to `MAX_PAGES`
     * because one-word site queries return hundreds of results and the answer
     * can sit anywhere in them. A scene query is a full title plus a site
     * filter: a match that is not on page one is one the confirmation rule was
     * going to reject anyway, so paging would spend requests collecting
     * candidates we then discard.
     */
    async searchScenes(query: string, siteId: number | null) {
      if (query.trim().length === 0) return [];
      const site = siteId === null ? '' : `&site_id=${siteId}`;
      const url = `${base}/scenes?q=${encodeURIComponent(query)}${site}&per_page=${PER_PAGE}`;

      let response: Response;
      try {
        response = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
        });
      } catch (error) {
        throw new Error(
          `scene search for "${query}" failed: ${redactToken((error as Error).message, config.apiKey)}`,
        );
      }

      if (response.status === 429) {
        throw new RateLimited(retryAfterMs(response.headers.get('retry-after')));
      }
      if (!response.ok) {
        throw new Error(
          `scene search for "${query}" returned HTTP ${response.status} ${response.statusText}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        throw new Error(
          `scene search for "${query}" returned unreadable JSON: ${redactToken((error as Error).message, config.apiKey)}`,
        );
      }

      return readScenes(body);
    },
```

- [ ] **Step 4: Run and confirm green.** `npm run check`.

- [ ] **Step 5: Report** — do not commit.

---

### Task 8: The artwork cache

**Files:**
- Create: `packages/core/src/media/artwork.ts`
- Test: `packages/core/test/media/artwork.test.ts` (create)

**Interfaces:**
- Produces: `cachePoster(deps: ArtworkDeps, groupId: number, url: string): Promise<string | null>` returning the stored filename, or `null` when nothing was stored.
- `ArtworkDeps = { dir: string; fetchImpl: FetchImpl; log: (message: string) => void }`

Spec §10. Every constraint here is a security boundary; do not relax one to make a test pass.

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function imageResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

test('a jpeg is stored under the group id with the type-derived extension', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1, 2, 3]), 'image/jpeg')), log() {} },
    7,
    'https://example.test/whatever.php',
  );
  assert.equal(name, '7.jpg', 'the extension comes from the content type, never the URL');
  assert.deepEqual([...(await readFile(join(dir, '7.jpg')))], [1, 2, 3]);
});

test('a non-image content type is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.resolve(imageResponse(new Uint8Array([1]), 'text/html')), log() {} },
    7,
    'https://example.test/p.jpg',
  );
  assert.equal(name, null);
  assert.deepEqual(await readdir(dir), []);
});

test('a response past the byte cap is abandoned and leaves nothing behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const huge = new Uint8Array(MAX_POSTER_BYTES + 1);
  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.resolve(imageResponse(huge, 'image/png')), log() {} },
    7,
    'https://example.test/p.png',
  );
  assert.equal(name, null);
  assert.deepEqual(await readdir(dir), [], 'no temp file survives the abort');
});

test('a fetch failure is reported, not thrown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const logged: string[] = [];
  const name = await cachePoster(
    { dir, fetchImpl: () => Promise.reject(new Error('offline')), log: (m) => logged.push(m) },
    7,
    'https://example.test/p.jpg',
  );
  assert.equal(name, null, 'a poster failure must not fail the metadata answer');
  assert.equal(logged.length, 1);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement**

```ts
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchImpl } from '../clients/theporndb.ts';

/**
 * The largest poster that will be written.
 *
 * This is the only place Pickarr writes remote binary content to disk, so the
 * ceiling is a hard one: without it a hostile or merely broken response fills
 * the volume the SQLite database lives on.
 */
export const MAX_POSTER_BYTES = 5 * 1024 * 1024;

/**
 * Content types accepted, and the extension each is stored under.
 *
 * The extension is derived from the *validated* type and never from the URL,
 * so a URL ending `.php`, or containing `..%2f`, cannot steer the path.
 */
const POSTER_EXTENSIONS = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

export interface ArtworkDeps {
  readonly dir: string;
  readonly fetchImpl: FetchImpl;
  readonly log: (message: string) => void;
}

/**
 * Downloads one poster, returning the filename stored or `null`.
 *
 * Never throws: a poster is decoration, and a group's metadata answer must be
 * written whether or not its image could be fetched.
 *
 * The filename is `<group_id>.<ext>` — an integer from our own database, which
 * cannot contain a path separator. That is safer than sanitising a
 * provider-supplied string and needs no argument about whether the sanitising
 * is exhaustive.
 */
export async function cachePoster(
  deps: ArtworkDeps,
  groupId: number,
  url: string,
): Promise<string | null> {
  const temp = join(deps.dir, `.${groupId}.part`);
  try {
    await mkdir(deps.dir, { recursive: true });

    const response = await deps.fetchImpl(url);
    if (!response.ok) {
      deps.log(`poster for group ${groupId}: HTTP ${response.status}`);
      return null;
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const extension = POSTER_EXTENSIONS.get(contentType);
    if (extension === undefined) {
      deps.log(`poster for group ${groupId}: refused content type ${contentType || 'none'}`);
      return null;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_POSTER_BYTES) {
      deps.log(`poster for group ${groupId}: ${bytes.byteLength} bytes exceeds the cap`);
      return null;
    }

    // Temp then rename: a crash between the two leaves a dotfile, never a
    // truncated image that reads as valid.
    const name = `${groupId}.${extension}`;
    await writeFile(temp, bytes);
    await rename(temp, join(deps.dir, name));
    return name;
  } catch (error) {
    deps.log(`poster for group ${groupId} failed: ${(error as Error).message}`);
    await rm(temp, { force: true }).catch(() => undefined);
    return null;
  }
}
```

- [ ] **Step 4: Run and confirm green.** `npm run check`.

- [ ] **Step 5: Break one on purpose**

Change the extension to come from the URL. Confirm the first test fails. Revert. Report.

---

### Task 9: The worker

**Files:**
- Create: `packages/core/src/pipeline/metadata.ts`
- Test: `packages/core/test/pipeline/metadata.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2, 3, 5, 6, 7, 8.
- Produces: `runMetadataPass(deps: MetadataPassDeps): Promise<MetadataPassResult>`.

```ts
export interface MetadataPassDeps {
  db: DatabaseSync;
  client: SceneLookupClient | undefined;
  pluginFor(pluginPackage: string): MediaTypePlugin | null;
  artwork: ArtworkDeps;
  perTick: number;
  now: () => number;
  log(message: string): void;
}
export interface MetadataPassResult {
  looked: number; confirmed: number; none: number; deferred: number;
  cooldownUntil: number | null;
}
```

Spec §8.

- [ ] **Step 1: Write the failing tests**

Cover, each as its own `test(...)`:

```ts
test('a confirmation is stored with its poster and clears the queue row', async () => { /* … */ });

test('a search that matched nothing is cached as an answer', async () => {
  // after the pass, getGroupMetadata(...).state === 'none'
  // and a second enqueue reports alreadyAnswered: 1
});

test('a lookup that could not be made is not cached', async () => {
  // client throws; group has no group_metadata row; queue row survives with attempts 1
});

test('backoff grows and is capped', async () => {
  // drive attempts up; assert nextAt - now never exceeds MAX_BACKOFF_MS
});

test('a 429 stops the pass and leaves later rows untouched', async () => {
  const asked: string[] = [];
  // three queued groups; client throws a RateLimited on the first
  assert.equal(asked.length, 1, 'one request discovers the limit; five must not rediscover it');
  assert.ok(result.cooldownUntil !== null);
  // groups 2 and 3 still have their original next_at
});

test('perTick bounds one pass', async () => { /* queue 10, perTick 3, assert 3 lookups */ });

test('a scene response backfills the site integer id', async () => {
  // discovered_sites row with source_id NULL; after the pass it is 1
});

test('a poster failure still writes the metadata row', async () => { /* … */ });

test('a group whose plugin offers no hooks is answered, not retried forever', async () => {
  // plugin without metadataQuery: the queue row must not survive the pass
});
```

Use a fake `SceneLookupClient` recording queries, and the real scenes plugin. The
fake models a rate limit by throwing `RateLimited` from Task 7 — it is a typed
error precisely so this test can distinguish "stop the pass" from "defer one row"
without matching on a message.

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement `runMetadataPass`**

Shape, in order, one row at a time:

1. `dueMetadataQueue(db, now, perTick)`. Empty → return zeros.
2. For each row: load the group (`plugin`, `identity_key`, `display` JSON). A
   missing group is impossible via foreign key, but a group whose plugin is no
   longer configured is not — answer it as `none` so it leaves the queue.
3. `plugin.metadataQuery`/`confirmMetadata` absent, or `metadataQuery` returns
   `null` → `recordMetadataAnswer` with `confirmed: null`, `nearMisses: []`.
   Never leave a row the worker can only ever discard.
4. `siteIdForName(db, query.siteName)` → integer or null.
5. `client.searchScenes(query.queries[0], siteId)`. On `RateLimited`, set
   `cooldownUntil`, `deferMetadata` this row with the retry delay, `break`.
   On any other error, `deferMetadata` with `backoffFor(attempts)` and continue.
6. `plugin.confirmMetadata(candidates, query)` inside a try — a throwing plugin
   is defended against the way `prepareSafely` defends `parse`; treat a throw as
   a deferral, not an answer.
7. On a confirmation whose `siteId` is known and whose `siteName` matches the
   query's, `rememberSiteId`.
8. `recordMetadataAnswer(...)`.
9. On a confirmation with a `posterUrl`, `cachePoster` then `setPosterPath`.
   A `null` return is not an error.

```ts
/** Doubling backoff from one minute, capped so a long outage never stops retrying. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

function backoffFor(attempts: number): number {
  return Math.min(60_000 * 2 ** attempts, MAX_BACKOFF_MS);
}
```

Log one line per distinct failure per pass, and one summary line.

- [ ] **Step 4: Run and confirm green.** `npm run check`.

- [ ] **Step 5: Break one on purpose**

Make the 429 path `continue` instead of `break`. Confirm the 429 test fails. Revert. Report.

---

### Task 10: Configuration and wiring

**Files:**
- Modify: `packages/core/src/config/schema.ts`
- Modify: `packages/core/src/pipeline/scheduler.ts`
- Modify: `packages/core/src/main.ts`
- Test: `packages/core/test/config/load.test.ts`, `packages/core/test/pipeline/scheduler.test.ts`

**Interfaces:**
- Produces: `MetadataConfig`; `SchedulerDeps.runMetadata?: () => Promise<void>`; `SchedulerDeps.metadataIntervalMs?: number`.

- [ ] **Step 1: Write the failing tests**

```ts
test('the metadata block defaults when absent', () => {
  const config = configSchema.parse(MINIMAL);
  assert.equal(config.metadata.enabled, true);
  assert.equal(config.metadata.intervalSeconds, 5);
  assert.equal(config.metadata.perTick, 5);
});

test('a non-positive perTick is refused at startup', () => {
  assert.throws(() => configSchema.parse({ ...MINIMAL, metadata: { perTick: 0 } }));
});

test('the scheduler drops a metadata tick that overlaps the previous one', async () => {
  // Mirror the reconcile test: assert tryRun semantics, not run.
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement**

In `schema.ts`:

```ts
/**
 * The asynchronous scene-metadata worker.
 *
 * Credentials come from `siteLookup`, which already carries the key and base
 * URL for the same service; no `siteLookup` means no metadata, exactly as it
 * already means no site lookup. Renaming that block for accuracy would break
 * every documented config for a cosmetic gain.
 */
export const metadataSchema = z.object({
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().positive().default(5),
  /**
   * Groups looked up per pass. With the default interval that is a ceiling of
   * one request per second, before backoff or a rate-limit cooldown.
   */
  perTick: z.number().int().positive().default(5),
  artworkDir: z.string().min(1).optional(),
});

export type MetadataConfig = z.infer<typeof metadataSchema>;
```

Add to `configSchema`: `metadata: metadataSchema.default({}),`

In `scheduler.ts`: a third timer, guarded by its own mutex, using `tryRun` —
carry a comment pointing at the reconcile timer's reasoning rather than
restating it. Skip registering the timer when `runMetadata` is absent.

In `main.ts`: default `artworkDir` to `join(dirname(config.database.path), 'artwork')`,
build the `SceneLookupClient` from the same `createTpdbClient` instance already
built for `siteLookup`, and pass `runMetadata` only when
`config.metadata.enabled` and the client exists — logging once at startup when
metadata is idle for want of credentials.

- [ ] **Step 4: Run and confirm green.** `npm run check`.

- [ ] **Step 5: Report** — do not commit.

---

### Task 11: HTTP surface

**Files:**
- Modify: `packages/core/src/http/server.ts`
- Modify: `packages/core/src/http/views.ts`
- Test: `packages/core/test/http/metadata.test.ts` (create)
- Test: `packages/core/test/http/server.test.ts` (browse field)

**Interfaces:**
- Produces:

```ts
export type MetadataView =
  | { state: 'confirmed'; title: string | null; performers: string[];
      releaseDate: string | null; durationSeconds: number | null;
      synopsis: string | null; hasPoster: boolean }
  | { state: 'none' } | { state: 'pending' } | { state: 'absent' };
```

`GroupView` gains `metadata: MetadataView`.

- [ ] **Step 1: Write the failing tests**

```ts
test('requesting metadata queues only the unanswered', async () => {
  const response = await server.inject({
    method: 'POST', url: '/api/metadata/request', payload: { groupIds: [1, 2] },
  });
  assert.deepEqual(response.json(), { queued: 2, alreadyAnswered: 0, pending: 0 });
});

test('a request for a group whose plugin cannot look up is answered, not queued', async () => {
  // returns alreadyAnswered, and no metadata_queue row exists
});

test('an oversized id list is refused', async () => {
  const response = await server.inject({
    method: 'POST', url: '/api/metadata/request',
    payload: { groupIds: Array.from({ length: 500 }, (_, i) => i + 1) },
  });
  assert.equal(response.statusCode, 400);
});

test('metadata reads report pending, none and confirmed distinctly', async () => { /* … */ });

test('browse carries metadata and reads it in one query', async () => {
  // Count prepared statements, or wrap db.prepare, to assert a single
  // group_metadata query for a page of three groups. Issue #31 is the
  // precedent this must not repeat.
});

test('a poster route serves the cached file and 404s when absent', async () => { /* … */ });

test('the poster route cannot escape the artwork directory', async () => {
  const response = await server.inject({ method: 'GET', url: '/api/groups/..%2f..%2fetc%2fpasswd/poster' });
  assert.equal(response.statusCode, 400, 'the id param is an integer schema, so this never reaches the filesystem');
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement** the three routes with `zod` param/body schemas
  matching the existing `idParamsSchema` style, and extend `viewOf` to take a
  `Map<number, GroupMetadata>` so a page is read once.

- [ ] **Step 4: Run and confirm green.** `npm run check`.

- [ ] **Step 5: Report** — do not commit.

---

### Task 12: The card fills in

**Files:**
- Create: `packages/web/src/api/useGroupMetadata.ts`
- Modify: `packages/web/src/api/client.ts`, `packages/web/src/components/MediaCard.tsx`, `packages/web/src/routes/Browse.tsx`
- Test: `packages/web/test/useGroupMetadata.test.tsx` (create), `packages/web/test/MediaCard.test.tsx`

**Interfaces:**
- Produces: `useGroupMetadata(groupIds: readonly number[]): Map<number, MetadataView>`.

- [ ] **Step 1: Write the failing tests**

```tsx
test('a page of ids is requested once, not once per card', async () => { /* … */ });
test('polling stops once nothing is pending', async () => { /* … */ });
test('a re-render with the same ids costs no request', async () => {
  // useIdentityPreview.test has the precedent for this assertion
});
test('the card renders the panel only when metadata is confirmed', () => { /* … */ });
test('the panel tolerates a missing poster, synopsis and empty performers independently', () => { /* … */ });
test('the parsed title stays the card title when metadata disagrees', () => {
  // phase 1 is non-destructive; the panel is a second opinion
});
```

Use `assert.ok(!screen.queryByText(x))` — never `assert.equal(..., null)` (#40).

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** Poll with backoff; stop when no id is `pending`;
  abort in-flight requests on unmount. The panel renders below the existing
  display fields, and the poster is an `<img>` at `/api/groups/<id>/poster`
  with no fixed aspect ratio.

- [ ] **Step 4: Run and confirm green.** `npm run check`.

- [ ] **Step 5: Report** — do not commit.

---

### Task 13: End-to-end, and the documentation

**Files:**
- Create: `packages/e2e/tests/metadata.spec.ts`
- Modify: `README.md`
- Modify: `docs/known-issues.md`

- [ ] **Step 1: Write the e2e journey**

Using the harness from `packages/e2e/src/harness.ts`, with the provider stubbed:
browse a page, assert a card shows no metadata panel, then assert the panel
appears **without a reload**. This is the one part of the feature that exists
only in the seam between client and server — unit tests on both sides can pass
while the card never updates.

- [ ] **Step 2: Run it.** `npm test -w @pickarr/e2e`.

- [ ] **Step 3: Document**

README gains a "Scene metadata" section covering: what it fetches, that it is
lazy and only enriches what you browse, the `metadata` config block, that a
group with no confirmed site is never looked up, and the artwork cache — that
it grows and is never evicted, matching the existing `trashDir` note, with the
recovery `UPDATE` from spec §13 spelled out.

`docs/known-issues.md` gains the settled-reasoning entries from spec §13 that
are decisions rather than work; file the rest as issues only if the repo owner
asks.

- [ ] **Step 4: Full verification**

Run: `npm run check && npm run build`
Expected: PASS, no lint or type errors.

- [ ] **Step 5: Report** — do not commit. Summarise the final test counts against the 577/62 baseline.

---

## Notes for the controller

- **Task order matters in two places.** Task 4 defines types every later task imports, so it cannot slip; and Task 2's `db/metadata.ts` imports `MetadataCandidate` from Task 4, so if the tasks are dispatched out of order, Task 4 goes first.
- **Tasks 5 and 6 share a file** (`plugin-scenes/src/metadata.ts`). Dispatch them sequentially, not in parallel.
- **Task 6 is the one to review hardest.** Everything else is plumbing that fails loudly; a wrong confirmation rule fails quietly and puts another scene's performers on a card.
- Tasks 1–9 are server-only and independently verifiable with `npm run test:server`. Nothing is user-visible until Task 11.
- Nothing here commits. Snapshot each task with `git stash create` and diff consecutive snapshots.
- The spec's §13 known risks are deliberate, not oversights. Do not "fix" the artwork eviction gap or the ambiguity refusal inside this plan.
