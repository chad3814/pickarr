# Release-name parser rewrite: the date is the boundary

`packages/plugin-scenes/src/parse.ts`, rewritten. Tests:
`packages/plugin-scenes/test/parse-corpus.test.ts` (new, 23 tests);
`packages/plugin-scenes/test/parse.test.ts` (unchanged, still passing).

No file outside `packages/plugin-scenes` was touched. The identity shape is
still exactly `slug(site) ":" ISO-date ":" slug(scene)`, three fields, slugs
restricted to `[a-z0-9-]`, and `identityKey.split(':')` stays well-defined; a
corpus invariant pins that shape directly.

`plan-import.ts` **did** have to change, and this is the one place the brief
allows it only if identity genuinely requires it — it does. The listing form
joins its sorted components with `--`, and `titleCaseSlug` split on a single
`-`, which erased that boundary one layer down: two different scenes with two
different keys rendered the same destination. `titleCaseSlug` was *not*
injective, contrary to what the first version of this report claimed; the fix
and the corrected argument are in §9.

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

- **Website prefix.** A domain is only a prefix when it carries an explicit
  *marker* — `www.` or a `http(s)://` scheme, optionally with a path. A bare
  domain is not enough, because a great many studios are named after their
  domain: `Bang.com`, `Deeper.com`, `Nubiles.net`, `Private.com`. In the
  delimited listing form a bare-domain rule cannot tell those from a prefix —
  both are "a domain, then ` - `" — and stripping one promotes the *performer*
  into the site slot, collapsing every such studio onto one key and filing
  their scenes under the performer. A studio allowlist would not fix that; it
  fails for every studio nobody thought of. A bracketed *bare* domain is still
  stripped, but only when the name is not a listing, since there a leading
  bracket is the studio field itself. Inside the host, the label repetition is
  **lazy**: `xxx` is a real TLD *and* the marker token, so a greedy host
  swallowed `www.Site.com.Brazzers.23.04.15.Alex.Coal.XXX.` and called it a
  prefix.
- **Trailing media file extension.** An extension is by definition appended
  *after* a complete release name, so what precedes it is that name's last
  element: a group tag or the encode section. When the preceding token is
  neither — `Site.23.04.15.Alex.Coal.XXX.WMV` — the trailing token is the
  container the name itself states, and stripping it would discard the only
  quality information present. So the strip is conditional on that test.
- **Release-group tag.** Hyphen-attached or, in some trackers' output,
  attached with the name's own separator. The dot-attached form additionally
  requires the preceding token to be encode information, because a group can
  only ever follow a complete encode section. **Both** forms go through the
  same shape test: 1-8 alphanumerics (2 minimum when dot-attached, where the
  separator carries no information), containing a letter, in caps, and absent
  from `NON_GROUP_TERMS` both as written and with a trailing digit run
  stripped.

  Every clause there is load-bearing and none subsumes another.
  `NON_GROUP_TERMS` is the only thing that rejects the correctly-capitalised
  `-UNCUT`; the digit strip is the only thing that rejects `-PART1`/`-PART2`;
  and the caps test is the only thing that rejects `-Bonus`, which no finite
  list can anticipate. Detaching any of them as a group merges two different
  cuts of a scene, which is the over-collation this component may not commit.
  All four are pinned by separate refusal rows and confirmed by mutation
  testing (§8).

Separators are normalised for the quality tables by rewriting `_` to `.`
(retained from the prior fix — `` does not match beside `_`), and the release
group is recovered **structurally from the token stream** rather than by a
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
  segments. Recognition is a *positive* test, not merely "a bracket or a ` - `
  is present": a name containing a date written with the dotted form's own
  separators is a dotted release and the listing recogniser declines on it.
  Without that, `[Tracker] Brazzers.2023.04.15.Alex.Coal.XXX.1080p.MP4-WRB` was
  read as a listing, which finds the date but no encode section — flattening
  every encode in the group to one score and killing upgrade detection.
  Reordering the two recognisers is *not* an alternative fix: the listing
  form's own date spellings satisfy the dotted date finder, so the dotted
  parser would then eat listings instead. The date may be a whole segment (`19-07-2023`, `2023-07-22`) or sit
  inside one, including parenthesised and written out (`(June 24, 2025)`). ISO
  order is tried first because it is unambiguous; the remaining numeric form is
  read day-first. A day/month transposition can only ever *split* a group,
  never merge two scenes, so guessing there sits on the safe side of the
  asymmetry.

## 4. Component ordering in the listing form — decision

The listing shapes put performers and title on either side of each other
depending on the tracker: `[Vixen] DATE - Alex Coal - Beautiful Episode` versus
`[Tushy] Beautiful Episode - Alex Coal - DATE`. **I normalise: the identity
slug is built from the *sorted* component slugs joined with `--`, while the
display title keeps source order.**

Reasoning, recorded as asked:

- Preserving order under-collates every time one site is scraped by two
  indexers with different layouts. That under-collation is *silent* — the user
  sees two cards that look identical and cannot tell which has the better
  encode.
- Sorting is sound **only because the join is injective, and that is a property
  of the delimiter, not of sorting.** My first version joined with a single
  `-`, and the lemma I wrote to justify it — "the sorted join of a different
  multiset is a different string" — was **false as implemented**: `slug()`
  emits `-` too, so the component boundaries dissolved and any re-split
  preserving alphabetical order collided. `Kylie` + `Page Turner` and
  `Kylie Page` + `Turner` both rendered `kylie-page-turner`; those are
  different scenes. Sorting narrowed the collision class but did not close it.
- The join is therefore `--`. `slug()` collapses runs of non-alphanumerics to a
  single `-` and strips the edges, so `--` cannot occur *inside* a component,
  and empty components are filtered out before the join. The delimiter is thus
  one no component can contain, the split is unique, and the lemma is now true:
  the multiset determines the string and the string determines the multiset.
- With that established, sorting reorders whole components and never merges
  them. Two scenes sharing a performer still differ in their title component.
  For two distinct scenes to collide, one site would have to publish, on one
  day, two scenes whose component multisets are exact permutations of each
  other — those are the same scene.
- `titleCaseSlug` filters empty parts, so `--` renders in paths exactly as `-`
  did.

Pinned by `the component join is injective: a re-split of one string is a
different key` and by the four re-split rows in the corpus.

## 5. Corpus

76 rows. `new?` marks a shape the previous parser refused or mis-parsed.
`quality` is `resolution|source|codec|container|vr|group`, `-` for absent, and
is pinned per row: a shape can parse to the right key and still lose its
quality tokens, which ties every encode in a group at one score and inverts
upgrade detection. That is a silent failure with no key to inspect.
Rows sharing a scene are asserted to share a key; rows of different scenes are
asserted never to. Generated from the test table by running the parser.

| # | Input | identityKey | title | quality | new? |
|---|-------|-------------|-------|---------|------|
| 1 | `Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` |  |
| 2 | `Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `2160|-|h265|mp4|-|GRP` |  |
| 3 | `Brazzers.23.04.15.Alex.Coal.XXX.2160p60.WEB-DL.H.265.10bit.HDR.DDP5.1.MP4-G` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `2160|web-dl|h265|mp4|-|G` |  |
| 4 | `brazzers 23 04 15 alex coal XXX 1080p MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `alex coal` | `1080|-|-|mp4|-|WRB` |  |
| 5 | `Brazzers_23_04_15_Alex_Coal_XXX_1080p_MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` |  |
| 6 | `Brazzers-23-04-15-Alex-Coal-XXX-1080p-MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex-Coal` | `1080|-|-|mp4|-|WRB` |  |
| 7 | `Brazzers.2023.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` |  |
| 8 | `www.site.com - Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` | **new** |
| 9 | `[www.pornsite.net] Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` | **new** |
| 10 | `www.Site.com.Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` | **new** |
| 11 | `Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB.mp4` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` | **new** |
| 12 | `Brazzers.23.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-GRP.mkv` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `2160|-|h265|mp4|-|GRP` | **new** |
| 13 | `Blacked.20180428.Alex.Coal.XXX.1080p.MP4-KTR` | `blacked:2018-04-28:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|KTR` | **new** |
| 14 | `Blacked.180428.Alex.Coal.XXX.1080p.MP4-KTR` | `blacked:2018-04-28:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|KTR` | **new** |
| 15 | `Blacked.18.04.28.Alex.Coal.XXX.2160p.HEVC.MP4-KTR` | `blacked:2018-04-28:alex-coal` | `Alex Coal` | `2160|-|h265|mp4|-|KTR` |  |
| 16 | `Tushy.24.01.09.Emily.Willis.XXX.1080p.HEVC.x265.PRT` | `tushy:2024-01-09:emily-willis` | `Emily Willis` | `1080|-|x265|-|-|PRT` | **new** |
| 17 | `Tushy.24.01.09.Emily.Willis.XXX.2160p.HEVC.x265.PRT` | `tushy:2024-01-09:emily-willis` | `Emily Willis` | `2160|-|x265|-|-|PRT` | **new** |
| 18 | `Tushy.24.01.09.Emily.Willis.XXX.1080p.HEVC.x265-PRT` | `tushy:2024-01-09:emily-willis` | `Emily Willis` | `1080|-|x265|-|-|PRT` |  |
| 19 | `SexBabesVR.23.04.15.Alex.Coal.XXX.1080p.VR.MP4-G` | `sexbabesvr:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|vr|G` | **new** |
| 20 | `SexBabesVR.23.04.15.Alex.Coal.XXX.2160p.VR.SBS.MP4-G` | `sexbabesvr:2023-04-15:alex-coal` | `Alex Coal` | `2160|-|-|mp4|vr|G` | **new** |
| 21 | `[Vixen] 19-07-2023 - Alex Coal - Beautiful Episode 2160p {SLUT}` | `vixen:2023-07-19:alex-coal--beautiful-episode` | `Alex Coal - Beautiful Episode` | `2160|-|-|-|-|SLUT` | **new** |
| 22 | `[Vixen] Beautiful Episode - Alex Coal - 2023-07-19 - 1080p` | `vixen:2023-07-19:alex-coal--beautiful-episode` | `Beautiful Episode - Alex Coal` | `1080|-|-|-|-|-` | **new** |
| 23 | `[Vixen] 19.07.2023 - Alex Coal - Beautiful Episode [1080p]` | `vixen:2023-07-19:alex-coal--beautiful-episode` | `Alex Coal - Beautiful Episode` | `1080|-|-|-|-|-` | **new** |
| 24 | `[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 1080p` | `tushy:2023-07-22:alex-coal--beautiful-episode` | `Beautiful Episode - Alex Coal` | `1080|-|-|-|-|-` | **new** |
| 25 | `[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 1080p WEB-DL x264` | `tushy:2023-07-22:alex-coal--beautiful-episode` | `Beautiful Episode - Alex Coal` | `1080|web-dl|x264|-|-|-` | **new** |
| 26 | `[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 2160p HEVC` | `tushy:2023-07-22:alex-coal--beautiful-episode` | `Beautiful Episode - Alex Coal` | `2160|-|h265|-|-|-` | **new** |
| 27 | `[Tushy] Different Episode - Alex Coal - 2023-07-22 - 1080p` | `tushy:2023-07-22:alex-coal--different-episode` | `Different Episode - Alex Coal` | `1080|-|-|-|-|-` | **new** |
| 28 | `Pure Taboo - Sarah Arabic, Lily LaBeau - A Costly Divorce (June 24, 2025) [1080p HEVC x265]` | `pure-taboo:2025-06-24:a-costly-divorce--sarah-arabic-lily-labeau` | `Sarah Arabic, Lily LaBeau - A Costly Divorce` | `1080|-|x265|-|-|-` | **new** |
| 29 | `Pure Taboo - A Costly Divorce - Sarah Arabic, Lily LaBeau - 2025-06-24 - 2160p` | `pure-taboo:2025-06-24:a-costly-divorce--sarah-arabic-lily-labeau` | `A Costly Divorce - Sarah Arabic, Lily LaBeau` | `2160|-|-|-|-|-` | **new** |
| 30 | `Pure Taboo - Sarah Arabic - A Different Divorce (Jun 24, 2025) [1080p]` | `pure-taboo:2025-06-24:a-different-divorce--sarah-arabic` | `Sarah Arabic - A Different Divorce` | `1080|-|-|-|-|-` | **new** |
| 31 | `TeamSkeet.24.01.02.Jane.Doe.XXX.1080p.MP4-XXX` | `teamskeet:2024-01-02:jane-doe` | `Jane Doe` | `1080|-|-|mp4|-|XXX` |  |
| 32 | `TeamSkeet.24.01.02.Jane.Doe.XXX.2160p.HEVC.MP4-XXX` | `teamskeet:2024-01-02:jane-doe` | `Jane Doe` | `2160|-|h265|mp4|-|XXX` |  |
| 33 | `TeamSkeet.24.01.02.John.Smith.XXX.1080p.MP4-XXX` | `teamskeet:2024-01-02:john-smith` | `John Smith` | `1080|-|-|mp4|-|XXX` |  |
| 34 | `Site.23.04.15.Anniversary.XXX.1080p.MP4-G` | `site:2023-04-15:anniversary` | `Anniversary` | `1080|-|-|mp4|-|G` |  |
| 35 | `Site.23.04.15.Anniversary.XXX.Edition.XXX.1080p.MP4-G` | `site:2023-04-15:anniversary-xxx-edition` | `Anniversary XXX Edition` | `1080|-|-|mp4|-|G` |  |
| 36 | `Site.23.04.15.Anniversary.XXX.Edition.XXX.2160p.HEVC.MP4-G` | `site:2023-04-15:anniversary-xxx-edition` | `Anniversary XXX Edition` | `2160|-|h265|mp4|-|G` |  |
| 37 | `Site.23.04.15.Anniversary.XXX.Web.Party.XXX.MP4-GRP1` | `site:2023-04-15:anniversary-xxx-web-party` | `Anniversary XXX Web Party` | `-|-|-|mp4|-|GRP1` |  |
| 38 | `Site.23.04.15.Anniversary.XXX.Web.Party.XXX.1080p.MP4-GRP2` | `site:2023-04-15:anniversary-xxx-web-party` | `Anniversary XXX Web Party` | `1080|-|-|mp4|-|GRP2` |  |
| 39 | `Site.23.04.15.Anniversary.XXX.Web.Bash.XXX.MP4-GRP2` | `site:2023-04-15:anniversary-xxx-web-bash` | `Anniversary XXX Web Bash` | `-|-|-|mp4|-|GRP2` |  |
| 40 | `Site.23.04.15.Anniversary.XXX.4K.Party.XXX.MP4-GRP1` | `site:2023-04-15:anniversary-xxx-4k-party` | `Anniversary XXX 4K Party` | `-|-|-|mp4|-|GRP1` |  |
| 41 | `Site.23.04.15.Gala.XXX.MP4.Madness.XXX.1080p.MP4-G` | `site:2023-04-15:gala-xxx-mp4-madness` | `Gala XXX MP4 Madness` | `1080|-|-|mp4|-|G` |  |
| 42 | `Site.23.04.15.Gala.XXX.MP4.Mayhem.XXX.1080p.MP4-G` | `site:2023-04-15:gala-xxx-mp4-mayhem` | `Gala XXX MP4 Mayhem` | `1080|-|-|mp4|-|G` |  |
| 43 | `Site.23.04.15.XXX.Anniversary.XXX.1080p.MP4-GRP` | `site:2023-04-15:xxx-anniversary` | `XXX Anniversary` | `1080|-|-|mp4|-|GRP` |  |
| 44 | `Site.23.04.15.XXXtreme.Makeover.XXX.1080p.MP4-GRP` | `site:2023-04-15:xxxtreme-makeover` | `XXXtreme Makeover` | `1080|-|-|mp4|-|GRP` |  |
| 45 | `Site.23.04.15.Girls.Of.Web.1080p.MP4-G` | `site:2023-04-15:girls-of-web` | `Girls Of Web` | `1080|-|-|mp4|-|G` |  |
| 46 | `Site.23.04.15.Girls.Of.Print.1080p.MP4-G` | `site:2023-04-15:girls-of-print` | `Girls Of Print` | `1080|-|-|mp4|-|G` |  |
| 47 | `Site.23.04.15.The.1080.Club.XXX.1080p.MP4-G` | `site:2023-04-15:the-1080-club` | `The 1080 Club` | `1080|-|-|mp4|-|G` |  |
| 48 | `Site.23.04.15.Agent.007.Undercover.XXX.1080p.MP4-G` | `site:2023-04-15:agent-007-undercover` | `Agent 007 Undercover` | `1080|-|-|mp4|-|G` |  |
| 49 | `Site.23.04.15.Agent.007.Overcover.XXX.1080p.MP4-G` | `site:2023-04-15:agent-007-overcover` | `Agent 007 Overcover` | `1080|-|-|mp4|-|G` |  |
| 50 | `Site.23.04.15.Miss.AVI.XXX.1080p.MP4-G` | `site:2023-04-15:miss-avi` | `Miss AVI` | `1080|-|-|mp4|-|G` |  |
| 51 | `Site.23.04.15.Miss.MKV.XXX.1080p.MP4-G` | `site:2023-04-15:miss-mkv` | `Miss MKV` | `1080|-|-|mp4|-|G` |  |
| 52 | `[Site] 2023-01-01 - Girls Of Web` | `site:2023-01-01:girls-of-web` | `Girls Of Web` | `-|-|-|-|-|-` | **new** |
| 53 | `[Site] 2023-01-01 - Episode 2 4K` | `site:2023-01-01:episode-2` | `Episode 2` | `2160|-|-|-|-|-` | **new** |
| 54 | `[Site] 2023-01-01 - Episode 3 4K` | `site:2023-01-01:episode-3` | `Episode 3` | `2160|-|-|-|-|-` | **new** |
| 55 | `Site.23.04.15.Alex.Coal.1080p.MP4-WRB` | `site:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` |  |
| 56 | `Site.23.04.15.Alex.Coal.XXX.MP4-GRP` | `site:2023-04-15:alex-coal` | `Alex Coal` | `-|-|-|mp4|-|GRP` |  |
| 57 | `Site.23.04.15.Alex.Coal.XXX.MKV-GRP` | `site:2023-04-15:alex-coal` | `Alex Coal` | `-|-|-|mkv|-|GRP` |  |
| 58 | `Site.23.04.15.Alex.Coal.XXX.WMV` | `site:2023-04-15:alex-coal` | `Alex Coal` | `-|-|-|wmv|-|-` |  |
| 59 | `Site.23.04.15.Alex.Coal.XXX` | `site:2023-04-15:alex-coal` | `Alex Coal` | `-|-|-|-|-|-` |  |
| 60 | `4K.Media.23.04.15.Alex.Coal.XXX.1080p.MP4-G` | `4k-media:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|G` |  |
| 61 | `WebYoung.23.04.15.Alex.Coal.XXX.1080p.MP4-G` | `webyoung:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|G` |  |
| 62 | `Tushy.com.23.04.15.Emily.Willis.XXX.1080p-G` | `tushy-com:2023-04-15:emily-willis` | `Emily Willis` | `1080|-|-|-|-|G` |  |
| 63 | `Vintage.1979.Collection.23.04.15.Alex.Coal.XXX.1080p.MP4-G` | `vintage-1979-collection:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|G` |  |
| 64 | `Bang.com - Alex Coal - Deep - 2023-01-01 - 1080p` | `bang-com:2023-01-01:alex-coal--deep` | `Alex Coal - Deep` | `1080|-|-|-|-|-` | **new** |
| 65 | `Deeper.com - Alex Coal - Deep - 2023-01-01 - 1080p` | `deeper-com:2023-01-01:alex-coal--deep` | `Alex Coal - Deep` | `1080|-|-|-|-|-` | **new** |
| 66 | `Private.com - Alex Coal - Deep - 2023-01-01 - 1080p` | `private-com:2023-01-01:alex-coal--deep` | `Alex Coal - Deep` | `1080|-|-|-|-|-` | **new** |
| 67 | `Nubiles.net - Alex Coal - Deep - 2023-01-01 - 1080p` | `nubiles-net:2023-01-01:alex-coal--deep` | `Alex Coal - Deep` | `1080|-|-|-|-|-` | **new** |
| 68 | `[Bang.com] - Alex Coal - Deep - 2023-01-01 - 1080p` | `bang-com:2023-01-01:alex-coal--deep` | `Alex Coal - Deep` | `1080|-|-|-|-|-` | **new** |
| 69 | `http://www.site.com/rss - Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` | **new** |
| 70 | `[pornsite.net] Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `brazzers:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` | **new** |
| 71 | `[Vixen] Kylie - Page Turner - 2023-07-19` | `vixen:2023-07-19:kylie--page-turner` | `Kylie - Page Turner` | `-|-|-|-|-|-` | **new** |
| 72 | `[Vixen] Kylie Page - Turner - 2023-07-19` | `vixen:2023-07-19:kylie-page--turner` | `Kylie Page - Turner` | `-|-|-|-|-|-` | **new** |
| 73 | `[Tushy] Anna Bell - Peaks - 2023-07-22` | `tushy:2023-07-22:anna-bell--peaks` | `Anna Bell - Peaks` | `-|-|-|-|-|-` | **new** |
| 74 | `[Tushy] Anna - Bell Peaks - 2023-07-22` | `tushy:2023-07-22:anna--bell-peaks` | `Anna - Bell Peaks` | `-|-|-|-|-|-` | **new** |
| 75 | `[EmpornIum] Brazzers.2023.04.15.Alex.Coal.XXX.1080p.MP4-WRB` | `empornium-brazzers:2023-04-15:alex-coal` | `Alex Coal` | `1080|-|-|mp4|-|WRB` | **new** |
| 76 | `[EmpornIum] Brazzers.2023.04.15.Alex.Coal.XXX.2160p.HEVC.MP4-WRB` | `empornium-brazzers:2023-04-15:alex-coal` | `Alex Coal` | `2160|-|h265|mp4|-|WRB` | **new** |
### Invariants asserted over the whole table

| Test | Property |
|------|----------|
| round-trips to its pinned identity key | every accepted name has a stable, stated key |
| deterministic across repeated calls | no stateful (`g`-flag) regex leaks `lastIndex` between feed items |
| every encode, spelling, and layout of one scene shares a key | no under-collation within a scene group |
| no two distinct scenes ever share an identity key | **no over-collation** — the property that matters |
| no title is silently truncated | display title matches exactly, per row |
| every accepted name keeps its full quality tokens | resolution/source/codec/container/vr/group pinned per row |
| encodes of one scene are ranked apart | within a scene, rows with different resolutions must score differently — the behaviour the row above protects |
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
| `Site.23.04.15.Name.XXX.1080p.MP4-Part1` / `-Part2` | new. A part tag, not a group. Detaching it merges the two halves of one scene under one key. Rejected by the caps test. |
| `Site.23.04.15.Name.XXX.1080p.MP4-PART1` / `-PART2` | new. Same, correctly capitalised — rejected only by stripping the trailing digits before the `NON_GROUP_TERMS` lookup. |
| `Site.23.04.15.Name.XXX.1080p.MP4-UNCUT`, `-FRENCH` | new. Edit and language tags in `NON_GROUP_TERMS`; the caps test passes them, so the list is what rejects these. |
| `Site.23.04.15.Name.XXX.1080p.MP4-Bonus` | new. An edit tag no finite list would contain; only the caps test rejects it. |
| `Site.23.04.15.Name.XXX.1080p.HEVC.UNCUT` / `.Bonus` | new. The same two cases, dot-attached. |
| `Site.23.04.15.Name.XXX.1080p.MP4-CD1` / `-CD2`, `-PT1` / `-PT2`, `-DISC1` / `-DISC2` | new. Disc and part numbering. Each is rejected only by its own `NON_GROUP_TERMS` entry, so each entry carries its own pair of rows; without them, removing `CD` silently re-opens the merge those entries were added to close. |
| `Site.23.04.15.Name.XXX.1080p.HEVC.G` | new. A single character attached by the name's own separator is a stray; a hyphen is what makes a one-letter tag like `-G` credible. |
| `[Vixen] Alex Coal - Beautiful Episode` | delimited listing with no date: the anchor the whole rule rests on is absent |
| `19-07-2023 - Alex Coal - Beautiful Episode 1080p` | delimited listing whose first segment is the date, leaving no site |

## 7. Regressions — each still holds, with evidence

Each is asserted twice: as a named test in `parse-corpus.test.ts` *and* as rows
inside the corpus table, so deleting one does not remove the coverage. The
original `parse.test.ts` also still pins all of them, unmodified.

| # | Regression | Evidence |
|---|-----------|----------|
| 1 | Two encodes of one scene share a key; two scenes never do | `regression 1`; corpus invariants 3 and 4 over all 76 rows |
| 2 | A release group named `XXX` does not break the boundary | `regression 2`: `TeamSkeet.24.01.02.Jane.Doe.XXX.{1080p,2160p.HEVC}.MP4-XXX` → one key, title `Jane Doe`. Structural reason: the group is detached before the boundary walk. |
| 3 | An in-title `XXX` neither collapses nor truncates | `regression 3`: `Anniversary.XXX.1080p` and `Anniversary.XXX.Edition.XXX.1080p` get different keys; the latter's title is `Anniversary XXX Edition`. Corpus also pins `Gala XXX MP4 Madness`, `XXX Anniversary`, `Anniversary XXX 4K Party`, `XXXtreme Makeover`. |
| 4 | Separator and case differences never split a group | `regression 4`: dot / space / underscore / hyphen spellings of one name → one key. Corpus rows 1-7. |
| 5 | An underscore name yields the *same quality tokens* as its dotted twin | `regression 5`: `deepEqual` on the whole `quality` object for three pairs, including `WEB_DL`/`H_265`. The original `invariant: separator spelling never changes the quality tokens` also still passes unmodified. |
| 6 | An invalid calendar date returns `null` | `regression 6`: `23.13.45`, `23.02.30`, and `20231345` |
| 7 | Identity stays inside the alphabet destinations need | corpus invariant `every key stays inside the alphabet...`; `plan-import.test.ts` unmodified and passing, including the destination-stability and path-sanitisation tests |
| + | A studio named after its domain keeps its own name as the site | `a studio named after its domain keeps the studio as the site`: five `.com`/`.net` studios in the listing form → five distinct keys, `display.subtitle` equal to the studio. Previously all five collapsed onto `alex-coal:2023-01-01:deep`. |
| + | Sorted components cannot be re-split into a collision | `the component join is injective...`: `Kylie`+`Page Turner` vs `Kylie Page`+`Turner`, `Anna Bell`+`Peaks` vs `Anna`+`Bell Peaks` |
| + | A tracker stamp does not cost a dotted name its quality | `a tracker stamp in front of a dotted name...`: `deepEqual` against the unstamped name's quality, and the 1080p/2160p encodes score apart |
| + | A part or edit tag is never detached as a group | `a part or edit tag is never detached as a release group`, plus six refusal rows |
| + | A website prefix does not split a group (the mis-parse this rewrite was called for) | `regression 7`: all three prefixed forms → `brazzers:2023-04-15:alex-coal`, identical to the bare name. Previously `www-site-com-brazzers:2023-04-15:alex-coal`. |

## 8. Review response and mutation check

Two Critical over-collations and three Important defects came back from review.
All five are fixed; each has a corpus row or named test **verified to fail
against the pre-fix commit** (11 of 23 corpus tests fail there, including every
one of the four targeted ones).

| ID | Defect | Fix |
|----|--------|-----|
| C1 | A `.com` studio in the listing form was stripped as a website prefix, promoting the performer to the site: five real studios → one key, all files under `Alex Coal/` | A prefix now requires `www.` or a scheme; a bracketed bare domain is stripped only when the name is not a listing |
| C2 | The sorted join used `-`, the same character `slug()` emits, so component boundaries dissolved and re-splits collided | Join with `--`, which `slug()` can never produce inside a component |
| I3 | A leading bracket handed a dotted name to the listing recogniser, destroying its whole encode section and tying every encode in the group at one score | Positive shape test: the listing recogniser declines on a dotted date run |
| I4 | The hyphen branch returned a group without calling `looksLikeGroupTag`, so `-Part1`/`-Part2`, `-UNCUT`, `-FRENCH` merged | Both branches routed through the same guards, with `minLength` 1 for hyphen and 2 for dot |
| I5 | The caps test and `NON_GROUP_TERMS` masked each other; the conditional extension strip was unpinned | `quality` pinned per corpus row, plus refusal rows that separate each guard |

The corrected claims are also fixed **in the code comments and the test file's
doc comment**, not only here: §4's non-collision lemma was false as originally
implemented and is now stated as a property of the delimiter, and §2's
"the caps requirement is load-bearing" now correctly says that the caps test,
`NON_GROUP_TERMS`, and the digit strip are three independent guards applying to
both attachment forms.

One further defect surfaced while pinning quality, unprompted: `2160p60` matched
no resolution pattern, so a 2160p60 encode scored as resolution zero and ranked
*below* a 480p inside its own group — the same upgrade inversion as the
underscore bug. Resolution patterns now absorb a frame-rate suffix. It would
have been enshrined as correct had I pinned `quality` without reading it.

### Mutation check on the guards touched

Ten mutants, run against the whole `plugin-scenes` suite. Baseline: 0 failures.
Every mutant is killed, and the two that initially survived (M3, M10) were
killed by adding the refusal rows that separate them, not by weakening them.

| Mutant | Tests failed |
|--------|--------------|
| M1 drop the caps test | 2 |
| M2 drop `NON_GROUP_TERMS` | 2 |
| M3 drop the digit-strip lookup | 2 (0 before adding `-PART1`/`-PART2`) |
| M4 hyphen branch skips the guards | 4 |
| M5 unconditional extension strip | 2 |
| M6 prefix marker optional (the C1 regression) | 80 |
| M7 drop the dotted-date decline (the I3 regression) | 12 |
| M8 join with a single `-` (the C2 regression) | 6 |
| M9 drop the frame-rate suffix | 2 |
| M10 dot branch accepts a 1-character tag | 2 (0 before adding `.HEVC.G`) |

## 9. Second review round

Re-review closed all five earlier findings and raised one substantive defect
plus three coverage gaps.

### 9.1 (Important) `titleCaseSlug` erased the component boundary

C2 separated the re-split scenes at the identity layer, but `plan-import.ts`
split the scene slug on a single `-`, so the `--` vanished and the very pairs
C2 distinguishes landed on one destination:

```
vixen:2023-07-19:kylie--page-turner  ->  Vixen/2023-07-19 - Kylie Page Turner.mp4
vixen:2023-07-19:kylie-page--turner  ->  Vixen/2023-07-19 - Kylie Page Turner.mp4
```

Not data loss — the importer refuses an occupied destination — but the second
scene then fails on every attempt and can never be imported. The reviewer's
fuzz found 160 such pairs.

**Fix.** `titleCaseSlug` now splits on `--` into components first, then on `-`
into words within each; words join with a space, components with ` - `. The two
cases above render `Kylie - Page Turner` and `Kylie Page - Turner`.

Why ` - ` and not a new character: these are library paths a human browses, and
the destination already reads `Site/DATE - Scene.ext`, so a hyphen-space
component separator stays in the visual grammar the user already sees rather
than introducing punctuation that looks like an encoding artefact. It is also
already known path-safe, since `sanitizeSegment` passes it untouched.

**The injectivity argument, stated properly this time.** `slug()` emits only
`[a-z0-9]` runs separated by single `-`, with no leading or trailing `-`
(independently fuzzed over 7.6M inputs). Therefore a component contains no
`--`, and splitting it on `-` yields no empty words. A rendered word contains
neither a space nor a hyphen; words are joined by ` ` and components by ` - `;
neither delimiter can occur inside a word. The rendering is therefore uniquely
decodable, so distinct slugs render distinctly. **I previously called
`titleCaseSlug` injective when it was not** — the same species of over-claim as
the two corrected in §8, and the reason the claim is now derived from a stated
precondition rather than asserted.

Pinned by `two distinct identity keys never produce the same destination` and
`a multi-component scene renders its component boundary in the path` in
`plan-import.test.ts`. Existing destination tests are unchanged and still pass:
single-component slugs render exactly as before.

### 9.2 Coverage gaps closed

| Gap | Row added |
|-----|-----------|
| `PT`/`CD`/`DISC` guard entries were untested, so all three mutants survived and removing `CD` would silently re-open the I4 merge | six `REFUSED` rows: `-CD1`/`-CD2`, `-PT1`/`-PT2`, `-DISC1`/`-DISC2` |
| Swapping the two recognisers survived the whole suite, because every listing row's tail was a bare resolution that cannot form a valid encode suffix | one listing row whose tail carries a source token: `[Tushy] Beautiful Episode - Alex Coal - 2023-07-22 - 1080p WEB-DL x264` |

### 9.3 Mutation check

Baseline 0 failures. All six new mutants killed, and the two representative
earlier ones re-confirmed.

| Mutant | Tests failed |
|--------|--------------|
| N1 remove `CD` from `NON_GROUP_TERMS` | 3 |
| N2 remove `DISC` | 3 |
| N3 remove `PT` | 3 |
| N4 swap the two recognisers | 9 |
| N5 `titleCaseSlug` ignores `--` (the 9.1 regression) | 5 |
| N6 `titleCaseSlug` joins components with a space | 5 |
| M1 drop the caps test (re-check) | 3 |
| M8 join components with a single `-` (re-check) | 11 |

### 9.4 Ledger — raised, deliberately not fixed

Recorded so they are not lost, and untouched because all are pre-existing or
cosmetic and none is an over-collation:

- the listing form leaks a hyphen-attached group into the identity
  (`- 1080p-GRP`);
- first-date-wins across listing segments;
- `4K60` matches no resolution (the frame-rate suffix fix covered `NNNp60`
  only);
- the `NON_GROUP_TERMS.has(upper)` clause is subsumed by its digit-stripped
  sibling.

## 10. Reference projects

**I did not fetch, read, or consult the source of Whisparr or
ThePornDatabase/namer at any point during this task.** No regex, table,
identifier, comment, or other expression came from either project. Every
pattern in `parse.ts` was written from the shape descriptions in the brief plus
the existing Pickarr code, which is the project's own MIT-licensed work. The
only thing carried over is domain knowledge stated in the brief itself — which
release-name shapes exist in the wild, and that the date is the right boundary
— which are facts about the domain rather than protected expression. The
repository stays MIT-clean.

## 11. Shapes not supported

- **Bare orientation numerals in VR names** (`...VR.LR.180.MP4-G`). `180` and
  `360` are not in the encode vocabulary because a bare number is a plausible
  title word and the corpus already depends on that (`Agent 007 Undercover`,
  `The 1080 Club`). Adding them would trade a visible refusal for a truncation
  risk in the wrong direction. The common VR form
  (`...XXX.1080p.VR.MP4-G`, `...VR.SBS.MP4-G`) is supported.
- **A bare-domain prefix that really is a prefix.** This is the other half of
  the C1 fix and it is a genuine loss: `site.com - Brazzers.23.04.15....` is no
  longer stripped, so it attributes to the site `site com - Brazzers` and files
  under the wrong directory. Unavoidable, because `Bang.com - Alex Coal - ...`
  is the same string shape and stripping there was the Critical. Prefixed with
  `www.` or a scheme it is stripped correctly. This is under-collation plus a
  wrong path, not over-collation, which is why the trade goes this way.
- **Ambiguous day/month in the listing form** (`07-08-2023`). Read day-first.
  Where a tracker means month-first the scene files under the transposed date,
  which splits a group rather than merging two — under-collation, the
  acceptable direction. Refusing instead would lose the whole shape.
- **Any release-group tag that is not 1-8 all-caps alphanumerics.** This is
  broader than "fully lowercase names", which is how I first described it and
  which understated the cost. The rule refuses `-Rarbg`, `-Ghost`, `-Evil`,
  and equally `-EVILANGEL` and `-DIGITALPLAYGROUND` (both over eight
  characters) — twelve realistic spellings were measured, and all parsed before
  this change. The caps-and-length test is what keeps unlisted edit tags such
  as `-Bonus` out, and no finite term list can replace it, so this is the price
  of closing I4. Case *differences* still never split a group — the pinned
  spellings all carry a short all-caps tag — but a name whose group tag falls
  outside that shape yields `null` rather than a key. Widening the length bound
  would recover the long studio-style groups at some cost in edit-tag risk;
  that trade is worth revisiting with real feed data.
- **Names with no date.** Out of scope by construction — the rule is the date.
  These were already refused and still are.
- **A tracker stamp in front of a dotted name under-collates.**
  `[EmpornIum] Brazzers.2023.04.15....` keeps its full quality but keys as
  `empornium-brazzers:...`, so it does not join the unstamped scene's group.
  Stripping an arbitrary leading bracket is not safe — in the listing form that
  bracket *is* the studio — and under-collation is the acceptable direction.
- **A title genuinely ending in an anchor-introduced encode run.** The residual
  class from §1. Refused, not guessed.

## 12. `npm run check`

Exit status 0. Warnings shown are pre-existing and all in `packages/core`;
`packages/plugin-scenes` produces none. 241 tests pass (216 before this work,
plus 23 corpus tests and 2 destination-injectivity tests). No existing test was
modified.

```

> check
> npm run lint && npm run typecheck && npm run test


> lint
> oxlint

packages/core/src/pipeline/upgrade.ts:149:5: warning eslint(preserve-caught-error): There is no cause error attached to this new thrown error. help: Preserve the original error by using the `cause` property when re-throwing errors.
packages/core/src/pipeline/import.ts:429:5: warning eslint(preserve-caught-error): There is no cause error attached to this new thrown error. help: Preserve the original error by using the `cause` property when re-throwing errors.
packages/core/src/config/load.ts:39:5: warning eslint(preserve-caught-error): There is no cause error attached to this new thrown error. help: Preserve the original error by using the `cause` property when re-throwing errors.
packages/core/src/plugins/registry.ts:47:7: warning eslint(preserve-caught-error): There is no cause error attached to this new thrown error. help: Preserve the original error by using the `cause` property when re-throwing errors.

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

✔ addUrl sends the category and returns the nzo id (14.319625ms)
✔ addUrl sends the caller-provided label as nzbname (0.240334ms)
✔ addUrl throws when sabnzbd reports failure (0.303708ms)
✔ addUrl throws when no nzo id comes back (0.157375ms)
✔ an error never contains the api key (1.413667ms)
✔ an error thrown by fetchImpl itself never leaks the api key (0.315958ms)
✔ a JSON-parse failure from response.json() never leaks the api key (0.311583ms)
✔ a base64-style api key with +, /, = never leaks, even decoded (0.191166ms)
✔ an api key containing +, /, =, and a space never leaks, even decoded (0.197917ms)
✔ an api key embedded in the thrown error's name is also redacted (0.231958ms)
✔ a non-Error throw from fetchImpl produces the wrapper, not a crash (0.203167ms)
✔ redaction leaves the rest of an error message legible (0.144833ms)
✔ the server's own error field never leaks the api key (0.238417ms)
✔ a percent-encoded request url outside query shape does not leak the key (0.173375ms)
✔ a doubly percent-encoded request url does not leak the key (0.168875ms)
✔ server-supplied strings returned by snapshot never carry the api key (0.347125ms)
✔ an nzo id echoing the request url is not returned verbatim (0.154292ms)
✔ snapshot reads queue and history filtered by category (0.530083ms)
✔ snapshot tolerates missing slots (0.14375ms)
✔ mapPath applies the longest matching prefix (0.05025ms)
✔ mapPath leaves an unmatched path alone (0.031125ms)
✔ loads a valid config (9.576584ms)
✔ resolves a file: secret and trims its trailing newline (16.367792ms)
✔ a missing secret file is fatal and names the path but not the contents (6.963833ms)
✔ a literal api key below the minimum length is rejected (14.334958ms)
✔ a file: secret resolving to a short key is rejected without printing it (4.785292ms)
✔ an invalid config names the offending field (4.182ms)
✔ PICKARR_PORT overrides the configured port (5.353209ms)
✔ two feeds sharing an id is rejected (8.731417ms)
✔ setClientRef throws by name and id rather than silently no-opping on a bad id (1.017292ms)
✔ setStatus throws on a bad id (0.308875ms)
✔ setStoragePath throws on a bad id (0.249041ms)
✔ failDownload throws on a bad id (0.226167ms)
✔ recordError throws on a bad id (0.224667ms)
✔ bumpAttempts throws on a bad id instead of returning 0 (0.21725ms)
✔ bumpMissingPolls throws on a bad id instead of returning 0 (0.23125ms)
✔ resetMissingPolls throws on a bad id (0.253875ms)
✔ resetMissingPolls on a real row whose missing_polls is already 0 is a legitimate no-op, not an error (0.326125ms)
✔ bumpAttempts and bumpMissingPolls increment and return the new count for a real row (0.287125ms)
✔ completeUpgrade keeps a better release flagged instead of clearing it (1.05175ms)
✔ completeUpgrade onto the best release clears the flag (0.2975ms)
✔ picking the worse of two known releases flags the better one (0.269958ms)
✔ picking the best known release leaves nothing flagged (0.24775ms)
✔ an equal-scoring release is not an upgrade (0.25275ms)
✔ flagUpgrade re-derives the same invariant and is the only write that moves list_rank_at (0.245375ms)
✔ migrate creates every table (1.278667ms)
✔ migrate is idempotent (0.299417ms)
✔ feed_items rejects a duplicate guid within a feed (0.28375ms)
✔ feed_items allows the same guid in a different feed (0.201042ms)
✔ media_groups rejects a duplicate identity within a plugin (0.212917ms)
✔ parses items into feed entries (2.527583ms)
✔ prefers the enclosure url over the link (0.310083ms)
✔ falls back to the link when there is no guid (0.277459ms)
✔ a single item is not mistaken for a non-array (0.201042ms)
✔ an empty channel yields no entries (0.615084ms)
✔ a channel containing bare text rather than elements throws (0.409333ms)
✔ an unparseable pubDate becomes null rather than NaN (0.554167ms)
✔ a non-rss document throws (0.191667ms)
✔ items missing a title or link are skipped (0.150375ms)
✔ health responds ok (65.069084ms)
✔ browse returns groups newest-rank first with their releases (2.308667ms)
✔ browse paginates with a stable cursor (1.800625ms)
✔ browse filters by q (1.309417ms)
✔ a picked group with no upgrade drops out of browse and appears in picks (3.799666ms)
✔ picking a release from the wrong group is a 400 (1.735125ms)
✔ a malformed pick body is a 400 (1.834208ms)
✔ downloads merges tracked rows with the untracked snapshot (1.629ms)
✔ retrying a failed import resumes at completed (1.931667ms)
✔ retrying a download that has not failed is refused (1.616541ms)
✔ retrying an unknown download is a 404 (0.918792ms)
✔ no route ever returns the client api key (1.415375ms)
✔ re-ingesting the same guid is a no-op (2.706666ms)
✔ two releases with the same identity collate into one group (0.514958ms)
✔ different identities create separate groups (0.337042ms)
✔ a new release on an unpicked group does not touch list_rank_at (0.327583ms)
✔ a better release on a picked group flags an upgrade and bumps list_rank_at (0.48375ms)
✔ a worse release on a picked group changes nothing (1.144375ms)
✔ an equal-scoring release on a picked group changes nothing (0.769792ms)
✔ a release better than the pick but not the flagged upgrade is ignored (0.468833ms)
✔ a release better than the flagged upgrade replaces it and bumps again (0.405209ms)
✔ an unparseable name records a parse_error and creates no group (0.290292ms)
✔ a plugin that throws does not stop the batch (0.302333ms)
✔ a plugin whose score throws records a parse_error and lets later entries through (0.284875ms)
✔ a plugin returning a non-finite score records a parse_error rather than a failed insert (0.206834ms)
✔ a plugin returning a display with no fields records a parse_error (0.268917ms)
✔ a plugin returning a malformed quality records a parse_error and lets later entries through (0.239917ms)
✔ a plugin returning a display field of null records a parse_error rather than persisting it (0.226667ms)
✔ a plugin returning an empty identity key records a parse_error (0.185458ms)
✔ groups are keyed by plugin id, not by feed (0.226208ms)
✔ search_text is lowercased and includes every display value (0.185125ms)
✔ imports the planned file and records it (16.927833ms)
✔ move removes the source, copy leaves it (13.072209ms)
✔ a cross-device rename falls back to copy-then-unlink (25.842375ms)
✔ a destination escaping the library root is rejected (14.820292ms)
✔ a planned source outside the download listing is refused, naming the path (6.166583ms)
✔ no importable files fails with a named reason (3.252166ms)
✔ retry after a partial import skips files already in place (7.92475ms)
✔ the file listing reaches the plugin with sizes and relative paths (3.796583ms)
✔ a destination resolving to the library root itself is rejected, and the source survives (3.623ms)
✔ a foreign regular file already at the destination fails the import and leaves the source untouched (2.665208ms)
✔ a symlink at the exact destination path is treated as a collision, not adopted (2.365167ms)
✔ a destination that already exists with no surviving source and no recorded row is adopted as crash recovery (1.968541ms)
✔ copy mode: a destination that already matches the source in size is adopted as crash recovery (4.879625ms)
✔ copy mode: a destination with different content than the source is a collision, not recovery (7.593083ms)
✔ a symlink at the destination with the source already gone is still a collision, not adopted (5.133834ms)
✔ runs exclusively and in order (30.886167ms)
✔ a rejection does not wedge the mutex (0.308334ms)
✔ tryRun skips instead of queueing when busy (21.117791ms)
✔ tryRun runs immediately once a preceding run has released the mutex (0.183042ms)
✔ a nested acquisition on the same mutex throws instead of deadlocking (0.252542ms)
✔ picking marks the group picked and starts a download (1.227834ms)
✔ picking sets picked_release_id immediately, before any download finishes (0.369458ms)
✔ an addUrl failure leaves the download queued and the pick intact (0.420709ms)
✔ a pick on an already-picked group is inferred as an upgrade and does not overwrite picked_release_id (0.428ms)
✔ picking a release that belongs to another group is rejected (0.392458ms)
✔ picking an unknown release is rejected (0.237792ms)
✔ picking the same release twice while in flight is rejected (0.341709ms)
✔ the download row records the client id and timestamps (0.324459ms)
✔ a persist failure after a successful addUrl is recorded distinctly from an addUrl failure (0.329291ms)
✔ a failure between marking picked and inserting the download rolls back the pick (0.359708ms)
pickarr: download 1 is named 'R' at the client, expected 'pickarr-1'; label-based double-submit recovery will not work against this server.
✔ a download in the queue stays downloading and resets missing_polls (1.84875ms)
✔ a completed download gets its mapped storage path and is imported (0.474208ms)
✔ a completed row with a storage path is imported even when the client has pruned its history (0.387375ms)
✔ an import failure on a completed row fails the download rather than retrying forever (0.384167ms)
✔ a failed download records the fail message (0.308ms)
✔ a completed download with no storage path fails rather than importing nothing (0.261875ms)
✔ a download missing from both lists fails only after three consecutive polls (0.374792ms)
✔ reappearing resets the missing counter (0.362625ms)
✔ a queued download with no client ref is retried (0.304083ms)
✔ addurl retries stop after the attempt cap (0.724833ms)
✔ entries with no matching row are reported as untracked and never imported (0.528042ms)
✔ an already-imported download still in history is not reported as untracked (0.226875ms)
✔ an import failure fails the download rather than throwing out of the tick (0.281333ms)
✔ a queued download whose addUrl already succeeded is recovered from the queue, not resubmitted (0.248833ms)
✔ a queued download whose addUrl already succeeded and finished is recovered from history and imported in the same tick (0.2445ms)
✔ recovering a ref by label does not consume an addurl attempt, unlike a real retry (0.2245ms)
✔ a fresh addUrl call is given the download-derived label, not the release title (0.215ms)
✔ a tracked download whose client-side name does not match its label warns exactly once, not once per tick (0.440875ms)
✔ a tracked download whose client-side name matches its label never warns (1.324583ms)
✔ importing resets to completed so the next tick redoes the import (1.238667ms)
✔ queued with no client ref is left queued for retry and counted (0.351542ms)
✔ terminal and in-flight rows are untouched (1.152917ms)
✔ reconcileNow caches the untracked snapshot for later reads (1.251542ms)
✔ a reconcile failure is logged and does not throw out of the tick (0.336542ms)
✔ a timer tick that lands while a reconcile is still running is dropped, not queued (29.006292ms)
✔ an ingest failure on one feed does not stop the others (0.714625ms)
✔ an upgrade trashes the old file, writes the new one, and repoints the group (13.835041ms)
✔ re-running the same upgrade import does not trash the files it just imported (17.177708ms)
✔ trash paths are namespaced so repeated upgrades cannot collide (10.32975ms)
✔ a failure after trashing reports where the old file went (3.919333ms)
✔ an initial import trashes nothing and leaves the pointer alone (2.175541ms)
✔ two live files sharing a basename in different library directories both survive in trash (3.739125ms)
✔ a refusal partway through trashing still names where earlier files in the same group went (10.772291ms)
✔ a live row whose file is already gone is trashed with no invented path (6.38625ms)
✔ a live row pointing at a directory is refused rather than trashed (3.910292ms)
✔ a live row that resolves outside the library root is refused rather than trashed (3.918291ms)
✔ loads a plugin and indexes it by package name and id (0.478875ms)
✔ two packages claiming the same id is fatal (0.241334ms)
✔ a plugin config without a libraryRoot is fatal (0.089916ms)
✔ a module without a default export is fatal and names the package (0.079583ms)
✔ an import failure is fatal and names the package (0.077917ms)
✔ byPackage throws for an unregistered package (0.080375ms)
✔ higher resolution always outranks lower (0.376458ms)
✔ resolution dominates codec and source (0.091542ms)
✔ at equal resolution, better source and codec win (0.051834ms)
✔ size breaks ties without ever overtaking a quality tier (0.054ms)
✔ unknown tokens score without throwing (0.057917ms)
✔ plugin-api resolves through the development condition (0.33875ms)
✔ corpus: every accepted name round-trips to its pinned identity key (6.246542ms)
✔ corpus: parsing is deterministic across repeated calls (1.651375ms)
✔ corpus: every encode, spelling, and layout of one scene shares a key (0.684875ms)
✔ corpus: no two distinct scenes ever share an identity key (2.200667ms)
✔ corpus: no title is silently truncated (0.614042ms)
✔ corpus: every accepted name keeps its full quality tokens (0.577125ms)
✔ corpus: encodes of one scene are ranked apart, never tied by a lost token (1.904042ms)
✔ corpus: every key stays inside the alphabet destinations are derived from (0.616875ms)
✔ corpus: the display date always agrees with the key (0.447834ms)
✔ corpus: the new shapes really are new coverage (0.10075ms)
✔ refusal set: ambiguous names are refused rather than guessed (0.169958ms)
✔ regression 1: two encodes of one scene share a key, two scenes never do (0.059667ms)
✔ regression 2: a release group literally named XXX does not move the boundary (0.044625ms)
✔ regression 3: an in-title XXX neither collapses nor truncates the title (0.049791ms)
✔ regression 4: separator and case differences never split a group (0.063959ms)
✔ regression 5: an underscore name yields the same quality tokens as its dotted twin (0.081459ms)
✔ regression 6: an invalid calendar date returns null (0.033125ms)
✔ regression 7: a website prefix does not split a group (0.054667ms)
✔ listing layout order does not change the identity key (0.073083ms)
✔ the component join is injective: a re-split of one string is a different key (0.052459ms)
✔ a studio named after its domain keeps the studio as the site (0.067375ms)
✔ a tracker stamp in front of a dotted name does not cost it its quality (0.061625ms)
✔ a part or edit tag is never detached as a release group (0.052833ms)
✔ parses the canonical Site.YY.MM.DD.Names.XXX.quality-GROUP form (1.863ms)
✔ two encodes of the same scene share an identity key (0.725375ms)
✔ different scenes on the same site and day do not collate (0.099959ms)
✔ separator and case differences do not split a group (0.095208ms)
✔ extracts resolution from every common token (0.2285ms)
✔ extracts video codec and source (0.070375ms)
✔ a two-digit year maps into the 2000s (0.065291ms)
✔ a four-digit year is accepted (0.049875ms)
✔ a release with no XXX marker still parses using the first quality token (0.06775ms)
✔ a name with no date returns null (0.095ms)
✔ an empty name returns null (0.044875ms)
✔ a name with a date but no site returns null (0.039958ms)
✔ an invalid calendar date returns null (0.0345ms)
✔ display fields carry site and performers (0.356167ms)
✔ two scenes differing only by content after an in-title XXX get different identity keys (0.067292ms)
✔ an in-title XXX scene keeps its full title instead of being truncated (0.038584ms)
✔ two encodes of a scene with an XXX release group still share an identity key (0.052292ms)
✔ two scenes differing only by content after an in-title XXX followed by an encode-like word get different identity keys (0.051625ms)
✔ invariant: separator spelling never changes the quality tokens (0.210375ms)
✔ invariant: no two distinct scenes ever share an identity key (0.834334ms)
✔ invariant: every encode of one scene collapses to a single identity key (0.262708ms)
✔ invariant: a title is never silently truncated at an in-title marker or encode word (0.107708ms)
✔ invariant: ambiguous names are refused rather than guessed (0.066041ms)
✔ picks the largest video file and names it from the parsed media (0.891291ms)
✔ skips sample, proof, and screens files even when they are large (0.144292ms)
✔ preserves the source extension (0.100042ms)
✔ returns null when there is no video file (0.044417ms)
✔ returns null for an empty listing (0.039542ms)
✔ sanitizes path separators and reserved characters out of the destination (0.715208ms)
✔ a destination can never escape the library root (0.055709ms)
✔ two releases with the same identity key produce the same destination (0.133625ms)
✔ two distinct identity keys never produce the same destination (0.88325ms)
✔ a multi-component scene renders its component boundary in the path (0.109125ms)
✔ a nested larger video does not beat a top-level smaller one (0.055083ms)
✔ a single junk-named video is imported rather than refused (0.040167ms)
✔ a release with no stated source is treated as an original site rip (0.574833ms)
✔ an explicit re-encode source ranks below an unstated one (0.096208ms)
✔ an explicit source is never overridden (0.051375ms)
✔ resolution still dominates the source adjustment (0.043042ms)
✔ formats the tokens that are present, in a stable order (0.361625ms)
✔ omits absent tokens without leaving separators (0.060292ms)
✔ an empty token set reads as unknown (0.044083ms)
✔ formats sizes in binary units (0.057042ms)
ℹ tests 234
ℹ suites 0
ℹ pass 234
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 430.815417

> test:web
> TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test "packages/web/test/**/*.test.tsx"

✔ a tracked row shows status and offers retry only when failed (11.845ms)
✔ untracked entries render inert and labelled (8.275166ms)
✔ renders the display fields (9.662333ms)
✔ shows one pick control per release, best first (4.206375ms)
✔ picking a release reports its id (2.612416ms)
✔ an upgrade-flagged group is badged (2.412292ms)
✔ the release you already own is marked and not offered again (1.584042ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 433.931958
```

(Long-tail `no-await-in-loop` / `prefer-set-has` / `no-array-sort` /
`consistent-function-scoping` warnings from `packages/core` elided above; all
pre-existing and unrelated.)
