import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostFetch } from '@pickarr/contract';
import type { SecretResolver } from '../../src/types.ts';
import { createTvdbSource, toSeamLanguage, tvdbId } from '../../src/artwork/tvdb.ts';

/**
 * TheTVDB's own artwork object, as read live from
 * `/v4/series/121361/artworks`. The endpoint carries more per entry (`id`,
 * `thumbnail`, `width`, `height`, `includesText`, `thumbnailWidth`,
 * `thumbnailHeight`, `updatedAt`, `status`, `tagOptions`); those are left
 * off because `tvdb.ts` reads none of them.
 */
function artwork(image: string, language: string | null, type: number, score: number): Record<string, unknown> {
  return { image, language, type, score };
}

/** Every v4 response is `{status, message, data}`; only `data` is read. */
function envelope(data: unknown): Record<string, unknown> {
  return { status: 'success', message: null, data };
}

const LOGIN_URL = 'https://api4.thetvdb.com/v4/login';
const LOGIN_BODY = envelope({ token: 'tok-from-login' });

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Keyed by exact url rather than a queue: one `imagesFor` fans out to a
 * login, a media route and zero or more person routes, and this way the
 * test does not have to predict the order they are issued in. A url with
 * nothing scripted throws, so calling an unexpected endpoint fails the
 * test instead of reading as an `undefined` body.
 *
 * A scripted value may be a function, which is how a test scripts a *second*
 * answer for the same url -- the 401-then-retry case needs exactly that.
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
        throw new Error(`tvdb.test.ts: nothing scripted for ${url}`);
      }
      const scripted = responses[url];
      return (typeof scripted === 'function' ? scripted() : scripted) as T;
    },
    async bytes(): Promise<Uint8Array> {
      throw new Error('bytes: this source only ever calls json');
    },
  };
  return { fetch, calls };
}

function keyResolver(key: string): SecretResolver {
  return async () => key;
}

/** Mimics `Secrets.get`'s rejection for a credential nobody configured. */
function missingSecretResolver(): SecretResolver {
  return async () => {
    const error = new Error('no value for secret');
    error.name = 'SecretNotFound';
    throw error;
  };
}

/** Mimics the host's `FetchFailedError`, which this package cannot import. */
function fetchFailed(status: number): Error {
  const error = new Error(`fetch failed: ${status}`);
  error.name = 'FetchFailedError';
  Object.assign(error, { status });
  return error;
}

// ---------------------------------------------------------------------------
// tvdbId
// ---------------------------------------------------------------------------

test('a tvdb reference is bare for media and composite for a person, which is not TMDB’s convention', () => {
  // **openmetadata is not uniform across providers.** These were read off
  // live `/api/v1/lookup` answers for two episodes of one series -- not
  // constructed to fit the parser, which is the mistake that cost the TMDB
  // source its first deployment.
  assert.equal(tvdbId('184871'), '184871', 'a series -- bare');
  assert.equal(tvdbId('10019744'), '10019744', 'an episode -- bare, and its own id');
  assert.equal(tvdbId('tvdb:person:7892648'), '7892648', 'a person -- composite, like TMDB');
});

test('a season reference is refused rather than read as its series', () => {
  // `184871:s14` is "series 184871, season 14". Answering `184871` here
  // would hand a season's route the series' id -- the right picture by
  // accident, through a substitution nobody wrote down. `mediaTarget`
  // reaches the series through `parents`, where it is explicit.
  assert.equal(tvdbId('184871:s14'), undefined);
});

test('a reference this build cannot read asks nothing rather than building a url that 404s', () => {
  assert.equal(tvdbId(''), undefined, 'nothing');
  assert.equal(tvdbId('abc'), undefined, 'not digits');
  assert.equal(tvdbId('tvdb:person:'), undefined, 'empty id segment');
  assert.equal(tvdbId('tvdb:person:abc'), undefined, 'non-numeric id segment');
  assert.equal(tvdbId('tvdb:person:12:34'), undefined, 'four segments is not the shape observed');
  assert.equal(tvdbId(' 184871'), undefined, 'a space is not a digit');
  assert.equal(tvdbId('0x7'), undefined, 'nor is hex');
});

// ---------------------------------------------------------------------------
// toSeamLanguage
// ---------------------------------------------------------------------------

test('three-letter language codes become the two-letter ones bestImage compares against', () => {
  // The whole point: `DEFAULT_LANGUAGE` is `'en'`, so without this an
  // English poster never reaches tier 0. Spelled literally on both sides
  // rather than computed, so this cannot pass by agreeing with itself.
  assert.equal(toSeamLanguage('eng'), 'en');
  assert.equal(toSeamLanguage('deu'), 'de');
  assert.equal(toSeamLanguage('fra'), 'fr');
  assert.equal(toSeamLanguage('jpn'), 'ja');
  assert.equal(toSeamLanguage('zho'), 'zh');
});

test('a textless image keeps its null rather than becoming a language', () => {
  // `null` is tier 1 in `bestImage` and outranks every foreign image;
  // turning it into a string would quietly demote every neutral poster.
  assert.equal(toSeamLanguage(null), null);
});

test('a code with no two-letter form, or no valid form at all, degrades to itself', () => {
  // All 185 codes `/v4/languages` publishes were run through `Intl.Locale`:
  // these three are the only ones that do not convert cleanly. Degrading to
  // the original is safe because it can never equal the configured
  // language, so the image sorts as "some other language" -- which it is.
  assert.equal(toSeamLanguage('yue'), 'yue', 'Cantonese has no ISO 639-1 form');
  assert.equal(toSeamLanguage('pt'), 'pt', 'already two letters');
  assert.equal(toSeamLanguage('zhtw'), 'zhtw', 'the one code that makes Intl.Locale throw');
});

// ---------------------------------------------------------------------------
// imagesFor
// ---------------------------------------------------------------------------

test('a series’ artworks become posters, backgrounds and logos by type id', async () => {
  const { fetch } = fakeFetch({
    [LOGIN_URL]: LOGIN_BODY,
    'https://api4.thetvdb.com/v4/series/184871/artworks': envelope({
      artworks: [
        artwork('https://artworks.thetvdb.com/p.jpg', 'eng', 2, 100172),
        artwork('https://artworks.thetvdb.com/b.jpg', null, 3, 90),
        artwork('https://artworks.thetvdb.com/l.jpg', 'eng', 23, 80),
        // Deliberately present and deliberately ignored: a Banner is not
        // any of the three slots this seam fills.
        artwork('https://artworks.thetvdb.com/banner.jpg', 'eng', 1, 999),
      ],
    }),
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  const answer = await source.imagesFor('series', '184871', [], []);

  assert.deepEqual(answer.media, {
    posters: [{ url: 'https://artworks.thetvdb.com/p.jpg', language: 'en', score: 100172 }],
    backgrounds: [{ url: 'https://artworks.thetvdb.com/b.jpg', language: null, score: 90 }],
    logos: [{ url: 'https://artworks.thetvdb.com/l.jpg', language: 'en', score: 80 }],
  });
});

test('a film reads /extended, and its type ids are not the series ones', async () => {
  // Two separate facts, and both are measured: `/movies/{id}/artworks`
  // answers `Bad Request`, and a film's poster is type 14 where a series'
  // is 2. Scripting only the `/extended` url is what pins the first --
  // an implementation that asked for `/artworks` would throw here.
  const { fetch } = fakeFetch({
    [LOGIN_URL]: LOGIN_BODY,
    'https://api4.thetvdb.com/v4/movies/113/extended': envelope({
      artworks: [
        artwork('https://artworks.thetvdb.com/mp.jpg', 'eng', 14, 100001),
        artwork('https://artworks.thetvdb.com/mb.jpg', null, 15, 70),
        artwork('https://artworks.thetvdb.com/ml.jpg', 'eng', 25, 60),
        // A film's `extended` payload really does mix in actor photos --
        // 9 of the 44 on the sample read. One in a poster slot would be a
        // headshot where the poster should be.
        artwork('https://artworks.thetvdb.com/face.jpg', 'eng', 13, 500),
        // And the series poster id, which must mean nothing here.
        artwork('https://artworks.thetvdb.com/wrong.jpg', 'eng', 2, 500),
      ],
    }),
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  const answer = await source.imagesFor('movie', '113', [], []);

  assert.deepEqual(answer.media.posters, [
    { url: 'https://artworks.thetvdb.com/mp.jpg', language: 'en', score: 100001 },
  ]);
  assert.deepEqual(answer.media.backgrounds, [
    { url: 'https://artworks.thetvdb.com/mb.jpg', language: null, score: 70 },
  ]);
  assert.deepEqual(answer.media.logos, [
    { url: 'https://artworks.thetvdb.com/ml.jpg', language: 'en', score: 60 },
  ]);
});

test('an episode is answered with its series’ artwork, reached through parents', async () => {
  // The real shape, from a live lookup: the episode's own ref is its own
  // id and reaches nothing, and the season parent's ref is unreadable on
  // purpose. Only the series parent can answer.
  const { fetch, calls } = fakeFetch({
    [LOGIN_URL]: LOGIN_BODY,
    'https://api4.thetvdb.com/v4/series/184871/artworks': envelope({
      artworks: [artwork('https://artworks.thetvdb.com/p.jpg', 'eng', 2, 10)],
    }),
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  const answer = await source.imagesFor('episode', '10019744', [], [
    { kind: 'season', providerRef: '184871:s14' },
    { kind: 'series', providerRef: '184871' },
  ]);

  assert.deepEqual(answer.media.posters, [
    { url: 'https://artworks.thetvdb.com/p.jpg', language: 'en', score: 10 },
  ]);
  // Nothing was asked of the episode's own id -- the failure that would
  // matter is a url built from `10019744`, which no route serves.
  assert.ok(
    !calls.some((call) => call.url.includes('10019744')),
    'the episode id must not reach a url',
  );
});

test('an ancestor reference this build cannot read asks no url, rather than pasting it into one', async () => {
  // **This is the tmdb incident's lesson, pinned.** Every tvdb ancestor
  // reference observed today is already bare digits, so parsing one and
  // passing it through are indistinguishable on real data -- deleting the
  // parse left the whole suite green until this test existed. What it
  // costs is only visible if openmetadata ever changes the format: the
  // parse makes that a missing poster, and its absence makes it a url
  // built from a string that cannot be an id, once per item, for ever.
  const { fetch, calls } = fakeFetch({ [LOGIN_URL]: LOGIN_BODY });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  // A fourth segment, as if openmetadata had started appending an
  // ordinal the way it already does for TMDB. Not a shape in use today --
  // that is the point of it.
  const answer = await source.imagesFor('episode', '10019744', [], [
    { kind: 'series', providerRef: 'tvdb:series:184871:2' },
  ]);

  assert.deepEqual(answer.media, { posters: [], backgrounds: [], logos: [] });
  assert.ok(
    !calls.some((call) => call.url.includes('/series/')),
    'no series url was built from an unreadable reference',
  );
});

test('a kind with no route and no usable ancestor asks nothing at all', async () => {
  const { fetch, calls } = fakeFetch({ [LOGIN_URL]: LOGIN_BODY });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  const answer = await source.imagesFor('season', '184871:s14', [], []);

  assert.deepEqual(answer.media, { posters: [], backgrounds: [], logos: [] });
  assert.ok(!calls.some((call) => call.url.includes('/series/')), 'no media route was asked');
});

test('a record with no artworks key answers empty rather than throwing', async () => {
  const { fetch } = fakeFetch({
    [LOGIN_URL]: LOGIN_BODY,
    'https://api4.thetvdb.com/v4/series/184871/artworks': envelope({}),
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  const answer = await source.imagesFor('series', '184871', [], []);

  assert.deepEqual(answer.media, { posters: [], backgrounds: [], logos: [] });
});

test('a person’s single image becomes one neutral-language picture', async () => {
  const { fetch } = fakeFetch({
    [LOGIN_URL]: LOGIN_BODY,
    'https://api4.thetvdb.com/v4/series/184871/artworks': envelope({ artworks: [] }),
    'https://api4.thetvdb.com/v4/people/7892648': envelope({
      image: 'https://artworks.thetvdb.com/face.jpg',
      score: 7,
    }),
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  const answer = await source.imagesFor('series', '184871', ['tvdb:person:7892648'], []);

  assert.deepEqual(answer.people.get('tvdb:person:7892648'), [
    { url: 'https://artworks.thetvdb.com/face.jpg', language: null, score: 7 },
  ]);
});

test('a person TheTVDB has no photo for is an omitted key, not an empty array', async () => {
  // `image: null` is what the live API answered for the one person on the
  // sample lookup -- the field is present and null, not absent.
  const { fetch } = fakeFetch({
    [LOGIN_URL]: LOGIN_BODY,
    'https://api4.thetvdb.com/v4/series/184871/artworks': envelope({ artworks: [] }),
    'https://api4.thetvdb.com/v4/people/7892648': envelope({ image: null, score: 0 }),
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  const answer = await source.imagesFor('series', '184871', ['tvdb:person:7892648'], []);

  assert.equal(answer.people.size, 0);
});

test('the api key buys a token and never travels on a request itself', async () => {
  const { fetch, calls } = fakeFetch({
    [LOGIN_URL]: LOGIN_BODY,
    'https://api4.thetvdb.com/v4/series/184871/artworks': envelope({ artworks: [] }),
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('the-api-key') });

  await source.imagesFor('series', '184871', [], []);

  const login = calls.find((call) => call.url === LOGIN_URL);
  assert.ok(login, 'a login was made');
  assert.equal(login.init?.method, 'POST');
  assert.equal(login.init?.body, JSON.stringify({ apikey: 'the-api-key' }));

  const artworks = calls.find((call) => call.url.endsWith('/artworks'));
  assert.ok(artworks, 'the artworks route was asked');
  const headers = new Headers(artworks.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer tok-from-login');
  // The key itself must never reach a url or a header -- it is not a
  // bearer token, and sending it as one would leak a credential that
  // buys tokens.
  assert.ok(
    !calls.some((call) => call.url.includes('the-api-key')),
    'the api key is not in any url',
  );
  assert.ok(
    !new Headers(artworks.init?.headers).get('authorization')?.includes('the-api-key'),
    'the api key is not the bearer',
  );
});

test('the token is bought once and reused across calls', async () => {
  let logins = 0;
  const { fetch } = fakeFetch({
    [LOGIN_URL]: () => {
      logins += 1;
      return LOGIN_BODY;
    },
    'https://api4.thetvdb.com/v4/series/184871/artworks': envelope({ artworks: [] }),
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  await source.imagesFor('series', '184871', [], []);
  await source.imagesFor('series', '184871', [], []);

  assert.equal(logins, 1);
});

test('a failed login is not cached: the next call retries and succeeds', async () => {
  // The until-restart failure this guards. Caching the *promise* would
  // cache the rejection, and this source outlives every job, so one
  // transient login failure would kill TVDB artwork until the host
  // restarted.
  let attempts = 0;
  const { fetch } = fakeFetch({
    [LOGIN_URL]: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('login is briefly down');
      return LOGIN_BODY;
    },
    'https://api4.thetvdb.com/v4/series/184871/artworks': envelope({ artworks: [] }),
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  await assert.rejects(source.imagesFor('series', '184871', [], []), /login is briefly down/);
  const answer = await source.imagesFor('series', '184871', [], []);

  assert.deepEqual(answer.media, { posters: [], backgrounds: [], logos: [] });
  assert.equal(attempts, 2);
});

test('an expired token is replaced once on a 401, rather than failing until restart', async () => {
  // TheTVDB's tokens expire and this source lives as long as the host, so
  // a long-running host will present a stale one. Without the retry those
  // jobs fail, retry and dead-letter with nothing wrong but the clock.
  let logins = 0;
  let artworkCalls = 0;
  const { fetch } = fakeFetch({
    [LOGIN_URL]: () => {
      logins += 1;
      return envelope({ token: `tok-${logins}` });
    },
    'https://api4.thetvdb.com/v4/series/184871/artworks': () => {
      artworkCalls += 1;
      if (artworkCalls === 1) throw fetchFailed(401);
      return envelope({ artworks: [artwork('https://artworks.thetvdb.com/p.jpg', 'eng', 2, 5)] });
    },
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  const answer = await source.imagesFor('series', '184871', [], []);

  assert.deepEqual(answer.media.posters, [
    { url: 'https://artworks.thetvdb.com/p.jpg', language: 'en', score: 5 },
  ]);
  assert.equal(logins, 2, 'a second token was bought');
  assert.equal(artworkCalls, 2, 'the request was retried exactly once');
});

test('a failure that is not a 401 is not retried', async () => {
  // The retry is narrow on purpose: retrying a 500 doubles the load on a
  // provider that is already failing, and retrying a 404 cannot help.
  let artworkCalls = 0;
  const { fetch } = fakeFetch({
    [LOGIN_URL]: LOGIN_BODY,
    'https://api4.thetvdb.com/v4/series/184871/artworks': () => {
      artworkCalls += 1;
      throw fetchFailed(500);
    },
  });
  const source = createTvdbSource({ fetch, resolveSecret: keyResolver('key') });

  await assert.rejects(source.imagesFor('series', '184871', [], []), /500/);
  assert.equal(artworkCalls, 1);
});

test('no key configured answers no images, fetches nothing, and says which of the two it is', async () => {
  const { fetch, calls } = fakeFetch({});
  const source = createTvdbSource({ fetch, resolveSecret: missingSecretResolver() });

  const answer = await source.imagesFor('series', '184871', ['tvdb:person:7892648'], []);

  assert.deepEqual(answer.media, { posters: [], backgrounds: [], logos: [] });
  assert.equal(answer.people.size, 0);
  // The flag, not just the emptiness: an empty answer from a configured
  // key means "TheTVDB has no pictures for this", and only this field lets
  // `job.ts` tell the operator the other thing once.
  assert.equal(answer.noCredential, true);
  // Not even the login: there is nothing to log in with.
  assert.equal(calls.length, 0);
});

test('a secret-resolution failure that is not "no key configured" still propagates', async () => {
  const { fetch } = fakeFetch({});
  const source = createTvdbSource({
    fetch,
    resolveSecret: async () => {
      throw new Error('the secrets directory is unreadable');
    },
  });

  await assert.rejects(
    source.imagesFor('series', '184871', [], []),
    /the secrets directory is unreadable/,
  );
});
