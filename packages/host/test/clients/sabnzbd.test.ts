import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SabnzbdConfig } from '../../src/clients/config.ts';
import { createSabnzbdClient } from '../../src/clients/sabnzbd.ts';
import { createHostFetch } from '../../src/fetch/queue.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';

function makeConfig(overrides: Partial<SabnzbdConfig> = {}): SabnzbdConfig {
  return {
    kind: 'sabnzbd',
    id: 1,
    baseUrl: 'https://sab.example.com',
    apiKey: 'test-key',
    category: 'tv',
    ...overrides,
  };
}

/**
 * A `QueuedFetch` double whose `json` is whatever the test supplies. The
 * `unknown` -> `T` step mirrors `createHostFetch`'s own `json` (`queue.ts`):
 * the cast is the caller's assertion about the shape it asked for, not a
 * licence to convert between unrelated types, and it is confined to this
 * one line rather than spread through every test.
 */
function fakeQueuedFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>): QueuedFetch {
  return {
    async json<T>(url: string, init?: RequestInit): Promise<T> {
      const body: unknown = await handler(url, init);
      return body as T;
    },
    bytes(): Promise<Uint8Array> {
      throw new Error('bytes is not used by these tests');
    },
    text(): Promise<string> {
      throw new Error('text is not used by these tests');
    },
  };
}

test('submitting returns the first nzo id as the reference', async () => {
  const config = makeConfig({ id: 7 });
  const fetch = fakeQueuedFetch(async () => ({
    status: true,
    nzo_ids: ['SABnzbd_nzo_abc123', 'SABnzbd_nzo_should_be_ignored'],
  }));
  const client = createSabnzbdClient(config, fetch);

  const result = await client.submit('http://example.com/one.nzb', 'One Show');

  assert.deepEqual(result, { ref: 'SABnzbd_nzo_abc123' });
});

test('an empty nzo_ids array is a failure, not an empty reference', async () => {
  // A submission with no id is unrecognisable later -- nothing could ever
  // match a downloads row back to a job in SABnzbd's queue or history.
  // Writing '' as the ref would not fail loudly here; it would instead
  // record a row that looks submitted and can never be reconciled.
  const config = makeConfig({ id: 9 });
  const fetch = fakeQueuedFetch(async () => ({ status: true, nzo_ids: [] }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('no nzo id back')
      && err.message.includes('9'),
  );
});

test('a rejection answered with HTTP 200 is still a failure', async () => {
  // SABnzbd refuses a submission with a 200 and `status: false` -- nothing in
  // the transport sees a problem, so this adapter is the only place it can
  // become one. Before this check the body had no `nzo_ids` at all and the
  // adapter died on a bare `TypeError` reading index 0 of undefined, which
  // names neither the client nor the reason.
  const config = makeConfig({ id: 11 });
  const fetch = fakeQueuedFetch(async () => ({ status: false, error: 'API Key Incorrect' }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('rejected the submission')
      && err.message.includes('API Key Incorrect')
      && err.message.includes('11'),
  );
});

test("a rejection reason quoting the request back has the api key stripped from it", async () => {
  // SABnzbd's `error` text routinely quotes the request it rejected, and that
  // request's query string is ours -- api key included. The reason is passed
  // through the same redaction a url would get, so echoing SABnzbd's wording
  // does not become a way to launder the key into a log.
  const config = makeConfig({ id: 12, apiKey: 'not-a-real-key' });
  const fetch = fakeQueuedFetch(async (url) => ({
    status: false,
    error: `could not process ${url}`,
  }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('rejected the submission')
      && !err.message.includes('not-a-real-key')
      && err.message.includes('apikey=***'),
  );
});

test('a rejection with no reason still names the client', async () => {
  const config = makeConfig({ id: 13 });
  const fetch = fakeQueuedFetch(async () => ({ status: false }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('no reason given')
      && err.message.includes('13'),
  );
});

test('an empty-string nzo id is refused like a missing one', async () => {
  // `''` is not a reference to anything; 1.x rejects it for the same reason.
  const config = makeConfig({ id: 14 });
  const fetch = fakeQueuedFetch(async () => ({ status: true, nzo_ids: [''] }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error && err.message.includes('no nzo id back'),
  );
});

test('the api key travels in the query and never in an error message', async () => {
  const config = makeConfig({ apiKey: 'not-a-real-key' });
  let capturedUrl = '';
  const fetch = fakeQueuedFetch(async (url) => {
    capturedUrl = url;
    // Empty on purpose: this exercises this module's own error path (the
    // "no nzo id" refusal), which is the one error this adapter builds
    // itself rather than getting from `createHostFetch`'s already-redacted
    // failure paths.
    return { status: true, nzo_ids: [] };
  });
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.submit('http://example.com/one.nzb', 'One Show'),
    (err: unknown) => err instanceof Error
      && err.message.includes('no nzo id back')
      && !err.message.includes('not-a-real-key'),
  );

  assert.ok(
    capturedUrl.includes('apikey=not-a-real-key'),
    'the api key must actually have been sent in the query',
  );
});

test('the category and display name are sent as the client sees them', async () => {
  const config = makeConfig({
    baseUrl: 'https://sab.example.com', apiKey: 'not-a-real-key', category: 'tv-shows',
  });
  let capturedUrl = '';
  const fetch = fakeQueuedFetch(async (url) => {
    capturedUrl = url;
    return { status: true, nzo_ids: ['SABnzbd_nzo_1'] };
  });
  const client = createSabnzbdClient(config, fetch);

  await client.submit('https://example.com/nzb/123.nzb', 'Show Name');

  assert.equal(
    capturedUrl,
    'https://sab.example.com/api?mode=addurl&name=https%3A%2F%2Fexample.com%2Fnzb%2F123.nzb'
    + '&cat=tv-shows&nzbname=Show+Name&apikey=not-a-real-key&output=json',
  );
});

/**
 * A stand-in for `globalThis.fetch` whose calls hang until the test releases
 * them, so concurrency can be observed directly (as a count of calls in
 * flight) rather than inferred from timing. Same shape as
 * `fetch/queue.test.ts`'s own `trackingFetch`, with a response body this
 * adapter can actually parse a reference out of.
 */
function trackingFetch() {
  let active = 0;
  let max = 0;
  const pending: Array<() => void> = [];

  const fetchFn: typeof globalThis.fetch = async () => {
    active += 1;
    max = Math.max(max, active);
    await new Promise<void>((resolve) => pending.push(resolve));
    active -= 1;
    return new Response(JSON.stringify({ status: true, nzo_ids: ['SABnzbd_nzo_queued'] }), { status: 200 });
  };

  return {
    fetchFn,
    activeNow: () => active,
    maxActive: () => max,
    releaseNext: () => {
      const next = pending.shift();
      assert.ok(next, 'releaseNext called with nothing pending');
      next();
    },
  };
}

/** Lets pending microtasks (including a queue's own wake-up chaining) run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('the request goes through the queue, so a second call to the same host waits', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn });
  const config = makeConfig({ baseUrl: 'http://sab.example', apiKey: 'queue-key' });
  const client = createSabnzbdClient(config, hostFetch);

  const first = client.submit('http://example.com/one.nzb', 'One');
  const second = client.submit('http://example.com/two.nzb', 'Two');

  await tick();
  assert.equal(track.activeNow(), 1, 'a second submission to the same host must not have started');

  track.releaseNext();
  await first;

  await tick();
  assert.equal(track.activeNow(), 1, 'the second submission only starts once the first has finished');
  track.releaseNext();
  await second;

  assert.equal(track.maxActive(), 1, 'at most one submission to this host was ever in flight at once');
});

/**
 * Routes a `fakeQueuedFetch` call by which endpoint it targets. Query-param
 * substring checks, not a full parse -- this is test scaffolding that
 * decides *which* canned body to hand back, not an assertion, so it is not
 * bound by the "assert against literals" rule the url-shape tests below
 * follow.
 */
function isQueueRequest(url: string): boolean {
  return url.includes('mode=queue');
}

test('a queue slot becomes a queue entry with its percentage and normalised category', async () => {
  const config = makeConfig({ id: 20 });
  const fetch = fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) {
      return {
        queue: {
          noofslots: 1,
          slots: [{ nzo_id: 'SABnzbd_nzo_q1', filename: 'Some.Show.S01E01', percentage: '42', cat: 'None' }],
        },
      };
    }
    return { history: { noofslots: 0, slots: [] } };
  });
  const client = createSabnzbdClient(config, fetch);

  const snapshot = await client.snapshot();

  assert.deepEqual(snapshot.queue, [
    { ref: 'SABnzbd_nzo_q1', name: 'Some.Show.S01E01', percentage: 42, category: null },
  ]);
});

test('a completed history slot carries its storage path', async () => {
  const config = makeConfig({ id: 21 });
  const fetch = fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) return { queue: { noofslots: 0, slots: [] } };
    return {
      history: {
        noofslots: 1,
        slots: [{
          nzo_id: 'SABnzbd_nzo_h1',
          name: 'Some.Show.S01E01',
          category: 'tv',
          status: 'Completed',
          storage: '/data/complete/Some.Show.S01E01',
        }],
      },
    };
  });
  const client = createSabnzbdClient(config, fetch);

  const snapshot = await client.snapshot();

  assert.deepEqual(snapshot.history, [
    {
      ref: 'SABnzbd_nzo_h1',
      name: 'Some.Show.S01E01',
      category: 'tv',
      outcome: 'completed',
      storagePath: '/data/complete/Some.Show.S01E01',
      failMessage: null,
    },
  ]);
});

test('a mid-unpack status is in-progress, not a failure', async () => {
  // 'Extracting'. This exact reading cost 1.x a fix round: every one of
  // these used to be a terminal failure, so an ordinary multi-part
  // download was marked failed while SABnzbd was still unpacking it.
  const config = makeConfig({ id: 22 });
  const fetch = fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) return { queue: { noofslots: 0, slots: [] } };
    return {
      history: {
        noofslots: 1,
        slots: [{ nzo_id: 'SABnzbd_nzo_h2', name: 'Multi.Part.Show', category: 'tv', status: 'Extracting' }],
      },
    };
  });
  const client = createSabnzbdClient(config, fetch);

  const snapshot = await client.snapshot();

  assert.equal(snapshot.history.length, 1);
  assert.equal(snapshot.history[0]?.outcome, 'in-progress');
});

test('a status this client does not enumerate reads as failed, not in-progress', async () => {
  const config = makeConfig({ id: 23 });
  const fetch = fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) return { queue: { noofslots: 0, slots: [] } };
    return {
      history: {
        noofslots: 1,
        slots: [{ nzo_id: 'SABnzbd_nzo_h3', name: 'Mystery.Job', category: 'tv', status: 'quarantined' }],
      },
    };
  });
  const client = createSabnzbdClient(config, fetch);

  const snapshot = await client.snapshot();

  assert.equal(snapshot.history.length, 1);
  assert.equal(snapshot.history[0]?.outcome, 'failed');
  // The guess is reported, not just made. `historyOutcome`'s comment argues
  // that a wrong `failed` is the safer error because it is "visible
  // immediately" -- which is only true if something names the status that
  // caused it. Without this, a status SABnzbd adds later turns into
  // unexplained failed downloads and nothing points at the list to extend.
  assert.deepEqual(snapshot.unreadable, ['quarantined']);
});

test('a status this client does enumerate is never reported unreadable', async () => {
  // The other half: `unreadable` has to stay empty in the ordinary case, or
  // a caller learns to ignore it and it stops being a signal at all.
  const config = makeConfig({ id: 24 });
  const fetch = fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) return { queue: { noofslots: 0, slots: [] } };
    return {
      history: {
        noofslots: 2,
        slots: [
          { nzo_id: 'SABnzbd_nzo_ok1', name: 'Done.Job', category: 'tv', status: 'Completed', storage: '/done/a' },
          { nzo_id: 'SABnzbd_nzo_ok2', name: 'Unpacking.Job', category: 'tv', status: 'Extracting' },
        ],
      },
    };
  });
  const client = createSabnzbdClient(config, fetch);

  const snapshot = await client.snapshot();

  assert.deepEqual(snapshot.unreadable, []);
});

test('one unreadable status reported by many slots is named once', async () => {
  const config = makeConfig({ id: 25 });
  const fetch = fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) return { queue: { noofslots: 0, slots: [] } };
    return {
      history: {
        noofslots: 2,
        slots: [
          { nzo_id: 'SABnzbd_nzo_q1', name: 'A', category: 'tv', status: 'quarantined' },
          { nzo_id: 'SABnzbd_nzo_q2', name: 'B', category: 'tv', status: 'quarantined' },
        ],
      },
    };
  });
  const client = createSabnzbdClient(config, fetch);

  const snapshot = await client.snapshot();

  assert.deepEqual(snapshot.unreadable, ['quarantined']);
});

test('history is paged until noofslots is satisfied', async () => {
  // Two pages. Assert both requests and that every slot appears once.
  const config = makeConfig({ id: 24 });
  const calls: string[] = [];
  const page1 = Array.from({ length: 500 }, (_, i) => ({
    nzo_id: `SABnzbd_nzo_h${i}`,
    name: `Job ${i}`,
    category: 'tv',
    status: 'completed',
    storage: `/data/${i}`,
  }));
  const page2 = [
    { nzo_id: 'SABnzbd_nzo_h500', name: 'Job 500', category: 'tv', status: 'completed', storage: '/data/500' },
  ];
  const fetch = fakeQueuedFetch(async (url) => {
    calls.push(url);
    if (isQueueRequest(url)) return { queue: { noofslots: 0, slots: [] } };
    if (url.includes('start=0&')) return { history: { noofslots: 501, slots: page1 } };
    if (url.includes('start=500&')) return { history: { noofslots: 501, slots: page2 } };
    throw new Error(`unexpected url ${url}`);
  });
  const client = createSabnzbdClient(config, fetch);

  const snapshot = await client.snapshot();

  assert.deepEqual(
    calls.filter((url) => url.includes('mode=history')),
    [
      'https://sab.example.com/api?mode=history&start=0&limit=500&apikey=test-key&output=json',
      'https://sab.example.com/api?mode=history&start=500&limit=500&apikey=test-key&output=json',
    ],
  );
  assert.equal(snapshot.history.length, 501, 'every slot from both pages must appear');
  const refs = new Set(snapshot.history.map((entry) => entry.ref));
  assert.equal(refs.size, 501, 'no slot must appear more than once');
  assert.equal(snapshot.complete, true);
});

test('hitting the page cap reports an incomplete snapshot rather than a whole one', async () => {
  const config = makeConfig({ id: 25 });
  let historyCalls = 0;
  const fetch = fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) return { queue: { noofslots: 0, slots: [] } };
    historyCalls += 1;
    const start = Number(new URL(url).searchParams.get('start'));
    const slots = Array.from({ length: 500 }, (_, i) => ({
      nzo_id: `SABnzbd_nzo_cap${start + i}`,
      name: `Job ${start + i}`,
      status: 'completed',
    }));
    // A total that will never be satisfied by any number of pages, so the
    // only way this loop stops is the cap.
    return { history: { noofslots: 1_000_000, slots } };
  });
  const client = createSabnzbdClient(config, fetch);

  const snapshot = await client.snapshot();

  assert.equal(historyCalls, 20, 'paging must stop at MAX_HISTORY_PAGES, not run forever');
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.history.length, 10_000, 'whatever was fetched before the cap is still usable');
});

test('a queue call that fails reports an incomplete snapshot, not an empty client', async () => {
  const config = makeConfig({ id: 26 });
  const fetch = fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) throw new Error('queue unreachable');
    return {
      history: {
        noofslots: 1,
        slots: [{
          nzo_id: 'SABnzbd_nzo_h4', name: 'Some.Show', category: 'tv', status: 'completed', storage: '/data/4',
        }],
      },
    };
  });
  const client = createSabnzbdClient(config, fetch);

  const snapshot = await client.snapshot();

  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.queue, []);
  assert.equal(snapshot.history.length, 1, 'a page that did load must still be usable, not discarded');
});

test('a history call that fails reports an incomplete snapshot, not an empty client', async () => {
  // The mirror of the queue-fails case above: the one direction that case
  // did not cover. A failed first history page must be exactly as partial
  // as a failed queue call -- resolved, not rejected -- since the queue call
  // here still answers.
  const config = makeConfig({ id: 27 });
  const fetch = fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) {
      return {
        queue: {
          noofslots: 1,
          slots: [{ nzo_id: 'SABnzbd_nzo_q1', filename: 'Queued.Show', percentage: '10', cat: 'tv' }],
        },
      };
    }
    throw new Error('history unreachable');
  });
  const client = createSabnzbdClient(config, fetch);

  const snapshot = await client.snapshot();

  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.queue.length, 1, 'a queue call that did load must still be usable, not discarded');
  assert.deepEqual(snapshot.history, []);
});

test('both calls failing is a contact failure, not a resolved empty snapshot', async () => {
  // The critical fix: before this, a SABnzbd outage never counted against
  // `consecutive_failures` because `snapshot()` swallowed every rejection
  // into a resolved, incomplete snapshot. Reject only when the client gave
  // no answer at all -- the queue call AND the first history page both
  // failed -- carrying the redacted underlying messages the way
  // `reconcile-job.ts`'s `runTick` logs a contact failure.
  const config = makeConfig({ id: 28 });
  const fetch = fakeQueuedFetch(async (url) => {
    if (isQueueRequest(url)) throw new Error('queue unreachable: https://sab.example.com/api?apikey=test-key');
    throw new Error('history unreachable');
  });
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.snapshot(),
    (err: unknown) => {
      if (!(err instanceof Error)) return false;
      return err.message.includes('28')
        && err.message.includes('queue unreachable')
        && err.message.includes('history unreachable')
        && !err.message.includes('test-key');
    },
  );
});

test('a delete refused with HTTP 200 is still a failure', async () => {
  // The trap this module documents at length for `submit`, on the call that
  // was reading nothing at all. Unchecked, `deliver.ts` stamped
  // `reclaimed_at`, never offered the row again, and -- because the request
  // carries `del_files=1` -- the job's files stayed on disk forever.
  const config = makeConfig({ id: 31 });
  const fetch = fakeQueuedFetch(async () => ({ status: false, error: 'API Key Incorrect' }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.remove('SABnzbd_nzo_remove_me'),
    (err: unknown) => err instanceof Error
      && err.message.includes('refused to delete')
      && err.message.includes('31')
      && err.message.includes('API Key Incorrect'),
  );
});

test('a refused delete has its reason redacted, the same reading a refused submission gets', async () => {
  // Both call sites go through one `refusalReason`, so the redaction cannot
  // be remembered at one and forgotten at the other. SABnzbd quotes the
  // request it rejected back at you, api key included.
  const config = makeConfig({ id: 33 });
  const fetch = fakeQueuedFetch(async () => ({
    status: false,
    error: 'cannot delete https://sab.example.com/api?apikey=super-secret&mode=history',
  }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.remove('SABnzbd_nzo_remove_me'),
    (err: unknown) => err instanceof Error
      && err.message.includes('apikey=***')
      && !err.message.includes('super-secret'),
  );
});

test('a refused delete with no reason given says so rather than nothing', async () => {
  const config = makeConfig({ id: 35 });
  const fetch = fakeQueuedFetch(async () => ({ status: false }));
  const client = createSabnzbdClient(config, fetch);

  await assert.rejects(
    client.remove('SABnzbd_nzo_remove_me'),
    (err: unknown) => err instanceof Error && err.message.includes('no reason given'),
  );
});

test('a delete answered with a body this adapter does not recognise is a success', async () => {
  // `=== false`, not `!== true`: there is nothing to read out of a
  // successful delete, so requiring an explicit success marker could only
  // buy failing every delete against a version that answers one
  // differently -- `reclaimFailures` climbing with nothing actually wrong,
  // and files never reclaimed. `submit` defaults the other way because it
  // has to read an id back; see its own comment.
  const config = makeConfig({ id: 37 });
  const client = createSabnzbdClient(config, fakeQueuedFetch(async () => ({})));
  const withOtherFields = createSabnzbdClient(
    makeConfig({ id: 39 }),
    fakeQueuedFetch(async () => ({ nzo_ids: [], error: '' })),
  );

  await assert.doesNotReject(
    client.remove('SABnzbd_nzo_remove_me'),
    'a body with no status marker at all must read as a successful delete',
  );
  await assert.doesNotReject(
    withOtherFields.remove('SABnzbd_nzo_remove_me'),
    'so must a body carrying other fields but no failure marker',
  );
});

test('remove asks the client to delete the job and its files', async () => {
  const config = makeConfig({ id: 27, apiKey: 'not-a-real-key' });
  let capturedUrl = '';
  const fetch = fakeQueuedFetch(async (url) => {
    capturedUrl = url;
    return { status: true };
  });
  const client = createSabnzbdClient(config, fetch);

  await client.remove('SABnzbd_nzo_remove_me');

  assert.equal(
    capturedUrl,
    'https://sab.example.com/api?mode=history&name=delete&value=SABnzbd_nzo_remove_me'
    + '&del_files=1&apikey=not-a-real-key&output=json',
  );
});
