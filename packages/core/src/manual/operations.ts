import { mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin } from '@pickarr/plugin-api';
import { clearParseError, getFeedItem, setDismissedAt } from '../db/feed-items.ts';
import {
  deleteGroup,
  earnsListBump,
  flagUpgrade,
  getGroup,
  markGroupEdited,
  markPicked,
  moveDownloadsToGroup,
  moveImportedFilesToGroup,
  moveReleasesToGroup,
  refreshUpgradeFlag,
  updateGroupIdentity,
} from '../db/groups.ts';
import {
  getImportedFile,
  setImportedFileDest,
  type ImportedFileRow,
} from '../db/imported-files.ts';
import { clearGroupMetadata } from '../db/metadata.ts';
import {
  getRelease,
  markReleaseEdited,
  releasesForGroup,
  updateReleaseQuality,
} from '../db/releases.ts';
import { inTransaction } from '../db/transaction.ts';
import { commitRelease, validateParsed } from '../ingest/commit.ts';
import type { PluginRegistry } from '../plugins/registry.ts';
import { lstatOrNull, moveWithinLibrary, type RenameLike } from '../pipeline/import.ts';
import { trashFiles } from '../pipeline/upgrade.ts';
import { planIdentityChange } from './identity-plan.ts';
import { buildRelease, editHooks, mediaFor, mergedValues, resolveIdentityFor } from './values.ts';

export interface ManualDeps {
  db: DatabaseSync;
  registry: PluginRegistry;
  pluginForFeed(feedId: string): MediaTypePlugin | null;
  now(): number;
  /**
   * Where a superseded pick's files go when an identity change merges two
   * groups. The same directory an upgrade import trashes into, and for the same
   * reason: one scene ends up with one owned file, and the other is recoverable
   * by hand rather than deleted.
   */
  trashDir: string;
  /** Injectable so a test can fail one rename mid-loop. Defaults to `fs.rename`. */
  rename?: RenameLike;
}

/**
 * The HTTP status travels with the message so that Task 6 can map a result
 * without a second table of rules restating which refusal means what. The
 * operations themselves know nothing else about HTTP.
 *
 * A rejection from `fromManualValues` and one from `validateParsed` are both
 * 400: the request shape was fine, the values in it were not.
 */
export type ManualResult<T> = { ok: T } | { error: string; status: 400 | 404 | 409 };

function refuse<T>(status: 400 | 404 | 409, error: string): ManualResult<T> {
  return { error, status };
}

/**
 * Describes a failed feed item by hand: the values become a release filed
 * exactly as a parsed one would have been.
 *
 * Steps 2 and 3 of spec §7.1 are `ingestEntries`' own tail, called here rather
 * than reimplemented — `commitRelease` owns find-or-create, the insert and the
 * bump rule, so the rule for when a group returns to the top of the browse
 * list cannot come to exist twice.
 *
 * That bump is deliberate: a resolve is a release *arriving*, just by a slower
 * route through a human. The merge in `editGroup` bumps for the same reason
 * and under the same guard; the edits that only correct an existing record do
 * not, because they introduce no release the group did not already have.
 */
export function resolveFeedItem(
  deps: ManualDeps,
  feedItemId: number,
  values: Record<string, string>,
): ManualResult<{ groupId: number; joinedExisting: boolean }> {
  const { db } = deps;
  return inTransaction(db, () => {
    const item = getFeedItem(db, feedItemId);
    if (item === null) return refuse(404, `no such feed item: ${feedItemId}`);
    if (item.parseError === null) {
      return refuse(409, `feed item ${feedItemId} already parsed; there is nothing to resolve`);
    }

    const plugin = deps.pluginForFeed(item.feedId);
    if (plugin === null) {
      // Guessing one would file the item under the wrong media type.
      return refuse(409, `feed ${item.feedId} is no longer in configuration`);
    }

    const from = plugin.fromManualValues;
    if (from === undefined) {
      return refuse(409, `plugin ${plugin.id} cannot build a release from typed values`);
    }

    const built = buildRelease(plugin, from, values);
    if ('error' in built) return refuse(400, built.error);

    const validated = validateParsed(plugin, built.media);
    if ('error' in validated) return refuse(400, validated.error);

    const now = deps.now();
    const outcome = commitRelease(db, validated.prepared, plugin, item.id, now);
    clearParseError(db, item.id);
    markReleaseEdited(db, outcome.releaseId, now);
    // Only a group this operation created was edited by it. Joining an
    // existing group edits nothing about that group, and a future re-parse
    // pass has no reason to treat it as protected.
    if (outcome.groupCreated) markGroupEdited(db, outcome.groupId, now);

    return { ok: { groupId: outcome.groupId, joinedExisting: !outcome.groupCreated } };
  });
}

/** Waves a failed item off the worklist. Needs no plugin: it is core's own bookkeeping. */
export function dismissFeedItem(
  deps: ManualDeps,
  feedItemId: number,
): ManualResult<{ dismissedAt: number }> {
  const { db } = deps;
  return inTransaction(db, () => {
    const item = getFeedItem(db, feedItemId);
    if (item === null) return refuse(404, `no such feed item: ${feedItemId}`);
    if (item.parseError === null) {
      return refuse(409, `feed item ${feedItemId} parsed; there is nothing to dismiss`);
    }

    const now = deps.now();
    setDismissedAt(db, feedItemId, now);
    return { ok: { dismissedAt: now } };
  });
}

/** What an applied identity change did, including the parts of it that failed. */
export interface GroupEditOutcome {
  groupId: number;
  mergedInto: number | null;
  renamed: number;
  trashed: number;
  /**
   * Files that did not end up where the plan said they would. Collected rather
   * than thrown: by the time any of this runs the database half is committed
   * and correct, and a throw would report the whole edit as a failure it was
   * not.
   */
  failed: readonly { path: string; error: string }[];
}

/**
 * Corrects a group's identity and display, which is to say every release in it,
 * every future import that lands in it, and — now — the files it has already
 * placed in the library.
 *
 * Four phases, and the order is the safety argument rather than an incidental
 * sequence (design doc of 2026-08-16 §5). Read the invariant before rearranging
 * anything: **after phase 1 the database is fully correct about grouping, and
 * every `dest_path` still truthfully names where its file actually is, because
 * nothing on disk has moved yet.** The database therefore never lies, at any
 * instant, including part-way through a failure — which is what makes an
 * interrupted edit something a re-save finishes rather than a puzzle an operator
 * has to reconstruct by hand.
 *
 * The identity itself comes from `resolveIdentityFor`, so the planner and this
 * cannot disagree about what a set of values means. It is the scoreless
 * validator because a group has no quality to score — see `validateIdentity`
 * for what asking anyway would cost — and `searchText` is taken from it rather
 * than recomputed, because the one place it is derived from `display` must stay
 * the one place `display` is serialized.
 */
export async function editGroup(
  deps: ManualDeps,
  groupId: number,
  values: Record<string, string>,
  planDigest?: string,
): Promise<ManualResult<GroupEditOutcome>> {
  const { db } = deps;

  // Phase 0. The plan is recomputed rather than trusted: between the preview
  // and this call a release may have ingested or a queued download may have
  // imported, and the user must not confirm a plan that no longer holds.
  const planned = await planIdentityChange(deps, groupId, values);
  if (!('ok' in planned)) return planned;
  const plan = planned.ok;

  if (plan.blockers.length > 0) {
    return refuse(409, `cannot apply this identity change: ${plan.blockers.join('; ')}`);
  }

  // A plan that moves nothing needs no confirmation, which is what keeps a typo
  // fix on a display field a one-click save exactly as it always was.
  //
  // `renames` and `trashing` are asked about regardless of `kind`, and that is
  // load-bearing rather than belt-and-braces: re-submitting the same values
  // after a partial rename failure classifies as `kind: 'none'` — the merge
  // already happened — while the planner still sees files at stale paths and
  // still returns renames. Gating the file work on `kind` would make finishing
  // an interrupted edit impossible through the same door that started it.
  const needsConfirmation =
    plan.kind === 'merge' || plan.renames.length > 0 || plan.trashing.length > 0;
  if (needsConfirmation && planDigest !== plan.digest) {
    return refuse(
      409,
      planDigest === undefined
        ? 'this change moves releases or files and must be confirmed first'
        : 'what this change would do has altered since it was shown; review it again',
    );
  }

  const now = deps.now();
  const group = getGroup(db, groupId);
  if (group === null) return refuse(404, `no such group: ${groupId}`);
  const plugin = deps.registry.byId(group.plugin);
  if (plugin === undefined) return refuse(409, `no plugin loaded for id ${group.plugin}`);
  const resolved = resolveIdentityFor(plugin, group, values);
  if ('error' in resolved) return refuse(resolved.status, resolved.error);
  const identity = resolved.identity;

  const target = plan.mergeInto === null ? null : getGroup(db, plan.mergeInto.id);
  if (plan.mergeInto !== null && target === null) {
    return refuse(409, `group ${plan.mergeInto.id} no longer exists`);
  }

  // Phase 1. One transaction, database only, and every write in it is one the
  // rows alone can express — nothing here touches the filesystem, which is the
  // whole reason the invariant above holds.
  const survivorId = inTransaction(db, () => {
    if (target !== null) {
      // Asked *before* the move, and it has to be: `earnsListBump` compares
      // against the target's own pick and flag, and once these releases sit
      // under the target they are part of what it already knows about — the
      // comparison would then be against a group that contains them (and
      // `releasesForGroup(source)` would be empty besides).
      // `releasesForGroup` orders by score descending, so the first row is the
      // best thing this merge brings in.
      const best = releasesForGroup(db, group.id)[0];
      const bumps = best !== undefined && earnsListBump(db, target, best.score);

      // All three tables move before the delete, and the foreign keys enforce
      // it: `releases`, `downloads` and `imported_files` all reference
      // `group_id`, and any row left behind makes `deleteGroup` the statement
      // that discovers it. Moving `downloads` and `imported_files` at all is
      // what lifts the old refusal — see `moveDownloadsToGroup`.
      moveReleasesToGroup(db, group.id, target.id);
      moveDownloadsToGroup(db, group.id, target.id);
      moveImportedFilesToGroup(db, group.id, target.id);

      // A pick names a release the user owns a file for. That release changed
      // groups, it did not disappear, so the survivor takes the pick the plan
      // chose — dropping it would tell the user they no longer have a file they
      // do. `state` travels with it (`markPicked` writes both): a row holding a
      // pick while still reading 'new' is off Picks and back in Browse, the
      // same loss in a different hat.
      //
      // Written *before* the two flag calls below so that the flag is derived
      // against the pick the group actually ends up with. That is a choice, not
      // a correctness requirement, and the comment says so deliberately: both
      // `flagUpgrade` and `refreshUpgradeFlag` derive from the group's *current*
      // `picked_release_id`, but `markPicked` writes `upgrade_release_id` itself
      // from the same rule, so the final row is identical either way — reversing
      // the two would merely have the flag call derive against a stale pick and
      // `markPicked` overwrite it. The flag is right *because `markPicked`
      // re-derives it*. Anything that changes that — splitting `markPicked` into
      // a pick-only setter, say — makes this ordering load-bearing for real, so
      // keep it as written rather than relying on the overwrite.
      if (plan.pick.surviving !== null) {
        markPicked(db, target.id, plan.pick.surviving.releaseId);
      }

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
      //
      // `flagUpgrade` here is a re-derivation plus the bump — the bump is the
      // only thing it adds that `markPicked` did not already do. The
      // `refreshUpgradeFlag` branch is only meaningfully reached when no pick
      // survives (a merge of two unpicked groups, or a pick that named a release
      // the merged group will not hold); with a surviving pick it re-derives
      // exactly what `markPicked` just wrote.
      if (bumps) flagUpgrade(db, target.id, now);
      else refreshUpgradeFlag(db, target.id);
      // The stamp goes on the surviving group. The target's own display and
      // search text deliberately stand: the submitted values were the user's
      // way of naming which existing scene this is, not a rewrite of it.
      markGroupEdited(db, target.id, now);
      // Metadata is derived, disposable data with no foreign key of its own to
      // enforce moving it first — but it references the source by `group_id`
      // exactly as `releases` did, so it has to be gone before the delete
      // below for the same reason: nothing else clears it, and the delete is
      // the statement that would otherwise discover that the hard way.
      clearGroupMetadata(db, group.id);
      deleteGroup(db, group.id);
      return target.id;
    }

    // Whether the question a metadata lookup asks has changed, decided before
    // the update overwrites the answer to it. `sceneMetadataQuery` builds its
    // query out of the display — the site from `subtitle`, the title, the date
    // — so a changed display is a changed question even when the key survives
    // it, which a title correction that reduces to the same slug does.
    const questionChanged =
      identity.identityKey !== group.identityKey || identity.displayJson !== group.display;

    updateGroupIdentity(db, {
      id: group.id,
      identityKey: identity.identityKey,
      display: identity.displayJson,
      searchText: identity.searchText,
    });
    markGroupEdited(db, group.id, now);

    // An edit is the one thing that invalidates an answer. `enqueueMetadata`
    // treats any `group_metadata` row as settled and never asks again, which is
    // what stops a browse re-querying the provider forever — but that rule
    // assumes the question is fixed, and this is where it stops being. Left
    // alone, the row keeps describing whatever scene the reading the human just
    // overruled had matched, and the card goes on showing its performers and
    // its poster indefinitely.
    //
    // Cleared rather than re-queued: this runs inside the edit's transaction,
    // and the next browse of the group asks for it anyway. Only when something
    // actually changed, so a save that rewrites nothing does not blank the
    // panel and spend a request to rediscover the same answer.
    if (questionChanged) clearGroupMetadata(db, group.id);
    return group.id;
  });

  const failed: { path: string; error: string }[] = [];
  let trashed = 0;
  let renamed = 0;

  // Everything below is filesystem work, and it is skipped entirely when the
  // plan moves no files. A display-only edit must not create the library root
  // as a side effect of saving a title, and must not be refusable because it
  // could not.
  if (plan.trashing.length > 0 || plan.renames.length > 0) {
    let libraryRootReal: string | null = null;
    try {
      // Resolved and created before `realpath`, exactly as `importDownload`
      // does it: `realpath` needs the directory to exist. Resolved once, not
      // per file.
      const libraryRoot = resolve(deps.registry.libraryRootById(group.plugin));
      await mkdir(libraryRoot, { recursive: true });
      libraryRootReal = await realpath(libraryRoot);
    } catch (error) {
      // Reported rather than thrown, for the same reason a per-file failure is:
      // phase 1 is committed and was correct, and a throw here would report the
      // whole edit as failed. With no library root there is nowhere for any
      // planned move to go, so every one of them is named.
      const reason = (error as Error).message;
      for (const entry of plan.trashing) failed.push({ path: entry.path, error: reason });
      for (const move of plan.renames) failed.push({ path: move.from, error: reason });
    }

    if (libraryRootReal !== null) {
      // Phase 2, before phase 3, and for the reason `import.ts` gives for
      // trashing ahead of its own transfer loop: a superseded file frequently
      // occupies the exact path a renamed file wants, so it has to move out of
      // the way before anything can be written there. Ordering it ahead of the
      // renames — rather than interleaving — also means a failure part-way
      // through leaves a recoverable trail (the superseded files sitting in
      // `trashDir`) instead of a half-trashed, half-renamed group.
      if (plan.trashing.length > 0) {
        const rows: ImportedFileRow[] = [];
        for (const entry of plan.trashing) {
          const row = getImportedFile(db, entry.importedFileId);
          if (row === null) {
            // The row went between the plan and here, but its *file* need not
            // have, and the planner has already exempted its path from the
            // occupant blocker on the strength of this phase clearing it.
            // Skipping it silently would drop an occupied path out of the outcome
            // while leaving it in the way, so it is reported like any other file
            // this phase failed to move.
            failed.push({
              path: entry.path,
              error: `imported file ${entry.importedFileId} is no longer on record, so it was not trashed`,
            });
            continue;
          }
          rows.push(row);
        }
        let threw = false;
        let reason = '';
        try {
          await trashFiles(db, rows, libraryRootReal, deps.trashDir, survivorId, now);
        } catch (error) {
          threw = true;
          reason = error instanceof Error ? error.message : String(error);
        }
        // Read back on both paths, not just the failing one. `trashFiles` marks
        // each row immediately after moving that file, so the rows themselves
        // say how far it got — and `rows.length` says only how many were asked
        // for. Blaming the first row for a later one's failure would send an
        // operator to look at a file that moved perfectly well; claiming a file
        // moved when none did sends them to a trash directory holding nothing.
        //
        // `trashPath`, not `trashedAt`, is the field read. A row whose file was
        // already gone from disk is still marked trashed — it no longer
        // describes a live file either way — but `trashFiles` passes a null
        // `trash_path` for it, having not moved it and having nowhere honest to
        // point. `trashed_at` is set in both cases and so cannot tell a file
        // that reached `trashDir` from a row that was merely retired.
        //
        // On a clean return a row with no `trash_path` is neither counted nor
        // failed: §4.3 of the design already rules that a file gone from disk is
        // a warning rather than a failure. Only a throw turns one into a
        // `failed` entry, and only for the rows that did not move.
        for (const row of rows) {
          const after = getImportedFile(db, row.id);
          if (after !== null && after.trashPath !== null) trashed += 1;
          else if (threw) failed.push({ path: row.destPath, error: reason });
        }
      }

      // Phase 3. One file at a time, each row's `dest_path` updated in its own
      // small transaction straight after its own file moves, so a crash leaves
      // every moved file recorded at its new path and every unmoved one at its
      // old. A single transaction around the whole loop would hold a
      // transaction open across filesystem I/O and would, on a rollback, leave
      // every already-moved file recorded where it no longer is.
      for (const move of plan.renames) {
        // The last guard against overwriting a file, and now the only one.
        // `transfer` (`pipeline/import.ts`) does not check its destination —
        // `importDownload` does that in its own loop before calling it — and the
        // planner *deliberately* lifts its occupied-destination blocker for
        // exactly the paths phase 2 promises to clear. So if phase 2 did not
        // clear one (an unwritable `trashDir` throws at its first `mkdir`, before
        // touching anything, leaving every doomed file where it was), a rename
        // here would overwrite a file the design promises is recoverable from
        // `trashDir`, leave two live `imported_files` rows naming one path, and
        // leave the clobbered row describing another release's bytes.
        //
        // Whose file it is deliberately does not matter: if it is still there,
        // phase 3 has no business writing over it. Re-saving after fixing the
        // trash directory plans the same moves again, so nothing is lost by
        // refusing.
        const occupant = await lstatOrNull(move.to);
        if (occupant !== null) {
          failed.push({
            path: move.from,
            error: `${move.to} is still occupied, so it was left where it is`,
          });
          continue;
        }

        try {
          await moveWithinLibrary(move.from, move.to, libraryRootReal, deps.rename);
          inTransaction(db, () => setImportedFileDest(db, move.importedFileId, move.to));
          renamed += 1;
        } catch (error) {
          // Collected, never rethrown. The merge is already committed and was
          // correct; abandoning the remaining files would only strand more of
          // them, and the row still names where this one actually is, so
          // re-saving the same values plans the remaining moves again.
          failed.push({ path: move.from, error: (error as Error).message });
        }
      }
    }
  }

  return {
    ok: {
      groupId: survivorId,
      mergedInto: target === null ? null : target.id,
      renamed,
      trashed,
      failed,
    },
  };
}

/**
 * Corrects one release's quality, which decides its score and where a future
 * import of it lands. Anything already imported keeps the path it was given.
 */
export function editRelease(
  deps: ManualDeps,
  releaseId: number,
  values: Record<string, string>,
): ManualResult<{ groupId: number }> {
  const { db } = deps;
  return inTransaction(db, () => {
    const release = getRelease(db, releaseId);
    if (release === null) return refuse(404, `no such release: ${releaseId}`);
    const group = getGroup(db, release.groupId);
    if (group === null) return refuse(404, `no such group: ${release.groupId}`);

    const plugin = deps.registry.byId(group.plugin);
    if (plugin === undefined) return refuse(409, `no plugin loaded for id ${group.plugin}`);

    const hooks = editHooks(plugin);
    if (hooks === null) return refuse(409, `plugin ${plugin.id} does not support manual editing`);

    const merged = mergedValues(plugin, hooks.to, mediaFor(group, release.quality), values);
    if ('error' in merged) return refuse(400, merged.error);

    const built = buildRelease(plugin, hooks.from, merged.values);
    if ('error' in built) return refuse(400, built.error);

    // Only `quality` and `score` are taken from this; the identity half of the
    // result belongs to the group and is not a release edit's to rewrite.
    const validated = validateParsed(plugin, built.media);
    if ('error' in validated) return refuse(400, validated.error);

    const now = deps.now();
    updateReleaseQuality(db, {
      id: release.id,
      quality: validated.prepared.qualityJson,
      score: validated.prepared.score,
    });
    markReleaseEdited(db, release.id, now);
    // `refreshUpgradeFlag`, not `flagUpgrade`: a correction is not an arrival
    // and must not move `list_rank_at`.
    refreshUpgradeFlag(db, group.id);

    return { ok: { groupId: group.id } };
  });
}
