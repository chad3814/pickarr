import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOKUP_JOB } from '../src/engine.ts';
import { LOOKUP_JSON_TOO_LARGE } from '@pickarr/contract';
import {
  AUTO_REQUERY_LIMIT,
  REQUERY_QUIET_MS,
  REQUERY_SWEEP_INTERVAL_MS,
  REQUERY_SWEEP_JOB,
  createRequerySweep,
  isoDate,
  requeryCandidates,
  shouldRequery,
  suggestedDate,
} from '../src/requery.ts';
import { createTestHarness } from '../src/testing.ts';

/** 2026-10-06T12:00:00Z, so "today" in UTC is 2026-10-06. */
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const TODAY = '2026-10-06';

function envelopeJson(parsed: Record<string, unknown>, media: Record<string, unknown> | null = null): string {
  return JSON.stringify({ lookupId: 'l', state: 'unresolved', partial: false, cached: false, confidence: null, refusal: null, parsed, media, suggestions: null });
}

test('isoDate renders an epoch as a UTC calendar day', () => {
  assert.equal(isoDate(NOW), '2026-10-06');
  assert.equal(isoDate(Date.UTC(2026, 11, 31, 23, 59, 59)), '2026-12-31');
});

test('suggestedDate reads a scene\'s releasedOn, then an episode\'s airDate, then a low-confidence match\'s releaseDate', () => {
  // The three places the live service puts a date, measured 2026-10-06:
  // `parsed.releasedOn` for a scene, `parsed.airDate` for a dated episode,
  // and `media.releaseDate` when an unresolved answer still carries a
  // low-confidence match.
  assert.equal(suggestedDate(envelopeJson({ kind: 'scene', releasedOn: '2026-10-09' })), '2026-10-09');
  assert.equal(suggestedDate(envelopeJson({ kind: 'episode', airDate: '2026-10-08' })), '2026-10-08');
  assert.equal(suggestedDate(envelopeJson({ kind: 'episode', airDate: null }, { releaseDate: '2026-10-07' })), '2026-10-07');
  assert.equal(suggestedDate(envelopeJson({ kind: 'scene', releasedOn: '2026-10-09' }, { releaseDate: '2026-01-01' })), '2026-10-09', 'the parse wins over the match');
});

test('suggestedDate is null for a film (a year is not a date), no json, the too-large marker, malformed json and a non-ISO value', () => {
  assert.equal(suggestedDate(envelopeJson({ kind: 'movie', year: 2027 })), null);
  assert.equal(suggestedDate(null), null);
  assert.equal(suggestedDate(LOOKUP_JSON_TOO_LARGE), null);
  assert.equal(suggestedDate('{not json'), null);
  assert.equal(suggestedDate(envelopeJson({ kind: 'scene', releasedOn: 'soon' })), null);
  assert.equal(suggestedDate(envelopeJson({ kind: 'scene', releasedOn: '2026-10-09T00:00:00Z' })), '2026-10-09', 'a timestamp is cut to its day');
});

test('shouldRequery: a date today or later, or within the two days before today, starts a chain', () => {
  assert.equal(shouldRequery({ autoRequeryCount: 0, suggestedDate: '2026-10-09' }, TODAY), true, 'future');
  assert.equal(shouldRequery({ autoRequeryCount: 0, suggestedDate: '2026-10-06' }, TODAY), true, 'today');
  assert.equal(shouldRequery({ autoRequeryCount: 0, suggestedDate: '2026-10-04' }, TODAY), true, 'two days ago, inclusive');
  assert.equal(shouldRequery({ autoRequeryCount: 0, suggestedDate: '2026-10-03' }, TODAY), false, 'three days ago');
  assert.equal(shouldRequery({ autoRequeryCount: 0, suggestedDate: null }, TODAY), false, 'no date, no chain');
});

test('shouldRequery: a chain already started continues whatever the date, and stops at the limit', () => {
  assert.equal(AUTO_REQUERY_LIMIT, 5);
  assert.equal(shouldRequery({ autoRequeryCount: 1, suggestedDate: '2026-09-01' }, TODAY), true, 'the date aged out; the chain goes on');
  assert.equal(shouldRequery({ autoRequeryCount: 1, suggestedDate: null }, TODAY), true);
  assert.equal(shouldRequery({ autoRequeryCount: 4, suggestedDate: null }, TODAY), true, 'the fifth requery');
  assert.equal(shouldRequery({ autoRequeryCount: 5, suggestedDate: null }, TODAY), false, 'five done');
  assert.equal(shouldRequery({ autoRequeryCount: 5, suggestedDate: '2026-10-09' }, TODAY), false, 'even with a future date');
});

function seedUnresolved(
  harness: ReturnType<typeof createTestHarness>,
  feedId: number,
  fields: { lookupJson?: string | null; count?: number; updatedAt?: number; lookupState?: string; mediaItemId?: number | null },
): number {
  const id = harness.insertRssItem(`item-${String(Math.random()).slice(2)}.mkv`, feedId);
  harness.raw.prepare(`
    UPDATE rss_item SET lookup_state = ?, lookup_json = ?, auto_requery_count = ?, updated_at = ?, media_item_id = ? WHERE id = ?
  `).run(fields.lookupState ?? 'unresolved', fields.lookupJson ?? null, fields.count ?? 0, fields.updatedAt ?? 0, fields.mediaItemId ?? null, id);
  return id;
}

test('requeryCandidates selects this plugin\'s unresolved, unlinked, quiet rows the rule accepts, in id order', () => {
  const harness = createTestHarness({ now: () => NOW });
  const mine = harness.insertFeed(null, 'xxx');
  const theirs = harness.insertFeed(null, 'tv');
  const future = envelopeJson({ kind: 'scene', releasedOn: '2026-10-09' });
  const old = envelopeJson({ kind: 'scene', releasedOn: '2026-09-01' });

  const a = seedUnresolved(harness, mine, { lookupJson: future });
  const chained = seedUnresolved(harness, mine, { lookupJson: old, count: 2 });
  seedUnresolved(harness, mine, { lookupJson: old, count: 0 });
  seedUnresolved(harness, mine, { lookupJson: old, count: 5 });
  seedUnresolved(harness, mine, { lookupJson: future, lookupState: 'refused' });
  seedUnresolved(harness, mine, { lookupJson: future, mediaItemId: 9 });
  seedUnresolved(harness, mine, { lookupJson: future, updatedAt: NOW - REQUERY_QUIET_MS + 1 });
  seedUnresolved(harness, theirs, { lookupJson: future });
  const quietEnough = seedUnresolved(harness, mine, { lookupJson: future, updatedAt: NOW - REQUERY_QUIET_MS });

  assert.deepEqual(requeryCandidates(harness.raw, 'xxx', NOW), [a, chained, quietEnough]);
});

test('the sweep bumps each candidate\'s count, hands the ids to the lookup path in one call, and books itself a day out', async () => {
  const harness = createTestHarness({ now: () => NOW });
  const feed = harness.insertFeed(null, 'xxx');
  const future = envelopeJson({ kind: 'scene', releasedOn: '2026-10-09' });
  const a = seedUnresolved(harness, feed, { lookupJson: future });
  const b = seedUnresolved(harness, feed, { lookupJson: envelopeJson({ kind: 'scene' }), count: 4 });
  const handed: number[][] = [];
  const sweep = createRequerySweep('xxx', async (ids) => { handed.push([...ids]); }, () => NOW);

  await sweep({ id: 7, kind: REQUERY_SWEEP_JOB, payload: { sweep: 1 }, attempts: 1 }, harness.ctx);

  assert.deepEqual(handed, [[a, b]]);
  const counts = (harness.raw.prepare('SELECT id, auto_requery_count AS n FROM rss_item ORDER BY id').all() as { id: number; n: number }[])
    .map((row) => ({ id: row.id, n: row.n }));
  assert.deepEqual(counts, [{ id: a, n: 1 }, { id: b, n: 5 }]);
  assert.deepEqual(
    harness.enqueued.map((job) => ({ kind: job.kind, payload: job.payload, runAt: job.runAt })),
    [{ kind: REQUERY_SWEEP_JOB, payload: { sweep: 1 }, runAt: NOW + REQUERY_SWEEP_INTERVAL_MS }],
  );
  assert.equal(REQUERY_SWEEP_INTERVAL_MS, 86_400_000);
});

test('a sweep with nothing to do still books the next one, and hands nothing to the lookup path', async () => {
  const harness = createTestHarness({ now: () => NOW });
  harness.insertFeed(null, 'xxx');
  const handed: number[][] = [];
  const sweep = createRequerySweep('xxx', async (ids) => { handed.push([...ids]); }, () => NOW);

  await sweep({ id: 7, kind: REQUERY_SWEEP_JOB, payload: { sweep: 1 }, attempts: 1 }, harness.ctx);

  assert.deepEqual(handed, []);
  assert.deepEqual(harness.enqueued.map((job) => job.kind), [REQUERY_SWEEP_JOB]);
});

test('the lookup plugin registers the sweep and routes it through the same lookup enqueue as a new item', async () => {
  // Through `createLookupPlugin`, not `createRequerySweep` directly: the
  // wiring is the thing under test here.
  const { createLookupPlugin } = await import('../src/engine.ts');
  const harness = createTestHarness({ now: () => NOW });
  const plugin = createLookupPlugin(
    {
      id: 'xxx', mediaType: 'xxx', category: 'xxx', migrations: [], tokens: {},
      apply: async () => {}, check: () => {}, dropRows: () => {}, expects: async () => ({ kind: 'single' }),
    },
    { resolveSecret: async () => 'k', now: () => NOW, baseUrl: 'https://svc.test' },
  );
  for (const migration of plugin.migrations) migration.up(harness.raw);
  const feed = harness.insertFeed(null, 'xxx');
  const a = seedUnresolved(harness, feed, { lookupJson: envelopeJson({ kind: 'scene', releasedOn: '2026-10-09' }) });
  const handler = plugin.jobs[REQUERY_SWEEP_JOB];
  assert.ok(handler !== undefined, 'the sweep is one of the plugin\'s jobs');

  await handler({ id: 7, kind: REQUERY_SWEEP_JOB, payload: { sweep: 1 }, attempts: 1 }, harness.ctx);

  assert.deepEqual(
    harness.enqueued.map((job) => ({ kind: job.kind, payload: job.payload })),
    [
      { kind: REQUERY_SWEEP_JOB, payload: { sweep: 1 } },
      { kind: LOOKUP_JOB, payload: { rssItemIds: [a] } },
    ],
  );
});
