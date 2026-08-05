import { copyFile, mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { liveFilesForGroup, markTrashed } from '../db/imported-files.ts';
import { isContained, lstatOrNull } from './import.ts';

/**
 * Moves a group's live imported files into the trash directory.
 *
 * Trash-first ordering is required by the caller because the replacement
 * usually wants the same destination path as the file it supersedes: the old
 * file has to move out of the way before anything new can be written there.
 * Trash paths are namespaced `<trashDir>/<groupId>/<now>/<basename>` so
 * repeated upgrades of the same group cannot collide with each other.
 *
 * `imported_files` rows are the *only* record of what Pickarr wrote — this
 * function is the one place that turns a row into a filesystem move, so it
 * carries the same discipline `import.ts` established for writes: a row
 * proves what Pickarr *intended*, never what is actually sitting at that
 * path. Every row is re-verified against the real filesystem, right here,
 * before anything is touched:
 *
 *   - `lstat` (never `stat`) decides what occupies `destPath`, so a symlink
 *     is judged as a symlink, never silently followed to whatever it targets.
 *   - Nothing at `destPath` at all is not an error: a previous, interrupted
 *     attempt may have already moved it, or an operator may have removed it
 *     by hand. The row is still marked trashed (there is nothing live left
 *     to protect), but no filesystem operation is attempted.
 *   - Only a plain regular file is ever moved. A directory or a symlink at
 *     `destPath` is refused outright — this is what makes the operation
 *     bounded no matter how a row got here: even a row corrupted by an old
 *     bug (for instance, one that once recorded the library root itself as a
 *     file's `destPath`, a real historical case in this codebase) can never
 *     turn into a `rename` of an entire directory tree. The blast radius of
 *     any single row is at most one file.
 *   - The regular file's *real*, symlink-resolved path is required to sit
 *     inside `libraryRootReal` — the same real-path containment test
 *     `import.ts` applies before writing. A row that (through an old bug, or
 *     an ancestor directory that became a symlink since the row was written)
 *     now points outside the library it claims to belong to is refused
 *     rather than moved.
 *
 * Refusing a row throws rather than skipping it silently: silently leaving
 * an unexpected occupant in place would let the transfer loop's own
 * collision check catch it moments later with a much less specific error, or
 * — worse — could be adopted there if a future change ever weakened that
 * check. Failing here, by name, is strictly safer.
 *
 * Returns the directory used, or null when the group had nothing live to
 * trash (the initial-import case).
 */
export async function trashLiveFiles(
  db: DatabaseSync,
  groupId: number,
  libraryRootReal: string,
  trashDir: string,
  now: number,
): Promise<string | null> {
  const live = liveFilesForGroup(db, groupId);
  if (live.length === 0) return null;

  const destinationDir = join(trashDir, String(groupId), String(now));
  await mkdir(destinationDir, { recursive: true });

  for (const file of live) {
    const trashPath = join(destinationDir, basename(file.destPath));
    const occupant = await lstatOrNull(file.destPath);

    if (occupant === null) {
      // Already gone from disk (a prior, interrupted upgrade already moved
      // it, or an operator removed it by hand): nothing to move, but the row
      // no longer describes a live file either way.
      markTrashed(db, file.id, trashPath, now);
      continue;
    }

    if (!occupant.isFile()) {
      throw new Error(
        `imported_files row ${file.id} for group ${groupId} points at ${file.destPath}, ` +
          'which is not a regular file — refusing to trash a directory or symlink',
      );
    }

    const real = await realpath(file.destPath);
    if (!isContained(libraryRootReal, real, false)) {
      throw new Error(
        `imported_files row ${file.id} for group ${groupId} resolves outside the library ` +
          `root (${file.destPath} -> ${real}) — refusing to trash it`,
      );
    }

    try {
      await rename(file.destPath, trashPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV') throw error;
      await copyFile(file.destPath, trashPath);
      await unlink(file.destPath);
    }
    markTrashed(db, file.id, trashPath, now);
  }

  return destinationDir;
}
