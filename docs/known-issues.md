# Known issues

Everything here was found during the build, deliberately not fixed, and verified to
reproduce. Nothing in this list is speculative. It exists so that the next person to
open this repo — probably you — does not have to rediscover it.

The most useful of these will be settled by pointing Pickarr at a real indexer and
reading the `parse_error` rows it produces.

## Parser

**The refusal set is wider than it should be.** Against a sample of realistic scene
release names the parser returns `null` for roughly a quarter of them. A refused name
never reaches the browse list at all, so this is the difference between the list being
the product and the list being a quarter empty.

Known shapes that refuse:

- A dot-attached release group — `Site.24.01.09.Performer.Title.XXX.1080p.HEVC.x265.PRT`.
  `dropReleaseGroup` only strips a group introduced by a lone `-`. This shape is common.
- VR and Oculus tags, `HDRip`, `1080i`, `FullHD`, `HQ`.
- A trailing `[rartv]`-style suffix, or a trailing `.mp4`.

Widen `ANCILLARY_TOKEN` in `packages/plugin-scenes/src/parse.ts`, not the anchor sets —
adding to the anchors enlarges the class of names that collate wrongly, which is the
failure that actually costs you something. Tune it from the `parse_error` worklist
once you have real feed data.

**Residual over-collation, believed irreducible.** Two distinct scenes can share an
identity key when a release has *no* `XXX` marker *and* its title ends in a word that
looks like a resolution or source — a scene literally titled "Party 4K", for instance.
Without a marker there is no information in the name that separates the two readings.

**Under-collation by design.** A name whose boundary is genuinely ambiguous returns
`null` rather than guessing. That is the intended direction: a `parse_error` row is
visible and fixable, a wrong identity key silently merges two different scenes and you
pick the wrong thing.

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
