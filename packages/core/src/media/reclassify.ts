import { readFile } from 'node:fs/promises';
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
 * Async throughout, on purpose, even though a one-shot CLI would tolerate a
 * synchronous read: this lives in `@pickarr/core` rather than `scripts/`
 * precisely so it can be called from the running service later (a manual
 * "reclassify now" action, say), and a blocking `readFileSync` here would
 * stall whatever else shares that process's event loop — the same reasoning
 * `fetchImage`/`writeImage` already follow in `artwork.ts`.
 */
export interface ReclassifyDeps {
  readonly db: DatabaseSync;
  /** The artwork directory a path like `1.jpg` is resolved against. */
  readonly dir: string;
  /** Report what would move and write nothing. */
  readonly dryRun: boolean;
  readonly log: (message: string) => void;
}

export interface ReclassifyResult {
  /** Cached files measured — one per populated `poster_path`/`background_path`. */
  examined: number;
  /** A mismatching slot relocated to its empty opposite (or swapped with it). */
  moved: number;
  /**
   * A mismatching slot discarded rather than moved, because its destination
   * already held an image. Reported separately from `moved` so an operator
   * can tell "a misfiling was corrected" from "an image was thrown away" —
   * the two are very different outcomes to have applied to a library.
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
 */
async function planRow(
  deps: Pick<ReclassifyDeps, 'dir' | 'log'>,
  row: ArtworkRow,
): Promise<{ result: ReclassifyResult; next: ArtworkRow }> {
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
  if (posterMismatch && backgroundMismatch) {
    next = {
      groupId: row.groupId,
      posterUrl: row.backgroundUrl,
      posterPath: row.backgroundPath,
      backgroundUrl: row.posterUrl,
      backgroundPath: row.posterPath,
    };
    result.moved += 2;
    deps.log(`reclassify: group ${row.groupId}: poster and background were swapped, corrected`);
  } else if (posterMismatch) {
    const backgroundOccupied = row.backgroundUrl !== null || row.backgroundPath !== null;
    if (backgroundOccupied) {
      next = { ...row, posterUrl: null, posterPath: null };
      result.cleared += 1;
      deps.log(
        `reclassify: group ${row.groupId}: poster ${row.posterPath ?? ''} measures as a background ` +
          'but the background slot is already filled, cleared rather than moved',
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
      deps.log(`reclassify: group ${row.groupId}: poster ${row.posterPath ?? ''} measures as a background, moved`);
    }
  } else if (backgroundMismatch) {
    const posterOccupied = row.posterUrl !== null || row.posterPath !== null;
    if (posterOccupied) {
      next = { ...row, backgroundUrl: null, backgroundPath: null };
      result.cleared += 1;
      deps.log(
        `reclassify: group ${row.groupId}: background ${row.backgroundPath ?? ''} measures as a poster ` +
          'but the poster slot is already filled, cleared rather than moved',
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
      deps.log(`reclassify: group ${row.groupId}: background ${row.backgroundPath ?? ''} measures as a poster, moved`);
    }
  }

  return { result, next };
}

export async function reclassifyArtwork(deps: ReclassifyDeps): Promise<ReclassifyResult> {
  const totals: ReclassifyResult = { examined: 0, moved: 0, cleared: 0, unreadable: 0 };
  const rows = rowsWithArtwork(deps.db);

  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- one cached file at a time; a one-shot backfill, not a hot path
    const { result, next } = await planRow(deps, row);
    totals.examined += result.examined;
    totals.moved += result.moved;
    totals.cleared += result.cleared;
    totals.unreadable += result.unreadable;

    // `--dry-run` must change nothing at all, including the database: this is
    // the one write in the whole function, and it is skipped outright rather
    // than computed-and-discarded, so a caller auditing "does dry-run ever
    // call db.prepare" need not trust a flag threaded further down. A clear
    // writes just as a move does — both change the row from what `rows`
    // already read — so both gate the same write.
    if (!deps.dryRun && (result.moved > 0 || result.cleared > 0)) {
      setArtworkPair(deps.db, row.groupId, next);
    }
  }

  return totals;
}
