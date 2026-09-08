import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCursor,
  decodeUnionCursor,
  encodeCursor,
  encodeUnionCursor,
} from '../../src/api/cursor.ts';

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

test('a union cursor round-trips, carrying the transport that separates two rowid spaces', () => {
  const cursor = { updatedAt: 1700000000000, transport: 'torrent', id: 42 } as const;

  const encoded = encodeUnionCursor(cursor);

  // Pinned as a literal for the same reason as `encodeCursor`'s: the format
  // itself -- base64url of `<updatedAt>.<transport>.<id>` -- is what is
  // checked, not merely that decode undoes encode.
  assert.equal(encoded, 'MTcwMDAwMDAwMDAwMC50b3JyZW50LjQy');
  assert.deepEqual(decodeUnionCursor(encoded), cursor);
  assert.deepEqual(
    decodeUnionCursor(encodeUnionCursor({ updatedAt: 0, transport: 'nzb', id: 1 })),
    { updatedAt: 0, transport: 'nzb', id: 1 },
  );
});

test('a union cursor with an unknown transport means the beginning, not a throw', () => {
  // The transport is the whole reason this cursor type exists, so a middle
  // part outside the two-word vocabulary is malformed rather than coerced.
  assert.equal(decodeUnionCursor(Buffer.from('100.usenet.1').toString('base64url')), null);
  assert.equal(decodeUnionCursor(Buffer.from('100..1').toString('base64url')), null);
  assert.equal(decodeUnionCursor(Buffer.from('100.TORRENT.1').toString('base64url')), null);

  // And everything `decodeCursor` refuses is refused here too.
  assert.equal(decodeUnionCursor(undefined), null);
  assert.equal(decodeUnionCursor(''), null);
  assert.equal(decodeUnionCursor('not base64 at all!!!'), null);
  assert.equal(decodeUnionCursor(Buffer.from('100.nzb.-5').toString('base64url')), null);
  assert.equal(decodeUnionCursor(Buffer.from('100.nzb.1.9').toString('base64url')), null);
});

test('the two cursor forms are not interchangeable, so a route cannot resume the other\'s page', () => {
  // A downloads cursor decoded as a single-table cursor, or the reverse,
  // would page from a key that means something else. Both are refused, which
  // sends the caller to the beginning rather than to a wrong offset.
  const single = encodeCursor({ updatedAt: 100, id: 7 });
  const union = encodeUnionCursor({ updatedAt: 100, transport: 'nzb', id: 7 });

  assert.equal(decodeUnionCursor(single), null, 'a two-part cursor has no transport to read');
  assert.equal(decodeCursor(union), null, 'a three-part cursor is not a (updatedAt, id) pair');
});
