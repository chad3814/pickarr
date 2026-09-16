import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StaticDeps, StaticResponse } from '../../src/api/static-route.ts';
import { staticAnswer, warnIfWebRootMissing } from '../../src/api/static-route.ts';

/** Never a real filesystem, on `artwork-route.test.ts`'s own `fakeDeps` pattern. */
interface FakeFile {
  bytes: Uint8Array;
  mtimeMs: number;
  size: number;
}

function fakeDeps(webRoot: string, files: Record<string, FakeFile>): {
  deps: StaticDeps;
  readFileCalls: string[];
  statCalls: string[];
} {
  const readFileCalls: string[] = [];
  const statCalls: string[] = [];
  return {
    readFileCalls,
    statCalls,
    deps: {
      webRoot,
      readFile: async (path: string): Promise<Uint8Array> => {
        readFileCalls.push(path);
        const file = files[path];
        if (file === undefined) throw new Error('ENOENT: no such fake file');
        return file.bytes;
      },
      stat: async (path: string): Promise<{ mtimeMs: number; size: number }> => {
        statCalls.push(path);
        const file = files[path];
        if (file === undefined) throw new Error('ENOENT: no such fake file');
        return { mtimeMs: file.mtimeMs, size: file.size };
      },
    },
  };
}

function utf8(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function text(response: StaticResponse): string {
  return Buffer.from(response.body ?? new Uint8Array()).toString('utf8');
}

const WEB_ROOT = '/web/root';
const APP_JS = utf8('console.log("app");');
const INDEX_HTML = utf8('<!doctype html><title>pickarr</title>');
const SECRET = utf8('do-not-serve-this');

test('an asset is served with its content type and a weak etag', async () => {
  const { deps } = fakeDeps(WEB_ROOT, {
    [`${WEB_ROOT}/assets/app.js`]: { bytes: APP_JS, mtimeMs: 1_000, size: APP_JS.length },
  });

  const response = await staticAnswer(deps, '/assets/app.js', undefined);

  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.equal(response.headers.ETag, `W/"1000-${APP_JS.length}"`);
  assert.ok(response.headers['Last-Modified'], 'a Last-Modified header is present');
  assert.equal(text(response), 'console.log("app");');
});

test('a matching If-None-Match answers 304 with no body', async () => {
  const { deps, readFileCalls } = fakeDeps(WEB_ROOT, {
    [`${WEB_ROOT}/assets/app.js`]: { bytes: APP_JS, mtimeMs: 1_000, size: APP_JS.length },
  });
  const etag = `W/"1000-${APP_JS.length}"`;

  const response = await staticAnswer(deps, '/assets/app.js', etag);

  assert.equal(response.status, 304);
  assert.equal(response.body, null);
  assert.equal(response.headers.ETag, etag);
  assert.deepEqual(readFileCalls, [], 'a 304 never reads the bytes it is not sending');
});

test('an unmatched non-api path answers index.html, so a deep link survives a refresh', async () => {
  const { deps } = fakeDeps(WEB_ROOT, {
    [`${WEB_ROOT}/index.html`]: { bytes: INDEX_HTML, mtimeMs: 2_000, size: INDEX_HTML.length },
  });

  const response = await staticAnswer(deps, '/library/42', undefined);

  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(text(response), '<!doctype html><title>pickarr</title>');
});

test('an unmatched /api path is still an unknown-route 404, not html', async () => {
  // A typo'd endpoint answering HTML is a client parsing markup as JSON and
  // reporting a nonsense error, which is worse than a 404 by exactly the
  // time it takes to find (design spec §3). `index.html` is present in the
  // fixture, so this proves the `/api` refusal wins over the fallback that
  // would otherwise serve it, rather than merely proving no file exists.
  const { deps, readFileCalls, statCalls } = fakeDeps(WEB_ROOT, {
    [`${WEB_ROOT}/index.html`]: { bytes: INDEX_HTML, mtimeMs: 2_000, size: INDEX_HTML.length },
  });

  const response = await staticAnswer(deps, '/api/rss-items-v3', undefined);

  assert.equal(response.status, 404);
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(text(response)), { error: 'unknown route' });
  assert.deepEqual(statCalls, [], 'an /api path is refused before it ever touches the filesystem');
  assert.deepEqual(readFileCalls, []);
});

test('a path escaping the web root is refused after normalisation, not before', async () => {
  // `WEB_ROOT` is `/web/root`, two segments deep, so a candidate that walks
  // exactly two levels up and back down lands at `/web/secret.txt` -- still
  // outside `WEB_ROOT`, and a real file this fixture makes reachable *if*
  // the escape is ever allowed to resolve, so a mutant that drops the
  // containment check does not merely 404 by coincidence (a shallower escape
  // would land on a path this fixture never populated, and every mutant
  // would 404 the same way a correct refusal does).
  const ESCAPED = '/web/secret.txt';

  const { deps: literalDeps, readFileCalls: literalReads } = fakeDeps(WEB_ROOT, {
    [ESCAPED]: { bytes: SECRET, mtimeMs: 3_000, size: SECRET.length },
  });
  const literal = await staticAnswer(literalDeps, '/../secret.txt', undefined);
  assert.equal(literal.status, 404);
  assert.deepEqual(literalReads, [], 'the escaping candidate is never read');

  // The encoded form: `%2e%2e%2f` is what `new URL(...).pathname` leaves
  // *undecoded* (it never turns an encoded slash back into a real one), so
  // the raw string this function receives contains no literal `..` at all --
  // only `decodeURIComponent`, which this function must run before checking
  // containment, turns it into one. A check against the raw string would
  // find nothing to refuse and would serve `/web/secret.txt` outside the root.
  const { deps: encodedDeps, readFileCalls: encodedReads } = fakeDeps(WEB_ROOT, {
    [ESCAPED]: { bytes: SECRET, mtimeMs: 3_000, size: SECRET.length },
  });
  const encoded = await staticAnswer(encodedDeps, '/assets/%2e%2e%2f%2e%2e%2fsecret.txt', undefined);
  assert.equal(encoded.status, 404);
  assert.deepEqual(encodedReads, [], 'the escaping candidate is never read, however it was spelled');
  assert.ok(!text(encoded).includes('do-not-serve-this'), 'the secret file\'s bytes never reach the response');
});

test('an absent web root leaves the api answering and logs once', async () => {
  // No files at all: every `stat`/`readFile` call rejects, exactly as it
  // would against a `webRoot` that names no real directory.
  const { deps } = fakeDeps(WEB_ROOT, {});

  const asset = await staticAnswer(deps, '/assets/app.js', undefined);
  assert.equal(asset.status, 404, 'a missing root answers a plain 404, never a throw');
  assert.equal(asset.body, null);

  const fallback = await staticAnswer(deps, '/library/42', undefined);
  assert.equal(fallback.status, 404, 'the index.html fallback itself fails the same graceful way');

  const logged: string[] = [];
  await warnIfWebRootMissing(WEB_ROOT, deps.stat, (message) => { logged.push(message); });
  assert.equal(logged.length, 1, 'exactly one log line for one missing root, not a throw and not silence');
  assert.ok(!logged[0]?.includes(WEB_ROOT), 'the log names no filesystem path');

  const { deps: presentDeps } = fakeDeps(WEB_ROOT, {
    [WEB_ROOT]: { bytes: new Uint8Array(), mtimeMs: 1, size: 0 },
  });
  const quiet: string[] = [];
  await warnIfWebRootMissing(WEB_ROOT, presentDeps.stat, (message) => { quiet.push(message); });
  assert.deepEqual(quiet, [], 'a web root that is there logs nothing at all');
});

test('no answer carries a filesystem path', async () => {
  const secretRoot = '/very/unique/marker-path-nobody-should-see';
  const { deps } = fakeDeps(secretRoot, {
    [`${secretRoot}/assets/app.js`]: { bytes: APP_JS, mtimeMs: 1_000, size: APP_JS.length },
    [`${secretRoot}/index.html`]: { bytes: INDEX_HTML, mtimeMs: 2_000, size: INDEX_HTML.length },
  });

  const answers = await Promise.all([
    staticAnswer(deps, '/assets/app.js', undefined),
    staticAnswer(deps, '/assets/missing.js', undefined),
    staticAnswer(deps, '/library/42', undefined),
    staticAnswer(deps, '/api/unknown', undefined),
    staticAnswer(deps, '/../etc/passwd', undefined),
  ]);

  const logged: string[] = [];
  await warnIfWebRootMissing(`${secretRoot}-absent`, deps.stat, (message) => { logged.push(message); });

  for (const value of [...answers.map((answer) => JSON.stringify(answer)), ...logged]) {
    assert.ok(!value.includes(secretRoot), `no answer or log line may contain the web root's path: ${value}`);
    assert.ok(!value.includes('marker-path-nobody-should-see'), `nor any fragment of it: ${value}`);
  }
});
