# Release-name parser rewrite: the date is the boundary

`packages/plugin-scenes/src/parse.ts`, rewritten. Tests:
`packages/plugin-scenes/test/parse-corpus.test.ts` (new, 17 tests);
`packages/plugin-scenes/test/parse.test.ts` (unchanged, still passing).

No file outside `packages/plugin-scenes` was touched. `plan-import.ts` did not
need to change: the identity shape is still exactly
`slug(site) ":" ISO-date ":" slug(scene)`, three fields, slugs restricted to
`[a-z0-9-]`, which is what keeps `titleCaseSlug` injective and
`identityKey.split(':')` well-defined. A corpus invariant now pins that shape
directly.

## 1. The boundary rule, and why it is correct in general

**The date is the anchor. Everything before it is the site; everything after
it is the scene plus its encode suffix.**

### Why the old rule could not be patched

The previous parser found the identity/encode boundary by locating an `XXX`
marker. `XXX` is a *word*, drawn from the same character stream as the title,
and it occurs in three roles that are locally indistinguishable: as the marker,
as a title word (`Anniversary XXX Edition`), and as a release-group name
(`...MP4-XXX`). A rule of the form "find the marker" therefore has as many
candidate boundaries as the word has occurrences, and **no local test can
separate them**: whatever property the true marker has — being last, being
followed by an all-encode tail, being followed by a resolution — an in-title
occurrence can be given the same property by an adversarial (or merely
ordinary) release name. That is why three fix rounds each relocated the bug
instead of closing it, and why each was justified by a passing case list rather
than by an argument.

### Why the date closes it

The date is not a member of a vocabulary. It is recognised by **arithmetic** —
a run of digits that forms a valid calendar date — not by lookup. Three
consequences follow, and together they are the correctness argument:

1. **No title word can impersonate it.** Vocabulary rules fail because the
   vocabularies overlap; `Tushy` is both a studio and a plausible title word,
   `Web`/`MP4`/`4K` are both encode tokens and title words. Nothing in an open
   vocabulary is also a valid calendar date, so the recogniser cannot be fooled
   by content. Conversely it cannot rot: adding a studio, a codec or a group to
   the world does not add a date-shaped string.

2. **The site half of the identity needs no judgement at all.** Site = the text
   preceding the date. There is no table, no heuristic, and therefore no way to
   get it wrong for a name that has a date. This is what fixes
   `www.site.com - Brazzers...`: with the prefix stripped in preprocessing, the
   pre-date text is `Brazzers` whether or not the prefix was there.

3. **The encode search becomes local and bounded.** It runs only over the
   post-date region, so it can never walk backwards into the site. A studio
   named `4K Media` or `WebYoung` is now structurally unreachable by an encode
   rule (corpus rows 59-60), and a mistake in the encode boundary can no longer
   relocate the site — under the old whole-name scan it could.

### The remaining boundary, and why *it* is safe

Inside the post-date region the title/encode split is still needed, because the
identity contains the title. That boundary is found by a **suffix** rule rather
than a marker rule: the encode section is structurally a trailing run, and a
suffix has exactly one start, so there is no candidate to choose between. The
backward walk over encode-vocabulary tokens finds the run; the cut is placed

- at the `XXX` marker when one sits immediately before the run — and because
  `XXX` is never itself an encode token, the backward walk *cannot pass through
  a marker*, so the one found there is necessarily the last one in the name and
  any in-title `XXX` is shielded by it; a group named `XXX` has already been
  detached, so it cannot be mistaken for the marker either;
- otherwise at the earliest **boundary anchor** (a resolution or an explicit
  source — tokens implausible as title words) *inside* the run. Cutting at the
  anchor rather than at the start of the run is what preserves `Girls Of Web`
  and `Episode 2 4K`: the weak tokens `Web` and `2` stay in the title because
  no anchor precedes them;
- and nowhere otherwise — the name is refused.

### The property

The identity is `slug(pre-date text) : ISO date : slug(post-date text minus an
encode suffix)`. Two names collide only if all three fields agree. Fields one
and two are exact: no vocabulary is consulted for the site, and the date is
self-verifying. So **a collision requires two post-date regions that differ
only inside a suffix which (a) reaches the end of the name, (b) consists
entirely of closed-vocabulary encode tokens, and (c) is introduced by the `XXX`
marker or by a resolution/source anchor.** "Differs only in trailing encode
tokens" *is* the definition of "two encodes of one release" — so the rule
collapses exactly the set it is meant to collapse, and nothing else.

The residual class is a scene whose genuine title *ends* in an
anchor-introduced run of encode words. The parser does not guess there; it
refuses whenever the run is interrupted, which is why
`Site.23.04.15.The.1080p.Club.MP4-G` returns `null` rather than
`the`/`the-1080p-club`/`the-1080p`. That is the whole reason the accepted-null
set below is non-empty, and it is the deliberate trade: refusing is visible,
over-collating is not.

## 2. Preprocessing

Three passes run before shape recognition, each with a stated guard against
eating real content:

- **Website prefix.** `www.x.com - `, `[x.com] `, `(x.com) - `, and
  `www.x.com.`. A domain alone is not enough — an unambiguous delimiter is also
  required — so a studio whose own name ends in a TLD-like word
  (`Tushy.com.23.04.15...`, corpus row 61) keeps it. The domain's label
  repetition is **lazy**: `xxx` is a real TLD *and* the marker token, so a
  greedy domain happily swallowed
  `www.Site.com.Brazzers.23.04.15.Alex.Coal.XXX.` and called it a prefix. This
  was found by the corpus, not by inspection.
- **Trailing media file extension.** An extension is by definition appended
  *after* a complete release name, so what precedes it is that name's last
  element: a group tag or the encode section. When the preceding token is
  neither — `Site.23.04.15.Alex.Coal.XXX.WMV` — the trailing token is the
  container the name itself states, and stripping it would discard the only
  quality information present. So the strip is conditional on that test.
- **Dot-attached release group.** Accepted only when the preceding token is
  encode information (a group can only follow a complete encode section) and
  the token has a group's shape: 2-8 alphanumerics, containing a letter, in
  caps, not a codec/source/container/language/edit term. The caps requirement
  is load-bearing: it keeps `.Uncut` and `.Directors` out, because merging two
  edits of a scene is the over-collation this component may not commit.

Separators are normalised for the quality tables by rewriting `_` to `.`
(retained from the prior fix — `\b` does not match beside `_`), and the release
group is now recovered **structurally from the token stream** rather than by a
regex over the tail. That is separator-blind by construction and also fixes a
latent bug in the old regex, which read `releaseGroup: "DL"` out of a name
ending in `WEB-DL`.

## 3. Shapes

Two recognisers, tried in order; the delimited one declines immediately unless
the name is bracketed or contains a ` - ` delimiter, so the dotted path is
unaffected by its presence.

- **Dotted scene form** — `Site<sep>DATE<sep>Rest`. The date is found by
  scanning tokens left to right for the first *valid* calendar date in any of
  `YY.MM.DD`, `YYYY.MM.DD`, `YYMMDD`, `YYYYMMDD`. Token index 0 is skipped
  because a date there leaves no site.
- **Delimited listing form** — an optional `[Studio]` prefix plus ` - `
  segments. The date may be a whole segment (`19-07-2023`, `2023-07-22`) or sit
  inside one, including parenthesised and written out (`(June 24, 2025)`). ISO
  order is tried first because it is unambiguous; the remaining numeric form is
  read day-first. A day/month transposition can only ever *split* a group,
  never merge two scenes, so guessing there sits on the safe side of the
  asymmetry.

## 4. Component ordering in the listing form — decision

The listing shapes put performers and title on either side of each other
depending on the tracker: `[Vixen] DATE - Alex Coal - Beautiful Episode` versus
`[Tushy] Beautiful Episode - Alex Coal - DATE`. **I normalise: the identity
slug is built from the *sorted* component slugs, while the display title keeps
source order.**

Reasoning, recorded as asked:

- Preserving order under-collates every time one site is scraped by two
  indexers with different layouts. That under-collation is *silent* — the user
  sees two cards that look identical and cannot tell which has the better
  encode — which is the worst kind of acceptable failure.
- Sorting cannot raise collision risk the way word-level normalisation would.
  It reorders **whole components and never merges them**: two scenes that share
  a performer still differ in their title component, and the sorted join of a
  different multiset is a different string. Pinned by a test: two Tushy scenes
  on one day sharing `Alex Coal` keep different keys.
- For two distinct scenes to collide, one site would have to publish, on one
  day, two scenes whose component multisets are exact permutations of each
  other. Those are the same scene.
- Bonus, not relied on: because the join is over sorted slugs, a listing form
  can coincide with the dotted form for the same scene rather than being
  guaranteed to differ.

Note the two examples in the brief are *both* already sorted —
`alex-coal-beautiful-episode` and `a-costly-divorce-sarah-arabic-lily-labeau`
differ in apparent order only because they sort differently, not because the
layouts leak through.

## 5. Corpus

62 rows. `new?` marks a shape the previous parser refused or mis-parsed.
Rows sharing a scene are asserted to share a key; rows of different scenes are
asserted never to. Generated from the test table by running the parser.

| # | Input | identityKey | title | new? |
|---|-------|-------------|-------|------|
| 1 | `Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` |  |
| 2 | `Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` |  |
| 3 | `Brazzers.23.04.15.Alex.Coal.XXX.2160p60.WEB-DL.H.265.10bit.HDR.DDP5.1.MP4-G` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` |  |
| 4 | `brazzers 23 04 15 alex coal XXX 1080p MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `alex coal` |  |
| 5 | `Brazzers_23_04_15_Alex_Coal_XXX_1080p_MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` |  |
| 6 | `Brazzers-23-04-15-Alex-Coal-XXX-1080p-MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex-Coal` |  |
| 7 | `Brazzers.2023.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` |  |
| 8 | `www.site.com - Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | **new** |
| 9 | `[www.pornsite.net] Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | **new** |
| 10 | `www.Site.com.Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | **new** |
| 11 | `Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB.mp4` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | **new** |
| 12 | `Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP.mkv` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | **new** |
| 13 | `Blacked.20180428.Alex.Coal.XXX.1080p.MP4-KTR` | `blacked:2018-04-28:alex-coal` | `Alex Coal` | **new** |
| 14 | `Blacked.180428.Alex.Coal.XXX.1080p.MP4-KTR` | `blacked:2018-04-28:alex-coal` | `Alex Coal` | **new** |
| 15 | `Blacked.18.04.28.Alex.Coal.XXX.2160p.HEVC.MP4-KTR` | `blacked:2018-04-28:alex-coal` | `Alex Coal` |  |
| 16 | `Tushy.24.01.09.Emily.Willis.XXX.1080p.HEVC.x265.PRT` | `tushy:2024-01-09:emily-willis` | `Emily Willis` | **new** |
| 17 | `Tushy.24.01.09.Emily.Willis.XXX.2160p.HEVC.x265.PRT` | `tushy:2024-01-09:emily-willis` | `Emily Willis` | **new** |
| 18 | `Tushy.24.01.09.Emily.Willis.XXX.1080p.HEVC.x265-PRT` | `tushy:2024-01-09:emily-willis` | `Emily Willis` |  |
| 19 | `SexBabesVR.23.04.15.Alex.Coal.XXX.1080p.VR.MP4-G` | `sexbabesvr:2023-04-15:alex-coal` | `Alex Coal` | **new** |
| 20 | `SexBabesVR.23.04.15.Alex.Coal.XXX.2160p.VR.SBS.MP4-G` | `sexbabesvr:2023-04-15:alex-coal` | `Alex Coal` | **new** |
| 21 | `[Vixen] 19-07-2023 - Alex Coal - Beautiful Episode 2160p {SLUT}` | `vixen:2023-07-19:alex-coal-beautiful-episode` | `Alex Coal - Beautiful Episode` | **new** |
| 22 | `[Vixen] Beautiful Episode - Alex Coal - 2023-07-19 - 1080p` | `vixen:2023-07-19:alex-coal-beautiful-episode` | `Beautiful Episode - Alex Coal` | **new** |
| 23 | `[Vixen] 19.07.2023 - Alex Coal - Beautiful Episode [1080p]` | `vixen:2023-07-19:alex-coal-beautiful-episode` | `Alex Coal - Beautiful Episode` | **new** |
| 24 | `[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 1080p` | `tushy:2023-07-22:alex-coal-beautiful-episode` | `Beautiful Episode - Alex Coal` | **new** |
| 25 | `[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 2160p HEVC` | `tushy:2023-07-22:alex-coal-beautiful-episode` | `Beautiful Episode - Alex Coal` | **new** |
| 26 | `[Tushy] Different Episode - Alex Coal - 2023-07-22 - 1080p` | `tushy:2023-07-22:alex-coal-different-episode` | `Different Episode - Alex Coal` | **new** |
| 27 | `Pure Taboo - Sarah Arabic, Lily LaBeau - A Costly Divorce (June 24, 2025) [1080p HEVC x265]` | `pure-taboo:2025-06-24:a-costly-divorce-sarah-arabic-lily-labeau` | `Sarah Arabic, Lily LaBeau - A Costly Divorce` | **new** |
| 28 | `Pure Taboo - A Costly Divorce - Sarah Arabic, Lily LaBeau - 2025-06-24 - 2160p` | `pure-taboo:2025-06-24:a-costly-divorce-sarah-arabic-lily-labeau` | `A Costly Divorce - Sarah Arabic, Lily LaBeau` | **new** |
| 29 | `Pure Taboo - Sarah Arabic - A Different Divorce (Jun 24, 2025) [1080p]` | `pure-taboo:2025-06-24:a-different-divorce-sarah-arabic` | `Sarah Arabic - A Different Divorce` | **new** |
| 30 | `TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX` | `teamskeet:2024-01-02:jane-doe` | `Jane Doe` |  |
| 31 | `TeamSkeet.24.01.02.Jane.Doe.XXX.2160p.HEVC.MP4-XXX` | `teamskeet:2024-01-02:jane-doe` | `Jane Doe` |  |
| 32 | `TeamSkeet.24.01.02.John.Smith.XXX.1080p.MP4-XXX` | `teamskeet:2024-01-02:john-smith` | `John Smith` |  |
| 33 | `Site.23.04.15.Anniversary.XXX.1080p.MP4-G` | `site:2023-04-15:anniversary` | `Anniversary` |  |
| 34 | `Site.23.04.15.Anniversary.XXX.Edition.XXX.1080p.MP4-G` | `site:2023-04-15:anniversary-xxx-edition` | `Anniversary XXX Edition` |  |
| 35 | `Site.23.04.15.Anniversary.XXX.Edition.XXX.2160p.HEVC.MP4-G` | `site:2023-04-15:anniversary-xxx-edition` | `Anniversary XXX Edition` |  |
| 36 | `Site.23.04.15.Anniversary.XXX.Web.Party.XXX.MP4-GRP1` | `site:2023-04-15:anniversary-xxx-web-party` | `Anniversary XXX Web Party` |  |
| 37 | `Site.23.04.15.Anniversary.XXX.Web.Party.XXX.1080p.MP4-GRP2` | `site:2023-04-15:anniversary-xxx-web-party` | `Anniversary XXX Web Party` |  |
| 38 | `Site.23.04.15.Anniversary.XXX.Web.Bash.XXX.MP4-GRP2` | `site:2023-04-15:anniversary-xxx-web-bash` | `Anniversary XXX Web Bash` |  |
| 39 | `Site.23.04.15.Anniversary.XXX.4K.Party.XXX.MP4-GRP1` | `site:2023-04-15:anniversary-xxx-4k-party` | `Anniversary XXX 4K Party` |  |
| 40 | `Site.23.04.15.Gala.XXX.MP4.Madness.XXX.1080p.MP4-G` | `site:2023-04-15:gala-xxx-mp4-madness` | `Gala XXX MP4 Madness` |  |
| 41 | `Site.23.04.15.Gala.XXX.MP4.Mayhem.XXX.1080p.MP4-G` | `site:2023-04-15:gala-xxx-mp4-mayhem` | `Gala XXX MP4 Mayhem` |  |
| 42 | `Site.23.04.15.XXX.Anniversary.XXX.1080p.MP4-GRP` | `site:2023-04-15:xxx-anniversary` | `XXX Anniversary` |  |
| 43 | `Site.23.04.15.XXXtreme.Makeover.XXX.1080p.MP4-GRP` | `site:2023-04-15:xxxtreme-makeover` | `XXXtreme Makeover` |  |
| 44 | `Site.23.04.15.Girls.Of.Web.1080p.MP4-G` | `site:2023-04-15:girls-of-web` | `Girls Of Web` |  |
| 45 | `Site.23.04.15.Girls.Of.Print.1080p.MP4-G` | `site:2023-04-15:girls-of-print` | `Girls Of Print` |  |
| 46 | `Site.23.04.15.The.1080.Club.XXX.1080p.MP4-G` | `site:2023-04-15:the-1080-club` | `The 1080 Club` |  |
| 47 | `Site.23.04.15.Agent.007.Undercover.XXX.1080p.MP4-G` | `site:2023-04-15:agent-007-undercover` | `Agent 007 Undercover` |  |
| 48 | `Site.23.04.15.Agent.007.Overcover.XXX.1080p.MP4-G` | `site:2023-04-15:agent-007-overcover` | `Agent 007 Overcover` |  |
| 49 | `Site.23.04.15.Miss.AVI.XXX.1080p.MP4-G` | `site:2023-04-15:miss-avi` | `Miss AVI` |  |
| 50 | `Site.23.04.15.Miss.MKV.XXX.1080p.MP4-G` | `site:2023-04-15:miss-mkv` | `Miss MKV` |  |
| 51 | `[Site] 2023-01-01 - Girls Of Web` | `site:2023-01-01:girls-of-web` | `Girls Of Web` | **new** |
| 52 | `[Site] 2023-01-01 - Episode 2 4K` | `site:2023-01-01:episode-2` | `Episode 2` | **new** |
| 53 | `[Site] 2023-01-01 - Episode 3 4K` | `site:2023-01-01:episode-3` | `Episode 3` | **new** |
| 54 | `Site.23.04.15.Alex.Coal.1080p.MP4-WRB` | `site:2023-04-15:alex-coal` | `Alex Coal` |  |
| 55 | `Site.23.04.15.Alex.Coal.XXX.MP4-GRP` | `site:2023-04-15:alex-coal` | `Alex Coal` |  |
| 56 | `Site.23.04.15.Alex.Coal.XXX.MKV-GRP` | `site:2023-04-15:alex-coal` | `Alex Coal` |  |
| 57 | `Site.23.04.15.Alex.Coal.XXX.WMV` | `site:2023-04-15:alex-coal` | `Alex Coal` |  |
| 58 | `Site.23.04.15.Alex.Coal.XXX` | `site:2023-04-15:alex-coal` | `Alex Coal` |  |
| 59 | `4K.Media.23.04.15.Alex.Coal.XXX.1080p.MP4-G` | `4k-media:2023-04-15:alex-coal` | `Alex Coal` |  |
| 60 | `WebYoung.23.04.15.Alex.Coal.XXX.1080p.MP4-G` | `webyoung:2023-04-15:alex-coal` | `Alex Coal` |  |
| 61 | `Tushy.com.23.04.15.Emily.Willis.XXX.1080p-G` | `tushy-com:2023-04-15:emily-willis` | `Emily Willis` |  |
| 62 | `Vintage.1979.Collection.23.04.15.Alex.Coal.XXX.1080p.MP4-G` | `vintage-1979-collection:2023-04-15:alex-coal` | `Alex Coal` |  |

### Invariants asserted over the whole table

| Test | Property |
|------|----------|
| round-trips to its pinned identity key | every accepted name has a stable, stated key |
| deterministic across repeated calls | no stateful (`g`-flag) regex leaks `lastIndex` between feed items |
| every encode, spelling, and layout of one scene shares a key | no under-collation within a scene group |
| no two distinct scenes ever share an identity key | **no over-collation** — the property that matters |
| no title is silently truncated | display title matches exactly, per row |
| every key stays inside the alphabet destinations are derived from | `/^[a-z0-9-]+:\d{4}-\d{2}-\d{2}:[a-z0-9-]+$/`, exactly 3 `:`-fields |
| the display date always agrees with the key | the two date renderings cannot drift apart |
| the new shapes really are new coverage | guards the corpus itself from being reduced back to the old rule's cases |

## 6. The accepted `null` set

Refusing writes a `parse_error` row — a visible worklist. Each of these is
ambiguous in a way where the plausible readings disagree about the *identity*,
so refusing is the correct answer rather than a gap. All are pinned by
`refusal set: ambiguous names are refused rather than guessed`.

| Input | Why `null` is right |
|-------|---------------------|
| `` (empty) | nothing to parse |
| `Some.Random.Movie.2023.1080p.BluRay-GRP` | no date. A bare year is not a release date, and without a date there is no site/title boundary at all. Also correctly rejects non-scene media that reaches this plugin. |
| `23.04.15.Alex.Coal.XXX.1080p.MP4-G` | the date is first, so there is no site. Accepting it with an empty site would put every scene released that day into one group. |
| `Site.23.13.45.Name.XXX.1080p.MP4-G` | month 13 / day 45 is not a calendar date; the self-verifying property is exactly what makes this detectable |
| `Site.23.02.30.Name.XXX.1080p.MP4-G` | February 30 does not exist |
| `Site.20231345.Name.XXX.1080p.MP4-G` | same, in the concatenated form |
| `Site.23.04.15.Alex.Coal` | no encode section at all, so nothing marks where the title stops. `Alex Coal` and a truncated reading of a longer name are indistinguishable. |
| `Site.23.04.15.Alex.Coal.MP4-G` | the only encode evidence is a container, which is an ordinary title word in this domain (cf. the accepted `Gala XXX MP4 Madness`). Cutting there could truncate a title; not cutting could leave encode text in the identity. |
| `Site.23.04.15.Girls.Of.Web.MP4-G` | same class: `Web` and `MP4` are both weak. Guessing truncates the title to `Girls Of`. With an anchor present (`...Web.1080p.MP4-G`) the same name is accepted and keeps `Girls Of Web`. |
| `Site.23.04.15.The.1080p.Club.MP4-G` | the anchor sits mid-title, so no encode run reaches the end and no boundary is trustworthy |
| `Site.23.04.15.Name.XXX.1080p.Uncut.MP4-G` | an edit tag interrupts the encode run. Guessing merges the uncut and cut versions — two different files presented as one scene. |
| `Site.23.04.15.Name.XXX.1080p.Uncut` | new. A dot-attached mixed-case trailing word is an edit tag, not a release group; treating it as a group would merge edits as above. |
| `Site.23.04.15.XXX.1080p.MP4-G` | new. The title would be only the marker, which carries no discriminating content: two unrelated scenes on that site and day would collide. |
| `SexBabesVR.23.04.15.Alex.Coal.XXX.2160p.VR.LR.180.MP4-G` | new. A bare `180` is not in the encode vocabulary, and a bare number is a plausible title word (`Agent 007 Undercover` is accepted and depends on that). The run is treated as interrupted. See §9. |
| `[Vixen] Alex Coal - Beautiful Episode` | delimited listing with no date: the anchor the whole rule rests on is absent |
| `19-07-2023 - Alex Coal - Beautiful Episode 1080p` | delimited listing whose first segment is the date, leaving no site |

## 7. Regressions — each still holds, with evidence

Each is asserted twice: as a named test in `parse-corpus.test.ts` *and* as rows
inside the corpus table, so deleting one does not remove the coverage. The
original `parse.test.ts` also still pins all of them, unmodified.

| # | Regression | Evidence |
|---|-----------|----------|
| 1 | Two encodes of one scene share a key; two scenes never do | `regression 1`; corpus invariants 3 and 4 over all 62 rows |
| 2 | A release group named `XXX` does not break the boundary | `regression 2`: `TeamSkeet.24.01.02.Jane.Doe.XXX.{1080p,2160p.HEVC}.MP4-XXX` → one key, title `Jane Doe`. Structural reason: the group is detached before the boundary walk. |
| 3 | An in-title `XXX` neither collapses nor truncates | `regression 3`: `Anniversary.XXX.1080p` and `Anniversary.XXX.Edition.XXX.1080p` get different keys; the latter's title is `Anniversary XXX Edition`. Corpus also pins `Gala XXX MP4 Madness`, `XXX Anniversary`, `Anniversary XXX 4K Party`, `XXXtreme Makeover`. |
| 4 | Separator and case differences never split a group | `regression 4`: dot / space / underscore / hyphen spellings of one name → one key. Corpus rows 1-7. |
| 5 | An underscore name yields the *same quality tokens* as its dotted twin | `regression 5`: `deepEqual` on the whole `quality` object for three pairs, including `WEB_DL`/`H_265`. The original `invariant: separator spelling never changes the quality tokens` also still passes unmodified. |
| 6 | An invalid calendar date returns `null` | `regression 6`: `23.13.45`, `23.02.30`, and `20231345` |
| 7 | Identity stays inside the alphabet destinations need | corpus invariant `every key stays inside the alphabet...`; `plan-import.test.ts` unmodified and passing, including the destination-stability and path-sanitisation tests |
| + | A website prefix does not split a group (the mis-parse this rewrite was called for) | `regression 7`: all three prefixed forms → `brazzers:2023-04-15:alex-coal`, identical to the bare name. Previously `www-site-com-brazzers:2023-04-15:alex-coal`. |

## 8. Reference projects

**I did not fetch, read, or consult the source of Whisparr or
ThePornDatabase/namer at any point during this task.** No regex, table,
identifier, comment, or other expression came from either project. Every
pattern in `parse.ts` was written from the shape descriptions in the brief plus
the existing Pickarr code, which is the project's own MIT-licensed work. The
only thing carried over is domain knowledge stated in the brief itself — which
release-name shapes exist in the wild, and that the date is the right boundary
— which are facts about the domain rather than protected expression. The
repository stays MIT-clean.

## 9. Shapes not supported

- **Bare orientation numerals in VR names** (`...VR.LR.180.MP4-G`). `180` and
  `360` are not in the encode vocabulary because a bare number is a plausible
  title word and the corpus already depends on that (`Agent 007 Undercover`,
  `The 1080 Club`). Adding them would trade a visible refusal for a truncation
  risk in the wrong direction. The common VR form
  (`...XXX.1080p.VR.MP4-G`, `...VR.SBS.MP4-G`) is supported.
- **Ambiguous day/month in the listing form** (`07-08-2023`). Read day-first.
  Where a tracker means month-first the scene files under the transposed date,
  which splits a group rather than merging two — under-collation, the
  acceptable direction. Refusing instead would lose the whole shape.
- **All-lowercase dot-attached release groups**
  (`tushy.24.01.09.emily.willis.xxx.1080p.hevc.x265.prt`). The group test
  requires caps to keep edit tags like `.Uncut` out. This refuses rather than
  mis-parses.
- **Names with no date.** Out of scope by construction — the rule is the date.
  These were already refused and still are.
- **A title genuinely ending in an anchor-introduced encode run.** The residual
  class from §1. Refused, not guessed.

## 10. `npm run check`

Exit status 0. Warnings shown are pre-existing and all in `packages/core`;
`packages/plugin-scenes` produces none. 233 tests pass (216 before this change,
plus the 17 new corpus tests). No existing test was modified.

```

> check
> npm run lint && npm run typecheck && npm run test


> lint
> oxlint

packages/core/src/plugins/registry.ts:47:7: warning eslint(preserve-caught-error): There is no cause error attached to this new thrown error. help: Preserve the original error by using the `cause` property when re-throwing errors.
packages/core/src/config/load.ts:39:5: warning eslint(preserve-caught-error): There is no cause error attached to this new thrown error. help: Preserve the original error by using the `cause` property when re-throwing errors.
packages/core/src/pipeline/upgrade.ts:149:5: warning eslint(preserve-caught-error): There is no cause error attached to this new thrown error. help: Preserve the original error by using the `cause` property when re-throwing errors.
packages/core/src/pipeline/import.ts:429:5: warning eslint(preserve-caught-error): There is no cause error attached to this new thrown error. help: Preserve the original error by using the `cause` property when re-throwing errors.

> typecheck
> npm run typecheck --workspaces --if-present


> @pickarr/core@0.1.0 typecheck
> tsgo --noEmit -p tsconfig.json


> @pickarr/plugin-api@0.1.0 typecheck
> tsgo --noEmit -p tsconfig.json


> @pickarr/plugin-scenes@0.1.0 typecheck
> tsgo --noEmit -p tsconfig.json


> @pickarr/web@0.1.0 typecheck
> tsgo --noEmit -p tsconfig.json


> test
> npm run test:server && npm run test:web


> test:server
> node --import tsx --conditions development --test "packages/*/test/**/*.test.ts"

✔ addUrl sends the category and returns the nzo id (11.348709ms)
✔ addUrl sends the caller-provided label as nzbname (0.260792ms)
✔ addUrl throws when sabnzbd reports failure (0.3115ms)
✔ addUrl throws when no nzo id comes back (0.163167ms)
✔ an error never contains the api key (1.318167ms)
✔ an error thrown by fetchImpl itself never leaks the api key (0.3125ms)
✔ a JSON-parse failure from response.json() never leaks the api key (0.322167ms)
✔ a base64-style api key with +, /, = never leaks, even decoded (0.192167ms)
✔ an api key containing +, /, =, and a space never leaks, even decoded (0.19175ms)
✔ an api key embedded in the thrown error's name is also redacted (0.222459ms)
✔ a non-Error throw from fetchImpl produces the wrapper, not a crash (0.194333ms)
✔ redaction leaves the rest of an error message legible (0.134958ms)
✔ the server's own error field never leaks the api key (0.222541ms)
✔ a percent-encoded request url outside query shape does not leak the key (0.147667ms)
✔ a doubly percent-encoded request url does not leak the key (0.136625ms)
✔ server-supplied strings returned by snapshot never carry the api key (0.311125ms)
✔ an nzo id echoing the request url is not returned verbatim (0.148166ms)
✔ snapshot reads queue and history filtered by category (0.550833ms)
✔ snapshot tolerates missing slots (0.139667ms)
✔ mapPath applies the longest matching prefix (0.056417ms)
✔ mapPath leaves an unmatched path alone (0.034333ms)
✔ loads a valid config (10.036042ms)
✔ resolves a file: secret and trims its trailing newline (6.562416ms)
✔ a missing secret file is fatal and names the path but not the contents (5.182584ms)
✔ a literal api key below the minimum length is rejected (8.975125ms)
✔ a file: secret resolving to a short key is rejected without printing it (17.375625ms)
✔ an invalid config names the offending field (11.510334ms)
✔ PICKARR_PORT overrides the configured port (6.632834ms)
✔ two feeds sharing an id is rejected (4.564542ms)
✔ setClientRef throws by name and id rather than silently no-opping on a bad id (1.126333ms)
✔ setStatus throws on a bad id (0.324916ms)
✔ setStoragePath throws on a bad id (0.252958ms)
✔ failDownload throws on a bad id (0.228541ms)
✔ recordError throws on a bad id (0.231708ms)
✔ bumpAttempts throws on a bad id instead of returning 0 (0.224541ms)
✔ bumpMissingPolls throws on a bad id instead of returning 0 (0.22575ms)
✔ resetMissingPolls throws on a bad id (0.23225ms)
✔ resetMissingPolls on a real row whose missing_polls is already 0 is a legitimate no-op, not an error (0.333083ms)
✔ bumpAttempts and bumpMissingPolls increment and return the new count for a real row (0.314ms)
✔ completeUpgrade keeps a better release flagged instead of clearing it (1.03825ms)
✔ completeUpgrade onto the best release clears the flag (0.315708ms)
✔ picking the worse of two known releases flags the better one (0.260917ms)
✔ picking the best known release leaves nothing flagged (0.225208ms)
✔ an equal-scoring release is not an upgrade (0.260417ms)
✔ flagUpgrade re-derives the same invariant and is the only write that moves list_rank_at (0.254458ms)
✔ migrate creates every table (1.116041ms)
✔ migrate is idempotent (0.34775ms)
✔ feed_items rejects a duplicate guid within a feed (0.285833ms)
✔ feed_items allows the same guid in a different feed (0.2005ms)
✔ media_groups rejects a duplicate identity within a plugin (0.214834ms)
✔ parses items into feed entries (1.373417ms)
✔ prefers the enclosure url over the link (0.15725ms)
✔ falls back to the link when there is no guid (0.081125ms)
✔ a single item is not mistaken for a non-array (0.068917ms)
✔ an empty channel yields no entries (0.297375ms)
✔ a channel containing bare text rather than elements throws (0.178125ms)
✔ an unparseable pubDate becomes null rather than NaN (0.088ms)
✔ a non-rss document throws (0.085334ms)
✔ items missing a title or link are skipped (0.095416ms)
✔ health responds ok (55.402917ms)
✔ browse returns groups newest-rank first with their releases (2.544042ms)
✔ browse paginates with a stable cursor (1.855667ms)
✔ browse filters by q (1.243209ms)
✔ a picked group with no upgrade drops out of browse and appears in picks (3.367333ms)
✔ picking a release from the wrong group is a 400 (1.716625ms)
✔ a malformed pick body is a 400 (2.373041ms)
✔ downloads merges tracked rows with the untracked snapshot (1.909333ms)
✔ retrying a failed import resumes at completed (1.691541ms)
✔ retrying a download that has not failed is refused (1.696875ms)
✔ retrying an unknown download is a 404 (1.011542ms)
✔ no route ever returns the client api key (2.002958ms)
✔ re-ingesting the same guid is a no-op (1.224375ms)
✔ two releases with the same identity collate into one group (0.400083ms)
✔ different identities create separate groups (0.293834ms)
✔ a new release on an unpicked group does not touch list_rank_at (0.286375ms)
✔ a better release on a picked group flags an upgrade and bumps list_rank_at (0.471167ms)
✔ a worse release on a picked group changes nothing (0.341084ms)
✔ an equal-scoring release on a picked group changes nothing (0.28425ms)
✔ a release better than the pick but not the flagged upgrade is ignored (0.333875ms)
✔ a release better than the flagged upgrade replaces it and bumps again (0.363166ms)
✔ an unparseable name records a parse_error and creates no group (0.257792ms)
✔ a plugin that throws does not stop the batch (0.276ms)
✔ a plugin whose score throws records a parse_error and lets later entries through (0.251167ms)
✔ a plugin returning a non-finite score records a parse_error rather than a failed insert (0.194916ms)
✔ a plugin returning a display with no fields records a parse_error (0.244917ms)
✔ a plugin returning a malformed quality records a parse_error and lets later entries through (0.223ms)
✔ a plugin returning a display field of null records a parse_error rather than persisting it (0.221333ms)
✔ a plugin returning an empty identity key records a parse_error (0.184041ms)
✔ groups are keyed by plugin id, not by feed (0.215917ms)
✔ search_text is lowercased and includes every display value (0.177459ms)
✔ imports the planned file and records it (15.945208ms)
✔ move removes the source, copy leaves it (11.572209ms)
✔ a cross-device rename falls back to copy-then-unlink (6.049542ms)
✔ a destination escaping the library root is rejected (5.025542ms)
✔ a planned source outside the download listing is refused, naming the path (3.483292ms)
✔ no importable files fails with a named reason (1.982ms)
✔ retry after a partial import skips files already in place (7.186833ms)
✔ the file listing reaches the plugin with sizes and relative paths (4.989584ms)
✔ a destination resolving to the library root itself is rejected, and the source survives (4.776709ms)
✔ a foreign regular file already at the destination fails the import and leaves the source untouched (2.630916ms)
✔ a symlink at the exact destination path is treated as a collision, not adopted (2.631625ms)
✔ a destination that already exists with no surviving source and no recorded row is adopted as crash recovery (2.300666ms)
✔ copy mode: a destination that already matches the source in size is adopted as crash recovery (2.538958ms)
✔ copy mode: a destination with different content than the source is a collision, not recovery (2.792333ms)
✔ a symlink at the destination with the source already gone is still a collision, not adopted (1.467917ms)
✔ runs exclusively and in order (24.501667ms)
✔ a rejection does not wedge the mutex (0.288958ms)
✔ tryRun skips instead of queueing when busy (20.938417ms)
✔ tryRun runs immediately once a preceding run has released the mutex (0.348625ms)
✔ a nested acquisition on the same mutex throws instead of deadlocking (0.522458ms)
✔ picking marks the group picked and starts a download (1.426084ms)
✔ picking sets picked_release_id immediately, before any download finishes (0.398458ms)
✔ an addUrl failure leaves the download queued and the pick intact (0.402583ms)
✔ a pick on an already-picked group is inferred as an upgrade and does not overwrite picked_release_id (0.440792ms)
✔ picking a release that belongs to another group is rejected (0.393333ms)
✔ picking an unknown release is rejected (0.247917ms)
✔ picking the same release twice while in flight is rejected (0.356125ms)
✔ the download row records the client id and timestamps (0.290584ms)
✔ a persist failure after a successful addUrl is recorded distinctly from an addUrl failure (0.378541ms)
✔ a failure between marking picked and inserting the download rolls back the pick (0.342292ms)
pickarr: download 1 is named 'R' at the client, expected 'pickarr-1'; label-based double-submit recovery will not work against this server.
✔ a download in the queue stays downloading and resets missing_polls (2.852084ms)
✔ a completed download gets its mapped storage path and is imported (0.545333ms)
✔ a completed row with a storage path is imported even when the client has pruned its history (0.464416ms)
✔ an import failure on a completed row fails the download rather than retrying forever (0.440375ms)
✔ a failed download records the fail message (0.329042ms)
✔ a completed download with no storage path fails rather than importing nothing (0.273042ms)
✔ a download missing from both lists fails only after three consecutive polls (0.379292ms)
✔ reappearing resets the missing counter (0.369209ms)
✔ a queued download with no client ref is retried (0.34425ms)
✔ addurl retries stop after the attempt cap (0.730625ms)
✔ entries with no matching row are reported as untracked and never imported (0.567833ms)
✔ an already-imported download still in history is not reported as untracked (0.264667ms)
✔ an import failure fails the download rather than throwing out of the tick (0.307417ms)
✔ a queued download whose addUrl already succeeded is recovered from the queue, not resubmitted (0.244208ms)
✔ a queued download whose addUrl already succeeded and finished is recovered from history and imported in the same tick (0.244959ms)
✔ recovering a ref by label does not consume an addurl attempt, unlike a real retry (0.228291ms)
✔ a fresh addUrl call is given the download-derived label, not the release title (0.228417ms)
✔ a tracked download whose client-side name does not match its label warns exactly once, not once per tick (0.459084ms)
✔ a tracked download whose client-side name matches its label never warns (0.226083ms)
✔ importing resets to completed so the next tick redoes the import (1.0425ms)
✔ queued with no client ref is left queued for retry and counted (0.289459ms)
✔ terminal and in-flight rows are untouched (0.277ms)
✔ reconcileNow caches the untracked snapshot for later reads (1.203167ms)
✔ a reconcile failure is logged and does not throw out of the tick (0.336875ms)
✔ a timer tick that lands while a reconcile is still running is dropped, not queued (3.709833ms)
✔ an ingest failure on one feed does not stop the others (0.567875ms)
✔ an upgrade trashes the old file, writes the new one, and repoints the group (18.519291ms)
✔ re-running the same upgrade import does not trash the files it just imported (11.45ms)
✔ trash paths are namespaced so repeated upgrades cannot collide (11.486583ms)
✔ a failure after trashing reports where the old file went (5.651541ms)
✔ an initial import trashes nothing and leaves the pointer alone (4.659292ms)
✔ two live files sharing a basename in different library directories both survive in trash (4.650958ms)
✔ a refusal partway through trashing still names where earlier files in the same group went (3.752792ms)
✔ a live row whose file is already gone is trashed with no invented path (1.704709ms)
✔ a live row pointing at a directory is refused rather than trashed (2.284667ms)
✔ a live row that resolves outside the library root is refused rather than trashed (2.395417ms)
✔ loads a plugin and indexes it by package name and id (1.112125ms)
✔ two packages claiming the same id is fatal (0.668333ms)
✔ a plugin config without a libraryRoot is fatal (0.197083ms)
✔ a module without a default export is fatal and names the package (0.106417ms)
✔ an import failure is fatal and names the package (0.339292ms)
✔ byPackage throws for an unregistered package (0.103708ms)
✔ higher resolution always outranks lower (1.814375ms)
✔ resolution dominates codec and source (0.327708ms)
✔ at equal resolution, better source and codec win (0.214125ms)
✔ size breaks ties without ever overtaking a quality tier (0.1ms)
✔ unknown tokens score without throwing (0.081042ms)
✔ plugin-api resolves through the development condition (0.301ms)
✔ corpus: every accepted name round-trips to its pinned identity key (4.151458ms)
✔ corpus: parsing is deterministic across repeated calls (2.043834ms)
✔ corpus: every encode, spelling, and layout of one scene shares a key (0.594167ms)
✔ corpus: no two distinct scenes ever share an identity key (0.519541ms)
✔ corpus: no title is silently truncated (0.454ms)
✔ corpus: every key stays inside the alphabet destinations are derived from (1.004708ms)
✔ corpus: the display date always agrees with the key (0.447375ms)
✔ corpus: the new shapes really are new coverage (0.058833ms)
✔ refusal set: ambiguous names are refused rather than guessed (0.123208ms)
✔ regression 1: two encodes of one scene share a key, two scenes never do (0.134958ms)
✔ regression 2: a release group literally named XXX does not move the boundary (0.064458ms)
✔ regression 3: an in-title XXX neither collapses nor truncates the title (0.061042ms)
✔ regression 4: separator and case differences never split a group (0.070541ms)
✔ regression 5: an underscore name yields the same quality tokens as its dotted twin (0.099958ms)
✔ regression 6: an invalid calendar date returns null (0.038333ms)
✔ regression 7: a website prefix does not split a group (0.053084ms)
✔ listing layout order does not change the identity key (0.084375ms)
✔ parses the canonical Site.YY.MM.DD.Names.XXX.quality-GROUP form (1.77975ms)
✔ two encodes of the same scene share an identity key (0.582625ms)
✔ different scenes on the same site and day do not collate (0.101125ms)
✔ separator and case differences do not split a group (0.082042ms)
✔ extracts resolution from every common token (0.200917ms)
✔ extracts video codec and source (0.078375ms)
✔ a two-digit year maps into the 2000s (0.077833ms)
✔ a four-digit year is accepted (0.062875ms)
✔ a release with no XXX marker still parses using the first quality token (0.087208ms)
✔ a name with no date returns null (0.099916ms)
✔ an empty name returns null (0.048208ms)
✔ a name with a date but no site returns null (0.047125ms)
✔ an invalid calendar date returns null (0.039583ms)
✔ display fields carry site and performers (0.366958ms)
✔ two scenes differing only by content after an in-title XXX get different identity keys (0.071959ms)
✔ an in-title XXX scene keeps its full title instead of being truncated (0.080959ms)
✔ two encodes of a scene with an XXX release group still share an identity key (0.104625ms)
✔ two scenes differing only by content after an in-title XXX followed by an encode-like word get different identity keys (0.0645ms)
✔ invariant: separator spelling never changes the quality tokens (0.242208ms)
✔ invariant: no two distinct scenes ever share an identity key (0.767083ms)
✔ invariant: every encode of one scene collapses to a single identity key (0.345709ms)
✔ invariant: a title is never silently truncated at an in-title marker or encode word (0.116625ms)
✔ invariant: ambiguous names are refused rather than guessed (0.076667ms)
✔ picks the largest video file and names it from the parsed media (0.846541ms)
✔ skips sample, proof, and screens files even when they are large (0.138541ms)
✔ preserves the source extension (0.096167ms)
✔ returns null when there is no video file (0.045875ms)
✔ returns null for an empty listing (0.043125ms)
✔ sanitizes path separators and reserved characters out of the destination (0.573791ms)
✔ a destination can never escape the library root (0.057291ms)
✔ two releases with the same identity key produce the same destination (0.1115ms)
✔ a nested larger video does not beat a top-level smaller one (0.076167ms)
✔ a single junk-named video is imported rather than refused (0.086458ms)
✔ a release with no stated source is treated as an original site rip (0.402417ms)
✔ an explicit re-encode source ranks below an unstated one (0.074083ms)
✔ an explicit source is never overridden (0.051167ms)
✔ resolution still dominates the source adjustment (0.041375ms)
✔ formats the tokens that are present, in a stable order (0.352833ms)
✔ omits absent tokens without leaving separators (0.061917ms)
✔ an empty token set reads as unknown (0.045709ms)
✔ formats sizes in binary units (0.458125ms)
ℹ tests 226
ℹ suites 0
ℹ pass 226
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 384.635708

> test:web
> TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test "packages/web/test/**/*.test.tsx"

✔ a tracked row shows status and offers retry only when failed (11.018792ms)
✔ untracked entries render inert and labelled (8.454417ms)
✔ renders the display fields (8.934709ms)
✔ shows one pick control per release, best first (4.070959ms)
✔ picking a release reports its id (2.52725ms)
✔ an upgrade-flagged group is badged (2.676584ms)
✔ the release you already own is marked and not offered again (1.576292ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 306.7135
```

(Long-tail `no-await-in-loop` / `prefer-set-has` / `no-array-sort` /
`consistent-function-scoping` warnings from `packages/core` elided above; all
pre-existing and unrelated.)
