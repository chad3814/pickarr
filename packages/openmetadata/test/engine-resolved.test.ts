import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-sqlite';
import type { PluginContext } from '@pickarr/contract';
import { ARTWORK_JOB } from '../src/artwork/job.ts';
import { applyEnvelope } from '../src/engine.ts';
import { lookupTable, lookupTableMigration } from '../src/table.ts';
import { createTestHarness, refusedEnvelope, resolvedEnvelope, unresolvedEnvelope } from '../src/testing.ts';
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

test('the release is linked before the plugin applies, so a throwing apply strands no answer', async () => {
  // **The call-site half of a two-part guarantee, and the half nothing
  // pinned.** `MediaWriter.relinkRssItem` clears `lookup_json` in the same
  // statement that sets `media_item_id`, because a stored lookup answer is
  // only reachable while a release is unmatched. That fix is worth nothing
  // unless the link really does happen before the steps that can fail:
  // `apply` is plugin code and `attachPeople` walks a cast, and a throw in
  // either used to leave the row linked with its answer retained. The job
  // retries and then dead-letters, so a persistently failing `apply`
  // stranded the answer permanently, on a row `/unmatched` no longer shows.
  //
  // The existing order assertion above covers the first four *media* calls
  // and cannot see this: `apply` is a `deps` function, not a `ctx.media`
  // one, so it never enters `harness.media.calls`. This drives the failure
  // instead of inspecting the order, which is the same distinction
  // `CLAUDE.md` draws about pinning a function versus pinning its call
  // site.
  const { harness, deps, rssItemId } = fixture();
  const boom = new Error('the plugin could not write its own rows');

  await assert.rejects(
    () => applyEnvelope(
      resolvedEnvelope({ lookupId: 'lookup-7', media: movieMedia() }),
      { rssItemId, filename: 'dune.mkv', polls: 0 },
      { ...deps, apply: async () => { throw boom; } },
    ),
    (err: unknown) => err === boom,
    'the throw propagates, so the job fails and retries rather than reporting success',
  );

  const methods = harness.media.calls.map((call) => call.method);
  assert.ok(methods.includes('relinkRssItem'), 'the link happened before the plugin could fail');
  assert.ok(
    !methods.includes('setResolution'),
    'and the resolution did not -- which is exactly why the clear cannot be left to it',
  );
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

test('a resolved lookup enqueues one artwork job for the item it resolved', async () => {
  const { harness, deps, rssItemId } = fixture();

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-10', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  const artwork = harness.enqueued.filter((job) => job.kind === ARTWORK_JOB);
  assert.equal(artwork.length, 1, 'one job for the item, not one per person');
  // Every field spelled out, and `mediaItemId` spelled as the literal `1`
  // rather than read back out of `harness.media.items`: an expectation
  // computed from the code under test cannot see that code change.
  //
  // The two `people` entries are the second half of what this pins. The
  // fixture's cast is three parts naming two provider refs, and the payload
  // names people the database actually holds -- `upsertPerson` is keyed on
  // `provider_ref`, so the ref that plays cast and director is one `person`
  // row and gets one picture fetched, not two.
  assert.deepEqual(artwork[0]?.payload, {
    mediaItemId: 1,
    kind: 'movie',
    provider: 'tmdb',
    providerRef: 'tmdb:movie:693134',
    people: [
      { personId: 1, providerRef: 'tmdb:person:1' },
      { personId: 2, providerRef: 'tmdb:person:2' },
    ],
    parents: [],
  });
});

test('the artwork job names the media item that kept the claim, not the one that lost it', async () => {
  // The happy path cannot tell `claim.kept` from the row this call created:
  // they are the same number. A lost dedup race is where they differ, and
  // the artwork has to be fetched for the row everything else was pointed
  // at -- a job naming the dropped row would download four images and
  // attach them to nothing.
  const { harness, deps, rssItemId } = fixture();
  harness.media.loseNextClaim(99);

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-11', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );

  const artwork = harness.enqueued.filter((job) => job.kind === ARTWORK_JOB);
  assert.equal(artwork.length, 1);
  assert.deepEqual(artwork[0]?.payload, {
    mediaItemId: 99,
    kind: 'movie',
    provider: 'tmdb',
    providerRef: 'tmdb:movie:693134',
    people: [
      { personId: 1, providerRef: 'tmdb:person:1' },
      { personId: 2, providerRef: 'tmdb:person:2' },
    ],
    parents: [],
  });
});

test('the artwork payload carries the ancestors, nearest first and this provider\u2019s only', async () => {
  // Without the ancestors nothing downstream can answer an episode: TMDB
  // has no images endpoint addressable by an episode's own ref, so the
  // source falls back to the nearest ancestor it can address -- and it can
  // only do that if this enqueue hands them over.
  const { harness, deps, rssItemId } = fixture();
  const media: Media = {
    ...movieMedia(),
    kind: 'episode',
    providerRef: 'tmdb:episode:9',
    parents: [
      { id: 's', kind: 'season', title: 'Season 1', releaseDate: null, year: null, provider: 'tmdb', providerRef: 'tmdb:season:1' },
      { id: 'r', kind: 'series', title: 'A Show', releaseDate: null, year: null, provider: 'tmdb', providerRef: 'tmdb:series:1' },
      // Another provider's ref means nothing to the source being asked,
      // which is the one `media.provider` names.
      { id: 'x', kind: 'series', title: 'Elsewhere', releaseDate: null, year: null, provider: 'tvdb', providerRef: 'tvdb:series:1' },
    ],
  };

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-14', media }),
    { rssItemId, filename: 'show.s01e01.mkv', polls: 0 },
    deps,
  );

  const artwork = harness.enqueued.filter((job) => job.kind === ARTWORK_JOB);
  assert.deepEqual(artwork[0]?.payload, {
    mediaItemId: 1,
    kind: 'episode',
    provider: 'tmdb',
    providerRef: 'tmdb:episode:9',
    people: [
      { personId: 1, providerRef: 'tmdb:person:1' },
      { personId: 2, providerRef: 'tmdb:person:2' },
    ],
    // Nearest first, the order the service gave: it is what decides which
    // ancestor a source falls back to. The `tvdb` entry is gone.
    parents: [
      { kind: 'season', providerRef: 'tmdb:season:1' },
      { kind: 'series', providerRef: 'tmdb:series:1' },
    ],
  });
});

test('a refused or unresolved lookup enqueues nothing', async () => {
  // Neither outcome has a media item, so there is nothing to fetch artwork
  // for. Both drive the same assertion because they are two different
  // branches of `applyEnvelope` and only one of them was ever likely to
  // grow an enqueue by accident.
  const refused = fixture();
  await applyEnvelope(
    refusedEnvelope({ lookupId: 'lookup-12', refusal: 'this is a subtitle' }),
    { rssItemId: refused.rssItemId, filename: 'dune.srt', polls: 0 },
    refused.deps,
  );
  assert.deepEqual(refused.harness.enqueued.map((job) => job.kind), []);

  const unresolved = fixture();
  await applyEnvelope(
    unresolvedEnvelope({ lookupId: 'lookup-13' }),
    { rssItemId: unresolved.rssItemId, filename: 'dune.mkv', polls: 0 },
    unresolved.deps,
  );
  assert.deepEqual(unresolved.harness.enqueued.map((job) => job.kind), []);
});

test('the enqueue happens after the resolution is recorded', async () => {
  // One direction only: a job that ran before `setResolution` could read a
  // row mid-write. Pinned by asking the recording writer what it had been
  // told *at the moment* `enqueue` was called, which is what the fake's
  // call list already captures -- `enqueue` itself is not a `ctx.media`
  // call, so it never lands in that list and the order cannot be read off
  // it afterwards.
  const { harness, deps, rssItemId } = fixture();
  const seen: string[][] = [];
  const ctx: PluginContext = {
    ...harness.ctx,
    jobs: {
      async enqueue(job) {
        seen.push(harness.media.calls.map((call) => call.method));
        return await harness.ctx.jobs.enqueue(job);
      },
    },
  };

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-14', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    { ...deps, ctx },
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.at(-1), 'setResolution', 'the release was resolved before the job was queued');
});

test('a failing enqueue does not fail the lookup', async () => {
  // The whole premise of a separate job: artwork cannot break
  // identification. A queue that refuses the job leaves the release
  // identified and says so in a log line, rather than throwing and having
  // the job runner retry an identification that already succeeded.
  const { harness, deps, rssItemId } = fixture();
  const boom = new Error('the job queue is unavailable');
  const ctx: PluginContext = {
    ...harness.ctx,
    jobs: { async enqueue(): Promise<number> { throw boom; } },
  };

  await applyEnvelope(
    resolvedEnvelope({ lookupId: 'lookup-15', media: movieMedia() }),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    { ...deps, ctx },
  );

  assert.deepEqual(
    harness.media.resolutions.get(rssItemId),
    { resolution: 'resolved', detail: null, lookupJson: null },
    'the release stays identified',
  );
  const logged = harness.logs.filter((entry) => entry.detail?.['error'] === 'the job queue is unavailable');
  assert.equal(logged.length, 1, 'and the failure is logged rather than swallowed');
  assert.equal(logged[0]?.detail?.['mediaItemId'], 1);
});
