# Metadata Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a poster thumbnail and performer avatars on the media card, each opening a scaled modal, and link performer names and the metadata title to ThePornDB.

**Architecture:** A performer stops being a string. New `performers` and `group_performers` tables carry the identity, slug and cached artwork that TPDb returns on `performers[].parent`; the TPDb client stops discarding it; the metadata worker caches two images per performer through a generalised `cacheImage`; two new routes serve them; and one `ImageModal` component serves the poster and both avatar sizes.

**Tech Stack:** Node 24, TypeScript (tsgo, typecheck only), Fastify 5, `node:sqlite` `DatabaseSync`, React 19 + Vite, `node:test` + tsx, happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-13-metadata-layout-design.md` — read it before Task 1. It records the live-API ground truth these tasks depend on.

## Global Constraints

- **Never use the `any` TypeScript type.** Not in source, not in tests.
- **Prefer async APIs over sync twins** (`fs.promises` over `fs.*Sync`). `node:sqlite` `DatabaseSync` is the documented exception.
- **`npm run check` (lint + typecheck + tests) must pass before a task is done.** `npm run build` runs no typechecker and does not substitute.
- **Node 24 is not the shell default.** Every bash command needs `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.
- **Commits stay on the `metadata-layout` branch and are never pushed.** Merging and pushing are the user's call.
- **Migration version 7.** `migrations.ts` records two prior branch collisions on version numbers; `migrate.ts` has a duplicate-version guard that will fail the suite if 7 is taken.
- **A test whose expectation is computed by the code under test cannot detect that code changing.** Assert literals. This repo has been bitten three times; see `docs/known-issues.md`.
- **Escape-to-close is not unit-testable here.** happy-dom implements `showModal()` but not Escape. Verified: an open dialog given a bubbling, cancelable `keydown` with `key: 'Escape'` stays `open` and fires neither `cancel` nor `close`. Escape is tested in Playwright only (Task 10).
- **Never enable `t.mock.timers` in a web test.** It hangs the run — React's effect flush schedules through `setTimeout`, so the effect under test never runs and the test times out pointing at nothing. Recorded in `docs/known-issues.md`. No task here needs fake timers; if one seems to, spy on the real `setTimeout`'s arguments instead.
- **This branch was rebased onto `origin/main` at `ed0de07`.** Main moved seven commits under this plan while it was being written, all in the metadata area. Tasks 5, 7, 8 and 9 were rewritten against the new code; if a task's quoted code does not match the file, stop and report rather than reconciling silently.
- TPDb page URLs: scene `https://theporndb.net/scenes/<slug>`, performer `https://theporndb.net/performers/<slug>`, site performer `https://theporndb.net/performer-sites/<slug>`.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/plugin-api/src/types.ts` | `MetadataPerformer`; `MetadataCandidate.performers` and `.slug` |
| `packages/core/src/clients/theporndb.ts` | `readPerformers` — the parent-or-self rule |
| `packages/core/src/db/migrations.ts` | Migration 7: two tables, one column, the refetch backfill |
| `packages/core/src/db/performers.ts` | **new** — upsert performers, link to groups, read back per page |
| `packages/core/src/db/metadata.ts` | `recordMetadataAnswer` becomes an upsert; `scene_slug` |
| `packages/core/src/media/artwork.ts` | `cachePoster` → `cacheImage` |
| `packages/core/src/pipeline/metadata.ts` | Cache avatars alongside the poster |
| `packages/core/src/http/views.ts` | `MetadataView.performers`, `.performerNames`, `.sceneUrl` |
| `packages/core/src/http/server.ts` | `GET /api/performers/:id/{avatar,image}` |
| `packages/web/src/api/client.ts` | Mirror of `MetadataView` |
| `packages/web/src/components/ImageModal.tsx` | **new** — the modal |
| `packages/web/src/components/MediaCard.tsx` | Layout: corner poster, performer rows, links |
| `packages/web/src/styles.css` | Card positioning, avatar sizing, modal |
| `packages/e2e/src/metadata-modal.spec.ts` | **new** — Escape, in a real browser |

---

### Task 1: Capture performers and the scene slug from TPDb

**Files:**
- Modify: `packages/plugin-api/src/types.ts:118-130`
- Modify: `packages/core/src/clients/theporndb.ts:179-239`
- Test: `packages/core/test/clients/theporndb.test.ts`

**Interfaces:**
- Produces: `MetadataPerformer`, `MetadataCandidate.performers: readonly MetadataPerformer[]`, `MetadataCandidate.slug: string | null`.

The payload shape is in the spec under "Ground truth from the live API". The
rule: read `parent` when present, fall back to the site-level performer when
it is not. A site performer's `image`/`thumbnail`/`face` are `null` in
practice, so the fallback usually yields a name and a link with no avatar.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/clients/theporndb.test.ts`, alongside the existing
`SCENE_BODY`:

```ts
// Shapes taken from a live `GET /scenes?per_page=1`, trimmed to the fields
// this reads. The nesting is the point: `image`, `thumbnail` and `face` are
// null on the site performer and populated on its parent, so a reader that
// trusts the outer object renders no avatars at all.
const PERFORMER_BODY = {
  data: [{
    id: 'scene-uuid', _id: 1, title: 'T', date: '2025-02-07',
    slug: 'futilestruggles-alice-maze-first-time-day-1-episode-1',
    url: 'https://www.futilestruggles.com/trial/gallery.php?id=2583',
    site: { uuid: 'site-uuid', id: 6061, name: 'Futile Struggles' },
    performers: [{
      id: 'site-performer-uuid', _id: 2750085, slug: '6061-alice-maze',
      site_id: 6061, name: 'Alice Maze',
      image: null, thumbnail: null, face: null,
      parent: {
        id: 'parent-uuid', _id: 165140, slug: 'alice-maze', name: 'Alice Maze',
        image: 'https://cdn.theporndb.net/p/alice-maze.jpg',
        thumbnail: 'https://cdn.theporndb.net/p/c/alice-maze-thumb.jpg',
        face: 'https://thumb.theporndb.net/x/500x500/smart/alice-maze.jpg',
      },
    }],
  }],
  meta: { total: 1, per_page: 25, current_page: 1, last: 1 },
};

test('a performer is read from its parent, which is where the images are', async () => {
  const client = createTpdbClient(CONFIG, respondWith(PERFORMER_BODY));
  const [scene] = await client.searchScenes('x', 1);

  assert.deepEqual(scene?.performers, [{
    sourceUuid: 'parent-uuid',
    slug: 'alice-maze',
    name: 'Alice Maze',
    kind: 'performer',
    faceUrl: 'https://thumb.theporndb.net/x/500x500/smart/alice-maze.jpg',
    imageUrl: 'https://cdn.theporndb.net/p/alice-maze.jpg',
  }], 'the parent uuid and slug, not the site-prefixed ones');
});

test('a parentless performer falls back to itself and is a site performer', async () => {
  const body = structuredClone(PERFORMER_BODY);
  delete (body.data[0]!.performers[0] as { parent?: unknown }).parent;
  const client = createTpdbClient(CONFIG, respondWith(body));
  const [scene] = await client.searchScenes('x', 1);

  // `kind` is what decides the URL namespace later: /performer-sites/, not
  // /performers/, because the site-prefixed slug is not a performer page.
  assert.deepEqual(scene?.performers, [{
    sourceUuid: 'site-performer-uuid',
    slug: '6061-alice-maze',
    name: 'Alice Maze',
    kind: 'performer-site',
    faceUrl: null,
    imageUrl: null,
  }]);
});

test('a performer with no usable identity is dropped, not half-read', async () => {
  // No slug means no link and no stable key. A row keyed on '' would collide
  // with every other such performer under UNIQUE (source, source_uuid).
  const body = structuredClone(PERFORMER_BODY);
  const performer = body.data[0]!.performers[0] as Record<string, unknown>;
  delete performer['parent'];
  performer['slug'] = '';
  const client = createTpdbClient(CONFIG, respondWith(body));
  const [scene] = await client.searchScenes('x', 1);
  assert.deepEqual(scene?.performers, []);
});

test('the scene slug is captured and the studio url is not mistaken for it', async () => {
  const client = createTpdbClient(CONFIG, respondWith(PERFORMER_BODY));
  const [scene] = await client.searchScenes('x', 1);
  assert.equal(scene?.slug, 'futilestruggles-alice-maze-first-time-day-1-episode-1');
});
```

- [ ] **Step 2: Run them and watch them fail**

```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
npm run test:server 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)"
```

Expected: the four new tests fail. The existing
`assert.deepEqual(scene?.performers, ['Jessica Jaymes'], …)` also fails once
Step 3 lands — update it in the same step, keeping its comment about `name`
versus `full_name`, which is still true and still load-bearing.

- [ ] **Step 3: Add the type**

In `packages/plugin-api/src/types.ts`, above `MetadataCandidate`:

```ts
/**
 * One performer on a scene, as the metadata service describes them.
 *
 * `kind` records which of the service's two namespaces this identity lives
 * in, because that decides the page it links to. It is set by the same branch
 * that decides where the images came from — a performer read from a `parent`
 * is canonical, a parentless one is a site alias — so the link and the avatar
 * cannot disagree about which entity this is.
 */
export interface MetadataPerformer {
  readonly sourceUuid: string;
  readonly slug: string;
  readonly name: string;
  readonly kind: 'performer' | 'performer-site';
  /** A square crop, suited to a thumbnail. */
  readonly faceUrl: string | null;
  /** The full image, for a modal. */
  readonly imageUrl: string | null;
}
```

Change `MetadataCandidate`:

```ts
  readonly performers: readonly MetadataPerformer[];
  /** The service's own slug for this scene, from which its page URL is built. */
  readonly slug: string | null;
```

- [ ] **Step 4: Implement the reader**

Replace `readPerformerNames` in `packages/core/src/clients/theporndb.ts`:

```ts
function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reads the performers off a scene, preferring each one's `parent`.
 *
 * A scene's `performers[]` are *site* performers: their slug is
 * site-prefixed (`6061-alice-maze`), and in the live payload their `image`,
 * `thumbnail` and `face` are all null. Everything worth showing — the
 * canonical slug and all three images — is on the nested `parent`. Reading
 * the outer object, which is what the field names invite, yields a card with
 * no avatars and links to alias pages.
 *
 * `face` is preferred for the thumbnail over `thumbnail`: it is a 500x500
 * smart crop centred on the face, where `thumbnail` is the poster scaled
 * down, and a full-body poster two lines high is unrecognisable.
 *
 * A performer with no slug is dropped rather than stored with an empty one:
 * the slug is the whole link, and the uuid it would be keyed on is likewise
 * absent in that case, so the row would collide with every other such
 * performer under `UNIQUE (source, source_uuid)`.
 *
 * `name`, never `full_name` — the latter carries a disambiguation suffix such
 * as `Jessica Jaymes (2005)`.
 */
function readPerformers(value: unknown): MetadataPerformer[] {
  if (!Array.isArray(value)) return [];
  const performers: MetadataPerformer[] = [];

  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const site = entry as Record<string, unknown>;
    const parentValue = site['parent'];
    const parent =
      parentValue !== null && typeof parentValue === 'object'
        ? (parentValue as Record<string, unknown>)
        : null;
    const source = parent ?? site;

    const slug = str(source, 'slug');
    const sourceUuid = str(source, 'id');
    const name = str(source, 'name') ?? str(site, 'name');
    if (slug === null || sourceUuid === null || name === null) continue;

    performers.push({
      sourceUuid,
      slug,
      name,
      kind: parent === null ? 'performer-site' : 'performer',
      faceUrl: str(source, 'face'),
      imageUrl: str(source, 'image'),
    });
  }
  return performers;
}
```

Add to the `scenes.push({…})` literal in `readScenes`:

```ts
      performers: readPerformers(record['performers']),
      slug: str(record, 'slug'),
```

Note the existing local `str` helper may not exist under that name in this
file — if the name is taken, call this one `text`. Do not shadow.

- [ ] **Step 5: Run the tests**

```
npm run check 2>&1 | grep -E "^✖|^ℹ (tests|pass|fail)|error TS"
```

Expected: all green. Every other construction of a `MetadataCandidate` in
tests now needs `performers: []` and `slug: null`; fix them.

- [ ] **Step 6: Prove the tests bite**

Change `parent ?? site` to `site`. Expected: the first test fails on both the
uuid and the images. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-api/src/types.ts packages/core/src/clients/theporndb.ts packages/core/test
git commit -m "Read performers from their parent, where the images are"
```

---

### Task 2: Migration 7 — schema and the refetch backfill

**Files:**
- Modify: `packages/core/src/db/migrations.ts` (append after `version: 6`)
- Test: `packages/core/test/db/migrate.test.ts`

**Interfaces:**
- Produces: tables `performers`, `group_performers`; `group_metadata.scene_slug`; `metadata_queue` rows for every confirmed group.

- [ ] **Step 1: Write the failing test**

```ts
test('migration 7 re-queues confirmed groups so they refetch with performers', () => {
  const db = openMigratedTo(db_, 6);   // follow the file's existing helper
  db.prepare(`INSERT INTO media_groups (id, plugin, identity_key, display, search_text, created_at, list_rank_at)
              VALUES (1,'t','a','{}','a',1,1), (2,'t','b','{}','b',1,1), (3,'t','c','{}','c',1,1)`).run();
  db.prepare(`INSERT INTO group_metadata (group_id, state, source, fetched_at)
              VALUES (1,'confirmed','theporndb',1), (2,'none','theporndb',1)`).run();

  migrateTo(db, 7);

  // Confirmed only. A 'none' answer has nothing to enrich — re-asking it is
  // the loop `enqueueMetadata`'s guard exists to prevent — and group 3 was
  // never asked, so it queues on its own when someone browses to it.
  const queued = db.prepare('SELECT group_id FROM metadata_queue ORDER BY group_id').all();
  assert.deepEqual(queued.map((r) => (r as { group_id: number }).group_id), [1]);
});

test('migration 7 adds the performer tables and the scene slug', () => {
  const db = openMigratedTo(db_, 7);
  // Literal column lists, not a shape read back out of the schema: an
  // assertion derived from the thing under test cannot detect it changing.
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)');
  assert.deepEqual(
    columns.all('performers').map((r) => (r as { name: string }).name),
    ['id','source','source_uuid','slug','name','kind','face_url','face_path','image_url','image_path','fetched_at'],
  );
  assert.deepEqual(
    columns.all('group_performers').map((r) => (r as { name: string }).name),
    ['group_id','performer_id','position'],
  );
  assert.ok(
    columns.all('group_metadata').some((r) => (r as { name: string }).name === 'scene_slug'),
  );
});

test('two performers cannot share one source uuid', () => {
  const db = openMigratedTo(db_, 7);
  const insert = db.prepare(
    `INSERT INTO performers (source, source_uuid, slug, name, kind, fetched_at)
     VALUES ('theporndb', 'u', ?, 'N', 'performer', 1)`,
  );
  insert.run('a');
  assert.throws(() => insert.run('b'), /UNIQUE/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: `no such table: performers`.

- [ ] **Step 3: Write the migration**

```ts
  {
    version: 7,
    name: 'performer-identities',
    up(db) {
      db.exec(`
        CREATE TABLE performers (
          id          INTEGER PRIMARY KEY,
          source      TEXT    NOT NULL,
          source_uuid TEXT    NOT NULL,
          slug        TEXT    NOT NULL,
          name        TEXT    NOT NULL,
          kind        TEXT    NOT NULL,
          face_url    TEXT,
          face_path   TEXT,
          image_url   TEXT,
          image_path  TEXT,
          fetched_at  INTEGER NOT NULL,
          UNIQUE (source, source_uuid)
        );

        CREATE TABLE group_performers (
          group_id     INTEGER NOT NULL REFERENCES media_groups (id),
          performer_id INTEGER NOT NULL REFERENCES performers (id),
          position     INTEGER NOT NULL,
          PRIMARY KEY (group_id, performer_id)
        );
        CREATE INDEX group_performers_performer ON group_performers (performer_id);

        ALTER TABLE group_metadata ADD COLUMN scene_slug TEXT;
      `);

      // Every group already answered holds names and nothing else — no slug,
      // no avatar, no link. Queue them so the existing worker refetches at
      // its own rate. This bypasses `enqueueMetadata`'s "already answered"
      // guard deliberately: that guard stops a *lazy browse trigger* from
      // re-asking forever, and a one-time backfill is not that. Routing this
      // through the guard would mean weakening the guard.
      //
      // `state = 'confirmed'` only. A 'none' answer has no performers to
      // enrich, and re-asking it is exactly the loop the guard prevents.
      db.exec(`
        INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at)
        SELECT group_id, fetched_at, 0, fetched_at
        FROM group_metadata WHERE state = 'confirmed'
        ON CONFLICT (group_id) DO NOTHING
      `);
    },
  },
```

- [ ] **Step 4: Run the tests**

`npm run check` — expected green, including `assertUniqueVersions`.

- [ ] **Step 5: Prove the backfill is pinned**

Delete the `INSERT INTO metadata_queue` block. Expected: the first test fails
with `[] !== [1]`. Restore.

- [ ] **Step 6: Commit**

```bash
git commit -am "Add performer tables and re-queue answered groups"
```

---

### Task 3: The performers data-access module

**Files:**
- Create: `packages/core/src/db/performers.ts`
- Test: `packages/core/test/db/performers.test.ts`

**Interfaces:**
- Consumes: migration 7's tables.
- Produces:
  - `interface PerformerRow { id: number; sourceUuid: string; slug: string; name: string; kind: 'performer' | 'performer-site'; faceUrl: string | null; facePath: string | null; imageUrl: string | null; imagePath: string | null; }`
  - `upsertPerformers(db, source: string, performers: readonly MetadataPerformer[], now: number): number[]` — ids, in the order given.
  - `setGroupPerformers(db, groupId: number, performerIds: readonly number[]): void`
  - `performersForGroups(db, groupIds: readonly number[]): Map<number, PerformerRow[]>`
  - `getPerformer(db, id: number): PerformerRow | null`
  - `setPerformerArtwork(db, id: number, kind: 'face' | 'image', path: string): void`
  - `performersNeedingArtwork(db, ids: readonly number[]): PerformerRow[]`

- [ ] **Step 1: Write the failing tests**

```ts
test('upserting the same performer twice yields one row and one id', () => {
  const db = openTestDatabase();
  const performer: MetadataPerformer = {
    sourceUuid: 'u', slug: 'alice-maze', name: 'Alice Maze',
    kind: 'performer', faceUrl: 'f', imageUrl: 'i',
  };
  const [first] = upsertPerformers(db, 'theporndb', [performer], 1);
  const [second] = upsertPerformers(db, 'theporndb', [performer], 2);
  assert.equal(first, second);
  assert.equal(db.prepare('SELECT count(*) c FROM performers').get()?.['c'], 1);
});

test('a renamed slug updates the row it already had, keeping its id and artwork', () => {
  const db = openTestDatabase();
  const [id] = upsertPerformers(db, 'theporndb', [
    { sourceUuid: 'u', slug: 'old', name: 'N', kind: 'performer', faceUrl: 'f', imageUrl: 'i' },
  ], 1);
  setPerformerArtwork(db, id!, 'face', `${id}.jpg`);
  upsertPerformers(db, 'theporndb', [
    { sourceUuid: 'u', slug: 'new', name: 'N', kind: 'performer', faceUrl: 'f', imageUrl: 'i' },
  ], 2);

  const row = getPerformer(db, id!)!;
  // The uuid is the identity and the slug is presentation, so a rename is an
  // update, not a new performer — and the cached file it already fetched is
  // still its file.
  assert.equal(row.slug, 'new');
  assert.equal(row.facePath, `${id}.jpg`);
});

test('a group\'s performers come back in billing order', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  const ids = upsertPerformers(db, 'theporndb', [
    { sourceUuid: 'b', slug: 'b', name: 'Second', kind: 'performer', faceUrl: null, imageUrl: null },
    { sourceUuid: 'a', slug: 'a', name: 'First',  kind: 'performer', faceUrl: null, imageUrl: null },
  ], 1);
  setGroupPerformers(db, 1, ids);

  // The order TPDb gave, not id order and not alphabetical: 'Second' was
  // billed first and has the higher-sorting uuid, so any accidental sort
  // shows up here.
  assert.deepEqual(
    performersForGroups(db, [1]).get(1)?.map((p) => p.name),
    ['Second', 'First'],
  );
});

test('setGroupPerformers replaces the previous cast rather than adding to it', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  const first = upsertPerformers(db, 'theporndb', [
    { sourceUuid: 'a', slug: 'a', name: 'A', kind: 'performer', faceUrl: null, imageUrl: null },
  ], 1);
  setGroupPerformers(db, 1, first);
  const second = upsertPerformers(db, 'theporndb', [
    { sourceUuid: 'b', slug: 'b', name: 'B', kind: 'performer', faceUrl: null, imageUrl: null },
  ], 2);
  setGroupPerformers(db, 1, second);

  // A refetch that corrected the cast must not leave the old cast attached:
  // the whole point of the backfill is that the answer is replaced.
  assert.deepEqual(performersForGroups(db, [1]).get(1)?.map((p) => p.name), ['B']);
});

test('performersForGroups reads a whole page in one query', () => {
  // Issue #31: /api/downloads issues a query per row and polls it every three
  // seconds. Browse must not reacquire that defect.
  const db = openTestDatabase();
  for (const id of [1, 2, 3]) seedGroup(db, id);
  let queries = 0;
  const counted = countingDatabase(db, () => { queries += 1; });  // see helper below
  performersForGroups(counted, [1, 2, 3]);
  assert.equal(queries, 1);
});

test('an empty id list touches the database not at all', () => {
  const db = openTestDatabase();
  assert.equal(performersForGroups(db, []).size, 0);
});
```

For the query-counting test, wrap `prepare` rather than inventing a fake
database:

```ts
function countingDatabase(db: DatabaseSync, onPrepare: () => void): DatabaseSync {
  return new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === 'prepare' && typeof value === 'function') {
        return (sql: string) => {
          onPrepare();
          return (value as (s: string) => unknown).call(target, sql);
        };
      }
      return value;
    },
  }) as DatabaseSync;
}
```

- [ ] **Step 2: Run and watch fail** — module does not exist.

- [ ] **Step 3: Implement**

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { MetadataPerformer } from '@pickarr/plugin-api';
import { maybeStr, num, str, type SqlRow } from './row.ts';

export interface PerformerRow {
  id: number;
  sourceUuid: string;
  slug: string;
  name: string;
  kind: 'performer' | 'performer-site';
  faceUrl: string | null;
  facePath: string | null;
  imageUrl: string | null;
  imagePath: string | null;
}

const COLUMNS = `id, source_uuid, slug, name, kind, face_url, face_path, image_url, image_path`;

function toPerformer(row: SqlRow): PerformerRow {
  return {
    id: num(row, 'id'),
    sourceUuid: str(row, 'source_uuid'),
    slug: str(row, 'slug'),
    name: str(row, 'name'),
    kind: str(row, 'kind') === 'performer-site' ? 'performer-site' : 'performer',
    faceUrl: maybeStr(row, 'face_url'),
    facePath: maybeStr(row, 'face_path'),
    imageUrl: maybeStr(row, 'image_url'),
    imagePath: maybeStr(row, 'image_path'),
  };
}

/**
 * Inserts or refreshes each performer, answering their ids in the order given.
 *
 * The conflict target is `(source, source_uuid)` and the update deliberately
 * leaves `face_path` and `image_path` alone: those name files already on
 * disk, and the uuid is the identity, so a slug rename or a re-billing is an
 * update to a row that keeps its cached artwork. Overwriting the paths here
 * would orphan the files and re-download them on the next pass.
 *
 * The urls *are* updated: if the provider moved the image, the next artwork
 * pass should fetch the new one.
 */
export function upsertPerformers(
  db: DatabaseSync,
  source: string,
  performers: readonly MetadataPerformer[],
  now: number,
): number[] {
  const upsert = db.prepare(
    `INSERT INTO performers (source, source_uuid, slug, name, kind, face_url, image_url, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, source_uuid) DO UPDATE SET
       slug = excluded.slug, name = excluded.name, kind = excluded.kind,
       face_url = excluded.face_url, image_url = excluded.image_url,
       fetched_at = excluded.fetched_at
     RETURNING id`,
  );
  return performers.map((performer) => {
    const row = upsert.get(
      source, performer.sourceUuid, performer.slug, performer.name,
      performer.kind, performer.faceUrl, performer.imageUrl, now,
    );
    return num(row as SqlRow, 'id');
  });
}

/**
 * Replaces the group's cast wholesale. A refetch that corrected the cast must
 * not leave the previous one attached, and `position` is assigned here from
 * the array order rather than stored by the caller — the order is the
 * provider's billing order, and there is one place that knows it.
 */
export function setGroupPerformers(
  db: DatabaseSync,
  groupId: number,
  performerIds: readonly number[],
): void {
  db.prepare('DELETE FROM group_performers WHERE group_id = ?').run(groupId);
  const link = db.prepare(
    'INSERT INTO group_performers (group_id, performer_id, position) VALUES (?, ?, ?)',
  );
  performerIds.forEach((performerId, index) => link.run(groupId, performerId, index));
}

/**
 * One query for a whole page, for the reason `metadataForGroups` documents:
 * issue #31 records `/api/downloads` issuing a query per row and polling it
 * every three seconds, and browse must not reacquire that defect while
 * gaining this field.
 */
export function performersForGroups(
  db: DatabaseSync,
  groupIds: readonly number[],
): Map<number, PerformerRow[]> {
  const found = new Map<number, PerformerRow[]>();
  if (groupIds.length === 0) return found;
  const holes = groupIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT gp.group_id, ${COLUMNS} FROM group_performers gp
       JOIN performers ON performers.id = gp.performer_id
       WHERE gp.group_id IN (${holes})
       ORDER BY gp.group_id, gp.position`,
    )
    .all(...groupIds);
  for (const row of rows) {
    const groupId = num(row as SqlRow, 'group_id');
    const list = found.get(groupId) ?? [];
    list.push(toPerformer(row as SqlRow));
    found.set(groupId, list);
  }
  return found;
}

export function getPerformer(db: DatabaseSync, id: number): PerformerRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM performers WHERE id = ?`).get(id);
  return row === undefined ? null : toPerformer(row as SqlRow);
}

/** The artwork columns are written one at a time, as each fetch lands. */
export function setPerformerArtwork(
  db: DatabaseSync,
  id: number,
  kind: 'face' | 'image',
  path: string,
): void {
  const column = kind === 'face' ? 'face_path' : 'image_path';
  db.prepare(`UPDATE performers SET ${column} = ? WHERE id = ?`).run(path, id);
}

/** Those of these performers with a url but no file yet, in one query. */
export function performersNeedingArtwork(
  db: DatabaseSync,
  ids: readonly number[],
): PerformerRow[] {
  if (ids.length === 0) return [];
  const holes = ids.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM performers
       WHERE id IN (${holes})
         AND ((face_url IS NOT NULL AND face_path IS NULL)
           OR (image_url IS NOT NULL AND image_path IS NULL))`,
    )
    .all(...ids)
    .map((row) => toPerformer(row as SqlRow));
}
```

`column` is interpolated, not bound — SQLite cannot bind an identifier. It is
chosen from a two-value union, never from input.

- [ ] **Step 4: Run** — `npm run check`, green.

- [ ] **Step 5: Prove the ordering test bites**

Change `ORDER BY gp.group_id, gp.position` to `ORDER BY gp.group_id,
performers.id`. Expected: the billing-order test fails. Restore.

- [ ] **Step 6: Commit** — `git commit -am "Add the performers data-access module"`

---

### Task 4: Record performers with the metadata answer

**Files:**
- Modify: `packages/core/src/db/metadata.ts:190-246`
- Test: `packages/core/test/db/metadata.test.ts`

**Interfaces:**
- Consumes: `upsertPerformers`, `setGroupPerformers` (Task 3); `MetadataCandidate.slug` (Task 1).
- Produces: `GroupMetadata.sceneSlug`; `recordMetadataAnswer` is an upsert.

The spec's "Refetch of existing rows" section is the requirement. Read it.

- [ ] **Step 1: Write the failing tests**

```ts
test('a second answer replaces the first instead of being dropped', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 1, nearMisses: [],
    confirmed: candidate({ title: 'Old', performers: [], slug: 'old' }) });
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 2, nearMisses: [],
    confirmed: candidate({ title: 'New', performers: [], slug: 'new' }) });

  // The migration re-queues answered groups; ON CONFLICT DO NOTHING would
  // spend the API call and write nothing, leaving the group looking
  // refetched while holding its old data.
  const row = getGroupMetadata(db, 1)!;
  assert.equal(row.title, 'New');
  assert.equal(row.sceneSlug, 'new');
  assert.equal(row.fetchedAt, 2);
});

test('near misses do not accumulate across answers', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  const miss = { candidate: candidate({ title: 'X' }), reason: 'wrong date' };
  for (const now of [1, 2, 3]) {
    recordMetadataAnswer(db, { groupId: 1, source: 's', now, nearMisses: [miss],
      confirmed: candidate({ title: 'T' }) });
  }
  assert.equal(
    db.prepare('SELECT count(*) c FROM metadata_candidates WHERE group_id = 1').get()?.['c'],
    1,
  );
});

test('the answer writes the cast, and a later answer replaces it', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  recordMetadataAnswer(db, { groupId: 1, source: 'theporndb', now: 1, nearMisses: [],
    confirmed: candidate({ performers: [
      { sourceUuid: 'a', slug: 'a', name: 'A', kind: 'performer', faceUrl: null, imageUrl: null },
    ] }) });
  recordMetadataAnswer(db, { groupId: 1, source: 'theporndb', now: 2, nearMisses: [],
    confirmed: candidate({ performers: [
      { sourceUuid: 'b', slug: 'b', name: 'B', kind: 'performer', faceUrl: null, imageUrl: null },
    ] }) });

  assert.deepEqual(performersForGroups(db, [1]).get(1)?.map((p) => p.name), ['B']);
});

test('a none answer clears any cast the group had', () => {
  const db = openTestDatabase();
  seedGroup(db, 1);
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 1, nearMisses: [],
    confirmed: candidate({ performers: [
      { sourceUuid: 'a', slug: 'a', name: 'A', kind: 'performer', faceUrl: null, imageUrl: null },
    ] }) });
  recordMetadataAnswer(db, { groupId: 1, source: 's', now: 2, nearMisses: [], confirmed: null });

  // Otherwise a group that stopped being confirmed keeps a cast nothing
  // supports, and the card renders performers under a 'none' state.
  assert.equal(performersForGroups(db, [1]).get(1), undefined);
});
```

`candidate(over)` is a local helper building a `MetadataCandidate` with every
field defaulted; add it if the file lacks one.

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

Add `sceneSlug: string | null` to `GroupMetadata`, `sceneSlug: maybeStr(row,
'scene_slug')` to `toMetadata`, and `scene_slug` to `COLUMNS` **between
`poster_path` and `fetched_at`**:

```ts
const COLUMNS = `group_id, state, source, source_uuid, title, performers, release_date,
                 duration_s, synopsis, poster_url, poster_path, scene_slug, fetched_at`;
```

The position is not cosmetic. `COLUMNS` is interpolated straight into the
insert's column list, so it fixes the order the placeholders bind in — 13
columns, of which `poster_path` is the literal `NULL` in position 11, leaving
12 binds ending `…, confirmed?.slug ?? null, input.now`. Appending
`scene_slug` after `fetched_at` instead would silently write the timestamp
into the slug and the slug into `fetched_at`: both columns are permissive
enough to accept it, so nothing would throw. Verified separately that
`ALTER TABLE … ADD COLUMN` puts the column last in `pragma_table_info` while
leaving named-column inserts unaffected — physical order and this list are
independent.

Rewrite the insert as an upsert and replace the `changes > 0` gate:

```ts
    db.prepare(
        `INSERT INTO group_metadata (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT (group_id) DO UPDATE SET
           state = excluded.state, source = excluded.source,
           source_uuid = excluded.source_uuid, title = excluded.title,
           performers = excluded.performers, release_date = excluded.release_date,
           duration_s = excluded.duration_s, synopsis = excluded.synopsis,
           poster_url = excluded.poster_url, scene_slug = excluded.scene_slug,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        input.groupId,
        confirmed === null ? 'none' : 'confirmed',
        input.source,
        confirmed?.sourceUuid ?? null,
        confirmed?.title ?? null,
        // The legacy name array stays written: it is the fallback the view
        // uses for groups whose refetch has not landed, and keeping it
        // current costs one JSON.stringify.
        confirmed === null ? null : JSON.stringify(confirmed.performers.map((p) => p.name)),
        confirmed?.date ?? null,
        confirmed?.durationSeconds ?? null,
        confirmed?.synopsis ?? null,
        confirmed?.posterUrl ?? null,
        confirmed?.slug ?? null,
        input.now,
      );

    // Candidates are cleared and rewritten rather than gated on "this is the
    // first answer". That gate was `changes > 0`, which meant something under
    // ON CONFLICT DO NOTHING and means nothing under DO UPDATE. Same
    // guarantee — near misses never accumulate — by a mechanism that
    // survives a group being answered more than once, which the migration's
    // refetch now makes routine.
    db.prepare('DELETE FROM metadata_candidates WHERE group_id = ?').run(input.groupId);
    const candidate = db.prepare(/* unchanged */);
    for (const miss of input.nearMisses) { /* unchanged */ }

    // The cast, replaced wholesale for the same reason. A 'none' answer
    // clears it: a group that stopped being confirmed must not keep a cast
    // nothing supports.
    const performerIds =
      confirmed === null
        ? []
        : upsertPerformers(db, input.source, confirmed.performers, input.now);
    setGroupPerformers(db, input.groupId, performerIds);
```

Rewrite the doc comment's "A group is answered exactly once, so the candidate
rows cannot accumulate across retries" — that invariant is gone. State the
new one: a group is answered at most once per queue entry, and each answer
replaces the last in full.

- [ ] **Step 4: Run** — `npm run check`.

- [ ] **Step 5: Prove it bites**

Restore `ON CONFLICT (group_id) DO NOTHING`. Expected: the first and third
tests fail. Restore the upsert.

- [ ] **Step 6: Commit** — `git commit -am "Replace a metadata answer rather than dropping the second"`

---

### Task 5: Generalise the artwork cache

**Files:**
- Modify: `packages/core/src/media/artwork.ts`
- Modify: call site `packages/core/src/pipeline/metadata.ts:410-413`
- Test: `packages/core/test/media/artwork.test.ts` (follow the existing file)

**Interfaces:**
- Produces: `cacheImage(deps: ArtworkDeps, key: string, url: string): Promise<string | null>`, `MAX_IMAGE_BYTES`, `IMAGE_TIMEOUT_MS`, `performerArtworkKey`.

Nothing about the streaming cap, the content-type allow-list,
temp-then-rename, the total-operation deadline or the never-throws contract is
poster-specific. Only the log wording and the filename's provenance are.

**This file changed on main.** It now carries `POSTER_TIMEOUT_MS`, an
`AbortSignal.timeout` turned into a rejection by `abortRejection`
(`packages/core/src/abort.ts`), and a `timedOut: Promise<never>` threaded into
`readBodyWithinCap` and raced against every body read. All of it is carried
across unchanged — it is what stops a dribbling host from holding the metadata
worker's `tryRun` mutex open forever, and avatars come from the same provider
in the same pass. The existing timeout tests must still pass after the rename;
they use `t.mock.timers` with `{ apis: ['AbortSignal.timeout'] }`, which is
fine server-side.

- [ ] **Step 1: Write the failing test**

```ts
test('a cached image is named from the key it was given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const name = await cacheImage(
    { dir, fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' } }), log: () => {} },
    'performer-face-7',
    'https://example.invalid/a.png',
  );
  // The extension comes from the validated content type, never the URL.
  assert.equal(name, 'performer-face-7.png');
  await rm(dir, { recursive: true, force: true });
});

test('a key is never taken from provider input', async () => {
  // Not a behavioural test of cacheImage — a guard on its callers. Both
  // compose the key from integers of our own, so no separator can reach it.
  // If this ever needs relaxing, the sanitising argument `cachePoster`
  // deliberately avoided has to be made explicitly instead.
  assert.equal(performerArtworkKey(7, 'face'), 'performer-face-7');
  assert.equal(performerArtworkKey(7, 'image'), 'performer-image-7');
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

Rename `cachePoster` → `cacheImage`, `MAX_POSTER_BYTES` → `MAX_IMAGE_BYTES`,
`POSTER_EXTENSIONS` → `IMAGE_EXTENSIONS`, `POSTER_TIMEOUT_MS` →
`IMAGE_TIMEOUT_MS`. Replace the `groupId: number` parameter with
`key: string`, in `cacheImage` and in `readBodyWithinCap`'s second parameter
alike; use `` `${key}.${extension}` `` as the filename and
`` `.${key}.${randomUUID()}.part` `` as the temp name; change the log prefix
from `poster for group ${groupId}` to `image ${key}`.

Keep every comment, including the whole `IMAGE_TIMEOUT_MS` block and the
per-chunk-versus-total-operation argument — none of it becomes less true for
an avatar. Two need a word changed rather than kept verbatim: the timeout's
sizing paragraph refers to `MAX_POSTER_BYTES` by name, and the
filename-provenance comment should now say the key is composed *by the
caller* from integers of our own. The argument is unchanged; its subject moved
one level up. Add:

```ts
/** Keys for a performer's two cached images. Integers only, by construction. */
export function performerArtworkKey(performerId: number, kind: 'face' | 'image'): string {
  return `performer-${kind}-${performerId}`;
}
```

Update the poster call site to `cacheImage(deps.artwork, String(row.groupId), confirmed.posterUrl)`.
The poster's filename is unchanged, so existing cached posters keep resolving.

- [ ] **Step 4: Run** — `npm run check`. Confirm the poster route's existing
tests still pass; the filename must not have changed.

- [ ] **Step 5: Commit** — `git commit -am "Generalise the poster cache to any image"`

---

### Task 6: Fetch performer artwork in the metadata worker

**Files:**
- Modify: `packages/core/src/pipeline/metadata.ts:408-415`
- Test: `packages/core/test/pipeline/metadata.test.ts`

**Interfaces:**
- Consumes: `cacheImage`, `performerArtworkKey` (Task 5); `performersNeedingArtwork`, `setPerformerArtwork` (Task 3).

- [ ] **Step 1: Write the failing tests**

```ts
test('a confirmed answer caches each performer\'s face and image', async () => {
  // …drive runMetadataPass with a client returning one performer with both
  // urls, and a fetchImpl serving image/jpeg.
  assert.deepEqual(fetched.toSorted(), ['https://f/face.jpg', 'https://i/image.jpg']);
  const performer = performersForGroups(db, [1]).get(1)![0]!;
  assert.equal(performer.facePath, `performer-face-${performer.id}.jpg`);
  assert.equal(performer.imagePath, `performer-image-${performer.id}.jpg`);
});

test('a performer already holding artwork is not refetched', async () => {
  // Two groups sharing one performer: the second pass must fetch nothing.
  // This is the whole reason performers are a table rather than a blob.
  assert.deepEqual(secondPassFetches, []);
});

test('an artwork failure does not fail the answer', async () => {
  // cacheImage never throws, and the answer is written before it runs — the
  // same contract the poster already has. A group whose avatars 404 still
  // shows its metadata.
  assert.equal(getGroupMetadata(db, 1)?.state, 'confirmed');
  assert.equal(performersForGroups(db, [1]).get(1)![0]!.facePath, null);
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**, directly after the existing poster block:

```ts
  // Performer artwork, on the same terms as the poster above: the answer is
  // already written, `cacheImage` never throws, and a missing avatar is not a
  // missing scene.
  //
  // `performersNeedingArtwork` is what makes the table pay for itself — a
  // performer appearing in fifty groups is fetched once, and every later
  // group that names them finds the files already there.
  const performerIds = (performersForGroups(deps.db, [row.groupId]).get(row.groupId) ?? [])
    .map((performer) => performer.id);
  for (const performer of performersNeedingArtwork(deps.db, performerIds)) {
    for (const kind of ['face', 'image'] as const) {
      const url = kind === 'face' ? performer.faceUrl : performer.imageUrl;
      const path = kind === 'face' ? performer.facePath : performer.imagePath;
      if (url === null || path !== null) continue;
      // Sequential on purpose: these are remote fetches against one provider,
      // and the pass already walks groups one at a time rather than opening
      // the throttle this file's cooldown logic exists to respect.
      // eslint-disable-next-line no-await-in-loop
      const stored = await cacheImage(deps.artwork, performerArtworkKey(performer.id, kind), url);
      if (stored !== null) setPerformerArtwork(deps.db, performer.id, kind, stored);
    }
  }
```

- [ ] **Step 4: Run** — `npm run check`.

- [ ] **Step 5: Prove the dedupe test bites**

Change `performersNeedingArtwork(deps.db, performerIds)` to read every
performer of the group regardless of stored paths. Expected: the
"already holding artwork" test fails. Restore.

- [ ] **Step 6: Commit** — `git commit -am "Cache performer avatars alongside the poster"`

---

### Task 7: Views and routes

**Files:**
- Modify: `packages/core/src/http/views.ts:24-85`
- Modify: `packages/core/src/http/server.ts` (near the poster route, ~443)
- Test: `packages/core/test/http/metadata.test.ts`, `packages/core/test/http/server.test.ts`

**Interfaces:**
- Consumes: `performersForGroups`, `getPerformer` (Task 3).
- Produces:
  - `MetadataView` confirmed variant gains `performers: PerformerView[]`, `performerNames: string[]`, `sceneUrl: string | null`.
  - `interface PerformerView { id: number; name: string; url: string; hasAvatar: boolean; hasImage: boolean; }`
  - `metadataViewOf(metadata, performers: readonly PerformerRow[], queuedNextAt?: number)`
  - `GET /api/performers/:id/avatar`, `GET /api/performers/:id/image`

**Main changed this signature under the plan.** It is now
`metadataViewOf(metadata, queuedNextAt?: number)` — the old boolean `queued`
became `metadata_queue.next_at`, read by the new `queuedMetadataNextAt`, and
`{ state: 'pending' }` became `{ state: 'pending'; nextAttemptAt: number }`.
Put `performers` **second, required**, pushing `queuedNextAt` to third. Second
because it is the parameter every caller must supply; required because an
optional one would let both existing call sites keep compiling while silently
reporting an empty cast, which is precisely the failure this ordering exists
to prevent. Do not touch the pending behaviour.

The two call sites are `toGroupView` (`views.ts:312`, serving browse and
picks) and `GET /api/metadata` (`server.ts:418`, which already reads
`queuedMetadataNextAt` for the page and now reads `performersForGroups` the
same way).

- [ ] **Step 1: Write the failing tests**

```ts
test('a performer links to /performers/ and a site performer to /performer-sites/', () => {
  const view = metadataViewOf(confirmedMetadata(), [
    row({ id: 1, slug: 'alice-maze',      kind: 'performer' }),
    row({ id: 2, slug: '6061-alice-maze', kind: 'performer-site' }),
  ]);
  assert.equal(view.state, 'confirmed');
  // Literal URLs. An expectation built by calling the same helper the view
  // calls would pass against any consistent-but-wrong mapping.
  assert.deepEqual(view.performers.map((p) => p.url), [
    'https://theporndb.net/performers/alice-maze',
    'https://theporndb.net/performer-sites/6061-alice-maze',
  ]);
});

test('a scene slug becomes a scene url, and its absence a null', () => {
  assert.equal(
    metadataViewOf(confirmedMetadata({ sceneSlug: 'my-scene' }), []).sceneUrl,
    'https://theporndb.net/scenes/my-scene',
  );
  assert.equal(metadataViewOf(confirmedMetadata({ sceneSlug: null }), []).sceneUrl, null);
});

test('a group with no performer rows falls back to the stored names', () => {
  // Groups answered before migration 7 keep their cast as plain names until
  // their refetch lands, rather than losing it.
  const view = metadataViewOf(confirmedMetadata({ performers: ['Alice Maze'] }), []);
  assert.deepEqual(view.performerNames, ['Alice Maze']);
  assert.deepEqual(view.performers, []);
});

test('a group with performer rows reports no fallback names', () => {
  // Both populated would leave the card to choose, and two lists that can
  // disagree is exactly what the separate field exists to avoid.
  const view = metadataViewOf(confirmedMetadata({ performers: ['Alice Maze'] }), [row({ id: 1 })]);
  assert.deepEqual(view.performerNames, []);
  assert.equal(view.performers.length, 1);
});

test('the avatar route serves the cached face and 404s without one', async () => {
  // …mirroring the poster route's tests, including the cache-control header.
  assert.equal(response.headers['cache-control'], 'public, max-age=86400');
});

test('the avatar route refuses a traversal in the id', async () => {
  const response = await server.inject({ method: 'GET', url: '/api/performers/..%2f..%2fetc/avatar' });
  assert.equal(response.statusCode, 400);
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

In `views.ts`:

```ts
const TPDB_BASE = 'https://theporndb.net';

/**
 * The link for one performer, built server-side so the two-namespace rule
 * lives in one place. Sending `kind` to the browser instead would mean the
 * client re-deriving a mapping it has no other reason to know, and two
 * derivations that can disagree.
 */
function performerUrl(performer: PerformerRow): string {
  const namespace = performer.kind === 'performer-site' ? 'performer-sites' : 'performers';
  return `${TPDB_BASE}/${namespace}/${performer.slug}`;
}
```

`metadataViewOf` becomes:

```ts
export function metadataViewOf(
  metadata: GroupMetadata | undefined,
  performers: readonly PerformerRow[],
  queuedNextAt?: number,
): MetadataView {
```

Its existing doc comment about `queuedNextAt` stays exactly as main wrote it.
The confirmed branch returns:

```ts
    performers: performers.map((performer) => ({
      id: performer.id,
      name: performer.name,
      url: performerUrl(performer),
      hasAvatar: performer.facePath !== null,
      hasImage: performer.imagePath !== null,
    })),
    // Only when there is nothing better. The two fields are never both
    // populated: a caller that had to choose between them could choose
    // differently in two places.
    performerNames: performers.length > 0 ? [] : metadata.performers,
    sceneUrl: metadata.sceneSlug === null ? null : `${TPDB_BASE}/scenes/${metadata.sceneSlug}`,
```

Update both `metadataViewOf` call sites to pass the performers read for the
whole page with `performersForGroups`, never per group. In `server.ts:415`
that sits directly beside the existing `queuedMetadataNextAt(db, ids)` — the
same shape of batched read, for the same reason.

In `server.ts`, add both routes beside the poster route, copying its structure
exactly: the same id validation (see the comment at line 167 about the poster
route's id), the same `reply.type(...).header('cache-control', 'public, max-age=86400')`,
the same 404-not-500 on a missing file.

- [ ] **Step 4: Run** — `npm run check`.

- [ ] **Step 5: Prove the URL test bites**

Swap the namespaces in `performerUrl`. Expected: the first test fails on both
URLs. Restore.

- [ ] **Step 6: Commit** — `git commit -am "Serve performer links and avatars"`

---

### Task 8: The image modal

**Files:**
- Create: `packages/web/src/components/ImageModal.tsx`
- Modify: `packages/web/src/api/client.ts:79-91`
- Create: `packages/web/test/ImageModal.test.tsx`

**Interfaces:**
- Produces: `<ImageModal src alt onClose />`, rendered only while open.
- Mirror `MetadataView` from Task 7 into `client.ts`, including `PerformerView`.

**Declare the three new fields optional in the web mirror** —
`performers?: PerformerView[]`, `performerNames?: string[]`,
`sceneUrl?: string | null` — and say why, following the comment main added to
`nextAttemptAt` directly above them. That comment is the precedent: this type
describes what a *response* can contain, and a response can come from a server
predating the field (a tab left open across a rollback, a stale bundle). Task
9 reads them with `?? []` and `?? null` rather than trusting absence to mean
anything. Core's `MetadataView` keeps them required — it describes what this
server *sends*, which is a different claim.

**Read the Global Constraints on Escape before writing a test for it.**

- [ ] **Step 1: Write the failing tests**

```ts
test('the close button closes', () => {
  let closed = false;
  render(<ImageModal src="/a.png" alt="A" onClose={() => { closed = true; }} />);
  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  assert.equal(closed, true);
});

test('a click on the backdrop closes, and one on the image does not', () => {
  let closes = 0;
  render(<ImageModal src="/a.png" alt="A" onClose={() => { closes += 1; }} />);
  fireEvent.click(screen.getByRole('img'));
  assert.equal(closes, 0, 'clicking the image must not dismiss it');
  fireEvent.click(screen.getByRole('dialog'));
  assert.equal(closes, 1, 'a native modal reports a backdrop click as a click on the dialog');
});

test('the image is labelled and scaled to fit rather than cropped', () => {
  render(<ImageModal src="/a.png" alt="Poster for Alpha" onClose={() => {}} />);
  assert.ok(screen.getByRole('img', { name: 'Poster for Alpha' }));
});

// No Escape test here. happy-dom implements `showModal()` but not
// Escape-to-close: an open dialog given a bubbling, cancelable Escape keydown
// stays open and fires neither `cancel` nor `close`. A test asserting the
// modal closes would fail against correct code; one asserting it stays open
// would pass against broken code. Escape is covered in
// `packages/e2e/src/metadata-modal.spec.ts`, in a real browser.
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useRef } from 'react';

interface Props {
  src: string;
  alt: string;
  onClose: () => void;
}

/**
 * A full-size image over the page, closed by the X, a click outside, or
 * Escape.
 *
 * Built on a native `<dialog>` opened with `showModal()` rather than a
 * positioned div: that is what makes the rest of the page inert, traps focus
 * inside, restores it on close, and paints a backdrop — four things worth
 * having and none worth hand-rolling.
 *
 * Escape is the browser's, surfaced through `cancel` so the React state that
 * owns "which image is open" is updated rather than left describing a dialog
 * the DOM has already closed. Note that happy-dom does not implement it, so
 * this path is covered by a Playwright spec and not by the unit tests beside
 * this file.
 */
export function ImageModal({ src, alt, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null || element.open) return;
    element.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="image-modal"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      // A click on the backdrop of a native modal targets the dialog itself;
      // a click on anything inside targets that child. Comparing the target
      // to the element is the whole of "clicked outside".
      onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    >
      <button type="button" className="image-modal-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <img src={src} alt={alt} />
    </dialog>
  );
}
```

`onCancel` calls `preventDefault` so the dialog is closed by React unmounting
it, not by the browser closing it underneath React — otherwise the parent's
state still says open and the next open is a no-op.

- [ ] **Step 4: Run** — `npm run check`.

- [ ] **Step 5: Prove the backdrop test bites**

Change the click handler to unconditional `onClose()`. Expected: the
click-on-image assertion fails. Restore.

- [ ] **Step 6: Commit** — `git commit -am "Add the image modal"`

---

### Task 9: Card layout

**Files:**
- Modify: `packages/web/src/components/MediaCard.tsx:163-193`
- Modify: `packages/web/src/styles.css`
- Test: `packages/web/test/MediaCard.test.tsx`

**Interfaces:**
- Consumes: `ImageModal` (Task 8), the `MetadataView` mirror (Task 8).

**Two things main added to this file must survive.** The card renders
`{group.metadata.state === 'pending' && <p className="metadata-pending">pending</p>}`
above the metadata section — leave it exactly where it is. An absolutely
positioned poster is out of flow so the two do not compete, and a pending
group has no poster to show anyway. And the long comment above the
`state === 'confirmed'` block was rewritten to account for that note; edit it
only to the extent the poster moving out of the section makes it wrong.

Because the fields are optional in the web mirror (Task 8), read them as
`group.metadata.performers ?? []`, `group.metadata.performerNames ?? []` and
`group.metadata.sceneUrl ?? null`. The line numbers below are pre-rebase and
will have moved.

- [ ] **Step 1: Write the failing tests**

```ts
test('the poster is a button that opens the modal, and the modal closes', () => {
  render(<MediaCard group={withMetadata({ hasPoster: true })} onPick={() => {}} />);
  assert.equal(screen.queryByRole('dialog'), null);
  fireEvent.click(screen.getByRole('button', { name: /poster/i }));
  assert.ok(screen.getByRole('dialog'));
  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  assert.equal(screen.queryByRole('dialog'), null);
});

test('a performer shows an avatar, and their name links to their page', () => {
  render(<MediaCard group={withMetadata({ performers: [
    { id: 4, name: 'Alice Maze', url: 'https://theporndb.net/performers/alice-maze',
      hasAvatar: true, hasImage: true },
  ] })} onPick={() => {}} />);

  const link = screen.getByRole('link', { name: 'Alice Maze' });
  // A literal, not the value from the fixture: both ends agreeing on a wrong
  // string is the failure this style of assertion exists to catch.
  assert.equal(link.getAttribute('href'), 'https://theporndb.net/performers/alice-maze');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(screen.getByRole('img', { name: /alice maze/i }).getAttribute('src'),
    '/api/performers/4/avatar');
});

test('a performer with no cached avatar renders a name and no image', () => {
  render(<MediaCard group={withMetadata({ performers: [
    { id: 4, name: 'Alice Maze', url: 'https://theporndb.net/performers/alice-maze',
      hasAvatar: false, hasImage: false },
  ] })} onPick={() => {}} />);
  assert.ok(screen.getByRole('link', { name: 'Alice Maze' }));
  assert.equal(screen.queryByRole('img', { name: /alice maze/i }), null);
});

test('a performer avatar opens the full image, not the face', () => {
  // Two sizes exist for a reason: the thumbnail is a 500x500 crop, the modal
  // wants the poster.
  fireEvent.click(screen.getByRole('button', { name: /alice maze/i }));
  assert.equal(screen.getByRole('dialog').querySelector('img')?.getAttribute('src'),
    '/api/performers/4/image');
});

test('a performer with no full image is not clickable', () => {
  // Opening a modal onto a 404 is worse than not offering it.
  assert.equal(screen.queryByRole('button', { name: /alice maze/i }), null);
});

test('legacy metadata renders plain names with no links or avatars', () => {
  render(<MediaCard group={withMetadata({ performers: [], performerNames: ['Alice Maze'] })}
                    onPick={() => {}} />);
  assert.ok(screen.getByText('Alice Maze'));
  assert.equal(screen.queryByRole('link', { name: 'Alice Maze' }), null);
});

test('the metadata title links to the scene when a url is known', () => {
  render(<MediaCard group={withMetadata({ title: 'Scene', sceneUrl: 'https://theporndb.net/scenes/s' })}
                    onPick={() => {}} />);
  assert.equal(screen.getByRole('link', { name: 'Scene' }).getAttribute('href'),
    'https://theporndb.net/scenes/s');
});

test('the metadata title without a url is not a link', () => {
  render(<MediaCard group={withMetadata({ title: 'Scene', sceneUrl: null })} onPick={() => {}} />);
  assert.ok(screen.getByText('Scene'));
  assert.equal(screen.queryByRole('link', { name: 'Scene' }), null);
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement**

State: `const [modal, setModal] = useState<{ src: string; alt: string } | null>(null);`
and render `{modal !== null && <ImageModal {...modal} onClose={() => setModal(null)} />}`
at the end of the article. One piece of state, so two modals can never be open.

Move the poster out of `.metadata` to immediately after `<header>`, wrapped in
a button:

```tsx
      {group.metadata.state === 'confirmed' && group.metadata.hasPoster && (
        <button
          type="button"
          className="poster-thumb"
          onClick={() => setModal({ src: `/api/groups/${group.id}/poster`,
                                    alt: `Poster for ${display.title}` })}
        >
          <img src={`/api/groups/${group.id}/poster`} alt={`Poster for ${display.title}`} />
        </button>
      )}
```

Title:

```tsx
          {group.metadata.title !== null && (
            <p className="metadata-title">
              {group.metadata.sceneUrl === null ? (
                group.metadata.title
              ) : (
                <a href={group.metadata.sceneUrl} target="_blank" rel="noopener noreferrer">
                  {group.metadata.title}
                </a>
              )}
            </p>
          )}
```

Performers — the structured list, then the legacy fallback:

```tsx
          {group.metadata.performers.length > 0 && (
            <ul className="metadata-performers">
              {group.metadata.performers.map((performer) => (
                <li key={performer.id}>
                  {performer.hasAvatar &&
                    (performer.hasImage ? (
                      <button
                        type="button"
                        className="avatar-thumb"
                        onClick={() => setModal({ src: `/api/performers/${performer.id}/image`,
                                                  alt: performer.name })}
                      >
                        <img src={`/api/performers/${performer.id}/avatar`} alt={performer.name} />
                      </button>
                    ) : (
                      // A face with no full image: shown, not clickable.
                      // Opening a modal onto a 404 is worse than not offering.
                      <img className="avatar-thumb"
                           src={`/api/performers/${performer.id}/avatar`} alt={performer.name} />
                    ))}
                  <a href={performer.url} target="_blank" rel="noopener noreferrer">
                    {performer.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {group.metadata.performerNames.length > 0 && (
            // Answered before migration 7 and not yet refetched: names only,
            // and no link, because no slug was stored to build one from.
            <ul className="metadata-performers">
              {group.metadata.performerNames.map((name) => <li key={name}>{name}</li>)}
            </ul>
          )}
```

CSS: `.media-card { position: relative; }`, `.poster-thumb { position: absolute;
top: …; right: …; }` with a bounded `max-width`/`max-height` and no forced
aspect ratio (the provider's images are frequently landscape — the existing
comment says so and stays true). `.avatar-thumb img { height: 2.4em; width:
2.4em; object-fit: cover; border-radius: 50%; }` — about two lines high.
`.image-modal img { max-width: 100vw; max-height: 100vh; object-fit: contain; }`.
Both thumb buttons need `padding: 0; border: none; background: none; cursor: pointer;`.

- [ ] **Step 4: Run** — `npm run check`.

- [ ] **Step 5: Commit** — `git commit -am "Lay out the poster, avatars and links on the card"`

---

### Task 10: Escape closes the modal, in a real browser

**Files:**
- Create: `packages/e2e/src/metadata-modal.spec.ts`
- Test: itself

**Interfaces:**
- Consumes: the harness in `packages/e2e/src/harness.ts`; follow an existing spec's seeding.

This exists because happy-dom cannot answer the question. See Global
Constraints.

- [ ] **Step 1: Write the spec**

```ts
test('the poster modal closes on Escape, on a click outside, and on the X', async ({ page }) => {
  // Seeded with a confirmed metadata row and a poster file on disk.
  await page.goto(url('/browse'));
  const dialog = page.getByRole('dialog');

  await page.getByRole('button', { name: /poster/i }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  // The property no unit test in this repo can check: happy-dom implements
  // showModal() but not Escape-to-close, so this assertion only means
  // anything here.
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: /poster/i }).click();
  await expect(dialog).toBeVisible();
  // Top-left corner: outside the centred image, inside the backdrop.
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: /poster/i }).click();
  await page.getByRole('button', { name: /close/i }).click();
  await expect(dialog).toBeHidden();
});

test('a performer avatar opens the full image', async ({ page }) => {
  await page.goto(url('/browse'));
  await page.getByRole('button', { name: 'Alice Maze' }).click();
  await expect(page.getByRole('dialog').getByRole('img'))
    .toHaveAttribute('src', /\/api\/performers\/\d+\/image$/);
});
```

- [ ] **Step 2: Run**

```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
npm run e2e
```

- [ ] **Step 3: Prove the Escape assertion is real**

Remove the `onCancel` handler from `ImageModal`. The dialog still closes
natively, but React state says open — assert the behaviour actually observed
and make sure the spec distinguishes the two. If removing `onCancel` leaves
the spec green, the spec is checking the DOM and not the state; strengthen it
by re-opening the modal afterwards and asserting it appears again.

- [ ] **Step 4: Commit** — `git commit -am "Cover the modal's Escape and backdrop in a real browser"`

---

## Self-Review

**Spec coverage.** Bullet 1 → Tasks 8, 9, 10. Bullet 2 → Tasks 1, 3, 5, 6, 7,
8, 9, 10. Bullet 3 → Tasks 1, 7, 9. Bullet 4 → Tasks 1, 4, 7, 9. The refetch
of existing rows → Tasks 2 and 4. No spec section is unimplemented.

**Type consistency.** `MetadataPerformer` (Task 1) is consumed by
`upsertPerformers` (Task 3) and `recordMetadataAnswer` (Task 4).
`PerformerRow` (Task 3) is consumed by `metadataViewOf` (Task 7) and the
artwork pass (Task 6). `PerformerView` (Task 7) is mirrored in `client.ts`
(Task 8) and consumed by `MediaCard` (Task 9). `performerArtworkKey` (Task 5)
is used only in Task 6 and must produce the filenames Task 6's tests assert.

**Known risk.** Task 7 changes `metadataViewOf`'s signature, which every
caller must be updated for in the same task — browse, picks, and
`GET /api/metadata`. A caller that keeps passing two arguments will typecheck
if the new parameter is optional; it is not optional, deliberately, so the
compiler finds them.
