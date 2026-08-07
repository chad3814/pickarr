# Known issues

Everything here was found during the build, deliberately not fixed, and verified to
reproduce. Nothing in this list is speculative. It exists so that the next person to
open this repo — probably you — does not have to rediscover it.

The most useful of these will be settled by pointing Pickarr at a real indexer and
reading the `parse_error` rows it produces.

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

**A release group's name may contain spaces, and reading it as one token cost 65% of
all parse failures.** `...XXX.XviD-iPT Team` was read as the single token `Team`, which
left the run `iPT Team` with no encode boundary behind it and refused the whole name.
Measured against a 6,804-title corpus, that one group accounted for 1,496 of 2,302
refusals; fixing it took the SD tier from 22% to 85% and the corpus overall from 66% to
88%.

A multi-token group is detached under a stricter rule than a single-token one: it must
sit directly behind encode information, exactly as the dot-attached form must, and spans
at most three tokens. Title material never follows the encode section, so that is what
stops a run of words after a stray hyphen being swallowed.

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

Still refused for length: `-DIGITALPLAYGROUND` and anything over twelve characters.

**Date-at-end names need a configured site list to file correctly.** A second dotted
shape appeared in real feeds after the MVP: `Site.Title.And.Performers.YYYY.MM.DD.Encode`,
with the date at the end. It is hostile to this parser because the date is the only
boundary the ordinary form has, and here it sits past both the site and the title, so
*nothing* separates those two. The shape is recognised by two conditions that must hold
together — every token after the date is encode information (the positive test), and
there is more before the date than after it (which stops an ordinary name whose title
is all encode-like words from being re-read this way). The site/title split is then
resolved against `plugins.<pkg>.sites`, falling back to the first token.

The fallback is a guess about the library *path* only: every pre-date token reaches the
identity key whichever side of the split it lands on, so no split can merge two
different scenes. But two consequences are worth knowing. Without the list,
`Anal Only`'s scenes file under `Anal/`. And **changing a site's name changes the
identity key of every affected scene**, so anything already picked reappears as a new
group rather than an upgrade of the old one — settle the naming before a long run, not
during one. No other parser surveyed handles this shape at all, so there is no prior art
to check the heuristic against; it rests on the two conditions above and on the corpus
rows pinning the cases that must *not* be read this way.

**Site matching drops separators, and the configured spelling is canonical.** A site's
own name and the way releases write it disagree about word boundaries roughly 10-15% of
the time: ThePornDB calls the site `Bang Bros`, most releases use the `short_name` as a
single token (`BangBros`, `bangbros`), and a minority split it (`Bang.Bros`). Matching
therefore compares alphanumerics only, so all of those find one site — a slug comparison
made `bang-bros` and `bangbros` two different sites, which was a live bug the first time
this ran against the real API. The *matched* name then replaces whatever the release
wrote, so one site cannot become three groups depending on spelling. The corollary is
that the configured (or discovered) spelling decides the directory and the key, and
`ANALONLY` is a legitimate if ugly choice.

**A sub-site is only found when it is the name's leading run.** `Bangbros.Ass.Parade....`
resolves to `Bang Bros`, not to `Ass Parade`, even though `Ass Parade` is a real site
TPDB knows — the two-word candidate is `Bangbros Ass`, which matches nothing, so the
one-word fallback settles it and `Ass Parade` stays in the title. Matching a site
anywhere in the name was rejected deliberately: `Ass Parade` occurs at token 1 here, and
accepting it would drop `Bangbros` from the name entirely. Listing
`"Bangbros Ass Parade"` in config files these under the sub-site if that is wanted.

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

**Only two searches are made per unknown site: the first two words, then the first.**
This is not a cap on the site's length — a four-word site is found by a two-word query —
but it does mean a site is undiscoverable when neither of its first two words appears in
its registered name. None has been seen, and each extra query costs a round trip against
a substring search that gets noisier as the query gets shorter.

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

**A single-letter query is never sent; a single-digit one is.** The service matches a
query anywhere in a name, so one letter confirms nothing and costs a page: measured live,
`a` returns 87,955 results (`Male Reality`, `Laundry`), `b` 25,078, `x` 13,168. Digits are
the opposite — they lead real site names (`2 Chicks Same Time`) and are cheap, with `0`
through `4` returning nothing and `8` returning one. A blanket minimum query length would
have discarded the useful case with the useless one. The cost of the rule: a site named
with a single letter, and there is one called `X`, can be configured but never
discovered.

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

**Dateless keys carry an empty date segment, and that is a knowing over-collation.**
`brazzers::alex-coal`. Two encodes of one dateless scene collate with each other, and
*not* with a dated release of the same scene — ordinary under-collation. The cost is the
other direction: **two different scenes from one site sharing a title become one group**,
and in this domain a title is frequently just a performer name. Nothing in a dateless
name can separate them, so this is the one place the parser knowingly commits the error
it otherwise refuses. It was chosen over the alternatives — refusing these releases
entirely, or filling the slot with the RSS publish date, which would put a date that is
not the scene's date into the library path and split re-posted scenes into separate
groups. If it bites, the fix is a real per-scene date, not a heuristic.

**A bare TLD directly after a confirmed site belongs to the domain.**
`BralessForever.com.Emma.G.and.Rocky.Beach.Days.2160p` files under `Braless Forever`
with the title `Emma G and Rocky Beach Days`; without the rule the title would begin
`com`. It only ever runs *behind a confirmation*, which is what keeps it clear of the
bare-domain problem below: nothing confirms `Bang` in `Bang.com - Alex Coal`, so the rule
never fires there. It also never consumes the last remaining token.

**One unknown encode word refuses the whole name, so the vocabulary is worth
extending on evidence.** A token the encode vocabulary does not know interrupts the
trailing run, the run no longer reaches the end, and the name is refused — the same
mechanism that `REMASTERED` tripped. Corpus evidence added `VERTICAL` (phone-format
video), `F4V` (a Flash container), and `10bits` alongside `10bit`. Each was one or two
titles; the pattern is what matters, since the failure is total rather than partial.

**An indexer's trailing runtime stamp is stripped.** `... MP4-KTR [06:32:12]` sits behind
the group tag, so the encode run stops reaching the end and the name is refused over
three characters of metadata. The strip is deliberately narrow — a bracketed `HH:MM:SS`
at the very end and nothing else — because bracketed text is *not* junk in general: the
delimited form reads `[Vixen] Alex Coal - ...` and depends on it surviving.

**`MAX_GROUP_TAG_LENGTH` is no longer doing much.** Measured across the corpus, raising it
from 12 gains 0.1% at 13 and nothing at all beyond that, so the two titles it still
refuses (`-JustDifferent`, 13 characters) are the whole remaining cost. It is left at 12
because the measurement cannot see the failure it prevents: a long run-together title
word swallowed as a group produces a wrong key silently, without colliding with anything,
so a zero-collision result is not evidence of safety here. The position rule now carries
most of the weight this cap used to.

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

**`REMASTERED` was in the encode vocabulary and the non-group list at once.** The
vocabulary entry read `REMASTER`, anchored, so the longer spelling matched neither and
interrupted the encode run — 14 corpus titles refused by a typo. Real titles put it
*inside* the run, `XXX.REMASTERED.XviD-iPT Team`, exactly where `REPACK` and `PROPER`
sit, so it is encode vocabulary and a remaster collates with the original as another
version of one scene. Its `NON_GROUP_TERMS` entry is gone.

**Interlaced resolutions parse and rank below progressive.** `1080i` claims 1080 and
carries half the vertical detail per field, so it is recorded as `extras.interlaced` and
penalised — below `1080p`, still above a progressive 720p. The penalty is bounded like
the upscale one and deliberately a different size, so a release that is both upscaled and
interlaced ranks below one that is only either; their sum stays under one resolution unit.

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

**A bare-domain prefix becomes the site.** Stripping a website prefix now requires
`www.` or a scheme, because `Bang.com - Alex Coal - Deep` and `site.com - Brazzers - ...`
are the same string shape and guessing wrong merged five real studios onto one identity.
The cost of the safe choice: a genuine bare-domain stamp like `pornsite.net - Vixen - ...`
is treated as the studio, so the scene files under the wrong directory and under-collates
against the same scene without the stamp. Wrong path, never a wrong merge.

**The same scene in a dotted and a bracketed listing gets two groups.** The dotted form
carries no component boundaries, so `Vixen.23.07.19.Alex.Coal.Beautiful.Episode` and
`[Vixen] Alex Coal - Beautiful Episode - 2023-07-19` cannot be told to be the same
scene. Under-collation, and probably irreducible.

**Residual over-collation, believed irreducible.** Two distinct scenes can share an
identity key when a release has no marker *and* its title ends in a word that looks
like a resolution or source — a scene literally titled "Party 4K". Without a marker
the name contains nothing that separates the two readings.

**Smaller, all pre-existing:** in a listing, a hyphen-attached group inside the quality
segment leaks into the identity and the quality is lost (`- 1080p-GRP`); when a listing
holds two dates the first wins and the second ends up in the title; `4K60` matches no
resolution because there is no word boundary before the `60`.

**Under-collation by design.** A name whose boundary is genuinely ambiguous returns
`null` rather than guessing. That is the intended direction: a `parse_error` row is
visible and fixable, while a wrong identity key silently merges two different scenes
and you pick the wrong thing.

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

**A crash mid-import can cause a benign retry to re-trash correct files.** A hard crash
inside `importDownload` on a multi-file upgrade can leave a retry trashing files an
earlier attempt placed correctly, then failing. No data is lost — the error names the
trash directory — but the retry does not converge without intervention. Currently
unreachable because `planSceneImport` only ever selects one file. **Fix this before
adding multi-file import plans.**

**Copy-mode crash recovery adopts by byte size.** After a crash between the copy landing
and the row being recorded, a retry treats a destination whose size matches the source as
its own completed copy. A foreign file at that exact path with an exactly equal byte count
would be adopted. For a zero-byte source the size match is guaranteed rather than
coincidental — harmless, since copy mode never touches the source.

**A move-mode `EXDEV` crash no longer self-heals.** A crash between the copy completing
and the source being unlinked now reports a collision rather than finishing the move.
This is deliberate: a stuck import you can see beats automatically deleting a file we
cannot prove we wrote.

**Plugin sources are validated only at plan time.** `assertSourcesWereListed` rejects a
planned source that exists on disk but was not in the listing handed to `planImport`.
A source that does not exist at plan time but *materialises during* the import — a path
inside `trashDir` that `trashLiveFiles` then creates, for example — is not caught. The
reachable set is bounded to the library and trash directories. Adding the same membership
check immediately before the transfer closes it.

## Download client

**Labels are unique only within one database.** `downloadLabel` is `pickarr-<id>` with no
per-installation salt, so two Pickarr instances sharing one SABnzbd category — or one
instance whose database was deleted and recreated — can recover each other's jobs and
attach the wrong client reference. **Give each instance its own SABnzbd category.** A
per-install salt stored in the database at first boot would remove the constraint.

**The `nzbname` round-trip is unverified against a real server.** Double-submit recovery
depends on SABnzbd surfacing the label we send as the job's `name` in its queue and
history. If it renames jobs instead, recovery silently never fires and the same NZB can
be submitted twice. Pickarr logs a warning once per process the first time it sees a
tracked download whose name is not its expected label — **watch for that on your first
real run.**

**A release title that itself ends in something shaped like `[pickarr-N]`, combined with
truncation landing at exactly that offset, can misattribute a ref.** The job name sent to
SABnzbd is the release title with `[pickarr-<id>]` appended (see `clientJobName` in
`db/downloads.ts`), and recovery (`extractLabel`) reads the label back out by matching
that bracketed pattern anchored at the end of whatever name the client reports — not by
searching for our own marker specifically. If SABnzbd truncates away the real trailing
marker *and* the truncated remainder happens to end in a same-shaped bracketed substring
that the release's own title supplied, that substring is read as the label instead, and a
ref could attach to the wrong download. This requires our app-namespaced string to appear
literally in an indexer title and truncation to land at exactly that offset — reproduced
under test, but the preconditions make it vanishingly unlikely in practice. Not fixed;
recorded here rather than complicating the marker format.

## Web and API

`/api/downloads` returns every download row ever created, unpaginated, with one query per
row, and the SPA polls it every three seconds. Fine for a few hundred rows; not for a few
thousand.

The browse search parameter is interpolated into a `LIKE '%…%'` with no `ESCAPE`, so a
query containing `%` or `_` matches more than intended.

A malformed pagination cursor silently restarts from the first page instead of erroring,
which would present as an infinite scroll that never terminates.

Picks always go to `downloadClients[0]` regardless of which feed produced the release, and
only that client's untracked entries are exposed. The config accepts several clients with
no indication that more than one is only half-wired.

## Operational notes

**There is no authentication.** Put Pickarr behind a reverse proxy or keep it on a LAN.

**Pickarr never empties `trashDir`.** Superseded files accumulate there until you delete
them. That is deliberate — it is the only destructive operation in the system, so
reclaiming the space stays a manual decision.

**No library scanning.** Pickarr only knows about media it picked itself. Files already on
disk are invisible to it.

**A chronically unparseable feed logs its cap every tick, indefinitely.** Each ingest
tick logs up to `MAX_REPORTED_PARSE_FAILURES` (50) individual parse-failure lines, which
bounds one tick but not the feed's whole lifetime — a feed whose title format changed and
now fails to parse anything logs 50 lines every interval forever, not just once. That is
the intended tradeoff (each line is the raw title you need to fix the parser, and there is
no per-title dedup to complicate), but it is worth knowing before deciding a feed's
interval or where its log ends up.
