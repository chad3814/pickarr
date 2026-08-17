import type { MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import { validateIdentity, type PreparedIdentity } from '../ingest/commit.ts';
import type { GroupRow } from '../db/groups.ts';

/**
 * Asks the plugin to turn field values into a release.
 *
 * Guarded for the same reason `validateParsed` is: this runs inside a request
 * handler that has no guard of its own, and a plugin hook that throws would
 * otherwise be a 500 over a rolled-back transaction rather than a message
 * shown under the fields that caused it.
 */
export function buildRelease(
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
export function mergedValues(
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
export function editHooks(
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
export function mediaFor(group: GroupRow, quality: string): ParsedRelease {
  return {
    identityKey: group.identityKey,
    display: JSON.parse(group.display) as ParsedRelease['display'],
    quality: JSON.parse(quality) as ParsedRelease['quality'],
  };
}

/**
 * The identity a group would have if these values were saved.
 *
 * The three steps — prefill, merge, rebuild, validate — were inline in
 * `editGroup` when it was the only caller. The planner and the applier must
 * agree exactly about what a set of values *means*, and the cheapest way to
 * guarantee that is for there to be one function that decides.
 *
 * `mediaFor(group, '{}')` passes an empty quality deliberately: a group holds
 * none of its own — quality is release-level — and the plugin contract requires
 * a correct key and display from the identity-scoped values alone.
 */
export function resolveIdentityFor(
  plugin: MediaTypePlugin,
  group: GroupRow,
  values: Record<string, string>,
): { identity: PreparedIdentity } | { error: string; status: 400 | 409 } {
  const hooks = editHooks(plugin);
  if (hooks === null) {
    return { error: `plugin ${plugin.id} does not support manual editing`, status: 409 };
  }

  const merged = mergedValues(plugin, hooks.to, mediaFor(group, '{}'), values);
  if ('error' in merged) return { error: merged.error, status: 400 };

  const built = buildRelease(plugin, hooks.from, merged.values);
  if ('error' in built) return { error: built.error, status: 400 };

  const validated = validateIdentity(built.media);
  if ('error' in validated) return { error: validated.error, status: 400 };

  return { identity: validated.identity };
}
