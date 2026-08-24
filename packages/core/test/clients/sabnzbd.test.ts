import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSabnzbdClient,
  resetDroppedSlotWarningForTests,
  resetUnrecognizedHistoryStatusWarningForTests,
} from '../../src/clients/sabnzbd.ts';
import type { SabnzbdClientConfig } from '../../src/config/schema.ts';
import type { JsonValue } from '../../src/json.ts';
import { assertNoLeak, assertNoSecret } from './no-leak.ts';

// Shaped like a real SABnzbd key: 32 hex characters. Kept realistic because
// the config schema now refuses anything shorter than MIN_API_KEY_LENGTH, so
// a fixture below that length would exercise a configuration the system
// cannot actually be booted with.
const HEX_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

// A key whose characters percent-encode. Every "does it leak" case that is
// really about encoding uses this one, because a hex key survives
// encodeURIComponent unchanged and so cannot distinguish a redactor that
// understands encodings from one that got lucky.
const BASE64_KEY = 'dXNlcjpwYXNzd29yZDEyMw==';

const CONFIG: SabnzbdClientConfig = {
  id: 'sab',
  type: 'sabnzbd',
  url: 'http://sab.invalid:8080',
  apiKey: HEX_KEY,
  category: 'pickarr',
  importMode: 'move',
  pathMappings: [
    { from: '/downloads/complete', to: '/data/complete' },
    { from: '/downloads', to: '/data/downloads' },
  ],
};

function jsonResponse(body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(bodyFor: (url: string) => JsonValue): {
  fetch: (url: string) => Promise<Response>;
  urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url: string) => {
      urls.push(url);
      return jsonResponse(bodyFor(url));
    },
  };
}

test('addUrl sends the category and returns the nzo id', async () => {
  const recorder = recordingFetch(() => ({ status: true, nzo_ids: ['SABnzbd_nzo_abc'] }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  const ref = await client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored');

  assert.equal(ref, 'SABnzbd_nzo_abc');
  assert.match(recorder.urls[0] ?? '', /mode=addurl/);
  assert.match(recorder.urls[0] ?? '', /cat=pickarr/);
  assert.ok((recorder.urls[0] ?? '').includes(`apikey=${CONFIG.apiKey}`));
});

// The caller's label is what lets a later poll recognize a job the client
// already accepted without matching on the release's own name (see
// downloadLabel in @pickarr/core's db/downloads.ts) — so it must actually
// reach SABnzbd as the job's name, not just be accepted as a parameter.
test('addUrl sends the caller-provided label as nzbname', async () => {
  const recorder = recordingFetch(() => ({ status: true, nzo_ids: ['SABnzbd_nzo_abc'] }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  await client.addUrl('https://indexer.invalid/x.nzb', 'pickarr-42', 'ignored');

  assert.match(recorder.urls[0] ?? '', /nzbname=pickarr-42/);
});

test('addUrl throws when sabnzbd reports failure', async () => {
  const recorder = recordingFetch(() => ({ status: false, error: 'nope' }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), /nope/);
});

test('addUrl throws when no nzo id comes back', async () => {
  const recorder = recordingFetch(() => ({ status: true, nzo_ids: [] }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), /no nzo/i);
});

test('an error never contains the api key', async () => {
  const client = createSabnzbdClient(CONFIG, async () => new Response('nope', { status: 500 }));
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('an error thrown by fetchImpl itself never leaks the api key', async () => {
  const client = createSabnzbdClient(CONFIG, async (url) => {
    throw new Error(`network failure while fetching ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('a JSON-parse failure from response.json() never leaks the api key', async () => {
  const client = createSabnzbdClient(CONFIG, async (url) => {
    class ThrowingJsonResponse extends Response {
      override readonly json = async (): Promise<never> => {
        throw new Error(`could not parse JSON returned for ${url}`);
      };
    }
    return new ThrowingJsonResponse('not json', { status: 200 });
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('a base64-style api key with +, /, = never leaks, even decoded', async () => {
  const config: SabnzbdClientConfig = { ...CONFIG, apiKey: BASE64_KEY };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`fetch failed for ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    assertNoLeak(error, config.apiKey);
    return true;
  });
});

test('an api key containing +, /, =, and a space never leaks, even decoded', async () => {
  const config: SabnzbdClientConfig = { ...CONFIG, apiKey: 'sec/ret+key=1 2 long enough' };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`fetch failed for ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    assertNoLeak(error, config.apiKey);
    return true;
  });
});

test('an api key embedded in the thrown error\'s name is also redacted', async () => {
  const client = createSabnzbdClient(CONFIG, async () => {
    const error = new Error('generic failure');
    error.name = `FetchError(apikey=${CONFIG.apiKey})`;
    throw error;
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('a non-Error throw from fetchImpl produces the wrapper, not a crash', async () => {
  const client = createSabnzbdClient(CONFIG, async () => {
    throw `raw string failure with apikey=${CONFIG.apiKey}`;
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    assert.equal(error.message, 'SABnzbd addurl request failed');
    assert.ok(error.cause instanceof Error);
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

// Redaction that destroys the message is safe but useless; this pins the
// other half of the property, that a message survives redaction legible.
// (It replaces an earlier version of this test that used a one-character key
// to probe the same thing. A key that short is no longer a configuration the
// system accepts — see the config tests — so the case is now pinned with a
// key the system will actually run with.)
test('redaction leaves the rest of an error message legible', async () => {
  const client = createSabnzbdClient(CONFIG, async (url) => {
    throw new Error(`fetch failed for ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    const cause = error.cause;
    assert.ok(cause instanceof Error);
    assert.match(cause.message, /^fetch failed for http:\/\/sab\.invalid:8080\/api\?mode=addurl&/);
    assert.match(cause.message, /apikey=\*\*\*(&|$)/);
    assert.match(cause.message, /output=json$/);
    return true;
  });
});

test("the server's own error field never leaks the api key", async () => {
  // SABnzbd echoes the request it rejected. Nothing in the client's own
  // wording carries the key here — the whole leak is the server's string.
  const client = createSabnzbdClient(CONFIG, async (url) =>
    jsonResponse({ status: false, error: `bad request: ${url}` }),
  );
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('a percent-encoded request url outside query shape does not leak the key', async () => {
  // The whole URL encoded as one component: `&apikey=` becomes `%26apikey%3D`,
  // so there is no `?`/`&` delimiter for the structural rule to key off, and
  // the key itself is encoded so a literal-value pass cannot see it either.
  // One decodeURIComponent recovers everything.
  const config: SabnzbdClientConfig = { ...CONFIG, apiKey: BASE64_KEY };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`request failed: ${encodeURIComponent(url)}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    assertNoLeak(error, config.apiKey);
    return true;
  });
});

test('a doubly percent-encoded request url does not leak the key', async () => {
  const config: SabnzbdClientConfig = { ...CONFIG, apiKey: BASE64_KEY };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`request failed: ${encodeURIComponent(encodeURIComponent(url))}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), (error: Error) => {
    assertNoLeak(error, config.apiKey);
    return true;
  });
});

test('server-supplied strings returned by snapshot never carry the api key', async () => {
  // snapshot() returns server text rather than throwing it, so none of the
  // error-path defences apply; these strings reach a caller (and its log)
  // straight off the wire.
  const client = createSabnzbdClient(CONFIG, async (url) =>
    jsonResponse(
      url.includes('mode=queue')
        ? {
            queue: {
              noofslots: 1,
              slots: [{ nzo_id: 'q1', filename: `stalled: ${url}`, percentage: '7' }],
            },
          }
        : {
            history: {
              noofslots: 1,
              slots: [
                {
                  nzo_id: 'h1',
                  name: `failed: ${url}`,
                  status: 'Failed',
                  storage: '',
                  fail_message: `download failed for ${url}`,
                },
              ],
            },
          },
    ),
  );

  const snapshot = await client.snapshot();
  const surfaces = [
    ...snapshot.queue.flatMap((entry) => [entry.ref, entry.name]),
    ...snapshot.history.flatMap((entry) => [
      entry.ref,
      entry.name,
      entry.storagePath ?? '',
      entry.failMessage ?? '',
    ]),
  ];
  assert.ok(surfaces.length > 0);
  for (const surface of surfaces) assertNoSecret(surface, CONFIG.apiKey);
});

test('an nzo id echoing the request url is not returned verbatim', async () => {
  const client = createSabnzbdClient(CONFIG, async (url) =>
    jsonResponse({ status: true, nzo_ids: [`SABnzbd_nzo_for_${url}`] }),
  );
  assertNoSecret(await client.addUrl('https://indexer.invalid/x.nzb', 'label', 'ignored'), CONFIG.apiKey);
});

test('snapshot reads queue and history, unfiltered, and reports complete', async () => {
  const recorder = recordingFetch((url) =>
    url.includes('mode=queue')
      ? {
          queue: {
            noofslots: 1,
            slots: [{ nzo_id: 'q1', filename: 'Release.One', percentage: '42', cat: 'pickarr' }],
          },
        }
      : {
          history: {
            noofslots: 2,
            slots: [
              {
                nzo_id: 'h1',
                name: 'Release.Two',
                status: 'Completed',
                storage: '/downloads/complete/Release.Two',
                fail_message: '',
                category: 'pickarr',
              },
              {
                nzo_id: 'h2',
                name: 'Release.Three',
                status: 'Failed',
                storage: '',
                fail_message: 'Out of retention',
                category: 'pickarr',
              },
            ],
          },
        },
  );
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  const snapshot = await client.snapshot();

  assert.deepEqual(snapshot.queue, [
    { ref: 'q1', name: 'Release.One', percentage: 42, category: 'pickarr' },
  ]);
  assert.equal(snapshot.history[0]?.outcome, 'completed');
  assert.equal(snapshot.history[0]?.storagePath, '/downloads/complete/Release.Two');
  assert.equal(snapshot.history[0]?.category, 'pickarr');
  assert.equal(snapshot.history[1]?.outcome, 'failed');
  assert.equal(snapshot.history[1]?.failMessage, 'Out of retention');
  assert.equal(snapshot.history[1]?.storagePath, null);
  assert.equal(snapshot.complete, true);
});

// The root cause of the incident this design fixes: asking SABnzbd to filter
// by category costs the ability to verify completeness, because queue_info's
// noofslots is the size of the *whole* queue regardless of what was
// requested. Matching happens on our side instead (nzo_id / [pickarr-N]
// label), so neither request may carry a category filter. The history
// request instead carries an explicit `limit`, for the same reason `queue`
// carries an explicit `limit=0` — relying on a missing `limit` meaning
// "unlimited" on one endpoint but not the other is what caused the incident.
test('neither request filters by category, and the history request states its limit explicitly', async () => {
  const recorder = recordingFetch(() => ({}));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  await client.snapshot();

  assert.ok(recorder.urls.length >= 2);
  for (const url of recorder.urls) assert.doesNotMatch(url, /[?&]category=/);
  const queueUrl = recorder.urls.find((url) => url.includes('mode=queue'));
  const historyUrl = recorder.urls.find((url) => url.includes('mode=history'));
  assert.match(queueUrl ?? '', /[?&]limit=0(&|$)/);
  assert.match(historyUrl ?? '', /[?&]limit=500(&|$)/);
});

// A queue slot with no category is the literal string "None"; a history slot
// with no category is the empty string. Both must collapse to null, or a
// caller filtering locally by category would treat "None" as a real one.
test('queue "cat" and history "category" both land on the entry, and "None"/"" become null', async () => {
  const recorder = recordingFetch((url) =>
    url.includes('mode=queue')
      ? {
          queue: {
            noofslots: 2,
            slots: [
              { nzo_id: 'q1', filename: 'R1', percentage: '10', cat: 'pickarr' },
              { nzo_id: 'q2', filename: 'R2', percentage: '20', cat: 'None' },
            ],
          },
        }
      : {
          history: {
            noofslots: 2,
            slots: [
              {
                nzo_id: 'h1',
                name: 'R3',
                status: 'Completed',
                storage: '',
                fail_message: '',
                category: 'pickarr',
              },
              {
                nzo_id: 'h2',
                name: 'R4',
                status: 'Completed',
                storage: '',
                fail_message: '',
                category: '',
              },
            ],
          },
        },
  );
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  const snapshot = await client.snapshot();

  assert.equal(snapshot.queue[0]?.category, 'pickarr');
  assert.equal(snapshot.queue[1]?.category, null);
  assert.equal(snapshot.history[0]?.category, 'pickarr');
  assert.equal(snapshot.history[1]?.category, null);
});

// --- Snapshot completeness ----------------------------------------------
//
// The design this guards: a snapshot must be provably the client's whole
// picture before reconcile can conclude an entry is *absent*. It may still
// use a partial snapshot to advance rows it does contain.

test('history spanning three pages is fully collected, with increasing start on each request', async () => {
  const total = 1_100; // > 2 * HISTORY_PAGE_SIZE, so three pages are needed
  const recorder = recordingFetch((url) => {
    if (url.includes('mode=queue')) return { queue: { noofslots: 0, slots: [] } };
    const params = new URL(url).searchParams;
    const start = Number(params.get('start'));
    const limit = Number(params.get('limit'));
    const remaining = total - start;
    const count = Math.max(0, Math.min(limit, remaining));
    return {
      history: {
        noofslots: total,
        slots: Array.from({ length: count }, (_unused, index) => ({
          nzo_id: `h${start + index}`,
          name: 'R',
          status: 'Completed',
          storage: '',
          fail_message: '',
        })),
      },
    };
  });
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  const snapshot = await client.snapshot();

  assert.equal(snapshot.history.length, total);
  assert.equal(snapshot.complete, true);
  const historyStarts = recorder.urls
    .filter((url) => url.includes('mode=history'))
    .map((url) => Number(new URL(url).searchParams.get('start')));
  assert.deepEqual(historyStarts, [0, 500, 1000]);
});

test('complete is false when the collected count falls short of noofslots', async () => {
  const client = createSabnzbdClient(CONFIG, async (url) =>
    jsonResponse(
      url.includes('mode=queue')
        ? { queue: { noofslots: 0, slots: [] } }
        : // Reports 10 total but only ever returns 5, then nothing further —
          // an inconsistent client, which must not be read as complete.
          url.includes('start=0')
          ? {
              history: {
                noofslots: 10,
                slots: Array.from({ length: 5 }, (_unused, index) => ({
                  nzo_id: `h${index}`,
                  name: 'R',
                  status: 'Completed',
                  storage: '',
                  fail_message: '',
                })),
              },
            }
          : { history: { noofslots: 10, slots: [] } },
    ),
  );

  const snapshot = await client.snapshot();

  assert.equal(snapshot.history.length, 5);
  assert.equal(snapshot.complete, false);
});

test('complete is false when MAX_HISTORY_PAGES is exhausted before noofslots is reached', async () => {
  const recorder = recordingFetch((url) =>
    url.includes('mode=queue')
      ? { queue: { noofslots: 0, slots: [] } }
      : // Always reports far more remaining than has been collected, and
        // always returns a full page: paging never legitimately finishes.
        {
          history: {
            noofslots: 1_000_000,
            slots: [{ nzo_id: 'h', name: 'R', status: 'Completed', storage: '', fail_message: '' }],
          },
        },
  );
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  const snapshot = await client.snapshot();

  assert.equal(snapshot.complete, false);
  assert.equal(recorder.urls.filter((url) => url.includes('mode=history')).length, 20);
});

// Deliberately gives each history page real slots (not an empty page), which
// is what distinguishes this from a fixture that would stop on the first
// page for an unrelated reason. Before the fix (fix round 1, controller
// ruling), an unreadable `noofslots` on a *non-empty* page kept the loop
// going — the empty-page exit never fired, and neither did the
// reaches-noofslots exit, so it ran all the way to MAX_HISTORY_PAGES against
// a client that could never satisfy either — 20 requests every tick, forever.
test('complete is false when noofslots is absent or not a number, on either endpoint, and history does not page to the cap chasing it', async () => {
  const missingRecorder = recordingFetch((url) =>
    url.includes('mode=queue')
      ? { queue: { slots: [{ nzo_id: 'q1', filename: 'R', percentage: '1' }] } }
      : {
          history: {
            slots: [{ nzo_id: 'h1', name: 'R', status: 'Completed', storage: '', fail_message: '' }],
          },
        },
  );
  const missingNoofslots = createSabnzbdClient(CONFIG, missingRecorder.fetch);
  const missingSnapshot = await missingNoofslots.snapshot();
  assert.equal(missingSnapshot.complete, false);
  assert.equal(missingRecorder.urls.filter((url) => url.includes('mode=history')).length, 1);

  const nonNumericRecorder = recordingFetch((url) =>
    url.includes('mode=queue')
      ? { queue: { noofslots: 'lots', slots: [{ nzo_id: 'q1', filename: 'R', percentage: '1' }] } }
      : {
          history: {
            noofslots: 'lots',
            slots: [{ nzo_id: 'h1', name: 'R', status: 'Completed', storage: '', fail_message: '' }],
          },
        },
  );
  const nonNumericNoofslots = createSabnzbdClient(CONFIG, nonNumericRecorder.fetch);
  const nonNumericSnapshot = await nonNumericNoofslots.snapshot();
  assert.equal(nonNumericSnapshot.complete, false);
  assert.equal(nonNumericRecorder.urls.filter((url) => url.includes('mode=history')).length, 1);
});

test('complete is true on an ordinary single-page response', async () => {
  const client = createSabnzbdClient(CONFIG, async (url) =>
    jsonResponse(
      url.includes('mode=queue')
        ? { queue: { noofslots: 1, slots: [{ nzo_id: 'q1', filename: 'R', percentage: '1' }] } }
        : {
            history: {
              noofslots: 1,
              slots: [
                { nzo_id: 'h1', name: 'R', status: 'Completed', storage: '', fail_message: '' },
              ],
            },
          },
    ),
  );

  const snapshot = await client.snapshot();

  assert.equal(snapshot.complete, true);
});

// A slot this client cannot key on (see the nzo_id checks in snapshot()) is
// dropped from `queue` rather than kept under a ref we cannot trust, but it
// was still counted toward `noofslots`. Without tracking the raw count
// separately from what got accepted, that drop is invisible: the length test
// against `noofslots` still passes, `complete` still reports true, and
// property (b) — an incomplete snapshot must never imply absence — breaks
// for exactly the job whose slot got dropped.
test('a queue slot with an unreadable nzo_id makes the snapshot incomplete, without losing the slots that were readable', async () => {
  resetDroppedSlotWarningForTests();
  const client = createSabnzbdClient(CONFIG, async (url) =>
    jsonResponse(
      url.includes('mode=queue')
        ? {
            queue: {
              noofslots: 2,
              slots: [
                { nzo_id: 'q1', filename: 'R1', percentage: '1' },
                { nzo_id: '', filename: 'R2', percentage: '2' },
              ],
            },
          }
        : { history: { noofslots: 0, slots: [] } },
    ),
  );

  const snapshot = await client.snapshot();

  assert.equal(snapshot.queue.length, 1);
  assert.equal(snapshot.queue[0]?.ref, 'q1');
  assert.equal(snapshot.complete, false);
});

// Same hole, on the history side: history paging derives each page's `start`
// from the raw slot count, not the accepted one, so the two must be tracked
// separately regardless — this is the same drop, just on the endpoint that
// also pages.
test('a history slot with an unreadable nzo_id makes the snapshot incomplete, without losing the slots that were readable', async () => {
  resetDroppedSlotWarningForTests();
  const client = createSabnzbdClient(CONFIG, async (url) =>
    jsonResponse(
      url.includes('mode=queue')
        ? { queue: { noofslots: 0, slots: [] } }
        : {
            history: {
              noofslots: 2,
              slots: [
                { nzo_id: 'h1', name: 'R1', status: 'Completed', storage: '', fail_message: '' },
                { nzo_id: '', name: 'R2', status: 'Completed', storage: '', fail_message: '' },
              ],
            },
          },
    ),
  );

  const snapshot = await client.snapshot();

  assert.equal(snapshot.history.length, 1);
  assert.equal(snapshot.history[0]?.ref, 'h1');
  assert.equal(snapshot.complete, false);
});

// The incident this whole design exists to fix: a real SABnzbd (or a proxy
// in front of it) that silently caps a history response below what was
// asked for. Before this change, snapshot() had no way to notice — it
// requested via history_limit indirectly and never checked the count it got
// back against the client's own total, so a truncated response was
// indistinguishable from a genuinely short history, and downloads still in
// history were concluded absent.
test('incident regression: a client that caps history at 10 unless a larger limit is passed still yields all 35 entries, complete', async () => {
  const total = 35;
  const recorder = recordingFetch((url) => {
    if (url.includes('mode=queue')) return { queue: { noofslots: 0, slots: [] } };
    const params = new URL(url).searchParams;
    const start = Number(params.get('start'));
    const requestedLimit = Number(params.get('limit'));
    // The incident: a real endpoint (or a misconfigured proxy in front of
    // one) capping history at 10 unless the caller states a larger limit.
    // snapshot() now always states one (HISTORY_PAGE_SIZE = 500), so the
    // cap never engages and the whole history comes back in one page.
    const effectiveLimit = Math.max(10, requestedLimit);
    const remaining = total - start;
    const count = Math.max(0, Math.min(effectiveLimit, remaining));
    return {
      history: {
        noofslots: total,
        slots: Array.from({ length: count }, (_unused, index) => ({
          nzo_id: `h${start + index}`,
          name: 'R',
          status: 'Completed',
          storage: '',
          fail_message: '',
        })),
      },
    };
  });
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  const snapshot = await client.snapshot();

  assert.equal(snapshot.history.length, total);
  assert.equal(snapshot.complete, true);
});

// Fix round 1 regression: the queue request is started before the history
// loop and only awaited afterward, so a queue-side failure lives unawaited
// across every `await` the history loop makes in between. Node treats a
// promise as "unhandled" if nothing has attached a handler to it by the end
// of a turn, and by default that terminates the process — so this used to
// be able to crash the whole process instead of `snapshot()` cleanly
// rejecting, exactly when a queue failure landed while history was still
// paging. This pins both halves of the fix: the rejection still reaches the
// caller, and nothing is ever flagged unhandled along the way.
test('a queue rejection while history paging is still in progress surfaces as a clean snapshot() rejection, never an unhandled one', async () => {
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    // A deferred promise pins the ordering without relying on real timers:
    // the queue side is only allowed to reject once the first history page
    // has actually been requested, so the queue rejection lands while pages
    // 2 and 3 (of 3; `total` is set above HISTORY_PAGE_SIZE * 2) are still
    // to come — history paging is provably still in progress.
    let releaseQueueRejection: (() => void) | undefined;
    const queueUnblocked = new Promise<void>((resolve) => {
      releaseQueueRejection = resolve;
    });
    let historyPageCount = 0;
    const total = 1_100;

    const client = createSabnzbdClient(CONFIG, async (url) => {
      if (url.includes('mode=queue')) {
        await queueUnblocked;
        throw new Error('queue endpoint unreachable');
      }
      historyPageCount += 1;
      releaseQueueRejection?.();
      // A real event-loop turn per page, standing in for actual network I/O.
      // Without this, every promise in this test settles inside one batch of
      // microtasks with no macrotask boundary in between, and Node's
      // unhandled-rejection check — which runs between macrotasks, not
      // within a single microtask flush — never gets a chance to run before
      // `snapshot()` reaches its own `await queuePromise` and attaches a
      // handler "in time" regardless of whether the fix is in place. This
      // was verified: without this line, the test could not tell fixed code
      // from the reverted bug.
      await new Promise((resolve) => setImmediate(resolve));
      const params = new URL(url).searchParams;
      const start = Number(params.get('start'));
      const remaining = total - start;
      const count = Math.max(0, Math.min(500, remaining));
      return jsonResponse({
        history: {
          noofslots: total,
          slots: Array.from({ length: count }, (_unused, index) => ({
            nzo_id: `h${start + index}`,
            name: 'R',
            status: 'Completed',
            storage: '',
            fail_message: '',
          })),
        },
      });
    });

    await assert.rejects(client.snapshot(), (error: Error) => {
      assert.match(error.message, /SABnzbd queue request failed/);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /queue endpoint unreachable/);
      return true;
    });
    assert.ok(historyPageCount >= 1, 'history must have started paging before the queue rejected');

    // Give a straggling unhandled rejection (what this test exists to catch)
    // a full turn to surface before asserting none did.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

// --- History status -> outcome -----------------------------------------
//
// SABnzbd's real history carries several transient post-processing labels
// for a job that has neither failed nor finished. The previous rule read
// every one of them as a terminal failure, which meant an ordinary
// multi-part download got marked failed while SABnzbd was still unpacking
// it. Only 'Completed' is success; a specific, deliberately short list of
// terminal-failure labels is 'failed'; everything else transient is
// 'in-progress'.

test('every transient SABnzbd post-processing status is read as in-progress, not failed', async () => {
  const transient = [
    'Extracting',
    'Moving',
    'Repairing',
    'Verifying',
    'Fetching',
    'Running',
    'Queued',
    'Paused',
  ];
  for (const status of transient) {
    const client = createSabnzbdClient(CONFIG, async (url) =>
      url.includes('mode=queue')
        ? jsonResponse({})
        : jsonResponse({
            history: {
              noofslots: 1,
              slots: [{ nzo_id: 'h1', name: 'R', status, storage: '', fail_message: '' }],
            },
          }),
    );
    const snapshot = await client.snapshot();
    assert.equal(snapshot.history[0]?.outcome, 'in-progress', `status ${status}`);
  }
});

test("'Deleted' is a terminal failure, not in-progress", async () => {
  const client = createSabnzbdClient(CONFIG, async (url) =>
    url.includes('mode=queue')
      ? jsonResponse({})
      : jsonResponse({
          history: {
            noofslots: 1,
            slots: [{ nzo_id: 'h1', name: 'R', status: 'Deleted', storage: '', fail_message: '' }],
          },
        }),
  );
  const snapshot = await client.snapshot();
  assert.equal(snapshot.history[0]?.outcome, 'failed');
});

test('an unrecognized status is a terminal failure, not in-progress', async () => {
  resetUnrecognizedHistoryStatusWarningForTests();
  const client = createSabnzbdClient(CONFIG, async (url) =>
    url.includes('mode=queue')
      ? jsonResponse({})
      : jsonResponse({
          history: {
            noofslots: 1,
            slots: [
              {
                nzo_id: 'h1',
                name: 'R',
                status: 'SomeFutureStatusThisClientHasNeverSeen',
                storage: '',
                fail_message: '',
              },
            ],
          },
        }),
  );
  const snapshot = await client.snapshot();
  assert.equal(snapshot.history[0]?.outcome, 'failed');
});

// Defaulting an unrecognized status to 'failed' with no explanation produces
// a record identical to a genuine unexplained failure — the exact bug this
// whole change exists to fix, just moved one status later. The message has
// to name the offending status, and the warning has to fire so a future
// occurrence is visible in the log, not just in a failed download nobody can
// explain.
test('an unrecognized status names itself in the failure message rather than looking like a generic failure', async () => {
  resetUnrecognizedHistoryStatusWarningForTests();
  const client = createSabnzbdClient(CONFIG, async (url) =>
    url.includes('mode=queue')
      ? jsonResponse({})
      : jsonResponse({
          history: {
            noofslots: 1,
            slots: [
              {
                nzo_id: 'h1',
                name: 'R',
                status: 'SomeFutureStatusThisClientHasNeverSeen',
                storage: '',
                fail_message: '',
              },
            ],
          },
        }),
  );
  const snapshot = await client.snapshot();
  assert.match(snapshot.history[0]?.failMessage ?? '', /SomeFutureStatusThisClientHasNeverSeen/);
});

test('an unrecognized status warns exactly once, not once per snapshot', async () => {
  resetUnrecognizedHistoryStatusWarningForTests();
  const client = createSabnzbdClient(CONFIG, async (url) =>
    url.includes('mode=queue')
      ? jsonResponse({})
      : jsonResponse({
          history: {
            noofslots: 1,
            slots: [
              { nzo_id: 'h1', name: 'R', status: 'Weird', storage: '', fail_message: '' },
            ],
          },
        }),
  );
  const warnMock = mock.method(console, 'warn', () => {});
  try {
    await client.snapshot();
    await client.snapshot();
    await client.snapshot();

    assert.equal(warnMock.mock.callCount(), 1);
    const message = String(warnMock.mock.calls[0]?.arguments[0] ?? '');
    assert.match(message, /h1/);
    assert.match(message, /Weird/);
  } finally {
    warnMock.mock.restore();
  }
});

// A recognized failure status (Failed, Deleted) is not "unrecognized" and
// must not trigger the warning or have the note appended — only a status
// outside every enumerated bucket does.
test('a recognized terminal failure status does not warn and keeps its own fail_message untouched', async () => {
  resetUnrecognizedHistoryStatusWarningForTests();
  const client = createSabnzbdClient(CONFIG, async (url) =>
    url.includes('mode=queue')
      ? jsonResponse({})
      : jsonResponse({
          history: {
            noofslots: 1,
            slots: [
              {
                nzo_id: 'h1',
                name: 'R',
                status: 'Failed',
                storage: '',
                fail_message: 'Out of retention',
              },
            ],
          },
        }),
  );
  const warnMock = mock.method(console, 'warn', () => {});
  try {
    const snapshot = await client.snapshot();
    assert.equal(warnMock.mock.callCount(), 0);
    assert.equal(snapshot.history[0]?.failMessage, 'Out of retention');
  } finally {
    warnMock.mock.restore();
  }
});

// Neither endpoint reports a `noofslots` here, which per the completeness
// rule above means "cannot verify" rather than "everything" — so an
// otherwise-empty response is not automatically a complete one.
test('snapshot tolerates missing slots, but reports itself incomplete since neither endpoint reported a total', async () => {
  const client = createSabnzbdClient(CONFIG, async () => jsonResponse({}));
  const snapshot = await client.snapshot();
  assert.deepEqual(snapshot, { queue: [], history: [], complete: false });
});

test('mapPath applies the longest matching prefix', () => {
  const client = createSabnzbdClient(CONFIG, async () => jsonResponse({}));
  assert.equal(client.mapPath('/downloads/complete/X'), '/data/complete/X');
  assert.equal(client.mapPath('/downloads/incomplete/X'), '/data/downloads/incomplete/X');
});

test('mapPath leaves an unmatched path alone', () => {
  const client = createSabnzbdClient(CONFIG, async () => jsonResponse({}));
  assert.equal(client.mapPath('/elsewhere/X'), '/elsewhere/X');
});
