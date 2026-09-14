import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { lookupTable, lookupTableMigration, lookupTableName } from '../src/table.ts';

function applied(pluginId: string): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  // The host's tables the DDL references. Minimal stubs: these tests are about
  // the generated table, and the real foreign keys are exercised by the host's
  // own flow test, which migrates the real schema.
  raw.exec('CREATE TABLE rss_item (id INTEGER PRIMARY KEY)');
  raw.exec('CREATE TABLE media_item (id INTEGER PRIMARY KEY)');
  lookupTableMigration(pluginId).up(raw);
  return raw;
}

test('is version 1 and names the table after the plugin', () => {
  assert.equal(lookupTableMigration('tv').version, 1);
  assert.equal(lookupTableName('tv'), 'tv_lookup');
});

test('creates the table and its unique index, both prefixed', () => {
  const raw = applied('movie');
  const names = raw.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String((row as { name: unknown }).name))
    .filter((name) => name !== 'rss_item' && name !== 'media_item');
  assert.deepEqual(names.toSorted(), ['movie_lookup', 'movie_lookup_rss_item']);
});

test('holds one row per rss item', () => {
  const raw = applied('xxx');
  raw.prepare('INSERT INTO rss_item (id) VALUES (1)').run();
  const insert = raw.prepare(
    'INSERT INTO xxx_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)',
  );
  insert.run(1, 10, 10);
  assert.throws(() => insert.run(1, 11, 11), /UNIQUE/);
});

test('leaves every column but the timestamps nullable, so a row exists before an answer does', () => {
  const raw = applied('tv');
  raw.prepare('INSERT INTO rss_item (id) VALUES (7)').run();
  raw.prepare('INSERT INTO tv_lookup (rss_item_id, created_at, updated_at) VALUES (7, 1, 1)').run();
  const row = raw.prepare('SELECT media_item_id, lookup_job_id, lookup_id, provider_ref, confidence FROM tv_lookup').get();
  assert.deepEqual(Object.assign({}, row), {
    media_item_id: null,
    lookup_job_id: null,
    lookup_id: null,
    provider_ref: null,
    confidence: null,
  });
});

test('the drizzle object names the same table and columns', () => {
  const table = lookupTable('tv');
  const raw = applied('tv');
  const columns = raw.prepare('SELECT name FROM pragma_table_info(?)').all('tv_lookup')
    .map((row) => String((row as { name: unknown }).name));
  assert.deepEqual(columns.toSorted(), [
    'confidence', 'created_at', 'id', 'lookup_id', 'lookup_job_id',
    'media_item_id', 'provider_ref', 'rss_item_id', 'updated_at',
  ]);
  // The Drizzle object is what the engine writes through; it must agree.
  assert.equal(table.rssItemId.name, 'rss_item_id');
  assert.equal(table.confidence.name, 'confidence');
});
