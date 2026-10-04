import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { SUGGEST_LIMIT } from '@pickarr/plugin-ui';
import { freshDb } from '../store/harness.ts';
import { done } from '../../src/store/idb.ts';
import { getRows } from '../../src/store/rows.ts';
import { listCatalog, type CatalogRecord } from '../../src/store/catalog.ts';
import { identifySubmit, suggestCandidates } from '../../src/library/suggestCandidates.ts';
import { postIdentify } from '../../src/library/postIdentify.ts';

interface SeedItem {
  id: number;
  title: string;
  updatedAt: number;
  pluginId?: string;
  releaseDate?: string | null;
}

/** Writes catalog records and `media_item` rows directly, as `useCatalogItems.test.tsx` does. */
async function seed(db: IDBDatabase, items: readonly SeedItem[]): Promise<void> {
  const tx = db.transaction(['catalog', 'rows'], 'readwrite');
  for (const item of items) {
    const pluginId = item.pluginId ?? 'tv';
    const record: CatalogRecord = {
      id: item.id,
      pluginId,
      updatedAt: item.updatedAt,
      picked: 0,
      haystack: item.title.toLowerCase(),
      poster: null,
      background: null,
    };
    tx.objectStore('catalog').put(record);
    tx.objectStore('rows').put({
      table: 'media_item',
      id: item.id,
      value: {
        id: item.id,
        pluginId,
        createdAt: item.updatedAt,
        updatedAt: item.updatedAt,
        provider: null,
        providerRef: null,
        title: item.title,
        releaseDate: item.releaseDate ?? null,
        description: null,
      },
    });
  }
  await done(tx);
}

function sourceFor(db: IDBDatabase): Parameters<typeof suggestCandidates>[0] {
  return {
    listCatalog: (query, opts) => listCatalog(db, query, opts),
    getRows: (table, ids) => getRows(db, table, ids),
  };
}

test('the term is normalised, so a trailing space and mixed case still match', async () => {
  const db = await freshDb();
  await seed(db, [{ id: 1, title: 'Dune', updatedAt: 10, releaseDate: '2021-10-22' }]);
  assert.deepEqual(await suggestCandidates(sourceFor(db), 'tv', 'Dune '), [{ mediaItemId: 1, title: 'Dune', year: '2021' }]);
  db.close();
});

test('an empty or blank term suggests nothing', async () => {
  const db = await freshDb();
  await seed(db, [{ id: 1, title: 'Dune', updatedAt: 10 }]);
  assert.deepEqual(await suggestCandidates(sourceFor(db), 'tv', ''), []);
  assert.deepEqual(await suggestCandidates(sourceFor(db), 'tv', '   '), []);
  db.close();
});

test('suggestions are scoped to the plugin', async () => {
  const db = await freshDb();
  await seed(db, [
    { id: 1, title: 'Dune', updatedAt: 10, pluginId: 'tv' },
    { id: 2, title: 'Dune', updatedAt: 20, pluginId: 'movies' },
  ]);
  assert.deepEqual((await suggestCandidates(sourceFor(db), 'tv', 'dune')).map((c) => c.mediaItemId), [1]);
  db.close();
});

test('year is null when the release date is absent or too short', async () => {
  const db = await freshDb();
  await seed(db, [
    { id: 1, title: 'Dune A', updatedAt: 10, releaseDate: null },
    { id: 2, title: 'Dune B', updatedAt: 20, releaseDate: '19' },
  ]);
  const found = await suggestCandidates(sourceFor(db), 'tv', 'dune');
  assert.deepEqual(found.map((c) => c.year), [null, null]);
  db.close();
});

test('at most SUGGEST_LIMIT titles come back, in catalog order (newest first)', async () => {
  const db = await freshDb();
  const items: SeedItem[] = [];
  for (let id = 1; id <= SUGGEST_LIMIT + 3; id += 1) items.push({ id, title: `Dune ${String(id)}`, updatedAt: id });
  await seed(db, items);
  const found = await suggestCandidates(sourceFor(db), 'tv', 'dune');
  assert.equal(found.length, SUGGEST_LIMIT);
  assert.deepEqual(found.map((c) => c.mediaItemId), [11, 10, 9, 8, 7, 6, 5, 4]);
  db.close();
});

test('identifySubmit binds the real post and suggestions off the store it is given', async () => {
  const db = await freshDb();
  await seed(db, [{ id: 1, title: 'Dune', updatedAt: 10, releaseDate: '2021-10-22' }]);
  const submit = identifySubmit(sourceFor(db));
  assert.equal(submit.identify, postIdentify);
  assert.deepEqual(await submit.suggest('tv', 'dune'), [{ mediaItemId: 1, title: 'Dune', year: '2021' }]);
  db.close();
});
