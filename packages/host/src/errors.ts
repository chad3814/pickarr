/**
 * Errors the host raises that a caller has to tell apart from every other
 * failure. Their own module so nothing importing one has to import
 * `host.ts` -- `clients/deliver.ts` catches the first class below and
 * `host.ts` builds the reconcile job that calls into it, which would be an
 * import cycle if this lived there. `clients/select.ts` and
 * `clients/downloads.ts` throw three of the others and are imported *by*
 * `host.ts`, so the same argument applies to them in the other direction.
 *
 * **Why six classes and not six message prefixes.** `clients/pick.ts`
 * turns each of these into one of `@pickarr/contract`'s
 * `REQUEST_PICK_REFUSALS` codes, and the only alternative to a type is
 * matching the message text. Every message below interpolates an id, so a
 * match would have to be a substring, and a substring match is satisfied or
 * broken by a rewording that reddens nothing -- which is the same silent
 * drift `contract/src/feeds.ts` exists to stop, one layer down. The classes
 * are what make the mapping a compile-time relationship instead.
 *
 * **Each message names ids and a feed name, and never a url, a path or a
 * credential.** Where that care is needed is narrower than this paragraph
 * first claimed, and is worth stating exactly: a wrong account of where a
 * string ends up is how the wrong string ends up there. This line said the
 * messages "reach `jobs.last_error` and the host log", and neither half is
 * true. Traced through every caller on this tree:
 *
 * - **Five of the six are never written down at all.**
 *   `UnknownRssItemError` and `PluginNotRegisteredError` are raised by
 *   `requestDownload` before a submission starts, and `NoClientOfTypeError`
 *   and `ClientTypeMismatchError` by `selectClientForFeed`, which
 *   `clients/downloads.ts` calls *before* it inserts the download row -- so
 *   `markFailed` never runs for them and there is no column to write to.
 *   `ReleaseAlreadyPickedError` joins them for a different reason: it is
 *   raised *by* that insert, so the row it would have been written to is
 *   the one that did not come into existence. All five become bare codes
 *   in `clients/pick.ts` and are discarded.
 * - **`AlreadySubmittedError` is the one that persists**, into
 *   `torrent_download.last_error` / `nzb_download.last_error`, through
 *   `redactUrl`. `sync/tables.ts` deliberately keeps that column out of the
 *   replica, but `/api/downloads` does serve it to a session holder as
 *   `DownloadRead.lastError` -- so it is the one message here a browser can
 *   be shown, and that, not a log file, is why none of these may carry a
 *   url or a credential.
 * - **`jobs.last_error` receives none of them.** The only job kinds are
 *   `poll`, `reconcile` and a plugin's own lookup; none reaches
 *   `requestDownload` or `submit`.
 * - **No log line carries one either.** `clients/downloads.ts` logs a fixed
 *   sentence beside `{ rssItemId, downloadClientId, kind }` and never the
 *   message, and no refusal reaches `api/server.ts`'s 500 handler, which is
 *   the only place a thrown message is written to the host log.
 *
 * So five of these messages are read by a developer holding a stack trace
 * and by nobody else. That is not an argument for being careless with them
 * -- the sixth is served over HTTP, and which is which is a property of
 * call sites above this file rather than of the classes.
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
 * download_client_id"). The class is for `clients/pick.ts`, which answers
 * a bare `no-client-of-type` and discards the wording entirely.
 *
 * **One `feed` object rather than loose positional parameters.** `feedName`
 * and `downloadType` are both `string`, so passing them the wrong way round
 * would compile and produce a message that reads perfectly and names the
 * wrong things -- the failure mode a reader is least likely to catch,
 * because nothing about it looks broken. `clients/select.ts` already holds
 * a `FeedRow` with exactly these three fields, so the call site is shorter
 * as well as safer.
 */
export class NoClientOfTypeError extends Error {
  constructor(feed: { id: number; name: string; downloadType: string }) {
    super(
      `feed ${feed.id} (${feed.name}) has no download client of type ${JSON.stringify(feed.downloadType)}: ` +
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
 *
 * **Two objects rather than five positional parameters**, and this is the
 * constructor that most needed it: `feedName`, `clientType` and
 * `downloadType` were three `string`s in one list, and swapping the last
 * two would compile and answer "names download client 3 of type
 * \"torrent\", but its download_type is \"nzb\"" for a feed that is the
 * other way round -- a wrong message that reads like a right one. Grouping
 * them also matches what `clients/select.ts` has in hand: a `FeedRow` and
 * a `ClientTypeRow`, passed whole.
 */
export class ClientTypeMismatchError extends Error {
  constructor(
    feed: { id: number; name: string; downloadType: string },
    client: { id: number; type: string },
  ) {
    super(
      `feed ${feed.id} (${feed.name}) names download client ${client.id} of type ` +
      `${JSON.stringify(client.type)}, but its download_type is ${JSON.stringify(feed.downloadType)}`,
    );
    this.name = 'ClientTypeMismatchError';
  }
}

/**
 * Thrown by `createDownloadClients`'s `submit` when writing a client's
 * reference onto a download row collides with the partial unique index on
 * `(download_client_id, client_ref)`.
 *
 * **A *caught* constraint violation rather than a condition some code
 * checked**, like {@link ReleaseAlreadyPickedError} below and unlike every
 * other class in this module. `clients/downloads.ts` writes its row
 * first and asks the client second, so a reference the client hands back
 * that it has already handed back for some other row collides on the
 * `UPDATE` rather than being pre-checked and then raced.
 *
 * **What this catches, now that the release-level index exists.** It is
 * *not* the same release picked twice: since migration 18 a second live
 * download for one `rss_item` is refused at the insert, before any client
 * is called, and that is {@link ReleaseAlreadyPickedError}. What is left
 * here is two *different* releases resolving to one reference on one
 * client -- two `rss_item` rows carrying the same magnet, which a feed
 * that re-publishes an item under a new guid produces. Both map to the
 * `already-submitted` refusal, because from the caller's side both are
 * "this download is already on file"; they are two classes because the
 * conditions are different and prose is all that would otherwise tell them
 * apart.
 *
 * **This docblock used to claim "a second pick at the same release reaches
 * the same client … there is no window in which two concurrent picks could
 * both pass a check and then both insert."** The second half was true and
 * the first was false, and the whole-branch review measured the cost:
 * `clients/select.ts` had already begun *drawing* at random among a feed's
 * candidate clients (`a5c8e9f`, three commits before this sentence was
 * written), so a second pick reached the same client only 1 time in N, and
 * with two torrent clients configured the same release picked twice
 * answered `accepted` twice. The mechanism described was right about the
 * collision it described; the premise underneath it -- "the same client" --
 * was a claim about another module that this one neither states nor checks.
 *
 * `cause` is SQLite's own error, kept so the collision is still traceable;
 * nothing reads it, and in particular `clients/pick.ts` does not, because
 * re-deriving the detection from `errcode` at the far end would be a second
 * copy of a rule that already has one.
 *
 * The message deliberately does not repeat SQLite's, which reads `UNIQUE
 * constraint failed: torrent_download.download_client_id,
 * torrent_download.client_ref` and names neither the item nor the client.
 * It is also the one message in this module that is written down and
 * served -- see this module's own doc for where it goes.
 *
 * One object rather than two adjacent `number` parameters, for the reason
 * {@link NoClientOfTypeError} gives: transposing them would compile.
 */
export class AlreadySubmittedError extends Error {
  constructor(submission: { rssItemId: number; downloadClientId: number }, options: { cause: unknown }) {
    super(
      `rss item ${submission.rssItemId} could not be recorded against download client ` +
      `${submission.downloadClientId}: this client already has a recorded download using ` +
      'the same reference',
      options,
    );
    this.name = 'AlreadySubmittedError';
  }
}

/**
 * Thrown by `createDownloadClients`'s `submit` when inserting a download
 * row collides with migration 18's partial unique index on `rss_item_id`
 * -- that is, when the release already has a download in every status but
 * `failed`.
 *
 * **The second caught constraint violation in this module, and the one
 * that does not depend on which client was resolved.**
 * {@link AlreadySubmittedError} is keyed on `(download_client_id,
 * client_ref)` and therefore cannot see a second pick that landed on a
 * different client; `clients/select.ts` draws at random among a feed's
 * candidates, so that is the common case on any install with two clients
 * of one type rather than a rare one. Migration 18's docblock has the
 * measurement and the definition of "live" the index encodes.
 *
 * **Caught, not pre-checked, and the ordering is what makes that safe.**
 * `clients/downloads.ts` inserts the row synchronously, before it awaits
 * anything, so a second pick arriving while the first is still talking to
 * its client meets a row that is already on file and already `submitting`.
 * A `SELECT` asking "does this release have a live download?" would have
 * to be followed by an insert, and two picks could both pass it -- which
 * is the race design spec §6 chose a real constraint to avoid.
 *
 * **How this is told apart from {@link AlreadySubmittedError} without
 * reading SQLite's message.** By *where* the violation was caught, not by
 * what it said. The insert supplies `client_ref = NULL`, which the
 * `..._client_ref` index excludes, so an insert can only have hit this
 * one; the `UPDATE` that writes a reference changes neither `rss_item_id`
 * nor the row's membership of `status <> 'failed'`, so it can only have
 * hit the other. A substring match on `UNIQUE constraint failed: …` would
 * be broken by a column rename that reddens nothing, which is the reason
 * this module holds classes at all.
 *
 * One object rather than two adjacent `number` parameters, for the reason
 * {@link NoClientOfTypeError} gives: transposing them would compile.
 */
export class ReleaseAlreadyPickedError extends Error {
  constructor(submission: { rssItemId: number; downloadClientId: number }, options: { cause: unknown }) {
    super(
      `rss item ${submission.rssItemId} could not be recorded against download client ` +
      `${submission.downloadClientId}: this release already has a download that has not failed`,
      options,
    );
    this.name = 'ReleaseAlreadyPickedError';
  }
}
