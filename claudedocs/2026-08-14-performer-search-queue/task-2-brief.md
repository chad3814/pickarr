### Task 2: The queue table, and the row that must be cleared

**Files:**
- Modify: `packages/core/src/db/migrations.ts:527` (append after `version: 7`)
- Create: `packages/core/src/db/performer-queue.ts`
- Modify: `packages/core/src/db/metadata.ts:387-390` (`clearGroupMetadata`)
- Test: `packages/core/test/db/performer-queue.test.ts` (create)

**Interfaces produced,** consumed by Tasks 5 and 6:

```ts
export interface PerformerQueueRow {
  groupId: number;
  requestedAt: number;
  attempts: number;
  nextAt: number;
  lastError: string | null;
}
export function insertPerformerSearch(db: DatabaseSync, groupId: number, now: number): boolean;
export function duePerformerQueue(db: DatabaseSync, now: number, limit: number): PerformerQueueRow[];
export function deferPerformerSearch(db: DatabaseSync, groupId: number, error: string, nextAt: number): void;
export function removePerformerSearch(db: DatabaseSync, groupId: number): void;
export function groupHasCast(db: DatabaseSync, groupId: number): boolean;
```

`insertPerformerSearch` returns `true` when it inserted, `false` when the group was already queued or already has a cast.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/db/performer-queue.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import {
  deferPerformerSearch,
  duePerformerQueue,
  groupHasCast,
  insertPerformerSearch,
  removePerformerSearch,
} from '../../src/db/performer-queue.ts';
import { clearGroupMetadata } from '../../src/db/metadata.ts';

/** One picked group holding one release, and nothing else. */
function seedGroup(db: DatabaseSync, id: number): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, ?, ?, 1)`,
  ).run(id, `g${id}`, `T${id}`, `https://indexer.invalid/${id}.nzb`);
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               created_at, list_rank_at)
     VALUES (?, 'test', ?, ?, ?, 'picked', 1, 1)`,
  ).run(id, `k${id}`, `{"title":"G${id}","fields":[]}`, `g${id}`);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (?, ?, ?, '{}', 100, 1)`,
  ).run(id, id, id);
}

/** Gives the group a cast, the way a confirmed scene answer does. */
function giveCast(db: DatabaseSync, groupId: number): void {
  db.prepare(
    `INSERT INTO performers (id, source, source_uuid, slug, name, kind, fetched_at)
     VALUES (?, 'theporndb', ?, 'someone', 'Someone', 'performer', 1)`,
  ).run(groupId, `uuid-${groupId}`);
  db.prepare(
    'INSERT INTO group_performers (group_id, performer_id, position) VALUES (?, ?, 0)',
  ).run(groupId, groupId);
}

test('a queued group comes back due once its next_at has passed', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);

  assert.equal(insertPerformerSearch(db, 1, 500), true);
  assert.deepEqual(duePerformerQueue(db, 499, 10), []);
  assert.deepEqual(
    duePerformerQueue(db, 500, 10).map((row) => row.groupId),
    [1],
  );
  db.close();
});

test('inserting twice keeps the first request rather than jumping the line', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  seedGroup(db, 2);
  insertPerformerSearch(db, 1, 100);
  insertPerformerSearch(db, 2, 200);

  // The second call must not move group 1's requested_at forward: the queue is
  // drained in (requested_at, group_id) order, so a re-request that reset the
  // stamp would let a repeatedly-settled group starve everything behind it.
  assert.equal(insertPerformerSearch(db, 1, 900), false);
  assert.deepEqual(
    duePerformerQueue(db, 1000, 10).map((row) => row.groupId),
    [1, 2],
  );
  assert.equal(duePerformerQueue(db, 1000, 10)[0]?.requestedAt, 100);
  db.close();
});

test('a group that already has a cast is not queued', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  giveCast(db, 1);

  assert.equal(groupHasCast(db, 1), true);
  assert.equal(insertPerformerSearch(db, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 1000, 10), []);
  db.close();
});

test('deferring bumps attempts and pushes next_at out', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  insertPerformerSearch(db, 1, 100);

  deferPerformerSearch(db, 1, 'provider returned HTTP 503', 5000);

  assert.deepEqual(duePerformerQueue(db, 4999, 10), []);
  const row = duePerformerQueue(db, 5000, 10)[0];
  assert.equal(row?.attempts, 1);
  assert.equal(row?.lastError, 'provider returned HTTP 503');
  db.close();
});

test('removing takes the row out for good', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  insertPerformerSearch(db, 1, 100);

  removePerformerSearch(db, 1);

  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('the limit is honoured, and it is the oldest request that survives it', () => {
  const db = openTestDatabase();
  for (const id of [1, 2, 3]) seedGroup(db, id);
  insertPerformerSearch(db, 3, 100);
  insertPerformerSearch(db, 1, 200);
  insertPerformerSearch(db, 2, 300);

  assert.deepEqual(
    duePerformerQueue(db, 1000, 2).map((row) => row.groupId),
    [3, 1],
  );
  db.close();
});

test('clearGroupMetadata removes the queue row, so deleting the group cannot fail the foreign key', () => {
  // docs/known-issues.md records this exact defect shipping twice: the group
  // tables reference media_groups with no cascade, so a merge's deleteGroup
  // returned a 500 for any group holding an invisible queue row. A new table
  // referencing media_groups re-creates it unless the clear hook knows.
  const db = openTestDatabase();
  seedGroup(db, 1);
  insertPerformerSearch(db, 1, 100);

  clearGroupMetadata(db, 1);

  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  // The delete is the point: this throws a FOREIGN KEY error if the row is
  // still there. `openTestDatabase` sets `PRAGMA foreign_keys = ON`.
  db.prepare('DELETE FROM releases WHERE group_id = ?').run(1);
  db.prepare('DELETE FROM media_groups WHERE id = ?').run(1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n'], 0);
  db.close();
});
```

- [ ] **Step 2: Run and watch them fail**

```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
node --import tsx --conditions development --test packages/core/test/db/performer-queue.test.ts
```

Expected: fails to resolve `../../src/db/performer-queue.ts`.

- [ ] **Step 3: Add the migration**

In `packages/core/src/db/migrations.ts`, append after the `version: 7` entry. **Use 8, and check first that no `version: 8` already exists** — the file carries two long comments about migrations colliding on a number, twice, because branches took the same one. `migrate` now refuses duplicates by name, so a collision is a hard stop rather than silent, but check anyway.

```ts
  {
    version: 8,
    up(db) {
      db.exec(`
        CREATE TABLE performer_queue (
          group_id     INTEGER PRIMARY KEY REFERENCES media_groups (id),
          requested_at INTEGER NOT NULL,
          attempts     INTEGER NOT NULL DEFAULT 0,
          next_at      INTEGER NOT NULL,
          last_error   TEXT
        );

        CREATE INDEX performer_queue_due ON performer_queue (next_at);
      `);
    },
  },
```

No backfill. The spec puts existing groups out of scope: only lookups that settle after this ships enqueue, and a backfill is a one-line insert later if the linking rate justifies it.

- [ ] **Step 4: Write the queue primitives**

Create `packages/core/src/db/performer-queue.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { maybeStr, num, type SqlRow } from './row.ts';

export interface PerformerQueueRow {
  groupId: number;
  requestedAt: number;
  attempts: number;
  nextAt: number;
  lastError: string | null;
}

/**
 * Whether the group already has performers attached.
 *
 * The whole reason this queue exists is groups a scene lookup left castless, so
 * this is the eligibility test — asked before queueing, and asked *again* inside
 * the transaction that writes a result, because a metadata refetch can attach a
 * real cast in between and `setGroupPerformers` deletes before it inserts.
 */
export function groupHasCast(db: DatabaseSync, groupId: number): boolean {
  return db.prepare('SELECT 1 AS hit FROM group_performers WHERE group_id = ? LIMIT 1')
    .get(groupId) !== undefined;
}

/**
 * Queues one group, answering whether it actually queued.
 *
 * `ON CONFLICT DO NOTHING` rather than an upsert, and that is the interesting
 * half: a group can settle repeatedly (a metadata refetch that confirms nothing,
 * again), and an upsert refreshing `requested_at` would move it to the back of
 * its own queue every time. `duePerformerQueue` drains in
 * `(requested_at, group_id)` order, so a row whose stamp kept moving forward
 * would let a repeatedly-settling group starve every row behind it. The first
 * request is the one that counts.
 *
 * The castless check is here rather than left to the caller because it is the
 * definition of eligibility and the caller is a loop; a check the caller
 * remembers is a check that holds on some paths. Whether the *plugin* has a
 * query to offer is a separate question, and it lives in `pipeline/performers.ts`
 * where the plugin registry is in hand — mirroring `metadataAnswerability`,
 * which likewise sits in the pipeline layer rather than in `db/`.
 */
export function insertPerformerSearch(db: DatabaseSync, groupId: number, now: number): boolean {
  if (groupHasCast(db, groupId)) return false;
  const result = db
    .prepare(
      `INSERT INTO performer_queue (group_id, requested_at, attempts, next_at)
       VALUES (?, ?, 0, ?) ON CONFLICT (group_id) DO NOTHING`,
    )
    .run(groupId, now, now);
  return Number(result.changes) > 0;
}

/**
 * Due rows, oldest request first — the same `(requested_at, group_id)` order
 * `dueMetadataQueue` uses, so a row cannot be permanently first in line while
 * its attempts never move. `pipeline/performers.ts` relies on that: a row whose
 * own write throws is deferred outside the failed transaction precisely so the
 * row behind it is reached on the next pass.
 */
export function duePerformerQueue(
  db: DatabaseSync,
  now: number,
  limit: number,
): PerformerQueueRow[] {
  return db
    .prepare(
      `SELECT group_id, requested_at, attempts, next_at, last_error
       FROM performer_queue WHERE next_at <= ? ORDER BY requested_at, group_id LIMIT ?`,
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

/** A search that could not be made. Attempts bump; the row stays. */
export function deferPerformerSearch(
  db: DatabaseSync,
  groupId: number,
  error: string,
  nextAt: number,
): void {
  db.prepare(
    `UPDATE performer_queue SET attempts = attempts + 1, last_error = ?, next_at = ?
     WHERE group_id = ?`,
  ).run(error, nextAt, groupId);
}

/**
 * A search that ran. The row goes, whether or not anything was linked.
 *
 * A search that ran and matched nothing **is** an answer — the rule
 * `resolve-sites.ts` and `runMetadataPass` both state — so leaving the row
 * queued would spend one provider request per pass, forever, rediscovering the
 * same silence.
 */
export function removePerformerSearch(db: DatabaseSync, groupId: number): void {
  db.prepare('DELETE FROM performer_queue WHERE group_id = ?').run(groupId);
}
```

- [ ] **Step 5: Teach `clearGroupMetadata` about the row**

In `packages/core/src/db/metadata.ts`, inside `clearGroupMetadata` (currently lines 387-390), add the delete alongside the existing four, and extend that function's doc comment to name this table. The reason belongs in the comment: the group tables reference `media_groups` with **no cascade**, so a merge's `deleteGroup` returns a foreign-key 500 for any group holding a queue row nobody can see — the defect `docs/known-issues.md` records shipping twice.

```ts
  db.prepare('DELETE FROM performer_queue WHERE group_id = ?').run(groupId);
```

Put it inside that function, not at its call sites. That is what makes every existing caller correct without touching any of them.

- [ ] **Step 6: Run the tests**

```
node --import tsx --conditions development --test packages/core/test/db/performer-queue.test.ts
npm run check
```

Expected: all new tests pass; the existing 813 + 165 still green.

- [ ] **Step 7: Prove the lifecycle test bites**

Comment out the `DELETE FROM performer_queue` line you just added to `clearGroupMetadata` and re-run. The `clearGroupMetadata removes the queue row` test must fail on the `DELETE FROM media_groups` line with a foreign-key error. Restore the line. Report the evidence.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/db/migrations.ts packages/core/src/db/performer-queue.ts \
        packages/core/src/db/metadata.ts packages/core/test/db/performer-queue.test.ts
git commit -m "Add the performer search queue table and clear it with the rest"
```

---

