/**
 * The write half of the `plugin_destination` wire contract: the codes
 * `PUT /api/destinations/:pluginId` refuses a destination with.
 *
 * **Why these live here and not in the host.** For the reason
 * `./mappings.ts`, `./download-clients.ts` and `./feeds.ts` each measure at
 * length: the same set of strings declared once in the host and again, by
 * hand, in the browser client is a pair that drifts silently, because
 * renaming one half reddens only that half's tests. Declaring them in the
 * package both sides already depend on makes the rename a compile error on
 * both sides.
 *
 * **A code, never a sentence.** Nothing here is prose and nothing here is
 * rendered: the server authors no sentence a human reads, so a client owns
 * its own wording and this list owns only the vocabulary the two sides
 * branch on.
 *
 * **Not every `refusal` that route can answer with is in this list.** It
 * also answers `invalid-shape` and `malformed-body` -- refusals of the
 * *request envelope*, raised before the host is reached at all --
 * which `packages/host/src/api/server.ts` declares;
 * `./feeds.ts`'s doc has the reasoning for keeping those out of a contract
 * module. A `:pluginId` segment that is not a plain identifier is answered
 * `404 { error: 'unknown route' }` and is not a refusal at all, for the
 * reason `mappingIdFrom` gives about an unparseable id.
 *
 * ## Five of these are `media/shape.ts`'s refusals under this route's names
 *
 * `ShapeRefusalCode` is deliberately **host-local** -- its own docblock says
 * so, and says that when a route has to answer one of those conditions "that
 * route's codes belong in the contract and this list stays the host's own".
 * This is that list. The host maps one to the other in
 * `media/destinations.ts`.
 *
 * The mapping is not an identity, and the two places it differs are the
 * point of the renaming:
 *
 * - `escapes-root` becomes **`escaping-shape`**, because `escaping-path`
 *   below is the *unmatched directory's* version of the same rule and a
 *   client showing an error beside the field that caused it has to be able
 *   to tell them apart.
 * - `separator-in-value` has **no code here**, because it cannot happen on
 *   save. The shape is validated by resolving it against a placeholder value
 *   for every token the plugin declares, and that placeholder contains no
 *   separator -- pinned by `test/media/destinations.test.ts`.
 *
 * ## Why the shape's *structure* is refused here at all
 *
 * Design spec §3 requires only that an unknown token be refused on save. The
 * four structural codes go further, and deliberately: the reason §3 gives
 * for validating on save is that "a typo is caught where it is typed, not
 * months later as a wrong path", and `{title` is that same typo. Accepting
 * it would store a shape that refuses at every import for ever, which is the
 * outcome the rule exists to prevent.
 */

/**
 * Every way `PUT /api/destinations/:pluginId` can decline a destination.
 *
 * Grouped by the field each is about, because a client has to put the error
 * beside the input that caused it and no code below is about two fields.
 *
 * The plugin:
 * - `unknown-plugin` -- the `:pluginId` segment is a well-formed plugin id
 *   and no registered plugin has it. Pre-checked against the host's plugin
 *   registry, not caught from a constraint: there is no plugin *table* for a
 *   foreign key to point at.
 *
 * The root:
 * - `not-absolute-root` -- `root` does not begin with `/`.
 * - `unusable-root` -- `root` begins with `/` but is not a directory
 *   *under* `/` spelled exactly as it resolves. Two limbs, and the code is
 *   the one name true of both: `/` itself, which names the whole
 *   filesystem rather than a library; and a value with an empty, `.` or
 *   `..` segment -- `//`, `/lib/`, `/a/./b`, `/lib/../..` -- where the
 *   value stored and the directory actually written to are not the same
 *   place. Refused on save because every one of them was accepted on save
 *   and then refused at *every* import, for ever: `/`, `//` and
 *   `/lib/../..` all answered `escapes-root`, which the importer's own
 *   list defines as reaching outside the root, when nothing had escaped
 *   anything. `host/src/media/shape.ts`'s `rootRefusal` is the one
 *   implementation and both sides call it.
 *
 *   **Whether the root exists is still not checked here.** Design spec §7
 *   is explicit that a root which does not exist is a misconfiguration an
 *   operator should see rather than a directory tree the importer invents,
 *   so that condition is the importer's `missing-root` and arrives at a
 *   log line rather than at this response.
 *
 * The shape:
 * - `unknown-token` -- the shape names a token the **declaring plugin** does
 *   not list in `MediaPlugin.tokens`. `{season}` is valid for television and
 *   invalid for a film; validating against the union of every plugin's
 *   tokens would accept both. The one code that also carries a
 *   {@link DestinationRefusalBody.token}.
 * - `malformed-shape` -- a brace that does not open and close a token.
 * - `backslash-in-shape` -- a literal `\` in the shape text. `/` is the
 *   separator on every platform, and a second spelling of it would lay one
 *   library out two different ways on two hosts.
 * - `escaping-shape` -- the shape is absolute, or one of its segments is
 *   `..`. A `..` *substring* is not this: `Rocky..Balboa` reaches nowhere.
 * - `empty-filename` -- the shape's last segment holds no literal text and
 *   no token, so the shape names a directory and no file.
 *
 * The unmatched directory (design spec §6):
 * - `empty-path` -- `unmatchedDir` names no directory at all, so unmatched
 *   files would land in the library root itself -- unnamed releases
 *   interleaved with organised ones, and no way to tell them apart
 *   afterwards. **Wider than the name**: `''` is the spelling §6 gives and
 *   the one an operator reaches first, but `'.'`, `'./'` and any value
 *   whose every segment is `.` or empty mean the same thing and get the
 *   same code. A client wording this should say "must name a directory",
 *   not "must not be empty". (`host/src/media/import.ts` calls the
 *   identical condition `unmatched-dir-is-root`, which is the better name;
 *   these two lists are separate vocabularies and neither is renamed to
 *   match the other.)
 * - `escaping-path` -- `unmatchedDir` is absolute, or one of its segments is
 *   `..`, under either separator. Nested is allowed: `_pickarr/unmatched` is
 *   a legitimate answer, and the escape check is what governs what it may
 *   reach.
 */
/**
 * The wire shape `PUT /api/destinations/:pluginId` needs -- what the
 * browser sends, not what `packages/host/src/media/destinations.ts`'s
 * `saveDestination` parses it into.
 *
 * **Declared once, here, rather than mirrored on each side of the wire.**
 * It used to be declared twice -- once as `media/destinations.ts`'s own
 * `SaveDestinationInput`, and again as a hand-copied interface in
 * `packages/web`'s `postDestination.ts` -- and issue #88's other three
 * moves left this one behind because the two copies disagreed on
 * `unmatchedDir`'s optionality. That disagreement is real, not a spelling
 * drift, and is resolved by having two *names*: this interface is the wire
 * shape the browser builds, and the host's `SaveDestinationInput` is a
 * derived, parsed form with the same three fields but `unmatchedDir`
 * required-but-nullable instead of optional. A rename of any field here is
 * now a compile error in both `@pickarr/web` and `@pickarr/host`, because
 * the host's type is defined in terms of this one rather than copied from
 * it.
 *
 * `root` and `shape` are `string`, unchecked: this value arrives off a
 * JSON request body and `saveDestination` is the validator that narrows
 * it, not a caller that has already done so.
 *
 * **`unmatchedDir` is optional, and the absence is load-bearing.** A blank
 * unmatched-folder field means "use the host's own default"
 * (`media/destinations.ts`'s `DEFAULT_UNMATCHED_DIR`, design spec §6's
 * `_unmatched`) and must be sent as an *absent* key, not as `''` --
 * `JSON.stringify` drops an `undefined` member, which is exactly this
 * omission, and the host's `empty-path` refusal is what an explicit `''`
 * earns instead. The host's derived `SaveDestinationInput` keeps this key
 * always present (`string | undefined`) because `exactOptionalPropertyTypes`
 * is on there and a route forwarding a value it read off a body has only
 * one meaning for "absent", not two.
 */
export interface SaveDestinationRequest {
  root: string;
  shape: string;
  unmatchedDir?: string;
}

export const DESTINATION_REFUSALS = [
  'unknown-plugin',
  'not-absolute-root',
  'unusable-root',
  'unknown-token',
  'malformed-shape',
  'backslash-in-shape',
  'escaping-shape',
  'empty-filename',
  'empty-path',
  'escaping-path',
] as const;

/**
 * What `PUT /api/destinations/:pluginId` answers a refusal with: the code,
 * and the token name when there is one.
 *
 * **Two fields, where most refusals in this codebase have one**, and the
 * second earns its place the way `ImportRefusal.errno` does. Design spec §3
 * asks for an unknown token to be "refused, naming it", and a settings row
 * listing **eight** tokens with a typo in one of them can tell the operator
 * only that *a* token was wrong without this. Eight is `TV_TOKENS`,
 * counted: the three shipped lists are tv 8, movie 7 and xxx 6, and
 * `settings/Destinations.tsx` renders one `<li>` per declared token, so
 * eight is also the most any row shows. (`resolution` is among them again:
 * issue #98 removed it while it read the lookup state and restored it once
 * it read `rss_item.video_resolution`.)
 *
 * **`token` is `null` for every code but `unknown-token`**, and may be
 * `null` for that one too: the host repeats a name only when it matches the
 * character class a declared token is in, on `api/server.ts`'s `MEDIA_TYPE`
 * precedent. A "token" is arbitrary text an operator typed between braces,
 * and no response body this API composes may carry a url, a path or a query
 * string -- including one the caller supplied. A client must therefore
 * handle `unknown-token` with no name, rather than assuming one.
 *
 * **It is never a sentence.** The client owns the wording, as it does for
 * every code here; this is a datum to put in one.
 */
export interface DestinationRefusalBody {
  refusal: DestinationRefusalCode;
  token: string | null;
}

/**
 * One of {@link DESTINATION_REFUSALS}, as a type.
 *
 * Derived from the array rather than written out beside it, for the reason
 * `./mappings.ts`'s twin gives: a second spelling of the same strings is the
 * duplication this module exists to remove, and it would go stale the same
 * way.
 */
export type DestinationRefusalCode = (typeof DESTINATION_REFUSALS)[number];
