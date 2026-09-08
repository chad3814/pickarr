import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCursor, encodeCursor } from '../../src/api/cursor.ts';

test('a cursor round-trips', () => {
  const cursor = { updatedAt: 1700000000000, id: 42 };

  const encoded = encodeCursor(cursor);

  // Pinned as a literal so the format itself -- base64url of
  // `<updatedAt>.<id>` -- is checked, not just that decode undoes encode.
  // A round-trip alone can't tell base64url from rot13.
  assert.equal(encoded, 'MTcwMDAwMDAwMDAwMC40Mg');
  assert.deepEqual(decodeCursor(encoded), cursor);
});

test('an absent cursor means the beginning, not an error', () => {
  assert.equal(decodeCursor(undefined), null);
});

test('a malformed cursor means the beginning, not a throw', () => {
  // Not base64url at all: decodes leniently to bytes with no `.` in them.
  assert.equal(decodeCursor('not base64 at all!!!'), null);

  // Valid base64url, but of junk with no `.` separator.
  assert.equal(decodeCursor(Buffer.from('justsomejunk').toString('base64url')), null);

  // A well-formed pair whose id half is not numeric.
  assert.equal(decodeCursor(Buffer.from('1700000000000.abc').toString('base64url')), null);

  // The empty string: decodes to an empty string, which has no `.`.
  assert.equal(decodeCursor(''), null);
});

test('a cursor with a negative or fractional id is refused as malformed', () => {
  // Ids are rowids. Anything else was not produced by encodeCursor.
  assert.equal(decodeCursor(Buffer.from('1700000000000.-5').toString('base64url')), null);
  assert.equal(decodeCursor(Buffer.from('1700000000000.5.5').toString('base64url')), null);
});
