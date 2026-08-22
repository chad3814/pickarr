# Known issues

This file is now two things at once.

**A map of the tracked defects.** Everything here that is a defect — something that
behaves wrongly, or something absent that should exist — now lives as a GitHub issue.
Those appear below as links, under their original section heading and in their original
order. The full evidence for each one, verbatim, is in the issue.

**The standing record of why the parser is shaped the way it is.** The rest of this file
is not work. It is settled reasoning: a rule that works, and the alternatives that were
tried against real feeds and cost more than they bought. Those entries stay here in full
and in place, because their job is to stop someone undoing the decision. They were not
filed as issues because there is nothing in them to research or solve.

So, reading below: **a bulleted link is tracked work; a paragraph is settled reasoning.**

Everything was found during the build and verified to reproduce. Nothing here is
speculative. The most useful of these will be settled by pointing Pickarr at a real
indexer and reading the `parse_error` rows it produces.

## Parser

The parser was rewritten after the MVP. It now finds the identity/encode boundary from
the **date** rather than from an `XXX` marker, which is what the mature tools in this
space do and what the marker approach kept failing at — `XXX` occurs both inside titles
and as a release-group name, and three separate attempts to disambiguate it each moved
the bug rather than closing it. The date is unambiguous and effectively always present.

It handles the plain dotted form, dot-attached release groups, bracketed sites with the
date in several positions, `Studio - Performers - Title (Month DD, YYYY)`, concatenated
`YYYYMMDD` and `YYMMDD`, website prefixes, trailing file extensions, and VR tags.

What follows is what it still gets wrong.

- [A release group's name may contain spaces, and reading it as one token cost 65% of all parse failures](https://github.com/chad3814/pickarr/issues/3) — `...XXX.XviD-iPT Team` was read as the single token `Team`; 1,496 of 2,302 corpus refusals.

**A hyphen-attached release group must be 1–12 alphanumerics and must not be a listed
term**, or the whole name is refused. Casing is not consulted at all.

Two stricter rules were tried against real feeds and both cost more than they bought.
Requiring all caps refused `-FETiSH` and `-Zsex3i`, which are real groups. Refusing
word-shaped tags additionally refused `-Ghost`, `-Rarbg`, `-rartv` and `-xpost`, also
real. Nothing structural separates `Ghost` from `Bonus` — same length, same casing, same
character classes — so any shape rule that admits one admits the other. The only question
is which error to take.

What guards the position instead is **the resolution, which is a second anchor**. Extra
content is named *before* the resolution, and only format and a group tag follow it. So
`Site.23.04.15.Name.Bonus.XXX.1080p.MP4-WRB` keeps `Bonus` in the identity — a different
piece of content, its own group — while `Site.23.04.15.Name.XXX.1080p.MP4-Bonus` reads
`Bonus` as a group, because nothing else can be there. Two strings that look alike are
unambiguous as positions. `B0NUS` is a real group name, which is the clearest argument
that a word list could never have done this job.

**`NON_GROUP_TERMS` is a narrow exception to that positional rule — and measurably a
quiet one.** 2,310 real indexer titles containing `cd`/`part`/`disc` markers were
checked: **none** placed one after a resolution in the trailing group position, and
removing the four split-marker entries changed nothing on that sample. Where those
markers actually occur — inside the title, or before the resolution — they land in the
identity by themselves and the halves keep separate keys with no rule involved. That is
the positional rule working, not the list.

The entries stay because they cost nothing and the failure they prevent is the expensive
kind, but they are insurance against an unobserved shape rather than a load-bearing
guard. The tags in question: `-Part1`/`-Part2`, `-CD1`/`-CD2` and `-DISC1`/`-DISC2` are
halves of one scene, so merging them means picking one half believing it is the whole;
`-UNCUT`, `-UNCENSORED`, `-DIRECTORS` are different cuts. Matching is case-insensitive
and digits are stripped, so one entry covers `Part1`, `part2` and `PART`. Removing an
entry re-opens exactly one merge with no second rule behind it — though on current
evidence the split-marker entries have nothing to re-open.

- [Release group tags over twelve characters are still refused (`-DIGITALPLAYGROUND`)](https://github.com/chad3814/pickarr/issues/4) — Still refused for length: `-DIGITALPLAYGROUND` and anything over twelve characters.

**A date at the very end, with the encode ahead of it, is the same shape read from the
other side.** `teensexmania_mishelle-klein_babe-loves-sperm-as-coffee-2160p-18.12.18`
puts the date last of all, so the date-at-end reader — which wants every token *after*
the date to be encode information — saw nothing after it and declined, and the ordinary
reader found nothing following the date and refused.

Both readings are now one function. When the date trails the name, the encode boundary
inside the pre-date run does the job the trailing run does in the ordinary case, and the
identity ends at that boundary rather than at the date — otherwise `2160p` lands in the
scene title. A trailing date with *no* encode section before it is still refused: nothing
would separate site from title or title from encode.

- [Date-at-end names need a configured site list to file correctly, and changing a site's name re-keys every affected scene](https://github.com/chad3814/pickarr/issues/5) — Without the list `Anal Only`'s scenes file under `Anal/`, and anything already picked reappears as a new group rather than an upgrade.

**Site matching drops separators, and the configured spelling is canonical.** A site's
own name and the way releases write it disagree about word boundaries roughly 10-15% of
the time: ThePornDB calls the site `Bang Bros`, most releases use the `short_name` as a
single token (`BangBros`, `bangbros`), and a minority split it (`Bang.Bros`). Matching
therefore compares alphanumerics only, so all of those find one site — a slug comparison
made `bang-bros` and `bangbros` two different sites, which was a live bug the first time
this ran against the real API. The *matched* name then replaces whatever the release
wrote, so one site cannot become three groups depending on spelling. The corollary is
that the configured (or discovered) spelling decides the directory, and `ANALONLY` is a
legitimate if ugly choice. It does *not* decide the key: the key's site segment is that
same alphanumerics-only form, so matching and keying cannot disagree. They used to — the
key was a slug — and a site confirmed after some of its scenes had been ingested split
them into two groups that could never merge.

- [A sub-site is only found when it is the name's leading run](https://github.com/chad3814/pickarr/issues/6) — `Bangbros.Ass.Parade....` resolves to `Bang Bros`, not to `Ass Parade`.
- [A confirmed site's own name must be at least four characters, and the cache outlives the rule](https://github.com/chad3814/pickarr/issues/7) — `Big.Boobs.For.The.Win` resolved to the site `BIG`; entries confirmed before the floor existed need clearing from `discovered_sites` by hand.

**A search result is believed only when it is one of the release's own leading runs.**
Two weaker rules were tried against the live API first and both are wrong. Confirming on
a non-zero result count invents sites: the search is a substring search over 100k+ names,
so `Getting In` returns `Getting In Deep` and friends without any site being called that.
Confirming only when a result *equals the query* fails in the other direction, because
the site is routinely longer than the query that finds it — `2 Chicks` finds
`2 Chicks Same Time`, `Free Use` finds `Freeuse Fantasy`, and neither query names a site.
Worse, that rule then falls through to the one-word retry, and **there is a real site
named `Free`**, so `Free.Use.Fantasy...` confirmed it and filed the scene under `Free/`
with the title `Use Fantasy ...` — a confidently wrong answer that got cached. Matching
returned names against the release's leading runs, longest first, is what settles all
three cases. `MAX_SITE_TOKENS` caps a site at five words.

- [Only two searches are made per unknown site, so a site whose first two words are absent from its registered name is undiscoverable](https://github.com/chad3814/pickarr/issues/8) — Only two searches are made per unknown site: the first two words, then the first.

**A short site-token cap causes wrong hits, not misses, so it is set generously.**
`MAX_SITE_TOKENS` is 12. The instinct to keep it small is backwards here. Matching is
exact equality against a name the service returned and the longest match wins, so extra
length only adds candidates that must still equal a real site. Truncating actively
misresolves: capped at five, `Giga.de.Rein.Mk.II.Delusion.group` matched the separate and
entirely genuine site `Gigade Rein Mk-II`, because the truncated run happened to equal
it exactly. That search returns 29 near-identical names differing by a letter
(`Rain`/`Rein`) or a suffix, and only the full-length run picks the right one. Names in
this space run long — `Giga de Rein no odor - the woman who appeared uncensored -` is ten
tokens.

- [A single-letter query is never sent, so the real site named `X` can be configured but never discovered](https://github.com/chad3814/pickarr/issues/9) — A single-letter query is never sent; a single-digit one is.

**Searches are paged, with two bounds.** The service caps `per_page` at 100 (asking for
more returns an empty body), and one-word fallback queries routinely exceed that:
measured live, `free` returns 149, `teen` 349, `anal` 352, `big` 649. Stopping at page
one silently loses any site past the first hundred, so a search walks up to
`MAX_PAGES` (10). The second bound is for queries too broad to be a site lookup at all —
`a` reports 87,955 matches, and walking 880 pages to look for an exact name is pointless
work — so a reported total above `MAX_TOTAL_TO_WALK` (1000) stops after page one. Page
one is still examined, since an exact match tends to rank first. The cost is paid once
per prefix ever, because both hits and misses are cached.

The list deliberately does **not** apply to the ordinary date-in-the-middle form, where
the date already supplies the boundary, nor to the bare-domain case below. Extending it
there would change how names that parse correctly today are read, which is a different
decision from adding a shape that currently fails.

**A confirmed site can stand in for the encode boundary.** A dateless name used to need
*both* a site and a trustworthy encode boundary. The boundary was only ever needed to
find where the title stops, and a confirmed site says where it starts — the same
information from the other end. `TripForFuck - Hiyori JAPANESE 2` has no date and no
encode vocabulary at all, and parses once the site is known.

One guard came out of this. On that path nothing has removed an encode section, because
there was no trustworthy place to cut one, so if what follows the site *starts* with
encode vocabulary the name is site plus encode with no scene: `Brazzers.1080p.MP4-WRB`
would otherwise have taken `1080p MP4-WRB` as its title. An existing test caught it.

**The bare-4K poster is filed under the site it comes from.**
`4K.kleo.34ans.de.clapiers` — 24 corpus titles, all distinct, none in ThePornDB. A
resolution cannot be a site, so there is no site anywhere in the text and nothing to look
up. They are Jacquie et Michel TV's output, which appears in the same feeds under its own
name, so they file there rather than in a bucket of their own — `4K.kleo...` and
`JacquieEtMichelTV.26.06.02.Lena...` belong in one directory.

- [The bare-4K rule is a named case rather than a structural rule, so another bare-resolution poster would be filed wrongly](https://github.com/chad3814/pickarr/issues/10) — The site is not detected from the text; it cannot be, there is nothing there.

**Every shape canonicalises its site against the configured list, including the ones that
never look a site up.** The ordinary dated form takes its site verbatim from the text
ahead of the date and used to stop there, so configuring `Jacquie Et Michel TV` split that
site in two: dated releases kept the release's own `JacquieEtMichelTV` while the
date-at-end, dateless and bare-4K ones took the configured spelling, and the same site
filed under two directories. A test written for the bare-4K poster is what surfaced it.

**A release with no date at all parses only when its site is confirmed.** These exist,
and until the site lookup arrived they were refused outright — the date was the only
thing marking where the site stopped. A confirmed site marks it just as well, so the
shape is now read as site, then title, then encode, with the encode boundary as the only
anchor.

There is deliberately **no first-token fallback here**, unlike the date-at-end shape.
The date was also the evidence that a name was a scene release at all, and without it
`Some.Random.Movie.2023.1080p.BluRay-GRP` and `Some.Band.Live.At.Wembley.1080p.WEB-DL`
have exactly this shape. Requiring a real site is what replaces that evidence; guessing
would turn every unrecognised release in a feed into a group filed under its first word.

- [Dateless keys carry an empty date segment, so two different scenes from one site sharing a title become one group](https://github.com/chad3814/pickarr/issues/11) — Dateless keys carry an empty date segment, and that is a knowing over-collation.

**A bare TLD directly after a confirmed site belongs to the domain.**
`BralessForever.com.Emma.G.and.Rocky.Beach.Days.2160p` files under `Braless Forever`
with the title `Emma G and Rocky Beach Days`; without the rule the title would begin
`com`. It only ever runs *behind a confirmation*, which is what keeps it clear of the
bare-domain problem below: nothing confirms `Bang` in `Bang.com - Alex Coal`, so the rule
never fires there. It also never consumes the last remaining token.

- [One unknown encode word refuses the whole name, so the encode vocabulary is worth extending on evidence](https://github.com/chad3814/pickarr/issues/12) — A token the vocabulary does not know interrupts the trailing run and the whole name is refused.

**An indexer's trailing runtime stamp is stripped.** `... MP4-KTR [06:32:12]` sits behind
the group tag, so the encode run stops reaching the end and the name is refused over
three characters of metadata. The strip is deliberately narrow — a bracketed `HH:MM:SS`
at the very end and nothing else — because bracketed text is *not* junk in general: the
delimited form reads `[Vixen] Alex Coal - ...` and depends on it surviving.

**There is no length cap on a release group.** One lived here at 8, then 12, on the
reasoning that a group tag is short and a long run-together token is more likely a title
word. The position rule made it redundant: a tag reads as a group because of *where* it
sits — after the encode section, the one place title material never reaches — and a name
with no encode section detaches no group at all.

Removed after measuring, and the measurement is the point. Across the corpus it gained
two titles (`-JustDifferent`, 13 characters, a real group) and **changed no existing
identity key**. That second number is the one that mattered: a title word swallowed as a
group produces a wrong key silently, without colliding with anything, so the collision
report could not have caught it — but a diff of every key before and against after can,
and did not find one.

**A name carrying no encode vocabulary at all is entirely title.**
`KarupsPC.com_13.10.14.Chelsey.Lanette` used to be refused, on the grounds that nothing
marked where the title stopped. That doubt needs at least one encode-ish token to exist:
`Alex.Coal.MP4-G` might be the scene "Alex Coal" with a container or the scene "Alex Coal
MP4", and nothing settles it — but when no token is encode vocabulary there is no run to
mistake for title and no title to mistake for a run. It also lets
`Site.23.04.15.Alex.Coal` collate with the same scene listed with its encode information,
which refusing could never do. Names that *do* carry a weak encode token are still
refused, for the original reason.

No group is detached on that path either, and it is the same argument rather than a
separate concession: a trailing tag reads as a group because of where it sits, after the
encode section, the one place title material never reaches. With no encode section there
is no such place, so a hyphen is only punctuation and
`Amanda.Verhooks.Anal.Three-way` is a title, not the scene "Amanda Verhooks Anal Three"
from a group called `way`.

**Image and photo sets are refused up front.** `...XXX.IMAGESET-FuGLi` carries a date,
a site and a title, so it parses cleanly on shape alone — and then collates with the
*video* release of the same scene, offering a zip of photographs as one of its versions.
`planSceneImport` would reject the download at import time, long after the pick. This was
introduced accidentally by the rule above and caught only because the titles looked wrong;
**the corpus parse rate went up while the output got worse**, which is worth remembering
about that metric.

- [`REMASTERED` was in the encode vocabulary and the non-group list at once, refusing 14 corpus titles](https://github.com/chad3814/pickarr/issues/13) — The vocabulary entry read `REMASTER`, anchored, so the longer spelling matched neither and interrupted the encode run.

**Interlaced resolutions parse and rank below progressive.** `1080i` claims 1080 and
carries half the vertical detail per field, so it is recorded as `extras.interlaced` and
penalised — below `1080p`, still above a progressive 720p. The penalty is bounded like
the upscale one and deliberately a different size, so a release that is both upscaled and
interlaced ranks below one that is only either; their sum stays under one resolution unit.

**Day-first dates with a four-digit year.** `19.04.2014` — the dotted reader knew
`YY.MM.DD` and `YYYY.MM.DD` but not this, which European sites use. Tried after the
year-first shapes, and the two can never both match: those need a two-digit final token
and this needs a four-digit one. `04.08.2026` is genuinely ambiguous between 4 August and
8 April; it reads day-first, the same convention the delimited reader already follows, so
the two do not disagree.

- [A year restated in full after a short date is swallowed, and eighteen corpus titles were silently keyed wrong](https://github.com/chad3814/pickarr/issues/14) — `ManyVids.26.08.02.2026.August.Heat.2` states 2026 twice — parsing, but wrong.
- [Poster signatures are stripped from a list of observed posters, so a new poster needs a new entry](https://github.com/chad3814/pickarr/issues/15) — A list of names rather than a structural rule. Ten corpus titles.

**An episode number anchors the boundary the same way a date does.** Sites that number
episodes instead of dating them — `HeavyOnHotties.E141.Daniela.Pechotes...`,
`InTheCrack.E1178.Tracy.Gold...` — put `E` followed by two or more digits exactly where
the date sits. It is recognised by shape rather than vocabulary, which is what made the
date a trustworthy anchor in the first place, so it gets the same treatment and needs no
site lookup to do it. Two digits minimum: a bare `E1` is too easy for a title to produce.
`S01E05` tokenises whole and does not match, keeping television numbering out.

The episode occupies the key's middle segment — `inthecrack:e1178:tracy-gold` — so two
encodes of one episode collate exactly as two encodes of one dated scene do. It is
deliberately **not** written to `display.date`, which carries a real date or nothing; a
consumer sorting or filtering on that field must not be handed a string that cannot be a
date. It surfaces as its own `Episode` field and renders in the library path as `E1178`.

Measured: 40 corpus titles carry an E-number and 38 of them now parse, against roughly
five before — a small share of the corpus, but complete coverage of the shape.

- [A bare-domain prefix becomes the site, so a genuine bare-domain stamp files the scene under the wrong directory](https://github.com/chad3814/pickarr/issues/16) — Wrong path, never a wrong merge.
- [The same scene in a dotted and a bracketed listing gets two groups](https://github.com/chad3814/pickarr/issues/17) — The dotted form carries no component boundaries. Under-collation, and probably irreducible.
- [In a listing, a hyphen-attached group inside the quality segment leaks into the identity and the quality is lost](https://github.com/chad3814/pickarr/issues/19) — `- 1080p-GRP`. One of the "Smaller, all pre-existing" defects.
- [When a listing holds two dates the first wins and the second ends up in the title](https://github.com/chad3814/pickarr/issues/20) — One of the "Smaller, all pre-existing" defects.
- [`4K60` matches no resolution because there is no word boundary before the `60`](https://github.com/chad3814/pickarr/issues/21) — One of the "Smaller, all pre-existing" defects.

**A trailing content-type tag and a bare site id are also dropped from the title, and that
is a second, accepted way to over-collate.** `Solo`, `Hardcore` and `Lesbian` name a
scene's type rather than the scene, and a bare number like `42466` is a site's own
catalogue id rather than a title word; both are read as suffix and trimmed, alongside a
trailing language tag, from a title that would otherwise carry junk a metadata service
cannot match against. The cost is structural rather than incidental: if two scenes posted
by one site on one day differ **only** in the tokens this trims, nothing is left to tell
them apart, and they collate onto one identity key —
`PornMegaLoad.26.08.05.Suki.Sin.Solo.42466...` and
`PornMegaLoad.26.08.05.Suki.Sin.Hardcore.42467...` both key as
`pornmegaload:2026-08-05:suki-sin`.

This was measured before it was accepted, not assumed. Across 7,166 parsed corpus titles
there are zero genuine over-collations from it — the fifteen keys that do carry more than
one distinct title are all case or spelling variants of one scene (`Mckenzie Mae` /
`McKenzie Mae`, `And` / `and`, `Zarina Noir` / `zarina noir`), which is
`siteComparisonKey` and `slug` doing their job, not this trade-off firing. There is
nothing to fix here — the alternative is refusing or truncating titles that are
overwhelmingly real and distinct to keep an id or a type tag that, in practice, never
turns out to matter.

Two shapes reach the same class by their own route. A **dateless** name has no day in its
key at all, so two dateless scenes from one site differing only in these tokens collate —
`TripForFuck.Hiyori.Suzuki.Solo.42466` and `...42467` are one key — which widens an
over-collation that shape already accepts by having no date to separate anything. And a
**delimited listing whose date has a two-digit year** is not a listing to the parser at
all: `26.08.05` matches the dotted-date run, so `[Site] Alex - Hardcore 42466 1080p -
26.08.05` is read as a dotted trailing-date name, the walk runs, and it shares
`site:2026-08-05:alex` with the same listing for `42467`. The four-digit spelling of that
same listing keeps both parts and stays distinct. It is pinned by a test (`packages/plugin-scenes/test/suffix-parse.test.ts`,
`'two scenes differing only in dropped tokens share a key, deliberately'`) rather than
guarded against in code, so a future change to what gets trimmed here shows up as a
failing test instead of a silent, undiscovered merge.

**A title that ends in a word shaped like a resolution collates with the scene that word
is a resolution of.** That is the encode-suffix trim itself misfiring rather than a third
trim. With no `XXX` marker in the name the cut lands at the earliest boundary anchor
inside the trailing encode run, and a resolution is an anchor wherever it sits — so
`Site.23.01.01.Party.4K.MP4-G`, the scene "Party" released in 4K, and
`Site.23.01.01.Party.4K.1080p.MP4-G`, the scene "Party 4K" released at 1080p, both key as
`site:2023-01-01:party`. The second carries a consequence the collision alone does not
show: `extractQuality` reads the tail from the same cut, so a 1080p release reports 2160,
and two encodes ranked on that resolution are ranked on a token the name never claimed.

Both readings account for every token in the name, so nothing local can choose between
them and there is no rule that improves this. Cutting later puts `4K` into the title of
every ordinary 4K release; cutting earlier is exactly what the marker case already does
when a marker is there to justify it. It is pinned by a test
(`packages/plugin-scenes/test/parse-corpus.test.ts`, `'a title ending in a resolution word
collides with the scene it is a resolution of, deliberately'`) for the same reason as the
trim above, and it cannot be a corpus row because the no-over-collation invariant would
fail on it by design. Detecting the collision was considered and dropped: the one
observable trace is a release reporting two resolutions' worth of information, which
catches `Party.4K.1080p` and cannot catch `Party.4K`, where the release genuinely is 4K
and the name is indistinguishable from a correctly parsed one. A check that fires on half
the class, on a shape the corpus has never produced, is not worth its false positives.

Two things would make it fixable, neither of them inside the parser. **A marker in the
name** pins the cut ahead of the run: `Site.23.01.01.Party.4K.XXX.1080p.MP4-G` keys as
`site:2023-01-01:party-4k` and reads 1080 correctly. The parser was rewritten away from
the marker as its primary anchor for the reasons at the top of this section, but the
marker still wins where it is present, and nothing Pickarr does makes posters write it.
**A per-scene identifier from the indexer or the metadata provider** would remove the
need to reconstruct identity from the title at all. Metadata confirmation does not supply
one today, and does not even notice the ambiguity: `matchScene`'s dated arm narrows on
closest date and then on title key, the query's title is the already-truncated `Party`,
so the candidate literally titled `Party` wins the tiebreak and the other is recorded as
a lost tiebreak. The group is confirmed against one of the two scenes with nothing
flagged.

**Under-collation by design.** A name whose boundary is genuinely ambiguous returns
`null` rather than guessing. That is the intended direction: a `parse_error` row is
visible and fixable, while a wrong identity key silently merges two different scenes
and you pick the wrong thing.

- [A configurable path template does not move files already imported](https://github.com/chad3814/pickarr/issues/22) — `pathTemplate` decides where new imports land; a change part-way through leaves two layouts side by side until the old files are moved by hand.

Because the default names the encode, **two encodes of one scene render two paths**. An
upgrade therefore lands on its own path and the superseded file is trashed by group
rather than overwritten by path. Omitting `{resolution}` and `{group}` puts both on one
path, where the importer refuses the occupied destination until the old file is trashed.
Both work; they differ in where the old file is standing when the new one arrives.

**Punctuation around an empty placeholder is dropped by structure, not by collapsing.**
The unit is a *run* of adjacent placeholders: `{date}{episode}` share one slot, so the
separator ahead of them goes only when the whole slot is empty. Two simpler rules were
wrong. Dropping the literal *after* an empty placeholder eats the separator holding the
date apart from the title (`2026-08-03chloe upgrades her butt`), and judging placeholders
individually loses the separator for every episode-numbered release
(`inthecrackE1178`). Collapsing repeated punctuation afterwards is wrong for a third
reason: ` - ` is three separator characters a scene slug emits deliberately, and
squeezing it erases the component boundary that keeps `Kylie - Page Turner` and
`Kylie Page - Turner` apart.

**The dot-joined title cannot use dots for both words and components.**
`{titledots}` joins words with `.` and components with `-`, so
`kylie--page-turner` gives `kylie-page.turner` and `kylie-page--turner` gives
`kylie.page-turner`. Using `.` for both renders them identically and the second scene can
then never import — the same collision the `--` boundary exists to prevent, reappearing
one layer down for the third time. Words contain neither `.` nor `-`, so the rendering
still decodes uniquely.

Every value is derived from `identityKey` or from the *group's* display record, never
from the individual release's display strings, so two encodes of one scene render one
path under any template. `{site}`, `{Site}` and `{SiteName}` are the group-record ones:
the key's site segment is separator-free, so deriving them from it would rewrite
`Bang Bros/` as `Bangbros/` in every existing library. There is one display record per
group, so this reintroduces no per-release variation. `{sitename}` and `{SiteName}` run
the words together and are the one pair that is not injective — `bang-bros` and
`bangbros` both give `bangbros` — but those cannot be two different sites, because site
matching compares exactly that separator-free form.

**A constraint, not a defect: `--` inside a scene slug is a component boundary, and
two files have to agree about that.** Where a release names its parts separately —
`[Vixen] Kylie - Page Turner - 2023-07-19` — the parts are sorted and joined with `--`,
so listing order cannot split a group. Sorting alone is not enough: joined with a single
`-`, `Kylie | Page Turner` and `Kylie Page | Turner` produce the same string and two
different scenes merge. `slug()` never emits `--`, which is what makes the doubled
separator injective.

`titleCaseSlug` in `plan-import.ts` has to know this, because it renders the key into a
library path. It splits on `--` first, then on `-`, and joins the components back with
` - `, so those two scenes land at `Kylie - Page Turner.mp4` and `Kylie Page - Turner.mp4`.
An earlier version split only on `-` and dropped empties, which collapsed both onto one
path — the identities were distinct and the files still collided, so the second scene
could never import.

If you change either the join in `parse.ts` or the render in `plan-import.ts`, change
both, and keep the destination-injectivity tests. Single-component names are unaffected;
only multi-part listings render differently, and only since the rewrite.

**If you extend this file, extend the corpus test with it.** `parse-corpus.test.ts`
asserts invariants over a table rather than checking cases one at a time, and it pins
the refusal set deliberately. Both times a fix to this parser was justified by "the
known cases pass", it was wrong; both times it was justified by an argument about
structure, it held.

## Import and upgrade

- [A crash mid-import can cause a benign retry to re-trash correct files](https://github.com/chad3814/pickarr/issues/23) — No data is lost, but the retry does not converge without intervention. Fix this before adding multi-file import plans.
- [Copy-mode crash recovery adopts a destination by byte size](https://github.com/chad3814/pickarr/issues/24) — A foreign file at that exact path with an exactly equal byte count would be adopted.
- [A move-mode `EXDEV` crash no longer self-heals and reports a collision instead](https://github.com/chad3814/pickarr/issues/25) — Deliberate: a stuck import you can see beats automatically deleting a file we cannot prove we wrote.
- [Plugin sources are validated only at plan time, so a source that materialises during import is not caught](https://github.com/chad3814/pickarr/issues/26) — `assertSourcesWereListed` runs at plan time only; adding the same membership check immediately before the transfer closes it.

## Download client

- [A finished job is dropped from the client, with its files](https://github.com/chad3814/pickarr/issues/27) — The client is asked to delete rather than Pickarr doing it; failed, untracked and still-running jobs are left alone.
- [Labels are unique only within one database, so two Pickarr instances sharing a SABnzbd category can recover each other's jobs](https://github.com/chad3814/pickarr/issues/28) — `downloadLabel` is `pickarr-<id>` with no per-installation salt. Give each instance its own SABnzbd category.
- [The `nzbname` round-trip is unverified against a real server](https://github.com/chad3814/pickarr/issues/29) — If SABnzbd renames jobs instead of surfacing our label, recovery silently never fires and the same NZB can be submitted twice.
- [A release title ending in something shaped like `[pickarr-N]`, plus truncation at exactly that offset, can misattribute a ref](https://github.com/chad3814/pickarr/issues/30) — Reproduced under test, but the preconditions make it vanishingly unlikely in practice.

## Web and API

- [`/api/downloads` returns every download row unpaginated, one query per row, and the SPA polls it every three seconds](https://github.com/chad3814/pickarr/issues/31) — Fine for a few hundred rows; not for a few thousand.
- [The browse search parameter is interpolated into a LIKE with no ESCAPE, so `%` and `_` match more than intended](https://github.com/chad3814/pickarr/issues/32) — A query containing `%` or `_` matches more than intended.
- [Picks always go to `downloadClients[0]` regardless of which feed produced the release](https://github.com/chad3814/pickarr/issues/34) — The config accepts several clients with no indication that more than one is only half-wired.
- [Identity-change UI: the failure message is built twice, and unmounting with the dialog open hangs the card's save](https://github.com/chad3814/pickarr/issues/61) — Browse and Picks each construct the "could not be moved" banner, and only one of the two is tested.

**Closed: a malformed pagination cursor is refused rather than served as the first
page.** This was #33. `parseCursor` answered `null` both for "no cursor was sent" and
for "the cursor sent cannot be read", and every caller turned that into the first page,
so a cursor the server could not read named a page other than the one asked for. Under
the SPA that compounds: each page is appended to what is on screen and paging continues
from the `nextCursor` just received, so page one's cursor fetches page two, whose
refusal serves page one again — the list repeats the same cards and never terminates.

Absence and unreadability are now separate answers. `cursorFrom` reports no cursor for
an omitted parameter, which is the first-page request every list opens with, and an
error for one that cannot be read; `/api/browse` and `/api/failed` both answer that
with a 400, from one shared parser over a neutral `KeysetCursor`. Both halves are
parsed digits-only, which also refuses `"100:2:3"` — the old two-binding
`split(':')` discarded everything past the second colon and served the page after
`100:2`, another real page that nobody asked for.

A well-formed cursor whose row has since left the list is deliberately still valid: the
keyset comparison is `(sortKey, id)` against the index rather than a lookup of that row.
That is the ordinary case in both directions — a browse group can really be deleted,
and a failed item is never deleted but stops matching `parse_error IS NOT NULL` once it
is resolved — so refusing it would break paging during normal operation.

## Operational notes

- [There is no authentication](https://github.com/chad3814/pickarr/issues/35) — Put Pickarr behind a reverse proxy or keep it on a LAN.
- [Pickarr never empties `trashDir`](https://github.com/chad3814/pickarr/issues/36) — Deliberate: it is the only destructive operation in the system, so reclaiming the space stays a manual decision.
- [There is no library scanning](https://github.com/chad3814/pickarr/issues/37) — Pickarr only knows about media it picked itself. Files already on disk are invisible to it.
- [A chronically unparseable feed logs its cap of 50 parse-failure lines every tick, indefinitely](https://github.com/chad3814/pickarr/issues/38) — `MAX_REPORTED_PARSE_FAILURES` bounds one tick but not the feed's whole lifetime.
- [The boot-time drift check re-parses every scene group, costs ~160-190 ms, and grows linearly with the library](https://github.com/chad3814/pickarr/issues/65) — Measured at ~120 ms cold over 1222 groups and ~192 ms after later changes on a loaded machine. Recorded rather than optimised: the cost is linear in the number of groups, so it scales with the library and not with anything self-limiting.
- [A group the re-key pass leaves in `failed` is never retried, and one ordering case can put it there](https://github.com/chad3814/pickarr/issues/66) — The marker means the write pass runs once. `planRekey` buckets a mover by the slot it fills and never by the slot it vacates, so a group whose new key is another mover's *current* key can lose the `UNIQUE (plugin, identity_key)` race by id order. Measured 0 occurrences on a real database; recovery is deleting the `app_state` marker row by hand.

## Manual metadata

- [Two merge implementations coexist, one gated on group history and one not](https://github.com/chad3814/pickarr/issues/68) — `editGroup` moves `releases`, `downloads` and `imported_files` and trashes what it supersedes; the re-key pass's `mergeGroupInto` moves `releases` alone and refuses any group with history. Not duplicates in the ordinary sense: they made opposite bargains about what a merge may destroy, so a fix to one silently does not reach the other. `deleteGroup`'s doc comment is currently the only place that is written down.

**Closed: a group ingested before its site was learned no longer re-keys itself on a
save that changed nothing.** This was #39, and the root cause was the identity key
itself — see the "Site matching drops separators" entry above. Once the key's site
segment held `siteComparisonKey`'s separator-free form, the same form site matching
already used, no spelling `learnSites` adds afterward could disagree with the key
built from an earlier spelling, so the re-key this issue reported cannot happen.

That fix left a residual in `sceneToManualValues`'s manual-edit prefill.
`siteForKeySegment` decided what to show in the Edit form's site field by probing
whether the stored display name, or failing that the key segment's own spelling,
would reproduce the key — and if *neither* did, fell back to the display name
anyway, since a prefill has to return something. That third case was believed
irreducible at the time: under the old key shape (`slug`, which keeps separators)
a spelling learned between ingest and Edit could make both probes fail at once,
and #39 was the record of it happening.

It is provably unreachable now, and the reason is short. Every writer of an
identity key in this codebase — `buildRelease`, for anything parsed or hand-entered,
and the migration that re-keyed every group predating this shape — produces the
site segment by calling `siteComparisonKey` directly. `siteComparisonKey` is
idempotent: it strips exactly the characters a second pass would strip, so a string
it already produced is unchanged by producing it again. That makes the key's own
spelling a guaranteed answer whenever the display name's does not, with nothing left
for a third case to guard. The dead branch was removed only after a test drove the
reported shape end to end — a release parsed with no site list, whose group is read
back for editing after `learnSites` grew the list — and confirmed the round trip
holds and the fallback the removed branch used to reach is never taken.

**Closed: editing the identity of a group that had already been downloaded was refused
outright, and the refusal never lifted.** This was #2. `editGroup`'s merge branch answered
409 whenever the source group had any `downloads` or `imported_files` row, and because
nothing ever deletes a `downloads` row, that refusal was permanent for any group ever
picked from — the exact correction (joining a dateless group to the dated group that
supersedes it) that a human fixing metadata by hand most needs to make. The fix replaces
the refusal with a shown plan: a read-only planner works out every consequence of the
merge, the user confirms it, and only then does anything move or get renamed on disk. See
`docs/superpowers/specs/2026-08-16-editing-downloaded-identity-design.md` for the design
and `docs/superpowers/specs/2026-08-07-manual-metadata-design.md` §7.3 and §2 for the
amended reasoning.

#2 is closed by this branch and should be marked closed on merge.

What that replacement left behind, all found by the branch's own whole-branch review and
deliberately not fixed in it:

- [An identity change reports two things imprecisely: the blocker's wording and the trashed count](https://github.com/chad3814/pickarr/issues/59) — the collision blocker blames a stranger for what can be the group's own untrashed file, and `trashed` counts rows rather than files that moved.
- [Trashing failures surface at apply time instead of as blockers, and the vanished-row branch is untested](https://github.com/chad3814/pickarr/issues/60) — the planner pre-checks the files it renames but not the ones it trashes, so the same two conditions become a `failed` entry after the user commits rather than a blocker before.
- [`resolveIdentityFor` runs twice per edit, so the identity applied comes from a different call than the digest matched](https://github.com/chad3814/pickarr/issues/62) — theoretical while the hook is pure, but the digest gate cannot see a hook that is not.

## Scene metadata

**The confirmation rule refuses rather than guesses when candidates tie.**
`confirmSceneMetadata` only confirms a candidate once every weaker one has been
filtered out by site, then by date window, and — where a date window still
leaves more than one — by how close it lands, with title breaking the
remaining tie. When two or more candidates survive that whole run with nothing
left to separate them — a dateless group whose title key matches two on-site
scenes, or a dated one where two are exactly the same distance inside the
window and neither's title matches the query — the group is answered
`confirmed: null` and every tied candidate is recorded as a near miss with
`reason: 'ambiguous: ...'`, so the tie is visible rather than silently broken
by array order. This is the same asymmetry the site-lookup rule elsewhere in
this document is already built around: a wrong confirmation attaches another
scene's performers and synopsis to a card and never says so, while an
unconfirmed one just leaves the card exactly as it was. The two outcomes cost
differently, so the rule is built to fail toward the one you can see.

**A stored answer is settled only while the question is fixed, so anything that
changes the question has to invalidate the answer.** A `group_metadata` row
means the provider has been asked, and `state = 'none'` is one of the answers it
can have given; `enqueueMetadata` therefore refuses to queue any group that has
one. That rule is what makes lazy, browse-driven fetching viable at all —
without it every page view re-queries every card on it, forever, including the
cards the provider has already said it knows nothing about. It has exactly one
assumption, and it is unstated in the rule itself: that the question does not
move. The question is built from the group's display — the site from
`subtitle`, the title, the date — so anything that rewrites a group's display
or deletes the group has moved it, and the row left behind is an answer to
something nobody asked.

Two paths have broken this, both found after the feature shipped rather than
while it was being designed. A **merge** deletes the group the answer belonged
to: the three metadata tables reference `media_groups (id)` with no cascade, so
merging any group that had ever been browsed failed the foreign key and
returned a 500 — a normal action, broken by an invisible row. An **edit**
rewrites the identity the answer described: nothing cleared the row, so the
card kept showing the poster, performers and synopsis of whatever scene the
reading the human had just overruled happened to match, with no way for them to
clear it. `clearGroupMetadata` is the hook for both, and for whatever the third
one turns out to be — a path that mutates a group's identity or display, or
deletes a group, has to call it, in the same transaction as the change itself.

There is a trap in how this looks in `editGroup`, and it is what made the
second bug easy to miss: that function *already* called `clearGroupMetadata`
before either fix, in its merge branch. Read the call and it is a foreign-key
precondition for the `deleteGroup` two lines below it, not a statement that the
answer had become wrong — so its presence made the plain-edit path look
covered on a skim while nothing in that path cleared anything. The edit fix
clears rather than re-queues, because it runs inside the edit's transaction and
the next browse asks anyway; and it is conditional on something actually having
changed, so a save that rewrites nothing does not blank a card's panel to
rediscover the same answer. That condition compares the **display**, not just
the identity key, because a title correction can reduce to the same slug — the
key survives while the question the display produces does not.

**The artwork cache grows and is never evicted, for the same reason `trashDir`
is never emptied.** Every confirmed scene with a poster caches one file under
`metadata.artworkDir`, and nothing here ever deletes one — not when a group is
edited or merged away, not on any schedule. Reclaiming that space is a manual
decision, exactly like emptying `trashDir`: it is disk usage a human should
choose to give back, not something Pickarr silently prunes out from under a
poster someone might still be looking at. Deleting the directory by hand
leaves the affected cards without their posters, because `group_metadata`
still records a `poster_path` that now points at nothing — the poster route
will 404 for it rather than serve one. Clear those rows the same way an
emptied `trashDir` needs no cleanup of its own:

```sql
UPDATE group_metadata SET poster_path = NULL WHERE poster_path IS NOT NULL;
```

That is a metadata loss, not a metadata refetch, and it is worth being precise about
that: the group's `group_metadata` row still exists after this statement runs, and
`enqueueMetadata` treats any group with a row — poster or no poster — as already
answered, so nothing ever re-queues it. Clearing `poster_path` only stops the poster
route 404ing for a file that is gone; it does not bring the poster back. The row's
title, synopsis, performers and confirmation are indeed untouched, but "untouched"
here means "also never re-fetched," not "refreshed for free." Getting a poster back
means deleting the group's `group_metadata` row (and its `metadata_candidates` rows)
so the group looks unasked again and gets picked up the next time it is browsed —
which redoes the whole lookup, not just the poster, and is not itself automated by
anything in this codebase today. Self-healing re-fetch is the obvious phase-2
improvement; this phase documents the footgun instead of hiding it.

**A card can settle with its poster and avatars missing until the page is reloaded.**
`runMetadataPass` writes the answer and deletes the queue row *first*, then caches the
poster and each performer's two images — all in the same call, but not the same instant.
`GET /api/metadata` reads `group_metadata` alone, so for the length of those downloads
the group already reports `state: 'confirmed'` with `hasPoster` and every `hasAvatar`
still `false`. `useGroupMetadata` re-polls only the ids it last saw as `'pending'`, so a
poll that lands inside that window takes the answer as final and never asks again: the
card renders its title, date and synopsis with no images, and stays that way until
something reloads the page.

This is a missing decoration, not a wrong record. Nothing is persisted incorrectly, the
files do finish downloading, and the next load shows them — which is why it was judged
not to block the branch it was found on. It is written down because the branch's own
end-to-end suite is *shaped around* it rather than against it:
`packages/e2e/tests/metadata-modal.spec.ts` seeds and drains the queue before
`page.goto` precisely so its page never mounts inside the window, and a comment there
says so. A suite that avoids a defect is not evidence the defect is absent.

The obvious fix does not work. Keeping the queue row until the artwork lands changes
nothing, because `metadataViewOf` reports `'confirmed'` from `group_metadata` whether or
not a queue row exists — the queue is only consulted to distinguish `'pending'` from
`'absent'`, and both of those require the answer row to be *missing*. Closing it needs
one of two things: a settling state on the view (a `confirmed` answer that still reports
itself as not-yet-final while its images are outstanding, which the SPA would keep
polling), or caching the artwork before the answer becomes visible at all — writing the
row and the images in one transaction, or staging the answer and publishing it once the
downloads finish. The second is the cleaner contract and the more invasive change: it
moves image downloads inside the write path, where a slow or hanging fetch delays the
metadata answer itself rather than just its decoration.

## Test-suite blind spots

These are hazards for whoever writes the next test rather than tracked work, so they are
not filed as issues and stay here in full. The exceptions are the mechanically preventable
ones, which have issues of their own:

- [Add a lint rule or shared helper banning `assert.equal(screen.queryByText(x), null)` in web tests](https://github.com/chad3814/pickarr/issues/40).
- [A typed fetch-stub helper would retire 28 uses of `as unknown as typeof fetch` in web tests](https://github.com/chad3814/pickarr/issues/58) — the global constraints ban `unknown`, and this one idiom is where every violation lives.
- [Tests leave their `mkdtemp` directories behind — about 20 per full run](https://github.com/chad3814/pickarr/issues/63) — the real directories are deliberate; only the cleanup is missing.

These are not product defects. They are ways this repo's tests have been green while
proving less than they appeared to, each found by mutating the source and watching nothing
fail. They are recorded because every one of them has already recurred at least once.

**`getByRole` and `getByText` cannot see whether a component is legible.** Both read the
accessibility tree, and the accessibility tree is satisfied by attributes a sighted user
never receives. `IdentityChangeConfirm` shipped with `role="dialog"`, an
`aria-label="Confirm identity change"`, no visible heading, and — as it turned out — no
`.confirm` rule in the stylesheet at all, so it rendered as an unstyled block of text
inline, directly beneath each page's own error banner. Eight unit tests and two Playwright
specs asserted `getByRole('dialog', { name: 'Confirm identity change' })` and passed
throughout, because that name came from the `aria-label`. The first person to use it read
it as an error, did not press Confirm, and reported the merge as silently broken; the
merge had been working the whole time and was waiting for a click.

The lesson is not "add a screenshot test". It is that `role` and `aria-*` are assertions
about the *announced* interface, and asserting them proves nothing about the rendered one:
a query that would still pass if every stylesheet were deleted is not evidence that anyone
can use the thing. Where a component's whole job is to be understood — a confirmation, an
error, a warning — assert the visible affordance too: a real heading via
`getByRole('heading')`, and the accessible name sourced from that heading with
`aria-labelledby` rather than duplicated in an `aria-label`, so the announced string and
the visible one cannot drift apart. Playwright's `toBeVisible()` does not close this gap
either: an unstyled `<div>` full of text is genuinely visible.

**A round-trip assertion cannot pin any property of a helper shared by both directions.**
`parse(name) → toManualValues → fromManualValues === parse(name)` looks like a strong
property, and it is — until the two directions are deduplicated onto one function, which is
otherwise the right thing to do. After that, changing the shared helper moves both sides
together and the assertion still holds: `.toSorted()` was deleted from
`sceneSlugFromParts` and the round-trip tests stayed green. Absolute-value assertions on
the key are what actually pin it. Deduplicate anyway — but replace the redundancy you just
removed.

**Mutation coverage flatters itself when every mutant targets contents and never the
wrapper.** `inTransaction` in `manual/operations.ts` was surrounded by 22 mutants that all
passed through it and none that attacked it; replacing its whole `BEGIN`/`COMMIT`/`ROLLBACK`
body with `return body()` left 302 tests green. A wrapper is invisible on every happy path,
so it needs a fault injected deliberately — for that one, a `BEFORE DELETE` trigger raising
`ABORT`, which fails the statement and leaves the transaction to the caller the way a real
constraint failure does. `RAISE(ROLLBACK)` unwinds first and tests SQLite instead of you.

**A test whose fixtures all come from the code under test cannot see that code's history.**
Every test of the manual-edit prefill seeded its rows from the *fixed* parser, so none
could observe a row written by the parser before the fix — and the defect that survived
into the final review lived exactly there. When behaviour changes and stored data does not,
hand-build a fixture in the old shape.

**`assert.equal(screen.queryByText(x), null)` OOM-kills the web test run.** When the node
exists, node:assert deep-inspects a live DOM element to format the failure. Inside a
`waitFor` that happens on every retry; even outside one it burns about 75 seconds and takes
the file with it. Either way it presents as a bare SIGKILL naming no test, which costs an
hour to trace. Compare booleans — `packages/web/test/Browse.test.tsx` has a `gone()` helper
for exactly this.

**`t.mock.timers` hangs the web test run, so a timing assertion there has to spy rather
than mock.** Enabling fake timers in a `@testing-library/react` test stalls before the
first assertion: React's own effect flush schedules through `setTimeout`, so replacing it
means the effect under test never runs and the test times out with nothing to point at.
This is not the OOM above — it presents as a plain timeout, which reads like the code being
wrong rather than the harness. Assert on the *arguments* to the real `setTimeout` instead:
`packages/web/test/useGroupMetadata.test.tsx` pins an exact backoff ladder and a clamped
five-minute sleep that way, without waiting a real five minutes or replacing any timer
behaviour. Server-side tests reach the same place by a different route, and not through
`t.mock.timers`: the fetch-timeout tests replace `AbortSignal.timeout` itself with a signal
the test aborts on demand (`packages/core/test/abort-timeout.ts`), which needs no timer
mocking at all and asserts the production path more directly — the code still calls
`AbortSignal.timeout(ms)`, still gets a signal, and still aborts for exactly one reason.

**A test whose expected value is computed by the code under test cannot detect that code
changing.** `groupAnchor` was mutated to return a constant `group-x` — every card claiming
one DOM id, so a Downloads link scrolls to whichever card renders first — and **all 70 web
tests passed, the end-to-end one included.** Eight separate sites, across three files,
built their expectation by calling `groupAnchor(...)`. Nothing asserted the literal string.
An off-by-one variant is just as invisible, so "check it isn't a constant" is not the
lesson; spelling at least one end literally is.

Two things make this worth its own entry rather than folding into the fixture one above.
It survived a reviewer who had *correctly identified the same pattern* one level up, in
`groupAnchorHref` — and then wrote the shared `groupAnchor` the fix depended on without
pinning it. And it has a subtler form: **pinning a pure function does not pin that anyone
calls it.** `migrate`'s duplicate-version guard had a passing test and deleting the guard's
*call site* broke nothing, because the test exercised the function directly. Give the call
site something drivable.

**A mutant that crashes proves nothing.** Four mutants that copied a column from a
merge loser to its survivor were first written to read the row *after* the delete, which
raised `NOT NULL` and failed every test in the file. That looks like overwhelming
evidence and is none: a mutant must change one behaviour, not break the code. Rewritten to
copy before the delete, each produced a single targeted failure. The same trap in SQL —
a narrowing mutant put `WHERE id = media_groups.id` inside a subquery already correlated on
`media_groups`, so the inner name shadowed the outer and the query was broken rather than
narrowed. When a mutant fails everything, suspect the mutant.

**A failing web test that skips its cleanup hangs the whole file, and the hang names no
test.** Three variants so far, all the same shape. `<Downloads />` polls every three
seconds, so a test that threw before its own `cleanup()` left the interval running and the
file sat for 180 seconds. A test that mocked `setInterval` and threw left the *reverted*
mock's timer running for real, ~70 seconds. And the `queryByText` OOM above is the third.
Use `afterEach(cleanup)`, which runs whether the test passed or threw —
`Failed.test.tsx`, `Browse.test.tsx` and `Downloads.test.tsx` all do. Per-test `cleanup()`
calls only run on the happy path, which is the path that did not need them.
