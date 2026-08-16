### Task 4: The match rule, on its own

**Files:**
- Create: `packages/core/src/pipeline/pick-performer.ts`
- Test: `packages/core/test/pipeline/pick-performer.test.ts` (create)

**Interfaces:**
- Consumes: `PerformerSearchResult` from `../clients/theporndb.ts` (Task 3).
- Produces: `pickPerformer(query: string, results: readonly PerformerSearchResult[]): MetadataPerformer | null`.

Pure and dependency-free: no database, no client, no clock. This is the piece that can silently write a wrong name onto a group, so it gets its own file, its own tests and its own review gate.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/pipeline/pick-performer.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PerformerSearchResult } from '../../src/clients/theporndb.ts';
import { pickPerformer } from '../../src/pipeline/pick-performer.ts';

/** A search result: canonical name, plus whatever aliases the provider listed. */
function result(name: string, aliases: string[] = []): PerformerSearchResult {
  return {
    performer: {
      sourceUuid: `uuid-${name}`,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      kind: 'performer',
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

test('normalisation does not collapse two genuinely different people into a tie', () => {
  // The guard against over-normalising: if it were aggressive enough to equate
  // these, the pair would read as an ambiguity and a real single match would be
  // lost. They must stay distinct.
  const picked = pickPerformer('Anna Bell', [result('Anna Bell'), result('Annabelle')]);
  assert.equal(picked?.name, 'Anna Bell');
});
```

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/core/src/pipeline/pick-performer.ts`:

```ts
import type { MetadataPerformer } from '@pickarr/plugin-api';
import type { PerformerSearchResult } from '../clients/theporndb.ts';

/**
 * The form two spellings of one name have to agree on.
 *
 * Case, and the punctuation that separates words — a release title writes
 * `Anne Marie` where the provider writes `Anne-Marie`, and `ONeil` where it
 * writes `O'Neil`. Both are the same claim about the same person and a
 * comparison that called them different would reject the majority of real hits.
 *
 * Deliberately *not* aggressive beyond that: it does not strip vowels, collapse
 * doubled letters or fold `Anna Bell` into `Annabelle`. Over-normalising here
 * does not merely admit a wrong match, it manufactures ties — two distinct
 * performers reading as equal is an ambiguity, and an ambiguity discards a real
 * single match. The cost of being too loose is silence where there was an
 * answer, so the bar is "spelled the same, punctuated differently".
 */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The one performer worth linking, or `null`.
 *
 * Tiered, and the tiers are ordered by how strong a claim they are:
 *
 * 1. An exact `name` match. Exactly one → that one. **Two or more → nothing,
 *    and the alias tier is not consulted.** A tie among canonical names is the
 *    strongest ambiguity available; reaching for a weaker signal to break it
 *    would be backwards.
 * 2. An exact alias match, only when tier one found none. Exactly one → that
 *    one. Two or more → nothing.
 *
 * Aliases count at all because the provider searches them and because the
 * filenames this query came from carry whatever the site billed, which is
 * frequently an alias rather than the canonical name. Excluding them would
 * reject most real hits; ranking them second is what stops that breadth costing
 * precision.
 *
 * "Exactly one" throughout, never "the first" or "the best scoring". The query
 * is two words off the front of a scene title — a guess that those words name a
 * performer at all — so the failure this must not have is a plausible wrong
 * name written onto a group's cast. Silence is the correct answer to doubt, and
 * it is by far the most common one.
 */
export function pickPerformer(
  query: string,
  results: readonly PerformerSearchResult[],
): MetadataPerformer | null {
  const wanted = normalise(query);
  if (wanted.length === 0) return null;

  const byName = results.filter((result) => normalise(result.performer.name) === wanted);
  if (byName.length === 1) return byName[0]?.performer ?? null;
  if (byName.length > 1) return null;

  const byAlias = results.filter((result) =>
    result.aliases.some((alias) => normalise(alias) === wanted),
  );
  return byAlias.length === 1 ? (byAlias[0]?.performer ?? null) : null;
}
```

- [ ] **Step 4: Run the tests**

```
node --import tsx --conditions development --test packages/core/test/pipeline/pick-performer.test.ts
npm run check
```

- [ ] **Step 5: Prove the tests bite**

Three mutations, each re-run and then reverted. Report all three:
1. Change `if (byName.length > 1) return null;` to fall through to the alias tier — the "do not fall through" test must fail.
2. Change `byAlias.length === 1` to `byAlias.length >= 1` — the two-alias test must fail.
3. Add `.replace(/\s+/g, '')` to `normalise` — the `Anna Bell` / `Annabelle` test must fail.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/pipeline/pick-performer.ts packages/core/test/pipeline/pick-performer.test.ts
git commit -m "Decide a performer match by name first, alias second, nothing on doubt"
```

---

