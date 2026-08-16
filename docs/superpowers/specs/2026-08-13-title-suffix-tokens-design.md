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
  the title, and is measured as such (§10). *Amended 2026-08-13: `POLISH` and `CZECH` too —
  see §5.*
- Corpus measurement of the change, per tier and against the holdout.
- *Amended 2026-08-13, final fix wave:* **the dateless shape**, which the first pass left
  computing a title bound it then discarded. Owner's decision, so that every key that will
  ever move moves in one re-key migration (§8, §10).

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

> **Amended 2026-08-13, during implementation. The order below is inverted from what this
> section originally specified, and the amendment is recorded rather than rewritten because
> the reason is worth keeping.**
>
> The original design walked backward from the end of the name over a predicate that
> included encode tokens, the `XXX` marker, and a release-group tag, and needed a bare-digit
> exclusion so sequel numbers survived. Wiring it revealed two defects, both caught by this
> repo's own invariant tests rather than by reasoning:
>
> - `Brazzers.23.04.15.Alex.Coal.XXX.2160p60.WEB-DL.H.265.10bit.HDR.DDP5.1.MP4-G` stopped
>   parsing. `DDP5.1` tokenizes to `DDP5` and `1`; the digit exclusion halted the walk at
>   that `1`, leaving the title boundary inside the encode run and starving the encode search
>   into returning `null`.
> - `PornMegaLoad.26.07.31.DD.White.Hardcore.42617.XXX.1080p.MP4-WRB` yielded the title `DD`
>   rather than `DD White`. `DD` is a Dolby Digital token, so `isEncodeToken('DD')` is true,
>   and the group-tag clause then ate `White` as group-shaped-after-an-encode-token.
>
> Both share one cause: those clauses used the *previous token* as a proxy for "am I inside
> the encode run", and the proxy is unreliable in both directions — title words can look like
> encode tokens, and encode runs contain bare digits.
>
> **The order is therefore reversed.** `findEncodeSuffixStart` runs *first* and remains the
> only authority on where the encode run begins; the new walk starts from *its* answer and
> considers only vocabulary. That deletes the encode clause, the marker clause, the group-tag
> clause and the digit exclusion outright — every one of them existed only to fight through a
> section the existing function already locates correctly.
>
> ```ts
> const encodeStart = findEncodeSuffixStart(tokens, minIndex);   // unchanged
> if (encodeStart === null) return null;                          // unchanged refusal
> const titleEnd = findTitleEnd(tokens, minIndex, encodeStart);   // vocabulary only
> ```
>
> `findTitleEnd` now takes the index to walk back *from*, and `isTitleSuffixToken` reduces to
> content type, language and numeric id. Everything below about the two indices diverging,
> about `extractQuality` being fed from `encodeStart`, and about tokens never being sliced
> still holds — only the order and the predicate's contents change.

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
is why the existing callers' values (`2`, `2`, `1`, `0`) carry over unchanged ~~and no
separate "never empty the title" special case is needed~~. `buildRelease` already refuses an
empty scene slug; this keeps the walk from producing one.

> **Amended 2026-08-13, during the final fix wave: the second half of that claim is wrong as
> stated, and a special case is exactly what it needed.** `minIndex` floors a *token index*,
> and the title does not start at token 0 — it starts after the site. `minIndex: 2`
> guarantees a non-empty title only while the site is one token. When a configured
> multi-token site reaches `minIndex` from the other side, the walk's floor and the site's end
> coincide and the trimmed title is empty. Measured by sweeping every 1–5-token leading prefix
> of every corpus title as a configured site — 48,941 (title, site-list) pairs — that happens
> for 19 titles.
>
> **The resolution is `titleEndOffsetAfterSite`, applied on a second pass once
> `matchSitePrefix` has run:** if the walk left nothing after the site, the suffix run *is*
> the title and the bound falls back to `encodeStart`. Two reasons it keeps the whole run
> rather than one token of it:
>
> - A title of `42466` or `FRENCH` is not a *wrong* answer. Nothing is invented — it is the
>   site's own catalogue id or its own tag, accurate and merely low on information — so the
>   "a wrong answer is worse than no answer" rule does not reach it, while refusing costs the
>   user a release to repair by hand. It is a poor term to ask ThePornDB and a perfectly
>   stable identity, and the metadata path records a near-miss rather than confirming a bad
>   match, so a lookup that fails on it costs nothing.
> - Keeping only the *first* remaining token merges two scenes.
>   `OF...Enokaeva_.128825778_456239169_720p` and `..._456239173_480p` share their first id
>   and differ in their second, so a one-token floor collapses them onto
>   `ofepart1ekaterinaenokaeva::128825778`. That pair is the only corpus case with more than
>   one token left after its site, and two distinct scenes on one key is the failure this
>   parser must never produce.
>
> Measured after the change: all 19 return to base's identity key exactly — same site slug,
> same title — and the sweep records 0 newly refused and 0 newly parsed pairs out of 48,941.
> The walk's answer is untouched wherever it leaves anything at all, which includes every
> unmatched site, where the fallback takes one token and the floor is the `2` it always was.

**Both functions must share one predicate for encode tokens.** If `findTitleEnd` and
`findEncodeSuffixStart` ever disagree about what an encode token is, the gap between the
two indices fills with tokens that reach `extractQuality`, and nothing says so. They both
call `isEncodeToken`.

## 5. The suffix-token rules

Tested in this order. A token consumed by any rule continues the walk; the first token
matching none of them ends it.

> **Amended 2026-08-13: rules 1 and 2 are deleted.** Under the inverted order in §4 the walk
> starts at the encode boundary rather than at the end of the name, so it never encounters an
> encode token, a release-group tag, or the `XXX` marker — `findEncodeSuffixStart` has already
> accounted for all three. Only rules 3, 4 and 5 remain, and the bare-digit exclusion that
> rule 1 required is gone with it. The two rules are kept below, struck through in prose, for
> the same reason the amendment in §4 is kept: the reasoning about `MARKER_TOKEN` being
> referenced rather than copied is still the right instinct, and issue #13 is still the
> precedent — it simply no longer needs applying here.

**~~1. Encode tokens and the optional group tag.~~** *Deleted — `findEncodeSuffixStart`
handles these.* Existing behaviour via `isEncodeToken`, unchanged.

**~~2. The `XXX` marker.~~** *Deleted — it is the boundary `findEncodeSuffixStart` returns,
so the walk begins after it rather than crossing it.* By reference to the existing `MARKER_TOKEN` constant, **not** by
adding `'XXX'` to any list. This clause is what makes the whole change work: `XXX` is
neither an encode token nor a boundary anchor — it has its own branch in
`findEncodeSuffixStart`, which returns *its* index as the cut. Without this clause the walk
stops dead at `XXX` and never reaches the id and the content-type tag behind it, which is
the majority of affected titles.

It is referenced rather than copied because issue #13 is the scar for the alternative:
`REMASTERED` was in the encode vocabulary and the non-group list at once, and refused 14
corpus titles.

**3. Content type** — `hardcore`, `solo`, `lesbian`. Matched case-insensitively. A named
set, held uppercase (`CONTENT_TYPE_TERMS`), sitting beside the parser's other vocabularies.

**4. Language** — `LANGUAGE_TERMS`, which is one half of a split `NON_GROUP_TERMS`, gated by
a casing rule (`isLanguageSuffixToken`, added after this section was first written — see its
own doc comment in `parse.ts` for the full measurement, summarized here since it is otherwise
undocumented outside a predicate's docstring).

`LANGUAGE_TERMS` membership alone is not the test: a language name is also a surname and an
adjective (`Britney Dutch`, `Perfect French Maid`), so the walk additionally requires **either**
of:

- **An inner capital** (`hasInnerCapital`: a capital anywhere but the first character, e.g.
  `GERMAN`, `iTALiAN`) — a release tag is conventionally shouted, a title word is not; or
- **The previous token is itself suffix vocabulary on its own merits** (checked with that
  token's own predecessor passed as `undefined`, so a title-case language cannot lend
  authority it does not have to the token behind it) — this is what keeps `Hardcore.Dutch`
  strippable even though `Hardcore` is title case.

Measured over the corpus: 141 occurrences of a language term, 89 with an inner capital and
every one a tag; of the 52 without one, the walk reaches exactly two genuine title words
(`Britney Dutch`, both real releases). Deliberately **not** extended to
`CONTENT_TYPE_TERMS` — the six `ClubSweethearts...Hardcore...` and
`...Remido.Solo...` releases this trimming exists to fix are title case, so a casing rule
there would undo the feature.

`NON_GROUP_TERMS` today mixes two kinds of thing under one question. It becomes the union
of two named halves, so its membership — and therefore release-group detachment — is
unchanged except for the ~~two~~ four additions below:

> **Amended 2026-08-13, final fix wave: `POLISH` and `CZECH` join the two below**, on the
> same evidence and after the same measurement. `POLISH` occurs three times in the corpus
> and is title-final in all three; `CZECH` occurs three times, title-final in two, and its
> third occurrence (`ALSScan.17.12.09.Czech.2017.Casting...`) is mid-title, where the walk
> stops at `Casting` and never reaches it. Both therefore behave exactly as `GERMAN` and
> `DUTCH` do. §10 records which languages were measured and *rejected*, which is the more
> useful half of this note.

```ts
const LANGUAGE_TERMS = new Set([
  'ENGLISH', 'FRENCH', 'GERMAN', 'SPANISH', 'ITALIAN', 'RUSSIAN', 'DUTCH', 'JAPANESE',
  'POLISH', 'CZECH',
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

~~All four `findEncodeSuffixStart` call sites move to the composer, so every parser shape is
covered by one boundary rule. That includes `splitSegment`, which serves the delimited
listing form.~~

> **Amended 2026-08-13, during implementation and again in the final fix wave. Three of the
> four call sites moved; `splitSegment` did not.** Moving it let the walk consume an entire
> listing part — `Hardcore` is itself a content-type term, so the walk crossed it and the
> numeric id behind it — and `[Site] Alex - Hardcore 42466 1080p - 2026-08-05` collapsed onto
> the same identity key as the same listing with `42467`. Two distinct scenes on one key is
> the one failure this parser must never produce, so `splitSegment` keeps the single
> `findEncodeSuffixStart` cut, exactly as the paragraph below said to do if the rule ever
> misfired there.
>
> **What that excludes is the code path, not the shape.** `splitSegment` is reached only when
> the listing's date carries a four-digit year; written `26.08.05` the same name matches
> `DOTTED_DATE_RUN`, the delimited reader declines, and the date-at-end shape reads it — where
> the walk does run. The two-digit spelling of the pair above *does* collapse onto
> `site:2026-08-05:alex`. That collision is inside the class `docs/known-issues.md` accepts
> (one site, one date, titles differing only in dropped tokens), so it is not a defect, but
> the earlier wording implied a guarantee the shape does not have. Both spellings are pinned
> by tests in `parse-date-at-end.test.ts`.
>
> The remaining three call sites each carry **two** indices rather than one: `before`, the run
> `matchSitePrefix` and `sceneSiteCandidates` read, reaches the encode boundary, while the
> title stops at `titleEnd`. Conflating them cost the date-at-end shape its site — see §10.

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
- ~~**Reaching the delimited shape is unmeasured**, because the corpus contains no
  content-type tags in that form. §6 records what to do if it misfires.~~

  > **Amended 2026-08-13: stale.** It misfired, it was measured, and the rule was scoped out
  > of `splitSegment` — see §6. What remains is not "unmeasured" but "excluded by code path":
  > a listing whose date has a two-digit year never reaches `splitSegment` and does get the
  > walk. That is pinned by a test rather than left as a note.

- **The two indices are easy to confuse, and confusing them corrupts the site.** `encodeStart`
  bounds what site matching may read; `titleEnd` bounds the title text. `matchSitePrefix`
  never consumes every token it is given, so a `before` cut down to `titleEnd` cannot match a
  site that spans the dropped tokens — the site silently degrades to the release's first word
  and takes the library directory with it. That happened in the date-at-end shape and was
  caught in review, not by the corpus: **the gate ran with no site list at all** (see the
  harness bullet below), so the site was a first-token guess before and after and no number
  could move. The real corpus name that exhibits it is
  `clubseventeen_tiny-teen,eva-elfie_solo-2160p-19.05.08` with
  `clubseventeen tiny teen,eva elfie` configured: base and the fix read the four-token site,
  the intermediate branch ignored it entirely. Both indices are now carried explicitly in
  `DateAtEnd` and `DatelessPrefix`, and the offset field is named `titleEndOffset` so it
  cannot be mistaken for `TitleBoundary.titleEnd`, which is an index.

- **An empty title is possible after all, and the suffix becomes the title when it happens.**
  See the amendment in §4 for the rule and the measurement. Both call sites that run the walk
  against a *matched* site need it — the date-at-end shape and the dateless shape. The others
  are safe by construction and were checked rather than assumed: the dotted shape walks only
  the post-date run, which holds no site tokens at all; the mid-name-date branch of the
  date-at-end shape and the no-boundary dateless path run no walk; `splitSegment` is scoped
  out. Every one of them was probed with a configured site covering everything but the suffix,
  and every one returned a non-empty title.

- **The corpus gate could not see the site half of the parser, and that is why the Critical
  survived it.** `scripts/parse-corpus.ts` passed `sites: []` unless `--sites=` was given by
  hand, and no run on this branch gave it — so `matchSitePrefix`, `consumeSiteTld` and every
  multi-token site name were never executed by the measurement that gated the change. The
  harness now measures the corpus twice by default: once with the configured list, once with
  the site names the first pass produced (`--no-learned-sites` to skip), and reports how many
  identity keys and site segments move between them. A gate that cannot execute the logic
  under test is a defect in the gate.

- **`THAI` and `ARABIC` were measured and rejected**, and this is the note that says so, so
  that "they are languages too" does not read as an oversight. `May Thai` is title-final in
  `MorePOV.26.07.23.Alexa.Flexy.Geisha.Kyd.And.May.Thai.XXX...` and so is the `Thai` of
  `ThaiSwinger.26.07.22.Tuk.Brilliant.Thai.XXX...`; `Sarah Arabic` appears in three corpus
  scenes. In this domain both words are performer names far more often than they are
  languages, so admitting them truncates real titles — the failure this whole vocabulary
  split exists to avoid. They belong beside `ENGLISH` and `RUSSIAN` as the entries to suspect
  first, except that these two never get in at all.

- **The dateless shape is in scope, as of the final fix wave.** §2 originally left it out.
  `parseDatelessForm` bounded its title at the encode boundary, so `titleEnd` was computed and
  discarded and the feature's own motivating example — `TripForFuck.Hiyori.Suzuki.Solo.42466`
  — was unfixed there on this branch *and* on its base. The repo owner's decision was to fix
  it now rather than later, so that every key which will ever move moves in one re-key
  migration. It widens the over-collation `parseDatelessForm` already documents: a dateless key
  has an empty date segment, and two dateless scenes differing only in dropped tokens now
  collate. The no-encode-boundary path inside that shape keeps its whole remainder as the
  title and deliberately does not run the walk, because what licenses the walk elsewhere is
  adjacency to a recognised encode section and there is none there.
- **The 250 threshold is empirical.** A site numbering scenes from 1 to 249 would keep its
  ids; a site with a genuine 250th part would lose it. Neither appears in 6,388 titles.
