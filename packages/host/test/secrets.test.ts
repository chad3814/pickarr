import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPENMETADATA_API_KEY_VARIABLE, createEnvSecretResolver } from '../src/secrets.ts';

test('resolves a known key from the environment it was given', async () => {
  const resolve = createEnvSecretResolver({ [OPENMETADATA_API_KEY_VARIABLE]: 'from-the-env' });
  // `assert.ok` with a message, which is the house remedy rule 3 of
  // `scripts/check-test-hygiene.ts` documents: it formats nothing, so no
  // operand can reach a failure message. Asserting the length alone was
  // safe in exactly the same way and passed for any twelve characters --
  // including the empty resolver answering something else entirely.
  //
  // The value here is a test literal rather than a real credential, so the
  // comparison is honest about what it wants: this variable's value, not
  // some value of the right size.
  const secret = await resolve('openmetadata-api-key');
  assert.ok(secret === 'from-the-env', 'the resolver answers the value that variable holds');
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
