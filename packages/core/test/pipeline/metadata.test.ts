import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, MetadataCandidate } from '@pickarr/plugin-api';
import createScenesPlugin from '@pickarr/plugin-scenes';
import { openTestDatabase } from '../../src/db/open.ts';
import { insertGroup } from '../../src/db/groups.ts';
import { dueMetadataQueue, enqueueMetadata, getGroupMetadata } from '../../src/db/metadata.ts';
import { getDiscoveredSite, recordDiscoveredSite } from '../../src/db/sites.ts';
import { RateLimited, type FetchImpl, type SceneLookupClient } from '../../src/clients/theporndb.ts';
import type { ArtworkDeps } from '../../src/media/artwork.ts';
import {
  createMetadataRunner,
  MAX_BACKOFF_MS,
  MAX_METADATA_ATTEMPTS,
  runMetadataPass,
  type MetadataPassDeps,
} from '../../src/pipeline/metadata.ts';

const scenesPlugin: MediaTypePlugin = createScenesPlugin({ libraryRoot: '/m', sites: [] });

function defaultPluginFor(pluginPackage: string): MediaTypePlugin | null {
  return pluginPackage === 'scenes' ? scenesPlugin : null;
}

// Never expected to run in tests that don't confirm a candidate with a
// poster: fetchImpl throws loudly if it is ever reached unexpectedly.
const unusedArtwork: ArtworkDeps = {
  dir: '/tmp/pickarr-metadata-test-unused',
  fetchImpl: () => {
    throw new Error('fetchImpl should not be called in this test');
  },
  log: () => undefined,
};

function deps(
  overrides: { db: DatabaseSync; client: SceneLookupClient | undefined } & Partial<
    Omit<MetadataPassDeps, 'db' | 'client'>
  >,
): MetadataPassDeps {
  return {
    db: overrides.db,
    client: overrides.client,
    pluginFor: overrides.pluginFor ?? defaultPluginFor,
    artwork: overrides.artwork ?? unusedArtwork,
    perTick: overrides.perTick ?? 5,
    now: overrides.now ?? (() => 0),
    log: overrides.log ?? (() => undefined),
  };
}

/** A group the scenes plugin can build a metadata query for: a title and a site. */
function makeGroup(db: DatabaseSync, title: string, siteName: string, date?: string): number {
  const display = {
    title,
    subtitle: siteName,
    fields: [],
    ...(date === undefined ? {} : { date }),
  };
  return insertGroup(db, {
    plugin: 'scenes',
    identityKey: `${siteName}:${title}`,
    display: JSON.stringify(display),
    searchText: title.toLowerCase(),
    createdAt: 0,
  });
}

function candidate(overrides: Partial<MetadataCandidate> = {}): MetadataCandidate {
  return {
    sourceUuid: 'scene-uuid',
    title: 'A Scene',
    siteUuid: 'site-uuid',
    siteId: 1,
    siteName: 'Some Site',
    date: null,
    performers: ['Jane Doe'],
    durationSeconds: 1200,
    synopsis: 'A synopsis',
    posterUrl: null,
    ...overrides,
  };
}

interface AskedQuery {
  query: string;
  siteId: number | null;
}

/**
 * A scene-search client that records every query it received and answers
 * from a scripted function — either candidates, or a thrown error, which
 * models both an ordinary failure and a 429 depending on what is thrown.
 */
function fakeSceneClient(
  respond: (asked: AskedQuery, call: number) => readonly MetadataCandidate[],
): SceneLookupClient & { asked: AskedQuery[] } {
  const asked: AskedQuery[] = [];
  let call = 0;
  return {
    source: 'theporndb',
    asked,
    searchScenes(query, siteId) {
      const entry = { query, siteId };
      asked.push(entry);
      const result = respond(entry, call);
      call += 1;
      return Promise.resolve(result);
    },
  };
}

const fetchJpeg: FetchImpl = () =>
  Promise.resolve(
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    }),
  );

const fetchNotFound: FetchImpl = () => Promise.resolve(new Response(null, { status: 404 }));

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-metadata-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a confirmation is stored with its poster and clears the queue row', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    const groupId = makeGroup(db, 'A Naughty Office Scene', 'Naughty Office');
    enqueueMetadata(db, [groupId], 1_000);

    const scene = candidate({
      title: 'A Naughty Office Scene',
      siteName: 'Naughty Office',
      posterUrl: 'https://example.test/poster.jpg',
    });
    const client = fakeSceneClient(() => [scene]);

    const result = await runMetadataPass(
      deps({ db, client, now: () => 1_000, artwork: { dir, fetchImpl: fetchJpeg, log: () => undefined } }),
    );

    assert.equal(result.confirmed, 1);
    const stored = getGroupMetadata(db, groupId);
    assert.equal(stored?.state, 'confirmed');
    assert.equal(stored?.posterPath, `${groupId}.jpg`);
    assert.equal(dueMetadataQueue(db, 999_999, 10).length, 0, 'the queue row must be gone');
  });
});

test('a search that matched nothing is cached as an answer', async () => {
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  enqueueMetadata(db, [groupId], 1_000);

  const client = fakeSceneClient(() => []);
  const result = await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  assert.equal(result.none, 1);
  assert.equal(getGroupMetadata(db, groupId)?.state, 'none');

  const second = enqueueMetadata(db, [groupId], 2_000);
  assert.deepEqual(second, { queued: 0, alreadyAnswered: 1, pending: 0 });
});

test('a lookup that could not be made is not cached', async () => {
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  enqueueMetadata(db, [groupId], 1_000);

  const client = fakeSceneClient(() => {
    throw new Error('ECONNREFUSED');
  });
  const result = await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  assert.equal(result.deferred, 1);
  assert.equal(getGroupMetadata(db, groupId), undefined, 'a failed lookup must not be cached');
  const row = db.prepare('SELECT attempts FROM metadata_queue WHERE group_id = ?').get(groupId);
  assert.equal(Number(row?.['attempts']), 1);
});

test('backoff grows and is capped', async () => {
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  enqueueMetadata(db, [groupId], 0);

  const client = fakeSceneClient(() => {
    throw new Error('ECONNRESET');
  });

  let now = 0;
  const deltas: number[] = [];
  const readQueue = () => {
    const row = db.prepare('SELECT next_at FROM metadata_queue WHERE group_id = ?').get(groupId);
    return Number(row?.['next_at']);
  };

  for (let i = 0; i < 12; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- driving the same row through repeated passes is inherently sequential
    await runMetadataPass(deps({ db, client, now: () => now }));
    const nextAt = readQueue();
    deltas.push(nextAt - now);
    now = nextAt;
  }

  assert.equal(deltas[0], 60_000);
  assert.equal(deltas[1], 120_000);
  assert.equal(deltas[2], 240_000);
  assert.ok(
    deltas.every((delta) => delta <= MAX_BACKOFF_MS),
    'backoff must never exceed the cap',
  );
  assert.equal(deltas[deltas.length - 1], MAX_BACKOFF_MS, 'it must eventually reach the cap');
  assert.equal(deltas[deltas.length - 2], MAX_BACKOFF_MS, 'and stay there');
});

test('a 429 stops the pass and leaves later rows untouched', async () => {
  const db = openTestDatabase();
  const ids = [
    makeGroup(db, 'Scene One', 'Site One'),
    makeGroup(db, 'Scene Two', 'Site Two'),
    makeGroup(db, 'Scene Three', 'Site Three'),
  ];
  const now = 1_000;
  enqueueMetadata(db, ids, now);

  const asked: string[] = [];
  const client = fakeSceneClient((entry) => {
    asked.push(entry.query);
    throw new RateLimited(30_000);
  });

  const result = await runMetadataPass(deps({ db, client, now: () => now }));

  assert.equal(asked.length, 1, 'one request discovers the limit; the others must not rediscover it');
  assert.ok(result.cooldownUntil !== null);
  assert.equal(result.cooldownUntil, now + 30_000);

  const rows = db
    .prepare(`SELECT group_id, next_at FROM metadata_queue WHERE group_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const nextAtById = new Map(rows.map((row) => [Number(row['group_id']), Number(row['next_at'])]));

  assert.equal(nextAtById.get(ids[0]!), now + 30_000, 'the row that hit the limit is deferred to the cooldown');
  assert.equal(nextAtById.get(ids[1]!), now, 'a later row must keep its original next_at');
  assert.equal(nextAtById.get(ids[2]!), now, 'a later row must keep its original next_at');
});

test('perTick bounds one pass', async () => {
  const db = openTestDatabase();
  const ids = Array.from({ length: 10 }, (_unused, i) => makeGroup(db, `Scene ${i}`, 'Some Site'));
  enqueueMetadata(db, ids, 1_000);

  const client = fakeSceneClient(() => []);
  const result = await runMetadataPass(deps({ db, client, now: () => 1_000, perTick: 3 }));

  assert.equal(client.asked.length, 3);
  assert.equal(result.looked, 3);
});

test('a scene response backfills the site integer id', async () => {
  const db = openTestDatabase();
  recordDiscoveredSite(db, 'Naughty Office', { site: 'Naughty Office', sourceUuid: 'site-uuid' }, 'theporndb', 500);
  assert.equal(getDiscoveredSite(db, 'Naughty Office')?.sourceId, null);

  const groupId = makeGroup(db, 'A Scene', 'Naughty Office');
  enqueueMetadata(db, [groupId], 1_000);

  const scene = candidate({ title: 'A Scene', siteName: 'Naughty Office', siteId: 1 });
  const client = fakeSceneClient(() => [scene]);

  await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  assert.equal(getDiscoveredSite(db, 'Naughty Office')?.sourceId, 1);
});

test('a poster failure still writes the metadata row', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    const groupId = makeGroup(db, 'A Scene', 'Some Site');
    enqueueMetadata(db, [groupId], 1_000);

    const scene = candidate({
      title: 'A Scene',
      siteName: 'Some Site',
      posterUrl: 'https://example.test/missing.jpg',
    });
    const client = fakeSceneClient(() => [scene]);

    const result = await runMetadataPass(
      deps({ db, client, now: () => 1_000, artwork: { dir, fetchImpl: fetchNotFound, log: () => undefined } }),
    );

    assert.equal(result.confirmed, 1);
    const stored = getGroupMetadata(db, groupId);
    assert.equal(stored?.state, 'confirmed');
    assert.equal(stored?.posterPath, null, 'a poster failure must not fail the metadata answer');
  });
});

test('a group whose plugin offers no hooks is answered, not retried forever', async () => {
  const db = openTestDatabase();
  const bare: MediaTypePlugin = {
    id: 'bare',
    displayName: 'Bare',
    parse: () => null,
    score: () => 0,
    planImport: () => null,
  };
  const groupId = insertGroup(db, {
    plugin: 'bare',
    identityKey: 'bare:1',
    display: JSON.stringify({ title: 'Whatever', fields: [] }),
    searchText: 'whatever',
    createdAt: 0,
  });
  enqueueMetadata(db, [groupId], 1_000);

  const client = fakeSceneClient(() => {
    throw new Error('must never be called: this group has no metadataQuery hook');
  });

  const result = await runMetadataPass(
    deps({ db, client, now: () => 1_000, pluginFor: (pkg) => (pkg === 'bare' ? bare : null) }),
  );

  assert.equal(result.none, 1);
  assert.equal(client.asked.length, 0);
  assert.equal(dueMetadataQueue(db, 999_999, 10).length, 0, 'a hookless plugin must not retry forever');
});

test('a row whose answer write throws is deferred, not stuck first in the queue forever', async () => {
  const db = openTestDatabase();
  // Poisoned deliberately, from outside the code under test: a trigger that
  // aborts only the one insert this row will cause. This is what a broken
  // constraint or a full disk looks like from `recordMetadataAnswer`'s
  // point of view — an exception thrown mid-transaction, which its own
  // ROLLBACK already unwinds cleanly. The row's own attempts/next_at,
  // stored in a different table, are untouched by that rollback, which is
  // exactly the gap this test exists to close.
  const poisonedId = makeGroup(db, 'Poison', 'Some Site');
  const fineId = makeGroup(db, 'Fine', 'Some Site');
  db.exec(
    `CREATE TRIGGER poison_row BEFORE INSERT ON group_metadata
     FOR EACH ROW WHEN NEW.group_id = ${poisonedId}
     BEGIN SELECT RAISE(ABORT, 'poisoned row'); END;`,
  );
  enqueueMetadata(db, [poisonedId, fineId], 1_000);

  const client = fakeSceneClient((entry) => [candidate({ title: entry.query, siteName: 'Some Site' })]);
  const result = await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  // The row behind the poisoned one was still reached and answered in the
  // same pass.
  assert.equal(client.asked.length, 2, 'the poisoned row must not stop the pass from reaching the next one');
  assert.equal(result.confirmed, 1);
  assert.equal(result.deferred, 1);
  assert.equal(getGroupMetadata(db, poisonedId), undefined, 'the failed write must not be cached as an answer');
  assert.equal(getGroupMetadata(db, fineId)?.state, 'confirmed');

  const poisonedRow = db.prepare('SELECT attempts, next_at FROM metadata_queue WHERE group_id = ?').get(poisonedId);
  assert.equal(Number(poisonedRow?.['attempts']), 1, 'the attempt must be counted despite the rollback');
  assert.ok(
    Number(poisonedRow?.['next_at']) > 1_000,
    'next_at must move so the row is not due again immediately',
  );

  // A second pass at the same `now` must not see it again — proof it is no
  // longer first in line forever.
  const second = await runMetadataPass(deps({ db, client, now: () => 1_000 }));
  assert.equal(second.looked, 0, 'the poisoned row must not be due again at the same instant');
});

test('a runner holds a 429 cooldown across ticks: no request while it stands, resumes once it lapses', async () => {
  // `runMetadataPass` itself already proves a single pass stops early on a
  // 429 (see the test above). This is the wiring finding 1 found broken:
  // main.ts awaited that pass and threw the returned `cooldownUntil` away,
  // so only the one row that hit the 429 was deferred — every other due row
  // kept its `next_at`, and the very next tick spent another request
  // rediscovering the same rate limit. `createMetadataRunner` is the fix:
  // it holds the cooldown in its own closure, across calls, and the whole
  // point of this test is to drive it across more than one call.
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  enqueueMetadata(db, [groupId], 1_000);

  let now = 1_000;
  const client = fakeSceneClient(() => {
    throw new RateLimited(30_000);
  });

  const runner = createMetadataRunner(deps({ db, client, now: () => now }));

  await runner();
  assert.equal(client.asked.length, 1, 'the first tick makes the request that discovers the limit');

  now = 5_000; // well inside the cooldown (until 1_000 + 30_000 = 31_000)
  await runner();
  assert.equal(client.asked.length, 1, 'a tick inside the cooldown must issue no provider request at all');

  now = 20_000; // still inside it
  await runner();
  assert.equal(client.asked.length, 1, 'still no request while the cooldown stands');

  now = 31_000; // the moment it lapses
  await runner();
  assert.equal(client.asked.length, 2, 'a tick once the cooldown has passed must resume');
});

test('a runner logs a cooldown skip once, not on every tick it is skipped for', async () => {
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  enqueueMetadata(db, [groupId], 1_000);

  let now = 1_000;
  const client = fakeSceneClient(() => {
    throw new RateLimited(30_000);
  });
  const logs: string[] = [];

  const runner = createMetadataRunner(deps({ db, client, now: () => now, log: (message) => logs.push(message) }));

  await runner(); // hits the 429, sets the cooldown
  const afterFirstPass = logs.length;

  now = 5_000;
  await runner(); // skipped: cooldown standing
  now = 10_000;
  await runner(); // skipped again: still standing
  now = 15_000;
  await runner(); // skipped a third time

  assert.equal(
    logs.length,
    afterFirstPass + 1,
    'three skipped ticks in a row must add exactly one log line, not three',
  );
});

test('an attempts ceiling stops a permanently poisoned row from deferring forever', async () => {
  const db = openTestDatabase();
  const client = fakeSceneClient(() => {
    throw new Error('boom');
  });

  // One short of the ceiling: still deferred.
  const belowId = makeGroup(db, 'Below', 'Some Site');
  enqueueMetadata(db, [belowId], 1_000);
  db.prepare('UPDATE metadata_queue SET attempts = ? WHERE group_id = ?').run(MAX_METADATA_ATTEMPTS - 2, belowId);

  const belowResult = await runMetadataPass(deps({ db, client, now: () => 1_000 }));
  assert.equal(belowResult.deferred, 1);
  assert.equal(getGroupMetadata(db, belowId), undefined, 'still not answered');
  const belowRow = db.prepare('SELECT attempts FROM metadata_queue WHERE group_id = ?').get(belowId);
  assert.equal(Number(belowRow?.['attempts']), MAX_METADATA_ATTEMPTS - 1);

  // At the ceiling: answered and leaves, rather than deferred again.
  const atId = makeGroup(db, 'At', 'Some Site');
  enqueueMetadata(db, [atId], 1_000);
  db.prepare('UPDATE metadata_queue SET attempts = ? WHERE group_id = ?').run(MAX_METADATA_ATTEMPTS - 1, atId);

  const atResult = await runMetadataPass(deps({ db, client, now: () => 1_000 }));
  assert.equal(atResult.none, 1);
  assert.equal(getGroupMetadata(db, atId)?.state, 'none');
  assert.equal(
    dueMetadataQueue(db, 999_999, 10).find((row) => row.groupId === atId),
    undefined,
    'the exhausted row must leave the queue rather than defer again',
  );
});
