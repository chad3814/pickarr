import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import { clearParseError, getFeedItem, setDismissedAt } from '../db/feed-items.ts';
import {
  deleteGroup,
  earnsListBump,
  findGroup,
  flagUpgrade,
  getGroup,
  groupHistory,
  markGroupEdited,
  moveReleasesToGroup,
  refreshUpgradeFlag,
  updateGroupIdentity,
  type GroupRow,
} from '../db/groups.ts';
import {
  getRelease,
  markReleaseEdited,
  releasesForGroup,
  updateReleaseQuality,
} from '../db/releases.ts';
import {
  commitRelease,
  validateIdentity,
  validateParsed,
  type PreparedIdentity,
} from '../ingest/commit.ts';
import type { PluginRegistry } from '../plugins/registry.ts';

export interface ManualDeps {
  db: DatabaseSync;
  registry: PluginRegistry;
  pluginForFeed(feedId: string): MediaTypePlugin | null;
  now(): number;
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
 * Every operation writes several rows that only make sense together — a
 * release and the parse error it clears, a merge and the group it deletes — so
 * each runs in one transaction, as `ingestEntries` does. A refusal commits an
 * empty transaction rather than opening one late, which keeps the precondition
 * checks and the writes reading the same snapshot.
 */
function inTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Asks the plugin to turn field values into a release.
 *
 * Guarded for the same reason `validateParsed` is: this runs inside a request
 * handler that has no guard of its own, and a plugin hook that throws would
 * otherwise be a 500 over a rolled-back transaction rather than a message
 * shown under the fields that caused it.
 */
function buildRelease(
  plugin: MediaTypePlugin,
  from: NonNullable<MediaTypePlugin['fromManualValues']>,
  values: Record<string, string>,
): { media: ParsedRelease } | { error: string } {
  try {
    return from.call(plugin, values);
  } catch (error) {
    return { error: `plugin threw: ${(error as Error).message}` };
  }
}

/**
 * The submitted values over the current record's own, so an edit form may send
 * only what changed — and so a form scoped to one half of the record (identity
 * for a group, quality for a release) still hands the plugin a complete set.
 */
function mergedValues(
  plugin: MediaTypePlugin,
  to: NonNullable<MediaTypePlugin['toManualValues']>,
  current: ParsedRelease,
  submitted: Record<string, string>,
): { values: Record<string, string> } | { error: string } {
  try {
    return { values: { ...to.call(plugin, current), ...submitted } };
  } catch (error) {
    return { error: `plugin threw: ${(error as Error).message}` };
  }
}

/**
 * Both halves of the edit contract, or nothing.
 *
 * A plugin implementing none of the manual hooks gets no edit UI at all, so
 * reaching an edit for one is a request for something that does not exist —
 * 409 rather than a thrown "not a function". Correcting an existing record
 * needs the inverse hook too: without `toManualValues` there is no way to send
 * only what changed.
 */
function editHooks(
  plugin: MediaTypePlugin,
): {
  from: NonNullable<MediaTypePlugin['fromManualValues']>;
  to: NonNullable<MediaTypePlugin['toManualValues']>;
} | null {
  const from = plugin.fromManualValues;
  const to = plugin.toManualValues;
  if (from === undefined || to === undefined) return null;
  return { from, to };
}

/** The stored halves of a record, back in the shape a plugin understands. */
function mediaFor(group: GroupRow, quality: string): ParsedRelease {
  return {
    identityKey: group.identityKey,
    display: JSON.parse(group.display) as ParsedRelease['display'],
    quality: JSON.parse(quality) as ParsedRelease['quality'],
  };
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

/**
 * Corrects a group's identity and display, which is to say every release in it
 * and every future import that lands in it.
 *
 * `validateIdentity` supplies `identityKey`, `displayJson` and `searchText`;
 * `searchText` is never recomputed here, because the one place it is derived
 * from `display` must stay the one place `display` is serialized. It is the
 * scoreless validator because a group has no quality to score — see its own
 * comment for what asking anyway would cost.
 */
export function editGroup(
  deps: ManualDeps,
  groupId: number,
  values: Record<string, string>,
): ManualResult<{ groupId: number; mergedInto: number | null }> {
  const { db } = deps;
  return inTransaction(db, () => {
    const group = getGroup(db, groupId);
    if (group === null) return refuse(404, `no such group: ${groupId}`);

    const plugin = deps.registry.byId(group.plugin);
    if (plugin === undefined) return refuse(409, `no plugin loaded for id ${group.plugin}`);

    const hooks = editHooks(plugin);
    if (hooks === null) return refuse(409, `plugin ${plugin.id} does not support manual editing`);

    // A group holds no quality of its own — quality is release-level — and the
    // plugin contract requires a correct key and display from the
    // identity-scoped values alone, so an empty one is the honest input.
    const merged = mergedValues(plugin, hooks.to, mediaFor(group, '{}'), values);
    if ('error' in merged) return refuse(400, merged.error);

    const built = buildRelease(plugin, hooks.from, merged.values);
    if ('error' in built) return refuse(400, built.error);

    const validated = validateIdentity(built.media);
    if ('error' in validated) return refuse(400, validated.error);

    const now = deps.now();
    const prepared: PreparedIdentity = validated.identity;
    const target =
      prepared.identityKey === group.identityKey
        ? null
        : findGroup(db, group.plugin, prepared.identityKey);

    if (target !== null && target.id !== group.id) {
      // Named specifically, because the two situations differ in what the user
      // would go and look at: a download record against this group, or files
      // already on disk under its name.
      //
      // Both messages say the refusal is permanent, because it is. Nothing in
      // the system deletes a `downloads` row, and a trashed `imported_files`
      // row still counts as history — so a user told only "has a download"
      // would reasonably wait for it to finish, and waiting makes it worse:
      // the import writes an `imported_files` row too. Lifting the restriction
      // is a code change (spec §7.3), not something to wait out.
      const obstruction = groupHistory(db, group.id);
      if (obstruction === 'downloads') {
        return refuse(
          409,
          `cannot merge group ${group.id} into group ${target.id}: group ${group.id} has a download recorded against it. Download records are never removed, so this will not clear by waiting.`,
        );
      }
      if (obstruction === 'imported-files') {
        return refuse(
          409,
          `cannot merge group ${group.id} into group ${target.id}: group ${group.id} already has files in the library under its own name, which keep the paths they were given. Trashing them does not clear this either.`,
        );
      }

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
      // scene by the Failed tab and by an identity correction must not leave
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
      markGroupEdited(db, target.id, now);
      deleteGroup(db, group.id);

      return { ok: { groupId: target.id, mergedInto: target.id } };
    }

    updateGroupIdentity(db, {
      id: group.id,
      identityKey: prepared.identityKey,
      display: prepared.displayJson,
      searchText: prepared.searchText,
    });
    markGroupEdited(db, group.id, now);

    return { ok: { groupId: group.id, mergedInto: null } };
  });
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
