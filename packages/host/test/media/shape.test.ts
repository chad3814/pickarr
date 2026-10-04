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
import { canonicalRoot, resolveShape, rootRefusal, validateShape } from '../../src/media/shape.ts';
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
 *
 * **`validateShape` is the deliberate exception and is not asserted
 * through this.** It is the same parse with the unknown token's name
 * kept, for the save-time validator whose caller is the operator who
 * typed the shape; the last test in this file is where the two are
 * compared side by side, and `resolveShape` -- everything this helper is
 * used on -- is the wrapper that strips.
 */
function assertRefusal(result: ReturnType<typeof resolveShape>, code: ShapeRefusalCode): void {
  assert.deepEqual(result, { refusal: code });
}

test('spec 8.2: an already-padded season and episode land as they are, and a token used twice resolves at both occurrences', () => {
  // The two digits are §8.2's, and they arrive already made: the plugin's
  // `season` resolver pads, because it is the only thing in the chain that
  // knows a season is a number. `plugin-tv/test/tokens.test.ts` is what pins
  // that it does; this pins that nothing here undoes it.
  const result = resolveShape(TV_SHAPE, {
    series: 'Severance', season: '02', episode: '03', ext: 'mkv',
  });

  assert.equal(pathOf(result), 'Severance/Season 02/Severance - S02E03.mkv');
});

test('no value is widened, whether it is one digit, three digits, or not a number at all', () => {
  // The whole of what replaced `padNumeric`. `2` stays one character -- so a
  // caller that forgot to pad gets `Season 2` rather than a silently
  // corrected path -- and so does everything else.
  const result = resolveShape('{a}/{b}/{c}/{d}/{e}.mkv', {
    a: '2', b: '100', c: '07', d: '2x', e: '-1',
  });

  assert.equal(pathOf(result), '2/100/07/2x/-1.mkv');
});

test('the hazard that removing the padding closed: a one-digit *title* is left alone', () => {
  // `9` is a real film, from 2009. While the resolver padded every all-digit
  // value it landed as `09`, permanently -- design spec §10 puts
  // re-importing out of scope. Nothing here can tell a title from a season,
  // which is why the padding moved to the plugin rather than growing a rule.
  const result = resolveShape('{title} ({year}).{ext}', {
    title: '9', year: '2009', ext: 'mkv',
  });

  assert.equal(pathOf(result), '9 (2009).mkv');
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

test('a value of `.. ` -- two dots and a trailing space -- is refused, because it reads as `..` and no one meant it', () => {
  assertRefusal(
    resolveShape('{series}/{title}.{ext}', { series: '.. ', title: 'Live', ext: 'mkv' }),
    'escapes-root',
  );
});

test('`...` is *not* refused, which is the stated edge of the trailing-whitespace rule', () => {
  // On POSIX, the only platform this host runs on (#99), `...` is an
  // ordinary directory name, and stripping dots would rewrite the
  // `Arrival.` pinned above. The rule stops at whitespace and this test is
  // where that boundary is written.
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
    series: 'Severance', season: '02', episode: '03', ext: 'mkv',
  }));

  assert.ok(!resolved.includes('\\'), 'no backslash in the result');
  assert.deepEqual(resolved.split('/'), ['Severance', 'Season 02', 'Severance - S02E03.mkv']);
});

test('the save-time validator names the unknown token, and the import-time resolver does not', () => {
  // **One parse, two entry points, and the difference is who may see the
  // name.** `resolveShape`'s refusal reaches `clients/deliver.ts`'s
  // `last_error`, which `/api/downloads` serves as
  // `DownloadRead.lastError` -- a browser looking at an unrelated
  // download -- so it carries nothing from the input, which is what
  // `assertRefusal` above pins at every other site in this file.
  // `validateShape`'s answers the very request that carried the shape, to
  // the operator who typed it, so design spec §3's "refused, naming it"
  // is reachable there.
  const values = { series: 'Severance', ext: 'mkv' };

  assert.deepEqual(
    validateShape('{series}/{seasn}.{ext}', values),
    { refusal: 'unknown-token', token: 'seasn' },
    'the validator names the token the values map has no key for',
  );
  assert.deepEqual(
    resolveShape('{series}/{seasn}.{ext}', values),
    { refusal: 'unknown-token' },
    'and the resolver answers the same rule with the name gone',
  );

  // Not only for `unknown-token`: every other refusal carries `token:
  // null` out of the validator, so a caller reads one field rather than
  // switching on the code first -- and every one of them is still a bare
  // `{ refusal }` out of the resolver.
  for (const shape of ['{series', '/x.{ext}', 'a\\b.{ext}', '{series}/']) {
    const validated = validateShape(shape, values);
    assert.ok('refusal' in validated, shape);
    assert.equal(validated.token, null, `${shape} names no token`);
    assert.deepEqual(resolveShape(shape, values), { refusal: validated.refusal }, shape);
  }

  // The two agree on every accept, because there is one parse: the
  // validator is the implementation and the resolver is a strip.
  assert.deepEqual(
    validateShape('{series}.{ext}', values),
    resolveShape('{series}.{ext}', values),
  );
});

test('canonicalRoot keeps the directory and drops only the spelling', () => {
  // Every pair names one directory. The left side is what an operator may
  // type; the right is the single spelling stored, so the settings screen
  // reads back the directory the importer writes to.
  const cases: readonly (readonly [string, string])[] = [
    ['/media/tv', '/media/tv'],
    ['/media/tv/', '/media/tv'],
    ['/media//tv', '/media/tv'],
    ['/media/./tv', '/media/tv'],
    ['/media/x/../tv', '/media/tv'],
    ['/a/../b', '/b'],
    ['/mnt/media/tv shows/', '/mnt/media/tv shows'],
  ];

  for (const [typed, stored] of cases) {
    const result = canonicalRoot(typed);
    assert.ok(!('refusal' in result), `"${typed}" names a directory`);
    assert.equal(result.root, stored, typed);
  }
});

test('canonicalRoot refuses what no import could ever write under', () => {
  // `/`, `//` and `/lib/../..` all reduce to nothing above the root. They
  // are refused rather than stored as `/`, because a library root of `/`
  // puts `<title>/` directories at the top of the system disk, and because
  // the importer's `target.startsWith(root + '/')` check is
  // `startsWith('//')` there, which no target satisfies.
  //
  // `/..` and `/a/../..` climb above `/`. Refused rather than clamped:
  // clamping is exactly how `/lib/../..` became `/` silently, and the
  // silence was the defect.
  for (const root of ['/', '//', '///', '/.', '/lib/../..', '/..', '/a/../..']) {
    const result = canonicalRoot(root);
    assert.ok('refusal' in result, `"${root}" was accepted`);
    assert.equal(result.refusal, 'unusable', root);
  }

  for (const root of ['', 'media/tv', './media', '../media']) {
    const result = canonicalRoot(root);
    assert.ok('refusal' in result, `"${root}" was accepted`);
    assert.equal(result.refusal, 'not-absolute', root);
  }
});

test('every root canonicalRoot stores is one rootRefusal accepts, so the save and the import cannot disagree', () => {
  // The invariant the two-sided rule rests on, driven rather than argued.
  // `media/destinations.ts` canonicalises on save; `media/import.ts` calls
  // `rootRefusal` on the stored value. If a value could pass the first and
  // fail the second, a destination would save and then refuse at every
  // import -- which is the bug both functions exist to prevent, and the
  // one a trailing slash used to cause.
  const typed = [
    '/media/tv', '/media/tv/', '/media//tv', '/media/./tv', '/media/x/../tv',
    '/a/../b', '/mnt/media/tv shows/', '/mnt/AC\\DC', '/one', '/a/b/c/d/e/',
    '/', '//', '/lib/../..', '/..', 'media/tv', '',
  ];

  let stored = 0;
  for (const root of typed) {
    const result = canonicalRoot(root);
    if ('refusal' in result) continue;
    stored += 1;
    assert.equal(rootRefusal(result.root), undefined, `"${root}" stored as "${result.root}", which the import refuses`);
    assert.deepEqual(canonicalRoot(result.root), { root: result.root }, `"${result.root}" is not a fixed point`);
  }
  assert.equal(stored, 10, 'the loop stopped finding storable roots, so it stopped proving anything');
});
