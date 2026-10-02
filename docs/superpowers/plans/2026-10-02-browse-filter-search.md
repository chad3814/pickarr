# Browse Filter and Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On each category page, a radio filter (All / Picked / Unpicked) and a search box matching title, release year, release filenames and people's names, both driven from the URL and served from a derived IndexedDB `catalog` store that `applyBatch` keeps consistent with the replica.

**Architecture:** `SCHEMA_VERSION` 3 adds a `catalog` object store (one record per media item: `pluginId`, `updatedAt`, `picked`, `haystack`) with two compound indexes, and a `by_person` index on `rows`. `applyBatch` gains a catalog phase in its own transaction: map each op to the media items it affects, recompute those records from `rows`, report them in `Changed.catalog`. A `listCatalog` read pages the filter off an index and tests a search term with `includes` on the catalog record. The page keeps its existing `useMediaItems` path for the default view and uses a new `useCatalogItems` hook otherwise.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), IndexedDB via the existing `store/idb.ts` helpers, React 19 + react-router 7 (`useSearchParams`), `node:test`, `@testing-library/react`, `fake-indexeddb`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-browse-filter-search-design.md`

## Global Constraints

- Worktree `/Users/chad/Projects/pickarr/worktrees/phase5-browse-filter-search`, branch `phase5-browse-filter-search`. Never edit `worktrees/main`, never push, never merge, never bare `git stash`.
- **Picked** = at least one of the item's releases has a `torrent_download` or `nzb_download` row, any status including `failed`. Stored as `picked: 0 | 1` (IndexedDB cannot index booleans).
- **Haystack** = lowercased parts joined by `\n`, in order: title; first four characters of `releaseDate` when it is a string of length ≥ 4; each release `filename` in `rss_item` id order; each role's person `name` in `role` id order (only where the person row is present). Whitespace inside a part collapsed to single spaces. Never `lookupJson`, `description`, `providerRef`.
- `SCHEMA_VERSION = 3`. Object store `catalog`, `keyPath: 'id'`; indexes `by_plugin_picked_updated` on `['pluginId','picked','updatedAt','id']` and `by_plugin_updated` on `['pluginId','updatedAt','id']`. New `rows` index `by_person` on `'value.personId'`.
- The catalog phase runs inside `applyBatch`'s transaction (which names `catalog`), after the write loop and before `writeCursors`, inside the existing `try`. It recomputes affected records; it never patches.
- `Changed` gains `catalog: readonly number[]`; `notify.ts` gains `subscribeCatalog`; `wipe()` clears `catalog` in the same transaction as `rows` and `meta`.
- `PickedFilter = 'all' | 'picked' | 'unpicked'`; `term` passed to `listCatalog` is already trimmed, lowercased, whitespace-collapsed. `listCatalog` tests `haystack.includes(term)` on the catalog record only.
- URL: `filter` ∈ {`picked`,`unpicked`} else `all`; `q` kept as typed; writes `{ replace: true }`; `all` + empty `q` writes **no params**; typing debounced `SEARCH_DEBOUNCE_MS = 150`; clearing immediate.
- The default view (`all`, empty term) renders through `useMediaItems` with zero catalog reads.
- Markup: `<form role="search" aria-label="Filter and search">`, `<fieldset><legend>Show</legend>` three native radios named `filter` labelled `All` `Picked` `Unpicked`; `<label>Search <input type="search" autocomplete="off"></label>`, no placeholder. No class attributes anywhere; `library.css` uses structural selectors.
- Empty sentences verbatim: `Nothing matches "<q>"`, `Nothing matches "<q>" among picked items`, `Nothing matches "<q>" among unpicked items`, `No picked items yet`, `No unpicked items`. Default view keeps `Nothing here yet.`
- `PAGE_SIZE` (24) from `useMediaItems.ts`; nav counts unchanged.
- No `any`; narrow instead of cast. A comment must be true of the code beside it. Web tests: `afterEach(cleanup)`, never a live DOM node to `node:assert`, no `t.mock.timers` (spy on `setTimeout`'s delay argument). `.ts` store tests run under the server runner; `.tsx` under the web runner (a `.ts` store test under the web runner hangs).
- Gate: `npm run check > file 2>&1; echo $?`. `timeout` is not a macOS command. Signing: retry once, then `git -c commit.gpgsign=false commit …` and report UNSIGNED.

## Review Focus

1. **A release arriving before its media item** (two batches, `rss_item` first). The first batch finds no `media_item` and writes nothing; the second recomputes and the record carries the filename. Test in Task 2.
2. **Plugin-owned rows that carry `mediaItemId`** (e.g. `tv_release`) come back from `by_media_item` too. They must be ignored by table, never mistaken for a release or a role. Test in Task 2.
3. **A term of only whitespace, or `filter=bogus` in the URL.** Both must read as the default view and write no params. Test in Task 4.
4. **`Load more` racing a catalog wake.** A wake rebuilds the window; a page appended from the pre-wake cursor must be dropped (generation guard, as `useMediaItems` has). Test in Task 3.
5. **A download row deleted** (a tombstone op). The host does not do this today, but the op exists; `picked` must return to 0 rather than stick. Test in Task 2.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/web/src/store/db.ts` | schema v3: `catalog` store + indexes, `by_person` | 1 |
| `packages/web/src/store/catalog.ts` (new) | `CatalogRecord`, `PickedFilter`, `CatalogQuery`, `normalizeTerm`, `listCatalog` | 1 |
| `packages/web/src/store/catalog-apply.ts` (new) | `affectedMediaItems`, `recomputeCatalog` (in-transaction maintenance) | 2 |
| `packages/web/src/store/apply.ts` | catalog phase, `Changed.catalog` | 2 |
| `packages/web/src/store/notify.ts`, `leader.ts`, `sync.ts`, `index.ts` | `subscribeCatalog`, serialization, relay, `wipe`, `Store` members | 2 |
| `packages/web/src/library/useCatalogItems.ts` (new) | paging hook over `listCatalog` | 3 |
| `packages/web/src/library/useBrowseQuery.ts` (new) | URL state, debounce | 4 |
| `packages/web/src/library/BrowseControls.tsx` (new) | the form | 4 |
| `packages/web/src/library/Category.tsx`, `styles/library.css` | default/filtered split, empty sentences, layout | 4 |
| `packages/e2e/tests/browse-filter.spec.ts` (new) | e2e | 5 |

Task 1 first. Tasks 2 and 3 both depend only on Task 1 and may run in parallel. Task 4 depends on 2 and 3. Task 5 depends on everything.

---

### Task 1: Schema v3 and `listCatalog`

**Files:**
- Modify: `packages/web/src/store/db.ts` (`SCHEMA_VERSION` ~35; `upgradeneeded` body ~93-131)
- Create: `packages/web/src/store/catalog.ts`
- Test: `packages/web/test/store/db.test.ts`, `packages/web/test/store/catalog.test.ts` (new)

**Interfaces:**
- Produces:

```ts
// store/catalog.ts
export interface CatalogRecord { id: number; pluginId: string; updatedAt: number; picked: 0 | 1; haystack: string; }
export type PickedFilter = 'all' | 'picked' | 'unpicked';
export interface CatalogQuery { pluginId: string; filter: PickedFilter; term: string; }
export interface ListCatalogOptions { from?: { updatedAt: number; id: number }; limit: number; }
export const CATALOG_STORE = 'catalog';
export function normalizeTerm(raw: string): string;          // trim, toLowerCase, /\s+/g → ' '
export function isCatalogRecord(value: unknown): value is CatalogRecord;
export async function listCatalog(db: IDBDatabase, query: CatalogQuery, opts: ListCatalogOptions): Promise<readonly CatalogRecord[]>;
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/test/store/db.test.ts` (it has `freshDb` via `../store/harness.ts`; read how it inspects indexes already):

```ts
test('schema 3 has the catalog store with its two indexes, and rows has by_person', async () => {
  const db = await freshDb();
  assert.ok(Array.from(db.objectStoreNames).includes('catalog'));
  const tx = db.transaction(['catalog', 'rows'], 'readonly');
  const catalog = tx.objectStore('catalog');
  assert.equal(catalog.keyPath, 'id');
  assert.deepEqual(catalog.index('by_plugin_picked_updated').keyPath, ['pluginId', 'picked', 'updatedAt', 'id']);
  assert.deepEqual(catalog.index('by_plugin_updated').keyPath, ['pluginId', 'updatedAt', 'id']);
  assert.equal(tx.objectStore('rows').index('by_person').keyPath, 'value.personId');
  assert.equal(db.version, 3);
});
```

`packages/web/test/store/catalog.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { freshDb } from './harness.ts';
import { listCatalog, normalizeTerm, type CatalogRecord } from '../../src/store/catalog.ts';
import { done } from '../../src/store/idb.ts';

async function seedCatalog(db: IDBDatabase, records: readonly CatalogRecord[]): Promise<void> {
  const tx = db.transaction('catalog', 'readwrite');
  for (const record of records) tx.objectStore('catalog').put(record);
  await done(tx);
}
const rec = (id: number, updatedAt: number, picked: 0 | 1, haystack: string, pluginId = 'tv'): CatalogRecord =>
  ({ id, pluginId, updatedAt, picked, haystack });

test('normalizeTerm trims, lowercases and collapses whitespace', () => {
  assert.equal(normalizeTerm('  Dune   Part\tTwo '), 'dune part two');
  assert.equal(normalizeTerm('   '), '');
});

test('picked and unpicked page off the index newest first, honouring limit and an exclusive cursor, with ties broken by id', async () => {
  const db = await freshDb();
  await seedCatalog(db, [
    rec(1, 10, 1, 'a'), rec(2, 20, 0, 'b'), rec(3, 20, 1, 'c'), rec(4, 30, 1, 'd'), rec(5, 30, 0, 'e'),
    rec(9, 99, 1, 'other plugin', 'movie'),
  ]);
  const page1 = await listCatalog(db, { pluginId: 'tv', filter: 'picked', term: '' }, { limit: 2 });
  assert.deepEqual(page1.map((r) => r.id), [4, 3]);
  const last = page1.at(-1);
  assert.ok(last);
  const page2 = await listCatalog(db, { pluginId: 'tv', filter: 'picked', term: '' }, { from: { updatedAt: last.updatedAt, id: last.id }, limit: 2 });
  assert.deepEqual(page2.map((r) => r.id), [1]);
  const unpicked = await listCatalog(db, { pluginId: 'tv', filter: 'unpicked', term: '' }, { limit: 10 });
  assert.deepEqual(unpicked.map((r) => r.id), [5, 2]);
});

test('ties on updatedAt resume without skipping or repeating', async () => {
  const db = await freshDb();
  await seedCatalog(db, [rec(1, 5, 0, ''), rec(2, 5, 0, ''), rec(3, 5, 0, ''), rec(4, 5, 0, ''), rec(5, 5, 0, '')]);
  const seen: number[] = [];
  let from: { updatedAt: number; id: number } | undefined;
  for (;;) {
    const page = await listCatalog(db, { pluginId: 'tv', filter: 'unpicked', term: '' }, from === undefined ? { limit: 2 } : { from, limit: 2 });
    if (page.length === 0) break;
    seen.push(...page.map((r) => r.id));
    const tail = page.at(-1);
    if (tail === undefined) break;
    from = { updatedAt: tail.updatedAt, id: tail.id };
  }
  assert.deepEqual(seen, [5, 4, 3, 2, 1]);
});

test('a term filters by substring of the haystack across all, picked and unpicked, and stops at limit matches', async () => {
  const db = await freshDb();
  await seedCatalog(db, [
    rec(1, 10, 0, 'dune\n2021\ndune.2021.1080p.mkv\ntimothée chalamet'),
    rec(2, 20, 1, 'dune: part two\n2024\ndune.part.two.2024.mkv\nzendaya'),
    rec(3, 30, 0, 'arrival\n2016\narrival.2016.mkv\namy adams'),
    rec(4, 40, 1, 'blade runner 2049\n2017\nbr2049.mkv\nryan gosling'),
  ]);
  const q = (filter: 'all' | 'picked' | 'unpicked', term: string, limit = 10) => listCatalog(db, { pluginId: 'tv', filter, term }, { limit });
  assert.deepEqual((await q('all', 'dune')).map((r) => r.id), [2, 1]);
  assert.deepEqual((await q('picked', 'dune')).map((r) => r.id), [2]);
  assert.deepEqual((await q('unpicked', 'dune')).map((r) => r.id), [1]);
  assert.deepEqual((await q('all', 'zendaya')).map((r) => r.id), [2], 'matches a person');
  assert.deepEqual((await q('all', 'br2049')).map((r) => r.id), [4], 'matches a filename');
  assert.deepEqual((await q('all', '2016')).map((r) => r.id), [3], 'matches a year');
  assert.deepEqual((await q('all', 'nothing here')).map((r) => r.id), []);
  assert.deepEqual((await q('all', '%')).map((r) => r.id), [], 'a percent sign is literal');
  assert.deepEqual((await q('all', 'e', 2)).map((r) => r.id), [4, 3], 'limit counts matches, not records walked');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --import tsx --conditions development --test packages/web/test/store/db.test.ts packages/web/test/store/catalog.test.ts 2>&1 | grep -E "^not ok|✖|Cannot find" | head`
Expected: FAIL (no `catalog` store; module not found).

- [ ] **Step 3: Schema**

In `db.ts`: `export const SCHEMA_VERSION = 3;` and extend the `SCHEMA_VERSION` docblock by one paragraph: version 3 adds the derived `catalog` store (design spec 2026-10-02 §1.1) and `by_person`; the bump costs every client a resync, accepted because the catalog is derived from rows that resync anyway. In the `upgradeneeded` body, after `rows.createIndex('by_table', 'table');`:

```ts
      // Who appears where, for the catalog's person-rename path
      // (`store/catalog-apply.ts`): only `role` carries `value.personId`, so
      // this index is self-filtering the way `by_table_plugin_updated` is.
      rows.createIndex('by_person', 'value.personId');
      // The derived catalog (design spec 2026-10-02 §1): one record per media
      // item, maintained by `applyBatch`'s catalog phase, never written by a
      // reader. `picked` is 0 | 1 because IndexedDB cannot index a boolean.
      const catalog = db.createObjectStore('catalog', { keyPath: 'id' });
      catalog.createIndex('by_plugin_picked_updated', ['pluginId', 'picked', 'updatedAt', 'id']);
      catalog.createIndex('by_plugin_updated', ['pluginId', 'updatedAt', 'id']);
```

- [ ] **Step 4: `catalog.ts`**

```ts
/**
 * The derived catalog's shape and its one read (design spec 2026-10-02 §1-2).
 *
 * Reads only. The records are written by `store/catalog-apply.ts` inside
 * `applyBatch`'s transaction, which is what makes a catalog record always
 * agree with the rows it was computed from. Nothing here opens a
 * `readwrite` transaction.
 *
 * A search term is tested with `String.prototype.includes` on `haystack`,
 * so `%`, `_`, `.` and `*` are literal. There is no text index; with a
 * term, the walk visits every record in the plugin's (and picked) range
 * until `limit` matches, which is the cost the design accepted for a
 * replica-sized library.
 */
export const CATALOG_STORE = 'catalog';

export interface CatalogRecord {
  id: number;
  pluginId: string;
  updatedAt: number;
  picked: 0 | 1;
  haystack: string;
}

export type PickedFilter = 'all' | 'picked' | 'unpicked';

export interface CatalogQuery {
  pluginId: string;
  filter: PickedFilter;
  /** Already through {@link normalizeTerm}; `''` means no term. */
  term: string;
}

export interface ListCatalogOptions {
  /** Exclusive: the record that ended the previous page. */
  from?: { updatedAt: number; id: number };
  limit: number;
}

export function normalizeTerm(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCatalogRecord(value: unknown): value is CatalogRecord {
  return isRecord(value)
    && typeof value.id === 'number'
    && typeof value.pluginId === 'string'
    && typeof value.updatedAt === 'number'
    && (value.picked === 0 || value.picked === 1)
    && typeof value.haystack === 'string';
}

/** The index and key range for a query: the picked index when the filter names a side, else the plugin-wide one. Bounds carry the index's full arity, as `rows.ts`'s `rangeFor` explains. */
function rangeFor(query: CatalogQuery, from: ListCatalogOptions['from']): { index: string; range: IDBKeyRange } {
  const prefix = query.filter === 'all' ? [query.pluginId] : [query.pluginId, query.filter === 'picked' ? 1 : 0];
  const low = [...prefix, -Infinity, -Infinity];
  const high = [...prefix, Infinity, Infinity];
  const index = query.filter === 'all' ? 'by_plugin_updated' : 'by_plugin_picked_updated';
  if (from === undefined) return { index, range: IDBKeyRange.bound(low, high) };
  // Walking `prev`: everything strictly below the named record.
  return { index, range: IDBKeyRange.bound(low, [...prefix, from.updatedAt, from.id], false, true) };
}

export function listCatalog(db: IDBDatabase, query: CatalogQuery, opts: ListCatalogOptions): Promise<readonly CatalogRecord[]> {
  const { index, range } = rangeFor(query, opts.from);
  const cursorRequest = db.transaction(CATALOG_STORE, 'readonly').objectStore(CATALOG_STORE).index(index).openCursor(range, 'prev');
  return new Promise((resolve, reject) => {
    const results: CatalogRecord[] = [];
    cursorRequest.addEventListener('success', () => {
      const cursor = cursorRequest.result;
      if (cursor === null || results.length >= opts.limit) {
        resolve(results);
        return;
      }
      const value: unknown = cursor.value;
      // A malformed record is skipped rather than thrown on: the walk is a
      // page for a screen, and one bad record should cost one row, not the page.
      if (isCatalogRecord(value) && (query.term === '' || value.haystack.includes(query.term))) results.push(value);
      cursor.continue();
    });
    cursorRequest.addEventListener('error', () => reject(cursorRequest.error ?? new Error('indexeddb cursor failed')), { once: true });
  });
}
```

The cursor walk mirrors `rows.ts`'s `drain` deliberately (that module's doc explains why cursors do not use `idb.ts`'s `request`), so this file imports nothing from `idb.ts`.

- [ ] **Step 5: Run, gate, commit**

Run the two test files — PASS. The schema bump may break existing store tests that assert `db.version` or the store list; fix those assertions to the new truth (they pin the old schema, not a behaviour). `npm run check > /tmp/p5-t1.log 2>&1; echo "exit $?"; rm -f /tmp/p5-t1.log` — exit 0.

```bash
git add -A packages && git commit -m "Add the derived catalog store and its index-backed read"
```

---

### Task 2: Maintain the catalog inside `applyBatch`, and announce it

**Files:**
- Create: `packages/web/src/store/catalog-apply.ts`
- Modify: `packages/web/src/store/apply.ts` (`Changed` ~107-110; transaction ~135; after the loop ~191, before `writeCursors`; `changed` ~236)
- Modify: `packages/web/src/store/notify.ts` (`emit` ~204; registries), `leader.ts` (`SerializedChanged` ~65-84), `sync.ts` (`wipe` ~777-783), `index.ts` (`Store` + factory)
- Test: `packages/web/test/store/catalog-apply.test.ts` (new), `apply.test.ts`, `notify.test.ts`, `leader.test.ts`, `sync.test.ts`, `store.test.ts`

**Interfaces:**
- Consumes: Task 1's `CatalogRecord`, `CATALOG_STORE`.
- Produces:

```ts
// store/catalog-apply.ts
export interface HeldOp { op: SyncOp; existing: StoredRow | undefined; }
export async function affectedMediaItems(tx: IDBTransaction, held: readonly HeldOp[]): Promise<ReadonlySet<number>>;
export async function recomputeCatalog(tx: IDBTransaction, ids: ReadonlySet<number>): Promise<number[]>;  // the ids written or deleted, ascending
export function buildHaystack(parts: readonly string[]): string;   // lowercases, collapses whitespace per part, joins with '\n'
// apply.ts
export interface Changed { touched: …; inserted: …; catalog: readonly number[]; }
// notify.ts
export function subscribeCatalog(cb: (ids: readonly number[]) => void): () => void;
// leader.ts
export interface SerializedChanged { touched; inserted; catalog: readonly number[]; }
// index.ts Store
listCatalog(query: CatalogQuery, opts: ListCatalogOptions): Promise<readonly CatalogRecord[]>;
subscribeCatalog(cb: (ids: readonly number[]) => void): () => void;
```

- [ ] **Step 1: Write the failing tests**

`packages/web/test/store/catalog-apply.test.ts` (fixtures: build `SyncOp`s with `{op:'create', table, id, value}`; read `MediaItemSyncRead`, `RssItemSyncRead`, `TorrentDownloadSyncRead`, `RoleSyncRead`, `PersonSyncRead` in `packages/contract/src/sync.ts` for exact fields and give every required field a value):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { freshDb } from './harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { request } from '../../src/store/idb.ts';
import { buildHaystack, type CatalogRecord } from '../../src/store/catalog.ts';

const CURSORS = { since: 1, before: null } as const;
async function record(db: IDBDatabase, id: number): Promise<CatalogRecord | undefined> {
  return request<CatalogRecord | undefined>(db.transaction('catalog', 'readonly').objectStore('catalog').get(id));
}
// Builders: fill every field of the contract shape; only the named ones matter here.
const item = (id: number, title: string, releaseDate: string | null, updatedAt = 100, pluginId = 'tv'): SyncOp =>
  ({ op: 'create', table: 'media_item', id, value: { id, pluginId, title, releaseDate, description: null, provider: null, providerRef: null, createdAt: 1, updatedAt } });
const release = (id: number, mediaItemId: number | null, filename: string): SyncOp =>
  ({ op: 'create', table: 'rss_item', id, value: { id, feedId: 1, filename, createdAt: 1, updatedAt: 1, downloadType: 'torrent', mediaItemId, rankingScore: null, lookupState: 'resolved', lookupStateDetail: null, videoResolution: null, lookupJson: '{"secret":"never-in-haystack"}', deliveredAt: null } });
const torrent = (id: number, rssItemId: number, status = 'failed'): SyncOp =>
  ({ op: 'create', table: 'torrent_download', id, value: { id, rssItemId, downloadClientId: 1, infohash: null, clientRef: null, status, attempts: 1, createdAt: 1, updatedAt: 1, percentage: null, absentSince: null, deliveredAt: null, reclaimedAt: null } });
const role = (id: number, mediaItemId: number, personId: number): SyncOp =>
  ({ op: 'create', table: 'role', id, value: { id, mediaItemId, personId, role: 'actor', name: null, billingOrder: null, createdAt: 1 } });
const person = (id: number, name: string): SyncOp =>
  ({ op: 'create', table: 'person', id, value: { id, name, providerRef: `p${String(id)}`, createdAt: 1, updatedAt: 1 } });
const del = (table: string, id: number): SyncOp => ({ op: 'delete', table, id });

test('one scrambled batch yields one record with pluginId, updatedAt, picked and the full haystack', async () => {
  const db = await freshDb();
  const changed = await applyBatch(db, [
    person(2, 'Zendaya'), torrent(1, 11), role(1, 1, 1), release(12, 1, 'Dune.Part.Two.2024.2160p.mkv'),
    item(1, 'Dune:  Part Two', '2024-03-01', 500), release(11, 1, 'Dune.Part.Two.2024.1080p.mkv'), role(2, 1, 2), person(1, 'Timothée Chalamet'),
  ], CURSORS);
  assert.deepEqual(changed.catalog, [1]);
  const rec = await record(db, 1);
  assert.deepEqual(rec, {
    id: 1, pluginId: 'tv', updatedAt: 500, picked: 1,
    haystack: 'dune: part two\n2024\ndune.part.two.2024.1080p.mkv\ndune.part.two.2024.2160p.mkv\ntimothée chalamet\nzendaya',
  });
  assert.ok(!rec?.haystack.includes('never-in-haystack'));
});

test('a later download flips picked; a tombstoned download flips it back', async () => {
  // Review Focus 5.
  const db = await freshDb();
  await applyBatch(db, [item(1, 'Arrival', null), release(11, 1, 'Arrival.mkv')], CURSORS);
  assert.equal((await record(db, 1))?.picked, 0);
  assert.equal((await record(db, 1))?.haystack, 'arrival\narrival.mkv', 'no year when releaseDate is null');
  await applyBatch(db, [torrent(1, 11)], { since: 2, before: null });
  assert.equal((await record(db, 1))?.picked, 1);
  await applyBatch(db, [del('torrent_download', 1)], { since: 3, before: null });
  assert.equal((await record(db, 1))?.picked, 0);
});

test('a release arriving before its media item is picked up when the item arrives', async () => {
  // Review Focus 1.
  const db = await freshDb();
  const first = await applyBatch(db, [release(11, 1, 'Early.mkv')], CURSORS);
  assert.deepEqual(first.catalog, [], 'nothing to recompute yet');
  assert.equal(await record(db, 1), undefined);
  await applyBatch(db, [item(1, 'Early', '1999-01-01')], { since: 2, before: null });
  assert.equal((await record(db, 1))?.haystack, 'early\n1999\nearly.mkv');
});

test('a release rematched from one item to another rewrites both records', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'A', null), item(2, 'B', null), release(11, 1, 'X.mkv')], CURSORS);
  const changed = await applyBatch(db, [{ ...release(11, 2, 'X.mkv'), op: 'upsert' }], { since: 2, before: null });
  assert.deepEqual(changed.catalog, [1, 2]);
  assert.equal((await record(db, 1))?.haystack, 'a');
  assert.equal((await record(db, 2))?.haystack, 'b\nx.mkv');
});

test('a person rename reaches every item they appear in; a role tombstone drops the name', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'A', null), item(2, 'B', null), person(7, 'Old Name'), role(1, 1, 7), role(2, 2, 7)], CURSORS);
  const changed = await applyBatch(db, [{ ...person(7, 'New Name'), op: 'upsert' }], { since: 2, before: null });
  assert.deepEqual(changed.catalog, [1, 2]);
  assert.equal((await record(db, 1))?.haystack, 'a\nnew name');
  await applyBatch(db, [del('role', 2)], { since: 3, before: null });
  assert.equal((await record(db, 2))?.haystack, 'b');
});

test('a media item tombstone deletes its record', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'A', null)], CURSORS);
  const changed = await applyBatch(db, [del('media_item', 1)], { since: 2, before: null });
  assert.deepEqual(changed.catalog, [1]);
  assert.equal(await record(db, 1), undefined);
});

test('plugin-owned rows that carry mediaItemId are ignored by the haystack', async () => {
  // Review Focus 2.
  const db = await freshDb();
  await applyBatch(db, [
    item(1, 'A', null),
    { op: 'create', table: 'tv_release', id: 50, value: { id: 50, mediaItemId: 1, filename: 'NOT-A-RELEASE.mkv', updatedAt: 1 } },
  ], CURSORS);
  assert.equal((await record(db, 1))?.haystack, 'a');
});

test('a refused batch leaves the catalog untouched', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'A', null)], CURSORS);
  await assert.rejects(applyBatch(db, [{ ...item(1, 'B', null), op: 'upsert' }, { op: 'upsert', table: 'media_item', id: 2, value: null }], { since: 2, before: null }));
  assert.equal((await record(db, 1))?.haystack, 'a');
});

test('buildHaystack lowercases, collapses whitespace per part and joins with newlines', () => {
  assert.equal(buildHaystack(['Dune:  Part\tTwo', '2024', 'A.mkv']), 'dune: part two\n2024\na.mkv');
});

test('a 500-op batch over 100 items applies within the budget', async () => {
  // A regression tripwire on fake-indexeddb, not a benchmark: the budget is
  // at least three times the median measured when this test was written
  // (record the measurement in CATALOG_BATCH_BUDGET_MS's comment).
  const db = await freshDb();
  const ops: SyncOp[] = [];
  for (let i = 1; i <= 100; i += 1) {
    ops.push(item(i, `Title ${String(i)}`, '2020-01-01'), release(i * 10, i, `f${String(i)}.mkv`), release(i * 10 + 1, i, `g${String(i)}.mkv`), role(i, i, i), person(i, `Person ${String(i)}`));
  }
  const started = performance.now();
  await applyBatch(db, ops, CURSORS);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < CATALOG_BATCH_BUDGET_MS, `${String(Math.round(elapsed))} ms`);
});
const CATALOG_BATCH_BUDGET_MS = 5_000; // replace with the measured budget per the comment above
```

Append to `notify.test.ts`: `subscribeCatalog` hears `emit({ touched: new Map(), inserted: new Map(), catalog: [1, 2] })` with `[1, 2]` and is not fired when `catalog` is empty. Append to `leader.test.ts`: `deserializeChanged(serializeChanged(changed))` round-trips `catalog`. Append to `sync.test.ts`: after a reset (`generation` mismatch), the `catalog` store is empty (seed a record directly first). In `store.test.ts`: `createStore` exposes `listCatalog` and `subscribeCatalog`.

- [ ] **Step 2: Run and watch them fail**

Run: `node --import tsx --conditions development --test packages/web/test/store/catalog-apply.test.ts packages/web/test/store/notify.test.ts packages/web/test/store/leader.test.ts 2>&1 | grep -E "^not ok|✖|Cannot find" | head` — FAIL.

- [ ] **Step 3: `catalog-apply.ts`**

```ts
/**
 * The catalog's maintenance: which media items a batch of ops affects, and
 * a fresh record for each (design spec 2026-10-02 §1.3). Runs inside
 * `applyBatch`'s transaction, after its writes, so every read here sees the
 * batch's own rows and the result commits or aborts with them.
 *
 * **A recompute, never a patch.** Each affected item is rebuilt from `rows`
 * in full, which is what makes op order inside a batch irrelevant: a
 * download before its release, a role before its person, a release before
 * its item -- all read the same final state. The price is three to six
 * reads per affected item; `catalog-apply.test.ts` keeps a tripwire on it.
 *
 * Only five tables matter here. A plugin-owned row that carries
 * `mediaItemId` (a `tv_release`) comes back from `by_media_item` too and is
 * filtered out by `table`, not by shape.
 */
import type { SyncOp } from './wire.ts';
import type { StoredRow } from './db.ts';
import { request } from './idb.ts';
import { CATALOG_STORE, type CatalogRecord } from './catalog.ts';

export interface HeldOp { op: SyncOp; existing: StoredRow | undefined; }

const DOWNLOAD_TABLES: ReadonlySet<string> = new Set(['torrent_download', 'nzb_download']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}
function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

export async function affectedMediaItems(tx: IDBTransaction, held: readonly HeldOp[]): Promise<ReadonlySet<number>> {
  const rows = tx.objectStore('rows');
  const ids = new Set<number>();
  const pending: Promise<void>[] = [];
  for (const { op, existing } of held) {
    const versions: unknown[] = [op.op === 'delete' ? undefined : op.value, existing?.value];
    switch (op.table) {
      case 'media_item':
        ids.add(op.id);
        break;
      case 'rss_item':
      case 'role':
        for (const v of versions) { const m = numberField(v, 'mediaItemId'); if (m !== undefined) ids.add(m); }
        break;
      case 'torrent_download':
      case 'nzb_download':
        for (const v of versions) {
          const rssItemId = numberField(v, 'rssItemId');
          if (rssItemId === undefined) continue;
          pending.push(request<StoredRow | undefined>(rows.get(['rss_item', rssItemId])).then((row) => {
            const m = numberField(row?.value, 'mediaItemId');
            if (m !== undefined) ids.add(m);
          }));
        }
        break;
      case 'person':
        pending.push(request<StoredRow[]>(rows.index('by_person').getAll(op.id)).then((roles) => {
          for (const r of roles) { const m = numberField(r.value, 'mediaItemId'); if (m !== undefined) ids.add(m); }
        }));
        break;
      default:
        break;
    }
  }
  await Promise.all(pending);
  return ids;
}

export function buildHaystack(parts: readonly string[]): string {
  return parts.map((p) => p.trim().toLowerCase().replace(/\s+/g, ' ')).join('\n');
}

async function recomputeOne(tx: IDBTransaction, id: number): Promise<void> {
  const rows = tx.objectStore('rows');
  const catalog = tx.objectStore(CATALOG_STORE);
  const item = await request<StoredRow | undefined>(rows.get(['media_item', id]));
  const pluginId = stringField(item?.value, 'pluginId');
  const updatedAt = numberField(item?.value, 'updatedAt');
  if (item === undefined || pluginId === undefined || updatedAt === undefined) {
    catalog.delete(id); // absent or a tombstone: no record
    return;
  }
  const linked = await request<StoredRow[]>(rows.index('by_media_item').getAll(id));
  const releases = linked.filter((r) => r.table === 'rss_item').sort((a, b) => a.id - b.id);
  const roles = linked.filter((r) => r.table === 'role').sort((a, b) => a.id - b.id);
  const [downloadSets, people] = await Promise.all([
    Promise.all(releases.map((r) => request<StoredRow[]>(rows.index('by_rss_item').getAll(r.id)))),
    Promise.all(roles.map((r) => {
      const personId = numberField(r.value, 'personId');
      return personId === undefined ? Promise.resolve(undefined) : request<StoredRow | undefined>(rows.get(['person', personId]));
    })),
  ]);
  const picked: 0 | 1 = downloadSets.some((set) => set.some((d) => DOWNLOAD_TABLES.has(d.table) && d.value !== undefined)) ? 1 : 0;
  const parts: string[] = [stringField(item.value, 'title') ?? ''];
  const releaseDate = stringField(item.value, 'releaseDate');
  if (releaseDate !== undefined && releaseDate.length >= 4) parts.push(releaseDate.slice(0, 4));
  for (const r of releases) { const f = stringField(r.value, 'filename'); if (f !== undefined) parts.push(f); }
  for (const p of people) { const n = stringField(p?.value, 'name'); if (n !== undefined) parts.push(n); }
  const record: CatalogRecord = { id, pluginId, updatedAt, picked, haystack: buildHaystack(parts) };
  catalog.put(record);
}

/** Rebuilds every id's record (or deletes it) and returns the ids, ascending, for `Changed.catalog`. */
export async function recomputeCatalog(tx: IDBTransaction, ids: ReadonlySet<number>): Promise<number[]> {
  const sorted = Array.from(ids).sort((a, b) => a - b);
  await Promise.all(sorted.map((id) => recomputeOne(tx, id)));
  return sorted;
}
```

IndexedDB's types (`IDBTransaction`, `IDBKeyRange`) are ambient; import nothing for them. `buildHaystack` lives in `catalog-apply.ts`; `catalog.ts` re-exports it (`export { buildHaystack } from './catalog-apply.ts';`) so the test above imports it from `catalog.ts`.

- [ ] **Step 4: Wire `applyBatch`, `Changed`, notify, leader, sync, Store**

`apply.ts`: `const tx = db.transaction(['rows', 'meta', CATALOG_STORE], 'readwrite');`. Inside the `try`, after the loop and before `await writeCursors(tx, cursors);`:

```ts
    // The catalog phase (design spec 2026-10-02 §1.3): reads issued here see
    // the `put`s above, so a batch resolves its own cross-table references.
    const affected = await affectedMediaItems(tx, held);
    catalogIds = await recomputeCatalog(tx, affected);
```
with `let catalogIds: number[] = [];` declared before the `try`, and `const changed: Changed = { touched, inserted, catalog: catalogIds };`. Extend `Changed` with `catalog: readonly number[]` and a doc line (affected media item ids; a subscriber re-reads its filtered list). Update `applyBatch`'s docblock paragraph about the transaction to name the third store.

`notify.ts`: `const catalogSubscribers = new Set<InsertListener>()`; `subscribeCatalog`; in `emit`, `if (changed.catalog.length > 0) fireInsert(catalogSubscribers, changed.catalog);`. Module doc: the seventh registry.

`leader.ts`: `SerializedChanged.catalog: readonly number[]`; `serializeChanged` copies `changed.catalog`; `deserializeChanged` passes it through (default `[]` if absent, so a leader on an older bundle cannot break a follower: `serialized.catalog ?? []` — but `exactOptionalPropertyTypes` means make the field optional on the wire type only if you need that; simplest is required and `?? []` is unnecessary — choose required, since both tabs run the same bundle after the schema bump closes old ones).

`sync.ts` `wipe()`: transaction over `['rows', 'meta', CATALOG_STORE]` and a third `clear()`; the docblock says three stores. Any other construction of `Changed` in `sync.ts` (e.g. `emit` after a reset) gets `catalog: []`.

`index.ts`: `Store.listCatalog` and `Store.subscribeCatalog`; factory wires `listCatalog: (q, o) => listCatalog(db, q, o)` and `subscribeCatalog`.

- [ ] **Step 5: Measure the budget, run, gate, commit**

Run `catalog-apply.test.ts` three times; set `CATALOG_BATCH_BUDGET_MS` to at least 3× the median elapsed printed on a deliberate failure (temporarily assert `elapsed < 0` to see the number, then restore), rounded up, and record the median in its comment. Run all named test files — PASS. `npm run check > /tmp/p5-t2.log 2>&1; echo "exit $?"; rm -f /tmp/p5-t2.log` — exit 0.

```bash
git add -A packages && git commit -m "Keep the catalog consistent inside applyBatch, and announce catalog changes"
```

---

### Task 3: `useCatalogItems`

**Files:**
- Create: `packages/web/src/library/useCatalogItems.ts`
- Test: `packages/web/test/library/useCatalogItems.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1's `listCatalog`, `CatalogQuery`, `CatalogRecord`; Task 2's `subscribeCatalog` (if Task 2 has not landed, type the member locally as `(cb: (ids: readonly number[]) => void) => () => void` and the test wires `notify.ts`'s `subscribeTouched` shape-compatibly via a local `Set`); `MediaItemsResult` and `PAGE_SIZE` from `useMediaItems.ts`.
- Produces:

```ts
export interface CatalogItemsSource {
  listCatalog: (query: CatalogQuery, opts: ListCatalogOptions) => Promise<readonly CatalogRecord[]>;
  getRows: Store['getRows'];
  subscribeCatalog: (cb: (ids: readonly number[]) => void) => () => void;
}
export function useCatalogItems(source: CatalogItemsSource, query: CatalogQuery, pageSize?: number): MediaItemsResult;
```

- [ ] **Step 1: Write the failing tests**

Model the file on `packages/web/test/library/useMediaItems.test.tsx` (read it first: its `Harness` component, `sourceFor`, `seed`, `afterEach(cleanup)`, `waitFor`). Seed through `applyBatch` so the catalog is real (Task 2) — or, if Task 2 has not landed in your tree, write `CatalogRecord`s and `media_item` rows directly into the two stores in one transaction. Tests:

```ts
test('lists the catalog page newest first, resolving media items in catalog order, and loads more from the cursor', …);
  // seed 5 items with updatedAt 10..50, 3 picked; query {filter:'picked', term:''}, pageSize 2 → titles of the two newest picked; loadMore → third
test('a query change resets the window', …);
  // render with filter 'picked', loadMore once (window 4), then rerender with filter 'unpicked' → items are the first page of unpicked only, and listCatalog was asked for `limit: pageSize`, not 2*pageSize
test('a catalog wake re-reads from the top and a page appended from the stale cursor is dropped', …);
  // Review Focus 4: hold the loadMore listCatalog promise open; fire the subscribeCatalog callback (reload resolves with a changed window); then release loadMore → items equal the reloaded window, nothing appended
test('empty is false until the first page resolves, then true for zero matches', …);
test('a media item missing from rows is skipped, not rendered as a hole', …);
  // a catalog record whose media_item row is absent → items omit it
```

- [ ] **Step 2: Run and watch them fail** (web runner, e.g. `npm run test:web -- packages/web/test/library/useCatalogItems.test.tsx` — read `package.json` for the exact script shape) — FAIL.

- [ ] **Step 3: Implement**

Copy `useMediaItems.ts`'s structure (state `items`, `done`, `resolved`; refs `windowSizeRef`, `cursorRef`, `loadingMoreRef`, `windowGenerationRef`) and change three things: the read is `source.listCatalog(query, { limit })` / `{ from: cursor, limit: pageSize }`; records become items via `const rows = await source.getRows('media_item', records.map((r) => r.id))` then `records.flatMap((r) => { const v = rows.get(r.id); return isMediaItem(v) ? [v] : []; })` (reuse `useMediaItems.ts`'s `isMediaItem` by exporting it); the cursor is `{ updatedAt: last.updatedAt, id: last.id }` from the last **record**, not the last item (a skipped item must not stall the cursor); the subscription is `source.subscribeCatalog(safeReload)`; the effect depends on `[source, query.pluginId, query.filter, query.term, pageSize]` and resets `windowSizeRef` to `pageSize` on each run. Docblock: why a catalog wake re-reads the whole window (a record leaving the filter can be anywhere in it), and why this hook exists beside `useMediaItems` rather than replacing it (the default view never pays a catalog read, design spec §3.3).

- [ ] **Step 4: Run, gate, commit**

Test file PASS. `npm run check > /tmp/p5-t3.log 2>&1; echo "exit $?"; rm -f /tmp/p5-t3.log` — exit 0.

```bash
git add -A packages && git commit -m "Page a category through the catalog when a filter or term is set"
```

---

### Task 4: The controls, the URL, and the page

**Files:**
- Create: `packages/web/src/library/useBrowseQuery.ts`, `packages/web/src/library/BrowseControls.tsx`
- Modify: `packages/web/src/library/Category.tsx` (`CategorySource` ~47, `CategoryList` ~83-145), `packages/web/src/styles/library.css` (append)
- Test: `packages/web/test/library/useBrowseQuery.test.tsx` (new), `BrowseControls.test.tsx` (new), `Category.test.tsx`, `shell/Shell.test.tsx`

**Interfaces:**
- Consumes: Task 3's `useCatalogItems`/`CatalogItemsSource`; Task 1's `normalizeTerm`, `PickedFilter`.
- Produces:

```ts
// useBrowseQuery.ts
export const SEARCH_DEBOUNCE_MS = 150;
export interface BrowseQuery { filter: PickedFilter; q: string; term: string; }   // q as typed (URL), term = normalizeTerm(q)
export interface BrowseQueryControls { filter: PickedFilter; input: string; setFilter(f: PickedFilter): void; setInput(v: string): void; }
export function parseFilter(raw: string | null): PickedFilter;
export function useBrowseQuery(): { query: BrowseQuery; controls: BrowseQueryControls };
// BrowseControls.tsx
export interface BrowseControlsProps { filter: PickedFilter; input: string; onFilter(f: PickedFilter): void; onInput(v: string): void; }
export function BrowseControls(props: BrowseControlsProps): ReactElement;
// Category.tsx
export interface CategorySource extends MediaItemsSource, CatalogItemsSource, GatheredSource, PluginRowsSource {}
export function emptySentence(query: BrowseQuery): string;
```

- [ ] **Step 1: Write the failing tests**

`useBrowseQuery.test.tsx` renders a probe inside `<MemoryRouter initialEntries={['/tv?filter=unpicked&q=Dune%20']}>` (react-router 7: `import { MemoryRouter, Routes, Route, useLocation } from 'react-router'`), exposing `query`, `controls` and `useLocation().search`:

- reads `filter=unpicked`, `q='Dune '`, `term='dune'` from the URL;
- `filter=bogus` reads as `all` (Review Focus 3); a whitespace-only `q` has `term=''` and the view is default;
- `setFilter('picked')` writes `?filter=picked` immediately and as a replace: the probe also renders `useNavigationType()`, which reads `REPLACE` after the write (and would read `PUSH` under the "URL write pushes" mutation);
- `setInput('dune')` does not change the URL synchronously, asks `setTimeout` for `SEARCH_DEBOUNCE_MS` (spy `globalThis.setTimeout`, restore in `afterEach`), and after the real 150 ms the URL has `q=dune`;
- `setInput('')` writes immediately;
- `setFilter('all')` with empty input leaves `search === ''` (no params).

`BrowseControls.test.tsx`: three radios by role and name, checked state follows `filter`, clicking fires `onFilter`; a searchbox by role `searchbox` with accessible name `Search`, value follows `input`, typing fires `onInput`; the form has role `search` and name `Filter and search`; no element has a `class` attribute (`container.querySelector('[class]') === null`).

`Category.test.tsx`: wrap existing renders in `<MemoryRouter initialEntries={['/tv']}>` (they will now need a router); add: default route performs zero `listCatalog` calls (spy on the source); with `initialEntries={['/tv?filter=picked']}` the list comes from `listCatalog` and shows only picked items; `No picked items yet` / `No unpicked items` / `Nothing matches "zz"` / `Nothing matches "zz" among unpicked items` for their cases; `Load more` pages a filtered list; items render through `MediaItemCard` (assert the disclosure button by title name).

`Shell.test.tsx`: the category route still renders (routes already live under a router; add nothing unless the test harness lacks one).

- [ ] **Step 2: Run and watch them fail** — FAIL.

- [ ] **Step 3: Implement**

`useBrowseQuery.ts`:

```ts
/**
 * The category page's filter and search, read from and written to the URL
 * (design spec 2026-10-02 §3.2): `/tv?filter=unpicked&q=dune`.
 *
 * `q` is what the operator typed and what the input shows; `term` is what
 * the catalog is asked for. Typing is debounced before the URL changes so
 * a keystroke does not write history (and `replace` so the ones that do
 * land do not stack). Clearing is immediate: an empty box should empty the
 * list without a pause. All-with-empty-q writes no params at all, so the
 * default URL stays bare.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { normalizeTerm, type PickedFilter } from '../store/catalog.ts';

export const SEARCH_DEBOUNCE_MS = 150;

export function parseFilter(raw: string | null): PickedFilter {
  return raw === 'picked' || raw === 'unpicked' ? raw : 'all';
}

function paramsFor(filter: PickedFilter, q: string): URLSearchParams {
  const params = new URLSearchParams();
  if (filter !== 'all') params.set('filter', filter);
  if (q !== '') params.set('q', q);
  return params;
}

export function useBrowseQuery(): { query: BrowseQuery; controls: BrowseQueryControls } {
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get('filter'));
  const q = params.get('q') ?? '';
  const [input, setInput] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The URL is the source of truth; a back/forward navigation re-seeds the box.
  useEffect(() => { setInput(q); }, [q]);
  useEffect(() => () => { if (timer.current !== undefined) clearTimeout(timer.current); }, []);
  const write = useCallback((nextFilter: PickedFilter, nextQ: string) => {
    setParams(paramsFor(nextFilter, nextQ), { replace: true });
  }, [setParams]);
  const setFilter = useCallback((f: PickedFilter) => { write(f, q); }, [write, q]);
  const setInputDebounced = useCallback((value: string) => {
    setInput(value);
    if (timer.current !== undefined) clearTimeout(timer.current);
    if (value.trim() === '') { write(filter, ''); return; }
    timer.current = setTimeout(() => { write(filter, value); }, SEARCH_DEBOUNCE_MS);
  }, [write, filter]);
  return {
    query: { filter, q, term: normalizeTerm(q) },
    controls: { filter, input, setFilter, setInput: setInputDebounced },
  };
}
```
(Define `BrowseQuery` and `BrowseQueryControls` as in Interfaces.)

`BrowseControls.tsx`: the form from Global Constraints; radios `<label><input type="radio" name="filter" value="all" checked={filter === 'all'} onChange={() => onFilter('all')} />All</label>` ×3; `<label>Search <input type="search" autoComplete="off" value={input} onChange={(e) => onInput(e.currentTarget.value)} /></label>`.

`Category.tsx`: `CategorySource` extends `CatalogItemsSource` too. `Category` renders `<BrowseControls …>` from `useBrowseQuery()` above the list (inside the `<section>`, before the `store === undefined` check so the controls show while the store opens). Split `CategoryList` into `DefaultList` (calls `useMediaItems`) and `FilteredList` (calls `useCatalogItems(store, { pluginId, filter, term })`), both rendering a shared `ItemList({ store, tables, submit, result, emptyMessage })` that holds today's body (`useMemo`s, `usePluginRows`, sentinel, button). `Category` picks `DefaultList` when `query.filter === 'all' && query.term === ''`, else `FilteredList` keyed on `${filter}|${term}`. `emptySentence(query)` returns the five sentences per Global Constraints; `DefaultList` keeps `Nothing here yet.`

`library.css`, appended with a comment that these selectors reach `BrowseControls.tsx`'s form and nothing else:

```css
form[role='search'] { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3, 0.75rem); margin-block-end: var(--space-3, 0.75rem); }
form[role='search'] fieldset { display: flex; gap: var(--space-2, 0.5rem); border: 0; padding: 0; margin: 0; }
form[role='search'] legend { float: left; margin-inline-end: var(--space-2, 0.5rem); }
form[role='search'] fieldset label { display: inline-flex; align-items: center; gap: 0.25rem; }
form[role='search'] > label { display: inline-flex; align-items: center; gap: var(--space-2, 0.5rem); }
```
Check `styles/tokens.css` for the real spacing token names and use them without fallbacks if they exist.

- [ ] **Step 4: Run, gate, commit**

All named test files PASS. `npm run check > /tmp/p5-t4.log 2>&1; echo "exit $?"; rm -f /tmp/p5-t4.log` — exit 0.

```bash
git add -A packages && git commit -m "Filter a category by picked state and search it, from the URL"
```

---

### Task 5: End to end, mutations, gate

- [ ] **Step 1: e2e spec** — `packages/e2e/tests/browse-filter.spec.ts`, copying `shell.spec.ts`'s `claimInstall` and pick flow (disclosure button by title → `Pick` button). Seed two releases in `tv` with distinct titles and filenames (`seedPickableRelease({ pluginId: 'tv', title: 'A Show', filename: 'A.Show.S01E01.1080p.mkv', lookupState: 'resolved', withDownloadClient: true })` then `{ title: 'B Show', filename: 'B.Show.S01E01.mkv', … }` without a second client). Then:

```ts
  await page.getByRole('button', { name: 'A Show' }).click();
  await page.getByRole('button', { name: 'Pick' }).click();
  await page.getByRole('radio', { name: 'Unpicked' }).check();
  await expect(page).toHaveURL(/filter=unpicked/);
  await expect(page.getByRole('button', { name: 'B Show' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'A Show' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'All' }).check();
  await page.getByRole('searchbox', { name: 'Search' }).fill('A.Show.S01E01');
  await expect(page).toHaveURL(/q=A\.Show\.S01E01/);
  await expect(page.getByRole('button', { name: 'A Show' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'B Show' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue('A.Show.S01E01');
  await expect(page.getByRole('button', { name: 'A Show' })).toBeVisible({ timeout: 15_000 });
```
Keep every timeout within what `shell.spec.ts` uses. The pick's download row must sync to the replica before Unpicked hides A Show; the 5 s expectation covers the 10 s reconcile? No: the row is written at submit time, so it syncs on the next tail tick, well under 5 s. If flaky, read the harness for how `shell.spec.ts` waits for a status text after a pick and do the same before switching filters.

- [ ] **Step 2: Run the e2e suite** (`npm run e2e > /tmp/p5-e2e.log 2>&1; echo $?`; read the tail; delete).

- [ ] **Step 3: Mutations** (one at a time; `git checkout -- <file>` after; a mutant that reddens nothing means a missing test — add it):

| Mutation | File | Covering tests |
|---|---|---|
| haystack skips filenames | `store/catalog-apply.ts` | `catalog-apply.test.ts` |
| `picked` only when a download's `status === 'delivered'` | `store/catalog-apply.ts` | `catalog-apply.test.ts` |
| rematch path ignores the previous row's `mediaItemId` | `store/catalog-apply.ts` | `catalog-apply.test.ts` |
| `by_media_item` rows not filtered by table (a `tv_release` treated as a release) | `store/catalog-apply.ts` | `catalog-apply.test.ts` |
| `wipe()` leaves `catalog` | `store/sync.ts` | `sync.test.ts` |
| `listCatalog` ignores `from` | `store/catalog.ts` | `catalog.test.ts` |
| `listCatalog` uses `by_plugin_updated` for `picked` too (filters nothing) | `store/catalog.ts` | `catalog.test.ts` |
| default view reads the catalog (`DefaultList` → `FilteredList`) | `library/Category.tsx` | `Category.test.tsx` |
| URL write pushes (`replace: false`) | `library/useBrowseQuery.ts` | `useBrowseQuery.test.tsx` |
| `SEARCH_DEBOUNCE_MS = 0` | `library/useBrowseQuery.ts` | `useBrowseQuery.test.tsx` |
| `parseFilter` returns the raw string | `library/useBrowseQuery.ts` | `useBrowseQuery.test.tsx` |
| `useCatalogItems` drops the generation guard | `library/useCatalogItems.ts` | `useCatalogItems.test.tsx` |

- [ ] **Step 4: Final gate** — `npm run check > /tmp/p5-final.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)" /tmp/p5-final.log; rm -f /tmp/p5-final.log` — exit 0, `fail 0`.

```bash
git add -A packages && git commit -m "Pin the browse filter and search end to end"
```

Nothing is pushed or merged.
