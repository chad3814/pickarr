import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPathMappings } from '../../src/clients/path-mappings.ts';

const MAPPINGS = [{ from: '/downloads', to: '/mnt/dl' }];

test('an exact match is translated', () => {
  assert.equal(applyPathMappings(MAPPINGS, '/downloads'), '/mnt/dl');
});

test('a path under the mapping keeps its remainder', () => {
  assert.equal(applyPathMappings(MAPPINGS, '/downloads/a/b.mkv'), '/mnt/dl/a/b.mkv');
});

test('a prefix that is not a path segment is not a match', () => {
  // `/downloads2` starts with `/downloads` as a string but is a different
  // directory. This is the property the `/` check exists for.
  assert.equal(applyPathMappings(MAPPINGS, '/downloads2/a.mkv'), '/downloads2/a.mkv');
});

test('an unmapped path is returned unchanged', () => {
  assert.equal(applyPathMappings(MAPPINGS, '/elsewhere/a.mkv'), '/elsewhere/a.mkv');
});

test('the longest matching mapping wins, whatever order they are given in', () => {
  const mappings = [
    { from: '/downloads', to: '/short' },
    { from: '/downloads/complete', to: '/long' },
  ];
  assert.equal(applyPathMappings(mappings, '/downloads/complete/a.mkv'), '/long/a.mkv');
  // And reversed, to prove the answer is not an artefact of input order.
  assert.equal(applyPathMappings([...mappings].reverse(), '/downloads/complete/a.mkv'), '/long/a.mkv');
});

test('mappings of equal length keep the order they were configured in', () => {
  const two = [{ from: '/d', to: '/first' }, { from: '/d', to: '/second' }];
  assert.equal(applyPathMappings(two, '/d/x'), '/first/x');
});

test('the caller\'s array is not reordered', () => {
  const mappings = [
    { from: '/a', to: '/x' },
    { from: '/a/deeper', to: '/y' },
  ];
  applyPathMappings(mappings, '/a/deeper/f');
  assert.equal(mappings[0]?.from, '/a', 'sorted a copy, not the input');
});
