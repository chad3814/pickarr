/**
 * The one implementation of `LibraryImporter`: what actually puts a finished
 * download in a plugin's library.
 *
 * `media/shape.ts` decides *where* a matched release goes and opens nothing;
 * this decides where an *unmatched* one goes (design spec §6), reads the
 * plugin's `plugin_destination` row, and performs the copy. One per plugin
 * context, closed over the plugin's id, so a plugin never names a library
 * that is not its own -- the shape `createMediaReader` next door already has.
 *
 * ---
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
 * a failed rename -- leaves the directories behind: measured, an unmatched
 * import whose copy fails with `unmatchedDir: 'a/b'` leaves `a/` and
 * `a/b/` under the root and no file. Empty
 * directories under a root an operator chose are not a deletion and not a
 * path outside the root, so nothing removes them; a cleanup that did would
 * be this module deleting things in a library, which §4 is about not
 * doing.
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
 * §7 forbids a path in any log line, and `redactUrl` there redacts urls, not
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
 * through the resolver.** Design spec §6's unmatched path is a configured
 * directory joined to the source filename, and never touches `resolveShape`
 * at all -- so a check there would leave uncovered exactly the branch with
 * no resolver in it. Here, one check covers both.
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
import { copyFile as realCopyFile, lstat, mkdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
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
 * `test/media/import.test.ts`'s 23 tests inject one**; the other eighteen
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
 * Design spec §6's destination for a release nothing matched:
 * `<unmatched>/<filename>`, relative to the root.
 *
 * The three rules §6 states, checked here rather than taken on trust from
 * the save -- see the module doc -- but no longer *restated* here.
 * `unmatchedDirSegments` (`media/shape.ts`) is the one implementation, and
 * `media/destinations.ts` calls the same function on the way in. This
 * module used to carry its own copy; the save side carried another, and
 * that one was missing the `.` drop, so `'.'` saved and then refused
 * forever. Two copies of a rule checked in two places is how "checked
 * twice" stops meaning what it says.
 */
function unmatchedDestination(unmatchedDir: string, filename: string): { path: string } | ImportRefusal {
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
  if (filename === '') return refuse('empty-filename');
  return { path: [...unmatched.segments, filename].join('/') };
}

export function createLibraryImporter(deps: LibraryImporterDeps): LibraryImporter {
  const copyFile = deps.copyFile ?? realCopyFile;

  /** The path under the root, or the refusal that stopped it. */
  async function relativeDestination(
    file: DownloadedFile,
    destination: Destination,
    resolveTokens: () => Promise<TokenValues>,
  ): Promise<{ path: string } | ImportRefusal> {
    if (file.mediaItemId === null) {
      return unmatchedDestination(destination.unmatchedDir, basename(file.path));
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
    async place(file, resolveTokens): Promise<ImportOutcome> {
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

      const relative = await relativeDestination(file, destination, resolveTokens);
      if ('refusal' in relative) return relative;
      if (hasControlCharacter(relative.path)) return refuse('control-character');

      const root = resolve(destination.root);
      const target = resolve(root, relative.path);
      // Last line of defence, after the normalisation `resolve` performs --
      // and it is a live check rather than a belt over a proven brace, so
      // do not read it as unreachable. The unmatched branch takes its
      // filename from `basename(file.path)`, and `basename('/a/..')` is
      // `'..'` (measured), so a source path ending in `/..` builds
      // `_unmatched/..` out of two values each of which passed its own
      // rule, and *this* line is what refuses it. The shape branch is the
      // one with no known way through. Refused rather than thrown -- a
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
        await copyFile(file.path, temporary);
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
