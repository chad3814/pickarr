import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { getDownload } from '../../src/db/downloads.ts';
import { buildServer, type ServerDeps } from '../../src/http/server.ts';
import type { DownloadClient } from '../../src/clients/types.ts';
import type { UntrackedEntry } from '../../src/pipeline/reconcile.ts';

function seedGroups(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'Alpha.1080p', 'https://indexer.invalid/1.nzb', 1),
            (2, 'f', 'g2', 'Alpha.2160p', 'https://indexer.invalid/2.nzb', 1),
            (3, 'f', 'g3', 'Beta.1080p',  'https://indexer.invalid/3.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state, created_at, list_rank_at)
     VALUES (1, 'test', 'alpha', '{"title":"Alpha","fields":[]}', 'alpha', 'new', 100, 100),
            (2, 'test', 'beta',  '{"title":"Beta","fields":[]}',  'beta',  'new', 200, 200)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":1080}', 1080, 1),
            (2, 1, 2, '{"resolution":2160}', 2160, 1),
            (3, 2, 3, '{"resolution":1080}', 1080, 1)`,
  ).run();
}

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

function deps(db: DatabaseSync, untracked: UntrackedEntry[] = []): ServerDeps {
  return {
    db,
    defaultClient: fakeClient(),
    untrackedFor: () => untracked,
    now: () => 1000,
    webRoot: null,
  };
}

test('health responds ok', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));
  const response = await server.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json()['status'], 'ok');
  await server.close();
  db.close();
});

test('browse returns groups newest-rank first with their releases', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  const response = await server.inject({ method: 'GET', url: '/api/browse' });
  const body = response.json();

  assert.equal(body['groups'].length, 2);
  assert.equal(body['groups'][0]['display']['title'], 'Beta');
  assert.equal(body['groups'][1]['display']['title'], 'Alpha');
  assert.equal(body['groups'][1]['releases'].length, 2);
  assert.equal(body['groups'][1]['releases'][0]['score'], 2160);
  await server.close();
  db.close();
});

test('browse paginates with a stable cursor', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  const first = (await server.inject({ method: 'GET', url: '/api/browse?limit=1' })).json();
  assert.equal(first['groups'].length, 1);
  assert.ok(first['nextCursor']);

  const second = (
    await server.inject({
      method: 'GET',
      url: `/api/browse?limit=1&cursor=${encodeURIComponent(String(first['nextCursor']))}`,
    })
  ).json();
  assert.equal(second['groups'][0]['display']['title'], 'Alpha');
  assert.equal(second['nextCursor'], null);
  await server.close();
  db.close();
});

test('browse filters by q', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  const body = (await server.inject({ method: 'GET', url: '/api/browse?q=ALP' })).json();
  assert.equal(body['groups'].length, 1);
  assert.equal(body['groups'][0]['display']['title'], 'Alpha');
  await server.close();
  db.close();
});

test('a picked group with no upgrade drops out of browse and appears in picks', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  const pick = await server.inject({
    method: 'POST',
    url: '/api/groups/1/pick',
    payload: { releaseId: 2 },
  });
  assert.equal(pick.statusCode, 200);

  const browse = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  assert.deepEqual(
    browse['groups'].map((group: { display: { title: string } }) => group.display.title),
    ['Beta'],
  );

  const picks = (await server.inject({ method: 'GET', url: '/api/picks' })).json();
  assert.equal(picks['groups'].length, 1);
  assert.equal(picks['groups'][0]['pickedReleaseId'], 2);
  await server.close();
  db.close();
});

test('picking a release from the wrong group is a 400', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  const response = await server.inject({
    method: 'POST',
    url: '/api/groups/2/pick',
    payload: { releaseId: 1 },
  });
  assert.equal(response.statusCode, 400);
  await server.close();
  db.close();
});

test('a malformed pick body is a 400', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  const response = await server.inject({
    method: 'POST',
    url: '/api/groups/1/pick',
    payload: { releaseId: 'not-a-number' },
  });
  assert.equal(response.statusCode, 400);
  await server.close();
  db.close();
});

test('downloads merges tracked rows with the untracked snapshot', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const untracked: UntrackedEntry[] = [
    { ref: 'foreign', name: 'Someone Elses', state: 'downloading', percentage: 33 },
  ];
  const server = buildServer(deps(db, untracked));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });

  const body = (await server.inject({ method: 'GET', url: '/api/downloads' })).json();

  assert.equal(body['tracked'].length, 1);
  assert.equal(body['tracked'][0]['title'], 'Alpha');
  assert.equal(body['untracked'].length, 1);
  assert.equal(body['untracked'][0]['name'], 'Someone Elses');
  await server.close();
  db.close();
});

test('retrying a failed import resumes at completed', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  db.prepare(
    "UPDATE downloads SET status = 'failed', error = 'disk full', storage_path = '/x' WHERE id = 1",
  ).run();

  const response = await server.inject({ method: 'POST', url: '/api/downloads/1/retry' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json()['status'], 'completed');
  await server.close();
  db.close();
});

test('retrying a download that has not failed is refused', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  db.prepare(
    "UPDATE downloads SET status = 'imported', storage_path = '/x' WHERE id = 1",
  ).run();

  const response = await server.inject({ method: 'POST', url: '/api/downloads/1/retry' });

  assert.equal(response.statusCode, 409);
  // Untouched: re-running an already-imported upgrade is the one API call that
  // could make an import destroy its own output, so the row must not be reset.
  assert.equal(getDownload(db, 1)?.status, 'imported');
  await server.close();
  db.close();
});

test('retrying an unknown download is a 404', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));
  const response = await server.inject({ method: 'POST', url: '/api/downloads/999/retry' });
  assert.equal(response.statusCode, 404);
  await server.close();
  db.close();
});

test('no route ever returns the client api key', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  for (const url of ['/api/browse', '/api/picks', '/api/downloads', '/api/health']) {
    const body = (await server.inject({ method: 'GET', url })).body;
    assert.doesNotMatch(body, /apiKey|apikey/);
  }
  await server.close();
  db.close();
});
