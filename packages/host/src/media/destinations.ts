/**
 * The one writer of `plugin_destination`: where a plugin's library lives,
 * what shape a path under it takes, and where an unmatched release goes
 * (design spec §3 and §6).
 *
 * **An upsert, and one function rather than an add and an edit.** A plugin
 * either has a destination or it does not -- the table's grain is one row
 * per plugin, enforced by migration 20's unique index -- so there is no
 * create/update distinction for a caller to make, and no id for it to hold.
 * `clients/mappings.ts` next door is three functions because a client may
 * have any number of mappings and each is addressed by its own id; that
 * shape does not transfer.
 *
 * **Every refusal is a value, never a throw** -- the shape `feeds/add.ts`,
 * `clients/add.ts`, `clients/mappings.ts` and `media/shape.ts` already
 * answer in, narrowed by callers with `'refusal' in result`. As there, that
 * is narrower than "never throws": a SQLite error is rethrown untouched,
 * reaches `api/server.ts`'s outermost handler and becomes a 500, which is
 * where an infrastructure fault belongs.
 *
 * **No refusal carries anything from the input, with one gated exception.**
 * Not the root, not the shape, not the plugin id. A refusal says which rule
 * was broken and nothing about the value that broke it -- the rule
 * `clients/mappings.ts` and `media/shape.ts` both state, and a root *is* a
 * path.
 *
 * The exception is the token, and it is design spec §3's requirement rather
 * than a relaxation of the rule: §3 says the host "refuses an unknown
 * token, **naming it**", and a settings screen listing the seven tokens the
 * television plugin declares can otherwise tell the operator only that *a*
 * token was wrong. This module declined that for one round and the decision
 * was reversed; {@link DestinationRefusal.token} carries the name and
 * `api/server.ts` sends it as `DestinationRefusalBody.token`.
 *
 * **What keeps that from being a hole is {@link ECHOABLE_TOKEN}**, not the
 * caller's good manners. A "token" is arbitrary text an operator typed
 * between braces, so the name is repeated only when it matches the class a
 * declared token is in; anything else is refused `unknown-token` with
 * `token: null`. Every other code carries `null` unconditionally.
 *
 * ---
 *
 * ## The shape is validated by resolving it, not by a second parser
 *
 * `resolveShape` (`media/shape.ts`) is handed the shape and a map holding
 * {@link SHAPE_PROBE_VALUE} under every token the plugin declares. An
 * unknown token is then `resolveShape`'s own `unknown-token`, because the
 * map has no key for it.
 *
 * **The alternative was a token extractor here, and it was rejected because
 * the two would drift.** A shape accepted on save and refused at every
 * import is exactly the failure design spec §3 validates on save to prevent,
 * and it is what a save-time check with its own idea of brace syntax
 * eventually produces. Resolving against a probe makes "accepted on save"
 * mean "this shape resolves, for values that are non-empty and contain no
 * separator" -- one function's answer, given twice.
 *
 * **What that does not promise, stated so it is not discovered later.** The
 * values are not known on save, so three of `resolveShape`'s refusals remain
 * reachable at import against a shape this module accepted: a value carrying
 * `/` or `\` (`separator-in-value`), a value that is exactly `..`
 * (`escapes-root`), and a filename whose every token resolved to nothing
 * (`empty-filename`). Those are conditions of the data, not of the shape,
 * and design spec §5's retry is what handles them.
 *
 * ## `unmatched_dir` is not run through the resolver, deliberately
 *
 * Design spec §6: "It is not a token and is not interpolated. It is a
 * literal directory name, so nothing in it resolves and nothing in it can
 * fail to resolve." Handing it to `resolveShape` would refuse a directory
 * literally called `{title}` as an unknown token, which is a rule the spec
 * does not have. Its three checks go through `unmatchedDirSegments`
 * instead -- the same function `media/import.ts` calls, and not a copy;
 * the comment at the call site below has the account of what two copies
 * cost. The root now takes the same route, through `canonicalRoot` here
 * and `rootRefusal` at the import -- one rule, and this side additionally
 * settles which spelling is stored.
 *
 * Synchronous, like `addMapping` and `addFeed`: `node:sqlite` is synchronous
 * -- this repo's documented exception to preferring an async API -- and this
 * is one prepared statement. The `Host` method wrapping it is `async` only
 * because the interface it satisfies is.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DestinationRefusalCode, SaveDestinationRequest } from '@pickarr/contract';
import { canonicalRoot, unmatchedDirSegments, validateShape } from './shape.ts';
import type { ShapeRefusalCode } from './shape.ts';

/**
 * Where an unmatched release lands when no destination names a directory --
 * design spec §6.
 *
 * **Here and nowhere else.** Migration 20 gives the column no `DEFAULT`, so
 * this constant is the whole of the rule: two spellings of one default is
 * the drift, and migration 19's docblock has the measured account of what a
 * column default on a synced table costs once SQLite has no `ALTER COLUMN`
 * to remove it.
 */
export const DEFAULT_UNMATCHED_DIR = '_unmatched';

/**
 * The value every declared token resolves to while a shape is being
 * validated.
 *
 * **Exported for one test, and that test is load-bearing.** It must contain
 * no `/` and no `\`, or an ordinary shape would come back
 * `separator-in-value` -- the one `ShapeRefusalCode` this route has no code
 * for, and which {@link destinationRefusalFor} therefore treats as a bug.
 * It must also be non-empty, or every shape's last segment would resolve to
 * nothing and `empty-filename` would refuse them all.
 *
 * A single character, and an unremarkable one: nothing downstream reads it.
 * It used to be documented as "not a digit, because `padNumeric` would
 * widen one" -- `media/shape.ts` no longer pads anything, so that reason is
 * gone and the choice is now arbitrary rather than load-bearing.
 */
export const SHAPE_PROBE_VALUE = 'x';

/**
 * What `Host.saveDestination` needs to write one plugin's destination:
 * `@pickarr/contract`'s `SaveDestinationRequest`, parsed.
 *
 * **Derived from the wire shape, not a second hand-copy of it.** Issue #88
 * moved `AddFeedInput`, `AddDownloadClientInput`, `AddMappingInput` and
 * `EditMappingInput` into `@pickarr/contract` and left this one behind,
 * because this is where the two sides of the wire genuinely disagree
 * rather than merely repeat each other: `unmatchedDir` is optional on the
 * wire and required-but-nullable here (see below). Two *names* -- this one
 * and `SaveDestinationRequest` -- still have to mean the same three
 * fields, so this type is written as a transform of that one rather than
 * copied from it: renaming or removing a field there is a compile error
 * here too (see below for why adding one also is), without either side's
 * optionality claim about `unmatchedDir` being lost.
 *
 * **Every field is a primitive and none is optional**, for the reason
 * `AddDownloadClientInput` and `AddMappingInput` each give at length: these
 * values arrive unchecked out of a JSON request body and this module is the
 * validator that narrows them.
 *
 * `unmatchedDir` is **required-but-nullable rather than optional**, the
 * shape `ReadServerDeps.host` uses and for the same reason:
 * `exactOptionalPropertyTypes` is on, so an optional property would make
 * "absent" and "explicitly undefined" two different things for a route
 * forwarding a value it read off a body, and there is only one thing they
 * could mean here -- use the default.
 *
 * **Written as three indexed-access fields, not a mapped type over
 * `Required<SaveDestinationRequest>`.** The mapped-type spelling was tried
 * first and types this file's own uses correctly, but loses the
 * `| undefined` half of `unmatchedDir` the moment something else maps over
 * *this* type in turn -- `test/media/destinations.test.ts`'s
 * `Partial<SaveDestinationInput>` did, and `exactOptionalPropertyTypes`
 * then refused the test's own `unmatchedDir: undefined` probes. A mapped
 * type remembers modifiers, not values, when nested; indexed access on
 * each field name does not have that failure mode, and still turns a
 * rename or removal on `SaveDestinationRequest` into a compile error here
 * (`SaveDestinationRequest['unmatchedDir']` stops resolving).
 *
 * **Indexed access alone does not catch a field added to
 * `SaveDestinationRequest`.** Three named fields read off it type-check
 * whether or not a fourth exists; an addition there would silently stay
 * unparsed and unwritten here. {@link saveDestinationKeysMatch} below is
 * the other half: a type-level assertion that the two interfaces' key sets
 * are exactly equal, so an added field fails the build here too instead of
 * only failing quietly at runtime.
 *
 * The plugin id is **not** a field. It comes from the request path, so
 * putting it in the body too would give one request two places to name a
 * plugin and a way for them to disagree; `editMapping` keeps its `id` out of
 * `EditMappingInput` for the same reason.
 */
export interface SaveDestinationInput {
  root: SaveDestinationRequest['root'];
  shape: SaveDestinationRequest['shape'];
  unmatchedDir: SaveDestinationRequest['unmatchedDir'];
}

/**
 * The other half of {@link SaveDestinationInput}'s field-parity claim:
 * every key of `SaveDestinationRequest` is a key of `SaveDestinationInput`
 * and back again.
 *
 * **Why indexed access alone is not enough.** `SaveDestinationInput`'s three
 * fields are each written as `SaveDestinationRequest['<name>']`, which is a
 * compile error the moment a named field is renamed or removed -- the
 * indexed type stops resolving. It is not a compile error when a field is
 * *added* to `SaveDestinationRequest`: nothing here reads it, so nothing
 * here notices. This type computes `never` unless the two interfaces'
 * key sets are identical, and assigning it to `true` below is what turns
 * that into a build failure rather than a silent gap -- add a field to one
 * side without the other and this line stops type-checking.
 */
type SaveDestinationKeysMatch = [
  Exclude<keyof SaveDestinationRequest, keyof SaveDestinationInput>,
  Exclude<keyof SaveDestinationInput, keyof SaveDestinationRequest>,
] extends [never, never]
  ? true
  : never;
const saveDestinationKeysMatch: SaveDestinationKeysMatch = true;
// Referenced so a linter does not flag this type-only assertion as unused.
void saveDestinationKeysMatch;

/**
 * Why a destination write declined, returned as a value rather than thrown
 * -- the one-field shape `MappingRefusal`, `AddFeedRefusal` and
 * `ShapeRefusal` already have, so `api/server.ts` narrows all of them with
 * `'refusal' in result`.
 *
 * The codes are `@pickarr/contract`'s `DESTINATION_REFUSALS`, not this
 * file's, because the browser client has to agree with them exactly to pick
 * the right sentence; that module's own doc has the reasoning and the
 * mapping from `ShapeRefusalCode`.
 */
export interface DestinationRefusal {
  refusal: DestinationRefusalCode;
  /**
   * The token `unknown-token` is about, or `null` -- see
   * {@link ECHOABLE_TOKEN} for when a name is repeated and when it is not.
   *
   * Required-but-nullable rather than optional, the shape
   * `ImportRefusal.errno` has and for the same reason
   * `SaveDestinationInput.unmatchedDir` gives:
   * `exactOptionalPropertyTypes` is on, so an optional property would make
   * "absent" and "explicitly null" two different things for a route
   * serialising this, and there is only one thing they could mean.
   */
  token: string | null;
}

/**
 * What this module needs from the host.
 *
 * `tokensFor` is a **function**, not the plugin registry and not the `Host`
 * -- the shape every other write rule here takes (`addFeed`'s
 * `isRegistered`, `addDownloadClient`'s `saveSecret`). Only `host.ts` holds
 * the registered plugins, and a module under `src/media` importing it would
 * be a cycle; a function closed over that map is all this needs, and it is
 * also all this may have. `undefined` for a plugin nothing registered is the
 * whole of the `unknown-plugin` check.
 */
export interface SaveDestinationDeps {
  raw: DatabaseSync;
  now: () => number;
  tokensFor: (pluginId: string) => readonly string[] | undefined;
}

/**
 * `SHAPE_PROBE_VALUE` under each of `tokens`, which is what turns
 * `resolveShape`'s `unknown-token` into "this plugin does not declare that".
 *
 * `Object.fromEntries` rather than a `Map`: `resolveShape` reads its values
 * with `Object.hasOwn`, which is prototype-safe on a plain object -- a token
 * called `toString` is unknown, pinned by `host/test/media/shape.test.ts`'s
 * `a token named after an \`Object.prototype\` member is unknown, not
 * inherited from the prototype`, which is the only test of it anywhere.
 * `fromEntries` defines rather than assigns, so even a token called
 * `__proto__` lands as an own property instead of replacing the
 * prototype.
 */
function probeValues(tokens: readonly string[]): Record<string, string> {
  return Object.fromEntries(tokens.map((token) => [token, SHAPE_PROBE_VALUE]));
}

/**
 * A refusal naming no token -- the nine `DESTINATION_REFUSALS` that are not
 * `unknown-token`, and the `unknown-token` whose name {@link ECHOABLE_TOKEN}
 * will not let this host repeat.
 */
function refuse(code: DestinationRefusalCode): DestinationRefusal {
  return { refusal: code, token: null };
}

/**
 * What an unknown token has to look like for this host to repeat it back.
 *
 * **`api/server.ts`'s `MEDIA_TYPE` precedent, and its reasoning verbatim.**
 * A "token" here is whatever an operator typed between braces: it cannot
 * hold `/`, `{` or `}` (the parse would have refused it first) and cannot
 * hold `\` (`backslash-in-shape` is checked before any token is read), but
 * `{http:host/x?apikey=k}` minus its slashes is still a query string, and
 * no response body this API composes may carry one -- the rule does not
 * carve out a value because the caller supplied it. So a name outside this
 * class is refused `unknown-token` *without* being repeated, and the rule
 * holds for every possible input rather than for the inputs that were
 * thought of.
 *
 * The class is what a declared token is: a short camelCase word.
 * `releaseDate` is the longest any plugin declares, and a typo of a real
 * token is overwhelmingly in the same class as the token it missed. Where
 * it is not, the operator still gets `unknown-token` and the settings
 * screen still holds the shape they typed.
 */
const ECHOABLE_TOKEN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/**
 * One of `media/shape.ts`'s refusals, as the code this route answers with.
 *
 * Every case is written out rather than a `default`, so a **seventh**
 * `ShapeRefusalCode` added later is a compile error here instead of
 * silently taking whichever code the default named. (There are six today
 * -- `shape.ts:128-134`. `media/import.ts` and `contract/library.ts` both
 * say "seventh"; this line said "sixth" and was the one out of step.)
 *
 * **`separator-in-value` throws, and that is not a refusal being swallowed.**
 * It reports that a *value* carried a separator, and the only values this
 * module supplies are copies of {@link SHAPE_PROBE_VALUE}, which has none
 * -- so reaching this branch means this module handed the resolver something
 * other than the probe, which is a bug in it rather than a fault in the
 * operator's input. A throw becomes `api/server.ts`'s 500, which is where a
 * bug belongs; answering an operator-facing refusal would blame them for it.
 */
function destinationRefusalFor(code: ShapeRefusalCode): DestinationRefusalCode {
  switch (code) {
    case 'malformed-shape':
      return 'malformed-shape';
    case 'unknown-token':
      return 'unknown-token';
    case 'backslash-in-shape':
      return 'backslash-in-shape';
    case 'escapes-root':
      // Renamed on the way out: `escaping-path` is the unmatched directory's
      // version of this rule, and a client has to be able to say which field
      // was wrong. See `DESTINATION_REFUSALS`.
      return 'escaping-shape';
    case 'empty-filename':
      return 'empty-filename';
    case 'separator-in-value':
      throw new Error('a shape probe value contained a path separator');
  }
}

/**
 * Writes `pluginId`'s destination, answering `{ id }` or a refusal.
 *
 * **The order the checks run in is a property, not an accident.** The plugin
 * is resolved first, so a caller naming an unregistered plugin is told that
 * and nothing else -- checking the root or the shape first would let the
 * code that came back say which plugin ids exist. After that the order is
 * field order (root, shape, unmatched directory), and no test depends on
 * it: `setup`'s defaults are a destination every plugin accepts, so a test
 * expecting a refusal names the one field it is about. The one exception
 * is deliberate and is about the *first* check rather than the rest --
 * `destinations.test.ts`'s `the plugin is checked before anything else, so
 * an unknown one cannot be told what else was wrong` sets a bad plugin, a
 * bad root, a bad shape and a bad unmatched directory at once, and pins
 * that the plugin still wins.
 *
 * **Nothing is scheduled afterwards**, the same as `Host.addMapping` and for
 * a reason of the same kind: the importer reads this table at the moment it
 * imports, so a changed destination is in force at the next delivery tick
 * with nothing to invalidate and nothing to enqueue.
 *
 * **`ON CONFLICT (plugin_id) DO UPDATE`, not a `SELECT` and a branch.** Two
 * concurrent saves for one plugin would both pass a pre-check and then race
 * the unique index, which is the reasoning `clients/add.ts`,
 * `clients/pick.ts` and `clients/mappings.ts` each record for catching a
 * constraint rather than pre-checking it. Here the constraint is not merely
 * caught, it is *handled by the statement*: there is no refusal for "already
 * has one", because having one is the ordinary case.
 *
 * **`created_at` is not in the `SET` list**, so a row keeps the time it was
 * first configured; `updated_at` always is, including when every value is
 * unchanged. An `UPDATE` writing the values already there is still a write,
 * and the sync trigger logs it -- which is what tells a replica the operator
 * confirmed the setting.
 *
 * **`RETURNING id` rather than `lastInsertRowid`.** On the conflict branch
 * nothing is inserted, so `lastInsertRowid` would answer whatever this
 * connection last inserted -- a different table's row, or 0 on a fresh
 * connection. `RETURNING` answers the row the statement actually touched on
 * both branches.
 */
export function saveDestination(
  deps: SaveDestinationDeps,
  pluginId: string,
  input: SaveDestinationInput,
): { id: number } | DestinationRefusal {
  const tokens = deps.tokensFor(pluginId);
  if (tokens === undefined) return refuse('unknown-plugin');

  // Delegated to `media/shape.ts`, not checked here, and for the same
  // reason the unmatched directory below is: `startsWith('/')` was the
  // whole of this rule and `media/import.ts` carried its own copy of the
  // identical line, so `'/'`, `'//'` and `'/lib/../..'` saved happily and
  // then refused `escapes-root` at *every* import -- the exact failure §3
  // validates on save to prevent, with the same shape as the `.` hole
  // fixed for `unmatched_dir` twenty lines down. One function, called from
  // both sides, is what makes "checked twice" mean checked twice.
  //
  // Still not `node:path`: these are pure string rules, because `resolve`
  // absolutises against the host's working directory and that is not a
  // question to ask of a stored value. `/` is the separator here, in the
  // shape and in the result, on every platform.
  //
  // `canonicalRoot`, not `rootRefusal`, and only on this side: it applies
  // that same rule and additionally settles *which* spelling gets stored.
  // `'/media/tv/'` named a directory the importer could write to, but was
  // refused for its trailing separator -- a real regression for a root
  // stored before this branch, breaking every import for an operator who
  // never opened settings. It is stored as `/media/tv` instead. The import
  // side goes on calling `rootRefusal`, which canonical values always
  // pass, so the two sides still judge one value by one rule.
  const canonical = canonicalRoot(input.root);
  if ('refusal' in canonical) {
    return refuse(canonical.refusal === 'not-absolute' ? 'not-absolute-root' : 'unusable-root');
  }

  // `validateShape`, not `resolveShape`: the same parse, with the unknown
  // token's name kept. That entry point exists for this caller alone --
  // the refusal answers the very request that carried the shape, to the
  // operator who typed it, where `resolveShape`'s goes to the host's stdout
  // (the plugin's `ctx.log`, then `deliverCompleted`'s catch) for a
  // download nobody asked about. `media/shape.ts`'s docblock has the trace,
  // including why it is stdout and not `last_error`.
  const resolved = validateShape(input.shape, probeValues(tokens));
  if ('refusal' in resolved) {
    const code = destinationRefusalFor(resolved.refusal);
    // Named only when the name is one this host will repeat. Every other
    // code carries `null`, so a client reads one field rather than
    // switching on the code first.
    return resolved.token !== null && ECHOABLE_TOKEN.test(resolved.token)
      ? { refusal: code, token: resolved.token }
      : refuse(code);
  }

  const unmatchedDir = input.unmatchedDir ?? DEFAULT_UNMATCHED_DIR;
  // Delegated to `media/shape.ts`, not checked here, and that is the fix
  // for a hole this module shipped: it had its own copy of design spec
  // §6's rules, the copy was missing `resolveShape`'s `.` drop, and so
  // `'.'`, `'./'` and `'./.'` saved happily and then refused at *every*
  // import -- the exact failure §3 validates on save to prevent.
  // `media/import.ts` checks the same value again through the same
  // function, so "checked twice" now means checked twice rather than
  // checked two different ways.
  //
  // Nothing trims, there or here. A directory named with spaces is one
  // every filesystem this host writes to permits, and trimming would store
  // a different name than the operator typed -- `clients/mappings.ts`'s
  // `emptyPathRefusal` records the same decision for the same reason, and
  // `test/media/destinations.test.ts` pins it, because a comment is not a
  // check.
  const unmatched = unmatchedDirSegments(unmatchedDir);
  if ('refusal' in unmatched) {
    // Two codes, not one: a client has to put the error beside the input
    // that caused it, and `escaping-path` and `empty-path` are different
    // things for an operator to fix. `names-the-root` maps to `empty-path`
    // because `''` is the spelling §6 names and the one an operator
    // reaches first; that code's own doc in `@pickarr/contract` carries
    // the full condition, which is wider than the name.
    return refuse(unmatched.refusal === 'escapes-root' ? 'escaping-path' : 'empty-path');
  }

  const at = deps.now();
  const row = deps.raw.prepare(`
    INSERT INTO plugin_destination
      (plugin_id, root, shape, unmatched_dir, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (plugin_id) DO UPDATE SET
      root          = excluded.root,
      shape         = excluded.shape,
      unmatched_dir = excluded.unmatched_dir,
      updated_at    = excluded.updated_at
    RETURNING id
  `).get(pluginId, canonical.root, input.shape, unmatchedDir, at, at);
  // Not a cast: `RETURNING id` on a statement that inserts or updates
  // exactly one row always answers one, so an absent row is this module
  // being wrong about its own SQL rather than a condition a caller caused --
  // and a 500 is where that belongs. `'id' in row` narrows exactly as far as
  // the check proves, the pattern `isConstraintViolation` uses next door.
  if (row === undefined || !('id' in row)) {
    throw new Error('the destination upsert returned no id');
  }
  return { id: Number(row.id) };
}
