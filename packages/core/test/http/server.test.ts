import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, openTestDatabase } from '../../src/db/open.ts';
import { failDownload, getDownload, setStatus } from '../../src/db/downloads.ts';
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

function fakeClient(id = 'sab'): DownloadClient {
  return {
    id,
    importMode: 'move',
    category: 'pickarr',
    addUrl: async () => `nzo_${id}`,
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

/**
 * `clientForFeed` defaults to one client for every feed, which is what a
 * one-client config resolves to in `main.ts`. Every pick test below leans on
 * that default and none of them names a feed: a routing change that started
 * requiring an annotation would break them here rather than in production.
 */
function deps(
  db: DatabaseSync,
  untracked: UntrackedEntry[] = [],
  clientForFeed: (feedId: string) => DownloadClient | null = () => fakeClient(),
): ServerDeps {
  return {
    db,
    clientForFeed,
    untrackedAll: () => untracked,
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
    trashDir: '/trash',
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

/**
 * Every shape that is not a cursor this route could have minted, and why each
 * one is in the list. `parseCursor` is shared with `/api/failed`, so this table
 * covers the rule for both lists; `manual.test.ts` checks that the failed route
 * really does go through it.
 */
const MALFORMED_CURSORS: readonly string[] = [
  '', // `?cursor=` — sent by a client that has no cursor, which is not the same as sending none.
  'nonsense',
  '100', // A sort key with no id: the tiebreak half is what makes paging stable.
  '100:',
  ':2',
  ':',
  '100:2:3', // The old `split(':')` read this as `100:2` — a real page, and not the one asked for.
  '1e3:2', // Every shape `Number()` accepts and no route mints.
  '0x64:2',
  '+100:2',
  ' 100:2',
  '100.5:2',
  '100:2.5',
  '100:-2',
  '100:0', // Rowids start at 1.
  '9007199254740993:2', // Collapses onto 9007199254740992, a different boundary.
  'abc:2',
  '100:abc',
];

test('a malformed browse cursor is a 400, never a silent first page', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  for (const cursor of MALFORMED_CURSORS) {
    const response = await server.inject({
      method: 'GET',
      url: `/api/browse?cursor=${encodeURIComponent(cursor)}`,
    });

    assert.equal(response.statusCode, 400, `cursor ${JSON.stringify(cursor)} should be refused`);
    assert.equal(response.json()['error'], 'Invalid cursor');
    // The failure that mattered was not the status but the payload: answering a
    // cursor nobody minted with page one hands the SPA the same `nextCursor`
    // page two already used, and the list scrolls forever (issue #33).
    assert.equal(
      Object.hasOwn(response.json(), 'groups'),
      false,
      `cursor ${JSON.stringify(cursor)} should not answer with a page`,
    );
  }
  await server.close();
  db.close();
});

test('an omitted browse cursor is still the first page', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  // The other half of the rule above: absence is the legitimate first-page
  // request every list opens with, and the two were the same answer before
  // issue #33 — which is exactly how a broken cursor passed for a first page.
  const response = await server.inject({ method: 'GET', url: '/api/browse' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json()['groups'].map((group: { display: { title: string } }) => group.display.title),
    ['Beta', 'Alpha'],
  );
  await server.close();
  db.close();
});

test('a browse cursor whose group has since been deleted still pages from where it pointed', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  const first = (await server.inject({ method: 'GET', url: '/api/browse?limit=1' })).json();
  assert.equal(first['nextCursor'], '200:group:2');
  db.prepare('DELETE FROM releases WHERE group_id = 2').run();
  db.prepare('DELETE FROM media_groups WHERE id = 2').run();

  const second = (
    await server.inject({ method: 'GET', url: '/api/browse?limit=1&cursor=200:group:2' })
  ).json();

  // Not malformed — well-formed and merely stale. The keyset comparison is
  // `(list_rank_at, id)` against the index rather than a lookup of that row, so
  // it still names the right boundary; ingest and edits delete rows underneath a
  // list that is being paged, and refusing this would break ordinary paging.
  assert.deepEqual(
    second['groups'].map((group: { display: { title: string } }) => group.display.title),
    ['Alpha'],
  );
  assert.equal(second['nextCursor'], null);
  await server.close();
  db.close();
});

test('a three-component browse cursor round-trips', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  const first = (await server.inject({ method: 'GET', url: '/api/browse?limit=1' })).json();
  assert.match(String(first['nextCursor']), /^\d+:(failed|group):\d+$/);

  const second = await server.inject({
    method: 'GET',
    url: `/api/browse?cursor=${encodeURIComponent(String(first['nextCursor']))}&limit=1`,
  });
  assert.equal(second.statusCode, 200);
  await server.close();
  db.close();
});

test('a two-component cursor is malformed on browse, and still valid on the other lists', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  // The old shape. Accepting it would read `(sortKey, id)` against a total
  // order that now has three components, which is a wrong boundary rather than
  // a loud failure.
  const stale = await server.inject({ method: 'GET', url: '/api/browse?cursor=100:5' });
  assert.equal(stale.statusCode, 400);
  assert.deepEqual(stale.json(), { error: 'Invalid cursor' });
  // Unchanged for the routes that still order on one table.
  const downloads = await server.inject({ method: 'GET', url: '/api/downloads?cursor=100:5' });
  assert.equal(downloads.statusCode, 200);
  await server.close();
  db.close();
});

test('an unknown kind is malformed on a browse cursor', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  const res = await server.inject({ method: 'GET', url: '/api/browse?cursor=100:banana:5' });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: 'Invalid cursor' });
  await server.close();
  db.close();
});

test('a browse cursor rejects the numeric forms the shared parser rejects', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));

  for (const cursor of ['1e3:group:5', '0x10:group:5', '+1:group:5', ' 1:group:5', '100:group:0']) {
    // eslint-disable-next-line no-await-in-loop -- five cursors, sequential like the malformed-cursor table above
    const res = await server.inject({
      method: 'GET',
      url: `/api/browse?cursor=${encodeURIComponent(cursor)}`,
    });
    assert.equal(res.statusCode, 400, cursor);
  }
  // The sort key may be 0 where the id may not — both stamps come from an
  // injected clock that hands out 0.
  const zero = await server.inject({ method: 'GET', url: '/api/browse?cursor=0:group:5' });
  assert.equal(zero.statusCode, 200);
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

// `%` is a LIKE wildcard, so wrapping the term in `%…%` and handing it to
// LIKE turned a search for a per-cent sign into the pattern `%%%`, which every
// row matches — the search box stopped being a filter. `%25` reaches the
// handler as a bare `%`.
test('browse matches a literal % in q rather than every group', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (4, 'f', 'g4', '100.Percent.Natural.1080p', 'https://indexer.invalid/4.nzb', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state, created_at, list_rank_at)
     VALUES (3, 'test', 'natural', '{"title":"100% Natural","fields":[]}', '100% natural', 'new', 300, 300)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (4, 3, 4, '{"resolution":1080}', 1080, 1)`,
  ).run();
  const server = buildServer(deps(db));

  const body = (await server.inject({ method: 'GET', url: '/api/browse?q=%25' })).json();

  assert.deepEqual(
    body['groups'].map((group: { display: { title: string } }) => group.display.title),
    ['100% Natural'],
  );
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
  releases: {
    id: number;
    download?: { downloadId: number; status: string; error: string | null; absentSince: number | null };
  }[];
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
  assert.equal(alpha.find((release) => release.id === 2)?.download?.status, 'failed');
  // Absent on the sibling release that was never picked, so it has never had
  // a download at all — a payload with nothing wrong with it is byte-for-byte
  // what it was before the field existed, which is what lets the SPA ignore
  // it wherever it does not care.
  assert.equal(Object.hasOwn(alpha.find((release) => release.id === 1) ?? {}, 'download'), false);
  // Beta's pick does have a download — it was picked too — but a healthy one
  // never reads `failed`.
  assert.notEqual(groups[1]?.releases[0]?.download?.status, 'failed');
  await server.close();
  db.close();
});

test('a release carries its latest download, not merely whether it failed', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });
  // A state the old boolean could not express at all — `downloadFailed` was
  // exactly `status === 'failed'`, and `downloading` is neither `true` nor
  // `false` under that rule — so this cannot pass by accident.
  setStatus(db, 1, 'downloading', 2000);

  const alpha = (await picksOf(server)).find((group) => group.id === 1);
  const release = alpha?.releases.find((candidate) => candidate.id === 2);
  assert.equal(release?.download?.status, 'downloading');
  assert.equal(release?.download?.error, null);
  assert.equal(release?.download?.absentSince, null);
  await server.close();
  db.close();
});

test('a release with no download omits the key entirely', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db));
  await server.inject({ method: 'POST', url: '/api/groups/1/pick', payload: { releaseId: 2 } });

  // Release 1 was never picked, so it has never had a download.
  const alpha = (await picksOf(server)).find((group) => group.id === 1);
  const release = alpha?.releases.find((candidate) => candidate.id === 1);
  // Absent, not present-and-null: the field is absent or it is a value,
  // matching how `manualValues` already behaves on the same type.
  assert.equal(Object.hasOwn(release ?? {}, 'download'), false);
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
  assert.equal(alpha?.releases.find((release) => release.id === 2)?.download?.status, 'failed');
  // Release 1 has a download too — the pick that imported fine — but it never
  // reads `failed`: the mark belongs to the release that actually failed.
  assert.notEqual(alpha?.releases.find((release) => release.id === 1)?.download?.status, 'failed');

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
    { clientId: 'sab', ref: 'foreign', name: 'Someone Elses', state: 'downloading', percentage: 33 },
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

// #34: the feed a release arrived on is what decides the client, and the pick
// route is the only place that decision is made. Group 2's release is moved to
// a second feed here so the two clients are distinguishable in the row.
test('a pick on a release from a second feed is submitted to that feed\'s client', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  db.prepare("UPDATE feed_items SET feed_id = 'f-b' WHERE id = 3").run();

  const server = buildServer(
    deps(db, [], (feedId) => (feedId === 'f-b' ? fakeClient('sab-b') : fakeClient('sab-a'))),
  );
  const response = await server.inject({
    method: 'POST',
    url: '/api/groups/2/pick',
    payload: { releaseId: 3 },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(db.prepare('SELECT client_id FROM downloads WHERE id = 1').get()?.['client_id'], 'sab-b');
  await server.close();
  db.close();
});

// A feed that has left configuration: the route's existing catch turns the
// thrown message into a 400, which is the right answer for something only a
// config edit can fix.
test('a pick on a release whose feed has no client is a 400 naming the feed', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const server = buildServer(deps(db, [], () => null));

  const response = await server.inject({
    method: 'POST',
    url: '/api/groups/1/pick',
    payload: { releaseId: 2 },
  });

  assert.equal(response.statusCode, 400);
  assert.match(String(response.json()['error']), /feed f/);
  await server.close();
  db.close();
});

// `untrackedAll` replaced `untrackedFor(defaultClient.id)`: every configured
// client's orphans reach the screen, and each entry says which client it came
// from because `ref` alone is unique only within one of them.
test('downloads reports untracked entries from every client, each stamped with its own', async () => {
  const db = openTestDatabase();
  seedGroups(db);
  const untracked: UntrackedEntry[] = [
    { clientId: 'sab-a', ref: 'shared', name: 'On A', state: 'downloading', percentage: 10 },
    { clientId: 'sab-b', ref: 'shared', name: 'On B', state: 'completed', percentage: null },
  ];
  const server = buildServer(deps(db, untracked));

  const body = (await server.inject({ method: 'GET', url: '/api/downloads' })).json();

  assert.deepEqual(
    body['untracked'].map((entry: { clientId: string; name: string }) => [entry.clientId, entry.name]),
    [
      ['sab-a', 'On A'],
      ['sab-b', 'On B'],
    ],
  );
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

/**
 * `count` downloads, one per group, `created_at` climbing with the id — which
 * is how downloads are really minted, one pick at a time, and so the direction
 * `/api/downloads`' `created_at DESC, id DESC` ordering assumes. A group each,
 * rather than one group shared, because the per-row group query this pins is
 * keyed on `group_id` and a single shared group would let a per-row loop look
 * like a batch.
 */
function seedManyDownloads(db: DatabaseSync, count: number): void {
  for (let id = 1; id <= count; id += 1) {
    db.prepare(
      `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
       VALUES (?, 'f', ?, ?, 'https://indexer.invalid/n.nzb', 1)`,
    ).run(id, `g${id}`, `Title ${id}`);
    db.prepare(
      `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                                 created_at, list_rank_at)
       VALUES (?, 'test', ?, ?, ?, 'new', ?, ?)`,
    ).run(id, `k${id}`, JSON.stringify({ title: `Title ${id}`, fields: [] }), `title ${id}`, id, id);
    db.prepare(
      `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
       VALUES (?, ?, ?, '{"resolution":1080}', 1080, 1)`,
    ).run(id, id, id);
    db.prepare(
      `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                              attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'sab', 'initial', 'downloading', 0, ?, ?)`,
    ).run(id, id, id, id, id);
  }
}

test('downloads paginates with a stable cursor, newest first', async () => {
  const db = openTestDatabase();
  seedManyDownloads(db, 5);
  const server = buildServer(deps(db));

  // Annotated because the loop is circular for the inference: `cursor` is read
  // to build the url and written from the response the url produced.
  const seen: number[] = [];
  const titles: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url: string =
      cursor === null
        ? '/api/downloads?limit=2'
        : `/api/downloads?limit=2&cursor=${encodeURIComponent(cursor)}`;
    const page = (await server.inject({ method: 'GET', url })).json<{
      tracked: { id: number; title: string }[];
      nextCursor: string | null;
    }>();
    pages += 1;
    assert.ok(page.tracked.length <= 2, 'a page never exceeds the limit asked for');
    for (const download of page.tracked) {
      seen.push(download.id);
      titles.push(download.title);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);

  // Every row exactly once, newest first, and the walk terminated on its own —
  // the last page's `nextCursor` is what ends the loop, so a route that always
  // answered one would hang here rather than assert.
  assert.deepEqual(seen, [5, 4, 3, 2, 1]);
  assert.deepEqual(titles, ['Title 5', 'Title 4', 'Title 3', 'Title 2', 'Title 1']);
  assert.equal(pages, 3);
  await server.close();
  db.close();
});

test('the last downloads page reports no next cursor even when it is exactly full', async () => {
  // The over-fetch-by-one is what tells these apart: four rows at limit two
  // gives a second page that is exactly `limit` long *and* is the end.
  const db = openTestDatabase();
  seedManyDownloads(db, 4);
  const server = buildServer(deps(db));

  const first = (await server.inject({ method: 'GET', url: '/api/downloads?limit=2' })).json();
  // The last row of page one, `created_at:id` — both 3, since this seed climbs
  // them together.
  assert.equal(first['nextCursor'], '3:3');

  const second = (
    await server.inject({ method: 'GET', url: '/api/downloads?limit=2&cursor=3:3' })
  ).json();

  assert.deepEqual(
    second['tracked'].map((download: { id: number }) => download.id),
    [2, 1],
  );
  assert.equal(second['nextCursor'], null);
  await server.close();
  db.close();
});

test('a malformed downloads cursor is a 400, never a silent first page', async () => {
  // The same table `/api/browse` is held to, because it is the same parser: a
  // cursor rule that held on two of the three paginated lists would leave the
  // third scrolling forever (issue #33).
  const db = openTestDatabase();
  seedManyDownloads(db, 3);
  const server = buildServer(deps(db));

  for (const cursor of MALFORMED_CURSORS) {
    const response = await server.inject({
      method: 'GET',
      url: `/api/downloads?cursor=${encodeURIComponent(cursor)}`,
    });

    assert.equal(response.statusCode, 400, `cursor ${JSON.stringify(cursor)} should be refused`);
    assert.equal(response.json()['error'], 'Invalid cursor');
    assert.equal(
      Object.hasOwn(response.json(), 'tracked'),
      false,
      `cursor ${JSON.stringify(cursor)} should not answer with a page`,
    );
  }
  await server.close();
  db.close();
});

test('one downloads page costs one group query, not one per row', async () => {
  // The N+1 this issue is really about. `toDownloadView` opened with
  // `SELECT display FROM media_groups WHERE id = ?` and the route called it
  // once per row: measured at 501 prepared statements for 500 downloads, every
  // three seconds. Counting prepared statements rather than timing anything is
  // what makes the assertion stable — and asserting the *total* rather than
  // only the absence of the per-row query is what stops a batch being added
  // beside the loop instead of in place of it.
  const db = openTestDatabase();
  seedManyDownloads(db, 40);
  const server = buildServer(deps(db));

  const prepare = db.prepare.bind(db);
  const prepared: string[] = [];
  db.prepare = (sql: string) => {
    prepared.push(sql);
    return prepare(sql);
  };

  const response = await server.inject({ method: 'GET', url: '/api/downloads?limit=30' });

  db.prepare = prepare;
  assert.equal(response.json()['tracked'].length, 30);
  assert.deepEqual(
    prepared.filter((sql) => /FROM media_groups WHERE id = \?/.test(sql)),
    [],
    'no per-row group lookup',
  );
  // The page itself and one batched lookup for its groups.
  assert.equal(prepared.length, 2, prepared.join('\n'));
  await server.close();
  db.close();
});

test('a download whose group is missing still lists, under a placeholder title', async () => {
  // The fallback `toDownloadView` always had, kept through the batching: a row
  // absent from the batch's map is the same fact as `get` answering undefined
  // was, and losing it would drop the download off the screen entirely rather
  // than name it awkwardly.
  //
  // Arranged with the foreign key off because that constraint is exactly what
  // makes this unreachable by ordinary writes — which is the point. The
  // fallback is for a database that got there anyway, and a test that could
  // only reach it through a supported code path would be testing that path
  // instead.
  const db = openTestDatabase();
  seedManyDownloads(db, 2);
  db.exec('PRAGMA foreign_keys = OFF');
  db.prepare('UPDATE downloads SET group_id = 99 WHERE id = 2').run();
  db.exec('PRAGMA foreign_keys = ON');
  const server = buildServer(deps(db));

  const body = (await server.inject({ method: 'GET', url: '/api/downloads' })).json();

  assert.deepEqual(
    body['tracked'].map((download: { title: string }) => download.title),
    ['Group 99', 'Title 1'],
  );
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
      { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', downloadClient: 'sab', intervalSeconds: 900, backfill: null },
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

// A syntactically valid qBittorrent api key — "qbt_" plus 28 alphanumerics —
// so a submission that carries one clears `qbittorrentClientSchema`'s shape
// check and reaches the cross-field rules in `parseConfig` the tests below are
// actually about.
const QBT_API_KEY = 'qbt_A1B2C3D4E5F6G7H8I9J0K1L2M3N4';

test('PUT /api/config round-trips a qBittorrent client with its credentials intact', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const server = buildServer(configDeps);
    const body = configSubmission();
    const clients = asJsonArray(body['downloadClients']);
    clients.push({
      id: 'qbt',
      type: 'qbittorrent',
      url: 'http://qbittorrent:8080',
      apiKey: null,
      username: 'admin',
      password: { kind: 'literal', value: 'hunter2' },
      category: 'pickarr',
      importMode: 'copy',
      pathMappings: [],
    });

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 200);

    const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, JsonValue>;
    const writtenClients = asJsonArray(written['downloadClients']).map((client) => asJsonObject(client));
    const qbt = writtenClients.find((client) => client?.['id'] === 'qbt');
    assert.ok(qbt !== undefined);
    // A schema that accepted the qbittorrent member but silently dropped one
    // of its fields on the way through would still round-trip *a* client with
    // this id — asserting the credentials specifically is what would catch it.
    assert.equal(qbt?.['username'], 'admin');
    assert.equal(qbt?.['password'], 'hunter2');
    assert.equal(qbt?.['apiKey'], undefined);
    await server.close();
  });
});

test('PUT /api/config refuses a qBittorrent client with both an apiKey and a login', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const before = await readFile(configPath, 'utf8');
    const server = buildServer(configDeps);
    const body = configSubmission();
    const clients = asJsonArray(body['downloadClients']);
    clients.push({
      id: 'qbt',
      type: 'qbittorrent',
      url: 'http://qbittorrent:8080',
      apiKey: { kind: 'literal', value: QBT_API_KEY },
      username: 'admin',
      password: { kind: 'literal', value: 'hunter2' },
      category: 'pickarr',
      importMode: 'copy',
      pathMappings: [],
    });

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 400);
    assert.match(response.json()['error'], /qbt/);
    assert.match(response.json()['error'], /exactly one/);
    assert.equal(await readFile(configPath, 'utf8'), before);
    await server.close();
  });
});

test('PUT /api/config refuses a qBittorrent client with importMode "move"', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const before = await readFile(configPath, 'utf8');
    const server = buildServer(configDeps);
    const body = configSubmission();
    const clients = asJsonArray(body['downloadClients']);
    clients.push({
      id: 'qbt',
      type: 'qbittorrent',
      url: 'http://qbittorrent:8080',
      apiKey: { kind: 'literal', value: QBT_API_KEY },
      username: null,
      password: null,
      category: 'pickarr',
      importMode: 'move',
      pathMappings: [],
    });

    const response = await server.inject({ method: 'PUT', url: '/api/config', payload: body });
    assert.equal(response.statusCode, 400);
    assert.match(response.json()['error'], /qbt/);
    assert.match(response.json()['error'], /move/);
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
    // Carrying the feed's `downloadClient` explicitly, because that is what a
    // save writes: the form is shown the *effective* client and writes back
    // what it was shown. A boot document lacking the key would differ from
    // the saved one and this test would be measuring that, not the no-op it
    // is here to measure — see the test below, which measures it deliberately.
    feeds: [
      { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', downloadClient: 'sab', intervalSeconds: 900 },
    ],
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

// The one visible effect of #34 on a config written before it: the first save
// makes each feed's client explicit. The value is the one already in force, so
// nothing about routing changes — but the *document* changes, and saying
// `restartRequired: false` about a file that is not byte-identical to the one
// booted from would be a claim this route cannot support.
test('a save on a file that named no download client writes the effective one', async () => {
  await withConfigDir(async ({ configPath, deps: configDeps }) => {
    const server = buildServer(configDeps);

    const response = await server.inject({
      method: 'PUT',
      url: '/api/config',
      payload: configSubmission(),
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json()['restartRequired'], true);
    const written = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, JsonValue>;
    assert.equal(asJsonObject(asJsonArray(written['feeds'])[0])?.['downloadClient'], 'sab');
    await server.close();
  });
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
