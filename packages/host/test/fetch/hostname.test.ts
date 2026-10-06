import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHostname } from '../../src/fetch/hostname.ts';

test('accepts bare lowercase hostnames', () => {
  for (const value of ['a.b', 'localhost', 'xn--n3h.example', 'cdn.theporndb.net', '127.0.0.1', 'a-b.c0']) {
    assert.equal(isHostname(value), true, value);
  }
});

test('refuses anything the queue would never key a request on', () => {
  // The queue keys on `new URL(url).hostname`, which is lowercase and
  // carries no port, path, userinfo or whitespace; an entry spelled any
  // of these ways would match no request and silently do nothing.
  for (const value of ['A.b', 'a.b:80', 'a.b/x', 'u@a.b', 'a b', '', 'http://a.b', 'a.b?x=1', 'a.b#f', '[::1]']) {
    assert.equal(isHostname(value), false, JSON.stringify(value));
  }
});
