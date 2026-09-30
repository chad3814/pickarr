import type { AddFeedRefusal } from '../feeds/add.ts';
import type { AddDownloadClientRefusal } from '../clients/add.ts';
import type { RetryLookupOutcome } from '../media/retry.ts';
import type { PickRefusal } from '../clients/pick.ts';
import type { MappingRefusal } from '../clients/mappings.ts';
import type { DestinationRefusal } from '../media/destinations.ts';

/**
 * The `statusFor*Refusal` mappers -- one per write route, each translating
 * that route's own refusal codes into the http status the route answers.
 *
 * Split out of `server.ts` (issue #89): refusal-to-status mapping is not
 * routing, and keeping every mapper in one module is what makes the shared
 * `409`-for-a-conflicting-row, `422`-for-an-unusable-value pattern visible
 * as one pattern rather than five separate decisions.
 */

/**
 * The status `POST /api/feeds` answers for each way `addFeed` can refuse.
 *
 * A conflict is the one refusal that already has a row to point at --
 * `duplicate-url` names a url already on file, so `409` is the one that
 * fits. The other three are all "this otherwise well-formed field's value is
 * not one this host will accept" -- an unregistered plugin, a transport
 * that is not `torrent` or `nzb`, a poll interval outside the allowed range
 * -- so all three answer `422`: the request parsed fine and named a field
 * that exists, but the value it carries cannot be acted on. Whatever the
 * status, the body always carries `refusal` itself (never a message a human
 * would read), which is what a client actually branches on -- see
 * `server.ts`'s module doc on why no body may carry prose in place of a
 * stable code.
 */
export function statusForFeedRefusal(refusal: AddFeedRefusal['refusal']): number {
  switch (refusal) {
    case 'duplicate-url':
      return 409;
    case 'unknown-plugin':
    case 'bad-download-type':
    case 'bad-poll-interval':
      return 422;
  }
}

/**
 * The status `POST /api/download-clients` answers for each way
 * `addDownloadClient` can refuse, on `statusForFeedRefusal`'s reasoning
 * above.
 *
 * `duplicate-name` is the one refusal that already has a row to point at --
 * a client answering to a name already on file -- so `409` is the one that
 * fits. The other three are all "this otherwise well-formed field's value
 * is not one this host will accept": an implementation this host cannot
 * drive, a set of credential fields no auth strategy uses, a url that is
 * not an http address. All three answer `422`: the request parsed fine and
 * named fields that exist, but the values they carry cannot be acted on.
 *
 * Whatever the status, the body carries `refusal` itself and nothing else
 * -- never a message a human would read, and in particular never the
 * submitted credential or url, neither of which any answer from this route
 * repeats.
 */
export function statusForDownloadClientRefusal(refusal: AddDownloadClientRefusal['refusal']): number {
  switch (refusal) {
    case 'duplicate-name':
      return 409;
    case 'unknown-implementation':
    case 'bad-auth-shape':
    case 'bad-url':
      return 422;
  }
}

/**
 * The status `POST /api/picks` answers for each way `requestPick` can
 * refuse, on `statusForFeedRefusal`'s reasoning above.
 *
 * `already-submitted` is the one refusal that already has a row to point
 * at -- since migration 18 that is a download on the release this pick
 * named, in any status but `failed`; before it, only a download this
 * client held under the reference this pick resolved to. Either way there
 * is an existing row that is the reason, so `409` is the one that fits,
 * exactly as `duplicate-url` and `duplicate-name` get it on the other two
 * routes. `clients/pick.ts` maps both conditions to this one code, and
 * says why.
 *
 * The other four all answer `422`: the request parsed fine and named a
 * field that exists, but the value it carries cannot be acted on. That is
 * the honest grouping even though the four are not alike in *whose* fault
 * they are -- `unknown-release` is a stale browser, `plugin-not-registered`
 * and `no-client-of-type` are an install with a gap in it, and
 * `client-type-mismatch` is a feed configured wrongly. A status is not what
 * tells those apart; the code in the body is, which is the whole reason
 * this route answers one. Splitting them across statuses would put the
 * distinction in the place a client is least able to act on it and leave
 * the codes doing the work anyway.
 *
 * Whatever the status, the body carries `refusal` itself and nothing else
 * -- never a message a human would read, and never the rss item id it was
 * asked about.
 */
export function statusForPickRefusal(refusal: PickRefusal['refusal']): number {
  switch (refusal) {
    case 'already-submitted':
      return 409;
    case 'unknown-release':
    case 'plugin-not-registered':
    case 'no-client-of-type':
    case 'client-type-mismatch':
      return 422;
  }
}

/**
 * `POST /api/unmatched/:id/retry`'s three refusals.
 *
 * `already-matched` is 409 and the other two are 422, matching
 * {@link statusForPickRefusal}'s own split: a 409 is a state that changed
 * under the caller and that a reload fixes, while a 422 says the request
 * names something this host cannot act on at all.
 */
export function statusForRetryRefusal(refusal: Exclude<RetryLookupOutcome, { accepted: true }>['refusal']): number {
  switch (refusal) {
    case 'already-matched':
      return 409;
    case 'unknown-release':
    case 'plugin-not-registered':
      return 422;
  }
}

/**
 * The status the three mapping routes answer for each way the host can
 * refuse, on `statusForFeedRefusal`'s reasoning above.
 *
 * `duplicate-from-path` is the one refusal that already has a row to point
 * at -- a mapping on this client already holding that `from_path` -- so
 * `409` is the one that fits, exactly as `duplicate-url`, `duplicate-name`
 * and `already-submitted` get it on the other three write routes.
 *
 * **`unknown-client` and `unknown-mapping` answer `404`, where every
 * "names no row" refusal on the routes above answers `422`.** The
 * difference is what the id is *of*. `unknown-release` is a field inside a
 * `POST /api/picks` body describing the pick; the request itself was
 * addressed to a route that exists, so a `404` would say "no such
 * endpoint". Here `unknown-mapping` is the **request target** --
 * `/api/mappings/7` names a resource, and a resource that is not there is
 * what `404` means. `unknown-client` rides along with it: `POST
 * /api/mappings` addresses the collection rather than a client, but the
 * two are the same answer to a browser holding a stale settings list
 * (reload and the row it named is gone), and giving them different
 * statuses would split one recovery into two.
 *
 * `empty-path` answers `422`: the request parsed fine and named fields
 * that exist, but the value one of them carries cannot be acted on.
 *
 * Whatever the status, the body carries `refusal` itself and nothing else
 * -- never a message a human would read, and never a path. Paths are in
 * this table by design (design spec §5) and a client reads them back off
 * the replica; that is not licence for an *error* body to quote the one it
 * was just handed.
 */
export function statusForMappingRefusal(refusal: MappingRefusal['refusal']): number {
  switch (refusal) {
    case 'duplicate-from-path':
      return 409;
    case 'unknown-client':
    case 'unknown-mapping':
      return 404;
    case 'empty-path':
      return 422;
  }
}

/**
 * The status `PUT /api/destinations/:pluginId` answers for each way the host
 * can refuse, on `statusForMappingRefusal`'s reasoning above.
 *
 * **`unknown-plugin` is `404` and everything else is `422`**, and the split
 * is the one that file already draws: `unknown-plugin` is about the
 * **request target** -- `/api/destinations/book` names a resource, and a
 * resource that is not there is what `404` means -- exactly as
 * `unknown-mapping` is. The other nine are about a *value in the body*: the
 * request parsed fine and named fields that exist, and one of them carries
 * something that cannot be acted on, which is what `422` means and what
 * `empty-path` already gets on the mapping routes.
 *
 * There is no `409`. Its sibling has one because a mapping can collide with
 * an existing row; a destination cannot -- the statement upserts, so having
 * one already is the ordinary case rather than a conflict.
 *
 * Whatever the status, the body carries `refusal` itself and nothing else --
 * never a message a human would read, and above all never the root. A root
 * is a path, and although this table's roots do reach a client through the
 * replica (design spec §3), that is not licence for an *error* body to quote
 * the one it was just handed.
 */
export function statusForDestinationRefusal(refusal: DestinationRefusal['refusal']): number {
  switch (refusal) {
    case 'unknown-plugin':
      return 404;
    case 'not-absolute-root':
    case 'unusable-root':
    case 'unknown-token':
    case 'malformed-shape':
    case 'backslash-in-shape':
    case 'escaping-shape':
    case 'empty-filename':
    case 'empty-path':
    case 'escaping-path':
      return 422;
  }
}
