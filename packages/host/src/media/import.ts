/**
 * The one implementation of `LibraryImporter`: what actually puts a finished
 * download in a plugin's library.
 *
 * `media/shape.ts` decides *where* a matched release goes and opens nothing;
 * this lists what a download holds, decides where an *unmatched* one goes
 * (the download file selection design spec's §4.3, which replaced the
 * importer design's §6 layout), reads the plugin's `plugin_destination`
 * row, and performs the copy. One per plugin
 * context, closed over the plugin's id, so a plugin never names a library
 * that is not its own -- the shape `createMediaReader` next door already has.
 *
 * ---
 *
 * ## Listing
 *
 * `list` is how a plugin learns what a download holds: a download is a
 * single file or a directory, and a directory cannot be copied as one. It
 * answers every regular file below `file.path`, recursively, each with its
 * absolute path, its `/`-separated path relative to the download, and its
 * size; a plain-file download answers one entry, itself, under its own
 * basename. Sorted by `relativePath` by plain code-unit comparison, so the
 * order is the same on every host and a retry places in the same order.
 *
 * **The root is followed and nothing below it is.** The root is read with
 * `stat`, because a client may hand over a symlinked download and following
 * it is what the operator meant. Below it, a symlink -- to a file or to a
 * directory -- is skipped, never followed: `readdir`'s `Dirent` describes
 * the link rather than its target, so a link is neither a file nor a
 * directory there. Following one would let a download name anything on this
 * host as part of itself, and `place` would copy it.
 *
 * **A rejection is `list-failed`, carrying the `errno` and nothing else**,
 * for the reason the section on `node:fs` errors below gives. A root that
 * is neither a file nor a directory is `list-failed` too, with no errno:
 * listing it as empty would read as a download imported with nothing in
 * it.
 *
 * ## The copy
 *
 * **A copy, and only ever a copy** (design spec §4). No move, no hardlink:
 * nothing is removed from a download client, and nothing already in the
 * library is moved, renamed or deleted. The only two writes this module
 * performs are `mkdir` under the root and the creation of one new file.
 *
 * **The `mkdir` outlives a refusal, and that is worth saying because the
 * sentence above understates it.** It runs before the copy, so a refusal
 * raised after it -- the second occupied-destination check, a failed copy,
 * a failed rename -- leaves the directories behind: an unmatched import
 * whose copy fails with `unmatchedDir: 'a/b'` leaves `a/`, `a/b/` and
 * `a/b/<release name>/` under the root and no file. Empty
 * directories under a root an operator chose are not a deletion and not a
 * path outside the root, so nothing removes them; a cleanup that did would
 * be this module deleting things in a library, which §4 is about not
 * doing.
 *
 * **The source is `entry.path`**, never `file.path`: `file` is the whole
 * download, which may be a directory, and `entry` is the one file of it
 * being copied. `place` refuses an entry that is not inside `file` --
 * `foreign-entry` -- before any destination is built, so a plugin cannot
 * hand it an arbitrary path to copy. "Inside" is checked on disk too, not
 * only in the path's spelling: see `ownsOnDisk`.
 *
 * **To a temporary in the destination directory, then a rename.** A rename
 * within a directory is atomic, so a reader never sees a half-copied file
 * and a crash mid-copy leaves a temporary nobody mistakes for a library
 * file. Copying straight to the final name gives a partial file the right
 * name, which is the one outcome a media server will happily index. The
 * temporary's name is derived from the destination and carries no
 * randomness, deliberately: design spec §7 says a failed copy "leaves only
 * the temporary, which the next tick overwrites", and a unique name per
 * attempt would accumulate one corpse per failure instead. Nothing here
 * unlinks it, for the same reason.
 *
 * **The residual race, stated rather than left to be found.** `rename(2)`
 * replaces an existing destination silently -- measured on this tree -- so
 * the check that refuses an occupied destination (§5) cannot be made atomic
 * with the rename by `rename` alone. It is therefore made twice: once before
 * the copy, so a re-grab costs nothing, and once immediately before the
 * rename, which narrows the window from however long a copy takes to the
 * cost of one `lstat`. `link(2)` would close it entirely -- it refuses an
 * existing name atomically -- but hardlinks are unsupported on filesystems a
 * media library plausibly sits on (exFAT, some network mounts), and design
 * spec §4 names a rename. The window is left open, and named.
 *
 * ## Why no `node:fs` error ever escapes
 *
 * Every rejection between the root check and the rename is converted to a
 * `copy-failed` refusal carrying the platform's `errno` code and nothing
 * else. That is not tidiness: **measured on this tree, every `node:fs`
 * rejection quotes both paths into its `message`** --
 * `"ENOENT: no such file or directory, copyfile '/…' -> '/…'"` -- and
 * `deliverCompleted`'s catch logs an escaping error's message. Design spec
 * §7 forbids a path in any log line, and `redactText` there redacts urls, not
 * paths. So a throw from here would be a leak on the very first disk that
 * filled up.
 *
 * ## Control characters, and why they are caught here
 *
 * A resolved value may hold one: `media/shape.ts` refuses a separator and a
 * `..` segment and is otherwise deliberately not in the business of deciding
 * what a filesystem will accept. Measured: on darwin a newline in a filename
 * copies perfectly well, so "a control character fails the copy" is false in
 * general -- but a **NUL** makes `node:fs` throw `ERR_INVALID_ARG_VALUE`,
 * and that error's message *quotes the whole path back*. That is the leak
 * above, arriving through a permanent condition that `deliverCompleted`
 * retries for ever.
 *
 * It is caught here rather than in `media/shape.ts` for a reason the
 * resolver cannot address: **only one of the two destination branches goes
 * through the resolver.** §4.3's unmatched path is a configured directory
 * joined to the release name and the entry's relative path, and never
 * touches `resolveShape` at all -- so a check there would leave uncovered
 * exactly the branch with no resolver in it. Here, one check covers both.
 *
 * ## The unmatched directory is re-checked, not trusted
 *
 * `media/destinations.ts` validates it on save. It is checked again here,
 * against the rules design spec §6 states, and the duplication is
 * deliberate: the save-time check hand-rolls its own escape rule for this
 * field instead of delegating to the resolver, and was found to accept `.`,
 * `./` and `a/.` -- every one of which means "put unmatched files in the
 * library root", the outcome §6 refuses `''` in order to prevent. A
 * validator that was wrong once is a validator worth a second reading at the
 * point of use, and the escape check has to exist here anyway for the
 * resolved shape, so pointing it at both inputs costs one function.
 *
 * ## `node:path` is imported here, where `media/shape.ts` refuses it
 *
 * The two are not the same question. `shape.ts` composes a *relative* path
 * out of operator configuration and untrusted values, where every
 * `node:path` function that does more than concatenate also normalises --
 * and normalising deletes the `..` §7 requires be refused. This module joins
 * an already-checked relative path to an absolute root on *this* host and
 * hands the result to *this* host's `fs`, which is precisely what
 * `node:path` is for. The normalisation is wanted here, and it happens after
 * every check that a normalisation would have erased; `resolve`'s answer is
 * then compared against the root, so a path that somehow reached outside it
 * is refused rather than written.
 */
import { copyFile as realCopyFile, lstat, mkdir, readdir, realpath, rename, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DownloadEntry,
  DownloadedFile,
  ImportOutcome,
  ImportRefusal,
  ImportRefusalCode,
  LibraryImporter,
  TokenValues,
} from '@pickarr/contract';
import { resolveShape, rootRefusal, unmatchedDirSegments } from './shape.ts';
import type { ShapeRefusalCode } from './shape.ts';

/**
 * What a partly-written copy is called while it is being written.
 *
 * The suffix 1.x's `pipeline/import.ts` used, unchanged: it is long enough
 * that nothing a release is called collides with it, and a library that
 * already holds one from the 1.x importer is holding it for the same reason.
 */
const TEMPORARY_SUFFIX = '.pickarr-import-tmp';

/** The highest code point treated as a control character, plus `DEL` below. */
const FIRST_PRINTABLE = 0x20;
const DELETE_CHARACTER = 0x7f;

/**
 * What a platform `errno` looks like, and the whole of what may leave this
 * module about a filesystem failure.
 *
 * `EACCES`, `ENOSPC`, `ERR_INVALID_ARG_VALUE`. Anchored and restricted to
 * capitals, digits and underscores, so an `Error` carrying something else
 * under `code` -- a path, a sentence -- contributes `null` rather than
 * whatever it is. `code` is not a declared property of `Error`, so what
 * arrives there is whatever threw, and a throw is not always `node:fs`.
 */
const ERRNO = /^[A-Z][A-Z0-9_]*$/;

/**
 * The copy itself, injectable so a test can fail part way through.
 *
 * A real `copyFile` cannot be asked to write some bytes and then reject,
 * which is the one thing the atomicity requirement (design spec §4, with
 * §7's "a copy that fails part way leaves only the temporary") has to be
 * shown against. It is also the only way to occupy the destination
 * *between* the two `presentAt` checks below. **Five of
 * `test/media/import.test.ts`'s 39 tests inject one**; the other thirty-four
 * run the real `node:fs/promises` copy.
 */
export type CopyFile = (source: string, destination: string) => Promise<void>;

export interface LibraryImporterDeps {
  raw: DatabaseSync;
  /** Whose library. Closed over, never a parameter -- see the module doc. */
  pluginId: string;
  /** Defaults to `node:fs/promises`' own `copyFile`. */
  copyFile?: CopyFile;
}

/** One plugin's configured destination, as `plugin_destination` holds it. */
interface Destination {
  root: string;
  shape: string;
  unmatchedDir: string;
}

function refuse(code: ImportRefusalCode): ImportRefusal {
  return { refusal: code, errno: null };
}

/**
 * One of `media/shape.ts`'s refusals as the code this module answers with.
 *
 * An identity, and the *assignment* is the check: `ShapeRefusalCode` is
 * host-local and `ImportRefusalCode` is the contract's, so this line stops
 * compiling the day a seventh shape refusal is added without being named in
 * the contract. A `switch` writing out six identical cases would say the
 * same thing at six times the length; `media/destinations.ts` needs one
 * because two of its cases are *not* identities.
 */
function importRefusalFor(code: ShapeRefusalCode): ImportRefusalCode {
  return code;
}

function importErrno(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const code: unknown = error.code;
  return typeof code === 'string' && ERRNO.test(code) ? code : null;
}

/**
 * Whether `value` holds a C0 control character or `DEL`.
 *
 * Iterated rather than matched with a regular expression, so the character
 * class is a pair of legible numeric comparisons instead of an escape
 * sequence a reader has to decode -- and so nothing in this file is a
 * literal control character.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < FIRST_PRINTABLE || code === DELETE_CHARACTER) return true;
  }
  return false;
}

function readDestination(raw: DatabaseSync, pluginId: string): Destination | undefined {
  const row = raw
    .prepare('SELECT root, shape, unmatched_dir FROM plugin_destination WHERE plugin_id = ?')
    .get(pluginId);
  if (row === undefined) return undefined;
  // Read through `String`, not a cast: the columns are `TEXT NOT NULL`, so
  // this is the compiler's question about `SQLOutputValue` answered rather
  // than asserted away.
  return {
    root: String(row['root']),
    shape: String(row['shape']),
    unmatchedDir: String(row['unmatched_dir']),
  };
}

/**
 * Design spec 2026-09-22 §4.3's destination for a release nothing matched:
 * `<unmatched>/<release name>/<relative path>`, relative to the root.
 *
 * The release name is its own segment, so it is checked on its own: `..`
 * here would otherwise resolve `_unmatched/../file` to a path *inside* the
 * root, which the final `startsWith` check cannot see. `basename('/a/..')`
 * is `'..'` (measured), so this is reachable from a source path. The
 * relative path needs no such check: `place` has already refused, as
 * `foreign-entry`, one holding an empty, `.` or `..` segment.
 *
 * The unmatched directory's three rules (importer design spec §6), checked
 * here rather than taken on trust from the save -- see the module doc --
 * but no longer *restated* here.
 * `unmatchedDirSegments` (`media/shape.ts`) is the one implementation, and
 * `media/destinations.ts` calls the same function on the way in. This
 * module used to carry its own copy; the save side carried another, and
 * that one was missing the `.` drop, so `'.'` saved and then refused
 * forever. Two copies of a rule checked in two places is how "checked
 * twice" stops meaning what it says.
 */
function unmatchedDestination(
  unmatchedDir: string,
  release: string,
  relativePath: string,
): { path: string } | ImportRefusal {
  const unmatched = unmatchedDirSegments(unmatchedDir);
  if ('refusal' in unmatched) {
    // This module's vocabulary, not that function's: `names-the-root` is
    // `unmatched-dir-is-root` here and `empty-path` at the route, because
    // each list is the one its own consumer branches on.
    return refuse(unmatched.refusal === 'escapes-root' ? 'escapes-root' : 'unmatched-dir-is-root');
  }
  // `basename` answers `''` for exactly two source paths: `'/'` and `''`.
  // Measured -- a trailing separator is *not* one of them, `basename('/a/b/')`
  // being `'b'`. Neither is a path this host should ever be handed, which is
  // why the case is refused rather than defaulted to something invented.
  if (release === '') return refuse('empty-filename');
  if (release === '.' || release === '..') return refuse('escapes-root');
  return { path: [...unmatched.segments, release, relativePath].join('/') };
}

/**
 * The directory an unmatched download is kept under (§4.3): a directory's
 * own name, or a single file's name without its extension.
 *
 * "A single file" is read off the entry rather than the disk, costing no
 * second `stat`: `list` gives a plain-file download exactly one entry, the
 * file itself, and a directory download never lists its own path, so
 * `entry.path === file.path` is the single-file case. Any other entry
 * handed in for a plain file names a path *beneath* a file, which
 * `ownsOnDisk` cannot `lstat` and so refuses. A leading dot is not an extension -- `.hidden`
 * keeps its name -- so the cut is at a dot after the first character.
 */
function releaseName(file: DownloadedFile, entry: DownloadEntry): string {
  const name = basename(file.path);
  if (entry.path !== file.path) return name;
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

/**
 * Whether `entry`'s *spelling* is that of a file inside `file` (spec §5):
 * its relative path is plain segments, and joining it to the download gives
 * its path. A plain-file download's only entry is the file itself under its
 * basename. The first of two checks; `ownsOnDisk` is the second, because a
 * string cannot see a symlink.
 */
function isForeign(file: DownloadedFile, entry: DownloadEntry): boolean {
  const segments = entry.relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return true;
  if (entry.path === file.path) return segments.length !== 1 || segments[0] !== basename(file.path);
  return resolve(file.path, ...segments) !== resolve(entry.path);
}

/**
 * Whether `entry` is, on disk, a regular file inside `file` -- the half of
 * the `foreign-entry` check a string comparison cannot make.
 *
 * A path spelled inside the download can still copy something outside it:
 * `<dir>/link.mkv` may be a symlink, and `<dir>/linkdir/x` may pass through
 * one, and `copyFile` follows both. A torrent can create either (BEP 47).
 * So the entry must `lstat` as a regular file -- not a link -- and its
 * `realpath` must lie under the download's `realpath`. The download root
 * itself is still followed, as `list` follows it: both sides are resolved,
 * so a symlinked download compares as the directory it points at. For a
 * plain-file download the entry *is* the root, so it is read with `stat`,
 * following it for the same reason, and must resolve to the same file.
 *
 * **A rejection from any of these calls is `false`, and so `foreign-entry`
 * with no errno**, rather than `copy-failed`: an entry whose ownership
 * could not be established has not been shown to be inside the download,
 * which is the whole of what this code means. The `list` just before it
 * already answered for faults with the download itself, and either refusal
 * leaves the row for the next tick. Nothing from the error is kept -- its
 * message quotes the path.
 *
 * A check, not a lock: a link swapped in between this and the copy is not
 * seen. That window is the same shape as the occupied-destination race the
 * module doc names, and is left open for the same reason.
 */
async function ownsOnDisk(file: DownloadedFile, entry: DownloadEntry): Promise<boolean> {
  try {
    const plainFile = entry.path === file.path;
    const found = plainFile ? await stat(entry.path) : await lstat(entry.path);
    if (!found.isFile()) return false;
    const [root, real] = await Promise.all([realpath(file.path), realpath(entry.path)]);
    return plainFile ? real === root : real.startsWith(root + sep);
  } catch {
    return false;
  }
}

/** Every regular file below `dir`, relative to it. Symlinks are skipped, not followed. */
async function walk(dir: string, prefix: string): Promise<DownloadEntry[]> {
  const children = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(children.map(async (child): Promise<DownloadEntry[]> => {
    const path = join(dir, child.name);
    const relativePath = prefix === '' ? child.name : `${prefix}/${child.name}`;
    // A `Dirent` describes the link, not its target, so a symlink is
    // neither a directory nor a file here and falls through to `[]`.
    if (child.isDirectory()) return walk(path, relativePath);
    if (!child.isFile()) return [];
    const { size } = await lstat(path);
    return [{ path, relativePath, sizeBytes: size }];
  }));
  return nested.flat();
}

function byRelativePath(a: DownloadEntry, b: DownloadEntry): number {
  if (a.relativePath < b.relativePath) return -1;
  return a.relativePath > b.relativePath ? 1 : 0;
}

export function createLibraryImporter(deps: LibraryImporterDeps): LibraryImporter {
  const copyFile = deps.copyFile ?? realCopyFile;

  /** The path under the root, or the refusal that stopped it. */
  async function relativeDestination(
    file: DownloadedFile,
    entry: DownloadEntry,
    destination: Destination,
    resolveTokens: () => Promise<TokenValues>,
  ): Promise<{ path: string } | ImportRefusal> {
    if (file.mediaItemId === null) {
      return unmatchedDestination(destination.unmatchedDir, releaseName(file, entry), entry.relativePath);
    }
    const resolved = resolveShape(destination.shape, await resolveTokens());
    return 'refusal' in resolved ? refuse(importRefusalFor(resolved.refusal)) : resolved;
  }

  /** Whether anything at all is at `path`, a dangling symlink included. */
  async function presentAt(path: string): Promise<boolean> {
    try {
      // `lstat`, not `stat`: a dangling symlink at the destination is
      // something already there, and `stat` would report it absent and let
      // the rename replace it.
      await lstat(path);
      return true;
    } catch (error) {
      if (importErrno(error) === 'ENOENT') return false;
      throw error;
    }
  }

  return {
    async list(file): Promise<readonly DownloadEntry[] | ImportRefusal> {
      try {
        // `stat`, not `lstat`, for the root alone: a client may hand over a
        // symlinked download, and following it is what the operator meant.
        const top = await stat(file.path);
        if (top.isFile()) return [{ path: file.path, relativePath: basename(file.path), sizeBytes: top.size }];
        // A FIFO, a socket, a device: nothing a download is, and not an
        // empty one either -- `[]` would read to the engine as a download
        // with nothing in it, imported successfully.
        if (!top.isDirectory()) return { refusal: 'list-failed', errno: null };
        return (await walk(file.path, '')).toSorted(byRelativePath);
      } catch (error) {
        // Every `node:fs` message quotes the path -- see the module doc.
        return { refusal: 'list-failed', errno: importErrno(error) };
      }
    },

    async place(file, entry, resolveTokens): Promise<ImportOutcome> {
      const destination = readDestination(deps.raw, deps.pluginId);
      if (destination === undefined) return refuse('no-destination');
      // `rootRefusal` (`media/shape.ts`), the same function
      // `media/destinations.ts` applies on the way in -- not a second copy
      // of the rule. Re-checked rather than trusted for the same reason the
      // unmatched directory is: a row can predate a rule. Both sides once
      // carried their own `startsWith('/')` and nothing else, which is how
      // `'/'`, `'//'` and `'/lib/../..'` came to save and then refuse at
      // every import for ever.
      const rootProblem = rootRefusal(destination.root);
      if (rootProblem !== undefined) {
        return refuse(rootProblem === 'not-absolute' ? 'not-absolute-root' : 'unusable-root');
      }

      if (isForeign(file, entry) || !(await ownsOnDisk(file, entry))) return refuse('foreign-entry');

      const relative = await relativeDestination(file, entry, destination, resolveTokens);
      if ('refusal' in relative) return relative;
      if (hasControlCharacter(relative.path)) return refuse('control-character');

      const root = resolve(destination.root);
      const target = resolve(root, relative.path);
      // Last line of defence, after the normalisation `resolve` performs --
      // and it is a live check rather than a belt over a proven brace, so
      // do not read it as unreachable, even though neither branch has a
      // known way through today. It is not what refuses a release name of
      // `..` -- `_unmatched/../x.mkv` resolves to `<root>/x.mkv`, inside
      // the root, so this line would let it pass; `unmatchedDestination`
      // refuses that segment on its own. What this line catches is a path
      // that leaves the root altogether, from either branch, by a route no
      // earlier rule anticipated. Refused rather than thrown -- a
      // throw from here reaches `deliverCompleted`'s log carrying two
      // paths.
      //
      // `root` is already what it resolves to: `rootRefusal` above refuses
      // an empty, `.` or `..` segment and refuses `/` itself, so
      // `root + sep` is a real prefix rather than `'//'`.
      if (!target.startsWith(root + sep)) return refuse('escapes-root');

      const placed = file.mediaItemId === null ? 'unmatched' : 'library';
      try {
        // Design spec §7: a root that does not exist is **not** created. Only
        // the levels *below* it are, which is what lets a shape name
        // directories at all.
        const rootStat = await stat(root).catch(() => null);
        if (rootStat === null || !rootStat.isDirectory()) return refuse('missing-root');
        if (await presentAt(target)) return refuse('destination-exists');

        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}${TEMPORARY_SUFFIX}`;
        await copyFile(entry.path, temporary);
        // Again, immediately before the rename. See the module doc for what
        // this narrows and what it does not close.
        if (await presentAt(target)) return refuse('destination-exists');
        await rename(temporary, target);
      } catch (error) {
        return { refusal: 'copy-failed', errno: importErrno(error) };
      }
      return { placed };
    },
  };
}
