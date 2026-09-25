import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostFetch } from '@pickarr/contract';
import type { SecretResolver } from '../../src/types.ts';
import { createTmdbSource } from '../../src/artwork/tmdb.ts';

/**
 * TMDB's own image object shape, as read live from `/3/movie/{id}/images`
 * (see the task brief): `file_path`, `iso_639_1` and `vote_average` are the
 * three fields this source reads. The others it carries (`width`, `height`,
 * `aspect_ratio`, `iso_3166_1`, `vote_count`) are omitted here because
 * nothing in `tmdb.ts` reads them.
 */
function image(filePath: string, language: string | null, score: number): Record<string, unknown> {
  return { file_path: filePath, iso_639_1: language, vote_average: score };
}

const CONFIGURATION_URL = 'https://api.themoviedb.org/3/configuration';
const CONFIGURATION_BODY = { images: { secure_base_url: 'https://image.tmdb.org/t/p/' } };

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * A `HostFetch` keyed by exact url rather than a queue, because a single
 * `imagesFor` call fans out to more than one url (configuration, the media
 * endpoint, zero or more person endpoints) and this way the test does not
 * have to predict which one the implementation happens to issue first. A
 * url with nothing scripted throws, which is what turns "the code called an
 * endpoint the test did not expect" into a failure instead of a silent
 * `undefined`.
 */
function fakeFetch(responses: Readonly<Record<string, unknown>>): {
  fetch: HostFetch;
  calls: readonly RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: HostFetch = {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      calls.push({ url, init });
      if (!Object.hasOwn(responses, url)) {
        throw new Error(`tmdb.test.ts: nothing scripted for ${url}`);
      }
      return responses[url] as T;
    },
    async bytes(): Promise<Uint8Array> {
      throw new Error('bytes: this source only ever calls json');
    },
  };
  return { fetch, calls };
}

function bearerResolver(token: string): SecretResolver {
  return async () => token;
}

/** Mimics `Secrets.get`'s rejection for a credential nobody configured -- see `packages/host/src/secrets/names.ts`. */
function missingSecretResolver(): SecretResolver {
  return async () => {
    const error = new Error('no value for secret');
    error.name = 'SecretNotFound';
    throw error;
  };
}

test('a movie’s images become posters, backgrounds and logos', async () => {
  const { fetch } = fakeFetch({
    [CONFIGURATION_URL]: CONFIGURATION_BODY,
    'https://api.themoviedb.org/3/movie/603/images': {
      id: 603,
      posters: [image('/poster.jpg', 'en', 8.4)],
      backdrops: [image('/backdrop.jpg', null, 5.1)],
      logos: [image('/logo.jpg', 'en', 3.2)],
    },
  });
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  const answer = await source.imagesFor('movie', '603', [], []);

  // The rename: the provider's `backdrops` becomes this codebase's
  // `background` here, and nowhere else -- the table, the writer and the
  // route all already say `background` (checked in `artwork-route.ts`).
  assert.deepEqual(answer.media.posters, [
    { url: 'https://image.tmdb.org/t/p/w780/poster.jpg', language: 'en', score: 8.4 },
  ]);
  assert.deepEqual(answer.media.backgrounds, [
    { url: 'https://image.tmdb.org/t/p/w1280/backdrop.jpg', language: null, score: 5.1 },
  ]);
  assert.deepEqual(answer.media.logos, [
    { url: 'https://image.tmdb.org/t/p/w300/logo.jpg', language: 'en', score: 3.2 },
  ]);
  assert.equal(answer.people.size, 0);
});

test('a television kind asks the television endpoint', async () => {
  const { fetch, calls } = fakeFetch({
    [CONFIGURATION_URL]: CONFIGURATION_BODY,
    'https://api.themoviedb.org/3/tv/1399/images': {
      id: 1399,
      posters: [image('/got.jpg', 'en', 9.0)],
      backdrops: [],
      logos: [],
    },
  });
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  const answer = await source.imagesFor('series', '1399', [], []);

  assert.equal(answer.media.posters[0]?.url, 'https://image.tmdb.org/t/p/w780/got.jpg');
  // Pinned because asking `/3/movie/{id}` for a series id answers a
  // *different show* rather than 404ing -- a wrong mapping that no test of
  // the happy path alone would ever notice.
  assert.ok(!calls.some((call) => call.url.includes('/3/movie/')), 'must not ask the movie endpoint for a series');
});

test('a kind TMDB has no images endpoint for, and no usable ancestor, asks nothing at all', async () => {
  // `book` and `scene` belong to the other two providers; `season` and
  // `episode` have no TMDB images endpoint of their own, and here neither
  // do their ancestors. Any of them reaching `fakeFetch` with nothing
  // scripted would throw and fail this test, which is the point: the
  // assertion is "zero calls", not "calls that happen to 404 gracefully".
  const { fetch, calls } = fakeFetch({});
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  // An ancestor is offered, and it is one this provider cannot address
  // either -- so the fallback finds nothing and the answer is still "ask
  // nothing", not "ask about the first parent in the list".
  const answer = await source.imagesFor('season', 'whatever', [], [{ kind: 'book', providerRef: 'p-1' }]);

  assert.equal(calls.length, 0);
  assert.deepEqual(answer.media, { posters: [], backgrounds: [], logos: [] });
  assert.equal(answer.people.size, 0);
});

test('an episode is answered with its series\u2019 images', async () => {
  // Without this fallback every episode card 404s its `<img>`, which is
  // the bulk of a television library and the exact symptom the feature
  // exists to end: a tv lookup resolves to `episode`, `season` or
  // `series` (`plugin-tv`'s `checkTv`) and only `series` is in
  // `MEDIA_KIND_PATH`.
  const { fetch, calls } = fakeFetch({
    [CONFIGURATION_URL]: CONFIGURATION_BODY,
    'https://api.themoviedb.org/3/tv/1399/images': {
      id: 1399,
      posters: [image('/got.jpg', 'en', 9.0)],
      backdrops: [],
      logos: [],
    },
  });
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  const answer = await source.imagesFor('episode', 'ep-77', [], [
    { kind: 'season', providerRef: 'se-9' },
    { kind: 'series', providerRef: '1399' },
  ]);

  // Spelled literally rather than built from the fixture: the url proves
  // both that the series ref was used and that the series *path* was.
  assert.equal(answer.media.posters[0]?.url, 'https://image.tmdb.org/t/p/w780/got.jpg');
  // The episode's own ref must never reach a url -- TMDB has no endpoint
  // that would answer it, so a request carrying it is a request to the
  // wrong thing rather than a harmless miss.
  assert.ok(!calls.some((call) => call.url.includes('ep-77')), 'the episode ref must not be asked about');
  assert.ok(!calls.some((call) => call.url.includes('se-9')), 'the unaddressable season must be skipped, not asked');
});

test('a season is answered with its series\u2019 images', async () => {
  const { fetch, calls } = fakeFetch({
    [CONFIGURATION_URL]: CONFIGURATION_BODY,
    'https://api.themoviedb.org/3/tv/1399/images': {
      id: 1399,
      posters: [],
      backdrops: [image('/backdrop.jpg', null, 5.1)],
      logos: [],
    },
  });
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  const answer = await source.imagesFor('season', 'se-9', [], [{ kind: 'series', providerRef: '1399' }]);

  assert.deepEqual(answer.media.backgrounds, [
    { url: 'https://image.tmdb.org/t/p/w1280/backdrop.jpg', language: null, score: 5.1 },
  ]);
  assert.ok(!calls.some((call) => call.url.includes('se-9')), 'the season ref must not be asked about');
});

test('an item that has an endpoint of its own ignores its ancestors', async () => {
  // The fallback is a fallback: a `series` with a `series` ancestor (a
  // shape nothing forbids) must still be asked about itself, or the
  // nearest-ancestor walk would quietly outrank the item.
  const { fetch } = fakeFetch({
    [CONFIGURATION_URL]: CONFIGURATION_BODY,
    'https://api.themoviedb.org/3/tv/1399/images': {
      id: 1399,
      posters: [image('/own.jpg', 'en', 9.0)],
      backdrops: [],
      logos: [],
    },
  });
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  const answer = await source.imagesFor('series', '1399', [], [{ kind: 'series', providerRef: '9999' }]);

  assert.equal(answer.media.posters[0]?.url, 'https://image.tmdb.org/t/p/w780/own.jpg');
});

test('a kind with no media endpoint still answers its people', async () => {
  // Pins the module docblock's ruling: `MEDIA_KIND_PATH` gates only the
  // media fetch, not the person fetches. Without this test, a reader
  // meeting an unmapped kind could "simplify" `imagesFor` into an early
  // return that skips person fetches too -- dropping every season's and
  // episode's cast pictures -- and nothing would redden, because the
  // previous test passes `personRefs: []` and can't see the difference.
  const { fetch, calls } = fakeFetch({
    [CONFIGURATION_URL]: CONFIGURATION_BODY,
    'https://api.themoviedb.org/3/person/500/images': {
      id: 500,
      profiles: [image('/face.jpg', null, 4.2)],
    },
  });
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  const answer = await source.imagesFor('season', 'whatever', ['500'], []);

  assert.deepEqual(answer.media, { posters: [], backgrounds: [], logos: [] });
  assert.ok(!calls.some((call) => /\/3\/[a-z]+\/whatever\/images$/.test(call.url)), 'no media images call for an unmapped kind');
  assert.deepEqual(answer.people.get('500'), [
    { url: 'https://image.tmdb.org/t/p/w185/face.jpg', language: null, score: 4.2 },
  ]);
});

test('the image url is secure_base_url + size + file_path', async () => {
  // Spelled literally, per the brief: a url built by concatenating the same
  // three pieces the implementation concatenates would still pass if the
  // size constant silently changed underneath it.
  const { fetch } = fakeFetch({
    [CONFIGURATION_URL]: CONFIGURATION_BODY,
    'https://api.themoviedb.org/3/movie/1/images': {
      id: 1,
      posters: [image('/abc.jpg', 'en', 1)],
      backdrops: [],
      logos: [],
    },
  });
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  const answer = await source.imagesFor('movie', '1', [], []);

  assert.equal(answer.media.posters[0]?.url, 'https://image.tmdb.org/t/p/w780/abc.jpg');
});

test('configuration is fetched once and reused across calls', async () => {
  // Counted, because nothing about a *second* item's output would show
  // whether configuration was re-fetched for it -- only the call count does.
  const { fetch, calls } = fakeFetch({
    [CONFIGURATION_URL]: CONFIGURATION_BODY,
    'https://api.themoviedb.org/3/movie/1/images': { id: 1, posters: [], backdrops: [], logos: [] },
    'https://api.themoviedb.org/3/movie/2/images': { id: 2, posters: [], backdrops: [], logos: [] },
  });
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  await source.imagesFor('movie', '1', [], []);
  await source.imagesFor('movie', '2', [], []);

  const configCalls = calls.filter((call) => call.url === CONFIGURATION_URL);
  assert.equal(configCalls.length, 1);
});

test('a failed configuration fetch is not cached: the next call retries and succeeds', async () => {
  // The failure this pins is permanent, not transient. The source outlives
  // any single job -- `engine.ts` builds the handler once and `job.ts`
  // holds the registry in a `WeakMap` keyed on `ctx.fetch` -- so a cached
  // *rejection* would make every later TMDB artwork job reject with the
  // same stale error, retry and dead-letter, until the process restarted.
  let configurationCalls = 0;
  const fetch: HostFetch = {
    async json<T>(url: string): Promise<T> {
      if (url === CONFIGURATION_URL) {
        configurationCalls += 1;
        if (configurationCalls === 1) throw new Error('tmdb configuration is briefly unavailable');
        return CONFIGURATION_BODY as T;
      }
      return { id: 1, posters: [image('/p.jpg', 'en', 1)], backdrops: [], logos: [] } as T;
    },
    async bytes(): Promise<Uint8Array> {
      throw new Error('bytes: this source only ever calls json');
    },
  };
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  await assert.rejects(
    () => source.imagesFor('movie', '1', [], []),
    /briefly unavailable/,
    'the first call surfaces the configuration failure',
  );

  const answer = await source.imagesFor('movie', '1', [], []);

  assert.equal(configurationCalls, 2, 'the second call must re-ask for configuration, not replay the rejection');
  assert.equal(answer.media.posters[0]?.url, 'https://image.tmdb.org/t/p/w780/p.jpg');
});

test('the api key travels as a bearer header, never in the url', async () => {
  const token = 'super-secret-token';
  const { fetch, calls } = fakeFetch({
    [CONFIGURATION_URL]: CONFIGURATION_BODY,
    'https://api.themoviedb.org/3/movie/1/images': { id: 1, posters: [], backdrops: [], logos: [] },
  });
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver(token) });

  await source.imagesFor('movie', '1', [], []);

  assert.ok(calls.length > 0);
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${token}`);
    // A key in a query string ends up in every access log and every proxy's
    // error message; the header is the only place it may travel.
    assert.ok(!call.url.includes(token), `url must not carry the token: ${call.url}`);
  }
});

test('a person’s profiles become images', async () => {
  const { fetch } = fakeFetch({
    [CONFIGURATION_URL]: CONFIGURATION_BODY,
    'https://api.themoviedb.org/3/movie/1/images': { id: 1, posters: [], backdrops: [], logos: [] },
    'https://api.themoviedb.org/3/person/500/images': {
      id: 500,
      profiles: [image('/face.jpg', null, 4.2)],
    },
    'https://api.themoviedb.org/3/person/501/images': {
      id: 501,
      profiles: [],
    },
  });
  const source = createTmdbSource({ fetch, resolveSecret: bearerResolver('tok') });

  const answer = await source.imagesFor('movie', '1', ['500', '501'], []);

  assert.deepEqual(answer.people.get('500'), [
    { url: 'https://image.tmdb.org/t/p/w185/face.jpg', language: null, score: 4.2 },
  ]);
  // A person TMDB has nothing for is an omitted key, not an empty array --
  // the same "nothing this provider has is ordinary" rule `bestImage` and
  // the seam's own docblock describe for media images.
  assert.ok(!answer.people.has('501'));
});

test('no key configured answers no images rather than throwing', async () => {
  const { fetch, calls } = fakeFetch({});
  const source = createTmdbSource({ fetch, resolveSecret: missingSecretResolver() });

  const answer = await source.imagesFor('movie', '1', ['500'], []);

  assert.deepEqual(answer.media, { posters: [], backgrounds: [], logos: [] });
  assert.equal(answer.people.size, 0);
  // The flag, not just the emptiness: an empty answer from a configured
  // key means "TMDB has no pictures for this", and only this field lets
  // `job.ts` tell the operator the other thing once.
  assert.equal(answer.noCredential, true);
  // Not merely "did not throw" -- a host with no key should make no network
  // call at all, the same way a host with no openmetadata key declines to
  // look anything up rather than asking and discarding the answer.
  assert.equal(calls.length, 0);
});

test('a secret-resolution failure that is not "no key configured" still propagates', async () => {
  // The "answer no images" rule is specific to a credential nobody set up.
  // A resolver that fails for some other reason (a secrets directory that
  // exists and could not be read, say) must not be swallowed the same way,
  // or a real misconfiguration would look identical to "artwork disabled".
  const { fetch } = fakeFetch({});
  const resolveSecret: SecretResolver = async () => {
    throw new Error('the secrets directory could not be read');
  };
  const source = createTmdbSource({ fetch, resolveSecret });

  await assert.rejects(() => source.imagesFor('movie', '1', [], []), /could not be read/);
});
