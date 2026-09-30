/**
 * The write half of the `rss_feed` wire contract: the codes `POST /api/feeds`
 * refuses a new feed with.
 *
 * **Why these live here and not in the host.** They used to be declared
 * twice -- once as `packages/host/src/feeds/add.ts`'s `AddFeedRefusal`, and
 * again as a hand-copied literal set in `packages/web`'s `AddFeed.tsx` --
 * with no test asserting the two spellings agreed. Measured, on the tree
 * before this module existed: renaming `duplicate-url` to
 * `url-already-on-file` on the host alone reddened two host tests and left
 * all 100 web tests green, so whoever performed the rename would fix the two
 * failures and ship a form that had silently stopped saying "That url is
 * already on file." and started saying its catch-all instead. Declaring the
 * codes once, in the package both sides already depend on, makes that rename
 * a compile error on both sides rather than a silent divergence.
 *
 * The read half of the same contract is `RssFeedSyncRead` in `./sync.ts`,
 * added by the same slice. This module is the half that was left behind.
 *
 * **A code, never a sentence.** Nothing here is prose and nothing here is
 * rendered: the server authors no sentence a human reads (a global
 * constraint of this repo), so a client owns its own wording and this list
 * owns only the vocabulary the two sides branch on. That is also why the
 * client's `offline` and `unrecognised` outcomes are *not* here -- neither
 * is a code the host can send. See `AddFeed.tsx`'s `AddFeedOutcome`.
 *
 * **Not every `refusal` the route can answer with is in this list**, and
 * that is deliberate. `POST /api/feeds` also answers `invalid-shape` and
 * `malformed-body` -- refusals of the *request envelope*, raised by the
 * route before `addFeed` is reached at all, rather than of the feed. A
 * client is expected to treat those as unrecognised (it has nothing useful
 * to say about a request its own code composed), so renaming one cannot
 * change what a human is told, which is the drift this module exists to
 * stop. `api/server.ts` is where those two are declared and why.
 */

/**
 * The wire shape `POST /api/feeds` needs, and what `Host.addFeed`
 * (`packages/host/src/feeds/add.ts`) accepts to create a feed.
 *
 * **Declared once, here, rather than mirrored on each side of the wire.**
 * It used to be declared twice -- once as `feeds/add.ts`'s own
 * `AddFeedInput`, and again as a hand-copied interface in
 * `packages/web`'s `AddFeed.tsx` -- with no test asserting the two
 * spellings agreed. Measured: renaming `pollIntervalS` to `pollSeconds` on
 * the host alone reddened every host test and left the whole web suite
 * green, so the client kept posting the old field name and every
 * submission came back `bad-poll-interval` wrapped in the catch-all
 * sentence. A rename here is now a compile error in `@pickarr/web`, not a
 * silent divergence (issue #88).
 *
 * `downloadType` is `string`, not `Transport` (`'torrent' | 'nzb'`), on
 * purpose: this value arrives unchecked off a JSON request body, and
 * `addFeed` is the validator that narrows it, not a caller that has
 * already done so. Typing it `Transport` would tell the compiler a check
 * `addFeed` itself performs at runtime (`TRANSPORTS.has`, in that same
 * module) is already guaranteed, which is false the moment a caller is
 * anything other than trusted code.
 */
export interface AddFeedInput {
  pluginId: string;
  name: string;
  url: string;
  downloadType: string;
  pollIntervalS: number;
}

/**
 * Every way `addFeed` can decline to create a feed.
 *
 * Ordered as `feeds/add.ts` checks them, which is the order this list was
 * read off. Nothing depends on that order -- both consumers treat it as a
 * set -- so it is a readability choice, not a contract.
 */
export const ADD_FEED_REFUSALS = [
  'unknown-plugin',
  'bad-download-type',
  'bad-poll-interval',
  'duplicate-url',
] as const;

/**
 * One of {@link ADD_FEED_REFUSALS}, as a type.
 *
 * Derived from the array rather than written out beside it: a second
 * spelling of the same four strings is the duplication this module was
 * created to remove, and it would go stale the same way.
 */
export type AddFeedRefusalCode = (typeof ADD_FEED_REFUSALS)[number];
