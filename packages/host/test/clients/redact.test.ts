import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl, redactHeaders, redactFormBody } from '../../src/clients/redact.ts';

test('a credential query parameter keeps its name and loses its value', () => {
  assert.equal(
    redactUrl('https://h/api?apikey=not-a-real-key&mode=addurl'),
    'https://h/api?apikey=***&mode=addurl',
  );
});

test('a url with no credential parameter is returned unchanged', () => {
  assert.equal(redactUrl('https://h/api?mode=addurl'), 'https://h/api?mode=addurl');
});

test('an Authorization header loses its value but keeps its scheme', () => {
  const redacted = redactHeaders({
    Authorization: 'Bearer not-a-real-token',
    'Content-Type': 'application/json',
  });
  assert.equal(redacted['Authorization'], 'Bearer ***');
  assert.equal(redacted['Content-Type'], 'application/json');
});

test('a password form field loses its value', () => {
  assert.equal(
    redactFormBody('username=admin&password=s3cret-placeholder'),
    'username=admin&password=***',
  );
});

test('redaction is case-insensitive in the parameter name', () => {
  // `ApiKey` and `APIKEY` are the same parameter to a server and must be to us.
  assert.equal(redactUrl('https://h/api?APIKEY=not-a-real-key'), 'https://h/api?APIKEY=***');
  assert.equal(redactUrl('https://h/api?ApiKey=not-a-real-key'), 'https://h/api?ApiKey=***');
});
