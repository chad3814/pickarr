import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelease, slug, parseSceneRelease } from '../src/parse.ts';

test('a hand-built release is byte-identical to the parsed one', () => {
  // The whole point of exporting the builder rather than writing a second
  // one: a manually entered release must land in the same group, and on the
  // same library path, as its parsed siblings.
  const parsed = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  assert.ok(parsed !== null);

  const built = buildRelease(
    'Brazzers',
    { kind: 'date', key: '2023-04-15', startOffset: 0, endOffset: 0 },
    'Alex Coal',
    slug('Alex Coal'),
    parsed.quality,
  );

  assert.deepEqual(built, parsed);
});

test('an empty site or scene slug is refused rather than keyed on nothing', () => {
  assert.equal(buildRelease('', null, 'Title', slug('Title'), { extras: {} }), null);
  assert.equal(buildRelease('Site', null, '', '', { extras: {} }), null);
});
