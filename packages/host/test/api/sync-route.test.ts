/**
 * `/api/sync` and `/api/sync/backfill`, over a real socket -- the guard, the
 * cursor parsing `sync-route.ts` owns, and the shape of a real page from
 * each. `sync/tail.test.ts` and `sync/backfill.test.ts` already cover the
 * ops themselves in depth; what belongs here is what only the route adds on
 * top of those functions: the session guard, and turning a malformed query
 * parameter into a `400` rather than a silent resync.
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

test('both sync routes require a session', async () => {
  const { raw, db } = setup();
  const registry = createSyncRegistry(raw, []);
  const { server } = await start(raw, db, registry);
  try {
    const tail = await get(server, '/api/sync?since=0', ANONYMOUS);
    assert.equal(tail.status, 401, '/api/sync must refuse a caller with no session');

    const backfill = await get(server, '/api/sync/backfill', ANONYMOUS);
    assert.equal(backfill.status, 401, '/api/sync/backfill must refuse a caller with no session');
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

test('the backfill answers a page, a cursor and a watermark', async () => {
  const { raw, db } = setup();
  // Distinct `created_at` values, ascending by insertion, so "newest first"
  // has an unambiguous answer: the last one seeded must come back first.
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
    assert.deepEqual(ids, [third, second, first], 'newest media item first, oldest last');

    // Every op carries its key, host or plugin -- `sync/tail.ts`'s `SyncOp`
    // says why the key is the op's and not the payload's.
    assert.deepEqual(mediaItemOps.map((op) => op.id), [third, second, first],
      'the op-level id must be the row id, on an upsert as much as on a delete');

    // Every backfill op is a `create`, which is what a client is allowed to
    // drop for a row it already holds (design spec §5.3).
    assert.deepEqual([...new Set(mediaItemOps.map((op) => op.op))], ['create'],
      'the walk emits creates; only the tail emits an upsert that overwrites');

    assert.equal(body.cursor, null, 'three rows on one page exhausts current state');
    assert.equal(typeof body.watermark, 'number', 'the watermark is where the client starts its tail');
    // And no second log position. `asOf` was a real field on this body for
    // one commit, with an apply rule attached; §5.3 replaced both with the
    // op kind, and a field left on the wire is a field slice 2 reads.
    assert.deepEqual(Object.keys(body).toSorted(), ['cursor', 'ops', 'watermark'],
      'the backfill body is exactly ops, cursor and watermark -- no asOf, no other dated position');
  } finally {
    await server.close();
  }
});

test('a backfill cursor round-trips, carrying the watermark the walk is measured against', async () => {
  const { raw, db } = setup();
  // One more than `PAGE_SIZE`, which is what it takes to get a non-null
  // cursor out of this route -- the page size is fixed and not a query
  // parameter. The oldest item is the one left for page two.
  const oldest = seedMediaItem(raw, 1, 'Oldest');
  for (let index = 0; index < PAGE_SIZE; index += 1) seedMediaItem(raw, 1000 + index, `Item ${String(index)}`);

  const registry = createSyncRegistry(raw, []);
  const { server, cookie } = await startSignedIn(raw, db, registry);
  try {
    const firstResponse = await get(server, '/api/sync/backfill', cookie);
    const first: unknown = JSON.parse(await firstResponse.text());
    if (!isRecord(first) || typeof first.cursor !== 'string') {
      throw new Error('a page that does not exhaust current state must answer a string cursor');
    }
    // `<createdAt>.<id>.<watermark>` -- three parts, the third being the
    // watermark, so a client cannot resume a walk without the number that
    // keeps the two streams from overlapping.
    const parts = first.cursor.split('.');
    assert.equal(parts.length, 3, `a backfill cursor has three parts, got ${String(parts.length)}`);
    assert.equal(Number(parts[2]), first.watermark, "the third part is the walk's watermark");

    const nextResponse = await get(server, `/api/sync/backfill?before=${first.cursor}`, cookie);
    assert.equal(nextResponse.status, 200);
    const next: unknown = JSON.parse(await nextResponse.text());
    if (!isRecord(next) || !Array.isArray(next.ops)) throw new Error('the next page must answer ops');
    assert.equal(next.watermark, first.watermark, 'the walk carries its watermark forward, never re-reads it');
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

    // `'1000.5'` is the *old* two-part form: it must be refused rather than
    // read as a walk with no watermark, which would silently put the two
    // streams back in overlap. `'1.2.3.4'` is one part too many.
    const cases = ['abc', '1000', '1000.', '.5', '1000.-5', '1000.5', '1.2.3.4', '1000.5.'];
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
