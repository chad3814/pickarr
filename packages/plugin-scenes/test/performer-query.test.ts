import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GroupIdentity } from '@pickarr/plugin-api';
import { scenePerformerQuery } from '../src/performer-query.ts';

/**
 * `display.title` is what `buildRelease` produces: the scene title with the
 * site in `display.subtitle`, the date in `display.date` and the quality
 * suffix already cut into `quality`. So these titles are what the parser
 * really hands over, not raw release names — a test built from raw names would
 * pin a stripping rule this function deliberately does not have.
 */
function identity(title: string): GroupIdentity {
  return { identityKey: 'k', display: { title, subtitle: 'Some Site', fields: [] } };
}

test('the query is the first two words of the title', () => {
  assert.equal(scenePerformerQuery(identity('Jessica Jaymes Loves It')), 'Jessica Jaymes');
});

test('a two-word title is used whole', () => {
  assert.equal(scenePerformerQuery(identity('Jessica Jaymes')), 'Jessica Jaymes');
});

test('a one-word title yields nothing rather than a one-word query', () => {
  // resolve-sites.ts records the cost of one-word queries at length: there is a
  // site called `Free`, so `Free.Use.Fantasy` confirms it on a one-word retry.
  // A one-word performer query fails the same way, and here the consequence is
  // a wrong name written onto a group.
  assert.equal(scenePerformerQuery(identity('Solo')), null);
});

test('an empty or whitespace title yields nothing', () => {
  assert.equal(scenePerformerQuery(identity('')), null);
  assert.equal(scenePerformerQuery(identity('   ')), null);
});

test('runs of whitespace collapse rather than producing an empty second word', () => {
  assert.equal(scenePerformerQuery(identity('Jessica   Jaymes  Loves')), 'Jessica Jaymes');
});

test('punctuation inside a word is kept, because the provider matches on the name', () => {
  // `O'Neil` and `Anne-Marie` are real names. Stripping punctuation here would
  // send a query the provider cannot match; normalisation for *comparison*
  // happens in the match rule, not in the query.
  assert.equal(scenePerformerQuery(identity("Katie O'Neil Returns")), "Katie O'Neil");
  assert.equal(scenePerformerQuery(identity('Anne-Marie Smith Again')), 'Anne-Marie Smith');
});
