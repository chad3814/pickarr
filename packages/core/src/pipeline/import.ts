import { copyFile, lstat, mkdir, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadedFile, ParsedRelease } from '@pickarr/plugin-api';
import type { PluginRegistry } from '../plugins/registry.ts';
import { getGroup } from '../db/groups.ts';
import { getRelease } from '../db/releases.ts';
import { setStatus, type DownloadRow } from '../db/downloads.ts';
import { findLiveByDest, insertImportedFile } from '../db/imported-files.ts';

export type RenameLike = (source: string, destination: string) => Promise<void>;

export interface ImportDeps {
  db: DatabaseSync;
  registry: PluginRegistry;
  importMode: 'move' | 'copy';
  trashDir: string;
  now(): number;
  rename?: RenameLike;
}

/**
 * `stat`, not `lstat`: the source is this function's own download directory,
 * not plugin- or attacker-influenced, so following a symlink there (if one
 * ever existed) is not the concern `lstatOrNull` below exists for. Returns
 * the `Stats` rather than a boolean because the copy-mode recovery check
 * needs the source's size, not just its presence.
 */
async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * `lstat`, not `stat`: callers use this to decide whether something occupies
 * a planned destination and, if so, what kind of thing it is. A symlink must
 * be seen as a symlink — never silently followed to whatever it points at —
 * so a symlink planted at a destination is judged on its own presence, not
 * adopted as if it were the regular file this download was meant to write.
 */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function listFiles(root: string): Promise<DownloadedFile[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: DownloadedFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolutePath = join(entry.parentPath, entry.name);
    const stats = await stat(absolutePath);
    files.push({
      absolutePath,
      relativePath: relative(root, absolutePath),
      sizeBytes: stats.size,
    });
  }

  return files;
}

/**
 * Whether `target` is inside `root`, optionally allowing `target` to equal
 * `root` itself. The two callers below want different answers to "does the
 * root itself count?": a planned *file* destination must never literally be
 * the library root (a file cannot replace the library directory), but a
 * *directory* that will hold a file legitimately can be the root itself —
 * every top-level file in the library has the root as its immediate parent.
 * Both containment tests are expressed here, in one place, so a future
 * change to what "contained" means cannot fix one copy and miss the other.
 */
function isContained(root: string, target: string, allowRootItself: boolean): boolean {
  if (allowRootItself && target === root) return true;
  return target.startsWith(root + sep);
}

/**
 * Resolves a plugin-supplied destination against the library root and refuses
 * anything that lexically escapes it. A plugin is not trusted to police its
 * own paths — a parser bug, or a different plugin entirely, must not be able
 * to write outside the library.
 *
 * This check is purely textual (no filesystem access): `resolve(root, dest)`
 * normalizes `..` segments and collapses empty/`.` segments, and — critically
 * — ignores `root` entirely if `dest` is itself absolute, so an absolute
 * escape attempt is resolved to itself and then still caught by the
 * containment test below. `isContained` (called here with
 * `allowRootItself: false`, since `target` here is the *file*, not a
 * directory that may hold one) requires the result to begin with
 * `root + sep`, which rules out: a sibling directory that merely shares
 * `root` as a string prefix (e.g. root `/lib`, target `/library-evil`); any
 * parent-relative escape; and the root itself. A destination of `.` or `""`
 * resolves to `root` exactly, which is rejected here rather than treated as
 * a valid (if odd) file path: the library root is a directory that must go
 * on existing, never a name a download can be moved onto.
 *
 * What this textual check *cannot* see is a symlink already sitting inside
 * the library root: `resolve` never touches the filesystem, so a destination
 * that is lexically fine (e.g. `Site/scene.mp4`) could still land outside the
 * root at write time if `Site` is a symlink pointing elsewhere. That case is
 * handled separately, with `realpath`, immediately before anything is
 * written or adopted, in `assertRealContainment` below.
 */
function resolveDestination(libraryRoot: string, destination: string): string {
  const root = resolve(libraryRoot);
  const target = resolve(root, destination);
  if (!isContained(root, target, false)) {
    throw new Error(`Destination ${destination} escapes the library root`);
  }
  return target;
}

/**
 * Confirms, using the real (symlink-resolved) filesystem, that a directory we
 * are about to write into or adopt a file from is actually inside the real
 * library root — not just lexically inside it. `dir` must already exist
 * (callers either just created it with `mkdir`, or it necessarily exists
 * because a file was already found inside it) so `realpath` has something to
 * resolve.
 *
 * Unlike `resolveDestination`'s check on the file itself, `dir` here is a
 * *directory* that will hold (or already holds) the file — and the root
 * itself is a perfectly legitimate parent directory, for any file living at
 * the library's top level. So this call allows `dirReal === libraryRootReal`,
 * where `resolveDestination` does not allow the equivalent for the file path.
 */
async function assertRealContainment(libraryRootReal: string, dir: string): Promise<void> {
  const dirReal = await realpath(dir);
  if (!isContained(libraryRootReal, dirReal, true)) {
    throw new Error(`Destination directory ${dir} escapes the library root`);
  }
}

/**
 * Copies into place via a same-directory temp file plus an atomic rename,
 * rather than copying straight to `destination`. A copy that crashes
 * partway through leaves a truncated file exactly where a plain `copyFile`
 * would have left one — but retry's idempotency check (below, in
 * `importDownload`) treats a destination that exists as complete, so a
 * truncated file at the final path would look indistinguishable from a
 * finished import and never be retried. Writing to
 * `${destination}.pickarr-import-tmp` and renaming it into place only after
 * the copy finishes means the final path comes into existence in one atomic
 * step: it is either absent (crash before the rename — safe to redo) or
 * complete (crash never observed at this path). The rename is
 * same-directory, so it is never subject to EXDEV and does not go through
 * the injectable `renameImpl`.
 */
async function copyIntoPlace(source: string, destination: string): Promise<void> {
  const tmp = `${destination}.pickarr-import-tmp`;
  await copyFile(source, tmp);
  await rename(tmp, destination);
}

/**
 * Whether a regular file already sitting at a planned destination can be
 * trusted as this download's own output from an earlier, crashed attempt —
 * as opposed to a name collision with something this download never wrote.
 * The signal that justifies trusting it is different in each mode, because
 * "the source is gone" is only ever a proxy for "we already wrote this
 * destination", and the proxy is sound in `move` mode alone.
 *
 * In `move` mode the source is removed as the very last step of a
 * successful transfer, so its absence is unambiguous: nothing else in this
 * codebase deletes files from the download directory. Its *presence* is
 * therefore never treated as recovery in `move` mode, even when the
 * destination looks right — an earlier attempt that crashed between
 * finishing the copy (inside the EXDEV fallback) and removing the source
 * lands here too, and the deliberate choice is to surface that as a
 * collision the operator can see and resolve by hand, rather than finish
 * the unlink automatically without being able to prove the file at the
 * destination really is this download's copy.
 *
 * In `copy` mode the source is never removed by design, so its presence
 * proves nothing either way — the only available signal is whether the
 * destination's content actually is the source's content. `copyIntoPlace`
 * only ever brings a destination into existence by atomically renaming a
 * *complete* temp copy into place, so a byte-size match between source and
 * destination is not something an accidental foreign file would produce by
 * coincidence; it means an earlier attempt's copy finished before crashing,
 * before `insertImportedFile` could run. The residual risk this doesn't
 * close: a foreign file that already happens to sit at this exact,
 * identity-derived destination path *and* happens to match the source's
 * byte count exactly would still be adopted. That's judged acceptable for
 * the MVP — narrow and stateable, not a designed-in gap — rather than
 * closed with a stronger (and slower) content comparison.
 */
function wasAlreadyWrittenHere(
  mode: 'move' | 'copy',
  sourceStat: Stats | null,
  destStat: Stats,
): boolean {
  if (sourceStat === null) return true;
  return mode === 'copy' && sourceStat.size === destStat.size;
}

async function transfer(
  source: string,
  destination: string,
  mode: 'move' | 'copy',
  renameImpl: RenameLike,
  libraryRootReal: string,
): Promise<void> {
  const destDir = dirname(destination);
  await mkdir(destDir, { recursive: true });
  await assertRealContainment(libraryRootReal, destDir);

  if (mode === 'copy') {
    await copyIntoPlace(source, destination);
    return;
  }

  try {
    await renameImpl(source, destination);
  } catch (error) {
    // The downloads volume and the library volume are frequently different
    // filesystems even inside one container.
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyIntoPlace(source, destination);
    await unlink(source);
  }
}

export async function importDownload(deps: ImportDeps, download: DownloadRow): Promise<void> {
  const { db, registry } = deps;
  const now = deps.now();
  const renameImpl = deps.rename ?? rename;

  if (download.storagePath === null) throw new Error('Download has no storage path');

  const group = getGroup(db, download.groupId);
  if (group === null) throw new Error(`No such group: ${download.groupId}`);
  const release = getRelease(db, download.releaseId);
  if (release === null) throw new Error(`No such release: ${download.releaseId}`);

  const plugin = registry.byId(group.plugin);
  if (plugin === undefined) throw new Error(`No plugin loaded for id ${group.plugin}`);
  const libraryRoot = registry.libraryRootById(group.plugin);

  setStatus(db, download.id, 'importing', now);

  const media: ParsedRelease = {
    identityKey: group.identityKey,
    display: JSON.parse(group.display) as ParsedRelease['display'],
    quality: JSON.parse(release.quality) as ParsedRelease['quality'],
  };

  const files = await listFiles(download.storagePath);
  const plan = plugin.planImport(media, files);
  if (plan === null || plan.files.length === 0) {
    throw new Error('no-importable-files');
  }

  const resolved = plan.files.map((file) => ({
    source: file.source,
    destination: resolveDestination(libraryRoot, file.destination),
  }));

  // Anchor for the real-path containment check in transfer() and in the
  // adoption branch below: ensure the library root itself exists (so
  // realpath has something to resolve) before resolving it, and resolve it
  // once — not per file.
  await mkdir(resolve(libraryRoot), { recursive: true });
  const libraryRootReal = await realpath(resolve(libraryRoot));

  for (const file of resolved) {
    const alreadyRecorded = findLiveByDest(db, download.groupId, file.destination);
    // `lstat`, not `stat`: a symlink at the destination must be seen as a
    // symlink, not silently resolved to whatever it points at, so it can be
    // refused below rather than adopted.
    const destStat = await lstatOrNull(file.destination);
    const sourceStat = await statOrNull(file.source);

    // A row already recorded for this exact destination means an earlier
    // attempt already finished this file (transferred it and recorded it)
    // before crashing on a later file; nothing left to verify or repeat.
    if (alreadyRecorded !== null && destStat !== null) continue;

    if (destStat === null) {
      // Nothing at the destination yet: a normal transfer, or — if the
      // source is gone too — a genuine fault (planned to move a file that
      // exists nowhere at all).
      if (sourceStat === null) throw new Error(`Planned source is missing: ${file.source}`);
      await transfer(file.source, file.destination, deps.importMode, renameImpl, libraryRootReal);
    } else if (destStat.isFile() && wasAlreadyWrittenHere(deps.importMode, sourceStat, destStat)) {
      // Idempotent crash recovery: a *regular file* already sits at the
      // destination, and `wasAlreadyWrittenHere` has judged — by the signal
      // appropriate to this mode — that it is this download's own output
      // from an earlier attempt, not a guess. Still re-verified against the
      // real library root, in case the regular file it's confirming is
      // itself reachable only through a symlinked ancestor directory that
      // changed since the plan was made.
      await assertRealContainment(libraryRootReal, dirname(file.destination));
    } else {
      // Anything else occupying the destination is a collision, not
      // recovery, and must not be guessed at: either `wasAlreadyWrittenHere`
      // found no mode-appropriate signal that this download wrote it (the
      // source is still present in `move` mode, or its size doesn't match in
      // `copy` mode), or the occupant is not a regular file at all (a
      // symlink or a directory), which is never treated as "the file we
      // wrote" regardless of the source's state. Failing loudly and never
      // touching the source is strictly safer than adopting the unknown
      // occupant and losing track of the only copy of the actual download.
      throw new Error(
        `Destination ${file.destination} is occupied by something this download did not write`,
      );
    }

    const stats = await stat(file.destination);
    insertImportedFile(db, {
      downloadId: download.id,
      groupId: download.groupId,
      sourcePath: file.source,
      destPath: file.destination,
      sizeBytes: stats.size,
      createdAt: now,
    });
  }

  setStatus(db, download.id, 'imported', now);
}
