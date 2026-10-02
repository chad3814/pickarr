import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { LOOKUP_JSON_CAP_BYTES, LOOKUP_JSON_TOO_LARGE } from '@pickarr/contract';
import {
  MAX_POLLS,
  POLL_DELAY_MS,
  POLL_JOB,
  applyEnvelope,
  describeUnresolved,
} from '../src/engine.ts';
import { lookupTable, lookupTableMigration } from '../src/table.ts';
import { lookupJsonFor } from '../src/lookupJson.ts';
import {
  createTestHarness,
  partialEnvelope,
  pendingEnvelope,
  refusedEnvelope,
  unresolvedEnvelope,
  withResolution,
} from '../src/testing.ts';
import type { LookupEnvelope, Media } from '../src/types.ts';

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

test('a partial answer polls, and leaves the lookup state alone', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(partialEnvelope({ lookupId: 'lookup-1' }), { rssItemId, filename: 'item.mkv', posted: 'item.mkv', polls: 0 }, deps);

  assert.equal(harness.enqueued.length, 1);
  assert.equal(harness.enqueued[0]?.kind, POLL_JOB);
  assert.deepEqual(harness.enqueued[0]?.payload, { lookupId: 'lookup-1', rssItemId, polls: 1, posted: 'item.mkv' });
  assert.equal(harness.enqueued[0]?.runAt, NOW + POLL_DELAY_MS);
  // Nothing is known about the item yet, so nothing is recorded about it.
  assert.equal(harness.media.lookupStates.size, 0);
});

test('a lookup still pending stores nothing, because nothing is known yet', async () => {
  // Pinned separately from the partial case above, and against
  // `setLookupState` directly rather than only the size of `lookupStates`:
  // a later change that starts writing a half-answer for every pending
  // release would still leave `lookupStates.size` at 0 today (nothing else
  // populates it in this fixture), but it would show up here as a call
  // this test does not expect.
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(pendingEnvelope({ lookupId: 'lookup-1b' }), { rssItemId, filename: 'item.mkv', posted: 'item.mkv', polls: 0 }, deps);

  const setLookupStateCalls = harness.media.calls.filter((call) => call.method === 'setLookupState');
  assert.deepEqual(setLookupStateCalls, [], 'the poll branch returns before calling setLookupState at all');
});

test('a pending state polls too -- the state, not only the flag', async () => {
  const { harness, deps, rssItemId } = fixture();
  await applyEnvelope(pendingEnvelope({ lookupId: 'lookup-2' }), { rssItemId, filename: 'item.mkv', posted: 'item.mkv', polls: 3 }, deps);
  assert.equal(harness.enqueued[0]?.kind, POLL_JOB);
  assert.deepEqual(harness.enqueued[0]?.payload, { lookupId: 'lookup-2', rssItemId, polls: 4, posted: 'item.mkv' });
});

test('the last permitted poll gives up, naming the lookup id, and stores the envelope behind it', async () => {
  const { harness, deps, rssItemId } = fixture();
  const envelope = pendingEnvelope({ lookupId: 'lookup-3' });

  await applyEnvelope(envelope, { rssItemId, filename: 'item.mkv', posted: 'item.mkv', polls: MAX_POLLS }, deps);

  assert.equal(harness.enqueued.length, 0, 'no further poll is scheduled');
  const recorded = harness.media.lookupStates.get(rssItemId);
  assert.equal(recorded?.state, 'unresolved');
  assert.match(recorded?.detail ?? '', /lookup-3/);
  // The service never finished, so the last envelope it sent -- whatever it
  // managed to fill in -- is the only record of how far it got.
  assert.equal(recorded?.lookupJson, lookupJsonFor(envelope));
});

test('a refusal is terminal: the lookup state says so and nothing else is written', async () => {
  const { harness, deps, rssItemId, applied } = fixture('item.srt');

  await applyEnvelope(
    refusedEnvelope({ lookupId: 'lookup-4', refusal: 'a subtitle' }),
    { rssItemId, filename: 'item.srt', posted: 'item.srt', polls: 0 },
    deps,
  );

  assert.deepEqual(harness.media.lookupStates.get(rssItemId), {
    state: 'refused',
    detail: 'a subtitle',
    lookupJson: lookupJsonFor(refusedEnvelope({ lookupId: 'lookup-4', refusal: 'a subtitle' })),
  });
  assert.equal(harness.enqueued.length, 0);
  assert.equal(applied.length, 0);
  assert.equal(harness.media.items.size, 0, 'a refusal creates no media item to clean up');
});

test('an unresolved answer stores the envelope behind it', async () => {
  const { harness, deps, rssItemId } = fixture('mystery2.mkv');
  const envelope = unresolvedEnvelope({ lookupId: 'lookup-5b' });

  await applyEnvelope(envelope, { rssItemId, filename: 'mystery2.mkv', posted: 'mystery2.mkv', polls: 0 }, deps);

  const recorded = harness.media.lookupStates.get(rssItemId);
  assert.equal(recorded?.state, 'unresolved');
  assert.equal(recorded?.lookupJson, lookupJsonFor(envelope));
});

test('an unresolved answer for a linked release leaves lookup_json NULL, and an unlinked one stores it', async () => {
  const linked = fixture('linked.mkv');
  linked.harness.raw.prepare('UPDATE rss_item SET media_item_id = 1 WHERE id = ?').run(linked.rssItemId);
  const envelope = unresolvedEnvelope({ lookupId: 'lookup-linked' });
  await applyEnvelope(envelope, { rssItemId: linked.rssItemId, filename: 'linked.mkv', posted: 'linked.mkv', polls: 0 }, linked.deps);
  const linkedState = linked.harness.media.lookupStates.get(linked.rssItemId);
  assert.equal(linkedState?.state, 'unresolved');
  assert.match(linkedState?.detail ?? '', /linked\.mkv/);
  assert.equal(linkedState?.lookupJson, null);

  const unlinked = fixture('unlinked.mkv');
  await applyEnvelope(envelope, { rssItemId: unlinked.rssItemId, filename: 'unlinked.mkv', posted: 'unlinked.mkv', polls: 0 }, unlinked.deps);
  assert.equal(unlinked.harness.media.lookupStates.get(unlinked.rssItemId)?.lookupJson, lookupJsonFor(envelope));
});

test('a refusal for a linked release leaves lookup_json NULL', async () => {
  const { harness, deps, rssItemId } = fixture('linked.srt');
  harness.raw.prepare('UPDATE rss_item SET media_item_id = 1 WHERE id = ?').run(rssItemId);
  await applyEnvelope(
    refusedEnvelope({ lookupId: 'lookup-lr', refusal: 'a subtitle' }),
    { rssItemId, filename: 'linked.srt', posted: 'linked.srt', polls: 0 },
    deps,
  );
  const recorded = harness.media.lookupStates.get(rssItemId);
  assert.equal(recorded?.state, 'refused');
  assert.equal(recorded?.lookupJson, null);
});

test('an unresolved answer names what the service was asked, not the filename', async () => {
  const { harness, deps, rssItemId } = fixture('real-file.mkv');
  await applyEnvelope(
    unresolvedEnvelope({ lookupId: 'lookup-typed' }),
    { rssItemId, filename: 'real-file.mkv', posted: 'Typed Name', polls: 0 },
    deps,
  );
  const detail = harness.media.lookupStates.get(rssItemId)?.detail ?? '';
  assert.match(detail, /Typed Name/);
  assert.doesNotMatch(detail, /real-file/);
});

test('the expiry sentence names what the service was asked, and the poll payload carries it', async () => {
  const { harness, deps, rssItemId } = fixture('real-file.mkv');
  await applyEnvelope(
    pendingEnvelope({ lookupId: 'lookup-p' }),
    { rssItemId, filename: 'real-file.mkv', posted: 'Typed Name', polls: 0 },
    deps,
  );
  assert.deepEqual(harness.enqueued[0]?.payload, { lookupId: 'lookup-p', rssItemId, polls: 1, posted: 'Typed Name' });
  await applyEnvelope(
    pendingEnvelope({ lookupId: 'lookup-p' }),
    { rssItemId, filename: 'real-file.mkv', posted: 'Typed Name', polls: MAX_POLLS },
    deps,
  );
  const detail = harness.media.lookupStates.get(rssItemId)?.detail ?? '';
  assert.match(detail, /Typed Name/);
  assert.doesNotMatch(detail, /real-file/);
});

test('an envelope over the cap is stored as the marker', async () => {
  // Built the same way `lookupJson.test.ts` measures its own boundary: pad
  // `parsed.blob` with enough plain ASCII to push the serialised envelope
  // past `LOOKUP_JSON_CAP_BYTES`, so this reaches the cap through the real
  // engine call site rather than only through `lookupJsonFor` directly.
  const { harness, deps, rssItemId } = fixture('huge.mkv');
  const envelope = {
    ...unresolvedEnvelope({ lookupId: 'lookup-huge' }),
    parsed: { blob: 'x'.repeat(LOOKUP_JSON_CAP_BYTES * 2) },
  };

  await applyEnvelope(envelope, { rssItemId, filename: 'huge.mkv', posted: 'huge.mkv', polls: 0 }, deps);

  assert.equal(harness.media.lookupStates.get(rssItemId)?.lookupJson, LOOKUP_JSON_TOO_LARGE);
});

test('an unrecognised name is unresolved, and says only that', async () => {
  const { harness, deps, rssItemId } = fixture('mystery.mkv');

  await applyEnvelope(unresolvedEnvelope({ lookupId: 'lookup-5' }), { rssItemId, filename: 'mystery.mkv', posted: 'mystery.mkv', polls: 0 }, deps);

  const recorded = harness.media.lookupStates.get(rssItemId);
  assert.equal(recorded?.state, 'unresolved');
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
    { rssItemId, filename: 'site.performer.mp4', posted: 'site.performer.mp4', polls: 0 },
    deps,
  );

  const detail = harness.media.lookupStates.get(rssItemId)?.detail ?? '';
  assert.match(detail, /Maddie Wren/);
  assert.match(detail, /A Performer/);
});

test('a resolved answer with no media throws rather than writing nothing quietly', async () => {
  const { deps, rssItemId } = fixture();
  const broken = { ...unresolvedEnvelope({ lookupId: 'lookup-7' }), state: 'resolved' as const };
  await assert.rejects(
    () => applyEnvelope(broken, { rssItemId, filename: 'item.mkv', posted: 'item.mkv', polls: 0 }, deps),
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

  await applyEnvelope(both, { rssItemId, filename: 'item.mkv', posted: 'item.mkv', polls: 0 }, deps);

  assert.equal(harness.enqueued[0]?.kind, POLL_JOB);
  assert.equal(harness.media.lookupStates.size, 0);
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
    await applyEnvelope(envelope, { rssItemId, filename: 'item.mkv', posted: 'item.mkv', polls: 0 }, deps);
    const row = harness.raw
      .prepare(`SELECT lookup_id, updated_at FROM ${PLUGIN_ID}_lookup WHERE rss_item_id = ?`)
      .get(rssItemId);
    // Single columns read off a row, so no prototype is involved and these
    // need no normalising — see `rows()` in the flow test for the other case.
    assert.equal(row?.['lookup_id'], envelope.lookupId, `the ${outcome} outcome records its lookup id`);
    assert.equal(row?.['updated_at'], NOW, `the ${outcome} outcome stamps the row from the injected clock`);
  }
});

test('a terminal non-resolved outcome records the video resolution the answer parsed', async () => {
  // The resolved outcome is `engine-resolved.test.ts`'s.
  const cases: readonly [string, LookupEnvelope, string | null][] = [
    ['unresolved', withResolution(unresolvedEnvelope({ lookupId: 'b' }), '720p'), '720p'],
    ['refused', refusedEnvelope({ lookupId: 'c', refusal: 'a sidecar' }), null],
    ['malformed', withResolution(unresolvedEnvelope({ lookupId: 'f' }), '4K'), null],
  ];
  for (const [name, envelope, expected] of cases) {
    const { harness, deps, rssItemId } = fixture();
    // eslint-disable-next-line no-await-in-loop -- one fresh fixture per case, in order
    await applyEnvelope(envelope, { rssItemId, filename: 'item.mkv', posted: 'item.mkv', polls: 0 }, deps);
    assert.ok(harness.media.videoResolutions.has(rssItemId), `${name}: written`);
    assert.equal(harness.media.videoResolutions.get(rssItemId), expected, `${name}: value`);
  }
});

test('a partial or pending answer that polls again writes no video resolution', async () => {
  // Any write to `rss_item` moves its `updated_at`, which `/unmatched`'s
  // Retry button reads as "the retry landed" -- so a write here would
  // re-enable the button while polling continues, and rewrite the row on
  // every poll. Even a partial answer that already carries a parse waits.
  const cases: readonly [string, LookupEnvelope][] = [
    ['partial', withResolution(partialEnvelope({ lookupId: 'd' }), '2160p')],
    ['pending', withResolution(pendingEnvelope({ lookupId: 'e' }), '1080p')],
  ];
  for (const [name, envelope] of cases) {
    const { harness, deps, rssItemId } = fixture();
    // eslint-disable-next-line no-await-in-loop -- one fresh fixture per case, in order
    await applyEnvelope(envelope, { rssItemId, filename: 'item.mkv', posted: 'item.mkv', polls: 0 }, deps);
    assert.equal(harness.enqueued[0]?.kind, POLL_JOB, `${name}: it polls again`);
    assert.ok(!harness.media.videoResolutions.has(rssItemId), `${name}: nothing written`);
  }
});

test('the poll that gives up records the video resolution of the last envelope', async () => {
  // The service never finished, so its last envelope is the best parse there is.
  const { harness, deps, rssItemId } = fixture();
  const envelope = withResolution(pendingEnvelope({ lookupId: 'lookup-expired' }), '720p');

  await applyEnvelope(envelope, { rssItemId, filename: 'item.mkv', posted: 'item.mkv', polls: MAX_POLLS }, deps);

  assert.equal(harness.enqueued.length, 0, 'no further poll is scheduled');
  assert.ok(harness.media.videoResolutions.has(rssItemId), 'written');
  assert.equal(harness.media.videoResolutions.get(rssItemId), '720p');
});
