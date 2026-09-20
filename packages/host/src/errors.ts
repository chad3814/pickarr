/**
 * Errors the host raises that a caller has to tell apart from every other
 * failure. Their own module so nothing importing one has to import
 * `host.ts` -- `clients/deliver.ts` catches the first class below and
 * `host.ts` builds the reconcile job that calls into it, which would be an
 * import cycle if this lived there. `clients/select.ts` and
 * `clients/downloads.ts` throw three of the others and are imported *by*
 * `host.ts`, so the same argument applies to them in the other direction.
 *
 * **Why five classes and not five message prefixes.** `clients/pick.ts`
 * turns each of these into one of `@pickarr/contract`'s
 * `REQUEST_PICK_REFUSALS` codes, and the only alternative to a type is
 * matching the message text. Every message below interpolates an id, so a
 * match would have to be a substring, and a substring match is satisfied or
 * broken by a rewording that reddens nothing -- which is the same silent
 * drift `contract/src/feeds.ts` exists to stop, one layer down. The classes
 * are what make the mapping a compile-time relationship instead.
 *
 * **Each message names ids and a feed name, and never a url, a path or a
 * credential.** That is load-bearing rather than incidental: these messages
 * reach `jobs.last_error` and the host log. No refusal *body* carries any
 * of it -- the route answers a bare code (`api/server.ts`) -- so what is
 * written here is for an operator reading a log, not for a browser.
 */

/**
 * Thrown by `Host.deliverToPlugin` when `pluginId` names no plugin this host
 * currently has registered, and by `Host.requestDownload` for the same
 * condition reached from an rss item.
 *
 * **`requestDownload` used to throw a bare `Error` here**, with the prose
 * "belongs to a feed whose plugin is not registered", and this docblock
 * used to point at that sentence as the same condition worded differently.
 * It is now this class on both paths, because `clients/pick.ts` has to map
 * it to the `plugin-not-registered` refusal and cannot read a sentence.
 *
 * `deliverCompleted` (`clients/deliver.ts`) is the other catcher, and it
 * must tell this one failure apart from every other way a plugin's
 * `onDownloadedFile` can reject: this one means "nobody owns this file",
 * which it reports as `unowned` and retries, the same shape
 * `notifyNewRssItems`'s own `unowned` gives an rss item whose feed names no
 * registered plugin, rather than folding it into an undifferentiated
 * failure count. The two call paths never cross -- `deliverCompleted` calls
 * only `deliverToPlugin` -- so sharing the class costs neither of them a
 * distinction it was making.
 *
 * **The rss item id is not in the message on the `requestDownload` path**,
 * where the old prose carried it. The caller supplied that id one frame
 * up and still holds it; the plugin id is the half it did *not* know and
 * the half an operator acts on, by registering that plugin.
 */
export class PluginNotRegisteredError extends Error {
  constructor(pluginId: string) {
    super(`plugin "${pluginId}" is not registered`);
    this.name = 'PluginNotRegisteredError';
  }
}

/**
 * Thrown by `Host.requestDownload` when no `rss_item` row has that id.
 *
 * Distinct from {@link PluginNotRegisteredError} although
 * `db/owner.ts`'s `ownerPluginId` answers `undefined` for both -- it joins
 * `rss_item` to `rss_feed`, so a missing item and a missing feed are one
 * answer there. They are two different things to tell an operator, and
 * `clients/pick.ts` maps them to two different refusal codes:
 * `unknown-release` is "that id names nothing", which a browser showing a
 * stale list produces, and `plugin-not-registered` is "it names something
 * this host cannot act on", which a misconfigured install produces.
 *
 * **`requestDownload` does not need a second query to tell them apart**,
 * and does not make one. `rss_item.feed_id` is `NOT NULL REFERENCES
 * rss_feed (id)` (`db/migrate.ts`) under `PRAGMA foreign_keys = ON`
 * (`db/open.ts`), so the feed half of the join cannot be the missing one:
 * `undefined` from `ownerPluginId` means the *item* is absent, full stop,
 * and a plugin id that comes back and is not in the registry is the other
 * case. Were the pragma ever off, an orphaned item would be reported as
 * unknown rather than as unowned -- a wrong code on a database that is
 * already corrupt, which is why this is a note and not a guard.
 */
export class UnknownRssItemError extends Error {
  constructor(rssItemId: number) {
    super(`rss item id ${rssItemId} is not on file`);
    this.name = 'UnknownRssItemError';
  }
}

/**
 * Thrown by `selectClientForFeed` when a feed names no download client and
 * no client of its `download_type` exists to stand in.
 *
 * The message is the one that branch has carried since it was written,
 * including its remedy ("create one, or set the feed's
 * download_client_id"): an operator reading a log is who it is for, and the
 * class is for `clients/pick.ts`, which answers the browser a bare
 * `no-client-of-type`.
 */
export class NoClientOfTypeError extends Error {
  constructor(feedId: number, feedName: string, downloadType: string) {
    super(
      `feed ${feedId} (${feedName}) has no download client of type ${JSON.stringify(downloadType)}: ` +
      `create one, or set the feed's download_client_id`,
    );
    this.name = 'NoClientOfTypeError';
  }
}

/**
 * Thrown by `selectClientForFeed` when a feed names a download client whose
 * `type` is not the feed's `download_type` -- an nzb client on a torrent
 * feed, or the reverse.
 *
 * Separate from {@link NoClientOfTypeError} because the two have opposite
 * remedies: this one is an explicit choice to correct, that one is a
 * missing client to create. `clients/select.ts`'s own tests already
 * asserted the two messages do not overlap; the classes are what make that
 * distinction survive a rewording.
 */
export class ClientTypeMismatchError extends Error {
  constructor(feedId: number, feedName: string, clientId: number, clientType: string, downloadType: string) {
    super(
      `feed ${feedId} (${feedName}) names download client ${clientId} of type ` +
      `${JSON.stringify(clientType)}, but its download_type is ${JSON.stringify(downloadType)}`,
    );
    this.name = 'ClientTypeMismatchError';
  }
}

/**
 * Thrown by `createDownloadClients`'s `submit` when writing a client's
 * reference onto a download row collides with the partial unique index on
 * `(download_client_id, client_ref)`.
 *
 * **This is the one error here that stands for a *caught* constraint
 * violation rather than a condition some code checked.** `clients/
 * downloads.ts` writes its row first and asks the client second, so a
 * second pick at the same release reaches the same client, gets the same
 * reference back, and collides on the `UPDATE` -- there is no window in
 * which two concurrent picks could both pass a check and then both insert.
 * `cause` is SQLite's own error, kept so the collision is still traceable;
 * nothing reads it, and in particular `clients/pick.ts` does not, because
 * re-deriving the detection from `errcode` at the far end would be a second
 * copy of a rule that already has one.
 *
 * The message deliberately does not repeat SQLite's, which reads `UNIQUE
 * constraint failed: torrent_download.download_client_id,
 * torrent_download.client_ref` and names neither the item nor the client.
 */
export class AlreadySubmittedError extends Error {
  constructor(rssItemId: number, downloadClientId: number, options: { cause: unknown }) {
    super(
      `rss item ${rssItemId} could not be recorded against download client ` +
      `${downloadClientId}: this client already has a recorded download using ` +
      'the same reference',
      options,
    );
    this.name = 'AlreadySubmittedError';
  }
}
