import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import { earnsListBump, findGroup, flagUpgrade, insertGroup } from '../db/groups.ts';
import { insertRelease } from '../db/releases.ts';

function isText(value: string | undefined): boolean {
  return typeof value === 'string';
}

function searchTextFor(display: DisplayFields): string {
  const parts = [display.title];
  if (isText(display.subtitle)) parts.push(display.subtitle ?? '');
  if (isText(display.date)) parts.push(display.date ?? '');
  for (const field of display.fields) {
    if (field !== null && typeof field === 'object' && isText(field.value)) parts.push(field.value);
  }
  return parts.join(' ').toLowerCase();
}

/**
 * The group-level half of a release: what it is, and how it reads.
 *
 * `searchText` is part of it rather than something a caller derives, so that
 * the one place it is computed from `display` is the one place `display` is
 * serialized. A caller recomputing it separately is how a group becomes
 * unsearchable under the name it shows.
 */
export interface PreparedIdentity {
  identityKey: string;
  displayJson: string;
  searchText: string;
}

/**
 * Everything a plugin contributes to one feed item, validated and reduced to
 * the exact values the writes below need — the identity above, plus the
 * release-level half.
 */
export interface PreparedRelease extends PreparedIdentity {
  qualityJson: string;
  score: number;
}

/**
 * The identity checks, shared by both validators below so they cannot drift.
 *
 * Two functions applying "the same checks minus one" by having both lists
 * written out is the duplication that ends with a record accepted down one
 * path and refused down the other; the difference between them is the score,
 * and the score alone.
 *
 * Uncaught by design: the callers own the try/catch, because both of them also
 * have plugin calls of their own to guard.
 */
function checkIdentity(parsed: ParsedRelease): { identity: PreparedIdentity } | { error: string } {
  if (typeof parsed.identityKey !== 'string' || parsed.identityKey.length === 0) {
    return { error: 'invalid parse result: identityKey must be a non-empty string' };
  }

  const display = parsed.display;
  if (display === null || typeof display !== 'object') {
    return { error: 'invalid parse result: display must be an object' };
  }
  if (typeof display.title !== 'string') {
    return { error: 'invalid parse result: display.title must be a string' };
  }
  if (!Array.isArray(display.fields)) {
    return { error: 'invalid parse result: display.fields must be an array' };
  }
  for (const field of display.fields) {
    if (
      field === null ||
      typeof field !== 'object' ||
      typeof field.label !== 'string' ||
      typeof field.value !== 'string'
    ) {
      return {
        error: 'invalid parse result: display.fields elements must have string label and value',
      };
    }
  }

  return {
    identity: {
      identityKey: parsed.identityKey,
      displayJson: JSON.stringify(display),
      searchText: searchTextFor(display),
    },
  };
}

/**
 * The identity half of `validateParsed`, for the one caller that must not ask
 * for a score: a group edit.
 *
 * A group holds no quality — quality is release-level — so scoring one there
 * means scoring an empty object and discarding the answer. A plugin whose
 * `score` cannot survive that would fail every group edit with a 400 the user
 * has no way to satisfy, which is a worse failure than the one the score check
 * exists to prevent. The two paths that genuinely write a `score` keep using
 * `validateParsed`.
 */
export function validateIdentity(
  parsed: ParsedRelease,
): { identity: PreparedIdentity } | { error: string } {
  try {
    return checkIdentity(parsed);
  } catch (error) {
    return { error: `plugin threw: ${(error as Error).message}` };
  }
}

/**
 * Shape-checks everything a plugin handed back, and asks it to score the
 * result, before any of it can reach the database.
 *
 * A plugin is third-party code whose return value crosses a boundary nothing
 * type-checks, and each of the escapes below was reachable: a `score` that
 * throws; a `display` with no `fields`, which made `searchTextFor` throw on a
 * value the compiler swore was iterable; a `score` returning `NaN`, which
 * bound as SQL NULL and tripped `releases.score`'s NOT NULL constraint. In
 * ingest every one of them escaped the per-entry try only to hit the ROLLBACK
 * — which discards the poison item's own `feed_items` row, so the next tick
 * re-serves it, re-throws on it, and never reaches a single entry behind it.
 * One malformed item silently blinded the whole feed, permanently.
 *
 * Hence the try/catch here rather than only in `prepareSafely`: this function
 * is also called from a request handler that has no guard of its own, where a
 * throwing `score` would become a 500 and a rolled-back transaction instead of
 * a recorded, visible parse error.
 *
 * Returning an error string instead puts the failure exactly where the spec
 * says it belongs: on the feed item, as a `parse_error`, visible in the
 * worklist, with the rest of the batch unaffected.
 */
export function validateParsed(
  plugin: MediaTypePlugin,
  parsed: ParsedRelease,
): { prepared: PreparedRelease } | { error: string } {
  try {
    const checked = checkIdentity(parsed);
    if ('error' in checked) return checked;

    const quality = parsed.quality;
    if (quality === null || typeof quality !== 'object' || Array.isArray(quality)) {
      return { error: 'invalid parse result: quality must be an object' };
    }

    const score = plugin.score(quality);
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      return { error: `invalid score: ${String(score)} is not a finite number` };
    }

    return {
      prepared: { ...checked.identity, qualityJson: JSON.stringify(quality), score },
    };
  } catch (error) {
    return { error: `plugin threw: ${(error as Error).message}` };
  }
}

export interface CommitOutcome {
  groupId: number;
  releaseId: number;
  groupCreated: boolean;
  upgradeFlagged: boolean;
}

/**
 * Files one validated release: find-or-create its group, insert the release,
 * and apply the bump rule.
 *
 * Deliberately does no transaction handling of its own — the caller owns the
 * transaction, because a caller doing more than this (stamping `edited_at`,
 * clearing a parse error) must commit that alongside these writes or not at
 * all. Database failures propagate for the same reason.
 */
export function commitRelease(
  db: DatabaseSync,
  prepared: PreparedRelease,
  plugin: MediaTypePlugin,
  feedItemId: number,
  now: number,
): CommitOutcome {
  const existing = findGroup(db, plugin.id, prepared.identityKey);
  const groupId =
    existing?.id ??
    insertGroup(db, {
      plugin: plugin.id,
      identityKey: prepared.identityKey,
      display: prepared.displayJson,
      searchText: prepared.searchText,
      createdAt: now,
    });

  const releaseId = insertRelease(db, {
    groupId,
    feedItemId,
    quality: prepared.qualityJson,
    score: prepared.score,
    createdAt: now,
  });

  // `earnsListBump` decides whether the *bump* is earned — whether this newly
  // arrived release is better than everything the group already knows about.
  // It lives in `db/groups.ts` beside `flagUpgrade` because a merge asks the
  // same question of the releases it moves in, and the two must not drift.
  // Which release ends up flagged is not decided here: `flagUpgrade`
  // re-derives that from the group's own releases, so the flag cannot disagree
  // with the table it summarizes.
  let upgradeFlagged = false;
  if (existing !== null && earnsListBump(db, existing, prepared.score)) {
    flagUpgrade(db, groupId, now);
    upgradeFlagged = true;
  }

  return { groupId, releaseId, groupCreated: existing === null, upgradeFlagged };
}
