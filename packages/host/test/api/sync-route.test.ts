/**
 * `/api/sync`, `/api/sync/backfill` and `/api/sync/bootstrap`, over a real
 * socket -- the guard, the cursor parsing `sync-route.ts` owns, and the shape
 * of a real answer from each. `sync/tail.test.ts`, `sync/backfill.test.ts`
 * and `sync/bootstrap.test.ts` already cover the ops and the pivot themselves
 * in depth; what belongs here is what only the route adds on top of those
 * functions: the session guard, turning a malformed query parameter into a
 * `400` rather than a silent resync, and the wire names of the two cursors.
 *
 * A self-contained harness, duplicated from `server.test.ts` rather than
 * imported -- that file's own comment on `createFakeTimers` gives the reason
 * this project follows throughout: no file here shares a test-support module
 * with another.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { ensureClaimToken } from '../../src/auth/claim.ts';
import { createAuth } from '../../src/auth/instance.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { ensureSyncGeneration } from '../../src/db/host-state.ts';
import type { HostDb } from '../../src/db/open.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import type { SyncRegistry } from '../../src/sync/registry.ts';
import type { ReadServer } from '../../src/api/server.ts';
import { createReadServer } from '../../src/api/server.ts';
import { PAGE_SIZE } from '../../src/api/cursor.ts';
import { BOOTSTRAP_ITEMS } from '../../src/sync/bootstrap.ts';
import { createSyncEvents } from '../../src/sync/events.ts';

/** Obviously synthetic, and not a real secret -- see `server.test.ts`'s own doc on these constants. */
const AUTH_SECRET = 'placeholder-not-a-real-signing-secret-for-tests';
const PASSWORD = 'placeholder-not-a-real-password';
const OWNER_EMAIL = 'owner@example.invalid';

/** No cookie at all, which is what an unauthenticated caller sends. */
const ANONYMOUS = null;

/** A `log` that drops every line -- nothing in this file asserts on it. */
const dropLine = (): void => {};

/** See `server.test.ts`'s own doc: a web root this file never has to build, because this file's job is sync, not static serving. */
const MISSING_WEB_ROOT = '/nonexistent/pickarr-web-root-for-sync-route-test';

interface Running {
  server: ReadServer;
  /**
   * The generation the server was started with -- minted from `raw` the way
   * `main` does, rather than a literal, so a route returning some *other*
   * `host_state` value would still be caught. See
   * `db/host-state.ts`'s `ensureSyncGeneration`.
   */
  generation: string;
}

interface SignedIn extends Running {
  cookie: string;
}

/** The `generation` off a body, or a failure naming what was there instead. */
function generationOf(body: unknown, route: string): string {
  if (!isRecord(body)) throw new Error(`${route} must answer an object`);
  const { generation } = body;
  if (typeof generation !== 'string') {
    throw new Error(`${route} answered no string generation, but ${JSON.stringify(generation)}`);
  }
  return generation;
}

function setup(): { raw: DatabaseSync; db: HostDb } {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  return { raw, db };
}

/** No plugin here declares a synced table -- `host.test.ts` covers a real plugin's. */
const noType = (): string | undefined => undefined;

/**
 * Starts a server on port 0, with `registry` behind it. See
 * `server.test.ts`'s `start` for why `port: 0` and why the auth instance is
 * a function of the origin rather than an instance built up front.
 */
async function start(raw: DatabaseSync, db: HostDb, registry: SyncRegistry): Promise<Running> {
  // Resolved once, before the listener, exactly as `main` does: the value
  // cannot change while this process holds the database open, so a
  // per-request read would be a query per sync request for a constant.
  const generation = ensureSyncGeneration(raw, 1_000);
  const server = await createReadServer({
    raw,
    pluginIdForType: noType,
    // Never called: this file's routes are the three sync ones, and none of
    // them reaches `/api/feeds`, `/api/download-clients`, `/api/picks` or
    // either `/api/mappings` route -- every stub gives the same "not
    // stubbed" failure the shape rather than silently succeeding, as
    // `server.test.ts`'s own do.
    addFeed: () => {
      throw new Error('addFeed not stubbed in this test');
    },
    retryLookup: () => {
      throw new Error('retryLookup not stubbed in this test');
    },
    identifyRelease: () => {
      throw new Error('identifyRelease not stubbed in this test');
    },
    requestPick: () => {
      throw new Error('requestPick not stubbed in this test');
    },
    addDownloadClient: () => {
      throw new Error('addDownloadClient not stubbed in this test');
    },
    addMapping: () => {
      throw new Error('addMapping not stubbed in this test');
    },
    editMapping: () => {
      throw new Error('editMapping not stubbed in this test');
    },
    removeFeed: () => {
      throw new Error('removeFeed not stubbed in this test');
    },
    setFeedDisabled: () => {
      throw new Error('setFeedDisabled not stubbed in this test');
    },
    removeMapping: () => {
      throw new Error('removeMapping not stubbed in this test');
    },
    saveDestination: () => {
      throw new Error('saveDestination not stubbed in this test');
    },
    registry,
    generation,
    // This file's own route is `/api/sync` and its siblings, never
    // `/api/sync/events` -- a quiet hub answers the guard the same way a
    // real one would, with no timer and no write path exercising it.
    events: createSyncEvents({
      raw,
      generation,
      timers: { setInterval: () => 0, clearInterval: () => {} },
      defer: (fn) => { setImmediate(fn); },
    }),
    // Nor `/api/activity`: an empty queue answers the guard the same way.
    fetchSnapshot: () => [],
    host: undefined,
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
    log: dropLine,
  });
  return { server, generation };
}

function originOf(server: ReadServer): string {
  return `http://${server.host}:${server.port}`;
}

function cookieHeader(response: Response): string {
  const pairs = response.headers.getSetCookie().map((value) => {
    const [pair] = value.split(';');
    if (pair === undefined) throw new Error('a Set-Cookie header with no name=value pair');
    return pair;
  });
  if (pairs.length === 0) throw new Error('the response set no cookie to send back');
  return pairs.join('; ');
}

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

async function startSignedIn(raw: DatabaseSync, db: HostDb, registry: SyncRegistry): Promise<SignedIn> {
  const running = await start(raw, db, registry);
  try {
    return { ...running, cookie: await signUpOwner(running.server, raw) };
  } catch (error) {
    await running.server.close();
    throw error;
  }
}

async function get(server: ReadServer, path: string, cookie: string | null): Promise<Response> {
  return fetch(`${originOf(server)}${path}`, cookie === null ? {} : { headers: { cookie } });
}

function seedMediaItem(raw: DatabaseSync, createdAt: number, title: string): number {
  const info = raw.prepare(
    'INSERT INTO media_item (plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?)',
  ).run('alpha', createdAt, createdAt, title);
  return Number(info.lastInsertRowid);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

test('all three sync routes require a session', async () => {
  const { raw, db } = setup();
  const registry = createSyncRegistry(raw, []);
  const { server } = await start(raw, db, registry);
  try {
    const tail = await get(server, '/api/sync?since=0', ANONYMOUS);
    assert.equal(tail.status, 401, '/api/sync must refuse a caller with no session');

    const backfill = await get(server, '/api/sync/backfill', ANONYMOUS);
    assert.equal(backfill.status, 401, '/api/sync/backfill must refuse a caller with no session');

    const bootstrap = await get(server, '/api/sync/bootstrap', ANONYMOUS);
    assert.equal(bootstrap.status, 401, '/api/sync/bootstrap must refuse a caller with no session');
  } finally {
    await server.close();
  }
});

test('the bootstrap answers one cursor per stream, and they drive the two routes', async () => {
  // The route's own job, on top of `sync/bootstrap.ts`: the body's two fields
  // are named for the query parameters they go into, so a client pastes them
  // straight back rather than working out which is which.
  const { raw, db } = setup();
  // More than `BOOTSTRAP_ITEMS`, which is what it takes for the pivot to land
  // anywhere but the oldest item: with fewer, every category falls back to its
  // oldest and the walk has nothing below the pivot at all -- correct, and it
  // would make the last two assertions here vacuous.
  for (let index = 0; index <= BOOTSTRAP_ITEMS + 4; index += 1) {
    seedMediaItem(raw, 1000 + index, `Item ${String(index)}`);
  }
  const registry = createSyncRegistry(raw, []);
  const { server, cookie } = await startSignedIn(raw, db, registry);
  try {
    const response = await get(server, '/api/sync/bootstrap', cookie);
    assert.equal(response.status, 200);
    const body: unknown = JSON.parse(await response.text());
    if (!isRecord(body)) throw new Error('the bootstrap must answer an object');
    assert.deepEqual(Object.keys(body).toSorted(), ['before', 'generation', 'since'],
      'the two query parameters the other two routes take, plus the generation, and nothing else');
    if (typeof body.since !== 'number' || typeof body.before !== 'number') {
      throw new Error('both cursors must be numbers');
    }
    assert.equal(body.since, body.before - 1, 'the pair must meet at the pivot');

    // And both really are accepted by the routes they name, which is the one
    // thing a body of two bare integers could still get wrong.
    const tail = await get(server, `/api/sync?since=${String(body.since)}`, cookie);
    assert.equal(tail.status, 200, 'the `since` it answered must be a cursor the tail accepts');
    const walk = await get(server, `/api/sync/backfill?before=${String(body.before)}`, cookie);
    assert.equal(walk.status, 200, 'and the `before` one the backfill accepts');

    const tailBody: unknown = JSON.parse(await tail.text());
    const walkBody: unknown = JSON.parse(await walk.text());
    if (!isRecord(tailBody) || !Array.isArray(tailBody.ops)) throw new Error('the tail must answer ops');
    if (!isRecord(walkBody) || !Array.isArray(walkBody.ops)) throw new Error('the walk must answer ops');
    assert.ok(tailBody.ops.length > 0, 'the tail is productive from its first request');
    assert.ok(walkBody.ops.length > 0, 'and so is the walk');
  } finally {
    await server.close();
  }
});

test('the tail answers ops and a cursor', async () => {
  const { raw, db } = setup();
  const mediaItemId = seedMediaItem(raw, 1000, 'A Movie');
  const registry = createSyncRegistry(raw, []);
  const { server, cookie } = await startSignedIn(raw, db, registry);
  try {
    const response = await get(server, '/api/sync?since=0', cookie);
    assert.equal(response.status, 200);
    const body: unknown = JSON.parse(await response.text());
    if (!isRecord(body) || !Array.isArray(body.ops)) throw new Error('the tail must answer an ops array');
    assert.equal(body.ops.length, 1, 'the one seeded row must arrive as exactly one op');
    const [op] = body.ops;
    if (!isRecord(op)) throw new Error('an op must be an object');
    assert.equal(op.op, 'upsert');
    assert.equal(op.table, 'media_item');
    if (!isRecord(op.value) || op.value.id !== mediaItemId) {
      throw new Error('the upsert must carry the seeded row');
    }
    assert.equal(typeof body.cursor, 'number', 'the cursor must be the log entry id, not an opaque string');
    assert.ok((body.cursor as number) > 0);
  } finally {
    await server.close();
  }
});

test('the backfill answers a page and a cursor, and no log position of its own', async () => {
  const { raw, db } = setup();
  // Inserted in order, so "newest log entry first" has an unambiguous answer:
  // the last one seeded must come back first.
  const first = seedMediaItem(raw, 1000, 'Oldest');
  const second = seedMediaItem(raw, 2000, 'Middle');
  const third = seedMediaItem(raw, 3000, 'Newest');
  const registry = createSyncRegistry(raw, []);
  const { server, cookie } = await startSignedIn(raw, db, registry);
  try {
    const response = await get(server, '/api/sync/backfill', cookie);
    assert.equal(response.status, 200);
    const body: unknown = JSON.parse(await response.text());
    if (!isRecord(body) || !Array.isArray(body.ops)) throw new Error('the backfill must answer an ops array');

    const mediaItemOps = body.ops.filter(
      (op): op is Record<string, unknown> => isRecord(op) && op.table === 'media_item',
    );
    const ids = mediaItemOps.map((op) => (isRecord(op.value) ? op.value.id : undefined));
    assert.deepEqual(ids, [third, second, first], 'newest log entry first, oldest last');

    // Every op carries its key, host or plugin -- `sync/tail.ts`'s `SyncOp`
    // says why the key is the op's and not the payload's.
    assert.deepEqual(mediaItemOps.map((op) => op.id), [third, second, first],
      'the op-level id must be the row id, on an upsert as much as on a delete');

    // Every backfill op is a `create`, which is what a client is allowed to
    // drop for a row it already holds (design spec §5.3).
    assert.deepEqual([...new Set(mediaItemOps.map((op) => op.op))], ['create'],
      'the walk emits creates; only the tail emits an upsert that overwrites');

    assert.equal(body.cursor, null, 'three rows on one page exhausts the log below the start');
    // No `watermark` and no `asOf`. Both were real fields on this body, each
    // for its own reason and each replaced: the watermark by
    // `/api/sync/bootstrap`, which answers both cursors before either is
    // called, and `asOf` by the op kind (§5.3). A field left on the wire is a
    // field slice 2 reads.
    assert.deepEqual(Object.keys(body).toSorted(), ['cursor', 'generation', 'ops'],
      'the backfill body is ops, cursor and the generation -- no watermark, no asOf, no dated position');
  } finally {
    await server.close();
  }
});

test('a backfill cursor round-trips as a bare log position', async () => {
  const { raw, db } = setup();
  // One more than `PAGE_SIZE`, which is what it takes to get a non-null
  // cursor out of this route -- the page size is fixed and not a query
  // parameter. The first item seeded is the one left for page two.
  const oldest = seedMediaItem(raw, 1, 'Oldest');
  for (let index = 0; index < PAGE_SIZE; index += 1) seedMediaItem(raw, 1000 + index, `Item ${String(index)}`);

  const registry = createSyncRegistry(raw, []);
  const { server, cookie } = await startSignedIn(raw, db, registry);
  try {
    const firstResponse = await get(server, '/api/sync/backfill', cookie);
    const first: unknown = JSON.parse(await firstResponse.text());
    if (!isRecord(first) || typeof first.cursor !== 'number') {
      throw new Error('a page that does not exhaust the log must answer a numeric cursor');
    }
    // A `sync_log.id`, the same kind of value `since` is on the tail -- which
    // is what makes the two cursors comparable and lets one endpoint hand out
    // both. It used to be `<createdAt>.<id>.<watermark>`, three numbers in one
    // token so the watermark could not be dropped; there is no watermark now.
    assert.ok(first.cursor > 0, 'the cursor is a log id, not an opaque string');

    const nextResponse = await get(server, `/api/sync/backfill?before=${String(first.cursor)}`, cookie);
    assert.equal(nextResponse.status, 200);
    const next: unknown = JSON.parse(await nextResponse.text());
    if (!isRecord(next) || !Array.isArray(next.ops)) throw new Error('the next page must answer ops');
    const seen = next.ops
      .filter((op): op is Record<string, unknown> => isRecord(op) && op.table === 'media_item')
      .map((op) => op.id);
    assert.deepEqual(seen, [oldest], 'resuming from the cursor skips nothing and repeats nothing');
  } finally {
    await server.close();
  }
});

test('a malformed cursor is refused rather than treated as zero', async () => {
  const { raw, db } = setup();
  seedMediaItem(raw, 1000, 'A Movie');
  const registry = createSyncRegistry(raw, []);
  const { server, cookie } = await startSignedIn(raw, db, registry);
  try {
    // Concurrent, then a plain loop of assertions with no `await` in it --
    // these four requests share nothing and none decides the next, so there
    // is no sequence for a loop to preserve. See `server.test.ts`'s
    // `getAll` for the same shape.
    // The last two are finding 10: `/^\d+$/` accepted a 22-digit `since`,
    // `tailSince` returned it unchanged for an empty page, and
    // `JSON.stringify` wrote it as `1e+21` -- which this same route then
    // refused, so a client echoing its own cursor back was stuck forever. The
    // 16-digit case is the quieter half: above `Number.MAX_SAFE_INTEGER`
    // (9007199254740991) the value is bound to `node:sqlite` with silent
    // precision loss instead.
    const cases = ['abc', '-1', '1.5', '', '1000000000000000000000', '9007199254740993'];
    const responses = await Promise.all(cases.map(async (since) => {
      const response = await get(server, `/api/sync?since=${since}`, cookie);
      return { since, status: response.status, body: await response.text() };
    }));
    for (const { since, status, body } of responses) {
      assert.equal(status, 400, `since=${JSON.stringify(since)} must be refused, never silently read as 0`);
      const parsed: unknown = JSON.parse(body);
      if (!isRecord(parsed) || typeof parsed.error !== 'string') {
        throw new Error('a 400 must carry an error message');
      }
    }
  } finally {
    await server.close();
  }
});

test('a supplied but malformed backfill cursor is refused, though an absent one is the first page', async () => {
  const { raw, db } = setup();
  seedMediaItem(raw, 1000, 'A Movie');
  const registry = createSyncRegistry(raw, []);
  const { server, cookie } = await startSignedIn(raw, db, registry);
  try {
    const noCursor = await get(server, '/api/sync/backfill', cookie);
    assert.equal(noCursor.status, 200, 'no cursor at all means the first page, not an error');

    // `'1000.5'` and `'1000.5.9'` are the *old* keyset forms, two and three
    // parts; a client that kept one across an upgrade is refused rather than
    // having its first component read as a log id, which would silently
    // restart its walk from an arbitrary place. `'1.5'` is a decimal, `'-1'`
    // a sign: `before` is a `sync_log.id`, and nothing else is one.
    const cases = ['abc', '1000.', '.5', '-1', '1.5', '1000.5', '1000.5.9', '1e3', ' 5',
      '1000000000000000000000', '9007199254740993'];
    const responses = await Promise.all(cases.map(async (before) => {
      const response = await get(server, `/api/sync/backfill?before=${before}`, cookie);
      return { before, status: response.status };
    }));
    for (const { before, status } of responses) {
      assert.equal(status, 400, `before=${JSON.stringify(before)} must be refused`);
    }
  } finally {
    await server.close();
  }
});

test('every cursor this route emits is one it accepts back', async () => {
  // The property finding 10 broke, asserted as a round trip rather than as a
  // list of refused strings: a client's whole protocol is echoing the cursor
  // it was handed. The largest `since` the route accepts is taken through
  // `JSON.stringify` -- which is what actually writes the wire body -- and
  // fed back in.
  const { raw, db } = setup();
  seedMediaItem(raw, 1000, 'A Movie');
  const registry = createSyncRegistry(raw, []);
  const { server, cookie } = await startSignedIn(raw, db, registry);
  try {
    const largest = '999999999999999';
    const response = await get(server, `/api/sync?since=${largest}`, cookie);
    assert.equal(response.status, 200, 'the largest accepted cursor must be accepted');

    const body: unknown = JSON.parse(await response.text());
    if (!isRecord(body)) throw new Error('the body must be an object');
    assert.equal(JSON.stringify(body.cursor), largest,
      'and must come back as plain digits, not exponential notation');

    const again = await get(server, `/api/sync?since=${JSON.stringify(body.cursor)}`, cookie);
    assert.equal(again.status, 200, 'a client echoing its own cursor back must not be refused');

    // The boundary from the other side, spelled literally so moving the bound
    // moves this test: one digit more is where exactness starts to go, since
    // 1000000000000000 is the first value a 16-digit bound would admit above
    // which `Number.MAX_SAFE_INTEGER` is reachable.
    const tooLong = await get(server, `/api/sync?since=${largest}9`, cookie);
    assert.equal(tooLong.status, 400, 'sixteen digits is past what a cursor may be');
  } finally {
    await server.close();
  }
});

test('all three sync routes carry this database`s generation, and it is the same one', async () => {
  // Without it a client cannot tell a rebuilt database from the one it
  // replicated, and the failure is silent: `pickarr.db` deleted, a client
  // holding `since = 5000` asking for ops above 5000 against a log whose max
  // id is 80, receiving nothing forever, showing the old library with no
  // error. `db/host-state.ts`'s `ensureSyncGeneration` has the mechanism; what
  // this asserts is that it reaches the wire, on every route a client polls,
  // as the value this host actually minted rather than any other string.
  const { raw, db } = setup();
  seedMediaItem(raw, 1000, 'A Movie');
  const registry = createSyncRegistry(raw, []);
  const { server, cookie, generation } = await startSignedIn(raw, db, registry);
  try {
    const [tail, walk, bootstrap] = await Promise.all([
      get(server, '/api/sync?since=0', cookie),
      get(server, '/api/sync/backfill', cookie),
      get(server, '/api/sync/bootstrap', cookie),
    ]);
    const bodies = await Promise.all([tail.text(), walk.text(), bootstrap.text()]);
    const [tailBody, walkBody, bootstrapBody] = bodies.map((text): unknown => JSON.parse(text));

    assert.equal(generationOf(tailBody, '/api/sync'), generation,
      'the tail must report the generation this host minted, not another value');
    assert.equal(generationOf(walkBody, '/api/sync/backfill'), generation,
      'and so must the backfill');
    assert.equal(generationOf(bootstrapBody, '/api/sync/bootstrap'), generation,
      'and so must the bootstrap, which is the one a client reads first');
  } finally {
    await server.close();
  }
});

test('an empty tail page still carries the generation', async () => {
  // The page a client polling a quiet host receives on every request, and the
  // exact case the value exists for: a cursor above a rebuilt log's max id
  // answers no ops at all, so an implementation that attached the generation
  // alongside the ops rather than to the response would leave the one client
  // that needs the signal without it, permanently.
  const { raw, db } = setup();
  const registry = createSyncRegistry(raw, []);
  const { server, cookie, generation } = await startSignedIn(raw, db, registry);
  try {
    const response = await get(server, '/api/sync?since=5000', cookie);
    assert.equal(response.status, 200);
    const body: unknown = JSON.parse(await response.text());
    if (!isRecord(body) || !Array.isArray(body.ops)) throw new Error('the tail must answer an ops array');
    assert.equal(body.ops.length, 0, 'a cursor past the end of the log answers nothing');
    assert.equal(generationOf(body, '/api/sync'), generation,
      'an empty page is the page a stale client gets, so it must still say which database answered');
  } finally {
    await server.close();
  }
});

test('the health route does not carry the generation', async () => {
  // `/api/health` is the one open route (`api/server.ts`'s `ROUTES`), so
  // anything on it is readable without a session. An install fingerprint
  // there lets a scanner tell two hosts apart and spot a rebuild for free,
  // which is a gift for no gain: the client that needs the value has a
  // session by the time it syncs.
  const { raw, db } = setup();
  const registry = createSyncRegistry(raw, []);
  const { server } = await start(raw, db, registry);
  try {
    const response = await get(server, '/api/health', ANONYMOUS);
    assert.equal(response.status, 200, 'health stays open');
    const body: unknown = JSON.parse(await response.text());
    if (!isRecord(body)) throw new Error('health must answer an object');
    assert.ok(!('generation' in body),
      'health is unauthenticated, and an install fingerprint must not be readable without a session');
  } finally {
    await server.close();
  }
});
