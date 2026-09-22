import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  isPlaced, placementTableMigration, placementTableName, recordPlacement,
} from '../src/placement.ts';

function database(): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('CREATE TABLE rss_item (id INTEGER PRIMARY KEY)');
  placementTableMigration('tv', 3).up(raw);
  return raw;
}

test('the table is named with the plugin prefix, at the version the plugin chose', () => {
  assert.equal(placementTableName('tv'), 'tv_placement');
  assert.equal(placementTableMigration('movie', 3).version, 3);
  const raw = database();
  const row = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tv_placement'").get();
  assert.ok(row !== undefined, 'tv_placement was not created');
});

test('an entry is placed only once recorded, per rss item and relative path', () => {
  const raw = database();
  assert.equal(isPlaced(raw, 'tv', 7, 'S1/a.mkv'), false);
  recordPlacement(raw, 'tv', 7, 'S1/a.mkv', 1);
  assert.equal(isPlaced(raw, 'tv', 7, 'S1/a.mkv'), true);
  assert.equal(isPlaced(raw, 'tv', 8, 'S1/a.mkv'), false, 'another rss item is not placed');
  assert.equal(isPlaced(raw, 'tv', 7, 'S1/b.mkv'), false, 'another entry is not placed');
});

test('recording the same entry twice is not an error', () => {
  const raw = database();
  recordPlacement(raw, 'tv', 7, 'a.mkv', 1);
  recordPlacement(raw, 'tv', 7, 'a.mkv', 2);
  const count = raw.prepare('SELECT COUNT(*) AS n FROM tv_placement').get()?.['n'];
  assert.equal(count, 1);
});
