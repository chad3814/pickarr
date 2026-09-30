import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ensureClaimToken } from '../../src/auth/claim.ts';
import { createAuth } from '../../src/auth/instance.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import type { HostDb } from '../../src/db/open.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import type { AddFeedInput } from '../../src/feeds/add.ts';
import type { AddDownloadClientInput } from '../../src/clients/add.ts';
import type { MappingRefusal } from '../../src/clients/mappings.ts';
import { ADD_DOWNLOAD_CLIENT_REFUSALS, DESTINATION_REFUSALS, MAPPING_REFUSALS, REQUEST_PICK_REFUSALS } from '@pickarr/contract';
import type { DestinationRefusalCode } from '@pickarr/contract';
import { shippedPlugins } from '../../src/main.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { PAGE_SIZE, encodeCursor, encodeUnionCursor } from '../../src/api/cursor.ts';
import type { ReadServer, ReadServerDeps } from '../../src/api/server.ts';
import type { RetryLookupOutcome } from '../../src/media/retry.ts';
import {
  API_VERSION,
  CONNECTIONS_CHECK_MS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  ROUTES,
  createReadServer,
} from '../../src/api/server.ts';

/**
 * One database behind both handles: `raw` for the fixtures and the read
 * routes, `db` for the Drizzle handle Better Auth's adapter writes sessions
 * through. If these were two databases, a session the mount issued would be a
 * session the guard could not find, and every test here would fail for a
 * reason that had nothing to do with what it was asserting.
 */
function setup(): { raw: DatabaseSync; db: HostDb } {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  return { raw, db };
}

/**
 * Obviously synthetic placeholders that say so in their own text, and none of
 * them is a secret worth having.
 *
 * **No assertion in this file formats a session token.** The one real
 * credential these tests handle is the cookie `signUpOwner` reads off a
 * sign-up response: it is passed straight back as a header, asserted only by
 * presence and by a message of its own, never by a value the test framework
 * would print into a diff on the run where it fails.
 */
const AUTH_SECRET = 'placeholder-not-a-real-signing-secret-for-tests';
const PASSWORD = 'placeholder-not-a-real-password';
const OWNER_EMAIL = 'owner@example.invalid';

/** No cookie at all, which is what an unauthenticated caller sends. */
const ANONYMOUS = null;

/**
 * A session cookie whose signature nothing could have produced.
 *
 * Better Auth answers the session check for it exactly as it answers one with
 * no cookie at all -- 200, with a body of `null` -- which is the trap the
 * guard must not fall into, and measured here rather than assumed.
 */
const BOGUS_COOKIE = 'better-auth.session_token=placeholder.not-a-real-signature';

/** A log that drops every line, for the instance whose lines this file does not assert. */
const dropLine = (): void => {};

/**
 * A web root this file never has to build or clean up, because it never
 * exists: this file's job is the router and the guard, not content-serving
 * fidelity (`static-route.test.ts` owns that, fully injected). Passing a
 * real absent path here also exercises the property design spec §3 promises
 * for it -- a missing web root does not crash the server or take `/api` down
 * with it, which every request this file makes to the static route's own
 * path implicitly proves by getting an answer at all.
 */
const MISSING_WEB_ROOT = '/nonexistent/pickarr-web-root-for-server-test';

/** One `log` call, as the fake below records it. */
interface LogLine {
  message: string;
  detail: Readonly<Record<string, unknown>> | undefined;
}

interface Running {
  server: ReadServer;
  /** Every `log` call the server made, in order, so a test can assert what was written down. */
  logs: LogLine[];
}

/** `Running`, plus the session of the one account the install has. */
interface SignedIn extends Running {
  /** The `Cookie` header a request carries to be let past the guard. */
  cookie: string;
}

/**
 * Starts a server on **port 0** -- the kernel picks a free port and
 * `server.port` reads back the one it assigned. No test in this file may name
 * a port: two tests running in the same process at the same time would fight
 * over any number written down, and the failure would look like a bug in
 * whichever of them lost.
 *
 * **Nothing has signed up yet**, so nothing here holds a session -- which is
 * what the tests about an unauthenticated caller need. `startSignedIn` is the
 * one that claims the install.
 *
 * The auth instance is a *function of the origin* rather than an instance,
 * because Better Auth refuses every POST whose `Origin` is not `baseURL`'s
 * (design spec §2) and port 0 means the address is not known until the
 * listener has bound. `createReadServer` calls this back once it has read its
 * own address; production has the same ordering problem and solves it the
 * same way.
 *
 * **Auth's own log is dropped, deliberately.** `logs` is asserted *by value*
 * by the 500 and unknown-route tests, and `createAuth` writes a line at
 * construction when no public url is configured -- a property of
 * `auth/instance.ts`, tested there, with no business in this file's log.
 *
 * `host` is the interface to bind, and `undefined` -- what every test but the
 * bind test passes -- asks the listener for its own `DEFAULT_HOST`, every
 * interface.
 *
 * **That is a convenience of this file's, not what production does.** Since
 * the config slice, `main` always passes a concrete string:
 * `HostSettings.readHost` is a plain `string`, and an unset
 * `PICKARR_READ_API_HOST` resolves through the config file's `server.host`
 * and then `serverConfigSchema`'s own default -- the same `'0.0.0.0'`,
 * carried in one place. `ReadServerDeps.host` one file over says so, and
 * this comment used to say the opposite.
 */
async function start(
  raw: DatabaseSync,
  db: HostDb,
  pluginIdForType: (type: string) => string | undefined,
  host?: string,
  // A partial `ReadServerDeps`, applied over the defaults below -- what lets
  // a test hand this its own `addFeed`, or its own `webRoot`, without
  // assembling a whole server.
  //
  // **`webRoot` is not a parameter of its own.** It was both: a fifth
  // positional argument *and* a field of this object, spread after it, so
  // the spread silently won whenever a caller passed both -- which
  // `startSignedIn` did, on every call, writing `overrides.webRoot ??
  // MISSING_WEB_ROOT` into a slot the next line overwrote. One route now,
  // defaulted below like every other dep.
  overrides: Partial<ReadServerDeps> = {},
): Promise<Running> {
  const logs: LogLine[] = [];
  const server = await createReadServer({
    raw,
    pluginIdForType,
    // Never called by anything in this file: no test here posts to
    // `/api/feeds` without overriding this, and a test that reaches it
    // without meaning to gets a failure naming the gap rather than a
    // silent success.
    addFeed: () => {
      throw new Error('addFeed not stubbed in this test');
    },
    // Same reasoning as `addFeed` above: no test here posts to
    // `/api/download-clients` without overriding this, and one that reaches
    // it without meaning to gets a failure naming the gap rather than a
    // silent success. It must never be a stub that *succeeds*: the
    // credential body below would then be accepted by a test that had no
    // opinion about credentials at all.
    addDownloadClient: () => {
      throw new Error('addDownloadClient not stubbed in this test');
    },
    // Same reasoning again: no test here posts a well-shaped body to
    // `/api/picks` without overriding this. The guard-probe tests do reach
    // `/api/picks` with a session, but they send `{}`, which the shape
    // guard refuses ahead of this -- so a stub that resolved would make
    // those tests pass for the wrong reason.
    retryLookup: () => {
      throw new Error('retryLookup not stubbed in this test');
    },
    requestPick: () => {
      throw new Error('requestPick not stubbed in this test');
    },
    // Same reasoning again for the two that take a body: the guard-probe
    // tests reach both `/api/mappings` routes with a session, sending
    // `{}`, which each shape guard refuses ahead of these.
    addMapping: () => {
      throw new Error('addMapping not stubbed in this test');
    },
    editMapping: () => {
      throw new Error('editMapping not stubbed in this test');
    },
    // **The one default in this object that is not a throw, and the
    // exception is forced by `guardProbe`.** `DELETE /api/mappings/:id`
    // has no body to fail a shape guard, so the probe reaches this
    // function -- with a throwing default that is a genuine 500 written
    // into the log of a test whose subject is the session guard, and a
    // reader later trying to work out what is broken.
    //
    // It is still not a stub that *succeeds*, which is the property the
    // siblings above exist to protect: `unknown-mapping` is the truthful
    // answer for id 1 against a database with no mappings in it, and any
    // test that means to observe a removal overrides this and would fail
    // loudly against it if it forgot.
    removeMapping: async () => ({ refusal: 'unknown-mapping' }),
    removeFeed: async () => ({ refusal: 'unknown-feed' }),
    setFeedDisabled: async () => ({ refusal: 'unknown-feed' }),
    // A throwing stub, for `addMapping`'s reason -- a stub that *resolved*
    // would make a test pass for the wrong reason -- but **not** for
    // `addMapping`'s mechanism, which this comment used to claim.
    // `probeFor` fills `:pluginId` with `'1'`, and `PLUGIN_ID` is
    // `/^[a-z][a-z0-9_]{0,31}$/`, so `pluginIdFrom` answers `undefined` and
    // the route returns `UNKNOWN_ROUTE` before the body is looked at at
    // all. The `{}` body never reaches `destinationBodyFrom`, and this
    // function never reaches the probe. (`mappingIdFrom` parses `'1'`
    // happily, which is why its sibling is refused by a body guard and
    // this one by a path guard.)
    saveDestination: () => {
      throw new Error('saveDestination not stubbed in this test');
    },
    // No plugin in this file declares a synced table -- what `/api/sync` and
    // `/api/sync/backfill` do with a real one is `sync-route.test.ts`'s.
    // This file only needs the guard on both routes, which an empty registry
    // answers just as well.
    registry: createSyncRegistry(raw, []),
    // A fixed placeholder, not `ensureSyncGeneration`: nothing in this file
    // asserts on the value, and what the three sync routes do with it is
    // `sync-route.test.ts`'s, where it is minted from the database the way
    // `main` does. Obviously synthetic, like the other constants above.
    generation: 'placeholder-generation',
    host,
    port: 0,
    webRoot: MISSING_WEB_ROOT,
    authFor: (baseURL) => createAuth({
      raw,
      db,
      secret: AUTH_SECRET,
      baseURL,
      publicUrl: undefined,
      trustedOrigins: [],
      trustedProxies: [],
      ipAddressHeaders: undefined,
      log: dropLine,
    }),
    log: (message, detail) => {
      logs.push({ message, detail });
    },
    ...overrides,
  });
  return { server, logs };
}

/**
 * The origin the listener actually bound, which is also the auth instance's
 * `baseURL` -- and with the default bind that origin names the unspecified
 * address, `http://0.0.0.0:<port>`.
 *
 * **Every request in this file is made to that address**, rather than to
 * loopback with an `Origin` of its own, and that is what keeps the two halves
 * of a POST agreeing: Better Auth refuses any state-changing request whose
 * `Origin` is neither `baseURL`'s nor one `trustedOrigins` places (design spec
 * §2), and the wildcard address is not one `trustedOrigins` places -- so a
 * sign-up below is accepted because `baseURL` was built from what the listener
 * bound, which is the property `api/server.ts` exists to get right. Connecting
 * to the unspecified address reaches a listener on this machine; measured here
 * on darwin, and the behaviour linux shares.
 */
function originOf(server: ReadServer): string {
  return `http://${server.host}:${server.port}`;
}

/**
 * The `Cookie` header a browser would send back, built from a response's
 * `Set-Cookie` headers. Throws rather than returning an empty string when
 * there is nothing to send: a silently cookie-less request would be
 * indistinguishable from a session that failed to round-trip, which is the
 * one thing the tests using this have to tell apart.
 */
function cookieHeader(response: Response): string {
  const pairs = response.headers.getSetCookie().map((value) => {
    const [pair] = value.split(';');
    if (pair === undefined) throw new Error('a Set-Cookie header with no name=value pair');
    return pair;
  });
  if (pairs.length === 0) throw new Error('the response set no cookie to send back');
  return pairs.join('; ');
}

/**
 * Signs the owner up **through the mounted auth routes** and returns the
 * session cookie that sign-up issued.
 *
 * Over the socket rather than through `auth.api`, because the socket is the
 * only path that proves the mount: an unauthenticated POST reaching Better
 * Auth at all is precisely what the guard must not break, and every test in
 * this file that needs a session depends on it having worked.
 *
 * The `Origin` header is the bound address, which is `baseURL`'s origin --
 * without one Better Auth answers 403 `MISSING_OR_NULL_ORIGIN` (spec §2), and
 * a browser always sends one.
 *
 * The claim token is the install's own, because `auth/instance.ts` refuses a
 * first sign-up that does not carry it. What the claim itself does is
 * `auth/claim.test.ts`'s.
 */
async function signUpOwner(server: ReadServer, raw: DatabaseSync): Promise<string> {
  const origin = originOf(server);
  const response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({
      email: OWNER_EMAIL,
      password: PASSWORD,
      name: 'Placeholder Owner',
      claimToken: ensureClaimToken(raw, 1_000),
    }),
  });
  assert.equal(response.status, 200, 'the harness must be able to sign up through the mounted auth routes');
  return cookieHeader(response);
}

/**
 * `start`, plus the one account this install gets and its session.
 *
 * Closes the listener if the sign-up fails, rather than leaking a bound port
 * out of a failing test: the `try` in each test only runs once this has
 * returned.
 *
 * `overrides` is a partial `ReadServerDeps`, not a `webRoot` string -- so a
 * test can supply its own `addFeed` (`{ addFeed: async (i) => ({ id: 7 }) }`,
 * say) without assembling a whole server. `webRoot` is reachable through it
 * (`{ webRoot }`) and only through it, since it is itself one of
 * `ReadServerDeps`'s own fields -- see `start`, which this passes straight
 * through rather than picking `webRoot` out of it first.
 */
async function startSignedIn(
  raw: DatabaseSync,
  db: HostDb,
  pluginIdForType: (type: string) => string | undefined,
  overrides: Partial<ReadServerDeps> = {},
): Promise<SignedIn> {
  const running = await start(raw, db, pluginIdForType, undefined, overrides);
  try {
    return { ...running, cookie: await signUpOwner(running.server, raw) };
  } catch (error) {
    await running.server.close();
    throw error;
  }
}

/**
 * A GET against the address the listener actually bound, never a written-down
 * one, carrying `cookie` as its session -- or `ANONYMOUS` for a caller that
 * has none.
 *
 * The session is a required argument rather than a default, so every request
 * in this file says which side of the guard it is on.
 */
async function get(
  server: ReadServer,
  path: string,
  cookie: string | null,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(`${originOf(server)}${path}`, {
    headers: cookie === null ? headers : { ...headers, cookie },
  });
}

/**
 * Every path fetched at once, each answer read to a string, in the order the
 * paths were given.
 *
 * Concurrent rather than a loop with an `await` in it, which is what
 * `no-await-in-loop` is pointing at: these requests share nothing and none of
 * them decides the next, so there is no sequence for a loop to preserve. What
 * follows is then a plain loop of assertions with no await at all, so a
 * failure still names the path it came from.
 */
async function getAll(
  server: ReadServer,
  paths: readonly string[],
  cookie: string | null,
): Promise<{ path: string; status: number; text: string }[]> {
  return Promise.all(paths.map(async (path) => {
    const response = await get(server, path, cookie);
    return { path, status: response.status, text: await response.text() };
  }));
}

/**
 * A `POST` carrying a raw string body -- what the oversized-body and
 * malformed-json tests need, since neither is expressible as a value
 * `JSON.stringify` would produce. `post` below is this with the
 * serialisation done for a caller that has an ordinary value to send.
 *
 * Resolves the same shape `getAll`'s entries do (`status` and an already-read
 * `text`), rather than the raw `Response` `get` hands back: every caller of
 * this asserts on both, and reading the body here once is what lets each
 * test do that without an `await response.text()` of its own.
 */
async function sendRaw(
  server: ReadServer,
  method: string,
  path: string,
  cookie: string | null,
  body: string,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${originOf(server)}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie === null ? {} : { cookie }),
    },
    body,
  });
  return { status: response.status, text: await response.text() };
}

async function postRaw(
  server: ReadServer,
  path: string,
  cookie: string | null,
  body: string,
): Promise<{ status: number; text: string }> {
  return sendRaw(server, 'POST', path, cookie, body);
}

/** `postRaw`, serialising `body` as json first -- what every test with a well-formed payload wants. */
async function post(
  server: ReadServer,
  path: string,
  cookie: string | null,
  body: unknown,
): Promise<{ status: number; text: string }> {
  return postRaw(server, path, cookie, JSON.stringify(body));
}

/** `sendRaw` with the serialisation done, for the two methods the mapping routes added. */
async function send(
  server: ReadServer,
  method: string,
  path: string,
  cookie: string | null,
  body: unknown,
): Promise<{ status: number; text: string }> {
  return sendRaw(server, method, path, cookie, JSON.stringify(body));
}

/**
 * A request carrying **no body at all** and no `content-type`, which is
 * what a browser's `fetch(url, { method: 'DELETE' })` actually sends.
 *
 * Separate from `send` rather than `send(..., undefined)`, because the
 * absence is the whole point: `JSON.stringify(undefined)` is `undefined`,
 * which `fetch` would turn into no body anyway, but writing it that way
 * would read as an oversight rather than as the case under test.
 */
async function sendBodiless(
  server: ReadServer,
  method: string,
  path: string,
  cookie: string | null,
): Promise<{ status: number; text: string }> {
  const response = await fetch(`${originOf(server)}${path}`, {
    method,
    headers: cookie === null ? {} : { cookie },
  });
  return { status: response.status, text: await response.text() };
}

/**
 * A request target for a route the table describes, with every `:name`
 * segment filled in.
 *
 * **Derived from `ROUTES`, never written out here.** A hand-written list of
 * paths is a list that goes stale the moment someone adds a route, and
 * silently -- so a route a later slice adds is probed by the tests below
 * without anyone having to remember to add it, or those tests fail.
 */
function probeFor(route: { readonly path: string }): string {
  return route.path.split('/').map((segment) => (segment.startsWith(':') ? '1' : segment)).join('/');
}

/** One `guardProbe` answer: which route, which of its methods, and what came back. */
interface Probe {
  path: string;
  method: string;
  status: number;
  text: string;
}

/**
 * One route probed with **every** method it declares, rather than always
 * `GET` -- `/api/feeds` is `POST`-only, so a blanket `getAll` across every
 * route in `ROUTES` would hit its own method guard before ever reaching the
 * session check the tests using this mean to exercise. Every route but that
 * one still declares `GET`, so this is `get()` in every other case.
 *
 * **Every method, not `methods[0]`.** Probing the first was correct only
 * because no route declares two, and it would have stayed silently correct
 * past the day one did: the first route to declare `['GET', 'POST']` would
 * have had its GET auth-probed and its POST not, by a helper whose callers
 * believe they enumerate the table. There is nothing to notice that with, so
 * the fan-out is here rather than in a comment asking the next person to
 * remember.
 *
 * Resolves one entry per method, flattened by the callers, each labelled
 * with the method so a failure names which one of a route's methods was let
 * through.
 */
async function guardProbe(
  server: ReadServer,
  route: { readonly path: string; readonly methods: readonly string[] },
  cookie: string | null,
): Promise<Probe[]> {
  if (route.methods.length === 0) throw new Error(`${route.path} declares no methods to probe`);
  return Promise.all(route.methods.map(async (method) => {
    const session = cookie === null ? {} : { cookie };
    // Two whole inits rather than one with a conditional `body`. A non-GET
    // needs a body that parses or `readBody` refuses it 400 ahead of the
    // router (see the write-method test), and a GET may carry none at all --
    // which `no-invalid-fetch-options` and `exactOptionalPropertyTypes` both
    // object to expressing as `body: undefined`, correctly.
    const init: RequestInit = method === 'GET'
      ? { method, headers: session }
      : { method, headers: { ...session, 'content-type': 'application/json' }, body: '{}' };
    const response = await fetch(`${originOf(server)}${probeFor(route)}`, init);
    return { path: route.path, method, status: response.status, text: await response.text() };
  }));
}

/** Every route in `routes` probed with every method it declares, flattened into one list. */
async function guardProbeAll(
  server: ReadServer,
  routes: readonly { readonly path: string; readonly methods: readonly string[] }[],
  cookie: string | null,
): Promise<Probe[]> {
  const perRoute = await Promise.all(routes.map((route) => guardProbe(server, route, cookie)));
  return perRoute.flat();
}

/**
 * The session check and a guarded read, made with the same cookie.
 *
 * Both in one helper so the `200 null` trap can be asserted as one fact: the
 * check answers 200 for a caller with no session, and the route refuses that
 * same caller anyway. A guard written against the check's *status* passes the
 * first half and fails the second.
 */
async function checkAndRead(server: ReadServer, cookie: string | null): Promise<{
  check: { status: number; text: string };
  guardedStatus: number;
}> {
  const check = await get(server, '/api/auth/get-session', cookie);
  const checked = { status: check.status, text: await check.text() };
  const guarded = await get(server, '/api/media?type=movie', cookie);
  return { check: checked, guardedStatus: guarded.status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * One paged response split into the three parts the paging tests assert
 * over: the row array (`items`, or `ids` on `/api/deletions`, whose page
 * carries ids and nothing else), the opaque cursor, and `done`.
 *
 * Read back through checks rather than a cast, so a route that answered a
 * different shape fails here, by name, instead of somewhere downstream. The
 * rows stay `unknown` because each route keys its rows differently -- see
 * `rowId` and `downloadKey`.
 */
interface ReadPage {
  rows: unknown[];
  cursor: string | null;
  done: boolean;
}

async function pageFrom(server: ReadServer, path: string, cookie: string | null): Promise<ReadPage> {
  const response = await get(server, path, cookie);
  assert.equal(response.status, 200, `${path} must answer a page`);
  const body: unknown = JSON.parse(await response.text());
  if (!isRecord(body)) throw new Error(`${path} answered something that is not a json object`);
  const rows = body.items ?? body.ids;
  if (!Array.isArray(rows)) throw new Error(`${path} answered neither an items nor an ids array`);
  const { cursor, done } = body;
  if (cursor !== null && typeof cursor !== 'string') throw new Error(`${path} answered a non-string cursor`);
  if (typeof done !== 'boolean') throw new Error(`${path} answered a non-boolean done`);
  return { rows, cursor, done };
}

/** `id` off one row of a page. Every item-bearing route carries one. */
function rowId(row: unknown): string {
  if (!isRecord(row) || typeof row.id !== 'number') throw new Error('a page row must carry a numeric id');
  return String(row.id);
}

/**
 * `transport#id` -- the only thing that names a download row across both
 * tables, since `id` on its own is a per-table rowid.
 */
function downloadKey(row: unknown): string {
  if (!isRecord(row) || typeof row.transport !== 'string') throw new Error('a download row must carry a transport');
  return `${row.transport}#${rowId(row)}`;
}

/** A deletions page carries bare ids, so there is no row to read a field off. */
function deletionKey(value: unknown): string {
  if (typeof value !== 'number') throw new Error('a deletions page must carry numbers');
  return String(value);
}

/**
 * Asserts that `second` really is the continuation of `first`: the two pages
 * share no row, and the run of keys across both is exactly `expected`.
 *
 * This is the assertion the round-trip tests exist for. Asserting each
 * page's returned cursor *value* -- which is all three of these routes used
 * to be checked for -- passes against a route that never reads a cursor back
 * in, and such a route serves page one forever.
 */
function continues(
  first: ReadPage,
  second: ReadPage,
  keyOf: (row: unknown) => string,
  expected: readonly string[],
): void {
  const firstKeys = first.rows.map(keyOf);
  const secondKeys = second.rows.map(keyOf);
  assert.equal(first.done, false, 'page 1 must be full, or there is no second page to page to');
  assert.equal(first.cursor === null, false, 'a full page must hand back a cursor to go on with');
  assert.equal(secondKeys.length > 0, true, 'page 2 must carry rows rather than come back empty');
  assert.notDeepEqual(secondKeys, firstKeys, 'page 2 must not be page 1 served over again');
  const onPageOne = new Set(firstKeys);
  assert.deepEqual(
    secondKeys.filter((key) => onPageOne.has(key)),
    [],
    'no row may be served on both pages',
  );
  assert.deepEqual([...firstKeys, ...secondKeys], expected, 'the two pages are the whole stream, in order');
  assert.equal(second.done, true, 'and page 2 is the end of it');
}

/** The one mapping most tests need: `movie` is `alpha`'s, and no other type exists. */
function moviesOnly(type: string): string | undefined {
  return type === 'movie' ? 'alpha' : undefined;
}

/**
 * A well-formed `/api/feeds` payload -- every `POST /api/feeds` test that
 * does not care what the feed says starts here. The url names
 * `tracker.example` deliberately: the refusal and malformed-body tests
 * assert it is never echoed back, which needs a url in the body worth
 * checking for in the first place.
 */
function validBody(): AddFeedInput {
  return {
    pluginId: 'alpha',
    name: 'A Feed',
    url: 'https://tracker.example/feed.xml?passkey=secret',
    downloadType: 'torrent',
    pollIntervalS: 300,
  };
}

function seedMediaItem(raw: DatabaseSync, pluginId: string, updatedAt: number, title: string): number {
  const info = raw.prepare(
    'INSERT INTO media_item (plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?)',
  ).run(pluginId, updatedAt, updatedAt, title);
  return Number(info.lastInsertRowid);
}

function seedPerson(raw: DatabaseSync, name: string): number {
  const info = raw.prepare(
    'INSERT INTO person (name, provider_ref, created_at, updated_at) VALUES (?, ?, 1, 1)',
  ).run(name, `provider-ref-${name}`);
  return Number(info.lastInsertRowid);
}

/** The `MediaItemRead` a row seeded by `seedMediaItem(raw, _, 1000 + id, ...)` serialises to. */
function expectedMediaItem(id: number): Record<string, unknown> {
  return {
    id,
    title: `Movie ${id}`,
    releaseDate: null,
    description: null,
    provider: null,
    providerRef: null,
    createdAt: 1000 + id,
    updatedAt: 1000 + id,
  };
}

/** `rss_feed.url` is unique, so every feed a test seeds needs its own. */
function seedFeed(raw: DatabaseSync, url: string, pluginId = 'alpha'): number {
  const info = raw.prepare(
    'INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
  ).run(pluginId, `Feed (${pluginId})`, url);
  return Number(info.lastInsertRowid);
}

/** `rss_item` is unique on `(feed_id, guid)`, so the guid is derived from the filename. */
function seedRssItem(raw: DatabaseSync, feedId: number, updatedAt: number, filename: string): number {
  const info = raw.prepare(`
    INSERT INTO rss_item
      (feed_id, filename, link, created_at, updated_at, download_type, media_item_id, lookup_state, lookup_state_detail, guid)
    VALUES (?, ?, ?, ?, ?, 'torrent', NULL, 'resolved', 'x264', ?)
  `).run(feedId, filename, `https://example.com/${filename}`, updatedAt, updatedAt, `guid-${filename}`);
  return Number(info.lastInsertRowid);
}

/** `download_client.name` is unique, so every client a test seeds needs its own. */
function seedClient(raw: DatabaseSync, name: string): number {
  const info = raw.prepare(`
    INSERT INTO download_client (name, type, url, category, import_mode, created_at, updated_at)
    VALUES (?, 'torrent', ?, 'movies', 'copy', 1, 1)
  `).run(name, `https://example.com/${name}`);
  return Number(info.lastInsertRowid);
}

function seedTorrentDownload(
  raw: DatabaseSync,
  rssItemId: number,
  clientId: number,
  updatedAt: number,
  clientRef: string,
): number {
  const info = raw.prepare(`
    INSERT INTO torrent_download
      (rss_item_id, download_client_id, infohash, client_ref, status, last_error, created_at, updated_at, percentage, absent_since, delivered_at)
    VALUES (?, ?, 'abc123', ?, 'downloading', NULL, ?, ?, 40, NULL, NULL)
  `).run(rssItemId, clientId, clientRef, updatedAt, updatedAt);
  return Number(info.lastInsertRowid);
}

function seedNzbDownload(
  raw: DatabaseSync,
  rssItemId: number,
  clientId: number,
  updatedAt: number,
  clientRef: string,
): number {
  const info = raw.prepare(`
    INSERT INTO nzb_download
      (rss_item_id, download_client_id, client_ref, status, last_error, created_at, updated_at, percentage, absent_since, delivered_at)
    VALUES (?, ?, ?, 'completed', NULL, ?, ?, 100, NULL, NULL)
  `).run(rssItemId, clientId, clientRef, updatedAt, updatedAt);
  return Number(info.lastInsertRowid);
}

/** Magic bytes only: nothing here measures an image, and the route only sniffs what it is handed. */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);

test('health answers ok', async () => {
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const response = await get(server, '/api/health', cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    const body: unknown = JSON.parse(await response.text());
    assert.deepEqual(body, { ok: true, version: 1 }, 'the body by value, not merely a 200');
    assert.equal(API_VERSION, 1, 'the exported constant is what the route answers');
  } finally {
    await server.close();
  }
});

test('a media page answers items and an opaque cursor, and the cursor pages forward', async () => {
  // `PAGE_SIZE + 1` rows, so the first page is full (`done: false`) and the
  // cursor has somewhere to go. A fixture smaller than a page would return
  // every row at once, and an implementation that ignored `since` entirely
  // would pass.
  const { raw, db } = setup();
  assert.equal(PAGE_SIZE, 200, 'the literals below are written for a page size of 200');
  for (let id = 1; id <= PAGE_SIZE + 1; id += 1) {
    seedMediaItem(raw, 'alpha', 1000 + id, `Movie ${id}`);
  }
  // Another plugin's row, on the newest timestamp of all: it must appear on
  // neither page. `type=movie` resolves to `alpha` alone.
  seedMediaItem(raw, 'beta', 9999, 'Not alphas');

  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const first = await get(server, '/api/media?type=movie', cookie);
    assert.equal(first.status, 200);
    const firstBody: unknown = JSON.parse(await first.text());
    const firstCursor = encodeCursor({ updatedAt: 1000 + PAGE_SIZE, id: PAGE_SIZE });
    assert.deepEqual(firstBody, {
      items: Array.from({ length: PAGE_SIZE }, (_unused, offset) => expectedMediaItem(offset + 1)),
      cursor: firstCursor,
      done: false,
    });

    // Opaque, not the pair spelled out: a client that read `1200.200` off the
    // wire would start depending on the shape.
    assert.equal(firstCursor.includes('.'), false, 'the cursor a client sees carries no visible separator');
    assert.equal(firstCursor.includes('1200'), false, 'nor the timestamp it was built from');

    const second = await get(server, `/api/media?type=movie&since=${encodeURIComponent(firstCursor)}`, cookie);
    assert.equal(second.status, 200);
    const secondBody: unknown = JSON.parse(await second.text());
    assert.deepEqual(secondBody, {
      items: [expectedMediaItem(PAGE_SIZE + 1)],
      cursor: encodeCursor({ updatedAt: 1000 + PAGE_SIZE + 1, id: PAGE_SIZE + 1 }),
      done: true,
    });
  } finally {
    await server.close();
  }
});

test('an unknown media type is 404 naming the type', async () => {
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const response = await get(server, '/api/media?type=book', cookie);
    assert.equal(response.status, 404, 'a type no plugin claims is not found, not a 500 and not an empty 200');
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: 'unknown media type: book' }, 'the message names the type');
    assert.equal(text.includes('?'), false, 'and carries no query string');
    assert.equal(text.includes('/'), false, 'and no path');
  } finally {
    await server.close();
  }
});

test('an unknown route is 404, not a 500', async () => {
  const { raw, db } = setup();
  const { server, logs, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    // `/` is deliberately absent from this list: since the static route
    // exists, `/` is no longer unmatched -- it is the static route's own
    // territory, and `static-route.test.ts` covers what it answers there.
    // Every probe below stays under `/api`, which the static route excludes
    // from its own match (`matchesPath`'s `STATIC_ROUTE_PATH` case), so each
    // one is still a path no route claims.
    const answers = await getAll(server, [
      '/api/nope',
      '/api/media/1',
      '/api/artwork/poster',
      '/api/artwork/statue/1',
      '/api/artwork/poster/nine',
    ], cookie);
    for (const { path, status, text } of answers) {
      assert.equal(status, 404, `${path} must be 404`);
      assert.deepEqual(JSON.parse(text), { error: 'unknown route' }, `${path} answers a fixed message`);
      assert.equal(text.includes('/'), false, `${path} must not be echoed back`);
    }
    assert.deepEqual(logs, [], 'an unknown route is not a failure, so nothing is logged as one');
  } finally {
    await server.close();
  }
});

test('a read that throws answers 500 with no url, path or query in the body', async () => {
  const { raw, db } = setup();
  seedMediaItem(raw, 'alpha', 1000, 'Recognisable Fixture Title');

  // A message shaped like everything this must never write into a response:
  // a url, a path, a query string and a credential.
  const secretUrl = 'https://sab.test/api?apikey=SECRET-KEY-9&mode=queue&file=/media/movies/Recognisable.mkv';
  const { server, logs, cookie } = await startSignedIn(raw, db, (type) => {
    if (type === 'movie') throw new Error(secretUrl);
    return undefined;
  });
  try {
    const response = await get(server, '/api/media?type=movie&since=whatever', cookie);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: 'read failed' }, 'a fixed message and nothing derived from the throw');

    // The absence of the recognisable values, not the presence of a generic
    // message: a body can carry both.
    for (const forbidden of ['?', '/', 'sab.test', 'apikey', 'SECRET-KEY-9', 'media', 'Recognisable']) {
      assert.equal(text.includes(forbidden), false, `the body must not carry ${forbidden}`);
    }

    // The thrown message is logged, and redacted on the way.
    assert.equal(logs.length, 1, 'exactly one line is written for one failure');
    const line = logs[0];
    assert.ok(line, 'a log line was recorded');
    assert.equal(line.message, 'read failed');
    assert.deepEqual(line.detail, {
      route: '/api/media',
      error: 'https://sab.test/api?apikey=*****&mode=queue&file=/media/movies/Recognisable.mkv',
    }, 'the credential is redacted, and the route logged is the path with no query string');
  } finally {
    await server.close();
  }

  // And a genuinely failing query, not only a failing mapping: the same fixed
  // body, with the table the statement named nowhere in it.
  const broken = setup();
  seedMediaItem(broken.raw, 'alpha', 1000, 'Recognisable Fixture Title');
  broken.raw.exec('DROP TABLE media_item');
  const failing = await startSignedIn(broken.raw, broken.db, moviesOnly);
  try {
    const response = await get(failing.server, '/api/media?type=movie', failing.cookie);
    assert.equal(response.status, 500);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { error: 'read failed' });
    for (const forbidden of ['?', '/', 'media_item', 'no such table', 'Recognisable']) {
      assert.equal(text.includes(forbidden), false, `the body must not carry ${forbidden}`);
    }
    const line = failing.logs[0];
    assert.ok(line, 'the failure is written down even though the response says nothing');
    assert.equal(line.message, 'read failed');
  } finally {
    await failing.server.close();
  }
});

test('the server binds the configured host, defaulting to 0.0.0.0', async () => {
  // **The listener's own address, never a probe against an external
  // interface.** That was slice E's reasoning for the shape of this test when
  // the expected value was loopback, and the reasoning survives the reversal
  // of the value: a probe that failed to reach an external interface would
  // pass on a machine with no route to that interface, and one that reached
  // it would be asserting the machine's routing table rather than this bind.
  // What the kernel says this listener holds is `server.address()`, which is
  // what `ReadServer.host` and `.family` are read back from.
  //
  // **Both halves in one test, asserted against the value that was
  // configured.** A second test for the override could drift from this one,
  // and there is one property here rather than two: whatever host was asked
  // for is the host that was bound. `undefined` is the request an unset
  // `PICKARR_READ_API_HOST` makes, and `DEFAULT_HOST` is the answer to it.
  const { raw, db } = setup();
  const cases = [undefined, '127.0.0.1'] as const;

  // Both listeners at once, and each closes its own port before this
  // resolves: two binds on port 0 share nothing and neither decides the
  // other, which is the same reason `getAll` above is concurrent rather than
  // a loop with an `await` in it. What follows is a plain loop of assertions
  // with no await at all, so a failure still names the case it came from.
  const bound = await Promise.all(cases.map(async (configured) => {
    const { server } = await start(raw, db, moviesOnly, configured);
    try {
      return { host: server.host, family: server.family, port: server.port };
    } finally {
      await server.close();
    }
  }));

  for (const [index, configured] of cases.entries()) {
    const actual = bound[index];
    assert.ok(actual, `a listener was bound for a configured host of ${String(configured)}`);
    assert.equal(
      actual.host,
      configured ?? DEFAULT_HOST,
      `the address the listener actually bound, for a configured host of ${String(configured)}`,
    );
    assert.equal(actual.family, 'IPv4', 'and its family, so a v6 wildcard cannot pass for a v4 one');
    assert.ok(actual.port > 0, 'port 0 was replaced by the one the kernel assigned');
  }

  // The defaults themselves, pinned here because nothing else can: a default
  // is the one value no caller passes.
  assert.equal(DEFAULT_HOST, '0.0.0.0', 'every interface, which is what the auth slice\'s §6 asks for');
  assert.equal(DEFAULT_PORT, 7676, 'the documented default port, which no test in this file binds');
});

test('close stops the listener and does not wait for an in-flight read', async () => {
  // The hold has to be one the test can *observe*, and two cheaper ones are
  // not. Both were measured against the mutation that awaits the drain
  // (`await new Promise(resolve => server.close(resolve))`), and both let it
  // pass:
  //
  // - Writing the start of a request on its own and then closing races the
  //   write: node's `server.close()` closes a connection it still considers
  //   idle, and the partial bytes had not arrived yet.
  // - A 32 MiB response to a client that has stopped reading is not in-flight
  //   as far as `close()` is concerned either. `res.end(bytes)` sets
  //   `writableEnded` the moment it is called, whatever is still queued, and
  //   that is what node's idle check reads -- so the connection is closed and
  //   the callback fires in about a millisecond with 65 KiB of 32 MiB sent.
  //
  // What does hold, deterministically, is an **incomplete request** whose
  // bytes have provably arrived: one `write` carrying a complete request
  // followed by the beginning of a second. TCP keeps a single write in
  // order, so once the first request's response comes back, the second
  // request's bytes are already in the server's parser -- and node holds
  // that connection open, callback unfired, until the socket dies. Measured
  // both ways: the drain-awaiting `close()` fails the assertion below, and
  // the real one passes it.
  const { raw, db } = setup();
  const { server } = await start(raw, db, moviesOnly);
  const socket = connect({ port: server.port, host: server.host });
  try {
    await once(socket, 'connect');
    let received = '';
    // ECONNRESET is what the dropped connection reaches this client as, and a
    // socket with no `error` listener throws it. Not asserted by value: which
    // of reset and a clean close arrives is the kernel's business, and the
    // property under test is what the server did, not how the client heard.
    socket.on('error', () => {});

    // Attached before anything closes: a `once` added after the event has
    // already fired would wait forever.
    const socketClosed = once(socket, 'close').then(() => 'dropped');

    const firstAnswered = new Promise<void>((resolve) => {
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (received.includes('"version":1}')) resolve();
      });
    });
    socket.write(
      'GET /api/health HTTP/1.1\r\nHost: localhost\r\n\r\n'
      + 'GET /api/health HTTP/1.1\r\nHost: localhost\r\n',
    );
    // Bounded, because an unbounded wait for a substring turns any change that
    // stops health answering `200 {...,"version":1}` into a **hung file**
    // rather than a failed test. Slice F's guard task hit exactly that: it
    // marked health as needing a session, and this test stopped the whole
    // file with no name attached -- the `check-test-hygiene` failure mode
    // ("presents as a bare SIGKILL, costs an hour to trace") reached by a
    // different route. The bound is generous enough never to fire on a
    // working server and short enough to name the problem when it breaks.
    await Promise.race([
      firstAnswered,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            'health never answered with a 200 body; received so far: '
            + JSON.stringify(received.slice(0, 120)),
          ));
        }, 5_000);
        timer.unref();
      }),
    ]);

    let settled = false;
    const closing = server.close().then(() => {
      settled = true;
    });
    // A macrotask boundary drains the microtask queue first, so an already
    // resolved `close()` has settled by here and a `close()` waiting on the
    // held request has not. No wall-clock timer is involved either way.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    assert.ok(settled, 'close() must resolve without waiting for the in-flight request');
    assert.equal(
      received.split('HTTP/1.1 200 OK').length - 1,
      1,
      'exactly one response: the held request was abandoned rather than answered on the way out',
    );

    await closing;
    // The listener is gone: a fresh connection to the same port is refused,
    // which `fetch` reports as a rejection rather than a response.
    await assert.rejects(get(server, '/api/health', ANONYMOUS));

    // And the held connection is dropped, not merely left without a listener
    // to accept new ones. That is what "does not drain" means from the side
    // holding it -- one reset and one retry -- and it is also what stops an
    // abandoned read keeping the process alive after shutdown. The bound is a
    // timer only so that a failure is an assertion instead of a hung test:
    // the passing path settles as soon as the kernel delivers the reset,
    // waiting on nothing. `unref` so the bound itself cannot outlive the test.
    const dropped = await Promise.race([
      socketClosed,
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('still open');
        }, 500).unref();
      }),
    ]);
    assert.equal(dropped, 'dropped', 'the in-flight read is dropped, not left open for a drain that never comes');
  } finally {
    socket.destroy();
    await server.close();
  }
});

test('rss items, downloads and deletions each page their own stream', async () => {
  const { raw, db } = setup();
  const feedId = seedFeed(raw, 'https://feeds.test/one.xml');
  const rssItemId = seedRssItem(raw, feedId, 2000, 'One.Movie.1080p.mkv');
  const clientId = seedClient(raw, 'main');
  const torrentId = seedTorrentDownload(raw, rssItemId, clientId, 3000, 'ref-t');
  const nzbId = seedNzbDownload(raw, rssItemId, clientId, 3000, 'ref-n');
  const mediaItemId = seedMediaItem(raw, 'alpha', 1000, 'Gone');
  raw.prepare('INSERT INTO deleted_media_item (media_item_id, plugin_id, deleted_at) VALUES (?, ?, ?)')
    .run(mediaItemId, 'alpha', 4000);

  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const items: unknown = JSON.parse(await (await get(server, '/api/rss-items', cookie)).text());
    assert.deepEqual(items, {
      items: [{
        id: rssItemId,
        feedId,
        filename: 'One.Movie.1080p.mkv',
        link: 'https://example.com/One.Movie.1080p.mkv',
        mediaItemId: null,
        lookupState: 'resolved',
        lookupStateDetail: 'x264',
        downloadType: 'torrent',
        deliveredAt: null,
      }],
      cursor: encodeCursor({ updatedAt: 2000, id: rssItemId }),
      done: true,
    });

    const downloads: unknown = JSON.parse(await (await get(server, '/api/downloads', cookie)).text());
    assert.deepEqual(downloads, {
      items: [
        {
          id: nzbId,
          rssItemId,
          downloadClientId: clientId,
          transport: 'nzb',
          status: 'completed',
          clientRef: 'ref-n',
          infohash: null,
          percentage: 100,
          absentSince: null,
          deliveredAt: null,
          lastError: null,
        },
        {
          id: torrentId,
          rssItemId,
          downloadClientId: clientId,
          transport: 'torrent',
          status: 'downloading',
          clientRef: 'ref-t',
          infohash: 'abc123',
          percentage: 40,
          absentSince: null,
          deliveredAt: null,
          lastError: null,
        },
      ],
      // The union's cursor, which is three parts rather than two -- a
      // downloads page resumed with a two-part cursor could not say which
      // table's row it had already served.
      cursor: encodeUnionCursor({ updatedAt: 3000, transport: 'torrent', id: torrentId }),
      done: true,
    });

    const deletions: unknown = JSON.parse(await (await get(server, '/api/deletions?type=movie', cookie)).text());
    assert.deepEqual(deletions, {
      // `ids`, not `items`: a tombstone is an id and nothing else.
      ids: [mediaItemId],
      cursor: encodeCursor({ updatedAt: 4000, id: mediaItemId }),
      done: true,
    }, 'deletions are scoped by type, because a tombstone carries the plugin that owned the row');

    const foreign = await get(server, '/api/deletions?type=book', cookie);
    assert.equal(foreign.status, 404, 'and an unknown type is refused there exactly as it is on /api/media');
    assert.deepEqual(JSON.parse(await foreign.text()), { error: 'unknown media type: book' });
  } finally {
    await server.close();
  }
});

/**
 * `PAGE_SIZE + 1` rows so page 1 is full (`done: false`) and page 2 has
 * exactly one row on it. A fixture smaller than a page returns everything at
 * once, which is what let three routes go untested for cursor forwarding
 * while still asserting the cursor value they handed back.
 */
const OVER_ONE_PAGE = PAGE_SIZE + 1;

test('the rss items cursor pages forward when a client sends it back', async () => {
  assert.equal(PAGE_SIZE, 200, 'the counts below are written for a page size of 200');
  const { raw, db } = setup();
  const feedId = seedFeed(raw, 'https://feeds.test/paging.xml');
  const expected: string[] = [];
  for (let index = 1; index <= OVER_ONE_PAGE; index += 1) {
    expected.push(String(seedRssItem(raw, feedId, 1000 + index, `Item.${index}.mkv`)));
  }

  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const first = await pageFrom(server, '/api/rss-items', cookie);
    // The round trip a real client makes. This route decodes a two-part
    // cursor; handing its own cursor to `decodeUnionCursor` used to typecheck
    // (`UnionCursor` was structurally a `Cursor`), and every cursor the route
    // issued then decoded to `null` -- so a client past 200 rss items never
    // advanced, with nothing anywhere reporting it.
    const second = await pageFrom(server, `/api/rss-items?since=${encodeURIComponent(first.cursor ?? '')}`, cookie);
    continues(first, second, rowId, expected);
  } finally {
    await server.close();
  }
});

test('the downloads cursor pages forward across both tables when a client sends it back', async () => {
  assert.equal(PAGE_SIZE, 200, 'the counts below are written for a page size of 200');
  const { raw, db } = setup();
  const feedId = seedFeed(raw, 'https://feeds.test/downloads.xml');
  const clientId = seedClient(raw, 'paging');
  // One release per download row: migration 18's partial unique index on
  // `rss_item_id` allows a release at most one download that has not
  // failed. Which release each row names is nothing this cursor reads.
  const itemFor = (label: string): number =>
    seedRssItem(raw, feedId, 100, `Paged.Movie.${label}.1080p.mkv`);

  // Interleaved by `updated_at`, one transport either side of every step, so
  // the page boundary falls between two rows from *different* tables -- which
  // is the boundary a cursor that forgot its transport gets wrong. Every
  // `updated_at` is distinct, so the expected order is fixed by time alone.
  const expected: string[] = [];
  for (let index = 1; index <= 100; index += 1) {
    expected.push(`torrent#${seedTorrentDownload(raw, itemFor(`t${index}`), clientId, 1000 + 2 * index, `ref-t${index}`)}`);
    expected.push(`nzb#${seedNzbDownload(raw, itemFor(`n${index}`), clientId, 1001 + 2 * index, `ref-n${index}`)}`);
  }
  // The one row past the page boundary, newer than all 200 before it.
  expected.push(`torrent#${seedTorrentDownload(raw, itemFor('t101'), clientId, 1000 + 2 * 101, 'ref-t101')}`);
  assert.equal(expected.length, OVER_ONE_PAGE, 'the fixture must be exactly one row past a page');

  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const first = await pageFrom(server, '/api/downloads', cookie);
    const second = await pageFrom(server, `/api/downloads?since=${encodeURIComponent(first.cursor ?? '')}`, cookie);
    continues(first, second, downloadKey, expected);
  } finally {
    await server.close();
  }
});

test('the deletions cursor pages forward when a client sends it back', async () => {
  assert.equal(PAGE_SIZE, 200, 'the counts below are written for a page size of 200');
  const { raw, db } = setup();
  // No `media_item` rows: a tombstone deliberately holds no reference to one,
  // because the row it names is gone. `media_item_id` is the tombstone's own
  // primary key, so the ids are named here rather than read back.
  const expected: string[] = [];
  const insert = raw.prepare(
    'INSERT INTO deleted_media_item (media_item_id, plugin_id, deleted_at) VALUES (?, ?, ?)',
  );
  for (let id = 1; id <= OVER_ONE_PAGE; id += 1) {
    insert.run(id, 'alpha', 1000 + id);
    expected.push(String(id));
  }
  // Another plugin's tombstone, newest of all: it belongs on neither page.
  insert.run(OVER_ONE_PAGE + 1, 'beta', 99999);

  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const first = await pageFrom(server, '/api/deletions?type=movie', cookie);
    const second = await pageFrom(
      server,
      `/api/deletions?type=movie&since=${encodeURIComponent(first.cursor ?? '')}`,
      cookie,
    );
    continues(first, second, deletionKey, expected);
  } finally {
    await server.close();
  }
});

test('artwork is served from the real filesystem with its type read from the bytes, and honours If-None-Match', async () => {
  const { raw, db } = setup();
  const mediaItemId = seedMediaItem(raw, 'alpha', 1000, 'Has A Poster');
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-server-artwork-'));
  try {
    const path = join(dir, 'a.bin');
    await writeFile(path, PNG_BYTES);
    raw.prepare('INSERT INTO poster (media_item_id, url, width, height, created_at, path) VALUES (?, ?, 100, 100, 1, ?)')
      .run(mediaItemId, 'https://images.test/a.png', path);

    const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
    try {
      const response = await get(server, `/api/artwork/poster/${mediaItemId}`, cookie);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png', 'sniffed from the bytes, not from the .bin suffix');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES, 'the bytes on disk, by value');

      const etag = response.headers.get('etag');
      assert.ok(etag !== null && etag.startsWith('W/'), 'a weak etag, since the cached path is not a hash of the content');

      const cached = await get(server, `/api/artwork/poster/${mediaItemId}`, cookie, { 'if-none-match': etag });
      assert.equal(cached.status, 304, 'the header the request carried reaches readArtwork');
      assert.equal((await cached.arrayBuffer()).byteLength, 0);

      const missing = await get(server, `/api/artwork/logo/${mediaItemId}`, cookie);
      assert.equal(missing.status, 404, 'no logo row is a 404, not an empty 200');
      assert.equal((await missing.arrayBuffer()).byteLength, 0);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a person\'s picture is served over /api/artwork/person/:personId', async () => {
  // Guards against the exact failure mode this route once had: `isArtworkKind`
  // was a hand-written `poster|background|logo` disjunction that stayed
  // well-typed after `ArtworkKind` grew a fourth member, so `person` reached
  // `readArtwork` with a correct query and still 404'd on every request --
  // `artworkAnswer`'s own guard threw it away before `readArtwork` ever ran.
  // A unit test of `readArtwork` cannot see that: it calls straight past the
  // guard this test exercises by going in through the real HTTP path.
  const { raw, db } = setup();
  const personId = seedPerson(raw, 'An Actor');
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-server-artwork-person-'));
  try {
    const path = join(dir, 'headshot.bin');
    await writeFile(path, PNG_BYTES);
    raw.prepare('INSERT INTO person_image (person_id, url, width, height, created_at, path) VALUES (?, ?, 100, 100, 1, ?)')
      .run(personId, 'https://images.test/headshot.png', path);

    const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
    try {
      const response = await get(server, `/api/artwork/person/${personId}`, cookie);
      assert.equal(response.status, 200, 'the person kind must be reachable, not swallowed by the kind guard');
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a media type shaped like a path or a query is refused without echoing it', async () => {
  // The one route required to name a caller's value back at it is the one
  // place the no-path/no-query rule could be broken by whatever a client
  // sends. So the echo is limited to values that could be a media type at
  // all, and anything else is refused without repetition.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const types = ['../../etc/passwd', 'movie?apikey=SECRET', '/media/movies', 'a'.repeat(64)];
    const answers = await getAll(server, types.map((type) => `/api/media?type=${encodeURIComponent(type)}`), cookie);
    for (const { path, status, text } of answers) {
      assert.equal(status, 404, `${path} is not a media type`);
      assert.deepEqual(JSON.parse(text), { error: 'unknown media type' }, 'refused without the value');
      for (const forbidden of ['/', '?', 'passwd', 'SECRET', 'aaaa']) {
        assert.equal(text.includes(forbidden), false, `the body must not carry ${forbidden}`);
      }
    }
  } finally {
    await server.close();
  }
});

test('a request with no type at all is refused before any read', async () => {
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const answers = await getAll(server, ['/api/media', '/api/media?type=', '/api/deletions'], cookie);
    for (const { path, status, text } of answers) {
      assert.equal(status, 400, `${path} is a malformed request, not a missing thing`);
      assert.deepEqual(JSON.parse(text), { error: 'a type query parameter is required' });
    }
  } finally {
    await server.close();
  }
});

test('a malformed cursor answers the first page rather than an error', async () => {
  // A client that sends a cursor this server never issued gets the beginning
  // back, which it can recover from by paging forward. A throw here would
  // fail every poll until whatever produced the bad cursor was fixed.
  const { raw, db } = setup();
  seedMediaItem(raw, 'alpha', 1001, 'Movie 1');
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const cursors = ['!!!', '', 'YWJjZGVm', encodeURIComponent('12.abc')];
    const answers = await getAll(server, cursors.map((cursor) => `/api/media?type=movie&since=${cursor}`), cookie);
    for (const { path, status, text } of answers) {
      assert.equal(status, 200, `${path} is not an error`);
      assert.deepEqual(JSON.parse(text), {
        items: [expectedMediaItem(1)],
        cursor: encodeCursor({ updatedAt: 1001, id: 1 }),
        done: true,
      });
    }
  } finally {
    await server.close();
  }
});

test('a write method is refused by every route that does not declare it', async () => {
  // **`/api` is no longer read-only** -- `POST /api/feeds` is a real write,
  // and this test's job is that *no other* route acquired one with it. A
  // route answers only the methods it declares, so a write against a
  // GET-only path is refused by the method rather than routed as though it
  // were a GET, which is what a router that only looked at the path would
  // do, answering a POST with a page of data.
  //
  // **What a caller learns depends on whether it has a session, and that is
  // the point.** With a session: 405 on a route that exists, 404 on a path
  // no route claims. With none: 405 only on an *open* route, and a uniform
  // 401 everywhere else -- including the unclaimed path, so the pair cannot
  // be compared to discover which paths exist. The session check runs first
  // for exactly that reason (see `refusalFor`'s doc), and the ordering was
  // the other way round for one commit, where anonymous POST answered 405
  // on `/api/media` and 401 on an invented path.
  //
  // `UNMOUNTED_PROBE` (declared below, with its own doc and the assertion
  // that it names nothing in `ROUTES`) is the third path, and it is the one
  // that carries the finding: with only the two paths this test used to
  // probe, both of which exist, the leak was invisible.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const paths = [
      { path: '/api/health', open: true, claimed: true },
      { path: '/api/media?type=movie', open: false, claimed: true },
      { path: UNMOUNTED_PROBE, open: false, claimed: false },
    ];
    const probes = ['POST', 'PUT', 'DELETE', 'PATCH'].flatMap((method) => (
      paths.flatMap((target) => [
        { method, target, cookie, session: 'a session' },
        { method, target, cookie: ANONYMOUS, session: 'no session' },
      ])
    ));
    const answers = await Promise.all(probes.map(async (probe) => {
      const response = await fetch(`${originOf(server)}${probe.target.path}`, {
        method: probe.method,
        headers: {
          'content-type': 'application/json',
          ...(probe.cookie === null ? {} : { cookie: probe.cookie }),
        },
        // An empty body would be refused 400 by `readBody` before the router
        // ever ran -- `handle` reads the body for every non-GET, ahead of
        // `answerFor` -- and the unclaimed path's 404 is the router's answer.
        // `{}` is the smallest body that parses; no route below reads it.
        body: '{}',
      });
      // Named out rather than spread: `no-map-spread` is a warning in this
      // repo and these are the fields this loop asserts over.
      return {
        method: probe.method,
        path: probe.target.path,
        open: probe.target.open,
        claimed: probe.target.claimed,
        anonymous: probe.cookie === null,
        session: probe.session,
        status: response.status,
        text: await response.text(),
      };
    }));
    for (const { method, path, open, claimed, anonymous, session, status, text } of answers) {
      const where = `${method} ${path} with ${session}`;
      if (anonymous && !open) {
        assert.equal(status, 401, `${where} is refused by the guard, before the method is looked at`);
        assert.deepEqual(JSON.parse(text), { error: 'unauthorized' }, `${where} refuses with the fixed body`);
        continue;
      }
      if (!claimed) {
        assert.equal(status, 404, `${where} names no route, so the router answers`);
        continue;
      }
      assert.equal(status, 405, `${where} is a method the route does not declare`);
      assert.deepEqual(JSON.parse(text), { error: 'method not allowed' });
    }
  } finally {
    await server.close();
  }
});

test('an anonymous POST tells a caller nothing about which paths exist', async () => {
  // The regression this pins, in one comparison. The method check used to
  // run ahead of the session check, so an anonymous POST answered 405 for a
  // path a route claims and 401 for one none does -- a path-existence
  // oracle needing no credential at all. GET never leaked it, which is why
  // the two GETs are here too: they are what made the POST asymmetry easy
  // to miss.
  const { raw, db } = setup();
  const { server } = await start(raw, db, moviesOnly);
  try {
    assert.ok(
      !ROUTES.some((route) => route.path === '/api/no-such-route'),
      '/api/no-such-route must name nothing in the table for this comparison to mean anything',
    );

    const known = await post(server, '/api/media?type=movie', ANONYMOUS, {});
    const unknown = await post(server, '/api/no-such-route', ANONYMOUS, {});
    assert.equal(
      known.status,
      unknown.status,
      'an anonymous POST must not distinguish a real path from an invented one',
    );
    assert.equal(known.status, 401, 'and what both answer is the guard, not the router');
    assert.deepEqual(JSON.parse(known.text), JSON.parse(unknown.text), 'bodies match too, not only statuses');

    const knownGet = await get(server, '/api/media?type=movie', ANONYMOUS);
    const unknownGet = await get(server, '/api/no-such-route', ANONYMOUS);
    assert.equal(knownGet.status, 401, 'a GET to a real path is the same 401 it always was');
    assert.equal(unknownGet.status, 401, 'and so is a GET to an invented one');
  } finally {
    await server.close();
  }
});

test('a route answers 405 for a method it does not declare, per route', async () => {
  // Per route, not once: a guard that refused every method on every route
  // would pass a single-route test and break every write this slice adds.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const getOnly = await post(server, '/api/media?type=movie', cookie, {});
    assert.equal(getOnly.status, 405, 'POST to a GET-only route is refused');
    const postOnly = await get(server, '/api/feeds', cookie);
    assert.equal(postOnly.status, 405, 'GET to a POST-only route is refused');
  } finally {
    await server.close();
  }
});

test('a body that never arrives is timed out rather than held open', async () => {
  // `MAX_BODY_BYTES` bounds how much a client may send and nothing bounded
  // how long it could take: a signed-in request announcing
  // `Content-Length: 1000` that sends one byte and stops held a socket with
  // no response at all -- measured on the commit before this one at 15s and
  // still waiting, since the only bound was node's 300s `requestTimeout`
  // default.
  //
  // **Both options, because `requestTimeout` alone is not a bound of
  // `requestTimeout`.** Node sweeps connections on an interval rather than
  // arming a timer per request, so with the sweep at its 30s default a 5s
  // `requestTimeout` produced a 408 at 29,904ms. This test would pass on
  // that, given a long enough wait, which is why the bound below is derived
  // from the two constants together and not from `REQUEST_TIMEOUT_MS`: drop
  // `connectionsCheckingInterval` from `createReadServer` and the wait
  // exceeds it.
  //
  // Over a raw socket because no `fetch` expresses "announce a length and
  // then do not send it", and a session because `refusalFor` answers an
  // anonymous caller before `readBody` is ever reached.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    addFeed: async () => ({ id: 1 }),
  });
  const socket = connect({ port: server.port, host: server.host });
  try {
    await once(socket, 'connect');
    socket.on('error', () => {});

    let received = '';
    const answered = new Promise<void>((resolve) => {
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
        if (received.includes('\r\n')) resolve();
      });
    });

    socket.write(
      `POST /api/feeds HTTP/1.1\r\nHost: localhost\r\nCookie: ${cookie}\r\n`
      + 'Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{',
    );

    // One sweep of slack past the worst case the two constants allow, plus a
    // second of scheduling room. A failure here is an assertion naming the
    // wait rather than a file that hangs for the 300s the default would
    // have taken.
    const bound = REQUEST_TIMEOUT_MS + (CONNECTIONS_CHECK_MS * 2) + 1_000;
    await Promise.race([
      answered,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            `no answer within ${String(bound)}ms to a body that never arrived; `
            + `received so far: ${JSON.stringify(received.slice(0, 120))}`,
          ));
        }, bound);
        timer.unref();
      }),
    ]);

    assert.ok(
      received.startsWith('HTTP/1.1 408'),
      `the half-sent request is timed out, not held: ${JSON.stringify(received.slice(0, 60))}`,
    );
  } finally {
    socket.destroy();
    await server.close();
  }
});

/**
 * Resolves with the first line `logs` receives, or rejects once `bound`
 * elapses with none.
 *
 * Bounded for the reason the timeout test above gives: a wait with no bound
 * turns "the line stopped being written" into a file that hangs with no test
 * name attached, which `CLAUDE.md` records as costing an hour to trace. The
 * passing path settles on the first poll after the server writes, waiting on
 * nothing; `unref` so the bound cannot outlive the test.
 */
function firstLogLine(logs: readonly LogLine[], bound: number): Promise<LogLine> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + bound;
    const poll = (): void => {
      const line = logs[0];
      if (line !== undefined) {
        resolve(line);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`nothing was logged within ${String(bound)}ms of the client going away`));
        return;
      }
      setTimeout(poll, 10).unref();
    };
    poll();
  });
}

test('a client that goes away mid-body is written down as an abort, not as a server fault', async () => {
  // Deferred finding #2 of the write-path review, measured there as
  // `{"msg":"read failed","fields":{"route":"/api/feeds","error":"aborted"}}`
  // -- the same line a genuine 500 on this route writes, from a browser
  // navigating away from a submit. Two causes sharing one message means a
  // real write-path fault is unfindable among copies of an ordinary event.
  //
  // Silence would be the wrong fix: a proxy-induced `ECONNRESET` reaches the
  // same branch and is worth seeing. So this asserts a *distinct* message
  // rather than an empty log.
  //
  // Over a raw socket for the reason the timeout test above gives -- no
  // `fetch` expresses "announce a length, send one byte, vanish" -- and
  // signed in, because `refusalFor` answers an anonymous caller before
  // `readBody` is reached at all.
  const { raw, db } = setup();
  const { server, logs, cookie } = await startSignedIn(raw, db, moviesOnly, {
    // Reaching this would mean a body arrived, which is the opposite of what
    // this test does. A throw here would be logged as `read failed` and the
    // assertion below would name it.
    addFeed: () => {
      throw new Error('addFeed must not be reached: this request never finishes its body');
    },
  });
  const socket = connect({ port: server.port, host: server.host });
  try {
    await once(socket, 'connect');
    socket.on('error', () => {});

    // Flushed before the socket goes, so the abort lands inside `readBody`
    // rather than before the request is dispatched at all. The write
    // callback is what says the bytes left this process; `'drain'` is not --
    // a write this small never fills the buffer, so that event never fires
    // and waiting on it hangs the file (measured, at 137s and counting).
    await new Promise<void>((resolve) => {
      socket.write(
        `POST /api/feeds HTTP/1.1\r\nHost: localhost\r\nCookie: ${cookie}\r\n`
        + 'Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{',
        () => {
          resolve();
        },
      );
    });
    // And a beat for the listener to parse those bytes and dispatch. Flushed
    // is not received: destroying the socket before the header block is
    // parsed leaves node with no request to emit, so nothing would reach the
    // branch under test. Over loopback the parse is microseconds; this is
    // three orders of magnitude of slack, and if it were ever not enough
    // `firstLogLine` below fails by name rather than hanging.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100).unref();
    });
    socket.destroy();

    const line = await firstLogLine(logs, 5_000);
    assert.equal(line.message, 'request aborted',
      'a client going away is its own message, greppable apart from a real fault');
    assert.deepEqual(line.detail, { route: '/api/feeds', error: 'aborted' },
      'the path with no query string, and node\'s own word for what happened');

    // The constraint, checked on the line rather than assumed from it: a
    // feed url can carry a passkey, and nothing about an abort is worth a
    // url in a log.
    const written = JSON.stringify(line);
    for (const forbidden of ['http', '?', 'apikey', 'Cookie', 'localhost']) {
      assert.equal(written.includes(forbidden), false, `the line must not carry ${forbidden}`);
    }

    assert.equal(logs.length, 1, 'one line for one abort, and no 500 written beside it');
  } finally {
    socket.destroy();
    await server.close();
  }
});

test('the request timeout node is given bounds the headers too', () => {
  // The claim `REQUEST_TIMEOUT_MS`'s doc makes about `headersTimeout`, which
  // is node's behaviour and not this module's: given a `requestTimeout`
  // smaller than the 60s `headersTimeout` default, node clamps the latter to
  // the former. Asserted because a node upgrade that stopped clamping would
  // silently leave a half-sent *header* block bounded at 60s while every
  // comment here said five seconds, and nothing else would notice.
  //
  // Built here rather than read off `createReadServer`, which exposes no
  // timeouts: what this pins is the assumption, and the test above pins that
  // `createReadServer` passes the options that trigger it.
  const probe = createServer({
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionsCheckingInterval: CONNECTIONS_CHECK_MS,
  });
  try {
    assert.equal(probe.requestTimeout, REQUEST_TIMEOUT_MS, 'the option is taken as given');
    assert.equal(probe.headersTimeout, REQUEST_TIMEOUT_MS, 'and headers are clamped to it, not left at 60s');
  } finally {
    probe.close();
  }
});

test('a body larger than the cap is refused before it is parsed', async () => {
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const huge = JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES + 1_000) });
    const answer = await postRaw(server, '/api/feeds', cookie, huge);
    assert.equal(answer.status, 413, 'an oversized body is refused');
    assert.ok(!answer.text.includes('x'.repeat(50)), 'and is not echoed back');
  } finally {
    await server.close();
  }
});

test('every route declares its methods', () => {
  // The count assertion that already guards `open` applies here too: a route
  // added without `methods` must not silently inherit GET.
  for (const route of ROUTES) {
    assert.ok(route.methods.length > 0, `${route.path} declares at least one method`);
  }
});

test('a valid feed is accepted and its id returned', async () => {
  const { raw, db } = setup();
  const accepted: AddFeedInput[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    addFeed: async (i) => {
      accepted.push(i);
      return { id: 7 };
    },
  });
  try {
    const answer = await post(server, '/api/feeds', cookie, validBody());
    assert.equal(answer.status, 201);
    assert.deepEqual(JSON.parse(answer.text), { id: 7 });
    assert.equal(accepted.length, 1, 'the host was asked exactly once');
  } finally {
    await server.close();
  }
});

test('each refusal answers a distinct code the client can branch on', async () => {
  // Global Constraint: distinguishable without parsing prose. The client
  // maps a code to its own words; the server authors no sentence a human
  // reads, and no url or path appears in any body.
  //
  // A fresh `setup()` per case, not one shared across them, run concurrently
  // rather than as a loop with an `await` in it -- the same reasoning
  // `getAll` gives: an install gets exactly one account (`signUpOwner`'s own
  // doc), so a second sign-up against the same database would be refused for
  // a reason that has nothing to do with the property this test checks, and
  // nothing here shares state across cases anyway.
  //
  // **All four of `AddFeedRefusal`'s codes, not the two that used to be
  // here.** `bad-download-type` and `bad-poll-interval` were pinned by
  // nothing, so `statusForFeedRefusal` could have moved either out of the
  // 422 group -- or dropped its `case` and fallen through -- with every test
  // still green. The grouping is the thing under test, and a table missing
  // half the group cannot see it drift.
  const cases = [
    ['duplicate-url', 409],
    ['unknown-plugin', 422],
    ['bad-download-type', 422],
    ['bad-poll-interval', 422],
  ] as const;
  // Both halves of the table, so a code added to `AddFeedRefusal` without a
  // row here fails rather than quietly going unprobed. Written as a set so
  // a duplicated row cannot make the count right by accident.
  assert.equal(new Set(cases.map(([refusal]) => refusal)).size, 4, 'every refusal the host can return has a row');

  await Promise.all(cases.map(async ([refusal, status]) => {
    const { raw, db } = setup();
    const { server, cookie, logs } = await startSignedIn(raw, db, moviesOnly, {
      addFeed: async () => ({ refusal }),
    });
    try {
      const answer = await post(server, '/api/feeds', cookie, validBody());
      assert.equal(answer.status, status, `${refusal} answers ${String(status)}`);
      assert.deepEqual(JSON.parse(answer.text), { refusal }, 'and the whole body is that one stable code');
      assert.ok(!answer.text.includes('tracker.example'), 'the url is never echoed');
      // The other half of the same constraint: no url in any *log* either,
      // which the response-body assertion above says nothing about. `logs`
      // is every `log` call this server made, asserted by substring rather
      // than by shape so a url reaching any field of any line is caught.
      assert.ok(
        !JSON.stringify(logs).includes('tracker.example'),
        'and the submitted url is not written down either',
      );
    } finally {
      await server.close();
    }
  }));
});

test('both 400s carry a code, so the one status they share is not told apart by prose', async () => {
  // The two refusals that collide on a status -- a body that does not parse
  // and one that parses into the wrong shape. Every other refusal this
  // endpoint gives has a status of its own; these two did not, and differed
  // only in an english string, which is exactly what the constraint on
  // refusal codes rules out. Asserted as whole bodies: adding `refusal`
  // beside the old `error` would satisfy a `.refusal` check and still leave
  // a client two shapes to read.
  const { raw, db } = setup();
  let called = 0;
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    addFeed: async () => {
      called += 1;
      return { id: 1 };
    },
  });
  try {
    const unparseable = await postRaw(server, '/api/feeds', cookie, '{not json');
    assert.equal(unparseable.status, 400);
    assert.deepEqual(JSON.parse(unparseable.text), { refusal: 'malformed-body' });

    // Parses, and is not a feed: `pollIntervalS` is a string where the shape
    // wants a number, so `isFeedBody` refuses it.
    const wrongShape = await post(server, '/api/feeds', cookie, { ...validBody(), pollIntervalS: 'soon' });
    assert.equal(wrongShape.status, 400);
    assert.deepEqual(JSON.parse(wrongShape.text), { refusal: 'invalid-shape' });

    assert.notDeepEqual(
      JSON.parse(unparseable.text),
      JSON.parse(wrongShape.text),
      'and the two are distinguishable without reading a sentence',
    );
    assert.equal(called, 0, 'neither reached the host');
  } finally {
    await server.close();
  }
});

test('the route is guarded by a session like every read', async () => {
  const { raw, db } = setup();
  const { server } = await start(raw, db, moviesOnly);
  try {
    const answer = await post(server, '/api/feeds', ANONYMOUS, validBody());
    assert.equal(answer.status, 401, 'no session, no write');
  } finally {
    await server.close();
  }
});


/**
 * The credential in every `POST /api/download-clients` test below.
 *
 * It exists to be looked for and not found: an obviously synthetic string,
 * distinct from every other literal in this file, so an assertion that it is
 * absent from a body or a log cannot be satisfied by some other value's
 * absence. Nothing here is a real key.
 */
const SUBMITTED_API_KEY = 'apikey-must-never-be-echoed-9f8e7d';

/**
 * A well-formed `/api/download-clients` payload.
 *
 * The url names `qbit.example` and the api key is {@link SUBMITTED_API_KEY},
 * both deliberately: the tests below assert neither is ever echoed into a
 * response body or a log line, which needs values in the body worth
 * searching for in the first place. Mirrors `validBody`'s own reasoning for
 * `tracker.example`.
 *
 * `type` is absent because the wire shape has no such field -- the host
 * derives it from `implementation` (design spec §4), so a client cannot
 * send a `type`/`implementation` pair that disagrees.
 */
function validClientBody(): AddDownloadClientInput {
  return {
    name: 'A Client',
    implementation: 'qbittorrent',
    url: 'http://qbit.example:8080',
    category: 'pickarr',
    apiKey: SUBMITTED_API_KEY,
    username: '',
    password: '',
  };
}

test('a valid download client is accepted and its id returned', async () => {
  const { raw, db } = setup();
  const accepted: AddDownloadClientInput[] = [];
  const { server, cookie, logs } = await startSignedIn(raw, db, moviesOnly, {
    addDownloadClient: async (i) => {
      accepted.push(i);
      return { id: 11 };
    },
  });
  try {
    const answer = await post(server, '/api/download-clients', cookie, validClientBody());
    assert.equal(answer.status, 201);
    assert.deepEqual(JSON.parse(answer.text), { id: 11 });
    assert.equal(accepted.length, 1, 'the host was asked exactly once');
    assert.equal(accepted[0]?.apiKey, SUBMITTED_API_KEY, 'and the credential reached it intact');

    // The success path, not just the refusals: an accepted create is the
    // one answer that has a real row to describe, and describing it is
    // exactly how a credential ends up echoed back. The body is the id and
    // nothing else.
    assert.ok(!answer.text.includes(SUBMITTED_API_KEY), 'the credential is never echoed');
    assert.ok(!answer.text.includes('qbit.example'), 'and neither is the address');
    assert.ok(
      !JSON.stringify(logs).includes(SUBMITTED_API_KEY),
      'and the credential is not written down either',
    );
    assert.ok(
      !JSON.stringify(logs).includes('qbit.example'),
      'and no log line carries the url',
    );
  } finally {
    await server.close();
  }
});

test('each download client refusal answers a distinct code the client can branch on', async () => {
  // Global Constraint: distinguishable without parsing prose. The client
  // maps a code to its own words; the server authors no sentence a human
  // reads, and no url and no credential appears in any body.
  //
  // **All four of `ADD_DOWNLOAD_CLIENT_REFUSALS`, not a sample.** The feeds
  // slice shipped two of its four unpinned, so `statusForFeedRefusal` could
  // have moved either out of the 422 group -- or dropped its `case` and
  // fallen through -- with every test still green. The grouping is the
  // thing under test, and a table missing half of it cannot see it drift.
  //
  // A fresh `setup()` per case, run concurrently rather than in a loop with
  // an `await` in it: an install gets exactly one account, so a second
  // sign-up against one database would be refused for a reason that has
  // nothing to do with this property.
  const cases = [
    ['duplicate-name', 409],
    ['unknown-implementation', 422],
    ['bad-auth-shape', 422],
    ['bad-url', 422],
  ] as const;
  // Both halves of the table, read off the contract rather than counted by
  // hand, so a fifth code added to `ADD_DOWNLOAD_CLIENT_REFUSALS` fails here
  // instead of quietly going unprobed.
  assert.equal(
    new Set(cases.map(([refusal]) => refusal)).size,
    ADD_DOWNLOAD_CLIENT_REFUSALS.length,
    'every refusal the host can return has a row',
  );
  for (const code of ADD_DOWNLOAD_CLIENT_REFUSALS) {
    assert.ok(cases.some(([refusal]) => refusal === code), `${code} is probed`);
  }

  await Promise.all(cases.map(async ([refusal, status]) => {
    const { raw, db } = setup();
    const { server, cookie, logs } = await startSignedIn(raw, db, moviesOnly, {
      addDownloadClient: async () => ({ refusal }),
    });
    try {
      const answer = await post(server, '/api/download-clients', cookie, validClientBody());
      assert.equal(answer.status, status, `${refusal} answers ${String(status)}`);
      assert.deepEqual(JSON.parse(answer.text), { refusal }, 'and the whole body is that one stable code');
      assert.ok(!answer.text.includes(SUBMITTED_API_KEY), 'the credential is never echoed');
      assert.ok(!answer.text.includes('qbit.example'), 'and neither is the url');
      // The other half of the same constraint: an error path is where a
      // value gets written into a message by someone being helpful.
      // Asserted by substring over every field of every line, so a
      // credential reaching any of them is caught.
      assert.ok(
        !JSON.stringify(logs).includes(SUBMITTED_API_KEY),
        'and the submitted credential is not written down either',
      );
      assert.ok(
        !JSON.stringify(logs).includes('qbit.example'),
        'and neither is the submitted url',
      );
    } finally {
      await server.close();
    }
  }));
});

test('both download client 400s carry a code, so the one status they share is not told apart by prose', async () => {
  // The two envelope refusals, which collide on a status and so used to
  // differ only by an english string. The same pair `POST /api/feeds`
  // answers, asserted again here rather than assumed shared: the two routes
  // reach `MALFORMED_BODY` through the same `readBody`, but each owns its
  // own `invalid-shape` answer and its own shape guard.
  const { raw, db } = setup();
  let called = 0;
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    addDownloadClient: async () => {
      called += 1;
      return { id: 1 };
    },
  });
  try {
    const unparseable = await postRaw(server, '/api/download-clients', cookie, '{not json');
    assert.equal(unparseable.status, 400);
    assert.deepEqual(JSON.parse(unparseable.text), { refusal: 'malformed-body' });

    // Parses, and is not a download client: `apiKey` is absent, which
    // `isDownloadClientBody` refuses. An absent credential field is not the
    // same fact as an empty one -- the host reads `''` as "this strategy
    // sends none", so a body that omits the field entirely would otherwise
    // reach the host as `undefined` and be read as a shape it never chose.
    const { apiKey: _omitted, ...withoutApiKey } = validClientBody();
    const wrongShape = await post(server, '/api/download-clients', cookie, withoutApiKey);
    assert.equal(wrongShape.status, 400);
    assert.deepEqual(JSON.parse(wrongShape.text), { refusal: 'invalid-shape' });

    // And a `type` a caller tried to smuggle in is simply not read: the
    // shape guard ignores unknown fields, and the host derives `type`
    // itself, so this is accepted as an ordinary create rather than
    // becoming a row whose type and implementation disagree.
    const withType = await post(server, '/api/download-clients', cookie, { ...validClientBody(), type: 'nzb' });
    assert.equal(withType.status, 201, 'an extra field is not a shape failure');

    assert.notDeepEqual(
      JSON.parse(unparseable.text),
      JSON.parse(wrongShape.text),
      'and the two 400s are distinguishable without reading a sentence',
    );
    assert.equal(called, 1, 'only the well-shaped body reached the host');
  } finally {
    await server.close();
  }
});

test('the download client route is guarded by a session like every read', async () => {
  const { raw, db } = setup();
  const { server } = await start(raw, db, moviesOnly);
  try {
    const answer = await post(server, '/api/download-clients', ANONYMOUS, validClientBody());
    assert.equal(answer.status, 401, 'no session, no write');
    assert.ok(!answer.text.includes(SUBMITTED_API_KEY), 'and the refusal repeats nothing of the body');
  } finally {
    await server.close();
  }
});


/**
 * A well-formed `/api/picks` payload. One field, and a number: the whole of
 * what the wire shape is.
 *
 * The id is obviously synthetic and appears in no other literal in this
 * file, so an assertion that a body or a log does *not* carry it cannot be
 * satisfied by some other value's absence -- the same reasoning
 * {@link SUBMITTED_API_KEY} is built on.
 */
function validPickBody(): { rssItemId: number } {
  return { rssItemId: 860531 };
}

test('a pick is accepted with 202 and no resource, not 201', async () => {
  const asked: number[] = [];
  const { raw, db } = setup();
  const { server, cookie, logs } = await startSignedIn(raw, db, moviesOnly, {
    requestPick: async (rssItemId) => {
      asked.push(rssItemId);
      return { accepted: true };
    },
  });
  try {
    const answer = await post(server, '/api/picks', cookie, validPickBody());

    // **202, and the reason is not "nothing was created".** Measured on
    // this tree: with the production wiring a `torrent_download` row does
    // exist by the time this answers -- `clients/downloads.ts` inserts it
    // before it calls the client, and `submit` is awaited the whole way up
    // through `onDownloadRequest`, `requestDownload` and `requestPick`, so
    // `clients/pick.test.ts` reads a `submitted` row straight after an
    // `accepted`. What is true is narrower and is what 202 means: the
    // request has been accepted and the processing is not complete.
    assert.equal(answer.status, 202);
    assert.deepEqual(JSON.parse(answer.text), { accepted: true });
    assert.deepEqual(asked, [860531], 'the host was asked once, for the id in the body');

    // No id, no Location, nothing a `201` would be claiming to have made.
    // A pick names no resource this API serves: there is no
    // `/api/picks/:id`, and what a pick eventually produces is a download
    // row the browser learns about through the sync replica.
    assert.deepEqual(Object.keys(JSON.parse(answer.text)), ['accepted']);
    assert.ok(!JSON.stringify(logs).includes('860531'), 'and the accepted id is not written down');
  } finally {
    await server.close();
  }
});

test('each pick refusal answers a distinct code the client can branch on', async () => {
  // Global Constraint: distinguishable without parsing prose. The client
  // maps a code to its own words; the server authors no sentence a human
  // reads.
  //
  // **All five of `REQUEST_PICK_REFUSALS`, not a sample** -- the feeds
  // slice shipped two of its four unpinned, so its status mapper could have
  // moved either out of the 422 group, or dropped its `case` and fallen
  // through, with every test still green. The grouping is the thing under
  // test and a table missing part of it cannot see it drift.
  //
  // A fresh `setup()` per case, run concurrently rather than in a loop with
  // an `await` in it: an install gets exactly one account, so a second
  // sign-up against one database would be refused for a reason that has
  // nothing to do with this property.
  const cases = [
    ['already-submitted', 409],
    ['unknown-release', 422],
    ['plugin-not-registered', 422],
    ['no-client-of-type', 422],
    ['client-type-mismatch', 422],
  ] as const;
  // Both halves of the table, read off the contract rather than counted by
  // hand, so a sixth code added to `REQUEST_PICK_REFUSALS` fails here
  // instead of quietly going unprobed.
  assert.equal(
    new Set(cases.map(([refusal]) => refusal)).size,
    REQUEST_PICK_REFUSALS.length,
    'every refusal the host can return has a row',
  );
  for (const code of REQUEST_PICK_REFUSALS) {
    assert.ok(cases.some(([refusal]) => refusal === code), `${code} is probed`);
  }
  // And the split is a real one rather than five rows of the same number:
  // a mapper that answered 422 for everything would satisfy every
  // per-case assertion below if the table said 422 five times.
  assert.equal(new Set(cases.map(([, status]) => status)).size, 2, 'the table distinguishes two statuses');

  await Promise.all(cases.map(async ([refusal, status]) => {
    const { raw, db } = setup();
    const { server, cookie, logs } = await startSignedIn(raw, db, moviesOnly, {
      requestPick: async () => ({ refusal }),
    });
    try {
      const answer = await post(server, '/api/picks', cookie, validPickBody());
      assert.equal(answer.status, status, `${refusal} answers ${String(status)}`);
      assert.deepEqual(JSON.parse(answer.text), { refusal }, 'and the whole body is that one stable code');
      assert.ok(!answer.text.includes('860531'), 'no refusal repeats the id it was asked about');
      assert.ok(
        !JSON.stringify(logs).includes('860531'),
        'and nothing about the refused pick is written down either',
      );
    } finally {
      await server.close();
    }
  }));
});

test('a retry is accepted with 202, and hands the route\u2019s id straight to the host', async () => {
  // 202 because nothing is finished: `retryLookup` enqueues and returns,
  // the service has not been asked yet, and what the browser eventually
  // sees arrives through the sync replica rather than this response.
  const { raw, db } = setup();
  const asked: number[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    retryLookup: async (rssItemId) => {
      asked.push(rssItemId);
      return { accepted: true };
    },
  });
  try {
    const answer = await post(server, '/api/unmatched/860531/retry', cookie, null);
    assert.equal(answer.status, 202);
    assert.deepEqual(JSON.parse(answer.text), { accepted: true });
    // Spelled literally: the id travels in the path, so a parser reading
    // the wrong segment would still answer 202 while retrying a stranger.
    assert.deepEqual(asked, [860531]);
  } finally {
    await server.close();
  }
});

test('each retry refusal answers its own status, and the split is real', async () => {
  const cases: [Exclude<RetryLookupOutcome, { accepted: true }>['refusal'], number][] = [
    ['already-matched', 409],
    ['unknown-release', 422],
    ['plugin-not-registered', 422],
  ];
  // The same guard the pick table carries: a mapper answering one status
  // for everything would satisfy every per-case assertion below if the
  // table said that status three times.
  assert.equal(new Set(cases.map(([, status]) => status)).size, 2, 'the table distinguishes two statuses');

  await Promise.all(cases.map(async ([refusal, status]) => {
    const { raw, db } = setup();
    const { server, cookie, logs } = await startSignedIn(raw, db, moviesOnly, {
      retryLookup: async () => ({ refusal }),
    });
    try {
      const answer = await post(server, '/api/unmatched/860531/retry', cookie, null);
      assert.equal(answer.status, status, `${refusal} answers ${String(status)}`);
      assert.deepEqual(JSON.parse(answer.text), { refusal }, 'and the whole body is that one stable code');
      assert.ok(!answer.text.includes('860531'), 'no refusal repeats the id it was asked about');
      assert.ok(!JSON.stringify(logs).includes('860531'), 'and nothing about it is written down either');
    } finally {
      await server.close();
    }
  }));
});

test('a retry path whose id is not an integer is an unknown route, and never reaches the host', async () => {
  // The id is read back off the pathname, so this is the route's own
  // guard rather than a body shape check. `/api/unmatched/7/retry/extra`
  // is in the list because a parser that checked only the segment and not
  // the segment *count* would read it as release 7.
  const { raw, db } = setup();
  let called = 0;
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    retryLookup: async () => {
      called += 1;
      return { accepted: true };
    },
  });
  try {
    for (const path of [
      '/api/unmatched/abc/retry',
      '/api/unmatched/ /retry',
      '/api/unmatched/0x7/retry',
      '/api/unmatched//retry',
      '/api/unmatched/7/retry/extra',
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one server, and each answer is asserted before the next request is sent
      const answer = await post(server, path, cookie, null);
      assert.equal(answer.status, 404, `${path} is not a route`);
    }
    assert.equal(called, 0, 'and the host was never asked about any of them');
  } finally {
    await server.close();
  }
});

test('both pick 400s carry a code, so the one status they share is not told apart by prose', async () => {
  // The two envelope refusals, which collide on a status and so would
  // otherwise differ only by an english string. The same pair the other two
  // POST routes answer, asserted again here rather than assumed shared:
  // all three reach `MALFORMED_BODY` through the same `readBody`, but each
  // owns its own `invalid-shape` answer and its own shape guard.
  const { raw, db } = setup();
  let called = 0;
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    requestPick: async () => {
      called += 1;
      return { accepted: true };
    },
  });
  try {
    const unparseable = await postRaw(server, '/api/picks', cookie, '{not json');
    assert.equal(unparseable.status, 400);
    assert.deepEqual(JSON.parse(unparseable.text), { refusal: 'malformed-body' });

    // Parses, and is not a pick: `rssItemId` as a string is exactly what a
    // form field or a route parameter hands you, and it is the shape the
    // guard exists to stop -- the host would otherwise be asked about an id
    // no `WHERE id = ?` could match.
    const asString = await post(server, '/api/picks', cookie, { rssItemId: '860531' });
    assert.equal(asString.status, 400);
    assert.deepEqual(JSON.parse(asString.text), { refusal: 'invalid-shape' });

    const missing = await post(server, '/api/picks', cookie, {});
    assert.equal(missing.status, 400, 'an absent id is a shape failure too');
    assert.deepEqual(JSON.parse(missing.text), { refusal: 'invalid-shape' });

    // An extra field is simply not read, the same way it is not for the
    // other two POST routes: the guard ignores unknown properties.
    const extra = await post(server, '/api/picks', cookie, { ...validPickBody(), downloadClientId: 3 });
    assert.equal(extra.status, 202, 'an extra field is not a shape failure');

    assert.notDeepEqual(
      JSON.parse(unparseable.text),
      JSON.parse(asString.text),
      'and the two 400s are distinguishable without reading a sentence',
    );
    assert.equal(called, 1, 'only the well-shaped body reached the host');
  } finally {
    await server.close();
  }
});

test('the pick route is guarded by a session like every read', async () => {
  const { raw, db } = setup();
  const { server } = await start(raw, db, moviesOnly);
  try {
    const answer = await post(server, '/api/picks', ANONYMOUS, validPickBody());
    assert.equal(answer.status, 401, 'no session, no write');
  } finally {
    await server.close();
  }
});

/**
 * A well-shaped `POST /api/mappings` body, so each test overrides only the
 * field it means to change.
 *
 * `D:\Downloads` **is** the default rather than an exotic extra case
 * (design spec §7 and acceptance 3): a route-level check on path shape
 * would be caught by every test in this group rather than by one of them.
 */
function validMappingBody(overrides: Partial<{ downloadClientId: number; fromPath: string; toPath: string }> = {}): {
  downloadClientId: number;
  fromPath: string;
  toPath: string;
} {
  return { downloadClientId: 4, fromPath: 'D:\\Downloads', toPath: '/mnt/seedbox', ...overrides };
}

/** A well-shaped `PATCH /api/mappings/:id` body -- the two paths, and no id. */
function validMappingEditBody(): { fromPath: string; toPath: string } {
  return { fromPath: 'D:\\Downloads', toPath: '/mnt/media' };
}

test('a well-shaped mapping body is written and answered 201 with the new id', async () => {
  const { raw, db } = setup();
  const seen: unknown[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    addMapping: async (input) => {
      seen.push(input);
      return { id: 31 };
    },
  });
  try {
    const answer = await post(server, '/api/mappings', cookie, validMappingBody());

    assert.equal(answer.status, 201);
    assert.deepEqual(JSON.parse(answer.text), { id: 31 });
    assert.deepEqual(
      seen,
      [{ downloadClientId: 4, fromPath: 'D:\\Downloads', toPath: '/mnt/seedbox' }],
      'the host is handed the body verbatim -- in particular the route neither normalises nor rejects a windows-shaped path',
    );
  } finally {
    await server.close();
  }
});

test('an edit answers 200 with the id from the path, and the host is told which row', async () => {
  const { raw, db } = setup();
  const seen: { id: number; input: unknown }[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    editMapping: async (id, input) => {
      seen.push({ id, input });
      return { id };
    },
  });
  try {
    const answer = await send(server, 'PATCH', '/api/mappings/7', cookie, validMappingEditBody());

    assert.equal(answer.status, 200, 'an edit created nothing, so it is not a 201');
    assert.deepEqual(JSON.parse(answer.text), { id: 7 });
    assert.deepEqual(
      seen,
      [{ id: 7, input: { fromPath: 'D:\\Downloads', toPath: '/mnt/media' } }],
      'the id comes off the path and the paths come out of the body, with neither read from the other',
    );
  } finally {
    await server.close();
  }
});

test('removing a feed answers the outcome, because deleted and disabled are different news', async () => {
  // `/api/mappings/:id` answers 204 and no body -- one outcome, nothing to
  // describe. A feed has two: one that produced no releases is deleted, one
  // that produced some is disabled and keeps them. A caller that cannot
  // tell which happened cannot tell the operator, so the body carries it.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    removeFeed: async (id) => (id === 1 ? { outcome: 'deleted' } : { outcome: 'disabled', items: 3 }),
  });
  try {
    const deleted = await sendBodiless(server, 'DELETE', '/api/feeds/1', cookie);
    assert.equal(deleted.status, 200);
    assert.deepEqual(JSON.parse(deleted.text), { outcome: 'deleted' });

    const disabled = await sendBodiless(server, 'DELETE', '/api/feeds/2', cookie);
    assert.equal(disabled.status, 200);
    assert.deepEqual(JSON.parse(disabled.text), { outcome: 'disabled', items: 3 });
  } finally {
    await server.close();
  }
});

test('removing a feed that does not exist answers 404', async () => {
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    removeFeed: async () => ({ refusal: 'unknown-feed' }),
  });
  try {
    const answer = await sendBodiless(server, 'DELETE', '/api/feeds/404', cookie);
    assert.equal(answer.status, 404);
    assert.deepEqual(JSON.parse(answer.text), { refusal: 'unknown-feed' });
  } finally {
    await server.close();
  }
});

test('a feed is paused and resumed through PATCH, and a bad body is refused', async () => {
  const seen: Array<{ id: number; disabled: boolean }> = [];
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    setFeedDisabled: async (id, disabled) => {
      seen.push({ id, disabled });
      return disabled ? { outcome: 'disabled' } : { outcome: 'enabled' };
    },
  });
  try {
    assert.equal((await send(server, 'PATCH', '/api/feeds/7', cookie, { disabled: true })).status, 200);
    assert.equal((await send(server, 'PATCH', '/api/feeds/7', cookie, { disabled: false })).status, 200);
    assert.deepEqual(seen, [{ id: 7, disabled: true }, { id: 7, disabled: false }]);

    // Strict about the body for the reason the config schemas are: a
    // misspelled field that parsed would do something other than it says.
    assert.equal((await send(server, 'PATCH', '/api/feeds/7', cookie, { disable: true })).status, 400);
    assert.equal((await send(server, 'PATCH', '/api/feeds/7', cookie, { disabled: 'yes' })).status, 400);
    assert.equal((await send(server, 'PATCH', '/api/feeds/7', cookie, { disabled: true, extra: 1 })).status, 400);
    assert.deepEqual(seen.length, 2, 'a refused body reaches no handler');
  } finally {
    await server.close();
  }
});

test('a feed id that is not digits is the same 404 an unknown path gets', async () => {
  // The same reasoning `/api/mappings/:id` records: saying which of two
  // mistakes a caller made would tell them a real path from an invented one.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {});
  try {
    assert.equal((await sendBodiless(server, 'DELETE', '/api/feeds/abc', cookie)).status, 404);
  } finally {
    await server.close();
  }
});

test('a removal answers 204 with no body at all', async () => {
  const { raw, db } = setup();
  const seen: number[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    removeMapping: async (id) => {
      seen.push(id);
      return { id };
    },
  });
  try {
    const answer = await sendBodiless(server, 'DELETE', '/api/mappings/7', cookie);

    assert.equal(answer.status, 204);
    assert.equal(answer.text, '', 'a 204 carries no body, and composing one would be a protocol violation');
    assert.deepEqual(seen, [7]);
  } finally {
    await server.close();
  }
});

test('a DELETE sends no body, and the request reader must not refuse it for that', async () => {
  // **The case the "one line per route" account of this slice misses.**
  // `handle` reads a body for every method but `GET`, and `readBody`'s
  // `JSON.parse('')` throws -- so before this slice a bodiless `DELETE`
  // was answered `400 malformed-body` by the reader, ahead of the router,
  // and the route's own `methods` entry could not have helped. A browser's
  // `fetch(url, { method: 'DELETE' })` sends exactly that, so this is the
  // ordinary case and not an edge one.
  //
  // Asserted against *both* new methods: a bodiless `PATCH` is a legal
  // request too, and it must reach the shape guard and be told its body is
  // the wrong shape, rather than be told it is malformed json.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    removeMapping: async (id) => ({ id }),
    editMapping: async (id) => ({ id }),
  });
  try {
    const removed = await sendBodiless(server, 'DELETE', '/api/mappings/7', cookie);
    assert.equal(removed.status, 204, 'a bodiless DELETE is the normal shape, not a malformed request');

    const edited = await sendBodiless(server, 'PATCH', '/api/mappings/7', cookie);
    assert.equal(edited.status, 400, 'a bodiless PATCH has no paths to write');
    assert.deepEqual(
      JSON.parse(edited.text),
      { refusal: 'invalid-shape' },
      'and it is a shape failure rather than a parse failure: there was nothing to parse',
    );

    // **A DELETE that *does* send a body is still read, and still refused
    // if it does not parse.** The change in `readBody` is about an empty
    // body, not about the method: skipping the read for `DELETE` would
    // leave a client's bytes unread on the socket, so the body is drained
    // and discarded either way. A `DELETE` carrying `{not json` therefore
    // gets the same `malformed-body` any other method would -- measured,
    // and pinned here because the alternative implementation would have
    // answered 204 and nothing would have said so.
    const garbage = await sendRaw(server, 'DELETE', '/api/mappings/7', cookie, '{not json');
    assert.equal(garbage.status, 400);
    assert.deepEqual(JSON.parse(garbage.text), { refusal: 'malformed-body' });

    // And a DELETE carrying a well-formed body is read, discarded and
    // answered normally: the route takes its id from the path and looks at
    // no body at all.
    const withBody = await send(server, 'DELETE', '/api/mappings/7', cookie, { fromPath: '/ignored' });
    assert.equal(withBody.status, 204);
    assert.equal(withBody.text, '');
  } finally {
    await server.close();
  }
});

test('an empty request body is not a malformed one, and whitespace still is', async () => {
  // **The edit to `readBody` moved three routes that were already
  // shipped**, and this is where that is pinned rather than left for the
  // next reader to construct. `JSON.parse('')` throws, so before the
  // change every completely empty non-`GET` body was `malformed-body`;
  // it is now `{ body: undefined }`, which each route's own shape guard
  // then refuses as `invalid-shape`.
  //
  // Both codes are 400 and both are stable codes, so the constraint the
  // pair exists to satisfy is untouched -- and `invalid-shape` is the
  // honest one, because there was nothing to parse.
  //
  // **Whitespace-only is still `malformed-body`**, and that is the line:
  // the check is `text === ''`, not a trim, so `' '` reaches `JSON.parse`
  // and throws exactly as it did before. A trim here would have quietly
  // widened "no body" to "nothing but spaces", which is a different claim
  // about what a client sent.
  //
  // Asserted on a **non-mapping** route as well as a mapping one, because
  // the routes this change moved are the ones it was not written for.
  const { raw, db } = setup();
  let reached = 0;
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    addFeed: async () => {
      reached += 1;
      return { id: 1 };
    },
    addMapping: async () => {
      reached += 1;
      return { id: 1 };
    },
  });
  try {
    const routes = ['/api/feeds', '/api/mappings'] as const;

    const empties = await Promise.all(routes.map(async (path) => {
      const { status, text } = await postRaw(server, path, cookie, '');
      return { path, status, text };
    }));
    for (const { path, status, text } of empties) {
      assert.equal(status, 400, `${path} refuses an empty body`);
      assert.deepEqual(
        JSON.parse(text),
        { refusal: 'invalid-shape' },
        `${path}: an absent body is a shape failure, not a parse failure`,
      );
    }

    const blanks = await Promise.all(routes.map(async (path) => {
      const { status, text } = await postRaw(server, path, cookie, '   ');
      return { path, status, text };
    }));
    for (const { path, status, text } of blanks) {
      assert.equal(status, 400, `${path} refuses a whitespace-only body`);
      assert.deepEqual(
        JSON.parse(text),
        { refusal: 'malformed-body' },
        `${path}: whitespace is a body, and it does not parse -- the check is \`=== ''\`, not a trim`,
      );
    }

    // The two codes still tell the two conditions apart, which is the whole
    // point of neither of them being prose.
    assert.notDeepEqual(
      JSON.parse(String(empties[0]?.text)),
      JSON.parse(String(blanks[0]?.text)),
      'an absent body and an unparseable one remain distinguishable without reading a sentence',
    );
    assert.equal(reached, 0, 'and neither body reached a host operation');
  } finally {
    await server.close();
  }
});

test('every mapping refusal answers its own status, on the route that can produce it', async () => {
  // **All four of `MAPPING_REFUSALS`, not a sample** -- the feeds slice
  // shipped two of its four unpinned, so its status mapper could have
  // dropped a `case` and fallen through with every test still green.
  //
  // Each code is driven through a route that can really answer it rather
  // than through whichever is convenient: `unknown-client` only reaches
  // the add, `unknown-mapping` only the edit and the remove. A stub can
  // return any code from any route, which is exactly why the table below
  // says which pairing it is asserting.
  const cases = [
    ['POST', '/api/mappings', 'unknown-client', 404],
    ['POST', '/api/mappings', 'duplicate-from-path', 409],
    ['POST', '/api/mappings', 'empty-path', 422],
    ['PATCH', '/api/mappings/7', 'unknown-mapping', 404],
    ['PATCH', '/api/mappings/7', 'duplicate-from-path', 409],
    ['PATCH', '/api/mappings/7', 'empty-path', 422],
    ['DELETE', '/api/mappings/7', 'unknown-mapping', 404],
  ] as const;
  // Both halves of the table, read off the contract rather than counted by
  // hand, so a fifth code added to `MAPPING_REFUSALS` fails here instead of
  // quietly going unprobed.
  assert.equal(
    new Set(cases.map(([, , refusal]) => refusal)).size,
    MAPPING_REFUSALS.length,
    'every refusal the host can return has a row',
  );
  for (const code of MAPPING_REFUSALS) {
    assert.ok(cases.some(([, , refusal]) => refusal === code), `${code} is probed`);
  }
  // And the split is a real one rather than seven rows of the same number:
  // a mapper answering 404 for everything would satisfy every per-case
  // assertion below if the table said 404 seven times.
  assert.equal(new Set(cases.map(([, , , status]) => status)).size, 3, 'the table distinguishes three statuses');

  // A fresh `setup()` per case, run concurrently rather than in a loop with
  // an `await` in it: an install gets exactly one account, so a second
  // sign-up against one database would be refused for a reason that has
  // nothing to do with this property.
  await Promise.all(cases.map(async ([method, path, refusal, status]) => {
    const { raw, db } = setup();
    const { server, cookie, logs } = await startSignedIn(raw, db, moviesOnly, {
      addMapping: async () => ({ refusal }),
      editMapping: async () => ({ refusal }),
      removeMapping: async () => ({ refusal }),
    });
    try {
      const answer = await send(server, method, path, cookie, validMappingBody());
      assert.equal(answer.status, status, `${method} ${path} answers ${String(status)} for ${refusal}`);
      assert.deepEqual(JSON.parse(answer.text), { refusal }, 'and the whole body is that one stable code');
      assert.ok(
        !answer.text.includes('Downloads') && !answer.text.includes('seedbox'),
        'no refusal repeats a path it was handed',
      );
      assert.ok(
        !JSON.stringify(logs).includes('Downloads'),
        'and nothing about the refused mapping is written down either',
      );
    } finally {
      await server.close();
    }
  }));
});

test('both mapping 400s carry a code, so the one status they share is not told apart by prose', async () => {
  const { raw, db } = setup();
  let added = 0;
  let edited = 0;
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    addMapping: async () => {
      added += 1;
      return { id: 1 };
    },
    editMapping: async (id) => {
      edited += 1;
      return { id };
    },
  });
  try {
    const unparseable = await postRaw(server, '/api/mappings', cookie, '{not json');
    assert.equal(unparseable.status, 400);
    assert.deepEqual(JSON.parse(unparseable.text), { refusal: 'malformed-body' });

    // Parses, and is not a mapping: `downloadClientId` as a string is what
    // a form field or a route parameter hands you.
    const asString = await post(server, '/api/mappings', cookie, validMappingBody({ downloadClientId: 4 }));
    assert.equal(asString.status, 201, 'the control: the well-shaped body is accepted');

    const wrongType = await post(server, '/api/mappings', cookie, { ...validMappingBody(), downloadClientId: '4' });
    assert.equal(wrongType.status, 400);
    assert.deepEqual(JSON.parse(wrongType.text), { refusal: 'invalid-shape' });

    const missingPath = await post(server, '/api/mappings', cookie, { downloadClientId: 4, fromPath: '/downloads' });
    assert.equal(missingPath.status, 400, 'an absent to_path is a shape failure');
    assert.deepEqual(JSON.parse(missingPath.text), { refusal: 'invalid-shape' });

    // An extra field is simply not read, the same way it is not on the
    // three POST routes above.
    const extra = await post(server, '/api/mappings', cookie, { ...validMappingBody(), id: 99 });
    assert.equal(extra.status, 201, 'an extra field is not a shape failure');

    // And the same pair on the edit, which has its own guard rather than
    // sharing the add's.
    const editUnparseable = await sendRaw(server, 'PATCH', '/api/mappings/7', cookie, '{not json');
    assert.equal(editUnparseable.status, 400);
    assert.deepEqual(JSON.parse(editUnparseable.text), { refusal: 'malformed-body' });

    const editWrongShape = await send(server, 'PATCH', '/api/mappings/7', cookie, { fromPath: '/downloads' });
    assert.equal(editWrongShape.status, 400);
    assert.deepEqual(JSON.parse(editWrongShape.text), { refusal: 'invalid-shape' });

    assert.notDeepEqual(
      JSON.parse(unparseable.text),
      JSON.parse(wrongType.text),
      'and the two 400s are distinguishable without reading a sentence',
    );
    assert.equal(added, 2, 'only the two well-shaped bodies -- the control and the one with an extra field -- reached the host');
    assert.equal(edited, 0, 'and neither malformed edit did');
  } finally {
    await server.close();
  }
});

/**
 * The one mapping id the stubs below know about, so a test can tell "the
 * host was asked and said no" from "the route never asked".
 */
const KNOWN_MAPPING_ID = 7;

/**
 * `editMapping`/`removeMapping` stubs that behave the way the real host
 * behaves, recording every id they are handed into `asked`.
 *
 * **Realistic rather than always-accepting, and that is what makes the
 * `Number.isSafeInteger` test mean anything.** The first version of that
 * test used stubs that answered `{ id }` for every id, so deleting the
 * check turned a 404 into a 204 -- a loud failure produced entirely by the
 * stub. The real host answers `changes === 0` as
 * `{ refusal: 'unknown-mapping' }`, so what actually changes in production
 * is the *body* of a 404, not the status. These stubs reproduce that, so
 * the assertion that reds is the one about the body.
 */
function knownMappingOnly(asked: number[]): Pick<ReadServerDeps, 'editMapping' | 'removeMapping'> {
  const answer = async (id: number): Promise<{ id: number } | MappingRefusal> => {
    asked.push(id);
    return id === KNOWN_MAPPING_ID ? { id } : { refusal: 'unknown-mapping' };
  };
  return { editMapping: (id) => answer(id), removeMapping: (id) => answer(id) };
}

test('a mapping id that is not a safe integer is an unknown route, and the host is never asked', async () => {
  // The `:id` is read back off the pathname by index and checked, never
  // bound and never `!`-asserted -- the shape `/api/artwork/:kind/
  // :mediaItemId` established.
  //
  // **What `Number.isSafeInteger` actually buys, re-measured.** The reason
  // first written here -- "a float bound against an `INTEGER PRIMARY KEY`
  // is a 500" -- was false. `node:sqlite` binds `1e+30`, `1.5`, `-1` and
  // `2**53` to both the `DELETE` and the `UPDATE` without throwing, each
  // reporting `changes: 0`, so the host would answer
  // `404 { refusal: 'unknown-mapping' }`.
  //
  // The check still earns its place, and this test is written against the
  // two things it really does: the answer is the *unknown-route* 404 rather
  // than a claim that a well-formed id named no row, and no such id reaches
  // a prepared statement at all. The row-aliasing case, which is the
  // stronger reason, is the test below.
  const { raw, db } = setup();
  const asked: number[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, knownMappingOnly(asked));
  try {
    const tooLarge = '9'.repeat(30);
    const unreachable = [
      ['DELETE', `/api/mappings/${tooLarge}`],
      ['PATCH', `/api/mappings/${tooLarge}`],
      ['DELETE', '/api/mappings/7x'],
      ['PATCH', '/api/mappings/-1'],
      ['DELETE', '/api/mappings/1.5'],
    ] as const;

    const answers = await Promise.all(unreachable.map(async ([method, path]) => {
      const { status, text } = await send(server, method, path, cookie, validMappingEditBody());
      return { method, path, status, text };
    }));

    for (const { method, path, status, text } of answers) {
      assert.equal(status, 404, `${method} ${path} is not a mapping that could exist`);
      // The body, not the status, is what moves if the check goes: the host
      // would answer `unknown-mapping`, which asserts something about a row
      // that it cannot honestly assert about `1e+30`.
      assert.deepEqual(
        JSON.parse(text),
        { error: 'unknown route' },
        `${method} ${path} answers the same 404 a path naming no route gets, not unknown-mapping`,
      );
    }
    assert.deepEqual(asked, [], 'no unparseable id reached the host, whatever it would have done with it');

    // Two controls, so the assertions above are not passing because nothing
    // ever gets through: a real id the host knows, and a real id it does
    // not -- the second being exactly the answer the unparseable ids must
    // *not* receive.
    const known = await sendBodiless(server, 'DELETE', `/api/mappings/${String(KNOWN_MAPPING_ID)}`, cookie);
    assert.equal(known.status, 204);

    const absent = await sendBodiless(server, 'DELETE', '/api/mappings/8', cookie);
    assert.equal(absent.status, 404);
    assert.deepEqual(
      JSON.parse(absent.text),
      { refusal: 'unknown-mapping' },
      'a well-formed id naming no row reads differently from an id that could never name one',
    );

    assert.deepEqual(asked, [KNOWN_MAPPING_ID, 8], 'and only the two well-formed ids reached the host');
  } finally {
    await server.close();
  }
});

test('an id above 2**53 cannot be used to address the row next to the one asked for', async () => {
  // **The strongest reason the check exists, and the one that is a
  // correctness bug rather than a cosmetic one.** Measured directly against
  // a migrated database: a `filepath_mapping` row seeded at id
  // `9007199254740992` (`2**53`) is deleted by
  // `DELETE ... WHERE id = Number('9007199254740993')` -- a *different*
  // id -- with `changes: 1`, because `Number('9007199254740993')` is
  // `9007199254740992`. Every integer above `2**53` has neighbours that
  // collapse onto it, and `INTEGER PRIMARY KEY` runs to `2**63 - 1`.
  //
  // `DIGITS` cannot catch this: sixteen digits are all digits. This is the
  // one case where removing `Number.isSafeInteger` is not a cosmetic change
  // to a 404 body but a silent write to the wrong row.
  const alias = '9007199254740993';
  assert.equal(Number(alias), 2 ** 53, 'the premise: this id parses to its neighbour');
  assert.equal(Number.isSafeInteger(Number(alias)), false, 'and the check is what sees that');

  const { raw, db } = setup();
  const asked: number[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, knownMappingOnly(asked));
  try {
    const removed = await sendBodiless(server, 'DELETE', `/api/mappings/${alias}`, cookie);
    assert.equal(removed.status, 404);
    assert.deepEqual(JSON.parse(removed.text), { error: 'unknown route' });

    const edited = await send(server, 'PATCH', `/api/mappings/${alias}`, cookie, validMappingEditBody());
    assert.equal(edited.status, 404);

    assert.deepEqual(
      asked,
      [],
      `no request for ${alias} may reach the host, because what it would be handed is ${String(2 ** 53)}`,
    );
  } finally {
    await server.close();
  }
});

test('PATCH and DELETE are refused without a session exactly as POST is, and tell a caller nothing else', async () => {
  // Acceptance 7, and the ordering `refusalFor` fixed a round of its own
  // for. The session check runs *before* the method check, so an anonymous
  // caller gets `401` whatever they sent and whether or not the path they
  // sent it to names a route. Measured as a **cross-path** comparison,
  // because that is the only way the leak was visible: when the order was
  // reversed, an anonymous write to a real path answered `405` and one to
  // an invented path answered `401`, so a pair of requests named which
  // `/api` paths exist.
  const { raw, db } = setup();
  let reached = 0;
  const count = async (): Promise<{ id: number }> => {
    reached += 1;
    return { id: 1 };
  };
  const { server } = await start(raw, db, moviesOnly, undefined, {
    addMapping: count,
    editMapping: count,
    removeMapping: count,
  });
  try {
    const probes = [
      // The three methods the two routes declare.
      ['POST', '/api/mappings'],
      ['PATCH', '/api/mappings/1'],
      ['DELETE', '/api/mappings/1'],
      // A method neither route declares, on a path that exists. This is the
      // one the ordering is about: `405` here would be an oracle.
      ['GET', '/api/mappings/1'],
      ['PUT', '/api/mappings/1'],
      // The same requests to paths no route claims, which must be
      // indistinguishable from the ones above.
      ['POST', '/api/mappings-invented'],
      ['PATCH', '/api/mappings-invented/1'],
      ['DELETE', '/api/mappings-invented/1'],
    ] as const;

    // `sendBodiless` for the `GET`, because `fetch` refuses to build a
    // `GET` with a body at all -- which is itself why the `GET` probe is
    // worth having: it is the shape a browser can actually send.
    const answers = await Promise.all(probes.map(async ([method, path]) => {
      const { status, text } = await (method === 'GET'
        ? sendBodiless(server, method, path, ANONYMOUS)
        : send(server, method, path, ANONYMOUS, validMappingEditBody()));
      return { method, path, status, text };
    }));

    for (const { method, path, status, text } of answers) {
      assert.equal(status, 401, `anonymous ${method} ${path} must be refused`);
      assert.deepEqual(JSON.parse(text), { error: 'unauthorized' }, `${method} ${path} refuses with the fixed body`);
    }
    assert.equal(
      new Set(answers.map(({ status }) => status)).size,
      1,
      'one status across every pairing, so no comparison tells a real path from an invented one',
    );
    assert.equal(reached, 0, 'and no anonymous request reached the host');
  } finally {
    await server.close();
  }
});

test('a signed-in caller still gets 405 for a method the mapping routes do not declare', async () => {
  // The other half of the ordering: nothing the session-first order buys
  // costs the method check its job. A caller who has identified themselves
  // is told their method is wrong, because at that point it is not a
  // question they have no standing to ask.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const wrong = await Promise.all(([
      ['GET', '/api/mappings'],
      ['DELETE', '/api/mappings'],
      ['GET', '/api/mappings/1'],
      ['POST', '/api/mappings/1'],
    ] as const).map(async ([method, path]) => {
      // `fetch` refuses to build a `GET` with a body, so the two `GET`
      // probes are sent as a browser would send them.
      const { status } = await (method === 'GET'
        ? sendBodiless(server, method, path, cookie)
        : send(server, method, path, cookie, {}));
      return { method, path, status };
    }));

    for (const { method, path, status } of wrong) {
      assert.equal(status, 405, `${method} ${path} is not a method either route declares`);
    }
  } finally {
    await server.close();
  }
});

test('every route except health refuses without a session', async () => {
  // Enumerated from the route table, not hand-listed: `probeFor` turns each
  // route's own path into a request, so a route a later slice adds is either
  // guarded or fails here. A written-out list of six paths would pass
  // untouched beside a seventh route nobody guarded.
  //
  // Each probed with *every* method it declares (`guardProbeAll`), not a
  // blanket `GET`: `/api/feeds` answers only `POST`, and a `GET` against it
  // would hit the method guard before ever reaching the session check this
  // test means to exercise -- see `guardProbe`'s own doc, which also says
  // why it is every method and not the first.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const guarded = ROUTES.filter((route) => !route.open);
    // Both halves of the table's shape, because the filter above is what a
    // route wrongly marked open would slip through: flipping one `open` would
    // otherwise *remove* that route from this test rather than fail it.
    assert.equal(guarded.length, ROUTES.length - 2, 'exactly two routes in the table are open');
    assert.ok(guarded.length >= 5, 'and the table is the real one, not a list this test passed over');

    const refused = await guardProbeAll(server, guarded, ANONYMOUS);
    // Exactly one answer per declared method, not per route. This is what
    // fails the day `guardProbe` goes back to probing `methods[0]` and a
    // route declares two -- which is otherwise silent, since a method that
    // is never probed cannot fail the loop below.
    assert.equal(
      refused.length,
      guarded.reduce((total, route) => total + route.methods.length, 0),
      'every method every guarded route declares is probed, not just the first',
    );
    for (const { path, method, status, text } of refused) {
      assert.equal(status, 401, `${method} ${path} must refuse a caller with no session`);
      assert.deepEqual(JSON.parse(text), { error: 'unauthorized' }, `${method} ${path} refuses with the fixed body`);
    }

    // And the same enumeration with a session: nothing here is 401, so the
    // loop above is not passing merely because the guard refuses everyone.
    const allowed = await guardProbeAll(server, guarded, cookie);
    for (const { path, method, status } of allowed) {
      assert.notEqual(status, 401, `${method} ${path} must be reachable by a session holder`);
    }
  } finally {
    await server.close();
  }
});

test('health and the static bundle answer without a session, and nothing else does', async () => {
  // A container health check has no credential to offer, and the bundle is
  // the same bytes for every caller and the one thing a browser must load
  // before it can even render a sign-in form -- so those two stay open, and
  // *only* those two, which is why the assertion is over the whole table
  // rather than over health alone.
  const { raw, db } = setup();
  const { server } = await start(raw, db, moviesOnly);
  try {
    const openPaths = ROUTES.filter((route) => route.open).map((route) => route.path);
    assert.deepEqual(
      openPaths,
      // '/*' is `server.ts`'s own `STATIC_ROUTE_PATH` sentinel, not a real
      // request target -- see that module's doc on the constant.
      ['/api/health', '/*'],
      'two open routes: the health check and the bundle',
    );

    // Each probed with every method it declares -- see `guardProbe`'s doc
    // for why a blanket `GET` cannot probe `POST /api/feeds`, and why one
    // method per route is not enough.
    const answers = await guardProbeAll(server, ROUTES, ANONYMOUS);
    for (const { path, method, status } of answers) {
      if (openPaths.includes(path)) {
        assert.notEqual(status, 401, `${method} ${path} must answer without a session`);
      } else {
        assert.equal(status, 401, `${method} ${path} must refuse a caller with no session`);
      }
    }

    const health = await get(server, '/api/health', ANONYMOUS);
    assert.deepEqual(
      JSON.parse(await health.text()),
      { ok: true, version: API_VERSION },
      'and answers the body a health check reads, not merely a status',
    );
  } finally {
    await server.close();
  }
});

/**
 * The reviewer's probe path: shaped exactly like a route a later slice would
 * add, and named by no route in `ROUTES`.
 *
 * A constant so the test below can assert that it names nothing in the table.
 * The day it does name something, this test says so rather than quietly
 * becoming a test of that route.
 */
const UNMOUNTED_PROBE = '/api/rss-items-v2';

test('a path beside the auth dispatch is refused, mounted or not', async () => {
  // **The reviewer's exact probe, as a test.** An unguarded
  // `/api/rss-items-v2` serving real rows was mounted in `handle` beside the
  // auth dispatch and all 22 tests passed: the guarded set is derived from
  // `ROUTES`, which is right, and a route that is not in `ROUTES` inherits
  // nothing from it. Nothing but `/api/auth/*` is mounted there today, so
  // nothing was exposed -- what this pins is that the guard is taken *before*
  // the router, so a mount written below it is refused without its author
  // having had to think about the guard.
  //
  // The rows exist so the mutation that re-mounts that probe has something
  // real to serve, which is what made it worth reporting: it was not an empty
  // page that happened to answer 200.
  const { raw, db } = setup();
  const feedId = seedFeed(raw, 'https://feeds.test/beside.xml');
  seedRssItem(raw, feedId, 2000, 'Beside.The.Dispatch.1080p.mkv');
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    assert.ok(
      !ROUTES.some((route) => route.path === UNMOUNTED_PROBE),
      `${UNMOUNTED_PROBE} now names a route in ROUTES, so it is no longer a probe for an unmounted path`,
    );

    const anonymous = await get(server, UNMOUNTED_PROBE, ANONYMOUS);
    assert.equal(anonymous.status, 401, 'a path no route claims is refused, not answered');
    // The body, not only the status: a 401 saying `unauthorized` is the
    // guard's answer, where a 404 would be the router's. That distinction is
    // the whole of this test -- a mount above the guard answers with its own
    // body, and a mount below it never runs.
    assert.deepEqual(
      JSON.parse(await anonymous.text()),
      { error: 'unauthorized' },
      'refused by the guard, rather than answered by anything mounted beside the dispatch',
    );

    // The other half, and it is a different fact: nothing *is* mounted there
    // today. Mounting the reviewer's probe below the guard fails this
    // assertion and not the one above -- which is the proof, because a route
    // mounted below the guard answering a session holder is exactly what a
    // correctly guarded new route does. Mounted above the guard it fails the
    // anonymous assertion instead, with a 200 and real rows.
    const signedIn = await get(server, UNMOUNTED_PROBE, cookie);
    assert.equal(signedIn.status, 404, 'past the guard, a path no route claims is an unknown route');
  } finally {
    await server.close();
  }
});

/**
 * A path that shares the auth mount's prefix without being inside it, which
 * is the whole space `isAuthPath`'s trailing slash keeps out of the
 * dispatcher. `/api/rss-items-v2` above cannot cover it: it does not share
 * the prefix, so it exercises the router rather than the prefix test.
 *
 * `/api/authors` is the shape a later slice actually adds; `authx` is the
 * shortest thing with the same property, and both are equally unclaimed.
 */
const AUTH_PREFIX_PROBE = '/api/authx';

test('a path that merely starts with the auth prefix is the guard\'s, not the dispatcher\'s', async () => {
  // **The one surviving mutation the whole-branch review found.**
  // `isAuthPath` is `pathname === AUTH_BASE || pathname.startsWith(`${AUTH_BASE}/`)`,
  // and its comment says the trailing slash is load-bearing. Replacing it with
  // `pathname.startsWith(AUTH_BASE)` passed all 1937 tests, while handing the
  // entire `/api/auth*` prefix space to a library that knows nothing about it:
  // measured at the socket, `/api/authx` then answers Better Auth's **404**
  // instead of this module's 401, so a route named `/api/authors` added later
  // would be dispatched into the library and nothing would fail.
  //
  // Anonymous is the half that matters: the 401 is proof the request was
  // guarded, and the dispatcher's 404 is proof it was not. The body is
  // asserted for the same reason as the test above -- a status alone cannot
  // tell which module answered.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    assert.ok(
      !ROUTES.some((route) => route.path === AUTH_PREFIX_PROBE),
      `${AUTH_PREFIX_PROBE} now names a route in ROUTES, so it is no longer a probe for the prefix`,
    );

    const anonymous = await get(server, AUTH_PREFIX_PROBE, ANONYMOUS);
    assert.equal(anonymous.status, 401, 'a path beside the mount, not in it, must reach the guard');
    assert.deepEqual(
      JSON.parse(await anonymous.text()),
      { error: 'unauthorized' },
      'answered by the guard; a 404 here would mean the auth dispatcher was handed a path it does not own',
    );

    // Past the guard it is an unknown route, exactly as `/api/rss-items-v2`
    // is -- which is what makes the 401 above the guard's and not the
    // router's.
    const signedIn = await get(server, AUTH_PREFIX_PROBE, cookie);
    assert.equal(signedIn.status, 404, 'past the guard, a path no route claims is an unknown route');

    // And the mount itself still dispatches, so this is not a test that would
    // pass by breaking the forwarding it is written beside: `/api/auth` and
    // `/api/auth/get-session` are both the library's.
    const session = await get(server, '/api/auth/get-session', ANONYMOUS);
    assert.equal(session.status, 200, 'the mount still reaches Better Auth');
    assert.equal(await session.text(), 'null', 'and answers 200 with a null body for an anonymous caller, which is what the guard reads');
  } finally {
    await server.close();
  }
});

test('a valid session cookie reaches the data', async () => {
  // The other half of the guard, and the one a refuse-everything
  // implementation fails: a real session, issued by a real sign-up through
  // the mounted auth routes, reads a real row.
  const { raw, db } = setup();
  const mediaItemId = seedMediaItem(raw, 'alpha', 1001, 'Movie 1');
  const feedId = seedFeed(raw, 'https://feeds.test/session.xml');
  seedRssItem(raw, feedId, 2000, 'Session.Movie.1080p.mkv');
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const media = await get(server, '/api/media?type=movie', cookie);
    assert.equal(media.status, 200, 'a session holder reads the media route');
    assert.deepEqual(JSON.parse(await media.text()), {
      items: [expectedMediaItem(mediaItemId)],
      cursor: encodeCursor({ updatedAt: 1001, id: mediaItemId }),
      done: true,
    }, 'the rows themselves, not an empty page the guard happened to allow');

    // A second route with the same cookie, so the pass is the session and not
    // one route's own accident.
    //
    // Read back through checks rather than a cast, the rule `pageFrom` above
    // states and the reason it gives: `Response.json()` is `unknown` under
    // this tsconfig, so `as { items: unknown[] }` silenced a real error and
    // would have let a route answering a different shape fail somewhere
    // downstream instead of here, by name. `isRecord` is already here for
    // exactly this.
    const items = await get(server, '/api/rss-items', cookie);
    assert.equal(items.status, 200, 'the same session cookie reads a second route');
    const itemsBody: unknown = await items.json();
    if (!isRecord(itemsBody) || !Array.isArray(itemsBody.items)) {
      throw new Error('/api/rss-items answered no items array');
    }
    assert.equal(itemsBody.items.length, 1, 'the seeded rss item, not an empty page the guard let through');

    // Artwork too, which slice E left as an existence oracle over integer
    // ids: a session holder still gets its 404 for a media item with no
    // poster, rather than the guard's 401.
    const artwork = await get(server, `/api/artwork/poster/${mediaItemId}`, cookie);
    assert.equal(artwork.status, 404, 'past the guard, and answered by the route');
  } finally {
    await server.close();
  }
});

test('a session check resolving null refuses, though the check answered 200', async () => {
  // The `200 null` trap, and the reason the guard tests the *value* the check
  // resolves to. Better Auth answers an unauthenticated session check with
  // 200 and a body of `null` (design spec §2, measured), so a guard written
  // against the status code lets every anonymous caller through while looking
  // correct in review.
  const { raw, db } = setup();
  seedMediaItem(raw, 'alpha', 1001, 'Movie 1');
  const { server } = await start(raw, db, moviesOnly);
  try {
    const [anonymous, bogus] = await Promise.all([
      checkAndRead(server, ANONYMOUS),
      checkAndRead(server, BOGUS_COOKIE),
    ]);

    for (const [name, probe] of [['no cookie', anonymous], ['a forged cookie', bogus]] as const) {
      assert.equal(probe.check.status, 200, `the session check for ${name} is 200, not 401`);
      // `assert.ok` with a message of its own rather than `assert.equal` on
      // the body: a check that wrongly resolved a session *is* a live session
      // token, and `assert.equal` would print it into the output on the one
      // run where this fails.
      assert.ok(probe.check.text === 'null', `the session check for ${name} resolved to null`);
      assert.equal(probe.guardedStatus, 401, `and the guard refuses ${name} anyway, on the value and not the status`);
    }
  } finally {
    await server.close();
  }
});

test('a 401 body carries no url, path or query string', async () => {
  // The same discipline as the 500 handler: a refusal says one fixed thing.
  // The request below carries a path, a query string and something shaped
  // like a credential, and none of it may come back.
  const { raw, db } = setup();
  const { server, logs } = await start(raw, db, moviesOnly);
  try {
    const probes = [
      '/api/media?type=movie&since=CURSOR-9&apikey=SECRET-KEY-9',
      '/api/artwork/poster/1?apikey=SECRET-KEY-9',
      '/api/nope?apikey=SECRET-KEY-9',
    ];
    const answers = await getAll(server, probes, ANONYMOUS);
    for (const { path, status, text } of answers) {
      assert.equal(status, 401, `${path} is refused`);
      assert.deepEqual(JSON.parse(text), { error: 'unauthorized' }, 'a fixed body');
      // The absence of the recognisable values, not the presence of a generic
      // message: a body can carry both.
      for (const forbidden of ['/', '?', 'api', 'media', 'artwork', 'poster', 'since', 'apikey', 'SECRET-KEY-9']) {
        assert.equal(text.includes(forbidden), false, `the body must not carry ${forbidden}`);
      }
    }
    assert.deepEqual(logs, [], 'a caller with no session is not a failure, so nothing is logged as one');
  } finally {
    await server.close();
  }
});

test('the auth routes are reachable without a session', async () => {
  // Otherwise nobody could ever sign in: the route that issues a session
  // would itself require one. `/api/auth/*` is dispatched by `toNodeHandler`
  // *before* the guard, and this asserts the dispatch rather than the absence
  // of a 401 -- Better Auth's own answer to a wrong password is also 401, so
  // "not 401" would prove nothing here.
  const { raw, db } = setup();
  const { server } = await start(raw, db, moviesOnly);
  try {
    const origin = originOf(server);
    const signIn = async (password: string): Promise<Response> => fetch(`${origin}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ email: OWNER_EMAIL, password }),
    });

    // The dispatch, asserted first and *before any account exists*, so this
    // assertion depends on nothing but the ordering: Better Auth answers a
    // sign-in it cannot satisfy with 401 and an error code of its own, and the
    // guard answers `{ error: 'unauthorized' }`. Same status, different body,
    // which is why the body is what is asserted.
    const noSuchAccount = await signIn(PASSWORD);
    assert.equal(noSuchAccount.status, 401);
    const refusalBody: unknown = JSON.parse(await noSuchAccount.text());
    assert.ok(
      isRecord(refusalBody) && typeof refusalBody.code === 'string',
      'sign-in reached Better Auth, which refused it with an error code of its own',
    );
    assert.notDeepEqual(refusalBody, { error: 'unauthorized' }, 'the guard did not answer for it');

    // Sign-up, unauthenticated, through the mount: the request a fresh install
    // has to be able to make before anything can hold a session at all.
    const cookie = await signUpOwner(server, raw);
    assert.ok(cookie.length > 0, 'sign-up issued a session');

    const signedIn = await signIn(PASSWORD);
    assert.equal(signedIn.status, 200, 'and now the same sign-in succeeds');
    // By count, never by value: the cookie is a live session.
    assert.equal(signedIn.headers.getSetCookie().length, 1, 'issuing exactly one session cookie');

    // And the GET half of the mount, which is the call the guard itself makes.
    const check = await get(server, '/api/auth/get-session', ANONYMOUS);
    assert.equal(check.status, 200, 'the session check is dispatched too, rather than guarded');
  } finally {
    await server.close();
  }
});

/**
 * A web root with a real `index.html` in it, which these two tests need and
 * the rest of the file deliberately does without.
 *
 * Every other test here points at `MISSING_WEB_ROOT`, and that is right for
 * them -- they assert on `/api`, and a bundle on disk would only add a way for
 * the fixture to be wrong. These two are the exception because the property
 * under test is *which* of two answers an `/api`-shaped request receives, and
 * with no bundle present both answers are 404 for different reasons. Reverting
 * `targetOf`'s origin check against `MISSING_WEB_ROOT` was measured: the
 * anonymous test failed on its status and the signed-in one passed, because
 * there was no html anywhere for the assertion to catch.
 */
async function bundleRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pickarr-bundle-'));
  await writeFile(join(root, 'index.html'), '<html lang="en"><body>pickarr</body></html>');
  return root;
}

test('a protocol-relative target is refused, never answered with the bundle', async () => {
  const { raw, db } = setup();
  const webRoot = await bundleRoot();
  const { server } = await start(raw, db, moviesOnly, undefined, { webRoot });
  try {
    // `fetch` sends these verbatim -- measured, it does not collapse the
    // doubled slash -- so the server really does see `//api/health`. Resolved
    // against a base, that string is protocol-relative: its first segment is
    // read as the authority, leaving pathname `/health`, which is not an api
    // path. Before `targetOf` compared origins, the open static route answered
    // every one of these with the bundle at 200.
    const answers = await getAll(server, ['//api/health', '//api/media', '/.//api/media'], null);
    for (const answer of answers) {
      assert.equal(answer.status, 401, `${answer.path} is refused for want of a session`);
      assert.ok(!answer.text.includes('<html'), `${answer.path} must not answer the bundle`);
    }
  } finally {
    // Every test in this file closes its own listener in a `finally`, and all
    // 24 of them did before this one. A live listener keeps the event loop
    // open, so skipping it does not fail the test -- it hangs the file with no
    // test name attached, which is the hazard `CLAUDE.md` records.
    await server.close();
    await rm(webRoot, { recursive: true, force: true });
  }
});

test('a signed-in protocol-relative target is an unknown route, not the bundle', async () => {
  const { raw, db } = setup();
  const webRoot = await bundleRoot();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, { webRoot });
  try {
    // With the session supplied, the refusal above is out of the way and what
    // is left is the route lookup: a null target has no pathname to match, so
    // it is unknown rather than open. This is the half that proves the 401
    // above is a guard rather than the only thing standing between a
    // protocol-relative path and the bundle.
    const answers = await getAll(server, ['//api/health', '//api/media'], cookie);
    for (const answer of answers) {
      assert.equal(answer.status, 404, `${answer.path} matches no route`);
      assert.ok(!answer.text.includes('<html'), `${answer.path} must not answer the bundle`);
    }
  } finally {
    await server.close();
    await rm(webRoot, { recursive: true, force: true });
  }
});

/**
 * A well-shaped `PUT /api/destinations/:pluginId` body.
 *
 * `unmatchedDir` is **absent by default**, because that is the ordinary
 * request: design spec §6 gives the column a default and a settings screen
 * that never touched the field sends nothing. A test that wants the field
 * passes it.
 *
 * Nothing here is a value any rule would refuse -- an absolute root, a shape
 * whose tokens the plugin declares -- because every value-level invariant is
 * the host's (`media/destinations.ts`) and a route-level check on any of
 * them would be caught by every test in this group rather than by one.
 */
function validDestinationBody(
  overrides: Partial<{ root: string; shape: string; unmatchedDir: string }> = {},
): Record<string, unknown> {
  return { root: '/library/tv', shape: '{series}/{series} - S{season}E{episode}.{ext}', ...overrides };
}

test('a well-shaped destination body is written and answered 200 with the row id', async () => {
  const { raw, db } = setup();
  const seen: { pluginId: string; input: unknown }[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    saveDestination: async (pluginId, input) => {
      seen.push({ pluginId, input });
      return { id: 12 };
    },
  });
  try {
    const answer = await send(server, 'PUT', '/api/destinations/tv', cookie, validDestinationBody());

    assert.equal(answer.status, 200, 'an upsert creates nothing addressable of its own, so it is not a 201');
    assert.deepEqual(JSON.parse(answer.text), { id: 12 });
    assert.deepEqual(seen, [{
      pluginId: 'tv',
      input: {
        root: '/library/tv',
        shape: '{series}/{series} - S{season}E{episode}.{ext}',
        unmatchedDir: undefined,
      },
    }], 'the plugin comes off the path, the two strings off the body, and an absent unmatchedDir arrives as undefined');
  } finally {
    await server.close();
  }
});

test('an unmatched directory in the body reaches the host verbatim', async () => {
  // The route neither applies the default nor normalises the value: design
  // spec §6 makes it a literal directory name and `media/destinations.ts`
  // owns both the default and the three rules, per the module doc's rule
  // that no business rule belongs in `api/server.ts`.
  const { raw, db } = setup();
  const seen: unknown[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    saveDestination: async (_pluginId, input) => {
      seen.push(input);
      return { id: 1 };
    },
  });
  try {
    await send(server, 'PUT', '/api/destinations/tv', cookie, validDestinationBody({ unmatchedDir: '_pickarr/odds' }));
    assert.deepEqual(seen, [{
      root: '/library/tv',
      shape: '{series}/{series} - S{season}E{episode}.{ext}',
      unmatchedDir: '_pickarr/odds',
    }]);
  } finally {
    await server.close();
  }
});

test('a destination body missing a field, or carrying the wrong type, is invalid-shape', async () => {
  // Including `unmatchedDir: null`, which is the case the optional field
  // creates: absent means "use the default" and a `null` means nothing at
  // all, so it is refused rather than silently read as absent.
  const { raw, db } = setup();
  let reached = 0;
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    saveDestination: async () => {
      reached += 1;
      return { id: 1 };
    },
  });
  try {
    const bodies: unknown[] = [
      {},
      { root: '/library' },
      { shape: '{title}.{ext}' },
      { root: 7, shape: '{title}.{ext}' },
      { root: '/library', shape: 7 },
      { root: '/library', shape: '{title}.{ext}', unmatchedDir: null },
      { root: '/library', shape: '{title}.{ext}', unmatchedDir: 7 },
      [],
      null,
    ];
    const answers = await Promise.all(bodies.map(async (body, index) => {
      const { status, text } = await send(server, 'PUT', '/api/destinations/tv', cookie, body);
      return { index, status, text };
    }));
    for (const { index, status, text } of answers) {
      assert.equal(status, 400, `body ${String(index)} is refused`);
      assert.deepEqual(JSON.parse(text), { refusal: 'invalid-shape' }, `body ${String(index)}`);
    }
    assert.equal(reached, 0, 'and none of them reached the host');
  } finally {
    await server.close();
  }
});

test('a :pluginId that could not be a plugin id is an unknown route, and never reaches the host', async () => {
  // `mappingIdFrom`'s reasoning, for a string segment rather than an
  // integer one: `unknown-plugin` claims "this is a well-formed plugin id
  // and nothing registered it", which is a statement the host cannot make
  // about `Tv%20Shows`. Refused here, the caller gets the same 404 a path
  // naming no route gets -- so a segment that could never name a plugin
  // reads as a bad request target rather than as a missing plugin, and no
  // unvalidated segment reaches a prepared statement.
  const { raw, db } = setup();
  let reached = 0;
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    saveDestination: async () => {
      reached += 1;
      return { id: 1 };
    },
  });
  try {
    const segments = ['TV', 'tv-shows', '1', '_tv', 'tv.shows', 'a'.repeat(33), '%20'];
    const answers = await Promise.all(segments.map(async (segment) => {
      const { status, text } = await send(
        server, 'PUT', `/api/destinations/${segment}`, cookie, validDestinationBody(),
      );
      return { segment, status, text };
    }));
    for (const { segment, status, text } of answers) {
      assert.equal(status, 404, `${segment} names no route`);
      assert.deepEqual(JSON.parse(text), { error: 'unknown route' }, segment);
    }
    assert.equal(reached, 0, 'and none of them reached the host');
  } finally {
    await server.close();
  }
});

test('every shipped plugin id is addressable on this route', async () => {
  // The other half of the segment check, and the half that would otherwise
  // be a claim: a validator narrower than the ids the host actually
  // registers would make a real plugin's destination unreachable, with the
  // caller told only "unknown route". Driven through the route against the
  // ids `main` builds rather than asserted against the pattern.
  const { raw, db } = setup();
  const seen: string[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    saveDestination: async (pluginId) => {
      seen.push(pluginId);
      return { id: 1 };
    },
  });
  try {
    const ids = shippedPlugins({
      now: () => 1_700_000_000_000,
      resolveSecret: async () => { throw new Error('resolveSecret: not used by this test'); },
      baseUrl: 'https://lookup.example.test',
    }).map((plugin) => plugin.id);
    assert.ok(ids.length >= 3, 'three plugins ship, and each must be addressable');

    for (const id of ids) {
      // Sequential rather than `Promise.all`: `seen` is asserted in order
      // below, and one server is enough for a check that writes nothing.
      // eslint-disable-next-line no-await-in-loop -- three requests, and the order is the assertion
      const answer = await send(server, 'PUT', `/api/destinations/${id}`, cookie, validDestinationBody());
      assert.equal(answer.status, 200, `${id} must reach the host`);
    }
    assert.deepEqual(seen, ids, 'each id arrives at the host exactly as it was registered');
  } finally {
    await server.close();
  }
});

test('every destination refusal answers its own status', async () => {
  // All nine of `DESTINATION_REFUSALS`, not a sample -- the feeds slice
  // shipped two of its four unpinned, so its status mapper could have
  // dropped a `case` and fallen through with every test still green.
  const cases = DESTINATION_REFUSALS.map((refusal): [DestinationRefusalCode, number] => (
    [refusal, refusal === 'unknown-plugin' ? 404 : 422]
  ));
  // The split is a real one rather than nine rows of the same number: a
  // mapper answering 422 for everything would satisfy every per-case
  // assertion below if the table said 422 nine times.
  assert.equal(new Set(cases.map(([, status]) => status)).size, 2, 'the table distinguishes two statuses');

  // A fresh `setup()` per case, run concurrently rather than in a loop with
  // an `await` in it: an install gets exactly one account, so a second
  // sign-up against one database would be refused for a reason that has
  // nothing to do with this property.
  await Promise.all(cases.map(async ([refusal, status]) => {
    const { raw, db } = setup();
    const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
      saveDestination: async () => ({ refusal, token: null }),
    });
    try {
      const answer = await send(server, 'PUT', '/api/destinations/tv', cookie, validDestinationBody());
      assert.equal(answer.status, status, `${refusal} answers ${String(status)}`);
      assert.deepEqual(
        JSON.parse(answer.text),
        { refusal, token: null },
        'the body is that one stable code, and a token field that is null unless there is a token',
      );
      assert.ok(
        !answer.text.includes('/library'),
        'a refusal body carries no path, not even the one it was just handed',
      );
    } finally {
      await server.close();
    }
  }));
});

test('an unknown token is named in the body, and only when it is a name this host repeats', async () => {
  // Design spec §3's "naming it", over the wire. The host decides whether
  // a name may be repeated (`media/destinations.ts`'s `ECHOABLE_TOKEN`);
  // this route serialises whatever it decided, so both legs are driven
  // through a stub that answers each.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    saveDestination: async (_pluginId, input) => (
      input.shape.includes('seasn')
        ? { refusal: 'unknown-token', token: 'seasn' }
        : { refusal: 'unknown-token', token: null }
    ),
  });
  try {
    const named = await send(
      server, 'PUT', '/api/destinations/movie', cookie, validDestinationBody({ shape: '{seasn}.{ext}' }),
    );
    assert.equal(named.status, 422);
    assert.deepEqual(
      JSON.parse(named.text),
      { refusal: 'unknown-token', token: 'seasn' },
      'the code and the token, and nothing else -- not the shape, not the root',
    );

    const unnamed = await send(
      server, 'PUT', '/api/destinations/movie', cookie, validDestinationBody({ shape: '{x?apikey=k}.{ext}' }),
    );
    assert.equal(unnamed.status, 422);
    assert.deepEqual(
      JSON.parse(unnamed.text),
      { refusal: 'unknown-token', token: null },
      'a name the host would not repeat still refuses, and the field is present and null',
    );
    assert.ok(!unnamed.text.includes('apikey'), 'and nothing of it reaches the body');
  } finally {
    await server.close();
  }
});

test('a destination route throw is a 500 that names no path', async () => {
  // The rule every write route here follows: anything the host does not
  // recognise as a refusal is an infrastructure fault, and neither the
  // response nor the log may carry the root that was submitted.
  const { raw, db } = setup();
  const { server, cookie, logs } = await startSignedIn(raw, db, moviesOnly, {
    saveDestination: () => {
      throw new Error('the destination upsert returned no id');
    },
  });
  try {
    const answer = await send(server, 'PUT', '/api/destinations/tv', cookie, validDestinationBody());
    assert.equal(answer.status, 500);
    assert.ok(!answer.text.includes('/library'), 'the 500 body carries no path');
    for (const line of logs) {
      assert.ok(!JSON.stringify(line).includes('/library'), 'and neither does the log line');
    }
  } finally {
    await server.close();
  }
});
