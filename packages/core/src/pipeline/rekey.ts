import { basename, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DownloadedFile,
  ImportPlan,
  MediaTypePlugin,
  ParsedRelease,
  QualityTokens,
} from '@pickarr/plugin-api';
import { getDownload } from '../db/downloads.ts';
import { groupHistory } from '../db/groups.ts';
import { getRelease } from '../db/releases.ts';
import { knownSiteNames } from '../db/sites.ts';
import { maybeNum, maybeStr, num, str, type SqlRow } from '../db/row.ts';
import { validateIdentity, type PreparedIdentity } from '../ingest/commit.ts';
import type { PluginRegistry } from '../plugins/registry.ts';

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

    renames.push({ fileId, from: destPath, to: resolve(libraryRoot, planned.destination) });
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
