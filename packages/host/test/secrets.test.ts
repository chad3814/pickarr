import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENMETADATA_API_KEY_VARIABLE, createEnvSecretResolver } from '../src/secrets.ts';

test('resolves a known key from the environment it was given', async () => {
  const resolve = createEnvSecretResolver({ [OPENMETADATA_API_KEY_VARIABLE]: 'from-the-env' });
  // The resolved value is a credential and is never an assertion operand:
  // what is asserted is that resolving succeeded and said something.
  const secret = await resolve('openmetadata-api-key');
  assert.equal(secret.length, 'from-the-env'.length);
});

test('names the variable to set when it is unset', async () => {
  const resolve = createEnvSecretResolver({});
  await assert.rejects(() => resolve('openmetadata-api-key'), new RegExp(OPENMETADATA_API_KEY_VARIABLE));
});

test('an empty variable is an unset one', async () => {
  const resolve = createEnvSecretResolver({ [OPENMETADATA_API_KEY_VARIABLE]: '' });
  await assert.rejects(() => resolve('openmetadata-api-key'), new RegExp(OPENMETADATA_API_KEY_VARIABLE));
});

test('refuses a key it has no variable for, rather than answering an empty string', async () => {
  const resolve = createEnvSecretResolver({});
  await assert.rejects(() => resolve('some-other-secret'), /some-other-secret/);
});
