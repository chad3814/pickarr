import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DownloadedFile,
  ImportPlan,
  MediaTypePlugin,
  ParsedRelease,
  QualityTokens,
} from '@pickarr/plugin-api';
import { getAppState, setAppState } from '../db/app-state.ts';
import { getDownload } from '../db/downloads.ts';
import { getGroup, groupHistory, updateGroupIdentity } from '../db/groups.ts';
import { updateDestPath } from '../db/imported-files.ts';
import { mergeGroupInto } from '../db/merge-groups.ts';
import { clearGroupMetadata } from '../db/metadata.ts';
import { getRelease } from '../db/releases.ts';
import { knownSiteNames } from '../db/sites.ts';
import { inTransaction } from '../db/transaction.ts';
import { maybeNum, maybeStr, num, str, type SqlRow } from '../db/row.ts';
import { validateIdentity, type PreparedIdentity } from '../ingest/commit.ts';
import type { PluginRegistry } from '../plugins/registry.ts';
import { isContained } from './import.ts';

/**
 * See the design doc and `task-3-brief.md` for the full account of why this
 * pass exists: the parser's identity rules are not append-only, so a title
 * that used to key one way can key another after a parser fix, while the
 * group already on disk keeps the old key and the old library path forever —
 * nothing else in the system ever revisits an identity once it is written.
 * This function is the *proposal* half of the repair. It never writes; Tasks
 * 4/4a/5 read its output and do the actual `UPDATE`s, the merge, and the
 * renames. That split is also what lets Task 6 run this on every boot as a
 * drift check and only count the outcomes — a read has no blast radius, so
 * running it far more often than it is acted on costs nothing.
 */
export type RekeyOutcome =
  | { kind: 'unchanged' }
  | { kind: 'skipped-edited' }
  | { kind: 'skipped-unparsable'; reason: string }
  | { kind: 'skipped-collision'; withGroupId: number; reason: string }
  | { kind: 'merge'; intoGroupId: number }
  | {
      kind: 'move';
      identityKey: string;
      displayJson: string;
      searchText: string;
      displayChanged: boolean;
      renames: { fileId: number; from: string; to: string }[];
    };

export interface RekeyProposal {
  groupId: number;
  outcome: RekeyOutcome;
}

interface GroupRawRow {
  id: number;
  plugin: string;
  identityKey: string;
  display: string;
  editedAt: number | null;
  rawTitle: string | null;
}

function toGroupRawRow(row: SqlRow): GroupRawRow {
  return {
    id: num(row, 'id'),
    plugin: str(row, 'plugin'),
    identityKey: str(row, 'identity_key'),
    display: str(row, 'display'),
    editedAt: maybeNum(row, 'edited_at'),
    rawTitle: maybeStr(row, 'raw_title'),
  };
}

/**
 * The slot a group occupies in `media_groups`' own `UNIQUE (plugin,
 * identity_key)` constraint, as a single map key. Two different plugins are
 * two different namespaces — nothing stops plugin `a` and plugin `b` from
 * emitting the identical string as an identity key — so the key has to carry
 * the plugin id, not just the identity key alone.
 */
function slot(pluginId: string, identityKey: string): string {
  return `${pluginId}\0${identityKey}`;
}

/**
 * A group that will not move under this proposal, whatever else happens
 * elsewhere in the pass: it is edited, unparsable, already correct, or its
 * key survives even though its display does not (case 7 — see below). Its
 * outcome is therefore already final the moment it is computed; nothing a
 * collision check discovers can change it, because collisions are about who
 * is fighting over a slot, and a stationary group's slot is the one it
 * already, uncontestedly, holds.
 */
interface StationaryAttempt {
  readonly kind: 'stationary';
  readonly slot: string;
  readonly outcome: RekeyOutcome;
}

/**
 * A group whose fresh parse disagrees with its stored `identity_key`. Its
 * outcome is *not* final yet: another group might already hold the slot it
 * wants, or a second mover might want the same one, and only
 * `planRekey` — which sees every group at once — can tell.
 */
interface MoverAttempt {
  readonly kind: 'mover';
  readonly slot: string;
  readonly identity: PreparedIdentity;
}

type Attempt = StationaryAttempt | MoverAttempt;

function stationary(row: GroupRawRow, outcome: RekeyOutcome): StationaryAttempt {
  return { kind: 'stationary', slot: slot(row.plugin, row.identityKey), outcome };
}

/**
 * Either every live file got a destination, or none of this group's renames
 * are trustworthy enough to act on. There is no partial-success shape: a
 * `move` whose `renames` silently omitted a file it couldn't figure out would
 * report success while quietly leaving that one file stranded at its old
 * path under the group's new key — the exact failure this whole pass exists
 * to catch, now with nothing anywhere saying it happened. "Skip the group"
 * costs a human one look at a reason string; "half-rename it" costs a file
 * that nothing will ever revisit, because the group's own key will read
 * `unchanged` on every future run once the identity columns are updated.
 */
type RenameResult =
  | { ok: true; renames: { fileId: number; from: string; to: string }[] }
  | { ok: false; reason: string };

/**
 * Builds the destination every live imported file would move to if the
 * group were re-keyed to `identity`, by asking the plugin exactly as
 * `pipeline/import.ts:324` does at real import time — never by editing the
 * old path's text. A title correction and a path are not the same
 * transformation (the path template can reorder, drop or rename segments
 * `identityKey` never touches directly), so string-replacing the old title
 * inside the old path would silently miss every one of those and place a file
 * where the template says nothing should live.
 *
 * Fails the whole group, naming the file, the moment any one file's
 * destination can't be computed — see `RenameResult` above for why a partial
 * list is not an acceptable answer.
 *
 * A file whose computed destination equals its current `dest_path` is
 * dropped rather than included as a no-op rename. This is exactly case 7's
 * shape carried down to the file level: `{sitename}`, `{date}` and every
 * other path-template placeholder key off `identityKey`
 * (`path-template.ts`'s `templateValues`), so a proposal whose key does not
 * move (only its `display` does — a site spelling learned after the group
 * was created, say) recomputes the identical path for every live file. Both
 * `destPath` and `to` are produced by the same `resolve(libraryRoot, ...)`
 * normalisation (here and in `pipeline/import.ts`'s `resolveDestination`),
 * so a plain string comparison is exact — there is no symlink or
 * relative-segment ambiguity `realpath` would be needed to resolve, and
 * `realpath` costs a syscall per file this pass would otherwise not spend.
 * Keeping such an entry out of `renames` is what lets `applyMove` skip the
 * destination-exists check for it entirely: the "destination" is the file's
 * own current path, not a collision.
 *
 * `to` is also checked with the same `isContained` a plugin's destination is
 * checked with at real import time (`pipeline/import.ts`'s
 * `resolveDestination`), on the same principle stated there: a plugin is not
 * trusted to keep its own paths inside the library. Not reachable with the
 * shipped plugin today — nothing in it can turn an identity key into a
 * `..`-escaping or absolute destination — but this pass hands `to` straight
 * to `rename()`, same as import does, so it must refuse exactly what import
 * refuses rather than only resembling that check. A prior draft of this
 * comment claimed the two were already doing "the same normalisation" while
 * only one of them enforced containment; fixed here by making it true,
 * rather than by narrowing the claim.
 */
function computeRenames(
  db: DatabaseSync,
  plugin: MediaTypePlugin,
  libraryRoot: string,
  groupId: number,
  identity: PreparedIdentity,
): RenameResult {
  const files = db
    .prepare(
      `SELECT id, download_id, dest_path, size_bytes
         FROM imported_files WHERE group_id = ? AND trashed_at IS NULL ORDER BY id`,
    )
    .all(groupId) as SqlRow[];
  if (files.length === 0) return { ok: true, renames: [] };

  const display = JSON.parse(identity.displayJson) as ParsedRelease['display'];
  const renames: { fileId: number; from: string; to: string }[] = [];

  for (const file of files) {
    const fileId = num(file, 'id');
    const downloadId = num(file, 'download_id');
    const download = getDownload(db, downloadId);
    if (download === null) {
      return { ok: false, reason: `imported file ${fileId}: its download row (id ${downloadId}) no longer exists` };
    }
    const release = getRelease(db, download.releaseId);
    if (release === null) {
      return {
        ok: false,
        reason: `imported file ${fileId}: its release row (id ${download.releaseId}) no longer exists`,
      };
    }

    const destPath = str(file, 'dest_path');
    const media: ParsedRelease = {
      identityKey: identity.identityKey,
      display,
      quality: JSON.parse(release.quality) as QualityTokens,
    };
    const sourceFiles: DownloadedFile[] = [
      { absolutePath: destPath, relativePath: basename(destPath), sizeBytes: num(file, 'size_bytes') },
    ];

    let plan: ImportPlan | null;
    try {
      plan = plugin.planImport(media, sourceFiles);
    } catch (error) {
      return { ok: false, reason: `imported file ${fileId}: planImport threw: ${(error as Error).message}` };
    }
    const planned = plan?.files[0];
    if (planned === undefined) {
      return {
        ok: false,
        reason: `imported file ${fileId}: planImport returned ${plan === null ? 'null' : 'no files'}`,
      };
    }

    const to = resolve(libraryRoot, planned.destination);
    // Refused exactly as `pipeline/import.ts`'s `resolveDestination` refuses
    // it, and for the same reason — see the doc comment above. `false`: `to`
    // names a file, never the library root directory itself, matching
    // `resolveDestination`'s own `allowRootItself` argument.
    if (!isContained(resolve(libraryRoot), to, false)) {
      return {
        ok: false,
        reason: `imported file ${fileId}: planned destination "${to}" escapes the library root "${resolve(libraryRoot)}"`,
      };
    }
    // Already there: a display-only correction (the key, and so the path,
    // did not move) is not a rename. See the doc comment above.
    if (to !== destPath) renames.push({ fileId, from: destPath, to });
  }

  return { ok: true, renames };
}

/**
 * The outcome for a group whose new identity has already cleared any
 * collision check — either because it never needed one (case 7's key never
 * moves, so nothing can be standing in its way) or because it won one. Not
 * unconditionally a `move`: if any live file's destination can't be computed,
 * this reports `skipped-unparsable` instead, per `RenameResult`'s reasoning —
 * a wrong answer is worse than no answer, and skipping a group beats
 * half-renaming it.
 */
function finalizeMove(
  db: DatabaseSync,
  registry: PluginRegistry,
  row: GroupRawRow,
  identity: PreparedIdentity,
  displayChanged: boolean,
): RekeyOutcome {
  const plugin = registry.byId(row.plugin);
  if (plugin === undefined) {
    // Unreachable in practice: attemptFor() already refused an unknown
    // plugin id before any group of this plugin can reach here. Answered
    // rather than asserted, for the same reason every other branch in this
    // module prefers a stated refusal to a thrown assertion.
    return {
      kind: 'skipped-unparsable',
      reason: `group ${row.id}: plugin id "${row.plugin}" resolved during parse but not while planning its renames`,
    };
  }

  const result = computeRenames(db, plugin, registry.libraryRootById(row.plugin), row.id, identity);
  if (!result.ok) {
    return {
      kind: 'skipped-unparsable',
      reason: `group ${row.id} would move to identity key "${identity.identityKey}", but its renames could not be computed: ${result.reason}`,
    };
  }

  return {
    kind: 'move',
    identityKey: identity.identityKey,
    displayJson: identity.displayJson,
    searchText: identity.searchText,
    displayChanged,
    renames: result.renames,
  };
}

/**
 * Classifies one group in isolation: edited, unparsable, or a fresh identity
 * to weigh against the rest of the database. Never decides a collision —
 * that needs every group's attempt at once, which is `planRekey`'s job, not
 * this one's.
 */
function attemptFor(
  db: DatabaseSync,
  registry: PluginRegistry,
  row: GroupRawRow,
): Attempt {
  // A hand-edited group is off-limits regardless of what the parser would do
  // with its title today — the values on it were typed, not parsed, and a
  // re-parse pass has no business overwriting a human's correction.
  if (row.editedAt !== null) return stationary(row, { kind: 'skipped-edited' });

  if (row.rawTitle === null) {
    return stationary(row, {
      kind: 'skipped-unparsable',
      reason: `group ${row.id} has no releases row, so there is no raw title to re-parse`,
    });
  }

  const plugin = registry.byId(row.plugin);
  if (plugin === undefined) {
    // `media_groups.plugin` holds `plugin.id`, never the package name — see
    // `registry.byId`. Getting this resolution wrong is exactly how an
    // earlier feature on this project shipped broken: every group silently
    // fell into this branch and the pass proposed nothing, with nothing
    // anywhere saying so. Refusing loudly (as `skipped-unparsable`, not a
    // thrown error that would abort every group behind it) is the point.
    return stationary(row, {
      kind: 'skipped-unparsable',
      reason: `plugin id "${row.plugin}" is not registered`,
    });
  }

  let parsed: ParsedRelease | null;
  try {
    parsed = plugin.parse(row.rawTitle);
  } catch (error) {
    return stationary(row, {
      kind: 'skipped-unparsable',
      reason: `plugin threw: ${(error as Error).message}`,
    });
  }
  if (parsed === null) {
    return stationary(row, {
      kind: 'skipped-unparsable',
      // Read immediately after the call it describes, exactly as its own
      // contract requires.
      reason: plugin.refusalReason?.() ?? 'plugin refused to parse the raw title',
    });
  }

  const validated = validateIdentity(parsed);
  if ('error' in validated) {
    return stationary(row, { kind: 'skipped-unparsable', reason: validated.error });
  }

  const identity = validated.identity;
  const keyChanged = identity.identityKey !== row.identityKey;
  const displayChanged = identity.displayJson !== row.display;

  if (!keyChanged && !displayChanged) return stationary(row, { kind: 'unchanged' });

  if (!keyChanged) {
    // Case 7: the key survives but the display does not — a site learned
    // since this group was created corrects its spelling without touching
    // the slug the site collapses to. The key never moving means nothing can
    // ever contest this slot, so the outcome is final immediately.
    return stationary(row, finalizeMove(db, registry, row, identity, true));
  }

  return { kind: 'mover', slot: slot(row.plugin, identity.identityKey), identity };
}

/** Every mover contesting one slot, plus the group (if any) already holding it uncontested. */
interface Bucket {
  stationaryId: number | null;
  moverIds: number[];
}

export function planRekey(db: DatabaseSync, registry: PluginRegistry): RekeyProposal[] {
  // Every plugin is seeded with whatever sites this installation has
  // confirmed, exactly as `main.ts` does once at boot. Skipping this would
  // make case 7's whole class of correction invisible: the identity key
  // would still agree, so nothing would look wrong, but the corrected
  // display this pass exists to notice would never be computed, because the
  // plugin would still be guessing off configuration alone. `learnSites` is
  // documented additive, so re-seeding a plugin that already knows a site is
  // a no-op, not a second write of anything.
  const sites = knownSiteNames(db);
  for (const plugin of registry.all()) plugin.learnSites?.(sites);

  const rows = db
    .prepare(
      `SELECT g.id, g.plugin, g.identity_key, g.display, g.edited_at,
              (SELECT fi.raw_title
                 FROM releases r JOIN feed_items fi ON fi.id = r.feed_item_id
                WHERE r.group_id = g.id ORDER BY r.id LIMIT 1) AS raw_title
         FROM media_groups g
        ORDER BY g.id`,
    )
    .all()
    .map((row) => toGroupRawRow(row as SqlRow));

  const attempts = new Map<number, Attempt>();
  for (const row of rows) attempts.set(row.id, attemptFor(db, registry, row));

  // Bucket every group by the slot it would occupy if nothing blocked it: its
  // own current slot for anything stationary, its freshly parsed slot for a
  // mover. Two entries sharing a bucket is the collision, and at most one of
  // them can be stationary — a stationary group's slot is its own *current*
  // key, and the schema's `UNIQUE (plugin, identity_key)` already guarantees
  // no two groups hold that today. A moved key colliding with a group that
  // is not moving is therefore indistinguishable, in this map, from two
  // movers colliding with each other; both are read off the same bucket.
  //
  // Known, unhandled gap (fix-wave review, 2026-08-16): a mover is bucketed
  // only by the slot it moves *into*, never by the slot it vacates. If group
  // B's fresh key is group A's *current* key while A is itself moving away
  // to a third slot, both A and B are proposed as plain `move`s here — A's
  // bucket (A's current slot) sees only A, since B's bucket key is B's own
  // fresh slot, not A's — and `applyRekey` applies proposals in group-id
  // order. If `B.id < A.id`, B's `updateGroupIdentity` runs first and hits
  // `UNIQUE (plugin, identity_key)` against A's still-current row, landing B
  // in `failed` permanently (nothing ever retries a `failed` group — see
  // `REKEY_MARKER_KEY`'s doc comment and the re-key spec's failure section
  // for the recovery path). No half-state results: the throw precedes any
  // rename, so B is left exactly as it was. Deliberately not fixed here —
  // the owner's real database has 0 failed groups, and redesigning the
  // bucketing to see vacated slots is a larger change than this fix wave
  // should carry.
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const attempt = attempts.get(row.id);
    if (attempt === undefined) continue; // unreachable: every row got an attempt above.
    const bucket = buckets.get(attempt.slot) ?? { stationaryId: null, moverIds: [] };
    if (attempt.kind === 'mover') bucket.moverIds.push(row.id);
    else bucket.stationaryId = row.id;
    buckets.set(attempt.slot, bucket);
  }

  const proposals: RekeyProposal[] = [];
  for (const row of rows) {
    const attempt = attempts.get(row.id);
    if (attempt === undefined) continue; // unreachable, as above.

    if (attempt.kind === 'stationary') {
      proposals.push({ groupId: row.id, outcome: attempt.outcome });
      continue;
    }

    const bucket = buckets.get(attempt.slot);
    const contenders = bucket === undefined ? 1 : bucket.moverIds.length + (bucket.stationaryId === null ? 0 : 1);

    if (contenders <= 1) {
      const displayChanged = attempt.identity.displayJson !== row.display;
      proposals.push({
        groupId: row.id,
        outcome: finalizeMove(db, registry, row, attempt.identity, displayChanged),
      });
      continue;
    }

    // Exactly one mover against a group that already, uncontestedly, holds
    // the slot: the mechanical rule from the design doc decides by history
    // alone, never by re-reading the titles. A wrong guess from titles
    // deletes a group; `groupHistory` is the proxy for what the user would
    // actually lose, and a trashed `imported_files` row still counts as
    // loss — the file was placed under this group's name once.
    if (bucket !== undefined && bucket.moverIds.length === 1 && bucket.stationaryId !== null) {
      const holderId = bucket.stationaryId;
      const history = groupHistory(db, row.id);
      proposals.push({
        groupId: row.id,
        outcome:
          history === null
            ? { kind: 'merge', intoGroupId: holderId }
            : {
                kind: 'skipped-collision',
                withGroupId: holderId,
                reason:
                  `group ${row.id} would take identity key "${attempt.identity.identityKey}" already ` +
                  `held by group ${holderId}, but group ${row.id} has ${history} recorded against it ` +
                  'and the pass never merges a group that has files or downloads on record',
              },
      });
      continue;
    }

    // Two or more movers wanting one slot, with or without a stationary
    // holder also in the way — "any other combination" from the design doc.
    // Never a merge: a merge needs a single, uncontested survivor to name,
    // and a three-or-more-way pile-up (or two movers with no holder at all)
    // has none. Named after the first other contender in the bucket so the
    // message points somewhere real, preferring the stationary holder when
    // one exists because it is the group least likely to change out from
    // under whoever reads this next.
    const other = bucket?.stationaryId ?? bucket?.moverIds.find((id) => id !== row.id) ?? row.id;
    proposals.push({
      groupId: row.id,
      outcome: {
        kind: 'skipped-collision',
        withGroupId: other,
        reason: `group ${row.id} and group ${other} both parse to identity key "${attempt.identity.identityKey}"`,
      },
    });
  }

  return proposals;
}

/**
 * Everything `applyRekey` needs beyond `db` and `registry`, injected instead
 * of imported directly so a test can substitute a fake without touching a
 * real filesystem or a real clock — the same reasoning `ManualDeps` already
 * applies one layer up, and `now` is the same member `ManualDeps` carries for
 * the same reason. `rename` is `node:fs/promises`' own function, unadapted:
 * the real caller (Task 6) wires up the import directly, and a test wires up
 * one that fails on demand — see `applyMove`'s tests for exactly which
 * failures that has to cover.
 *
 * `commit` exists for the same reason as `rename`, and only for that reason:
 * `applyMove` runs its own hand-rolled `BEGIN`/`COMMIT`/`ROLLBACK` (it cannot
 * use the shared `inTransaction` from `db/transaction.ts`, since that helper
 * is synchronous and the renames it would need to wrap are not) — see the
 * comment on `applyMove`. Wrapping only the `COMMIT` call, and only here,
 * lets a test make a commit fail on demand — deterministically, unlike
 * poisoning it with a deferred foreign key, which trips wherever `COMMIT`
 * happens to be called and so cannot distinguish *where* it was called from
 * — without adding any seam to `db/transaction.ts` itself, which is shared
 * with the manual edit path and must not grow one just for this test. The
 * real implementation is exactly `(db) => db.exec('COMMIT')`; there is
 * nothing else it could legitimately do.
 *
 * `now` arrived with the merge and nothing else needs it: a re-key writes no
 * timestamp of its own (spec §6 — not `edited_at`, not `list_rank_at`), but a
 * merge re-derives the survivor's upgrade flag, and the arrival half of that
 * rule stamps `list_rank_at`. See `mergeGroupInto`.
 */
export interface RekeyDeps {
  now(): number;
  rename(from: string, to: string): Promise<void>;
  commit(db: DatabaseSync): void;
}

/**
 * Tally of what one run of the write pass actually did, over every proposal
 * `planRekey` returned. `renamed` counts individual files moved on disk,
 * summed across every `move` — a display-only correction (case 7) contributes
 * zero even though it counts toward `moved`, and a group with several live
 * files can contribute more than one. A merge that throws is counted in
 * `failed` rather than in `merged`, exactly as a move that throws is — the
 * two are the same claim, that the pass reports what it actually wrote.
 *
 * `skippedDestinationExists` is deliberately its own field, not folded into
 * `failed`. `failed` is this report's word for "the pass tried to write
 * something and threw" — a broken constraint, a full disk, a poisoned
 * commit. A destination already occupied on disk is not that: it is
 * `applyMove` correctly declining to overwrite a file that is already there,
 * which is exactly the safe outcome `destinationOccupied` exists to produce.
 * This report is what an operator reads in the boot log to learn what the
 * pass did; counting a correct refusal as a failure sends them hunting a bug
 * that does not exist. Do not fold this back into `failed`.
 */
export interface RekeyReport {
  moved: number;
  renamed: number;
  merged: number;
  skippedEdited: number;
  skippedUnparsable: number;
  skippedCollision: number;
  skippedDestinationExists: number;
  failed: number;
}

/**
 * The write half of the re-key pass. Calls `planRekey` itself, on the same
 * `db` it is about to write to, rather than taking proposals as an argument
 * — so the plan it acts on is always read from the database's current state,
 * never a stale snapshot a caller happened to be holding.
 *
 * Every `move` and every `merge` is applied in its own transaction, never one
 * for the whole pass: a single poison row (a broken constraint, a full disk,
 * anything that makes one group's write throw) must not roll back the other
 * groups that were already correct. A group whose write throws is counted in
 * `failed` and left exactly as it was; the loop moves on to the next
 * proposal. This is the one property Step 5 breaks on purpose to prove — see
 * the task report.
 */
export async function applyRekey(
  db: DatabaseSync,
  registry: PluginRegistry,
  deps: RekeyDeps,
): Promise<RekeyReport> {
  const proposals = planRekey(db, registry);

  const report: RekeyReport = {
    moved: 0,
    renamed: 0,
    merged: 0,
    skippedEdited: 0,
    skippedUnparsable: 0,
    skippedCollision: 0,
    skippedDestinationExists: 0,
    failed: 0,
  };

  for (const { groupId, outcome } of proposals) {
    switch (outcome.kind) {
      case 'unchanged':
        // Nothing to write — the row already agrees with the parser. Proved
        // by a sentinel in the test, not by re-reading the (already equal)
        // identity columns: a write here would be invisible to an equality
        // check but not to a value the writer would have clobbered.
        break;

      case 'skipped-edited':
        report.skippedEdited++;
        break;

      case 'skipped-unparsable':
        report.skippedUnparsable++;
        break;

      case 'skipped-collision':
        report.skippedCollision++;
        break;

      case 'merge': {
        // The one outcome in this pass that deletes a row, so what makes it
        // safe is worth stating where it happens rather than only where it is
        // decided. `planRekey` proposes this only for a single mover against a
        // single, uncontested holder whose `groupHistory` answered null — no
        // downloads, no imported files live or trashed — which is the whole of
        // the argument: the mover's releases are the only thing merging can
        // move, and a group with nothing on disk and nothing on record can be
        // reconstructed by re-ingesting the same feed items.
        //
        // The mover folds into the holder, never the reverse. Nothing else is
        // available: the holder is the group that already occupies the slot,
        // so merging the other way would additionally have to re-key the
        // survivor into the freed slot, which is a different and larger
        // operation than the one `mergeGroupInto` performs.
        try {
          const merged = inTransaction(db, () => {
            // Asked a second time, inside the transaction that does the
            // delete, and deliberately: this is not the redundant check it
            // looks like and should not be removed as one.
            //
            // `planRekey` read this at plan time, and today nothing can
            // falsify it in between — the pass runs at startup before the
            // server listens, and nothing in this loop creates a download or
            // an imported file. But `applyRekey` is exported, and this is the
            // only path in the system that deletes a group without a human
            // asking. The first caller that runs it against a live server —
            // a "run the pass now" control, say — makes the plan a snapshot
            // that an in-flight import can outrun, and the plan-time answer
            // stops being a fact about now.
            //
            // The foreign keys do protect the file: a delete under a
            // `downloads` or `imported_files` row is refused outright. But
            // they refuse it as a throw counted in `failed`, which reads as
            // "something broke" and says nothing about what. Re-asking turns
            // the same protection into the answer it should have had —
            // `skipped-collision`, the outcome for exactly this shape.
            const history = groupHistory(db, groupId);
            if (history !== null) return false;

            const target = getGroup(db, outcome.intoGroupId);
            if (target === null) {
              // Unreachable: a holder is stationary by construction, and
              // nothing in this loop deletes a stationary group. Thrown into
              // the same `failed` count as any other broken merge rather than
              // asserted, because the alternative to counting it is a pass
              // that stops.
              throw new Error(`group ${outcome.intoGroupId} vanished before group ${groupId} could merge into it`);
            }
            mergeGroupInto(db, { id: groupId }, target, deps.now(), {
              // A pass is not a human. `mergeGroupInto`'s own comment carries
              // the full reasoning; the short of it is that `edited_at` is
              // what tells the *next* run of this pass to leave a row alone.
              stampEdited: false,
            });
            return true;
          });
          if (merged) report.merged++;
          else report.skippedCollision++;
        } catch {
          // As in `move` below (via `applyMove`): the transaction has already
          // rolled the whole merge back, so both groups are left exactly as
          // they were — the releases still on the mover, the mover still
          // present.
          report.failed++;
        }
        break;
      }

      case 'move': {
        try {
          const renamedCount = await applyMove(db, groupId, outcome, deps);
          if (renamedCount === null) {
            // A destination `computeRenames` planned is already occupied on
            // disk. Refused before a single row was written or a single file
            // touched, so the group is left exactly where `planRekey` found
            // it. Counted separately from `failed`, deliberately: nothing
            // threw here, and nothing went wrong — `destinationOccupied`
            // caught exactly the collision it exists to catch, and did the
            // safe thing. Folding this into `failed` would read, in the boot
            // log this report feeds, as a bug to go hunting for; it is not
            // one. See `RekeyReport.skippedDestinationExists`.
            report.skippedDestinationExists++;
          } else {
            report.moved++;
            report.renamed += renamedCount;
          }
        } catch {
          // `applyMove` has already rolled back its transaction and, if any
          // renames had already landed, reversed them on disk — so the group
          // is left exactly as it was. The catch here, rather than one
          // around the whole loop, is what lets the next proposal still be
          // applied.
          report.failed++;
        }
        break;
      }
    }
  }

  return report;
}

/**
 * The write half of a `move` outcome: the identity row, the metadata clear it
 * conditionally implies, and every live file's `dest_path`, together with the
 * renames on disk those new paths promise. Order is the whole of the safety
 * argument the module comment on `applyRekey` refers to — the transaction
 * opens, the row and every `dest_path` are written, the renames run *inside*
 * that still-open transaction, and only then does it commit:
 *
 *   1. `BEGIN`
 *   2. write `identity_key`/`display`/`search_text` and every new `dest_path`
 *   3. `await rename(...)` each live file
 *   4. `COMMIT`
 *
 * Committing before the renames would leave the database pointing at a path
 * nothing has been moved to yet — and both `findLiveByDest`
 * (`pipeline/import.ts`) and `trashLiveFiles` (`pipeline/upgrade.ts`) trust
 * `dest_path` to name a real file. Doing the disk work inside the still-open
 * transaction instead means a failure in either direction has something to
 * undo: a rename that throws still has an open transaction to roll back, and
 * a commit that throws still has real files sitting at their new paths that
 * can be renamed back.
 *
 * That "renamed back" is only safe because of what `renames` is restricted to
 * in practice: `{titledots}` is the only placeholder this pass ever changes
 * (a key move never touches the `{sitename}` segment, which is the only path
 * *segment* the default template has — see `path-template.ts`), so every
 * entry in `renames` moves a file within one directory. A same-directory
 * rename is a single filesystem operation with no window in which the file
 * exists at neither name, which is what makes "call `rename` again with the
 * arguments swapped" a complete undo rather than a best-effort guess at one.
 *
 * Returns the number of files renamed on success, or `null` if the group was
 * refused because a computed destination was already occupied — refused
 * ahead of the transaction, so nothing about the group is written at all.
 *
 * Exported so a test can drive the same-path defensive guard directly with a
 * hand-built `outcome`, independent of whether `computeRenames` currently
 * produces one — see the guard's own comment for why that independence
 * matters. `applyRekey` is still the only real caller.
 */
export async function applyMove(
  db: DatabaseSync,
  groupId: number,
  outcome: Extract<RekeyOutcome, { kind: 'move' }>,
  deps: RekeyDeps,
): Promise<number | null> {
  // Defensive, not load-bearing: `computeRenames` no longer emits an entry
  // whose `to` equals its own `from` (see its doc comment), so this should
  // always be a no-op filter. It stays here anyway, because the alternative
  // is trusting every future caller of `applyMove` to route through a
  // planner that gets this right — and the cost of being wrong is the bug
  // this guards: a file compared against its own current path reads as
  // "occupied" and aborts a group that isn't actually colliding with
  // anything.
  const renames = outcome.renames.filter((move) => move.from !== move.to);

  // `rename(2)` silently replaces an existing destination on POSIX; this
  // check, done before anything is written, is the only thing standing
  // between the pass and destroying a file that already lives at a path
  // `computeRenames` planned to. A collision costs the group nothing more
  // than staying where it was.
  for (const move of renames) {
    if (await destinationOccupied(move.to)) return null;
  }

  db.exec('BEGIN');
  try {
    updateGroupIdentity(db, {
      id: groupId,
      identityKey: outcome.identityKey,
      // `PreparedIdentity.displayJson` is what this column is filled
      // from; `display` is only what the column itself is called —
      // see `interfaces.md`, which exists because this exact name
      // mismatch cost a prior implementer a debugging round.
      display: outcome.displayJson,
      searchText: outcome.searchText,
    });
    // Only when the question a metadata lookup would ask has actually
    // changed — `manual/operations.ts`'s `questionChanged` reasoning,
    // reapplied here: `sceneMetadataQuery` builds its query from the
    // display, so a slug-only move (the mirror of case 7: key changed but
    // display did not) asks the provider the same question it already
    // answered, and the cached answer is still good. Deliberately never
    // touches `edited_at`: that column marks a row a human corrected by
    // hand, so a future pass knows not to overwrite it
    // (`migrations.ts:268-272`). This pass is not a human, and stamping it
    // would immunise every group it re-keys against the next run.
    if (outcome.displayChanged) clearGroupMetadata(db, groupId);
    for (const move of renames) updateDestPath(db, move.fileId, move.to);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const renamedSoFar: { from: string; to: string }[] = [];
  try {
    for (const move of renames) {
      await deps.rename(move.from, move.to);
      renamedSoFar.push(move);
    }
  } catch (error) {
    db.exec('ROLLBACK');
    for (const move of renamedSoFar.toReversed()) await deps.rename(move.to, move.from);
    throw error;
  }

  try {
    deps.commit(db);
  } catch (error) {
    db.exec('ROLLBACK');
    for (const move of renames.toReversed()) await deps.rename(move.to, move.from);
    throw error;
  }

  return renames.length;
}

/**
 * Whether something already sits at `path`, tolerating exactly the one error
 * that answers the question ("nothing is there") and rethrowing everything
 * else. A permissions error or similar is not evidence the pass may proceed —
 * it is evidence the pass cannot tell, and guessing "empty" in that case risks
 * the one outcome `applyMove` calls this to prevent: `rename(2)` overwriting a
 * file that was there all along.
 */
async function destinationOccupied(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * The `app_state` key this pass's completion marker lives under — see
 * `app-state.ts`'s own doc comment for why a generic key-value table is the
 * right home for it (a pass marker, not user data) and
 * `docs/superpowers/specs/2026-08-14-rekey-scene-slugs-design.md` for why the
 * pass needs one at all: it runs the live parser rather than a fixed schema
 * change, so it has no place in `schema_migrations`.
 *
 * The write pass this key gates is deliberately never re-run automatically
 * (see `runRekeyOnBoot`'s own comment): once set, every later boot only
 * drift-checks. That means a group left in `failed` or
 * `skippedDestinationExists` by the one boot that ran the write pass is never
 * retried by anything in this codebase — recovery is manual. To force the
 * write pass to run again (for example after fixing whatever made a group
 * fail), delete this key's row from `app_state`:
 *
 *   DELETE FROM app_state WHERE key = 'pass:rekey-scene-slugs';
 *
 * The next boot then re-runs `runRekeyOnBoot` from the top exactly as it
 * would after an interrupted first run (see that function's comment on why
 * this converges): every already-correct group reads as `unchanged`, and
 * only whatever is genuinely still outstanding is retried.
 */
export const REKEY_MARKER_KEY = 'pass:rekey-scene-slugs';

/**
 * How many groups a fresh `planRekey` would still act on — every proposal
 * whose outcome is `move`, `merge`, `skipped-collision`,
 * `skipped-unparsable`, or (once `applyRekey` runs) `skipped-destination-
 * exists`: stored state genuinely disagreeing with what the parser says
 * today, whether the pass itself can resolve that disagreement or a human
 * has to. Pure and read-only, like `planRekey` itself: no write, no
 * filesystem access, nothing gated on whether the marker is set. Measured at
 * ~120ms cold over 1222 groups on the owner's real database (Task 7) and
 * growing linearly with the library — already over the plan's own "~100ms,
 * say so" line, so this is deliberately left as a single `planRekey` call
 * rather than optimised here.
 *
 * `skipped-edited` is the one non-`unchanged` outcome deliberately excluded.
 * It is not a disagreement to flag — it is a recorded human decision
 * (`migrations.ts:268-272`) that the pass skips forever, on purpose. Counting
 * it would give this number a permanent floor: on the owner's database, 33
 * groups would report "diverging" at every single boot, for eternity, with
 * nothing that could ever act on them. A count that can never reach zero is
 * one a reader learns to ignore, which defeats the reason this function
 * exists. Do not add it back to the sum.
 *
 * Never call this a second time in a boot that already ran `applyRekey`:
 * that would re-parse every raw title for an answer `applyRekey`'s own
 * report already carries. `runRekeyOnBoot` below derives its drift count
 * from the report in that case instead of calling this function.
 */
export function countDrift(db: DatabaseSync, registry: PluginRegistry): number {
  return planRekey(db, registry).filter(
    (proposal) => proposal.outcome.kind !== 'unchanged' && proposal.outcome.kind !== 'skipped-edited',
  ).length;
}

/** What one boot's worth of `runRekeyOnBoot` did — see that function. */
export interface RekeyBootOutcome {
  /** True on the one boot that actually writes: the marker was unset. */
  applied: boolean;
  /** `applyRekey`'s own tally, present only when `applied` is true. */
  report: RekeyReport | null;
  /**
   * Groups not agreeing with a fresh parse, as of this check — same
   * definition as `countDrift`'s, `skipped-edited` excluded for the same
   * reason (see that function's comment). When `applied` is true this is
   * read off `report` instead of a second `countDrift` call, so that running
   * the pass and then drift-checking it does not parse every title twice
   * (see `countDrift`'s own comment) — `moved` and `merged` are excluded from
   * that sum because they are exactly the groups this boot just brought into
   * agreement, and `failed` is included because a group counted there still
   * disagrees, which together make the sum equal what a post-apply
   * `countDrift` call would return (see `runRekeyOnBoot`'s comment on the
   * sum itself). When `applied` is false, this is `countDrift`'s answer
   * directly.
   */
  drift: number;
}

/**
 * The Task 6 entry point: run the write pass exactly once, ever, then settle
 * into an every-boot read-only drift check. Gated on `REKEY_MARKER_KEY`
 * rather than on whether anything is actually left to do, so the *decision*
 * to stop writing survives independently of the data — the alternative
 * (write until `planRekey` returns nothing but `unchanged`) would run the
 * write pass again on every boot for as long as even one group is
 * permanently stationary by design (`skipped-edited`, `skipped-collision`),
 * which is forever.
 *
 * Takes `deps` and returns its outcome rather than logging anything itself;
 * `main.ts`'s `runRekeyAtBoot` owns the log line and the try/catch that keeps
 * a throw here from blocking startup.
 */
export async function runRekeyOnBoot(
  db: DatabaseSync,
  registry: PluginRegistry,
  deps: RekeyDeps,
): Promise<RekeyBootOutcome> {
  if (getAppState(db, REKEY_MARKER_KEY) !== null) {
    return { applied: false, report: null, drift: countDrift(db, registry) };
  }

  const report = await applyRekey(db, registry, deps);

  // Written last, in its own transaction, deliberately — not "in the same
  // transaction as the final batch" (an earlier draft of this task's brief
  // said that, but there is no batch: `applyRekey`'s own module comment
  // explains why Task 4 commits one group at a time, on purpose, so a single
  // poison row cannot roll back the groups that already landed). Folding
  // this write into any one group's transaction would mean that group's
  // identity, and only that group's, decides whether the whole pass is ever
  // considered "done" — an arbitrary coupling with no basis in the design.
  //
  // Safe to write separately because the pass converges: if this line is
  // never reached (a throw from `applyRekey` itself, or the process dying
  // between the last group's commit and here), the marker stays unset and
  // the next boot simply re-runs `runRekeyOnBoot` from the top. `planRekey`
  // then reads every already-moved group as `unchanged` — the identity
  // columns are already right — so that boot's `applyRekey` call only
  // touches whatever is genuinely still outstanding, and this line runs
  // again. Task 7 is the evidence for "converges": it asserts the pass
  // proposes nothing against an already-converged copy of the owner's real
  // database.
  setAppState(db, REKEY_MARKER_KEY, 'done', deps.now());

  // `RekeyBootOutcome.drift` documents "groups not agreeing with a fresh
  // parse, as of this check" — a state, not an activity log. `moved` and
  // `merged` are exactly the groups this boot just brought into agreement,
  // so they do not belong in that state: including them would make the one
  // boot that repairs everything report the largest "still not agreeing"
  // number it will ever produce. `skippedEdited` stays excluded, per
  // `countDrift`'s comment, as a recorded human decision rather than a
  // disagreement. `failed` is included, unlike in an earlier draft of this
  // sum: a group counted there did not get repaired — its stored identity
  // still disagrees with a fresh parse — and on this path `failed` is this
  // boot's own apply-time counter, not a plan-time bucket, so adding it here
  // double-counts nothing. This makes the sum equal what a post-apply
  // `countDrift` call would return; see `rekey.test.ts` for the pin.
  const drift =
    report.skippedUnparsable +
    report.skippedCollision +
    report.skippedDestinationExists +
    report.failed;

  return { applied: true, report, drift };
}
