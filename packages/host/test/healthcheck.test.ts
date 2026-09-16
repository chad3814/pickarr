import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigDocument } from '../src/config/file.ts';
import { DEFAULT_PORT } from '../src/api/server.ts';
import { main, resolveHealthPort } from '../src/healthcheck.ts';

/**
 * A port that is deliberately not the schema default. The bug this file
 * exists for is a healthcheck that probes the default port no matter what
 * boot was actually told, so a fixture using the default would pass against
 * a broken resolver just as readily as a correct one.
 */
const CONFIGURED_PORT = 9321;
const ENV_PORT = 9654;

/** No `server` namespace at all -- the state a first-boot config file is in. */
const EMPTY_DOC: ConfigDocument = {};
const DOC_WITH_PORT: ConfigDocument = { server: { port: CONFIGURED_PORT } };

test('the port comes from PICKARR_READ_API_PORT first', () => {
  const env = { PICKARR_READ_API_PORT: String(ENV_PORT) };
  assert.equal(resolveHealthPort(env, DOC_WITH_PORT), ENV_PORT, 'the variable must win over the file');
});

test('then from the config file', () => {
  assert.equal(resolveHealthPort({}, DOC_WITH_PORT), CONFIGURED_PORT, 'no variable, so the file wins');
});

test('then from the default', () => {
  assert.equal(resolveHealthPort({}, EMPTY_DOC), DEFAULT_PORT, 'no variable and no file section, so the schema default applies');
});

test('an empty PICKARR_READ_API_PORT is not a value', () => {
  // `main.ts`'s `configuredEnvValue` treats empty as unset for every
  // variable it resolves, `PICKARR_READ_API_PORT` included -- see
  // `main.test.ts`'s "an empty PICKARR_READ_API_HOST, PICKARR_READ_API_PORT
  // or PICKARR_DATABASE is unset" and `configuredEnvValue`'s own docblock,
  // which says plainly that checking only `=== undefined` "would also make
  // an empty PICKARR_READ_API_PORT throw ... instead of falling back". This
  // resolver reuses that same function rather than inventing a second rule,
  // so an empty variable here falls back to the file exactly as it does at
  // boot -- it does not throw.
  const env = { PICKARR_READ_API_PORT: '' };
  assert.equal(resolveHealthPort(env, DOC_WITH_PORT), CONFIGURED_PORT, 'empty is unset, so the file wins');
});

test('a non-numeric PICKARR_READ_API_PORT is refused, not coerced', () => {
  // The one case that genuinely does throw: `resolveReadPort` is stricter
  // than a fallback, deliberately (main.ts's own docblock), and this
  // resolver calls that function rather than a second copy of its rule.
  const env = { PICKARR_READ_API_PORT: 'nope' };
  assert.throws(() => resolveHealthPort(env, DOC_WITH_PORT), /PICKARR_READ_API_PORT/);
});

/** Saves and restores `process.exitCode` around a `main()` call, so one test's exit code cannot leak into the next. */
async function withExitCode(fn: () => Promise<void>): Promise<void> {
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn();
  } finally {
    process.exitCode = previous;
  }
}

test('a 200 is healthy', async () => {
  await withExitCode(async () => {
    const asked: string[] = [];
    await main({
      env: { PICKARR_READ_API_PORT: String(ENV_PORT) },
      fetchImpl: async (url) => {
        asked.push(String(url));
        return new Response('{}', { status: 200 });
      },
    });
    assert.equal(process.exitCode, 0);
    assert.deepEqual(asked, [`http://127.0.0.1:${ENV_PORT}/api/health`]);
  });
});

test('a non-200 is unhealthy', async () => {
  await withExitCode(async () => {
    await main({
      env: { PICKARR_READ_API_PORT: String(ENV_PORT) },
      fetchImpl: async () => new Response('nope', { status: 503 }),
    });
    assert.equal(process.exitCode, 1);
  });
});

test('a refused connection is unhealthy, not a thrown error', () => {
  return withExitCode(async () => {
    await main({
      env: { PICKARR_READ_API_PORT: String(ENV_PORT) },
      fetchImpl: async () => {
        throw new Error('fetch failed');
      },
    });
    assert.equal(process.exitCode, 1);
  });
});
