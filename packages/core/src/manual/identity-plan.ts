import { basename, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { MediaTypePlugin, ParsedRelease } from '@pickarr/plugin-api';
import { findGroup, getGroup, type GroupRow } from '../db/groups.ts';
import { liveFilesForOtherReleases, type ImportedFileRow } from '../db/imported-files.ts';
import { releasesForGroup } from '../db/releases.ts';
import { isContained, lstatOrNull, resolveDestination } from '../pipeline/import.ts';
import type { PreparedIdentity } from '../ingest/commit.ts';
import type { ManualDeps, ManualResult } from './operations.ts';
import { resolveIdentityFor } from './values.ts';

/** One file to be moved because the identity that placed it has changed. */
export interface PlannedRename {
  importedFileId: number;
  from: string;
  to: string;
}

/** One file to be trashed because the release that owns it lost the pick. */
export interface PlannedTrash {
  importedFileId: number;
  path: string;
}

export interface IdentityPlan {
  groupId: number;
  identityKey: string;
  /**
   * `none` — the key and the display both survive the edit.
   * `display-only` — the key survives, the display does not.
   * `rekey` — the key changes and belongs to no other group.
   * `merge` — the key belongs to another group, which will absorb this one.
   */
  kind: 'none' | 'display-only' | 'rekey' | 'merge';
  mergeInto: { id: number; title: string } | null;
  releasesMoving: number;
  downloadsMoving: number;
  pick: {
    surviving: { releaseId: number; score: number; side: 'source' | 'target' } | null;
    superseded: { releaseId: number; score: number } | null;
  };
  renames: readonly PlannedRename[];
  trashing: readonly PlannedTrash[];
  /** Shown, and does not stop the apply. */
  warnings: readonly string[];
  /** Shown, and refuses the apply. */
  blockers: readonly string[];
  digest: string;
}

/**
 * `JSON.stringify` over an object built in a fixed key order, which is what
 * makes this stable — do not reorder the `withoutDigest` literal built in
 * `planIdentityChange` below, and do not build it from a spread of something
 * whose order is not fixed.
 *
 * `crypto.subtle`, not `createHash`: this runs on the request path, and the
 * async form is the house rule for anything that would otherwise block the
 * loop.
 */
async function digestOf(plan: Omit<IdentityPlan, 'digest'>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function titleOf(group: GroupRow): string {
  const display = JSON.parse(group.display) as { title?: string };
  return display.title ?? group.identityKey;
}

function countDownloads(db: DatabaseSync, groupId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM downloads WHERE group_id = ?')
    .get(groupId) as { n: number } | undefined;
  return row === undefined ? 0 : Number(row.n);
}

/**
 * The score of the release a group's `picked_release_id` names, and the id
 * that goes with it — or null when the group has no pick, or when the pick
 * names a release the group (post-merge) will not hold. Bundling the id with
 * the score, rather than returning the score alone, is what lets
 * `reconcilePick` below build its result without a non-null assertion: a
 * `heldScore` result that is not null already carries the release id that
 * produced it, so there is nothing left to assert about `source.pickedReleaseId`
 * or `target.pickedReleaseId` being non-null at the call site.
 */
function heldScore(
  db: DatabaseSync,
  releaseId: number | null,
  groupId: number,
): { releaseId: number; score: number } | null {
  if (releaseId === null) return null;
  const row = db
    .prepare('SELECT score FROM releases WHERE id = ? AND group_id = ?')
    .get(releaseId, groupId) as { score: number } | undefined;
  return row === undefined ? null : { releaseId, score: Number(row.score) };
}

/**
 * The pick the merged group ends up with, and the one it does not.
 *
 * Higher score wins; a tie goes to the target, matching migration 4's rule that
 * the survivor's pick stands. A pick naming a release the merged group will not
 * hold counts as no pick at all — `holds()` in `db/migrations.ts` makes the same
 * call, for the same reason: a dangling pick is already broken, and a merge is
 * the one moment it could be spread rather than merely tolerated.
 */
function reconcilePick(
  db: DatabaseSync,
  source: GroupRow,
  target: GroupRow | null,
): IdentityPlan['pick'] {
  const sourceHeld = heldScore(db, source.pickedReleaseId, source.id);
  const targetHeld = target === null ? null : heldScore(db, target.pickedReleaseId, target.id);

  // Nested, rather than one `sourceHeld === null && targetHeld === null` check
  // up front: TypeScript narrows a variable across an early return only within
  // the branch that tested *that* variable, not from a compound condition over
  // two variables at once, and this shape is what lets both ids reach the
  // literals below without a non-null assertion anywhere.
  if (sourceHeld === null) {
    if (targetHeld === null) return { surviving: null, superseded: null };
    return { surviving: { ...targetHeld, side: 'target' }, superseded: null };
  }
  if (targetHeld === null) {
    return { surviving: { ...sourceHeld, side: 'source' }, superseded: null };
  }

  return sourceHeld.score > targetHeld.score
    ? { surviving: { ...sourceHeld, side: 'source' }, superseded: { ...targetHeld } }
    : { surviving: { ...targetHeld, side: 'target' }, superseded: { ...sourceHeld } };
}

/**
 * Where a file already in the library would go under a new identity, or why
 * it cannot be placed at all.
 *
 * Asked of the plugin rather than computed here, and asked per file. The
 * destination must come from the same `planImport` a fresh import would use, or
 * a renamed file and a newly imported one can disagree about where the same
 * scene belongs — and the plugin needs *that file's own release's* quality,
 * because a merged group can hold a 1080p and a 2160p file at once and the path
 * template renders resolution. Using the pick's quality for both would move a
 * file to a path naming a resolution it is not.
 *
 * `null` means the plugin declined to place the file at all (a `planImport`
 * returning nothing); `{ refused }` means it tried and the attempt could not
 * be honoured. The two are kept apart, rather than both collapsing to `null`,
 * so the caller can word a blocker that says *why* rather than just *that*.
 *
 * Both `plugin.planImport` and `resolveDestination` are called inside one
 * try/catch, for the same reason `buildRelease` in `values.ts` guards
 * `fromManualValues`: a plugin hook is untrusted code running inside a request
 * handler with no guard of its own, and letting it throw would turn a blocker
 * the design promises to *show* into a 500 with a stack trace instead of "a
 * message shown under the fields that caused it". `resolveDestination` throws
 * exactly this way when a plugin's destination lexically escapes the library
 * root — `pipeline/import.ts` states outright that "a plugin is not trusted to
 * police its own paths" — so an escaping destination and a `planImport` that
 * throws outright are the same failure mode from here: something the plugin
 * did that must not reach the caller as an exception.
 */
function destinationFor(
  plugin: MediaTypePlugin,
  identity: PreparedIdentity,
  quality: string,
  libraryRoot: string,
  file: ImportedFileRow,
): { destination: string } | { refused: string } | null {
  const media: ParsedRelease = {
    identityKey: identity.identityKey,
    display: JSON.parse(identity.displayJson) as ParsedRelease['display'],
    quality: JSON.parse(quality) as ParsedRelease['quality'],
  };
  try {
    const plan = plugin.planImport(media, [
      {
        relativePath: basename(file.destPath),
        absolutePath: file.destPath,
        sizeBytes: file.sizeBytes,
      },
    ]);
    const planned = plan?.files[0];
    if (planned === undefined) return null;
    return { destination: resolveDestination(libraryRoot, planned.destination) };
  } catch (error) {
    // A plugin is untrusted code and is not bound to throw an `Error` — a
    // string literal or a plain object thrown instead would read back as
    // `undefined` through `(error as Error).message`, which is a blocker that
    // names no reason. `instanceof Error` takes the real message when there is
    // one; `String(error)` always produces *something* when there is not.
    const reason = error instanceof Error ? error.message : String(error);
    return { refused: reason };
  }
}

/** The quality of the release an imported file belongs to, through its download. */
function qualityForFile(db: DatabaseSync, file: ImportedFileRow): string | null {
  const row = db
    .prepare(
      `SELECT r.quality AS quality
         FROM downloads d JOIN releases r ON r.id = d.release_id
        WHERE d.id = ?`,
    )
    .get(file.downloadId) as { quality: string } | undefined;
  return row === undefined ? null : String(row.quality);
}

/**
 * Everything an identity change would do, and nothing done.
 *
 * Reads the database and stats the filesystem; writes neither. Both the preview
 * route and the apply call this, which is the point: the plan a user confirms
 * and the plan that runs are the same computation, so they cannot drift.
 */
export async function planIdentityChange(
  deps: ManualDeps,
  groupId: number,
  values: Record<string, string>,
): Promise<ManualResult<IdentityPlan>> {
  const { db } = deps;
  const group = getGroup(db, groupId);
  if (group === null) return { error: `no such group: ${groupId}`, status: 404 };

  const plugin = deps.registry.byId(group.plugin);
  if (plugin === undefined) {
    return { error: `no plugin loaded for id ${group.plugin}`, status: 409 };
  }

  const resolved = resolveIdentityFor(plugin, group, values);
  if ('error' in resolved) return { error: resolved.error, status: resolved.status };
  const identity = resolved.identity;

  const target =
    identity.identityKey === group.identityKey
      ? null
      : findGroup(db, group.plugin, identity.identityKey);
  const merging = target !== null && target.id !== group.id;

  const kind: IdentityPlan['kind'] = merging
    ? 'merge'
    : identity.identityKey !== group.identityKey
      ? 'rekey'
      : identity.displayJson !== group.display
        ? 'display-only'
        : 'none';

  const pick = merging ? reconcilePick(db, group, target) : reconcilePick(db, group, null);

  const renames: PlannedRename[] = [];
  const trashing: PlannedTrash[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];

  // Resolved once here, matching `pipeline/import.ts`'s `resolveDestination`
  // and `manual/operations.ts`'s own read of this same registry value: the
  // registry (`plugins/registry.ts`) accepts any non-empty string, so an
  // unresolved root with a trailing slash or a relative path would make the
  // raw `isContained` check below compare against a string `file.destPath`
  // (already absolute) can never start with, turning every rename into a
  // false "resolves outside the library root" blocker.
  const libraryRoot = resolve(deps.registry.libraryRootById(group.plugin));
  const keepReleaseId = pick.surviving?.releaseId ?? null;

  // Trashing is decided first: a row about to leave the library is not also a
  // row to rename, and moving a file to its new name only to move it to
  // trashDir would report two actions against one file.
  //
  // A superseded pick can sit on either side of a merge: if the target held
  // the higher-scoring release, it is the *source's* pick that is superseded,
  // and if the source held it, the *target's* is. So both groups are asked —
  // the source always, and the target only when merging, since without a
  // merge there is no target to ask. `pick.superseded` is non-null only when
  // both sides had a pick to compare, which only happens on a merge, but the
  // `merging` guard is kept explicit rather than relied upon implicitly.
  const doomed: ImportedFileRow[] =
    pick.superseded === null
      ? []
      : [
          ...liveFilesForOtherReleases(db, group.id, keepReleaseId),
          ...(merging ? liveFilesForOtherReleases(db, target.id, keepReleaseId) : []),
        ];
  // The same three checks the rename loop below makes, in the same order and
  // with the same wording, because two of them are the same conditions
  // `trashFiles` (`pipeline/upgrade.ts`) throws on. Without them the identical
  // filesystem fact — a directory where a regular file should be, a `dest_path`
  // outside the root — reached the operator as a blocker before they committed
  // when it belonged to a *renamed* row, and as a `failed` entry after the merge
  // had already happened when it belonged to a *doomed* one. §4.3 of the design
  // phrases both blockers about the row rather than about the rename, so this is
  // the code coming to the design rather than the other way round.
  //
  // Every doomed row is pushed regardless of what its check found, and that is
  // load-bearing rather than laziness: `trashing` and `trashedPaths` are the
  // plan's account of which paths phase 2 will clear, a blocked plan never
  // reaches the applier at all (`editGroup` refuses on `blockers`), and dropping
  // a blocked entry would only change the plan the dialog renders while
  // re-opening the occupant blocker below on a path this plan already speaks
  // for — see `trashedPaths`.
  for (const file of doomed) {
    const source = await lstatOrNull(file.destPath);
    if (source === null) {
      // A warning rather than a blocker, matching the rename side and matching
      // what phase 2 will actually do with it: `trashFiles` retires a row whose
      // file is already gone with a null `trash_path` instead of failing.
      warnings.push(`${file.destPath} is already gone from disk; nothing to trash`);
    } else if (!source.isFile()) {
      blockers.push(`${file.destPath} is not a regular file; refusing to trash it`);
    } else if (!isContained(libraryRoot, file.destPath, false)) {
      blockers.push(`${file.destPath} resolves outside the library root; refusing to trash it`);
    }
    trashing.push({ importedFileId: file.id, path: file.destPath });
  }
  const doomedIds = new Set(doomed.map((file) => file.id));
  /**
   * The paths phase 2 of the apply will have emptied before phase 3 renames
   * anything, and the reason the occupant check below is not a bare
   * `lstat`-is-non-null test.
   *
   * This is the *motivating* case for trash-before-rename, not a corner of it:
   * the design's own rationale for that ordering is that "a superseded file
   * frequently occupies the exact path a renamed file wants". A file this same
   * plan is about to trash is not a foreign occupant — the blocker's subject is
   * something the group did not put there — so refusing on it would make the
   * commonest merge in the feature permanently unappliable, and would make phase
   * 2 unreachable through the one situation it exists for.
   *
   * Do not "simplify" this away: without it, `editGroup`'s phases 2 and 3 are
   * ordered for a collision the planner never lets through.
   */
  const trashedPaths = new Set(doomed.map((file) => file.destPath));

  // Every live file the surviving group will own, from both sides for a merge.
  // The target's own files are already at paths its identity produced — and a
  // merge leaves the target's identity alone — so only the source's can be
  // stale. A rekey has only the one group's.
  for (const file of liveFilesForOtherReleases(db, group.id, null)) {
    if (doomedIds.has(file.id)) continue;

    const quality = qualityForFile(db, file);
    if (quality === null) {
      warnings.push(`imported file ${file.id} has no release on record; leaving it where it is`);
      continue;
    }

    const placed = destinationFor(plugin, identity, quality, libraryRoot, file);
    if (placed === null) {
      blockers.push(
        `plugin ${plugin.id} will not place ${file.destPath} under the new identity, ` +
          'so renaming it is impossible and leaving it would strand it',
      );
      continue;
    }
    if ('refused' in placed) {
      blockers.push(
        `${file.destPath} could not be placed under the new identity: ${placed.refused}`,
      );
      continue;
    }
    const to = placed.destination;
    if (to === file.destPath) continue;

    const source = await lstatOrNull(file.destPath);
    if (source === null) {
      warnings.push(`${file.destPath} is already gone from disk; nothing to move`);
      continue;
    }
    if (!source.isFile()) {
      blockers.push(`${file.destPath} is not a regular file; refusing to move it`);
      continue;
    }
    if (!isContained(libraryRoot, file.destPath, false)) {
      blockers.push(`${file.destPath} resolves outside the library root; refusing to move it`);
      continue;
    }

    // Occupied by something *other than* a file this plan is already removing.
    // See `trashedPaths` above for why the exemption exists; the blocker still
    // stands for every other occupant, which is the case it was written for —
    // an unrelated file, or one an operator put there by hand.
    const occupant = await lstatOrNull(to);
    if (occupant !== null && !trashedPaths.has(to)) {
      blockers.push(`${to} is occupied by something this group did not put there`);
      continue;
    }

    renames.push({ importedFileId: file.id, from: file.destPath, to });
  }

  const withoutDigest: Omit<IdentityPlan, 'digest'> = {
    groupId,
    identityKey: identity.identityKey,
    kind,
    mergeInto: merging ? { id: target.id, title: titleOf(target) } : null,
    releasesMoving: merging ? releasesForGroup(db, group.id).length : 0,
    downloadsMoving: merging ? countDownloads(db, group.id) : 0,
    pick,
    renames,
    trashing,
    warnings,
    blockers,
  };

  return { ok: { ...withoutDigest, digest: await digestOf(withoutDigest) } };
}
