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
  setPosterPath,
} from '../../src/db/metadata.ts';
import { buildServer, type ServerDeps } from '../../src/http/server.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';
import type { DownloadClient } from '../../src/clients/types.ts';

const NOW = 1000;

function fakeClient(): DownloadClient {
  return {
    id: 'sab',
    importMode: 'move',
    addUrl: async () => 'nzo_1',
    snapshot: async () => ({ queue: [], history: [] }),
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
  overrides: Partial<Pick<ServerDeps, 'registry' | 'artworkDir' | 'metadataAvailable'>> = {},
): ServerDeps {
  return {
    db,
    defaultClient: fakeClient(),
    untrackedFor: () => [],
    now: () => NOW,
    webRoot: null,
    registry: overrides.registry ?? registryWith([ASKABLE, NO_HOOKS, NULL_QUERY]),
    pluginForFeed: () => null,
    artworkDir: overrides.artworkDir ?? '/tmp/pickarr-metadata-test-unused-artwork',
    metadataAvailable: overrides.metadataAvailable ?? true,
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
    performers: ['Jane Doe'],
    durationSeconds: 1200,
    synopsis: 'A synopsis',
    posterUrl: 'https://example.invalid/poster.jpg',
    ...overrides,
  };
}

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
  assert.deepEqual(response.json(), { queued: 2, alreadyAnswered: 0, pending: 0, missing: 0, unavailable: 0 });
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
  assert.deepEqual(response.json(), { queued: 0, alreadyAnswered: 3, pending: 0, missing: 0, unavailable: 0 });

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
  assert.deepEqual(again.json(), { queued: 0, alreadyAnswered: 3, pending: 0, missing: 0, unavailable: 0 });
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
  };
  assert.deepEqual(body, { queued: 1, alreadyAnswered: 0, pending: 0, missing: 1, unavailable: 0 });
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
    performers: ['Jane Doe'],
    releaseDate: '2024-01-01',
    durationSeconds: 1200,
    synopsis: 'A synopsis',
    hasPoster: false,
  });
  assert.deepEqual(body[String(none)], { state: 'none' });
  assert.deepEqual(body[String(pending)], { state: 'pending' });
  assert.deepEqual(body[String(absent)], { state: 'absent' });

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
    performers: ['Jane Doe'],
    releaseDate: '2024-01-01',
    durationSeconds: 1200,
    synopsis: 'A synopsis',
    hasPoster: false,
  });
  assert.deepEqual(byId.get(g2), { state: 'none' });
  assert.deepEqual(byId.get(g3), { state: 'absent' });

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
