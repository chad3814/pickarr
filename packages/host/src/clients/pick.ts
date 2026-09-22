/**
 * `Host.requestPick`: the thin converter that makes the download path
 * answerable over HTTP.
 *
 * **This module exists because `requestDownload` throws and the two other
 * write paths do not.** `feeds/add.ts` and `clients/add.ts` each return
 * every refusal as a value, for the reason both of their docs state: a
 * thrown error is indistinguishable from a bug at the call site, and the
 * route in front needs to map each refusal to its own status. The pick path
 * was built before any route could reach it and threw all the way down --
 * through `selectClientForFeed`, through `submit`, through `requestDownload`
 * itself. Design spec §6 chose to wrap that rather than rewrite it in place,
 * so this file is the whole of the conversion.
 *
 * **It performs no check of its own, and that is the design.** There is no
 * "does this rss item exist" query here, no client lookup and no "has this
 * already been submitted" SELECT. Every condition below is discovered by the
 * code that owns it -- `host.ts` reading the item's owner,
 * `clients/select.ts` resolving the feed's client, and SQLite's own two
 * partial unique indexes on the download tables -- and arrives here as a
 * class from `../errors.ts`. A pre-check would be a second copy of each
 * rule, and for `already-submitted` it would also be wrong: two concurrent
 * picks can both pass a check and then collide, where a second insert
 * against a live row cannot pass the constraint at all.
 *
 * **That last clause used to read "two picks that both reach the index
 * cannot both win", and it was false when it was written.** The index it
 * meant was the one on `(download_client_id, client_ref)`, and
 * `clients/select.ts` had already begun drawing at random among a feed's
 * candidate clients three commits earlier -- so two picks at one release
 * reached *different* clients and both won, measured as two `submitted`
 * rows and two `accepted` answers on a two-client install. The sentence
 * described a real mechanism and rested on a premise about another module
 * that this one neither states nor checks. What makes the claim true now
 * is migration 18's index on `rss_item_id`, which is keyed on the release
 * rather than on whatever client a draw happened to return.
 *
 * **The mapping is exhaustive over `REQUEST_PICK_REFUSALS` and closed
 * against everything else.** An error this module does not recognise is
 * rethrown untouched, so a corrupt row or a closed database reaches
 * `api/server.ts`'s outermost handler and becomes a 500. Answering a
 * refusal for those would put a 4xx in front of an infrastructure fault and
 * tell an operator the pick was refused when nothing had been decided.
 */
import type { RequestPickRefusalCode } from '@pickarr/contract';
import {
  AlreadySubmittedError,
  ClientTypeMismatchError,
  NoClientOfTypeError,
  PluginNotRegisteredError,
  ReleaseAlreadyPickedError,
  UnknownRssItemError,
} from '../errors.ts';

/**
 * Why `Host.requestPick` declined to submit the pick, returned as a value
 * rather than thrown -- the shape `AddFeedRefusal` and
 * `AddDownloadClientRefusal` already have, so all three write paths answer
 * the same way and `api/server.ts` narrows all three with `'refusal' in
 * result`.
 *
 * The codes are `@pickarr/contract`'s `REQUEST_PICK_REFUSALS`, not this
 * file's, because the browser client has to agree with them exactly to pick
 * the right sentence; that module's own doc has the measurement from the
 * feeds slice, where two spellings were hand-copied.
 *
 * **No refusal carries anything from the failure it came from.** Every
 * error below has a message naming a feed, a client id or an rss item id,
 * and none of it travels: a refusal says which rule was broken and nothing
 * about the row that broke it.
 */
export interface PickRefusal {
  refusal: RequestPickRefusalCode;
}

/**
 * What a pick answers when the host has taken it -- not when a download
 * exists. See the `POST /api/picks` route for why the status beside this is
 * `202` and what is and is not true at the moment it is written.
 */
export interface PickAccepted {
  accepted: true;
}

/**
 * The code for a thrown error, or `undefined` for one that is not a
 * refusal at all.
 *
 * `instanceof` and not a message match. Every message these classes carry
 * interpolates an id, so a match would have to be a substring, and a
 * substring match is satisfied or broken by a rewording that reddens
 * nothing -- `../errors.ts`'s own doc has the longer version of this.
 *
 * Ordered as design spec §6 lists the codes, which is also the order a pick
 * meets them; nothing depends on that, since no error is an instance of two
 * of these classes.
 *
 * **Six classes, five codes**, and the pair that share one is deliberate.
 * `ReleaseAlreadyPickedError` is "this release already has a live
 * download" and `AlreadySubmittedError` is "this client already holds this
 * reference"; they are separate conditions caught at separate statements
 * (`clients/downloads.ts`'s insert and its `markSubmitted` respectively),
 * and separate classes for the reason this module's whole mapping exists.
 * They answer the same code because a caller can do the same thing about
 * either -- nothing -- and a sixth code would be a distinction
 * `web/src/library/postPick.ts` would have to write a second sentence for
 * that said the same thing.
 */
function refusalFor(err: unknown): RequestPickRefusalCode | undefined {
  if (err instanceof UnknownRssItemError) return 'unknown-release';
  if (err instanceof PluginNotRegisteredError) return 'plugin-not-registered';
  if (err instanceof NoClientOfTypeError) return 'no-client-of-type';
  if (err instanceof ClientTypeMismatchError) return 'client-type-mismatch';
  if (err instanceof ReleaseAlreadyPickedError) return 'already-submitted';
  if (err instanceof AlreadySubmittedError) return 'already-submitted';
  return undefined;
}

/**
 * Submits a pick, answering `{ accepted: true }` or one of five refusals.
 *
 * Takes `requestDownload` rather than the `Host`, the same way
 * `feeds/add.ts` takes `isRegistered` rather than the host's plugin map:
 * it is the one capability this needs, and not having the rest in hand is a
 * stronger statement than not calling it. `Host.requestPick` passes its own
 * public method, so a pick takes the identical path every other caller of
 * `requestDownload` takes.
 *
 * `rssItemId` is a plain `number` because that is what it is -- unlike
 * `AddFeedInput` and `AddDownloadClientInput`, whose fields are primitives
 * because this layer is their validator, nothing here narrows anything. The
 * route's shape guard has already established it is a number, and whether
 * that number names a row is the `unknown-release` refusal's business, not
 * a type's.
 *
 * **Async only because `requestDownload` is.** There is no I/O in this
 * function: it awaits one call and branches on what came back.
 */
export async function requestPick(
  deps: { requestDownload: (rssItemId: number) => Promise<void> },
  rssItemId: number,
): Promise<PickAccepted | PickRefusal> {
  try {
    await deps.requestDownload(rssItemId);
  } catch (err) {
    const refusal = refusalFor(err);
    // Rethrown, not folded into a refusal -- see the module doc. `err` is
    // rethrown as it arrived rather than wrapped, so whatever `redactText`
    // the 500 handler applies sees the original message.
    if (refusal === undefined) throw err;
    return { refusal };
  }
  return { accepted: true };
}
