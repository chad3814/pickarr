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

**The hyphen-attached release group must be 1–12 all-caps alphanumerics, or the whole
name is refused.** This is deliberate — it is what stops `-Part1` and `-Part2`, or
`-Uncut` and `-Directors`, being read as release groups and merging two different cuts
of one scene. But it also refuses realistic tag spellings that used to parse: `-Rarbg`,
`-Ghost`, `-inSaNe` and other mixed case; `-rartv`, `-xpost` and other lowercase; and
`-DIGITALPLAYGROUND` or anything else over twelve characters. Those land in
`parse_error` rather than the browse list. If the worklist fills with them, relax the
caps rule last — it is the one carrying the over-collation guard.

The cap was 8 until a real feed showed that one rule producing the majority of all
`parse_error` rows, most of them the 9-character group `P0RNL0V3R`. Raising it to 12
came with a cost that is easy to miss: **the cap had silently been the only guard
rejecting 9-12 character edit tags**, since `NON_GROUP_TERMS` and the caps test are
what handle the short ones. Widening it moved `-UNCENSORED`, `-DIRECTORSCUT` and
`-COMPILATION` from refused to parsed-as-a-group — a merge, not a refusal, and merging
is the one error this parser may not make. They are now listed terms with their own
corpus refusal rows. `DIRECTORS` and `REMASTERED` were already listed and had been
redundant with the cap; they are load-bearing now. **If you raise `MAX_GROUP_TAG_LENGTH`
again, walk the newly exposed length band for edit and content tags first** — the
constant's doc comment says the same thing at the point of change.

**Theoretical, never observed: content tags of 8 characters or fewer would be swallowed
as release groups.** `-SAMPLE`, `-TRAILER`, `-PREVIEW`, `-CENSORED` and `-BLOOPERS` are
all-caps, alphanumeric, short, and absent from `NON_GROUP_TERMS`, so each would be
detached as a group and collate into the scene proper — a two-minute trailer offered as
a pickable "version" of the full scene. This predates the cap change and the cap never
covered it. Deliberately not fixed: none of these has been seen in a real feed, and
adding them *changes* current behaviour, turning names that parse today into
`parse_error` rows — a certain cost against a hypothetical benefit. Recorded so that if
a trailer ever does show up on a scene's version list, the cause is already written
down. `-PROPER` and `-REPACK` are the same shape but merging those is correct: they are
re-releases of the same scene, which is what upgrade detection is for.

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
