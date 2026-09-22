import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOriginOnly } from '../src/origin.ts';

test('an origin is accepted, with or without a trailing slash', () => {
  for (const value of ['http://host', 'https://host', 'http://host:7676', 'https://host/', 'http://127.0.0.1:7676']) {
    assert.doesNotThrow(() => { assertOriginOnly(value, 'LABEL'); }, `${value} must be accepted`);
  }
});

test('everything that unmounts the auth routes is refused, and the label is in the message', () => {
  const cases: [string, RegExp][] = [
    ['http://host/pickarr', /no path/],
    ['http://host/a/b', /no path/],
    ['http://host?x=1', /query string/],
    ['http://host#f', /fragment/],
    ['ws://host', /http or https/],
    ['not a url', /not a url/],
  ];
  for (const [value, expected] of cases) {
    assert.throws(() => { assertOriginOnly(value, 'LABEL'); }, expected, `${value} must be refused`);
    assert.throws(() => { assertOriginOnly(value, 'LABEL'); }, /LABEL/, `${value}'s message must name the label`);
  }
});
