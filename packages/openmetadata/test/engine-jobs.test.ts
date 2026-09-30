import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTWORK_JOB } from '../src/artwork/job.ts';
import { VIDEO_RESOLUTION_BACKFILL_JOB } from '../src/backfill.ts';
import { LOOKUP_JOB, POLL_JOB, createLookupPlugin } from '../src/engine.ts';
import {
  createFakeLookupService,
  createTestHarness,
  partialEnvelope,
  refusedEnvelope,
  resolvedEnvelope,
} from '../src/testing.ts';
import { MAX_BATCH } from '../src/client.ts';
import { placementTableMigration } from '../src/placement.ts';
import type { Expectation } from '../src/select.ts';
import type { ApplyArgs } from '../src/engine.ts';
import type { LookupEnvelope, Media } from '../src/types.ts';
import type {
  DownloadEntry,
  DownloadSubmission,
  DownloadedFile,
  HostFetch,
  PluginContext,
  TokenResolver,
} from '@pickarr/contract';

const NOW = 1_700_000_000_000;

/**
 * Three resolvers that answer something traceable to their argument, so a
 * test can tell which token produced which value in the map the engine
 * builds -- three copies of `async () => null` would make the whole map one
 * indistinguishable answer.
 */
const siteToken: TokenResolver = async (file) => `site-${file.rssItemId}`;
const titleToken: TokenResolver = async (file) => (
  file.mediaItemId === null ? null : `title-${file.mediaItemId}`
);
const extToken: TokenResolver = async (file) => file.path.split('.').pop() ?? null;

/** The two-token map most of the specs below declare. */
const NAMED_TOKENS = { site: siteToken, title: titleToken };

function sceneMedia(providerRef: string): Media {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    kind: 'scene',
    title: 'A Scene',
    releaseDate: '2026-01-15',
    year: 2026,
    provider: 'tpdb',
    providerRef,
    overview: null,
    details: { siteName: 'A Site', siteRef: 'tpdb:site:7' },
    parents: [],
    people: [],
  };
}

/** The plugin under test: the engine, with an `apply` that only records. */
function build(service?: { fetch: HostFetch }, expectation: Expectation = { kind: 'single' }) {
  const applied: ApplyArgs[] = [];
  const plugin = createLookupPlugin({
    id: 'xxx',
    mediaType: 'xxx',
    category: 'xxx',
    migrations: [placementTableMigration('xxx', 2)],
    // A scene is all this spec is ever handed, so the pre-flight has nothing
    // to refuse -- these tests are about jobs, not about what a plugin accepts.
    check: (): void => {},
    apply: async (args) => { applied.push(args); },
    // Not the real xxx plugin's list -- that one is asserted in the host,
    // against the plugin the host actually builds. Here it only has to be
    // something the engine can be seen to pass through unchanged, and each
    // resolver answers a value derived from its argument so a test can tell
    // which token produced which string.
    tokens: NAMED_TOKENS,
    expects: async () => expectation,
  }, {
    now: () => NOW,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });
  const harness = service === undefined
    ? createTestHarness()
    : createTestHarness({ fetch: service.fetch });
  // The engine's own migration, plus whatever the spec added.
  for (const migration of plugin.migrations) migration.up(harness.raw);
  return { plugin, harness, applied };
}

test('carries the engine state table as migration 1, before the spec migrations', () => {
  const plugin = createLookupPlugin({
    id: 'xxx',
    mediaType: 'xxx',
    category: 'xxx',
    migrations: [{ version: 2, up: (db) => db.exec('CREATE TABLE xxx_own (id INTEGER PRIMARY KEY)') }],
    check: (): void => {},
    apply: async () => {},
    tokens: NAMED_TOKENS,
    expects: async () => ({ kind: 'single' }),
  }, { now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'test-key' });

  assert.deepEqual(plugin.migrations.map((migration) => migration.version), [1, 2]);
  assert.equal(plugin.id, 'xxx');
  assert.equal(plugin.mediaType, 'xxx');
  assert.deepEqual(Object.keys(plugin.jobs).toSorted(), [ARTWORK_JOB, LOOKUP_JOB, POLL_JOB, VIDEO_RESOLUTION_BACKFILL_JOB]);
});

test("carries the spec's tokens through to the plugin, unchanged and unmerged", () => {
  const plugin = createLookupPlugin({
    id: 'xxx',
    mediaType: 'xxx',
    category: 'xxx',
    migrations: [],
    check: (): void => {},
    apply: async () => {},
    tokens: { site: siteToken, title: titleToken, ext: extToken },
    expects: async () => ({ kind: 'single' }),
  }, { now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'test-key' });

  // The exact map, in order, and identical resolvers. The engine adds
  // nothing of its own here -- unlike `migrations`, where it prepends its
  // state table. A shared `filename`/`ext` tail merged in by the engine
  // would be invisible to the plugin declaring the list, and this is what
  // says it is not doing that.
  assert.deepEqual(Object.keys(plugin.tokens), ['site', 'title', 'ext']);
  assert.equal(plugin.tokens['site'], siteToken);
  assert.equal(plugin.tokens['title'], titleToken);
  assert.equal(plugin.tokens['ext'], extToken);
});

test('keeps a spec job handler alongside its own two', () => {
  const plugin = createLookupPlugin({
    id: 'xxx',
    mediaType: 'xxx',
    category: 'xxx',
    migrations: [],
    jobs: { sweep: async () => {} },
    check: (): void => {},
    apply: async () => {},
    tokens: NAMED_TOKENS,
    expects: async () => ({ kind: 'single' }),
  }, { now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'test-key' });

  assert.deepEqual(Object.keys(plugin.jobs).toSorted(), [ARTWORK_JOB, LOOKUP_JOB, POLL_JOB, 'sweep', VIDEO_RESOLUTION_BACKFILL_JOB]);
});

test('records a row per new rss item and one lookup job for the batch', async () => {
  const { plugin, harness } = build();
  const first = harness.insertRssItem('a.mp4');
  const second = harness.insertRssItem('b.mp4');

  await plugin.onNewRssItems([first, second], harness.ctx);

  assert.equal(harness.enqueued.length, 1);
  assert.equal(harness.enqueued[0]?.kind, LOOKUP_JOB);
  assert.deepEqual(harness.enqueued[0]?.payload, { rssItemIds: [first, second] });
  const rows = harness.raw.prepare('SELECT rss_item_id, lookup_job_id FROM xxx_lookup ORDER BY rss_item_id').all();
  assert.deepEqual(rows.map((row) => Object.assign({}, row)), [
    { rss_item_id: first, lookup_job_id: 1 },
    { rss_item_id: second, lookup_job_id: 1 },
  ]);
});

test('a re-offered batch recovers instead of colliding with its own rows', async () => {
  const { plugin, harness } = build();
  const first = harness.insertRssItem('a.mp4');
  const second = harness.insertRssItem('b.mp4');

  // The host's feed reader marks *nothing* delivered when a plugin's
  // `onNewRssItems` rejects (`feeds/reader.ts`: a feed names one plugin, so
  // a failure is all-or-nothing for the batch), so the very same ids arrive
  // again on the next poll. If the insert were a plain one it would throw
  // `UNIQUE constraint failed` here -- forever, and for every later item on
  // that feed too, because the batch would never be delivered again.
  await plugin.onNewRssItems([first, second], harness.ctx);
  await plugin.onNewRssItems([first, second], harness.ctx);

  const rows = harness.raw.prepare('SELECT rss_item_id, lookup_job_id FROM xxx_lookup ORDER BY rss_item_id').all();
  assert.deepEqual(rows.map((row) => Object.assign({}, row)), [
    { rss_item_id: first, lookup_job_id: 2 },
    { rss_item_id: second, lookup_job_id: 2 },
  ], 'one row per rss item, each naming the job that will now identify it');
  assert.equal(harness.enqueued.length, 2, 'the second offer enqueues its own lookup job');
});

test('asks about nothing, and enqueues nothing, for an empty batch', async () => {
  const { plugin, harness } = build();
  await plugin.onNewRssItems([], harness.ctx);
  assert.equal(harness.enqueued.length, 0);
  assert.equal(harness.raw.prepare('SELECT count(*) AS n FROM xxx_lookup').get()?.['n'], 0);
});

test('splits more than one batch of ids into one job each', async () => {
  const { plugin, harness } = build();
  const ids = Array.from({ length: MAX_BATCH + 1 }, (_, index) => harness.insertRssItem(`n-${index}.mp4`));

  await plugin.onNewRssItems(ids, harness.ctx);

  assert.equal(harness.enqueued.length, 2);
  const [firstJob, secondJob] = harness.enqueued;
  assert.ok(firstJob !== undefined && secondJob !== undefined);
  assert.equal((firstJob.payload as { rssItemIds: number[] }).rssItemIds.length, MAX_BATCH);
  assert.equal((secondJob.payload as { rssItemIds: number[] }).rssItemIds.length, 1);
  // Each row records the job that covers it, not merely the last one enqueued.
  const lastId = ids.at(-1);
  assert.ok(lastId !== undefined);
  const last = harness.raw.prepare('SELECT lookup_job_id FROM xxx_lookup WHERE rss_item_id = ?')
    .get(lastId);
  assert.equal(last?.['lookup_job_id'], 2);
});

test('the lookup handler asks about every name in the payload and applies each answer', async () => {
  const batch = new Map<string, LookupEnvelope>([
    ['a.mp4', resolvedEnvelope({ lookupId: 'lookup-a', media: sceneMedia('tpdb:scene:1') })],
    ['b.mp4', refusedEnvelope({ lookupId: 'lookup-b', refusal: 'a sidecar' })],
  ]);
  const service = createFakeLookupService({ batch, polls: new Map() });
  const { plugin, harness, applied } = build(service);
  const first = harness.insertRssItem('a.mp4');
  const second = harness.insertRssItem('b.mp4');
  harness.raw.prepare('INSERT INTO xxx_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?), (?, ?, ?)')
    .run(first, NOW, NOW, second, NOW, NOW);

  const handler = plugin.jobs[LOOKUP_JOB];
  assert.ok(handler !== undefined);
  await handler({ id: 1, kind: LOOKUP_JOB, payload: { rssItemIds: [first, second] }, attempts: 1 }, harness.ctx);

  assert.deepEqual(service.batchRequests, [['a.mp4', 'b.mp4']]);
  assert.equal(applied.length, 1, 'only the resolved answer reaches the plugin');
  assert.equal(harness.media.lookupStates.get(second)?.state, 'refused');
});

test('the poll handler asks by lookup id and applies what comes back', async () => {
  const service = createFakeLookupService({
    batch: new Map(),
    polls: new Map([['lookup-c', [resolvedEnvelope({ lookupId: 'lookup-c', media: sceneMedia('tpdb:scene:2') })]]]),
  });
  const { plugin, harness, applied } = build(service);
  const rssItemId = harness.insertRssItem('c.mp4');
  harness.raw.prepare('INSERT INTO xxx_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)')
    .run(rssItemId, NOW, NOW);

  const handler = plugin.jobs[POLL_JOB];
  assert.ok(handler !== undefined);
  await handler(
    { id: 2, kind: POLL_JOB, payload: { lookupId: 'lookup-c', rssItemId, polls: 1 }, attempts: 1 },
    harness.ctx,
  );

  assert.deepEqual(service.pollRequests, ['lookup-c']);
  assert.equal(applied.length, 1);
  assert.equal(harness.media.lookupStates.get(rssItemId)?.state, 'resolved');
});

test('a still-partial poll schedules the next one, counting up', async () => {
  const service = createFakeLookupService({
    batch: new Map(),
    polls: new Map([['lookup-d', [partialEnvelope({ lookupId: 'lookup-d' })]]]),
  });
  const { plugin, harness } = build(service);
  const rssItemId = harness.insertRssItem('d.mp4');
  harness.raw.prepare('INSERT INTO xxx_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)')
    .run(rssItemId, NOW, NOW);

  const handler = plugin.jobs[POLL_JOB];
  assert.ok(handler !== undefined);
  await handler(
    { id: 3, kind: POLL_JOB, payload: { lookupId: 'lookup-d', rssItemId, polls: 4 }, attempts: 1 },
    harness.ctx,
  );

  assert.deepEqual(harness.enqueued[0]?.payload, { lookupId: 'lookup-d', rssItemId, polls: 5 });
});

test('a malformed payload throws naming what it should carry', async () => {
  const { plugin, harness } = build();
  const lookup = plugin.jobs[LOOKUP_JOB];
  const poll = plugin.jobs[POLL_JOB];
  assert.ok(lookup !== undefined && poll !== undefined);
  await assert.rejects(
    () => lookup({ id: 4, kind: LOOKUP_JOB, payload: {}, attempts: 1 }, harness.ctx),
    /rssItemIds/,
  );
  await assert.rejects(
    () => poll({ id: 5, kind: POLL_JOB, payload: { rssItemId: 1 }, attempts: 1 }, harness.ctx),
    /lookupId/,
  );
});

test('a name the payload names but the database does not throws rather than being skipped', async () => {
  const service = createFakeLookupService({ batch: new Map(), polls: new Map() });
  const { plugin, harness } = build(service);
  const lookup = plugin.jobs[LOOKUP_JOB];
  assert.ok(lookup !== undefined);
  await assert.rejects(
    () => lookup({ id: 6, kind: LOOKUP_JOB, payload: { rssItemIds: [404] }, attempts: 1 }, harness.ctx),
    /404/,
  );
});

/**
 * A finished download, with a path carrying a distinctive segment.
 *
 * The marker is so that a leak anywhere in a log line -- under `path`,
 * folded into the message, or renamed to something like `file` -- is
 * findable by searching the serialised line rather than only by naming the
 * key it was expected under. Importer design spec §7: a plugin's log detail
 * is the channel `last_error` is written from, and `/api/downloads` serves
 * that to a browser as `DownloadRead.lastError`.
 */
const PATH_MARKER = 'PICKARR-PATH-MARKER-3b91fe';
function downloaded(over: Partial<DownloadedFile> = {}): DownloadedFile {
  return {
    path: `/downloads/${PATH_MARKER}/a.mp4`,
    sizeBytes: 10,
    downloadClientId: 1,
    rssItemId: 7,
    mediaItemId: 42,
    ...over,
  };
}

/** Every log line this plugin wrote, as one string a marker can be searched for. */
function serialisedLogs(harness: { logs: readonly { message: string; detail: unknown }[] }): string {
  return harness.logs.map((line) => `${line.message} ${JSON.stringify(line.detail)}`).join('\n');
}

test('a finished download is handed to the host, with a value for every token the plugin declares', async () => {
  const { plugin, harness } = build();

  await plugin.onDownloadedFile(downloaded(), harness.ctx);

  // Keyed exactly by what the spec declared, and each key carrying that
  // resolver's own answer. The map is built from `Object.entries` of the
  // declaration, which is what makes "declared but never resolved"
  // unwritable -- there is no key here that no function produced, and no
  // function whose answer landed under the wrong name.
  assert.equal(harness.imports.length, 1);
  assert.deepEqual(harness.imports[0]?.values, { site: 'site-7', title: 'title-42' });
  assert.deepEqual(harness.imports[0]?.file, downloaded());
  assert.deepEqual(harness.imports[0]?.entry, { path: downloaded().path, relativePath: 'a.mp4', sizeBytes: 10 });
});

test('a token resolving to null is carried as null rather than dropped from the map', async () => {
  const { plugin, harness } = build();

  await plugin.onDownloadedFile(downloaded({ mediaItemId: null }), harness.ctx);

  // Present and null, not absent: `resolveShape` refuses `unknown-token`
  // for a key the map has no entry for, and treats a null value as a
  // resolution to drop (design spec §8.8). Dropping the key here would turn
  // the second into the first and refuse every shape naming it.
  assert.deepEqual(harness.imports[0]?.values, { site: 'site-7', title: null });
});

test('the line it logs names the two ids, says where the file went, and carries no path', async () => {
  const { plugin, harness } = build();

  await plugin.onDownloadedFile(downloaded(), harness.ctx);

  const line = harness.logs[0];
  assert.ok(line !== undefined, 'onDownloadedFile logged nothing');
  assert.deepEqual(line.detail, { rssItemId: 7, mediaItemId: 42, listed: 1, chosen: 1, copied: 1, alreadyPlaced: 0, placed: 'library' });
  assert.ok(!serialisedLogs(harness).includes(PATH_MARKER), 'the log line carries the path');
  assert.ok(!serialisedLogs(harness).includes('/downloads/'), 'the log line carries a path fragment');
});

test('the line it logs says so when nothing matched the release', async () => {
  const { plugin, harness } = build();

  await plugin.onDownloadedFile(downloaded({ mediaItemId: null }), harness.ctx);

  // `null`, not absent. An unmatched release is design spec §6's own state,
  // and a missing key reads in a log as "the plugin forgot" rather than as
  // "nothing matched". `placed` says which of §6's two destinations took it.
  assert.deepEqual(
    harness.logs[0]?.detail,
    { rssItemId: 7, mediaItemId: null, listed: 1, chosen: 1, copied: 1, alreadyPlaced: 0, placed: 'unmatched' },
  );
});

test('a refused import is logged with its rule and then thrown, so the row stays completed', async () => {
  const { plugin, harness } = build();
  harness.answerImport({ refusal: 'destination-exists', errno: null });

  // Thrown, not returned: `deliverCompleted` marks a row `delivered` the
  // moment `onDownloadedFile` returns, so swallowing a refusal would record
  // a file as imported that is not there -- and design spec §5 requires
  // exactly the opposite, that the next tick tries again.
  await assert.rejects(
    () => plugin.onDownloadedFile(downloaded(), harness.ctx),
    /destination-exists/,
  );
  assert.deepEqual(harness.logs[0]?.detail, {
    rssItemId: 7, mediaItemId: 42, refusal: 'destination-exists', errno: null,
  });
});

test('a refusal carrying an errno keeps it, and still carries no path', async () => {
  const { plugin, harness } = build();
  harness.answerImport({ refusal: 'copy-failed', errno: 'ENOSPC' });

  await assert.rejects(
    () => plugin.onDownloadedFile(downloaded(), harness.ctx),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      // The message reaches `deliverCompleted`'s log, so it is part of the
      // same rule as the detail below.
      assert.ok(!error.message.includes(PATH_MARKER), 'the thrown message carries the path');
      assert.match(error.message, /copy-failed/);
      return true;
    },
  );
  assert.deepEqual(harness.logs[0]?.detail, {
    rssItemId: 7, mediaItemId: 42, refusal: 'copy-failed', errno: 'ENOSPC',
  });
  assert.ok(!serialisedLogs(harness).includes(PATH_MARKER), 'the log line carries the path');
});

test('a listing refusal is logged with its errno and thrown, and nothing is placed', async () => {
  const { plugin, harness } = build();
  harness.answerList({ refusal: 'list-failed', errno: 'EACCES' });

  await assert.rejects(() => plugin.onDownloadedFile(downloaded(), harness.ctx), /list-failed/);
  assert.equal(harness.imports.length, 0);
  assert.deepEqual(harness.logs[0]?.detail, { rssItemId: 7, mediaItemId: 42, refusal: 'list-failed', errno: 'EACCES' });
  assert.ok(!serialisedLogs(harness).includes(PATH_MARKER));
});

test('each entry resolves its tokens over its own path, not the download directory', async () => {
  // A path-derived token, so the values show which path the resolvers were
  // handed: resolved over the directory, `ext` would be the whole of `dir`,
  // which holds no dot.
  const plugin = createLookupPlugin({
    id: 'xxx',
    mediaType: 'xxx',
    category: 'xxx',
    migrations: [placementTableMigration('xxx', 2)],
    check: (): void => {},
    apply: async () => {},
    tokens: { ext: extToken },
    expects: async () => ({ kind: 'single' }),
  }, { now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'test-key' });
  const harness = createTestHarness();
  for (const migration of plugin.migrations) migration.up(harness.raw);
  const dir = `/downloads/${PATH_MARKER}`;
  harness.answerList([{ path: `${dir}/Show.S01E01.mkv`, relativePath: 'Show.S01E01.mkv', sizeBytes: 5 }]);

  await plugin.onDownloadedFile(downloaded({ path: dir, sizeBytes: 4096 }), harness.ctx);

  assert.equal(harness.imports[0]?.file.path, dir, 'place is handed the whole download');
  assert.equal(harness.imports[0]?.entry.relativePath, 'Show.S01E01.mkv');
  assert.deepEqual(harness.imports[0]?.values, { ext: 'mkv' });
});

const DIR = `/downloads/${PATH_MARKER}`;
function listing(...relativePaths: string[]): DownloadEntry[] {
  return relativePaths.map((relativePath) => ({ path: `${DIR}/${relativePath}`, relativePath, sizeBytes: 1 }));
}

test('single: the one video file is placed and the sidecar is not', async () => {
  const { plugin, harness } = build();
  harness.answerList(listing('film.iso', 'film.mds.mds'));

  await plugin.onDownloadedFile(downloaded({ path: DIR }), harness.ctx);

  assert.deepEqual(harness.imports.map((recorded) => recorded.entry.relativePath), ['film.iso']);
});

test('a selection refusal is logged and thrown, and nothing is placed', async () => {
  const { plugin, harness } = build();
  harness.answerList(listing('a.mkv', 'b.mkv'));

  await assert.rejects(() => plugin.onDownloadedFile(downloaded({ path: DIR }), harness.ctx), /too-many-video-files/);
  assert.equal(harness.imports.length, 0);
  assert.deepEqual(harness.logs[0]?.detail, {
    rssItemId: 7, mediaItemId: 42, refusal: 'too-many-video-files', errno: null,
  });
  assert.ok(!serialisedLogs(harness).includes(PATH_MARKER));
  assert.ok(!serialisedLogs(harness).includes('a.mkv'), 'a relative path reached the log');
});

test('episodes: the plugin\'s season is what the pack is checked against', async () => {
  const { plugin, harness } = build(undefined, { kind: 'episodes', season: 1 });
  harness.answerList(listing('Show.S01E01.mkv', 'Show.S02E01.mkv'));

  await assert.rejects(() => plugin.onDownloadedFile(downloaded({ path: DIR }), harness.ctx), /too-many-video-files/);
});

test('unmatched: every entry is placed, and expects is not asked', async () => {
  let asked = 0;
  const plugin = createLookupPlugin({
    id: 'xxx', mediaType: 'xxx', category: 'xxx', migrations: [placementTableMigration('xxx', 2)],
    check: (): void => {}, apply: async () => {}, tokens: NAMED_TOKENS,
    expects: async () => { asked += 1; return { kind: 'single' }; },
  }, { now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'test-key' });
  const harness = createTestHarness();
  for (const migration of plugin.migrations) migration.up(harness.raw);
  harness.answerList(listing('a.mkv', 'b.nfo', 'Sample/s.mkv'));

  await plugin.onDownloadedFile(downloaded({ path: DIR, mediaItemId: null }), harness.ctx);

  assert.equal(asked, 0, 'an unmatched release has no media item to ask about');
  assert.deepEqual(harness.imports.map((recorded) => recorded.entry.relativePath), ['a.mkv', 'b.nfo', 'Sample/s.mkv']);
});

test('unmatched: an empty download is refused no-video-file rather than delivered with nothing copied', async () => {
  const { plugin, harness } = build();
  harness.answerList([]);

  // Returning would mark the row delivered with no file anywhere; a matched
  // release with nothing in it already refuses through `select`, and an
  // unmatched one must not be the way round that.
  await assert.rejects(
    () => plugin.onDownloadedFile(downloaded({ path: DIR, mediaItemId: null }), harness.ctx),
    /no-video-file/,
  );
  assert.equal(harness.imports.length, 0);
  assert.deepEqual(harness.logs[0]?.detail, {
    rssItemId: 7, mediaItemId: null, refusal: 'no-video-file', errno: null,
  });
});

test('a pack that failed part way resumes on the next tick without meeting its own copies', async () => {
  const { plugin, harness } = build(undefined, { kind: 'episodes', season: 1 });
  const pack = listing('S.S01E01.mkv', 'S.S01E02.mkv', 'S.S01E03.mkv');
  harness.answerList(pack);
  harness.answerImports([undefined, { refusal: 'copy-failed', errno: 'ENOSPC' }]);

  await assert.rejects(() => plugin.onDownloadedFile(downloaded({ path: DIR }), harness.ctx), /copy-failed/);
  assert.deepEqual(harness.imports.map((recorded) => recorded.entry.relativePath), ['S.S01E01.mkv', 'S.S01E02.mkv']);

  harness.answerList(pack);
  await plugin.onDownloadedFile(downloaded({ path: DIR }), harness.ctx);

  // E01 was recorded and is not asked for again; E02 failed and is retried.
  assert.deepEqual(
    harness.imports.slice(2).map((recorded) => recorded.entry.relativePath),
    ['S.S01E02.mkv', 'S.S01E03.mkv'],
  );
  assert.deepEqual(harness.logs.at(-1)?.detail, {
    rssItemId: 7, mediaItemId: 42, listed: 3, chosen: 3, copied: 2, alreadyPlaced: 1, placed: 'library',
  });
});

test('an unrecorded entry that answers destination-exists is still refused', async () => {
  const { plugin, harness } = build();
  harness.answerImport({ refusal: 'destination-exists', errno: null });

  await assert.rejects(() => plugin.onDownloadedFile(downloaded(), harness.ctx), /destination-exists/);
  const rows = harness.raw.prepare('SELECT COUNT(*) AS n FROM xxx_placement').get()?.['n'];
  assert.equal(rows, 0, 'a refused entry was recorded as placed');
});

test('a download whose every entry was already placed copies nothing and says so', async () => {
  const { plugin, harness } = build();
  await plugin.onDownloadedFile(downloaded(), harness.ctx);
  await plugin.onDownloadedFile(downloaded(), harness.ctx);

  assert.equal(harness.imports.length, 1);
  assert.deepEqual(harness.logs.at(-1)?.detail, {
    rssItemId: 7, mediaItemId: 42, listed: 1, chosen: 1, copied: 0, alreadyPlaced: 1, placed: null,
  });
});

/**
 * `harness.ctx` with a `downloads` that records instead of throwing, and the
 * submissions it recorded. The harness's own `downloads.submit` refuses,
 * which is right for every lookup test and is the one thing an
 * `onDownloadRequest` test has to replace.
 */
function withRecordedDownloads(ctx: PluginContext): {
  ctx: PluginContext;
  submitted: DownloadSubmission[];
} {
  const submitted: DownloadSubmission[] = [];
  return {
    ctx: {
      ...ctx,
      downloads: {
        async submit(submission: DownloadSubmission): Promise<string> {
          submitted.push(submission);
          return 'client-ref-1';
        },
      },
    },
    submitted,
  };
}

test('a download request on a feed that names no client submits anyway', async () => {
  // The defect: this used to read `rss_feed.download_client_id` itself and
  // throw on NULL, which is every feed created through the settings UI.
  // The column is NULL here and the submission goes out regardless.
  const { plugin, harness } = build();
  const feedId = harness.insertFeed(null);
  const rssItemId = harness.insertRssItem('e.mp4', feedId);
  const recorded = withRecordedDownloads(harness.ctx);

  await plugin.onDownloadRequest(rssItemId, recorded.ctx);

  assert.deepEqual(recorded.submitted, [{ rssItemId }]);
  assert.ok(
    harness.logs.some((line) => line.message === 'submitted a download'),
    'the submission must be logged',
  );
});

test('a download request works with the rss_feed table dropped, so it reads no feed', async () => {
  // What the test above cannot show any more. `DownloadSubmission` has one
  // field, so the submission's shape is fixed by the type and nothing about
  // it could reveal whether the feed was read. Dropping the table does
  // reveal it: the join this used to make would fail with "no such table:
  // rss_feed" and the call below would reject instead of submitting.
  const { plugin, harness } = build();
  const rssItemId = harness.insertRssItem('f.mp4', harness.insertFeed(7));
  harness.raw.exec('DROP TABLE rss_feed');
  const recorded = withRecordedDownloads(harness.ctx);

  await plugin.onDownloadRequest(rssItemId, recorded.ctx);

  assert.deepEqual(recorded.submitted, [{ rssItemId }]);
});

test('the dispatcher\'s signal reaches the request, which is the shape production always takes', async () => {
  // The branch under test is the one the *process* takes: `run-job.ts` hands
  // every handler a real signal, so the no-signal shape both `clientFor` and
  // the client's own `init` also carry is the one nothing in production
  // reaches. Without this test the covered half and the shipped half are
  // opposites.
  const seen: (AbortSignal | null | undefined)[] = [];
  const service = createFakeLookupService({
    batch: new Map([['g.srt', refusedEnvelope({ lookupId: 'lookup-s', refusal: 'a sidecar' })]]),
    polls: new Map(),
  });
  // The real fake, at the real wire shape, with the init recorded on its way
  // through -- so what is asserted is the argument the client actually built.
  const recording = {
    fetch: {
      async json<T>(url: string, init?: RequestInit): Promise<T> {
        seen.push(init?.signal);
        return await service.fetch.json<T>(url, init);
      },
      async bytes(): Promise<never> { throw new Error('not used'); },
    },
  };
  const { plugin, harness } = build(recording);
  const rssItemId = harness.insertRssItem('g.srt');
  harness.raw.prepare('INSERT INTO xxx_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)')
    .run(rssItemId, NOW, NOW);

  const controller = new AbortController();
  const handler = plugin.jobs[LOOKUP_JOB];
  assert.ok(handler !== undefined);
  await handler(
    { id: 8, kind: LOOKUP_JOB, payload: { rssItemIds: [rssItemId] }, attempts: 1 },
    harness.ctx,
    controller.signal,
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0], controller.signal, 'the job\'s own signal, not a copy and not undefined');
});

test('a failed request is logged with its status, and still fails the job', async () => {
  const failing = {
    fetch: {
      async json(): Promise<never> {
        const error = new Error('failed: 429 Too Many Requests');
        Object.assign(error, { status: 429 });
        throw error;
      },
      async bytes(): Promise<never> { throw new Error('not used'); },
    },
  };
  const { plugin, harness } = build(failing);
  const rssItemId = harness.insertRssItem('f.mp4');
  const handler = plugin.jobs[LOOKUP_JOB];
  assert.ok(handler !== undefined);

  await assert.rejects(
    () => handler({ id: 7, kind: LOOKUP_JOB, payload: { rssItemIds: [rssItemId] }, attempts: 1 }, harness.ctx),
    /429/,
  );

  assert.match(harness.logs[0]?.message ?? '', /lookup request failed/);
  assert.equal(harness.logs[0]?.detail?.['status'], 429);
  // The key travels in a header, so no log line could carry it -- and this one
  // carries no query string either.
  assert.equal(harness.logs[0]?.detail?.['url'], 'https://openmetadata.test/');
});
