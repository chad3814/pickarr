/**
 * The write half of the `download_client` wire contract: the codes
 * `POST /api/download-clients` refuses a new download client with.
 *
 * **Why these live here and not in the host.** For the reason
 * `./feeds.ts`'s own doc measures at length: the same set of strings
 * declared once in the host and again, by hand, in the browser client is a
 * pair that drifts silently, because renaming one half reddens only that
 * half's tests. Declaring them in the package both sides already depend on
 * makes the rename a compile error on both sides. This module is that
 * lesson applied before the second spelling exists rather than after.
 *
 * **A code, never a sentence.** Nothing here is prose and nothing here is
 * rendered: the server authors no sentence a human reads (a global
 * constraint of this repo), so a client owns its own wording and this list
 * owns only the vocabulary the two sides branch on.
 *
 * **Not every `refusal` the route can answer with is in this list.**
 * `POST /api/download-clients` also answers `invalid-shape` and
 * `malformed-body` -- refusals of the *request envelope*, raised by the
 * route before `addDownloadClient` is reached at all, rather than of the
 * client. `packages/host/src/api/server.ts` is where those two are declared,
 * and `./feeds.ts`'s doc is where the reasoning for keeping them out of a
 * contract module is written down.
 *
 * **No code here names a credential**, and that is not an accident of this
 * list being short. A credential crosses the wire exactly once, in the POST
 * body, and the design (spec §2, §3) is that it reaches `Secrets.saveSecret`
 * without touching a column, a log line, an error message or a response --
 * so there is no refusal whose meaning is "that api key was wrong". Nothing
 * here checks a credential's *value*; `bad-auth-shape` is about which
 * credential fields were supplied, never about what was in them.
 */

/**
 * Every way `addDownloadClient` can decline to create a download client.
 *
 * Written in the order design spec §3 lists them, which is **not** the order
 * `packages/host/src/clients/add.ts` checks them in -- `bad-url` is checked
 * third, before the insert, and `duplicate-name` can only be discovered by
 * the insert itself. (`./feeds.ts`'s list happens to be in check order and
 * says so; this one is not, and saying otherwise would be a comment stating
 * a reason that is false.) Nothing depends on the order either way -- both
 * consumers treat it as a set.
 */
export const ADD_DOWNLOAD_CLIENT_REFUSALS = [
  'unknown-implementation',
  'bad-auth-shape',
  'duplicate-name',
  'bad-url',
] as const;

/**
 * One of {@link ADD_DOWNLOAD_CLIENT_REFUSALS}, as a type.
 *
 * Derived from the array rather than written out beside it, for the reason
 * `./feeds.ts`'s twin gives: a second spelling of the same four strings is
 * the duplication this module exists to remove, and it would go stale the
 * same way.
 */
export type AddDownloadClientRefusalCode = (typeof ADD_DOWNLOAD_CLIENT_REFUSALS)[number];
