import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKFILL_RETRY_DELAY_MS,
  VIDEO_RESOLUTION_BACKFILL_JOB,
  createVideoResolutionBackfillJob,
  videoResolutionBackfillMigration,
} from '../src/backfill.ts';
import { lookupTableMigration } from '../src/table.ts';
import { MAX_BATCH } from '../src/client.ts';
import { createTestHarness, unresolvedEnvelope, withResolution, type TestHarness } from '../src/testing.ts';
import type { LookupEnvelope } from '../src/types.ts';

const NOW = 1_700_000_000_000;

/** A harness at plugin version 1, with `rows` releases in the given lookup states, each with a lookup row. */
function seeded(rows: readonly string[]): { harness: TestHarness; ids: number[] } {
  const harness = createTestHarness();
  lookupTableMigration('movie').up(harness.raw);
  const ids = rows.map((state, index) => {
    const id = harness.insertRssItem(`release-${index}.mkv`);
    harness.raw.prepare('UPDATE rss_item SET lookup_state = ? WHERE id = ?').run(state, id);
    harness.raw.prepare('INSERT INTO movie_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)').run(id, NOW, NOW);
    return id;
  });
  return { harness, ids };
}

function marked(harness: TestHarness): number[] {
  return harness.raw.prepare('SELECT rss_item_id FROM movie_lookup WHERE video_resolution_backfill = 1 ORDER BY rss_item_id')
    .all().map((row) => Number((row as { rss_item_id: unknown }).rss_item_id));
}

function queuedJobs(harness: TestHarness): { plugin_id: unknown; kind: unknown; state: unknown; max_attempts: unknown }[] {
  return harness.raw.prepare('SELECT plugin_id, kind, state, max_attempts FROM jobs').all()
    .map((row) => ({ ...(row as { plugin_id: unknown; kind: unknown; state: unknown; max_attempts: unknown }) }));
}

test('the migration marks resolved releases only, and queues one job for them', () => {
  const { harness, ids } = seeded(['resolved', 'unresolved', 'resolved', 'refused', 'pending']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  assert.deepEqual(marked(harness), [ids[0], ids[2]]);
  assert.deepEqual(queuedJobs(harness), [
    { plugin_id: 'movie', kind: VIDEO_RESOLUTION_BACKFILL_JOB, state: 'ready', max_attempts: 5 },
  ]);
});

test('the migration queues nothing when nothing is resolved -- a fresh install', () => {
  const { harness } = seeded(['pending', 'unresolved']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  assert.deepEqual(marked(harness), []);
  assert.deepEqual(queuedJobs(harness), [], 'no job for an empty backfill');
});

test('the migration carries the version the plugin gave it', () => {
  assert.equal(videoResolutionBackfillMigration('movie', 4).version, 4);
});

/** A backfill handler over a scripted batch, recording every request. */
function handler(answer: (names: readonly string[]) => readonly LookupEnvelope[]) {
  const requests: (readonly string[])[] = [];
  const run = createVideoResolutionBackfillJob({
    pluginId: 'movie',
    category: 'movies',
    now: () => NOW,
    batch: async (_ctx, _signal, names) => {
      requests.push(names);
      return answer(names);
    },
  });
  return { run, requests };
}

const answerEach = (resolution: unknown) => (names: readonly string[]) =>
  names.map((name) => withResolution(unresolvedEnvelope({ lookupId: name }), resolution));

test('the job stores only the resolution, clears each mark, and asks again for the rest', async () => {
  const { harness, ids } = seeded(Array.from({ length: MAX_BATCH + 3 }, () => 'resolved'));
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  const { run, requests } = handler(answerEach('1080p'));

  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);

  assert.equal(requests.length, 1, 'one batch request');
  assert.equal(requests[0]?.length, MAX_BATCH, 'of the service maximum');
  assert.equal(marked(harness).length, 3, 'the rest are still marked');
  assert.deepEqual(harness.enqueued.map((job) => job.kind), [VIDEO_RESOLUTION_BACKFILL_JOB], 'and asked for again');
  assert.equal(harness.media.videoResolutions.get(ids[0] ?? -1), '1080p');
  // Review Focus 5: a fresh answer must not re-identify the release.
  const written = new Set(harness.media.calls.map((call) => call.method));
  assert.deepEqual([...written], ['setVideoResolution'], 'nothing but the resolution is written');
});

test('the last batch does not re-enqueue', async () => {
  const { harness } = seeded(['resolved', 'resolved']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  const { run } = handler(answerEach('720p'));
  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);
  assert.deepEqual(marked(harness), []);
  assert.deepEqual(harness.enqueued, [], 'nothing left, nothing queued');
});

test('an answer with no usable resolution stores null and still clears the mark, so the job cannot loop', async () => {
  const { harness, ids } = seeded(['resolved']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  const { run } = handler(answerEach('4K'));
  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);
  assert.equal(harness.media.videoResolutions.get(ids[0] ?? -1), null);
  assert.deepEqual(marked(harness), []);
});

test('a marked release that was deleted is cleared and never asked about', async () => {
  // Review Focus 2: the join can never return it, so without this the
  // "marks remain" count would re-enqueue the job for ever.
  const { harness, ids } = seeded(['resolved', 'resolved']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  harness.raw.prepare('DELETE FROM rss_item WHERE id = ?').run(ids[1] ?? -1);
  const { run, requests } = handler(answerEach('1080p'));
  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);
  assert.deepEqual(requests, [['release-0.mkv']], 'only the release that exists is asked about');
  assert.deepEqual(marked(harness), [], 'the orphan is cleared too');
  assert.deepEqual(harness.enqueued, [], 'and nothing is re-enqueued for it');
});

test('a failing service asks again in ten minutes, with every mark intact', async () => {
  // Review Focus 4. Throwing would hand the job to the runner's backoff --
  // five attempts over about fifteen seconds -- and a dead-lettered backfill
  // is never enqueued again, since the plugin migration inserts the only
  // row. So an outage or a 429 schedules a successor instead.
  const { harness, ids } = seeded(['resolved', 'resolved']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  const { run } = handler(() => { throw new Error('429 Too Many Requests'); });

  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);

  assert.deepEqual(marked(harness), ids, 'every mark intact');
  assert.equal(harness.media.videoResolutions.size, 0, 'nothing written');
  assert.deepEqual(
    harness.enqueued.map((job) => ({ kind: job.kind, runAt: job.runAt })),
    [{ kind: VIDEO_RESOLUTION_BACKFILL_JOB, runAt: NOW + BACKFILL_RETRY_DELAY_MS }],
    'exactly one delayed successor',
  );
  assert.equal(BACKFILL_RETRY_DELAY_MS, 600_000, 'ten minutes, spelled literally');
  assert.equal(harness.logs.length, 1, 'one line logged');
  const detail = JSON.stringify(harness.logs[0]?.detail ?? {});
  assert.match(detail, /429 Too Many Requests/, 'naming the failure');
  assert.ok(!detail.includes('release-'), 'and no filename');
});

test('with nothing marked, the job asks nothing', async () => {
  const { harness } = seeded(['pending']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  const { run, requests } = handler(answerEach('1080p'));
  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);
  assert.deepEqual(requests, []);
});
