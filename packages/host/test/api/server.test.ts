import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ensureClaimToken } from '../../src/auth/claim.ts';
import { createAuth } from '../../src/auth/instance.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import type { HostDb } from '../../src/db/open.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { PAGE_SIZE, encodeCursor, encodeUnionCursor } from '../../src/api/cursor.ts';
import type { ReadServer } from '../../src/api/server.ts';
import { API_VERSION, DEFAULT_HOST, DEFAULT_PORT, ROUTES, createReadServer } from '../../src/api/server.ts';

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
): Promise<Running> {
  const logs: LogLine[] = [];
  const server = await createReadServer({
    raw,
    pluginIdForType,
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
      log: dropLine,
    }),
    log: (message, detail) => {
      logs.push({ message, detail });
    },
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
 */
async function startSignedIn(
  raw: DatabaseSync,
  db: HostDb,
  pluginIdForType: (type: string) => string | undefined,
): Promise<SignedIn> {
  const running = await start(raw, db, pluginIdForType);
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

function seedMediaItem(raw: DatabaseSync, pluginId: string, updatedAt: number, title: string): number {
  const info = raw.prepare(
    'INSERT INTO media_item (plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?)',
  ).run(pluginId, updatedAt, updatedAt, title);
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
      (feed_id, filename, link, created_at, updated_at, download_type, media_item_id, resolution, resolution_detail, guid)
    VALUES (?, ?, ?, ?, ?, 'torrent', NULL, '1080p', 'x264', ?)
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
      error: 'https://sab.test/api?apikey=***&mode=queue&file=/media/movies/Recognisable.mkv',
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
  assert.equal(DEFAULT_PORT, 8787, 'the documented default port, which no test in this file binds');
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
        resolution: '1080p',
        resolutionDetail: 'x264',
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
  const rssItemId = seedRssItem(raw, feedId, 100, 'Paged.Movie.1080p.mkv');
  const clientId = seedClient(raw, 'paging');

  // Interleaved by `updated_at`, one transport either side of every step, so
  // the page boundary falls between two rows from *different* tables -- which
  // is the boundary a cursor that forgot its transport gets wrong. Every
  // `updated_at` is distinct, so the expected order is fixed by time alone.
  const expected: string[] = [];
  for (let index = 1; index <= 100; index += 1) {
    expected.push(`torrent#${seedTorrentDownload(raw, rssItemId, clientId, 1000 + 2 * index, `ref-t${index}`)}`);
    expected.push(`nzb#${seedNzbDownload(raw, rssItemId, clientId, 1001 + 2 * index, `ref-n${index}`)}`);
  }
  // The one row past the page boundary, newer than all 200 before it.
  expected.push(`torrent#${seedTorrentDownload(raw, rssItemId, clientId, 1000 + 2 * 101, 'ref-t101')}`);
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

test('anything but a read is refused, whether or not the caller has a session', async () => {
  // The whole API is read-only, so a write method is refused by the method
  // rather than routed as though it were a GET -- which is what a router that
  // only looked at the path would do, answering a POST with a page of data.
  //
  // **The method check sits ahead of the guard, and it is the *guarded* path
  // with no session that pins that.** It costs nothing to put it there: every
  // non-GET answers the same 405 on every path with or without a session, so
  // the ordering tells an anonymous caller nothing beyond "the API is
  // read-only". The four combinations are all needed, and the one that does
  // the work is a guarded path anonymously: an open path answers 405 whatever
  // the order, so a version probing only `/api/health` could not tell the two
  // orderings apart -- measured, by moving the guard in front and watching
  // 23/23 pass.
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const probes = ['POST', 'PUT', 'DELETE', 'PATCH'].flatMap((method) => (
      ['/api/health', '/api/media?type=movie'].flatMap((path) => [
        { method, path, cookie, session: 'a session' },
        { method, path, cookie: ANONYMOUS, session: 'no session' },
      ])
    ));
    const answers = await Promise.all(probes.map(async (probe) => {
      const response = await fetch(`${originOf(server)}${probe.path}`, {
        method: probe.method,
        headers: probe.cookie === null ? {} : { cookie: probe.cookie },
      });
      // Named out rather than spread: `no-map-spread` is a warning in this
      // repo and the three fields are the three this loop asserts over.
      return {
        method: probe.method,
        path: probe.path,
        session: probe.session,
        status: response.status,
        text: await response.text(),
      };
    }));
    for (const { method, path, session, status, text } of answers) {
      assert.equal(status, 405, `${method} ${path} with ${session} is not a read`);
      assert.deepEqual(JSON.parse(text), { error: 'method not allowed' });
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
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const guarded = ROUTES.filter((route) => !route.open);
    // Both halves of the table's shape, because the filter above is what a
    // route wrongly marked open would slip through: flipping one `open` would
    // otherwise *remove* that route from this test rather than fail it.
    assert.equal(guarded.length, ROUTES.length - 2, 'exactly two routes in the table are open');
    assert.ok(guarded.length >= 5, 'and the table is the real one, not a list this test passed over');

    const refused = await getAll(server, guarded.map(probeFor), ANONYMOUS);
    for (const { path, status, text } of refused) {
      assert.equal(status, 401, `${path} must refuse a caller with no session`);
      assert.deepEqual(JSON.parse(text), { error: 'unauthorized' }, `${path} refuses with the fixed body`);
    }

    // And the same enumeration with a session: nothing here is 401, so the
    // loop above is not passing merely because the guard refuses everyone.
    const allowed = await getAll(server, guarded.map(probeFor), cookie);
    for (const { path, status } of allowed) {
      assert.notEqual(status, 401, `${path} must be reachable by a session holder`);
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

    const answers = await getAll(server, ROUTES.map(probeFor), ANONYMOUS);
    for (const { path, status } of answers) {
      if (openPaths.includes(path)) {
        assert.notEqual(status, 401, `${path} must answer without a session`);
      } else {
        assert.equal(status, 401, `${path} must refuse a caller with no session`);
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
