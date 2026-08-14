# Performer search queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a group's scene lookup settles without a cast, queue a performer search on the first two words of its title and link the result when exactly one performer matches unambiguously.

**Architecture:** A new `performer_queue` table and drain pass, deliberately built as a near-copy of the existing `metadata_queue` + `runMetadataPass` machinery so the two behave the same under backoff, give-up and rate limiting. The "what to search for" decision is a plugin seam (`performerQuery`), so core never learns what a title's leading words mean. The match rule is a pure function, tested on its own, because it is the piece that can silently write a wrong cast.

**Tech Stack:** TypeScript (ESM, `.ts` import specifiers), `node:sqlite` `DatabaseSync`, `node:test` + `node:assert/strict`, oxlint, `tsgo` for typechecking. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-performer-search-queue-design.md` — read it before Task 1. This plan argues from it; where the plan refines a spec decision it says so explicitly (see Task 5's note on where the two refusals live).

## Global Constraints

- **Do not commit until a task's step says to.** Each task ends with its own commit. Do **not** push — the repo owner approves every push separately.
- **Node 24 is not the shell default.** Every command below assumes: `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`
- **Verify with `npm run check`** — that is `oxlint && npm run typecheck --workspaces && npm test`. `npm run build` runs no typechecker, so it is not a substitute.
- **Baseline before Task 1: 813 core tests, 165 web tests, all green.** If your baseline differs, stop and say so rather than absorbing someone else's failure.
- **Never use `any`.** Also never `unknown` as a shortcut for a real type. tsconfig sets `exactOptionalPropertyTypes`, `erasableSyntaxOnly`, `verbatimModuleSyntax` — an absent optional property must be *absent* (spread it in conditionally), never assigned `undefined`.
- **Two-space indent, semicolons always.**
- **Import specifiers keep the `.ts` extension** (`from './groups.ts'`). This is not a mistake in the existing code; match it.
- **Comments explain *why*, not what.** This codebase's comments are long and argue for the decision. Match that register — a comment restating the code will be sent back.
- **When a test claims to pin a property, mutate the source to break it and confirm the test fails.** Report that evidence in the task's summary. A test that passes against broken code pins nothing.
- **In web tests never write `assert.equal(screen.queryByText(x), null)`** — it deep-inspects a live DOM node to format the failure, burns ~75s and kills the run with no test named. No web tests in this plan, but the rule stands if you add one.

## File Structure

| File | Responsibility |
|---|---|
| `packages/plugin-api/src/types.ts` | **Modify.** Add the optional `performerQuery` method to `MediaTypePlugin`. |
| `packages/plugin-scenes/src/performer-query.ts` | **Create.** `scenePerformerQuery` — the first-two-words rule, and the only place it lives. |
| `packages/plugin-scenes/src/index.ts` | **Modify.** Wire `performerQuery` into the plugin object. |
| `packages/core/src/db/migrations.ts` | **Modify.** Migration `version: 8` creating `performer_queue`. |
| `packages/core/src/db/performer-queue.ts` | **Create.** SQL primitives: due rows, insert, defer, remove. No plugin knowledge. |
| `packages/core/src/db/metadata.ts` | **Modify.** `clearGroupMetadata` also clears `performer_queue` (spec §4.1). |
| `packages/core/src/clients/theporndb.ts` | **Modify.** `searchPerformers`, `PerformerLookupClient`, `PerformerSearchResult`, and the shared performer-field reader. |
| `packages/core/src/pipeline/pick-performer.ts` | **Create.** The tiered match rule, pure and dependency-free. |
| `packages/core/src/pipeline/performers.ts` | **Create.** `enqueuePerformerSearch`, `runPerformerPass`, `createPerformerRunner`. |
| `packages/core/src/pipeline/metadata.ts` | **Modify.** One enqueue call site after a row settles. |
| `packages/core/src/main.ts` | **Modify.** Build the runner and hand it to the metadata tick. |

Seven tasks, executed in strict numeric order. The real dependencies: Task 4 needs Task 3 (it imports `PerformerSearchResult` from the client module), Task 5 needs 1 and 2, Task 6 needs 2–5, Task 7 needs 6. Tasks 1–3 are mutually independent, but numeric order satisfies everything and is what this plan assumes.

---

### Task 1: The plugin says what to search for

**Files:**
- Modify: `packages/plugin-api/src/types.ts`
- Create: `packages/plugin-scenes/src/performer-query.ts`
- Modify: `packages/plugin-scenes/src/index.ts:56`
- Test: `packages/plugin-scenes/test/performer-query.test.ts` (create)

**Interfaces:**
- Consumes: `GroupIdentity` from `@pickarr/plugin-api` — `{ readonly identityKey: string; readonly display: DisplayFields }`.
- Produces: `MediaTypePlugin.performerQuery?(identity: GroupIdentity): string | null`, and `scenePerformerQuery(group: GroupIdentity): string | null` exported from `packages/plugin-scenes/src/performer-query.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-scenes/test/performer-query.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GroupIdentity } from '@pickarr/plugin-api';
import { scenePerformerQuery } from '../src/performer-query.ts';

/**
 * `display.title` is what `buildRelease` produces: the scene title with the
 * site in `display.subtitle`, the date in `display.date` and the quality
 * suffix already cut into `quality`. So these titles are what the parser
 * really hands over, not raw release names — a test built from raw names would
 * pin a stripping rule this function deliberately does not have.
 */
function identity(title: string): GroupIdentity {
  return { identityKey: 'k', display: { title, subtitle: 'Some Site', fields: [] } };
}

test('the query is the first two words of the title', () => {
  assert.equal(scenePerformerQuery(identity('Jessica Jaymes Loves It')), 'Jessica Jaymes');
});

test('a two-word title is used whole', () => {
  assert.equal(scenePerformerQuery(identity('Jessica Jaymes')), 'Jessica Jaymes');
});

test('a one-word title yields nothing rather than a one-word query', () => {
  // resolve-sites.ts records the cost of one-word queries at length: there is a
  // site called `Free`, so `Free.Use.Fantasy` confirms it on a one-word retry.
  // A one-word performer query fails the same way, and here the consequence is
  // a wrong name written onto a group.
  assert.equal(scenePerformerQuery(identity('Solo')), null);
});

test('an empty or whitespace title yields nothing', () => {
  assert.equal(scenePerformerQuery(identity('')), null);
  assert.equal(scenePerformerQuery(identity('   ')), null);
});

test('runs of whitespace collapse rather than producing an empty second word', () => {
  assert.equal(scenePerformerQuery(identity('Jessica   Jaymes  Loves')), 'Jessica Jaymes');
});

test('punctuation inside a word is kept, because the provider matches on the name', () => {
  // `O'Neil` and `Anne-Marie` are real names. Stripping punctuation here would
  // send a query the provider cannot match; normalisation for *comparison*
  // happens in the match rule, not in the query.
  assert.equal(scenePerformerQuery(identity("Katie O'Neil Returns")), "Katie O'Neil");
  assert.equal(scenePerformerQuery(identity('Anne-Marie Smith Again')), 'Anne-Marie Smith');
});
```

- [ ] **Step 2: Run it and watch it fail**

```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
TSX_TSCONFIG_PATH=packages/plugin-scenes/tsconfig.json node --import tsx --conditions development --test packages/plugin-scenes/test/performer-query.test.ts
```

Expected: fails to resolve `../src/performer-query.ts`.

- [ ] **Step 3: Add the plugin seam**

In `packages/plugin-api/src/types.ts`, on the `MediaTypePlugin` interface, beside `metadataQuery`:

```ts
  /**
   * What to search a performer directory for, given a group's identity, or
   * `null` when this group is not worth asking about.
   *
   * The same shape of seam as `siteCandidates` and `metadataQuery`: the plugin
   * says what to ask, the host decides how and when. Core never learns what a
   * title's leading words mean, which is what lets a media type with no notion
   * of performers opt out by simply not implementing this — rather than by core
   * special-casing it.
   *
   * A plugin returning a query is not claiming the query names a performer. It
   * is a guess, and the host's match rule is what decides whether to believe
   * any result; see the spec's §7.
   */
  performerQuery?(identity: GroupIdentity): string | null;
```

- [ ] **Step 4: Implement the scenes rule**

Create `packages/plugin-scenes/src/performer-query.ts`:

```ts
import type { GroupIdentity } from '@pickarr/plugin-api';

/**
 * The number of leading words a performer query is built from.
 *
 * Two, because a performer is billed as a first and last name and two words is
 * the shortest run that can distinguish one. One word is not merely weaker, it
 * is actively wrong: `resolve-sites.ts` documents `Free.Use.Fantasy` confirming
 * the real-but-wrong site `Free` on a one-word retry, and a one-word performer
 * query has the same failure with a worse consequence — a name written onto a
 * group's cast rather than a site guessed at.
 */
const WORDS = 2;

/**
 * The first two words of the group's title, or `null` when it has fewer.
 *
 * `display.title` is already the right text to cut: `buildRelease` puts the site
 * in `display.subtitle`, the date in `display.date`, and the quality suffix into
 * `quality` — so the title is the scene title alone and this function needs no
 * stripping rules of its own. Adding any here would be a second place that
 * decides what a title is.
 *
 * Punctuation inside a word is preserved. `Katie O'Neil` and `Anne-Marie Smith`
 * are how the provider spells those names, so a query with the punctuation
 * removed is a query it cannot match. Normalisation belongs to *comparison*,
 * which happens in the host's match rule against a returned name — not to the
 * query, which has to look like the thing being searched for.
 */
export function scenePerformerQuery(group: GroupIdentity): string | null {
  const words = group.display.title.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length < WORDS) return null;
  return words.slice(0, WORDS).join(' ');
}
```

- [ ] **Step 5: Wire it into the plugin**

In `packages/plugin-scenes/src/index.ts`, add the import beside the other metadata imports and the method beside `metadataQuery` (currently line 56):

```ts
    performerQuery: (group) => scenePerformerQuery(group),
```

- [ ] **Step 6: Run the test and the plugin's suite**

```
TSX_TSCONFIG_PATH=packages/plugin-scenes/tsconfig.json node --import tsx --conditions development --test packages/plugin-scenes/test/performer-query.test.ts
npm run check
```

Expected: the new file's tests pass; 813 core + 165 web still green, plus the new plugin tests.

- [ ] **Step 7: Prove the tests bite**

Change `WORDS` to `1` and re-run. The one-word test must fail. Change it back. Report this in your summary.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-api/src/types.ts packages/plugin-scenes/src/performer-query.ts \
        packages/plugin-scenes/src/index.ts packages/plugin-scenes/test/performer-query.test.ts
git commit -m "Ask the plugin what to search a performer directory for"
```

---

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

### Task 3: Ask the provider

**Files:**
- Modify: `packages/core/src/clients/theporndb.ts` (add near `searchScenes`; refactor `readPerformers` at 205-254)
- Test: `packages/core/test/clients/theporndb.test.ts` (extend)

**Interfaces produced,** consumed by Tasks 4 and 6:

```ts
export interface PerformerSearchResult {
  readonly performer: MetadataPerformer;
  readonly aliases: readonly string[];
}
export interface PerformerSearchPage {
  readonly results: readonly PerformerSearchResult[];
  /**
   * True when the provider reported pages beyond the one read. The caller's rule
   * is "exactly one exact match", which a truncated set can get wrong, so this
   * is the signal that makes the truncation loggable instead of silent. It lives
   * on the return value rather than being logged here because the client has no
   * `log` dependency — and giving it one to say this would be the wrong seam.
   */
  readonly truncated: boolean;
}
export interface PerformerLookupClient {
  readonly source: string;
  searchPerformers(query: string): Promise<PerformerSearchPage>;
}
```

`createTpdbClient`'s return type becomes `SiteLookupClient & SceneLookupClient & PerformerLookupClient`.

**The endpoint, confirmed against the live API:**

```
GET {baseUrl}/performers?q=<query>&page=1&per_page=100
Authorization: Bearer <apiKey>
Accept: application/json
```

**The response body** (fields this uses; everything else is tolerated and ignored):

```json
{ "data": [ { "id": "32aa4b68-…", "slug": "jessica-jaymes", "name": "Jessica Jaymes",
              "full_name": "Jessica Jaymes (2005)", "is_parent": true,
              "aliases": ["Jessi Jaymes"], "image": "https://…", "face": "https://…" } ],
  "meta": { "total": 210, "per_page": 25, "current_page": 3, "last": 10 } }
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/clients/theporndb.test.ts`. **Use the file's existing fixtures — do not invent new ones:** `respondWith(body, init?)` at line 39 returns a `FetchImpl & { urls: string[] }`, and `CONFIG` at line 28 is a complete `SiteLookupConfig` (it needs `type: 'theporndb'`, which a bare `{baseUrl, apiKey}` object omits and which would not typecheck). Every test below is written against those two.

```ts
test('searchPerformers reads a top-level result as a canonical performer', async () => {
  // `is_parent` is the whole point of this test. `readPerformers` derives kind
  // from a nested `parent`, which a scene's site-performers have and a top-level
  // /performers result does not — it *is* the parent. Reusing that reader here
  // would stamp every linked performer `performer-site` and point them all at
  // alias pages, which is invisible until a user clicks one.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{
        id: '32aa4b68-4dbe-49f2-92a5-0e54e5074f4b',
        slug: 'jessica-jaymes',
        name: 'Jessica Jaymes',
        full_name: 'Jessica Jaymes (2005)',
        is_parent: true,
        aliases: ['Jessi Jaymes'],
        image: 'https://cdn.invalid/image.jpg',
        face: 'https://cdn.invalid/face.jpg',
      }],
      meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  const page = await client.searchPerformers('Jessica Jaymes');

  assert.equal(page.truncated, false);
  assert.equal(page.results.length, 1);
  assert.deepEqual(page.results[0]?.performer, {
    sourceUuid: '32aa4b68-4dbe-49f2-92a5-0e54e5074f4b',
    slug: 'jessica-jaymes',
    // `name`, never `full_name`: the latter carries a disambiguation suffix that
    // could never equal a two-word query.
    name: 'Jessica Jaymes',
    kind: 'performer',
    faceUrl: 'https://cdn.invalid/face.jpg',
    imageUrl: 'https://cdn.invalid/image.jpg',
  });
  assert.deepEqual(page.results[0]?.aliases, ['Jessi Jaymes']);
});

test('a provider reporting more pages than were read is reported as truncated', () => {
  // The match rule turns on *how many* candidates match exactly. A second exact
  // match sitting on page two would turn "link nothing, this is ambiguous" into
  // a confident wrong link, so the caller has to be able to say it judged on a
  // partial set rather than doing so in silence.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true }],
      meta: { total: 210, per_page: 100, current_page: 1, last: 3 },
    }),
  );

  return client.searchPerformers('N').then((page) => assert.equal(page.truncated, true));
});

test('a body with no meta block is not treated as truncated', () => {
  // `truncated` is a claim that more pages exist. An absent `meta` is not
  // evidence of that, and defaulting it to true would log a truncation warning
  // on every search against a provider that stops sending the block.
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true }] }),
  );

  return client.searchPerformers('N').then((page) => assert.equal(page.truncated, false));
});

test('a result without is_parent is a site alias, not a canonical performer', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ id: 'u1', slug: '6061-alice-maze', name: 'Alice Maze', is_parent: false }],
      meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.equal(
    (await client.searchPerformers('Alice Maze')).results[0]?.performer.kind,
    'performer-site',
  );
});

test('a result missing its slug or uuid is dropped rather than stored empty', async () => {
  // The slug is the whole link, and an absent uuid collides with every other
  // such row under UNIQUE (source, source_uuid) — the same reason
  // `readPerformers` drops these.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [
        { id: 'u1', name: 'No Slug', is_parent: true },
        { slug: 'no-uuid', name: 'No Uuid', is_parent: true },
        { id: 'u2', slug: 'fine', name: 'Fine Person', is_parent: true },
      ],
      meta: { total: 3, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.deepEqual(
    (await client.searchPerformers('x')).results.map((r) => r.performer.name),
    ['Fine Person'],
  );
});

test('missing aliases read as an empty list, not undefined', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true }],
      meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.deepEqual((await client.searchPerformers('x')).results.map((r) => r.aliases), [[]]);
});

test('an empty query never reaches the provider', async () => {
  let called = false;
  const client = createTpdbClient(
    CONFIG,
    async (url) => { called = true; return respondWith({ data: [] })(url); },
  );

  assert.deepEqual(await client.searchPerformers('   '), { results: [], truncated: false });
  assert.equal(called, false);
});

test('the api key never appears in a searchPerformers error', async () => {
  const client = createTpdbClient(
    CONFIG,
    async () => { throw new Error(`connect ECONNREFUSED with Bearer ${API_KEY}`); },
  );

  await assert.rejects(
    () => client.searchPerformers('Jessica Jaymes'),
    (error: Error) => !error.message.includes(API_KEY),
  );
});

test('a 429 from searchPerformers is RateLimited with the Retry-After', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({}, { status: 429, headers: { 'Retry-After': '120' } }),
  );

  await assert.rejects(() => client.searchPerformers('x'), (error: Error) => {
    assert.ok(error instanceof RateLimited);
    assert.equal(error.retryAfterMs, 120_000);
    return true;
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/clients/theporndb.test.ts
```

Expected: `searchPerformers` is not a function.

- [ ] **Step 3: Factor the shared performer reader**

`readPerformers` (lines 205-254) and the new reader agree on five of six fields and differ only on how `kind` is decided. Extract the agreement rather than copying it — and keep `readPerformers`' existing doc comment, which explains the `parent` preference and is still true of that caller.

```ts
/**
 * The five fields both performer shapes spell identically, or `null` when the
 * record cannot be stored at all.
 *
 * `kind` is the parameter because it is the one thing the two endpoints disagree
 * about, and they disagree for a real reason: a scene's `performers[]` are site
 * aliases carrying a nested canonical `parent`, while a `/performers` search
 * returns the canonical entity itself, which says so with `is_parent`. One
 * reader deciding `kind` by looking for a `parent` would answer
 * `'performer-site'` for every search result — every linked performer pointed at
 * an alias page, and nothing to notice it by.
 *
 * A record missing slug, uuid or name yields `null` rather than a row with an
 * empty one: the slug is the whole link, and an absent uuid collides with every
 * other such record under `UNIQUE (source, source_uuid)`.
 */
function readPerformerFields(
  record: Record<string, unknown>,
  kind: MetadataPerformer['kind'],
  nameFallback: Record<string, unknown> | null = null,
): MetadataPerformer | null {
  const slug = str(record, 'slug');
  const sourceUuid = str(record, 'id');
  const name = str(record, 'name') ?? (nameFallback === null ? null : str(nameFallback, 'name'));
  if (slug === null || sourceUuid === null || name === null) return null;
  return { sourceUuid, slug, name, kind, faceUrl: str(record, 'face'), imageUrl: str(record, 'image') };
}
```

Then rewrite `readPerformers`' loop body to use it, passing `parent === null ? 'performer-site' : 'performer'` and `site` as the `nameFallback`. **Run the full suite here** — the existing scene-metadata tests are the proof this refactor changed no behaviour.

- [ ] **Step 4: Add the search method**

Add the two interfaces near `SceneLookupClient` (line 146), widen `createTpdbClient`'s return type, and add the method beside `searchScenes`. Model the body on `searchScenes` — one page, `RateLimited` on 429, `redactToken` on every thrown message — not on `searchSites`, which walks pages.

```ts
    /**
     * One page, like `searchScenes` and unlike `searchSites`' `MAX_PAGES` walk.
     *
     * `PER_PAGE` (100) rather than a smaller page, and that is a correctness
     * argument rather than a throughput one: the caller's rule is "exactly one
     * exact match", which is only honestly decidable over the results actually
     * seen. A narrow page hides a second exact match on page two and converts an
     * ambiguity — link nothing — into a confident wrong link. When `meta.last`
     * says there were more pages the caller is told, so a truncated judgement is
     * logged rather than silent.
     */
    async searchPerformers(query: string): Promise<PerformerSearchPage> {
      if (query.trim().length === 0) return { results: [], truncated: false };
      const url = `${base}/performers?q=${encodeURIComponent(query)}&page=1&per_page=${PER_PAGE}`;
      const signal = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
      const timedOut = abortRejection(signal);

      let response: Response;
      try {
        response = await Promise.race([
          fetchImpl(url, {
            headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
            signal,
          }),
          timedOut,
        ]);
      } catch (error) {
        throw new Error(
          `performer search for "${query}" failed: ${redactToken((error as Error).message, config.apiKey)}`,
        );
      }

      if (response.status === 429) {
        throw new RateLimited(retryAfterMs(response.headers.get('retry-after')));
      }
      if (!response.ok) {
        throw new Error(
          `performer search for "${query}" returned HTTP ${response.status} ${response.statusText}`,
        );
      }

      let body: unknown;
      try {
        // Raced against the same deadline as the fetch above — see the comment
        // on the site-search loop for why headers arriving is not enough to
        // consider the request safe from stalling.
        body = await Promise.race([response.json(), timedOut]);
      } catch (error) {
        throw new Error(
          `performer search for "${query}" returned unreadable JSON: ${redactToken((error as Error).message, config.apiKey)}`,
        );
      }

      return readPerformerPage(body);
    },
```

That error handling is `searchScenes`' verbatim with only the url, the noun in each message, and the reader changed. Do not paraphrase it — the redaction on the two `catch` paths and the shared `timedOut` race are both load-bearing, and the 429 must throw `RateLimited` rather than a plain `Error` or the pass cannot tell a rate limit from a fault.

Then the page reader, beside `readScenes`:

```ts
/**
 * Reads a performer search page, tolerating everything we do not use.
 *
 * `is_parent` decides `kind`, and it is compared against `true` rather than
 * coerced: a provider that starts sending `"true"`, `1` or `null` must read as
 * "not stated" and fall to the alias namespace, not be silently truthy. Getting
 * this wrong is invisible until a user clicks a performer and lands on the wrong
 * page.
 *
 * `truncated` is `meta.last > 1`, and an absent or unreadable `meta` reads as
 * `false`. It is a positive claim that more pages exist; defaulting it to true
 * would warn about truncation on every search the moment the provider stopped
 * sending the block.
 */
function readPerformerPage(body: unknown): PerformerSearchPage {
  if (body === null || typeof body !== 'object') return { results: [], truncated: false };
  const record = body as Record<string, unknown>;

  const results: PerformerSearchResult[] = [];
  const data = record['data'];
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (entry === null || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const performer = readPerformerFields(
        row,
        row['is_parent'] === true ? 'performer' : 'performer-site',
      );
      if (performer === null) continue;
      const aliases = row['aliases'];
      results.push({
        performer,
        aliases: Array.isArray(aliases)
          ? aliases.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0)
          : [],
      });
    }
  }

  const meta = record['meta'];
  const last =
    meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>)['last'] : null;
  return { results, truncated: typeof last === 'number' && last > 1 };
}
```

- [ ] **Step 5: Run the tests**

```
node --import tsx --conditions development --test packages/core/test/clients/theporndb.test.ts
npm run check
```

- [ ] **Step 6: Prove the mislabel guard bites**

Change the `kind` argument at the search call site to always `'performer'` and re-run: the `is_parent: false` test must fail. Then change it to `'performer-site'` always: the first test must fail. Restore. Report both.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/clients/theporndb.ts packages/core/test/clients/theporndb.test.ts
git commit -m "Search the performer directory, reading kind from is_parent"
```

---

### Task 4: The match rule, on its own

**Files:**
- Create: `packages/core/src/pipeline/pick-performer.ts`
- Test: `packages/core/test/pipeline/pick-performer.test.ts` (create)

**Interfaces:**
- Consumes: `PerformerSearchResult` from `../clients/theporndb.ts` (Task 3).
- Produces: `pickPerformer(query: string, results: readonly PerformerSearchResult[]): MetadataPerformer | null`.

Pure and dependency-free: no database, no client, no clock. This is the piece that can silently write a wrong name onto a group, so it gets its own file, its own tests and its own review gate.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/pipeline/pick-performer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PerformerSearchResult } from '../../src/clients/theporndb.ts';
import { pickPerformer } from '../../src/pipeline/pick-performer.ts';

/** A search result: canonical name, plus whatever aliases the provider listed. */
function result(name: string, aliases: string[] = []): PerformerSearchResult {
  return {
    performer: {
      sourceUuid: `uuid-${name}`,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      kind: 'performer',
      faceUrl: null,
      imageUrl: null,
    },
    aliases,
  };
}

test('one exact name match is linked', () => {
  const picked = pickPerformer('Jessica Jaymes', [result('Jessica Jaymes'), result('Someone Else')]);
  assert.equal(picked?.name, 'Jessica Jaymes');
});

test('an alias-only match is linked, because that is what filenames carry', () => {
  // A release is named with whatever the site billed, which is frequently an
  // alias. The provider searches aliases, so this is the common real hit — the
  // returned `name` does not equal the query at all.
  const picked = pickPerformer('Jessi Jaymes', [result('Jessica Jaymes', ['Jessi Jaymes'])]);
  assert.equal(picked?.name, 'Jessica Jaymes');
});

test('a name match beats another candidate alias match', () => {
  // A canonical name is a stronger claim than a billing alias, so when both are
  // on offer the name decides. This is the case that makes the tiering earn its
  // keep rather than being ceremony.
  const picked = pickPerformer('Jessi Jaymes', [
    result('Someone Else', ['Jessi Jaymes']),
    result('Jessi Jaymes'),
  ]);
  assert.equal(picked?.name, 'Jessi Jaymes');
});

test('two exact name matches link nothing and do not fall through to aliases', () => {
  // A tie at the strongest tier is the strongest ambiguity available. Breaking
  // it with a weaker signal would be backwards, so the alias tier is not even
  // consulted — note the third candidate, whose alias matches and is ignored.
  const picked = pickPerformer('Jessica Jaymes', [
    result('Jessica Jaymes'),
    result('Jessica Jaymes'),
    result('Someone Else', ['Jessica Jaymes']),
  ]);
  assert.equal(picked, null);
});

test('two alias matches link nothing', () => {
  const picked = pickPerformer('Jessi Jaymes', [
    result('Jessica Jaymes', ['Jessi Jaymes']),
    result('Jessika Jaymes', ['Jessi Jaymes']),
  ]);
  assert.equal(picked, null);
});

test('no match links nothing', () => {
  assert.equal(pickPerformer('Jessica Jaymes', [result('Someone Else', ['Nobody'])]), null);
  assert.equal(pickPerformer('Jessica Jaymes', []), null);
});

test('one candidate matching by both name and alias is a single tier-one hit', () => {
  const picked = pickPerformer('Jessica Jaymes', [result('Jessica Jaymes', ['Jessica Jaymes'])]);
  assert.equal(picked?.name, 'Jessica Jaymes');
});

test('comparison ignores case, punctuation and whitespace runs', () => {
  // The query comes from a release title and the name from a provider; the two
  // spell the same person differently as a matter of course. `Anne-Marie` vs
  // `Anne Marie` and `O'Neil` vs `ONeil` are the same claim.
  assert.equal(pickPerformer('jessica  jaymes', [result('Jessica Jaymes')])?.name, 'Jessica Jaymes');
  assert.equal(pickPerformer('Anne Marie Smith', [result('Anne-Marie Smith')])?.name, 'Anne-Marie Smith');
  assert.equal(pickPerformer("Katie ONeil", [result("Katie O'Neil")])?.name, "Katie O'Neil");
});

test('normalisation does not collapse two genuinely different people into a tie', () => {
  // The guard against over-normalising: if it were aggressive enough to equate
  // these, the pair would read as an ambiguity and a real single match would be
  // lost. They must stay distinct.
  const picked = pickPerformer('Anna Bell', [result('Anna Bell'), result('Annabelle')]);
  assert.equal(picked?.name, 'Anna Bell');
});
```

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/core/src/pipeline/pick-performer.ts`:

```ts
import type { MetadataPerformer } from '@pickarr/plugin-api';
import type { PerformerSearchResult } from '../clients/theporndb.ts';

/**
 * The form two spellings of one name have to agree on.
 *
 * Case, and the punctuation that separates words — a release title writes
 * `Anne Marie` where the provider writes `Anne-Marie`, and `ONeil` where it
 * writes `O'Neil`. Both are the same claim about the same person and a
 * comparison that called them different would reject the majority of real hits.
 *
 * Deliberately *not* aggressive beyond that: it does not strip vowels, collapse
 * doubled letters or fold `Anna Bell` into `Annabelle`. Over-normalising here
 * does not merely admit a wrong match, it manufactures ties — two distinct
 * performers reading as equal is an ambiguity, and an ambiguity discards a real
 * single match. The cost of being too loose is silence where there was an
 * answer, so the bar is "spelled the same, punctuated differently".
 */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The one performer worth linking, or `null`.
 *
 * Tiered, and the tiers are ordered by how strong a claim they are:
 *
 * 1. An exact `name` match. Exactly one → that one. **Two or more → nothing,
 *    and the alias tier is not consulted.** A tie among canonical names is the
 *    strongest ambiguity available; reaching for a weaker signal to break it
 *    would be backwards.
 * 2. An exact alias match, only when tier one found none. Exactly one → that
 *    one. Two or more → nothing.
 *
 * Aliases count at all because the provider searches them and because the
 * filenames this query came from carry whatever the site billed, which is
 * frequently an alias rather than the canonical name. Excluding them would
 * reject most real hits; ranking them second is what stops that breadth costing
 * precision.
 *
 * "Exactly one" throughout, never "the first" or "the best scoring". The query
 * is two words off the front of a scene title — a guess that those words name a
 * performer at all — so the failure this must not have is a plausible wrong
 * name written onto a group's cast. Silence is the correct answer to doubt, and
 * it is by far the most common one.
 */
export function pickPerformer(
  query: string,
  results: readonly PerformerSearchResult[],
): MetadataPerformer | null {
  const wanted = normalise(query);
  if (wanted.length === 0) return null;

  const byName = results.filter((result) => normalise(result.performer.name) === wanted);
  if (byName.length === 1) return byName[0]?.performer ?? null;
  if (byName.length > 1) return null;

  const byAlias = results.filter((result) =>
    result.aliases.some((alias) => normalise(alias) === wanted),
  );
  return byAlias.length === 1 ? (byAlias[0]?.performer ?? null) : null;
}
```

- [ ] **Step 4: Run the tests**

```
node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts
npm run check
```

- [ ] **Step 5: Prove the tests bite**

Three mutations, each re-run and then reverted. Report all three:
1. Change `if (byName.length > 1) return null;` to fall through to the alias tier — the "do not fall through" test must fail.
2. Change `byAlias.length === 1` to `byAlias.length >= 1` — the two-alias test must fail.
3. Add `.replace(/\s+/g, '')` to `normalise` — the `Anna Bell` / `Annabelle` test must fail.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pipeline/pick-performer.ts packages/core/test/pipeline/pick-performer.test.ts
git commit -m "Decide a performer match by name first, alias second, nothing on doubt"
```

---

### Task 5: Queue the search when a lookup settles

**Files:**
- Create: `packages/core/src/pipeline/performers.ts` (the enqueue half only; Task 6 adds the pass to this file)
- Modify: `packages/core/src/pipeline/metadata.ts` (inside `runMetadataPass`, after `outcome` is assigned)
- Test: `packages/core/test/pipeline/performers-enqueue.test.ts` (create)
- Test: `packages/core/test/pipeline/metadata.test.ts` (extend)

**Interfaces:**
- Consumes: `insertPerformerSearch`, `groupHasCast` from `../db/performer-queue.ts` (Task 2); `MediaTypePlugin.performerQuery` (Task 1).
- Produces, both consumed by Task 6:

```ts
export interface PerformerEnqueueDeps {
  db: DatabaseSync;
  pluginFor(pluginId: string): MediaTypePlugin | null;
  log(message: string): void;
}
/** The query for one group, or null when it is not worth asking about. */
export function performerQueryFor(deps: PerformerEnqueueDeps, groupId: number): string | null;
export function enqueuePerformerSearch(
  deps: PerformerEnqueueDeps,
  groupId: number,
  now: number,
): boolean;
```

`performerQueryFor` is exported because Task 6's pass needs the same query the enqueue decided on, and re-deriving it there from the plugin would be the rule spelled twice. Task 6 imports this, it does not reimplement it.

**A note on where the two refusals live.** The spec's §4 lists both refusals — already-has-a-cast, and plugin-yields-no-query — as `enqueuePerformerSearch`'s. They are, but the function lives here in the pipeline layer rather than in `db/`, because only this layer has the plugin registry. The castless half is a pure SQL question and stays in `db/performer-queue.ts` as `insertPerformerSearch`'s own guard, so it cannot be bypassed by a future caller. This mirrors `metadataAnswerability`, which likewise sits in `pipeline/metadata.ts` rather than in `db/`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/pipeline/performers-enqueue.test.ts`. Reuse the `seedGroup` / `giveCast` helpers from `packages/core/test/db/performer-queue.test.ts` by copying them in — the two files test different layers and a shared fixture module is not worth it for two helpers.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { GroupIdentity, MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { duePerformerQueue } from '../../src/db/performer-queue.ts';
import {
  enqueuePerformerSearch,
  performerQueryFor,
  type PerformerEnqueueDeps,
} from '../../src/pipeline/performers.ts';

/** One picked group, titled so the two-word rule has something to cut. */
function seedGroup(db: DatabaseSync, id: number, title: string): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, ?, ?, 1)`,
  ).run(id, `g${id}`, title, `https://indexer.invalid/${id}.nzb`);
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               created_at, list_rank_at)
     VALUES (?, 'test', ?, ?, ?, 'picked', 1, 1)`,
  ).run(id, `k${id}`, JSON.stringify({ title, subtitle: 'Some Site', fields: [] }), `g${id}`);
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

/**
 * A plugin whose `performerQuery` behaves as told. `undefined` stands for a
 * plugin that does not implement the method at all, which is how a media type
 * with no notion of performers opts out.
 */
function pluginWith(
  performerQuery: ((identity: GroupIdentity) => string | null) | undefined,
): MediaTypePlugin {
  // A real minimal plugin, the shape `metadata.test.ts:577` uses — not a cast
  // through `unknown`. If `MediaTypePlugin` gains a required member this fails to
  // typecheck, which is the signal you want; a cast would hide it.
  const plugin: MediaTypePlugin = {
    id: 'test',
    displayName: 'Test',
    parse: () => null,
    score: () => 0,
    planImport: () => null,
  };
  return performerQuery === undefined ? plugin : { ...plugin, performerQuery };
}

function depsWith(db: DatabaseSync, plugin: MediaTypePlugin | null): PerformerEnqueueDeps {
  return { db, pluginFor: () => plugin, log: () => {} };
}

test('a castless group with a query is queued', () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const deps = depsWith(db, pluginWith((identity) => identity.display.title.split(' ').slice(0, 2).join(' ')));

  assert.equal(performerQueryFor(deps, 1), 'Jessica Jaymes');
  assert.equal(enqueuePerformerSearch(deps, 1, 500), true);
  assert.deepEqual(duePerformerQueue(db, 500, 10).map((row) => row.groupId), [1]);
  db.close();
});

test('a group whose plugin offers no query is not queued', () => {
  // A one-word title is the real case: the plugin returns null rather than a
  // one-word query. Not queueing is a silent success — the caller is a pass
  // draining a queue, not a user action that can fail.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Solo');
  const deps = depsWith(db, pluginWith(() => null));

  assert.equal(performerQueryFor(deps, 1), null);
  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  db.close();
});

test('a plugin that does not implement performerQuery queues nothing', () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const deps = depsWith(db, pluginWith(undefined));

  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  db.close();
});

test('a group with a cast is not queued', () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  giveCast(db, 1);
  const deps = depsWith(db, pluginWith(() => 'Jessica Jaymes'));

  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  db.close();
});

test('a group whose plugin is no longer configured is not queued', () => {
  // `pluginFor` answering null is normal, not a bug: a plugin can be removed
  // from config after groups it created already exist.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const deps = depsWith(db, null);

  assert.equal(performerQueryFor(deps, 1), null);
  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  db.close();
});

test('a plugin that throws building the query does not take the caller down', () => {
  // The caller is a loop over settled rows inside `runMetadataPass`. A plugin
  // bug must cost this one group its search, not abort the metadata pass — the
  // same treatment `safeMetadataQuery` gives `metadataQuery` throwing.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const logged: string[] = [];
  const deps: PerformerEnqueueDeps = {
    db,
    pluginFor: () => pluginWith(() => { throw new Error('plugin bug'); }),
    log: (message) => logged.push(message),
  };

  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  assert.ok(logged.some((line) => line.includes('plugin bug')));
  db.close();
});

test('a missing group is silence rather than a throw', () => {
  // The caller has already resolved the group from a queue row it just read; a
  // row for an id that is gone has nothing to say.
  const db = openTestDatabase();
  const deps = depsWith(db, pluginWith(() => 'Jessica Jaymes'));

  assert.equal(enqueuePerformerSearch(deps, 9999, 500), false);
  db.close();
});
```

Then extend `packages/core/test/pipeline/metadata.test.ts`. Read that file's existing fixtures first and build these on them rather than re-seeding from scratch — it already constructs a `MetadataPassDeps` with a stub scene client, which is most of the work.

```ts
test('a confirmed scene that supplied a cast queues no performer search', async () => {
  // The confirmation already answered the question this queue exists to ask.
  // Nothing here checks that explicitly — `insertPerformerSearch` refuses a
  // group with a cast — which is exactly why including `confirmed` at the call
  // site is safe rather than a second rule to keep in step.
  // Arrange: a scene client returning one confirmable candidate with performers.
  // Act: runMetadataPass.
  // Assert: group_metadata is confirmed, group_performers is non-empty,
  //         duePerformerQueue is empty.
});

test('a confirmed scene that named nobody queues a performer search', async () => {
  // Same confirmation, `performers: []`. The group ends up picked, answered and
  // castless — which is precisely the gap this feature fills, and the case a
  // rule keyed only on `state = 'none'` would miss.
});

test('a settled-as-none lookup queues a performer search', async () => {
  // A search that ran and confirmed nothing. `answerUnaskable` / a 'none' answer
  // settles the row, and the group has no cast.
});

test('a deferred row queues nothing, because it has not settled', async () => {
  // A client that throws an ordinary error, so `deferOrGiveUp` defers rather
  // than answering. The row will be asked again: a group whose scene lookup is
  // still in flight has not yet *failed* to produce a cast, and queueing here
  // would spend a performer request on a question that is still open.
});
```

Fill in each `Arrange / Act / Assert` against the fixtures actually in that file. The four assertions that matter are: `duePerformerQueue(db, now, 10)` is empty in cases one and four, and holds the group in cases two and three.

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-enqueue.test.ts packages/core/test/pipeline/metadata.test.ts
```

- [ ] **Step 3: Implement the enqueue**

Create `packages/core/src/pipeline/performers.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, MediaTypePlugin } from '@pickarr/plugin-api';
import { getGroup } from '../db/groups.ts';
import { insertPerformerSearch } from '../db/performer-queue.ts';

export interface PerformerEnqueueDeps {
  db: DatabaseSync;
  /**
   * Resolves the plugin a group's `plugin` column names. `null` for a plugin no
   * longer configured — a normal outcome, not a bug: a plugin can be removed
   * from config after groups it created already exist.
   */
  pluginFor(pluginId: string): MediaTypePlugin | null;
  log(message: string): void;
}

/**
 * What to search a performer directory for on behalf of one group, or `null`
 * when there is nothing worth asking.
 *
 * Exported because the pass needs the same answer the enqueue acted on, and a
 * pass re-deriving it from the plugin would be this rule spelled twice — the
 * duplication `deriveUpgradeReleaseId` exists in this codebase to prevent. Both
 * callers ask here.
 *
 * A plugin throwing is a log line and a `null`, never a throw of our own. The
 * caller is a loop over settled rows inside `runMetadataPass`, and a plugin bug
 * must cost one group its search rather than aborting a pass that has other rows
 * to answer — the same treatment `safeMetadataQuery` gives `metadataQuery`.
 */
export function performerQueryFor(deps: PerformerEnqueueDeps, groupId: number): string | null {
  const group = getGroup(deps.db, groupId);
  if (group === null) return null;

  const plugin = deps.pluginFor(group.plugin);
  if (plugin?.performerQuery === undefined) return null;

  try {
    const display = JSON.parse(group.display) as DisplayFields;
    const query = plugin.performerQuery({ identityKey: group.identityKey, display });
    return query === null || query.trim().length === 0 ? null : query;
  } catch (error) {
    deps.log(
      `performer enqueue: group ${groupId} skipped, plugin threw building the query: ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Queues one group, answering whether it queued.
 *
 * The two refusals the spec names are both here in effect, but only one is
 * enforced here: whether the plugin has anything to ask is this layer's question
 * because only this layer holds the registry, while "does the group already have
 * a cast" is pure SQL and stays inside `insertPerformerSearch`, where no future
 * caller can bypass it. `metadataAnswerability` sits on the same side of the
 * same line for the same reason.
 */
export function enqueuePerformerSearch(
  deps: PerformerEnqueueDeps,
  groupId: number,
  now: number,
): boolean {
  if (performerQueryFor(deps, groupId) === null) return false;
  return insertPerformerSearch(deps.db, groupId, now);
}
```

Note `plugin?.performerQuery === undefined` covers both a null plugin and a plugin that does not implement the method — one condition rather than two, because both mean the same thing here.

- [ ] **Step 4: Add the one call site**

In `runMetadataPass`, immediately after `outcome` is assigned (both the `try` result and the `catch` fallback have landed in it by then) and before the counters:

```ts
    // One call site, gated on having settled. `deferred` has not settled: the
    // row will be asked again, and a group whose scene lookup is still in
    // flight has not yet failed to produce a cast. A single site rather than
    // one per settle path for the reason `deriveUpgradeReleaseId` exists — an
    // invariant re-derived by whichever caller remembers is one that holds on
    // some paths. This is the only place a metadata row settles.
    if (outcome.kind !== 'deferred') {
      enqueuePerformerSearch({ db: deps.db, pluginFor: deps.pluginFor, log: deps.log }, row.groupId, now);
    }
```

`confirmed` needs no cast check here — `insertPerformerSearch` refuses a group that has one, which is what makes including `confirmed` safe rather than a second rule to keep in step.

- [ ] **Step 5: Run the tests**

```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-enqueue.test.ts packages/core/test/pipeline/metadata.test.ts
npm run check
```

- [ ] **Step 6: Prove the gate bites**

Change `outcome.kind !== 'deferred'` to an unconditional call and re-run: the deferred test must fail. Restore. Report it.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/pipeline/performers.ts packages/core/src/pipeline/metadata.ts \
        packages/core/test/pipeline/performers-enqueue.test.ts packages/core/test/pipeline/metadata.test.ts
git commit -m "Queue a performer search when a scene lookup settles castless"
```

---

### Task 6: Drain the queue

**Files:**
- Modify: `packages/core/src/pipeline/performers.ts` (add the pass beside the enqueue)
- Test: `packages/core/test/pipeline/performers-pass.test.ts` (create)

**Interfaces:**
- Consumes: `duePerformerQueue`, `deferPerformerSearch`, `removePerformerSearch`, `groupHasCast` (Task 2); `PerformerLookupClient` (Task 3); `pickPerformer` (Task 4); `upsertPerformers`, `setGroupPerformers` from `../db/performers.ts`.
- Produces:

```ts
export const MAX_PERFORMER_ATTEMPTS = 50;
/**
 * Extends the enqueue deps rather than restating them: the pass calls
 * `performerQueryFor`, which needs exactly `db`, `pluginFor` and `log`.
 */
export interface PerformerPassDeps extends PerformerEnqueueDeps {
  client: PerformerLookupClient | undefined;
  perTick: number;
  now: () => number;
}
export interface PerformerPassResult {
  looked: number;
  linked: number;
  unmatched: number;
  deferred: number;
  cooldownUntil: number | null;
}
export function runPerformerPass(deps: PerformerPassDeps): Promise<PerformerPassResult>;
export function createPerformerRunner(deps: PerformerPassDeps): () => Promise<void>;
```

`MAX_PERFORMER_ATTEMPTS` is 50 for the reason `MAX_METADATA_ATTEMPTS` documents: backoff (`backoffFor`, shared) ramps to a six-hour cap in nine attempts, so fifty spans roughly ten days past the ramp — long enough to survive a multi-day provider outage, short enough that a deterministically poisoned row stops consuming a `perTick` slot four times a day forever.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/pipeline/performers-pass.test.ts`. Copy `seedGroup`, `giveCast` and `pluginWith` in from `performers-enqueue.test.ts` — two small helpers duplicated across two test files is cheaper than a shared fixture module, and these files pin different layers.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { MetadataPerformer } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { RateLimited, type PerformerSearchPage } from '../../src/clients/theporndb.ts';
import { duePerformerQueue, insertPerformerSearch } from '../../src/db/performer-queue.ts';
import { performersForGroups } from '../../src/db/performers.ts';
import {
  MAX_PERFORMER_ATTEMPTS,
  createPerformerRunner,
  runPerformerPass,
  type PerformerPassDeps,
} from '../../src/pipeline/performers.ts';

// …seedGroup / giveCast / pluginWith copied from performers-enqueue.test.ts…

/** A search result carrying just the fields the match rule reads. */
function found(name: string, aliases: string[] = []): PerformerSearchPage['results'][number] {
  return {
    performer: {
      sourceUuid: `uuid-${name}`,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      kind: 'performer',
      faceUrl: null,
      imageUrl: null,
    } satisfies MetadataPerformer,
    aliases,
  };
}

/**
 * Deps whose client answers with `pages` in call order, or throws whatever is at
 * that position. One array rather than a stub object so a test can say "the first
 * call is rate limited, the second would have succeeded" and prove the second
 * never happened.
 */
function deps(
  db: DatabaseSync,
  answers: readonly (PerformerSearchPage | Error)[],
  overrides: Partial<PerformerPassDeps> = {},
): PerformerPassDeps & { calls: string[]; logged: string[] } {
  const calls: string[] = [];
  const logged: string[] = [];
  let index = 0;
  return {
    db,
    client: {
      source: 'theporndb',
      async searchPerformers(query: string) {
        calls.push(query);
        const answer = answers[index] ?? { results: [], truncated: false };
        index += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    pluginFor: () => pluginWith((identity) => identity.display.title.split(' ').slice(0, 2).join(' ')),
    perTick: 10,
    now: () => 1000,
    log: (message) => logged.push(message),
    calls,
    logged,
    ...overrides,
  };
}

function castOf(db: DatabaseSync, groupId: number): string[] {
  return (performersForGroups(db, [groupId]).get(groupId) ?? []).map((row) => row.name);
}

test('a single exact match is linked and the row is settled', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [{ results: [found('Jessica Jaymes')], truncated: false }]));

  assert.equal(result.linked, 1);
  assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('an alias-only match is linked, since that is what the filename carried', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessi Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  await runPerformerPass(deps(db, [
    { results: [found('Jessica Jaymes', ['Jessi Jaymes'])], truncated: false },
  ]));

  assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
  db.close();
});

test('no match settles the row without writing anything', async () => {
  // A search that ran and matched nothing IS an answer. Leaving the row queued
  // would spend one request per pass forever rediscovering the same silence.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [{ results: [found('Someone Else')], truncated: false }]));

  assert.equal(result.unmatched, 1);
  assert.deepEqual(castOf(db, 1), []);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM performers').get()?.['n'], 0);
  db.close();
});

test('an ambiguous result settles the row without writing anything', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  await runPerformerPass(deps(db, [
    { results: [found('Jessica Jaymes'), found('Jessica Jaymes')], truncated: false },
  ]));

  assert.deepEqual(castOf(db, 1), []);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('a cast that appeared between enqueue and drain is not clobbered', async () => {
  // The guard the spec calls out. `setGroupPerformers` deletes before it inserts,
  // so without the re-check inside the writing transaction a one-name guess
  // arriving a moment after a confirmed scene REPLACES the real cast. Queue
  // first, then attach the cast, then run — which is the real ordering, since a
  // metadata refetch can land at any point after the enqueue.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  giveCast(db, 1);

  await runPerformerPass(deps(db, [{ results: [found('Jessica Jaymes')], truncated: false }]));

  assert.deepEqual(castOf(db, 1), ['Someone'], 'the confirmed cast must survive');
  assert.deepEqual(duePerformerQueue(db, 9999, 10), [], 'and the row is still settled');
  db.close();
});

test('a 429 breaks the pass, leaving the rows behind it untouched', async () => {
  // A rate limit is a fact about the service, not about one row. Asking the rest
  // anyway would spend one request per row rediscovering a limit already known.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  seedGroup(db, 2, 'Someone Else Entirely');
  insertPerformerSearch(db, 1, 100);
  insertPerformerSearch(db, 2, 200);

  const passDeps = deps(db, [new RateLimited(120_000), { results: [found('Someone Else')], truncated: false }]);
  const result = await runPerformerPass(passDeps);

  assert.equal(result.looked, 1);
  assert.equal(result.cooldownUntil, 1000 + 120_000);
  assert.deepEqual(passDeps.calls, ['Jessica Jaymes'], 'the second row was never asked');
  assert.deepEqual(duePerformerQueue(db, 9999, 10).map((row) => row.groupId), [1, 2]);
  assert.equal(duePerformerQueue(db, 9999, 10)[0]?.attempts, 0, 'a 429 is not the row failing');
  db.close();
});

test('an ordinary failure defers the row with its message', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [new Error('returned HTTP 503 Service Unavailable')]));

  assert.equal(result.deferred, 1);
  const row = duePerformerQueue(db, 9_999_999_999, 10)[0];
  assert.equal(row?.attempts, 1);
  assert.ok(row?.lastError?.includes('503'));
  assert.ok(row !== undefined && row.nextAt > 1000, 'and it is pushed into the future');
  db.close();
});

test('a row that has failed too often is given up on rather than deferred forever', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  db.prepare('UPDATE performer_queue SET attempts = ? WHERE group_id = 1')
    .run(MAX_PERFORMER_ATTEMPTS - 1);

  await runPerformerPass(deps(db, [new Error('still broken')]));

  assert.deepEqual(duePerformerQueue(db, 9_999_999_999, 10), []);
  assert.deepEqual(castOf(db, 1), []);
  db.close();
});

test('a row whose own write throws still has its attempts bumped', async () => {
  // The poison-row defect `runMetadataPass` documents having had: rows drain in
  // (requested_at, group_id) order, so a row whose attempts never moved would
  // abort every pass on the same row and nothing behind it would ever be looked
  // at. The trigger is the same shape of failure a constraint or a full disk
  // produces — the search succeeded, the write cannot.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  seedGroup(db, 2, 'Someone Else Entirely');
  insertPerformerSearch(db, 1, 100);
  insertPerformerSearch(db, 2, 200);
  db.exec(`CREATE TRIGGER no_link BEFORE INSERT ON group_performers
           BEGIN SELECT RAISE(ABORT, 'link write refused'); END`);

  const passDeps = deps(db, [
    { results: [found('Jessica Jaymes')], truncated: false },
    { results: [found('Someone Else')], truncated: false },
  ]);
  const result = await runPerformerPass(passDeps);

  assert.equal(result.deferred, 1, 'the failing row deferred rather than throwing');
  assert.equal(duePerformerQueue(db, 9_999_999_999, 10).find((row) => row.groupId === 1)?.attempts, 1);
  // Group 2 was still reached in this same pass, and settled normally.
  assert.deepEqual(passDeps.calls, ['Jessica Jaymes', 'Someone Else']);
  db.close();
});

test('a query that has gone away settles the row rather than retrying forever', async () => {
  // The query is rebuilt each pass rather than stored, so a title corrected by
  // hand to a single word leaves nothing to ask. That is not a failure to retry.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  const passDeps = deps(db, [], { pluginFor: () => pluginWith(() => null) });

  await runPerformerPass(passDeps);

  assert.deepEqual(passDeps.calls, []);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('a truncated page is judged, and the truncation is logged rather than silent', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const passDeps = deps(db, [{ results: [found('Jessica Jaymes')], truncated: true }]);
  await runPerformerPass(passDeps);

  assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
  assert.ok(passDeps.logged.some((line) => line.includes('one page')));
  db.close();
});

test('no client means no pass and no reads', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [], { client: undefined }));

  assert.deepEqual(result, { looked: 0, linked: 0, unmatched: 0, deferred: 0, cooldownUntil: null });
  assert.deepEqual(duePerformerQueue(db, 9999, 10).map((row) => row.groupId), [1]);
  db.close();
});

test('createPerformerRunner makes no request inside a cooldown, and says so once', async () => {
  // A multi-hour cooldown at a five-second interval would otherwise write
  // thousands of identical lines.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  const passDeps = deps(db, [new RateLimited(120_000)]);
  const run = createPerformerRunner(passDeps);

  await run();
  await run();
  await run();

  assert.deepEqual(passDeps.calls, ['Jessica Jaymes'], 'only the first tick asked');
  assert.equal(passDeps.logged.filter((line) => line.includes('cooldown')).length, 1);
  db.close();
});
```

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
```

- [ ] **Step 3: Export `backoffFor`**

It is module-private in `metadata.ts:26`. Add `export` and import it here rather than writing a second copy: two backoff curves against one rate-limited service is two things to tune, and one of them will be forgotten. Add a line to its doc comment saying both passes share it.

- [ ] **Step 4: Implement the write**

Add to `packages/core/src/pipeline/performers.ts`. This is the part with the guard in it, so it goes in its own function:

```ts
/**
 * Records the outcome of one search: links the performer if there is one, and
 * removes the queue row either way, in one transaction.
 *
 * **The castless check is re-done here, inside the transaction that writes.**
 * `insertPerformerSearch` already refused a group with a cast, but that was at
 * enqueue time and a metadata refetch can attach a real cast in the interval —
 * and `setGroupPerformers` deletes the group's rows before inserting, so a
 * one-name guess arriving late would *replace* a confirmed cast rather than lose
 * to it. Re-checking under the writing transaction is what makes that impossible
 * rather than merely unlikely.
 *
 * The row's removal is in the same transaction as the link for the same reason
 * `failDownload` transacts its two statements: nothing here awaits, so no reader
 * can observe the gap, but a process dying between them would leave a linked cast
 * still queued — and the next pass would spend a request re-linking it.
 *
 * The row goes whether or not anything was linked. A search that ran and matched
 * nothing **is** an answer, the rule `resolve-sites.ts` and `runMetadataPass`
 * both state; leaving it queued would spend one request per pass forever
 * rediscovering the same silence.
 */
function recordPerformerOutcome(
  deps: PerformerPassDeps,
  groupId: number,
  performer: MetadataPerformer | null,
  now: number,
): 'linked' | 'unmatched' {
  deps.db.exec('BEGIN');
  try {
    let linked = false;
    if (performer !== null && !groupHasCast(deps.db, groupId)) {
      const ids = upsertPerformers(deps.db, 'theporndb', [performer], now);
      setGroupPerformers(deps.db, groupId, ids);
      linked = true;
    }
    removePerformerSearch(deps.db, groupId);
    deps.db.exec('COMMIT');
    return linked ? 'linked' : 'unmatched';
  } catch (error) {
    deps.db.exec('ROLLBACK');
    throw error;
  }
}
```

`upsertPerformers` and `setGroupPerformers` both document that they carry no transaction of their own and are meant to be called from inside one — this is that one.

- [ ] **Step 5: Implement the pass and runner**

Model these on `runMetadataPass` (`metadata.ts:222-275`) and `createMetadataRunner` (296 onward); read both first.

```ts
/**
 * Drains up to `perTick` due rows: builds each group's query, searches, decides,
 * and links on an unambiguous match.
 *
 * Sequential, not concurrent, mirroring `runMetadataPass` and
 * `resolveSitesForBatch`: simpler, self-rate-limiting, and a pass this small has
 * nothing to gain from concurrency.
 *
 * The rule throughout is the one `resolveSitesForBatch` documents: a search that
 * ran and matched nothing is an answer, but a search that could not be *made*
 * learned nothing and must not be recorded as one.
 */
export async function runPerformerPass(deps: PerformerPassDeps): Promise<PerformerPassResult> {
  const result: PerformerPassResult = {
    looked: 0, linked: 0, unmatched: 0, deferred: 0, cooldownUntil: null,
  };

  const client = deps.client;
  if (client === undefined) return result;

  const now = deps.now();
  const due = duePerformerQueue(deps.db, now, deps.perTick);
  if (due.length === 0) return result;

  for (const row of due) {
    result.looked += 1;
    const query = performerQueryFor(deps, row.groupId);

    // The query is rebuilt each pass rather than stored, so it can have gone
    // away since the row was written — a title corrected by hand to one word.
    // That is not a failure to retry; there is nothing left to ask.
    if (query === null) {
      removePerformerSearch(deps.db, row.groupId);
      result.unmatched += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- rows are answered one at a time, deliberately sequential
      const page = await client.searchPerformers(query);
      if (page.truncated) {
        deps.log(
          `performer pass: group ${row.groupId} judged "${query}" on one page of ` +
            `${page.results.length}; the provider reported more`,
        );
      }
      const outcome = recordPerformerOutcome(
        deps, row.groupId, pickPerformer(query, page.results), now,
      );
      if (outcome === 'linked') result.linked += 1;
      else result.unmatched += 1;
    } catch (error) {
      if (error instanceof RateLimited) {
        // A rate limit is a fact about the service, not about this row: the row
        // keeps its next_at and is picked up normally once the cooldown clears.
        // Asking the rest anyway would spend one request per row rediscovering a
        // limit already known.
        result.cooldownUntil = now + error.retryAfterMs;
        break;
      }
      result.deferred += 1;
      // `now` and the backoff are both computed from the pass's captured clock
      // and passed in, matching `metadata.ts`'s own `deferOrGiveUp` signature.
      // Reading `deps.now()` again inside would stamp `next_at` from a later
      // instant than the row was judged at.
      deferOrGiveUp(deps, row, (error as Error).message, now + backoffFor(row.attempts));
    }
  }

  deps.log(
    `performer pass: ${result.linked} linked, ${result.unmatched} unmatched, ` +
      `${result.deferred} deferred` +
      (result.cooldownUntil === null
        ? ''
        : `, cooldown until ${new Date(result.cooldownUntil).toISOString()}`),
  );

  return result;
}
```

And the deferral, which must commit even when the transaction that led here rolled back:

```ts
/**
 * Defers a row, unless it has now failed `MAX_PERFORMER_ATTEMPTS` times, in
 * which case the row is removed so it stops costing a `perTick` slot forever.
 *
 * A fresh statement, not nested inside whatever transaction the caller may just
 * have watched fail — so it commits even when that transaction rolled itself
 * back. This is what stops a poison row (a constraint its own data trips, a full
 * disk) from being permanently first in line: `duePerformerQueue` orders by
 * `(requested_at, group_id)`, so a row whose attempts never moved would abort
 * every pass on the same row and nothing behind it would ever be looked at.
 * `runMetadataPass` documents having had exactly that defect.
 */
function deferOrGiveUp(
  deps: PerformerPassDeps,
  row: PerformerQueueRow,
  message: string,
  nextAt: number,
): void {
  const attemptsAfter = row.attempts + 1;
  if (attemptsAfter >= MAX_PERFORMER_ATTEMPTS) {
    deps.log(
      `performer pass: group ${row.groupId} given up after ${attemptsAfter} attempts: ${message}`,
    );
    removePerformerSearch(deps.db, row.groupId);
    return;
  }
  deps.log(`performer pass: group ${row.groupId} deferred (attempt ${attemptsAfter}): ${message}`);
  deferPerformerSearch(deps.db, row.groupId, message, nextAt);
}
```

`createPerformerRunner` is `createMetadataRunner`'s shape exactly: hold `cooldownUntil` and a `loggedSkip` flag in the closure, return an async function that makes **no** provider request at all inside a cooldown — it never calls `runPerformerPass`, so `duePerformerQueue` is not even read — and logs the skip once per cooldown rather than once per tick, because a multi-hour cooldown at a five-second interval would otherwise write thousands of identical lines. Copy that function and change the names, the pass it calls and the log prefix; do not reinvent the bookkeeping.

`PerformerPassDeps` extends `PerformerEnqueueDeps` (it needs the same `db`, `pluginFor` and `log` for `performerQueryFor`), so declare it as `export interface PerformerPassDeps extends PerformerEnqueueDeps { … }` and drop the three duplicated fields from the signature given in the Interfaces block above.

- [ ] **Step 6: Run the tests**

```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
npm run check
```

- [ ] **Step 7: Prove the clobber guard bites**

Remove the in-transaction `groupHasCast` re-check and re-run: test 4 must fail with the real cast replaced by the guess. Restore. Report it.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/pipeline/performers.ts packages/core/src/pipeline/metadata.ts \
        packages/core/test/pipeline/performers-pass.test.ts
git commit -m "Drain the performer queue, linking only an unambiguous match"
```

---

### Task 7: Wire it into the running process

**Files:**
- Modify: `packages/core/src/main.ts:92-96` (client type), `:127-156` (runner construction), `:167-169` (scheduler options)
- Test: `packages/core/test/main.test.ts` (extend)

**Interfaces consumed:** `createPerformerRunner`, `PerformerPassDeps` (Task 6); `PerformerLookupClient` (Task 3).

- [ ] **Step 1: Write the failing test**

Extend `packages/core/test/main.test.ts` following its existing style — read how that file builds a config and stubs the scheduler before writing these, and reuse those fixtures.

```ts
test('one metadata tick runs the scene pass and then the performer pass', async () => {
  // Order matters and is the reason this is asserted rather than assumed: a
  // performer search is the fallback for a scene lookup that settled without a
  // cast, so the pass that produces those rows has to run before the pass that
  // drains them. Asserting the *sequence* — not just that both ran — is what
  // pins it.
  // Arrange: a config with metadata.enabled true and a siteLookup apiKey, and a
  //   fetch stub recording each request path in order.
  // Act: start the process far enough to obtain the scheduler's `runMetadata`,
  //   and await one invocation.
  // Assert: the recorded paths are ['/scenes…', '/performers…'] — scenes first.
});

test('metadata disabled runs neither pass', async () => {
  // `runMetadata` stays undefined and the scheduler registers no timer at all,
  // which is already how an absent metadata client is expressed. Adding a second
  // pass must not turn that into a partially-registered tick.
  // Assert: the scheduler received no `runMetadata`, and no request was made.
});

test('no provider client runs neither pass, without throwing', async () => {
  // metadata.enabled true but siteLookup unconfigured. The existing code logs and
  // leaves `runMetadata` undefined; the performer runner must not be built from an
  // undefined client and then invoked.
});
```

Fill in each `Arrange / Act / Assert` against the fixtures in that file. If `main.test.ts` has no seam that exposes the scheduler's options, do not invent one for this — assert instead on the request paths the fetch stub recorded, which is the observable that actually matters.

- [ ] **Step 2: Run and watch it fail**

```
node --import tsx --conditions development --test packages/core/test/main.test.ts
```

- [ ] **Step 3: Implement**

`createTpdbClient` now returns `PerformerLookupClient` too, so widen the `tpdbClient` declaration at line 92 to `(SiteLookupClient & SceneLookupClient & PerformerLookupClient) | undefined`.

Inside the same `else` branch that builds `runMetadata` (line 136 onward), build a performer runner from the same client and `config.metadata.perTick`, and compose the two into the single `runMetadata` closure the scheduler already receives:

```ts
    // One tick drives both passes, in order. No second interval: a second knob
    // is a second thing to tune wrong, and both passes talk to the same
    // rate-limited service, so sharing one cadence is what keeps the combined
    // request rate predictable. Scenes first — a performer search is the
    // fallback for a scene lookup that settled without a cast, so the pass that
    // produces those rows runs before the pass that drains them. A row enqueued
    // this tick is therefore searched on the next one, which is correct: the
    // enqueue and the search are separate decisions.
    const runScenes = createMetadataRunner({
      db,
      client,
      pluginFor,
      artwork,
      perTick: config.metadata.perTick,
      now: () => Date.now(),
      log,
    });
    const runPerformers = createPerformerRunner({
      db,
      client,
      pluginFor,
      perTick: config.metadata.perTick,
      now: () => Date.now(),
      log,
    });
    runMetadata = async () => {
      await runScenes();
      await runPerformers();
    };
```

Copy the `createMetadataRunner` argument list from what is already at that call site rather than from the sketch above — it is written from lines 147-155 and the surrounding code may have moved. `client` satisfies both `SceneLookupClient` and `PerformerLookupClient`, so the same value is passed to both without a cast.

`await` both in sequence rather than `Promise.all`: they talk to one rate-limited service, and running them concurrently would double the instantaneous request rate that `perTick` exists to bound.

Extend the existing "metadata: enabled, every Ns, N per tick" log line to say the performer pass shares the tick, so an operator reading the log knows both are running.

- [ ] **Step 4: Verify everything**

```
npm run check
npm run build
```

Expected: green lint, green typecheck, all tests passing, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/main.ts packages/core/test/main.test.ts
git commit -m "Run the performer pass on the metadata tick"
```

---

## Notes for the controller

- **Nothing pushes.** Seven commits land on `feature/performer-search-queue`; the repo owner approves any push and any merge.
- **The endpoint is the one unverifiable piece.** Task 3's tests stub `fetch`, so they prove the reader and the error handling, not that TPDB answers this shape. The response example in the spec came from the repo owner. If the live API disagrees on a field name, Task 3's reader is the only place to change.
- **Expect this to link almost nothing at first,** and do not treat that as a bug to fix mid-plan. The spec's §12 says so deliberately: two words of a scene title are a guess, and the tiered rule is built so a wrong guess writes nothing. If the linking rate is disappointing, §12 lists the follow-ups in cost order — all additive, none in this plan.
- **Task 3 Step 3 is a refactor of shipped code.** The existing scene-metadata tests are its safety net; if they do not all pass before you move to Step 4, stop rather than continuing forward.
- **Two places this plan refines the spec, both deliberate and both argued at the point of use.** First, the spec puts both enqueue refusals in one function; the plan splits them, keeping the castless check in `db/` where no caller can bypass it and the plugin question in `pipeline/` where the registry lives (Task 5's Interfaces note). Second, the spec has the *client* log a truncated page; the client has no `log` dependency and giving it one to say this would be the wrong seam, so `searchPerformers` returns `truncated` and the pass logs it (Task 3's `PerformerSearchPage` comment, Task 6's truncation test). Neither changes observable behaviour. If a reviewer disagrees with either, they are cheap to move.
