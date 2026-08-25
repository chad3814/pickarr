import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, MetadataCandidate } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { insertGroup } from '../../src/db/groups.ts';
import {
  dueMetadataQueue,
  enqueueMetadata,
  getGroupMetadata,
  recordMetadataAnswer,
  setBackgroundPath,
  setPosterPath,
  type GroupMetadata,
} from '../../src/db/metadata.ts';
import {
  performersForGroups,
  setGroupPerformers,
  setPerformerArtwork,
  upsertPerformers,
  type PerformerRow,
} from '../../src/db/performers.ts';
import { buildServer, type ServerDeps } from '../../src/http/server.ts';
import { metadataViewOf, type MetadataRequestResponse } from '../../src/http/views.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';
import type { DownloadClient } from '../../src/clients/types.ts';

const NOW = 1000;

function fakeClient(): DownloadClient {
  return {
    id: 'sab',
    importMode: 'move',
    category: 'pickarr',
    addUrl: async () => 'nzo_1',
    snapshot: async () => ({ queue: [], history: [], complete: true }),
    remove: async () => {},
    mapPath: (path) => path,
  };
}

/** A plugin that can build a real query: a title and a site, non-empty queries. */
const ASKABLE: MediaTypePlugin = {
  id: 'askable',
  displayName: 'Askable',
  parse: () => null,
  score: () => 0,
  planImport: () => null,
  metadataQuery: (identity) => ({ queries: [identity.display.title], siteName: 'Some Site' }),
  confirmMetadata: () => ({ confirmed: null, nearMisses: [] }),
};

/** A plugin registered, but missing both metadata hooks entirely. */
const NO_HOOKS: MediaTypePlugin = {
  id: 'no-hooks',
  displayName: 'No Hooks',
  parse: () => null,
  score: () => 0,
  planImport: () => null,
};

/** A plugin whose hooks exist, but which declines to build a query at all. */
const NULL_QUERY: MediaTypePlugin = {
  id: 'null-query',
  displayName: 'Null Query',
  parse: () => null,
  score: () => 0,
  planImport: () => null,
  metadataQuery: () => null,
  confirmMetadata: () => ({ confirmed: null, nearMisses: [] }),
};

function registryWith(plugins: readonly MediaTypePlugin[]): PluginRegistry {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin] as const));
  return {
    byPackage: (packageName) => {
      throw new Error(`No plugin registered for package ${packageName}`);
    },
    byId: (id) => byId.get(id),
    libraryRoot: () => '/library',
    libraryRootById: () => '/library',
    all: () => [...plugins],
  };
}

function deps(
  db: DatabaseSync,
  // `now` is overridable because the stale-answer tests below need a clock far
  // enough past `NOW` to cross a 36-hour window, which `NOW = 1000` cannot
  // express by moving `fetched_at` backwards instead.
  overrides: Partial<Pick<ServerDeps, 'registry' | 'artworkDir' | 'metadataAvailable' | 'now'>> = {},
): ServerDeps {
  return {
    db,
    clientForFeed: () => fakeClient(),
    untrackedAll: () => [],
    now: overrides.now ?? (() => NOW),
    webRoot: null,
    registry: overrides.registry ?? registryWith([ASKABLE, NO_HOOKS, NULL_QUERY]),
    pluginForFeed: () => null,
    artworkDir: overrides.artworkDir ?? '/tmp/pickarr-metadata-test-unused-artwork',
    metadataAvailable: overrides.metadataAvailable ?? true,
    configPath: '/tmp/pickarr-metadata-test-unused-config.json',
    bootConfigDocument: null,
    databasePath: '/tmp/pickarr-metadata-test-unused.db',
    requestRestart: () => {},
    trashDir: '/trash',
  };
}

function group(
  db: DatabaseSync,
  plugin: string,
  title: string,
): number {
  return insertGroup(db, {
    plugin,
    identityKey: title.toLowerCase(),
    display: JSON.stringify({ title, fields: [] }),
    searchText: title.toLowerCase(),
    createdAt: NOW,
  });
}

function candidate(overrides: Partial<MetadataCandidate> = {}): MetadataCandidate {
  return {
    sourceUuid: 'scene-uuid',
    title: 'A Scene',
    siteUuid: 'site-uuid',
    siteId: 1,
    siteName: 'Some Site',
    date: '2024-01-01',
    performers: [],
    durationSeconds: 1200,
    synopsis: 'A synopsis',
    posterUrl: 'https://example.invalid/poster.jpg',
    slug: null,
    ...overrides,
  };
}

/** A confirmed `GroupMetadata`, for exercising `metadataViewOf` directly. */
function confirmedMetadata(overrides: Partial<GroupMetadata> = {}): GroupMetadata {
  return {
    groupId: 1,
    state: 'confirmed',
    source: 'theporndb',
    sourceUuid: 'scene-uuid',
    title: 'A Scene',
    performers: [],
    releaseDate: '2024-01-01',
    durationSeconds: 1200,
    synopsis: 'A synopsis',
    posterUrl: null,
    posterPath: null,
    backgroundUrl: null,
    backgroundPath: null,
    sceneSlug: null,
    fetchedAt: NOW,
    ...overrides,
  };
}

/** A `PerformerRow`, for exercising `metadataViewOf` directly. */
function row(overrides: Partial<PerformerRow> = {}): PerformerRow {
  return {
    id: 1,
    sourceUuid: 'performer-uuid',
    slug: 'alice-maze',
    name: 'Alice Maze',
    kind: 'performer',
    faceUrl: null,
    facePath: null,
    imageUrl: null,
    imagePath: null,
    ...overrides,
  };
}

test('a performer links to /performers/ and a site performer to /performer-sites/', () => {
  const view = metadataViewOf(confirmedMetadata(), [
    row({ id: 1, slug: 'alice-maze', kind: 'performer' }),
    row({ id: 2, slug: '6061-alice-maze', kind: 'performer-site' }),
  ]);
  assert.ok(view.state === 'confirmed');
  // Literal URLs. An expectation built by calling the same helper the view
  // calls would pass against any consistent-but-wrong mapping.
  assert.deepEqual(view.performers.map((p) => p.url), [
    'https://theporndb.net/performers/alice-maze',
    'https://theporndb.net/performer-sites/6061-alice-maze',
  ]);
});

test('a scene slug becomes a scene url, and its absence a null', () => {
  const withScene = metadataViewOf(confirmedMetadata({ sceneSlug: 'my-scene' }), []);
  assert.ok(withScene.state === 'confirmed');
  assert.equal(withScene.sceneUrl, 'https://theporndb.net/scenes/my-scene');

  const withoutScene = metadataViewOf(confirmedMetadata({ sceneSlug: null }), []);
  assert.ok(withoutScene.state === 'confirmed');
  assert.equal(withoutScene.sceneUrl, null);
});

test('the view reports each image independently', () => {
  // `hasPoster` and `hasBackground` derive from separate columns, so a
  // group can carry one, the other, both, or neither without the two
  // fields ever moving together.
  const view = metadataViewOf(confirmedMetadata({ posterPath: null, backgroundPath: 'group-background-1.jpg' }), []);
  assert.ok(view.state === 'confirmed');
  assert.equal(view.hasPoster, false);
  assert.equal(view.hasBackground, true);
});

test('a group with no performer rows falls back to the stored names', () => {
  // Groups answered before migration 7 keep their cast as plain names until
  // their refetch lands, rather than losing it.
  const view = metadataViewOf(confirmedMetadata({ performers: ['Alice Maze'] }), []);
  assert.ok(view.state === 'confirmed');
  assert.deepEqual(view.performerNames, ['Alice Maze']);
  assert.deepEqual(view.performers, []);
});

test('a group with performer rows reports no fallback names', () => {
  // Both populated would leave the card to choose, and two lists that can
  // disagree is exactly what the separate field exists to avoid.
  const view = metadataViewOf(confirmedMetadata({ performers: ['Alice Maze'] }), [row({ id: 1 })]);
  assert.ok(view.state === 'confirmed');
  assert.deepEqual(view.performerNames, []);
  assert.equal(view.performers.length, 1);
});

test('a performer reports which of its two images are cached', () => {
  // Both directions, both fields. `hasAvatar` is what decides whether the
  // card draws an avatar at all, so a derivation stuck at false removes the
  // feature everywhere while every other assertion in this file still holds:
  // the fixtures elsewhere leave both paths null, which is the value a broken
  // derivation returns anyway.
  const view = metadataViewOf(confirmedMetadata(), [
    row({ id: 1, facePath: 'performer-face-1.jpg', imagePath: 'performer-image-1.jpg' }),
    row({ id: 2, facePath: 'performer-face-2.jpg', imagePath: null }),
    row({ id: 3, facePath: null, imagePath: 'performer-image-3.jpg' }),
    row({ id: 4, facePath: null, imagePath: null }),
  ]);
  assert.ok(view.state === 'confirmed');
  assert.deepEqual(
    view.performers.map((performer) => [performer.hasAvatar, performer.hasImage]),
    [[true, true], [true, false], [false, true], [false, false]],
  );
});

test('requesting metadata queues only the unanswered', async () => {
  const db = openTestDatabase();
  const g1 = group(db, 'askable', 'Alpha');
  const g2 = group(db, 'askable', 'Beta');
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/request',
    payload: { groupIds: [g1, g2] },
  });

  assert.equal(response.statusCode, 200);
  // `refreshed` is empty because nothing here had a previous answer; only an id
  // whose settled answer is being replaced needs the SPA to watch it again.
  assert.deepEqual(response.json(), {
    queued: 2, alreadyAnswered: 0, pending: 0, missing: 0, unavailable: 0, refreshed: [],
  });
  assert.equal(dueMetadataQueue(db, NOW, 10).length, 2);

  await server.close();
  db.close();
});

test('metadata unavailable server-wide: the request endpoint does not queue', async () => {
  // Finding 6: with the worker disabled, or enabled with no client, browsing
  // still inserted a `metadata_queue` row per group with nothing to ever
  // drain it, and the SPA polled those rows at its 8s floor for as long as
  // Browse stayed mounted. `metadataAvailable: false` is main.ts's own
  // "would a timer even be registered" decision, passed in rather than
  // re-derived here.
  const db = openTestDatabase();
  const askable = group(db, 'askable', 'Alpha');
  const server = buildServer(deps(db, { metadataAvailable: false }));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/request',
    payload: { groupIds: [askable] },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    dueMetadataQueue(db, NOW, 10).length,
    0,
    'nothing may be queued when there is no worker to ever drain it',
  );
  assert.equal(
    getGroupMetadata(db, askable),
    undefined,
    'unavailability is not a permanent answer either — it must not be cached as one',
  );

  await server.close();
  db.close();
});

test('metadata available: the request endpoint queues normally', async () => {
  const db = openTestDatabase();
  const askable = group(db, 'askable', 'Alpha');
  const server = buildServer(deps(db, { metadataAvailable: true }));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/request',
    payload: { groupIds: [askable] },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(dueMetadataQueue(db, NOW, 10).length, 1);

  await server.close();
  db.close();
});

test('a request for a group whose plugin cannot look up is answered, not queued', async () => {
  const db = openTestDatabase();
  const noHooks = group(db, 'no-hooks', 'Alpha');
  const nullQuery = group(db, 'null-query', 'Beta');
  const noPlugin = group(db, 'missing-plugin', 'Gamma');
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/request',
    payload: { groupIds: [noHooks, nullQuery, noPlugin] },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    queued: 0, alreadyAnswered: 3, pending: 0, missing: 0, unavailable: 0, refreshed: [],
  });

  // Settled as an answer, not left in the queue for the worker to discard.
  assert.equal(dueMetadataQueue(db, NOW, 10).length, 0);
  for (const id of [noHooks, nullQuery, noPlugin]) {
    const metadata = getGroupMetadata(db, id);
    assert.ok(metadata !== undefined, `group ${id} should have been answered`);
    assert.equal(metadata.state, 'none');
  }

  // Idempotent: asking again does not double-answer or queue anything.
  const again = await server.inject({
    method: 'POST',
    url: '/api/metadata/request',
    payload: { groupIds: [noHooks, nullQuery, noPlugin] },
  });
  assert.deepEqual(again.json(), {
    queued: 0, alreadyAnswered: 3, pending: 0, missing: 0, unavailable: 0, refreshed: [],
  });
  assert.equal(dueMetadataQueue(db, NOW, 10).length, 0);

  await server.close();
  db.close();
});

test('an oversized id list is refused', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/request',
    payload: { groupIds: Array.from({ length: 500 }, (_, i) => i + 1) },
  });

  assert.equal(response.statusCode, 400);

  await server.close();
  db.close();
});

test('a request naming a group that no longer exists reports it as missing, not silently dropped', async () => {
  const db = openTestDatabase();
  const askable = group(db, 'askable', 'Alpha');
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/request',
    // 999999 was never inserted, so getGroup answers null for it.
    payload: { groupIds: [askable, 999_999] },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    queued: number;
    alreadyAnswered: number;
    pending: number;
    missing: number;
    unavailable: number;
    refreshed: number[];
  };
  assert.deepEqual(body, {
    queued: 1, alreadyAnswered: 0, pending: 0, missing: 1, unavailable: 0, refreshed: [],
  });
  // The five counters are meant to be an honest partition of the request: a
  // caller can detect a bug in this arithmetic without knowing anything else
  // about what was sent.
  assert.equal(
    body.queued + body.alreadyAnswered + body.pending + body.missing + body.unavailable,
    2,
  );

  await server.close();
  db.close();
});

test('a settled group is requeried and its group_metadata row is untouched', async () => {
  const db = openTestDatabase();
  const askable = group(db, 'askable', 'Alpha');
  recordMetadataAnswer(db, {
    groupId: askable, source: 'theporndb', confirmed: candidate(), nearMisses: [], now: NOW,
  });
  const before = getGroupMetadata(db, askable);
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/requery',
    payload: { groupIds: [askable] },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { requeued: 1, missing: 0, unavailable: 0, unaskable: 0 });
  assert.equal(dueMetadataQueue(db, NOW, 10).length, 1);
  assert.deepEqual(getGroupMetadata(db, askable), before, 'a requery must never touch group_metadata');

  await server.close();
  db.close();
});

test('missing, unaskable and requeued ids are each counted, and the counters sum to the ids sent', async () => {
  const db = openTestDatabase();
  const askable = group(db, 'askable', 'Alpha');
  const noHooks = group(db, 'no-hooks', 'Beta');
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/requery',
    // 999999 was never inserted, so getGroup answers null for it. Unlike
    // `/api/metadata/request`'s equivalent test, `unavailable` cannot join
    // this mix in the same request: it is a server-wide flag
    // (`ServerDeps.metadataAvailable`), not a per-id fact, so with it true
    // every existing id here is either unaskable or requeued — never
    // unavailable — the same limitation `/api/metadata/request` already has.
    payload: { groupIds: [askable, noHooks, 999_999] },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    requeued: number;
    missing: number;
    unavailable: number;
    unaskable: number;
  };
  assert.deepEqual(body, { requeued: 1, missing: 1, unavailable: 0, unaskable: 1 });
  assert.equal(
    body.requeued + body.missing + body.unavailable + body.unaskable,
    3,
  );
  assert.equal(dueMetadataQueue(db, NOW, 10).length, 1);
  // Unlike `/api/metadata/request`, an unaskable id here is never answered:
  // the group is already settled (or, as here, may never even have been
  // asked), and there is nothing to answer.
  assert.equal(getGroupMetadata(db, noHooks), undefined, 'a requery must not answer an unaskable group');

  await server.close();
  db.close();
});

test('metadata unavailable server-wide: the requery endpoint does not requeue', async () => {
  const db = openTestDatabase();
  const askable = group(db, 'askable', 'Alpha');
  recordMetadataAnswer(db, {
    groupId: askable, source: 'theporndb', confirmed: candidate(), nearMisses: [], now: NOW,
  });
  const server = buildServer(deps(db, { metadataAvailable: false }));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/requery',
    payload: { groupIds: [askable] },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { requeued: 0, missing: 0, unavailable: 1, unaskable: 0 });
  assert.equal(dueMetadataQueue(db, NOW, 10).length, 0);
  assert.equal(
    getGroupMetadata(db, askable)?.state,
    'confirmed',
    'unavailability must not disturb the standing answer',
  );

  await server.close();
  db.close();
});

test('a duplicate id in a requery is requeued once, not double-counted', async () => {
  // `requeueMetadata` has no dedup of its own and reports `groupIds.length`
  // back directly — passing it a repeated id would inflate `requeued` past
  // the number of rows actually touched. The route dedups before that call.
  const db = openTestDatabase();
  const askable = group(db, 'askable', 'Alpha');
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/requery',
    payload: { groupIds: [askable, askable] },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { requeued: 1, missing: 0, unavailable: 0, unaskable: 0 });
  assert.equal(dueMetadataQueue(db, NOW, 10).length, 1);

  await server.close();
  db.close();
});

test('an oversized id list is refused for requery too', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/requery',
    payload: { groupIds: Array.from({ length: 500 }, (_, i) => i + 1) },
  });

  assert.equal(response.statusCode, 400);

  await server.close();
  db.close();
});

test('a malformed requery body is refused', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/requery',
    payload: { groupIds: ['not-a-number'] },
  });

  assert.equal(response.statusCode, 400);

  await server.close();
  db.close();
});

test('metadata reads report pending, none and confirmed distinctly', async () => {
  const db = openTestDatabase();
  const confirmed = group(db, 'askable', 'Confirmed');
  const none = group(db, 'askable', 'None');
  const pending = group(db, 'askable', 'Pending');
  const absent = group(db, 'askable', 'Absent');

  recordMetadataAnswer(db, {
    groupId: confirmed,
    source: 'theporndb',
    confirmed: candidate(),
    nearMisses: [],
    now: NOW,
  });
  recordMetadataAnswer(db, {
    groupId: none,
    source: 'theporndb',
    confirmed: null,
    nearMisses: [],
    now: NOW,
  });
  enqueueMetadata(db, [pending], NOW);

  const server = buildServer(deps(db));
  const response = await server.inject({
    method: 'GET',
    url: `/api/metadata?ids=${confirmed},${none},${pending},${absent}`,
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as Record<string, unknown>;
  assert.deepEqual(body[String(confirmed)], {
    state: 'confirmed',
    title: 'A Scene',
    performers: [],
    performerNames: [],
    releaseDate: '2024-01-01',
    durationSeconds: 1200,
    synopsis: 'A synopsis',
    hasPoster: false,
    hasBackground: false,
    sceneUrl: null,
  });
  // The cast rides beside every state now (see `CastView`), so a castless
  // group reads two empty lists rather than the bare state it used to.
  assert.deepEqual(body[String(none)], { state: 'none', performers: [], performerNames: [] });
  // enqueueMetadata (via the `pending` group() call above) inserted the queue
  // row with next_at = NOW, so the response must carry that value back
  // rather than merely saying "pending".
  assert.deepEqual(body[String(pending)], {
    state: 'pending',
    nextAttemptAt: NOW,
    performers: [],
    performerNames: [],
  });
  assert.deepEqual(body[String(absent)], { state: 'absent', performers: [], performerNames: [] });

  await server.close();
  db.close();
});

test('GET /api/metadata reads the queue for a whole page in one query, not one per id', async () => {
  const db = openTestDatabase();
  const g1 = group(db, 'askable', 'Alpha');
  const g2 = group(db, 'askable', 'Beta');
  const g3 = group(db, 'askable', 'Gamma');
  enqueueMetadata(db, [g1, g2, g3], NOW);

  const server = buildServer(deps(db));

  // Same instrumentation approach as the browse test below: wrap the
  // prepared statement's own `.all`, not `db.prepare`, so a regression that
  // prepares once and then calls `.get()` per id in a loop is still caught.
  const originalPrepare = db.prepare.bind(db);
  let metadataQueueExecutions = 0;
  db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes('metadata_queue')) return statement;
    const originalAll = statement.all.bind(statement);
    statement.all = ((...args: Parameters<typeof statement.all>) => {
      metadataQueueExecutions += 1;
      return originalAll(...args);
    }) as typeof statement.all;
    return statement;
  }) as typeof db.prepare;

  const response = await server.inject({ method: 'GET', url: `/api/metadata?ids=${g1},${g2},${g3}` });

  assert.equal(response.statusCode, 200);
  assert.equal(
    metadataQueueExecutions,
    1,
    'GET /api/metadata must read metadata_queue in one query execution for the whole page',
  );
  const body = response.json() as Record<string, { state: string; nextAttemptAt?: number }>;
  for (const id of [g1, g2, g3]) {
    assert.deepEqual(body[String(id)], {
      state: 'pending',
      nextAttemptAt: NOW,
      performers: [],
      performerNames: [],
    });
  }

  await server.close();
  db.close();
});

test('an id list at the page cap succeeds; one over is refused, not a 500', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  // MAX_PAGE_LIMIT is 100 (the same ceiling browse and the request cap use);
  // none of these ids need to exist for `parseIds` to accept or reject them —
  // that check runs before any query touches the database.
  const atCap = Array.from({ length: 100 }, (_, i) => i + 1).join(',');
  const overCap = Array.from({ length: 101 }, (_, i) => i + 1).join(',');

  const ok = await server.inject({ method: 'GET', url: `/api/metadata?ids=${atCap}` });
  assert.equal(ok.statusCode, 200);

  const refused = await server.inject({ method: 'GET', url: `/api/metadata?ids=${overCap}` });
  assert.equal(refused.statusCode, 400, 'one id over the cap must be a 400, not a 500 from SQLite');

  await server.close();
  db.close();
});

test('malformed ids are refused rather than coerced to a different id', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  // Each of these is something `Number()` (and so bare `z.coerce.number()`)
  // would happily parse into *some* number, which is exactly the problem:
  // "0x10" silently becoming 16, or a number past MAX_SAFE_INTEGER silently
  // colliding with a different one, would answer a question the caller never
  // asked instead of refusing it. `+1` is deliberately not tested here: a
  // literal `+` in a query string is already decoded to a space before this
  // handler ever sees it (that's `application/x-www-form-urlencoded`, not
  // this code's doing), and `" 1"` trimming down to a valid `"1"` is correct
  // — the poster route's own id param does not get that treatment, which is
  // exactly why `+1` is tested there instead, below.
  for (const malformed of ['0x10', '1e3', '1.5', '9007199254740993']) {
    const response = await server.inject({ method: 'GET', url: `/api/metadata?ids=${malformed}` });
    assert.equal(response.statusCode, 400, `"${malformed}" must be refused`);
  }

  await server.close();
  db.close();
});

test('the poster route refuses a coerced id, not just a traversal attempt', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  for (const malformed of ['+1', '%201', '1.5', '0x1']) {
    const response = await server.inject({ method: 'GET', url: `/api/groups/${malformed}/poster` });
    assert.equal(response.statusCode, 400, `"${malformed}" must be refused, not coerced to a group id`);
  }

  await server.close();
  db.close();
});

test('browse carries metadata and reads it in one query', async () => {
  const db = openTestDatabase();
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'Alpha.1080p', 'https://indexer.invalid/1.nzb', 1),
            (2, 'f', 'g2', 'Beta.1080p',  'https://indexer.invalid/2.nzb', 1),
            (3, 'f', 'g3', 'Gamma.1080p', 'https://indexer.invalid/3.nzb', 1)`,
  ).run();
  const g1 = group(db, 'askable', 'Alpha');
  const g2 = group(db, 'askable', 'Beta');
  const g3 = group(db, 'askable', 'Gamma');
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, ?, 1, '{}', 1, 1), (2, ?, 2, '{}', 1, 1), (3, ?, 3, '{}', 1, 1)`,
  ).run(g1, g2, g3);

  recordMetadataAnswer(db, {
    groupId: g1,
    source: 'theporndb',
    confirmed: candidate({ title: 'Alpha Scene' }),
    nearMisses: [],
    now: NOW,
  });
  recordMetadataAnswer(db, { groupId: g2, source: 'theporndb', confirmed: null, nearMisses: [], now: NOW });
  // g3 gets no answer at all.

  const server = buildServer(deps(db));

  // Count *executions* against group_metadata, not merely calls to
  // `db.prepare` — a regression that prepares one statement and then calls
  // `.get()` on it once per group in a loop would still show one `prepare`
  // call and slip past a counter that only wraps that method. Wrapping the
  // statement's own `.all`/`.get` catches that shape of regression too.
  const originalPrepare = db.prepare.bind(db);
  let groupMetadataExecutions = 0;
  db.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    if (!sql.includes('group_metadata')) return statement;
    const originalAll = statement.all.bind(statement);
    const originalGet = statement.get.bind(statement);
    statement.all = ((...args: Parameters<typeof statement.all>) => {
      groupMetadataExecutions += 1;
      return originalAll(...args);
    }) as typeof statement.all;
    statement.get = ((...args: Parameters<typeof statement.get>) => {
      groupMetadataExecutions += 1;
      return originalGet(...args);
    }) as typeof statement.get;
    return statement;
  }) as typeof db.prepare;

  const response = await server.inject({ method: 'GET', url: '/api/browse?limit=10' });

  assert.equal(response.statusCode, 200);
  assert.equal(
    groupMetadataExecutions,
    1,
    'browse must read group_metadata in one query execution for the whole page',
  );

  const body = response.json() as { groups: { id: number; metadata: unknown }[] };
  const byId = new Map(body.groups.map((g) => [g.id, g.metadata]));
  assert.deepEqual(byId.get(g1), {
    state: 'confirmed',
    title: 'Alpha Scene',
    performers: [],
    performerNames: [],
    releaseDate: '2024-01-01',
    durationSeconds: 1200,
    synopsis: 'A synopsis',
    hasPoster: false,
    hasBackground: false,
    sceneUrl: null,
  });
  assert.deepEqual(byId.get(g2), { state: 'none', performers: [], performerNames: [] });
  assert.deepEqual(byId.get(g3), { state: 'absent', performers: [], performerNames: [] });

  await server.close();
  db.close();
});

test('browse gives each group its own cast, never the other one\'s', async () => {
  // `performers.get(group.id) ?? []` on the same line as the already-tested
  // `metadata.get(group.id)` — this is the case that would notice the two
  // groups' maps getting crossed, which an empty-cast fixture never can.
  const db = openTestDatabase();
  const g1 = group(db, 'askable', 'Alpha');
  const g2 = group(db, 'askable', 'Beta');

  recordMetadataAnswer(db, {
    groupId: g1,
    source: 'theporndb',
    confirmed: candidate({
      performers: [
        { sourceUuid: 'p1', slug: 'alice-maze', name: 'Alice Maze', kind: 'performer', faceUrl: null, imageUrl: null },
      ],
    }),
    nearMisses: [],
    now: NOW,
  });
  recordMetadataAnswer(db, {
    groupId: g2,
    source: 'theporndb',
    confirmed: candidate({
      performers: [
        { sourceUuid: 'p2', slug: 'bella-rolland', name: 'Bella Rolland', kind: 'performer', faceUrl: null, imageUrl: null },
      ],
    }),
    nearMisses: [],
    now: NOW,
  });

  const server = buildServer(deps(db));
  const response = await server.inject({ method: 'GET', url: '/api/browse?limit=10' });
  assert.equal(response.statusCode, 200);

  const body = response.json() as {
    groups: { id: number; metadata: { performers: { name: string }[] } }[];
  };
  const namesById = new Map(body.groups.map((g) => [g.id, g.metadata.performers.map((p) => p.name)]));
  assert.deepEqual(namesById.get(g1), ['Alice Maze']);
  assert.deepEqual(namesById.get(g2), ['Bella Rolland']);

  await server.close();
  db.close();
});

test('a poster route serves the cached file and 404s when absent', async () => {
  const db = openTestDatabase();
  const artworkDir = await mkdtemp(join(tmpdir(), 'pickarr-poster-'));
  try {
    const withPoster = group(db, 'askable', 'Has Poster');
    const noAnswer = group(db, 'askable', 'No Answer');
    const answeredNoPoster = group(db, 'askable', 'Answered No Poster');
    const missingFile = group(db, 'askable', 'Missing File');

    const bytes = Buffer.from('not-really-a-jpeg');
    await writeFile(join(artworkDir, `${withPoster}.jpg`), bytes);

    recordMetadataAnswer(db, {
      groupId: withPoster,
      source: 'theporndb',
      confirmed: candidate(),
      nearMisses: [],
      now: NOW,
    });
    setPosterPath(db, withPoster, `${withPoster}.jpg`);

    recordMetadataAnswer(db, {
      groupId: answeredNoPoster,
      source: 'theporndb',
      confirmed: candidate({ posterUrl: null }),
      nearMisses: [],
      now: NOW,
    });

    recordMetadataAnswer(db, {
      groupId: missingFile,
      source: 'theporndb',
      confirmed: candidate(),
      nearMisses: [],
      now: NOW,
    });
    setPosterPath(db, missingFile, `${missingFile}.jpg`); // never written to disk

    const server = buildServer(deps(db, { artworkDir }));

    const ok = await server.inject({ method: 'GET', url: `/api/groups/${withPoster}/poster` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/jpeg');
    assert.equal(ok.headers['cache-control'], 'public, max-age=86400');
    assert.deepEqual(ok.rawPayload, bytes);

    const neverAnswered = await server.inject({ method: 'GET', url: `/api/groups/${noAnswer}/poster` });
    assert.equal(neverAnswered.statusCode, 404);

    const noPoster = await server.inject({ method: 'GET', url: `/api/groups/${answeredNoPoster}/poster` });
    assert.equal(noPoster.statusCode, 404);

    const gone = await server.inject({ method: 'GET', url: `/api/groups/${missingFile}/poster` });
    assert.equal(gone.statusCode, 404);

    await server.close();
  } finally {
    db.close();
    await rm(artworkDir, { recursive: true, force: true });
  }
});

test('the poster route cannot escape the artwork directory', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'GET',
    url: '/api/groups/..%2f..%2fetc%2fpasswd/poster',
  });
  assert.equal(response.statusCode, 400, 'the id param is an integer schema, so this never reaches the filesystem');

  await server.close();
  db.close();
});

test('a background route serves the cached file and 404s when absent', async () => {
  // …mirroring the poster route's tests above, including the cache-control
  // header: same shape, different column.
  const db = openTestDatabase();
  const artworkDir = await mkdtemp(join(tmpdir(), 'pickarr-background-'));
  try {
    const withBackground = group(db, 'askable', 'Has Background');
    const noAnswer = group(db, 'askable', 'No Answer');
    const answeredNoBackground = group(db, 'askable', 'Answered No Background');
    const missingFile = group(db, 'askable', 'Missing File');

    const bytes = Buffer.from('not-really-a-jpeg');
    await writeFile(join(artworkDir, `group-background-${withBackground}.jpg`), bytes);

    recordMetadataAnswer(db, {
      groupId: withBackground,
      source: 'theporndb',
      confirmed: candidate(),
      nearMisses: [],
      now: NOW,
    });
    setBackgroundPath(db, withBackground, `group-background-${withBackground}.jpg`);

    recordMetadataAnswer(db, {
      groupId: answeredNoBackground,
      source: 'theporndb',
      confirmed: candidate({ backgroundUrl: null }),
      nearMisses: [],
      now: NOW,
    });

    recordMetadataAnswer(db, {
      groupId: missingFile,
      source: 'theporndb',
      confirmed: candidate(),
      nearMisses: [],
      now: NOW,
    });
    setBackgroundPath(db, missingFile, `group-background-${missingFile}.jpg`); // never written to disk

    const server = buildServer(deps(db, { artworkDir }));

    const ok = await server.inject({ method: 'GET', url: `/api/groups/${withBackground}/background` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/jpeg');
    assert.equal(ok.headers['cache-control'], 'public, max-age=86400');
    assert.deepEqual(ok.rawPayload, bytes);

    const neverAnswered = await server.inject({ method: 'GET', url: `/api/groups/${noAnswer}/background` });
    assert.equal(neverAnswered.statusCode, 404);

    const noBackground = await server.inject({ method: 'GET', url: `/api/groups/${answeredNoBackground}/background` });
    assert.equal(noBackground.statusCode, 404);

    const gone = await server.inject({ method: 'GET', url: `/api/groups/${missingFile}/background` });
    assert.equal(gone.statusCode, 404);

    await server.close();
  } finally {
    db.close();
    await rm(artworkDir, { recursive: true, force: true });
  }
});

test('the background route cannot escape the artwork directory', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'GET',
    url: '/api/groups/..%2f..%2fetc%2fpasswd/background',
  });
  assert.equal(response.statusCode, 400, 'the id param is an integer schema, so this never reaches the filesystem');

  await server.close();
  db.close();
});

test('the avatar route serves the cached face and 404s without one', async () => {
  // …mirroring the poster route's tests, including the cache-control header.
  const db = openTestDatabase();
  const artworkDir = await mkdtemp(join(tmpdir(), 'pickarr-avatar-'));
  try {
    const [withFace] = upsertPerformers(db, 'theporndb', [
      { sourceUuid: 'u1', slug: 'has-face', name: 'Has Face', kind: 'performer', faceUrl: 'https://example.invalid/f.jpg', imageUrl: null },
    ], NOW);
    const [neverFetched] = upsertPerformers(db, 'theporndb', [
      { sourceUuid: 'u2', slug: 'no-face', name: 'No Face', kind: 'performer', faceUrl: null, imageUrl: null },
    ], NOW);
    const [missingFile] = upsertPerformers(db, 'theporndb', [
      { sourceUuid: 'u3', slug: 'missing-file', name: 'Missing File', kind: 'performer', faceUrl: 'https://example.invalid/f.jpg', imageUrl: null },
    ], NOW);

    const bytes = Buffer.from('not-really-a-jpeg');
    await writeFile(join(artworkDir, `performer-face-${withFace}.jpg`), bytes);
    setPerformerArtwork(db, withFace!, 'face', `performer-face-${withFace}.jpg`);
    setPerformerArtwork(db, missingFile!, 'face', `performer-face-${missingFile}.jpg`); // never written to disk

    const server = buildServer(deps(db, { artworkDir }));

    const ok = await server.inject({ method: 'GET', url: `/api/performers/${withFace}/avatar` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/jpeg');
    assert.equal(ok.headers['cache-control'], 'public, max-age=86400');
    assert.deepEqual(ok.rawPayload, bytes);

    const noSuchPerformer = await server.inject({ method: 'GET', url: '/api/performers/999999/avatar' });
    assert.equal(noSuchPerformer.statusCode, 404);

    const noFace = await server.inject({ method: 'GET', url: `/api/performers/${neverFetched}/avatar` });
    assert.equal(noFace.statusCode, 404);

    const gone = await server.inject({ method: 'GET', url: `/api/performers/${missingFile}/avatar` });
    assert.equal(gone.statusCode, 404);

    await server.close();
  } finally {
    db.close();
    await rm(artworkDir, { recursive: true, force: true });
  }
});

test('the avatar route refuses a traversal in the id', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({ method: 'GET', url: '/api/performers/..%2f..%2fetc/avatar' });
  assert.equal(response.statusCode, 400);

  await server.close();
  db.close();
});

test('the image route serves the cached image and 404s without one', async () => {
  const db = openTestDatabase();
  const artworkDir = await mkdtemp(join(tmpdir(), 'pickarr-image-'));
  try {
    const [withImage] = upsertPerformers(db, 'theporndb', [
      { sourceUuid: 'u1', slug: 'has-image', name: 'Has Image', kind: 'performer', faceUrl: null, imageUrl: 'https://example.invalid/i.jpg' },
    ], NOW);
    const [neverFetched] = upsertPerformers(db, 'theporndb', [
      { sourceUuid: 'u2', slug: 'no-image', name: 'No Image', kind: 'performer', faceUrl: null, imageUrl: null },
    ], NOW);
    const [missingFile] = upsertPerformers(db, 'theporndb', [
      { sourceUuid: 'u3', slug: 'missing-file', name: 'Missing File', kind: 'performer', faceUrl: null, imageUrl: 'https://example.invalid/i.jpg' },
    ], NOW);

    const bytes = Buffer.from('not-really-a-jpeg');
    await writeFile(join(artworkDir, `performer-image-${withImage}.jpg`), bytes);
    setPerformerArtwork(db, withImage!, 'image', `performer-image-${withImage}.jpg`);
    setPerformerArtwork(db, missingFile!, 'image', `performer-image-${missingFile}.jpg`); // never written to disk

    const server = buildServer(deps(db, { artworkDir }));

    const ok = await server.inject({ method: 'GET', url: `/api/performers/${withImage}/image` });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/jpeg');
    assert.equal(ok.headers['cache-control'], 'public, max-age=86400');
    assert.deepEqual(ok.rawPayload, bytes);

    const noSuchPerformer = await server.inject({ method: 'GET', url: '/api/performers/999999/image' });
    assert.equal(noSuchPerformer.statusCode, 404);

    const noImage = await server.inject({ method: 'GET', url: `/api/performers/${neverFetched}/image` });
    assert.equal(noImage.statusCode, 404);

    const gone = await server.inject({ method: 'GET', url: `/api/performers/${missingFile}/image` });
    assert.equal(gone.statusCode, 404);

    await server.close();
  } finally {
    db.close();
    await rm(artworkDir, { recursive: true, force: true });
  }
});

test('the image route refuses a traversal in the id', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({ method: 'GET', url: '/api/performers/..%2f..%2fetc/image' });
  assert.equal(response.statusCode, 400);

  await server.close();
  db.close();
});

// The cast is a property of the *group*, not of the scene answer. The performer
// search exists precisely for a group whose scene lookup settled without one —
// and the commonest form of that is `state = 'none'`, no scene matched at all.
// Reported live: a group with no scene data never showed a cast, because
// `metadataViewOf` returned a bare `{ state: 'none' }` and threw the performers
// it had been handed away, so the search's whole output was unreachable in the
// case it was built for.

/** Links a cast to a group the way `recordPerformerOutcome` does. */
function linkCast(db: DatabaseSync, groupId: number, names: readonly string[]): void {
  const ids = upsertPerformers(
    db,
    'theporndb',
    names.map((name) => ({
      sourceUuid: `uuid-${name.toLowerCase().replace(/\s+/g, '-')}`,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      kind: 'performer' as const,
      faceUrl: null,
      imageUrl: null,
    })),
    NOW,
  );
  setGroupPerformers(db, groupId, ids);
}

test('a group whose scene lookup found nothing still reports the cast the performer search linked', () => {
  const db = openTestDatabase();
  const groupId = group(db, 'askable', 'Amalia Davis');

  // The scene lookup ran and matched nothing — `confirmed: null`.
  recordMetadataAnswer(db, { groupId, source: 'theporndb', confirmed: null, nearMisses: [], now: NOW });
  // The performer search then answered, which is the whole point of the fallback.
  linkCast(db, groupId, ['Amalia Davis']);

  const view = metadataViewOf(getGroupMetadata(db, groupId), performersForGroups(db, [groupId]).get(groupId) ?? []);

  assert.equal(view.state, 'none', 'the scene answer is unchanged: nothing was found');
  assert.deepEqual(
    view.performers.map((performer) => performer.name),
    ['Amalia Davis'],
    'the cast must survive a scene answer of none',
  );

  db.close();
});

test('the cast rides beside the scene answer in every state, not inside the confirmed one', () => {
  // The shape, stated once: `performers`/`performerNames` are readable whatever
  // `state` says, so no caller has to narrow the union before asking who is in
  // a group. A group that was never asked (`absent`) can hold a cast too — a
  // metadata row is not a precondition for `group_performers`.
  const db = openTestDatabase();
  const never = group(db, 'askable', 'Never Asked');
  linkCast(db, never, ['Riley Reid']);

  const view = metadataViewOf(getGroupMetadata(db, never), performersForGroups(db, [never]).get(never) ?? []);

  assert.equal(view.state, 'absent');
  assert.deepEqual(view.performers.map((performer) => performer.name), ['Riley Reid']);
  assert.deepEqual(view.performerNames, [], 'the legacy list stays empty when there is a structured cast');

  db.close();
});

test('/api/metadata carries the cast of a group with no scene data', async () => {
  const db = openTestDatabase();
  const groupId = group(db, 'askable', 'Amalia Davis');
  recordMetadataAnswer(db, { groupId, source: 'theporndb', confirmed: null, nearMisses: [], now: NOW });
  linkCast(db, groupId, ['Amalia Davis']);

  const server = buildServer(deps(db));
  const response = await server.inject({ method: 'GET', url: `/api/metadata?ids=${groupId}` });

  assert.equal(response.statusCode, 200);
  const body = response.json() as Record<string, { state: string; performers: { name: string }[] }>;
  assert.equal(body[String(groupId)]?.state, 'none');
  assert.deepEqual(body[String(groupId)]?.performers.map((p) => p.name), ['Amalia Davis']);

  await server.close();
  db.close();
});

test('browse carries the cast of a group with no scene data', async () => {
  // The other endpoint that builds a `MetadataView`. Both are fed by the same
  // `metadataViewOf`, but only a test through each says the SPA can actually
  // see the cast on the screens it uses.
  const db = openTestDatabase();
  const groupId = group(db, 'askable', 'Amalia Davis');
  recordMetadataAnswer(db, { groupId, source: 'theporndb', confirmed: null, nearMisses: [], now: NOW });
  linkCast(db, groupId, ['Amalia Davis']);

  const server = buildServer(deps(db));
  const response = await server.inject({ method: 'GET', url: '/api/browse?limit=10' });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    groups: { id: number; metadata: { state: string; performers: { name: string }[] } }[];
  };
  const found = body.groups.find((entry) => entry.id === groupId);
  assert.equal(found?.metadata.state, 'none');
  assert.deepEqual(found?.metadata.performers.map((p) => p.name), ['Amalia Davis']);

  await server.close();
  db.close();
});

// Re-asking a group whose metadata came back empty. A `'none'` answer is
// settled, and `/api/metadata/request` used to treat settled as final for all
// time — so a scene the provider simply did not have yet was never looked up
// again, however long the SPA kept showing the card. Past `RETRY_AFTER_MS`,
// viewing the group is what asks again.

/** The window the route uses, restated so a change to it fails these tests loudly. */
const RETRY_AFTER_MS = 36 * 60 * 60 * 1000;

function queueRow(db: DatabaseSync, groupId: number): { attempts: number; nextAt: number } | null {
  const queued = db
    .prepare('SELECT attempts, next_at FROM metadata_queue WHERE group_id = ?')
    .get(groupId) as { attempts: number; next_at: number } | undefined;
  return queued === undefined
    ? null
    : { attempts: Number(queued.attempts), nextAt: Number(queued.next_at) };
}

async function requestFor(db: DatabaseSync, ids: number[], now: number) {
  const server = buildServer(deps(db, { now: () => now }));
  const response = await server.inject({
    method: 'POST',
    url: '/api/metadata/request',
    payload: { groupIds: ids },
  });
  const body = response.json() as MetadataRequestResponse & { refreshed: number[] };
  await server.close();
  return body;
}

test('a none answer older than the retry window is asked again', async () => {
  const db = openTestDatabase();
  const groupId = group(db, 'askable', 'Nothing Found');
  recordMetadataAnswer(db, { groupId, source: 'theporndb', confirmed: null, nearMisses: [], now: NOW });

  const body = await requestFor(db, [groupId], NOW + RETRY_AFTER_MS);

  assert.equal(body.queued, 1, 'a queue row was written, so `queued` is the honest counter');
  assert.equal(body.alreadyAnswered, 0);
  assert.deepEqual(body.refreshed, [groupId], 'the SPA has stopped watching this id and must rearm it');
  assert.notEqual(queueRow(db, groupId), null, 'the worker has something to drain');

  db.close();
});

test('a none answer younger than the retry window is left alone', async () => {
  // One millisecond short. The boundary is the whole of what this feature is,
  // so it is pinned from both sides rather than tested at a comfortable margin.
  const db = openTestDatabase();
  const groupId = group(db, 'askable', 'Nothing Found');
  recordMetadataAnswer(db, { groupId, source: 'theporndb', confirmed: null, nearMisses: [], now: NOW });

  const body = await requestFor(db, [groupId], NOW + RETRY_AFTER_MS - 1);

  assert.equal(body.queued, 0);
  assert.equal(body.alreadyAnswered, 1);
  assert.deepEqual(body.refreshed, []);
  assert.equal(queueRow(db, groupId), null, 'nothing queued, so no provider request will be spent');

  db.close();
});

test('a confirmed answer is never re-asked, however old', async () => {
  // Only an empty answer is worth revisiting. A confirmed scene going stale is
  // a different feature with a different cost, and this one must not quietly
  // become it.
  const db = openTestDatabase();
  const groupId = group(db, 'askable', 'Found It');
  recordMetadataAnswer(db, { groupId, source: 'theporndb', confirmed: candidate(), nearMisses: [], now: NOW });

  const body = await requestFor(db, [groupId], NOW + RETRY_AFTER_MS * 100);

  assert.equal(body.alreadyAnswered, 1);
  assert.equal(body.queued, 0);
  assert.deepEqual(body.refreshed, []);
  assert.equal(queueRow(db, groupId), null);

  db.close();
});

test('a stale none already queued keeps its backoff rather than being rewound', async () => {
  // Viewing the page must not reset a row the worker has already failed on
  // several times: `requeueMetadata` would zero `attempts` and pull `next_at`
  // back to now, so a reader idly refreshing would hold a failing group at the
  // front of the queue forever. This is why the route does not reuse it.
  const db = openTestDatabase();
  const groupId = group(db, 'askable', 'Nothing Found');
  recordMetadataAnswer(db, { groupId, source: 'theporndb', confirmed: null, nearMisses: [], now: NOW });
  const farFuture = NOW + RETRY_AFTER_MS * 10;
  db.prepare(
    `INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at)
     VALUES (?, ?, 4, ?)`,
  ).run(groupId, NOW, farFuture);

  const body = await requestFor(db, [groupId], NOW + RETRY_AFTER_MS);

  assert.equal(body.pending, 1, 'already queued is `pending`, not a second queueing');
  assert.equal(body.queued, 0);
  assert.deepEqual(queueRow(db, groupId), { attempts: 4, nextAt: farFuture }, 'untouched');

  db.close();
});

test('the five counters still partition a mixed request', async () => {
  // The invariant `MetadataRequestResponse` documents. Adding a sixth outcome
  // to the route is exactly the change that would quietly break it.
  const db = openTestDatabase();
  const stale = group(db, 'askable', 'Stale None');
  const fresh = group(db, 'askable', 'Fresh None');
  const confirmed = group(db, 'askable', 'Confirmed');
  const never = group(db, 'askable', 'Never Asked');
  const now = NOW + RETRY_AFTER_MS;
  recordMetadataAnswer(db, { groupId: stale, source: 'theporndb', confirmed: null, nearMisses: [], now: NOW });
  recordMetadataAnswer(db, { groupId: fresh, source: 'theporndb', confirmed: null, nearMisses: [], now });
  recordMetadataAnswer(db, { groupId: confirmed, source: 'theporndb', confirmed: candidate(), nearMisses: [], now: NOW });

  const ids = [stale, fresh, confirmed, never, 9999];
  const body = await requestFor(db, ids, now);

  assert.equal(
    body.queued + body.alreadyAnswered + body.pending + body.missing + body.unavailable,
    ids.length,
  );
  assert.equal(body.queued, 2, 'the stale none and the never-asked one');
  assert.equal(body.alreadyAnswered, 2, 'the fresh none and the confirmed one');
  assert.equal(body.missing, 1);
  assert.deepEqual(body.refreshed, [stale], 'only the id that had an answer before needs a rearm');

  db.close();
});
