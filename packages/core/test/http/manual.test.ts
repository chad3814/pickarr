import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { ManualField, MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import createScenesPlugin from '@pickarr/plugin-scenes';
import { openTestDatabase } from '../../src/db/open.ts';
import { getFeedItem } from '../../src/db/feed-items.ts';
import { browsableGroup, getGroup } from '../../src/db/groups.ts';
import { getRelease } from '../../src/db/releases.ts';
import { buildServer, type ServerDeps } from '../../src/http/server.ts';
import type { PluginRegistry } from '../../src/plugins/registry.ts';
import type { DownloadClient } from '../../src/clients/types.ts';

const NOW = 5000;

/**
 * The same shape of stand-in the operations tests use: identity is whatever
 * `key` says, quality is a resolution. These tests are about what the HTTP
 * layer does with a plugin's answers, not about any real plugin's idea of a
 * release name.
 */
const FIELDS: readonly ManualField[] = [
  { name: 'key', label: 'Key', type: 'text', scope: 'identity', required: true },
  { name: 'title', label: 'Title', type: 'text', scope: 'identity' },
  { name: 'res', label: 'Resolution', type: 'text', scope: 'quality' },
];

const PLUGIN: MediaTypePlugin = {
  id: 'test',
  displayName: 'Test',
  parse: () => null,
  score: (quality) => quality.resolution ?? 0,
  planImport: () => null,
  manualFields: () => FIELDS,
  fromManualValues(values): { media: ParsedRelease } | { error: string } {
    const key = values['key'] ?? '';
    if (key === '') return { error: 'key is required' };
    return {
      media: {
        // `!` is the one back door: a plugin that reports success while handing
        // back a release core must refuse. Nothing else reaches that branch
        // from outside.
        identityKey: key === '!' ? '' : key,
        display: { title: values['title'] ?? key, fields: [] },
        quality: { resolution: Number(values['res'] ?? '0') },
      },
    };
  },
  toManualValues: (media) => ({
    key: media.identityKey,
    title: media.display.title,
    res: String(media.quality.resolution ?? ''),
  }),
  suggestManualValues: (releaseName) => ({ title: releaseName.replace(/\./g, ' ') }),
};

/** The same plugin with none of the manual hooks — the degradation case. */
const BARE: MediaTypePlugin = {
  id: 'test',
  displayName: 'Test',
  parse: () => null,
  score: (quality) => quality.resolution ?? 0,
  planImport: () => null,
};

/** A plugin whose prefill hook is broken, which no request can avoid. */
const THROWS_ON_PREFILL: MediaTypePlugin = {
  ...PLUGIN,
  toManualValues: () => {
    throw new Error('boom');
  },
};

/** A plugin whose suggestion hook is broken, which no Failed page can avoid. */
const THROWS_ON_SUGGEST: MediaTypePlugin = {
  ...PLUGIN,
  suggestManualValues: () => {
    throw new Error('boom');
  },
};

/** A plugin whose field list is broken. */
const THROWS_ON_FIELDS: MediaTypePlugin = {
  ...PLUGIN,
  manualFields: () => {
    throw new Error('boom');
  },
};

/**
 * A plugin that describes a form but cannot read one back. Half a contract:
 * every hook that consumes the values is missing, so any submission of that
 * form is refused.
 */
const FIELDS_ONLY: MediaTypePlugin = {
  id: 'test',
  displayName: 'Test',
  parse: () => null,
  score: (quality) => quality.resolution ?? 0,
  planImport: () => null,
  manualFields: () => FIELDS,
};

function registryFor(plugin: MediaTypePlugin): PluginRegistry {
  return {
    byPackage: () => plugin,
    byId: (id) => (id === plugin.id ? plugin : undefined),
    libraryRoot: () => '/library',
    libraryRootById: () => '/library',
    all: () => [plugin],
  };
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

/** Feed `f` is configured; every other feed id has been removed from config. */
function deps(db: DatabaseSync, plugin: MediaTypePlugin = PLUGIN): ServerDeps {
  return {
    db,
    defaultClient: fakeClient(),
    untrackedFor: () => [],
    now: () => NOW,
    webRoot: null,
    registry: registryFor(plugin),
    pluginForFeed: (feedId) => (feedId === 'f' ? plugin : null),
    artworkDir: '/tmp/pickarr-manual-test-unused-artwork',
    metadataAvailable: true,
  };
}

/**
 * Items 1 and 2 are plain failures a page apart in time, 3 is dismissed and the
 * newest of the three, 4 parsed cleanly, and 5 failed on a feed that is no
 * longer in configuration.
 */
function seedFeedItems(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, published_at, first_seen_at,
                             parse_error, dismissed_at)
     VALUES (1, 'f',    'g1', 'Alpha.One',   'https://indexer.invalid/1.nzb', 11,   100, 'no site', NULL),
            (2, 'f',    'g2', 'Beta.Two',    'https://indexer.invalid/2.nzb', NULL, 200, 'no date', NULL),
            (3, 'f',    'g3', 'Gamma.Three', 'https://indexer.invalid/3.nzb', NULL, 300, 'no site', 900),
            (4, 'f',    'g4', 'Delta.Four',  'https://indexer.invalid/4.nzb', NULL, 50,  NULL,      NULL),
            (5, 'gone', 'g5', 'Epsilon.Five','https://indexer.invalid/5.nzb', NULL, 400, 'no site', NULL)`,
  ).run();
}

/**
 * Two groups, one release each, over feed items of their own — ids well clear
 * of the failed ones so the two seeds compose. Group 1 is picked on a 720;
 * group 2 holds a 2160, so merging 2 into 1 raises a flag that was not there
 * before.
 */
function seedTwoGroups(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (11, 'f', 'g11', 'G1.720p',  'https://indexer.invalid/11.nzb', 100),
            (12, 'f', 'g12', 'G2.2160p', 'https://indexer.invalid/12.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"G1","fields":[]}', 'g1', 'picked', 1,    100, 500),
            (2, 'test', 'k2', '{"title":"G2","fields":[]}', 'g2', 'new',    NULL, 100, 600)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 11, '{"resolution":720}',  720,  100),
            (2, 2, 12, '{"resolution":2160}', 2160, 100)`,
  ).run();
}

/**
 * One picked group with something better on offer: release 1 is the 1080 it is
 * sitting on, release 2 the 2160 it could have. `state` is `picked`, so the
 * upgrade flag is the *only* thing keeping this group in the browse list.
 */
function seedPickedWithUpgrade(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (11, 'f', 'g11', 'G1.1080p', 'https://indexer.invalid/11.nzb', 100),
            (12, 'f', 'g12', 'G1.2160p', 'https://indexer.invalid/12.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, upgrade_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"G1","fields":[]}', 'g1', 'picked', 1, 2, 100, 500)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 11, '{"resolution":1080}', 1080, 100),
            (2, 1, 12, '{"resolution":2160}', 2160, 100)`,
  ).run();
}

function insertDownload(db: DatabaseSync, groupId: number, releaseId: number): void {
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status, created_at, updated_at)
     VALUES (1, ?, ?, 'sab', 'initial', 'queued', 1, 1)`,
  ).run(releaseId, groupId);
}

function groupCount(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM media_groups').get()?.['n']);
}

interface FailedItemBody {
  id: number;
  feedId: string;
  plugin: string;
  rawTitle: string;
  link: string;
  parseError: string;
  firstSeenAt: number;
  publishedAt: number | null;
  suggestedValues: Record<string, string>;
  dismissedAt: number | null;
}

function idsOf(body: Record<string, unknown>): number[] {
  return (body['items'] as FailedItemBody[]).map((item) => item.id);
}

// --- Field schemas -----------------------------------------------------

test('manual-fields returns a field list per plugin id', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({ method: 'GET', url: '/api/manual-fields' });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body), ['test']);
  assert.deepEqual(
    body['test'].map((field: { name: string }) => field.name),
    ['key', 'title', 'res'],
  );
  assert.equal(body['test'][0]['scope'], 'identity');
  await server.close();
  db.close();
});

test('manual-fields omits a plugin that has no field list', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db, BARE));

  const body = (await server.inject({ method: 'GET', url: '/api/manual-fields' })).json();

  // Absence is how the SPA decides there is no form to offer, the same rule
  // `manualValues` follows on a group.
  assert.deepEqual(body, {});
  await server.close();
  db.close();
});

test('manual-fields omits a plugin that describes a form it cannot read back', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db, FIELDS_ONLY));

  const body = (await server.inject({ method: 'GET', url: '/api/manual-fields' })).json();

  // Listing it would put a Fix form on the Failed screen whose every submit is
  // a 409 from `resolveFeedItem`. Browse is already right about this plugin —
  // it has no `toManualValues`, so no card offers Edit — and the two screens
  // have to agree.
  assert.deepEqual(body, {});
  await server.close();
  db.close();
});

test('a plugin whose field list throws costs its schema, not the endpoint', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db, THROWS_ON_FIELDS));

  const response = await server.inject({ method: 'GET', url: '/api/manual-fields' });

  // The same rule the prefill values follow: a hook with no promise not to
  // throw is called inside a guard, and a plugin that breaks it loses its own
  // form rather than everyone else's.
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {});
  await server.close();
  db.close();
});

// --- The failed list ---------------------------------------------------

test('failed lists refusals newest-first with the plugin and its suggestions', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  const response = await server.inject({ method: 'GET', url: '/api/failed' });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  // 3 is dismissed and 4 parsed; 5 is newest and comes first.
  assert.deepEqual(idsOf(body), [5, 2, 1]);
  assert.equal(body['nextCursor'], null);

  // The whole item, not a chosen few fields: the Failed screen renders the feed
  // it came from and links the nzb, and neither `feedId`, `link` nor
  // `firstSeenAt` is checked anywhere else — `nextCursor` is built from the row,
  // not from this view, so a blanked field here would reach the UI silently.
  // Comparing the object also fails loudly if a field is added without a test.
  assert.deepEqual((body['items'] as FailedItemBody[])[2], {
    id: 1,
    feedId: 'f',
    plugin: 'test',
    rawTitle: 'Alpha.One',
    link: 'https://indexer.invalid/1.nzb',
    parseError: 'no site',
    firstSeenAt: 100,
    publishedAt: 11,
    suggestedValues: { title: 'Alpha One' },
    dismissedAt: null,
  });
  await server.close();
  db.close();
});

test('a plugin whose suggestion hook throws costs the prefill, not the page', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db, THROWS_ON_SUGGEST));

  const response = await server.inject({ method: 'GET', url: '/api/failed' });

  // The hook's contract forbids throwing, but a contract is what a plugin owes
  // rather than what it does — and this call site runs once per row, so one
  // plugin breaking on one refused name would 500 the entire worklist of
  // broken names. That is the screen a broken plugin most needs to be visible
  // on, and the only route from a refusal to a correction.
  assert.equal(response.statusCode, 200);
  const items = response.json()['items'] as FailedItemBody[];
  assert.deepEqual(idsOf(response.json()), [5, 2, 1]);
  for (const item of items) assert.deepEqual(item.suggestedValues, {});
  await server.close();
  db.close();
});

test('a failed item from a feed no longer in configuration names no plugin', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  const body = (await server.inject({ method: 'GET', url: '/api/failed' })).json();
  const orphan = (body['items'] as FailedItemBody[])[0]!;

  // Nothing can say which schema would describe it, so the SPA offers no form
  // — and asking a plugin picked at random for suggestions would be worse.
  assert.equal(orphan.id, 5);
  assert.equal(orphan.plugin, '');
  assert.deepEqual(orphan.suggestedValues, {});
  await server.close();
  db.close();
});

test('failed paginates with a cursor and reports the last page as the last page', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  const first = (await server.inject({ method: 'GET', url: '/api/failed?limit=2' })).json();
  assert.deepEqual(idsOf(first), [5, 2]);
  assert.equal(first['nextCursor'], '200:2');

  const second = (
    await server.inject({
      method: 'GET',
      url: `/api/failed?limit=2&cursor=${encodeURIComponent(String(first['nextCursor']))}`,
    })
  ).json();
  assert.deepEqual(idsOf(second), [1]);
  // One page exactly the length of the list is not a page with more behind it.
  assert.equal(second['nextCursor'], null);
  await server.close();
  db.close();
});

test('a page exactly as long as what remains still reports no next page', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  const body = (await server.inject({ method: 'GET', url: '/api/failed?limit=3' })).json();

  assert.deepEqual(idsOf(body), [5, 2, 1]);
  assert.equal(body['nextCursor'], null);
  await server.close();
  db.close();
});

test('failed hides dismissed items unless includeDismissed is 1', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  const hidden = (await server.inject({ method: 'GET', url: '/api/failed' })).json();
  assert.equal(idsOf(hidden).includes(3), false);

  const shown = (
    await server.inject({ method: 'GET', url: '/api/failed?includeDismissed=1' })
  ).json();
  assert.deepEqual(idsOf(shown), [5, 3, 2, 1]);
  assert.equal((shown['items'] as FailedItemBody[])[1]?.dismissedAt, 900);

  // The flag is the literal string '1'; anything else is off, so a stray
  // `?includeDismissed=false` cannot read as true.
  for (const value of ['0', 'false', 'true', 'yes', '']) {
    const body = (
      await server.inject({ method: 'GET', url: `/api/failed?includeDismissed=${value}` })
    ).json();
    assert.equal(idsOf(body).includes(3), false, `includeDismissed=${value} should be off`);
  }
  await server.close();
  db.close();
});

test('a failed page over the maximum limit is a 400', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));
  const response = await server.inject({ method: 'GET', url: '/api/failed?limit=1000' });
  assert.equal(response.statusCode, 400);
  await server.close();
  db.close();
});

// --- Resolve -----------------------------------------------------------

test('resolve returns the new group and says it did not join one', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/feed-items/1/resolve',
    payload: { values: { key: 'k9', title: 'Nine', res: '1080' } },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body['joinedExisting'], false);
  assert.equal(body['group']['display']['title'], 'Nine');
  assert.equal(body['group']['releases'].length, 1);
  assert.equal(body['group']['releases'][0]['score'], 1080);
  assert.equal(body['group']['releases'][0]['releaseName'], 'Alpha.One');
  assert.equal(getFeedItem(db, 1)?.parseError, null);
  await server.close();
  db.close();
});

test('resolve reports joining an existing group and returns that group', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedTwoGroups(db);
  const server = buildServer(deps(db));

  const body = (
    await server.inject({
      method: 'POST',
      url: '/api/feed-items/1/resolve',
      payload: { values: { key: 'k2', res: '480' } },
    })
  ).json();

  assert.equal(body['joinedExisting'], true);
  assert.equal(body['group']['id'], 2);
  assert.equal(body['group']['releases'].length, 2);
  await server.close();
  db.close();
});

test("resolve answers with the plugin's own complaint and a 400", async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/feed-items/1/resolve',
    payload: { values: { key: '', res: '1080' } },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json()['error'], 'key is required');
  assert.equal(getFeedItem(db, 1)?.parseError, 'no site');
  await server.close();
  db.close();
});

test('resolving an item that already parsed is a 409, and an unknown one a 404', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  // The operations layer decides which refusal this is; the route must carry
  // that status rather than derive one of its own.
  const parsed = await server.inject({
    method: 'POST',
    url: '/api/feed-items/4/resolve',
    payload: { values: { key: 'k9' } },
  });
  const missing = await server.inject({
    method: 'POST',
    url: '/api/feed-items/99/resolve',
    payload: { values: { key: 'k9' } },
  });

  assert.equal(parsed.statusCode, 409);
  assert.equal(missing.statusCode, 404);
  await server.close();
  db.close();
});

test('a resolve body that is not a values map is a 400', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  const noValues = await server.inject({
    method: 'POST',
    url: '/api/feed-items/1/resolve',
    payload: { key: 'k9' },
  });
  const notStrings = await server.inject({
    method: 'POST',
    url: '/api/feed-items/1/resolve',
    payload: { values: { key: 9 } },
  });

  assert.equal(noValues.statusCode, 400);
  assert.equal(notStrings.statusCode, 400);
  assert.equal(groupCount(db), 0);
  await server.close();
  db.close();
});

// --- Dismiss -----------------------------------------------------------

test('dismiss stamps the item and answers with the stamp', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  const response = await server.inject({ method: 'POST', url: '/api/feed-items/1/dismiss' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { id: 1, dismissedAt: NOW });
  assert.equal(getFeedItem(db, 1)?.dismissedAt, NOW);
  await server.close();
  db.close();
});

test('dismiss works for a plugin with no manual hooks at all', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db, BARE));

  const response = await server.inject({ method: 'POST', url: '/api/feed-items/1/dismiss' });

  // Dismissing is core's own bookkeeping and asks the plugin nothing.
  assert.equal(response.statusCode, 200);
  assert.equal(getFeedItem(db, 1)?.dismissedAt, NOW);
  await server.close();
  db.close();
});

test('dismissing an item that parsed is a 409, and an unknown one a 404', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  const server = buildServer(deps(db));

  const parsed = await server.inject({ method: 'POST', url: '/api/feed-items/4/dismiss' });
  const missing = await server.inject({ method: 'POST', url: '/api/feed-items/99/dismiss' });

  assert.equal(parsed.statusCode, 409);
  assert.equal(missing.statusCode, 404);
  await server.close();
  db.close();
});

// --- Edit a group ------------------------------------------------------

test('patching a group returns it rewritten, with no merge', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedTwoGroups(db);
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'PATCH',
    url: '/api/groups/2',
    payload: { values: { title: 'Renamed' } },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body['mergedInto'], null);
  assert.equal(body['group']['id'], 2);
  assert.equal(body['group']['display']['title'], 'Renamed');
  await server.close();
  db.close();
});

test('a merge answers with the target group and names it in mergedInto', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedTwoGroups(db);
  const server = buildServer(deps(db));

  const body = (
    await server.inject({
      method: 'PATCH',
      url: '/api/groups/2',
      payload: { values: { key: 'k1' } },
    })
  ).json();

  // The client knows the source id — it sent it — so `mergedInto` naming the
  // target is what lets it drop one card and replace the other.
  assert.equal(body['mergedInto'], 1);
  assert.equal(body['group']['id'], 1);
  assert.deepEqual(
    body['group']['releases'].map((release: { id: number }) => release.id),
    [2, 1],
  );
  assert.equal(getGroup(db, 2), null);
  await server.close();
  db.close();
});

test('a merge refused for a group with a download is a 409 that says why', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedTwoGroups(db);
  insertDownload(db, 2, 2);
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'PATCH',
    url: '/api/groups/2',
    payload: { values: { key: 'k1' } },
  });

  assert.equal(response.statusCode, 409);
  assert.match(String(response.json()['error']), /has a download recorded against it/);
  assert.equal(getGroup(db, 2)?.identityKey, 'k2');
  await server.close();
  db.close();
});

test('patching an unknown group is a 404 and a malformed body a 400', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  const server = buildServer(deps(db));

  const missing = await server.inject({
    method: 'PATCH',
    url: '/api/groups/99',
    payload: { values: { key: 'k9' } },
  });
  const malformed = await server.inject({
    method: 'PATCH',
    url: '/api/groups/2',
    payload: { values: 'k9' },
  });

  assert.equal(missing.statusCode, 404);
  assert.equal(malformed.statusCode, 400);
  assert.equal(getGroup(db, 2)?.identityKey, 'k2');
  await server.close();
  db.close();
});

// --- Edit a release ----------------------------------------------------

test('patching a release returns the group holding the rescored release', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedTwoGroups(db);
  const server = buildServer(deps(db));

  // Release 2 belongs to group 2, which is unpicked and so is in the browse
  // list whatever its releases score. Group 1 is picked with nothing better on
  // offer and is *not* in that list, which is a different case — see below.
  const response = await server.inject({
    method: 'PATCH',
    url: '/api/releases/2',
    payload: { values: { res: '4320' } },
  });

  assert.equal(response.statusCode, 200);
  const group = response.json()['group'];
  assert.equal(group['id'], 2);
  assert.equal(group['releases'][0]['score'], 4320);
  assert.equal(group['releases'][0]['quality']['resolution'], 4320);
  assert.equal(getRelease(db, 2)?.score, 4320);
  // A correction is not an arrival: the card must not jump to the top.
  assert.equal(group['listRankAt'], 600);
  await server.close();
  db.close();
});

test('a release edit under a group that was never in the browse list answers null', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedTwoGroups(db);
  const server = buildServer(deps(db));

  // Group 1 is picked with nothing better on offer, so it is not in Browse and
  // rescoring its own picked release does not put it there.
  const response = await server.inject({
    method: 'PATCH',
    url: '/api/releases/1',
    payload: { values: { res: '2160' } },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json()['group'], null);
  assert.equal(getRelease(db, 1)?.score, 2160);
  await server.close();
  db.close();
});

test('a release edit that takes the group out of the browse list answers group: null', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedPickedWithUpgrade(db);
  const server = buildServer(deps(db));

  // Downgrading the 2160 below the picked 1080 clears the upgrade flag, and
  // that flag was the group's only claim to a place in Browse.
  const response = await server.inject({
    method: 'PATCH',
    url: '/api/releases/2',
    payload: { values: { res: '720' } },
  });

  assert.equal(response.statusCode, 200);
  // Null, not the group: a client handed the group patches the card back into
  // a list the group has left, and Pick on that card queues an *upgrade* to
  // the release just downgraded — which on import trashes the live 1080.
  assert.equal(response.json()['group'], null);
  assert.equal(getGroup(db, 1)?.upgradeReleaseId, null);
  assert.equal(browsableGroup(db, 1), null);
  const browse = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  assert.deepEqual(browse['groups'], []);
  await server.close();
  db.close();
});

test('a release edit that leaves the group listed still answers with the group', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedPickedWithUpgrade(db);
  const server = buildServer(deps(db));

  // Still better than the picked 1080, so the flag stands and so does the card.
  const body = (
    await server.inject({
      method: 'PATCH',
      url: '/api/releases/2',
      payload: { values: { res: '1440' } },
    })
  ).json();

  assert.equal(body['group']['id'], 1);
  assert.equal(body['group']['upgradeReleaseId'], 2);
  await server.close();
  db.close();
});

test('patching a release under a plugin with no manual hooks is a 409', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  const server = buildServer(deps(db, BARE));

  const response = await server.inject({
    method: 'PATCH',
    url: '/api/releases/1',
    payload: { values: { res: '2160' } },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(getRelease(db, 1)?.score, 720);
  await server.close();
  db.close();
});

test('patching an unknown release is a 404', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  const server = buildServer(deps(db));
  const response = await server.inject({
    method: 'PATCH',
    url: '/api/releases/99',
    payload: { values: { res: '2160' } },
  });
  assert.equal(response.statusCode, 404);
  await server.close();
  db.close();
});

// --- Identity preview --------------------------------------------------

test('manual-preview returns the identity key the values would produce', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/manual-preview',
    payload: { plugin: 'test', values: { key: 'k9', title: 'Nine' } },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { identityKey: 'k9' });
  // The only guard against a wrong manual identity is seeing it first, so the
  // preview must not be able to create one.
  assert.equal(groupCount(db), 0);
  await server.close();
  db.close();
});

test("manual-preview answers bad values with the plugin's complaint and writes nothing", async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/manual-preview',
    payload: { plugin: 'test', values: { key: '' } },
  });

  // A complaint is an answer, not a transport failure: the form asks this
  // while the user is still typing and shows whichever came back.
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { error: 'key is required' });
  assert.equal(groupCount(db), 0);
  await server.close();
  db.close();
});

test('manual-preview applies the checks a save would, not just the plugin’s', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const response = await server.inject({
    method: 'POST',
    url: '/api/manual-preview',
    payload: { plugin: 'test', values: { key: '!' } },
  });

  // A preview showing a key that saving would then refuse is worse than no
  // preview: it is the guard reporting all clear on the thing it guards.
  assert.equal(response.statusCode, 200);
  assert.match(String(response.json()['error']), /identityKey/);
  await server.close();
  db.close();
});

test('manual-preview refuses a plugin that cannot build a release', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db, BARE));

  const response = await server.inject({
    method: 'POST',
    url: '/api/manual-preview',
    payload: { plugin: 'test', values: { key: 'k9' } },
  });

  assert.equal(response.statusCode, 409);
  await server.close();
  db.close();
});

test('manual-preview 404s on an unknown plugin and 400s on a malformed body', async () => {
  const db = openTestDatabase();
  const server = buildServer(deps(db));

  const unknown = await server.inject({
    method: 'POST',
    url: '/api/manual-preview',
    payload: { plugin: 'nope', values: { key: 'k9' } },
  });
  const malformed = await server.inject({
    method: 'POST',
    url: '/api/manual-preview',
    payload: { values: { key: 'k9' } },
  });

  assert.equal(unknown.statusCode, 404);
  assert.equal(malformed.statusCode, 400);
  await server.close();
  db.close();
});

// --- Prefill values on the views ---------------------------------------

test('a group and its releases carry the values that would prefill an edit form', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedTwoGroups(db);
  const server = buildServer(deps(db));

  const body = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  const group = body['groups'].find((candidate: { id: number }) => candidate.id === 2);

  // The group's half is identity-only, which is exactly what a group edit
  // submits over: no quality, because a group holds none.
  assert.deepEqual(group['manualValues'], { key: 'k2', title: 'G2', res: '' });
  // The release's half needs the group's identity *and* that release's own
  // quality — a release row alone cannot produce it.
  assert.deepEqual(group['releases'][0]['manualValues'], {
    key: 'k2',
    title: 'G2',
    res: '2160',
  });
  await server.close();
  db.close();
});

test('a plugin without the prefill hook produces no manualValues at all', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedTwoGroups(db);
  const server = buildServer(deps(db, BARE));

  const body = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  const group = body['groups'][0];

  // Their absence is how the SPA decides not to offer an Edit control, so an
  // empty object here would put a form in front of a plugin that cannot read
  // one back.
  assert.equal('manualValues' in group, false);
  assert.equal('manualValues' in group['releases'][0], false);
  await server.close();
  db.close();
});

test('a plugin whose prefill hook throws costs the Edit control, not the list', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedTwoGroups(db);
  const server = buildServer(deps(db, THROWS_ON_PREFILL));

  const response = await server.inject({ method: 'GET', url: '/api/browse' });

  // Unguarded, this hook runs once per group and once per release on every
  // browse page, so one plugin throwing on one stored record would take the
  // whole list down rather than one card's Edit button.
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes('manualValues'), false);
  const group = response.json()['groups'][0];
  assert.equal('manualValues' in group, false);
  assert.equal('manualValues' in group['releases'][0], false);
  await server.close();
  db.close();
});

// --- A no-op save, against the real scenes plugin ----------------------

/**
 * Inserts one group per name, keyed exactly as the real parser keyed it.
 *
 * The stand-in plugin above cannot carry this case: its `toManualValues` and
 * `fromManualValues` are each other's exact inverse by construction, so no
 * arrangement of it can lose information between the two. The failure being
 * pinned is a *real* plugin's prefill being lossy about its own key, and only
 * the real plugin has it.
 */
function seedParsedGroups(
  db: DatabaseSync,
  plugin: MediaTypePlugin,
  names: readonly string[],
): ParsedRelease[] {
  return names.map((name, index) => {
    const id = index + 1;
    const media = plugin.parse(name);
    assert.ok(media !== null, name);
    db.prepare(
      `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
       VALUES (?, 'f', ?, ?, ?, 100)`,
    ).run(id, `g${id}`, name, `https://indexer.invalid/${id}.nzb`);
    db.prepare(
      `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                                 created_at, list_rank_at)
       VALUES (?, 'scenes', ?, ?, ?, 'new', 100, ?)`,
    ).run(
      id,
      media.identityKey,
      JSON.stringify(media.display),
      media.display.title.toLowerCase(),
      500 + id,
    );
    db.prepare(
      `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
       VALUES (?, ?, ?, ?, 0, 100)`,
    ).run(id, id, id, JSON.stringify(media.quality));
    return media;
  });
}

test('opening Edit on a listing group and saving nothing merges nothing', async () => {
  // Two different scenes on one site and one day. `prettify` rewrites the
  // `.-.` inside the first name's leading part as ` - `, which is also what
  // the delimited form joins its *parts* with — so both groups used to display
  // the identical title `Kylie - Page - Turner`, and the prefill built from
  // that title recovered the second group's part multiset for the first.
  //
  // At this level the consequence is the one that matters: a PATCH carrying
  // the row's own untouched prefill re-keyed group 1 onto group 2's key, which
  // moved its releases, deleted the `media_groups` row, and left two distinct
  // scenes as one.
  const db = openTestDatabase();
  const scenes = createScenesPlugin({});
  const [inner, outer] = seedParsedGroups(db, scenes, [
    '[Vixen] Kylie.-.Page - Turner - 2023-07-19',
    '[Vixen] Kylie - Page - Turner - 2023-07-19',
  ]);
  assert.ok(inner !== undefined && outer !== undefined);
  assert.notEqual(inner.identityKey, outer.identityKey);

  const server = buildServer(deps(db, scenes));
  const browse = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  const listed = browse['groups'].find((candidate: { id: number }) => candidate.id === 1);
  const untouched = listed['manualValues'] as Record<string, string>;

  // Spec §11 calls this preview the only guard against a wrong manual
  // identity. A preview that confidently shows another group's key is not a
  // guard, so it is asserted before the save that would act on it.
  const preview = await server.inject({
    method: 'POST',
    url: '/api/manual-preview',
    payload: { plugin: 'scenes', values: untouched },
  });
  assert.deepEqual(preview.json(), { identityKey: inner.identityKey });

  const patched = await server.inject({
    method: 'PATCH',
    url: '/api/groups/1',
    payload: { values: untouched },
  });

  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json()['mergedInto'], null);
  assert.equal(groupCount(db), 2);
  assert.equal(getGroup(db, 1)?.identityKey, inner.identityKey);
  assert.equal(getGroup(db, 2)?.identityKey, outer.identityKey);
  await server.close();
  db.close();
});

test('a group stored by the pre-fix parser survives opening Edit and saving nothing', async () => {
  // Seeded by hand, not by the parser, because the parser is fixed and the
  // stored rows are not: `insertGroup` writes `media_groups.display` once and
  // no later ingest rewrites it, and `toGroupView` builds the prefill by
  // `JSON.parse`ing that column rather than re-parsing the release name. So a
  // row written before `collapsePartSeparator` landed still holds the lossy
  // three-part title beside its two-part key, and the prefill built from it
  // used to re-key the group on a save that changed nothing — with no sibling
  // to merge into, silently, moving a library directory already on disk.
  const db = openTestDatabase();
  const scenes = createScenesPlugin({});
  const storedKey = 'vixen:2023-07-19:kylie-page--turner';
  const storedDisplay = {
    title: 'Kylie - Page - Turner',
    subtitle: 'Vixen',
    date: '2023-07-19',
    fields: [
      { label: 'Site', value: 'Vixen' },
      { label: 'Date', value: '2023-07-19' },
      { label: 'Scene', value: 'Kylie - Page - Turner' },
    ],
  };
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', '[Vixen] Kylie.-.Page - Turner - 2023-07-19',
             'https://indexer.invalid/1.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               created_at, list_rank_at)
     VALUES (1, 'scenes', ?, ?, 'kylie - page - turner', 'new', 100, 501)`,
  ).run(storedKey, JSON.stringify(storedDisplay));
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"extras":{}}', 0, 100)`,
  ).run();

  const server = buildServer(deps(db, scenes));
  const browse = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  const listed = browse['groups'].find((candidate: { id: number }) => candidate.id === 1);
  const untouched = listed['manualValues'] as Record<string, string>;

  const preview = await server.inject({
    method: 'POST',
    url: '/api/manual-preview',
    payload: { plugin: 'scenes', values: untouched },
  });
  assert.deepEqual(preview.json(), { identityKey: storedKey });

  const patched = await server.inject({
    method: 'PATCH',
    url: '/api/groups/1',
    payload: { values: untouched },
  });

  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json()['mergedInto'], null);
  assert.equal(groupCount(db), 1);
  assert.equal(getGroup(db, 1)?.identityKey, storedKey);
  await server.close();
  db.close();
});

test('every manual route answers a group view the browse list would agree with', async () => {
  const db = openTestDatabase();
  seedFeedItems(db);
  seedTwoGroups(db);
  const server = buildServer(deps(db));

  const patched = (
    await server.inject({
      method: 'PATCH',
      url: '/api/groups/2',
      payload: { values: { title: 'Renamed' } },
    })
  ).json()['group'];
  const browse = (await server.inject({ method: 'GET', url: '/api/browse' })).json();
  const listed = browse['groups'].find((candidate: { id: number }) => candidate.id === 2);

  // The SPA patches this card straight in, so the two have to be the same
  // object down to the prefill values.
  assert.deepEqual(listed, patched);
  await server.close();
  db.close();
});
