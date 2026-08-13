import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTpdbClient,
  PROVIDER_REQUEST_TIMEOUT_MS,
  RateLimited,
  type FetchImpl,
} from '../../src/clients/theporndb.ts';
import type { SiteLookupConfig } from '../../src/config/schema.ts';

/**
 * Node's test runner has supported mocking `AbortSignal.timeout` for a
 * while, but `@types/node@24`'s `MockTimersOptions['apis']` has not caught
 * up to it — confirmed against the actual runtime this repo targets, which
 * does honour it. Only the argument is widened (via `unknown`, since the
 * literal union types don't otherwise overlap) — `enable` is still called as
 * a method on `t.mock.timers`, not detached from it, since detaching it
 * loses the `this` its implementation relies on.
 */
type TimerApis = Parameters<TestContext['mock']['timers']['enable']>[0];

function enableAbortTimeoutMock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['AbortSignal.timeout'] } as unknown as TimerApis);
}

const API_KEY = 'tpdb-secret-key-0123456789abcdef';

const CONFIG: SiteLookupConfig = {
  type: 'theporndb',
  apiKey: API_KEY,
  baseUrl: 'https://api.theporndb.net',
};

/**
 * `urls` records every request made through this fake, in order — needed by
 * tests that assert on the query string built (e.g. `site_id=`) or on how
 * many requests a single search cost.
 */
function respondWith(body: unknown, init?: ResponseInit): FetchImpl & { urls: string[] } {
  const urls: string[] = [];
  const impl: FetchImpl = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  };
  return Object.assign(impl, { urls });
}

function site(name: string, shortName: string): Record<string, unknown> {
  return {
    uuid: `uuid-${shortName}`,
    id: 42,
    name,
    short_name: shortName,
    url: 'https://example.test',
  };
}

test('results are returned with both spellings intact', async () => {
  const client = createTpdbClient(CONFIG, respondWith({ data: [site('Bang Bros', 'bangbros')] }));
  assert.deepEqual(await client.searchSites('bangbros'), [
    { name: 'Bang Bros', shortName: 'bangbros', sourceUuid: 'uuid-bangbros', sourceId: 42 },
  ]);
});

test('every result is returned, not just ones resembling the query', async () => {
  // Deciding which result is the site needs the release name, which this
  // client does not have. Filtering here would discard "2 Chicks Same Time"
  // because the query was "2 Chicks".
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [site('2 Chicks Same Time', '2chickssametime'), site('2 Chicks 1 Dick', '2chicks1dick')],
    }),
  );
  assert.equal((await client.searchSites('2 chicks')).length, 2);
});

test("the site's uuid is carried through", async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [{ name: 'S', short_name: 's', id: 108995, uuid: 'u-1' }] }),
  );
  const [result] = await client.searchSites('s');
  assert.equal(result?.sourceUuid, 'u-1');
});

test('a site search captures the integer id alongside the uuid', async () => {
  // GET /scenes?site_id= accepts only the integer form, never the uuid, which
  // is why both are kept even though /sites/<id> and /sites/<uuid> return the
  // same record.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ name: 'Naughty Office', short_name: 'naughtyoffice', uuid: 'site-uuid', id: 1 }],
    }),
  );
  const [site] = await client.searchSites('naughty office');
  assert.equal(site?.sourceUuid, 'site-uuid');
  assert.equal(site?.sourceId, 1);
});

test('a non-integer or missing id is null rather than invented', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [
        { name: 'A', short_name: 'a', uuid: 'u-a' },
        { name: 'B', short_name: 'b', uuid: 'u-b', id: 'not-a-number' },
        { name: 'C', short_name: 'c', uuid: 'u-c', id: 1.5 },
      ],
    }),
  );
  const results = await client.searchSites('x');
  assert.deepEqual(
    results.map((r) => r.sourceId),
    [null, null, null],
  );
});

test('a missing or empty uuid is null rather than invented', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [{ name: 'S', short_name: 's', uuid: '' }, { name: 'T', short_name: 't' }] }),
  );
  const results = await client.searchSites('s');
  assert.equal(results[0]?.name, 'S', 'the site is still usable without an identifier');
  assert.equal(results[0]?.sourceUuid, null);
  assert.equal(results[1]?.sourceUuid, null);
});

test('an empty result set is a negative, not an error', async () => {
  const client = createTpdbClient(CONFIG, respondWith({ data: [], meta: { total: 0 } }));
  assert.deepEqual(await client.searchSites('bangbros ass'), []);
});

// --- Paging ------------------------------------------------------------------

/** Serves `total` generated sites, honouring page and per_page. */
function pagedFetch(total: number): FetchImpl & { pages: number[] } {
  const pages: number[] = [];
  const impl = async (url: string) => {
    const page = Number(new URL(url).searchParams.get('page'));
    const perPage = Number(new URL(url).searchParams.get('per_page'));
    pages.push(page);
    const start = (page - 1) * perPage;
    const data = Array.from({ length: Math.max(0, Math.min(perPage, total - start)) }, (_, i) => ({
      name: `Site ${start + i}`,
      short_name: `site${start + i}`,
    }));
    return new Response(JSON.stringify({ data, meta: { total } }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return Object.assign(impl, { pages });
}

test('a single short page costs exactly one request', async () => {
  const fetchImpl = pagedFetch(6);
  await createTpdbClient(CONFIG, fetchImpl).searchSites('free use');
  assert.deepEqual(fetchImpl.pages, [1]);
});

test('a result set larger than one page is followed to the end', async () => {
  // q="free" reports 149 matches; the site being looked for can sit past the
  // first hundred, and the service caps per_page at 100.
  const fetchImpl = pagedFetch(149);
  const results = await createTpdbClient(CONFIG, fetchImpl).searchSites('free');
  assert.deepEqual(fetchImpl.pages, [1, 2]);
  assert.equal(results.length, 149);
  assert.equal(results.at(-1)?.name, 'Site 148');
});

test('a long but realistic result set is walked to the end', async () => {
  // Measured live: anal=352, teen=349, big=649. All must be reachable.
  for (const total of [352, 649]) {
    const fetchImpl = pagedFetch(total);
    const results = await createTpdbClient(CONFIG, fetchImpl).searchSites('big');
    assert.equal(results.length, total, `total=${total}`);
    assert.equal(results.at(-1)?.name, `Site ${total - 1}`);
  }
});

test('a query too broad to be a site name is not walked past the first page', async () => {
  // q="a" reports 87,955 matches. Paging that to look for an exact name is
  // pointless work; page one still gets examined because an exact match
  // tends to rank first.
  const fetchImpl = pagedFetch(87_955);
  const results = await createTpdbClient(CONFIG, fetchImpl).searchSites('a');
  assert.deepEqual(fetchImpl.pages, [1]);
  assert.equal(results.length, 100);
});

test('paging is bounded even when the service keeps offering full pages', async () => {
  const fetchImpl = pagedFetch(999);
  const results = await createTpdbClient(CONFIG, fetchImpl).searchSites('x');
  assert.equal(fetchImpl.pages.length, 10, 'MAX_PAGES caps the walk');
  assert.equal(results.length, 999);
});

test('an exactly-full single page does not provoke a second request', async () => {
  const fetchImpl = pagedFetch(100);
  await createTpdbClient(CONFIG, fetchImpl).searchSites('x');
  assert.deepEqual(fetchImpl.pages, [1], 'meta.total says 100, so page 1 is everything');
});

test('a full page with no usable total still terminates', async () => {
  let calls = 0;
  const client = createTpdbClient(CONFIG, async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ data: Array.from({ length: 100 }, (_, i) => site(`S${i}`, `s${i}`)) }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  const results = await client.searchSites('x');
  assert.equal(calls, 10, 'without a total it pages to the cap and stops');
  assert.equal(results.length, 1000);
});

test('the query is sent url-encoded with the documented parameters', async () => {
  let seen = '';
  const client = createTpdbClient(CONFIG, async (url) => {
    seen = url;
    return new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  await client.searchSites('anal only');
  assert.equal(seen, 'https://api.theporndb.net/sites?q=anal%20only&page=1&per_page=100');
});

test('the key is sent as a bearer token and never in the url', async () => {
  let seenUrl = '';
  let seenAuth: string | null = null;
  const client = createTpdbClient(CONFIG, async (url, init) => {
    seenUrl = url;
    seenAuth = new Headers(init?.headers).get('authorization');
    return new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  await client.searchSites('anal only');
  assert.equal(seenAuth, `Bearer ${API_KEY}`);
  assert.ok(!seenUrl.includes(API_KEY), 'the api key must never appear in the request url');
});

// --- The key must not escape into an error ----------------------------------

test('a transport failure that echoes the key does not leak it', async () => {
  const client = createTpdbClient(CONFIG, async () => {
    throw new Error(`connect ECONNREFUSED (sent Authorization: Bearer ${API_KEY})`);
  });
  const error = await client.searchSites('anal only').then(
    () => null,
    (thrown: Error) => thrown,
  );
  assert.ok(error !== null);
  assert.ok(!error.message.includes(API_KEY), `leaked the key: ${error.message}`);
  assert.ok(error.message.includes('ECONNREFUSED'), 'the rest must stay legible');
});

test('an unreadable body that echoes the key does not leak it', async () => {
  const client = createTpdbClient(CONFIG, async () => {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.reject(new Error(`bad json near Bearer ${API_KEY}`)),
    } as unknown as Response;
  });
  const error = await client.searchSites('anal only').then(
    () => null,
    (thrown: Error) => thrown,
  );
  assert.ok(error !== null);
  assert.ok(!error.message.includes(API_KEY), `leaked the key: ${error.message}`);
});

test('an http error names the status and carries no key', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({ message: 'Unauthenticated.' }, { status: 401, statusText: 'Unauthorized' }),
  );
  const error = await client.searchSites('anal only').then(
    () => null,
    (thrown: Error) => thrown,
  );
  assert.ok(error !== null);
  assert.ok(error.message.includes('401'), error.message);
  assert.ok(!error.message.includes(API_KEY));
});

// --- Malformed responses are "no match", never a confirmation ---------------

test('a structurally wrong body yields no match rather than throwing', async () => {
  for (const body of [null, {}, { data: null }, { data: {} }, { data: [null, 3, 'x'] }, []]) {
    const client = createTpdbClient(CONFIG, respondWith(body));
    assert.deepEqual(await client.searchSites('anal only'), [], JSON.stringify(body));
  }
});

test('unknown extra fields on a site do not prevent it being read', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [{ ...site('Anal Only', 'analonly'), some_new_field: { a: 1 } }] }),
  );
  assert.deepEqual(await client.searchSites('anal only'), [
    { name: 'Anal Only', shortName: 'analonly', sourceUuid: 'uuid-analonly', sourceId: 42 },
  ]);
});

test('an empty query is refused without a request', async () => {
  let called = false;
  const client = createTpdbClient(CONFIG, async () => {
    called = true;
    return new Response('{}');
  });
  assert.deepEqual(await client.searchSites('   '), []);
  assert.equal(called, false);
});

test('a trailing slash on the base url does not double up', async () => {
  let seen = '';
  const client = createTpdbClient({ ...CONFIG, baseUrl: 'https://api.theporndb.net/' }, async (url) => {
    seen = url;
    return new Response(JSON.stringify({ data: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  await client.searchSites('x');
  assert.ok(seen.startsWith('https://api.theporndb.net/sites?'), seen);
});

// --- Scene search ------------------------------------------------------------

const SCENE_BODY = {
  data: [{
    id: 'd284e2a0-789d-4e6c-beb9-6e61c24e8b84',
    _id: 0,
    title: 'Smokin Hot Brunette Silvia Saige',
    description: "Silvia Saige has been Sam's therapist for a while",
    date: '2021-11-15',
    duration: 1000,
    poster: 'https://thumb.theporndb.net/office-couch.jpg',
    posters: { full: 'https://cdn/full.jpg', large: 'https://cdn/large.jpg' },
    image: 'https://images1.naughtycdn.com/h.jpg',
    performers: [{ name: 'Jessica Jaymes', full_name: 'Jessica Jaymes (2005)' }],
    site: { uuid: 'site-uuid', id: 1, name: 'Naughty Office', short_name: 'naughtyoffice' },
  }],
  meta: { total: 1, per_page: 25, current_page: 1, last: 1 },
};

test('a scene search maps the documented payload', async () => {
  const client = createTpdbClient(CONFIG, respondWith(SCENE_BODY));
  const [scene] = await client.searchScenes('Smokin Hot Brunette', 1);

  assert.equal(scene?.sourceUuid, 'd284e2a0-789d-4e6c-beb9-6e61c24e8b84',
    'a scene id is the uuid string; _id is the integer');
  assert.equal(scene?.siteId, 1);
  assert.equal(scene?.siteUuid, 'site-uuid');
  assert.equal(scene?.date, '2021-11-15');
  assert.equal(scene?.durationSeconds, 1000);
  assert.deepEqual(scene?.performers, ['Jessica Jaymes'],
    'name, not full_name, which carries a disambiguation suffix');
  assert.equal(scene?.posterUrl, 'https://cdn/large.jpg', 'posters.large is preferred');
});

test('the site id narrows the query and is omitted when unknown', async () => {
  const withId = respondWith(SCENE_BODY);
  const client = createTpdbClient(CONFIG, withId);
  await client.searchScenes('x', 1);
  assert.ok(withId.urls[0]?.includes('site_id=1'));

  const without = respondWith(SCENE_BODY);
  await createTpdbClient(CONFIG, without).searchScenes('x', null);
  assert.ok(!without.urls[0]?.includes('site_id'));
});

test('only one page is requested', async () => {
  const full = { ...SCENE_BODY, meta: { total: 210, per_page: 25, current_page: 1, last: 10 } };
  const fetchImpl = respondWith(full);
  await createTpdbClient(CONFIG, fetchImpl).searchScenes('x', 1);
  assert.equal(fetchImpl.urls.length, 1,
    'a title plus a site filter ranks the match on page one or the rule rejects it anyway');
});

test('a structurally broken entry yields no candidate rather than a partial one', async () => {
  const client = createTpdbClient(CONFIG, respondWith({ data: [{ id: 5 }, null, 'nonsense'] }));
  assert.deepEqual(await client.searchScenes('x', null), []);
});

test('further malformed shapes are tolerated: a bare number, and a site given as a string', async () => {
  // Guards readScenes against exactly the shapes the brief calls out: an
  // entry that is a bare number, and a `site` that is not an object at all.
  // Neither may throw or produce a half-populated candidate.
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [7, { title: 'Only A Title', site: 'not-an-object' }] }),
  );
  const results = await client.searchScenes('x', null);
  assert.deepEqual(results, [{
    sourceUuid: null,
    title: 'Only A Title',
    siteUuid: null,
    siteId: null,
    siteName: '',
    date: null,
    performers: [],
    durationSeconds: null,
    synopsis: null,
    posterUrl: null,
  }]);
});

test('a scene search failure redacts the bearer token', async () => {
  const client = createTpdbClient(CONFIG, () => {
    throw new Error(`connect failed with Bearer ${CONFIG.apiKey}`);
  });
  await assert.rejects(client.searchScenes('x', null), (error: Error) => {
    assert.ok(!error.message.includes(CONFIG.apiKey));
    return true;
  });
});

test('a 429 raises RateLimited rather than a generic error', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({ message: 'Too Many Attempts.' }, { status: 429, headers: { 'retry-after': '30' } }),
  );
  await assert.rejects(client.searchScenes('x', null), (error: unknown) => {
    assert.ok(error instanceof RateLimited);
    assert.equal(error.retryAfterMs, 30_000);
    return true;
  });
});

test('a 429 with no usable retry-after defaults to a minute', async () => {
  const client = createTpdbClient(CONFIG, respondWith({}, { status: 429 }));
  await assert.rejects(client.searchScenes('x', null), (error: unknown) => {
    assert.ok(error instanceof RateLimited);
    assert.equal(error.retryAfterMs, 60_000);
    return true;
  });
});

test('an empty scene query is refused without a request', async () => {
  const fetchImpl = respondWith(SCENE_BODY);
  const client = createTpdbClient(CONFIG, fetchImpl);
  assert.deepEqual(await client.searchScenes('   ', null), []);
  assert.equal(fetchImpl.urls.length, 0);
});

// --- Timeouts ----------------------------------------------------------------
//
// A host that accepts the connection and then sends nothing must not hang
// these calls forever: the metadata worker runs its pass under a `tryRun`
// mutex, so one hung lookup silently stops every metadata lookup after it
// (see the comment on PROVIDER_REQUEST_TIMEOUT_MS). `fetchImpl` below never
// settles and never looks at `init.signal` — the worst case, a test double
// that is not even aware a timeout exists — so a passing test here proves
// the deadline is enforced by this client itself, not merely honoured by a
// cooperative fetch implementation. Node's fake timers stand in for real
// time so the test resolves instantly rather than actually waiting out the
// deadline, and the explicit per-test `timeout` bounds the test in case the
// deadline is not actually enforced and the promise never settles.

test(
  'a site search that never gets a response is abandoned rather than hung forever',
  { timeout: 2_000 },
  async (t) => {
    enableAbortTimeoutMock(t);
    const client = createTpdbClient(CONFIG, () => new Promise(() => undefined));

    const pending = assert.rejects(client.searchSites('bangbros'));
    t.mock.timers.tick(PROVIDER_REQUEST_TIMEOUT_MS);
    await pending;
  },
);

test(
  'a scene search that never gets a response is abandoned rather than hung forever, ' +
    'and is not mistaken for a rate limit',
  { timeout: 2_000 },
  async (t) => {
    enableAbortTimeoutMock(t);
    const client = createTpdbClient(CONFIG, () => new Promise(() => undefined));

    const pending = assert.rejects(client.searchScenes('bangbros', null), (error: unknown) => {
      // A slow host must defer one row, not abort the whole pass the way a
      // 429 does — so a timeout must never surface as RateLimited.
      assert.ok(!(error instanceof RateLimited), 'a timeout must not be treated as a rate limit');
      return true;
    });
    t.mock.timers.tick(PROVIDER_REQUEST_TIMEOUT_MS);
    await pending;
  },
);
