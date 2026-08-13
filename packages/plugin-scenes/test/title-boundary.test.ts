import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTitleBoundary, suffixOffset, tokensOf, detachReleaseGroup, isEncodeToken, isTitleSuffixToken } from '../src/parse.ts';

test('the two indices diverge, and the quality haystack starts at the later one', () => {
  const name = 'Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB';
  const detached = detachReleaseGroup(tokensOf(name), name);
  const boundary = findTitleBoundary(detached.tokens, 1);
  assert.ok(boundary !== null);

  const title = name.slice(0, suffixOffset(detached.tokens, boundary.titleEnd, name));
  const tail = name.slice(suffixOffset(detached.tokens, boundary.encodeStart, name));

  // The indices create a gap between title and encode: tokens[0:titleEnd] form the
  // title, tokens[titleEnd:encodeStart] form the gap (not in either haystack),
  // and tokens[encodeStart:] form the encode section passed to extractQuality.
  // The gap is what must never reach extractQuality: issue #12 records that one
  // unknown encode word refuses a whole name, and `Solo` and `42466` are two.
  assert.equal(title, 'Suki.Sin.');
  assert.equal(tail, 'XXX.1080p.MP4-WRB');
  assert.ok(!tail.includes('Solo'));
  assert.ok(!tail.includes('42466'));
});

test('titleEnd never exceeds encodeStart', () => {
  for (const name of [
    'Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB',
    'Remido.Solo.XXX.1080p.MP4-WRB',
    'Maria.Gail.GERMAN.XXX.1080p',
    'Alex.Coal.Plain.Title.XXX.1080p.MP4-WRB',
  ]) {
    const detached = detachReleaseGroup(tokensOf(name), name);
    const boundary = findTitleBoundary(detached.tokens, 1);
    assert.ok(boundary !== null, name);
    assert.ok(boundary.titleEnd <= boundary.encodeStart, name);
  }
});

test('no recognisable encode section is still null, as before', () => {
  assert.equal(findTitleBoundary(tokensOf('Maria.Gail.GERMAN'), 1), null);
});

test('suffixOffset reads past the last token as the end of the text', () => {
  const name = 'Alex.Coal';
  const tokens = tokensOf(name);
  assert.equal(suffixOffset(tokens, tokens.length, name), name.length);
});

test('undetached tokens with trailing group tag returns null', () => {
  // This is pre-existing findEncodeSuffixStart behavior: it looks for a trailing
  // run of encode tokens, but a group tag blocks the backwards walk. Callers
  // detach first. This test records that findTitleBoundary respects this contract.
  const name = 'Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB';
  const boundary = findTitleBoundary(tokensOf(name), 1);
  assert.equal(boundary, null);
});

test('isTitleSuffixToken accepts every encode token, except a bare digit', () => {
  // The two boundary searches must agree about encode tokens, or the gap
  // between titleEnd and encodeStart fills with tokens that reach
  // extractQuality. Asserted as a property over the vocabulary rather than
  // inferred from two indices happening to match on one fixture: a partial
  // divergence leaves both indices non-null and merely different, which an
  // index comparison on a single name does not catch.
  for (const t of ['1080p', '2160p', '4K', 'UHD', 'WEB-DL', 'SiteRip', 'BluRay',
                   'x265', 'HEVC', 'AAC', 'MP4', 'MKV', 'REPACK', 'HDR']) {
    assert.equal(isEncodeToken(t), true, `${t} should be an encode token`);
    assert.equal(isTitleSuffixToken(t, 'word'), true, `${t} must be crossable`);
  }
  // The one deliberate divergence, and the reason it is safe: a lone digit is
  // an encode token but not a suffix token, so a sequel number survives.
  assert.equal(isEncodeToken('4'), true);
  assert.equal(isTitleSuffixToken('4', 'sarasota'), false);
});

test('both boundaries land at the same place when suffix is entirely encode tokens', () => {
  // When the whole suffix consists of encode tokens, titleEnd and encodeStart
  // both point to the first one. This test uses two indices on one fixture,
  // so it does not prove the functions agree—see the property test for that.
  // What this test asserts is the weaker but still useful property that
  // boundaries can coincide without error.
  const name = 'Alex.Coal.1080p.MP4-WRB';
  const detached = detachReleaseGroup(tokensOf(name), name);
  const boundary = findTitleBoundary(detached.tokens, 1);
  assert.ok(boundary !== null);
  assert.equal(boundary.titleEnd, boundary.encodeStart);
});
