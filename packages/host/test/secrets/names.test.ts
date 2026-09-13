import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertSecretName, envNameFor, SecretNotFound, SecretsFileUnreadable } from '../../src/secrets/names.ts';

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

test('the env var name holds only characters a variable name may contain', () => {
  // Deliberately NOT /^[A-Z_][A-Z0-9_]*$/: 58% of uuids begin with a hex
  // digit, so that assertion would fail more often than it passed. See
  // `envNameFor`'s docblock for what can and cannot set such a variable.
  const shape = /^[A-Z0-9_]+$/;
  for (const name of ['tvdb_key', 'a-b', randomUUID()]) {
    assert.ok(shape.test(envNameFor(name)), `${name} must map to a usable env var name`);
  }
});

test('a hyphen becomes an underscore, and a digit-leading name is accepted as-is', () => {
  assert.equal(envNameFor('550e8400-e29b-41d4-a716-446655440000'), '550E8400_E29B_41D4_A716_446655440000');
  assert.equal(envNameFor('tvdb_key'), 'TVDB_KEY');
  assert.equal(envNameFor('a-b-c'), 'A_B_C');
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
