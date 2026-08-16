import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, MediaTypePlugin } from '@pickarr/plugin-api';
import { getGroup } from '../db/groups.ts';
import { insertPerformerSearch } from '../db/performer-queue.ts';

export interface PerformerEnqueueDeps {
  db: DatabaseSync;
  /**
   * Resolves the plugin a group's `plugin` column names. `null` for a plugin no
   * longer configured — a normal outcome, not a bug: a plugin can be removed
   * from config after groups it created already exist.
   */
  pluginFor(pluginId: string): MediaTypePlugin | null;
  log(message: string): void;
}

/**
 * What to search a performer directory for on behalf of one group, or `null`
 * when there is nothing worth asking.
 *
 * Exported because the pass needs the same answer the enqueue acted on, and a
 * pass re-deriving it from the plugin would be this rule spelled twice — the
 * duplication `deriveUpgradeReleaseId` exists in this codebase to prevent. Both
 * callers ask here.
 *
 * A plugin throwing is a log line and a `null`, never a throw of our own. The
 * caller is a loop over settled rows inside `runMetadataPass`, and a plugin bug
 * must cost one group its search rather than aborting a pass that has other rows
 * to answer — the same treatment `safeMetadataQuery` gives `metadataQuery`.
 */
export function performerQueryFor(deps: PerformerEnqueueDeps, groupId: number): string | null {
  const group = getGroup(deps.db, groupId);
  if (group === null) return null;

  const plugin = deps.pluginFor(group.plugin);
  if (plugin?.performerQuery === undefined) return null;

  try {
    const display = JSON.parse(group.display) as DisplayFields;
    const query = plugin.performerQuery({ identityKey: group.identityKey, display });
    return query === null || query.trim().length === 0 ? null : query.trim();
  } catch (error) {
    // `JSON.parse` and `plugin.performerQuery` share this one try/catch, so
    // this cannot say which of the two threw — a group with corrupt `display`
    // looks identical here to a genuine plugin bug. Naming both rather than
    // blaming the plugin is what keeps an operator from chasing innocent
    // plugin code when the real fault is a malformed stored row.
    deps.log(
      `performer enqueue: group ${groupId} skipped, building the query threw (plugin or malformed display): ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Queues one group, answering whether it queued.
 *
 * The two refusals the spec names are both here in effect, but only one is
 * enforced here: whether the plugin has anything to ask is this layer's question
 * because only this layer holds the registry, while "does the group already have
 * a cast" is pure SQL and stays inside `insertPerformerSearch`, where no future
 * caller can bypass it. `metadataAnswerability` sits on the same side of the
 * same line for the same reason.
 */
export function enqueuePerformerSearch(
  deps: PerformerEnqueueDeps,
  groupId: number,
  now: number,
): boolean {
  if (performerQueryFor(deps, groupId) === null) return false;
  return insertPerformerSearch(deps.db, groupId, now);
}
