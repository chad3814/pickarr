import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSearchText, matchesTerm } from '../src/api/search.ts';
import type { DisplayFields } from '../src/api/client.ts';

const FULL: DisplayFields = {
  title: 'Alex Coal',
  subtitle: 'Backroom Casting',
  date: '2026-02-14',
  fields: [
    { label: 'Site', value: 'BangBros' },
    { label: 'Duration', value: '42m' },
  ],
};

test('the haystack holds every part of the display, lowercased', () => {
  // The property that matters is not the exact spacing but that all four parts
  // are reachable, so each is asserted on its own rather than against one
  // golden string a reordering would break for no reason.
  const text = groupSearchText(FULL);
  assert.ok(text.includes('alex coal'), 'title');
  assert.ok(text.includes('backroom casting'), 'subtitle');
  assert.ok(text.includes('2026-02-14'), 'date');
  assert.ok(text.includes('bangbros'), 'a field value');
  assert.ok(text.includes('42m'), 'every field value, not just the first');
});

test('a label is not part of the haystack, only its value', () => {
  // `searchTextFor` in `packages/core/src/ingest/commit.ts` pushes `field.value`
  // and never `field.label`, so `search_text` holds no labels either. Searching
  // "site" must not match every group that happens to have a Site field.
  assert.equal(groupSearchText(FULL).includes('site'), false);
});

test('the absent halves of a display are skipped, not spelled as undefined', () => {
  // A group with no subtitle, no date and no fields is the common shape from a
  // plugin that only knows a title. Interpolating the absences would put the
  // word "undefined" in the haystack, where the term "und" would then match
  // every such group.
  const text = groupSearchText({ title: 'Alpha', fields: [] });
  assert.equal(text, 'alpha');
});

test('an empty or blank term matches everything', () => {
  // The box starts empty, and clearing it must restore the full list rather
  // than filter it to nothing. Whitespace counts as empty: a stray space left
  // behind while deleting a term is not a query.
  assert.equal(matchesTerm('', 'anything at all'), true);
  assert.equal(matchesTerm('   ', 'anything at all'), true);
  assert.equal(matchesTerm('', ''), true);
});

test('matching ignores case and surrounding whitespace on both sides', () => {
  assert.equal(matchesTerm('ALEX', groupSearchText(FULL)), true);
  assert.equal(matchesTerm('  alex  ', groupSearchText(FULL)), true);
  // Raw text, not a prepared haystack: Downloads passes a download title
  // straight in, so the lowercasing cannot live only in `groupSearchText`.
  assert.equal(matchesTerm('coal', 'Alex Coal 2160p'), true);
});

test('a term that appears nowhere does not match', () => {
  assert.equal(matchesTerm('riley', groupSearchText(FULL)), false);
});

test('matching is substring, over the joined parts rather than within each one', () => {
  // Two consequences of one haystack, both of which the server also has, since
  // `search_text LIKE '%term%'` runs against the same joined string:
  //
  // A term may span the boundary between two parts — "coal backroom" reaches
  // across the end of the title into the start of the subtitle and matches.
  assert.equal(matchesTerm('coal backroom', groupSearchText(FULL)), true);
  // And matching is a substring test, not a word-set one, so the same two words
  // in the other order find nothing.
  assert.equal(matchesTerm('backroom coal', groupSearchText(FULL)), false);
});

test('LIKE wildcards are literal here', () => {
  // Issue #32: `/api/browse?q=` interpolates the term into a LIKE with no
  // ESCAPE, so `%` and `_` match more than the reader typed. This filter is a
  // plain substring test, so those characters mean themselves — which is why
  // Picks and Downloads must not grow a copy of that SQL.
  assert.equal(matchesTerm('a%l', 'alex coal'), false);
  assert.equal(matchesTerm('a_ex', 'alex coal'), false);
  assert.equal(matchesTerm('100%', 'imported 100% verified'), true);
});
