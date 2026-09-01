import type { DatabaseSync } from 'node:sqlite';
import {
  deleteGroup,
  earnsListBump,
  flagUpgrade,
  markGroupEdited,
  moveReleasesToGroup,
  refreshUpgradeFlag,
  type GroupRow,
} from './groups.ts';
import { clearGroupMetadata } from './metadata.ts';
import { releasesForGroup } from './releases.ts';

/**
 * Folds `group` into `target` — every release moves across, the target's
 * upgrade flag is re-derived over them, and the emptied source is deleted.
 *
 * Lifted unchanged out of `manual/operations.ts`'s group edit, which was its
 * only caller until the re-key pass reached the same situation from the other
 * end: an edit arrives at a key another group already holds because a human
 * typed it, the pass arrives there because the parser now reads two titles the
 * same way. The ordering below is not obvious and the foreign keys punish
 * getting it wrong, so the two callers share one body rather than each keeping
 * a copy that could drift.
 *
 * **The caller owns the transaction and the precondition.** Every statement
 * here belongs to one transaction (see `moveReleasesToGroup` for what a
 * half-committed merge leaves behind), and `groupHistory(db, group.id)` must
 * already have answered `null`: this deletes the source outright, and the
 * foreign keys on `downloads` and `imported_files` are the backstop for that
 * rule, not the place it is decided.
 */
export function mergeGroupInto(
  db: DatabaseSync,
  group: { id: number },
  target: GroupRow,
  now: number,
  opts: { stampEdited: boolean },
): void {
  // Asked *before* the move, and it has to be: `earnsListBump` compares
  // against the target's own pick and flag, and once these releases sit
  // under the target they are part of what it already knows about — the
  // comparison would then be against a group that contains them (and
  // `releasesForGroup(source)` would be empty besides).
  // `releasesForGroup` orders by score descending, so the first row is the
  // best thing this merge brings in.
  const best = releasesForGroup(db, group.id)[0];
  const bumps = best !== undefined && earnsListBump(db, target, best.score);

  // Order matters and the foreign key enforces it: the releases move
  // first, then the target's flag is re-derived over them, and the emptied
  // source is deleted last — the one statement here that can throw.
  moveReleasesToGroup(db, group.id, target.id);
  // A release moving into a group and beating its pick *is* an arrival at
  // that group. It merely took a slower route, in through a human, exactly
  // as a resolve does — and a resolve bumps (§7.1). Reaching the same
  // scene by resolving a refused name and by an identity correction must not leave
  // it ordered two different ways.
  //
  // The rule that an edit does not bump still holds for the two cases it
  // was written for — correcting a group's display, and correcting a
  // release's quality — because neither introduces a release the group did
  // not already have. A merge that brings in nothing better does not bump
  // either: moving a pair of also-ran encodes across is not an arrival.
  if (bumps) flagUpgrade(db, target.id, now);
  else refreshUpgradeFlag(db, target.id);
  // The stamp goes on the surviving group. The target's own display and
  // search text deliberately stand: the submitted values were the user's
  // way of naming which existing scene this is, not a rewrite of it.
  //
  // Which is exactly why it is a parameter, and why the re-key pass passes
  // false: that justification is about a human having named this scene, and
  // a pass is not a human. `edited_at` is what tells a later pass to leave a
  // row alone (`migrations.ts:268-272`), so stamping a survivor the pass
  // itself chose would immunise it against every future re-key — a group
  // repaired once would then be exempt from the next parser fix, for no
  // reason a reader of the row could ever recover.
  if (opts.stampEdited) markGroupEdited(db, target.id, now);
  // Metadata is derived, disposable data with no foreign key of its own to
  // enforce moving it first — but it references the source by `group_id`
  // exactly as `releases` did, so it has to be gone before the delete
  // below for the same reason: nothing else clears it, and the delete is
  // the statement that would otherwise discover that the hard way.
  clearGroupMetadata(db, group.id);
  deleteGroup(db, group.id);
}
