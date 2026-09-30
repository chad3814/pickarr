/**
 * The write half of the `filepath_mapping` wire contract: the codes
 * `POST /api/mappings`, `PATCH /api/mappings/:id` and
 * `DELETE /api/mappings/:id` refuse a mapping with.
 *
 * **Why these live here and not in the host.** For the reason
 * `./download-clients.ts` and `./feeds.ts` each measure at length: the same
 * set of strings declared once in the host and again, by hand, in the
 * browser client is a pair that drifts silently, because renaming one half
 * reddens only that half's tests. Declaring them in the package both sides
 * already depend on makes the rename a compile error on both sides.
 *
 * **A code, never a sentence.** Nothing here is prose and nothing here is
 * rendered: the server authors no sentence a human reads (a global
 * constraint of this repo), so a client owns its own wording and this list
 * owns only the vocabulary the two sides branch on.
 *
 * **One list across three routes, not three lists.** The three write routes
 * share one host module (`packages/host/src/clients/mappings.ts`) and one
 * refusal type, and no route can answer every code -- `unknown-client` is
 * reachable only from the add, `unknown-mapping` only from the edit and the
 * remove. Splitting the list per route would make the union of the three the
 * thing a client has to assemble, and would put `empty-path` and
 * `duplicate-from-path` in two places each. Which codes a given route can
 * actually answer is pinned by that route's own tests rather than by the
 * shape of this module.
 *
 * **Not every `refusal` those routes can answer with is in this list.** They
 * also answer `invalid-shape` and `malformed-body` -- refusals of the
 * *request envelope*, raised by the route before the host is reached at all,
 * rather than of the mapping. `packages/host/src/api/server.ts` is where
 * those two are declared, and `./feeds.ts`'s doc is where the reasoning for
 * keeping them out of a contract module is written down.
 *
 * **No code here is about the *shape* of a path**, and that is a decision
 * rather than an omission. Design spec §7: a `from_path` is a foreign path,
 * possibly Windows-shaped (`D:\Downloads`), and
 * `packages/host/src/clients/paths.ts` refuses `node:path` for exactly that
 * reason -- so a writer that rejected a backslash, demanded a leading `/`
 * or normalised anything would be stricter than the consumer, and would
 * refuse mappings that work. `empty-path` is the one path-content rule
 * there is, and it is about the empty string alone.
 */

/**
 * The wire shape `POST /api/mappings` needs, and what `Host.addMapping`
 * (`packages/host/src/clients/mappings.ts`) accepts to create a mapping.
 *
 * **Declared once, here, rather than mirrored on each side of the wire** --
 * `./feeds.ts`'s `AddFeedInput` doc has the measurement of what mirroring
 * a write input costs (issue #88). A rename here is now a compile error in
 * `@pickarr/web`, not a silent divergence.
 *
 * **Every field is a primitive and none is optional**, for the reason
 * `AddDownloadClientInput` gives at length: these values arrive unchecked
 * out of a JSON request body and `addMapping` is the validator that
 * narrows them, not a caller that has already done so. `downloadClientId`
 * is a plain `number` for the same reason `requestPick`'s `rssItemId` is --
 * the route's shape guard establishes it is a number, and whether that
 * number names a row is the `unknown-client` refusal's business rather
 * than a type's.
 */
export interface AddMappingInput {
  downloadClientId: number;
  fromPath: string;
  toPath: string;
}

/**
 * The wire shape `PATCH /api/mappings/:id` needs, and what
 * `Host.editMapping` replaces a mapping's two mutable columns with.
 *
 * Declared once, here, for the same reason {@link AddMappingInput} is.
 *
 * **Both fields, always, rather than a patch of whichever the caller cares
 * about.** The route is a `PATCH` because it addresses one existing row,
 * not because the body is sparse: a two-field body with one field optional
 * gives "leave it alone" and "set it to the same value" two spellings that
 * the host would have to tell apart, and `exactOptionalPropertyTypes`
 * makes the absent case a third thing again.
 *
 * **`downloadClientId` is absent, and cannot be sent.** A mapping belongs
 * to exactly one client by foreign key and is meaningless away from it
 * (design spec §8), so moving one between clients is not an edit; it is a
 * remove and an add, and the `unknown-client` refusal exists on the add
 * alone because of it.
 */
export interface EditMappingInput {
  fromPath: string;
  toPath: string;
}

/**
 * Every way the three mapping write paths can decline.
 *
 * Written in the order design spec §6's "Refusals" paragraph lists them,
 * which is **not** the order any one module checks them in: `empty-path` is
 * checked first in both `addMapping` and `editMapping`, and
 * `duplicate-from-path` and `unknown-client` can only be discovered by the
 * write itself. Nothing depends on the order either way -- both consumers
 * treat it as a set.
 *
 * - `unknown-client` -- the add named a `download_client` row that does not
 *   exist. Caught from the foreign key, not pre-checked.
 * - `duplicate-from-path` -- the client already has a mapping with that
 *   `from_path`. Caught from migration 19's unique index on
 *   `(download_client_id, from_path)`, not pre-checked, so two concurrent
 *   writes cannot both pass a check and collide.
 * - `unknown-mapping` -- the edit or the remove named a `filepath_mapping`
 *   row that does not exist. A removal that matched nothing is this, never
 *   a silent success.
 * - `empty-path` -- `fromPath` or `toPath` was `''`. An empty `to_path`
 *   maps everything under its prefix to a relative path. An empty
 *   `from_path` is a catch-all for **absolute POSIX paths only**, not for
 *   every path the client reports: `matchesBoundary` needs the remainder
 *   after the prefix to be `''` or to start with `/`, so a Windows-shaped
 *   `D:\Downloads\x` is measurably *not* matched -- the case the paragraph
 *   above insists this contract must accept. It rewrites the paths a
 *   single-filesystem install relies on passing through and misses the
 *   foreign ones a mapping is for.
 *   `packages/host/src/clients/mappings.ts` has the full measurement.
 */
export const MAPPING_REFUSALS = [
  'unknown-client',
  'duplicate-from-path',
  'unknown-mapping',
  'empty-path',
] as const;

/**
 * One of {@link MAPPING_REFUSALS}, as a type.
 *
 * Derived from the array rather than written out beside it, for the reason
 * `./download-clients.ts`'s twin gives: a second spelling of the same four
 * strings is the duplication this module exists to remove, and it would go
 * stale the same way.
 */
export type MappingRefusalCode = (typeof MAPPING_REFUSALS)[number];
