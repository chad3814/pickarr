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
 * - `not-absolute-root` -- `root` does not begin with `/`. Nothing else
 *   about it is checked; design spec §7 is explicit that a root which does
 *   not exist is a misconfiguration an operator should see rather than a
 *   directory tree the importer invents.
 *
 * The shape:
 * - `unknown-token` -- the shape names a token the **declaring plugin** does
 *   not list in `MediaPlugin.tokens`. `{season}` is valid for television and
 *   invalid for a film; validating against the union of every plugin's
 *   tokens would accept both.
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
 * - `empty-path` -- `unmatchedDir` is `''`, which would mean "put unmatched
 *   files in the library root" -- unnamed releases interleaved with
 *   organised ones, and no way to tell them apart afterwards.
 * - `escaping-path` -- `unmatchedDir` is absolute, or one of its segments is
 *   `..`, under either separator. Nested is allowed: `_pickarr/unmatched` is
 *   a legitimate answer, and the escape check is what governs what it may
 *   reach.
 */
export const DESTINATION_REFUSALS = [
  'unknown-plugin',
  'not-absolute-root',
  'unknown-token',
  'malformed-shape',
  'backslash-in-shape',
  'escaping-shape',
  'empty-filename',
  'empty-path',
  'escaping-path',
] as const;

/**
 * One of {@link DESTINATION_REFUSALS}, as a type.
 *
 * Derived from the array rather than written out beside it, for the reason
 * `./mappings.ts`'s twin gives: a second spelling of the same strings is the
 * duplication this module exists to remove, and it would go stale the same
 * way.
 */
export type DestinationRefusalCode = (typeof DESTINATION_REFUSALS)[number];
