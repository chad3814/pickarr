import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOKUP_JOB, POLL_JOB, createLookupPlugin } from '../src/engine.ts';
import {
  createFakeLookupService,
  createTestHarness,
  partialEnvelope,
  refusedEnvelope,
  resolvedEnvelope,
} from '../src/testing.ts';
import { MAX_BATCH } from '../src/client.ts';
import type { ApplyArgs } from '../src/engine.ts';
import type { LookupEnvelope, Media } from '../src/types.ts';
import type { HostFetch } from '@pickarr/contract';

const NOW = 1_700_000_000_000;

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
function build(service?: { fetch: HostFetch }) {
  const applied: ApplyArgs[] = [];
  const plugin = createLookupPlugin({
    id: 'xxx',
    mediaType: 'xxx',
    category: 'xxx',
    migrations: [],
    apply: async (args) => { applied.push(args); },
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
    apply: async () => {},
  }, { now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'test-key' });

  assert.deepEqual(plugin.migrations.map((migration) => migration.version), [1, 2]);
  assert.equal(plugin.id, 'xxx');
  assert.equal(plugin.mediaType, 'xxx');
  assert.deepEqual(Object.keys(plugin.jobs).toSorted(), [LOOKUP_JOB, POLL_JOB]);
});

test('keeps a spec job handler alongside its own two', () => {
  const plugin = createLookupPlugin({
    id: 'xxx',
    mediaType: 'xxx',
    category: 'xxx',
    migrations: [],
    jobs: { sweep: async () => {} },
    apply: async () => {},
  }, { now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'test-key' });

  assert.deepEqual(Object.keys(plugin.jobs).toSorted(), [LOOKUP_JOB, POLL_JOB, 'sweep']);
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
  assert.equal(harness.media.resolutions.get(second)?.resolution, 'refused');
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
  assert.equal(harness.media.resolutions.get(rssItemId)?.resolution, 'resolved');
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

test('the two entry points this slice does not develop still do something real', async () => {
  const { plugin, harness } = build();
  await plugin.onDownloadedFile({ path: '/downloads/a.mp4', sizeBytes: 10, downloadClientId: 1 }, harness.ctx);
  assert.match(harness.logs[0]?.message ?? '', /download/);
  await assert.rejects(
    () => plugin.onDownloadRequest(harness.insertRssItem('e.mp4'), harness.ctx),
    /download client/,
  );
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
