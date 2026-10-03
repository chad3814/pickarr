# Several Images Per Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the five best posters, backgrounds, logos and person pictures per owner, ranked as the artwork job already ranks them; replicate the rows (never the files) to the browser; serve each image by its own row id; show every stored image in the card's gallery. Issue #79, with no picking.

**Architecture:** Migration 27 adds a `rank` column to the four artwork tables and starts replicating them (triggers plus a seeded log). The artwork job ranks every provider image with the existing `bestImage` ordering, keeps the first five per kind, attaches each with its rank, and calls a set-based `keepTop` that deletes the rest. The route serves by row id. The browser gathers artwork rows from the replica's `by_media_item` and `by_person` indexes into ranked lists, shows the top poster, and hands every image to the existing multi-image gallery.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `node:sqlite`, the host's sync log and triggers, React 19, `node:test`, `@testing-library/react`, `fake-indexeddb`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-multiple-images-design.md`

## Global Constraints

- Worktree `/Users/chad/Projects/pickarr/worktrees/phase7-multiple-images`, branch `phase7-multiple-images`. Never edit `worktrees/main`, never push, never merge, never bare `git stash`.
- `ARTWORK_KEEP = 5` per kind per media item and per person. Ordering is `bestImage`'s: configured language first, then `null` language, then anything else; within a tier score descending; then url ascending. `rank` is the index in that order, 0 best.
- Migration **27**: `ALTER TABLE <t> ADD COLUMN rank INTEGER NOT NULL DEFAULT 0` for `poster`, `background`, `logo`, `person_image` (plain ADD COLUMN, no rebuild), then `installSyncTriggers(db, [...four])` and `seedSyncLog(db, [...four])` as the last statements. Read `docs/database-migrations.md` first.
- `ImageInit` gains `rank: number`; every attach writes `rank` on insert and `ON CONFLICT … DO UPDATE SET … rank = excluded.rank`.
- `keepOnly(table, owner, url)` becomes `keepTop(table, owner, urls: readonly string[])`: delete every row for the owner whose `url` is not in `urls`, unlink their files. Table names spelled literally per statement (the hygiene script reads them).
- `HOST_SYNCED_TABLES` gains `poster`, `background`, `logo`, `person_image` (fourteen). Projections verbatim: `id, media_item_id AS mediaItemId, width, height, language, rank, created_at AS createdAt` (three media tables); `id, person_id AS personId, width, height, language, rank, created_at AS createdAt` (`person_image`). **Never `url`, never `path`.** Contract read shapes `ArtworkSyncRead` and `PersonImageSyncRead` with exactly those fields.
- No replica (`SCHEMA_VERSION`) bump. `TABLES_WITH_UPDATED_AT` untouched.
- Route `GET /api/artwork/:kind/:id`: `:id` is the artwork row id; queries verbatim `SELECT path FROM poster WHERE id = ? AND path IS NOT NULL` (and `background`, `logo`, `person_image` for `person`). Guard, 404, ETag, sniffing unchanged.
- Browser URL for a row is `/api/artwork/<kind>/<id>` with `kind` ∈ `poster|background|logo|person`. Lists sorted by `rank` ascending, then `id` ascending.
- `MediaDetails`: detail image `posters[0]`; placeholder directly when there is no poster row; gallery order posters → backgrounds → each top-billed cast member's pictures; captions the title for the item's images and the person's name for theirs; logos not rendered.
- No `any`; narrow instead of cast. A comment must be true of the code beside it. Web tests: `afterEach(cleanup)`, never a live DOM node to `node:assert`, no `t.mock.timers`. `.ts` store tests under the server runner; `.tsx` under the web runner's node invocation plus the file path.
- Gate: `npm run check > file 2>&1; echo $?`. `timeout` is not a macOS command. Signing: retry once, then `git -c commit.gpgsign=false commit …` and report UNSIGNED.

## Review Focus

1. **A provider answering two images with the same url for one owner** (TVDB does repeat urls across types). `(owner, url)` is unique, so the second attach upserts the first row and `keepTop` must not delete it; the kind holds fewer than five. Test in Task 2.
2. **A re-run that demotes a previously kept image out of the top five while another job's bytes for it are still being written.** `keepTop` runs after all attaches of a kind settle, so the deletion sees the final set; a test pins that `keepTop` is called once per kind after `Promise.all`. Test in Task 2.
3. **An artwork row whose `media_item` row has not replicated yet.** `gather` keys on the media item's own id, so an early poster row is simply there when the item arrives; nothing throws on a poster with no item. Test in Task 4.
4. **Pre-upgrade rows all at `rank` 0 for a kind that later gains more**: the old row and the new rank-0 row tie; the tie breaks on `id`, so the older row stays first until its next job reranks. Test the tie-break in Task 4.
5. **A gallery whose only poster fails to load** must still open on the background (today's behaviour) and must not loop when every image of a kind fails. Test in Task 5.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/host/src/db/migrate.ts`, `db/schema.ts`; `packages/contract/src/media.ts` (`ImageInit`), `sync.ts`, `index.ts` | migration 27, `rank`, read shapes | 1 |
| `packages/host/src/sync/tables.ts`, `api/artwork-route.ts`, `api/server.ts` (route doc) | fourteen synced tables, per-row route | 1 |
| `packages/host/src/media/writer.ts` | `rank` in attaches, `keepTop` | 2 |
| `packages/openmetadata/src/artwork/source.ts`, `job.ts`, `src/testing.ts` | `rankImages`, `ARTWORK_KEEP`, per-kind attach loop | 2 |
| `packages/web/src/store/gather.ts`; `packages/plugin-ui/src/types.ts`; `packages/web/src/library/useGatheredItem.ts` | ranked lists, per-row URLs, artwork subscriptions | 3 |
| `packages/plugin-ui/src/MediaDetails.tsx`; `packages/plugin-{tv,movie,xxx}/test/*` fixtures | top poster, full gallery | 4 |
| `packages/e2e/src/harness-2.ts`, `packages/e2e/tests/media-details.spec.ts`, `tests/artwork.spec.ts` (new) | seeds and e2e | 5 |

Task 1 first. Tasks 2 and 3 depend only on Task 1 and may run in parallel. Task 4 depends on 3. Task 5 depends on all.

---

### Task 1: Migration 27, read shapes, synced tables, per-row route

**Files:**
- Modify: `packages/host/src/db/migrate.ts` (after `MIGRATION_26` ~1469; `MIGRATIONS` array tail ~1471), `packages/host/src/db/schema.ts` (drizzle mirror of the four tables, ~430-500)
- Modify: `packages/contract/src/media.ts` (`ImageInit` ~50-57), `packages/contract/src/sync.ts` (after `RoleSyncRead` ~418), `packages/contract/src/index.ts`
- Modify: `packages/host/src/sync/tables.ts` (`HOST_SYNCED_TABLES` ~200-211; `selectSql` switch ~241-295; docblock)
- Modify: `packages/host/src/api/artwork-route.ts` (`ARTWORK_QUERY` ~112 and its docblock ~70-111), `packages/host/src/api/server.ts` (route comment ~977-998 names `:mediaItemId`; rename the path param doc to `:id`)
- Test: `packages/host/test/db/migrate.test.ts` (the `migration 23 …` test ~1829), `packages/host/test/sync/tables.test.ts` (count assertions ~71, ~99), `packages/host/test/api/artwork-route.test.ts`, `packages/host/test/api/server.test.ts` (~1317, ~1352), `packages/host/test/db/schema.test.ts`

**Interfaces:**
- Produces (contract):

```ts
// media.ts
export interface ImageInit { url: string; title: string | null; language: string | null; bytes: Uint8Array; rank: number; }
// sync.ts
export interface ArtworkSyncRead { id: number; mediaItemId: number; width: number; height: number; language: string | null; rank: number; createdAt: number; }
export interface PersonImageSyncRead { id: number; personId: number; width: number; height: number; language: string | null; rank: number; createdAt: number; }
```
- Produces (host): `HOST_SYNCED_TABLES` has fourteen entries ending `'poster', 'background', 'logo', 'person_image'`; `ARTWORK_QUERY` keyed by row id.

- [ ] **Step 1: Write the failing tests**

`migrate.test.ts`: change the title and body of the migration-23 test to assert `person_image` **is** replicated after a full migrate (three triggers in `sqlite_master`), and add:

```ts
test('migration 27 adds rank to the four artwork tables, replicates them, and seeds their existing rows', () => {
  const { raw } = openTestDatabase();
  // `migrateHostWith(raw, list)` (migrate.ts ~1479) applies a given list; the migration-16 seed test (~1273) uses it the same way.
  migrateHostWith(raw, MIGRATIONS.filter((m) => m.version <= 26));
  // seed one poster row pre-27 so the seed is observable
  raw.prepare("INSERT INTO media_item (id, plugin_id, title, created_at, updated_at) VALUES (1, 'tv', 'A', 1, 1)").run();
  raw.prepare("INSERT INTO poster (media_item_id, url, width, height, created_at, path) VALUES (1, 'http://x/p.png', 10, 15, 1, '/tmp/p.bin')").run();
  migrateHost(raw);
  for (const table of ['poster', 'background', 'logo', 'person_image']) {
    const cols = raw.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r['name']));
    assert.ok(cols.includes('rank'), `${table}.rank`);
    const triggers = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(table).map((r) => String(r['name'])).toSorted();
    assert.deepEqual(triggers, [`${table}_sync_del`, `${table}_sync_ins`, `${table}_sync_upd`]);
  }
  assert.equal(raw.prepare("SELECT rank FROM poster WHERE id = 1").get()?.['rank'], 0, 'existing rows default to rank 0');
  assert.equal(raw.prepare("SELECT count(*) AS n FROM sync_log WHERE table_name = 'poster' AND op = 'upsert'").get()?.['n'], 1, 'the existing row was seeded into the log');
});
```
If no partial-migrate helper exists, write the test as: migrate fully, then check columns/triggers, then insert a poster and assert the insert trigger logged it (the seed itself is then pinned by `migration16`'s precedent test pattern — read how migrate.test pins `seedSyncLog` for `rss_feed` and copy that shape).

`tables.test.ts`: the count assertion becomes 14; rename/extend the `plugin_destination is the tenth …` test with `person_image is the fourteenth host synced table` listing all fourteen in order. The lockstep tests need no edits but will fail until the shapes exist (they drive `HOST_SYNCED_TABLES`). Add:

```ts
test('the artwork projections carry neither url nor path', () => {
  for (const table of ['poster', 'background', 'logo', 'person_image']) {
    const sql = selectSql(table, '?');   // or however the test file reaches the SQL; see `readHostRows never projects a path…` at ~193
    assert.doesNotMatch(sql, /\burl\b/);
    assert.doesNotMatch(sql, /\bpath\b/);
  }
});
```

`artwork-route.test.ts`: replace `several posters for one media item serve the first-written one` (~185) with:

```ts
test('each kind is served by its own row id, and another row of the same owner is not touched', async () => {
  // seed two posters for media item 1 with ids 10 and 11 and distinct paths; readArtwork('poster', 11) serves path 11's bytes; the stat spy never sees path 10
});
test('an unknown row id is 404', …);
test('a person picture is served by its person_image row id, not the person id', …);
```
Update the query-plan test (~355): every `ARTWORK_QUERY` now seeks the primary key (`SEARCH … USING INTEGER PRIMARY KEY (rowid=?)`) and none sorts; the null-path shadowing tests (~221, ~247) become one test: a row whose `path` is null is 404 by its own id.

`server.test.ts` ~1317 and ~1352: the URLs become `/api/artwork/poster/<posterRowId>` and `/api/artwork/person/<personImageRowId>`; read the ids back after seeding.

`schema.test.ts` ("every schema index/column matches the migration DDL" or similar): will fail until `db/schema.ts` gains `rank` on the four tables.

- [ ] **Step 2: Run and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/db/migrate.test.ts packages/host/test/sync/tables.test.ts packages/host/test/api/artwork-route.test.ts 2>&1 | grep -E "^not ok|✖" | head` — FAIL.

- [ ] **Step 3: Contract**

`ImageInit.rank: number` with doc: the image's position in the job's ranking, 0 best, written on every attach. `ArtworkSyncRead`/`PersonImageSyncRead` after `RoleSyncRead`, with a docblock: replicated so a card can know how many images exist and in what order; **no `url` (a provider URL — the `rss_item.link` rule) and no `path` (a local filename)**; the browser reaches the bytes through `/api/artwork/<kind>/<id>`. Export both from `index.ts`.

- [ ] **Step 4: Migration 27 and schema**

```ts
/**
 * Several images per kind (design spec 2026-10-02, #79). `rank` is the
 * job's ordering, 0 best; existing rows default to 0, and each kind held
 * one row until now, so nothing ties until the next job reranks.
 *
 * ADD COLUMN only -- no rebuild, so no trigger is lost (`docs/database-migrations.md`).
 * The four tables start replicating here: triggers for every later write,
 * and a seeded log so a replica receives what the host already holds.
 */
const MIGRATION_27_TABLES = ['poster', 'background', 'logo', 'person_image'] as const;
const MIGRATION_27 = `
ALTER TABLE poster       ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE background   ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logo         ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE person_image ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
`;
function migration27(db: DatabaseSync): void {
  db.exec(MIGRATION_27);
  installSyncTriggers(db, [...MIGRATION_27_TABLES]);
  seedSyncLog(db, [...MIGRATION_27_TABLES]);
}
// MIGRATIONS: { version: 27, up: (db) => migration27(db) },
```
Rewrite migration 23's docblock paragraph ("no `installSyncTriggers` and no `seedSyncLog` … #79 records the decision") to say migration 27 is where replication begins. `db/schema.ts`: add `rank: integer('rank').notNull().default(0)` to the four drizzle tables.

- [ ] **Step 5: Synced tables and the route**

`tables.ts`: append the four names to `HOST_SYNCED_TABLES`; four `selectSql` cases with the projections from Global Constraints; update the docblock's count and the "describe files already reachable at `/api/artwork/:kind/:mediaItemId`" reasoning (now: rows replicate, bytes do not; the URL is per row). Check `main.ts` reinstalls triggers for the whole list at boot (it does by reading the array).

`artwork-route.ts`: `ARTWORK_QUERY` per Global Constraints; rewrite its docblock (the null-path shadowing paragraph becomes one sentence; the plan paragraph says all four seek the primary key). `server.ts`: the route comment's `:mediaItemId` → `:id` with "the artwork row's own id; a client learns ids from the replicated artwork rows". Any `artworkAnswer` doc mentioning the owner id likewise.

- [ ] **Step 6: Run, gate, commit**

`ImageInit.rank` is required, so the tree does not compile until its two producers and one consumer know it. In this task: the four attaches in `writer.ts` write `rank` from `image.rank` (`INSERT … rank … ON CONFLICT … SET … rank = excluded.rank`), and the job's `imageInit` passes `rank: 0` with a one-line comment that Task 2 supplies the real rank. Both are true of the code as committed; Task 2 replaces the constant.

Named tests PASS. `npm run check > /tmp/p7-t1.log 2>&1; echo "exit $?"; rm -f /tmp/p7-t1.log` — exit 0.

```bash
git add -A packages && git commit -m "Rank artwork rows, replicate the four artwork tables, and serve each image by its own id"
```

---

### Task 2: Keep the top five per kind

**Files:**
- Modify: `packages/host/src/media/writer.ts` (`OTHER_ARTWORK_SQL`/`keepOnly` ~99-146; the four attaches ~310-390)
- Modify: `packages/openmetadata/src/artwork/source.ts` (`bestImage` → `rankImages` + `bestImage` kept as `rankImages(...)[0]`), `packages/openmetadata/src/artwork/job.ts` (~424-470), `packages/openmetadata/src/testing.ts` (recording media: `attach*` record `(id, url, rank)`)
- Test: `packages/host/test/media/writer.test.ts` (~629, ~666 pin `keepOnly`), `packages/openmetadata/test/artwork/source.test.ts`, `job.test.ts` (~181, ~241, ~702)

**Interfaces:**
- Consumes: Task 1's `ImageInit.rank`.
- Produces: `export const ARTWORK_KEEP = 5` (job.ts); `rankImages(images: readonly ProviderImage[], language: string): ProviderImage[]` (source.ts); writer `keepTop(table, ownerId, keptUrls: readonly string[]): Promise<void>` (module-private) and a new `MediaWriter` member pair is **not** added — instead each attach no longer prunes, and `MediaWriter` gains `keepArtwork(kind: 'poster' | 'background' | 'logo', mediaItemId: number, urls: readonly string[]): Promise<void>` and `keepPersonImages(personId: number, urls: readonly string[]): Promise<void>` which the job calls once per kind after its attaches.

- [ ] **Step 1: Write the failing tests**

`writer.test.ts`: replace the two `keepOnly` tests with:

```ts
test('attaching several posters keeps them all until keepArtwork names the survivors', async () => {
  // attach urls a (rank 0), b (rank 1), c (rank 2) → three rows with those ranks and three files
  // keepArtwork('poster', id, [a, b]) → c's row and file gone; a and b untouched
});
test('re-attaching a url rewrites its rank in place and keeps its id', …);
test('keepArtwork with an unchanged set deletes nothing and unlinks nothing', …);
test('keepPersonImages prunes person_image the same way', …);
test('attaching the same url twice is one row, which keepArtwork keeps', …);   // Review Focus 1
```

`source.test.ts`: `rankImages` returns the whole list in `bestImage`'s order; `bestImage(images, lang)` equals `rankImages(images, lang)[0]`; stable on ties.

`job.test.ts`: `a resolved item gets one poster, one background and one logo` (~181) becomes "gets up to ARTWORK_KEEP of each, ranked": seed seven posters, assert five `attachPoster` calls with ranks 0–4 in `rankImages` order and a `keepArtwork('poster', id, [those five urls])` call after them; three backgrounds → three; a person with three pictures → three attaches and one `keepPersonImages`. `running twice writes one row and one file per slot` (~702) → "per kept image". Add: "a failed download of the rank-1 image still keeps the other four and names only the four in keepArtwork" and "keepArtwork is called once per kind, after every attach of that kind settled" (Review Focus 2: record call order; the keep call's index is after the last attach's).

- [ ] **Step 2: Run and watch them fail** — FAIL.

- [ ] **Step 3: Writer**

Replace `OTHER_ARTWORK_SQL`/`keepOnly` with a set-based `keepTop`. SQLite has no array parameter, so the `NOT IN (?, ?, …)` tail is built from `urls.length` per call; the table names stay literal in each statement because `scripts/check-test-hygiene.ts` reads this file for reads of named tables (the placeholder tail is not a table name):

```ts
  /** Each table's two statements with a `NOT IN (…)` tail supplied per call. Literal table names: see the hygiene note above. */
  const KEEP_TOP_SQL: Readonly<Record<'poster' | 'background' | 'logo' | 'person_image', (placeholders: string) => { readonly paths: string; readonly drop: string }>> = {
    poster: (p) => ({
      paths: `SELECT path FROM poster WHERE media_item_id = ? AND url NOT IN (${p}) AND path IS NOT NULL`,
      drop: `DELETE FROM poster WHERE media_item_id = ? AND url NOT IN (${p})`,
    }),
    background: (p) => ({
      paths: `SELECT path FROM background WHERE media_item_id = ? AND url NOT IN (${p}) AND path IS NOT NULL`,
      drop: `DELETE FROM background WHERE media_item_id = ? AND url NOT IN (${p})`,
    }),
    logo: (p) => ({
      paths: `SELECT path FROM logo WHERE media_item_id = ? AND url NOT IN (${p}) AND path IS NOT NULL`,
      drop: `DELETE FROM logo WHERE media_item_id = ? AND url NOT IN (${p})`,
    }),
    person_image: (p) => ({
      paths: `SELECT path FROM person_image WHERE person_id = ? AND url NOT IN (${p}) AND path IS NOT NULL`,
      drop: `DELETE FROM person_image WHERE person_id = ? AND url NOT IN (${p})`,
    }),
  };

  /** Keeps `urls` as the owner's only images in `table`; rows first, then files, as `dropMediaItem` orders them. An empty `urls` deletes every row -- the provider returned nothing this run. */
  async function keepTop(table: keyof typeof KEEP_TOP_SQL, ownerId: number, urls: readonly string[]): Promise<void> {
    // `NOT IN ()` is a syntax error in SQLite; an empty set is "nothing kept".
    const placeholders = urls.length === 0 ? "''" : urls.map(() => '?').join(', ');
    const sql = KEEP_TOP_SQL[table](placeholders);
    const stale = raw.prepare(sql.paths).all(ownerId, ...urls);
    if (stale.length === 0) return;
    raw.prepare(sql.drop).run(ownerId, ...urls);
    await Promise.all(stale.map((row) => artwork.remove(String(row['path']))));
  }
```
If the hygiene script still objects to the template literals, fall back to four literal pairs per fixed cap size — but check first; the script matches table names, not template syntax. Each attach writes `rank` (`INSERT … rank … ON CONFLICT … SET … rank = excluded.rank`) and no longer prunes. `MediaWriter` (contract + writer + recording media in `openmetadata/src/testing.ts` + every other `MediaWriter` literal: `grep -rn "attachPersonImage" packages/*/test packages/*/src`) gains `keepArtwork` and `keepPersonImages`. Rewrite the "widening a slot is #79" comment: it is the policy this function now implements.

- [ ] **Step 4: Job**

`source.ts`: `export function rankImages(images, language): ProviderImage[]` holding today's sort; `bestImage` returns `rankImages(images, language)[0]` (keep it: `select.ts`/tests may use it). `job.ts`:

```ts
export const ARTWORK_KEEP = 5;
…
    const kept = { poster: [] as string[], background: [] as string[], logo: [] as string[] };
    const people = new Map<number, string[]>();
    for (const [index, image] of rankImages(answer.media.posters, language).slice(0, ARTWORK_KEEP).entries()) {
      slots.push({ what: `poster ${String(index)}`, image, attach: async (bytes) => { await ctx.media.attachPoster(payload.mediaItemId, imageInit(image, bytes, index)); kept.poster.push(image.url); } });
    }
    // same for backgrounds, logos; for each person: rankImages(found, language).slice(0, ARTWORK_KEEP) with attachPersonImage and people.get(personId).push(url)
    await Promise.all(slots.map((slot) => store(slot, ctx, signal)));
    await ctx.media.keepArtwork('poster', payload.mediaItemId, kept.poster);
    await ctx.media.keepArtwork('background', payload.mediaItemId, kept.background);
    await ctx.media.keepArtwork('logo', payload.mediaItemId, kept.logo);
    for (const [personId, urls] of people) await ctx.media.keepPersonImages(personId, urls);
```
`imageInit(image, bytes, rank)` sets `rank`. A failed `store` never pushes its url, so the keep set is exactly what was attached. Rewrite the "One image per slot" comment (~424). Note `kept.poster` is pushed to from concurrent attaches — fine, single-threaded; order of the array does not matter for `NOT IN`.

- [ ] **Step 5: Run, gate, commit** — `npm run check > /tmp/p7-t2.log 2>&1; echo "exit $?"; rm -f /tmp/p7-t2.log` — exit 0.

```bash
git add -A packages && git commit -m "Keep the five best images per kind and per person, ranked as the job ranks them"
```

---

### Task 3: Gather ranked artwork rows

**Files:**
- Modify: `packages/web/src/store/gather.ts` (`ArtworkKind`/`ArtworkUrls`/`artworkUrls`/`personImageUrl` ~118-143; `gatherRole` ~220-232; `gatherMediaItem` ~243-270; `GatheredItem`/`GatheredRole` types)
- Modify: `packages/plugin-ui/src/types.ts` (~43-76), `packages/web/src/library/useGatheredItem.ts` (`watchDownloads` ~236-262)
- Test: `packages/web/test/store/gather.test.ts` (~98), `packages/web/test/library/useGatheredItem.test.tsx`, `MediaItemCard.test.tsx` fixtures (~158), `packages/plugin-ui/test/MediaDetails.test.tsx` fixture (~23, ~39) — the plugin-ui fixture change is Task 4's but the type change here breaks its compile; update the fixture shape minimally here and leave behaviour tests to Task 4

**Interfaces:**
- Consumes: Task 1's `ArtworkSyncRead`, `PersonImageSyncRead`.
- Produces:

```ts
// gather.ts (and mirrored in plugin-ui/src/types.ts as GatheredImageView, GatheredArtworkView)
export interface GatheredImage { readonly id: number; readonly url: string; readonly width: number; readonly height: number; readonly language: string | null; readonly rank: number; }
export interface GatheredArtwork { readonly posters: readonly GatheredImage[]; readonly backgrounds: readonly GatheredImage[]; readonly logos: readonly GatheredImage[]; }
// GatheredItem.artwork: GatheredArtwork; GatheredRole.images: readonly GatheredImage[] (imageUrl removed)
export function artworkUrl(kind: 'poster' | 'background' | 'logo' | 'person', id: number): string;
```

- [ ] **Step 1: Write the failing tests**

`gather.test.ts`: replace `artwork is three urls, not rows` with:

```ts
test('artwork is the item\'s poster, background and logo rows, each list by rank then id, with per-row urls', async () => {
  // seed media_item 7; posters id 20 rank 1, id 21 rank 0, id 22 rank 0 (tie → id order: 21, 22, 20); one background id 30; no logos
  // assert gathered.artwork.posters.map(p => [p.id, p.rank, p.url]) deepEquals [[21,0,'/api/artwork/poster/21'],[22,0,'/api/artwork/poster/22'],[20,1,'/api/artwork/poster/20']]; backgrounds one; logos []
});
test('a role carries its person\'s pictures by rank, and none when the person has no rows', …);   // person_image rows via by_person; url /api/artwork/person/<id>
test('a poster row for an item not yet replicated does not break gathering of another item', …);  // Review Focus 3: seed poster for mediaItemId 99 (no media_item 99); gatherMediaItem(7) still works; gatherMediaItem(99) is undefined
```
Builders: `artworkRow(table, id, mediaItemId, rank)` with `{ id, mediaItemId, width: 10, height: 15, language: null, rank, createdAt: 1 }`; `personImageRow(id, personId, rank)`.

`useGatheredItem.test.tsx`: an insert of a `poster` row for this item re-gathers; one for another item does not; a `person_image` row for a gathered person re-gathers.

- [ ] **Step 2: Run and watch them fail** — FAIL.

- [ ] **Step 3: Implement**

`gather.ts`: `isArtworkRow(value)` narrows `{ id, mediaItemId, width, height, language, rank }` (numbers/string|null); `isPersonImageRow` likewise with `personId`. `gatherMediaItem` partitions `rows` (already read from `by_media_item`) into releases, roles, posters, backgrounds, logos by `row.table`; `toImages(kind, rows)` maps narrowed rows to `GatheredImage` with `url: artworkUrl(kind, row.id)` and sorts `(a.rank - b.rank) || (a.id - b.id)`. `gatherRole` becomes async or `gatherMediaItem` reads `person_image` rows once for all people through a new `rows.ts` helper `byPersonIds(db, personIds)` (index `by_person`, `getAll` per id, in parallel) and passes each person's images in. Update the header comment "**No artwork rows.**" to the new truth. `plugin-ui/src/types.ts`: `GatheredImageView`, `GatheredArtworkView`, `GatheredRoleView.images`, `GatheredItemView.artwork: GatheredArtworkView`; the type-level assignability check in `gather.ts` still compiles.

`useGatheredItem.ts`: in `watchDownloads`, for each of `poster`, `background`, `logo`, `person_image`: (a) `source.subscribeTouched(table, (ids) => { if (ids.some((id) => knownIds.has(id))) safeGather(); })` where `knownIds` is the set of artwork row ids the last gather returned for this item and its people — catches rank rewrites and deletions of rows already shown; (b) `source.subscribeInserts(table, safeGather)` — catches a new row for this item at the cost of one gather when the row is another item's, which is exactly how download inserts are handled today (read the comment above the download subscriptions and extend it by one sentence). `GatheredSource` gains `subscribeTouched`; the test sources (`sourceFor` in the gathered-item, card and category tests) bind it.

- [ ] **Step 4: Run, gate, commit** — exit 0.

```bash
git add -A packages && git commit -m "Gather every artwork row into ranked lists with per-row urls"
```

---

### Task 4: Show them all

**Files:**
- Modify: `packages/plugin-ui/src/MediaDetails.tsx` (`galleryImages` ~83-100; poster button ~118-135; `CastMember` ~190-237)
- Test: `packages/plugin-ui/test/MediaDetails.test.tsx`, `packages/plugin-{tv,movie,xxx}/test/browser.test.tsx` fixtures, `packages/web/test/library/MediaItemCard.test.tsx`

**Interfaces:**
- Consumes: Task 3's `GatheredArtworkView`, `GatheredRoleView.images`.

- [ ] **Step 1: Write the failing tests**

`MediaDetails.test.tsx` (update the fixture builders to rows; keep existing behaviour tests green by giving fixtures one poster, one background, one picture per person):

```ts
test('the detail image is the rank-0 poster, and with no poster row the placeholder renders at once', …);  // no <img> for the poster, placeholder label `No poster for <title>`, and the poster button still opens the gallery when a background exists
test('the gallery walks every poster, then every background, then each cast member\'s pictures, in rank order', …);  // two posters, two backgrounds, person with two pictures → 6 images; open at posters[0]; press next 5 times, asserting the img src each step and the "n of 6" text
test('a cast thumbnail is the person\'s rank-0 picture and opens the gallery there', …);
test('a cast member with no pictures gets the placeholder and no button', …);
test('when the only poster fails, the button still opens on the background; when every image fails the gallery closes', …);  // Review Focus 5 (the second half exists in Gallery tests; assert here only that opening with all-failed images closes)
```

- [ ] **Step 2: Run and watch them fail** — FAIL.

- [ ] **Step 3: Implement**

`galleryImages`: `[...posters, ...backgrounds].map(i => ({ url: i.url, caption: item.title }))` then `cast.flatMap(role => role.person === undefined ? [] : role.images.map(i => ({ url: i.url, caption: role.person.name })))`. Poster: `const poster = gathered.artwork.posters[0]; const posterFailedOrMissing = posterFailed || poster === undefined;` render placeholder in that case; `onClick` opens at `poster?.url ?? gathered.artwork.backgrounds[0]?.url`, and the button is disabled when both are undefined. `CastMember` takes `images` and uses `images[0]`; no button when `images.length === 0`. Rewrite the "Poster and background only. The logo is deliberately not here" comment to the lists form. Plugin test fixtures: the three `browser.test.tsx` and `MediaItemCard.test.tsx` build `artwork` as `{ posters: [...], backgrounds: [...], logos: [] }` and roles with `images`.

- [ ] **Step 4: Run, gate, commit** — exit 0.

```bash
git add -A packages && git commit -m "Show every stored image in the card's gallery, the top-ranked poster on the card"
```

---

### Task 5: Harness, end to end, mutations, gate

- [ ] **Step 1: Harness and existing specs** — `packages/e2e/src/harness-2.ts`: `seedTvRelease({ withPoster })` inserts the poster with `rank 0` and returns `{ mediaItemId, posterId }` (read the current return shape; add `posterId: number | undefined`); add `seedPoster(mediaItemId, rank): number` inserting a second poster pointing at the same `posterPath` file (one file, two rows is fine for serving). `media-details.spec.ts` (~146) and `shell.spec.ts` (~721-800) intercept/await `/api/artwork/poster/<posterId>` instead of the media item id; read each spec's wording about the URL and make it true.

- [ ] **Step 2: e2e spec** — `packages/e2e/tests/artwork.spec.ts`:

```ts
test('a card shows its top-ranked poster and the gallery steps to the second one', async ({ page, harness }) => {
  const { mediaItemId, posterId } = await harness.seedTvRelease({ /* as media-details.spec seeds */ withPoster: true });
  const second = harness.seedPoster(mediaItemId, 1);
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await page.getByRole('button', { name: /A Show/ }).click();
  const poster = page.locator('.details .poster img');
  await expect(poster).toHaveAttribute('src', `/api/artwork/poster/${String(posterId)}`, { timeout: 15_000 });
  await page.locator('.details .poster').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('img')).toHaveAttribute('src', `/api/artwork/poster/${String(posterId)}`);
  await dialog.getByRole('button', { name: /next/i }).click();
  await expect(dialog.locator('img')).toHaveAttribute('src', `/api/artwork/poster/${String(second)}`);
  await expect(dialog.getByText(/2 of \d+/)).toBeVisible();
});
```
(`.details .poster` are plugin-ui's own class names, which `library.css` already styles; the e2e may use them.) Keep step timeouts within the 90 s budget.

- [ ] **Step 3: Run the e2e suite** (`npm run e2e > /tmp/p7-e2e.log 2>&1; echo $?`; read the tail; delete).

- [ ] **Step 4: Mutations** (one at a time; restore after; a mutant reddening nothing means a missing test):

| Mutation | File | Covering tests |
|---|---|---|
| `keepTop` deletes nothing | `host/src/media/writer.ts` | `writer.test.ts` |
| `ARTWORK_KEEP = 6` | `openmetadata/src/artwork/job.ts` | `job.test.ts` |
| every attach passes `rank: 0` | `job.ts` `imageInit` | `job.test.ts` |
| `keepArtwork` called before `Promise.all` | `job.ts` | `job.test.ts` (order test) |
| gather sorts by `id` only | `web/src/store/gather.ts` | `gather.test.ts` |
| gather builds urls from `mediaItemId` | `gather.ts` | `gather.test.ts` |
| route query ignores `:id` (`WHERE path IS NOT NULL LIMIT 1`) | `host/src/api/artwork-route.ts` | `artwork-route.test.ts` |
| poster projection adds `url` | `host/src/sync/tables.ts` | `tables.test.ts` |
| `HOST_SYNCED_TABLES` drops `person_image` | `tables.ts` | `tables.test.ts` |
| gallery omits backgrounds | `plugin-ui/src/MediaDetails.tsx` | `MediaDetails.test.tsx` |
| cast thumbnail uses `images.at(-1)` | `MediaDetails.tsx` | `MediaDetails.test.tsx` |
| `useGatheredItem` drops the artwork subscriptions | `web/src/library/useGatheredItem.ts` | `useGatheredItem.test.tsx` |

- [ ] **Step 5: Final gate** — `npm run check > /tmp/p7-final.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)" /tmp/p7-final.log; rm -f /tmp/p7-final.log` — exit 0, `fail 0`.

```bash
git add -A packages && git commit -m "Pin several images per kind end to end"
```

Nothing is pushed or merged.
