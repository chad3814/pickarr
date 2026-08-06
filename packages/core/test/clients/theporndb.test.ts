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
  return { uuid: 'u', id: 1, name, short_name: shortName, url: 'https://example.test' };
}

test('results are returned with both spellings intact', async () => {
  const client = createTpdbClient(CONFIG, respondWith({ data: [site('Bang Bros', 'bangbros')] }));
  assert.deepEqual(await client.searchSites('bangbros'), [
    { name: 'Bang Bros', shortName: 'bangbros' },
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

test('an empty result set is a negative, not an error', async () => {
  const client = createTpdbClient(CONFIG, respondWith({ data: [], meta: { total: 0 } }));
  assert.deepEqual(await client.searchSites('bangbros ass'), []);
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
    { name: 'Anal Only', shortName: 'analonly' },
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
