import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTpdbClient, type FetchImpl } from '../../src/clients/theporndb.ts';
import type { SiteLookupConfig } from '../../src/config/schema.ts';

const API_KEY = 'tpdb-secret-key-0123456789abcdef';

const CONFIG: SiteLookupConfig = {
  type: 'theporndb',
  apiKey: API_KEY,
  baseUrl: 'https://api.theporndb.net',
};

function respondWith(body: unknown, init?: ResponseInit): FetchImpl {
  return async () =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
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
    { name: 'Bang Bros', shortName: 'bangbros', sourceUuid: 'uuid-bangbros' },
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
  // Only the uuid: GET /sites/<id> and GET /sites/<uuid> return the same
  // record, so keeping the numeric id too would be two columns for one fact.
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [{ name: 'S', short_name: 's', id: 108995, uuid: 'u-1' }] }),
  );
  const [result] = await client.searchSites('s');
  assert.equal(result?.sourceUuid, 'u-1');
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
    { name: 'Anal Only', shortName: 'analonly', sourceUuid: 'uuid-analonly' },
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
