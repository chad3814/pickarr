import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { putFetchHost } from '../../src/settings/putFetchHost.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answering(status: number, body: unknown, seen: { url: string; init: RequestInit | undefined }[]) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}

test('sends a PUT with the patch as given, null included, and answers the row', async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const row = { hostname: 'cdn.example', concurrency: 3, timeoutMs: 30000, inherited: { concurrency: false, timeoutMs: true }, configured: true };
  answering(200, row, seen);
  const outcome = await putFetchHost('cdn.example', { concurrency: 3, timeoutMs: null });
  assert.deepEqual(outcome, row);
  assert.equal(seen[0]?.url, '/api/fetch-hosts/cdn.example');
  assert.equal(seen[0]?.init?.method, 'PUT');
  assert.equal(seen[0]?.init?.body, '{"concurrency":3,"timeoutMs":null}');
});

test('the default row answers a bare pair, and a refusal code is passed through', async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  answering(200, { concurrency: 2, timeoutMs: 20000 }, seen);
  assert.deepEqual(await putFetchHost('default', { concurrency: 2, timeoutMs: 20000 }), { concurrency: 2, timeoutMs: 20000 });
  answering(400, { refusal: 'invalid-timeout' }, seen);
  assert.deepEqual(await putFetchHost('cdn.example', { timeoutMs: 1 }), { refusal: 'invalid-timeout' });
  answering(500, { error: 'boom' }, seen);
  assert.deepEqual(await putFetchHost('cdn.example', { timeoutMs: 1000 }), { refusal: 'unrecognised' });
});
