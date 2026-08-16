import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, openTestDatabase } from '../../src/db/open.ts';
import { failDownload, getDownload } from '../../src/db/downloads.ts';
import { getGroup } from '../../src/db/groups.ts';
import { insertImportedFile } from '../../src/db/imported-files.ts';
import { buildServer, type ServerDeps } from '../../src/http/server.ts';
import type { FastifyInstance } from 'fastify';
import type { DownloadClient } from '../../src/clients/types.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';
import type { UntrackedEntry } from '../../src/pipeline/reconcile.ts';
import { asJsonArray, asJsonObject, type JsonObject, type JsonValue } from '../../src/json.ts';

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
    category: 'pickarr',
    addUrl: async () => 'nzo_1',
    snapshot: async () => ({ queue: [], history: [], complete: true }),
  remove: async () => {},
    mapPath: (path) => path,
  };
}

/**
 * No plugins are loaded here. These tests are about browsing, picking and
 * retrying, none of which asks a plugin anything, and an empty registry is the
 * honest way to say so — the manual routes and the prefill values a plugin
 * supplies have their own file, `manual.test.ts`.
 */
function emptyRegistry(): PluginRegistry {
  return {
    byPackage: (packageName) => {
      throw new Error(`No plugin registered for package ${packageName}`);
    },
    byId: () => undefined,
    libraryRoot: () => '/library',
    libraryRootById: () => '/library',
    all: () => [],
  };
}

function deps(db: DatabaseSync, untracked: UntrackedEntry[] = []): ServerDeps {
  return {
    db,
    defaultClient: fakeClient(),
    untrackedFor: () => untracked,
    now: () => 1000,
    webRoot: null,
    registry: emptyRegistry(),
    pluginForFeed: () => null,
    artworkDir: '/tmp/pickarr-server-test-unused-artwork',
    metadataAvailable: true,
    configPath: '/tmp/pickarr-server-test-unused-config.json',
    bootConfigDocument: null,
    databasePath: '/tmp/pickarr-server-test-unused.db',
    requestRestart: () => {},
  };
}

const CONFIG_DOCUMENT: JsonObject = {
  server: { port: 8080 },
  database: { path: '/config/pickarr.db' },
  trashDir: '/data/trash',
  plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes' } },
  downloadClients: [
    {
      id: 'sab',
      type: 'sabnzbd',
      url: 'http://sabnzbd:8080',
      apiKey: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
      category: 'pickarr',
      importMode: 'move',
      pathMappings: [],
    },
  ],
  feeds: [
    { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900 },
  ],
};

/**
 * A temp directory holding a `config.json`, plus deps pointed at it. Every
 * config route test goes through here so none of them can touch a real config.
 */
async function withConfigDir(
  fn: (context: { dir: string; configPath: string; deps: ServerDeps }) => Promise<void>,
  document: JsonValue = structuredClone(CONFIG_DOCUMENT),
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-http-config-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(document, null, 2));
  const db = openTestDatabase();
  try {
    await fn({
      dir,
      configPath,
      deps: { ...deps(db), configPath, bootConfigDocument: structuredClone(document) },
    });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
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
  // And the response says so, so a paginated browse can drop that one card
  // instead of refetching its first page and losing the rest.
  assert.equal(pick.json()['group'], null);
  assert.equal(pick.json()['download']['groupId'], 1);

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

/** The groups `/api/picks` returns, in the order it returned them. */
interface PickedGroup {
  id: number;
  pickedReleaseId: number | null;
  releases: { id: number; downloadFailed?: boolean }[];
}

async function picksOf(server: FastifyInstance): Promise<PickedGroup[]> {
  const body = (await server.inject({ method: 'GET', url: '/api/picks' })).json();
  return body['groups'] as PickedGroup[];
}

test('picks flags a group whose download failed, marks the release, and says nothing at all otherwise', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  await server.inject({ method: 'POST', url: '/api/groups/2/pick', payload: { releaseId: 3 } });
  failDownload(db, 1, 'Repair failed, not enough repair blocks (92 short)', 2000);

  const groups = await picksOf(server);

  // Alpha's download failed at 2000, which stamped its list rank and carried it
  // past Beta's 200. Not because failures sort ahead of everything — the list
  // orders on `list_rank_at` alone — but because failing is one of the two events
  // that write it.
  assert.deepEqual(groups.map((group) => group.id), [1, 2]);
  // The order *is* the group-level statement — there is no group-level field,
  // and nothing on the client re-derives one.
  // The card is told *which* release, which is the part a screen reads.
  const alpha = groups[0]?.releases ?? [];
  assert.equal(alpha.find((release) => release.id === 2)?.downloadFailed, true);
  // Absent, not `false`, on the healthy sibling release and on the healthy
  // group alike: a payload with nothing wrong with it is byte-for-byte what it
  // was before either field existed, which is what lets the SPA ignore them
  // wherever it does not care.
  assert.equal(Object.hasOwn(alpha.find((release) => release.id === 1) ?? {}, 'downloadFailed'), false);
  assert.equal(Object.hasOwn(groups[1]?.releases[0] ?? {}, 'downloadFailed'), false);
  await server.close();
  db.close();
});

test('a failed upgrade flags its group even though the pick imported fine, and leaves browse at once', async () => {
  // The case that scoped out the first version of this rule, which asked only
  // whether `picked_release_id` had failed. Own a 1080p; a 2160p arrives and is
  // flagged; pick it. That is an upgrade, so the pick deliberately stays on the
  // 1080p until the replacement imports — and when the 2160p fails, the pick is
  // a release that imported perfectly well. Under the narrow rule the group had
  // no flag, no badge and no sort, and sat on Browse advertising the very
  // release that had just failed.
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 1 } });
  // The 1080p lands: a live file is what makes the next pick an upgrade rather
  // than a fresh initial download.
  db.prepare("UPDATE downloads SET status = 'imported' WHERE id = 1").run();
  db.prepare(
    `INSERT INTO imported_files (download_id, group_id, source_path, dest_path, size_bytes, created_at)
     VALUES (1, 1, '/dl/a.mkv', '/library/a.mkv', 10, 1)`,
  ).run();
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, 2, 'the 2160p should be flagged as an upgrade');

  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  assert.equal(getDownload(db, 2)?.kind, 'upgrade');
  failDownload(db, 2, 'Repair failed, not enough repair blocks (92 short)', 3000);

  const alpha = (await picksOf(server)).find((group) => group.id === 1);
  // The pick is untouched — the user still has the 1080p and still wants the
  // content — but the group is flagged and the 2160p is the release marked.
  assert.equal(alpha?.pickedReleaseId, 1);
  assert.equal(alpha?.releases.find((release) => release.id === 2)?.downloadFailed, true);
  assert.equal(
    Object.hasOwn(alpha?.releases.find((release) => release.id === 1) ?? {}, 'downloadFailed'),
    false,
  );

  // Off Browse in the same instant it appeared on Picks, not at whatever later
  // write next happened to re-derive the flag. Advertising "Upgrade available"
  // for a release that has just proved undownloadable is the reported loop.
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, null);
  const browse = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  assert.deepEqual(
    browse['groups'].map((group: { display: { title: string } }) => group.display.title),
    ['Beta'],
  );
  await server.close();
  db.close();
});

test('picking a lesser release keeps the group in browse, with the better one still offered', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  // Release 1 is the 1080p; release 2 (2160p) scores higher and remains an
  // upgrade, which is what keeps the group listed.
  const pick = await server.inject({
    method: 'POST',
    url: '/api/groups/1/pick',
    payload: { releaseId: 1 },
  });

  assert.equal(pick.statusCode, 200);
  const group = pick.json()['group'];
  assert.equal(group['id'], 1);
  assert.equal(group['state'], 'picked');
  assert.equal(group['pickedReleaseId'], 1);
  assert.equal(group['upgradeReleaseId'], 2);

  // The same group the browse list itself would return — the client patches
  // this straight in, so the two must agree.
  const browse = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  const listed = browse['groups'].find((candidate: { id: number }) => candidate.id === 1);
  assert.deepEqual(listed, group);
  await server.close();
  db.close();
});

test('picking an upgrade answers with no group, and browse stops listing it', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  // Take the 1080p and let it land, so the group holds a file and the 2160p
  // is what browse is offering. Picking it is an upgrade rather than a fresh
  // acquisition.
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 1 } });
  insertImportedFile(db, {
    downloadId: 1,
    groupId: 1,
    sourcePath: '/downloads/alpha.mp4',
    destPath: '/library/Alpha/alpha.mp4',
    sizeBytes: 1,
    createdAt: 1,
  });

  const pick = await server.inject({
    method: 'POST',
    url: '/api/groups/1/pick',
    payload: { releaseId: 2 },
  });

  assert.equal(pick.statusCode, 200);
  // A null group is the whole contract the SPA acts on: `Browse` filters the
  // card out on exactly this. It used to come back non-null — still flagged
  // with the release now downloading — so the card stayed on screen offering
  // a Pick button that could only answer `already has download`.
  assert.equal(pick.json()['group'], null);

  // And the list agrees, which is the point of the route answering at all:
  // the client patches this response straight in, so a disagreement here is a
  // client view that has quietly stopped matching the database.
  const browse = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  assert.deepEqual(
    browse['groups'].map((candidate: { id: number }) => candidate.id),
    [2],
  );

  // The pick itself has not moved — the replacement is still downloading, and
  // moving it early is what would trash the wrong file on import.
  assert.equal(getGroup(db, 1)?.pickedReleaseId, 1);
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

test('downloads reports absentSince, null and populated', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });

  const untouched = (await server.inject({ method: 'GET', url: '/api/downloads' })).json();
  assert.equal(untouched['tracked'][0]['absentSince'], null);

  db.prepare('UPDATE downloads SET absent_since = 500 WHERE id = 1').run();
  const marked = (await server.inject({ method: 'GET', url: '/api/downloads' })).json();
  assert.equal(marked['tracked'][0]['absentSince'], 500);
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

test('retry takes no body, and is not refused for having none', async () => {
  // The route always worked; the SPA could never reach it. Its fetch helper
  // set `content-type: application/json` on every request including this
  // bodyless POST, and Fastify's JSON parser answers that with a 400
  // (FST_ERR_CTP_EMPTY_JSON_BODY) before any handler runs — so the button had
  // never once retried anything. Asserting the shape the browser actually
  // sends is what would have caught it; the test above sends no header at all.
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  db.prepare(
    "UPDATE downloads SET status = 'failed', error = 'ENOTDIR', storage_path = '/x' WHERE id = 1",
  ).run();

  const response = await server.inject({
    method: 'POST',
    url: '/api/downloads/1/retry',
    headers: { 'content-type': 'application/json' },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(getDownload(db, 1)?.status, 'completed');
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

test('retrying a healthy downloading download is refused', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  // Fresh from `pick`, row 1 is `downloading` with no absent_since — the client
  // still reports it, so retry must refuse it exactly as it always has.

  const response = await server.inject({ method: 'POST', url: '/api/downloads/1/retry' });

  assert.equal(response.statusCode, 409);
  assert.equal(getDownload(db, 1)?.status, 'downloading');
  await server.close();
  db.close();
});

test('retrying a downloading download the client has lost is accepted', async () => {
  // The escape hatch Task 4 adds: absence never fails a download (Task 3), so
  // a genuinely-lost download stays `downloading` forever unless retry will
  // take it. Without this, `inFlightForRelease` (which excludes only `failed`)
  // would also keep its release from ever being picked again.
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  db.prepare('UPDATE downloads SET absent_since = 500 WHERE id = 1').run();

  const response = await server.inject({ method: 'POST', url: '/api/downloads/1/retry' });

  assert.equal(response.statusCode, 200);
  const after = getDownload(db, 1);
  assert.equal(after?.status, 'queued');
  assert.equal(after?.absentSince, null);
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
  for (const url of [
    '/api/browse',
    '/api/picks',
    '/api/downloads',
    '/api/health',
    '/api/failed',
    '/api/manual-fields',
  ]) {
    const body = (await server.inject({ method: 'GET', url })).body;
    assert.doesNotMatch(body, /apiKey|apikey/);
  }
  await server.close();
  db.close();
});

test('GET /api/config redacts a literal api key', async () => {
  await withConfigDir(async ({ deps: configDeps }) => {
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json()['config']['downloadClients'][0]['apiKey'], { kind: 'set' });
    assert.doesNotMatch(response.body, /0f1e2d3c4b5a69788796a5b4c3d2e1f0/);
    await server.close();
  });
});

test('GET /api/config reports no pending restart when the file matches boot', async () => {
  await withConfigDir(async ({ deps: configDeps }) => {
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.json()['restartRequired'], false);
    await server.close();
  });
});

// Reformatting by hand must not read as a pending restart: the comparison is of
// parsed documents, not of bytes.
test('GET /api/config ignores whitespace-only differences from the boot document', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    await writeFile(configPath, JSON.stringify(CONFIG_DOCUMENT));
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.json()['restartRequired'], false);
    await server.close();
  });
});

test('GET /api/config reports a pending restart when the file has really changed', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const changed = structuredClone(CONFIG_DOCUMENT);
    changed.trashDir = '/data/elsewhere';
    await writeFile(configPath, JSON.stringify(changed, null, 2));
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.json()['restartRequired'], true);
    await server.close();
  });
});

test('GET /api/config reports PICKARR_PORT as an override', async () => {
  await withConfigDir(async ({ deps: configDeps }) => {
    process.env['PICKARR_PORT'] = '9999';
    try {
      const server = buildServer(configDeps);
      const response = await server.inject({ method: 'GET', url: '/api/config' });
      assert.equal(response.json()['portOverride'], 9999);
      await server.close();
    } finally {
      delete process.env['PICKARR_PORT'];
    }
  });
});

// `loadConfig` refuses a malformed PICKARR_PORT at boot; this route only
// reports the override, so it must not repeat that refusal — a bad env var
// should not 500 the whole Settings screen.
test('GET /api/config reports a malformed PICKARR_PORT as no override, not an error', async () => {
  await withConfigDir(async ({ deps: configDeps }) => {
    process.env['PICKARR_PORT'] = 'abc';
    try {
      const server = buildServer(configDeps);
      const response = await server.inject({ method: 'GET', url: '/api/config' });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json()['portOverride'], null);
      assert.equal(response.json()['config']['server']['port'], 8080);
      await server.close();
    } finally {
      delete process.env['PICKARR_PORT'];
    }
  });
});

test('GET /api/config answers 500 with the reason when the file is unparseable', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    await writeFile(configPath, '{ not json');
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'GET', url: '/api/config' });
    assert.equal(response.statusCode, 500);
    assert.match(response.json()['error'], /not valid JSON/);
    await server.close();
  });
});

/** A submission matching CONFIG_DOCUMENT, keeping the api key that is on disk. */
function configSubmission(): Record<string, JsonValue> {
  return {
    server: { port: 8080 },
    database: { path: '/config/pickarr.db' },
    trashDir: '/data/trash',
    plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes' } },
    downloadClients: [
      {
        id: 'sab',
        type: 'sabnzbd',
        url: 'http://sabnzbd:8080',
        apiKey: { kind: 'keep' },
        category: 'pickarr',
        importMode: 'move',
        pathMappings: [],
      },
    ],
    feeds: [
      { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900 },
    ],
    siteLookup: null,
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: null },
  };
}

test('PUT /api/config writes the change and keeps the secret on disk', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const server = buildServer(configDeps);
    const body = configSubmission();
    body['trashDir'] = '/data/elsewhere';

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json()['restartRequired'], true);

    const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, JsonValue>;
    assert.equal(written['trashDir'], '/data/elsewhere');
    const clients = asJsonArray(written['downloadClients']);
    assert.equal(asJsonObject(clients[0])?.['apiKey'], '0f1e2d3c4b5a69788796a5b4c3d2e1f0');
    await server.close();
  });
});

// `writeFile` creates the temp file at `0666 & ~umask`, and `rename` carries
// that mode onto `config.json` — silently widening a restrictive file that
// holds literal api keys on every successful save. This pins that the save
// preserves whatever mode was already on disk.
test('PUT /api/config preserves the mode config.json already had', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    await chmod(configPath, 0o600);
    const server = buildServer(configDeps);

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: configSubmission() });
    assert.equal(response.statusCode, 200);

    const mode = (await stat(configPath)).mode & 0o777;
    assert.equal(mode.toString(8), '600');
    await server.close();
  });
});

// The test above passes even if the mode were hardcoded to `0600` and the
// `stat` ignored, so this one pins that the mode is genuinely read from disk.
// `0660` is chosen deliberately rather than arbitrarily: under the common
// umask 022 the group-write bit is masked off when the temp file is created,
// so reaching `660` here is only possible because of the `chmod` that follows
// the write. Under a permissive umask the write alone would suffice and this
// still passes — it never fails a correct implementation, and it does fail one
// that drops either half.
test('PUT /api/config preserves a wider mode too, not just a restrictive one', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    await chmod(configPath, 0o660);
    const server = buildServer(configDeps);

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: configSubmission() });
    assert.equal(response.statusCode, 200);

    const mode = (await stat(configPath)).mode & 0o777;
    assert.equal(mode.toString(8), '660');
    await server.close();
  });
});

test('PUT /api/config leaves no temporary file behind', async () => {
  await withConfigDir(async ({ dir, deps: configDeps }) => {
    const server = buildServer(configDeps);
    await server.inject({ method: 'PUT', url: '/api/config', payload: configSubmission() });
    assert.deepEqual(await readdir(dir), ['config.json']);
    await server.close();
  });
});

// The property that matters most: a refused save must not have touched the file
// the container boots from.
test('a rejected PUT leaves the file byte-identical', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const before = await readFile(configPath, 'utf8');
    const server = buildServer(configDeps);
    const body = configSubmission();
    body['trashDir'] = '';

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 400);
    assert.match(response.json()['error'], /trashDir/);
    assert.equal(await readFile(configPath, 'utf8'), before);
    await server.close();
  });
});

// The rehearsal: this document parses, but boot would die resolving the secret.
test('a PUT whose file: secret cannot be resolved is refused before the write', async () => {
  await withConfigDir(async ({ dir, configPath, deps: configDeps }) => {
    const before = await readFile(configPath, 'utf8');
    const server = buildServer(configDeps);
    const body = configSubmission();
    const clients = asJsonArray(body['downloadClients']);
    asJsonObject(clients[0])!['apiKey'] = { kind: 'file', path: join(dir, 'absent-secret') };

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 400);
    assert.match(response.json()['error'], /absent-secret/);
    assert.equal(await readFile(configPath, 'utf8'), before);
    await server.close();
  });
});

test('a PUT keeping a secret for a renamed client is refused with a usable message', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const before = await readFile(configPath, 'utf8');
    const server = buildServer(configDeps);
    const body = configSubmission();
    const clients = asJsonArray(body['downloadClients']);
    asJsonObject(clients[0])!['id'] = 'sab-renamed';

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 400);
    assert.match(response.json()['error'], /sab-renamed/);
    assert.equal(await readFile(configPath, 'utf8'), before);
    await server.close();
  });
});

// The PUT and GET routes compute `restartRequired` the same way — against
// `bootConfigDocument` — so they must never contradict each other on the same
// disk state. Fix 3: `restartRequired` used to be hardcoded `true` on every
// save, even one that changed nothing a boot would notice.
//
// `applyEdits` always writes a `metadata` object and always deletes an absent
// `siteLookup`, whether or not the document on disk already had them — so the
// document the base `CONFIG_DOCUMENT` fixture produces is *not* a fixed point
// of `configSubmission()`. This test needs a document that already is one.
test('PUT /api/config answers restartRequired: false when the save matches the boot document', async () => {
  const unchanged: JsonObject = {
    ...structuredClone(CONFIG_DOCUMENT),
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5 },
  };
  await withConfigDir(async ({ deps: configDeps }) => {
    const server = buildServer(configDeps);
    // Submits exactly what's on disk (and what boot document holds), so the
    // resulting document is unchanged.
    const response = await server.inject({
      method: 'PUT',
      url: '/api/config',
      payload: configSubmission(),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json()['restartRequired'], false);
    await server.close();
  }, unchanged);
});

test('PUT /api/config answers restartRequired: true when the save actually changes something', async () => {
  await withConfigDir(async ({ deps: configDeps }) => {
    const server = buildServer(configDeps);
    const body = configSubmission();
    body['trashDir'] = '/data/elsewhere';

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json()['restartRequired'], true);
    await server.close();
  });
});

test('a PUT against an unparseable file on disk is refused', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    await writeFile(configPath, '{ not json');
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: configSubmission() });
    assert.equal(response.statusCode, 500);
    assert.match(response.json()['error'], /not valid JSON/);
    await server.close();
  });
});

test('a malformed PUT body is a 400 and writes nothing', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const before = await readFile(configPath, 'utf8');
    const server = buildServer(configDeps);
    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: { nope: true } });
    assert.equal(response.statusCode, 400);
    assert.equal(await readFile(configPath, 'utf8'), before);
    await server.close();
  });
});

test('POST /api/restart acknowledges and asks for exactly one restart', async () => {
  const db = openTestDatabase();
  let restarts = 0;
  const server = buildServer({ ...deps(db), requestRestart: () => { restarts += 1; } });

  const response = await server.inject({ method: 'POST', url: '/api/restart' });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json()['restarting'], true);
  // `inject` resolves once the reply has finished, which is exactly the event
  // the handler hangs the restart on.
  assert.equal(restarts, 1);

  await server.close();
  db.close();
});

test('a backup that cannot be written answers 500 and leaves no temp file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-backup-fail-'));
  const db = openTestDatabase();
  try {
    seedGroups(db);
    // A `databasePath` whose directory does not exist: `backup()` cannot
    // create its destination there and rejects deterministically — this
    // failure needs no fault injection, unlike the ones further into the
    // handler that only occur strictly after a successful `open()`.
    const databasePath = join(dir, 'missing', 'pickarr.db');
    const server = buildServer({ ...deps(db), databasePath });

    const response = await server.inject({ method: 'GET', url: '/api/database/backup' });
    assert.equal(response.statusCode, 500);
    assert.match(response.json()['error'], /Backup failed/);

    // The directory backup() would have written into never came to exist,
    // so there is nothing here for it to have left behind either.
    assert.deepEqual(await readdir(dir), []);

    await server.close();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the backup route streams an openable copy and leaves nothing behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-backup-'));
  const databasePath = join(dir, 'pickarr.db');
  const db = openDatabase(databasePath);
  try {
    seedGroups(db);
    const server = buildServer({ ...deps(db), databasePath });

    const response = await server.inject({ method: 'GET', url: '/api/database/backup' });
    assert.equal(response.statusCode, 200);
    assert.equal(
      response.headers['content-disposition'],
      'attachment; filename="pickarr-1970-01-01.db"',
    );
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    // Makes the intent explicit rather than merely implied by the row count
    // check below: a truncated stream would still be non-empty, so this is
    // the assertion that actually pins the byte count to the real file size.
    assert.equal(response.headers['content-length'], String(response.rawPayload.length));

    // A real SQLite file, and one that actually holds the seeded rows.
    const copyPath = join(dir, 'downloaded.db');
    await writeFile(copyPath, response.rawPayload);
    const copy = openDatabase(copyPath);
    try {
      const rows = copy.prepare('SELECT COUNT(*) AS n FROM media_groups').get();
      assert.equal(rows?.['n'], 2);
    } finally {
      copy.close();
    }

    // Nothing temporary survives: the only files here are the database, its WAL
    // sidecars, and the copy this test wrote itself.
    const left = (await readdir(dir)).filter((name) => name.startsWith('.'));
    assert.deepEqual(left, []);

    await server.close();
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
