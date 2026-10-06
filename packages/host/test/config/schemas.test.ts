import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRUSTED_PROXIES, databaseConfigSchema, fetchConfigSchema, secretsConfigSchema, serverConfigSchema } from '../../src/config/schemas.ts';

test('every host namespace parses an absent section into its defaults', () => {
  assert.deepEqual(serverConfigSchema.parse(undefined), {
    host: '0.0.0.0',
    port: 7676,
    // Empty, not absent: a host with no proxy and no alternate name trusts
    // only `publicUrl` and private-range IP literals, exactly as before
    // these fields existed.
    trustedOrigins: [],
    // Non-empty by default, which is the one security-relevant default here
    // -- see `DEFAULT_TRUSTED_PROXIES` for what it costs. Compared against
    // the exported constant rather than a second copy of the list: two
    // spellings of the same six CIDRs is a thing to keep in step for no gain.
    trustedProxies: [...DEFAULT_TRUSTED_PROXIES],
  });
  assert.deepEqual(databaseConfigSchema.parse(undefined), { path: '/config/pickarr.db' });
  assert.deepEqual(secretsConfigSchema.parse(undefined), { baseDir: '/run/secrets' });
});

test('the server defaults match what the auth slice chose', () => {
  const parsed = serverConfigSchema.parse(undefined);
  // 0.0.0.0 because a session is what protects the socket now, not the
  // interface it listens on.
  assert.equal(parsed.host, '0.0.0.0');
  assert.equal(parsed.port, 7676);
});

test('a publicUrl with a path is refused in the file, exactly as it is in the environment', () => {
  for (const publicUrl of ['http://host/pickarr', 'http://host?x=1', 'http://host#f', 'ws://host', 'nope']) {
    assert.throws(() => serverConfigSchema.parse({ publicUrl }), `${publicUrl} must be refused`);
  }
  assert.doesNotThrow(() => serverConfigSchema.parse({ publicUrl: 'https://host' }));
});

test('a port outside the legal range is refused', () => {
  for (const port of [0, -1, 65536, 1.5]) {
    assert.throws(() => serverConfigSchema.parse({ port }), `${port} must be refused`);
  }
  assert.doesNotThrow(() => serverConfigSchema.parse({ port: 1 }));
  assert.doesNotThrow(() => serverConfigSchema.parse({ port: 65535 }));
});

test('an unknown key inside a namespace is refused rather than silently dropped', () => {
  assert.throws(() => serverConfigSchema.parse({ prot: 7676 }), /unrecognized|unknown/i);
});

test('webRoot is absent by default, and a configured one passes through unmodified', () => {
  // Absent means "derive it" (design spec §3) -- a value this schema cannot
  // compute, since the default lives beside wherever the running process's
  // own code happens to be. `main.ts`'s `defaultWebRoot` is what computes
  // it; this schema only validates a value an operator actually set.
  assert.equal(serverConfigSchema.parse(undefined).webRoot, undefined);
  assert.equal(serverConfigSchema.parse({ webRoot: '/srv/web' }).webRoot, '/srv/web');
  // A bare string second argument is `assert.throws`'s failure *message*,
  // not a matcher against the thrown error -- Finding 12: this used to pass
  // for any thrown value at all, proving only that something threw. A
  // `RegExp` is validated against `error.message`.
  assert.throws(() => serverConfigSchema.parse({ webRoot: '' }), /too_small/, 'an empty string is not a path');
});

test('an absent fetch section yields the two constants the queue used to carry', () => {
  assert.deepEqual(fetchConfigSchema.parse(undefined), {
    default: { concurrency: 1, timeoutMs: 30000 },
    hosts: {},
  });
});

test('a fetch host entry may pin one field and inherit the other', () => {
  assert.deepEqual(
    fetchConfigSchema.parse({ hosts: { 'cdn.example': { concurrency: 3 } } }),
    { default: { concurrency: 1, timeoutMs: 30000 }, hosts: { 'cdn.example': { concurrency: 3 } } },
  );
});

test('a fetch host key that is not a bare lowercase hostname is refused naming the key', () => {
  assert.throws(
    () => fetchConfigSchema.parse({ hosts: { 'CDN.example:443': { concurrency: 3 } } }),
    /CDN\.example:443/,
  );
});

test('fetch bounds are enforced and the path names the host and field', () => {
  assert.throws(() => fetchConfigSchema.parse({ hosts: { 'a.b': { concurrency: 0 } } }), /hosts.*a\.b.*concurrency/s);
  assert.throws(() => fetchConfigSchema.parse({ hosts: { 'a.b': { concurrency: 65 } } }), /concurrency/);
  assert.throws(() => fetchConfigSchema.parse({ hosts: { 'a.b': { timeoutMs: 999 } } }), /timeoutMs/);
  assert.throws(() => fetchConfigSchema.parse({ hosts: { 'a.b': { timeoutMs: 300001 } } }), /timeoutMs/);
  assert.throws(() => fetchConfigSchema.parse({ default: { concurrency: 1.5, timeoutMs: 30000 } }), /concurrency/);
  assert.throws(() => fetchConfigSchema.parse({ hosts: { 'a.b': { retries: 2 } } }), /retries|unrecognized/i);
});

test('fetch bounds accept their ceilings: 300000 ms and 64 in flight', () => {
  assert.deepEqual(
    fetchConfigSchema.parse({ hosts: { 'a.b': { timeoutMs: 300000 } } }).hosts,
    { 'a.b': { timeoutMs: 300000 } },
  );
  assert.deepEqual(
    fetchConfigSchema.parse({ hosts: { 'a.b': { concurrency: 64 } } }).hosts,
    { 'a.b': { concurrency: 64 } },
  );
});

test('the reserved `default` is refused as a fetch.hosts key', () => {
  assert.throws(
    () => fetchConfigSchema.parse({ hosts: { default: { concurrency: 3 } } }),
    /not the reserved `default`/,
  );
});
