import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createSabnzbdClient } from '../../src/clients/sabnzbd.ts';
import type { DownloadClientConfig } from '../../src/config/schema.ts';
import type { JsonValue } from '../../src/json.ts';

const CONFIG: DownloadClientConfig = {
  id: 'sab',
  type: 'sabnzbd',
  url: 'http://sab.invalid:8080',
  apiKey: 'SECRET_KEY',
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

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks the whole error surface a caller might log or inspect — not just
 * `.message`. A fix that only cleaned `.message` while leaving the secret
 * reachable through `.cause`, `.name`, or `util.inspect` would pass a
 * narrower check but still leak in practice. Also checks the *decoded*
 * form of everything: a key that survives percent-encoding (base64-style
 * keys routinely contain `+`, `/`, `=`) is recoverable with one
 * decodeURIComponent, so literal-absence alone is not enough.
 */
function assertNoLeak(error: Error, secret: string): void {
  const pattern = new RegExp(escapeRegExp(secret));
  const surfaces = [error.message, String(error), inspect(error, { depth: 5 })];
  const cause = error.cause;
  if (cause instanceof Error) {
    surfaces.push(cause.message, cause.name, String(cause));
  }
  for (const surface of surfaces) {
    assert.doesNotMatch(surface, pattern);
    // decodeURIComponent leaves already-decoded text untouched, so decoding
    // is safe whenever the surface happens to be valid percent-encoding, and
    // it is the check that would have caught the percent-encoding bypass.
    // Stack traces can contain a bare `%` that isn't a valid escape; only
    // the decode itself is allowed to fail silently, never the assertion.
    let decoded: string | null = null;
    try {
      decoded = decodeURIComponent(surface);
    } catch {
      // Not valid percent-encoding; the literal check above already covered it.
    }
    if (decoded !== null) assert.doesNotMatch(decoded, pattern);
  }
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

  const ref = await client.addUrl('https://indexer.invalid/x.nzb');

  assert.equal(ref, 'SABnzbd_nzo_abc');
  assert.match(recorder.urls[0] ?? '', /mode=addurl/);
  assert.match(recorder.urls[0] ?? '', /cat=pickarr/);
  assert.match(recorder.urls[0] ?? '', /apikey=SECRET_KEY/);
});

test('addUrl throws when sabnzbd reports failure', async () => {
  const recorder = recordingFetch(() => ({ status: false, error: 'nope' }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), /nope/);
});

test('addUrl throws when no nzo id comes back', async () => {
  const recorder = recordingFetch(() => ({ status: true, nzo_ids: [] }));
  const client = createSabnzbdClient(CONFIG, recorder.fetch);
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), /no nzo/i);
});

test('an error never contains the api key', async () => {
  const client = createSabnzbdClient(CONFIG, async () => new Response('nope', { status: 500 }));
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), (error: Error) => {
    assert.doesNotMatch(error.message, /SECRET_KEY/);
    return true;
  });
});

test('an error thrown by fetchImpl itself never leaks the api key', async () => {
  const client = createSabnzbdClient(CONFIG, async (url) => {
    throw new Error(`network failure while fetching ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), (error: Error) => {
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
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('a base64-style api key with +, /, = never leaks, even decoded', async () => {
  const config: DownloadClientConfig = { ...CONFIG, apiKey: 'dXNlcjpwYXNzd29yZA==' };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`fetch failed for ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), (error: Error) => {
    assertNoLeak(error, config.apiKey);
    return true;
  });
});

test('an api key containing +, /, =, and a space never leaks, even decoded', async () => {
  const config: DownloadClientConfig = { ...CONFIG, apiKey: 'sec/ret+key=1 2' };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`fetch failed for ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), (error: Error) => {
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
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), (error: Error) => {
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('a non-Error throw from fetchImpl produces the wrapper, not a crash', async () => {
  const client = createSabnzbdClient(CONFIG, async () => {
    throw `raw string failure with apikey=${CONFIG.apiKey}`;
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), (error: Error) => {
    assert.equal(error.message, 'SABnzbd addurl request failed');
    assert.ok(error.cause instanceof Error);
    assertNoLeak(error, CONFIG.apiKey);
    return true;
  });
});

test('a one-character api key does not shred the rest of the error message', async () => {
  const config: DownloadClientConfig = { ...CONFIG, apiKey: 'a' };
  const client = createSabnzbdClient(config, async (url) => {
    throw new Error(`fetch failed for ${url}`);
  });
  await assert.rejects(client.addUrl('https://indexer.invalid/x.nzb'), (error: Error) => {
    const cause = error.cause;
    assert.ok(cause instanceof Error);
    // Legible: the rest of the message survives untouched.
    assert.match(cause.message, /^fetch failed for http:\/\/sab\.invalid:8080\/api\?mode=addurl&/);
    // The apikey query parameter's value is still stripped by the
    // structural rule, even though the literal-value pass is skipped for a
    // key this short.
    assert.match(cause.message, /apikey=\*\*\*(&|$)/);
    return true;
  });
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
