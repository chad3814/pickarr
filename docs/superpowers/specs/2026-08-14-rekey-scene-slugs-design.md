# Re-keying scene slugs after the suffix-token change

**Status:** draft for review. Blocks the merge of `title-suffix-tokens`.

## 1. Why this exists

`title-suffix-tokens` stops treating trailing tags — `hardcore`, `solo`, `lesbian`, `XXX`, a
language, a site's numeric id — as part of a scene title. That moves the title, and the identity key
is built from the title, so it moves the key.

Measured on 10,100 corpus titles at `--holdout=0` with a 1,037-name learned site list: **320 keys
move.** All 320 differ in the **scene-slug segment only** — zero change their site segment or their
date segment. Zero new collisions. The floor without a site list is 311; the nine extra are dateless
names that only parse once a site is known, so a fuller site list moves *more*, not fewer.

Shipping the parser without this pass would leave every affected scene split in two: the existing
group keeps its old key and its files, and the next release of that scene creates a second group
under the new key, with its own library directory.

## 2. What I got wrong before the research, corrected here

Three things I assumed, that the codebase contradicts. They shape everything below.

**This is not a third-segment-only change.** The scene slug moves, but so do `display.title` and
`search_text`, because all three derive from the parsed title. That matters because the metadata
"question" is built from `display` — `sceneMetadataQuery` reads `display.subtitle`, `display.title`,
`display.date` (`packages/plugin-scenes/src/metadata.ts:17-32`). So this pass moves the question, and
the invariant in `docs/known-issues.md:465-476` applies in full:

> A stored answer is settled only while the question is fixed, so anything that changes the question
> has to invalidate the answer.

That invariant has already been broken twice, and the second break is exactly our shape: an edit
rewrote a group's identity without clearing its metadata, and the card kept showing the poster and
synopsis of whatever scene the overruled reading had matched. **Migration 4 is not a precedent for
this half** — a site-slug reform left the canonical site name untouched, so it had no display half.

**Artwork needs nothing.** Posters are cached as `<group_id>.<ext>`
(`packages/core/src/media/artwork.ts:199-201`) — an integer from our own database. A key change
cannot invalidate a poster path. My earlier claim that on-disk artwork would need moving was wrong.

**Paths are only partly key-derived.** `{site}`, `{Site}`, `{SiteName}` read `display.subtitle`, not
the key (`packages/plugin-scenes/src/path-template.ts:155-156`). Only `{sitename}` reads the key
segment. The conclusion survives — `{title}`, `{Title}`, `{titledots}`, `{TitleDots}` are
key-derived (`:163-166`) and those are what move — but the reasoning needed narrowing.

## 3. A pass, not a schema migration

**Proposal: a one-shot re-parse pass that runs the live plugin, not a numbered migration with a
frozen transform.** Migration 7 stays unused by this work.

Migrations in this repo must freeze the logic they depend on. `migrations.ts:158-163`:

> This is a frozen copy of `siteComparisonKey` … deliberately not an import. A migration has to keep
> producing the keys it produced the day it shipped; the plugin's helper belongs to code that is
> free to change, and importing a plugin into core's schema history would also point the dependency
> the wrong way round.

That convention is right, and it is precisely why a migration is the wrong tool here. Migration 4
froze six lines. Freezing *this* transform means freezing `findTitleEnd`, the whole suffix
vocabulary, the numeric-id rule with its year and ordinal carve-outs, `findEncodeSuffixStart`, and
the `titleEndOffsetAfterSite` guard — and then keeping that frozen copy producing keys that the live
parser also produces. The moment they diverge we break the contract in
`packages/plugin-scenes/src/manual.ts:356-360`, which requires *every writer of an identity key* to
agree with the parser. A frozen copy of a thousand-line transform is a second parser that nobody
tests against the first.

Two alternatives rejected:

- **Slug surgery** — drop trailing vocabulary from the stored slug without re-parsing. Cheap, needs
  no frozen parser, and wrong: the slug has already lost the information the rules need. `42466`
  and `2` are both bare numbers in a slug; only the parser knows one is a site id and the other a
  sequel number. It would also diverge from the parser by construction, breaking the same contract.
- **Numbered migration re-parsing via an import** — resolves the divergence but points the
  dependency the wrong way round, which the convention forbids.

The pass reads `feed_items.raw_title` (reachable as `media_groups → releases → feed_items`) and
re-parses it with the live plugin, exactly as ingest does. It therefore produces, by construction,
the key the parser would produce today. The codebase already anticipates this shape —
`migrations.ts:118-121`, on `edited_at`:

> Nothing reads them yet; they exist so that a future **re-parse pass** can tell which rows it must
> not overwrite.

**When it runs: at startup**, after `migrate`, before the HTTP server accepts requests.

**Idempotence: a row in a new `app_state` table.** Not being in `schema_migrations`, the pass needs its
own marker. Migration 7 creates:

```sql
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Pure DDL, so nothing in it can drift and §3's frozen-copy concern does not arise. The pass writes
`key = 'pass:rekey-scene-slugs'`, `value` holding the number of groups it re-keyed, `updated_at` the
completion time — in the same transaction as its final batch. The row existing is the marker; the value
is there because a bare sentinel tells you nothing six months later.

**Keeping it from becoming a junk drawer.** A generic key-value table invites unrelated state, and it
rots by accretion when there is no rule. The rule, to live in the migration's comment: a row here is
one small operational fact about this installation — a pass marker, a schedule cursor. Not user data,
not anything read in bulk or joined against, not anything structured enough to want columns. Keys are
namespaced `subsystem:name`. Anything failing those tests earns a real table.

**Re-running is harmless regardless of the marker**, because the pass converges: re-parsing an
already-moved row yields the key it already has, and §6 writes nothing when nothing changed. The marker
exists to stop the *file renames* being reconsidered every boot, not to protect the database.

**A free drift check runs every boot, marker or not.** Re-parsing all 945 groups in the current backup
costs 8–16 ms, so knowing is free. It writes nothing, touches no files, and logs `N groups disagree
with the parser` when N > 0. That recovers the early warning a one-shot marker would otherwise cost
us — a later parser change surfaces in the log instead of accumulating silently. Demote it to a debug
log if it proves noisy; don't delete it. (I am reading the marker choice as differing from the
alternative only in the table, so this check stays in — say if you'd rather drop it.)

## 4. Hand-edited rows are skipped

**Rows with `edited_at IS NOT NULL` are left entirely alone**, per the stated purpose of the column.
A human has overruled the parser on that row; a re-parse pass that overwrote it would re-impose the
reading they rejected. Migration 4 never faced this because its transform was display-neutral, and
it deliberately did not stamp `edited_at` (`migrations.ts:268-272`).

Consequence, stated plainly: a hand-edited group keeps a key the current parser would not produce.
That is the correct trade — the alternative discards user intent — but it means `edited_at` stops
being merely advisory and starts carrying real weight, and the first thing to read it is this pass.

## 5. Collisions: reported by default, merged in one narrow class

**Decided: report, except where merging provably destroys nothing.** This section originally read
"report, never merge", and the argument for that is unchanged and still below — but it turned out to
be an argument about *one class* of collision, and the owner's database contains a second class it
never considered. Both are named here, because a section that reads as a blanket prohibition is how
the next reader deletes the merge as a mistake, and a section that reads as blanket permission is
how someone fuses two scenes.

When two existing groups' new slugs collide, migration 4's answer was to merge: choose a survivor
(live imported file, then any download, then lowest id), repoint every referencing row, delete the
losers, then take the new key — in that order, because `UNIQUE (plugin, identity_key)` would
otherwise reject the update (`migrations.ts:254-260`).

### Class 1 — two different scenes. Reported, never merged.

Migration 4's collisions were always the *same scene* split in two, so merging was pure repair. The
collision class this branch *introduces* is not: it is two genuinely *different* scenes
(`docs/known-issues.md:281-314`) —

> `PornMegaLoad.26.08.05.Suki.Sin.Solo.42466…` and `PornMegaLoad.26.08.05.Suki.Sin.Hardcore.42467…`
> both key as `pornmegaload:2026-08-05:suki-sin`

Accepting that for *new* ingest is defensible: nothing is lost that was ever separate. Doing it to
rows that already exist means fusing two groups a user may already have two sets of files for, and
deleting one of them. Nothing else in the codebase takes a position on that, and "a wrong answer is
worse than no answer" points one way.

So on a class-1 collision, re-key neither row. Leave both at their old keys, and report them —
count at startup, full list behind a flag. Both groups keep their files and their history; the cost
is that both keep keys the parser would no longer produce, and a future release of either scene
creates a third group. That is visible and repairable. A silent fusion is neither.

Measured: **zero** collisions of this kind across 7,166 parsed corpus titles, so the expected
population is zero and this is a safety net rather than a workflow.

### Class 2 — one scene, two encodes, two groups. Merged.

The collision the owner's 2026-08-16 database actually contains is not class 1 at all. It is one
scene held twice, which is migration 4's shape exactly, and there merging repairs rather than fuses:

```
group  106  ClubSweethearts.26.08.07.Foxy.Dreams.Solo.XXX.1080p.MP4-WRB   moves, loses "Solo"
group 1137  ClubSweethearts.2026.08.07.Foxy.Dreams.720p.x265              already holds the key
```

Measured on that pair: group 106 has 3 releases and **no downloads, no imported files, no metadata
and no pick**; group 1137 has one of each. Reporting instead of merging costs the user a 1080p
release sitting beside the 720p they already downloaded, which they cannot otherwise see — the two
groups being separate is the whole reason it is invisible.

**Which class a pair falls in is decided mechanically, from history — never from the titles.**
Reading two titles and judging "same scene?" is a guess, and a wrong guess deletes a group. So the
pass asks `groupHistory` (`db/groups.ts:584`) about the *mover* — the group whose key is changing —
and merges only when it answers `null`: no downloads, and no `imported_files` rows live **or**
trashed. Such a group has nothing that merging can destroy; its releases move to the survivor and
everything else about it is reconstructible by re-ingesting the same feed items. Anything else is
class 1 and is reported.

This deliberately declines to merge some genuine duplicates — a duplicate that has been downloaded
stays reported. That is the direction to err, and class 1's own "a wrong answer is worse than no
answer" is why.

**Direction is not a choice the pass makes.** The survivor is the group already holding the key; the
mover folds into it. Migration 4's "lowest id" last resort has no role here, and the ids in the pair
above run the other way — 106 is deleted, 1137 survives. Merging the other way round would mean
deleting the holder *and* re-keying the survivor into the freed slot, which is a larger operation
than the shared merge performs; a mover that has history is therefore reported, never resolved by
reversing the direction. A slot contested by two or more movers is reported too: a merge needs a
single uncontested survivor to name, and a pile-up has none.

Two further restrictions, both load-bearing:

- The merge is the one lifted from `manual/operations.ts` (now `db/merge-groups.ts`), unchanged, so
  the ordering the foreign keys demand is written once. `clearGroupMetadata` before `deleteGroup` is
  part of that ordering — see §7.
- The pass does **not** stamp `edited_at` on the survivor, though the manual merge does. That stamp
  is justified by a human having named the scene; a pass is not a human, and stamping would immunise
  the survivor against every future run (§4, §6).

## 6. What the pass writes, per row

For each `scenes` group with `edited_at IS NULL`, in one transaction **per group** — deliberately,
not one for the whole batch, so a single poison row cannot roll back the groups that already landed;
see §7 and `packages/core/src/pipeline/rekey.ts`'s own module comment, both of which already state
this:

1. Re-parse the group's `raw_title` with the live plugin. No parse, or a refusal → leave the row
   untouched and count it.
2. New key equals old key **and** display is unchanged → write nothing at all, so the row cannot
   drift. Migration 4's rule (`migrations.ts:331-336`).
3. New key collides with another existing row → merged into the holder if §5's class-2 test passes,
   otherwise skip both and report them.
4. Otherwise write `identity_key`, `display` and `search_text` together via the existing
   `updateGroupIdentity` (`packages/core/src/db/groups.ts:501`), and **call
   `clearGroupMetadata`** (`packages/core/src/db/metadata.ts:387`) in the same transaction,
   conditional on the display having changed rather than on the key having changed — a title
   correction can reduce to the same slug, so the key survives while the question does not
   (`packages/core/src/manual/operations.ts:333-334`).

**Do not stamp `edited_at`.** A pass is not a human, and stamping it would immunise every re-keyed
group against the next pass — migration 4's reasoning at `:268-272`, which applies unchanged.

**Do not touch** `list_rank_at` (only an arriving release lifts a group), `created_at`, or
`picked_release_id`.

## 6a. Live files are renamed with the key

Decided: the pass renames files rather than reporting them. Measured against the 2026-08-14 backup,
the population is **six** live imported files, all `ClubSweethearts` releases carrying `Hardcore`.

This is a one-time backlog, not an ongoing flow. Every import *after* the parser ships is named
correctly at import time, so the only files that can need moving are ones already in the library. The
backlog grows only while this branch sits unmerged.

**Only the filename changes.** The template is
`{sitename}/{sitename}.{date}{episode}.{titledots}.{resolution}-{group}`, and this change moves only
`{titledots}`, so every rename is within one directory. That is what makes the ordering below safe: a
same-directory rename is atomic and trivially reversible.

**Order, per group, and it is load-bearing:**

1. Open the transaction.
2. Write `identity_key`, `display`, `search_text`, and the new `dest_path` for each live file.
3. Rename each file on disk.
4. Commit.

A rename that throws → roll back and skip the row entirely, leaving both the key and the file as they
were. A commit that throws after a successful rename → rename back, then skip. Doing the disk work
*inside* the transaction window is what allows both failure directions to end in a consistent state;
committing first would leave the database pointing at a path that does not exist.

**Refuse rather than overwrite.** If a computed destination already exists on disk, skip the group and
report it. Two groups' files wanting one name is the same shape as the key collision in §5 and gets
class 1's answer, not class 2's: a file already at the destination is precisely the history that
makes a pair unmergeable, so nothing here can be repaired by folding one group into the other.

Only rows with `trashed_at IS NULL` are touched. `trash_path` is left alone — it records where a
trashed file went, and nothing renders a new one.

This overrides, for this pass only, the policy the interactive merge states — that files in the
library "keep the paths they were given" (`packages/core/src/manual/operations.ts:256`). That rule
exists because a merge fuses two scenes that were always separate; here the file's name is simply
wrong under the new parser, and the group it belongs to is not changing.

**Why not leave them.** Leaving files is functionally harmless — `findLiveByDest` and `trashLiveFiles`
both work off the stored string, and an upgrade self-heals the name. It was the smaller change. It was
rejected because it leaves the library visibly inconsistent with what the application would generate
today, and "it self-heals eventually" is not a property anyone can see or rely on.

## 7. Failure behaviour

The runner commits each migration in its own transaction and rethrows on failure, so a throwing
migration aborts startup with earlier migrations already committed (`packages/core/src/db/migrate.ts:69-80`).
A pass over user data should not be able to prevent the application from starting. **Proposal:** the
pass catches per-row failures, counts them, and continues; only a failure to open a transaction
aborts. A row that fails is left at its old key, which is the same outcome as a refusal.

Note the FK trap: there is **no `ON DELETE` clause anywhere in the schema**, and deleting a group
that has ever been browsed fails the foreign key from the metadata tables — the 500 documented at
`docs/known-issues.md:478-482`. §5's class-2 merge is the one thing in this pass that deletes a row,
so `clearGroupMetadata` before `deleteGroup` in the same transaction is mandatory, not defensive;
there are now **four** such tables, `group_performers` being the newest (`db/metadata.ts:387`). The
shared merge body already orders it that way, which is most of why it is shared rather than copied.

A merge that throws is counted and skipped exactly as a failed re-key is, and one transaction per
merge means the rollback returns both groups to what they were: the releases still on the mover, the
mover still present.

The history rule is asked **twice**: once by `planRekey`, and again inside the merge transaction
immediately before the delete. The second ask is not redundant. `applyRekey` is exported, and this
is the only path in the system that deletes a group without a human asking; the first caller to run
it against a live server turns the plan into a snapshot an in-flight import can outrun. The foreign
keys do protect the record either way — the delete is refused outright — but they refuse it as a
throw counted in `failed`, where re-asking produces the answer this shape should have had, a
`skipped-collision` that names the reason.

**A known, unhandled gap in the bucketing.** `planRekey` buckets a mover only by the slot it moves
*into*, never by the slot it *vacates*. If group B's fresh identity key equals group A's *current*
key, while A is itself moving away to a third slot, `planRekey` sees no collision at all — A's own
bucket (its current slot) holds only A, since B's bucket key is B's fresh slot, not A's current one —
and proposes plain `move`s for both. `applyRekey` applies proposals in group-id order, so if
`B.id < A.id`, B's `updateGroupIdentity` runs first and hits `UNIQUE (plugin, identity_key)` against
A's still-current row, landing B in `failed`. No half-state results: the throw precedes any rename, so
B is left exactly as it was before the pass ran. This is not fixed in this version — the owner's real
database has zero `failed` groups today, and seeing a vacated slot requires the bucketing to consider
every group's *current* slot as well as its destination slot, which is a larger change than a
narrow fix wave should carry. Left as a comment at the bucketing code in `rekey.ts` rather than as a
silent gap.

**Recovery for a `failed` (or `skippedDestinationExists`) group.** The write pass is marker-gated
(`REKEY_MARKER_KEY`) to run exactly once, ever — every boot after the first only drift-checks. That
means nothing in this codebase automatically retries a group left in `failed` or
`skippedDestinationExists`; whatever made it fail (a broken constraint, a full disk, a file already
occupying the computed destination, or the vacated-slot gap above) has to be fixed by hand, and then
the pass has to be told to run again. To do that, delete the marker row and let the next boot re-run
`runRekeyOnBoot` from the top:

```sql
DELETE FROM app_state WHERE key = 'pass:rekey-scene-slugs';
```

The pass converges on re-run: every group already correctly re-keyed reads as `unchanged` on the next
`planRekey` (its identity columns already agree), so only whatever is genuinely still outstanding is
retried.

## 8. Testing

- A group whose title loses a trailing tag is re-keyed, and its `display.title` and `search_text`
  move with it.
- A group whose key does not move is not written at all (assert via a trigger or by checking no
  `UPDATE` ran, not merely that values are equal).
- A hand-edited group (`edited_at` set) is untouched even though its title would move.
- Two groups colliding under the new key are both left alone and both reported, unless the mover has
  no history at all (§5, class 2) — in which case it is folded into the holder, the holder keeps its
  own key, pick and files, and its `edited_at` stays null. A mover whose only history is a *trashed*
  imported file is reported, not merged.
- A group that had been browsed has its `group_metadata` row cleared; one that had not is unaffected.
- A group whose display changes but whose slug does not is still cleared — the case that broke the
  invariant the second time.
- A group with no parseable `raw_title` is skipped and counted.
- The pass is idempotent: running it twice writes nothing the second time.
- The pass is verified against the parser, not against a frozen expectation: for a sample of
  corpus names, the key the pass produces equals the key `plugin.parse` produces.

## 9. Numbers this spec depends on, and where they come from

| number | value | source |
|---|---|---|
| identity keys moved | **318**, all in the title segment only | corpus at `--holdout=0`, learned 1,037-name site list |
| same, with no site list (floor) | 309 | same run |
| new collisions introduced | 0 | same run |
| site or date segments changed | 0 | same run |
| live imported files needing rename | **6**, all `ClubSweethearts` `Hardcore` | `scripts/estimate-renames.ts` against the 2026-08-14 backup |
| scene groups in that backup | 945, of which 24 hand-edited and skipped | same backup |

These are measured against parser commit `b493436`, which is final for this branch. The figure was 320
before the language-casing rule landed; it fell by exactly 2, the two `Britney.Dutch` releases
returning to their base keys, and one of the seven file renames disappeared with them.

The casing rule: a language token counts as a tag only if it has a capital letter after the first
character (`DUTCH`, `iTALiAN`) or the token before it is itself suffix vocabulary (`Hardcore.Dutch`).
`Britney Dutch` and `Tyler French` are performers; `Perfect French Maid` is a title.

**One known misclassification, currently harmless.** Six German DVD rips in the corpus carry a genuine
title-case language tag — `Fickferien.in.der.Toscana.German.2007.XXX.DVDRiP.XviD-WDE` and four
`Orgi.Poernchen.N.German.200X` releases. The rule reads those as title words. All six are refused
outright by the parser today, and a year sits between the tag and the encode boundary blocking the walk
in any case, so nothing filed wrongly. If a German rip ever does file wrongly, this is the first place
to look — it is recorded in the predicate's docstring, with the two accidents that make it harmless spelled out.

## 10. Scale on the owner's actual database

The corpus figures measure the change's breadth across 10,909 release names. What the pass will do on
the real 2026-08-14 database is smaller and is the number to plan against:

| | |
|---|---|
| scene groups | 945 |
| **keys the pass will move** | **60** |
| of those, with a live imported file to rename | 6 |
| hand-edited, skipped by §4 | 24 |
| `raw_title` no longer parses, skipped by §6 step 1 | 12 |
| full re-parse of all 945 | 8–16 ms |

Both numbers are worth keeping: 318 says how broad the parser change is, 60 says how much of this
installation it touches.

## 11. Open questions for review

1. §4 skips hand-edited rows, leaving 24 groups holding keys the parser would not produce. That is the
   right call for user intent, but it makes `edited_at` load-bearing for the first time and this pass
   is its first reader. Worth confirming before it ships.
2. The 12 groups whose `raw_title` no longer parses are left at their old keys and counted. They are
   already inconsistent — the parser refuses a name it once accepted — so this pass is not making
   anything worse, but they are a pre-existing problem this measurement happens to surface.
