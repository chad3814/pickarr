import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { HostFetch, ImageInit, JobRecord, MediaWriter, PluginContext } from '@pickarr/contract';
import { ARTWORK_JOB, ARTWORK_KEEP, createArtworkJob } from '../../src/artwork/job.ts';
import type { ArtworkJobPayload } from '../../src/artwork/job.ts';
import type { ArtworkAnswer, ArtworkParent, ArtworkSource, ProviderImage } from '../../src/artwork/source.ts';
import { rankImages } from '../../src/artwork/source.ts';
import { createTestHarness } from '../../src/testing.ts';

function image(url: string, fields: { language?: string | null; score?: number } = {}): ProviderImage {
  return { url, language: fields.language ?? null, score: fields.score ?? 0 };
}

function answer(fields: {
  posters?: readonly ProviderImage[];
  backgrounds?: readonly ProviderImage[];
  logos?: readonly ProviderImage[];
  people?: Readonly<Record<string, readonly ProviderImage[]>>;
  noCredential?: true;
}): ArtworkAnswer {
  const media = {
    posters: fields.posters ?? [],
    backgrounds: fields.backgrounds ?? [],
    logos: fields.logos ?? [],
  };
  const people = new Map(Object.entries(fields.people ?? {}));
  // Two shapes rather than one literal with `noCredential: undefined`:
  // `exactOptionalPropertyTypes` makes an absent key and an explicit
  // `undefined` different things, and the field is declared `?: true`.
  return fields.noCredential === undefined ? { media, people } : { media, people, noCredential: true };
}

interface AskedFor {
  kind: string;
  providerRef: string;
  personRefs: readonly string[];
  parents: readonly ArtworkParent[];
}

/** A source that answers from a script, recording exactly what it was asked. */
function scriptedSource(reply: ArtworkAnswer | Error): { source: ArtworkSource; asked: AskedFor[] } {
  const asked: AskedFor[] = [];
  const source: ArtworkSource = {
    async imagesFor(kind, providerRef, personRefs, parents): Promise<ArtworkAnswer> {
      asked.push({ kind, providerRef, personRefs, parents });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { source, asked };
}

/** A registry factory for `ArtworkJobDeps.sources`, over a literal map. */
function registryOf(entries: Readonly<Record<string, ArtworkSource>>) {
  const map = new Map<string, ArtworkSource>(Object.entries(entries));
  return () => map;
}

/**
 * A `HostFetch` whose `bytes` answers from a url table, repeatedly -- a
 * second run of the same job asks for the same urls again, and must be able
 * to get them.
 */
function bytesFetch(table: Readonly<Record<string, Uint8Array | Error>>): {
  fetch: HostFetch;
  asked: string[];
  /** The `init` each `bytes` call was given, in the same order as `asked`. */
  inits: (RequestInit | undefined)[];
} {
  const asked: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetch: HostFetch = {
    async json(): Promise<never> {
      throw new Error('bytesFetch: the artwork job makes no json call of its own');
    },
    async bytes(url: string, init?: RequestInit): Promise<Uint8Array> {
      asked.push(url);
      inits.push(init);
      const found = table[url];
      if (found === undefined) throw new Error(`bytesFetch: nothing scripted for ${url}`);
      if (found instanceof Error) throw found;
      return found;
    },
  };
  return { fetch, asked, inits };
}

/**
 * The `MediaWriter` methods the artwork job must never reach. Throwing
 * rather than recording is deliberate: a double that quietly tolerated a
 * `createMediaItem` or a `setLookupState` could not tell anyone the job made
 * one.
 */
function unused(method: string): () => never {
  return () => {
    throw new Error(`${method}: the artwork job must not call this`);
  };
}

interface Attached {
  /** `poster`, `background`, `logo`, or `person`. */
  what: string;
  /** The media item id, or the person id for `person`. */
  id: number;
  init: ImageInit;
  /** Position among every attach and keep call the writer saw, so a test can assert one ran after another. */
  at: number;
}

/** One `keepArtwork` or `keepPersonImages` call. */
interface Kept {
  /** `poster`, `background`, `logo`, or `person`. */
  what: string;
  id: number;
  urls: readonly string[];
  /** As `Attached.at`. */
  at: number;
}

interface AttachWriter {
  writer: MediaWriter;
  attached: Attached[];
  kept: Kept[];
  /** Makes every attach of this url reject, the way `ArtworkStore` refuses bytes it cannot measure. */
  refuse(url: string): void;
}

/** A `MediaWriter` whose four attach and two keep methods record and whose other seven throw. */
function attachWriter(): AttachWriter {
  const attached: Attached[] = [];
  const kept: Kept[] = [];
  const refused = new Set<string>();
  let calls = 0;

  function record(what: string, id: number, init: ImageInit): void {
    if (refused.has(init.url)) {
      // The shape `MediaWriter.attachPoster` really fails in: it calls
      // `ArtworkStore.put` first, which throws for bytes `image-size`
      // cannot measure -- an html error page served 200 looks like this.
      throw new Error(`artwork store: bytes for ${init.url} could not be measured as an image`);
    }
    attached.push({ what, id, init, at: calls++ });
  }

  function keep(what: string, id: number, urls: readonly string[]): void {
    kept.push({ what, id, urls: [...urls], at: calls++ });
  }

  const writer: MediaWriter = {
    createMediaItem: unused('createMediaItem'),
    updateMediaItem: unused('updateMediaItem'),
    claimProviderRef: unused('claimProviderRef'),
    relinkRssItem: unused('relinkRssItem'),
    reassignRelease: unused('reassignRelease'),
    dropMediaItemRows: unused('dropMediaItemRows'),
    dropMediaItem: unused('dropMediaItem'),
    upsertPerson: unused('upsertPerson'),
    attachRole: unused('attachRole'),
    setLookupState: unused('setLookupState'),
    setVideoResolution: unused('setVideoResolution'),
    async attachPoster(mediaItemId, poster): Promise<void> { record('poster', mediaItemId, poster); },
    async attachBackground(mediaItemId, background): Promise<void> { record('background', mediaItemId, background); },
    async attachLogo(mediaItemId, logo): Promise<void> { record('logo', mediaItemId, logo); },
    async attachPersonImage(personId, picture): Promise<void> { record('person', personId, picture); },
    async keepArtwork(kind, mediaItemId, urls): Promise<void> { keep(kind, mediaItemId, urls); },
    async keepPersonImages(personId, urls): Promise<void> { keep('person', personId, urls); },
  };

  return { writer, attached, kept, refuse: (url) => refused.add(url) };
}

function payloadFor(fields: Partial<ArtworkJobPayload> = {}): ArtworkJobPayload {
  return {
    mediaItemId: fields.mediaItemId ?? 7,
    kind: fields.kind ?? 'movie',
    provider: fields.provider ?? 'tmdb',
    providerRef: fields.providerRef ?? 'ref-1',
    people: fields.people ?? [],
    parents: fields.parents ?? [],
  };
}

function jobRecord(payload: ArtworkJobPayload): JobRecord {
  return { id: 1, kind: ARTWORK_JOB, payload, attempts: 1 };
}

/** A `PluginContext` with a scripted `HostFetch` and a chosen `MediaWriter`. */
function contextWith(fetch: HostFetch, writer: MediaWriter): {
  ctx: PluginContext;
  logs: readonly { message: string; detail: Readonly<Record<string, unknown>> | undefined }[];
} {
  const harness = createTestHarness({ fetch });
  return { ctx: { ...harness.ctx, media: writer }, logs: harness.logs };
}

const BYTES = new Uint8Array([137, 80, 78, 71]);

function urlsOf(attached: readonly Attached[], what: string): string[] {
  return attached.filter((entry) => entry.what === what).map((entry) => entry.init.url);
}

/** `count` images of one language whose scores fall as the index rises, so `rankImages` keeps their order. */
function descending(prefix: string, count: number): ProviderImage[] {
  return Array.from({ length: count }, (_, index) =>
    image(`https://cdn.test/${prefix}-${String(index)}.jpg`, { language: 'en', score: 100 - index }));
}

test('a resolved item gets up to ARTWORK_KEEP of each kind, ranked', async () => {
  assert.equal(ARTWORK_KEEP, 5);
  // Seven posters, scrambled, across all three language tiers, so which
  // five survive and in what order is `rankImages`' decision. The expected
  // urls are spelled literally: a test that asked `rankImages` for them
  // could not see it rank differently.
  const posters = [
    image('https://cdn.test/p-foreign.jpg', { language: 'fr', score: 99 }),
    image('https://cdn.test/p-en-3.jpg', { language: 'en', score: 3 }),
    image('https://cdn.test/p-neutral-8.jpg', { language: null, score: 8 }),
    image('https://cdn.test/p-en-5.jpg', { language: 'en', score: 5 }),
    image('https://cdn.test/p-neutral-2.jpg', { language: null, score: 2 }),
    image('https://cdn.test/p-en-9.jpg', { language: 'en', score: 9 }),
    image('https://cdn.test/p-en-1.jpg', { language: 'en', score: 1 }),
  ];
  const backgrounds = [
    image('https://cdn.test/back-low.jpg', { language: 'en', score: 1 }),
    image('https://cdn.test/back-high.jpg', { language: 'en', score: 6 }),
    image('https://cdn.test/back-neutral.jpg', { language: null, score: 9 }),
  ];
  const logos = [image('https://cdn.test/logo-de.png', { language: 'de', score: 9 })];
  const { source } = scriptedSource(answer({ posters, backgrounds, logos }));
  // **Every** offered url is downloadable, including the ones that should
  // lose. A table holding only the winners would mask a job that tried to
  // store all of them: the losers would fail to download, be isolated, and
  // the count would come out right for the wrong reason.
  const { fetch, asked } = bytesFetch(Object.fromEntries(
    [...posters, ...backgrounds, ...logos].map((entry) => [entry.url, BYTES]),
  ));
  const writer = attachWriter();
  const { ctx } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({ mediaItemId: 42 })), ctx);

  const topFivePosters = [
    'https://cdn.test/p-en-9.jpg',
    'https://cdn.test/p-en-5.jpg',
    'https://cdn.test/p-en-3.jpg',
    'https://cdn.test/p-en-1.jpg',
    'https://cdn.test/p-neutral-8.jpg',
  ];
  // The attaches settle concurrently, so within a kind they are read back by rank.
  const byRank = (what: string) => writer.attached
    .filter((entry) => entry.what === what)
    .toSorted((a, b) => a.init.rank - b.init.rank);
  assert.deepEqual(
    byRank('poster').map((entry) => [entry.init.url, entry.init.rank]),
    topFivePosters.map((url, rank) => [url, rank]),
  );
  assert.deepEqual(byRank('background').map((entry) => [entry.init.url, entry.init.rank]), [
    ['https://cdn.test/back-high.jpg', 0],
    ['https://cdn.test/back-low.jpg', 1],
    ['https://cdn.test/back-neutral.jpg', 2],
  ]);
  assert.deepEqual(byRank('logo').map((entry) => [entry.init.url, entry.init.rank]), [['https://cdn.test/logo-de.png', 0]]);
  // Five, three and one attaches and no more: the sixth and seventh posters
  // are never even fetched, so the cut happens before the network.
  assert.equal(writer.attached.length, 9);
  assert.equal(asked.length, 9);
  assert.ok(!asked.includes('https://cdn.test/p-foreign.jpg'));
  assert.ok(!asked.includes('https://cdn.test/p-neutral-2.jpg'));
  // All against the media item from the payload, not the job id.
  assert.ok(writer.attached.every((entry) => entry.id === 42));
  // The provider's own language travels onto the row.
  assert.equal(byRank('poster')[0]?.init.language, 'en');
  assert.equal(byRank('poster')[4]?.init.language, null);

  // One keep call per kind, naming exactly what was attached.
  assert.deepEqual(writer.kept.map((entry) => [entry.what, entry.id, entry.urls.toSorted()]), [
    ['poster', 42, topFivePosters.toSorted()],
    ['background', 42, ['https://cdn.test/back-high.jpg', 'https://cdn.test/back-low.jpg', 'https://cdn.test/back-neutral.jpg']],
    ['logo', 42, ['https://cdn.test/logo-de.png']],
  ]);
  // The literal list agrees with `rankImages`: the job did not re-implement it.
  assert.deepEqual(rankImages(posters, 'en').slice(0, ARTWORK_KEEP).map((entry) => entry.url), topFivePosters);
});

test('a url the provider lists twice is attached once and kept once, and does not take a second slot', async () => {
  const posters = [
    image('https://cdn.test/dup.jpg', { language: 'en', score: 9 }),
    image('https://cdn.test/dup.jpg', { language: 'en', score: 9 }),
    image('https://cdn.test/next.jpg', { language: 'en', score: 1 }),
  ];
  const { source } = scriptedSource(answer({ posters }));
  const { fetch } = bytesFetch({ 'https://cdn.test/dup.jpg': BYTES, 'https://cdn.test/next.jpg': BYTES });
  const writer = attachWriter();
  const { ctx } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({ mediaItemId: 42 })), ctx);

  assert.deepEqual(
    writer.attached.filter((entry) => entry.what === 'poster').toSorted((a, b) => a.init.rank - b.init.rank)
      .map((entry) => [entry.init.url, entry.init.rank]),
    [['https://cdn.test/dup.jpg', 0], ['https://cdn.test/next.jpg', 1]],
  );
  const keptPosters = writer.kept.filter((entry) => entry.what === 'poster');
  assert.equal(keptPosters.length, 1);
  assert.deepEqual(keptPosters[0]?.urls.toSorted(), ['https://cdn.test/dup.jpg', 'https://cdn.test/next.jpg']);
});

test('each person gets up to ARTWORK_KEEP pictures, and one keepPersonImages', async () => {
  const faces = descending('a', 3);
  const { source, asked } = scriptedSource(answer({
    people: {
      'person-a': faces,
      'person-b': [image('https://cdn.test/b-only.jpg')],
      // A person the payload never asked about: a source is free to answer
      // more than it was asked, and nothing may be stored for someone this
      // job holds no `personId` for.
      'person-unasked': [image('https://cdn.test/unasked.jpg')],
    },
  }));
  // Every url is downloadable, the unasked-for included, so that a job
  // which stored the wrong people is caught by the count rather than
  // rescued by a download that was never scripted.
  const { fetch } = bytesFetch(Object.fromEntries(
    [...faces, image('https://cdn.test/b-only.jpg'), image('https://cdn.test/unasked.jpg')].map((entry) => [entry.url, BYTES]),
  ));
  const writer = attachWriter();
  const { ctx } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({
    people: [
      { personId: 11, providerRef: 'person-a' },
      { personId: 12, providerRef: 'person-b' },
      // Asked for, but the source found nothing -- an omitted key is
      // ordinary, not an error (`ArtworkAnswer.people`).
      { personId: 13, providerRef: 'person-c' },
    ],
  })), ctx);

  // The refs reach the source exactly as the payload holds them: the seam
  // is asked in the provider's vocabulary.
  assert.deepEqual(asked[0]?.personRefs, ['person-a', 'person-b', 'person-c']);
  assert.deepEqual(
    writer.attached.map((entry) => [entry.what, entry.id, entry.init.url, entry.init.rank]).toSorted(),
    [
      ['person', 11, 'https://cdn.test/a-0.jpg', 0],
      ['person', 11, 'https://cdn.test/a-1.jpg', 1],
      ['person', 11, 'https://cdn.test/a-2.jpg', 2],
      ['person', 12, 'https://cdn.test/b-only.jpg', 0],
    ],
  );
  assert.deepEqual(writer.kept.map((entry) => [entry.what, entry.id, entry.urls.toSorted()]), [
    ['person', 11, ['https://cdn.test/a-0.jpg', 'https://cdn.test/a-1.jpg', 'https://cdn.test/a-2.jpg']],
    ['person', 12, ['https://cdn.test/b-only.jpg']],
  ]);
});

test('keepArtwork is called once per kind, after every attach of that kind settled', async () => {
  const posters = descending('p', 4);
  const backgrounds = descending('b', 2);
  const faces = descending('f', 3);
  const { source } = scriptedSource(answer({ posters, backgrounds, people: { 'person-a': faces } }));
  const { fetch } = bytesFetch(Object.fromEntries([...posters, ...backgrounds, ...faces].map((entry) => [entry.url, BYTES])));
  const writer = attachWriter();
  const { ctx } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({ mediaItemId: 3, people: [{ personId: 11, providerRef: 'person-a' }] })), ctx);

  assert.deepEqual(writer.kept.map((entry) => entry.what), ['poster', 'background', 'person'], 'once per kind that had images');
  const lastAttach = Math.max(...writer.attached.map((entry) => entry.at));
  for (const entry of writer.kept) {
    assert.ok(entry.at > lastAttach, `keep ${entry.what} ran at ${String(entry.at)}, before the last attach at ${String(lastAttach)}`);
  }
});

test('a failed download of the rank-1 image still keeps the other four and names only the four', async () => {
  const posters = descending('p', 5);
  const { source } = scriptedSource(answer({ posters }));
  const { fetch } = bytesFetch(Object.fromEntries(posters.map((entry) => [entry.url, BYTES])));
  const writer = attachWriter();
  writer.refuse('https://cdn.test/p-1.jpg');
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({ mediaItemId: 9 })), ctx);

  assert.deepEqual(
    writer.attached.map((entry) => [entry.init.url, entry.init.rank]).toSorted(),
    [
      ['https://cdn.test/p-0.jpg', 0],
      ['https://cdn.test/p-2.jpg', 2],
      ['https://cdn.test/p-3.jpg', 3],
      ['https://cdn.test/p-4.jpg', 4],
    ],
    'a rank is the provider ranking, so the survivors keep 0, 2, 3 and 4',
  );
  assert.equal(writer.kept.length, 1);
  assert.equal(writer.kept[0]?.what, 'poster');
  assert.deepEqual(writer.kept[0]?.urls.toSorted(), [
    'https://cdn.test/p-0.jpg',
    'https://cdn.test/p-2.jpg',
    'https://cdn.test/p-3.jpg',
    'https://cdn.test/p-4.jpg',
  ]);
  assert.equal(logs.filter((line) => line.message.includes('could not be stored')).length, 1);
});

test('a kind whose every download failed is not pruned', async () => {
  // Naming no survivors would delete what a previous run stored because of
  // a transient failure; storing nothing should change nothing.
  const posters = descending('p', 2);
  const backgrounds = descending('b', 1);
  const { source } = scriptedSource(answer({ posters, backgrounds }));
  const { fetch } = bytesFetch(Object.fromEntries([...posters, ...backgrounds].map((entry) => [entry.url, BYTES])));
  const writer = attachWriter();
  writer.refuse('https://cdn.test/p-0.jpg');
  writer.refuse('https://cdn.test/p-1.jpg');
  const { ctx } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({ mediaItemId: 9 })), ctx);

  assert.deepEqual(writer.kept.map((entry) => entry.what), ['background']);
});

test('the payload\u2019s ancestors reach the source', async () => {
  // The source-side fallback is worth nothing if the job does not hand the
  // ancestors over: dropping this argument would put every episode and
  // season card back to a 404 with every `tmdb.ts` test still green.
  const { source, asked } = scriptedSource(answer({}));
  const { fetch } = bytesFetch({});
  const writer = attachWriter();
  const { ctx } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({
    kind: 'episode',
    providerRef: 'ep-77',
    parents: [{ kind: 'season', providerRef: 'se-9' }, { kind: 'series', providerRef: '1399' }],
  })), ctx);

  // Nearest first, unchanged: the order is what decides which ancestor a
  // source falls back to.
  assert.deepEqual(asked[0]?.parents, [
    { kind: 'season', providerRef: 'se-9' },
    { kind: 'series', providerRef: '1399' },
  ]);
  assert.equal(asked[0]?.kind, 'episode');
});

test('a provider whose credential is not configured is reported once, not once per item', async () => {
  // The design's "absent is not an error" rule has a second half -- "logs
  // once and fetches no artwork for it" -- and without this an operator
  // with no key gets blank cards and no diagnostic at all.
  const { source } = scriptedSource(answer({ noCredential: true }));
  const { fetch, asked } = bytesFetch({});
  const writer = attachWriter();
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({ mediaItemId: 1, provider: 'tmdb' })), ctx);
  await handler(jobRecord(payloadFor({ mediaItemId: 2, provider: 'tmdb' })), ctx);

  const reported = logs.filter((line) => line.message.includes('no credential is configured'));
  assert.equal(reported.length, 1, 'one line for the provider, not one per item');
  assert.equal(reported[0]?.detail?.['provider'], 'tmdb');
  // Not a failure, and nothing downloaded: the job succeeds and the item
  // simply has no pictures.
  assert.deepEqual(asked, []);
  assert.deepEqual(writer.attached, []);
});

test('a second provider with no credential is reported separately', async () => {
  const { fetch } = bytesFetch({});
  const writer = attachWriter();
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({
    resolveSecret: async () => 'unused',
    sources: registryOf({
      tmdb: scriptedSource(answer({ noCredential: true })).source,
      tpdb: scriptedSource(answer({ noCredential: true })).source,
    }),
  });
  await handler(jobRecord(payloadFor({ provider: 'tmdb' })), ctx);
  await handler(jobRecord(payloadFor({ provider: 'tpdb' })), ctx);

  assert.deepEqual(
    logs.filter((line) => line.message.includes('no credential is configured')).map((line) => line.detail?.['provider']),
    ['tmdb', 'tpdb'],
  );
});

test('a configured provider with no pictures for an item says nothing', async () => {
  // The flag, not the emptiness, is what the log keys off: an item a
  // provider simply has no artwork for is ordinary and must stay silent,
  // or the once-per-provider line would fire for the first such item and
  // then never again for a host that really has no key.
  const { source } = scriptedSource(answer({}));
  const { fetch } = bytesFetch({});
  const writer = attachWriter();
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({ provider: 'tmdb' })), ctx);

  assert.deepEqual(logs, []);
});

test('a provider with no registered source logs once, not once per item', async () => {
  const { fetch, asked } = bytesFetch({});
  const writer = attachWriter();
  const { ctx, logs } = contextWith(fetch, writer.writer);

  // One handler, as the plugin holds one: the whole point is that the
  // second item sees the first item's knowledge.
  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: scriptedSource(answer({})).source }) });
  await handler(jobRecord(payloadFor({ mediaItemId: 1, provider: 'tpdb' })), ctx);
  await handler(jobRecord(payloadFor({ mediaItemId: 2, provider: 'tpdb' })), ctx);

  const reported = logs.filter((line) => line.message.includes('no source is registered'));
  assert.equal(reported.length, 1, 'one line for the provider, not one per item');
  assert.equal(reported[0]?.detail?.['provider'], 'tpdb');
  // And nothing was attempted for either item.
  assert.deepEqual(writer.attached, []);
  assert.deepEqual(asked, []);
});

test('a second unregistered provider is reported separately', async () => {
  // The "once" above is once per provider, not once ever: a host meeting a
  // second unknown provider must still hear about it.
  const { fetch } = bytesFetch({});
  const writer = attachWriter();
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({}) });
  await handler(jobRecord(payloadFor({ provider: 'tmdb' })), ctx);
  await handler(jobRecord(payloadFor({ provider: 'tpdb' })), ctx);

  assert.deepEqual(
    logs.filter((line) => line.message.includes('no source is registered')).map((line) => line.detail?.['provider']),
    ['tmdb', 'tpdb'],
  );
});

test('a source that throws leaves the media item alone and fails only the job', async () => {
  const boom = new Error('tmdb: /3/movie/ref-1/images answered 500');
  const { source } = scriptedSource(boom);
  const { fetch, asked } = bytesFetch({});
  const writer = attachWriter();
  const { ctx } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  // The job fails, which is how a wholesale source failure becomes visible
  // and retried. Nothing about the media item changed: the writer's other
  // eight methods throw if called at all, and no image was downloaded.
  await assert.rejects(handler(jobRecord(payloadFor()), ctx), /answered 500/);
  assert.deepEqual(writer.attached, []);
  assert.deepEqual(asked, []);
});

test('a download the store refuses does not stop the other images', async () => {
  // `ArtworkStore.put` rejects bytes `image-size` cannot measure -- an html
  // error page served 200 looks exactly like this. One bad poster must not
  // cost the backdrop, the logo or the cast.
  const { source } = scriptedSource(answer({
    posters: [image('https://cdn.test/poster.jpg')],
    backgrounds: [image('https://cdn.test/back.jpg')],
    logos: [image('https://cdn.test/logo.png')],
    people: { 'person-a': [image('https://cdn.test/face.jpg')] },
  }));
  const { fetch } = bytesFetch({
    'https://cdn.test/poster.jpg': BYTES,
    'https://cdn.test/back.jpg': BYTES,
    'https://cdn.test/logo.png': BYTES,
    'https://cdn.test/face.jpg': BYTES,
  });
  const writer = attachWriter();
  writer.refuse('https://cdn.test/poster.jpg');
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({ people: [{ personId: 11, providerRef: 'person-a' }] })), ctx);

  // The other three landed -- not merely "nothing threw".
  assert.deepEqual(
    writer.attached.map((entry) => entry.init.url).toSorted(),
    ['https://cdn.test/back.jpg', 'https://cdn.test/face.jpg', 'https://cdn.test/logo.png'],
  );
  assert.deepEqual(urlsOf(writer.attached, 'poster'), []);
  const complaints = logs.filter((line) => line.message.includes('could not be stored'));
  assert.equal(complaints.length, 1);
  assert.equal(complaints[0]?.detail?.['what'], 'poster 0');
});

test('a download that 404s does not stop the other images', async () => {
  const { source } = scriptedSource(answer({
    posters: [image('https://cdn.test/gone.jpg')],
    backgrounds: [image('https://cdn.test/back.jpg')],
  }));
  const { fetch } = bytesFetch({
    'https://cdn.test/gone.jpg': new Error('fetch https://cdn.test/gone.jpg failed: 404 Not Found'),
    'https://cdn.test/back.jpg': BYTES,
  });
  const writer = attachWriter();
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor()), ctx);

  assert.deepEqual(urlsOf(writer.attached, 'background'), ['https://cdn.test/back.jpg']);
  assert.deepEqual(urlsOf(writer.attached, 'poster'), []);
  assert.equal(logs.filter((line) => line.message.includes('could not be stored')).length, 1);
});

test('an oversized image is refused after download, as the second line the spec names', async () => {
  // 8 MiB, spelled out here rather than imported: a test that took the cap
  // from the module could not see the cap change.
  const CAP = 8 * 1024 * 1024;
  const { source } = scriptedSource(answer({
    posters: [image('https://cdn.test/huge.jpg')],
    backgrounds: [image('https://cdn.test/exactly-at-the-cap.jpg')],
  }));
  const { fetch } = bytesFetch({
    'https://cdn.test/huge.jpg': new Uint8Array(CAP + 1),
    // The boundary from the other side: at the cap is stored, so the check
    // cannot have been written as `>=` and still pass.
    'https://cdn.test/exactly-at-the-cap.jpg': new Uint8Array(CAP),
  });
  const writer = attachWriter();
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor()), ctx);

  assert.deepEqual(urlsOf(writer.attached, 'poster'), []);
  assert.deepEqual(urlsOf(writer.attached, 'background'), ['https://cdn.test/exactly-at-the-cap.jpg']);
  const refusals = logs.filter((line) => line.message.includes('exceeded the size cap'));
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0]?.detail?.['cap'], CAP);
  assert.equal(refusals[0]?.detail?.['bytes'], CAP + 1);
  // The url is logged without its query -- a signed CDN url carries its
  // signature there, and a log line is where it would surface.
  assert.equal(refusals[0]?.detail?.['url'], 'https://cdn.test/huge.jpg');
});

test('a query string is dropped from a logged url', async () => {
  const { source } = scriptedSource(answer({ posters: [image('https://cdn.test/p.jpg?sig=deadbeef&exp=1')] }));
  const { fetch } = bytesFetch({
    'https://cdn.test/p.jpg?sig=deadbeef&exp=1': new Error('fetch failed: 403 Forbidden'),
  });
  const writer = attachWriter();
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor()), ctx);

  const complaint = logs.find((line) => line.message.includes('could not be stored'));
  assert.equal(complaint?.detail?.['url'], 'https://cdn.test/p.jpg');
});

test('a store refusal is logged without the query string its message embeds', async () => {
  // `ArtworkStore` builds its refusal as `bytes for ${url} could not be
  // measured as an image` -- the url verbatim, query and all -- and the
  // host's `redactDetail` walks **string** values only, so an `Error` put
  // in a detail object would reach the sink untouched. Both halves have to
  // hold for the guard beside them to be real.
  const signed = 'https://cdn.test/poster.jpg?sig=deadbeefcafe&exp=99';
  const { source } = scriptedSource(answer({
    posters: [image(signed)],
    backgrounds: [image('https://cdn.test/back.jpg')],
  }));
  const { fetch } = bytesFetch({ [signed]: BYTES, 'https://cdn.test/back.jpg': BYTES });
  const writer = attachWriter();
  writer.refuse(signed);
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor()), ctx);

  const complaint = logs.find((line) => line.message.includes('could not be stored'));
  assert.ok(complaint, 'the refusal was logged');
  // Nothing anywhere in the detail carries the signature -- not the `url`
  // field, not the message, not a nested `Error` nobody thought to walk.
  assert.ok(
    !JSON.stringify(complaint.detail).includes('deadbeefcafe'),
    'the signature must not reach the log in any field',
  );
  const logged = complaint.detail?.['error'];
  assert.equal(typeof logged, 'string', 'a string, so the host\'s string-only redaction can see it');
  assert.equal(
    logged,
    'artwork store: bytes for https://cdn.test/poster.jpg could not be measured as an image',
  );
  // And the diagnosis survives: the refusal still names which url failed.
  assert.equal(complaint.detail?.['url'], 'https://cdn.test/poster.jpg');
  // The backdrop is unaffected, as ever.
  assert.deepEqual(urlsOf(writer.attached, 'background'), ['https://cdn.test/back.jpg']);
});

test('the job\'s abort signal is forwarded to every download', async () => {
  // The dispatcher ties a signal to its per-job ceiling; a job downloading
  // from a hung CDN can only be cut off if this forwards it. Nothing else
  // in this file passes one, so without this the branch that builds the
  // `init` is unexercised.
  const { source } = scriptedSource(answer({
    posters: [image('https://cdn.test/p.jpg')],
    backgrounds: [image('https://cdn.test/b.jpg')],
  }));
  const { fetch, inits } = bytesFetch({
    'https://cdn.test/p.jpg': BYTES,
    'https://cdn.test/b.jpg': BYTES,
  });
  const writer = attachWriter();
  const { ctx } = contextWith(fetch, writer.writer);
  const controller = new AbortController();

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor()), ctx, controller.signal);

  assert.equal(inits.length, 2);
  // Compared as booleans, never handed to a formatter: identity is the
  // assertion, and the *same* signal must reach both downloads.
  assert.ok(inits.every((init) => init?.signal === controller.signal), 'every download carries the job signal');
});

test('no abort signal means no init at all, not an init holding undefined', async () => {
  // `exactOptionalPropertyTypes` makes those different things, which is the
  // whole reason the call site is a ternary rather than one expression.
  const { source } = scriptedSource(answer({ posters: [image('https://cdn.test/p.jpg')] }));
  const { fetch, inits } = bytesFetch({ 'https://cdn.test/p.jpg': BYTES });
  const writer = attachWriter();
  const { ctx } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor()), ctx);

  assert.deepEqual(inits, [undefined]);
});

test('a source with nothing to offer stores nothing and does not fail', async () => {
  // What a provider with no configured key answers: `createTmdbSource` and
  // `createTpdbSource` both return an empty answer rather than throwing, so
  // "no key" has to reach here as "no images" and cost nothing.
  const { source } = scriptedSource(answer({}));
  const { fetch, asked } = bytesFetch({});
  const writer = attachWriter();
  const { ctx, logs } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({ people: [{ personId: 11, providerRef: 'person-a' }] })), ctx);

  assert.deepEqual(writer.attached, []);
  assert.deepEqual(asked, []);
  assert.deepEqual(logs, []);
});

/**
 * A `MediaWriter` over the real artwork DDL: the four tables' columns and
 * their `UNIQUE (owner_id, url)` indexes, copied from the host's
 * `migrate.ts`, with the same `ON CONFLICT ... DO UPDATE` statements
 * `host/src/media/writer.ts` runs.
 *
 * A double rather than the host's writer because this package must not
 * import `@pickarr/host` (see `src/testing.ts`). What it makes observable is
 * the thing a recording double cannot: whether a second run of the job
 * leaves one row and one file per slot, or two. `width`/`height` are
 * constants here -- the real writer measures them through `ArtworkStore`,
 * and nothing in this test depends on their value.
 */
function storingWriter(): { writer: MediaWriter; rows(table: string): number; files: Map<string, Uint8Array> } {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE poster (
      id INTEGER PRIMARY KEY, media_item_id INTEGER NOT NULL, title TEXT, language TEXT,
      url TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, path TEXT, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX poster_media_item_url ON poster (media_item_id, url);
    CREATE TABLE background (
      id INTEGER PRIMARY KEY, media_item_id INTEGER NOT NULL, title TEXT, description TEXT, language TEXT,
      url TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, path TEXT, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX background_media_item_url ON background (media_item_id, url);
    CREATE TABLE logo (
      id INTEGER PRIMARY KEY, media_item_id INTEGER NOT NULL, title TEXT, language TEXT,
      url TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, path TEXT, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX logo_media_item_url ON logo (media_item_id, url);
    CREATE TABLE person_image (
      id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL, title TEXT, language TEXT,
      url TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, path TEXT, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX person_image_person_url ON person_image (person_id, url);
  `);
  // Keyed the way `createArtworkStore` keys its filenames: `(mediaItemId,
  // url)` for a media item and a disjoint `person:` namespace for a person,
  // so a person and a media item sharing an id and a url are still two
  // files.
  const files = new Map<string, Uint8Array>();

  function write(table: string, owner: string, ownerId: number, init: ImageInit, fileKey: string): void {
    files.set(fileKey, init.bytes);
    db.prepare(`
      INSERT INTO ${table} (${owner}, title, language, url, width, height, path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (${owner}, url) DO UPDATE
        SET title = excluded.title, language = excluded.language,
            width = excluded.width, height = excluded.height, path = excluded.path
    `).run(ownerId, init.title, init.language, init.url, 10, 10, `/artwork/${fileKey}.bin`, 0);
  }

  /** Drops the owner's rows whose url is not named, and their files -- `keepTop`'s contract. */
  function keep(table: string, owner: string, ownerId: number, urls: readonly string[], filePrefix: string): void {
    const kept = new Set(urls);
    const rows = db.prepare(`SELECT url FROM ${table} WHERE ${owner} = ?`).all(ownerId);
    for (const row of rows) {
      const url = String(row['url']);
      if (kept.has(url)) continue;
      db.prepare(`DELETE FROM ${table} WHERE ${owner} = ? AND url = ?`).run(ownerId, url);
      files.delete(`${filePrefix}${url}`);
    }
  }

  const writer: MediaWriter = {
    createMediaItem: unused('createMediaItem'),
    updateMediaItem: unused('updateMediaItem'),
    claimProviderRef: unused('claimProviderRef'),
    relinkRssItem: unused('relinkRssItem'),
    reassignRelease: unused('reassignRelease'),
    dropMediaItemRows: unused('dropMediaItemRows'),
    dropMediaItem: unused('dropMediaItem'),
    upsertPerson: unused('upsertPerson'),
    attachRole: unused('attachRole'),
    setLookupState: unused('setLookupState'),
    setVideoResolution: unused('setVideoResolution'),
    async attachPoster(id, init): Promise<void> { write('poster', 'media_item_id', id, init, `${id}:${init.url}`); },
    async attachBackground(id, init): Promise<void> { write('background', 'media_item_id', id, init, `${id}:${init.url}`); },
    async attachLogo(id, init): Promise<void> { write('logo', 'media_item_id', id, init, `${id}:${init.url}`); },
    async attachPersonImage(id, init): Promise<void> {
      write('person_image', 'person_id', id, init, `person:${id}:${init.url}`);
    },
    async keepArtwork(kind, id, urls): Promise<void> { keep(kind, 'media_item_id', id, urls, `${id}:`); },
    async keepPersonImages(id, urls): Promise<void> { keep('person_image', 'person_id', id, urls, `person:${id}:`); },
  };

  return {
    writer,
    rows(table: string): number {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      return Number((row as { n: unknown }).n);
    },
    files,
  };
}

test('running twice writes one row and one file per kept image', async () => {
  // The unique indexes make the second write a no-op; this proves the job
  // does not instead throw on the conflict -- and, just as load-bearing,
  // that the second run chooses the *same* urls, which is what `rankImages`'
  // url tiebreak exists for. A choice that varied between runs would write
  // a second row past every index.
  const { source } = scriptedSource(answer({
    posters: [
      image('https://cdn.test/p-a.jpg', { language: 'en', score: 5 }),
      image('https://cdn.test/p-b.jpg', { language: 'en', score: 5 }),
    ],
    backgrounds: [image('https://cdn.test/b.jpg')],
    logos: [image('https://cdn.test/l.png')],
    people: { 'person-a': [image('https://cdn.test/f.jpg'), image('https://cdn.test/g.jpg')] },
  }));
  const { fetch } = bytesFetch({
    'https://cdn.test/p-a.jpg': BYTES,
    'https://cdn.test/p-b.jpg': BYTES,
    'https://cdn.test/b.jpg': BYTES,
    'https://cdn.test/l.png': BYTES,
    'https://cdn.test/f.jpg': BYTES,
    'https://cdn.test/g.jpg': BYTES,
  });
  const store = storingWriter();
  const { ctx, logs } = contextWith(fetch, store.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  const job = jobRecord(payloadFor({ mediaItemId: 5, people: [{ personId: 11, providerRef: 'person-a' }] }));
  await handler(job, ctx);
  await handler(job, ctx);

  assert.equal(store.rows('poster'), 2);
  assert.equal(store.rows('background'), 1);
  assert.equal(store.rows('logo'), 1);
  assert.equal(store.rows('person_image'), 2);
  // One file per kept image, and the person's are in their own namespace.
  assert.deepEqual([...store.files.keys()].toSorted(), [
    '5:https://cdn.test/b.jpg',
    '5:https://cdn.test/l.png',
    '5:https://cdn.test/p-a.jpg',
    '5:https://cdn.test/p-b.jpg',
    'person:11:https://cdn.test/f.jpg',
    'person:11:https://cdn.test/g.jpg',
  ]);
  assert.deepEqual(logs, [], 'a second run is not an error and says nothing');
});

test('a malformed payload fails the job rather than storing a stranger', async () => {
  const { fetch } = bytesFetch({});
  const writer = attachWriter();
  const { ctx } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({}) });
  await assert.rejects(
    handler({ id: 1, kind: ARTWORK_JOB, payload: { mediaItemId: 1 }, attempts: 1 }, ctx),
    /must carry mediaItemId, kind, provider, providerRef, people and parents/,
  );
  await assert.rejects(
    handler(
      { id: 1, kind: ARTWORK_JOB, payload: { ...payloadFor(), people: [{ personId: '11', providerRef: 'a' }] }, attempts: 1 },
      ctx,
    ),
    /people\[0\] must carry personId and providerRef/,
  );
  await assert.rejects(
    handler(
      { id: 1, kind: ARTWORK_JOB, payload: { ...payloadFor(), parents: [{ kind: 'series' }] }, attempts: 1 },
      ctx,
    ),
    /parents\[0\] must carry kind and providerRef/,
  );
});
