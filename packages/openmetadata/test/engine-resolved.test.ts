import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { applyEnvelope } from '../src/engine.ts';
import { lookupTable, lookupTableMigration } from '../src/table.ts';
import { createTestHarness, resolvedEnvelope, unresolvedEnvelope } from '../src/testing.ts';
import type { ApplyArgs } from '../src/engine.ts';
import type { Media } from '../src/types.ts';

const PLUGIN_ID = 'movie';
const NOW = 1_700_000_000_000;

function movieMedia(): Media {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    kind: 'movie',
    title: 'Dune: Part Two',
    releaseDate: '2024-03-01',
    year: 2024,
    provider: 'tmdb',
    providerRef: 'tmdb:movie:693134',
    overview: 'Paul unites with the Fremen.',
    details: { runtimeMinutes: 166 },
    parents: [],
    people: [
      { providerRef: 'tmdb:person:1', name: 'First Billed', role: 'cast', characterName: 'Paul', billingOrder: 0 },
      { providerRef: 'tmdb:person:2', name: 'Second Billed', role: 'cast', characterName: 'Chani', billingOrder: 1 },
      { providerRef: 'tmdb:person:1', name: 'First Billed', role: 'director', characterName: null, billingOrder: null },
    ],
  };
}

function fixture() {
  const harness = createTestHarness();
  lookupTableMigration(PLUGIN_ID).up(harness.raw);
  const rssItemId = harness.insertRssItem('dune.mkv');
  harness.raw.prepare(
    `INSERT INTO ${PLUGIN_ID}_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)`,
  ).run(rssItemId, NOW, NOW);
  const applied: ApplyArgs[] = [];
  const deps = {
    pluginId: PLUGIN_ID,
    ctx: harness.ctx,
    raw: harness.raw,
    db: drizzle({ client: harness.raw }),
    table: lookupTable(PLUGIN_ID),
    now: NOW,
    // Accepts everything by default; the mis-kind test below passes its own.
    check: (): void => {},
    apply: async (args: ApplyArgs) => { applied.push(args); },
  };
  return { harness, deps, rssItemId, applied };
}

/**
 * `node:sqlite` rows come back with a null prototype, so `assert.deepEqual`
 * (which is `deepStrictEqual` under `node:assert/strict`, and compares
 * prototypes) fails against an object literal even when every column
 * matches. Normalized the same way `test/table.test.ts` does.
 */
function stateRow(harness: ReturnType<typeof fixture>['harness']) {
  const row = harness.raw.prepare(
    `SELECT media_item_id, lookup_id, provider_ref, confidence, updated_at FROM ${PLUGIN_ID}_lookup`,
  ).get();
  return Object.assign({}, row);
}

test('creates the media item from the answer and claims its provider reference', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-1', confidence: 0.94, media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  const item = harness.media.items.get(1);
  assert.equal(item?.title, 'Dune: Part Two');
  assert.equal(item?.releaseDate, '2024-03-01');
  // `description` comes from the answer's `overview`.
  assert.equal(item?.description, 'Paul unites with the Fremen.');
  assert.equal(item?.provider, 'tmdb');
  assert.equal(item?.providerRef, 'tmdb:movie:693134');
  assert.deepEqual(
    harness.media.resolutions.get(rssItemId),
    { resolution: 'resolved', detail: null, lookupJson: null },
  );
});

test('a resolved answer stores no envelope, and clears one left by an earlier failure', async () => {
  // The clear is the half a happy-path test misses, and it is what bounds
  // `rss_item.lookup_json`: a release that failed, was retried and matched
  // must not keep a copy of the answer that failed it. Driven through two
  // real `applyEnvelope` calls against the same rss item -- an unresolved
  // attempt first, so there is a real envelope in `resolutions` to lose --
  // rather than asserting `null` as if nothing had ever been written.
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    unresolvedEnvelope({ lookupId: 'lookup-fail' }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );
  assert.notEqual(
    harness.media.resolutions.get(rssItemId)?.lookupJson,
    null,
    'the failed attempt left an envelope behind',
  );

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-9', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  // Asserted as an explicit `null` fourth argument, not as "absent": the
  // recording fake stores exactly what `setResolution` was called with, so
  // this fails if the resolved branch ever stops passing a fourth argument
  // at all just as surely as if it passed something other than `null`.
  const setResolutionCalls = harness.media.calls.filter((call) => call.method === 'setResolution');
  assert.deepEqual(setResolutionCalls.at(-1)?.args, [rssItemId, 'resolved', null, null]);
  assert.equal(harness.media.resolutions.get(rssItemId)?.lookupJson, null, 'the retry clears the earlier envelope');
});

test('records the lookup id, the reference and the confidence on its own row', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-2', confidence: 0.81, media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  assert.deepEqual(stateRow(harness), {
    media_item_id: 1,
    lookup_id: 'lookup-2',
    provider_ref: 'tmdb:movie:693134',
    confidence: 0.81,
    updated_at: NOW,
  });
});

test('hands the plugin the media item it should write against', async () => {
  const { deps, rssItemId, applied } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-3', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  assert.equal(applied.length, 1);
  assert.equal(applied[0]?.mediaItemId, 1);
  assert.equal(applied[0]?.media.providerRef, 'tmdb:movie:693134');
  assert.equal(applied[0]?.now, NOW);
});

test('writes each person once and each part in billing order', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-4', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  // Three parts, two people: the same provider ref plays cast and director.
  assert.equal(harness.media.roles.length, 3);
  assert.deepEqual(harness.media.roles.map((role) => role.role), ['cast', 'cast', 'director']);
  assert.equal(harness.media.roles[0]?.personId, 1);
  assert.equal(harness.media.roles[1]?.personId, 2);
  assert.equal(harness.media.roles[2]?.personId, 1, 'one person, two parts');
  assert.equal(harness.media.roles[0]?.name, 'Paul');
  assert.equal(harness.media.roles[0]?.billingOrder, 0);
});

test('a lost claim drops our row, links the winner, and applies against it', async () => {
  const { harness, deps, rssItemId, applied } = fixture();
  harness.media.loseNextClaim(99);

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-5', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  const methods = harness.media.calls.map((call) => call.method);
  assert.deepEqual(methods.slice(0, 4), ['createMediaItem', 'claimProviderRef', 'dropMediaItem', 'relinkRssItem']);
  assert.equal(harness.media.items.has(1), false, 'the row that lost is gone');
  assert.deepEqual(harness.media.calls[3]?.args, [rssItemId, 99]);
  assert.equal(applied[0]?.mediaItemId, 99, 'the plugin writes against the winner');
  assert.equal(stateRow(harness)?.['media_item_id'], 99);
});

test('the resolution is written last, after the rows a reader would then look for', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-6', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  const methods = harness.media.calls.map((call) => call.method);
  assert.equal(methods.at(-1), 'setResolution');
});

test('a plugin that cannot represent the answer refuses it before a single shared row exists', async () => {
  const { harness, deps, rssItemId, applied } = fixture();
  // Exactly the guard each plugin's `apply` used to hold alone: a kind this
  // plugin cannot write. Held here instead, it runs before `createMediaItem`
  // -- which is the whole point, because a throw from `apply` arrives after
  // the media item exists, holds the provider-ref claim, and has the rss item
  // relinked to it, with nothing left to drop any of that.
  const refusing = {
    ...deps,
    check: (media: Media): void => {
      throw new Error(`a movies lookup answered with kind ${media.kind}`);
    },
  };

  await assert.rejects(
    () => applyEnvelope(
      resolvedEnvelope({ lookupId: 'lookup-8', media: { ...movieMedia(), kind: 'scene' } }),
      { rssItemId, filename: 'dune.mkv', polls: 0 },
      refusing,
    ),
    /kind scene/,
  );

  assert.deepEqual(
    harness.media.calls.map((call) => call.method),
    [],
    'no media item, no claim, no relink, no resolution',
  );
  assert.equal(applied.length, 0, 'and the plugin was never asked to write its own rows');
  assert.equal(stateRow(harness)?.['media_item_id'], null);
});

test('a null confidence is stored as null rather than refused', async () => {
  const { harness, deps, rssItemId } = fixture();
  const envelope = { ...resolvedEnvelope({ lookupId: 'lookup-7', media: movieMedia() }), confidence: null };

  await applyEnvelope(envelope, { rssItemId, filename: 'dune.mkv', polls: 0 }, deps);

  assert.equal(stateRow(harness)?.['confidence'], null);
});
