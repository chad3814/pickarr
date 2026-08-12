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
  metadataQuery: (group) => ({ queries: [group.display.title], siteName: 'Some Site' }),
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
  overrides: Partial<Pick<ServerDeps, 'registry' | 'artworkDir'>> = {},
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
  assert.deepEqual(response.json(), { queued: 2, alreadyAnswered: 0, pending: 0 });
  assert.equal(dueMetadataQueue(db, NOW, 10).length, 2);

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
  assert.deepEqual(response.json(), { queued: 0, alreadyAnswered: 3, pending: 0 });

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
  assert.deepEqual(again.json(), { queued: 0, alreadyAnswered: 3, pending: 0 });
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

  // Count every statement touching group_metadata: browse must issue exactly
  // one for the whole page, never one per group (issue #31's defect).
  const originalPrepare = db.prepare.bind(db);
  let groupMetadataQueries = 0;
  db.prepare = ((sql: string) => {
    if (sql.includes('group_metadata')) groupMetadataQueries += 1;
    return originalPrepare(sql);
  }) as typeof db.prepare;

  const response = await server.inject({ method: 'GET', url: '/api/browse?limit=10' });

  assert.equal(response.statusCode, 200);
  assert.equal(groupMetadataQueries, 1, 'browse must read group_metadata in one query for the whole page');

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
