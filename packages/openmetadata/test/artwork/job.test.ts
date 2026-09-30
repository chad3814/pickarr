import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { HostFetch, ImageInit, JobRecord, MediaWriter, PluginContext } from '@pickarr/contract';
import { ARTWORK_JOB, createArtworkJob } from '../../src/artwork/job.ts';
import type { ArtworkJobPayload } from '../../src/artwork/job.ts';
import type { ArtworkAnswer, ArtworkParent, ArtworkSource, ProviderImage } from '../../src/artwork/source.ts';
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
 * The eight `MediaWriter` methods the artwork job must never reach. Throwing
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
}

interface AttachWriter {
  writer: MediaWriter;
  attached: Attached[];
  /** Makes every attach of this url reject, the way `ArtworkStore` refuses bytes it cannot measure. */
  refuse(url: string): void;
}

/** A `MediaWriter` whose four attach methods record and whose other eight throw. */
function attachWriter(): AttachWriter {
  const attached: Attached[] = [];
  const refused = new Set<string>();

  function record(what: string, id: number, init: ImageInit): void {
    if (refused.has(init.url)) {
      // The shape `MediaWriter.attachPoster` really fails in: it calls
      // `ArtworkStore.put` first, which throws for bytes `image-size`
      // cannot measure -- an html error page served 200 looks like this.
      throw new Error(`artwork store: bytes for ${init.url} could not be measured as an image`);
    }
    attached.push({ what, id, init });
  }

  const writer: MediaWriter = {
    createMediaItem: unused('createMediaItem'),
    updateMediaItem: unused('updateMediaItem'),
    claimProviderRef: unused('claimProviderRef'),
    relinkRssItem: unused('relinkRssItem'),
    dropMediaItem: unused('dropMediaItem'),
    upsertPerson: unused('upsertPerson'),
    attachRole: unused('attachRole'),
    setLookupState: unused('setLookupState'),
    setVideoResolution: unused('setVideoResolution'),
    async attachPoster(mediaItemId, poster): Promise<void> { record('poster', mediaItemId, poster); },
    async attachBackground(mediaItemId, background): Promise<void> { record('background', mediaItemId, background); },
    async attachLogo(mediaItemId, logo): Promise<void> { record('logo', mediaItemId, logo); },
    async attachPersonImage(personId, picture): Promise<void> { record('person', personId, picture); },
  };

  return { writer, attached, refuse: (url) => refused.add(url) };
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

test('a resolved item gets one poster, one background and one logo', async () => {
  // Every kind is offered more than one image, so "one per slot" is a
  // counted property rather than the only thing available. The winners are
  // spelled literally: `bestImage` decides, and a test that asked it which
  // one it chose could not see it choose differently.
  const { source } = scriptedSource(answer({
    posters: [
      image('https://cdn.test/poster-fr.jpg', { language: 'fr', score: 9 }),
      image('https://cdn.test/poster-en.jpg', { language: 'en', score: 2 }),
      image('https://cdn.test/poster-neutral.jpg', { language: null, score: 8 }),
    ],
    backgrounds: [
      image('https://cdn.test/back-low.jpg', { language: 'en', score: 1 }),
      image('https://cdn.test/back-high.jpg', { language: 'en', score: 6 }),
    ],
    logos: [
      image('https://cdn.test/logo-de.png', { language: 'de', score: 9 }),
      image('https://cdn.test/logo-neutral.png', { language: null, score: 1 }),
    ],
  }));
  // **Every** offered url is downloadable, including the ones that should
  // lose. A table holding only the winners would mask a job that tried to
  // store all seven: the losers would fail to download, be isolated, and
  // the count would come out right for the wrong reason.
  const { fetch, asked } = bytesFetch({
    'https://cdn.test/poster-fr.jpg': BYTES,
    'https://cdn.test/poster-en.jpg': BYTES,
    'https://cdn.test/poster-neutral.jpg': BYTES,
    'https://cdn.test/back-low.jpg': BYTES,
    'https://cdn.test/back-high.jpg': BYTES,
    'https://cdn.test/logo-de.png': BYTES,
    'https://cdn.test/logo-neutral.png': BYTES,
  });
  const writer = attachWriter();
  const { ctx } = contextWith(fetch, writer.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  await handler(jobRecord(payloadFor({ mediaItemId: 42 })), ctx);

  assert.deepEqual(urlsOf(writer.attached, 'poster'), ['https://cdn.test/poster-en.jpg']);
  assert.deepEqual(urlsOf(writer.attached, 'background'), ['https://cdn.test/back-high.jpg']);
  assert.deepEqual(urlsOf(writer.attached, 'logo'), ['https://cdn.test/logo-neutral.png']);
  // Three attaches and no more: storing every image a provider offered
  // would be disk the serving route (#79) can never show.
  assert.equal(writer.attached.length, 3);
  // And three downloads: a loser is never even fetched, so the choice
  // happens before the network rather than after it.
  assert.deepEqual(asked.toSorted(), [
    'https://cdn.test/back-high.jpg',
    'https://cdn.test/logo-neutral.png',
    'https://cdn.test/poster-en.jpg',
  ]);
  // All three against the media item from the payload, not the job id.
  assert.deepEqual(writer.attached.map((entry) => entry.id), [42, 42, 42]);
  // The provider's own language travels onto the row, so the chosen
  // image's language is recoverable later.
  assert.equal(writer.attached[0]?.init.language, 'en');
  assert.equal(writer.attached[2]?.init.language, null);
});

test('each person gets one image', async () => {
  const { source, asked } = scriptedSource(answer({
    people: {
      'person-a': [
        image('https://cdn.test/a-low.jpg', { language: 'en', score: 1 }),
        image('https://cdn.test/a-high.jpg', { language: 'en', score: 7 }),
      ],
      'person-b': [image('https://cdn.test/b-only.jpg')],
      // A person the payload never asked about: a source is free to answer
      // more than it was asked, and nothing may be stored for someone this
      // job holds no `personId` for.
      'person-unasked': [image('https://cdn.test/unasked.jpg')],
    },
  }));
  // Every url is downloadable, the losers and the unasked-for included, so
  // that a job which stored the wrong people is caught by the count rather
  // than rescued by a download that was never scripted.
  const { fetch } = bytesFetch({
    'https://cdn.test/a-low.jpg': BYTES,
    'https://cdn.test/a-high.jpg': BYTES,
    'https://cdn.test/b-only.jpg': BYTES,
    'https://cdn.test/unasked.jpg': BYTES,
  });
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
    writer.attached.map((entry) => [entry.what, entry.id, entry.init.url]),
    [
      ['person', 11, 'https://cdn.test/a-high.jpg'],
      ['person', 12, 'https://cdn.test/b-only.jpg'],
    ],
  );
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
  assert.equal(complaints[0]?.detail?.['what'], 'poster');
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

  const writer: MediaWriter = {
    createMediaItem: unused('createMediaItem'),
    updateMediaItem: unused('updateMediaItem'),
    claimProviderRef: unused('claimProviderRef'),
    relinkRssItem: unused('relinkRssItem'),
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

test('running twice writes one row and one file per slot', async () => {
  // The unique indexes make the second write a no-op; this proves the job
  // does not instead throw on the conflict -- and, just as load-bearing,
  // that the second run chooses the *same* url, which is what `bestImage`'s
  // url tiebreak exists for. A choice that varied between runs would write
  // a second row past every index.
  const { source } = scriptedSource(answer({
    posters: [
      image('https://cdn.test/p-a.jpg', { language: 'en', score: 5 }),
      image('https://cdn.test/p-b.jpg', { language: 'en', score: 5 }),
    ],
    backgrounds: [image('https://cdn.test/b.jpg')],
    logos: [image('https://cdn.test/l.png')],
    people: { 'person-a': [image('https://cdn.test/f.jpg')] },
  }));
  const { fetch } = bytesFetch({
    'https://cdn.test/p-a.jpg': BYTES,
    'https://cdn.test/p-b.jpg': BYTES,
    'https://cdn.test/b.jpg': BYTES,
    'https://cdn.test/l.png': BYTES,
    'https://cdn.test/f.jpg': BYTES,
  });
  const store = storingWriter();
  const { ctx, logs } = contextWith(fetch, store.writer);

  const handler = createArtworkJob({ resolveSecret: async () => 'unused', sources: registryOf({ tmdb: source }) });
  const job = jobRecord(payloadFor({ mediaItemId: 5, people: [{ personId: 11, providerRef: 'person-a' }] }));
  await handler(job, ctx);
  await handler(job, ctx);

  assert.equal(store.rows('poster'), 1);
  assert.equal(store.rows('background'), 1);
  assert.equal(store.rows('logo'), 1);
  assert.equal(store.rows('person_image'), 1);
  // One file per slot, and the person's is in its own namespace.
  assert.deepEqual([...store.files.keys()].toSorted(), [
    '5:https://cdn.test/b.jpg',
    '5:https://cdn.test/l.png',
    '5:https://cdn.test/p-a.jpg',
    'person:11:https://cdn.test/f.jpg',
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
