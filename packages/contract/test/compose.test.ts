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
  // set the lookup state of whatever rss item happens to share that rowid. A
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
  // Never actually executed -- see the comment below -- so these bytes need
  // not be a real image; the point is that `ImageInit` takes bytes and no
  // caller-supplied width or height.
  const bytes = new Uint8Array([0]);
  await ctx.media.attachPoster(claim.kept, {
    title: null, language: null, url: 'https://example.com/poster.jpg', bytes, rank: 0,
  });
  await ctx.media.attachBackground(claim.kept, {
    title: null, language: null, url: 'https://example.com/bg.jpg', bytes, rank: 0,
  });
  await ctx.media.attachLogo(claim.kept, {
    title: null, language: null, url: 'https://example.com/logo.jpg', bytes, rank: 0,
  });
  const personId = await ctx.media.upsertPerson({ name: 'Someone', providerRef: 'p1' });
  await ctx.media.attachRole(claim.kept, { personId, role: 'cast', name: null, billingOrder: 0 });
  // No envelope to store for a resolved answer -- and `null` clears any
  // an earlier failed attempt at this item left behind.
  await ctx.media.setLookupState(rssItemId, 'resolved', null, null);
};

const fixture: MediaPlugin = {
  id: 'fixture',
  mediaType: 'movie',
  migrations: [{ version: 1, up: () => {} }],
  jobs: { lookup },
  synced: [],
  // A resolver per key, which is the whole of `PluginTokens`: there is no
  // way to declare `year` here and leave nothing to answer for it. Each
  // reads something real off the two arguments a resolver is handed, so the
  // signature is proven to compose rather than merely to be satisfiable by
  // `async () => null`.
  tokens: {
    title: async (_file, ctx: PluginContext) => (await ctx.read.mediaItem(1))?.title ?? null,
    year: async (_file, ctx: PluginContext) => (await ctx.read.mediaItem(1))?.releaseDate?.slice(0, 4) ?? null,
    filename: async (file) => file.path,
    ext: async (file) => String(file.rssItemId),
  },
  onNewRssItems: async (ids, ctx: PluginContext) => {
    await ctx.jobs.enqueue({ kind: 'lookup', payload: { ids } });
  },
  onDownloadedFile: async () => {},
  onDownloadRequest: async (rssItemId, ctx: PluginContext) => {
    // The client's own reference must be read, not `void` behind an ignored
    // await — the null check below only compiles if `submit` kept its
    // promised `string | null` return type.
    const reference = await ctx.downloads.submit({ rssItemId });
    ctx.log('submitted download', { reference: reference === null ? null : reference.toUpperCase() });
  },
  onMediaItemDropped: async () => {},
  onLookupRequest: async () => {},
};

test('the contract composes into a whole plugin', () => {
  // The compile is the assertion; this keeps the fixture from being pruned as
  // unused and states what the file is for.
  assert.equal(fixture.id, 'fixture');
  assert.equal(Object.keys(fixture.jobs).length, 1);
});
