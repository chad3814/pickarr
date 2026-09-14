import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-sqlite';
import {
  MAX_POLLS,
  POLL_DELAY_MS,
  POLL_JOB,
  applyEnvelope,
  describeUnresolved,
} from '../src/engine.ts';
import { lookupTable, lookupTableMigration } from '../src/table.ts';
import {
  createTestHarness,
  partialEnvelope,
  pendingEnvelope,
  refusedEnvelope,
  unresolvedEnvelope,
} from '../src/testing.ts';
import type { Media } from '../src/types.ts';

const PLUGIN_ID = 'tv';
const NOW = 1_700_000_000_000;

/** A harness with the plugin's own state table migrated and one rss item in it. */
function fixture(filename = 'item.mkv') {
  const harness = createTestHarness();
  lookupTableMigration(PLUGIN_ID).up(harness.raw);
  const rssItemId = harness.insertRssItem(filename);
  const table = lookupTable(PLUGIN_ID);
  const db = drizzle({ client: harness.raw });
  harness.raw.prepare(
    `INSERT INTO ${PLUGIN_ID}_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)`,
  ).run(rssItemId, NOW, NOW);
  const applied: { media: Media; mediaItemId: number }[] = [];
  const deps = {
    pluginId: PLUGIN_ID,
    ctx: harness.ctx,
    raw: harness.raw,
    db,
    table,
    now: NOW,
    // These tests drive the branch, not a plugin's refusal: nothing here is
    // a kind any real plugin would reject, so the pre-flight accepts
    // everything. The refusal itself is `engine-resolved.test.ts`'s.
    check: (): void => {},
    apply: async (args: { media: Media; mediaItemId: number }) => {
      applied.push({ media: args.media, mediaItemId: args.mediaItemId });
    },
  };
  return { harness, deps, rssItemId, table, db, applied };
}

test('a partial answer polls, and leaves the resolution alone', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(partialEnvelope({ lookupId: 'lookup-1' }), { rssItemId, filename: 'item.mkv', polls: 0 }, deps);

  assert.equal(harness.enqueued.length, 1);
  assert.equal(harness.enqueued[0]?.kind, POLL_JOB);
  assert.deepEqual(harness.enqueued[0]?.payload, { lookupId: 'lookup-1', rssItemId, polls: 1 });
  assert.equal(harness.enqueued[0]?.runAt, NOW + POLL_DELAY_MS);
  // Nothing is known about the item yet, so nothing is recorded about it.
  assert.equal(harness.media.resolutions.size, 0);
});

test('a pending state polls too -- the state, not only the flag', async () => {
  const { harness, deps, rssItemId } = fixture();
  await applyEnvelope(pendingEnvelope({ lookupId: 'lookup-2' }), { rssItemId, filename: 'item.mkv', polls: 3 }, deps);
  assert.equal(harness.enqueued[0]?.kind, POLL_JOB);
  assert.deepEqual(harness.enqueued[0]?.payload, { lookupId: 'lookup-2', rssItemId, polls: 4 });
});

test('the last permitted poll gives up, naming the lookup id', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    pendingEnvelope({ lookupId: 'lookup-3' }),
    { rssItemId, filename: 'item.mkv', polls: MAX_POLLS },
    deps,
  );

  assert.equal(harness.enqueued.length, 0, 'no further poll is scheduled');
  const recorded = harness.media.resolutions.get(rssItemId);
  assert.equal(recorded?.resolution, 'unresolved');
  assert.match(recorded?.detail ?? '', /lookup-3/);
});

test('a refusal is terminal: the resolution says so and nothing else is written', async () => {
  const { harness, deps, rssItemId, applied } = fixture('item.srt');

  await applyEnvelope(
    refusedEnvelope({ lookupId: 'lookup-4', refusal: 'a subtitle' }),
    { rssItemId, filename: 'item.srt', polls: 0 },
    deps,
  );

  assert.deepEqual(harness.media.resolutions.get(rssItemId), { resolution: 'refused', detail: 'a subtitle' });
  assert.equal(harness.enqueued.length, 0);
  assert.equal(applied.length, 0);
  assert.equal(harness.media.items.size, 0, 'a refusal creates no media item to clean up');
});

test('an unrecognised name is unresolved, and says only that', async () => {
  const { harness, deps, rssItemId } = fixture('mystery.mkv');

  await applyEnvelope(unresolvedEnvelope({ lookupId: 'lookup-5' }), { rssItemId, filename: 'mystery.mkv', polls: 0 }, deps);

  const recorded = harness.media.resolutions.get(rssItemId);
  assert.equal(recorded?.resolution, 'unresolved');
  assert.match(recorded?.detail ?? '', /mystery\.mkv/);
  assert.equal(harness.enqueued.length, 0, 'a retry happens on request, not on a schedule');
});

test('an unresolved answer with suggestions names what was recognised', async () => {
  const { harness, deps, rssItemId } = fixture('site.performer.mp4');

  await applyEnvelope(
    unresolvedEnvelope({
      lookupId: 'lookup-6',
      suggestions: {
        site: { name: 'Maddie Wren', providerRef: 'tpdb:site:1' },
        performers: [{ name: 'A Performer', providerRef: 'tpdb:person:2' }],
      },
    }),
    { rssItemId, filename: 'site.performer.mp4', polls: 0 },
    deps,
  );

  const detail = harness.media.resolutions.get(rssItemId)?.detail ?? '';
  assert.match(detail, /Maddie Wren/);
  assert.match(detail, /A Performer/);
});

test('a resolved answer with no media throws rather than writing nothing quietly', async () => {
  const { deps, rssItemId } = fixture();
  const broken = { ...unresolvedEnvelope({ lookupId: 'lookup-7' }), state: 'resolved' as const };
  await assert.rejects(
    () => applyEnvelope(broken, { rssItemId, filename: 'item.mkv', polls: 0 }, deps),
    /lookup-7/,
  );
});

test('describeUnresolved reads differently with and without suggestions', () => {
  assert.match(describeUnresolved('a.mkv', null), /did not recognise/);
  assert.match(
    describeUnresolved('a.mkv', { site: { name: 'Site', providerRef: 'r' }, performers: [] }),
    /recognised site Site/,
  );
});

test('a partial answer that is also refused still polls -- partial is read first', async () => {
  const { harness, deps, rssItemId } = fixture();
  const both = { ...refusedEnvelope({ lookupId: 'lookup-8', refusal: 'a subtitle' }), partial: true };

  await applyEnvelope(both, { rssItemId, filename: 'item.mkv', polls: 0 }, deps);

  assert.equal(harness.enqueued[0]?.kind, POLL_JOB);
  assert.equal(harness.media.resolutions.size, 0);
});

/**
 * The one write the resolved path does not own.
 *
 * `lookup_id` is recorded at the top of `applyEnvelope`, before the branch
 * decides anything, so an item that ended `refused` or `unresolved` — or one
 * still polling — carries the service's own id too. Written only on the
 * resolved path, as it first was, the column was null for exactly the rows
 * anyone asks a support question about, which is the opposite of what §4.1
 * says it is for.
 *
 * This test exists to stop that statement being deleted as dead weight: every
 * case below reads null without it, and the resolved path's own row update
 * covers none of them.
 */
test('every outcome records the service lookup id, not only the resolved one', async () => {
  const cases = [
    { outcome: 'refused', envelope: refusedEnvelope({ lookupId: 'lookup-refused', refusal: 'a subtitle' }) },
    { outcome: 'unresolved', envelope: unresolvedEnvelope({ lookupId: 'lookup-unresolved' }) },
    { outcome: 'pending', envelope: pendingEnvelope({ lookupId: 'lookup-pending' }) },
    { outcome: 'partial', envelope: partialEnvelope({ lookupId: 'lookup-partial' }) },
  ];

  for (const { outcome, envelope } of cases) {
    const { harness, deps, rssItemId } = fixture();
    // eslint-disable-next-line no-await-in-loop -- each case owns a fresh in-memory database, so there is nothing here for a parallel run to overlap
    await applyEnvelope(envelope, { rssItemId, filename: 'item.mkv', polls: 0 }, deps);
    const row = harness.raw
      .prepare(`SELECT lookup_id, updated_at FROM ${PLUGIN_ID}_lookup WHERE rss_item_id = ?`)
      .get(rssItemId);
    // Single columns read off a row, so no prototype is involved and these
    // need no normalising — see `rows()` in the flow test for the other case.
    assert.equal(row?.['lookup_id'], envelope.lookupId, `the ${outcome} outcome records its lookup id`);
    assert.equal(row?.['updated_at'], NOW, `the ${outcome} outcome stamps the row from the injected clock`);
  }
});
