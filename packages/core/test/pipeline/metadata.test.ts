import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, MetadataCandidate, MetadataPerformer } from '@pickarr/plugin-api';
import createScenesPlugin from '@pickarr/plugin-scenes';
import { openTestDatabase } from '../../src/db/open.ts';
import { insertGroup } from '../../src/db/groups.ts';
import {
  dueMetadataQueue, enqueueMetadata, getGroupMetadata, recordMetadataAnswer, requeueMetadata,
} from '../../src/db/metadata.ts';
import { duePerformerQueue } from '../../src/db/performer-queue.ts';
import { performersForGroups } from '../../src/db/performers.ts';
import { getDiscoveredSite, recordDiscoveredSite } from '../../src/db/sites.ts';
import { RateLimited, type FetchImpl, type SceneLookupClient } from '../../src/clients/theporndb.ts';
import type { ArtworkDeps } from '../../src/media/artwork.ts';
import { MAX_BACKOFF_MS } from '../../src/pipeline/backoff.ts';
import {
  createMetadataRunner,
  MAX_METADATA_ATTEMPTS,
  runMetadataPass,
  type MetadataPassDeps,
} from '../../src/pipeline/metadata.ts';
import { performerQueryFor } from '../../src/pipeline/performers.ts';

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
    performers: [],
    durationSeconds: 1200,
    synopsis: 'A synopsis',
    posterUrl: null,
    slug: null,
    ...overrides,
  };
}

function performer(overrides: Partial<MetadataPerformer> = {}): MetadataPerformer {
  return {
    sourceUuid: 'performer-uuid',
    slug: 'a-performer',
    name: 'A Performer',
    kind: 'performer',
    faceUrl: null,
    imageUrl: null,
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

/** Serves `image/jpeg` for every request, recording the url each call asked for. */
function trackingFetchJpeg(fetched: string[]): FetchImpl {
  return (url) => {
    fetched.push(url);
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
  };
}

/**
 * Serves `image/jpeg` for every url except those named in `notFoundUrls`,
 * which 404 — and records every url asked for, successful or not.
 */
function trackingFetchExcept(fetched: string[], notFoundUrls: readonly string[]): FetchImpl {
  return (url) => {
    fetched.push(url);
    if (notFoundUrls.includes(url)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    );
  };
}

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

test('a group already holding a poster is not made to download it again', async () => {
  // The poster half of 'a performer already holding artwork is not
  // refetched'. Migration 7 queues every confirmed group in the library, and
  // `cacheImage` keys the poster on the group id, so without the cached-path
  // guard the backfill spends one full image download per group to overwrite
  // a byte-identical file — the whole library's worth, on first boot after
  // the upgrade, and no test would have noticed.
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    const groupId = makeGroup(db, 'A Scene', 'Some Site');
    enqueueMetadata(db, [groupId], 1_000);

    const scene = candidate({
      title: 'A Scene',
      siteName: 'Some Site',
      posterUrl: 'https://example.test/poster.jpg',
    });

    const firstPassFetches: string[] = [];
    await runMetadataPass(
      deps({
        db,
        client: fakeSceneClient(() => [scene]),
        now: () => 1_000,
        artwork: { dir, fetchImpl: trackingFetchJpeg(firstPassFetches), log: () => undefined },
      }),
    );
    assert.deepEqual(firstPassFetches, ['https://example.test/poster.jpg']);

    // Re-queued the way migration 7 does it — straight into the table, past
    // `enqueueMetadata`'s already-answered guard, which is exactly the path
    // that makes this cost real rather than hypothetical.
    db.prepare(
      `INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at) VALUES (?, ?, 0, ?)`,
    ).run(groupId, 2_000, 2_000);

    const secondPassFetches: string[] = [];
    const result = await runMetadataPass(
      deps({
        db,
        client: fakeSceneClient(() => [scene]),
        now: () => 2_000,
        artwork: { dir, fetchImpl: trackingFetchJpeg(secondPassFetches), log: () => undefined },
      }),
    );

    assert.equal(result.confirmed, 1);
    assert.deepEqual(secondPassFetches, [], 'the poster is already on disk under this group id');
    assert.equal(getGroupMetadata(db, groupId)?.posterPath, `${groupId}.jpg`);
  });
});

test('a confirmed answer caches each performer\'s face and image', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    const groupId = makeGroup(db, 'A Scene', 'Some Site');
    enqueueMetadata(db, [groupId], 1_000);

    const cast = performer({
      sourceUuid: 'performer-1',
      faceUrl: 'https://f/face.jpg',
      imageUrl: 'https://i/image.jpg',
    });
    const scene = candidate({ title: 'A Scene', siteName: 'Some Site', performers: [cast] });
    const client = fakeSceneClient(() => [scene]);

    const fetched: string[] = [];
    const result = await runMetadataPass(
      deps({ db, client, now: () => 1_000, artwork: { dir, fetchImpl: trackingFetchJpeg(fetched), log: () => undefined } }),
    );

    assert.equal(result.confirmed, 1);
    assert.deepEqual(fetched.toSorted(), ['https://f/face.jpg', 'https://i/image.jpg']);

    const found = performersForGroups(db, [groupId]).get(groupId)!;
    assert.equal(found.length, 1);
    const stored = found[0]!;
    assert.equal(stored.facePath, `performer-face-${stored.id}.jpg`);
    assert.equal(stored.imagePath, `performer-image-${stored.id}.jpg`);
  });
});

test('a performer already holding artwork is not refetched', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();

    const cast = performer({
      sourceUuid: 'shared-performer',
      faceUrl: 'https://f/face.jpg',
      imageUrl: 'https://i/image.jpg',
    });

    const groupOneId = makeGroup(db, 'Scene One', 'Some Site');
    enqueueMetadata(db, [groupOneId], 1_000);
    const sceneOne = candidate({ title: 'Scene One', siteName: 'Some Site', performers: [cast] });
    const clientOne = fakeSceneClient(() => [sceneOne]);

    const firstPassFetches: string[] = [];
    await runMetadataPass(
      deps({
        db,
        client: clientOne,
        now: () => 1_000,
        artwork: { dir, fetchImpl: trackingFetchJpeg(firstPassFetches), log: () => undefined },
      }),
    );
    assert.deepEqual(firstPassFetches.toSorted(), ['https://f/face.jpg', 'https://i/image.jpg']);

    const groupTwoId = makeGroup(db, 'Scene Two', 'Some Site');
    enqueueMetadata(db, [groupTwoId], 2_000);
    const sceneTwo = candidate({ title: 'Scene Two', siteName: 'Some Site', performers: [cast] });
    const clientTwo = fakeSceneClient(() => [sceneTwo]);

    const secondPassFetches: string[] = [];
    const result = await runMetadataPass(
      deps({
        db,
        client: clientTwo,
        now: () => 2_000,
        artwork: { dir, fetchImpl: trackingFetchJpeg(secondPassFetches), log: () => undefined },
      }),
    );

    assert.equal(result.confirmed, 1);
    assert.deepEqual(secondPassFetches, [], 'the shared performer already has artwork; nothing should be fetched');

    const groupTwoPerformers = performersForGroups(db, [groupTwoId]).get(groupTwoId)!;
    assert.equal(groupTwoPerformers.length, 1);
    assert.equal(groupTwoPerformers[0]!.facePath, `performer-face-${groupTwoPerformers[0]!.id}.jpg`);
  });
});

test('a performer with one kind cached and the other still missing is refetched only for the missing kind', async () => {
  // `performersNeedingArtwork`'s WHERE clause is an OR across the two
  // url/path pairs, so a performer with a cached face but no image yet is
  // still returned by it — the outer filter alone cannot tell the two kinds
  // apart. Only the inner per-kind `path !== null` check stops the already-
  // cached face from being fetched again once that row comes back through.
  // This is the state the "already holding artwork" test above never
  // reaches, because its performer is fully cached on both kinds after pass
  // one.
  await withTempDir(async (dir) => {
    const db = openTestDatabase();

    const faceUrl = 'https://f/face.jpg';
    const imageUrl = 'https://i/image.jpg';
    const cast = performer({ sourceUuid: 'half-cached-performer', faceUrl, imageUrl });

    const groupOneId = makeGroup(db, 'Scene One', 'Some Site');
    enqueueMetadata(db, [groupOneId], 1_000);
    const sceneOne = candidate({ title: 'Scene One', siteName: 'Some Site', performers: [cast] });
    const clientOne = fakeSceneClient(() => [sceneOne]);

    const firstPassFetches: string[] = [];
    // The image 404s on this pass; the face succeeds — leaving the performer
    // with a face_path but a still-null image_path.
    await runMetadataPass(
      deps({
        db,
        client: clientOne,
        now: () => 1_000,
        artwork: { dir, fetchImpl: trackingFetchExcept(firstPassFetches, [imageUrl]), log: () => undefined },
      }),
    );
    assert.deepEqual(firstPassFetches.toSorted(), [faceUrl, imageUrl]);
    const afterFirstPass = performersForGroups(db, [groupOneId]).get(groupOneId)![0]!;
    assert.equal(afterFirstPass.facePath, `performer-face-${afterFirstPass.id}.jpg`);
    assert.equal(afterFirstPass.imagePath, null, 'the image must still be missing going into pass two');

    const groupTwoId = makeGroup(db, 'Scene Two', 'Some Site');
    enqueueMetadata(db, [groupTwoId], 2_000);
    const sceneTwo = candidate({ title: 'Scene Two', siteName: 'Some Site', performers: [cast] });
    const clientTwo = fakeSceneClient(() => [sceneTwo]);

    const secondPassFetches: string[] = [];
    // Both urls succeed this time — if the cached face were wrongly
    // refetched, it would show up in `secondPassFetches` too.
    const result = await runMetadataPass(
      deps({
        db,
        client: clientTwo,
        now: () => 2_000,
        artwork: { dir, fetchImpl: trackingFetchExcept(secondPassFetches, []), log: () => undefined },
      }),
    );

    assert.equal(result.confirmed, 1);
    assert.deepEqual(
      secondPassFetches,
      [imageUrl],
      'only the still-missing image must be fetched; the already-cached face must not be',
    );

    const groupTwoPerformers = performersForGroups(db, [groupTwoId]).get(groupTwoId)!;
    assert.equal(groupTwoPerformers[0]!.facePath, `performer-face-${groupTwoPerformers[0]!.id}.jpg`);
    assert.equal(groupTwoPerformers[0]!.imagePath, `performer-image-${groupTwoPerformers[0]!.id}.jpg`);
  });
});

test('an artwork failure does not fail the answer', async () => {
  await withTempDir(async (dir) => {
    const db = openTestDatabase();
    const groupId = makeGroup(db, 'A Scene', 'Some Site');
    enqueueMetadata(db, [groupId], 1_000);

    const cast = performer({
      sourceUuid: 'performer-404',
      faceUrl: 'https://f/missing-face.jpg',
      imageUrl: 'https://i/missing-image.jpg',
    });
    const scene = candidate({ title: 'A Scene', siteName: 'Some Site', performers: [cast] });
    const client = fakeSceneClient(() => [scene]);

    const result = await runMetadataPass(
      deps({ db, client, now: () => 1_000, artwork: { dir, fetchImpl: fetchNotFound, log: () => undefined } }),
    );

    assert.equal(result.confirmed, 1);
    assert.equal(getGroupMetadata(db, groupId)?.state, 'confirmed');
    const found = performersForGroups(db, [groupId]).get(groupId)!;
    assert.equal(found[0]!.facePath, null);
    assert.equal(found[0]!.imagePath, null);
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
  //
  // A single queued row cannot tell the runner's cooldown apart from the
  // per-row `next_at` deferral `runMetadataPass` already applies to the row
  // that hit the 429: with only one row, both mechanisms produce the exact
  // same observed requests. Two rows can tell them apart. Row B is never
  // touched by the 429 — only row A's `next_at` is deferred — so row B stays
  // "due" for as long as the queue is concerned. If the runner's own
  // cooldown were broken (or absent), a tick during the cooldown window
  // would still call `runMetadataPass`, which would find row B due and ask
  // it. Only the runner-level cooldown can keep row B unasked through those
  // ticks.
  const db = openTestDatabase();
  const groupA = makeGroup(db, 'A Scene', 'Some Site');
  const groupB = makeGroup(db, 'B Scene', 'Some Site');
  enqueueMetadata(db, [groupA, groupB], 1_000);

  // Throws only on the very first request ever made, regardless of which
  // row it is for, so a later tick that reaches a row a second time does
  // not re-trigger the limit and mask whether row B was ever reached.
  let hasFailedOnce = false;
  const client = fakeSceneClient(() => {
    if (!hasFailedOnce) {
      hasFailedOnce = true;
      throw new RateLimited(30_000);
    }
    return [];
  });
  const askedTitles = () => client.asked.map((entry) => entry.query);

  let now = 1_000;
  const runner = createMetadataRunner(deps({ db, client, now: () => now }));

  await runner();
  assert.equal(client.asked.length, 1, 'the first tick makes the request that discovers the limit');
  assert.deepEqual(askedTitles(), ['A Scene'], 'row A hit the limit; row B was never reached this pass');

  now = 5_000; // well inside the cooldown (until 1_000 + 30_000 = 31_000)
  await runner();
  assert.equal(client.asked.length, 1, 'a tick inside the cooldown must issue no provider request at all');
  assert.ok(
    !askedTitles().includes('B Scene'),
    'row B is due (its own next_at was never deferred) but must still not be asked while the cooldown stands',
  );

  now = 20_000; // still inside it
  await runner();
  assert.equal(client.asked.length, 1, 'still no request while the cooldown stands');
  assert.ok(!askedTitles().includes('B Scene'), 'row B still must not be asked');

  now = 31_000; // the moment it lapses
  await runner();
  assert.ok(client.asked.length > 1, 'a tick once the cooldown has passed must resume making requests');
  assert.ok(
    askedTitles().includes('B Scene'),
    'row B — the due row the cooldown was holding back — must be asked once the cooldown lapses',
  );
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

test('a confirmed scene that supplied a cast queues no performer search', async () => {
  // The confirmation already answered the question this queue exists to ask.
  // Nothing here checks that explicitly — `insertPerformerSearch` refuses a
  // group with a cast — which is exactly why including `confirmed` at the call
  // site is safe rather than a second rule to keep in step.
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  enqueueMetadata(db, [groupId], 1_000);

  const scene = candidate({ title: 'A Scene', siteName: 'Some Site', performers: [performer()] });
  const client = fakeSceneClient(() => [scene]);

  // Proves the group was eligible for a performer search before the pass
  // ever runs, so the empty `duePerformerQueue` below means the cast refused
  // it — not that this arrangement was never going to queue anything, which
  // is what the next test (identical arrangement, no cast) demonstrates.
  assert.equal(performerQueryFor({ db, pluginFor: defaultPluginFor, log: () => undefined }, groupId), 'A Scene');

  await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  assert.equal(getGroupMetadata(db, groupId)?.state, 'confirmed');
  assert.ok((performersForGroups(db, [groupId]).get(groupId) ?? []).length > 0);
  assert.deepEqual(duePerformerQueue(db, 1_000, 10), []);
});

test('a confirmed scene that named nobody queues a performer search', async () => {
  // Same confirmation, `performers: []`. The group ends up picked, answered and
  // castless — which is precisely the gap this feature fills, and the case a
  // rule keyed only on `state = 'none'` would miss.
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  enqueueMetadata(db, [groupId], 1_000);

  const scene = candidate({ title: 'A Scene', siteName: 'Some Site', performers: [] });
  const client = fakeSceneClient(() => [scene]);

  await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  assert.equal(getGroupMetadata(db, groupId)?.state, 'confirmed');
  assert.deepEqual(duePerformerQueue(db, 1_000, 10).map((row) => row.groupId), [groupId]);
});

test('a settled-as-none lookup queues a performer search', async () => {
  // A search that ran and confirmed nothing. `answerUnaskable` / a 'none' answer
  // settles the row, and the group has no cast.
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  enqueueMetadata(db, [groupId], 1_000);

  const client = fakeSceneClient(() => []);

  await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  assert.equal(getGroupMetadata(db, groupId)?.state, 'none');
  assert.deepEqual(duePerformerQueue(db, 1_000, 10).map((row) => row.groupId), [groupId]);
});

test('a deferred row queues nothing, because it has not settled', async () => {
  // A client that throws an ordinary error, so `deferOrGiveUp` defers rather
  // than answering. The row will be asked again: a group whose scene lookup is
  // still in flight has not yet *failed* to produce a cast, and queueing here
  // would spend a performer request on a question that is still open.
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  enqueueMetadata(db, [groupId], 1_000);

  const client = fakeSceneClient(() => {
    throw new Error('ECONNREFUSED');
  });

  const result = await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  assert.equal(result.deferred, 1);
  assert.deepEqual(duePerformerQueue(db, 1_000, 10), []);
});

test('a group requeried after settling none with no cast ends up with a performer_queue row', async () => {
  // The end-to-end proof the requery button exists for: a group settled
  // outside this pass entirely (directly, via `recordMetadataAnswer`, the way
  // a group answered before this feature shipped would have settled) has no
  // `metadata_queue` row and, because `insertPerformerSearch` was never
  // reached for it, no `performer_queue` row either. `requeueMetadata` is
  // Task 1's half of this feature; running the resulting row through
  // `runMetadataPass` here proves the two halves actually connect.
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  recordMetadataAnswer(db, { groupId, source: 'theporndb', confirmed: null, nearMisses: [], now: 500 });
  assert.deepEqual(duePerformerQueue(db, 500, 10), [], 'no performer search was ever queued for this group');

  assert.equal(requeueMetadata(db, [groupId], 1_000), 1);

  const client = fakeSceneClient(() => []);
  const result = await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  assert.equal(result.none, 1);
  assert.equal(getGroupMetadata(db, groupId)?.state, 'none');
  assert.deepEqual(duePerformerQueue(db, 1_000, 10).map((row) => row.groupId), [groupId]);
});

test('a requery re-answered with the same cast keeps it linked and gains no performer_queue row', async () => {
  // Scoped deliberately at "the same cast came back", which is what this
  // stubbed client actually returns — it does *not* prove the broader
  // "a requery never unlinks a cast" claim, because the shared settle path
  // replaces the cast wholesale whenever the answer is written. The test
  // below covers that case honestly rather than this one pretending to.
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  recordMetadataAnswer(db, {
    groupId,
    source: 'theporndb',
    confirmed: candidate({ title: 'A Scene', siteName: 'Some Site', performers: [performer()] }),
    nearMisses: [],
    now: 500,
  });
  assert.ok(
    (performersForGroups(db, [groupId]).get(groupId) ?? []).length > 0,
    'the first answer must have linked a cast',
  );

  assert.equal(requeueMetadata(db, [groupId], 1_000), 1);

  const scene = candidate({ title: 'A Scene', siteName: 'Some Site', performers: [performer()] });
  const client = fakeSceneClient(() => [scene]);
  const result = await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  assert.equal(result.confirmed, 1);
  assert.equal(getGroupMetadata(db, groupId)?.state, 'confirmed');
  // `groupHasCast` still refuses it — the cast from the fresh answer, not a
  // stale one left over from before the requery.
  assert.deepEqual(duePerformerQueue(db, 1_000, 10), []);
  assert.ok(
    (performersForGroups(db, [groupId]).get(groupId) ?? []).length > 0,
    'the cast must still be linked after the requery',
  );
});

test('a requery re-confirmed with an empty cast replaces the cast, through the pre-existing settle path', async () => {
  // The honest counterpart to the test above, and the limit of this branch's
  // "a requery never unlinks a cast" claim: `requeueMetadata` itself never
  // touches `group_performers`, but the answer it leads to goes through
  // `recordMetadataAnswer`, whose cast write is a wholesale replacement
  // whenever the upsert is written (`written.changes > 0`) — and
  // `setGroupPerformers` with an empty list is a DELETE.
  //
  // Asserted rather than guarded: adding a guard would change how the
  // ordinary metadata pass treats *every* group, which is out of this
  // branch's scope. What this test pins is that the behaviour is known and
  // deliberate rather than an accident nobody had looked at, and that a
  // future guard would have exactly one test to update.
  const db = openTestDatabase();
  const groupId = makeGroup(db, 'A Scene', 'Some Site');
  recordMetadataAnswer(db, {
    groupId,
    source: 'theporndb',
    confirmed: candidate({ title: 'A Scene', siteName: 'Some Site', performers: [performer()] }),
    nearMisses: [],
    now: 500,
  });
  assert.equal((performersForGroups(db, [groupId]).get(groupId) ?? []).length, 1);

  assert.equal(requeueMetadata(db, [groupId], 1_000), 1);

  // Same scene, re-confirmed, but the provider has since dropped its cast —
  // a real shape for a scene whose performer records were removed upstream.
  const scene = candidate({ title: 'A Scene', siteName: 'Some Site', performers: [] });
  const client = fakeSceneClient(() => [scene]);
  const result = await runMetadataPass(deps({ db, client, now: () => 1_000 }));

  assert.equal(result.confirmed, 1);
  assert.deepEqual(
    performersForGroups(db, [groupId]).get(groupId) ?? [],
    [],
    'the empty cast in the fresh answer replaced the old one',
  );
  // And the now-castless group falls to the performer search queue, because
  // `groupHasCast` is false by the time `enqueuePerformerSearch` looks —
  // the settle path's enqueue runs after the answer is written.
  assert.deepEqual(duePerformerQueue(db, 1_000, 10).map((row) => row.groupId), [groupId]);
});
