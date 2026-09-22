/**
 * `redactUrl`, which parses a url rather than matching it as text.
 *
 * **Three passes, and each catches something the others cannot** -- which
 * is why the tests below are grouped by pass rather than by input:
 *
 * 1. `password`, the userinfo credential. No shape rule reaches `hunter2`:
 *    seven characters, no case mixture, no digits.
 * 2. A query parameter whose *name* hints at a credential, whatever the
 *    value looks like. This is what catches a short value -- the six-letter
 *    `SECRET` that `redactSecrets` alone leaves alone.
 * 3. `redactSecrets` over the result, for a credential-shaped run with no
 *    name attached -- a path segment above all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl } from '../../src/clients/redact.ts';

const PASSKEY = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';

test('a url with no userinfo is returned with none invented', () => {
  // The hazard that makes the `password !== ''` guard load-bearing rather
  // than tidy. `new URL('https://tr.example/rss')` with `password` assigned
  // unconditionally serialises as `https://:*****@tr.example/rss` -- an
  // address the operator never entered, written into every feed row the
  // sync projection touches. Measured before the guard was written.
  assert.equal(redactUrl('https://tr.example/rss'), 'https://tr.example/rss');
  assert.equal(redactUrl('https://tr.example/rss?mode=list'), 'https://tr.example/rss?mode=list');
});

test('a userinfo password is masked, and no shape rule could have done it', () => {
  // `hunter2` is seven characters with no case mixture: under the length
  // bar of the first rule and under the class bar of the second. Only
  // parsing the url reaches it. A download client behind basic auth is an
  // ordinary way to run one.
  assert.equal(
    redactUrl('http://user:hunter2@qbit.local:8080/base'),
    'http://user:*****@qbit.local:8080/base',
  );
  assert.equal(redactUrl('http://user@qbit.local:8080/'), 'http://user@qbit.local:8080/',
    'a username with no password is not a credential and is left alone');
});

test('a parameter whose name hints at a credential is masked whatever its value looks like', () => {
  // The four hints are substrings, so this is four words covering
  // `apikey`, `api_key`, `passkey`, `x-auth-token`, `private_key` and the
  // rest without enumerating them.
  for (const name of ['apikey', 'api_key', 'passkey', 'token', 'x-auth-token', 'private_key']) {
    assert.equal(
      redactUrl(`https://h/x?${name}=SECRET&mode=list`),
      `https://h/x?${name}=*****&mode=list`,
      name,
    );
  }
});

test('the name rule catches a short value the shape rules cannot', () => {
  // The case that made issue #78's own pinning test stay green through the
  // fix: `SECRET` is six characters and trips neither shape rule. Parsing
  // the url and matching the *name* is what closes it.
  assert.equal(
    redactUrl('https://tracker.example/rss?passkey=SECRET'),
    'https://tracker.example/rss?passkey=*****',
  );
});

test('the hint match is case-insensitive, and a parameter that hints at nothing survives', () => {
  assert.equal(redactUrl('https://h/x?APIKEY=abc'), 'https://h/x?APIKEY=*****');
  assert.equal(redactUrl('https://h/x?ApiKey=abc'), 'https://h/x?ApiKey=*****');
  // The other side. Without this, a rule that masked every parameter would
  // pass every assertion above.
  assert.equal(redactUrl('https://h/x?mode=list&page=2'), 'https://h/x?mode=list&page=2');
});

test('a credential-shaped path segment is masked, and an ordinary slug is not', () => {
  // The third pass. There is no parameter name here to match on, which is
  // the reason issue #78 said adding names was not a fix.
  assert.equal(
    redactUrl(`https://tr.example/announce/${PASSKEY}/file.torrent`),
    'https://tr.example/announce/*****/file.torrent',
  );
  assert.equal(
    redactUrl('https://tr.example/category/tv-shows/rss'),
    'https://tr.example/category/tv-shows/rss',
    'a slug is not a secret, and a rule that masked it would be useless',
  );
});

test('a URL object is accepted as well as a string, and the caller’s object is not mutated', () => {
  // `sync/tables.ts` hands it a string from a column; nothing hands it a
  // `URL` today. The overload exists because the signature says it does,
  // and an unused branch that has never run is the kind that is wrong.
  const url = new URL('https://h/x?apikey=abc');
  assert.equal(redactUrl(url), 'https://h/x?apikey=*****');
  assert.equal(url.href, 'https://h/x?apikey=abc', 'the caller still holds its own unredacted url');
});

test('a string that is not a url falls back to text redaction rather than throwing', () => {
  // `new URL` throws on one, and callers include a sync projection reading
  // a column a human typed. Throwing there would turn a redaction miss
  // into an outage, so the unparseable case gets the text treatment.
  assert.equal(redactUrl('not a url at all'), 'not a url at all');
  assert.equal(
    redactUrl(`fetch failed for tracker/${PASSKEY}`),
    'fetch failed for tracker/*****',
    'and the shape rules still apply on that path',
  );
});
