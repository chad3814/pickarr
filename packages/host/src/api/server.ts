/**
 * The read-and-write API on a socket: `node:http`, twenty routes --
 * eighteen behind a session and two open (`/api/health` and the static
 * bundle) -- bound by default to every interface.
 *
 * The split is spelled out because the line that used to stand here said "six
 * routes behind a session", which the paragraph on the guard below -- and
 * `ROUTES` itself, where exactly two entries are `open: true` -- contradicts.
 * A one-line summary disagreeing with its own file is the whole class of
 * defect the comments here are written against. (The count grew to eight
 * when the client-sync slice added `/api/sync` and `/api/sync/backfill`, to
 * nine when it added `/api/sync/bootstrap`, to ten when the shell slice
 * added the static route -- guarded like the other eight except
 * `/api/health` and that one -- to eleven with `POST /api/feeds`, the first
 * route this file answers a write on, to twelve with
 * `POST /api/download-clients`, to thirteen with `POST /api/picks`, and to
 * fifteen with `POST /api/mappings` and `/api/mappings/:id` -- the last of
 * those being one route answering two methods, so the route count and the
 * method count have stopped being the same number; the shape of the
 * sentence is what matters and has not changed -- to sixteen with
 * `PUT /api/destinations/:pluginId`, the importer slice's, and the first
 * `PUT` this API has ever answered, to seventeen with `DELETE` and `PATCH
 * /api/feeds/:id`, a second route answering two methods, and to eighteen
 * with `POST /api/unmatched/:id/retry`, letting an operator ask for an
 * unmatched release to be identified again, and to nineteen with
 * `GET /api/sync/events`, the live-push slice's stream of sync nudges, and
 * to twenty with `GET /api/activity`, the Activities slice's read.)
 *
 * **It said "eleven" through two of those.** The download-clients slice
 * added its route and left both this line and `ROUTES`' own doc reading
 * eleven, so the number was one short before the picks slice made it two.
 * Measured rather than counted by eye, which is the only way this gets
 * caught: `grep -c "^    path: "` on this file.
 *
 * Everything this file does is routing. A request's body is read and capped
 * by `./body.ts`, its shape checked by `./request-shapes.ts`, and a refusal
 * mapped to a status by `./refusal-status.ts`; an id or a plugin id named in
 * a path is read back by `./path-params.ts`, and the `Answer` both this file
 * and `./body.ts` build one of lives in `./answer.ts`. Past that, this file
 * parses a request, calls one function from `./reads.ts`, `./artwork-route.ts`
 * or `./static-route.ts`, and writes what came back.
 *
 * **No SQL here.** Every read is a `reads.ts` call, so the keyset predicates,
 * the page size and the plan-tested statements live in one module with one
 * set of tests over them, rather than being restated by whatever happens to
 * be answering a request. A query written here would also be a query no
 * `EXPLAIN QUERY PLAN` test covers.
 *
 * **Nothing here imports `host.ts`.** The media route needs to know which
 * plugin owns a media type, and `host.ts` owns that registry -- so the
 * mapping arrives as a *function*, `pluginIdForType`, built by `main` from
 * the plugin list it already holds. Importing the registry instead would put
 * `src/api` in a cycle with `host.ts`, and slice D spent real time breaking
 * two of those.
 *
 * **No response body this file composes carries a url, a path or a query
 * string.** A thrown error becomes a 500 with a fixed message; the thrown
 * message goes through `redactText` on its way to the log and never into the
 * response at all. The one caller-supplied value any body repeats is a media
 * type, which the brief requires an unknown type to name -- and `MEDIA_TYPE`
 * below is what keeps that from becoming a way to get a path echoed back.
 *
 * **One sanctioned exception, and only one: `/api/sync`'s and
 * `/api/sync/backfill`'s bodies carry an `rss_feed` op whose `value.url` is a
 * url.** It is not this sentence's rule quietly slipping -- `sync/tables.ts`'s
 * top docblock is where that rule was deliberately amended, and the value
 * here is `redactText`'s output, not the raw column, composed by
 * `sync-route.ts` and `readHostRows` rather than by anything in this file.
 * The redaction is narrower than a raw url deserves -- it catches the
 * `?apikey=` name, plus anything credential-shaped since issue #78, but a
 * secret shorter than eight characters or carrying neither hex shape nor
 * case mixture still reaches this body -- which is why this stays recorded
 * as an exception rather than folded silently into the sentence above.
 *
 * **The auth dispatch's bodies are not this file's, and two of them do carry
 * urls.** That sentence was once unqualified, and `handle` now forwards
 * `/api/auth/*` to `toNodeHandler` ahead of everything, so it has to be
 * scoped. Measured: anonymously, `GET /api/auth/error?error=…` renders a
 * **9,302-byte HTML page** carrying `https://better-auth.com/docs/reference/
 * errors/<error>` **twice** (a plain `href` and an `?askai=` variant) and
 * echoing the caller's own `error` parameter into both -- gated on
 * `/^['A-Za-z0-9_-]+$/`, so anything else becomes `UNKNOWN`, which is why it
 * is garbled markup at worst and not reflected XSS (the library escapes and
 * `encodeURIComponent`s it; a `"><svg/onload=…>` payload does not appear in
 * the body in any form). With `NODE_ENV=production` -- which the Dockerfile's
 * runtime stage sets, and which the library reads at module load, so a probe
 * that set it later could not see this -- the same route answers **302** with
 * an empty body instead. `GET /api/auth/callback/:id` is **302** either way,
 * and every one of those redirects carries a url *and* a query string in its
 * `Location` header (`…/api/auth/error?error=state_not_found`).
 *
 * None of that is a credential and none of it is this host's own urls: it is
 * the library's documentation links plus a caller-supplied code echoed back to
 * that same caller. It is recorded rather than suppressed because the
 * constraint is about bodies this repo emits, and the module doc had stopped
 * being true of the responses that leave this socket.
 *
 * **Every route requires a session except `/api/health` and the static
 * bundle.** Slice E shipped this API unauthenticated, with loopback binding
 * as the whole of the protection; the auth slice's §5 closes it -- and its
 * §6 then reverses the bind, so a session is not the second of two defences
 * but the only one (see `DEFAULT_HOST`). The guard is `refusalFor` below, and
 * it tests the *value* `auth.api.getSession` resolves to, never a status
 * code -- an unauthenticated session check answers `200` with a body of
 * `null` (that slice's §2, measured against better-auth 1.7.3), so a guard
 * written against the status lets every anonymous caller through. Health
 * stays open so a container health check needs no credential; the static
 * route (the shell slice's Task 1) stays open for a different reason -- it
 * is the same bytes for every caller, and it is what a browser has to load
 * before it can render a sign-in form at all, so guarding it would make
 * signing in impossible rather than merely inconvenient. Those are the only
 * two: *which* routes are open is a property of `ROUTES` below rather than
 * of a list written anywhere else, and the tests enumerate that table so a
 * route added later is guarded or the test fails.
 *
 * **The guard is taken in `handle`, ahead of the router.** A table can only
 * speak for the routes in it, and a route mounted beside the auth dispatch is
 * not in it -- measured, by mounting one there and watching all 22 tests
 * pass. Guarding before routing is what makes the next mount inherit the
 * guard by construction.
 *
 * **`/api/auth/*` is dispatched before the guard**, by `toNodeHandler`. It
 * has to be: the route that issues a session cannot require one.
 *
 * **What the session now protects is not only "the library".**
 * `/api/rss-items` serves `RssItemRead.link` unredacted, which for a private
 * tracker or indexer *is* a credential -- it carries the passkey. Behind the
 * guard that, plus every download's `clientRef`, `infohash` and `lastError`,
 * plus artwork bytes for any media item id, plus every media item of every
 * type, is reachable by a session holder and by nobody else. It is still all
 * reachable *to* a session holder: `?type=` is how a caller picks a plugin,
 * not a check on which one it may have, and the `MediaReader` scoping in
 * `../media/reader.ts` is a boundary between plugins inside the process that
 * says nothing about this socket. Auth changed who can read it, not what is
 * served.
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { Auth } from '../auth/instance.ts';
import { redactText } from '../clients/redact.ts';
import type { AddDownloadClientRefusal } from '../clients/add.ts';
import type { MappingRefusal } from '../clients/mappings.ts';
import type { RetryLookupOutcome } from '../media/retry.ts';
import type {
  AddDownloadClientInput,
  AddFeedInput,
  AddMappingInput,
  DestinationRefusalBody,
  EditMappingInput,
} from '@pickarr/contract';
import type { DestinationRefusal, SaveDestinationInput } from '../media/destinations.ts';
import type { PickAccepted, PickRefusal } from '../clients/pick.ts';
import type { AddFeedRefusal } from '../feeds/add.ts';
import type { SyncRegistry } from '../sync/registry.ts';
import type { SyncEvents } from '../sync/events.ts';
import type { ActivityHost } from '@pickarr/contract';
import { readActivity } from './activity.ts';
import type { ArtworkKind } from './artwork-route.ts';
import { ARTWORK_QUERY, readArtwork } from './artwork-route.ts';
import { json } from './answer.ts';
import type { Answer } from './answer.ts';
import { readBody } from './body.ts';
import { decodeCursor, decodeUnionCursor } from './cursor.ts';
import { DIGITS, feedIdFrom, mappingIdFrom, pluginIdFrom, retryIdFrom } from './path-params.ts';
import { deletionsSince, downloadsSince, mediaItemsSince, rssItemsSince } from './reads.ts';
import {
  destinationBodyFrom,
  isDownloadClientBody,
  isFeedBody,
  isMappingBody,
  isMappingEditBody,
  isPickBody,
  isSetFeedDisabledBody,
} from './request-shapes.ts';
import {
  statusForDestinationRefusal,
  statusForDownloadClientRefusal,
  statusForFeedRefusal,
  statusForMappingRefusal,
  statusForPickRefusal,
  statusForRetryRefusal,
} from './refusal-status.ts';
import { isApiPath, staticAnswer } from './static-route.ts';
import { backfillAnswer, bootstrapAnswer, syncAnswer } from './sync-route.ts';
import type { EnableFeedOutcome, FeedRefusal, RemoveFeedOutcome } from '../feeds/remove.ts';

/**
 * The port the shipped process listens on when `PICKARR_READ_API_PORT` says nothing.
 *
 * **7676, and the reason has changed twice.** It was 8080 in 1.x. It became
 * 8787 so a 2.0 host and a 1.x install could share a machine without either
 * being told a port -- a reason that died with 1.x. It is 7676 now because
 * 8787 is readarr's, and two *arr* applications on one host is the ordinary
 * case rather than the exotic one.
 *
 * `packages/web/vite.config.ts` repeats this number as a literal, because
 * web must not import from host to learn it, and
 * `scripts/check-dev-scripts.test.ts` is what holds the two together.
 */
export const DEFAULT_PORT = 7676;

/**
 * How long one request has to arrive in full -- request line, headers and
 * body -- before node answers `408` and drops the socket.
 *
 * **`MAX_BODY_BYTES` bounds how much a client may send; this bounds how long
 * it may take.** Without both, a client that announces `Content-Length: 1000`,
 * sends one byte and stops holds a socket with no response and no refusal:
 * measured on the commit before this one at 15s and still waiting, since the
 * only bound in play was node's own 300s `requestTimeout` default. Nothing in
 * this module timed the read out on its own.
 *
 * **Five seconds, and which bound that is.** `requestTimeout` is the one that
 * applies, because it covers headers *and* body and it is the body that was
 * unbounded here; node's `headersTimeout` alone would not have caught this
 * request, whose headers were complete. The value is sized against
 * `MAX_BODY_BYTES`: 16 KiB in 5s is 3.2 KiB/s, slower than any link a client
 * of this host is reachable over, so no honest request can hit it. It is per
 * request and cleared once the request is fully received, so it bounds
 * neither a slow *response* nor an idle keep-alive connection -- the latter
 * is `keepAliveTimeout`'s (node's 5s default), left alone.
 *
 * `headersTimeout` is left at node's default, which node itself clamps to
 * `requestTimeout` when that is the smaller of the two -- asserted in
 * `server.test.ts` rather than trusted, since a clamp that stopped happening
 * would leave headers bounded at 60s with nothing saying so.
 */
export const REQUEST_TIMEOUT_MS = 5_000;

/**
 * How often node sweeps open connections looking for one that has blown
 * `REQUEST_TIMEOUT_MS`.
 *
 * **Setting `requestTimeout` alone does not bound anything to
 * `requestTimeout`.** Node does not arm a timer per request; it walks the
 * connection list on an interval and answers `408` to whatever it finds
 * expired, so the real bound is the timeout rounded up to the next sweep.
 * With node's 30s default that is what the same slow-body request measured:
 * `requestTimeout` at 5s, `408` arriving at **29,904ms**. Dropping the sweep
 * to one second is what makes the five seconds mean five: the same request
 * measured **5,912ms**. So the bound to quote an operator is
 * `REQUEST_TIMEOUT_MS + CONNECTIONS_CHECK_MS` in the worst case, not
 * `REQUEST_TIMEOUT_MS` alone.
 *
 * One second, not less: the sweep is a walk of the open connections on a
 * timer, so its cost scales with how often it runs, and a tenth of a second
 * would buy nothing a client could notice against a five-second bound.
 */
export const CONNECTIONS_CHECK_MS = 1_000;

/**
 * The read API's own contract version, as `/api/health` reports it -- not the
 * package version.
 *
 * A client polls this to know whether the routes and shapes it was written
 * against are the ones being served, and that question is answered by the
 * *API's* compatibility, not by the release number of the process: a patch
 * release changes the second and must not change the first. Reading
 * `package.json` at runtime was the alternative and is worse in both
 * directions -- it is a filesystem read that can fail, and it would report a
 * number that moves for reasons no client cares about.
 */
export const API_VERSION = 1;

/**
 * Every interface, and the default the shipped process binds when
 * `PICKARR_READ_API_HOST` says nothing.
 *
 * **This reverses slice E's loopback bind, deliberately.** That slice bound
 * `127.0.0.1` and argued for it, on the grounds that the API was
 * unauthenticated and the bind was therefore the whole of its access control.
 * It is not any more: every route but the health check requires a session
 * (see the module doc), and a host reachable only from the machine it runs on
 * cannot serve the client it exists for. The auth slice's §6 configures the
 * interface and its §8 records the consequence in the plainest terms it has
 * -- a session is now the *only* boundary rather than the second of two, so a
 * session-handling defect or a weak password is exposed to whatever network
 * this host sits on.
 *
 * A parameter now, because something has asked to bind something else:
 * `ReadServerDeps.host` overrides this, and that is what
 * `PICKARR_READ_API_HOST` reaches.
 */
export const DEFAULT_HOST = '0.0.0.0';

/**
 * A listening read API.
 *
 * `host` and `family` are read back from `server.address()` rather than
 * echoed from what was asked for, and they are on this interface for a
 * reason the brief's shape did not have room for: what a listener bound is
 * only testable by asserting *what the listener bound*. A test that instead
 * probed an interface would prove nothing either way -- finding nothing on an
 * external interface passes on a machine with no route to it, and finding
 * something asserts the machine's routing table rather than this bind. That
 * reasoning is slice E's, from when the expected value was loopback, and it
 * survives the default having been reversed: only the value changed.
 */
export interface ReadServer {
  /** The address the listener actually bound -- `DEFAULT_HOST`, unless `ReadServerDeps.host` asked for another. */
  host: string;
  /** The port it actually bound, which is the assigned one when 0 was asked for. */
  port: number;
  /** Its address family, so an IPv6 wildcard cannot pass for the IPv4 one. */
  family: string;
  /**
   * Stops the listener. Does **not** drain in-flight requests: open
   * connections are dropped and the promise resolves without waiting for
   * either the drain or the socket teardown. The same choice `Host.stop()`
   * makes about in-flight jobs, for the same reason -- an abandoned read
   * costs a client one retry, and waiting on readers is exactly the coupling
   * the job slice removed.
   *
   * Idempotent. A second call does nothing, rather than asking node to close
   * a server that is not listening -- which, with no callback to hand the
   * resulting `ERR_SERVER_NOT_RUNNING` to, emits an unhandled `'error'` event
   * and takes the process down.
   */
  close(): Promise<void>;
}

/** What `createReadServer` needs, and nothing else it could reach for. */
export interface ReadServerDeps {
  raw: DatabaseSync;
  /**
   * The plugin owning a media type, or `undefined` for a type nothing claims.
   * A function rather than a table because the registry is `host.ts`'s -- see
   * the module doc.
   */
  pluginIdForType: (type: string) => string | undefined;
  /**
   * Validates and writes a new `rss_feed` row -- `Host.addFeed`, handed in
   * as the one operation this route needs rather than the whole `Host`.
   * `ReadServerDeps.host` above already means the bind interface string, so
   * the object cannot also mean the `Host` instance; a function is also all
   * `POST /api/feeds` (`ROUTES` below) ever calls. Resolves a refusal
   * *value* on failure and throws no refusal -- see that method's own doc,
   * which also records what it can still reject with -- so the route maps
   * each refusal to its own status rather than treating one as a bug. A
   * rejection is not a refusal and is not mapped: it falls through to the
   * outermost handler's 500, which is where an infrastructure fault
   * belongs.
   */
  addFeed: (input: AddFeedInput) => Promise<{ id: number } | AddFeedRefusal>;
  /**
   * Validates and writes a new `download_client` row -- `Host.addDownloadClient`,
   * handed in as the one operation this route needs rather than the whole
   * `Host`, for the reason `addFeed` above gives: `ReadServerDeps.host`
   * already means the bind interface string, so the object cannot also mean
   * the `Host` instance. Resolves a refusal *value* on failure and throws
   * no refusal, with the same scope `addFeed` above states: it can still
   * reject on a SQLite error that is not the name collision, on
   * `saveSecret`, or on the reconcile it schedules after the insert, and
   * each of those becomes a 500 here rather than a mapped status.
   *
   * **The one dependency in this interface that is handed a credential.**
   * The submitted api key or password arrives in the POST body, is passed
   * straight through here, and is stored under a generated name by
   * `clients/add.ts`. Nothing in this module reads it, logs it or puts it in
   * a response -- `POST /api/download-clients` answers `{ id }` or
   * `{ refusal }`, both of which carry nothing from the request.
   */
  addDownloadClient: (input: AddDownloadClientInput) => Promise<{ id: number } | AddDownloadClientRefusal>;
  /**
   * Asks for an unmatched release to be identified again -- `Host.retryLookup`,
   * handed in as one function for the same reason `requestPick` below is.
   * Resolves a refusal value; throws only on a fault.
   */
  retryLookup: (rssItemId: number) => Promise<RetryLookupOutcome>;
  /**
   * Submits a pick -- `Host.requestPick`, handed in as the one operation
   * this route needs rather than the whole `Host`, for the reason `addFeed`
   * above gives: `ReadServerDeps.host` already means the bind interface
   * string, so the object cannot also mean the `Host` instance, and a
   * function is all `POST /api/picks` ever calls.
   *
   * **A function is also what keeps `requestDownload` out of reach.** The
   * `Host` carries both, and `requestDownload` is the throwing one: handing
   * this module the object would put the method whose refusals arrive as
   * exceptions one property access away from the route that must not use
   * it.
   *
   * Resolves a refusal *value* on failure and throws no refusal, with the
   * same scope the two above state: anything `Host.requestPick` does not
   * recognise as a refusal is rethrown -- a plugin's own bug, a download
   * client that could not be reached, a closed database -- and each of
   * those becomes a 500 here rather than a mapped status.
   */
  requestPick: (rssItemId: number) => Promise<PickAccepted | PickRefusal>;
  /**
   * Writes a new `filepath_mapping` row -- `Host.addMapping`, handed in as
   * one function rather than the whole `Host`, for the reason `addFeed`
   * above gives.
   *
   * Resolves a refusal *value* on failure and throws no refusal, with the
   * same scope the three above state: a SQLite error that is neither the
   * foreign-key nor the unique-index violation is rethrown by
   * `clients/mappings.ts` and becomes a 500 here rather than a mapped
   * status.
   */
  addMapping: (input: AddMappingInput) => Promise<{ id: number } | MappingRefusal>;
  /**
   * Replaces one mapping's two paths -- `Host.editMapping`, wired the same
   * way as `addMapping` above and with the same guarantees. `id` is a
   * separate argument rather than a field of the input because it comes
   * from the request *path*, not from the body: see `mappingIdFrom`.
   */
  editMapping: (id: number, input: EditMappingInput) => Promise<{ id: number } | MappingRefusal>;
  /**
   * Deletes one mapping -- `Host.removeMapping`, wired the same way again.
   * Resolves `{ id }` for a row that was there and `unknown-mapping` for
   * one that was not; the route discards the id, since a `204` carries no
   * body to put it in.
   */
  removeMapping: (id: number) => Promise<{ id: number } | MappingRefusal>;
  /** `Host.removeFeed` -- deletes a feed with no releases, disables one with. */
  removeFeed: (id: number) => Promise<RemoveFeedOutcome>;
  /** `Host.setFeedDisabled` -- pauses or resumes polling, removing nothing. */
  setFeedDisabled: (
    id: number,
    disabled: boolean,
  ) => Promise<EnableFeedOutcome | { readonly outcome: 'disabled' } | FeedRefusal>;
  /**
   * Writes one plugin's library destination -- `Host.saveDestination`,
   * handed in as one function rather than the whole `Host`, for the reason
   * `addFeed` above gives.
   *
   * `pluginId` is a separate argument rather than a field of the input
   * because it comes from the request *path*, not from the body: see
   * `pluginIdFrom`, and `editMapping` above for the same split.
   *
   * **The one dependency here that needs the plugin registry**, which is
   * exactly why it arrives as a function. Validating a shape needs the
   * declaring plugin's declared tokens (design spec §3), `host.ts` owns that
   * registry, and nothing under `src/api` may import `host.ts` without
   * putting the read layer in a cycle with it -- the same constraint
   * `pluginIdForType` above solves the same way.
   *
   * Resolves a refusal *value* on failure and throws no refusal, with the
   * same scope the four above state: a SQLite error, or an upsert that
   * answered no row, is rethrown by `media/destinations.ts` and becomes a
   * 500 here rather than a mapped status.
   */
  saveDestination: (pluginId: string, input: SaveDestinationInput) => Promise<{ id: number } | DestinationRefusal>;
  /**
   * Host tables plus every plugin's declared tables, as one lookup --
   * `sync/registry.ts`'s `createSyncRegistry(raw, plugins)`. What `/api/sync`
   * and `/api/sync/backfill` read current state through; see `sync-route.ts`.
   *
   * Built by `main`, from the same plugin list `pluginIdForType` is built
   * from, and passed in rather than reached for here -- `createSyncRegistry`
   * is `sync/registry.ts`'s, not `host.ts`'s, but importing it from
   * `src/api` directly would still mean two independent constructions of the
   * same lookup, from the same list, on every boot. One construction, held
   * here, is what keeps them from ever disagreeing about what a plugin
   * declared.
   */
  registry: SyncRegistry;
  /**
   * This database's sync generation, on the body of all three sync routes and
   * on none of the others -- `db/host-state.ts`'s `ensureSyncGeneration`, and
   * `sync-route.ts`'s `GenerationDeps` for what a client does with it.
   *
   * **Resolved once by `main` and held here, not read per request.** It
   * cannot change while this process holds the database open -- it is minted
   * on first read and persisted, and a value that changed would mean a
   * different database -- so reading it per request would be one query per
   * sync request for a constant a client polls for.
   *
   * A `string` and not the reader itself, for the same reason: there is
   * nothing here to defer. `authFor` is a function because `baseURL` is not
   * known until the listener has bound; this is known before it.
   */
  generation: string;
  /**
   * The event hub `GET /api/sync/events` attaches to (`sync/events.ts`).
   * Built by `main.ts` and the e2e harness; a test builds a quiet one.
   */
  events: SyncEvents;
  /** The fetch layer's `snapshot`, which `GET /api/activity` reads; a test hands in a constant. */
  fetchSnapshot: () => readonly ActivityHost[];
  /**
   * The interface to bind, or `undefined` for `DEFAULT_HOST`.
   *
   * **`main` no longer passes `undefined` here.** `HostSettings.readHost`
   * (`main.ts`'s `resolveSettings`) is typed as a plain `string`: an unset
   * `PICKARR_READ_API_HOST` now resolves through the config file's `server.host`
   * and, absent that, `serverConfigSchema`'s own default -- which is this
   * same value, `'0.0.0.0'`, carried in exactly one place. `undefined`
   * remains a legal value on this type for any other caller that wants the
   * listener's own default without naming it (a test, for instance); it is
   * simply not one `main` reaches for any more.
   *
   * Required-but-nullable rather than optional: `exactOptionalPropertyTypes`
   * is on, so an optional property would make "absent" and "explicitly
   * undefined" two different things for a caller forwarding a value it read
   * from the environment, and there is only one thing they could mean here.
   */
  host: string | undefined;
  /** 0 asks the kernel for a free port, which `ReadServer.port` then reports. */
  port: number;
  /**
   * The built bundle's own directory, as `static-route.ts`'s `staticAnswer`
   * reads it -- `server.webRoot`, already resolved to a concrete string.
   *
   * `main` never passes an absent value here, the same way it no longer
   * passes one for `host`: `HostSettings.webRoot` derives a default (`web`
   * beside the host's own `dist`) when the config file names none, so this
   * is always a real path to try, even on a development host where that
   * derived path does not exist -- see `warnIfWebRootMissing`, which `main`
   * calls once at boot precisely because this field cannot say "there is no
   * bundle" on its own. A required `string` rather than `string | undefined`
   * for the same reason `generation` below is a plain `string`: nothing here
   * would do anything useful with an absent value that `staticAnswer`'s own
   * graceful fallback does not already do with a present-but-wrong one.
   */
  webRoot: string;
  /**
   * Better Auth, built **from the origin the listener actually bound**.
   *
   * A function rather than an instance because of an ordering constraint the
   * auth slice's §2 measured: Better Auth refuses every state-changing request
   * whose `Origin` is not `baseURL`'s, so the reachable address has to be known
   * before `betterAuth()` is constructed -- and with `port: 0` it is not known
   * until the listener has bound. So `createReadServer` listens first, reads
   * `server.address()`, and calls this back with `http://<host>:<port>`.
   *
   * That is not a test artifact. Production has the same problem in the same
   * order, and solves it the same way; what production adds is that `main`
   * prefers `PICKARR_PUBLIC_URL` over the address passed here when the host is
   * behind a proxy, which is a decision for the caller of this rather than for
   * the listener.
   */
  authFor: (baseURL: string) => Auth;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/**
 * The fixed `204` a successful delete answers: a status, and nothing else.
 *
 * A module-level constant rather than a value built per request, because
 * there is nothing in it that could vary -- and in particular nothing from
 * the request, which is the rule every fixed answer in this file follows.
 */
const NO_CONTENT: Answer = { kind: 'empty', status: 204 };

/** The fixed 404 every unrecognised path and every unparseable one answers. */
const UNKNOWN_ROUTE = json(404, { error: 'unknown route' });

/**
 * The fixed 401 every guarded route answers a caller with no session.
 *
 * One sentence, carrying no url, path or query string -- the same discipline
 * the 500 below follows, and for the same reason: the request that was
 * refused is the request of someone who has not identified themselves, so
 * nothing derived from it may be echoed back. It does not say *why* either;
 * an expired session and no session at all are the same answer, because a
 * client's only useful response to both is to sign in again.
 */
const UNAUTHORIZED = json(401, { error: 'unauthorized' });

/**
 * What a media type may look like for an unknown one to be named back at the
 * caller.
 *
 * The `/api/media` and `/api/deletions` routes are required to answer an
 * unknown type by naming it, and the type is a value the caller chose -- so
 * without this, `?type=/etc/passwd` or `?type=x?apikey=k` would be a way to
 * get a path or a query string into a response body, which is the one thing
 * no body here may carry. A real media type is a short word (`movie`,
 * `show`, `scene`); anything outside that is refused *without* being
 * repeated, so the rule holds for every possible input rather than for the
 * inputs that were thought of.
 */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

/**
 * Only `readArtwork`'s two filesystem calls, and the real ones -- the async
 * `node:fs/promises` pair, never the `*Sync` twins: this server shares its
 * event loop with the job dispatcher, and a synchronous read of a poster
 * would stall every job and every other request with it.
 *
 * At module scope rather than built per request or per server: it closes over
 * nothing, and `unicorn(consistent-function-scoping)` is right that a
 * function which captures nothing does not belong inside another.
 */
const ARTWORK_FILES = {
  readFile,
  stat: async (path: string): Promise<{ mtimeMs: number; size: number }> => {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  },
};

/**
 * `staticAnswer`'s pair, on the same reasoning as `ARTWORK_FILES` -- real,
 * async, never the `*Sync` twins, and a separate object rather than the same
 * one because these serve the built bundle, not artwork, even though the
 * wrapped calls happen to be identical.
 */
const STATIC_FILES = {
  readFile,
  stat: async (path: string): Promise<{ mtimeMs: number; size: number }> => {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, size: info.size };
  },
};

/**
 * The base a request target is resolved against. A request line carries a
 * path, not an absolute url, and `new URL` needs one; nothing reads the host
 * back off this -- only `pathname` and `searchParams` are ever used.
 */
const REQUEST_BASE = 'http://127.0.0.1';

/**
 * `null` for a target `new URL` cannot parse, which is answered as an unknown
 * route rather than a 500 -- and `null` too for one it parses into a
 * *different origin* than the base.
 *
 * That second case is why this is more than a `try`. A target beginning `//`
 * is protocol-relative, so `new URL('//api/health', base)` yields host `api`
 * and pathname `/health`: the first segment is eaten as an authority and the
 * server never sees the `/api` it was asked for. Since nothing here reads the
 * host back, that loss was silent, and `//api/media` answered the bundle
 * instead of the guarded route's 401. Refusing a reinterpreted origin is the
 * fix at the boundary, rather than teaching every downstream check about a
 * shape that should never have got past parsing.
 *
 * This server only ever receives origin-form targets. Absolute-form is legal
 * in HTTP/1.1 for proxies and is not something a browser sends here, so
 * refusing it costs nothing a real client does.
 */
function targetOf(url: string | undefined): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url ?? '/', REQUEST_BASE);
  } catch {
    return null;
  }
  return parsed.origin === REQUEST_BASE ? parsed : null;
}

/** A cursor as it arrived on the query string: absent and empty are both "no cursor". */
function since(params: URLSearchParams): string | undefined {
  const raw = params.get('since');
  return raw === null || raw === '' ? undefined : raw;
}

/**
 * The plugin a request's `type` names, or the reply that says why there
 * isn't one. A 400 for a missing type and a 404 for a type nothing claims
 * are genuinely different answers: the first is a malformed request that
 * every poll will repeat until the client is fixed, the second is a
 * well-formed question about a type this host does not serve.
 */
function pluginFor(
  params: URLSearchParams,
  pluginIdForType: (type: string) => string | undefined,
): { pluginId: string } | { refusal: Answer } {
  const type = params.get('type');
  if (type === null || type === '') {
    return { refusal: json(400, { error: 'a type query parameter is required' }) };
  }
  // Refused before it could be echoed -- see `MEDIA_TYPE`.
  if (!MEDIA_TYPE.test(type)) {
    return { refusal: json(404, { error: 'unknown media type' }) };
  }
  const pluginId = pluginIdForType(type);
  if (pluginId === undefined) {
    return { refusal: json(404, { error: `unknown media type: ${type}` }) };
  }
  return { pluginId };
}

/**
 * Derived from `ARTWORK_QUERY`'s own keys, not a hand-written disjunction --
 * a literal chain (`value === 'poster' || ...`) type-checks as long as it
 * narrows to *some* subset of `ArtworkKind`, so a chain that named only
 * three of four kinds was still a well-typed `value is ArtworkKind` and the
 * compiler had no way to flag the missing one. That is exactly how `person`
 * stayed unreachable over HTTP after `ArtworkKind` grew a fourth member: the
 * guard silently stopped covering the type it claims to guard, and nothing
 * failed to compile.
 *
 * `ARTWORK_QUERY` is typed `Record<ArtworkKind, string>`, so it is missing
 * no key `ArtworkKind` has -- TypeScript refuses the object literal
 * otherwise. `Object.hasOwn` against those keys therefore admits exactly
 * `ArtworkKind`'s members, automatically, with no separate list to keep in
 * step. Adding a fifth kind to `ArtworkKind` and leaving `ARTWORK_QUERY`
 * untouched is a compile error at `ARTWORK_QUERY`'s own declaration (a
 * missing property on a `Record`), which is what forces the one place this
 * guard actually reads to grow with the type -- checked by attempting it:
 * widening `ArtworkKind` alone, with no other change, fails
 * `npm run typecheck` on `ARTWORK_QUERY`'s literal.
 */
function isArtworkKind(value: string): value is ArtworkKind {
  return Object.hasOwn(ARTWORK_QUERY, value);
}

/**
 * `/api/artwork/:kind/:mediaItemId`, or the unknown-route 404 for anything
 * shaped differently.
 *
 * Every segment is read by index and checked, never `!`-asserted:
 * `noUncheckedIndexedAccess` types each one `string | undefined`, and a path
 * with the right number of slashes and an empty segment is a real request a
 * client can send. An id that is not a safe integer is refused here too --
 * `Number('9'.repeat(30))` is a float, and handing a float to a parameter
 * bound against an `INTEGER PRIMARY KEY` is a 500 for a request that only
 * ever meant "not found".
 */
async function artworkAnswer(
  raw: DatabaseSync,
  pathname: string,
  ifNoneMatch: string | undefined,
): Promise<Answer> {
  const segments = pathname.split('/');
  if (segments.length !== 5) return UNKNOWN_ROUTE;
  const kind = segments[3];
  const id = segments[4];
  if (kind === undefined || id === undefined) return UNKNOWN_ROUTE;
  if (!isArtworkKind(kind) || !DIGITS.test(id)) return UNKNOWN_ROUTE;

  const ownerId = Number(id);
  if (!Number.isSafeInteger(ownerId)) return UNKNOWN_ROUTE;

  return {
    kind: 'artwork',
    artwork: await readArtwork(raw, kind, ownerId, ARTWORK_FILES, ifNoneMatch),
  };
}

/**
 * `/*` -- everything `routeFor` reaches this route for, which `matchesPath`
 * has already confined to paths outside `/api` (see that function). Wraps
 * `static-route.ts`'s `staticAnswer` into an `Answer` the same way
 * `artworkAnswer` wraps `readArtwork`: the filesystem shape lives one file
 * over, tested without a socket, and this is only the routing glue.
 */
async function staticRouteAnswer(
  webRoot: string,
  pathname: string,
  ifNoneMatch: string | undefined,
): Promise<Answer> {
  return {
    kind: 'static',
    file: await staticAnswer({ webRoot, readFile: STATIC_FILES.readFile, stat: STATIC_FILES.stat }, pathname, ifNoneMatch),
  };
}

/**
 * Where Better Auth is mounted, spelled as it arrives on the wire -- Better
 * Auth's own `basePath` default, which `createAuth` does not override.
 */
const AUTH_BASE = '/api/auth';

/**
 * Whether a path belongs to Better Auth rather than to this module.
 *
 * The trailing slash is load-bearing: without it a route named
 * `/api/authors` would be handed to Better Auth, which knows nothing about
 * it. The base itself is included so `/api/auth` is Better Auth's 404 rather
 * than this module's.
 *
 * **Measured, and pinned.** Under `return pathname.startsWith(AUTH_BASE)` the
 * whole `/api/auth*` prefix space escapes the guard: anonymous
 * `GET /api/authx` answers the library's 404 instead of this module's 401.
 * That mutation passed the entire suite until
 * `test/api/server.test.ts`'s `AUTH_PREFIX_PROBE` test existed -- the nearest
 * test used `/api/rss-items-v2`, which does not share the prefix and so
 * exercises the router rather than this function. It is the one surviving
 * mutation the whole-branch review found, and it is now the single failure
 * under it.
 */
function isAuthPath(pathname: string): boolean {
  return pathname === AUTH_BASE || pathname.startsWith(`${AUTH_BASE}/`);
}

/**
 * Everything one request is answered against.
 *
 * Separate from `ReadServerDeps` because the auth instance cannot exist when
 * the deps are assembled: it is built from the address the listener bound, so
 * it comes into being between `listen` and the first request. See
 * `ReadServerDeps.authFor`.
 */
interface Serving {
  deps: ReadServerDeps;
  auth: Auth;
  /**
   * `toNodeHandler(auth)`, built once rather than per request -- it writes the
   * response itself, which is why the auth mount is not an `Answer`.
   */
  dispatchAuth: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
}

/** One request, as the route that answers it needs to see it. */
interface RouteRequest {
  deps: ReadServerDeps;
  request: IncomingMessage;
  /** The path, already parsed -- the artwork route reads its own segments back off it. */
  pathname: string;
  /** The query string, which is where every route but artwork takes its arguments. */
  params: URLSearchParams;
  /**
   * The request body, already read, capped and json-parsed by `handle` --
   * `undefined` for a `GET`, which never has one read, and `undefined`
   * too for a request that sent an empty one (a `DELETE`, ordinarily; see
   * `readBody`). `unknown` because
   * nothing here has checked its shape yet: that is each route's own job,
   * the same way `addFeed` (`../feeds/add.ts`) is the validator for the
   * fields inside it rather than a caller that has already done so.
   */
  body: unknown;
}

/**
 * One route: the path it answers, whether it answers a caller with no
 * session, and the answer.
 *
 * **This table is the only statement of which routes are guarded**, and the
 * tests enumerate it rather than listing paths of their own -- so a route
 * added by a later slice is either marked here or it is refused, and a
 * hand-written list of six paths cannot go quietly stale beside a seventh
 * route nobody guarded. This codebase has produced ten stale-documentation
 * defects; a list of routes kept in a test is the same failure in test form.
 */
interface Route {
  /**
   * The path, with `:name` for a segment the route reads back rather than
   * matches. Compared segment by segment, so `/api/artwork/poster/1` matches
   * `/api/artwork/:kind/:mediaItemId` and `/api/artwork/poster` -- one
   * segment short -- matches nothing and is an unknown route.
   */
  readonly path: string;
  /**
   * The HTTP methods this route answers. **Required, not defaulted**: a
   * route added without thinking about its methods is exactly the route
   * that should not silently accept a write. Until this slice the guard was
   * one line rejecting every non-GET before dispatch, which is what kept
   * `/api` read-only; making each route declare its own is what lets one
   * route accept a POST without opening the rest.
   */
  readonly methods: readonly string[];
  /**
   * Whether a caller with no session may reach it. `true` on exactly two
   * routes, and the tests assert that count rather than trusting it.
   */
  readonly open: boolean;
  readonly answer: (route: RouteRequest) => Answer | Promise<Answer>;
}

/**
 * The static route's own `path`, in `ROUTES` -- a sentinel `matchesPath`
 * recognises and handles before its ordinary segment comparison ever runs,
 * not a template built from `:name` segments the way every other route's is
 * (see that function). `probeFor` in the tests also sends it as a literal
 * request path, which is harmless: `/*` names no real file under any web
 * root, so `staticAnswer` answers it with `index.html`, exactly as it would
 * any other path nothing on disk matches.
 */
const STATIC_ROUTE_PATH = '/*';

/**
 * The twenty routes -- eighteen guarded, two `open: true`, the same split
 * this module's own doc states. Twenty *routes*, twenty-two
 * route-and-method pairs: `/api/mappings/:id` and `/api/feeds/:id` are the
 * two entries here that declare two methods each, so the two counts have
 * parted company and a reader counting "endpoints" will get a different
 * number than `grep` does.
 *
 * **It said "ten" until the final review counted them, and then "eleven"
 * for two slices while the table held twelve.** `POST /api/feeds` made
 * eleven and the slice that added it updated the module doc twenty lines
 * above -- the one whose whole opening paragraph exists because its
 * predecessor said "six routes" and was wrong -- while missing this line;
 * the download-clients slice then added a twelfth and updated neither.
 * (The picks slice made it thirteen and corrected both; the mappings slice
 * made it fifteen and the importer slice sixteen. The feed-removal slice
 * made it seventeen and the retry slice eighteen, both missing this line
 * too. The live-push slice's `GET /api/sync/events` made it nineteen
 * and the Activities slice's `GET /api/activity` twenty.
 * Measured with the `grep` below on each occasion, not incremented on
 * sight -- `20` on this tree.) That is not an argument for deleting the number:
 * a reader wants to know whether the table below is the whole set. It is
 * an argument for checking it, because no test pins the total and none
 * can usefully. The one count assertion in `api/server.test.ts` is
 * `assert.equal(guarded.length, ROUTES.length - 2)`, which derives its
 * expectation from the code under test and so pins the *open* count
 * without being able to see the total move. `grep -c "^    path: "` on this
 * file is what actually answers it.
 *
 * Exported because the tests derive their request set from it; nothing else
 * reads it, and nothing may mutate it.
 */
export const ROUTES: readonly Route[] = [
  {
    path: '/api/health',
    // One of two open routes: a container health check has no credential to
    // offer, and the body it answers names nothing a caller could not guess.
    // **No `generation` here**, deliberately: it is on all three sync routes
    // and it is an install fingerprint, so serving it without a session would
    // let a scanner tell two hosts apart and notice a rebuild. See
    // `sync-route.ts`'s `GenerationDeps`.
    methods: ['GET'],
    open: true,
    answer: () => json(200, { ok: true, version: API_VERSION }),
  },
  {
    path: '/api/media',
    methods: ['GET'],
    open: false,
    answer: ({ deps, params }) => {
      const resolved = pluginFor(params, deps.pluginIdForType);
      if ('refusal' in resolved) return resolved.refusal;
      return json(200, mediaItemsSince(deps.raw, resolved.pluginId, decodeCursor(since(params))));
    },
  },
  {
    path: '/api/rss-items',
    methods: ['GET'],
    open: false,
    // Not type-scoped, deliberately: a feed's `plugin_id` says who polls it,
    // not who may read what it found. See `rssItemsSince`.
    answer: ({ deps, params }) => json(200, rssItemsSince(deps.raw, decodeCursor(since(params)))),
  },
  {
    path: '/api/downloads',
    methods: ['GET'],
    open: false,
    // The union pair, not the plain one: `id` is a per-table rowid, so a
    // two-part cursor cannot say which table's row was already served. See
    // `UnionCursor`.
    //
    // Not type-scoped either, for the reason `/api/rss-items` gives: a
    // download hangs off an rss item, which hangs off a feed, and a feed's
    // `plugin_id` is who polls it. Every client syncs one download stream.
    answer: ({ deps, params }) => json(200, downloadsSince(deps.raw, decodeUnionCursor(since(params)))),
  },
  {
    path: '/api/deletions',
    methods: ['GET'],
    open: false,
    answer: ({ deps, params }) => {
      // Type-scoped, unlike the spec's own route sketch, and it has to be: a
      // tombstone carries the `plugin_id` that owned the row precisely because
      // there is no `media_item` left to join to, and `deletionsSince` reads
      // only one plugin's. Without a type there is no plugin id to pass, and
      // serving every plugin's tombstones from one unscoped route would hand a
      // client ids the scoped media route never showed it.
      const resolved = pluginFor(params, deps.pluginIdForType);
      if ('refusal' in resolved) return resolved.refusal;
      const page = deletionsSince(deps.raw, resolved.pluginId, decodeCursor(since(params)));
      // `ids`, not `items`, per slice E's §5: the page carries ids and nothing
      // else, and calling them `items` would suggest rows a client could read.
      return json(200, { ids: page.items, cursor: page.cursor, done: page.done });
    },
  },
  {
    path: '/api/artwork/:kind/:mediaItemId',
    methods: ['GET'],
    open: false,
    // No `type`, and no ownership check on the media item id: an accepted
    // consequence rather than an omission, and slice E's §5 records it.
    // Scoping it would confine nobody -- artwork is not on `MediaReader` at
    // all, and `ctx.db` is the raw connection. What it adds is a
    // 404-versus-200 existence oracle by integer id, which
    // `/api/media?type=<each of four>` already answers outright to the same
    // caller.
    //
    // **And that caller now holds a session.** Slice E accepted the oracle
    // because every route was equally open; the auth slice's §5 keeps it
    // accepted for a different reason -- an unauthenticated caller cannot
    // reach this route at all, which is the point of guarding it.
    answer: ({ deps, request, pathname }) => artworkAnswer(
      deps.raw,
      pathname,
      request.headers['if-none-match'],
    ),
  },
  {
    path: '/api/sync',
    methods: ['GET'],
    open: false,
    // A replica of the whole library is exactly what the session guard
    // exists to protect (design spec §5) -- this route and the next are as
    // guarded as every other, never a special case.
    answer: ({ deps, params }) => {
      const answer = syncAnswer(
        { raw: deps.raw, registry: deps.registry, generation: deps.generation },
        params,
      );
      return json(answer.status, answer.body);
    },
  },
  {
    path: '/api/sync/events',
    methods: ['GET'],
    open: false,
    // As guarded as `/api/sync` itself: a stream of "the library changed"
    // is a side channel onto the same data, and the session guard runs
    // before this answer is ever built (design spec 2026-10-01 §2).
    answer: ({ deps }) => ({ kind: 'stream', attach: (response) => { deps.events.attach(response); } }),
  },
  {
    path: '/api/activity',
    methods: ['GET'],
    open: false,
    // The host's own work is as private as the library it works on.
    answer: ({ deps }) => json(200, readActivity(deps.raw, deps.fetchSnapshot)),
  },
  {
    path: '/api/sync/bootstrap',
    methods: ['GET'],
    open: false,
    // Where an empty client starts both cursors. Guarded like the two it
    // feeds: the answer is two log positions and the sync generation, but a
    // caller with no session has no business being handed a way into the
    // replica -- nor, for the generation, an install fingerprint.
    answer: ({ deps }) => {
      const answer = bootstrapAnswer({ raw: deps.raw, generation: deps.generation });
      return json(answer.status, answer.body);
    },
  },
  {
    path: '/api/sync/backfill',
    methods: ['GET'],
    open: false,
    // Two segments under `/api/sync`, one literal and one -- see
    // `matchesPath` -- which is what keeps this from shadowing or being
    // shadowed by the route above: `matchesPath` compares segment *counts*
    // first, so a three-segment request never matches this four-segment
    // template and a four-segment request never matches that three-segment
    // one. `/api/artwork/:kind/:mediaItemId` is the existing precedent for a
    // multi-segment path coexisting with shorter ones in this same table.
    answer: ({ deps, params }) => {
      const answer = backfillAnswer(
        { raw: deps.raw, registry: deps.registry, generation: deps.generation },
        params,
      );
      return json(answer.status, answer.body);
    },
  },
  {
    path: '/api/feeds',
    methods: ['POST'],
    open: false,
    // Writes a new `rss_feed` row through `deps.addFeed` -- the first write
    // this API has ever answered, and guarded like every read: a caller with
    // no session has no more business creating a feed than reading one.
    //
    // Only the body's *shape* is checked here (the fields exist and have the
    // right primitive types, via `isFeedBody`); the invariants on their
    // values -- a registered plugin, a real transport, a poll interval in
    // range -- live in `feeds/add.ts`'s `addFeed`, per the module doc's rule
    // that no SQL and no business rule belongs in this file. Duplicating
    // them here is how the two copies drift.
    answer: async ({ deps, body }) => {
      // `{ refusal }` and no prose, for the reason `MALFORMED_BODY`'s doc
      // gives: these two are the only answers here that share a status, so
      // an english string was the whole of what told them apart.
      if (!isFeedBody(body)) return json(400, { refusal: 'invalid-shape' });
      const result = await deps.addFeed(body);
      if ('refusal' in result) {
        return json(statusForFeedRefusal(result.refusal), { refusal: result.refusal });
      }
      return json(201, { id: result.id });
    },
  },
  {
    path: '/api/download-clients',
    methods: ['POST'],
    open: false,
    // Writes a new `download_client` row through `deps.addDownloadClient`,
    // shaped exactly like `POST /api/feeds` above and guarded the same way:
    // a caller with no session has no more business configuring a download
    // client than reading one.
    //
    // **This is the one route that receives a credential**, and the whole
    // of what it does with it is hand it on. The api key or password
    // arrives in the body, `isDownloadClientBody` confirms it is a string
    // and reads nothing of its content, and `clients/add.ts` stores it
    // under a generated name in the `secret` table. Neither answer below
    // carries anything from the request: `{ id }` on success, `{ refusal }`
    // on every failure. There is deliberately no branch here that could
    // quote the body -- see this module's doc on why no response may carry
    // prose in place of a stable code, which is also what keeps a helpful
    // error message from becoming a credential in a log.
    //
    // Only the body's *shape* is checked here; the invariants on the values
    // -- a known implementation, an auth shape some strategy can use, a url
    // that is an address, a name not already taken -- live in
    // `clients/add.ts`, per the module doc's rule that no SQL and no
    // business rule belongs in this file.
    answer: async ({ deps, body }) => {
      // `{ refusal }` and no prose, for the reason `MALFORMED_BODY`'s doc
      // gives: these two are the only answers here that share a status.
      if (!isDownloadClientBody(body)) return json(400, { refusal: 'invalid-shape' });
      const result = await deps.addDownloadClient(body);
      if ('refusal' in result) {
        return json(statusForDownloadClientRefusal(result.refusal), { refusal: result.refusal });
      }
      return json(201, { id: result.id });
    },
  },
  {
    path: '/api/picks',
    methods: ['POST'],
    open: false,
    // Submits one pick through `deps.requestPick`, shaped exactly like the
    // two POST routes above and guarded the same way. It is the third write
    // this API answers and the one the other two were leading to: the
    // download path has existed for several slices with no caller.
    //
    // Only the body's *shape* is checked here -- one field, a number, via
    // `isPickBody`. Every value-level invariant, including whether that id
    // names a row at all, lives in `../clients/pick.ts` and what it wraps,
    // per the module doc's rule that no SQL and no business rule belongs in
    // this file.
    //
    // **202, and not 201.** The reason is *not* that nothing was created by
    // the time this answers -- that is the obvious argument and it is
    // false. Measured on this tree: `clients/downloads.ts` inserts the
    // download row *before* it calls the client, and `submit` is awaited
    // the whole way up through the plugin's `onDownloadRequest`,
    // `requestDownload` and `requestPick`, so with the production wiring a
    // `torrent_download` row is on file, usually already `submitted`,
    // before this line runs. `clients/pick.test.ts` reads exactly that row
    // straight after an `accepted`.
    //
    // What is actually true is narrower, and is what 202 means: the request
    // has been accepted and its processing is not complete.
    //
    //  - **The host cannot say a row exists, because nothing tells it
    //    one does.** `MediaPlugin.onDownloadRequest` returns
    //    `Promise<void>`, and `host.ts`'s `requestDownload` awaits it and
    //    reads nothing off it. `ctx.downloads.submit` does answer a
    //    reference, but it answers it to the *plugin*, which the contract
    //    does not oblige to call it at all -- so `accepted` here means
    //    "the owning plugin's handler resolved" and cannot be strengthened
    //    into "a row was written" by anything on this path. A `201` would
    //    be the host asserting a fact no value it holds carries.
    //
    //    This bullet used to cite `packages/e2e/src/harness-2.ts`'s
    //    `stubPlugin` as `async onDownloadRequest() {}`. `d983fde` changed
    //    that handler to submit for real, so the example no longer exists
    //    on this tree even though the conclusion did not depend on it: the
    //    argument above is about the return type of the contract's own
    //    method, which is checkable from `packages/contract` without
    //    looking for a plugin that happens to write nothing.
    //  - **A row that does exist may not be a download yet.** `submit`
    //    answers `null` for a `.torrent` the client did not resolve, which
    //    leaves the row `submitting` with no `client_ref` for the reconcile
    //    job to settle later -- and that row can still end `failed`.
    //  - **There is no resource to point at.** A `201` names what it made,
    //    by id or by `Location`; this answers `{ accepted: true }` and
    //    there is no `/api/picks/:id` to serve. What a pick eventually
    //    produces is a download row the browser learns about through the
    //    sync replica, not through this response.
    answer: async ({ deps, body }) => {
      // `{ refusal }` and no prose, for the reason `MALFORMED_BODY`'s doc
      // gives: these two are the only answers here that share a status.
      if (!isPickBody(body)) return json(400, { refusal: 'invalid-shape' });
      const result = await deps.requestPick(body.rssItemId);
      if ('refusal' in result) {
        return json(statusForPickRefusal(result.refusal), { refusal: result.refusal });
      }
      return json(202, { accepted: true });
    },
  },
  {
    path: '/api/unmatched/:id/retry',
    methods: ['POST'],
    open: false,
    // Asks for one unmatched release to be identified again. The lookup
    // engine leaves a name it did not recognise `unresolved` and enqueues
    // nothing, calling it "the state a human might fix"; this is how the
    // human says they have.
    //
    // **The id is in the path and there is no body**, unlike `/api/picks`
    // next door, which takes `{ rssItemId }`. The difference is not style:
    // a pick names the thing it acts on as data because the route is about
    // picks in general, while this route acts on one already-identified
    // resource and has nothing else to say about it. A body would be a
    // second place the id could come from and a second shape to guard.
    //
    // **202, on `/api/picks`'s reasoning and more plainly than there.**
    // Nothing is finished when this answers: `retryLookup` enqueues a job
    // and returns, the service has not been asked yet, and what the
    // browser eventually sees -- a new lookup state, or the release leaving
    // `/unmatched` entirely -- arrives through the sync replica rather
    // than through this response. There is no resource to point a 201 at.
    answer: async ({ deps, pathname }) => {
      const id = retryIdFrom(pathname);
      if (id === undefined) return UNKNOWN_ROUTE;
      const result = await deps.retryLookup(id);
      if ('refusal' in result) {
        return json(statusForRetryRefusal(result.refusal), { refusal: result.refusal });
      }
      return json(202, { accepted: true });
    },
  },
  {
    path: '/api/mappings',
    methods: ['POST'],
    open: false,
    // Writes a new `filepath_mapping` row through `deps.addMapping`, shaped
    // exactly like the three POST routes above and guarded the same way: a
    // caller with no session has no more business configuring where this
    // host looks for a file than reading which files it has.
    //
    // Only the body's *shape* is checked here; every value-level invariant
    // -- a client that exists, a `from_path` this client has not already
    // claimed, neither path empty -- lives in `../clients/mappings.ts`, per
    // the module doc's rule that no SQL and no business rule belongs in
    // this file.
    answer: async ({ deps, body }) => {
      // `{ refusal }` and no prose, for the reason `MALFORMED_BODY`'s doc
      // gives: these two are the only answers here that share a status.
      if (!isMappingBody(body)) return json(400, { refusal: 'invalid-shape' });
      const result = await deps.addMapping(body);
      if ('refusal' in result) {
        return json(statusForMappingRefusal(result.refusal), { refusal: result.refusal });
      }
      return json(201, { id: result.id });
    },
  },
  {
    path: '/api/feeds/:id',
    // `DELETE` and `PATCH`, on `/api/mappings/:id`'s pattern above -- one
    // entry with a `methods` array, because `routeFor` is a `.find` and a
    // second entry for the same path would never be reached.
    //
    // **Why `DELETE` answers 200 with a body and the mapping route answers
    // 204.** Deleting a mapping has one outcome and nothing to describe.
    // Removing a feed has two: a feed that produced no releases is deleted,
    // and one that produced some is disabled and keeps them
    // (`feeds/remove.ts`). A caller that cannot tell which happened cannot
    // tell the operator, so the outcome is the body.
    methods: ['DELETE', 'PATCH'],
    open: false,
    answer: async ({ deps, request, pathname, body }) => {
      const id = feedIdFrom(pathname);
      if (id === undefined) return UNKNOWN_ROUTE;

      if (request.method === 'DELETE') {
        const removed = await deps.removeFeed(id);
        if ('refusal' in removed) return json(404, { refusal: removed.refusal });
        return json(200, removed);
      }

      if (!isSetFeedDisabledBody(body)) return json(400, { refusal: 'bad-body' });
      const changed = await deps.setFeedDisabled(id, body.disabled);
      if ('refusal' in changed) return json(404, { refusal: changed.refusal });
      return json(200, changed);
    },
  },
  {
    path: '/api/mappings/:id',
    // **The first route in this table to declare two methods**, and the
    // first `PATCH` or `DELETE` this API has ever answered -- until this
    // slice it answered `GET` and `POST` only. That is a line in this
    // array rather than a change to the guard, which is what the per-route
    // `methods` table added in the feed-settings slice bought (design spec
    // §6). `refusalFor`'s ordering is untouched: the session check still
    // runs before the method check, so an anonymous `PATCH` and an
    // anonymous `DELETE` are `401` exactly as an anonymous `POST` is, and
    // neither can be used to tell a real path from an invented one.
    //
    // **One entry, not two.** `routeFor` is a `.find`, so a second entry
    // with this same path would never be reached and its methods would
    // silently 405. The branch below is on `request.method` instead, which
    // is safe because the guard has already refused every method not named
    // here.
    methods: ['PATCH', 'DELETE'],
    open: false,
    // Four segments, so `matchesPath`'s segment-count comparison keeps this
    // and `/api/mappings` above from shadowing one another -- the same
    // arrangement `/api/sync` and `/api/sync/backfill` already have.
    //
    // The `:id` is read back off the pathname by `mappingIdFrom`, never
    // bound by the router: `Route.path` declares the segment only so the
    // count matches. `/api/artwork/:kind/:mediaItemId` is the precedent.
    answer: async ({ deps, request, pathname, body }) => {
      const id = mappingIdFrom(pathname);
      // The same 404 a path naming no route gets. An id that is not digits,
      // or is too large to be an integer, is not a mapping that could
      // exist, and saying so in any other words would tell a caller which
      // of their two mistakes it was.
      if (id === undefined) return UNKNOWN_ROUTE;

      if (request.method === 'DELETE') {
        const removed = await deps.removeMapping(id);
        if ('refusal' in removed) {
          return json(statusForMappingRefusal(removed.refusal), { refusal: removed.refusal });
        }
        // 204 and no body. There is nothing left to describe: the id the
        // caller would read back is the one they sent, in the url they sent
        // it to.
        return NO_CONTENT;
      }

      // `PATCH`, and nothing else can reach here: `methods` above names two
      // and `refusalFor` answers 405 for every other, so this is not an
      // unchecked assumption about the request line.
      if (!isMappingEditBody(body)) return json(400, { refusal: 'invalid-shape' });
      const result = await deps.editMapping(id, body);
      if ('refusal' in result) {
        return json(statusForMappingRefusal(result.refusal), { refusal: result.refusal });
      }
      // 200 rather than 201: nothing was created, and the id is the one the
      // caller addressed. It is answered anyway, so an edit and an add have
      // the same success shape for a client to read.
      return json(200, { id: result.id });
    },
  },
  {
    path: '/api/destinations/:pluginId',
    // **A `PUT`, and the first this API answers.** An upsert: a plugin
    // either has a destination or it does not (design spec §3), so there is
    // no create/update distinction worth two routes and no collection to
    // `POST` to. `PUT` is also the method whose semantics match -- the
    // request names the resource in full and replaces it, and repeating it
    // changes nothing beyond `updated_at`.
    //
    // One method, so no branch on `request.method` here: `refusalFor`
    // answers 405 for everything else, and the session check still runs
    // ahead of the method check, so an anonymous `PUT` is 401 exactly as an
    // anonymous `POST` is.
    methods: ['PUT'],
    open: false,
    // Four segments, so `matchesPath`'s segment-count comparison keeps this
    // from colliding with anything -- the same arrangement
    // `/api/mappings/:id` and `/api/artwork/:kind/:mediaItemId` have. The
    // `:pluginId` is read back off the pathname by `pluginIdFrom`, never
    // bound by the router.
    answer: async ({ deps, pathname, body }) => {
      const pluginId = pluginIdFrom(pathname);
      // The same 404 a path naming no route gets. A segment that could not
      // be a plugin id is not a plugin that could exist, and saying so in
      // any other words would tell a caller which of their two mistakes it
      // was.
      if (pluginId === undefined) return UNKNOWN_ROUTE;

      const input = destinationBodyFrom(body);
      // `{ refusal }` and no prose, for the reason `MALFORMED_BODY`'s doc
      // gives: these two are the only answers here that share a status.
      if (input === undefined) return json(400, { refusal: 'invalid-shape' });

      const result = await deps.saveDestination(pluginId, input);
      if ('refusal' in result) {
        // **The one refusal body in this file with a second field**, and it
        // is `@pickarr/contract`'s `DestinationRefusalBody` rather than an
        // ad-hoc literal. Design spec §3 asks for an unknown token to be
        // refused "naming it", and a settings row listing the seven tokens
        // the television plugin declares -- the longest of the three lists,
        // counted -- cannot say which of them was wrong otherwise. The
        // name is the caller's own input echoed to the caller, and it is
        // gated by a character class in `../media/destinations.ts`
        // (`ECHOABLE_TOKEN`, on `MEDIA_TYPE`'s reasoning above), so this
        // is not a way to get a path or a query string into a body.
        // `token` is `null` for every other code, and may be `null` for
        // this one.
        const refused: DestinationRefusalBody = { refusal: result.refusal, token: result.token };
        return json(statusForDestinationRefusal(result.refusal), refused);
      }
      // 200 rather than 201: the caller addressed the resource, so nothing
      // was created at an address they did not already know. The row id is
      // answered anyway -- it is the key a replica holds the destination
      // under, and a client that just saved one has no other way to learn it.
      return json(200, { id: result.id });
    },
  },
  {
    path: STATIC_ROUTE_PATH,
    // The other of two open routes (design spec §3, and the shell slice's
    // Task 1). It has to be: the bundle is the same bytes for every caller,
    // and it is what a browser must load and run *before* it can render the
    // sign-in form that would otherwise establish a session -- guarding it
    // would not protect anything, since there is nothing caller-specific in
    // an `index.html` or a hashed asset file, and it would make signing in
    // to a fresh install impossible rather than merely inconvenient.
    //
    // `matchesPath` excludes every `/api` path from this template already,
    // so an unmatched `/api/*` request still falls through to "no route
    // claims this", which `refusalFor` guards -- exactly as it did before
    // this route existed. `staticAnswer` refuses `/api` again on its own,
    // defensively, in case it is ever called from somewhere that skipped
    // that exclusion.
    methods: ['GET'],
    open: true,
    answer: ({ deps, request, pathname }) => staticRouteAnswer(
      deps.webRoot,
      pathname,
      request.headers['if-none-match'],
    ),
  },
];

/**
 * Whether `pathname` is the route `template` describes.
 *
 * `STATIC_ROUTE_PATH` is handled first and separately, because it is not a
 * segment template at all: it matches every path of any depth *except* one
 * under `/api`, which the segment-count comparison below has no way to
 * express (a fixed template only ever matches paths of its own segment
 * count). Excluding `/api` here, rather than leaving it to `staticAnswer`
 * alone, is what keeps an unmatched `/api/*` path guarded exactly as it was
 * before this route existed: `routeFor` finding no match for it is what
 * sends it to `refusalFor`'s "a path no route claims is guarded" branch,
 * where `staticAnswer`'s own defensive check on the same rule never runs at
 * all because `staticAnswer` is never called for it.
 *
 * For every other template, segment counts must match, every literal
 * segment must be equal, and a `:name` segment matches anything but the
 * empty string -- a path with the right number of slashes and an empty
 * segment is a real request a client can send, and it is not this route.
 */
function matchesPath(template: string, pathname: string): boolean {
  if (template === STATIC_ROUTE_PATH) return !isApiPath(pathname);
  const wanted = template.split('/');
  const got = pathname.split('/');
  if (wanted.length !== got.length) return false;
  return wanted.every((segment, index) => {
    // `noUncheckedIndexedAccess`: the lengths were compared above, but the
    // compiler types this as possibly-absent and an assertion would be a
    // claim rather than a check.
    const actual = got[index];
    if (actual === undefined) return false;
    return segment.startsWith(':') ? actual !== '' : segment === actual;
  });
}

/** The route a path names, or `undefined` for a path no route claims. */
function routeFor(pathname: string): Route | undefined {
  return ROUTES.find((route) => matchesPath(route.path, pathname));
}

/**
 * The refusal this request gets before anything is routed, or `null` when it
 * may proceed.
 *
 * **This runs in `handle`, ahead of the router, and that is the whole
 * point.** Deriving the guarded set from `ROUTES` is right and is not
 * sufficient: a route mounted in `handle` *beside* the auth dispatch is
 * outside the table altogether, so it inherits nothing. That is not
 * hypothetical -- an unguarded `/api/rss-items-v2` serving real rows was
 * mounted there and all 22 tests passed. Nothing but `/api/auth/*` is
 * mounted beside the dispatch today, so nothing was exposed; what this
 * closes is the next mount, which now inherits the guard by construction
 * rather than by whoever adds it remembering to.
 *
 * **Each route declares its own `methods` now, not one line rejecting every
 * non-`GET` before dispatch.** That one line is what kept this API read-only
 * from slice E until this one; a route answering a method it does not
 * declare is refused by that route's own table entry instead, which is what
 * lets `POST /api/feeds` accept a write without loosening the check for
 * anything else. A router that looked only at the path would answer a POST
 * with a page of data, which is not a thing any route here should ever
 * appear to accept.
 *
 * **The order matters, and it is session-first.** For anything but an open
 * route the session check runs *before* the method check, so a caller with
 * no session gets `401` and learns nothing else -- whatever method they
 * sent, and whether or not the path they sent it to names a route.
 *
 * That ordering was the other way round for one commit, and it leaked.
 * Measured on that commit: anonymous `POST /api/media?type=movie` answered
 * `405` while anonymous `POST /api/no-such-path` answered `401`, so a POST
 * was a path-existence oracle -- ask twice and the pair of statuses names
 * which `/api` paths exist. GETs were uniform `401` and hid it, which is
 * why the leak needs a *cross-path* comparison to see, not a
 * with-session/without-session one. The blanket non-`GET` refusal this
 * slice replaced had answered both POSTs `405`, so it was a regression and
 * not a property the API always had.
 *
 * Nothing the old order bought is lost. Measured on the order below: a
 * signed-in caller still gets `405` for a method a route does not declare
 * (`POST /api/media`, `GET /api/feeds`) and still gets `404`, not `405`,
 * for a path no route claims -- the method check is skipped for
 * `route === undefined`, so an unknown path is never told it failed a check
 * only a real route could fail, and `answerFor` turns it into the 404. The
 * two open routes still answer `405` to an anonymous wrong-method request,
 * since `open` skips the session check: that tells a caller nothing, as
 * both are open by definition and the path alone already says so. Better
 * Auth's own POSTs never reach here -- `handle` dispatched them already.
 *
 * **The guard tests the value the session check resolves to.** Not its
 * status: an unauthenticated check answers `200` with a body of `null` (the
 * auth slice's §2, measured), so `getSession` resolving `null` is the only
 * thing that distinguishes a caller with a session from one without. The
 * check goes through `auth.api`, never through SQL of this module's own --
 * the same rule the rest of this file follows for reads.
 *
 * Open is a property of `ROUTES`, read here: a path no route claims is
 * guarded, and so is a request target that would not parse. Answering 404
 * first would tell a caller with no session which paths exist, which is a
 * question they have no standing to ask.
 */
async function refusalFor(serving: Serving, target: URL | null, request: IncomingMessage): Promise<Answer | null> {
  const route = target === null ? undefined : routeFor(target.pathname);
  if (route?.open !== true) {
    const session = await serving.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (session === null) return UNAUTHORIZED;
  }
  if (route !== undefined && !route.methods.includes(request.method ?? '')) {
    return json(405, { error: 'method not allowed' });
  }
  return null;
}

/**
 * One request, routed. **Guarded already** -- `handle` has the refusal above
 * ahead of this call, so nothing here asks about a session and nothing added
 * here can forget to. `body` is `handle`'s: already read, capped and parsed
 * for anything but a `GET`, `undefined` for one.
 */
function answerFor(
  serving: Serving,
  target: URL | null,
  request: IncomingMessage,
  body: unknown,
): Answer | Promise<Answer> {
  if (target === null) return UNKNOWN_ROUTE;
  const { pathname, searchParams } = target;

  const route = routeFor(pathname);
  if (route === undefined) return UNKNOWN_ROUTE;

  return route.answer({ deps: serving.deps, request, pathname, params: searchParams, body });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
}

function write(response: ServerResponse, answer: Answer): void {
  if (answer.kind === 'json') {
    writeJson(response, answer.status, answer.body);
    return;
  }
  if (answer.kind === 'empty') {
    // No `Content-Type` and no `Content-Length`: a 204 carries neither, and
    // `end()` with no argument is what sends the status line alone.
    response.writeHead(answer.status);
    response.end();
    return;
  }
  if (answer.kind === 'stream') {
    // The hub writes the headers and keeps the response; nothing here ends it.
    answer.attach(response);
    return;
  }
  if (answer.kind === 'artwork') {
    // Written exactly as `readArtwork` composed it, including a 404 or a 304
    // carrying no body at all: that function has already decided what the
    // caller may know, and it deliberately names neither the path it looked
    // for nor whether the row or the file was the thing missing.
    response.writeHead(answer.artwork.status, answer.artwork.headers);
    response.end(answer.artwork.body ?? undefined);
    return;
  }
  // `answer.kind === 'static'`, written exactly as `staticAnswer` composed
  // it, on the same reasoning as the artwork branch above.
  response.writeHead(answer.file.status, answer.file.headers);
  response.end(answer.file.body ?? undefined);
}

/** An error's message, whatever was thrown -- a non-`Error` stringifies rather than vanishing. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Answers one request, and answers a failure the same way whatever failed.
 *
 * **The auth routes are dispatched first, ahead of the guard and ahead of
 * the method check.** Sign-in is a POST, and it is the request that *issues*
 * a session -- routed any later it would be refused for not carrying the
 * thing it exists to hand out, and nobody could ever sign in to this host.
 * Everything under `/api/auth/` is Better Auth's own; this module neither
 * inspects those requests nor writes their responses.
 *
 * **Everything after that dispatch is guarded, by position.** The refusal is
 * taken here rather than inside the router, so a mount added below it
 * inherits the guard whether or not whoever adds it thinks about the guard at
 * all. That is the one structural difference between this and deriving the
 * guarded set from `ROUTES`: the table cannot speak for a route that is not
 * in it, and a route mounted beside this dispatch is not in it. See
 * `refusalFor`.
 *
 * The 500's body is a fixed string: the thrown message can name a feed url,
 * an artwork path or a client's api key (SQLite's own messages name tables
 * and constraints; a client adapter's name whatever url it was reaching), and
 * none of that is a caller's to see. The message is written down instead --
 * through `redactText`, so a credential in a url does not reach the log
 * either -- against the request's *path*, never its query string. A throw out
 * of the auth handler is answered the same way, for the same reason.
 */
async function handle(serving: Serving, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const { deps } = serving;
  try {
    const target = targetOf(request.url);
    if (target !== null && isAuthPath(target.pathname)) {
      await serving.dispatchAuth(request, response);
      return;
    }
    const refusal = await refusalFor(serving, target, request);
    if (refusal !== null) {
      write(response, refusal);
      return;
    }
    // Past the guard. Anything mounted from here down is guarded by having
    // been written below this line, rather than by being marked in `ROUTES`.
    //
    // The body is read here, not per route: most routes answer a `GET` and
    // never have one, and `readBody` is a no-op cost none of them should
    // each have to remember to skip. (That line named `/api/feeds` as the
    // single exception, which it stopped being three write routes ago.)
    //
    // `DELETE` goes through it too, and must: a request whose stream is
    // never read leaves bytes on the socket if a client did send some.
    // `readBody` answers `{ body: undefined }` for an empty one rather than
    // calling it malformed -- see its own note, which is where the bodiless
    // `DELETE` this slice added is actually handled.
    let body: unknown;
    if (request.method !== 'GET') {
      const read = await readBody(request);
      if ('refusal' in read) {
        write(response, read.refusal);
        return;
      }
      body = read.body;
    }
    write(response, await answerFor(serving, target, request, body));
  } catch (error) {
    const route = targetOf(request.url)?.pathname ?? '(unparseable)';
    // A client that goes away mid-body is not a fault of this host's, and it
    // used to be written down as one: `readBody`'s `'error'` listener rejects
    // with node's own `'aborted'`, which arrives here and was logged as
    // `read failed` -- the same line a real 500 writes. A browser navigating
    // away from a submit is an entirely ordinary thing to do, so that line
    // was going to appear in normal use and make a genuine write-path fault
    // unfindable among copies of itself.
    //
    // **A distinct message, not silence.** A proxy-induced `ECONNRESET`
    // reaches this same branch and is worth seeing; dropping the line would
    // hide it. `request.destroyed && !response.headersSent` is what tells the
    // two apart: the request stream is gone, and nothing had been written
    // back yet, so there was no response for the client to have been reading
    // when it left.
    //
    // Only the message changes. The response below is written either way --
    // on a socket the client destroyed `writeJson` is a silent no-op
    // (measured: the listener goes on serving normally afterwards), so
    // returning early here would buy nothing and would give a genuine fault
    // that happens to have a destroyed request no answer at all.
    //
    // `route` is `target.pathname`, never the query string, and the message
    // goes through `redactText` -- the same two rules the 500 path follows, so
    // no url reaches this line either.
    const aborted = request.destroyed && !response.headersSent;
    deps.log(aborted ? 'request aborted' : 'read failed', { route, error: redactText(messageOf(error)) });
    if (response.headersSent) {
      // Nothing safe left to say -- the status line is already gone. Dropping
      // the connection is what tells a client the response is incomplete;
      // appending an error to a half-written body would corrupt it instead.
      response.destroy();
      return;
    }
    writeJson(response, 500, { error: 'read failed' });
  }
}

/**
 * The origin of the address a listener bound, which is what
 * `ReadServerDeps.authFor` is handed.
 *
 * **One origin this listener answers at, not the only one.** With the default
 * wildcard bind it is `http://0.0.0.0:<port>`. Finishing that is the caller's
 * job and `main` does it in two ways: it prefers `PICKARR_PUBLIC_URL` as
 * `baseURL` when a proxy is in front, and `auth/instance.ts`'s
 * `trustedOrigins` accepts a request whose `Origin` names `localhost` or an
 * address in a private, loopback, link-local or unique-local block -- block
 * membership, not this machine's own networks, which it reads nothing about.
 * What this function is for is the case with neither -- a host reached
 * directly at the address it bound.
 *
 * **`http://0.0.0.0:<port>` reaches this host, and it works only because it
 * arrives here.** That url is a real one a client on the machine can use --
 * every request in `test/api/server.test.ts` targets it -- so it is an origin
 * a browser can genuinely be on, and `0.0.0.0` being the default bind is what
 * makes that ordinary rather than exotic. It is *not* a placeable origin:
 * `isPrivateIPv4` matches `127`, `10`, `172.16/12`, `192.168` and `169.254`,
 * and `0` is none of them, so `trustedOrigins` never returns it. Measured: a
 * sign-up carrying `Origin: http://0.0.0.0:<port>` against some other
 * `baseURL` is refused `403 INVALID_ORIGIN`, and the same request succeeds
 * when this function's value *is* the `baseURL` -- Better Auth puts
 * `baseURL`'s origin in its trusted list implicitly. So this path is held
 * open by that implicit trust and by nothing in the origin policy. Anything
 * that stops passing the bound address as `baseURL` closes it, which is worth
 * knowing before `PICKARR_PUBLIC_URL` is made mandatory or this value is
 * normalized to something "nicer".
 *
 * An IPv6 address is bracketed, because `http://::1:7676` is not a url and
 * `http://[::1]:7676` is: `address.address` reports the bare address, and an
 * origin that will not parse would refuse every state-changing request
 * against it rather than fail visibly at construction.
 */
function originOf(address: AddressInfo): string {
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

/**
 * Binds the read API and starts answering.
 *
 * Resolves once the listener is up, so a caller that awaits this knows the
 * port is open -- and rejects if the bind fails, rather than leaving a
 * process that looks started and serves nothing.
 *
 * **It listens before it builds the auth instance, and has to.** `baseURL`
 * must be the origin requests actually arrive at or Better Auth refuses every
 * POST (the auth slice's §2), and with `port: 0` that origin is not known
 * until the kernel has assigned a port -- so the request listener is attached
 * *after* the address is read, rather than passed to `createServer`. Nothing
 * is dropped in between: node cannot emit a `'request'` event until a later
 * turn of the loop, and everything from the bind to the attach below runs
 * without yielding.
 */
export async function createReadServer(deps: ReadServerDeps): Promise<ReadServer> {
  // `REQUEST_TIMEOUT_MS`'s own doc says why this bound and not another, and
  // `CONNECTIONS_CHECK_MS`'s says why the second option is not optional.
  // Both passed to `createServer` rather than assigned afterwards, so there
  // is no window in which a listener is up without them.
  const server = createServer({
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionsCheckingInterval: CONNECTIONS_CHECK_MS,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, deps.host ?? DEFAULT_HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    // A pipe or an unbound server: neither is something this can report a
    // port for, and a caller told "started" would then poll an address that
    // does not exist. Only reachable if `listen` is ever given something
    // other than a port, which `deps.port` being a number rules out.
    server.close();
    throw new Error('the read api bound no tcp address');
  }

  const auth = deps.authFor(originOf(address));
  const serving: Serving = { deps, auth, dispatchAuth: toNodeHandler(auth) };
  server.on('request', (request, response) => {
    handle(serving, request, response).catch((error: unknown) => {
      // `handle` answers its own failures, so reaching here means the
      // *answering* threw -- a socket that died mid-write, say. Logged rather
      // than swallowed, because the alternative is an empty catch that hides
      // a real defect in `handle`.
      deps.log('read response failed', { error: redactText(messageOf(error)) });
      response.destroy();
    });
  });

  let closed = false;
  return {
    host: address.address,
    port: address.port,
    family: address.family,
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      // `close()` stops the listener; `closeAllConnections()` drops what is
      // already open. Neither is awaited: `server.close(callback)` fires its
      // callback only once every connection has ended, which is precisely
      // the drain this must not wait for -- and a client holding a request
      // half-sent would otherwise delay shutdown indefinitely.
      server.close();
      server.closeAllConnections();
    },
  };
}
