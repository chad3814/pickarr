import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobHandler, MediaPlugin, PluginContext } from '../src/index.ts';

/**
 * A full implementation of the contract, existing to prove the contract
 * composes. If a `MediaWriter` method returns something no handler can consume,
 * or an entry point's signature disagrees with `JobHandler`'s, this file stops
 * compiling — which is the assertion. `npm run typecheck` is the gate.
 */
const lookup: JobHandler = async (job, ctx) => {
  // The rss item id comes from the payload, not from `job.id`. Both are
  // numbers, so passing the job's own id would compile and be wrong — it would
  // set the resolution of whatever rss item happens to share that rowid. A
  // handler's payload is the only thing that knows which item it is about.
  const { rssItemId } = job.payload as { rssItemId: number };

  const mediaItemId = await ctx.media.createMediaItem({
    pluginId: 'fixture', title: 'A Title', releaseDate: null, description: null,
  });
  const claim = await ctx.media.claimProviderRef(mediaItemId, 'tmdb', 'movie:1');
  if (claim.dropped !== null) {
    await ctx.media.dropMediaItem(claim.dropped);
    await ctx.media.relinkRssItem(rssItemId, claim.kept);
  }
  await ctx.media.attachPoster(claim.kept, {
    title: null, language: null, url: 'https://example.com/poster.jpg', width: 300, height: 450,
  });
  await ctx.media.attachBackground(claim.kept, {
    title: null, description: null, language: null, url: 'https://example.com/bg.jpg', width: 1920, height: 1080,
  });
  const personId = await ctx.media.upsertPerson({ name: 'Someone', providerRef: 'p1' });
  await ctx.media.attachRole(claim.kept, { personId, role: 'cast', name: null, billingOrder: 0 });
  await ctx.media.setResolution(rssItemId, 'resolved', null);
};

const fixture: MediaPlugin = {
  id: 'fixture',
  mediaType: 'movie',
  migrations: [{ version: 1, up: () => {} }],
  jobs: { lookup },
  onNewRssItems: async (ids, ctx: PluginContext) => {
    await ctx.jobs.enqueue({ kind: 'lookup', payload: { ids } });
  },
  onDownloadedFile: async () => {},
  onDownloadRequest: async (rssItemId, ctx: PluginContext) => {
    // The client's own reference must be a real string, not `void` behind an
    // ignored await — `.toUpperCase()` only compiles if `submit` kept its
    // promised return type.
    const reference = await ctx.downloads.submit({ rssItemId, downloadClientId: 1 });
    ctx.log('submitted download', { reference: reference.toUpperCase() });
  },
};

test('the contract composes into a whole plugin', () => {
  // The compile is the assertion; this keeps the fixture from being pruned as
  // unused and states what the file is for.
  assert.equal(fixture.id, 'fixture');
  assert.equal(Object.keys(fixture.jobs).length, 1);
});
