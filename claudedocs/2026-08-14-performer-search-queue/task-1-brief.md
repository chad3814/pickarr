### Task 1: The plugin says what to search for

**Files:**
- Modify: `packages/plugin-api/src/types.ts`
- Create: `packages/plugin-scenes/src/performer-query.ts`
- Modify: `packages/plugin-scenes/src/index.ts:56`
- Test: `packages/plugin-scenes/test/performer-query.test.ts` (create)

**Interfaces:**
- Consumes: `GroupIdentity` from `@pickarr/plugin-api` — `{ readonly identityKey: string; readonly display: DisplayFields }`.
- Produces: `MediaTypePlugin.performerQuery?(identity: GroupIdentity): string | null`, and `scenePerformerQuery(group: GroupIdentity): string | null` exported from `packages/plugin-scenes/src/performer-query.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin-scenes/test/performer-query.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
TSX_TSCONFIG_PATH=packages/plugin-scenes/tsconfig.json node --import tsx --conditions development --test packages/plugin-scenes/test/performer-query.test.ts
```

Expected: fails to resolve `../src/performer-query.ts`.

- [ ] **Step 3: Add the plugin seam**

In `packages/plugin-api/src/types.ts`, on the `MediaTypePlugin` interface, beside `metadataQuery`:

```ts
  /**
   * What to search a performer directory for, given a group's identity, or
   * `null` when this group is not worth asking about.
   *
   * The same shape of seam as `siteCandidates` and `metadataQuery`: the plugin
   * says what to ask, the host decides how and when. Core never learns what a
   * title's leading words mean, which is what lets a media type with no notion
   * of performers opt out by simply not implementing this — rather than by core
   * special-casing it.
   *
   * A plugin returning a query is not claiming the query names a performer. It
   * is a guess, and the host's match rule is what decides whether to believe
   * any result; see the spec's §7.
   */
  performerQuery?(identity: GroupIdentity): string | null;
```

- [ ] **Step 4: Implement the scenes rule**

Create `packages/plugin-scenes/src/performer-query.ts`:

```ts
import type { GroupIdentity } from '@pickarr/plugin-api';

/**
 * The number of leading words a performer query is built from.
 *
 * Two, because a performer is billed as a first and last name and two words is
 * the shortest run that can distinguish one. One word is not merely weaker, it
 * is actively wrong: `resolve-sites.ts` documents `Free.Use.Fantasy` confirming
 * the real-but-wrong site `Free` on a one-word retry, and a one-word performer
 * query has the same failure with a worse consequence — a name written onto a
 * group's cast rather than a site guessed at.
 */
const WORDS = 2;

/**
 * The first two words of the group's title, or `null` when it has fewer.
 *
 * `display.title` is already the right text to cut: `buildRelease` puts the site
 * in `display.subtitle`, the date in `display.date`, and the quality suffix into
 * `quality` — so the title is the scene title alone and this function needs no
 * stripping rules of its own. Adding any here would be a second place that
 * decides what a title is.
 *
 * Punctuation inside a word is preserved. `Katie O'Neil` and `Anne-Marie Smith`
 * are how the provider spells those names, so a query with the punctuation
 * removed is a query it cannot match. Normalisation belongs to *comparison*,
 * which happens in the host's match rule against a returned name — not to the
 * query, which has to look like the thing being searched for.
 */
export function scenePerformerQuery(group: GroupIdentity): string | null {
  const words = group.display.title.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length < WORDS) return null;
  return words.slice(0, WORDS).join(' ');
}
```

- [ ] **Step 5: Wire it into the plugin**

In `packages/plugin-scenes/src/index.ts`, add the import beside the other metadata imports and the method beside `metadataQuery` (currently line 56):

```ts
    performerQuery: (group) => scenePerformerQuery(group),
```

- [ ] **Step 6: Run the test and the plugin's suite**

```
TSX_TSCONFIG_PATH=packages/plugin-scenes/tsconfig.json node --import tsx --conditions development --test packages/plugin-scenes/test/performer-query.test.ts
npm run check
```

Expected: the new file's tests pass; 813 core + 165 web still green, plus the new plugin tests.

- [ ] **Step 7: Prove the tests bite**

Change `WORDS` to `1` and re-run. The one-word test must fail. Change it back. Report this in your summary.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-api/src/types.ts packages/plugin-scenes/src/performer-query.ts \
        packages/plugin-scenes/src/index.ts packages/plugin-scenes/test/performer-query.test.ts
git commit -m "Ask the plugin what to search a performer directory for"
```

---

