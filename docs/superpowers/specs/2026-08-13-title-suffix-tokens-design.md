# Title suffix tokens — Design

Date: 2026-08-13
Status: approved for planning
Branch: `title-suffix-tokens`
Prerequisite: the re-key migration, specified separately. **This change cannot merge
without it** — see §8.

## 1. What this adds

The parser currently ends a scene title at the encode section, and keeps everything before
it. Some sites append tokens there that are not title words: a content-type tag, a CMS id,
a language. They reach `display.title`, and from there the identity key, the library path,
and the query a metadata lookup sends.

The visible cost is metadata: a group whose title reads `Suki Sin Solo 42466` asks
ThePornDB about a scene by that name, finds nothing, and is answered `none` — permanently,
because a stored answer is never re-asked. The invisible cost is collation: two sites can
spell one scene's trailing run differently, and the key moves with it.

This adds `findTitleEnd`, which walks the trailing tokens and stops at the first one that
could be a title word. `findEncodeSuffixStart` keeps its existing job of locating the
encode section, now within the suffix that walk produced.

## 2. Scope

In scope:

- `findTitleEnd`, and a composer that returns both boundaries.
- Five suffix-token rules: encode tokens and group (existing), the `XXX` marker, content
  type, language, and numeric ids.
- **Splitting `NON_GROUP_TERMS` into a language half and a non-language half**, with
  `NON_GROUP_TERMS` becoming their union so its membership is unchanged, and the language
  half serving as the suffix candidates (§5).
- **Adding `DUTCH` and `JAPANESE`** to the language half, which puts them in
  `NON_GROUP_TERMS` for the first time. That changes release-group detachment as well as
  the title, and is measured as such (§10).
- Corpus measurement of the change, per tier and against the holdout.

Out of scope:

- **Re-keying existing groups.** Moving the boundary changes the identity key, so every
  affected group already in a database keys differently after this change. That migration
  is its own spec, and this one cannot ship without it (§8).
- Any token class not measured below. The rules are drawn from the corpus, not from
  imagination.

## 3. What the corpus says

Measured with the shipped parser over the eight corpus files, 6,388 unique titles that
currently parse. Every number below is from that run, not from a regex over raw names.

**Re-validated after the corpus grew.** `db-2026-08-13.txt` adds 925 titles taken from a
live instance's `feed_items`, bringing the corpus to 10,359 distinct names and 7,166 that
parse. Every rule below survives unchanged and the ratios are stable — a content-type tag
last rises 82 → 106, behind trailing junk 128 → 150, a title ending in a language 25 → 60,
numbers kept below the threshold 206 → 298, numbers dropped as ids 103 → 141, the year
carve-out saving 2 → 3 titles and the ordinal carve-out 1 → 1. The tables in this section
keep their original denominator so their arithmetic stays internally consistent; treat the
counts as *at least* these, not as exact against the larger corpus.

The one number that is not stable is the mid-title count, because classifying a tag as
"mid-title" rather than "behind trailing junk" depends on where the junk threshold is drawn,
and it reads 9 or 2 for two defensible choices. The implementation extracts the real list
with a fixed rule rather than trusting either figure (§7).

**Content-type tags** — `hardcore`, `solo`, `lesbian`:

| Position in the parsed title | Count |
|---|---|
| Final word | 82 |
| Followed only by an id or a short tag | 128 |
| Genuinely mid-title, must be left alone | 9 |

The 128 are the reason a rule anchored on "final word" is not enough: it would reach 37%
of the affected titles. They look like `Suki Sin Solo 42466`, `DD White Hardcore 42617`,
`Alessandra Sweet Hardcore DUTCH`.

**Trailing all-numeric tokens** — 312 titles end in one:

| Value | Count | What they are |
|---|---|---|
| `< 10` | 190 | sequel and part numbers — `Sarasota 4`, `Menu 2` |
| `10`–`99` | 16 | same |
| `250`–`1899` | 5 | mixed; includes one real episode number |
| `1900`–`2099` | 2 | years |
| `>= 2100` | 99 | CMS ids — `42466`, `42600`, `42617` |

A flat `>= 250` threshold drops 106 and is correct on 103. The three it gets wrong are
the ones the carve-outs in §5 exist for:

```
Violet Voss Episode 466              ← a real episode number
Gianna Dior TOTM March 2020          ← a year
Jordan Maxx Cake S01 E01 Carried Away 2021
```

`Episode 466` is the dangerous one. Truncating it to `Violet Voss Episode` does not merely
lose a word; it collides with episode 467 if a site ever posts two on one date.

**Languages** — of the sixteen language terms in or added to `NON_GROUP_TERMS`, seven occur
title-final: `GERMAN`, `DUTCH`, `SPANISH`, `FRENCH`, `ITALIAN`, `JAPANESE`, `JAP`. Every
observed occurrence is a genuine tag, not a title word:

```
Maria Gail GERMAN            Krystal Genner SPANISH
Mia Wallace FRENCH           Orgia Balorda iTALiAN        ← an Italian-language release
Rina D JAPANESE              Minori Kamiyama Rispetto 1 JAP
Alessandra Sweet Hardcore DUTCH
```

They are their own class rather than descriptor-adjacent noise — `Maria Gail GERMAN` and
`Rina D JAPANESE` carry no content-type tag at all.

Three points the samples settle. `iTALiAN` is spelled mixed-case, so case-insensitive
matching is load-bearing rather than tidy. `Rispetto 1 JAP` is the compound case: the walk
crosses `JAP`, then stops at `1` because it is under the numeric threshold. And `ENGLISH`
and `RUSSIAN` never appear title-final at all, along with `ENG`, `FRA`, `GER`, `ESP`, `ITA`,
`JPN` — they are included for consistency with the class, not because a measurement asked
for them (§10).

**The non-language half must not be suffix candidates**, and the corpus says so outright.
Three of its entries appear title-final, and in every case as a real title word:

```
Alaina Dawson Compilation    Best Blowjobs Compilation
Jessica Jans Bonus Scene     Leona Mia Beauty In Full
```

`Beauty In Full` truncating to `Beauty In` is the shape of the damage a single undivided
list would do. This is the measurement behind §5's split.

**Two safety checks**, run over raw names with a cruder splitter than the parser's, so
approximate — stated as such rather than presented as exact:

- Stripping a trailing content-type tag merged **0** pairs of genuinely different titles on
  one site and date.
- **0** cases where both `X Solo` and a bare `X` exist on one site and date, so nothing
  currently split gets joined. Sites apply these tags consistently.

The second number is why the collation argument for this change is weak on today's data,
and the metadata argument is the strong one. The collation value is prospective: it makes
the key immune to a site changing its tagging convention, which is the failure `learnSites`
already caused once for site names.

## 4. `findTitleEnd`, and the composition

`findEncodeSuffixStart` already opens with the walk this needs:

```ts
let runStart = tokens.length;
while (runStart > minIndex && isEncodeToken(tokens[runStart - 1]?.text ?? '')) runStart -= 1;
```

`findTitleEnd` is that loop with a wider predicate. It returns the index at which the title
ends; everything from there to the end of the tokens is suffix.

```ts
function findTitleEnd(tokens: Token[], minIndex: number): number;
function findTitleBoundary(
  tokens: Token[],
  minIndex: number,
): { titleEnd: number; encodeStart: number } | null;
```

**The composer returns both indices, because they are no longer the same number.** Today
one `cut` serves as both the end of the title and the start of the encode section. Once
dropped tokens sit between them they diverge, and each caller needs both: the title text is
`tokens[0..titleEnd)`, while `extractQuality` must be fed from `encodeStart`.

That second half is not tidiness. Issue #12 records that one unknown encode word refuses a
whole name, so handing `extractQuality` a haystack containing `Solo 42466` can refuse names
that parse today.

**`findEncodeSuffixStart` is unchanged, and receives `titleEnd` as its `minIndex`.** That
parameter already means "the first index the cut may fall on", so the composition needs no
new concept:

```ts
const titleEnd = findTitleEnd(tokens, minIndex);
const encodeStart = findEncodeSuffixStart(tokens, titleEnd);
if (encodeStart === null) return null;   // the existing refusal path, unchanged
return { titleEnd, encodeStart };
```

**Tokens are passed whole, never sliced.** Callers cut the original name string with
`token.start` offsets — `prettify(name.slice(firstSceneToken.start, identityEnd))`. Slicing
the array would shift indices while those offsets stayed absolute, which corrupts silently.

**`minIndex` guards the title.** It is what keeps the walk from consuming everything, which
is why the existing callers' values (`2`, `2`, `1`, `0`) carry over unchanged and no
separate "never empty the title" special case is needed. `buildRelease` already refuses an
empty scene slug; this keeps the walk from producing one.

**Both functions must share one predicate for encode tokens.** If `findTitleEnd` and
`findEncodeSuffixStart` ever disagree about what an encode token is, the gap between the
two indices fills with tokens that reach `extractQuality`, and nothing says so. They both
call `isEncodeToken`.

## 5. The suffix-token rules

Tested in this order. A token consumed by any rule continues the walk; the first token
matching none of them ends it.

**1. Encode tokens and the optional group tag.** Existing behaviour via `isEncodeToken`,
unchanged.

**2. The `XXX` marker.** By reference to the existing `MARKER_TOKEN` constant, **not** by
adding `'XXX'` to any list. This clause is what makes the whole change work: `XXX` is
neither an encode token nor a boundary anchor — it has its own branch in
`findEncodeSuffixStart`, which returns *its* index as the cut. Without this clause the walk
stops dead at `XXX` and never reaches the id and the content-type tag behind it, which is
the majority of affected titles.

It is referenced rather than copied because issue #13 is the scar for the alternative:
`REMASTERED` was in the encode vocabulary and the non-group list at once, and refused 14
corpus titles.

**3. Content type** — `hardcore`, `solo`, `lesbian`. Matched case-insensitively. A named
set, held lowercase, sitting beside the parser's other vocabularies.

**4. Language** — `LANGUAGE_TERMS`, which is one half of a split `NON_GROUP_TERMS`.

`NON_GROUP_TERMS` today mixes two kinds of thing under one question. It becomes the union
of two named halves, so its membership — and therefore release-group detachment — is
unchanged except for the two additions below:

```ts
const LANGUAGE_TERMS = new Set([
  'ENGLISH', 'FRENCH', 'GERMAN', 'SPANISH', 'ITALIAN', 'RUSSIAN', 'DUTCH', 'JAPANESE',
  'ENG', 'FRA', 'GER', 'ESP', 'ITA', 'RUS', 'JAP', 'JPN',
]);

/** Not languages, and — unlike languages — capable of being title words. */
const NON_GROUP_EDIT_TERMS = new Set([
  'SUB', 'SUBS', 'SUBBED', 'DUBBED', 'UNCUT', 'UNRATED', 'EXTENDED', 'DIRECTORS',
  'UNCENSORED', 'DIRECTORSCUT', 'COMPILATION', 'REMUX', 'PART', 'PT', 'CD', 'DISC',
  'SCENE', 'FULL', 'HQ', 'LQ',
]);

const NON_GROUP_TERMS = new Set([...LANGUAGE_TERMS, ...NON_GROUP_EDIT_TERMS]);
```

Only `LANGUAGE_TERMS` is a suffix candidate. **The other half must never be**, and that is
measured rather than assumed: `COMPILATION`, `SCENE` and `FULL` all occur title-final as
genuine title words (§3), so a single undivided list would turn `Beauty In Full` into
`Beauty In`. The existing comment on the set already says why for a different reason —
*"Each names a different cut or different content, which is why detaching one as a group
would merge two things that are not the same scene"* — and dropping `UNCUT` from a title
merges the uncut and the standard cut, exactly the merge that comment exists to prevent.

`DUTCH` and `JAPANESE` are new to the union and therefore new to `NON_GROUP_TERMS`. That
is a fix — a release ending in either could previously have it detached as a release group,
merging two language cuts — but it is also a behaviour change beyond the title, and §10
records it as one.

`SUB`, `SUBS`, `SUBBED` and `DUBBED` stay on the non-language side deliberately. They are
about a language rather than being one, they are unobserved title-final, and a dub is
arguably a different thing from the original audio — so there is no evidence to justify
dropping them and a plausible reason not to.

**5. All-numeric tokens `>= 250`**, with two carve-outs:

- **Not `1900`–`2099`.** Those read as years, and two corpus titles need it.
- **Not directly preceded by an ordinal word** — `episode`, `part`, `vol`, `scene`. This
  saves `Violet Voss Episode 466` from truncation and from colliding with episode 467.

The threshold is `250` because sequel numbers are small and ids are large: the corpus has
206 trailing numbers below 250, every one of them a sequel or part number, and 99 at or
above 2100, every one an id. Nothing has 250 sequels.

Leading zeros are id-shaped — `Michala 0279` — and `Number('0279')` is `279`, so they fall
on the drop side without a special case.

## 6. What each shape gets

All four `findEncodeSuffixStart` call sites move to the composer, so every parser shape is
covered by one boundary rule. That includes `splitSegment`, which serves the delimited
listing form.

The delimited form is worth naming as an asymmetry rather than left implicit. Its title is
a set of parts with no fixed order — `sceneSlugFromParts` sorts them precisely because
trackers put performer and title on either side of each other — so "trailing" describes the
order the uploader happened to use, which the key deliberately discards. The corpus shows
no content-type tags arriving in that shape at all. Covering it anyway costs nothing
measurable and keeps one rule rather than two; if it ever misfires there, the fix is to
scope the rule by shape, and this paragraph is the note that says so.

## 7. Testing

- **Unit, `findTitleEnd`:** each rule in isolation; each carve-out; the walk stopping at
  `minIndex`; a token matching no rule ending the walk immediately.
- **Unit, the composer:** that `titleEnd <= encodeStart` always; that `extractQuality`
  receives nothing from between them. A test that fails if the two functions are given
  different encode predicates.
- **The three false positives by name** — `Violet Voss Episode 466`,
  `Gianna Dior TOTM March 2020`, `Jordan Maxx Cake S01 E01 Carried Away 2021` — asserted to
  keep their trailing token. These are the cases the carve-outs exist for; without them as
  tests the carve-outs are unpinned.
- **The nine mid-title cases** asserted unchanged, since a rule that reached them would be
  removing real title words.
- **`XXX` crossing:** `Suki.Sin.Solo.42466.XXX.1080p.MP4-WRB` parses to title `Suki Sin`,
  and `extractQuality` sees no `Solo` and no `42466`. This is the end-to-end case for §5's
  second rule; if it passes with the `MARKER_TOKEN` clause removed, the clause is unpinned.
- **The split is behaviour-preserving for groups:** a test asserting `NON_GROUP_TERMS` still
  contains every term it did before, so the refactor cannot silently drop one. The two
  additions are asserted separately, as additions.
- **Case-insensitivity, by the corpus's own spelling:** `Orgia Balorda iTALiAN` must lose
  its tag. A rule that matched only uppercase would pass every other language test.
- **The non-language half is not a suffix candidate:** `Leona Mia Beauty In Full`,
  `Alaina Dawson Compilation` and `Jessica Jans Bonus Scene` keep their final word. These
  are the cases the split exists for, and without them it is unpinned.
- **Corpus, before and after:** `npm run corpus` over all tiers. Parse rate must not fall;
  refusal-reason counts must not grow; the collision count must not grow. Report the
  release-group delta too, since `DUTCH` and `JAPANESE` joining `NON_GROUP_TERMS` changes
  detachment. Then a run with `--holdout=0` to check the held-back tenth, because tuning
  against a set that is also measured reports overfitting as progress.
- **Every mutation verified by reverting it** and confirming the specific test fails.

## 8. The re-key prerequisite

`sceneSlug` is `slug(sceneText)`, and `sceneText` is what `titleEnd` bounds. So this change
moves the identity key for the affected titles, and with it the library path, since
`path-template.ts` derives every value from the key.

A database that has ingested those scenes keys them the old way. After this change the same
scene arriving again keys the new way, so it forms a second group — issue #39's failure
class — and its imports land on a different path than its older siblings.

**Therefore the re-key migration must land in the same release.** The two specs are
separate because they are separate pieces of work with different risks, not because they
can ship apart. The migration will need a frozen copy of the vocabularies here, as
migration 4 froze the site-slug rule rather than importing the plugin: a migration
describes a transformation of data as it was at that version, and importing live code would
let a later edit change what an applied migration meant.

It will also need to clear metadata for every group it merges, per the invariant recorded
in `docs/known-issues.md` — unlike migration 4, a migration numbered after 6 runs in a
database where the metadata tables exist.

## 9. What this fixes, stated plainly

Of the 219 titles carrying a content-type tag, 210 have it in the trailing run and become
askable; 9 are mid-title and are deliberately untouched. Separately, 103 titles shed a
trailing numeric id — 99 of them ids of the `42xxx` shape, 4 ambiguous but id-shaped — and
25 shed a language, whether or not they also carry a content-type tag.

It does not join any group that is currently split — the corpus has no such case. The
collation benefit is prospective, not present.

## 10. Known risks

- **New refusals.** `findEncodeSuffixStart` returns `null` when nothing recognisable
  remains, and callers refuse on that. A longer suffix should make that less likely, not
  more, but the direction is an assumption and the corpus run in §7 is what tests it.
- **Adding `DUTCH` and `JAPANESE` changes release-group detachment**, not just titles. A
  release ending in `-DUTCH` previously had `DUTCH` detached as a release group; now it will
  not. That is the intended fix — detaching it merges two different language cuts — but it
  is a second behaviour change riding along with this one, and the corpus run in §7 must
  report the group-detachment delta separately rather than only the parse rate.
- **Six language terms are unobserved title-final.** `ENGLISH`, `RUSSIAN`, `ENG`, `FRA`,
  `GER`, `ESP`, `ITA` and `JPN` never appear there in 6,388 titles. They are included
  because they are languages and the class is what the rule is about, not because a
  measurement asked for them. `ENGLISH` and `RUSSIAN` are the two that are also ordinary
  English adjectives, so if a title is ever wrongly truncated, those are the likely
  entries — and the fix is to drop them from the suffix half while leaving them in the
  union, which the split makes a one-line change.
- **The ordinal carve-out is a list.** `episode`, `part`, `vol`, `scene` are the words
  observed; another site's `chapter` or `ep` would truncate. Same maintenance cost
  `stripPosterSignature` names for its observed-posters list, and the same reason: a
  structural rule was not available.
- **Reaching the delimited shape is unmeasured**, because the corpus contains no
  content-type tags in that form. §6 records what to do if it misfires.
- **The 250 threshold is empirical.** A site numbering scenes from 1 to 249 would keep its
  ids; a site with a genuine 250th part would lose it. Neither appears in 6,388 titles.
