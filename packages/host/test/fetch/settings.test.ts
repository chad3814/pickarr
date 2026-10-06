import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FETCH_CONCURRENCY_MAX, FETCH_CONCURRENCY_MIN, FETCH_TIMEOUT_MAX_MS, FETCH_TIMEOUT_MIN_MS } from '@pickarr/contract';
import type { ConfigHandle } from '../../src/config/instance.ts';
import { type FetchConfig, fetchConfigSchema } from '../../src/config/schemas.ts';
import { createFetchSettings } from '../../src/fetch/settings.ts';

const LOOKUP = 'openmetadata.nexus';
const LOOKUP_FALLBACK = { concurrency: 4, timeoutMs: 300_000 } as const;

/** A `ConfigHandle` over memory that records every document written and can be told to fail. */
function memoryHandle(initial: unknown, failWith?: Error): { handle: ConfigHandle<FetchConfig>; written: FetchConfig[] } {
  let current = fetchConfigSchema.parse(initial);
  const written: FetchConfig[] = [];
  const handle: ConfigHandle<FetchConfig> = {
    get current() { return current; },
    async update(next) {
      if (failWith !== undefined) throw failWith;
      written.push(next);
      current = next;
    },
  };
  return { handle, written };
}

function settingsOver(initial: unknown, failWith?: Error) {
  const { handle, written } = memoryHandle(initial, failWith);
  return { settings: createFetchSettings({ handle, lookupHostname: LOOKUP, lookupFallback: LOOKUP_FALLBACK }), written };
}

test('the bounds the schema enforces are the ones the contract publishes', () => {
  assert.doesNotThrow(() => fetchConfigSchema.parse({ default: { concurrency: FETCH_CONCURRENCY_MIN, timeoutMs: FETCH_TIMEOUT_MIN_MS } }));
  assert.doesNotThrow(() => fetchConfigSchema.parse({ default: { concurrency: FETCH_CONCURRENCY_MAX, timeoutMs: FETCH_TIMEOUT_MAX_MS } }));
  assert.throws(() => fetchConfigSchema.parse({ default: { concurrency: FETCH_CONCURRENCY_MAX + 1, timeoutMs: 30000 } }));
  assert.throws(() => fetchConfigSchema.parse({ default: { concurrency: 1, timeoutMs: FETCH_TIMEOUT_MAX_MS + 1 } }));
});

test('resolution per field: the entry, then the lookup fallback for that one hostname, then default', () => {
  const { settings } = settingsOver({
    default: { concurrency: 2, timeoutMs: 20_000 },
    hosts: { 'cdn.example': { concurrency: 5 }, [LOOKUP]: { timeoutMs: 120_000 } },
  });
  assert.equal(settings.limitFor('cdn.example'), 5);
  assert.equal(settings.timeoutFor('cdn.example'), 20_000, 'no timeout in the entry, so default');
  assert.equal(settings.limitFor(LOOKUP), 4, 'no concurrency in the entry, so the lookup fallback, not default');
  assert.equal(settings.timeoutFor(LOOKUP), 120_000, 'the entry wins over the fallback');
  assert.equal(settings.limitFor('unseen.example'), 2);
  assert.equal(settings.timeoutFor('unseen.example'), 20_000);
});

test('read merges configured and seen hostnames, sorted, with inherited and configured flags', () => {
  const { settings } = settingsOver({ hosts: { 'cdn.example': { concurrency: 5 } } });
  assert.deepEqual(settings.read(['tracker.example', 'cdn.example', LOOKUP]), {
    default: { concurrency: 1, timeoutMs: 30000 },
    hosts: [
      { hostname: 'cdn.example', concurrency: 5, timeoutMs: 30000, inherited: { concurrency: false, timeoutMs: true }, configured: true },
      { hostname: LOOKUP, concurrency: 4, timeoutMs: 300000, inherited: { concurrency: false, timeoutMs: false }, configured: false },
      { hostname: 'tracker.example', concurrency: 1, timeoutMs: 30000, inherited: { concurrency: true, timeoutMs: true }, configured: false },
    ],
  });
});

test('saveHost pins one field, leaves the other, writes the document, and the live values follow', async () => {
  const { settings, written } = settingsOver({ hosts: { 'cdn.example': { timeoutMs: 60_000 } } });

  const row = await settings.saveHost('cdn.example', { concurrency: 3 });

  assert.deepEqual(row, { hostname: 'cdn.example', concurrency: 3, timeoutMs: 60000, inherited: { concurrency: false, timeoutMs: false }, configured: true });
  assert.deepEqual(written, [{ default: { concurrency: 1, timeoutMs: 30000 }, hosts: { 'cdn.example': { concurrency: 3, timeoutMs: 60000 } } }]);
  assert.equal(settings.limitFor('cdn.example'), 3);
  assert.doesNotThrow(() => fetchConfigSchema.parse(written[0]), 'what was written round-trips through the schema');
});

test('null clears a field to inherited, and clearing both removes the key from the file', async () => {
  const { settings, written } = settingsOver({ hosts: { 'cdn.example': { concurrency: 3, timeoutMs: 60_000 } } });

  const partial = await settings.saveHost('cdn.example', { timeoutMs: null });
  assert.deepEqual(partial, { hostname: 'cdn.example', concurrency: 3, timeoutMs: 30000, inherited: { concurrency: false, timeoutMs: true }, configured: true });

  const cleared = await settings.saveHost('cdn.example', { concurrency: null });
  assert.deepEqual(cleared, { hostname: 'cdn.example', concurrency: 1, timeoutMs: 30000, inherited: { concurrency: true, timeoutMs: true }, configured: false });
  assert.deepEqual(written[1], { default: { concurrency: 1, timeoutMs: 30000 }, hosts: {} }, 'no `{}` entry left behind');
});

test('an empty patch on an unconfigured host writes nothing and answers the effective row', async () => {
  const { settings, written } = settingsOver({});
  const row = await settings.saveHost('cdn.example', {});
  assert.equal('refusal' in row, false);
  assert.deepEqual(written, [], 'nothing to write');
});

test('saveHost refusals, each by name, and none of them writes', async () => {
  const { settings, written } = settingsOver({});
  assert.deepEqual(await settings.saveHost('CDN.example', { concurrency: 2 }), { refusal: 'invalid-hostname' });
  assert.deepEqual(await settings.saveHost('default', { concurrency: 2 }), { refusal: 'invalid-hostname' });
  assert.deepEqual(await settings.saveHost('cdn.example', { concurrency: 0 }), { refusal: 'invalid-concurrency' });
  assert.deepEqual(await settings.saveHost('cdn.example', { concurrency: 65 }), { refusal: 'invalid-concurrency' });
  assert.deepEqual(await settings.saveHost('cdn.example', { concurrency: 2.5 }), { refusal: 'invalid-concurrency' });
  assert.deepEqual(await settings.saveHost('cdn.example', { timeoutMs: 999 }), { refusal: 'invalid-timeout' });
  assert.deepEqual(await settings.saveHost('cdn.example', { timeoutMs: 3_600_001 }), { refusal: 'invalid-timeout' });
  assert.deepEqual(written, []);
});

test('saveDefault requires both fields non-null and answers the pair', async () => {
  const { settings, written } = settingsOver({});
  assert.deepEqual(await settings.saveDefault({ concurrency: 2 }), { refusal: 'default-required' });
  assert.deepEqual(await settings.saveDefault({ concurrency: 2, timeoutMs: null }), { refusal: 'default-required' });
  assert.deepEqual(await settings.saveDefault({ concurrency: 0, timeoutMs: 20_000 }), { refusal: 'invalid-concurrency' });
  assert.deepEqual(await settings.saveDefault({ concurrency: 2, timeoutMs: 20_000 }), { concurrency: 2, timeoutMs: 20000 });
  assert.deepEqual(written, [{ default: { concurrency: 2, timeoutMs: 20000 }, hosts: {} }]);
  assert.equal(settings.limitFor('anything.example'), 2);
});

test('a rejected config write propagates and leaves the live values unchanged', async () => {
  const { settings } = settingsOver({ hosts: { 'cdn.example': { concurrency: 3 } } }, new Error('disk full'));
  await assert.rejects(settings.saveHost('cdn.example', { concurrency: 7 }), /disk full/);
  assert.equal(settings.limitFor('cdn.example'), 3, 'the swap happens after the write, not before');
  await assert.rejects(settings.saveDefault({ concurrency: 9, timeoutMs: 9_000 }), /disk full/);
  assert.equal(settings.limitFor('other.example'), 1);
});
