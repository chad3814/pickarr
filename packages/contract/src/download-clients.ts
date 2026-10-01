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
 * The wire shape `POST /api/download-clients` needs, and what
 * `Host.addDownloadClient` (`packages/host/src/clients/add.ts`) accepts to
 * create a download client.
 *
 * **Declared once, here, rather than mirrored on each side of the wire** --
 * `./feeds.ts`'s `AddFeedInput` doc has the measurement of what mirroring
 * a write input costs (issue #88): a host-side field rename left the whole
 * web suite green, because nothing pinned the two copies together. A
 * rename here is now a compile error in `@pickarr/web`, not a silent
 * divergence.
 *
 * **Every field is a primitive, and none is a union or optional.** These
 * values arrive unchecked out of a JSON request body, and
 * `addDownloadClient` is the validator that narrows them, not a caller
 * that has already done so. `implementation` is `string` rather than
 * `Implementation` for exactly that reason -- typing it as the union would
 * tell the compiler a check that module performs at runtime is already
 * guaranteed.
 *
 * **`type` is absent, deliberately**, and cannot be sent. It is derived
 * from `implementation` on the host (`clients/add.ts`'s
 * `TYPE_FOR_IMPLEMENTATION`), because `readClientConfig` treats a
 * `type`/`implementation` mismatch as a fatal misconfiguration -- so
 * accepting both from a browser would be accepting the ability to
 * construct a row that can never work.
 *
 * **`apiKey`, `username` and `password` are `string`, not `string | null`,
 * and every one of the three is present on every request** -- an
 * unsupplied credential is `''`, never an omitted key. That is not a
 * convenience: `''` is what a blank form field sends, `readClientConfig`'s
 * `optionalText` already folds a blank column to absent on the way back
 * out, and the host reads a blank field as "this strategy sends no such
 * credential", deciding the auth shape from which of the three are blank
 * -- so omitting one would arrive as `undefined` and be read as a shape
 * the operator never chose (`api/request-shapes.ts`'s
 * `isDownloadClientBody`).
 *
 * The two credential fields cross the wire here and nowhere else. Neither
 * is ever written to a column, a log line, an error message or a response
 * body.
 *
 * **Those four are the channels inside the product, and they are not the
 * whole list.** A credential typed into the browser form by an end-to-end
 * test is recorded in cleartext by Playwright's trace -- in the `fill`
 * action's parameters, in the action log, in the step title, in the POST
 * body resource, and in the DOM snapshot, which serialises a
 * `type="password"` input's `value` unredacted. `packages/e2e`'s
 * `playwright.config.ts` keeps that trace on failure and `ci.yml:96-103`
 * uploads it as a build artifact with 7-day retention, so a red build
 * publishes it.
 *
 * Nothing in this file can prevent that and no change here would: the
 * channel is the test harness, not the code under test, and it exists for
 * any form field a browser test fills. It is enumerated here because this
 * docblock is where someone goes to find out where a credential can end
 * up, and a list that stops at the product boundary reads as exhaustive
 * when it is not. The constraint that keeps it harmless -- every
 * credential the e2e suite types is a literal committed to this repo --
 * lives with the credentials, in `packages/e2e/tests/shell.spec.ts`'s
 * module docblock.
 *
 * **`category` may be `''`, and that is a configuration rather than a
 * missing value** -- which is why there is no refusal code for it and why
 * none is wanted. An empty category means "file downloads under no
 * category", and every consumer already understands it: `clients/add.ts`
 * writes `''` to the column as-is, unlike the credential fields, where
 * `''` is folded to `null`; a blank category is a real answer rather than
 * an absent one.
 */
export interface AddDownloadClientInput {
  name: string;
  implementation: string;
  url: string;
  category: string;
  apiKey: string;
  username: string;
  password: string;
}

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

/**
 * The consecutive-failure count at which a download client is unreachable.
 * Here, in the contract, because two sides must agree on it and neither may
 * import the other: the host's `selectClientForFeed` passes such a client
 * over when a feed names no client of its own -- a feed that names a client
 * always uses it, health notwithstanding -- and the web settings list labels
 * it. If they disagreed, the screen would call a client reachable while
 * picks avoided it.
 */
export const CLIENT_UNREACHABLE_AFTER_FAILURES = 3;
