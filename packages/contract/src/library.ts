/**
 * The capability a plugin uses to put a finished download in its library:
 * `PluginContext.library`, implemented once by the host in
 * `host/src/media/import.ts`.
 *
 * **Why the plugin does not do this itself.** "The host notifies; the
 * plugin imports" is the *reconcile* slice's division
 * (`docs/superpowers/specs/2026-09-06-reconcile-design.md`), and this
 * design supersedes half of it: the host performs the copy. What it keeps
 * is the split of *knowledge* the importer spec §3 makes -- only a plugin
 * can resolve `{season}`, and only the host holds `plugin_destination` and
 * this machine's filesystem. A
 * plugin package cannot reach either -- `@pickarr/openmetadata` and the
 * three plugins built on it depend on this package and nothing else, and a
 * dependency on `@pickarr/host` would be a cycle. So the copy lives in the
 * host and arrives through the context, the same seam `jobs`, `media`,
 * `read` and `downloads` already use.
 *
 * **Declared here rather than in the host** for the reason every contract
 * module gives -- `./mappings.ts` and `./download-clients.ts` each measure
 * it: this is a boundary two packages have to agree on exactly, and a
 * second hand-written copy of it is the pair that drifts, because renaming
 * one half reddens only that half's tests. (`./media.ts`'s `MediaWriter`
 * was cited here and does not argue this; its docblock is about scoping,
 * which is a different question.)
 *
 * **Not a browser contract.** Nothing in this module reaches a client.
 * `./destinations.ts` holds the codes `PUT /api/destinations/:pluginId`
 * answers with because a browser branches on those strings; nothing branches
 * on an {@link ImportRefusalCode} except a log line. It is here because the
 * *plugin* is the other side of it, not because a browser is.
 */
import type { DownloadedFile } from './plugin.ts';

/**
 * Every way {@link LibraryImporter.place} can decline to put a file in the
 * library.
 *
 * **Returned as a value, never thrown** -- the shape `MappingRefusal`,
 * `AddFeedRefusal`, `DestinationRefusal` and the host's own `ShapeRefusal`
 * already answer in, narrowed by callers with `'refusal' in result`. What a
 * plugin does with a refusal is the plugin's own decision: the engine logs
 * it and then throws, because design spec §5 and §7 require the download row
 * to stay `completed` and be retried, and `deliverCompleted` treats a throw
 * as exactly that.
 *
 * ## The first six are the host resolver's own rules, under the same names
 *
 * `host/src/media/shape.ts`'s `ShapeRefusalCode` is deliberately host-local.
 * These six are spelled the same rather than renamed, because unlike
 * `./destinations.ts` -- where `escapes-root` had to become
 * `escaping-shape` so a client could tell the shape's version of the rule
 * from the unmatched directory's -- nothing here has a second field for a
 * reader to confuse it with. The host proves the containment with a typed
 * identity function rather than a switch, so a seventh shape refusal added
 * later is a compile error in the host until it is added below.
 *
 * - `malformed-shape` -- a brace that does not open and close a token.
 * - `unknown-token` -- the stored shape names a token the plugin did not
 *   resolve. Refused on save (design spec §3), so reaching it at import
 *   means the plugin's declared tokens changed after the shape was stored.
 * - `backslash-in-shape` -- a literal `\` in the shape text.
 * - `separator-in-value` -- a resolved value contains `/` or `\`. A
 *   condition of the data, not of the shape, so save-time validation cannot
 *   see it: `AC/DC` is a real series name.
 * - `escapes-root` -- the shape, the resolved path or the configured
 *   unmatched directory reaches outside the plugin's root.
 * - `empty-filename` -- the last segment resolved to nothing.
 *
 * ## The rest are the copy's own
 *
 * - `no-destination` -- no `plugin_destination` row names this plugin, so
 *   nothing says where its library is. Retried rather than delivered: a
 *   destination saved later takes effect on the very next tick, because the
 *   importer reads the table at the moment it imports.
 * - `not-absolute-root` -- the stored root does not begin with `/`. Refused
 *   on save; re-checked because a relative root would place the library
 *   against whatever directory the host happens to be running in.
 * - `unusable-root` -- the stored root begins with `/` but is not a
 *   directory *under* `/` spelled exactly as it resolves: it is `/` itself,
 *   or it holds an empty, `.` or `..` segment. Refused on save under the
 *   same name (`./destinations.ts`), and re-checked here through the same
 *   function (`host/src/media/shape.ts`'s `rootRefusal`) because a row can
 *   predate the rule -- and because until that rule existed every one of
 *   these values saved and then answered `escapes-root` at every import,
 *   which is the next code down and does not mean this.
 * - `missing-root` -- the root does not exist, or is not a directory.
 *   **Never created** (design spec §7): a missing root is a
 *   misconfiguration an operator should see, not a directory tree the
 *   importer invents somewhere unintended.
 * - `unmatched-dir-is-root` -- the configured unmatched directory names no
 *   directory at all (it is empty, `.`, `./`, or only such segments), so
 *   unmatched files would land in the library root itself -- the outcome
 *   design spec §6 refuses `''` in order to prevent.
 * - `control-character` -- the resolved path holds a character in
 *   `U+0000`-`U+001F` or `U+007F`. See `host/src/media/import.ts` for the
 *   measurement that motivates this one; the short version is that a NUL
 *   makes `node:fs` throw an error whose message quotes the whole path back.
 * - `destination-exists` -- something is already at the destination.
 *   Refused, and the row is left for retry (design spec §5): overwriting
 *   destroys whichever copy was better with nothing recorded.
 * - `copy-failed` -- the filesystem refused the copy or the rename.
 *   {@link ImportRefusal.errno} carries the `errno` code and nothing else.
 */
export type ImportRefusalCode =
  | 'malformed-shape'
  | 'unknown-token'
  | 'backslash-in-shape'
  | 'separator-in-value'
  | 'escapes-root'
  | 'empty-filename'
  | 'no-destination'
  | 'not-absolute-root'
  | 'unusable-root'
  | 'missing-root'
  | 'unmatched-dir-is-root'
  | 'control-character'
  | 'destination-exists'
  | 'copy-failed';

/**
 * A declined import.
 *
 * **Two fields, where most refusals in this codebase have one** -- the
 * hedge `./destinations.ts` already uses, and the exception is that file:
 * `DestinationRefusal` and `DestinationRefusalBody`, added on this same
 * branch, carry a `token` beside their code. The second field here is the
 * reason to read this doc. A `copy-failed` with nothing
 * else on it cannot tell a full disk from a read-only mount from a
 * permission the host lost, and those are three different things for an
 * operator to do. `errno` is the platform's own symbolic code -- `ENOSPC`,
 * `EACCES` -- and is `null` for every refusal that is not a filesystem
 * fault.
 *
 * **It is not the error's message, and cannot become one.** Measured on
 * this tree: every `node:fs` rejection quotes both paths into `message`
 * (`"ENOENT: no such file or directory, copyfile '/…' -> '/…'"`), and a
 * NUL in a path produces `ERR_INVALID_ARG_VALUE` quoting the whole path
 * back. Design spec §7 forbids a path in any log line, so the host reads
 * the `code` property alone and admits it only if it matches
 * `/^[A-Z][A-Z0-9_]*$/` -- see `importErrno` in `host/src/media/import.ts`.
 * Anything else, including an error that carries a path *as* its code,
 * arrives here as `null`.
 */
export interface ImportRefusal {
  readonly refusal: ImportRefusalCode;
  readonly errno: string | null;
}

/**
 * A file now in the library, and which of design spec's two destinations it
 * went to.
 *
 * `'unmatched'` is §6's: the release matched nothing, so there was no title
 * to shape a path from and the file went to `<root>/<unmatched>/<filename>`.
 * Reported rather than inferred by the caller from `file.mediaItemId`,
 * because the branch is the host's to take and a caller re-deriving it would
 * be a second copy of §6's rule.
 */
export interface ImportPlacement {
  readonly placed: 'library' | 'unmatched';
}

export type ImportOutcome = ImportPlacement | ImportRefusal;

/**
 * The already-resolved value of every token the plugin declares, by name.
 *
 * `null` is a resolution, not a failure -- a film with no collection -- and
 * the host resolver drops the segment rather than writing a hole (design
 * spec §8.8).
 */
export type TokenValues = Readonly<Record<string, string | null>>;

/** Puts a finished download in one plugin's library. One per plugin context. */
export interface LibraryImporter {
  /**
   * Copies `file` into this plugin's library, or declines.
   *
   * **`resolveTokens` is a function, not a map, because the host owns the
   * branch that decides whether any token is needed.** Design spec §6 sends
   * an unmatched release to `<root>/<unmatched>/<filename>` with no shape
   * and no tokens at all, and `file.mediaItemId` -- the thing that decides
   * which branch applies -- is the host's to read. Handing over an
   * already-built map would mean every plugin querying its own tables for a
   * title that does not exist, on every unmatched import, and discarding
   * the answer. It is called at most once.
   *
   * **The copy is atomic and it is a copy** (design spec §4): a temporary
   * in the destination directory and then a rename, never a write straight
   * to the final name; and never a move or a hardlink, so nothing leaves
   * the download client and nothing already in the library is touched.
   */
  place(file: DownloadedFile, resolveTokens: () => Promise<TokenValues>): Promise<ImportOutcome>;
}
