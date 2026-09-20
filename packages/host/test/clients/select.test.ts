import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { randomIndexWith, selectClientForFeed } from '../../src/clients/select.ts';

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

/**
 * The chooser handed to every case that settles without a draw: a feed that
 * names its own client, and each of the three refusals. None of them has a
 * set of candidates to choose from, so reaching a chooser at all would be a
 * bug -- this makes that bug a failure rather than something a later
 * assertion would have to infer.
 */
function refuseToChoose(): never {
  throw new Error('the chooser was consulted where there was no choice to make');
}

/**
 * A fixed-sequence stand-in for `Math.random`, so a test can drive the
 * *real* chooser without asserting a probability.
 *
 * A 32-bit xorshift, every step an exact operation on a 32-bit word. This
 * was a textbook LCG, described here as glibc's; it was neither. At this
 * width `state * 1103515245` exceeds `Number.MAX_SAFE_INTEGER` on the first
 * step, so the product is rounded and the sequence is not the one those
 * constants name. Determinism -- the only property actually required --
 * survived that, but the attribution did not, and an unchecked provenance
 * in a comment is the kind of claim this repo has been bitten by.
 *
 * Nothing here needs the sequence to be statistically good. What is
 * required of it is that it be the same on every run, and that it reach all
 * three candidates -- which is not assumed, it is what the assertion below
 * measures.
 */
function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

test('a feed that names a client gets that client', () => {
  const raw = setup();
  const first = seedClient(raw, { name: 'First', type: 'torrent' });
  const second = seedClient(raw, { name: 'Second', type: 'torrent' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: second });

  const result = selectClientForFeed(raw, feedId, refuseToChoose);

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

  // `refuseToChoose`, not `() => 0`: a sole candidate is unambiguous by
  // construction, and the module says so. Taking it through a draw of one
  // would make the case that describes nearly every install depend on
  // whatever chooser its caller happened to pass.
  const result = selectClientForFeed(raw, feedId, refuseToChoose);

  assert.equal(result, torrentClient);
});

test('three clients of the feed\'s type: the chooser picks among them, by id order', () => {
  // The behaviour change. This branch used to refuse; it now draws, and
  // what is asserted is that the draw is the *chooser's* -- fed the real
  // candidate count, and honoured.
  const raw = setup();
  const first = seedClient(raw, { name: 'First', type: 'torrent' });
  const second = seedClient(raw, { name: 'Second', type: 'torrent' });
  const third = seedClient(raw, { name: 'Third', type: 'torrent' });
  const feedId = seedFeed(raw, { name: 'Spread Feed', downloadType: 'torrent', downloadClientId: null });

  const asked: number[] = [];
  const result = selectClientForFeed(raw, feedId, (count) => {
    asked.push(count);
    return 1;
  });

  // Index 1 of three ids in ascending order is the second one, spelled out
  // literally rather than recomputed from the code under test -- an
  // implementation that ignored the chooser and kept returning index 0
  // would still satisfy an expectation built by asking it.
  assert.deepEqual(asked, [3]);
  assert.equal(result, second);
  assert.notEqual(result, first);
  assert.notEqual(result, third);
});

test('repeated selection through the real chooser reaches every candidate', () => {
  // This is the test the 1.x bug has to fail. `randomIndexWith` is the
  // factory `randomIndex` -- the chooser production passes -- is built
  // from; only its source of randomness is replaced here, by a generator
  // whose sequence is fixed, so the assertion is the same on every run
  // instead of being a probability dressed up as a test.
  const raw = setup();
  const ids = [
    seedClient(raw, { name: 'First', type: 'torrent' }),
    seedClient(raw, { name: 'Second', type: 'torrent' }),
    seedClient(raw, { name: 'Third', type: 'torrent' }),
  ];
  const feedId = seedFeed(raw, { name: 'Busy Feed', downloadType: 'torrent', downloadClientId: null });

  const random = seededRandom(20260919);
  const reached = new Set<number>();
  for (let pick = 0; pick < 60; pick += 1) {
    reached.add(selectClientForFeed(raw, feedId, randomIndexWith(random)));
  }

  assert.deepEqual([...reached].toSorted((a, b) => a - b), ids);
});

test('a chooser built by randomIndexWith spans the whole range and never answers past its end', () => {
  // `Math.random` is [0, 1), so the top of the range must land on the last
  // index rather than one past it -- the out-of-range answer the next test
  // shows `selectClientForFeed` would refuse.
  assert.equal(randomIndexWith(() => 0)(3), 0);
  assert.equal(randomIndexWith(() => 0.34)(3), 1);
  assert.equal(randomIndexWith(() => 0.67)(3), 2);
  assert.equal(randomIndexWith(() => 0.9999999)(3), 2);
  assert.equal(randomIndexWith(() => 0.9999999)(1), 0);
});

test('a chooser answering outside the candidate range is an error, not a crash', () => {
  // Reachable, unlike the other guards in this module: the chooser is
  // injected, so a wrong one is a caller's bug and must read as one rather
  // than as `undefined` surfacing somewhere further down.
  const raw = setup();
  seedClient(raw, { name: 'First', type: 'torrent' });
  seedClient(raw, { name: 'Second', type: 'torrent' });
  const feedId = seedFeed(raw, { name: 'Out Of Range Feed', downloadType: 'torrent', downloadClientId: null });

  // Index 7, not index 2: `2` appears in this message anyway as the
  // candidate count, and in the feed id often enough, so `includes('2')`
  // would pass against an implementation that never reported the index at
  // all. `answered 7` can only come from the chooser's own answer.
  assert.throws(
    () => selectClientForFeed(raw, feedId, () => 7),
    (err: unknown) => err instanceof Error
      && err.message.includes(`feed ${feedId}`)
      && err.message.includes('Out Of Range Feed')
      && err.message.includes('answered 7')
      && err.message.includes('2 candidates')
      && !err.message.includes('has no download client of type'),
  );
});

test('no client of the feed\'s type is an error naming the feed', () => {
  const raw = setup();
  const feedId = seedFeed(raw, { name: 'Lonely Feed', downloadType: 'torrent', downloadClientId: null });

  assert.throws(
    () => selectClientForFeed(raw, feedId, refuseToChoose),
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
    () => selectClientForFeed(raw, feedId, refuseToChoose),
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
    () => selectClientForFeed(raw, feedId, refuseToChoose),
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
    () => selectClientForFeed(raw, 999, refuseToChoose),
    (err: unknown) => err instanceof Error
      && err.message.includes('999')
      && err.message.includes('not found')
      && !err.message.includes('matches')
      && !err.message.includes('has no download client of type')
      && !err.message.includes('but its download_type is'),
  );
});
