/**
 * The write half of the pick contract: the codes `POST /api/picks` refuses
 * a pick with.
 *
 * **Why these live here and not in the host.** For the reason `./feeds.ts`'s
 * own doc measures at length: the same set of strings declared once in the
 * host and again, by hand, in the browser client is a pair that drifts
 * silently, because renaming one half reddens only that half's tests.
 * Declaring them in the package both sides already depend on makes the
 * rename a compile error on both sides. `./download-clients.ts` is the
 * second application of that lesson and this is the third.
 *
 * **A code, never a sentence.** Nothing here is prose and nothing here is
 * rendered: the server authors no sentence a human reads (a global
 * constraint of this repo), so a client owns its own wording and this list
 * owns only the vocabulary the two sides branch on.
 *
 * **Not every `refusal` the route can answer with is in this list.**
 * `POST /api/picks` also answers `invalid-shape` and `malformed-body` --
 * refusals of the *request envelope*, raised by the route before
 * `requestPick` is reached at all, rather than of the pick.
 * `packages/host/src/api/server.ts` is where those two are declared, and
 * `./feeds.ts`'s doc is where the reasoning for keeping them out of a
 * contract module is written down.
 *
 * **Nothing here names a release, a feed, a client or an address.** A pick
 * body is `{ rssItemId }` and every answer to it is either `{ accepted:
 * true }` or one of these codes, so no url a feed holds and no url a
 * download client is reached at can travel back out through this route --
 * the same discipline `./download-clients.ts` states for credentials.
 */

/**
 * Every way `requestPick` can decline to submit a pick.
 *
 * **This is the only one of the three refusal lists whose codes are
 * produced by converting a *throw*.** `addFeed` and `addDownloadClient`
 * return their refusals as values all the way down; `Host.requestDownload`,
 * which this wraps, throws, and `packages/host/src/clients/pick.ts` is
 * where each throw becomes one of these. That is invisible from here -- a
 * caller sees five codes and no exceptions -- and it is why the list is
 * worth reading beside that module rather than beside a set of `if`
 * statements.
 *
 * Written in the order design spec §6 lists them, which is also the order a
 * pick encounters them: the release is looked up, then its plugin, then the
 * client its feed resolves to, and only then is a duplicate reference
 * discoverable -- by the insert that collides, never by a check. Nothing
 * depends on the order; both consumers treat it as a set.
 */
export const REQUEST_PICK_REFUSALS = [
  'unknown-release',
  'plugin-not-registered',
  'no-client-of-type',
  'client-type-mismatch',
  'already-submitted',
] as const;

/**
 * One of {@link REQUEST_PICK_REFUSALS}, as a type.
 *
 * Derived from the array rather than written out beside it, for the reason
 * `./feeds.ts`'s twin gives: a second spelling of the same five strings is
 * the duplication this module exists to remove, and it would go stale the
 * same way.
 */
export type RequestPickRefusalCode = (typeof REQUEST_PICK_REFUSALS)[number];

/**
 * Every way `Host.retryLookup` can decline to ask for a release to be
 * identified again.
 *
 * **Three codes, and two of them are spelled the same as a pick's.** That
 * is deliberate rather than an oversight to deduplicate: `unknown-release`
 * and `plugin-not-registered` mean the same thing to a reader on both
 * paths, and a client's sentence for them is the same sentence. Sharing
 * one union across two unrelated operations would be worse -- it would
 * say a retry can answer `no-client-of-type`, which it cannot, and the
 * exhaustive `switch` that maps each to a status would stop being
 * exhaustive over what this route really returns.
 *
 * `already-matched` is this list's own. It is not a failure so much as a
 * stale page: a lookup landed between the render and the click, the
 * release is fine, and the sentence an operator reads should say so
 * rather than implying they did something wrong.
 *
 * Unlike {@link REQUEST_PICK_REFUSALS}, none of these is produced by
 * converting a throw -- `packages/host/src/media/retry.ts` returns all
 * three as values, and rethrows anything it does not recognise so a
 * broken plugin becomes a 500 rather than a 4xx.
 */
export const RETRY_LOOKUP_REFUSALS = [
  'unknown-release',
  'already-matched',
  'plugin-not-registered',
] as const;

/** One of {@link RETRY_LOOKUP_REFUSALS}, as a type. Derived, never re-spelled. */
export type RetryLookupRefusalCode = (typeof RETRY_LOOKUP_REFUSALS)[number];
