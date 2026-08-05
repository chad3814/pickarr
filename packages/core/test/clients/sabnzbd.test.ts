import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createSabnzbdClient } from '../../src/clients/sabnzbd.ts';
import type { DownloadClientConfig } from '../../src/config/schema.ts';
import type { JsonValue } from '../../src/json.ts';

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

const CONFIG: DownloadClientConfig = {
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

/**
 * Every reading of `surface` a consumer could arrive at with routine
 * decoding: repeated percent-decoding, `+`-for-space form decoding, and any
 * interleaving of the two. Asserting only literal absence is what let the
 * percent-encoding bypass through an earlier round — `apikey=dXNlcjpwYXNz%3D%3D`
 * contains no literal match yet gives the key up to one decodeURIComponent.
 *
 * Written out here rather than imported from the client on purpose: if the
 * test reused the client's own decoder, a blind spot in that decoder would be
 * a blind spot in the check that is supposed to catch it. Percent runs are
 * decoded individually so a single stray `%` (common in stack traces) cannot
 * switch the whole check off, which a bare decodeURIComponent would allow.
 */
function readings(surface: string): string[] {
  const seen = new Set<string>([surface]);
  let frontier = [surface];
  for (let round = 0; round < 3 && frontier.length > 0; round += 1) {
    const next: string[] = [];
    for (const view of frontier) {
      const percentDecoded = view.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
        try {
          return decodeURIComponent(run);
        } catch {
          return run;
        }
      });
      for (const candidate of [percentDecoded, view.replaceAll('+', ' ')]) {
        if (!seen.has(candidate)) {
          seen.add(candidate);
          next.push(candidate);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/** Asserts the secret is unrecoverable from a single string. */
function assertNoSecret(surface: string, secret: string): void {
  for (const reading of readings(surface)) {
    assert.ok(
      !reading.includes(secret),
      `api key is recoverable from this text: ${reading.slice(0, 300)}`,
    );
  }
}

/**
 * Checks the whole error surface a caller might log or inspect — not just
 * `.message`. A fix that only cleaned `.message` while leaving the secret
 * reachable through `.cause`, `.name`, or `util.inspect` would pass a
 * narrower check but still leak in practice.
 */
function assertNoLeak(error: Error, secret: string): void {
  const surfaces = [error.message, String(error), inspect(error, { depth: 6 })];
  const cause = error.cause;
  if (cause instanceof Error) {
    surfaces.push(cause.message, cause.name, String(cause));
  }
  for (const surface of surfaces) assertNoSecret(surface, secret);
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

  const ref = await client.addUrl('https://indexer.invalid/x.nzb', 'label');

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

  await client.addUrl('https://indexer.invalid/x.nzb', 'pickarr-42');

  assert.match(recorder.urls[0] ?? '', /nzbname=pickarr-42/);
});

test('addUrl throws when sabnzbd reports failure', async () => {
  const recorder = recordingFetch(() => ({ status: false, error: 'nope' }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), /nope/);
});

test('addUrl throws when no nzo id comes back', async () => {
  const recorder = recordingFetch(() => ({ status: true, nzo_ids: [] }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), /no nzo/i);
});

test('an error never contains the api key', async () => {
  const client = createSabnzbdClient(CONFIG, async () => new Response('nope', { status: 500 }));
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('an error thrown by fetchImpl itself never leaks the api key', async () => {
  const client = createSabnzbdClient(CONFIG, async (url) => {
    throw new Error(`network failure while fetching ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
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
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('a base64-style api key with +, /, = never leaks, even decoded', async () => {
  const config: DownloadClientConfig = { ...CONFIG, apiKey: BASE64_KEY };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`fetch failed for ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
    assertNoLeak(error, config.apiKey);
    return true;
  });
});

test('an api key containing +, /, =, and a space never leaks, even decoded', async () => {
  const config: DownloadClientConfig = { ...CONFIG, apiKey: 'sec/ret+key=1 2 long enough' };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`fetch failed for ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
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
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('a non-Error throw from fetchImpl produces the wrapper, not a crash', async () => {
  const client = createSabnzbdClient(CONFIG, async () => {
    throw `raw string failure with apikey=${CONFIG.apiKey}`;
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
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
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
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
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('a percent-encoded request url outside query shape does not leak the key', async () => {
  // The whole URL encoded as one component: `&apikey=` becomes `%26apikey%3D`,
  // so there is no `?`/`&` delimiter for the structural rule to key off, and
  // the key itself is encoded so a literal-value pass cannot see it either.
  // One decodeURIComponent recovers everything.
  const config: DownloadClientConfig = { ...CONFIG, apiKey: BASE64_KEY };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`request failed: ${encodeURIComponent(url)}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
    assertNoLeak(error, config.apiKey);
    return true;
  });
});

test('a doubly percent-encoded request url does not leak the key', async () => {
  const config: DownloadClientConfig = { ...CONFIG, apiKey: BASE64_KEY };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`request failed: ${encodeURIComponent(encodeURIComponent(url))}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb', 'label'), (error: Error) => {
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
        ? { queue: { slots: [{ nzo_id: 'q1', filename: `stalled: ${url}`, percentage: '7' }] } }
        : {
            history: {
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
  assertNoSecret(await client.addUrl('https://indexer.invalid/x.nzb', 'label'), CONFIG.apiKey);
});

test('snapshot reads queue and history filtered by category', async () => {
  const recorder = recordingFetch((url) =>
    url.includes('mode=queue')
      ? { queue: { slots: [{ nzo_id: 'q1', filename: 'Release.One', percentage: '42' }] } }
      : {
          history: {
            slots: [
              {
                nzo_id: 'h1',
                name: 'Release.Two',
                status: 'Completed',
                storage: '/downloads/complete/Release.Two',
                fail_message: '',
              },
              {
                nzo_id: 'h2',
                name: 'Release.Three',
                status: 'Failed',
                storage: '',
                fail_message: 'Out of retention',
              },
            ],
          },
        },
  );
  const client = createSabnzbdClient(CONFIG, recorder.fetch);

  const snapshot = await client.snapshot();

  assert.deepEqual(snapshot.queue, [{ ref: 'q1', name: 'Release.One', percentage: 42 }]);
  assert.equal(snapshot.history[0]?.outcome, 'completed');
  assert.equal(snapshot.history[0]?.storagePath, '/downloads/complete/Release.Two');
  assert.equal(snapshot.history[1]?.outcome, 'failed');
  assert.equal(snapshot.history[1]?.failMessage, 'Out of retention');
  assert.equal(snapshot.history[1]?.storagePath, null);
  assert.ok(recorder.urls.every((url) => url.includes('category=pickarr')));
});

test('snapshot tolerates missing slots', async () => {
  const client = createSabnzbdClient(CONFIG, async () => jsonResponse({}));
  const snapshot = await client.snapshot();
  assert.deepEqual(snapshot, { queue: [], history: [] });
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
