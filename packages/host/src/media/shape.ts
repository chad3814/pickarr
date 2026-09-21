/**
 * Turns a destination **shape** and a map of already-resolved token values
 * into a path relative to a plugin's root, or into a refusal.
 *
 * ```
 * resolveShape('{series}/Season {season}/{series} - S{season}E{episode}.{ext}',
 *              { series: 'Severance', season: '2', episode: '3', ext: 'mkv' })
 *   -> { path: 'Severance/Season 02/Severance - S02E03.mkv' }
 * ```
 *
 * **It knows no schema and no plugin.** Design spec §3 gives each plugin its
 * own declared token list because only a plugin knows whether `{season}`
 * means anything; the plugin resolves its tokens from its own tables and
 * hands the values here as strings. So every rule below is a rule about the
 * *shape of a string*, never about which token it came from -- and where
 * that costs something, the cost is written down rather than papered over
 * (see the padding note).
 *
 * **Pure, and it opens nothing.** No `node:fs`, no `node:path`, no clock, no
 * database. Design spec §7 requires a shape that escapes the root to be
 * refused *before* any copy begins; a function that cannot copy satisfies
 * that by construction rather than by ordering, which is why the escape
 * check lives here and not beside the copy.
 *
 * **Every refusal is a value, never a throw** -- the shape `feeds/add.ts`,
 * `clients/add.ts` and `clients/mappings.ts` already answer in, narrowed by
 * callers with `'refusal' in result`. A throw here would be
 * indistinguishable from a bug at the call site, and `deliverCompleted`
 * treats a throw as "leave the row `completed` and retry", which is the
 * right answer for a transient fault and the wrong one for a shape that
 * will never resolve.
 *
 * **A refusal names the rule and carries nothing from the input** -- no
 * shape text, no token name, no value. `last_error` is served by
 * `/api/downloads` as `DownloadRead.lastError` (design spec §7), so
 * anything a refusal carried would leave the host.
 *
 * ---
 *
 * ## Why `node:path` is not imported, which is *not* `clients/paths.ts`'s
 * reason
 *
 * `clients/paths.ts` refuses `node:path` because the paths it handles are
 * **foreign** -- possibly Windows-shaped, from a machine that is not this
 * one -- so this host's platform rules do not apply to them. These paths
 * are **local**: the result is joined to a root on this host and handed to
 * this host's `fs`. That reasoning does not transfer, and the conclusion
 * survives anyway for three different reasons, each measured on this tree
 * with the repo's Node:
 *
 * 1. **Every `node:path` function that would do more than concatenate also
 *    normalises, and normalising deletes the condition §7 requires be
 *    refused.** `path.join('a', '..', 'b')` is `'b'` and
 *    `path.posix.normalize('a/../b')` is `'b'`: a shape that reaches out of
 *    its own directory comes back looking like one that never tried.
 *    Running the check first and `join` after would leave `join` with
 *    nothing to do, since by then no segment is `.`, `..` or empty.
 * 2. **`path.resolve` would make the result absolute against
 *    `process.cwd()`** -- measured: `path.resolve('a/b')` returns a path
 *    under this worktree. This function's contract is a *relative* path for
 *    a caller that owns the root.
 * 3. **A shape is operator-typed configuration, not a host path.** Read
 *    with `path.win32` semantics the same stored shape would mean two
 *    different things on two hosts; `path.win32.normalize('AC/DC')` is
 *    `'AC\\DC'`, which is exactly the silent promotion of a value to a
 *    directory level that {@link ShapeRefusalCode}'s `separator-in-value`
 *    exists to refuse.
 *
 * What is relied on instead: **`/` is the separator, in the shape and in
 * the result, on every platform.** Node's `fs` accepts `/` as a separator
 * on Windows as well as POSIX -- that is documented Node behaviour and this
 * tree cannot measure it, since only darwin was available here. A literal
 * backslash anywhere in a shape is refused (`backslash-in-shape`) rather
 * than carried through, so there is no second spelling for a separator to
 * disagree about.
 */

/**
 * Every way {@link resolveShape} can decline.
 *
 * **Declared here rather than in `@pickarr/contract`, and that is a
 * boundary rather than an oversight.** The contract modules hold the codes
 * a *route* answers with, because a browser client has to branch on the
 * same strings (`contract/src/mappings.ts` has the measurement from the
 * feeds slice). Nothing here reaches a browser: a shape is resolved on the
 * import path, long after any request, and the only externally visible
 * trace of a refusal is that the row stays `completed` and retries. When a
 * route does need to answer one of these -- validating a shape on save,
 * design spec §3 -- that route's codes belong in the contract and this
 * list stays the host's own.
 *
 * - `malformed-shape` -- a brace that does not open and close a token.
 * - `unknown-token` -- the shape names a token the values map has no key
 *   for. Distinct from a key whose value is `null`, which is a resolution
 *   the plugin made and is handled rather than refused.
 * - `backslash-in-shape` -- a literal `\` in the shape text.
 * - `separator-in-value` -- a resolved value contains `/` or `\`.
 * - `escapes-root` -- the shape is absolute, or a segment resolved to `..`.
 * - `empty-filename` -- the shape's last segment resolved to nothing.
 */
export type ShapeRefusalCode =
  | 'malformed-shape'
  | 'unknown-token'
  | 'backslash-in-shape'
  | 'separator-in-value'
  | 'escapes-root'
  | 'empty-filename';

/** A declined resolution, in the one-field shape `MappingRefusal` has. */
export interface ShapeRefusal {
  refusal: ShapeRefusalCode;
}

/** A resolved destination, relative to the plugin's configured root. */
export interface ResolvedShape {
  /** Separated by `/`, with no leading or trailing separator. */
  path: string;
}

/**
 * The minimum width a purely numeric value is padded to, and design spec
 * §8.2's "zero-padded to two digits" in full.
 *
 * **A minimum, not a field width.** An episode of `100` keeps all three
 * digits; truncating to two would name a different episode, and there is no
 * reading of §8.2 under which `S02E00` is the right answer for episode 100.
 */
const MIN_NUMERIC_WIDTH = 2;

/** ASCII digits only, start to end. `[0-9]` rather than `\d` so the class is visible. */
const ALL_DIGITS = /^[0-9]+$/;

/**
 * Zero-pads `value` to {@link MIN_NUMERIC_WIDTH} if it is entirely ASCII
 * digits, and returns it untouched otherwise.
 *
 * **Decided on the shape of the value, because the resolver has no other
 * signal.** It is handed `Record<string, string | null>`; nothing in that
 * says `{season}` is a number and `{series}` is not, and design spec §3 is
 * explicit that only a plugin knows. So "looks like a number" is the whole
 * of the test.
 *
 * **The cost of that, stated rather than discovered later: a one-character
 * all-digit *title* is padded too.** `9` is a real film, and it lands as
 * `09`. That is wrong, it is pinned by a test that says so, and the only
 * fixes available are for the plugin to hand a pre-padded string or for the
 * token list to gain a per-token numeric flag -- neither of which this
 * function can decide on its own. A title of two or more characters is
 * unaffected, because padding to a minimum width of 2 is already satisfied.
 */
function padNumeric(value: string): string {
  if (!ALL_DIGITS.test(value)) return value;
  return value.padStart(MIN_NUMERIC_WIDTH, '0');
}

/**
 * One resolved segment, or the refusal that stopped it.
 *
 * A bare `string` would not do: `''` is a legitimate resolution (every
 * token in the segment was null) and has to be told apart from a failure.
 */
type SegmentResult = { text: string } | ShapeRefusal;

/**
 * Substitutes every `{token}` in one shape segment.
 *
 * **A `{` always opens a token, so a literal brace cannot be written in a
 * shape at all.** That is the trade for the guarantee that no brace ever
 * reaches a path: an operator who typed `{collecton}` gets `unknown-token`
 * where they typed it rather than a directory called `{collecton}` months
 * later. Braces in media filenames are rare; a silently mis-typed token is
 * not.
 *
 * Segments are split before this runs, so a `/` inside a token name is
 * never seen as part of the name -- `{ser/ies}` arrives here as `{ser` and
 * `ies}` and both halves are `malformed-shape`. That is the same answer a
 * name-level check would give, one rule shorter.
 */
function resolveSegment(segment: string, values: Readonly<Record<string, string | null>>): SegmentResult {
  let out = '';
  let index = 0;
  while (index < segment.length) {
    const char = segment[index];
    if (char === '}') return { refusal: 'malformed-shape' };
    if (char !== '{') {
      out += char;
      index += 1;
      continue;
    }
    const close = segment.indexOf('}', index + 1);
    if (close === -1) return { refusal: 'malformed-shape' };
    const name = segment.slice(index + 1, close);
    // An empty name is not a token, and a `{` inside one means the `}` found
    // above closes a later brace rather than this one.
    if (name === '' || name.includes('{')) return { refusal: 'malformed-shape' };
    // `Object.hasOwn`, not `name in values`: `in` walks the prototype, so a
    // token called `toString` or `constructor` would "resolve" against
    // `Object.prototype` on any plain object literal a caller passes.
    if (!Object.hasOwn(values, name)) return { refusal: 'unknown-token' };
    // `?? null` only satisfies `noUncheckedIndexedAccess`, which types an
    // index read as possibly `undefined`; the declared value type has no
    // `undefined` in it and `Object.hasOwn` has already established the key.
    const value = values[name] ?? null;
    if (value !== null) {
      if (value.includes('/') || value.includes('\\')) return { refusal: 'separator-in-value' };
      out += padNumeric(value);
    }
    index = close + 1;
  }
  return { text: out };
}

/**
 * Resolves `shape` against `values`, answering a relative path or a refusal.
 *
 * ## What a token that resolves to nothing produces
 *
 * Design spec §8.8 requires "no empty path segment and no literal
 * `{collection}`" but deliberately does not say what a film with no
 * collection should land as. The rule chosen, and pinned:
 *
 * - **A `null` value contributes nothing to its segment**, and an
 *   **empty-string value is treated identically**. The two are different
 *   inputs and could have had different answers; they do not, because the
 *   difference has no expression in a path -- an absent directory level and
 *   a blank one are the same hole -- and the only other option, refusing
 *   `''`, converts a permanent data condition (a blank title in a plugin's
 *   table) into a retry that no operator action can ever clear. Design spec
 *   §5's retry is safe because the condition it retries on *does* clear.
 * - **A segment that resolves to `''` or to `.` is dropped entirely.**
 *   Dropping is the whole of §8.8's "no empty segment", and it cannot
 *   produce `//`, a leading separator or a trailing one, because a dropped
 *   segment contributes no separator either. `.` is dropped rather than
 *   refused because it denotes the directory the path is already in, so
 *   removing it does not change where the path points -- measured:
 *   `path.posix.normalize('a/./b')` is `'a/b'`. `..` is a different matter
 *   and is refused below.
 * - **A null token inside a segment that survives removes only itself.**
 *   `{title}.{ext}` with a null `ext` is `Arrival.` -- the dot the shape
 *   typed stays, because this function cannot know that dot was there only
 *   for the extension, and deleting literal text an operator wrote would be
 *   an edit to their shape rather than a resolution of it.
 * - **If the shape's *last* segment resolves to nothing, the whole shape is
 *   refused** (`empty-filename`). Dropping it instead would make the last
 *   surviving *directory* the destination file name, which imports a file
 *   under a name the shape never proposed. An empty shape refuses the same
 *   way, and so does one whose filename is entirely null tokens around a
 *   dot.
 *
 * ## Why an untrusted value is refused rather than sanitised
 *
 * A title comes from a metadata provider and `AC/DC` is a real series name.
 * Sanitising it -- to `AC-DC`, `ACDC`, anything -- invents a name the
 * operator never chose, and design spec §10 puts re-importing out of scope,
 * so that invented name is permanent. Worse, it is not injective: a library
 * that already holds a genuine `AC-DC` gains a second series' files in the
 * same directory with nothing recorded. A refusal leaves the row
 * `completed` and logs each tick -- visible, per §5, which is the property
 * that makes refusing safe rather than silent -- and the operator can fix
 * the title. `\` is refused on the same rule and on every platform, not
 * only on Windows where it separates, so that one shape and one title
 * cannot lay out a library two different ways depending on where pickarr
 * runs.
 *
 * `..` is **not** refused as a substring. Design spec §6 and §7 both say a
 * `..` *segment*, and `Rocky..Balboa` reaches nowhere: the segment check
 * below catches every traversal, including one assembled from two values
 * that are each innocent alone.
 */
export function resolveShape(
  shape: string,
  values: Readonly<Record<string, string | null>>,
): ResolvedShape | ShapeRefusal {
  if (shape.includes('\\')) return { refusal: 'backslash-in-shape' };
  // Checked on the raw shape rather than after the split, because a leading
  // `/` produces an empty first segment, and an empty segment is dropped --
  // so splitting first would turn an absolute shape into a relative one
  // silently, which is the one outcome design spec §6 names.
  if (shape.startsWith('/')) return { refusal: 'escapes-root' };

  const shapeSegments = shape.split('/');
  const resolved: string[] = [];
  for (const [index, segment] of shapeSegments.entries()) {
    const result = resolveSegment(segment, values);
    if ('refusal' in result) return result;
    if (result.text === '..') return { refusal: 'escapes-root' };
    const isLast = index === shapeSegments.length - 1;
    if (result.text === '' || result.text === '.') {
      if (isLast) return { refusal: 'empty-filename' };
      continue;
    }
    resolved.push(result.text);
  }
  return { path: resolved.join('/') };
}
