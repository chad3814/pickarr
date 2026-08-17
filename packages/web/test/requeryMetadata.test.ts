import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { requeryOneGroup } from '../src/api/requeryMetadata.ts';
import type { MetadataRequeryResponse } from '../src/api/client.ts';

// A `.ts` test rather than `.tsx`, so it runs in the server suite alongside
// `format.test.ts`: there is no component and no DOM here, only the two-step
// ordering both routes' `onRequeryMetadata` delegates to.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Answers `POST /api/metadata/requery` with `counters`, and records every
 * request body so a test can prove the call was made at all — a refusal that
 * never reached the server would satisfy the same assertions otherwise.
 */
function serve(counters: MetadataRequeryResponse): { bodies: number[][] } {
  const bodies: number[][] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://test.invalid');
    if (url.pathname !== '/api/metadata/requery') throw new Error(`unexpected request to ${url.pathname}`);
    const body = JSON.parse(String(init?.body)) as { groupIds: number[] };
    bodies.push(body.groupIds);
    return new Response(JSON.stringify(counters), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { bodies };
}

test('an accepted requery re-arms the hook for exactly that id', async () => {
  const { bodies } = serve({ requeued: 1, missing: 0, unavailable: 0, unaskable: 0 });
  const rearmed: number[] = [];

  await requeryOneGroup(7, (groupId) => rearmed.push(groupId));

  assert.deepEqual(bodies, [[7]]);
  assert.deepEqual(rearmed, [7]);
});

/**
 * One refusal: the counters the server answers with, and the message the user
 * must end up reading.
 *
 * Spelled out as four sequential calls below rather than a loop over a table,
 * because each case reinstalls the `fetch` stub — `Promise.all` over them
 * would have four tests racing for one global, and a loop with an `await` in
 * it is what the repo's `no-await-in-loop` rule objects to.
 */
async function expectRefusal(counters: MetadataRequeryResponse, message: RegExp): Promise<void> {
  const { bodies } = serve(counters);
  const rearmed: number[] = [];

  await assert.rejects(
    requeryOneGroup(7, (groupId) => rearmed.push(groupId)),
    message,
    `expected ${JSON.stringify(counters)} to be reported as a refusal`,
  );

  assert.deepEqual(bodies, [[7]], 'the refusal came from the server, not from a call never made');
  assert.deepEqual(rearmed, [], 'a refused requery must not start a poll for an answer nobody will write');
}

test('a refused requery rejects with the reason and re-arms nothing', async () => {
  // Reading the counters is the whole point: a 200 that requeued nothing used
  // to report success to the user and then leave the hook polling for an
  // answer no worker would ever write.

  // No metadata provider configured — the most likely refusal by far.
  await expectRefusal({ requeued: 0, missing: 0, unavailable: 1, unaskable: 0 }, /no metadata provider/i);
  await expectRefusal({ requeued: 0, missing: 0, unavailable: 0, unaskable: 1 }, /no metadata query/i);
  await expectRefusal({ requeued: 0, missing: 1, unavailable: 0, unaskable: 0 }, /no longer exists/i);
  // A server whose counters do not add up. Not something a user can cause,
  // and it still must not silently look like success.
  await expectRefusal({ requeued: 0, missing: 0, unavailable: 0, unaskable: 0 }, /no reason/i);
});

test('a failed request rejects without re-arming, as it always did', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Invalid request' }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
  const rearmed: number[] = [];

  await assert.rejects(requeryOneGroup(7, (groupId) => rearmed.push(groupId)), /Invalid request/);
  assert.deepEqual(rearmed, []);
});
