import { copyFile, lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadedFile, ImportFile, ParsedRelease } from '@pickarr/plugin-api';
import type { PluginRegistry } from '../plugins/registry.ts';
import { completeUpgrade, getGroup } from '../db/groups.ts';
import { getRelease } from '../db/releases.ts';
import { setImportPlan, setStatus, type DownloadRow } from '../db/downloads.ts';
import { findLiveByDest, insertImportedFile, liveFilesForGroup } from '../db/imported-files.ts';
import { trashFiles } from './upgrade.ts';
import { asJsonArray, asJsonObject, type JsonValue } from '../json.ts';

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
export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/**
 * Everything the completed download left behind, as the plugin sees it.
 *
 * The storage path a client reports is usually the job's directory, but it is
 * not required to be one and SABnzbd routinely reports the *file* instead —
 * for a job that unpacked to a single video, `storage` is that video's full
 * path. `readdir` on it fails with ENOTDIR, and since the failure happens
 * before `planImport` is ever called, the download fails with a filesystem
 * error naming a path that plainly exists. It is not an error at all: the
 * client has told us exactly which file it produced, which is more than the
 * directory form says. Handled here rather than by second-guessing the client
 * in `sabnzbd.ts` — a storage path that names one file is a legitimate answer
 * from any client, and the listing is where the two shapes converge.
 *
 * The single file is given its own basename as `relativePath`, matching what
 * a one-file directory would have produced, so the plugin's junk-name and
 * depth heuristics see the same input either way.
 */
async function listFiles(root: string): Promise<DownloadedFile[]> {
  const rootStat = await stat(root);
  if (rootStat.isFile()) {
    return [{ absolutePath: root, relativePath: basename(root), sizeBytes: rootStat.size }];
  }

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
export function isContained(root: string, target: string, allowRootItself: boolean): boolean {
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
export function resolveDestination(libraryRoot: string, destination: string): string {
  const root = resolve(libraryRoot);
  const target = resolve(root, destination);
  if (!isContained(root, target, false)) {
    throw new Error(`Destination ${destination} escapes the library root`);
  }
  return target;
}

/**
 * Reads back the plan an earlier attempt committed to `downloads.import_plan`.
 *
 * Every attempt after the first one acts on this rather than on a fresh
 * `planImport`, so it is a trust boundary in the same sense a plugin's answer
 * is: the value is a string out of the database, which a hand-edit, a
 * truncated write or a restore from a differently-shaped backup can make into
 * anything at all. Read through the `JsonValue` helpers so nothing here is
 * `any` or `unknown`, and refused outright rather than half-read — a plan
 * missing an entry, or with a blank destination, would send this download's
 * files somewhere nobody asked for, and an import that refuses to run is
 * always recoverable while a file moved to the wrong place is not.
 *
 * `asText` is deliberately not used for the two fields: it turns a number or a
 * boolean into a string, and `42` is not a path anything in this download's
 * listing ever had. The rule is the literal one — a non-empty string — so a
 * stored plan that does not have that shape is refused rather than coerced
 * into one.
 *
 * An empty array is unreadable too, not an empty plan. `setImportPlan` is only
 * ever called with a plan that already passed the `plan.files.length === 0`
 * check, so nothing legitimate ever stores one; and `asJsonArray` answers `[]`
 * for a value that is not an array at all, which this way needs no second
 * branch to catch.
 *
 * The download is named because this is the one failure in `importDownload`
 * that takes a retryable download and makes it fail forever — every attempt
 * reads the same bad column and refuses the same way. Clearing the column by
 * hand is the recovery, and the message has to be enough to find the row.
 */
function parseStoredPlan(downloadId: number, json: string): ImportFile[] {
  const unreadable = (): Error =>
    new Error(`Stored import plan for download ${downloadId} is unreadable`);

  let parsed: JsonValue;
  try {
    parsed = JSON.parse(json) as JsonValue;
  } catch {
    throw unreadable();
  }

  const entries = asJsonArray(parsed);
  if (entries.length === 0) throw unreadable();

  return entries.map((entry) => {
    const object = asJsonObject(entry);
    if (object === null) throw unreadable();
    const source = object['source'];
    const destination = object['destination'];
    if (typeof source !== 'string' || source === '') throw unreadable();
    if (typeof destination !== 'string' || destination === '') throw unreadable();
    return { source, destination };
  });
}

/**
 * The membership rule itself, split out of the sweep below so the transfer
 * loop can ask the same question at the moment it acts on the answer. The
 * message lives here and nowhere else: a source refused at plan time and a
 * source refused mid-import are the same refusal, and must not become
 * distinguishable by their wording.
 */
function assertSourceWasListed(offered: ReadonlySet<string>, source: string): void {
  if (offered.has(source)) return;
  throw new Error(`Planned source ${source} was not in this download's file listing`);
}

/**
 * Refuses a plan that names a source core never offered the plugin.
 *
 * A plugin's *destinations* have always been policed — lexically by
 * `resolveDestination` and against the real filesystem by
 * `assertRealContainment` — on the principle that a plugin is not trusted to
 * keep its own paths inside the library. Its *sources* went unchecked, which
 * left the mirror-image hole wide open: a plugin returning
 * `{ source: '/etc/pickarr.conf', destination: 'notes.txt' }` had core
 * `rename()` that file into the library and, in move mode, delete the
 * original. Nothing about a plugin makes it trustworthy in one direction and
 * not the other, and the spec already states the rule — a source is "an
 * `absolutePath` from the input listing" — it simply was not enforced. This is
 * the enforcement, so the guarantee is symmetric: core reads and writes only
 * paths it chose itself.
 *
 * The check is deliberately scoped to sources that *exist*, rather than
 * rejecting every unlisted path outright. The listing is a snapshot of the
 * download directory taken moments earlier, and in `move` mode a retried
 * import legitimately finds it shrunken — files an earlier attempt already
 * transferred are gone from it, and a plan that still names them is the exact
 * input the crash-recovery branch in the transfer loop exists to handle. A
 * source that is absent from both the listing and the disk cannot be read,
 * copied, moved or unlinked; there is nothing there to take. A source that is
 * present on disk but absent from the listing is the attack, and is refused
 * before anything — including an upgrade's trashing step — has touched the
 * filesystem.
 *
 * That last scoping decision is sound at the instant this runs and stops being
 * sound a few lines later, which is why this sweep is no longer the only place
 * the rule is applied. `importDownload` creates files while the import is
 * running: `trashFiles` moves every superseded file of the group to
 * `<trashDir>/<groupId>/<now>/<path-relative-to-the-library-root>`, a path
 * built entirely from values a plugin can compute for itself. A plan naming
 * one of those paths is absent from the listing *and* absent from disk when
 * this sweep looks, so it passes here, and exists by the time the transfer
 * loop reaches it. "Absent from disk" is therefore a fact with a short shelf
 * life, and the loop re-asks `assertSourceWasListed` for every source it finds
 * present. This sweep is kept because it is the one that fails the import
 * before `trashFiles` has moved anything, which is a far more useful error
 * than one raised halfway through.
 */
async function assertSourcesWereListed(
  offered: ReadonlySet<string>,
  planned: ImportFile[],
): Promise<void> {
  for (const file of planned) {
    if ((await statOrNull(file.source)) === null) continue;
    assertSourceWasListed(offered, file.source);
  }
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

const COMPARE_CHUNK_BYTES = 64 * 1024;

/**
 * Whether two paths hold the same bytes, read a chunk at a time rather than
 * whole: the files this compares are the library's media files, so a
 * `readFile` of each would make the answer depend on a multi-gigabyte pair
 * fitting in memory, and the comparison would pay for reading all of both
 * even when they diverge in the first kilobyte.
 *
 * A short read that lands differently on the two handles reads as a
 * difference and returns `false`. Regular files on a local filesystem don't
 * do that, and if one ever did the wrong answer is the refusing one — the
 * caller's only use of `true` is to adopt a file it did not write.
 */
async function filesHaveSameContent(a: string, b: string): Promise<boolean> {
  // Nested rather than one `finally` closing both: opening `b` can fail
  // (it is the destination, and the only thing we know of it is that it
  // lstat'd as a regular file a moment ago), and the handle on `a` has to
  // close anyway. Two attempts a few files into a retry is all it takes for
  // a leaked handle to become an EMFILE that looks like an unrelated fault.
  const handleA = await open(a, 'r');
  try {
    const handleB = await open(b, 'r');
    try {
      const bufferA = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
      const bufferB = Buffer.allocUnsafe(COMPARE_CHUNK_BYTES);
      for (;;) {
        const [readA, readB] = await Promise.all([
          handleA.read(bufferA, 0, COMPARE_CHUNK_BYTES, null),
          handleB.read(bufferB, 0, COMPARE_CHUNK_BYTES, null),
        ]);
        if (readA.bytesRead !== readB.bytesRead) return false;
        // Both at EOF with everything so far equal, which for two empty
        // files is the very first pass.
        if (readA.bytesRead === 0) return true;
        const differs = Buffer.compare(
          bufferA.subarray(0, readA.bytesRead),
          bufferB.subarray(0, readB.bytesRead),
        );
        if (differs !== 0) return false;
      }
    } finally {
      await handleB.close();
    }
  } finally {
    await handleA.close();
  }
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
 * proves nothing either way, and nothing about this branch requires a crash
 * to have happened: any regular file sitting at the destination with no
 * `imported_files` row for it arrives here, on a first attempt as readily as
 * on a retry. The only signal that survives that is the destination's own
 * content. Size is the pre-filter and not the answer — a different length is
 * a decisive no that costs no read, but a byte count is a 64-bit summary of a
 * file and every other file of that length matches it, so an equal length is
 * only ever a reason to go on and read. Byte-identical is the whole test, and
 * it is sufficient on its own: a destination holding exactly the source's
 * bytes is indistinguishable from the copy `copyIntoPlace` would have made
 * there, so adopting it produces precisely the intended result whether an
 * earlier attempt wrote it or something else did.
 */
async function wasAlreadyWrittenHere(
  mode: 'move' | 'copy',
  source: string,
  destination: string,
  sourceStat: Stats | null,
  destStat: Stats,
): Promise<boolean> {
  if (sourceStat === null) return true;
  return (
    mode === 'copy' &&
    sourceStat.size === destStat.size &&
    (await filesHaveSameContent(source, destination))
  );
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

/**
 * Moves a file from one place in the library to another.
 *
 * A thin, named wrapper over `transfer` in `'move'` mode, and named because the
 * caller's intent matters: an identity change relocates a file that is *already*
 * in the library, so the mode is never a configuration question. `importMode`
 * decides how a file arrives from the download volume; copying inside the
 * library would leave two copies of one file and a record of one.
 */
export async function moveWithinLibrary(
  from: string,
  to: string,
  libraryRootReal: string,
  renameImpl: RenameLike = rename,
): Promise<void> {
  await transfer(from, to, 'move', renameImpl, libraryRootReal);
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

  // The set of paths core actually offered the plugin, built once and used
  // twice: by the fail-fast sweep below, and again inside the transfer loop for
  // each source that turns out to exist by the time we reach it.
  const offered = new Set(files.map((file) => file.absolutePath));

  // A retry decides what to do from the plan the first attempt committed to,
  // not from a listing that attempt has already changed. `listFiles` runs on
  // every attempt regardless — the loop below needs `offered` whichever plan
  // it is acting on — but `planImport` is asked exactly once per download.
  //
  // Asking again is what the bug was. In `move` mode the previous attempt
  // renamed its sources out of the download directory, so a retry hands the
  // plugin a strictly smaller listing and gets back a different plan: one that
  // no longer names the destination the crashed attempt already wrote. The
  // recovery branch in the loop can only repair a destination the plan gives
  // it, so that file becomes an orphan — in the library, absent from
  // `imported_files`, invisible to `liveFilesForGroup`, and therefore never
  // trashed and never adopted. The next upgrade of the group trashes the
  // group's genuinely live files and *then* collides with the orphan, which is
  // a failure that repeats forever and needs a human. See #23.
  //
  // The plan is stored, rather than the placed files being recorded earlier or
  // the listing being cached: what a retry needs is not "what was on disk" but
  // "what this download decided to do", and only the plan says that. It is
  // stored as the plugin gave it, with destinations still relative, so
  // `resolveDestination` below runs over it on every attempt and the
  // configured library root stays authoritative — a plan committed before the
  // root was reconfigured resolves against the new root, not the old one.
  const stored = download.importPlan;
  let planned: ImportFile[];
  if (stored === null) {
    const plan = plugin.planImport(media, files);
    // First attempt only. A stored plan is never empty, because an empty one
    // was never persisted.
    if (plan === null || plan.files.length === 0) {
      throw new Error('no-importable-files');
    }
    planned = plan.files;
  } else {
    planned = parseStoredPlan(download.id, stored);
  }

  // Runs over whichever plan was chosen, including a stored one. The sweep
  // permits a source that is absent from both the listing and the disk (see
  // its doc comment), which is exactly the shape a stored plan takes on a
  // retry, and the `offered` set it builds is the same one the loop re-asks
  // against.
  await assertSourcesWereListed(offered, planned);

  // Committed after the sweep and before anything touches the filesystem: a
  // plan core has already refused is not one a retry should be handed back,
  // and a plan that only gets written once the first file has moved is missing
  // for precisely the crash it exists to survive.
  if (stored === null) setImportPlan(db, download.id, JSON.stringify(planned));

  const resolved = planned.map((file) => ({
    source: file.source,
    destination: resolveDestination(libraryRoot, file.destination),
  }));

  // Anchor for the real-path containment check in transfer() and in the
  // adoption branch below: ensure the library root itself exists (so
  // realpath has something to resolve) before resolving it, and resolve it
  // once — not per file.
  await mkdir(resolve(libraryRoot), { recursive: true });
  const libraryRootReal = await realpath(resolve(libraryRoot));

  // Trash-first: an upgrade's replacement usually wants the exact destination
  // path the superseded file already occupies, so the old file has to move
  // out of the way before the transfer loop below can write there. Ordering
  // this ahead of the loop — rather than deleting old files as new ones land
  // — means a failure partway through the loop still leaves a fully
  // recoverable trail (the old files sitting in `trashedTo`), never a
  // half-deleted, half-written group.
  //
  // `trashFiles` runs *inside* the same try block as the transfer loop,
  // not before it: if trashing itself throws partway through (one file moved,
  // a later one refused), `trashedTo` is never assigned, but the error
  // trashFiles throws already names its own destination directory (see
  // upgrade.ts) — so the raw rethrow below still tells the caller where to
  // look. If trashing instead completes and `trashedTo` is assigned, and the
  // transfer loop is what fails, the catch below appends that directory to
  // *that* failure instead. Either way, a failure after anything has been
  // physically moved always names where.
  let trashedTo: string | null = null;

  try {
    if (download.kind === 'upgrade') {
      // `download.id` is passed to `liveFilesForGroup` so this download's own
      // rows are never trashed: on a retry they describe files this import
      // already placed, not the release it supersedes. See
      // `liveFilesForGroup` for why that distinction is the whole safety
      // property.
      trashedTo = await trashFiles(
        db,
        // Unchanged in effect: everything live in this group except this
        // download's own files, which on a retry are ones this import already
        // placed. See trashFiles for why the selector now lives at the call
        // site.
        liveFilesForGroup(db, download.groupId, download.id),
        libraryRootReal,
        deps.trashDir,
        download.groupId,
        now,
      );
    }

    for (const file of resolved) {
      const alreadyRecorded = findLiveByDest(db, download.groupId, file.destination);
      // `lstat`, not `stat`: a symlink at the destination must be seen as a
      // symlink, not silently resolved to whatever it points at, so it can be
      // refused below rather than adopted.
      const destStat = await lstatOrNull(file.destination);
      const sourceStat = await statOrNull(file.source);

      // Re-asked here, not just at plan time, because the plan-time answer was
      // about a filesystem this function has since changed: an upgrade's
      // `trashFiles` above creates paths a plugin can name in advance. Gated
      // on the source existing so the rule stays word-for-word the plan-time
      // one — a source absent from both listing and disk is still allowed
      // through, which is what the crash-recovery branch below depends on.
      // Placed before the branches rather than beside the `transfer` call so
      // it also covers adoption, which stats the source and, in copy mode,
      // reads its bytes.
      if (sourceStat !== null) assertSourceWasListed(offered, file.source);

      // A row already recorded for this exact destination means an earlier
      // attempt already finished this file (transferred it and recorded it)
      // before crashing on a later file; nothing left to verify or repeat.
      if (alreadyRecorded !== null && destStat !== null) continue;

      if (destStat === null) {
        // Nothing at the destination yet: a normal transfer, or — if the
        // source is gone too — a genuine fault (planned to move a file that
        // exists nowhere at all).
        if (sourceStat === null) throw new Error(`Planned source is missing: ${file.source}`);
        await transfer(
          file.source,
          file.destination,
          deps.importMode,
          renameImpl,
          libraryRootReal,
        );
      } else if (
        destStat.isFile() &&
        (await wasAlreadyWrittenHere(
          deps.importMode,
          file.source,
          file.destination,
          sourceStat,
          destStat,
        ))
      ) {
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
        // source is still present in `move` mode, or its size or its content
        // doesn't match in `copy` mode), or the occupant is not a regular
        // file at all (a symlink or a directory), which is never treated as
        // "the file we wrote" regardless of the source's state. Failing loudly and never
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
  } catch (error) {
    // `trashedTo` is only ever non-null once `trashFiles` has *returned*
    // successfully — so reaching this branch means trashing fully completed
    // and it was the transfer loop that failed afterward. A failure here must
    // not read as "the old file is gone with nothing to show for it." Naming
    // the trash location in the error is what lets the caller (reconcile.ts
    // marks the download `failed` with this exact message) tell the user
    // where to look to restore it by hand. If `trashFiles` itself threw
    // instead, `trashedTo` was never assigned and this branch is skipped —
    // but that thrown error already names its own destination directory
    // (see upgrade.ts), so the raw rethrow below is not missing anything.
    if (trashedTo === null) throw error;
    throw new Error(
      `${(error as Error).message} — previous files were moved to ${trashedTo} and can be restored by hand`,
    );
  }

  if (download.kind === 'upgrade') {
    completeUpgrade(db, download.groupId, download.releaseId);
  }

  setStatus(db, download.id, 'imported', now);
}
