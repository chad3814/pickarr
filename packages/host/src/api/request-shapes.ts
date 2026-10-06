import type { AddDownloadClientInput, AddFeedInput, AddMappingInput, EditMappingInput, FetchHostPatch, IdentifyRequest } from '@pickarr/contract';
import type { SaveDestinationInput } from '../media/destinations.ts';

/**
 * The shape guard for every write route's body -- an `is*Body` predicate
 * per `POST`/`PATCH`/`PUT` route, except the two bodies with optional
 * fields a predicate cannot honestly express: `destinationBodyFrom` and
 * `fetchHostPatchFrom` read those instead, returning the body as its typed
 * input, or `undefined` for a body of the wrong shape.
 *
 * Split out of `server.ts` (issue #89): body-shape validation is not
 * routing. None of these checks a field's *value* -- only that a required
 * one is present and that each is of the right primitive type -- because
 * the value-level invariants belong to whichever host function the route hands the body to:
 * per `server.ts`'s module doc, no business rule belongs in a shape guard
 * either.
 */

/**
 * Whether `value` has the shape `POST /api/feeds` needs: every field
 * present, and a primitive of the right type. Nothing here checks a field's
 * *value* -- a registered plugin, a real transport, a poll interval in range
 * -- because that is `addFeed`'s job (`../feeds/add.ts`'s module doc), and
 * checking it twice is how the two checks drift apart.
 *
 * `'pluginId' in value` rather than a cast to `Record<string, unknown>`:
 * `value` is `unknown` off a json-parsed body, and `in` narrows it exactly as
 * far as each check proves, the same pattern `feeds/add.ts`'s own
 * `isUniqueConstraintViolation` uses.
 */
export function isFeedBody(value: unknown): value is AddFeedInput {
  return typeof value === 'object' && value !== null
    && 'pluginId' in value && typeof value.pluginId === 'string'
    && 'name' in value && typeof value.name === 'string'
    && 'url' in value && typeof value.url === 'string'
    && 'downloadType' in value && typeof value.downloadType === 'string'
    && 'pollIntervalS' in value && typeof value.pollIntervalS === 'number';
}

/**
 * Whether `value` has the shape `POST /api/download-clients` needs: every
 * field present, and a string. Nothing here checks a field's *value* -- a
 * real implementation, a usable auth shape, a url that is an address --
 * because that is `addDownloadClient`'s job (`../clients/add.ts`'s module
 * doc), and checking it twice is how the two checks drift apart.
 *
 * **Every credential field is required, not optional**, and an unsupplied
 * one is `''`. The distinction is load-bearing rather than tidy: the host
 * reads `''` as "this strategy sends no such credential" and decides the
 * auth shape from which of the three are blank, so a body that *omits*
 * `apiKey` rather than sending it empty would arrive as `undefined` and be
 * read as a shape the operator never chose. Requiring the field makes the
 * client state its intent.
 *
 * **`type` is not a field and is not read even if sent.** The host derives
 * it from `implementation` (design spec §4 and §8.3), because
 * `readClientConfig` treats a `type`/`implementation` mismatch as fatal --
 * so accepting one from a browser would be accepting the ability to
 * construct a row that can never work. An extra property on the body is
 * simply ignored, the same way it is for `POST /api/feeds`.
 *
 * `'name' in value` rather than a cast to `Record<string, unknown>`:
 * `value` is `unknown` off a json-parsed body, and `in` narrows it exactly
 * as far as each check proves -- the same pattern `isFeedBody` above uses.
 */
export function isDownloadClientBody(value: unknown): value is AddDownloadClientInput {
  return typeof value === 'object' && value !== null
    && 'name' in value && typeof value.name === 'string'
    && 'implementation' in value && typeof value.implementation === 'string'
    && 'url' in value && typeof value.url === 'string'
    && 'category' in value && typeof value.category === 'string'
    && 'apiKey' in value && typeof value.apiKey === 'string'
    && 'username' in value && typeof value.username === 'string'
    && 'password' in value && typeof value.password === 'string';
}

/**
 * Whether `value` has the shape `POST /api/picks` needs: one field, and a
 * number.
 *
 * Nothing here checks the *value* -- not that the id names a row, not that
 * its feed has a registered plugin, not that a client of the right type
 * exists, and not that this release has already been picked. Every one of
 * those is `requestPick`'s (`../clients/pick.ts`'s module doc), and
 * checking any of them twice is how the two checks drift apart. The
 * `unknown-release` refusal is what an id naming nothing gets, and it comes
 * from the host rather than from here.
 *
 * **`typeof … === 'number'` and no more**, deliberately: this does not
 * reject a non-integer, a negative or `NaN`. Measured against a migrated
 * database holding one `rss_item` at id 1, each of `1.5`, `-1` and `NaN`
 * comes back from `ownerPluginId`'s join as `undefined` -- so each already
 * has a correct answer, `unknown-release`, and adding the check here would
 * be this module deciding what an id may look like, which is a value-level
 * rule about a table it can see none of.
 *
 * **The `typeof` half is not decoration, and the obvious reason for it is
 * wrong.** The same measurement: `'1'`, the string an id arrives as when a
 * caller forgets to parse it, **matches the row** -- SQLite applies the
 * column's INTEGER affinity to the bound text and compares it as a number.
 * So a string id would not "silently match nothing"; it would silently
 * *work*, and this route would be quietly accepting a wire shape it does
 * not declare, which the browser client is then free to depend on. The
 * guard is what keeps `{ rssItemId: number }` true of what the host is
 * actually asked.
 *
 * `'rssItemId' in value` rather than a cast to `Record<string, unknown>`:
 * `value` is `unknown` off a json-parsed body, and `in` narrows it exactly
 * as far as the check proves -- the same pattern `isFeedBody` and
 * `isDownloadClientBody` above use.
 */
export function isPickBody(value: unknown): value is { rssItemId: number } {
  return typeof value === 'object' && value !== null
    && 'rssItemId' in value && typeof value.rssItemId === 'number';
}

/**
 * `POST /api/releases/:id/identify`'s body: one of three modes. A `name` must
 * have something in it once trimmed; {@link trimIdentifyBody} then strips the
 * padding, so the host and the plugin see the operator's words without it.
 * Extra keys are tolerated, as in the other body guards here.
 */
export function isIdentifyBody(value: unknown): value is IdentifyRequest {
  if (typeof value !== 'object' || value === null || !('mode' in value)) return false;
  switch (value.mode) {
    case 'requery':
      return true;
    case 'name':
      return 'name' in value && typeof value.name === 'string' && value.name.trim() !== '';
    case 'media-item':
      return 'mediaItemId' in value && typeof value.mediaItemId === 'number' && Number.isInteger(value.mediaItemId);
    default:
      return false;
  }
}

/** The body with a `name`'s ends trimmed (inner runs are the lookup service's business); other modes unchanged. */
export function trimIdentifyBody(body: IdentifyRequest): IdentifyRequest {
  return body.mode === 'name' ? { mode: 'name', name: body.name.trim() } : body;
}

/**
 * Whether `value` has the shape `POST /api/mappings` needs: three fields, a
 * number and two strings.
 *
 * Nothing here checks a field's *value*. Not that the client id names a
 * row -- that is `unknown-client`, caught from the foreign key in
 * `../clients/mappings.ts`; not that the `from_path` is free -- that is
 * `duplicate-from-path`, caught from the unique index; and above all
 * **nothing here looks at the shape of a path**. Design spec §7: a
 * `from_path` may be `D:\Downloads`, because these are foreign paths from a
 * machine that is not this one, and `../clients/paths.ts` refuses
 * `node:path` for exactly that reason. A route that demanded a leading `/`
 * or rejected a backslash would be stricter than the consumer and would
 * refuse mappings that work. The one path-content rule there is --
 * `empty-path`, on `''` alone -- lives in the host with every other
 * value-level invariant, per `server.ts`'s module doc rule that no business
 * rule belongs there.
 *
 * `'fromPath' in value` rather than a cast to `Record<string, unknown>`:
 * `value` is `unknown` off a json-parsed body, and `in` narrows it exactly
 * as far as each check proves -- the same pattern `isFeedBody`,
 * `isDownloadClientBody` and `isPickBody` above use.
 */
export function isMappingBody(value: unknown): value is AddMappingInput {
  return typeof value === 'object' && value !== null
    && 'downloadClientId' in value && typeof value.downloadClientId === 'number'
    && 'fromPath' in value && typeof value.fromPath === 'string'
    && 'toPath' in value && typeof value.toPath === 'string';
}

/**
 * Whether `value` has the shape `PATCH /api/feeds/:id` needs: exactly one
 * boolean, `disabled`.
 *
 * Strict about extra keys for the reason the config schemas are: a body
 * carrying a misspelled field would otherwise be accepted and do something
 * other than what it says.
 */
export function isSetFeedDisabledBody(value: unknown): value is { disabled: boolean } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('disabled' in value) || typeof value.disabled !== 'boolean') return false;
  return Object.keys(value).length === 1;
}

/**
 * Whether `value` has the shape `PATCH /api/mappings/:id` needs: the two
 * paths, both present.
 *
 * **Both required, not optional**, and `downloadClientId` absent. The host
 * replaces both columns, so an omitted field would arrive as `undefined`
 * and there would be two spellings of "leave it alone" for this route to
 * tell apart -- `EditMappingInput`'s own doc has the longer version. The
 * client a mapping belongs to is not editable at all: a mapping is
 * meaningless away from its client (design spec §8), and an extra
 * `downloadClientId` on the body is simply ignored, the same way an extra
 * property is on every other route here.
 *
 * The id is **not** in the body -- it is the path segment `mappingIdFrom`
 * reads -- so there is no way for a body to name one row while the target
 * names another.
 */
export function isMappingEditBody(value: unknown): value is EditMappingInput {
  return typeof value === 'object' && value !== null
    && 'fromPath' in value && typeof value.fromPath === 'string'
    && 'toPath' in value && typeof value.toPath === 'string';
}

/**
 * `PUT /api/destinations/:pluginId`'s body as the host wants it, or
 * `undefined` for one this route will not forward.
 *
 * **It builds a value where the other body guards assert a shape**, and
 * that is because of the one optional field. `isMappingBody` and its
 * siblings are `value is T` predicates, which is honest when every property
 * is required: the checks prove exactly the type. Here `unmatchedDir` may
 * be *absent*, and a predicate claiming `{ unmatchedDir: string | undefined }`
 * of an object that has no such property would be asserting slightly more
 * than it proved. Constructing the input instead turns "absent" into
 * `undefined` by writing it, which is what `SaveDestinationInput` means by
 * the field -- and `exactOptionalPropertyTypes` is why "absent" and
 * "explicitly undefined" have to be collapsed somewhere rather than carried
 * as two states.
 *
 * **A `null` is refused rather than read as absent.** A client that means
 * "use the default" sends no field; `null` is a third thing, and giving it
 * the same meaning as absence would make two spellings of one intent that
 * this route would have to keep agreeing about.
 *
 * Nothing here checks a field's *value*. Not that the root is absolute --
 * that is `not-absolute-root`; not that the shape's tokens are declared --
 * that is `unknown-token`, and it needs the plugin registry this module
 * deliberately cannot reach; and not the three unmatched-directory rules.
 * Every one of them lives in `../media/destinations.ts`, per `server.ts`'s
 * module doc rule that no business rule belongs there.
 *
 * `'root' in value` rather than a cast to `Record<string, unknown>`:
 * `value` is `unknown` off a json-parsed body, and `in` narrows it exactly
 * as far as each check proves -- the same pattern every guard above uses.
 */
export function destinationBodyFrom(value: unknown): SaveDestinationInput | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('root' in value) || typeof value.root !== 'string') return undefined;
  if (!('shape' in value) || typeof value.shape !== 'string') return undefined;
  if (!('unmatchedDir' in value)) {
    return { root: value.root, shape: value.shape, unmatchedDir: undefined };
  }
  if (typeof value.unmatchedDir !== 'string') return undefined;
  return { root: value.root, shape: value.shape, unmatchedDir: value.unmatchedDir };
}

/** A number or `null` for a patch field; anything else is the wrong shape. Range is `fetch/settings.ts`'s rule. */
function isPatchField(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

/**
 * The body of `PUT /api/fetch-hosts/:hostname`. Each of the two fields may
 * be absent, `null`, or a number; an absent field is left out of the
 * result rather than set to `undefined`, which is what lets the settings
 * object tell "leave it" from "clear it".
 */
export function fetchHostPatchFrom(value: unknown): FetchHostPatch | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const concurrency = 'concurrency' in value ? value.concurrency : undefined;
  const timeoutMs = 'timeoutMs' in value ? value.timeoutMs : undefined;
  if (concurrency !== undefined && !isPatchField(concurrency)) return undefined;
  if (timeoutMs !== undefined && !isPatchField(timeoutMs)) return undefined;
  return {
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}
