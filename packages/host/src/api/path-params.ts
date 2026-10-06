/**
 * Reads an id, a plugin id or a fetch hostname back off a request's path --
 * `server.ts`'s router matches a template like `/api/mappings/:id` by
 * segment count alone and never binds the `:name` segment itself, so each
 * of these is what recovers the value for the one route that named it.
 *
 * Split out of `server.ts` (issue #89): this is parsing, not routing, and
 * every function here is pure -- a pathname in, a value or `undefined` out.
 */

import { FETCH_DEFAULT_HOST } from '@pickarr/contract';
import { isHostname } from '../fetch/hostname.ts';

/** An artwork id, as a path segment: digits only, so nothing else reaches a query parameter. */
export const DIGITS = /^\d+$/;

/**
 * What a plugin id may look like as a path segment, for
 * `PUT /api/destinations/:pluginId`.
 *
 * **The class a plugin id already has to be in, bounded.**
 * `MediaPlugin.id` is a bare `string` in the contract, but it is also "the
 * required prefix for every table this plugin declares" -- and
 * `assertSyncedTableName` (`@pickarr/contract`) refuses a table name outside
 * `/^[a-z][a-z0-9_]*$/`, because that name is interpolated into a trigger
 * body where SQLite binds no parameters. So a plugin whose id fell outside
 * this class could declare no synced table at all. The 32-character bound is
 * this module's own: a path segment is caller-chosen and unbounded, and
 * nothing is served by letting an arbitrarily long one reach a route
 * decision.
 *
 * **A segment outside it answers `UNKNOWN_ROUTE`, not `unknown-plugin`** --
 * `mappingIdFrom`'s reasoning below, for a string rather than an integer.
 * `unknown-plugin` claims "this is a well-formed plugin id and nothing
 * registered it", which is a statement the host cannot make about
 * `Tv%20Shows`; the 404 a path naming no route gets says the truthful thing
 * instead, and tells a caller nothing a missing plugin would not have.
 *
 * `api/server.test.ts` drives every shipped plugin id through the route, so
 * a class narrower than the ids the host actually registers fails there
 * rather than making a real plugin's destination unreachable.
 */
export const PLUGIN_ID = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * The feed id in `/api/feeds/:id`, or `undefined` for a segment that cannot
 * be one. Identical rules to {@link mappingIdFrom}, and a separate function
 * rather than a shared one only so each route's 404 keeps naming its own
 * resource in the reader's head; if a third arrives, share it.
 */
export function feedIdFrom(pathname: string): number | undefined {
  return mappingIdFrom(pathname);
}

/**
 * The mapping id in `/api/mappings/:id`, or `undefined` for a segment that
 * is not one.
 *
 * **Read back off the pathname by index, never bound**, which is the shape
 * `server.ts`'s `artworkAnswer` established and the reason `Route.path`
 * carries a `:name` segment at all: the template exists so `matchesPath` can
 * compare segment counts, and the value is this function's to recover.
 *
 * Every segment is checked rather than `!`-asserted:
 * `noUncheckedIndexedAccess` types each one `string | undefined`, and a
 * path with the right number of slashes and an empty segment is a real
 * request a client can send.
 *
 * **`Number.isSafeInteger` is the last check, and the reason written here
 * first was false.** It said a float bound against an `INTEGER PRIMARY
 * KEY` is a 500. Measured on a migrated database: `node:sqlite` binds
 * `1e+30`, `1.5`, `-1` and `2**53` to both the `DELETE` and the `UPDATE`
 * **without throwing**, each reporting `changes: 0`. So without this check
 * the host answers `404 { refusal: 'unknown-mapping' }`, not a 500. The
 * sentence was copied from `server.ts`'s `artworkAnswer` docblock, which
 * makes the same claim about the same binding and is wrong in the same way;
 * that one is left for whoever owns that route, but nothing here now rests
 * on it.
 *
 * Two real reasons remain, and both are measured.
 *
 * **A float id can address a row that is not the one asked for.** A
 * `filepath_mapping` row seeded at id `9007199254740992` (`2**53`) is
 * deleted by a request for `/api/mappings/9007199254740993` -- a different
 * id -- because `Number('9007199254740993')` *is* `9007199254740992`,
 * `changes: 1`, row gone. Every integer above `2**53` has neighbours that
 * collapse onto it, and `INTEGER PRIMARY KEY` goes to `2**63 - 1`, so the
 * aliasing is a property of the id space rather than of any particular
 * install. This check is the only thing between that and a silent
 * wrong-row write. `DIGITS` cannot see it: sixteen digits are all digits.
 *
 * **And the body stays honest.** `unknown-mapping` claims "this is a
 * well-formed id and no row has it", which is a statement the host cannot
 * make about `1e+30`. Refused here, both callers answer `UNKNOWN_ROUTE` --
 * the same 404 a path naming no route gets -- so an id that could never
 * name a row reads as a bad request target rather than as a missing
 * mapping, and no unparseable id reaches a prepared statement at all.
 *
 * `undefined` rather than an `Answer`, because the two callers want
 * different things from it and neither wants this function's opinion: both
 * turn it into `UNKNOWN_ROUTE`, which is the same 404 a path naming no
 * route gets, so an unparseable id tells a caller nothing a missing row
 * would not have.
 */
export function mappingIdFrom(pathname: string): number | undefined {
  return idAt(pathname, 4, 3);
}

/**
 * The release id in `/api/unmatched/:id/retry`.
 *
 * Five segments, not four, which is why this is not simply
 * {@link mappingIdFrom}: the id is not the last thing in the path. The
 * shared {@link idAt} is what the note above `feedIdFrom` asked for -- "if
 * a third arrives, share it" -- and a third has.
 */
export function retryIdFrom(pathname: string): number | undefined {
  return idAt(pathname, 5, 3);
}

/**
 * The release id in `/api/releases/:id/identify`: five segments, the id
 * third, exactly as {@link retryIdFrom}.
 */
export function identifyIdFrom(pathname: string): number | undefined {
  return idAt(pathname, 5, 3);
}

/**
 * The integer at `index` of a pathname with exactly `segments` parts, or
 * `undefined` for anything else.
 *
 * **The segment count is checked, not just the one segment.** Without it
 * `/api/feeds/7/anything` would read as feed 7 and answer a route that
 * does not exist. `DIGITS` rather than `Number()` alone because `Number`
 * accepts `' 7'`, `'0x7'` and `''`, each of which would name a row the
 * caller did not ask for or none at all.
 */
export function idAt(pathname: string, segments: number, index: number): number | undefined {
  const parts = pathname.split('/');
  if (parts.length !== segments) return undefined;
  const raw = parts[index];
  if (raw === undefined || !DIGITS.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * The plugin id in `/api/destinations/:pluginId`, or `undefined` for a
 * segment that could not be one.
 *
 * **Read back off the pathname by index, never bound**, the shape
 * `artworkAnswer` established and `mappingIdFrom` above follows: `Route.path`
 * carries a `:name` segment so `matchesPath` can compare segment counts, and
 * the value is this function's to recover. Every segment is checked rather
 * than `!`-asserted -- `noUncheckedIndexedAccess` types each one
 * `string | undefined`, and an assertion would be a claim rather than a
 * check.
 *
 * **What differs from `mappingIdFrom`, and what does not.** A mapping id is
 * an integer, so that function has `DIGITS` and then `Number.isSafeInteger`
 * -- two checks, the second because a float id can silently address a
 * *different* row. Nothing here parses: a plugin id is a string all the way
 * to the prepared statement, so there is no coercion for a neighbouring
 * value to collapse onto and the safe-integer hazard has no analogue. What
 * is left is the class check alone, {@link PLUGIN_ID}, whose doc has what it
 * is and why a segment outside it is `UNKNOWN_ROUTE` rather than a refusal.
 *
 * `undefined` rather than an `Answer`, for `mappingIdFrom`'s reason: the
 * caller turns it into `UNKNOWN_ROUTE` and wants no opinion from here.
 */
export function pluginIdFrom(pathname: string): string | undefined {
  const segments = pathname.split('/');
  if (segments.length !== 4) return undefined;
  const raw = segments[3];
  if (raw === undefined || !PLUGIN_ID.test(raw)) return undefined;
  return raw;
}

/**
 * The fourth segment of `/api/fetch-hosts/:hostname`: either the reserved
 * `default` or a bare hostname (`isHostname`). Anything else is
 * `undefined`, which the route turns into `UNKNOWN_ROUTE` on the same
 * reasoning `pluginIdFrom` gives -- a segment that could not be a hostname
 * is not a host that could exist. The segment is not percent-decoded: a
 * hostname has no character that needs encoding, so an encoded one is
 * refused by the class check rather than decoded into something else.
 */
export function hostnameFrom(pathname: string): string | undefined {
  const segments = pathname.split('/');
  if (segments.length !== 4) return undefined;
  const raw = segments[3];
  if (raw === undefined) return undefined;
  if (raw === FETCH_DEFAULT_HOST || isHostname(raw)) return raw;
  return undefined;
}
