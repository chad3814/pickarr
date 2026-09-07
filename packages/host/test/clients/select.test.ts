import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { selectClientForFeed } from '../../src/clients/select.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/**
 * Inserts one `download_client` row and returns its id. Only `name` and
 * `type` vary per test; `implementation` follows `type` so the row stays
 * internally consistent, though `selectClientForFeed` never reads it.
 */
function seedClient(raw: DatabaseSync, overrides: { name?: string; type?: string } = {}): number {
  const row = { name: 'Client', type: 'torrent', ...overrides };
  const implementation = row.type === 'nzb' ? 'sabnzbd' : 'qbittorrent';
  raw.prepare(`
    INSERT INTO download_client (name, type, implementation, url, category, import_mode, created_at, updated_at)
    VALUES (?, ?, ?, 'https://example.com', 'movies', 'copy', 1, 1)
  `).run(row.name, row.type, implementation);
  const inserted = raw.prepare('SELECT id FROM download_client WHERE name = ?').get(row.name);
  return Number((inserted as { id: unknown }).id);
}

/** Inserts one `rss_feed` row and returns its id. */
function seedFeed(raw: DatabaseSync, overrides: {
  name?: string;
  downloadType?: string;
  downloadClientId?: number | null;
} = {}): number {
  const row = { name: 'Feed', downloadType: 'torrent', downloadClientId: null, ...overrides };
  raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, download_client_id, download_type, created_at, updated_at)
    VALUES ('alpha', ?, ?, ?, ?, 1, 1)
  `).run(row.name, `https://example.com/${row.name}`, row.downloadClientId, row.downloadType);
  const inserted = raw.prepare('SELECT id FROM rss_feed WHERE name = ?').get(row.name);
  return Number((inserted as { id: unknown }).id);
}

test('a feed that names a client gets that client', () => {
  const raw = setup();
  const first = seedClient(raw, { name: 'First', type: 'torrent' });
  const second = seedClient(raw, { name: 'Second', type: 'torrent' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: second });

  const result = selectClientForFeed(raw, feedId);

  // Two torrent clients exist, so a "first match" implementation would also
  // pass this test by accident if it happened to return `first`. Asserting
  // the exact chosen id, and that it is not `first`, is what actually pins
  // down that the explicit name won, not some positional fallback.
  assert.equal(result, second);
  assert.notEqual(result, first);
});

test('a feed naming none falls back to the only client of its type', () => {
  const raw = setup();
  const torrentClient = seedClient(raw, { name: 'Torrent Client', type: 'torrent' });
  seedClient(raw, { name: 'Nzb Client', type: 'nzb' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: null });

  const result = selectClientForFeed(raw, feedId);

  assert.equal(result, torrentClient);
});

test('two clients of the feed\'s type is an error naming the feed', () => {
  // Not a silent choice. This is the 1.x bug, and the test that forbids it.
  const raw = setup();
  seedClient(raw, { name: 'First', type: 'torrent' });
  seedClient(raw, { name: 'Second', type: 'torrent' });
  const feedId = seedFeed(raw, { name: 'Ambiguous Feed', downloadType: 'torrent', downloadClientId: null });

  assert.throws(
    () => selectClientForFeed(raw, feedId),
    (err: unknown) => err instanceof Error
      && err.message.includes(`feed ${feedId}`)
      && err.message.includes('Ambiguous Feed')
      && err.message.includes('matches 2 download clients of type "torrent"')
      && !err.message.includes('has no download client of type')
      && !err.message.includes('but its download_type is')
      && !err.message.includes('not found'),
  );
});

test('no client of the feed\'s type is an error naming the feed', () => {
  const raw = setup();
  const feedId = seedFeed(raw, { name: 'Lonely Feed', downloadType: 'torrent', downloadClientId: null });

  assert.throws(
    () => selectClientForFeed(raw, feedId),
    (err: unknown) => err instanceof Error
      && err.message.includes(`feed ${feedId}`)
      && err.message.includes('Lonely Feed')
      && err.message.includes('has no download client of type "torrent"')
      && !err.message.includes('matches')
      && !err.message.includes('but its download_type is')
      && !err.message.includes('not found'),
  );
});

test('a client of the other type is not a candidate', () => {
  // One nzb client exists and the feed is torrent: that is "none", not "one".
  const raw = setup();
  seedClient(raw, { name: 'Nzb Client', type: 'nzb' });
  const feedId = seedFeed(raw, { name: 'Torrent Feed', downloadType: 'torrent', downloadClientId: null });

  assert.throws(
    () => selectClientForFeed(raw, feedId),
    (err: unknown) => err instanceof Error
      && err.message.includes(`feed ${feedId}`)
      && err.message.includes('has no download client of type "torrent"')
      && !err.message.includes('matches')
      && !err.message.includes('but its download_type is'),
  );
});

test('a feed naming a client of the wrong type is an error', () => {
  // An explicit choice can still be wrong, and a magnet handed to an nzb
  // client fails confusingly far from here.
  const raw = setup();
  const nzbClient = seedClient(raw, { name: 'Nzb Client', type: 'nzb' });
  const feedId = seedFeed(raw, { name: 'Mismatched Feed', downloadType: 'torrent', downloadClientId: nzbClient });

  assert.throws(
    () => selectClientForFeed(raw, feedId),
    (err: unknown) => err instanceof Error
      && err.message.includes(`feed ${feedId}`)
      && err.message.includes('Mismatched Feed')
      && err.message.includes(`download client ${nzbClient}`)
      && err.message.includes('but its download_type is "torrent"')
      && !err.message.includes('has no download client of type')
      && !err.message.includes('matches')
      && !err.message.includes('not found'),
  );
});

test('a feed id that matches no rss_feed row is an error naming the feed id', () => {
  const raw = setup();

  assert.throws(
    () => selectClientForFeed(raw, 999),
    (err: unknown) => err instanceof Error
      && err.message.includes('999')
      && err.message.includes('not found')
      && !err.message.includes('matches')
      && !err.message.includes('has no download client of type')
      && !err.message.includes('but its download_type is'),
  );
});
