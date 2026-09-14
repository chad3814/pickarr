import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostFetch } from '@pickarr/contract';
import { MAX_BATCH, createLookupClient } from '../src/client.ts';

interface Sent {
  url: string;
  method: string;
  authorization: string | undefined;
  names: readonly string[];
}

/** A `HostFetch` that records what it was asked and answers from a queue of bodies. */
function recordingFetch(bodies: readonly unknown[]): { fetch: HostFetch; sent: Sent[] } {
  const remaining = [...bodies];
  const sent: Sent[] = [];
  const fetch: HostFetch = {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : { items: [] };
      const items: unknown = (body as { items?: unknown }).items;
      sent.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization') ?? undefined,
        names: Array.isArray(items)
          ? items.map((item) => String((item as { name?: unknown }).name))
          : [],
      });
      const next = remaining.shift();
      if (next === undefined) throw new Error(`nothing scripted for ${url}`);
      return next as T;
    },
    async bytes(): Promise<Uint8Array> {
      throw new Error('bytes: not used by the lookup client');
    },
  };
  return { fetch, sent };
}

function entry(lookupId: string, status = 200): Record<string, unknown> {
  return {
    lookupId,
    state: 'unresolved',
    partial: false,
    cached: false,
    confidence: null,
    refusal: null,
    parsed: null,
    media: null,
    suggestions: null,
    status,
  };
}

test('sends one batch request, bearing the resolved key', async () => {
  const { fetch, sent } = recordingFetch([{ results: [entry('a'), entry('b')] }]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });

  const results = await client.batch('movies', ['one.mkv', 'two.mkv']);

  assert.equal(results.length, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, 'https://openmetadata.test/api/v1/lookup');
  assert.equal(sent[0]?.method, 'POST');
  assert.deepEqual(sent[0]?.names, ['one.mkv', 'two.mkv']);
  // The presence of the header, not the value: a credential is never an operand.
  assert.ok(sent[0]?.authorization?.startsWith('Bearer ') === true);
});

test('splits more than one hundred names across requests, in order', async () => {
  const names = Array.from({ length: MAX_BATCH + 5 }, (_, index) => `name-${index}.mkv`);
  const { fetch, sent } = recordingFetch([
    { results: names.slice(0, MAX_BATCH).map((_, index) => entry(`first-${index}`)) },
    { results: names.slice(MAX_BATCH).map((_, index) => entry(`second-${index}`)) },
  ]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });

  const results = await client.batch('tv', names);

  assert.equal(results.length, names.length);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.names.length, MAX_BATCH);
  assert.equal(sent[1]?.names.length, 5);
  assert.equal(results[0]?.lookupId, 'first-0');
  assert.equal(results[MAX_BATCH]?.lookupId, 'second-0');
});

test('asks nothing for an empty name list', async () => {
  const { fetch, sent } = recordingFetch([]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });
  assert.deepEqual(await client.batch('xxx', []), []);
  assert.equal(sent.length, 0);
});

test('polls by lookup id and reads a bare envelope', async () => {
  const { fetch, sent } = recordingFetch([entry('lookup-1')]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });

  const envelope = await client.poll('lookup-1');

  assert.equal(envelope.lookupId, 'lookup-1');
  assert.equal(sent[0]?.url, 'https://openmetadata.test/api/v1/lookup/lookup-1');
  assert.equal(sent[0]?.method, 'GET');
});

test('refuses a batch answer of the wrong length', async () => {
  const { fetch } = recordingFetch([{ results: [entry('a')] }]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test',
    resolveSecret: async () => 'test-key',
  });
  await assert.rejects(() => client.batch('movies', ['one.mkv', 'two.mkv']), /2 names.*1/);
});

test('trims a trailing slash off the base url', async () => {
  const { fetch, sent } = recordingFetch([entry('lookup-1')]);
  const client = createLookupClient({
    fetch,
    baseUrl: 'https://openmetadata.test/',
    resolveSecret: async () => 'test-key',
  });
  await client.poll('lookup-1');
  assert.equal(sent[0]?.url, 'https://openmetadata.test/api/v1/lookup/lookup-1');
});
