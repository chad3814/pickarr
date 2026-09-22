import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactText, redactHeaders, redactFormBody } from '../../src/clients/redact.ts';

test('a credential query parameter keeps its name and loses its value', () => {
  assert.equal(
    redactText('https://h/api?apikey=not-a-real-key&mode=addurl'),
    'https://h/api?apikey=***&mode=addurl',
  );
});

test('a url with no credential parameter is returned unchanged', () => {
  assert.equal(redactText('https://h/api?mode=addurl'), 'https://h/api?mode=addurl');
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

test('a password field is redacted at the start of a body, not only after an &', () => {
  // Closes the `(?:^|&)` branch: every other form-body test has `password`
  // preceded by `&`, so dropping the `^` alternative would break nothing and
  // a lone `password=` body would log its value in full.
  assert.equal(redactFormBody('password=s3cret-placeholder'), 'password=***');
});

test('a header value with no scheme loses the whole value', () => {
  // Closes the `schemeEnd === -1` branch. With no space there is no scheme to
  // keep, so there is nothing safe to leave behind -- and this is the branch
  // whose failure mode is worst: returning the value unchanged would log an
  // entire credential, and no other test would notice.
  const redacted = redactHeaders({ Authorization: 'not-a-real-token' });
  assert.equal(redacted['Authorization'], '***');
});

test('redaction is case-insensitive in the parameter name', () => {
  // `ApiKey` and `APIKEY` are the same parameter to a server and must be to us.
  assert.equal(redactText('https://h/api?APIKEY=not-a-real-key'), 'https://h/api?APIKEY=***');
  assert.equal(redactText('https://h/api?ApiKey=not-a-real-key'), 'https://h/api?ApiKey=***');
});
