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

**The hyphen-attached release group must be 1–8 all-caps alphanumerics, or the whole
name is refused.** This is deliberate — it is what stops `-Part1` and `-Part2`, or
`-Uncut` and `-Directors`, being read as release groups and merging two different cuts
of one scene. But it also refuses twelve realistic tag spellings that used to parse:
`-Rarbg`, `-Ghost`, `-inSaNe` and other mixed case; `-rartv`, `-xpost` and other
lowercase; `-EVILANGEL`, `-DIGITALPLAYGROUND` and anything over eight characters. Those
land in `parse_error` rather than the browse list. If the worklist fills with them,
relax the length cap before the caps rule — the caps rule is the one carrying the
over-collation guard.

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
