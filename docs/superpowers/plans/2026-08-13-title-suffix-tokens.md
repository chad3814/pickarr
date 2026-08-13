# Title suffix tokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop trailing content-type tags, CMS ids and language tags reaching the scene title, so a group's title is what a metadata lookup can actually be asked about.

**Architecture:** `findTitleEnd` walks the trailing tokens and stops at the first that could be a title word. A composer pairs it with the existing `findEncodeSuffixStart`, returning two indices instead of one, because the end of the title and the start of the encode section are no longer the same place. All four existing call sites move to the composer.

**Tech Stack:** Node 24, TypeScript 7 (`tsgo`, typecheck only), `node:test` + tsx, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-13-title-suffix-tokens-design.md`. Read it before Task 1 — every rule in it is backed by a corpus measurement, and the numbers are the justification for the constants below.

## Global Constraints

- **One commit per task, on this branch. Do not push and do not merge** — the repo owner approves integration.
- **This branch cannot merge without the re-key migration**, which is a separate spec. Moving the boundary moves the identity key, and shipping this alone splits every affected scene across two groups and two library paths. Do not attempt the migration here.
- Node 24 is not the shell default: `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.
- **Verify with `npm run check`** (lint + typecheck + tests). `npm run build` runs no typechecker.
- Baseline: **724 server / 92 web**, all green.
- Never use `any`. tsconfig sets `exactOptionalPropertyTypes`, `erasableSyntaxOnly` (which rejects TypeScript parameter properties), `verbatimModuleSyntax`.
- Comments explain *why*. This file's existing comments carry measured evidence; match that register.
- **All matching is case-insensitive.** The corpus contains `iTALiAN`. A rule that only matched uppercase would pass every other language test.
- When a test claims to pin a property, mutate the source to break it and confirm the test fails. Report the evidence.

## Constants fixed by the spec

Copy these values exactly; do not re-derive them.

| Constant | Value | Task |
|---|---|---|
| `CONTENT_TYPE_TERMS` | `HARDCORE`, `SOLO`, `LESBIAN` | 2 |
| `LANGUAGE_TERMS` | the 16 in Task 1 | 1 |
| `ORDINAL_WORDS` | `EPISODE`, `PART`, `VOL`, `SCENE` | 2 |
| `NUMERIC_ID_MIN` | `250` | 2 |
| year carve-out | `1900`–`2099` inclusive | 2 |

## The walk is a trailing run, and that is a deliberate limit

`findTitleEnd` stops at the **first** token that could be a title word. It does not skip over one to reach suffix tokens behind it. Two corpus titles show both sides of this:

| Title | Walk | Result |
|---|---|---|
| `Minori Kamiyama Rispetto 1 JAP` | crosses `JAP`, stops at `1` | `Minori Kamiyama Rispetto 1` |
| `Hiyori JAPANESE 2` | stops at `2` immediately | `Hiyori JAPANESE 2` — tag survives |

The second is not a bug to fix in this plan. Skipping over a kept token to strip something behind it is how you start removing words from the middle of titles, and the corpus has 9 titles with a content-type tag mid-title that must stay untouched. Task 3 pins both cases so the limit is recorded rather than discovered.

---

### Task 1: Split `NON_GROUP_TERMS` into a language half and a non-language half

**Files:**
- Modify: `packages/plugin-scenes/src/parse.ts` (the `NON_GROUP_TERMS` declaration, around line 191)
- Test: `packages/plugin-scenes/test/suffix-vocabulary.test.ts` (create)

**Interfaces:**
- Produces: `LANGUAGE_TERMS`, `NON_GROUP_EDIT_TERMS`, and `NON_GROUP_TERMS` as their union. Task 2 consumes `LANGUAGE_TERMS`.

This is a refactor plus two deliberate additions. `NON_GROUP_TERMS` is consumed by release-group detachment, so its membership must not change except by those two.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_TERMS, NON_GROUP_EDIT_TERMS, NON_GROUP_TERMS } from '../src/parse.ts';

/**
 * Every term the single undivided set held before the split. Spelled out as a
 * literal rather than computed from the halves: computing it from the code
 * under test is how a dropped term goes unnoticed.
 */
const BEFORE_THE_SPLIT = [
  'ENGLISH', 'FRENCH', 'GERMAN', 'SPANISH', 'ITALIAN', 'RUSSIAN',
  'ENG', 'FRA', 'GER', 'ESP', 'ITA', 'RUS', 'JAP', 'JPN',
  'SUB', 'SUBS', 'SUBBED', 'DUBBED', 'UNCUT', 'UNRATED', 'EXTENDED', 'DIRECTORS',
  'UNCENSORED', 'DIRECTORSCUT', 'COMPILATION', 'REMUX', 'PART', 'PT', 'CD', 'DISC',
  'SCENE', 'FULL', 'HQ', 'LQ',
];

test('the split keeps every term the union had before it', () => {
  for (const term of BEFORE_THE_SPLIT) {
    assert.ok(NON_GROUP_TERMS.has(term), `${term} fell out of NON_GROUP_TERMS`);
  }
});

test('DUTCH and JAPANESE are the only additions, and they are languages', () => {
  // Additions, asserted separately from the preservation test above so that a
  // future addition cannot hide inside it.
  assert.ok(NON_GROUP_TERMS.has('DUTCH'));
  assert.ok(NON_GROUP_TERMS.has('JAPANESE'));
  assert.ok(LANGUAGE_TERMS.has('DUTCH'));
  assert.ok(LANGUAGE_TERMS.has('JAPANESE'));
  assert.equal(NON_GROUP_TERMS.size, BEFORE_THE_SPLIT.length + 2);
});

test('the two halves are disjoint and cover the union', () => {
  for (const term of LANGUAGE_TERMS) assert.ok(!NON_GROUP_EDIT_TERMS.has(term), term);
  for (const term of NON_GROUP_EDIT_TERMS) assert.ok(!LANGUAGE_TERMS.has(term), term);
  assert.equal(NON_GROUP_TERMS.size, LANGUAGE_TERMS.size + NON_GROUP_EDIT_TERMS.size);
});

test('terms that can be title words stay out of the language half', () => {
  // The corpus has `Leona Mia Beauty In Full`, `Alaina Dawson Compilation` and
  // `Jessica Jans Bonus Scene` — real titles ending in these words. Only the
  // language half is ever dropped from a title, so these must not be in it.
  for (const term of ['FULL', 'COMPILATION', 'SCENE', 'PART', 'UNCUT', 'EXTENDED']) {
    assert.ok(!LANGUAGE_TERMS.has(term), `${term} must not be droppable from a title`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/plugin-scenes/test/suffix-vocabulary.test.ts`
Expected: FAIL — `LANGUAGE_TERMS` is not exported.

- [ ] **Step 3: Split the set**

Replace the single `NON_GROUP_TERMS` declaration. Keep its existing doc comment on the union, and give each half its own.

```ts
/**
 * Language names and codes. Exported and split out of `NON_GROUP_TERMS`
 * because they answer a second question the other half cannot: a language is
 * not a title word either, so it may be dropped from the end of a title —
 * see `isTitleSuffixToken`.
 *
 * `DUTCH` and `JAPANESE` were absent before this split, which is why a release
 * ending in either had it detached as a release group, merging two language
 * cuts of one scene. Adding them fixes that and is the only membership change
 * the split makes.
 *
 * Measured: seven of these occur at the end of a parsed title in the corpus —
 * `GERMAN` 13, `DUTCH` 11, `SPANISH`, `FRENCH`, `ITALIAN`, `JAPANESE`, `JAP` —
 * and every occurrence is a tag rather than a title word. `ENGLISH` and
 * `RUSSIAN` never occur there and are the two that are also ordinary
 * adjectives; if a title is ever wrongly truncated, they are the first
 * entries to suspect.
 */
export const LANGUAGE_TERMS = new Set([
  'ENGLISH', 'FRENCH', 'GERMAN', 'SPANISH', 'ITALIAN', 'RUSSIAN', 'DUTCH', 'JAPANESE',
  'ENG', 'FRA', 'GER', 'ESP', 'ITA', 'RUS', 'JAP', 'JPN',
]);

/**
 * The rest of `NON_GROUP_TERMS`: edit, cut and distribution notes.
 *
 * These are emphatically *not* droppable from a title, which is the whole
 * reason the split exists. The corpus ends real titles with three of them —
 * `Leona Mia Beauty In Full`, `Alaina Dawson Compilation`, `Jessica Jans Bonus
 * Scene` — so a rule that treated this half as suffix noise would render the
 * first as `Beauty In`. The union's own comment makes the same point from the
 * other direction: each names a different cut or different content, so
 * detaching one as a group would merge two things that are not the same scene.
 */
export const NON_GROUP_EDIT_TERMS = new Set([
  'SUB', 'SUBS', 'SUBBED', 'DUBBED', 'UNCUT', 'UNRATED', 'EXTENDED', 'DIRECTORS',
  'UNCENSORED', 'DIRECTORSCUT', 'COMPILATION', 'REMUX', 'PART', 'PT', 'CD', 'DISC',
  'SCENE', 'FULL', 'HQ', 'LQ',
]);
```

Then make the union, keeping the original doc comment above it:

```ts
export const NON_GROUP_TERMS = new Set([...LANGUAGE_TERMS, ...NON_GROUP_EDIT_TERMS]);
```

- [ ] **Step 4: Run and confirm green**

Run: `npm run check`
Expected: PASS. If any existing test fails, **read it before changing it** — a failure here means group detachment moved, which is only expected for names ending in `DUTCH` or `JAPANESE`.

- [ ] **Step 5: Break it on purpose**

Delete `'FULL'` from `NON_GROUP_EDIT_TERMS` and confirm the preservation test fails naming `FULL`. Then move `'UNCUT'` into `LANGUAGE_TERMS` and confirm the disjointness test and the title-word test both fail. Revert both. Paste the output.

- [ ] **Step 6: Commit.** Do not push.

---

### Task 2: The suffix-token predicates

**Files:**
- Modify: `packages/plugin-scenes/src/parse.ts`
- Test: `packages/plugin-scenes/test/suffix-tokens.test.ts` (create)

**Interfaces:**
- Consumes: `LANGUAGE_TERMS` from Task 1.
- Produces: `isContentTypeTerm(text: string): boolean`, `isLanguageTerm(text: string): boolean`, `isNumericIdToken(text: string, previous: string | undefined): boolean`. Task 3 consumes all three.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isContentTypeTerm, isLanguageTerm, isNumericIdToken } from '../src/parse.ts';

test('content types match in any case', () => {
  for (const t of ['solo', 'SOLO', 'Solo', 'hardcore', 'Hardcore', 'lesbian', 'LESBIAN']) {
    assert.ok(isContentTypeTerm(t), t);
  }
  assert.ok(!isContentTypeTerm('soloist'));
  assert.ok(!isContentTypeTerm('anal'));
});

test('languages match in any case, including the corpus spelling', () => {
  // `Orgia Balorda iTALiAN` is a real corpus title. A rule matching only
  // uppercase passes every other language assertion and fails this one.
  assert.ok(isLanguageTerm('iTALiAN'));
  assert.ok(isLanguageTerm('DUTCH'));
  assert.ok(isLanguageTerm('japanese'));
  assert.ok(isLanguageTerm('JAP'));
  assert.ok(!isLanguageTerm('dutchess'));
  assert.ok(!isLanguageTerm('SUB'), 'SUB is about a language, not one');
});

test('a numeric id is 250 or more', () => {
  assert.ok(isNumericIdToken('42466', 'solo'));
  assert.ok(isNumericIdToken('250', 'x'));
  assert.ok(!isNumericIdToken('249', 'x'));
  assert.ok(!isNumericIdToken('2', 'x'), 'a sequel number is a title word');
  assert.ok(!isNumericIdToken('4', 'x'));
});

test('a padded id is still an id', () => {
  // `Michala 0279` — leading zeros are id-shaped, and Number('0279') is 279.
  assert.ok(isNumericIdToken('0279', 'michala'));
});

test('a year is not an id', () => {
  // `Gianna Dior TOTM March 2020` and `Jordan Maxx ... Carried Away 2021`.
  assert.ok(!isNumericIdToken('2020', 'march'));
  assert.ok(!isNumericIdToken('2021', 'away'));
  assert.ok(!isNumericIdToken('1900', 'x'));
  assert.ok(!isNumericIdToken('2099', 'x'));
  assert.ok(isNumericIdToken('2100', 'x'), 'past the year range it is an id again');
  assert.ok(isNumericIdToken('1899', 'x'), 'below the year range too');
});

test('a number after an ordinal word belongs to the title', () => {
  // `Violet Voss Episode 466`. Without this, episode 466 and episode 467
  // both key as `violet-voss-episode` and collide.
  assert.ok(!isNumericIdToken('466', 'Episode'));
  assert.ok(!isNumericIdToken('466', 'episode'));
  assert.ok(!isNumericIdToken('3', 'part'));
  assert.ok(!isNumericIdToken('900', 'vol'));
  assert.ok(!isNumericIdToken('900', 'scene'));
  assert.ok(isNumericIdToken('466', 'voss'), 'an ordinary word does not protect it');
});

test('a non-numeric token is never an id', () => {
  assert.ok(!isNumericIdToken('1080p', 'x'));
  assert.ok(!isNumericIdToken('4K', 'x'));
  assert.ok(!isNumericIdToken('E1178', 'x'));
  assert.ok(!isNumericIdToken('', 'x'));
});
```

- [ ] **Step 2: Run it and watch it fail.** Expected: FAIL — nothing is exported.

- [ ] **Step 3: Implement the predicates**

Place these next to the vocabularies from Task 1.

```ts
/**
 * Scene-type tags some sites append after the title. Not title words: the
 * service that knows the scene knows it by a name without them, so a title
 * carrying one cannot be matched.
 *
 * Measured: 219 corpus titles carry one, 210 of them in the trailing run.
 * The remaining 9 are mid-title and are left alone — `findTitleEnd` only ever
 * walks the end.
 */
const CONTENT_TYPE_TERMS = new Set(['HARDCORE', 'SOLO', 'LESBIAN']);

/**
 * Words after which a number belongs to the title.
 *
 * `Violet Voss Episode 466` is why: 466 is past the id threshold, and dropping
 * it does not merely shorten the title — it collides with episode 467 if a
 * site posts two on one day.
 *
 * A list of observed words, with the maintenance cost that implies: another
 * site's `chapter` or `ep` would truncate. `stripPosterSignature` carries the
 * same cost for the same reason — no structural rule was available.
 *
 * `PART` and `SCENE` are also in `NON_GROUP_EDIT_TERMS`. That is not the
 * duplication issue #13 warns about: these two sets answer different questions
 * — "may a number after this word be dropped" and "does this token have a
 * group's shape" — and their answers never conflict.
 */
const ORDINAL_WORDS = new Set(['EPISODE', 'PART', 'VOL', 'SCENE']);

/**
 * The smallest all-numeric token treated as a site's own id rather than part
 * of the title.
 *
 * Measured over 6,388 corpus titles: 312 end in a number. All 206 below 250
 * are sequel or part numbers (`Sarasota 4`, `Menu 2`), and 99 of the 106 at or
 * above it are ids of the `42xxx` shape. Nothing has 250 sequels.
 */
const NUMERIC_ID_MIN = 250;

/** Numbers in this range read as years, and a year can be a title word. */
const YEAR_MIN = 1900;
const YEAR_MAX = 2099;

function isContentTypeTerm(text: string): boolean {
  return CONTENT_TYPE_TERMS.has(text.toUpperCase());
}

function isLanguageTerm(text: string): boolean {
  return LANGUAGE_TERMS.has(text.toUpperCase());
}

/**
 * `previous` is the token before this one, which is still part of the title at
 * the moment the walk asks. It is what the `ORDINAL_WORDS` carve-out reads.
 */
function isNumericIdToken(text: string, previous: string | undefined): boolean {
  if (!/^\d+$/.test(text)) return false;
  const value = Number(text);
  if (value < NUMERIC_ID_MIN) return false;
  if (value >= YEAR_MIN && value <= YEAR_MAX) return false;
  if (previous !== undefined && ORDINAL_WORDS.has(previous.toUpperCase())) return false;
  return true;
}
```

Export all three for the test.

- [ ] **Step 4: Run and confirm green.** `npm run check`.

- [ ] **Step 5: Break each carve-out on purpose**

Three separate mutations, each reverted before the next: remove the year check and confirm only the year test fails; remove the `ORDINAL_WORDS` check and confirm only the ordinal test fails; change `NUMERIC_ID_MIN` to `200` and confirm the `249` assertion fails. Paste all three outputs.

- [ ] **Step 6: Commit.** Do not push.

---

### Task 3: `findTitleEnd`

**Files:**
- Modify: `packages/plugin-scenes/src/parse.ts`
- Test: `packages/plugin-scenes/test/find-title-end.test.ts` (create)

**Interfaces:**
- Consumes: Task 2's three predicates, plus the existing `isEncodeToken` and `MARKER_TOKEN`.
- Produces: `isTitleSuffixToken(text: string, previous: string | undefined): boolean` and `findTitleEnd(tokens: Token[], minIndex: number): number`. Task 4 consumes `findTitleEnd`.

`tokensOf` already exists in this file and is what the tests should use to build inputs, so a test cannot disagree with the tokenizer.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTitleEnd, tokensOf } from '../src/parse.ts';

/** The title text the walk leaves behind, for readable assertions. */
function titleOf(name: string, minIndex = 0): string {
  const tokens = tokensOf(name);
  const end = findTitleEnd(tokens, minIndex);
  return tokens.slice(0, end).map((t) => t.text).join(' ');
}

test('the walk crosses the XXX marker to reach what is behind it', () => {
  // The whole change depends on this: XXX is neither an encode token nor a
  // boundary anchor, so a walk that stopped there would never see `42466` or
  // `Solo`, which is where most affected titles keep their junk.
  assert.equal(titleOf('Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB'), 'Suki Sin');
});

test('it crosses a content-type tag', () => {
  assert.equal(titleOf('Remido.Solo.XXX.1080p.MP4-WRB'), 'Remido');
});

test('it crosses a language tag, in the corpus spelling', () => {
  assert.equal(titleOf('Orgia.Balorda.iTALiAN.XXX.1080p'), 'Orgia Balorda');
  assert.equal(titleOf('Maria.Gail.GERMAN.XXX.1080p'), 'Maria Gail');
});

test('it crosses a language tag then stops at a sequel number', () => {
  // `Minori Kamiyama Rispetto 1 JAP`: JAP goes, the 1 stays.
  assert.equal(titleOf('Minori.Kamiyama.Rispetto.1.JAP.XXX.1080p'),
    'Minori Kamiyama Rispetto 1');
});

test('a kept token blocks the walk from reaching suffix tokens behind it', () => {
  // `Hiyori JAPANESE 2` — the 2 stops the walk, so JAPANESE survives. This is
  // the trailing-run limit, recorded deliberately: skipping a kept token to
  // strip something behind it is how words go missing from the middle of a
  // title, and 9 corpus titles have a content-type tag mid-title.
  assert.equal(titleOf('Hiyori.JAPANESE.2.XXX.1080p'), 'Hiyori JAPANESE 2');
});

test('a title word ends the walk immediately', () => {
  assert.equal(titleOf('Alex.Coal.Some.Title'), 'Alex Coal Some Title');
});

test('minIndex stops the walk, so the title can never empty', () => {
  // Every token is a suffix token; minIndex is the only thing left.
  assert.equal(titleOf('Solo.Hardcore.Lesbian', 1), 'Solo');
  assert.equal(titleOf('Solo.Hardcore.Lesbian', 2), 'Solo Hardcore');
});

test('mid-title tags are untouched, because the walk only sees the end', () => {
  assert.equal(titleOf('Solo.Adventure.Begins'), 'Solo Adventure Begins');
  assert.equal(titleOf('The.Hardcore.Truth'), 'The Hardcore Truth');
});
```

- [ ] **Step 2: Run it and watch it fail.** Expected: FAIL — `findTitleEnd` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * Whether a token at the end of a name is something other than a title word.
 *
 * `MARKER_TOKEN` is referenced rather than copied into any of the sets above.
 * It has to be crossable or the walk stops at `XXX` and never reaches the id
 * and the content-type tag behind it — which is most of what this exists to
 * remove. Issue #13 is what copying it would cost: `REMASTERED` sat in the
 * encode vocabulary and the non-group list at once and refused 14 corpus
 * titles.
 */
function isTitleSuffixToken(text: string, previous: string | undefined): boolean {
  return (
    isEncodeToken(text) ||
    text.toUpperCase() === MARKER_TOKEN ||
    isContentTypeTerm(text) ||
    isLanguageTerm(text) ||
    isNumericIdToken(text, previous)
  );
}

/**
 * The index at which the title ends: everything from here to the end of
 * `tokens` is suffix.
 *
 * The same backward walk `findEncodeSuffixStart` opens with, over a wider
 * predicate. It stops at the *first* token that could be a title word and does
 * not look past it — see the test named for `Hiyori JAPANESE 2`. `minIndex`
 * carries its existing meaning and is what keeps the walk from emptying the
 * title, so no separate guard is needed; `buildRelease` still refuses an empty
 * scene slug if one ever arrives another way.
 */
function findTitleEnd(tokens: Token[], minIndex: number): number {
  let end = tokens.length;
  while (end > minIndex) {
    const token = tokens[end - 1];
    if (token === undefined) break;
    if (!isTitleSuffixToken(token.text, tokens[end - 2]?.text)) break;
    end -= 1;
  }
  return end;
}
```

Export `findTitleEnd` and `tokensOf` for the test if they are not already.

- [ ] **Step 4: Run and confirm green.** `npm run check`.

- [ ] **Step 5: Break the marker clause on purpose**

Remove `text.toUpperCase() === MARKER_TOKEN` from `isTitleSuffixToken`. Confirm the first test fails with `Suki Sin Solo 42466` instead of `Suki Sin` — the walk stopping at `XXX`. Revert. Paste the output. If that test still passes, the clause is unpinned and you must say so.

- [ ] **Step 6: Commit.** Do not push.

---

### Task 4: The composer

**Files:**
- Modify: `packages/plugin-scenes/src/parse.ts`
- Test: `packages/plugin-scenes/test/title-boundary.test.ts` (create)

**Interfaces:**
- Consumes: `findTitleEnd` from Task 3, `findEncodeSuffixStart` unchanged.
- Produces: `interface TitleBoundary { readonly titleEnd: number; readonly encodeStart: number }`, `findTitleBoundary(tokens: Token[], minIndex: number): TitleBoundary | null`, and `suffixOffset(tokens: Token[], index: number, text: string): number`. Task 5 consumes all three.

`findEncodeSuffixStart` is **not modified**. It receives `titleEnd` as its `minIndex`, which is already what that parameter means.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTitleBoundary, suffixOffset, tokensOf } from '../src/parse.ts';

test('the two indices diverge, and the quality haystack starts at the later one', () => {
  const name = 'Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB';
  const tokens = tokensOf(name);
  const boundary = findTitleBoundary(tokens, 1);
  assert.ok(boundary !== null);

  const title = name.slice(0, suffixOffset(tokens, boundary.titleEnd, name));
  const tail = name.slice(suffixOffset(tokens, boundary.encodeStart, name));

  assert.equal(title, 'Suki.Sin');
  assert.equal(tail, 'XXX.1080p.MP4-WRB');
  // The gap is what must never reach extractQuality: issue #12 records that one
  // unknown encode word refuses a whole name, and `Solo` and `42466` are two.
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
    const boundary = findTitleBoundary(tokensOf(name), 1);
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
```

- [ ] **Step 2: Run it and watch it fail.** Expected: FAIL — `findTitleBoundary` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * Where the title stops and where the encode section starts. Two numbers
 * because they are no longer the same one: the tokens between them are the
 * suffix `findTitleEnd` removed, and they must reach neither the title nor
 * `extractQuality`.
 */
export interface TitleBoundary {
  readonly titleEnd: number;
  readonly encodeStart: number;
}

/**
 * Pairs the title walk with the existing encode-boundary search.
 *
 * `findEncodeSuffixStart` is unchanged and receives `titleEnd` as its
 * `minIndex`, which already means "the first index the cut may fall on". A
 * `null` return means what it has always meant — no recognisable encode
 * section — so every caller's existing refusal path still applies.
 *
 * Tokens are passed whole rather than sliced. Callers cut the original name
 * string with `token.start`, and slicing the array would shift indices while
 * those offsets stayed absolute.
 */
function findTitleBoundary(tokens: Token[], minIndex: number): TitleBoundary | null {
  const titleEnd = findTitleEnd(tokens, minIndex);
  const encodeStart = findEncodeSuffixStart(tokens, titleEnd);
  if (encodeStart === null) return null;
  return { titleEnd, encodeStart };
}

/**
 * The offset in `text` at which the token at `index` begins, or the end of
 * `text` when `index` is past the last token — which happens whenever a name
 * carries no suffix at all.
 */
function suffixOffset(tokens: Token[], index: number, text: string): number {
  return tokens[index]?.start ?? text.length;
}
```

Export `findTitleBoundary` and `suffixOffset` for the test.

- [ ] **Step 4: Run and confirm green.** `npm run check`.

- [ ] **Step 5: Prove the two functions share one encode predicate**

Add this test, which fails if a future change forks the predicate:

```ts
test('both boundaries agree about what an encode token is', () => {
  // If findTitleEnd and findEncodeSuffixStart used different encode
  // predicates, the gap between the indices would fill with tokens that reach
  // extractQuality, and nothing would say so. With one predicate, a name whose
  // whole suffix is encode tokens has both indices at the same place.
  const tokens = tokensOf('Alex.Coal.1080p.MP4-WRB');
  const boundary = findTitleBoundary(tokens, 1);
  assert.ok(boundary !== null);
  assert.equal(boundary.titleEnd, boundary.encodeStart);
});
```

Run it, confirm it passes, then change `isTitleSuffixToken` to drop its `isEncodeToken(text)` clause and confirm it fails. Revert. Paste the output.

- [ ] **Step 6: Commit.** Do not push.

---

### Task 5: Move the four call sites to the composer

**Files:**
- Modify: `packages/plugin-scenes/src/parse.ts` — four sites, currently at lines 1134, 1209, 1414, 1545
- Test: `packages/plugin-scenes/test/suffix-parse.test.ts` (create)
- Modify: existing fixtures across `packages/plugin-scenes/test/` and `packages/core/test/` as needed

**Interfaces:**
- Consumes: `findTitleBoundary` and `suffixOffset` from Task 4.

**This is the task that changes parser output, and existing tests will fail.** Eighteen lines across five files reference a suffix term: `path-template.test.ts` (6), `parse-date-at-end.test.ts` (9), `manual.test.ts` (1), `parse-corpus.test.ts` (1), `core/test/feeds/parse-rss.test.ts` (1). **Read every failure before changing it.** A fixture whose expected title loses a trailing tag is the change working. A failure anywhere else is a finding, and you must report it rather than adjust the fixture.

- [ ] **Step 1: Probe the blast radius first**

Before writing anything, make the four sites use `findTitleBoundary` in the crudest way that compiles — `titleEnd` for the title, `encodeStart` for the tail — and run `npm run check` to list every failure. Save that list to your report. Then revert the probe and proceed properly. This is how you find out whether the 18 lines are the whole story.

- [ ] **Step 2: Write the failing end-to-end test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import createScenesPlugin from '../src/index.ts';

const plugin = createScenesPlugin({});

/** The parsed title, or the refusal reason, for readable assertions. */
function titleOf(name: string): string {
  const parsed = plugin.parse(name);
  return parsed === null ? `REFUSED: ${plugin.refusalReason?.() ?? '?'}` : parsed.display.title;
}

test('a content-type tag and an id both leave the title', () => {
  assert.equal(titleOf('PornMegaLoad.26.08.05.Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB'),
    'Suki Sin');
  assert.equal(titleOf('PornMegaLoad.26.07.31.DD.White.Hardcore.42617.XXX.1080p.MP4-WRB'),
    'DD White');
});

test('a content-type tag alone leaves the title', () => {
  assert.equal(titleOf('ClubSweethearts.26.08.05.Remido.Solo.XXX.1080p.MP4-WRB'), 'Remido');
  assert.equal(
    titleOf('AllOver30.26.08.03.Diana.V.And.Lauren.De.Graaf.Lesbian.XXX.1080p.MP4-WRB'),
    'Diana V And Lauren De Graaf',
  );
});

test('a language tag leaves the title, whatever its case', () => {
  assert.equal(
    titleOf('HollandschePassie.26.08.06.Alessandra.Sweet.Hardcore.DUTCH.XXX.1080p.MP4-WRB'),
    'Alessandra Sweet',
  );
});

test('the quality still parses once the suffix is longer', () => {
  const parsed = plugin.parse('PornMegaLoad.26.08.05.Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB');
  assert.ok(parsed !== null);
  assert.equal(parsed.quality.resolution, 1080);
  assert.equal(parsed.quality.releaseGroup, 'WRB');
});

test('a sequel number, a year and an episode number all stay', () => {
  assert.equal(titleOf('Site.26.08.05.Summer.Renee.Sarasota.4.XXX.1080p.MP4-WRB'),
    'Summer Renee Sarasota 4');
  assert.equal(titleOf('Site.26.08.05.Gianna.Dior.TOTM.March.2020.XXX.1080p.MP4-WRB'),
    'Gianna Dior TOTM March 2020');
  assert.equal(titleOf('Site.26.08.05.Violet.Voss.Episode.466.XXX.1080p.MP4-WRB'),
    'Violet Voss Episode 466');
});

test('a title that is a real word from the non-language half keeps it', () => {
  assert.equal(titleOf('Site.26.08.05.Leona.Mia.Beauty.In.Full.XXX.1080p.MP4-WRB'),
    'Leona Mia Beauty In Full');
  assert.equal(titleOf('Site.26.08.05.Alaina.Dawson.Compilation.XXX.1080p.MP4-WRB'),
    'Alaina Dawson Compilation');
});

test('a mid-title tag is untouched', () => {
  assert.equal(titleOf('Site.26.08.05.The.Hardcore.Truth.XXX.1080p.MP4-WRB'),
    'The Hardcore Truth');
});
```

- [ ] **Step 3: Run it and watch it fail.** Expected: the first four tests fail with the tag still in the title.

- [ ] **Step 4: Rewrite site 1 — `dateAtEndPrefixTokens`, the `after.length === 0` branch**

```ts
const boundary = findTitleBoundary(beforeTokens, 2);
if (boundary === null) return null;
const encodeToken = beforeTokens[boundary.encodeStart];
if (encodeToken === undefined) return null;
return {
  before: beforeTokens.slice(0, boundary.titleEnd),
  tail: beforeText.slice(encodeToken.start),
  group: undefined,
};
```

- [ ] **Step 5: Rewrite site 2 — `datelessPrefixTokens`**

Keep the existing no-boundary fallback below it exactly as it is; only the guarded branch changes.

```ts
const boundary = findTitleBoundary(detached.tokens, 2);
if (boundary !== null) {
  const encodeToken = detached.tokens[boundary.encodeStart];
  if (encodeToken !== undefined) {
    return {
      before: detached.tokens.slice(0, boundary.titleEnd),
      tail: name.slice(encodeToken.start),
    };
  }
}
```

- [ ] **Step 6: Rewrite site 3 — the dotted form after the date**

```ts
const boundary = findTitleBoundary(detached.tokens, 1);
if (boundary === null) return refuse('no trustworthy encode boundary after the date');
const encodeToken = detached.tokens[boundary.encodeStart];
if (encodeToken === undefined) return refuse('no trustworthy encode boundary after the date');

const sceneText = prettify(rest.slice(0, suffixOffset(detached.tokens, boundary.titleEnd, rest)));
if (sceneText.length === 0) return refuse('no title between the date and the encode section');
if (sceneText.toUpperCase() === MARKER_TOKEN) return refuse('title is only the XXX marker');

const tail = rest.slice(encodeToken.start);
```

- [ ] **Step 7: Rewrite site 4 — `splitSegment`**

```ts
const boundary = findTitleBoundary(tokens, 0);
if (boundary !== null) {
  const encodeToken = tokens[boundary.encodeStart];
  if (encodeToken !== undefined) {
    quality.unshift(text.slice(encodeToken.start));
    text = text.slice(0, suffixOffset(tokens, boundary.titleEnd, text));
  }
}
```

- [ ] **Step 8: Run the new test and confirm green.** Then run `npm run check` and work through the existing failures one at a time, reading each before touching it.

- [ ] **Step 9: Pin the nine real mid-title cases**

The synthetic mid-title test above is not enough — the design requires the nine corpus titles that carry a content-type tag away from the end, because a rule that reached them would be deleting real title words. Extract them, then assert each one's title is unchanged.

Run this to list them, from the worktree root:

```bash
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
cat > packages/plugin-scenes/probe.ts <<'TS'
import { readFileSync, readdirSync } from 'node:fs';
import createScenesPlugin from './src/index.ts';
const plugin = createScenesPlugin({});
const DESC = new Set(['solo', 'hardcore', 'lesbian']);
const root = '/Users/cwalker/Projects/pickarr/';
const seen = new Set<string>();
for (const f of readdirSync(root).filter((x) => x.endsWith('.txt') || x.endsWith('-titles'))) {
  for (const line of readFileSync(root + f, 'utf8').split('\n')) {
    const n = line.trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    const r = plugin.parse(n);
    if (r === null) continue;
    const w = r.display.title.split(' ').filter(Boolean).map((x) => x.toLowerCase());
    const at = w.findIndex((x) => DESC.has(x));
    // A tag with a genuine title word after it, rather than trailing junk.
    if (at >= 0 && at < w.length - 1 && w.slice(at + 1).some((t) => !/^\d+$/.test(t) && t.length > 6)) {
      console.log(`${r.display.title}\n    ${n}`);
    }
  }
}
TS
node --import tsx --conditions development packages/plugin-scenes/probe.ts
rm packages/plugin-scenes/probe.ts
```

Add one assertion per title returned, of the same shape as the synthetic test in Step 2, using the raw release name as input and the parsed title as the expectation. Delete the probe file afterwards and confirm `git status` is clean of it. If the probe returns a different count than nine, report that rather than adjusting the design's number silently.

- [ ] **Step 10: Break it on purpose**

Revert site 3 alone to `findEncodeSuffixStart(detached.tokens, 1)` with `cut` used for both title and tail. Confirm the content-type tests fail. Revert. Paste the output.

- [ ] **Step 11: Commit.** Do not push.

---

### Task 6: Corpus validation

**Files:**
- No source changes. Report only, plus fixture updates if the corpus surfaces any.

The corpus harness is the tool this repo uses to judge parser changes, and it reports the three numbers that matter here.

- [ ] **Step 1: Record the before numbers**

From the merge base, before any of this branch's commits:

```bash
git stash list   # confirm nothing is stashed
git checkout "$(git merge-base origin/main HEAD)" -- packages/plugin-scenes/src/parse.ts
npm run corpus -- ../../uhd.txt ../../hd.txt ../../sd.txt
```

Save the parse rate per tier, the ranked refusal reasons, and the collision count. Then restore: `git checkout HEAD -- packages/plugin-scenes/src/parse.ts`.

The corpus files live at the project root, above the worktree: `uhd.txt`, `uhd2.txt`, `hd.txt`, `hd2.txt`, `sd.txt`, `sd2.txt`, `part1-titles`, `cd1-titles`. Confirm the paths before relying on them.

- [ ] **Step 2: Record the after numbers**

Same command on the branch as it now stands.

- [ ] **Step 3: Compare, and report each of these explicitly**

- **Parse rate per tier must not fall.** A drop means `findTitleEnd` consumed something `findEncodeSuffixStart` needed, and it is a finding, not a tuning opportunity.
- **No refusal reason may grow.** Report the full ranked list both ways.
- **The collision count must not grow.** A new collision is two distinct scenes landing on one identity key, which is the worst outcome this change could produce.
- **The release-group delta**, separately. `DUTCH` and `JAPANESE` joining `NON_GROUP_TERMS` changes detachment, so some names will now keep a group they previously lost or vice versa. That is expected; report the count and inspect a sample.

- [ ] **Step 4: Check the holdout**

```bash
npm run corpus -- ../../uhd.txt ../../hd.txt ../../sd.txt --holdout=0
```

Ten percent is held back by default, keyed on the title, and tuning against a set you also measure reports overfitting as progress. Report the holdout numbers separately from the main run.

- [ ] **Step 5: Report.** No commit unless a fixture changed.

---

## Notes for the controller

- **Task 5 is the only task that changes parser output**, and the only one where existing tests fail by design. Its Step 1 probe exists so the blast radius is known before any real work; read that report before approving the rest of the task.
- Tasks 1–4 are additive and independently verifiable with `npm run check`. Nothing is user-visible until Task 5.
- **Task 6 gates the branch, not a task.** If the corpus shows a parse-rate drop or a new collision, the branch is not ready regardless of how green the unit tests are.
- **This branch cannot merge without the re-key migration.** That is a separate spec and must land in the same release; §8 of the design explains why shipping this alone splits every affected scene across two groups and two library paths.
- The design's §6 deliberately applies the rule to the delimited-listing shape as well, where the corpus shows no content-type tags. If Task 6 surfaces a regression confined to that shape, the documented fallback is to scope the rule by shape rather than to weaken the rules.
