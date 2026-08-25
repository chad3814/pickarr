import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { rowsWithArtwork, setArtworkPair, type ArtworkRow } from '../db/metadata.ts';
import { classifyArtwork, type ArtworkKind } from './classify.ts';

/**
 * Corrects rows migration 15 could not.
 *
 * That migration classifies by URL, because a migration gets a database and
 * nothing else — no `artworkDir`, no way to open a file, only SQL. It sorts
 * the clear cases and deliberately leaves the ambiguous remainder filed as
 * posters: the studio-CDN images whose shape nothing in the payload records.
 * Of the three such rows in the real library, one is a background and one is
 * a poster — a URL rule would have misfiled one of the only two anyone could
 * verify, so migration 15 declines to guess and this is what finishes the job
 * instead, by measuring the file already cached on disk.
 *
 * Offline: no network request, no API key, nothing but `classifyArtwork`
 * (from `image-size`) run against bytes already on the local filesystem. Safe
 * to run any number of times — a row that already agrees with its own column
 * is left untouched, so a second pass over a clean library moves nothing.
 *
 * Not read-only, though. It writes rows, and on the one path that discards an
 * image rather than relocating it (see `ReclassifyResult.cleared`) it usually
 * deletes that image's file from `dir` — not always, because a discarded image
 * that is the row's only readable one is kept instead. Nothing else on disk is
 * touched.
 *
 * Async throughout, on purpose, even though a one-shot CLI would tolerate a
 * synchronous read: this lives in `@pickarr/core` rather than `scripts/`
 * precisely so it can be called from the running service later (a manual
 * "reclassify now" action, say), and a blocking `readFileSync` here would
 * stall whatever else shares that process's event loop — the same reasoning
 * `fetchImage`/`writeImage` already follow in `artwork.ts`.
 */
export interface ReclassifyDeps {
  readonly db: DatabaseSync;
  /**
   * The artwork directory a path like `1.jpg` is resolved against — for
   * reading, and for the one case that deletes a file (see `cleared`).
   */
  readonly dir: string;
  /** Report what would move and change nothing, in the database or on disk. */
  readonly dryRun: boolean;
  readonly log: (message: string) => void;
  /**
   * Injectable for tests, as `reconcile.ts`'s is and for the same reason:
   * making a real unlink fail is a `chmod` game that a root-owned container
   * defeats, and the "one file would not delete, keep going" path is worth
   * pinning deterministically. Defaults to the real `node:fs/promises` `rm`.
   */
  readonly rm?: (path: string, options: { force: boolean }) => Promise<void>;
}

export interface ReclassifyResult {
  /** Cached files measured — one per populated `poster_path`/`background_path`. */
  examined: number;
  /** A mismatching slot relocated to its empty opposite (or swapped with it). */
  moved: number;
  /**
   * A mismatching slot discarded rather than moved, because its destination
   * was already occupied. The column is always nulled; the cached file
   * underneath it is *usually* deleted from `dir` too, so the image is thrown
   * away rather than merely dereferenced — an artwork directory that silently
   * accumulates files no row names is one nobody can afterwards tell from a
   * directory of live images.
   *
   * Usually, not always: a clear whose surviving slot has no usable image of
   * its own keeps the file, because deleting it would leave the row with no
   * readable image at all. See `planRow`. So this is a count of clears, not a
   * count of deletions, and the two can differ — `clearedFileFateLine` reports
   * per row which of the three fates that row got.
   *
   * Reported separately from `moved` so an operator can tell "a misfiling was
   * corrected" from "an image was discarded" — the two are very different
   * outcomes to have applied to a library.
   */
  cleared: number;
  /** Could not be measured: missing file, unreadable bytes, or an unrecognised format. */
  unreadable: number;
}

/**
 * Reads a cached file's bytes, or `null` if it cannot be read.
 *
 * A missing file and a corrupt one are both "unreadable" as far as this tool
 * is concerned — neither can be measured, and neither is a reason to move a
 * row on the strength of a guess. Only `classifyArtwork` distinguishes an
 * image it can measure from one it cannot; this distinguishes "reached
 * `classifyArtwork` at all" from "the disk had nothing to offer it".
 */
async function readCached(dir: string, path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(join(dir, path));
  } catch {
    return null;
  }
}

/** What one populated slot measured to, or `null` if its file could not be read. */
async function measure(dir: string, path: string): Promise<ArtworkKind | null> {
  const bytes = await readCached(dir, path);
  return bytes === null ? null : classifyArtwork(bytes);
}

/** The slot a clear emptied, and what that leaves of the file it named. */
interface ClearedSlot {
  /** Which column was nulled. */
  slot: ArtworkKind;
  /** The cached file that column named, left unreferenced by `next`. */
  path: string | null;
  fate: ClearedFileFate;
}

/**
 * One row's examination: the tally, the pair to write, and the clear — if any —
 * that write leaves a file behind from.
 *
 * `cleared` is carried back out rather than acted on where it is decided, which
 * is the whole reason this shape exists. It keeps `planRow` a planner that
 * touches no state, and it keeps every effect — the database row and the file
 * alike — inside `reclassifyArtwork`, behind the single `--dry-run` gate that
 * function's own comment claims for itself. Unlinking inside `planRow` would put
 * a second, separately-gated side effect in the function documented as deciding
 * and not doing, and a reader auditing "what does --dry-run skip" would have two
 * places to check instead of one.
 */
/**
 * Which relocation a row needs, named rather than described, so the line that
 * reports it can be written once the write has actually happened.
 *
 * Same reasoning as `ClearedSlot`: `planRow` decides, `reclassifyArtwork`
 * reports. A move has no filesystem effect, but it does have a database one,
 * and `setArtworkPair` can throw — so a line printed from `planRow` would claim
 * a move that a failed write never made, and would claim it in the past tense
 * during a `--dry-run` that made no move at all.
 */
type Movement = 'swapped' | 'poster-to-background' | 'background-to-poster';

/**
 * How a move reads once it has happened, or would happen.
 *
 * Every movement takes the `dryRun` distinction, unlike `clearedFileFateLine`
 * where only the deletion does: a move's whole content is the change to the
 * row, so there is no part of it that is true either way.
 */
function movementLine(groupId: number, movement: Movement, dryRun: boolean): string {
  const prefix = `reclassify: group ${groupId}:`;
  switch (movement) {
    case 'swapped':
      return `${prefix} the two slots ${dryRun ? 'would be swapped' : 'are swapped'}`;
    case 'poster-to-background':
      return `${prefix} the poster ${dryRun ? 'would be moved' : 'is moved'} to the background slot`;
    case 'background-to-poster':
      return `${prefix} the background ${dryRun ? 'would be moved' : 'is moved'} to the poster slot`;
  }
}

interface RowPlan {
  result: ReclassifyResult;
  next: ArtworkRow;
  /** The clear this row reached, or `null` when it reached none. */
  cleared: ClearedSlot | null;
  /** The relocation this row reached, or `null` when it reached none. */
  movement: Movement | null;
}

/**
 * What becomes of the file a cleared slot leaves behind.
 *
 * `'kept-shared'` — the surviving slot names that same file, so it is not an
 * orphan at all and is still being served. Defence against a future writer or a
 * hand-edited database rather than a state this library produces: see `planRow`
 * for why nothing in it can currently write a row that way.
 * `'kept-sole-image'` — the surviving slot holds no image this run could
 * measure, so the cleared file is the only readable image the row has left and
 * deleting it would take the row's last one. `'deleted'` — everything else,
 * which is the ordinary case.
 *
 * Three cases and not two because an operator has to be able to tell the two
 * keeps apart: one leaves a file a row still names, the other leaves a genuine
 * orphan that wants looking at.
 */
type ClearedFileFate = 'deleted' | 'kept-shared' | 'kept-sole-image';

/**
 * Which of the three a clear reaches.
 *
 * `survivingUsable` is "the surviving slot holds an image that was successfully
 * measured as its own kind" — see `planRow` for why a slot can be occupied
 * without being usable, and for why a slot measured to the *wrong* kind cannot
 * reach here.
 */
function clearedFileFate(
  clearedPath: string | null,
  survivingPath: string | null,
  survivingUsable: boolean,
): ClearedFileFate {
  if (clearedPath === survivingPath) return 'kept-shared';
  return survivingUsable ? 'deleted' : 'kept-sole-image';
}

/**
 * The line reporting what a clear did to the row and to the file underneath it.
 *
 * Which of the three fates happened has to be in it, or an operator reading
 * "deleted" goes looking for a file that is still there — and one that is still
 * being served reads very differently from one nothing names any more.
 *
 * `planRow` cannot write this line, which is why it is a line and not a phrase
 * appended to one. That function runs before the `--dry-run` gate and before the
 * unlink, so at that point neither the clear nor the deletion has happened: the
 * same wording would be a false claim in a dry run and a premature one in a real
 * run, contradicted two lines later by the failure path. Called from
 * `reclassifyArtwork` instead, where the row has already been written and — for
 * `'deleted'` — the unlink has already returned.
 *
 * Only `'deleted'` needs the `dryRun` distinction. Both keeps are true in either
 * mode for the same reason: nothing was going to be deleted, so the file is
 * still there whether or not the run was allowed to touch anything. They are
 * deliberately unconditional, and should not be "fixed" into a conditional they
 * do not need.
 */
function clearedFileFateLine(groupId: number, cleared: ClearedSlot, dryRun: boolean): string {
  const slot = `the ${cleared.slot} slot ${dryRun ? 'would be cleared' : 'is cleared'}`;
  const file = cleared.path ?? '';
  switch (cleared.fate) {
    case 'kept-shared':
      return `reclassify: group ${groupId}: ${slot}, and ${file} kept, because the surviving slot names that file too`;
    case 'kept-sole-image':
      return `reclassify: group ${groupId}: ${slot}, and ${file} kept, because the surviving slot has no usable image of its own`;
    case 'deleted':
      return `reclassify: group ${groupId}: ${slot} and ${file} ${dryRun ? 'would be deleted' : 'deleted'}`;
  }
}

/**
 * Examines one row's populated slot(s) and returns both the tally and the
 * pair the row should hold afterward.
 *
 * A slot only ever counts as a mismatch when it was actually measured — a
 * slot whose file could not be read stays exactly where it is, because an
 * unreadable file is a reason to leave a row for a later run, never a reason
 * to move it on the strength of a failed measurement.
 *
 * When both slots are populated and both mismatch — a poster and a background
 * that were literally swapped — this swaps them directly rather than routing
 * each through the other's vacated slot, so the row never passes through an
 * intermediate state where one side is momentarily empty. The far more common
 * shape, a migration 15 leftover with only one slot filled, has no such
 * corner: the vacated slot was already empty, so "move" and "swap" agree.
 *
 * When only one slot mismatches, the destination is not assumed empty — it
 * can legitimately already hold a correct image, migration 15's studio-CDN
 * leftovers being exactly that case: filed as a poster, later given a real
 * background by the service. Moving the mismatching slot in regardless would
 * overwrite that correct image, so the destination is checked first (by
 * either column being non-null, since a row can hold a url with no cached
 * file yet). Occupied means the mismatching slot is cleared instead of moved
 * — nulled, not relocated — which is the same judgement spec §4.1 makes for
 * the synthesised crop: an image that cannot be correctly placed is not
 * stored under a name that misdescribes it.
 *
 * A cleared slot's file is usually deleted too, which is why `cleared` comes
 * back out of here. Nothing references that file once the column is nulled, and
 * the one thing worse than discarding an image is discarding it halfway —
 * leaving bytes in the artwork directory that no row names, indistinguishable
 * from the live ones, for a later reader to guess about. Nulling the column is
 * the decision; deleting the file is that decision carried out. The move and
 * swap branches orphan nothing, because every path they touch is still named by
 * one column or the other afterwards, so they return `null`.
 *
 * Usually, because "occupied" is deliberately wider than "holds a usable
 * image" — it is `url OR path`, since a row can hold a url with no cached file
 * yet — and the three states inside that gap are precisely the ones where the
 * destination has nothing readable: a url with `path` still NULL, a path whose
 * file is missing, a path whose file is unreadable or an unmeasurable format.
 * Clear the mismatching slot in any of those and its file is the only readable
 * image the row has, so it is kept as an orphan instead. That asymmetry is
 * deliberate: an orphan wastes disk and can be swept up later, a deleted sole
 * image is gone. It is also what this function's own rule above — an unreadable
 * file is never grounds to act on a failed measurement — already says about the
 * mismatching slot, applied to the destination as well.
 *
 * "Holds a usable image" is exactly `backgroundKind === 'background'` in the
 * poster branch and `posterKind === 'poster'` in the background branch, with no
 * third possibility to worry about: a destination that measured to the *wrong*
 * kind makes its own mismatch flag true, and a row with both flags true takes
 * the swap branch above and never reaches a clear at all. So inside a clear the
 * destination has either measured to its own kind or not measured at all.
 *
 * A row whose two columns name the *same* file is kept for a different reason:
 * the surviving slot goes on serving it, so it is not an orphan — clearing the
 * mismatching column is precisely what protects that image, and deleting it
 * would be the clear destroying what it set out to save. This is defence
 * against a future writer or a hand-edited database rather than a state the
 * library produces: `pipeline/metadata.ts` writes through `groupArtworkKey`, so
 * a group's two files are always `group-poster-N.ext` and
 * `group-background-N.ext`; migration 15 moves `poster_path` and nulls the
 * source; `setArtworkPair` only swaps or nulls. Cheap insurance against a loss
 * nothing could undo.
 */
async function planRow(
  deps: Pick<ReclassifyDeps, 'dir' | 'log'>,
  row: ArtworkRow,
): Promise<RowPlan> {
  const result: ReclassifyResult = { examined: 0, moved: 0, cleared: 0, unreadable: 0 };

  let posterKind: ArtworkKind | null = null;
  if (row.posterPath !== null) {
    result.examined += 1;
    // eslint-disable-next-line no-await-in-loop -- one row's own two files; nothing to batch this with
    posterKind = await measure(deps.dir, row.posterPath);
    if (posterKind === null) result.unreadable += 1;
  }

  let backgroundKind: ArtworkKind | null = null;
  if (row.backgroundPath !== null) {
    result.examined += 1;
    // eslint-disable-next-line no-await-in-loop -- one row's own two files; nothing to batch this with
    backgroundKind = await measure(deps.dir, row.backgroundPath);
    if (backgroundKind === null) result.unreadable += 1;
  }

  const posterMismatch = posterKind !== null && posterKind !== 'poster';
  const backgroundMismatch = backgroundKind !== null && backgroundKind !== 'background';

  let next: ArtworkRow = row;
  let cleared: ClearedSlot | null = null;
  let movement: Movement | null = null;
  if (posterMismatch && backgroundMismatch) {
    next = {
      groupId: row.groupId,
      posterUrl: row.backgroundUrl,
      posterPath: row.backgroundPath,
      backgroundUrl: row.posterUrl,
      backgroundPath: row.posterPath,
    };
    result.moved += 2;
    movement = 'swapped';
    deps.log(
      `reclassify: group ${row.groupId}: the poster measures as a background and the background ` +
        'measures as a poster, so the two are each in the other\'s slot',
    );
  } else if (posterMismatch) {
    const backgroundOccupied = row.backgroundUrl !== null || row.backgroundPath !== null;
    if (backgroundOccupied) {
      next = { ...row, posterUrl: null, posterPath: null };
      result.cleared += 1;
      cleared = {
        slot: 'poster',
        path: row.posterPath,
        fate: clearedFileFate(row.posterPath, row.backgroundPath, backgroundKind === 'background'),
      };
      // The finding only. What becomes of the row and of the file is reported
      // from `reclassifyArtwork`, once it has happened — see
      // `clearedFileFateLine`.
      deps.log(
        `reclassify: group ${row.groupId}: poster ${row.posterPath ?? ''} measures as a background ` +
          'but the background slot is already filled, so it cannot be moved there',
      );
    } else {
      next = {
        groupId: row.groupId,
        posterUrl: null,
        posterPath: null,
        backgroundUrl: row.posterUrl,
        backgroundPath: row.posterPath,
      };
      result.moved += 1;
      movement = 'poster-to-background';
      deps.log(`reclassify: group ${row.groupId}: poster ${row.posterPath ?? ''} measures as a background`);
    }
  } else if (backgroundMismatch) {
    const posterOccupied = row.posterUrl !== null || row.posterPath !== null;
    if (posterOccupied) {
      next = { ...row, backgroundUrl: null, backgroundPath: null };
      result.cleared += 1;
      cleared = {
        slot: 'background',
        path: row.backgroundPath,
        fate: clearedFileFate(row.backgroundPath, row.posterPath, posterKind === 'poster'),
      };
      deps.log(
        `reclassify: group ${row.groupId}: background ${row.backgroundPath ?? ''} measures as a poster ` +
          'but the poster slot is already filled, so it cannot be moved there',
      );
    } else {
      next = {
        groupId: row.groupId,
        posterUrl: row.backgroundUrl,
        posterPath: row.backgroundPath,
        backgroundUrl: null,
        backgroundPath: null,
      };
      result.moved += 1;
      movement = 'background-to-poster';
      deps.log(`reclassify: group ${row.groupId}: background ${row.backgroundPath ?? ''} measures as a poster`);
    }
  }

  return { result, next, cleared, movement };
}

export async function reclassifyArtwork(deps: ReclassifyDeps): Promise<ReclassifyResult> {
  const totals: ReclassifyResult = { examined: 0, moved: 0, cleared: 0, unreadable: 0 };
  const rows = rowsWithArtwork(deps.db);
  const removeFile = deps.rm ?? rm;

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- one cached file at a time; a one-shot backfill, not a hot path
    const { result, next, cleared, movement } = await planRow(deps, row);
    totals.examined += result.examined;
    totals.moved += result.moved;
    totals.cleared += result.cleared;
    totals.unreadable += result.unreadable;

    // `--dry-run` must change nothing at all, database or filesystem: these are
    // the only two effects in the whole function, and they are skipped outright
    // rather than computed-and-discarded, so a caller auditing "does dry-run
    // ever call db.prepare, or rm" need not trust a flag threaded further down.
    // A clear writes just as a move does — both change the row from what `rows`
    // already read — so both gate the same write, and the unlink is inside the
    // same condition rather than beside it.
    if (deps.dryRun) {
      // Reporting is not an effect, so a dry run still says what it would have
      // done to a cleared row — in the conditional wording the summary uses, and
      // from here rather than from `planRow`, which cannot know the mode.
      if (movement !== null) deps.log(movementLine(row.groupId, movement, true));
      if (cleared !== null) deps.log(clearedFileFateLine(row.groupId, cleared, true));
    } else if (result.moved > 0 || result.cleared > 0) {
      setArtworkPair(deps.db, row.groupId, next);
      // After the write, for the reason `Movement` gives: a throw from
      // `setArtworkPair` must not leave a line behind saying the row moved.
      if (movement !== null) deps.log(movementLine(row.groupId, movement, false));

      // Database first, orphaned file second, and only once the write has
      // returned. If `setArtworkPair` throws, the file is still there and the
      // row still names it, so a re-run reaches the same decision and finishes
      // the job. Deleting first and writing second would leave a row naming a
      // file that is gone — nothing here can recover from that, and the poster
      // route would 404 for a group whose image was fine an instant earlier.
      if (cleared !== null) {
        const doomed = cleared.fate === 'deleted' ? cleared.path : null;
        if (doomed === null) {
          deps.log(clearedFileFateLine(row.groupId, cleared, false));
        } else {
          // `join` unlinks on the strength of a `group_metadata` column, so the
          // safety of this line rests on where those values come from, not on a
          // check here: every artwork path is written by `writeImage` under a
          // key this repo composes from integers of its own (`groupArtworkKey`),
          // never from provider text — the argument `artwork.ts`'s `cacheImage`
          // states for the write side, restated here because this is the module
          // that deletes. A `../`-bearing column value would escape `dir`, and
          // that is the reason nothing is allowed to put one there.
          // eslint-disable-next-line no-await-in-loop -- this row's own file, in a loop that is sequential by design
          const failure = await removeFile(join(deps.dir, doomed), { force: true }).then(
            () => null,
            (error: Error) => error.message,
          );
          // Said only now, and only on the branch where it is true: the fate was
          // decided in `planRow`, but this is where it either happened or did
          // not.
          if (failure === null) {
            deps.log(clearedFileFateLine(row.groupId, cleared, false));
          } else {
            // `force` already tolerates a file that is simply not there, so
            // reaching here means something else — a permission problem, most
            // likely. The row is correctly reclassified either way, so the run
            // continues: this is a leaked file, not a failed reclassification,
            // and the line says so in those terms rather than letting one
            // unwritable file abort a backfill over thousands of rows.
            deps.log(
              `reclassify: group ${row.groupId}: reclassified, but ${doomed} could not be ` +
                `deleted and is now unreferenced: ${failure}`,
            );
          }
        }
      }
    }
  }

  return totals;
}
