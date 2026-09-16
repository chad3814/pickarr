import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfigSchema, secretsConfigSchema, serverConfigSchema } from '../../src/config/schemas.ts';

test('every host namespace parses an absent section into its defaults', () => {
  assert.deepEqual(serverConfigSchema.parse(undefined), { host: '0.0.0.0', port: 8787 });
  assert.deepEqual(databaseConfigSchema.parse(undefined), { path: '/config/pickarr.db' });
  assert.deepEqual(secretsConfigSchema.parse(undefined), { baseDir: '/run/secrets' });
});

test('the server defaults match what the auth slice chose', () => {
  const parsed = serverConfigSchema.parse(undefined);
  // 0.0.0.0 because a session is what protects the socket now, not the
  // interface it listens on.
  assert.equal(parsed.host, '0.0.0.0');
  assert.equal(parsed.port, 8787);
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
  assert.throws(() => serverConfigSchema.parse({ prot: 8787 }), /unrecognized|unknown/i);
});

test('webRoot is absent by default, and a configured one passes through unmodified', () => {
  // Absent means "derive it" (design spec §3) -- a value this schema cannot
  // compute, since the default lives beside wherever the running process's
  // own code happens to be. `main.ts`'s `defaultWebRoot` is what computes
  // it; this schema only validates a value an operator actually set.
  assert.equal(serverConfigSchema.parse(undefined).webRoot, undefined);
  assert.equal(serverConfigSchema.parse({ webRoot: '/srv/web' }).webRoot, '/srv/web');
  assert.throws(() => serverConfigSchema.parse({ webRoot: '' }), 'an empty string is not a path');
});
