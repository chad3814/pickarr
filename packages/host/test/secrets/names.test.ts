import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertSecretName, envNameFor, SECRET_ENV_PREFIX, SecretNotFound, SecretsFileUnreadable } from '../../src/secrets/names.ts';

test('a generated uuid is a legal secret name', () => {
  for (let i = 0; i < 20; i += 1) {
    assert.doesNotThrow(() => { assertSecretName(randomUUID()); });
  }
});

test('a name a human would choose is legal', () => {
  for (const name of ['tvdb_key', 'a', 'sab1', 'a-b_c9']) {
    assert.doesNotThrow(() => { assertSecretName(name); }, `${name} must be legal`);
  }
});

test('anything that could escape the secrets directory is refused', () => {
  for (const name of ['..', 'a/b', 'a.b', '../../etc/passwd', '/abs', 'a\\b', '', 'A', '_leading', '-leading', 'a b']) {
    assert.throws(() => { assertSecretName(name); }, /secret name/, `${name} must be refused`);
  }
});

test('a name at the length limit is legal and one past it is not', () => {
  assert.doesNotThrow(() => { assertSecretName('a'.repeat(64)); });
  assert.throws(() => { assertSecretName('a'.repeat(65)); }, /secret name/);
});

test('the env var name is one a shell could assign, uuid names included', () => {
  // The strict shape, /^[A-Z_][A-Z0-9_]*$/, which the unprefixed form could
  // not meet: 114 of a 200-uuid sample begin with a decimal digit (10/16 =
  // 62.5% by construction, and 200 of 200 begin with a *hex* digit, which is
  // no property at all -- a uuid is hex). The prefix supplies the leading
  // letter, so the assertion this test used to weaken now holds for every
  // name. See `envNameFor`'s docblock for what can set such a variable.
  const shape = /^[A-Z_][A-Z0-9_]*$/;
  for (const name of ['tvdb_key', 'a-b', randomUUID()]) {
    assert.ok(shape.test(envNameFor(name)), `${name} must map to a usable env var name`);
  }
});

test('every env var name is namespaced, so a secret cannot read an ambient variable', () => {
  // The failure this prefix exists for: unprefixed, `envNameFor('path')` was
  // `PATH`, `fromEnv` wins the chain, and a secret named `path` therefore
  // resolved to the container's own PATH rather than to the stored
  // credential. `home`, `user`, `shell`, `lang`, `term` and the rest are the
  // same shape, and `assertSecretName` accepts all of them.
  for (const name of ['path', 'home', 'user', 'shell', 'lang', 'term', 'pwd', 'hostname', 'tz', 'node_env']) {
    const variable = envNameFor(name);
    assert.ok(variable.startsWith(SECRET_ENV_PREFIX), `${name} must be namespaced`);
    assert.notEqual(variable, name.toUpperCase(), `${name} must not name the ambient variable`);
  }
});

test('a hyphen becomes an underscore, and a digit-leading name keeps its digits', () => {
  assert.equal(envNameFor('550e8400-e29b-41d4-a716-446655440000'), 'PICKARR_SECRET_550E8400_E29B_41D4_A716_446655440000');
  assert.equal(envNameFor('tvdb_key'), 'PICKARR_SECRET_TVDB_KEY');
  assert.equal(envNameFor('a-b-c'), 'PICKARR_SECRET_A_B_C');

  // Not solved by the prefix, and said out loud rather than implied: the two
  // name forms still share one variable, so one export overrides whichever
  // of the two rows is asked for.
  assert.equal(envNameFor('a-b'), envNameFor('a_b'));
});

test('SecretNotFound carries the name without a path, and does not shadow Error.name', () => {
  const error = new SecretNotFound('tvdb_key');
  assert.equal(error.secretName, 'tvdb_key');
  assert.equal(error.name, 'SecretNotFound');
  assert.ok(error.message.includes('tvdb_key'));
  assert.ok(!error.message.includes('/'), 'the message must carry no path');
});

test('SecretsFileUnreadable carries the name without a path, and is not a SecretNotFound', () => {
  const error = new SecretsFileUnreadable('tvdb_key');
  assert.equal(error.secretName, 'tvdb_key');
  assert.equal(error.name, 'SecretsFileUnreadable');
  assert.ok(error.message.includes('tvdb_key'));
  assert.ok(!error.message.includes('/'), 'the message must carry no path');
  // Two separate classes rather than a flag, because the whole point is that
  // a caller (and an operator reading a log) can tell "this credential was
  // never configured" from "the secrets directory could not be read".
  assert.ok(!(error instanceof SecretNotFound));
  assert.ok(!(new SecretNotFound('tvdb_key') instanceof SecretsFileUnreadable));
});
