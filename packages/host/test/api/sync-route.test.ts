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
import type { HostDb } from '../../src/db/open.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import type { SyncRegistry } from '../../src/sync/registry.ts';
import type { ReadServer } from '../../src/api/server.ts';
import { createReadServer } from '../../src/api/server.ts';
import { PAGE_SIZE } from '../../src/api/cursor.ts';
import { BOOTSTRAP_ITEMS } from '../../src/sync/bootstrap.ts';

/** Obviously synthetic, and not a real secret -- see `server.test.ts`'s own doc on these constants. */
const AUTH_SECRET = 'placeholder-not-a-real-signing-secret-for-tests';
const PASSWORD = 'placeholder-not-a-real-password';
const OWNER_EMAIL = 'owner@example.invalid';

/** No cookie at all, which is what an unauthenticated caller sends. */
const ANONYMOUS = null;

/** A `log` that drops every line -- nothing in this file asserts on it. */
const dropLine = (): void => {};

interface Running {
  server: ReadServer;
}

interface SignedIn extends Running {
  cookie: string;
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
  const server = await createReadServer({
    raw,
    pluginIdForType: noType,
    registry,
    host: undefined,
    port: 0,
    authFor: (baseURL) => createAuth({
      raw,
      db,
      secret: AUTH_SECRET,
      baseURL,
      publicUrl: undefined,
      log: dropLine,
    }),
    log: dropLine,
  });
  return { server };
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
    assert.deepEqual(Object.keys(body).toSorted(), ['before', 'since'],
      'exactly the two query parameters the other two routes take, and nothing else');
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
    assert.deepEqual(Object.keys(body).toSorted(), ['cursor', 'ops'],
      'the backfill body is exactly ops and cursor -- no watermark, no asOf, no dated position');
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
    const cases = ['abc', '-1', '1.5', ''];
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
    const cases = ['abc', '1000.', '.5', '-1', '1.5', '1000.5', '1000.5.9', '1e3', ' 5'];
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
