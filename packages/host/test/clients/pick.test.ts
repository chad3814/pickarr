/**
 * `requestPick`, the wrapper that turns `Host.requestDownload`'s throws into
 * returned refusals.
 *
 * **Almost every test here drives a real host over a real database**, rather
 * than handing `requestPick` a double that throws the class the assertion
 * expects. A double-only suite would pin the mapping and nothing else: it
 * would stay green if `selectClientForFeed` stopped throwing
 * `NoClientOfTypeError`, if `requestDownload` stopped distinguishing a
 * missing row from an unregistered plugin, or if either partial unique
 * index on the download tables were dropped -- which is to say it would pin
 * the half of the behaviour that cannot break on its own. Every condition
 * is therefore *constructed* here, in the database, and the refusal is read
 * off the far end.
 *
 * **Three of them construct `already-submitted`'s boundary rather than just
 * its code**, because the whole-branch review found that the one test which
 * existed could not see the defect it was aimed at: it seeded a feed that
 * *named* its client, so no draw happened, and the case where a draw sends
 * the second pick somewhere else -- the case where duplicate detection
 * actually failed -- was the one it could not build. The three are the
 * named-client case, the drawn case, and the `failed` case that must still
 * be allowed through.
 *
 * The two tests that do use a double are the two that cannot be constructed:
 * "a rejection that is not a refusal is rethrown" needs an error no
 * condition produces, and the mutation guard needs to observe a return where
 * a throw would also have been possible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaPlugin } from '@pickarr/contract';
import { REQUEST_PICK_REFUSALS } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createHost } from '../../src/host.ts';
import type { Host } from '../../src/host.ts';
import { requestPick } from '../../src/clients/pick.ts';
import { UnknownRssItemError } from '../../src/errors.ts';
import { createDownloadClients } from '../../src/clients/downloads.ts';
import type { ChooseIndex } from '../../src/clients/select.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import { writeSecretValue } from '../../src/secrets/store.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';

/**
 * The magnet every torrent seeded below links to, and the infohash
 * `infohashFromMagnet` reads out of it -- which is also the `client_ref`
 * qBittorrent's adapter reports back, and therefore what a `submitted` row
 * in this file carries. Mirrors `downloads.test.ts`'s pair.
 *
 * It is no longer what a second pick at the same release collides on: since
 * migration 18 that is refused at the insert, by the index on
 * `rss_item_id`, before a reference is asked for. `MAGNET_HASH` is still
 * asserted here, as the evidence that a pick really reached the client.
 */
const MAGNET = 'magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=Some.Show';
const MAGNET_HASH = '0123456789abcdef0123456789abcdef01234567';

/**
 * Where a `createSecrets` chain in this file would look for a file-backed
 * credential. It does not exist, so every value comes from the `secret`
 * table {@link seedClient} wrote it to.
 */
const NO_SECRETS_DIR = '/nonexistent/pickarr-pick-test-secrets';

/**
 * No test here attaches artwork, so this is never created or written to --
 * `createArtworkStore` only touches the filesystem from its first `put()`.
 */
const UNUSED_ARTWORK_DIR = '/nonexistent/pickarr-pick-test-artwork';

/** A fixed clock: nothing here asserts on a timestamp, but a real one would make rows non-reproducible. */
const NOW = 7000;

/**
 * qBittorrent's adapter posts and reads a body back; `'Ok.'` is what a
 * successful add answers. `json` and `bytes` are absent and throw, so a test
 * that unexpectedly reached SABnzbd's adapter or an artwork fetch would fail
 * loudly rather than quietly resolve.
 */
const OK_FETCH: QueuedFetch = {
  snapshot: () => [],
  json: async () => { throw new Error('fetch.json: not used by this test'); },
  bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  text: async () => 'Ok.',
};

/**
 * The chooser every test here passes. No feed below has two clients of one
 * type, so `selectClientForFeed` settles without a draw -- reaching a
 * chooser would mean a selection this file did not intend, which this turns
 * into a failure rather than a coincidence. The same idiom
 * `downloads.test.ts`'s `refuseToChoose` uses.
 */
function refuseToChoose(): never {
  throw new Error('the chooser was consulted for a feed this test gave one unambiguous client');
}

/** An entry point a plugin under test never expects to be reached. */
function unusedEntryPoint(name: string): () => Promise<never> {
  return async () => { throw new Error(`${name}: not used by this test`); };
}

/**
 * The plugin every host below registers: it submits, and says nothing about
 * which client to submit to.
 *
 * That omission is the point rather than a simplification -- it is exactly
 * what `packages/openmetadata`'s own `onDownloadRequest` does since the
 * previous task, so the client resolution these tests exercise is the host's
 * `selectClientForFeed` and not a guess the plugin made.
 */
function pickingPlugin(id: string): MediaPlugin {
  return {
    id,
    mediaType: 'movie',
    migrations: [],
    jobs: {},
    synced: [],
    tokens: {},
    onNewRssItems: unusedEntryPoint('onNewRssItems'),
    onDownloadedFile: unusedEntryPoint('onDownloadedFile'),
    onDownloadRequest: async (rssItemId, ctx) => {
      await ctx.downloads.submit({ rssItemId });
    },
    onMediaItemDropped: unusedEntryPoint('onMediaItemDropped'),
    onLookupRequest: unusedEntryPoint('onLookupRequest'),
  };
}

/**
 * A host wired to the real download subsystem over `raw`, with `alpha`
 * registered.
 *
 * Both dependencies a test may need to vary are parameters with the
 * defaults every test but two takes: {@link OK_FETCH}, whose adapter always
 * succeeds, and {@link refuseToChoose}, which fails rather than silently
 * settling a draw. The two that override them are the ones that need a
 * feed with several candidate clients (the draw), and the one that needs a
 * first submission to fail (the fetch).
 */
function setup(options: { fetch?: QueuedFetch; chooseIndex?: ChooseIndex } = {}): { raw: DatabaseSync; host: Host } {
  const fetch = options.fetch ?? OK_FETCH;
  const chooseIndex = options.chooseIndex ?? refuseToChoose;
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const host = createHost({
    raw,
    db,
    fetch,
    downloads: (secrets) => createDownloadClients({
      raw,
      fetch,
      secrets,
      now: () => NOW,
      chooseIndex,
      log: () => {},
    }),
    secrets: createSecrets({ raw, baseDir: NO_SECRETS_DIR }),
    now: () => NOW,
    artworkDir: UNUSED_ARTWORK_DIR,
    // No `timers` and no `start()`: nothing here runs a job, so the
    // dispatcher arms nothing and this test creates no real timer.
  });
  host.register(pickingPlugin('alpha'));
  return { raw, host };
}

/** Inserts one `download_client` row, with its credential in `secret`, and returns its id. */
function seedClient(raw: DatabaseSync, overrides: { name?: string; type?: string; implementation?: string } = {}): number {
  const row = { name: 'Client', type: 'torrent', implementation: 'qbittorrent', ...overrides };
  const apiKeySecretName = `${row.name.toLowerCase()}-api-key`;
  writeSecretValue(raw, apiKeySecretName, 'not-a-real-key', 1);
  const result = raw.prepare(`
    INSERT INTO download_client
      (name, type, implementation, url, api_key_secret_name, username, password_secret_name,
       category, import_mode, created_at, updated_at)
    VALUES (?, ?, ?, 'https://client.example.com', ?, NULL, NULL, 'movies', 'copy', 1, 1)
  `).run(row.name, row.type, row.implementation, apiKeySecretName);
  return Number(result.lastInsertRowid);
}

/** Inserts one `rss_feed` row and returns its id. */
function seedFeed(raw: DatabaseSync, overrides: {
  pluginId?: string;
  name?: string;
  downloadType?: string;
  downloadClientId?: number | null;
} = {}): number {
  const row = { pluginId: 'alpha', name: 'Feed', downloadType: 'torrent', downloadClientId: null, ...overrides };
  const result = raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, download_client_id, download_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1)
  `).run(row.pluginId, row.name, `https://example.test/${row.name}`, row.downloadClientId, row.downloadType);
  return Number(result.lastInsertRowid);
}

/** Inserts one `rss_item` row linking to {@link MAGNET} and returns its id. */
function seedRssItem(raw: DatabaseSync, feedId: number, downloadType = 'torrent'): number {
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, lookup_state)
    VALUES (?, 'Some Show', ?, 1, 1, ?, 'pending')
  `).run(feedId, MAGNET, downloadType);
  return Number(result.lastInsertRowid);
}

/**
 * Every refusal code a test in this file has actually watched come back out
 * of `requestPick`, recorded by {@link pickWithoutThrowing} as each one
 * runs. The last test in the file is the only reader.
 *
 * **This set is what makes that test's name true.** It used to compare
 * `REQUEST_PICK_REFUSALS` against a literal list written three lines above
 * the assertion, which checks only that the contract still holds five
 * particular strings: deleting any one of the condition tests below left it
 * green, because the literal was still sitting there. Reading what the
 * tests *observed* is the difference between "these five strings are
 * declared" and "these five conditions were constructed and each produced
 * its code".
 *
 * **What it does not promise**, so the name is not read as stronger than it
 * is: a code counts as covered wherever it was produced, so deleting the
 * dedicated `no-client-of-type` test would still leave the set complete
 * while the shape test below happens to construct that same condition. The
 * guarantee is that every code is reached by some condition in this file,
 * which is what the title claims and no more.
 */
const observedRefusals = new Set<string>();

/**
 * Calls `host.requestPick`, fails if it *rejects*, and records any refusal
 * it saw in {@link observedRefusals}.
 *
 * **The reject check is the invariant the whole slice turns on, so it is
 * asserted rather than assumed by every test below.** `requestDownload`
 * throws where the two other write paths return refusals as values;
 * `requestPick` exists to convert that, and a test written as
 * `await assert.rejects(...)` would be asserting the very bug this function
 * was added to remove. Wrapping the call is what makes a regression read as
 * "it threw" rather than as an unhandled rejection somewhere in the
 * runner's output.
 */
async function pickWithoutThrowing(host: Host, rssItemId: number): Promise<unknown> {
  try {
    const result = await host.requestPick(rssItemId);
    if ('refusal' in result) observedRefusals.add(result.refusal);
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    assert.fail(`requestPick rejected instead of returning a refusal: ${detail}`);
  }
}

test('a feed naming no client, with one client of its type, picks successfully', async () => {
  // Design spec §8.2: the case that failed before the previous task, when
  // the plugin read `rss_feed.download_client_id` itself and threw on NULL.
  const { raw, host } = setup();
  const clientId = seedClient(raw, { name: 'QBT' });
  const feedId = seedFeed(raw, { downloadClientId: null });
  const itemId = seedRssItem(raw, feedId);

  const result = await pickWithoutThrowing(host, itemId);

  assert.deepEqual(result, { accepted: true });
  // The answer alone would be satisfied by a `requestPick` that swallowed
  // everything, so the effect is read too: the pick really did reach the
  // client and really was recorded against the one client of its type.
  const row = raw.prepare(
    'SELECT download_client_id, client_ref, status FROM torrent_download WHERE rss_item_id = ?',
  ).get(itemId);
  assert.deepEqual({ ...row }, { download_client_id: clientId, client_ref: MAGNET_HASH, status: 'submitted' });
});

test('an rss item id nothing is on file under is refused as unknown-release, not thrown', async () => {
  const { raw, host } = setup();
  seedClient(raw, { name: 'QBT' });
  const feedId = seedFeed(raw);
  const onFile = seedRssItem(raw, feedId);

  // One past the only row there is, so this names nothing while the table
  // is non-empty -- an empty table would also be refused by a `requestPick`
  // that refused every id.
  const result = await pickWithoutThrowing(host, onFile + 1);

  assert.deepEqual(result, { refusal: 'unknown-release' });
  assert.equal(
    Number((raw.prepare('SELECT COUNT(*) AS n FROM torrent_download').get() as { n: unknown }).n),
    0,
    'and nothing was submitted for it',
  );
});

test("an item whose feed names an unregistered plugin is refused as plugin-not-registered, not thrown", async () => {
  const { raw, host } = setup();
  seedClient(raw, { name: 'QBT' });
  // `ghost` is never registered; `alpha` is. A feed owned by `alpha` in the
  // same database is what keeps this from passing for a host with no
  // plugins at all.
  const ghostFeed = seedFeed(raw, { pluginId: 'ghost', name: 'GhostFeed' });
  const itemId = seedRssItem(raw, ghostFeed);

  const result = await pickWithoutThrowing(host, itemId);

  assert.deepEqual(result, { refusal: 'plugin-not-registered' });
});

test('a feed with no client of its type is refused as no-client-of-type, not thrown', async () => {
  const { raw, host } = setup();
  // An nzb client exists, so this is "none of *this* type" rather than "no
  // clients at all" -- the two would be indistinguishable with an empty
  // `download_client` table.
  seedClient(raw, { name: 'SAB', type: 'nzb', implementation: 'sabnzbd' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: null });
  const itemId = seedRssItem(raw, feedId);

  const result = await pickWithoutThrowing(host, itemId);

  assert.deepEqual(result, { refusal: 'no-client-of-type' });
});

test('a feed naming a client of the wrong type is refused as client-type-mismatch, not thrown', async () => {
  const { raw, host } = setup();
  const nzbClientId = seedClient(raw, { name: 'SAB', type: 'nzb', implementation: 'sabnzbd' });
  // A torrent client exists too, so `selectClientForFeed` had a usable
  // candidate and refused anyway because the feed named the other one --
  // which is what makes this a mismatch rather than a shortage.
  seedClient(raw, { name: 'QBT' });
  const feedId = seedFeed(raw, { downloadType: 'torrent', downloadClientId: nzbClientId });
  const itemId = seedRssItem(raw, feedId);

  const result = await pickWithoutThrowing(host, itemId);

  assert.deepEqual(result, { refusal: 'client-type-mismatch' });
});

test('picking the same release twice is refused as already-submitted by the real unique index, not thrown', async () => {
  // The refusal that is *caught*, never pre-checked. The first pick leaves
  // a live `torrent_download` row on this release; the second's INSERT
  // collides with migration 18's partial unique index on `rss_item_id`
  // before any client is called. No code asked "has this been submitted?",
  // which is what makes two concurrent picks unable to both pass a check
  // and then race the same constraint -- the insert is synchronous and
  // happens before `submit` awaits anything.
  //
  // **This test used to describe the `(download_client_id, client_ref)`
  // index**, which collided on the `UPDATE` that writes the reference back.
  // That index still exists and still catches its own case; it is no longer
  // the one this reaches, because the release index refuses two statements
  // earlier. `downloads.test.ts` has the case that still reaches the other.
  const { raw, host } = setup();
  const clientId = seedClient(raw, { name: 'QBT' });
  const feedId = seedFeed(raw, { downloadClientId: clientId });
  const itemId = seedRssItem(raw, feedId);

  assert.deepEqual(await pickWithoutThrowing(host, itemId), { accepted: true }, 'the first pick must succeed');

  const second = await pickWithoutThrowing(host, itemId);

  assert.deepEqual(second, { refusal: 'already-submitted' });

  // The index really is what refused: had it been dropped, the second pick
  // would have written a second row and answered `accepted`. And the row it
  // does *not* write is the whole of the review's I3 -- the refused attempt
  // used to leave a `failed` row that `ReleaseList` rendered forever beside
  // the `submitted` one, with no surface to clear it.
  const rows = raw.prepare(
    'SELECT status FROM torrent_download WHERE rss_item_id = ? ORDER BY id',
  ).all(itemId).map((row) => String((row as { status: unknown }).status));
  assert.deepEqual(rows, ['submitted'], 'the original row survives and the refused attempt writes nothing');
});

test('a second pick is refused even when the draw lands on a different client', async () => {
  // **The case the test above cannot see, and the one the whole-branch
  // review measured as accepted twice.** That test seeds a feed that
  // *names* its client, so no draw happens and the second pick necessarily
  // reaches the same client and collides on `(download_client_id,
  // client_ref)`. Here the feed names none and two clients match its type,
  // so `selectClientForFeed` draws -- and a draw that answers 1 the second
  // time sends the second pick to a client that has never seen this
  // reference. Before the `rss_item_id` index, that second pick answered
  // `{ accepted: true }` and left two clients downloading the same file.
  //
  // `0` then `1` are both legal answers of a real draw over two
  // candidates, which is what makes this a behaviour and not a contrived
  // chooser: nothing here asks the chooser for anything `randomIndex`
  // could not have answered.
  const draws = [0, 1];
  let draw = 0;
  const chooseIndex: ChooseIndex = (count) => {
    const answer = draws[draw];
    draw += 1;
    if (answer === undefined || answer >= count) {
      throw new Error(`the chooser was consulted ${String(draw)} times over ${String(count)} candidates`);
    }
    return answer;
  };
  const { raw, host } = setup({ chooseIndex });
  const first = seedClient(raw, { name: 'QBT-A' });
  const second = seedClient(raw, { name: 'QBT-B' });
  const feedId = seedFeed(raw, { downloadClientId: null });
  const itemId = seedRssItem(raw, feedId);

  assert.deepEqual(await pickWithoutThrowing(host, itemId), { accepted: true }, 'the first pick must succeed');

  const result = await pickWithoutThrowing(host, itemId);

  assert.deepEqual(result, { refusal: 'already-submitted' });
  assert.equal(draw, 2, 'both picks drew, so the second really did resolve a client of its own');
  // Read across both clients rather than filtered to either: the defect
  // was one row per client, and a query naming one client would show
  // exactly one row whether or not the second was written.
  const rows = raw.prepare(
    'SELECT download_client_id, status FROM torrent_download WHERE rss_item_id = ? ORDER BY id',
  ).all(itemId).map((row) => ({
    client: Number((row as { download_client_id: unknown }).download_client_id),
    status: String((row as { status: unknown }).status),
  }));
  assert.deepEqual(
    rows,
    [{ client: first, status: 'submitted' }],
    'one live download for the release, and no row at all for the client the second draw reached',
  );
  assert.notEqual(first, second, 'the two clients are distinct, so the draw had somewhere else to land');
});

test('a release whose only download failed can be picked again', async () => {
  // The other half of the definition: `failed` is the one status that does
  // *not* block, so a pick that produced no download is not permanent.
  // Constructed rather than asserted -- the first submission fails at the
  // client, which is the only way this schema produces a `failed` row.
  let calls = 0;
  const failThenSucceed: QueuedFetch = {
    ...OK_FETCH,
    text: async () => {
      calls += 1;
      // qBittorrent answers a refused add with HTTP 200 and this body, which
      // `clients/qbittorrent.ts` turns into a throw -- so the row is marked
      // `failed` by the real path rather than by a hand-written UPDATE.
      return calls === 1 ? 'Fails.' : 'Ok.';
    },
  };
  const { raw, host } = setup({ fetch: failThenSucceed });
  const clientId = seedClient(raw, { name: 'QBT' });
  const feedId = seedFeed(raw, { downloadClientId: clientId });
  const itemId = seedRssItem(raw, feedId);

  // Not a refusal: a client that refused the add is an infrastructure
  // fault and reaches the route as a 500, which is `pick.ts`'s rule for
  // everything that is not one of the five.
  await assert.rejects(host.requestPick(itemId));
  assert.deepEqual(
    raw.prepare('SELECT status FROM torrent_download WHERE rss_item_id = ?')
      .all(itemId).map((row) => String((row as { status: unknown }).status)),
    ['failed'],
    'the first attempt left a failed row and nothing else',
  );

  const result = await pickWithoutThrowing(host, itemId);

  assert.deepEqual(result, { accepted: true }, 'a failed download does not block a re-pick');
  assert.deepEqual(
    raw.prepare('SELECT status FROM torrent_download WHERE rss_item_id = ? ORDER BY id')
      .all(itemId).map((row) => String((row as { status: unknown }).status)),
    ['failed', 'submitted'],
    'the failed attempt is kept as history beside the download that worked',
  );
});

test('a refusal carries the code and nothing else', async () => {
  // Global Constraint: no credential, url or path in any message or body,
  // and a refusal distinguishable without parsing prose. Every condition
  // above has a message behind it naming a feed, a client or an id; none of
  // that may ride out on the value, so the shape is asserted by key rather
  // than by `deepEqual` alone -- an extra `message` property would satisfy
  // a `.refusal` check.
  const { raw, host } = setup();
  seedClient(raw, { name: 'SAB', type: 'nzb', implementation: 'sabnzbd' });
  const feedId = seedFeed(raw, { name: 'A Feed Whose Name Must Not Escape', downloadType: 'torrent' });
  const itemId = seedRssItem(raw, feedId);

  const result = await pickWithoutThrowing(host, itemId);

  assert.ok(result !== null && typeof result === 'object');
  assert.deepEqual(Object.keys(result), ['refusal']);
  assert.ok(!JSON.stringify(result).includes('A Feed Whose Name Must Not Escape'));
  assert.ok(!JSON.stringify(result).includes('client.example.com'));
});

test('a rejection that is not a refusal is rethrown, so a bug cannot arrive as a pick outcome', async () => {
  // The other half of "every refusal is a returned value": a `requestPick`
  // that answered a refusal for *every* throw would pass all six tests
  // above and silently turn a corrupt row, a closed database or a plugin
  // bug into something a browser renders as an ordinary "no" -- and the
  // route maps every refusal to a 4xx, so the 500 those deserve would never
  // be answered. A double is the only way to raise an error no condition in
  // this schema produces.
  const boom = new Error('the database went away');
  await assert.rejects(
    requestPick({ requestDownload: async () => { throw boom; } }, 1),
    (err: unknown) => err === boom,
  );
});

test('requestPick returns its refusal rather than rejecting with it', async () => {
  // The mutation guard, stated on its own rather than left implicit in the
  // six tests above: `requestPick` is a converter, and a converter that
  // rethrows what it recognised has done nothing. Driven through a double
  // so the throw is unambiguous -- `UnknownRssItemError` is the class
  // `requestDownload` raises for an id nothing is on file under.
  const result = await requestPick(
    { requestDownload: async () => { throw new UnknownRssItemError(42); } },
    42,
  );
  assert.deepEqual(result, { refusal: 'unknown-release' });
});

/**
 * Declared last on purpose: node's runner executes a file's top-level tests
 * in declaration order, and this one reads what every test above it
 * observed. A condition test that fails before recording fails this one
 * too, which is a cascade rather than a second, separate finding.
 */
test('every refusal code the contract declares is produced by a condition above', () => {
  // Compared against what the tests actually saw, not against a literal
  // list -- see `observedRefusals`. Both directions in one `deepEqual`: a
  // sixth code added to `REQUEST_PICK_REFUSALS` with no condition behind it
  // reds here, and so does a code this file produces that the contract does
  // not declare.
  assert.deepEqual(
    [...observedRefusals].toSorted(),
    REQUEST_PICK_REFUSALS.toSorted(),
    'each code must have been seen coming back from requestPick, not merely declared',
  );
});
