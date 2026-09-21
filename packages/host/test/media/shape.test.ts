/**
 * `resolveShape`'s tests. Every decision the resolver's docblock claims is
 * pinned here, including the ones it declines to make -- a value it leaves
 * alone has a test as much as a value it rewrites, because "not padded" and
 * "not refused" are behaviours a later edit can break silently.
 *
 * Nothing here touches a filesystem, and that is not an omission: the
 * resolver imports no `node:fs`, so there is no temporary directory for
 * these to create. The copy half of this task owns the filesystem tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShape } from '../../src/media/shape.ts';
import type { ShapeRefusalCode } from '../../src/media/shape.ts';

const TV_SHAPE = '{series}/Season {season}/{series} - S{season}E{episode}.{ext}';

/**
 * The resolved path, or a failure naming the refusal instead -- so a test
 * that expected a path reports which rule refused rather than
 * `undefined !== 'Severance/...'`.
 */
function pathOf(result: ReturnType<typeof resolveShape>): string {
  if ('refusal' in result) {
    assert.fail(`expected a path, got refusal ${result.refusal}`);
  }
  return result.path;
}

/**
 * Asserts the whole refusal object, not just its code.
 *
 * `deepEqual` rather than reading `.refusal` off it: that pins the
 * one-field shape at every site, so a refusal that grew a field carrying
 * the offending value -- the thing `DownloadRead.lastError` must never be
 * handed -- reddens every one of these rather than none of them. The
 * parameter is typed `ShapeRefusalCode`, so a mistyped code is a compile
 * error rather than a test that pins a string nothing returns.
 */
function assertRefusal(result: ReturnType<typeof resolveShape>, code: ShapeRefusalCode): void {
  assert.deepEqual(result, { refusal: code });
}

test('spec 8.2: season 2 and episode 3 pad to two digits, and a token used twice resolves at both occurrences', () => {
  const result = resolveShape(TV_SHAPE, {
    series: 'Severance', season: '2', episode: '3', ext: 'mkv',
  });

  assert.equal(pathOf(result), 'Severance/Season 02/Severance - S02E03.mkv');
});

test('a three-digit number keeps all three digits: padding is a minimum width, not a field width', () => {
  const result = resolveShape(TV_SHAPE, {
    series: 'Severance', season: '2', episode: '100', ext: 'mkv',
  });

  assert.equal(pathOf(result), 'Severance/Season 02/Severance - S02E100.mkv');
});

test('a value that is not all digits is left exactly as it is, including one that merely begins with digits', () => {
  // `2x` and `-1` each contain a digit and neither is a number this resolver
  // may invent a width for; `Severance` is the ordinary case. All three come
  // back byte-for-byte.
  const result = resolveShape('{series}/{season}/{episode}.{ext}', {
    series: 'Severance', season: '2x', episode: '-1', ext: 'mkv',
  });

  assert.equal(pathOf(result), 'Severance/2x/-1.mkv');
});

test('a value that is already two or more digits is not padded further, leading zeros included', () => {
  const result = resolveShape('{a}/{b}/{c}.mkv', { a: '07', b: '007', c: '2024' });

  assert.equal(pathOf(result), '07/007/2024.mkv');
});

test('the documented hazard: a one-digit *title* is padded too, because the resolver knows no schema', () => {
  // `9` is a real film. The resolver is handed strings with no indication of
  // which token is a number, so a one-character all-digit title takes the
  // same padding a season does. Pinned rather than hidden: if a later change
  // narrows padding to declared numeric tokens, this test is the one that
  // says so out loud.
  const result = resolveShape('{title} ({year}).{ext}', {
    title: '9', year: '2009', ext: 'mkv',
  });

  assert.equal(pathOf(result), '09 (2009).mkv');
});

test('spec 8.8: a null token leaves no empty segment, no literal brace, no doubled separator and no trailing separator', () => {
  const result = resolveShape('{collection}/{title} ({year}).{ext}', {
    collection: null, title: 'Arrival', year: '2016', ext: 'mkv',
  });

  const resolved = pathOf(result);
  assert.equal(resolved, 'Arrival (2016).mkv');
  assert.ok(!resolved.includes('//'), 'no doubled separator');
  assert.ok(!resolved.includes('{') && !resolved.includes('}'), 'no stray brace');
  assert.ok(!resolved.startsWith('/') && !resolved.endsWith('/'), 'no leading or trailing separator');
});

test('a null token in the middle of a shape drops only its own segment, leaving the ones around it', () => {
  const result = resolveShape('{a}/{b}/{c}.mkv', { a: 'Top', b: null, c: 'Leaf' });

  assert.equal(pathOf(result), 'Top/Leaf.mkv');
});

test('an empty-string value is treated exactly as null is, segment dropped and all', () => {
  const withNull = resolveShape('{collection}/{title}.{ext}', {
    collection: null, title: 'Arrival', ext: 'mkv',
  });
  const withEmpty = resolveShape('{collection}/{title}.{ext}', {
    collection: '', title: 'Arrival', ext: 'mkv',
  });

  assert.equal(pathOf(withEmpty), pathOf(withNull));
  assert.equal(pathOf(withEmpty), 'Arrival.mkv');
});

test('a null token inside a surviving filename removes only itself, leaving the literal text around it', () => {
  // `.{ext}` with a null `ext` keeps the dot the shape typed. The resolver
  // cannot know that dot was there only for the extension, and inventing
  // that it was would be a rewrite of a shape nobody asked it to edit.
  const result = resolveShape('{title}.{ext}', { title: 'Arrival', ext: null });

  assert.equal(pathOf(result), 'Arrival.');
});

test('a NON-final `.` segment is dropped, which is the position the drop rule is actually about', () => {
  // The two `.` tests below exercise the *final* segment, where the answer
  // is to refuse. A mutant narrowing the drop to `isLast` therefore left
  // them green while `./{title}` resolved to `./Live.mkv`. Both routes to a
  // non-final `.` are pinned here: one an operator typed, one assembled out
  // of null tokens.
  assert.equal(pathOf(resolveShape('./{title}.{ext}', { title: 'Live', ext: 'mkv' })), 'Live.mkv');
  assert.equal(
    pathOf(resolveShape('{a}.{b}/{title}.{ext}', { a: null, b: null, title: 'Live', ext: 'mkv' })),
    'Live.mkv',
  );
  assert.equal(
    pathOf(resolveShape('Movies/./{title}.{ext}', { title: 'Live', ext: 'mkv' })),
    'Movies/Live.mkv',
  );
});

test('a doubled separator typed into a shape is swallowed by the same drop, not refused', () => {
  const result = resolveShape('a//b/{title}.{ext}', { title: 'Live', ext: 'mkv' });

  assert.equal(pathOf(result), 'a/b/Live.mkv');
});

test('a trailing separator on a shape is an empty final segment, and is refused', () => {
  assertRefusal(resolveShape('{title}/', { title: 'Live' }), 'empty-filename');
});

test('a final segment that resolves to nothing at all is refused rather than importing into a directory name', () => {
  const result = resolveShape('{title}/{filename}', { title: 'Arrival', filename: null });

  assertRefusal(result, 'empty-filename');
});

test('a final segment of `.` -- every token in it null -- is refused, not written as a directory reference', () => {
  const result = resolveShape('Movies/{title}.{ext}', { title: null, ext: null });

  assertRefusal(result, 'empty-filename');
});

test('an empty shape is refused as an empty filename', () => {
  assertRefusal(resolveShape('', {}), 'empty-filename');
});

test("a resolved value containing `/` is refused: `AC/DC` may not become a directory level", () => {
  const result = resolveShape('{series}/{title}.{ext}', {
    series: 'AC/DC', title: 'Live', ext: 'mkv',
  });

  assertRefusal(result, 'separator-in-value');
});

test('a resolved value containing a backslash is refused on every platform, not only where it separates', () => {
  const result = resolveShape('{series}/{title}.{ext}', {
    series: 'AC\\DC', title: 'Live', ext: 'mkv',
  });

  assertRefusal(result, 'separator-in-value');
});

test('`..` inside a value is *not* refused: it traverses nothing unless it is the whole segment', () => {
  // Spec 6 is the section that refuses a `..` *segment*; 7 says only
  // "escapes the root". `Rocky..Balboa` is a legal name and refusing it
  // would refuse a title that reaches nowhere.
  const result = resolveShape('{title}.{ext}', { title: 'Rocky..Balboa', ext: 'mkv' });

  assert.equal(pathOf(result), 'Rocky..Balboa.mkv');
});

test('a value of `.. ` -- two dots and a trailing space -- is refused, because Win32 would trim it to `..`', () => {
  assertRefusal(
    resolveShape('{series}/{title}.{ext}', { series: '.. ', title: 'Live', ext: 'mkv' }),
    'escapes-root',
  );
});

test('`...` is *not* refused, which is the stated edge of the trailing-whitespace rule', () => {
  // Win32 trims a trailing period as well as a trailing space, so `...`
  // may behave differently there. That is not measurable on this host and
  // stripping dots would rewrite the `Arrival.` pinned above, so the rule
  // stops at whitespace and this test is where that boundary is written.
  const result = resolveShape('{series}/{title}.{ext}', {
    series: '...', title: 'Live', ext: 'mkv',
  });

  assert.equal(pathOf(result), '.../Live.mkv');
});

test('a value that is exactly `..` is refused, because it makes the whole segment a traversal', () => {
  const result = resolveShape('{series}/{title}.{ext}', {
    series: '..', title: 'Live', ext: 'mkv',
  });

  assertRefusal(result, 'escapes-root');
});

test('two values that concatenate into a `..` segment are refused just the same', () => {
  // Neither value is `..` on its own, so this is caught by the segment check
  // rather than by any per-value rule.
  const result = resolveShape('{a}{b}/{title}.{ext}', {
    a: '.', b: '.', title: 'Live', ext: 'mkv',
  });

  assertRefusal(result, 'escapes-root');
});

test("spec 6: a shape with a literal `..` segment is refused, and is not collapsed the way `node:path` would collapse it", () => {
  // Measured on this tree: `path.join('a','..','b')` is `'b'`. Normalising
  // first would delete the condition this refusal exists to catch.
  const result = resolveShape('a/../b/{title}.{ext}', { title: 'Live', ext: 'mkv' });

  assertRefusal(result, 'escapes-root');
});

test('spec 6: an absolute shape is refused rather than quietly made relative to the root', () => {
  const result = resolveShape('/{title}.{ext}', { title: 'Live', ext: 'mkv' });

  assertRefusal(result, 'escapes-root');
});

test('a leading `..` is refused even though it is the first thing in the shape', () => {
  assertRefusal(resolveShape('../{title}.{ext}', { title: 'Live', ext: 'mkv' }), 'escapes-root');
});

test('a backslash in the shape itself is refused, so one shape cannot mean two things on two hosts', () => {
  const result = resolveShape('Season {season}\\{title}.{ext}', {
    season: '2', title: 'Live', ext: 'mkv',
  });

  assertRefusal(result, 'backslash-in-shape');
});

test('a token with no entry in the values map is refused rather than written out as a literal brace', () => {
  const result = resolveShape('{series}/{nosuchtoken}.{ext}', { series: 'Severance', ext: 'mkv' });

  assertRefusal(result, 'unknown-token');
});

test('a present key whose value is null is an entirely different answer from an absent key', () => {
  const absent = resolveShape('{collection}/{title}.{ext}', { title: 'Arrival', ext: 'mkv' });
  const present = resolveShape('{collection}/{title}.{ext}', {
    collection: null, title: 'Arrival', ext: 'mkv',
  });

  assertRefusal(absent, 'unknown-token');
  assert.equal(pathOf(present), 'Arrival.mkv');
});

test('a token named after an `Object.prototype` member is unknown, not inherited from the prototype', () => {
  // `'toString' in {}` is true on any object literal a caller passes, so a
  // lookup written with `in` would "resolve" this token against
  // `Object.prototype`. `Object.hasOwn` is what stops it.
  assertRefusal(resolveShape('{toString}.mkv', { title: 'Live' }), 'unknown-token');
  assertRefusal(resolveShape('{constructor}.mkv', { title: 'Live' }), 'unknown-token');
});

test('an unclosed brace, a lone closing brace and an empty token are each a malformed shape', () => {
  const values = { title: 'Live', ext: 'mkv' };

  assertRefusal(resolveShape('{title.{ext}', values), 'malformed-shape');
  assertRefusal(resolveShape('{title}}.{ext}', values), 'malformed-shape');
  assertRefusal(resolveShape('{}.{ext}', values), 'malformed-shape');
  assertRefusal(resolveShape('{title}.{ext', values), 'malformed-shape');
});

test('a shape with no tokens at all is a constant path, returned unchanged', () => {
  const result = resolveShape('Movies/Unsorted/placeholder.mkv', {});

  assert.equal(pathOf(result), 'Movies/Unsorted/placeholder.mkv');
});

test('values a shape never mentions are ignored rather than refused', () => {
  const result = resolveShape('{title}.{ext}', {
    title: 'Live', ext: 'mkv', resolution: '1080p', filename: 'whatever.mkv',
  });

  assert.equal(pathOf(result), 'Live.mkv');
});

test('the separator in the result is `/` and only `/`, on whichever platform this runs', () => {
  const resolved = pathOf(resolveShape(TV_SHAPE, {
    series: 'Severance', season: '2', episode: '3', ext: 'mkv',
  }));

  assert.ok(!resolved.includes('\\'), 'no backslash in the result');
  assert.deepEqual(resolved.split('/'), ['Severance', 'Season 02', 'Severance - S02E03.mkv']);
});
