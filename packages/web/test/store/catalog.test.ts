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
  db.close();
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
  db.close();
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
  assert.deepEqual((await q('all', 'e', 2)).map((r) => r.id), [4, 2], 'limit counts matches, not records walked (record 3 is walked and skipped)');
  db.close();
});
