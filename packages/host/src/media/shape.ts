/**
 * Turns a destination **shape** and a map of already-resolved token values
 * into a path relative to a plugin's root, or into a refusal.
 *
 * ```
 * resolveShape('{series}/Season {season}/{series} - S{season}E{episode}.{ext}',
 *              { series: 'Severance', season: '02', episode: '03', ext: 'mkv' })
 *   -> { path: 'Severance/Season 02/Severance - S02E03.mkv' }
 * ```
 *
 * **It knows no schema and no plugin.** Design spec §3 gives each plugin its
 * own declared token list because only a plugin knows whether `{season}`
 * means anything; the plugin resolves its tokens from its own tables and
 * hands the values here as strings. So every rule below is a rule about the
 * *shape of a string*, never about which token it came from.
 *
 * **Nothing here widens a number, and that is the point of the `02` above
 * being an input rather than an output.** This function used to zero-pad any
 * all-digit value to two characters, which is design spec §8.2 for a season
 * and is wrong for a title: the 2009 film *9* landed as `09`, permanently,
 * because §10 puts re-importing out of scope. The signal to tell the two
 * apart does not exist here -- the values arrive as
 * `Record<string, string | null>` with nothing on them saying which is a
 * number -- so the padding moved to the only place that does know, the
 * plugin's own token resolver (`contract`'s `TokenResolver`). A second
 * padder here, disagreeing with that one, would be worse than either.
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
 * **A {@link resolveShape} refusal names the rule and carries nothing from
 * the input** -- no shape text, no token name, no value. **Where it goes,
 * traced rather than assumed:** the plugin logs it (`ctx.log`, which
 * `host.ts` builds as `console.log`) and then throws, and
 * `deliverCompleted`'s catch logs the thrown message. Both are the host's
 * stdout. It does **not** reach `last_error`: `clients/deliver.ts` never
 * calls `failRow` and says so twice in its own comments, and `failRow`'s
 * only caller is `clients/reconcile.ts`, for a download a *client* reported
 * failed, which an import refusal never becomes. Design spec §7's rule is
 * "no path, url or credential reaches a log line", and stdout is the line
 * it means here. `errors.ts:20-49` is this same audit done for the six
 * error classes, and correcting an identical earlier claim.
 *
 * **{@link validateShape} is the one exception, and it is a different
 * caller rather than a loosening.** It is the same parse with the unknown
 * token's *name* kept, for the save-time validator alone
 * (`media/destinations.ts`): there the refusal answers the very request
 * that carried the shape, to the operator who typed it, so naming the token
 * they got wrong is showing someone their own input -- the distinction
 * `sync/tables.ts` draws between a *dictated* value and a *discovered* one.
 * `resolveShape` is a wrapper that builds a fresh one-field object, so the
 * import path cannot receive the name by any arrangement of the call.
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
 * the result.** The host runs on POSIX -- in Docker, which is the supported
 * deployment (`README.md`), or on a POSIX machine for development -- and
 * Windows is out of scope (#99), so there is no second platform whose path
 * rules this module has to reconcile with. A literal backslash anywhere in
 * a shape is still refused (`backslash-in-shape`) rather than carried
 * through: on POSIX it is an ordinary filename character, and a shape that
 * used it would be laying out a library with a character no one types for
 * any reason but a separator.
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
 * A refusal with the offending token name kept -- what {@link validateShape}
 * answers and {@link resolveShape} strips.
 *
 * `token` is the name for `unknown-token` and `null` for every other code,
 * so a caller reads one field rather than switching first.
 */
export interface NamedShapeRefusal extends ShapeRefusal {
  token: string | null;
}

/**
 * One resolved segment, or the refusal that stopped it.
 *
 * A bare `string` would not do: `''` is a legitimate resolution (every
 * token in the segment was null) and has to be told apart from a failure.
 */
type SegmentResult = { text: string } | NamedShapeRefusal;

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
    if (char === '}') return { refusal: 'malformed-shape', token: null };
    if (char !== '{') {
      out += char;
      index += 1;
      continue;
    }
    const close = segment.indexOf('}', index + 1);
    if (close === -1) return { refusal: 'malformed-shape', token: null };
    const name = segment.slice(index + 1, close);
    // An empty name is not a token, and a `{` inside one means the `}` found
    // above closes a later brace rather than this one.
    if (name === '' || name.includes('{')) return { refusal: 'malformed-shape', token: null };
    // `Object.hasOwn`, not `name in values`: `in` walks the prototype, so a
    // token called `toString` or `constructor` would "resolve" against
    // `Object.prototype` on any plain object literal a caller passes.
    // The one refusal that names something from the input. See
    // {@link validateShape} for who may see it and who may not.
    if (!Object.hasOwn(values, name)) return { refusal: 'unknown-token', token: name };
    // `?? null` only satisfies `noUncheckedIndexedAccess`, which types an
    // index read as possibly `undefined`; the declared value type has no
    // `undefined` in it and `Object.hasOwn` has already established the key.
    const value = values[name] ?? null;
    if (value !== null) {
      if (value.includes('/') || value.includes('\\')) return { refusal: 'separator-in-value', token: null };
      // Verbatim. See the module doc on padding for why nothing here widens
      // a number.
      out += value;
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
 * - **A non-final segment that resolves to `''` or to `.` is dropped**, and
 *   a *final* one is refused -- see the last bullet, which is the only
 *   place the two positions differ. Dropping is the whole of §8.8's "no
 *   empty segment", and it cannot produce `//`, a leading separator or a
 *   trailing one, because a dropped segment contributes no separator
 *   either. `.` is dropped rather than refused because it denotes the
 *   directory the path is already in, so removing it does not change where
 *   the path points -- measured: `path.posix.normalize('a/./b')` is
 *   `'a/b'`. `..` is a different matter and is refused below.
 * - **The same drop is what swallows a doubled separator in the shape
 *   itself.** `a//b/{title}.{ext}` resolves to `a/b/…`: the empty segment
 *   between the two slashes is dropped like any other. That is a shape an
 *   operator typed by accident rather than one a value produced, and it
 *   goes through rather than being refused because the result is the path
 *   they plainly meant and nothing about it is ambiguous. Pinned, so the
 *   swallowing is a decision with a witness rather than a side effect.
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
 * the title. `\` is refused on the same rule: on POSIX it is an ordinary
 * character, but a title carrying one would be laying out a library with
 * the one character that means "separator" to anyone who reads the path,
 * and this module does not become the place that spelling is decided.
 *
 * **Non-injectivity alone is not the argument, and this module does not
 * get to pretend it is.** Dropping a null segment is not injective either
 * -- measured: with `{collection}/{series}/{title}.mkv`, both
 * `{collection: null, series: 'S'}` and `{collection: 'S', series: null}`
 * resolve to `S/T.mkv`. Design spec §5 anticipates exactly that ("two
 * releases resolving to one path") and it is designed behaviour, because
 * the collision is *caught*: the second import is refused
 * `destination-exists` and logged. Sanitising merges silently, and that is
 * the difference.
 *
 * `..` is **not** refused as a substring. Design spec **§6** is the one
 * that says a `..` *segment* -- §7 says only "escapes the root" and names
 * no mechanism, so it is not a second witness and this comment used to
 * claim it was. `Rocky..Balboa` reaches nowhere: the segment check below
 * catches every `..` segment, whether it was typed in the shape, supplied
 * whole by one value, or assembled from two values that are each innocent
 * alone.
 *
 * **"Every" there is POSIX, which is the only platform this host runs on
 * (#99).** This paragraph used to hedge three claims about Win32 -- that it
 * trims a trailing space from a component, that it trims a trailing
 * period, that Node's `fs` accepts `/` there -- none of them measurable on
 * the machines available, and the decision is that they do not need to be:
 * the supported deployment is Docker, and Windows is out of scope. One
 * rule that came from that hedging stays, for a reason that holds on
 * POSIX: a value of `'.. '` -- two dots and a trailing space -- is refused
 * by comparing with trailing whitespace stripped. On POSIX it is a legal
 * directory name, but it is one that reads as `..` to every person who
 * looks at the path and that no title ever resolves to by accident, so
 * refusing it costs nothing anyone wanted and keeps a traversal from
 * hiding behind a space. `'...'` and `Arrival.` are what POSIX says they
 * are, and the test suite pins both. A segment of spaces alone (`'   '`)
 * is likewise kept as the directory name POSIX says it is.
 */
export function resolveShape(
  shape: string,
  values: Readonly<Record<string, string | null>>,
): ResolvedShape | ShapeRefusal {
  const result = validateShape(shape, values);
  // **The strip is the boundary, and it is structural.** A fresh object
  // literal carrying `refusal` alone -- not `result`, not a spread, not a
  // `delete` -- so there is no arrangement of this line under which a token
  // name reaches an import-path caller. An import refusal reaches the
  // host's **stdout**, twice: the plugin's `ctx.log` and `deliverCompleted`'s
  // catch. It does not reach `last_error` -- see this module's docblock for
  // the trace. A token name is operator-typed free text, and design spec §7
  // forbids exactly that in a log line.
  return 'refusal' in result ? { refusal: result.refusal } : result;
}

/**
 * {@link resolveShape}'s work, with the unknown token's **name** kept.
 *
 * **Two entry points over one parse, and the split is the point.** The
 * difference is not what is computed -- this function is the whole
 * implementation and `resolveShape` calls it -- but who is allowed to see
 * the name.
 *
 * - **`resolveShape` is the import-time resolver.** Its refusal reaches the
 *   host's stdout -- the plugin's `ctx.log` and then `deliverCompleted`'s
 *   catch -- for a download nobody is looking at, so it carries nothing
 *   from the input. That guarantee is unchanged and
 *   `media/shape.test.ts`'s `assertRefusal` still pins the one-field shape
 *   at every site.
 * - **This is the save-time validator.** Its caller is
 *   `media/destinations.ts`, answering the very request that carried the
 *   shape, to the operator who typed it -- so naming the token they got
 *   wrong is showing someone their own input, the same distinction
 *   `sync/tables.ts` draws between a *dictated* value and a *discovered*
 *   one. Design spec §3 asks for an unknown token "refused, naming it";
 *   this is what makes that possible, and a typo in one of the **seven**
 *   tokens the television plugin declares -- counted from `TV_TOKENS`, and
 *   the longest of the three lists -- is the case it exists for.
 *
 * **What it does not do is decide whether the name is fit to echo.** The
 * name is arbitrary text an operator typed between braces -- it cannot hold
 * `/`, `{` or `}`, and cannot hold `\` either since `backslash-in-shape` is
 * checked first, but it can hold anything else. `media/destinations.ts`
 * holds the character class it will repeat, on `api/server.ts`'s
 * `MEDIA_TYPE` precedent; this function reports what it found.
 */
export function validateShape(
  shape: string,
  values: Readonly<Record<string, string | null>>,
): ResolvedShape | NamedShapeRefusal {
  if (shape.includes('\\')) return { refusal: 'backslash-in-shape', token: null };
  // Checked on the raw shape rather than after the split, because a leading
  // `/` produces an empty first segment, and an empty segment is dropped --
  // so splitting first would turn an absolute shape into a relative one
  // silently. Design spec §7 is what forbids that: a shape that escapes the
  // root is refused before any copy begins.
  if (shape.startsWith('/')) return { refusal: 'escapes-root', token: null };

  const shapeSegments = shape.split('/');
  const resolved: string[] = [];
  for (const [index, segment] of shapeSegments.entries()) {
    const result = resolveSegment(segment, values);
    if ('refusal' in result) return result;
    // `trimEnd` before the comparison: `'.. '` is a legal POSIX name that
    // reads as `..` to anyone looking at the path, and refusing it costs
    // nothing anyone wanted. See the docblock (#99).
    if (result.text.trimEnd() === '..') return { refusal: 'escapes-root', token: null };
    const isLast = index === shapeSegments.length - 1;
    if (result.text === '' || result.text === '.') {
      if (isLast) return { refusal: 'empty-filename', token: null };
      continue;
    }
    resolved.push(result.text);
  }
  return { path: resolved.join('/') };
}

/**
 * Why {@link unmatchedDirSegments} declined, in the one-field shape every
 * refusal in this codebase has.
 *
 * **Not `ShapeRefusalCode`, and the two must not be merged.** An unmatched
 * directory is not a shape: nothing in it is interpolated (design spec §6),
 * so `malformed-shape`, `unknown-token` and `separator-in-value` have no
 * meaning here -- and `empty-filename` has the wrong one, because the last
 * segment of this value is a *directory* rather than a file. What is left
 * is the pair below, and each caller maps it to a code in its own
 * vocabulary: `media/destinations.ts` to `escaping-path`/`empty-path` and
 * `media/import.ts` to `escapes-root`/`unmatched-dir-is-root`.
 *
 * - `escapes-root` -- absolute, or a segment is `..`.
 * - `names-the-root` -- no segment survives, so the value names the library
 *   root itself. `''`, `'.'` and `'./'` are all this.
 */
export type UnmatchedDirRefusalCode = 'escapes-root' | 'names-the-root';

/** A declined unmatched directory. */
export interface UnmatchedDirRefusal {
  refusal: UnmatchedDirRefusalCode;
}

/** An accepted one, as the levels it actually contributes under the root. */
export interface UnmatchedDirPath {
  /** Non-empty, with every `.` and every empty segment already dropped. */
  segments: readonly string[];
}

/**
 * The directory levels an unmatched directory contributes under a plugin's
 * root, or the refusal that stops it -- design spec §6's three rules, in
 * one place.
 *
 * **One implementation, because there were two and they disagreed.**
 * `media/destinations.ts` checks this on save and `media/import.ts` checks
 * it again at import, deliberately: the second is not trust in the first,
 * since a row can predate a rule. But they were two hand-written copies of
 * the same rule, and the save-side copy was missing the `.` drop -- so
 * `'.'`, `'./'` and `'./.'` saved happily and then refused at *every*
 * import, for ever, which is exactly the failure design spec §3 validates
 * on save to prevent. Sharing the function is what makes "checked twice"
 * mean checked twice rather than checked two different ways.
 *
 * **It lives here, beside {@link resolveShape}, because it is the same
 * three rules.** A `..` segment, a `.` segment and an empty segment mean
 * here exactly what that function's docblock argues they mean there,
 * trailing-whitespace note included; co-location is what stops the second
 * copy growing back.
 *
 * **What it deliberately does *not* do is parse.** Design spec §6: the
 * value "is not a token and is not interpolated. It is a literal directory
 * name, so nothing in it resolves and nothing in it can fail to resolve."
 * A directory called `{title}` is a directory called `{title}`, and running
 * this through `resolveShape` -- the obvious way to share code, and the
 * wrong one -- would refuse it as an unknown token.
 *
 * **Split on either separator, the one place a backslash is judged rather
 * than banned.** `resolveShape` refuses `\` anywhere in a shape so that one
 * stored shape cannot lay a library out two ways on two hosts. The hazard
 * is the same here -- `..\..` is one segment under a `/` split and two
 * levels of traversal where `\` separates -- but the remedy differs,
 * because this value is a literal name and `AC\DC` is a name a filesystem
 * accepts. So the check is on the escape, not on the character.
 *
 * Nothing is joined and nothing is rewritten: the caller owns what it does
 * with the surviving levels, and the *stored* value is always the string
 * the operator typed.
 */
export function unmatchedDirSegments(dir: string): UnmatchedDirPath | UnmatchedDirRefusal {
  // On the raw string, before the split, for `resolveShape`'s own reason: a
  // leading separator produces an empty first segment, and an empty segment
  // is dropped -- so splitting first would turn an absolute value into a
  // relative one silently.
  if (dir.startsWith('/') || dir.startsWith('\\')) return { refusal: 'escapes-root' };

  const segments: string[] = [];
  for (const segment of dir.split(/[/\\]/)) {
    // `trimEnd` before the comparison, for the reason `resolveShape`
    // records: `'.. '` reads as `..` to anyone looking at the path, and no
    // one meant it as a directory name.
    if (segment.trimEnd() === '..') return { refusal: 'escapes-root' };
    // An empty segment and a `.` both name the directory the path is
    // already in, so neither contributes a level. `'   '` is not one of
    // them: a directory named with spaces is a directory POSIX permits, and
    // dropping it would store a different name than the operator typed.
    if (segment === '' || segment === '.') continue;
    segments.push(segment);
  }
  // Nothing survived, so `<root>/<unmatched>` is `<root>`. Design spec §6
  // refuses `''` to prevent exactly that outcome -- unnamed releases
  // interleaved with organised ones, indistinguishable afterwards -- and
  // `'.'` reaches it by a different spelling.
  if (segments.length === 0) return { refusal: 'names-the-root' };
  return { segments };
}

/**
 * Why {@link rootRefusal} declined a configured root.
 *
 * Host-local, like {@link UnmatchedDirRefusalCode} and for the same reason:
 * each caller maps it into its own vocabulary. `media/destinations.ts` maps
 * both to `DestinationRefusalCode`s an operator is shown and
 * `media/import.ts` to `ImportRefusalCode`s a log line carries; in this one
 * case both lists happen to spell them the same way.
 *
 * - `not-absolute` -- the root does not begin with `/`.
 * - `unusable` -- it begins with `/` but is not a directory *under* `/`
 *   spelled exactly as it resolves. See {@link rootRefusal} for the whole
 *   condition and for what each spelling costs.
 */
export type RootRefusalCode = 'not-absolute' | 'unusable';

/**
 * Whether a configured library root is one an import can ever write under,
 * or `undefined` when it is.
 *
 * **Both callers, one rule -- which is the fix for a save/import
 * disagreement this module already carries the other half of.** The save
 * (`media/destinations.ts`) and the import (`media/import.ts`) each checked
 * `root.startsWith('/')` and nothing more, so `'/'`, `'//'` and
 * `'/lib/../..'` all saved happily and then refused `escapes-root` at
 * *every* import, for ever. That is precisely the failure
 * {@link unmatchedDirSegments} exists to stop for the unmatched directory,
 * three lines away in the same function, and it was left for the root.
 *
 * **Why each spelling is refused, measured on this tree:**
 *
 * - `'/'` resolves to itself, so a rule written as `resolve(root) !== root`
 *   -- the obvious one -- does **not** catch it. It is refused on its own
 *   merits: the importer's containment check is
 *   `target.startsWith(root + '/')`, which is `startsWith('//')` here and
 *   which no target satisfies, and the reading that would make it work is
 *   worse than the bug -- a library root of `/` puts `<title>/` directories
 *   at the top of the system disk.
 * - `'//'` and `'/lib/../..'` both resolve to `'/'`, so they reach the same
 *   dead containment check. `'/lib/../..'` is the worst of the three: the
 *   settings screen shows what the operator typed and the importer uses
 *   something else, with nothing saying so.
 * - `'/lib/'` and `'/a/./b'` resolve to something *other* than themselves
 *   too. They would import fine, but the stored value and the effective
 *   root differ, which is the same silent disagreement in a case that
 *   happens not to hurt yet.
 *
 * **Spelled out rather than delegated to `node:path`,** for this module's
 * own reason: nothing here imports it (see the docblock), and `resolve`
 * absolutises against the process's working directory, which is not a
 * question a pure rule about a stored string may ask. The condition below
 * is exactly "`resolve(root) === root`, and `root` is not `/`" for every
 * absolute POSIX path -- `resolve` drops `.`, applies `..`, collapses
 * repeated separators and strips a trailing one, and those four are what
 * an empty, `.` or `..` segment spells.
 *
 * A backslash is not judged here. On POSIX it is an ordinary character in a
 * directory name, and unlike a shape -- which this host lays out itself and
 * so may insist on one separator for -- a root is a path the operator's
 * filesystem already has.
 */
export function rootRefusal(root: string): RootRefusalCode | undefined {
  if (!root.startsWith('/')) return 'not-absolute';
  for (const segment of root.slice(1).split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'unusable';
  }
  return undefined;
}

/**
 * The one spelling of a root this host stores, or why it cannot be stored
 * at all.
 *
 * **Why canonicalise on save rather than accept both spellings.** The
 * validity rule is {@link rootRefusal} and both callers still use it --
 * that shared rule is the whole content of the save/import fix this module
 * carries twice over. What this adds is applied on the save side only, and
 * it does not make the two sides disagree: it makes the value they both
 * judge canonical before either judges it. The invariant is
 * `rootRefusal(canonicalRoot(x).root) === undefined` for every `x` this
 * accepts, and `test/media/shape.test.ts` drives it over the same spellings
 * rather than asserting it here.
 *
 * The alternative considered and rejected was a lenient importer: refuse
 * `'/media/tv/'` on save, normalise it at import so an already-stored one
 * still works. That restores exactly the asymmetry that caused the bug --
 * save and import applying different rules to one value -- to spare a case
 * this removes outright.
 *
 * **What each spelling becomes, and why refusal is not the answer for
 * most of them:**
 *
 * - `'/media/tv/'`, `'/media//tv'`, `'/media/./tv'` and `'/media/x/../tv'`
 *   all name the directory `/media/tv`, and an operator who typed one of
 *   them meant that. They are stored as `/media/tv`, so the settings
 *   screen reads back what the importer will use -- which is the half of
 *   the complaint against `'/lib/../..'` that refusing it never fixed.
 * - `'/'`, `'//'` and `'/lib/../..'` reduce to nothing above the root.
 *   They are refused rather than stored as `/`: a library root of `/` puts
 *   `<title>/` directories at the top of the system disk, and it is also
 *   the one value the importer's `target.startsWith(root + '/')` check can
 *   never satisfy.
 * - A `..` that would climb above `/` is refused rather than clamped.
 *   Clamping is how `'/lib/../..'` becomes `/` silently, and silence is
 *   the defect.
 *
 * Still no `node:path`, for this module's standing reason: `resolve`
 * absolutises against the process's working directory, which is not a
 * question to ask of a stored string. The loop below is lexical, and `/`
 * is the separator here on every platform.
 */
export function canonicalRoot(root: string): { root: string } | { refusal: RootRefusalCode } {
  if (!root.startsWith('/')) return { refusal: 'not-absolute' };
  const segments: string[] = [];
  for (const segment of root.slice(1).split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return { refusal: 'unusable' };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return { refusal: 'unusable' };
  return { root: `/${segments.join('/')}` };
}
