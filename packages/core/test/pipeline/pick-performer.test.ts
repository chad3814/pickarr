import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PerformerSearchResult } from '../../src/clients/theporndb.ts';
import { pickPerformer } from '../../src/pipeline/pick-performer.ts';

/**
 * A search result: canonical name, plus whatever aliases the provider listed.
 *
 * `kind` is a parameter because the two identities a `/performers` page can
 * return are not interchangeable here, and defaulting it to `'performer'` would
 * mean every test but the two that pass `'performer-site'` describes the easy
 * half of the payload.
 */
function result(
  name: string,
  aliases: string[] = [],
  kind: PerformerSearchResult['performer']['kind'] = 'performer',
): PerformerSearchResult {
  return {
    performer: {
      sourceUuid: `uuid-${name}-${kind}`,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      kind,
      faceUrl: null,
      imageUrl: null,
    },
    aliases,
  };
}

test('one exact name match is linked', () => {
  const picked = pickPerformer('Jessica Jaymes', [result('Jessica Jaymes'), result('Someone Else')]);
  assert.equal(picked?.name, 'Jessica Jaymes');
});

test('an alias-only match is linked, because that is what filenames carry', () => {
  // A release is named with whatever the site billed, which is frequently an
  // alias. The provider searches aliases, so this is the common real hit — the
  // returned `name` does not equal the query at all.
  const picked = pickPerformer('Jessi Jaymes', [result('Jessica Jaymes', ['Jessi Jaymes'])]);
  assert.equal(picked?.name, 'Jessica Jaymes');
});

test('a name match beats another candidate alias match', () => {
  // A canonical name is a stronger claim than a billing alias, so when both are
  // on offer the name decides. This is the case that makes the tiering earn its
  // keep rather than being ceremony.
  const picked = pickPerformer('Jessi Jaymes', [
    result('Someone Else', ['Jessi Jaymes']),
    result('Jessi Jaymes'),
  ]);
  assert.equal(picked?.name, 'Jessi Jaymes');
});

test('two exact name matches link nothing and do not fall through to aliases', () => {
  // A tie at the strongest tier is the strongest ambiguity available. Breaking
  // it with a weaker signal would be backwards, so the alias tier is not even
  // consulted — note the third candidate, whose alias matches and is ignored.
  const picked = pickPerformer('Jessica Jaymes', [
    result('Jessica Jaymes'),
    result('Jessica Jaymes'),
    result('Someone Else', ['Jessica Jaymes']),
  ]);
  assert.equal(picked, null);
});

test('two alias matches link nothing', () => {
  const picked = pickPerformer('Jessi Jaymes', [
    result('Jessica Jaymes', ['Jessi Jaymes']),
    result('Jessika Jaymes', ['Jessi Jaymes']),
  ]);
  assert.equal(picked, null);
});

test('no match links nothing', () => {
  assert.equal(pickPerformer('Jessica Jaymes', [result('Someone Else', ['Nobody'])]), null);
  assert.equal(pickPerformer('Jessica Jaymes', []), null);
});

test('one candidate matching by both name and alias is a single tier-one hit', () => {
  const picked = pickPerformer('Jessica Jaymes', [result('Jessica Jaymes', ['Jessica Jaymes'])]);
  assert.equal(picked?.name, 'Jessica Jaymes');
});

test('comparison ignores case, punctuation and whitespace runs', () => {
  // The query comes from a release title and the name from a provider; the two
  // spell the same person differently as a matter of course. `Anne-Marie` vs
  // `Anne Marie` and `O'Neil` vs `ONeil` are the same claim.
  assert.equal(pickPerformer('jessica  jaymes', [result('Jessica Jaymes')])?.name, 'Jessica Jaymes');
  assert.equal(pickPerformer('Anne Marie Smith', [result('Anne-Marie Smith')])?.name, 'Anne-Marie Smith');
  assert.equal(pickPerformer("Katie ONeil", [result("Katie O'Neil")])?.name, "Katie O'Neil");
});

test('a canonical performer is linked past the site entries that share its name', () => {
  // This is the shape of a real `/performers` page for a name a site also bills
  // under: the canonical parent, and one or more site-scoped entries spelled
  // identically. Counting both makes the commonest *correct* query two exact
  // matches — an ambiguity — and links nothing. Only the canonical identity is
  // linkable, so only it is counted.
  const picked = pickPerformer('Alice Maze', [
    result('Alice Maze', [], 'performer-site'),
    result('Alice Maze'),
    result('Alice Maze', [], 'performer-site'),
  ]);
  assert.equal(picked?.name, 'Alice Maze');
  assert.equal(picked?.kind, 'performer');
});

test('a site entry is not linked on its own, by name or by alias', () => {
  // With no parent in the page there is no canonical identity to link, and the
  // site entry is not a substitute for one: its slug is site-prefixed, so
  // linking it points every card that credits this person at an alias page.
  assert.equal(pickPerformer('Alice Maze', [result('Alice Maze', [], 'performer-site')]), null);
  // And it must not slip in through tier 2 either — the filter runs before the
  // tiering so that excluding it from names does not leave it eligible on an
  // alias.
  assert.equal(
    pickPerformer('Ally Maze', [result('Alice Maze', ['Ally Maze'], 'performer-site')]),
    null,
  );
});

test('normalisation does not collapse two genuinely different people into a tie', () => {
  // The guard against over-normalising: if it were aggressive enough to equate
  // these, the pair would read as an ambiguity and a real single match would be
  // lost. They must stay distinct.
  const picked = pickPerformer('Anna Bell', [result('Anna Bell'), result('Annabelle')]);
  assert.equal(picked?.name, 'Anna Bell');
});
