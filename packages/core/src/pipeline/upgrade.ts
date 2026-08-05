import { copyFile, mkdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { liveFilesForGroup, markTrashed } from '../db/imported-files.ts';
import { isContained, lstatOrNull } from './import.ts';

/**
 * Moves a group's live imported files into the trash directory — every one of
 * them *except* those `importingDownloadId` itself recorded.
 *
 * That exclusion is what makes this operation safe to repeat. An import is
 * retried whenever it is interrupted between its transfer loop and its final
 * status write (a crash plus boot recovery, an operator retry), and on the
 * second pass the rows the first pass inserted are indistinguishable, to a
 * plain "live files of this group" query, from the rows of the old release
 * being superseded. Trashing them moves this download's freshly imported files
 * out of the library and leaves the transfer loop with nothing to re-place —
 * the group ends up claiming a release whose files are all in trash. Scoping
 * the query to *other* downloads' rows states the real rule: an upgrade
 * supersedes what came before it, never its own output. No generation counter
 * is needed because a download's id already is one.
 *
 * Trash-first ordering is required by the caller because the replacement
 * usually wants the same destination path as the file it supersedes: the old
 * file has to move out of the way before anything new can be written there.
 *
 * Trash paths are `<trashDir>/<groupId>/<now>/<path-relative-to-the-library-
 * root>` — the file's own path *inside the library*, replayed inside the
 * timestamped trash directory, intermediate directories created as needed.
 * This is collision-free by construction, not by convention: two distinct
 * files can only collide here if they had the same path relative to the
 * library root, which means they were the same destination path, which means
 * they were the same file. A flat `basename(destPath)` scheme (an earlier
 * version of this function used one) does not have this property —
 * `library/A/scene.mp4` and `library/B/scene.mp4` both reduce to `scene.mp4`
 * and one would silently overwrite the other in trash, with `imported_files`
 * left recording an inaccurate `trash_path` for whichever lost the race. This
 * scheme cannot do that: `relative(libraryRootReal, real)` is unique per real
 * path within one library root, by definition of what "relative path" means.
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
 *     by hand. The row is still marked trashed (there is nothing live left to
 *     protect), but with a *null* `trash_path` — we do not know where the
 *     file actually went (if anywhere), so recording this attempt's would-be
 *     path would tell an operator to look in a specific place the file was
 *     never at. A null is an honest "unknown; search `trashDir`", which is
 *     strictly more useful than a specific, possibly wrong answer.
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
 * Refusing a row throws rather than skipping it silently: silently leaving an
 * unexpected occupant in place would let the transfer loop's own collision
 * check catch it moments later with a much less specific error, or — worse —
 * could be adopted there if a future change ever weakened that check. Failing
 * here, by name, is strictly safer. A throw here can happen *after* earlier
 * rows in the same call already moved successfully — in that case the thrown
 * message still names `destinationDir`, so a caller's failure report never
 * omits the one fact that matters: some of this group's files really did
 * move, and this is where.
 *
 * Returns the directory used, or null when the group had nothing live to
 * trash (the initial-import case, and the benign retry-of-a-failed-initial-
 * pick case — see the Task 14 report).
 */
export async function trashLiveFiles(
  db: DatabaseSync,
  groupId: number,
  importingDownloadId: number,
  libraryRootReal: string,
  trashDir: string,
  now: number,
): Promise<string | null> {
  const live = liveFilesForGroup(db, groupId, importingDownloadId);
  if (live.length === 0) return null;

  const destinationDir = join(trashDir, String(groupId), String(now));
  await mkdir(destinationDir, { recursive: true });

  try {
    for (const file of live) {
      const occupant = await lstatOrNull(file.destPath);

      if (occupant === null) {
        // Already gone from disk (a prior, interrupted upgrade already moved
        // it, or an operator removed it by hand): nothing to move, and — not
        // having moved it ourselves — nowhere honest to point `trash_path`
        // at. The row no longer describes a live file either way, so it is
        // still marked trashed, just with no invented location.
        markTrashed(db, file.id, null, now);
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

      const trashPath = join(destinationDir, relative(libraryRootReal, real));
      await mkdir(dirname(trashPath), { recursive: true });

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
  } catch (error) {
    // Some earlier row in this same call may already have been moved
    // successfully before this one was refused or failed. The caller's own
    // failure message (see import.ts) only gets to append this directory
    // when trashing as a whole reports success — so if trashing itself is
    // what's throwing, this is the one place left that can still say where
    // any already-moved files ended up.
    throw new Error(
      `${(error as Error).message} — files already trashed for this group moved to ${destinationDir}`,
    );
  }

  return destinationDir;
}
