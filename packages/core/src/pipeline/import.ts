import { copyFile, mkdir, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
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
 * Resolves a plugin-supplied destination against the library root and refuses
 * anything that lexically escapes it. A plugin is not trusted to police its
 * own paths — a parser bug, or a different plugin entirely, must not be able
 * to write outside the library.
 *
 * This check is purely textual (no filesystem access): `resolve(root, dest)`
 * normalizes `..` segments and collapses empty/`.` segments, and — critically
 * — ignores `root` entirely if `dest` is itself absolute, so an absolute
 * escape attempt is resolved to itself and then still caught by the
 * containment test below. The containment test requires the result to equal
 * `root` or begin with `root + sep`, which rules out both a sibling directory
 * that merely shares `root` as a string prefix (e.g. root `/lib`, target
 * `/library-evil`) and any parent-relative escape, on any platform's
 * separator (`sep` is platform-specific, not hardcoded).
 *
 * What this textual check *cannot* see is a symlink already sitting inside
 * the library root: `resolve` never touches the filesystem, so a destination
 * that is lexically fine (e.g. `Site/scene.mp4`) could still land outside the
 * root at write time if `Site` is a symlink pointing elsewhere. That case is
 * handled separately, with `realpath`, immediately before the write in
 * `transfer` below — after the destination's parent directory has been
 * created (or confirmed to exist) but before any bytes move.
 */
function resolveDestination(libraryRoot: string, destination: string): string {
  const root = resolve(libraryRoot);
  const target = resolve(root, destination);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`Destination ${destination} escapes the library root`);
  }
  return target;
}

/**
 * Confirms, using the real (symlink-resolved) filesystem, that a directory we
 * are about to write into is actually inside the real library root — not
 * just lexically inside it. `dir` must already exist (callers create it with
 * `mkdir` first) so `realpath` has something to resolve.
 */
async function assertRealContainment(libraryRootReal: string, dir: string): Promise<void> {
  const dirReal = await realpath(dir);
  if (dirReal !== libraryRootReal && !dirReal.startsWith(libraryRootReal + sep)) {
    throw new Error(`Destination directory ${dir} escapes the library root`);
  }
}

/**
 * Copies into place via a same-directory temp file plus an atomic rename,
 * rather than copying straight to `destination`. A copy that crashes
 * partway through leaves a truncated file exactly where a plain `copyFile`
 * would have left one — but retry's idempotency check (below, in
 * `importDownload`) only asks "does the destination exist?", so a truncated
 * file at the final path would look indistinguishable from a completed
 * import and never be retried. Writing to `${destination}.pickarr-import-tmp`
 * and renaming it into place only after the copy finishes means the final
 * path comes into existence in one atomic step: it is either absent (crash
 * before the rename — safe to redo) or complete (crash never observed at
 * this path). The rename is same-directory, so it is never subject to EXDEV
 * and does not go through the injectable `renameImpl`.
 */
async function copyIntoPlace(source: string, destination: string): Promise<void> {
  const tmp = `${destination}.pickarr-import-tmp`;
  await copyFile(source, tmp);
  await rename(tmp, destination);
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

  // Anchor for the real-path containment check in transfer(): ensure the
  // library root itself exists (so realpath has something to resolve) before
  // resolving it, and resolve it once — not per file.
  await mkdir(resolve(libraryRoot), { recursive: true });
  const libraryRootReal = await realpath(resolve(libraryRoot));

  for (const file of resolved) {
    // Idempotent on retry: a destination that exists with no surviving source
    // was written by an earlier attempt that crashed before recording it.
    const alreadyRecorded = findLiveByDest(db, download.groupId, file.destination);
    const destinationExists = await exists(file.destination);
    const sourceExists = await exists(file.source);

    if (alreadyRecorded !== null && destinationExists) continue;

    if (!destinationExists) {
      if (!sourceExists) throw new Error(`Planned source is missing: ${file.source}`);
      await transfer(file.source, file.destination, deps.importMode, renameImpl, libraryRootReal);
    } else if (deps.importMode === 'move' && sourceExists) {
      // The destination already exists — because copyIntoPlace only ever
      // makes it exist via an atomic rename, that content is guaranteed
      // complete, not a truncated in-progress copy. So a surviving source
      // here can only mean an earlier attempt finished the copy and crashed
      // before this last unlink; finishing it now is safe, not a guess.
      await unlink(file.source);
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
