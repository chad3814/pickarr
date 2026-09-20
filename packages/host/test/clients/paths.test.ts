import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { mapClientPath } from '../../src/clients/paths.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

/** Inserts one `download_client` row and returns its id. */
function seedClient(raw: DatabaseSync, name = 'Client'): number {
  raw.prepare(`
    INSERT INTO download_client (name, type, implementation, url, category, import_mode, created_at, updated_at)
    VALUES (?, 'torrent', 'qbittorrent', 'https://example.com', 'movies', 'copy', 1, 1)
  `).run(name);
  const inserted = raw.prepare('SELECT id FROM download_client WHERE name = ?').get(name);
  return Number((inserted as { id: unknown }).id);
}

/** Inserts one `filepath_mapping` row for `clientId`. */
function seedMapping(raw: DatabaseSync, clientId: number, fromPath: string, toPath: string): void {
  raw.prepare(`
    INSERT INTO filepath_mapping (download_client_id, from_path, to_path, created_at, updated_at)
    VALUES (?, ?, ?, 1, 1)
  `).run(clientId, fromPath, toPath);
}

test('a matching prefix is replaced', () => {
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');

  const result = mapClientPath(raw, clientId, '/downloads/movie.mkv');

  assert.equal(result, '/media/movie.mkv');
});

test('the longest matching prefix wins, whichever row was inserted first', () => {
  // General mapping first, specific mapping second.
  const generalFirst = setup();
  const generalFirstClient = seedClient(generalFirst);
  seedMapping(generalFirst, generalFirstClient, '/downloads', '/media');
  seedMapping(generalFirst, generalFirstClient, '/downloads/tv', '/media/tv-shows');

  assert.equal(
    mapClientPath(generalFirst, generalFirstClient, '/downloads/tv/show.mkv'),
    '/media/tv-shows/show.mkv',
  );

  // Same two mappings, fresh database, order reversed: specific mapping
  // inserted first, general mapping second. A first-match implementation
  // would pass the case above and fail this one, or vice versa.
  const specificFirst = setup();
  const specificFirstClient = seedClient(specificFirst);
  seedMapping(specificFirst, specificFirstClient, '/downloads/tv', '/media/tv-shows');
  seedMapping(specificFirst, specificFirstClient, '/downloads', '/media');

  assert.equal(
    mapClientPath(specificFirst, specificFirstClient, '/downloads/tv/show.mkv'),
    '/media/tv-shows/show.mkv',
  );
});

test('an unmapped path is returned unchanged rather than refused', () => {
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');

  const result = mapClientPath(raw, clientId, '/elsewhere/movie.mkv');

  assert.equal(result, '/elsewhere/movie.mkv');
});

test("another client's mapping is not applied", () => {
  const raw = setup();
  const clientId = seedClient(raw, 'Client A');
  const otherClientId = seedClient(raw, 'Client B');
  seedMapping(raw, otherClientId, '/downloads', '/media');

  const result = mapClientPath(raw, clientId, '/downloads/movie.mkv');

  assert.equal(result, '/downloads/movie.mkv');
});

test('a sibling directory with a longer name is not a match', () => {
  // Raw `startsWith` would let `/downloads-old` match a `/downloads`
  // mapping, because the string `/downloads-old` starts with the characters
  // `/downloads` even though it names a sibling directory, not anything
  // beneath `/downloads`. The match must end at a path boundary: the
  // remainder after the prefix must be empty or begin with `/`.
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');

  const result = mapClientPath(raw, clientId, '/downloads-old/movie.mkv');

  assert.equal(result, '/downloads-old/movie.mkv');
});

test('the tie this function does not resolve cannot be reached, because the index refuses it', () => {
  // `mapClientPath`'s doc says equal-length matches resolve to whichever row
  // the loop visits first and that nothing relies on that. Migration 19's
  // unique index on `(download_client_id, from_path)` is what turns "nothing
  // relies on it" into "nothing can reach it", and this drives that through
  // the consumer rather than asserting the index exists -- the schema half
  // is `test/db/migrate.test.ts`'s "two mappings for one client cannot share
  // a from_path".
  //
  // **Equal length and both matching implies identical, which is the whole
  // argument.** `matchesBoundary` requires `clientPath.startsWith(fromPath)`,
  // so two `from_path` values that both match one path are both prefixes of
  // it; two prefixes of one string with the same length are the same string.
  // So a tie needs two identical `from_path` values for one client, and that
  // is exactly the pair the index refuses. Two same-length *different*
  // values (`/a/b` and `/c/d`) are admitted by the index and cannot tie,
  // because at most one of them matches any given path.
  const raw = setup();
  const clientId = seedClient(raw);
  seedMapping(raw, clientId, '/downloads', '/media');

  assert.throws(
    () => seedMapping(raw, clientId, '/downloads', '/elsewhere'),
    /UNIQUE/,
    'the second row of the only pair that could tie must never reach the table',
  );

  assert.equal(mapClientPath(raw, clientId, '/downloads/movie.mkv'), '/media/movie.mkv',
    'so the surviving mapping is the only candidate and the answer is not a draw');
});
