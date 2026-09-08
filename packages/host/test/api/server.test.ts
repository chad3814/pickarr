import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { migrateHost } from '../../src/db/migrate.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import { PAGE_SIZE, encodeCursor, encodeUnionCursor } from '../../src/api/cursor.ts';
import type { ReadServer } from '../../src/api/server.ts';
import { API_VERSION, DEFAULT_PORT, createReadServer } from '../../src/api/server.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

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

/**
 * Starts a server on **port 0** -- the kernel picks a free port and
 * `server.port` reads back the one it assigned. No test in this file may name
 * a port: two tests running in the same process at the same time would fight
 * over any number written down, and the failure would look like a bug in
 * whichever of them lost.
 */
async function start(
  raw: DatabaseSync,
  pluginIdForType: (type: string) => string | undefined,
): Promise<Running> {
  const logs: LogLine[] = [];
  const server = await createReadServer({
    raw,
    pluginIdForType,
    port: 0,
    log: (message, detail) => {
      logs.push({ message, detail });
    },
  });
  return { server, logs };
}

/** A GET against the address the listener actually bound, never a written-down one. */
async function get(
  server: ReadServer,
  path: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(`http://${server.host}:${server.port}${path}`, { headers });
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
): Promise<{ path: string; status: number; text: string }[]> {
  return Promise.all(paths.map(async (path) => {
    const response = await get(server, path);
    return { path, status: response.status, text: await response.text() };
  }));
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

async function pageFrom(server: ReadServer, path: string): Promise<ReadPage> {
  const response = await get(server, path);
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
  const raw = setup();
  const { server } = await start(raw, moviesOnly);
  try {
    const response = await get(server, '/api/health');
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
  const raw = setup();
  assert.equal(PAGE_SIZE, 200, 'the literals below are written for a page size of 200');
  for (let id = 1; id <= PAGE_SIZE + 1; id += 1) {
    seedMediaItem(raw, 'alpha', 1000 + id, `Movie ${id}`);
  }
  // Another plugin's row, on the newest timestamp of all: it must appear on
  // neither page. `type=movie` resolves to `alpha` alone.
  seedMediaItem(raw, 'beta', 9999, 'Not alphas');

  const { server } = await start(raw, moviesOnly);
  try {
    const first = await get(server, '/api/media?type=movie');
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

    const second = await get(server, `/api/media?type=movie&since=${encodeURIComponent(firstCursor)}`);
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
  const raw = setup();
  const { server } = await start(raw, moviesOnly);
  try {
    const response = await get(server, '/api/media?type=book');
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
  const raw = setup();
  const { server, logs } = await start(raw, moviesOnly);
  try {
    const answers = await getAll(server, [
      '/api/nope',
      '/',
      '/api/media/1',
      '/api/artwork/poster',
      '/api/artwork/statue/1',
      '/api/artwork/poster/nine',
    ]);
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
  const raw = setup();
  seedMediaItem(raw, 'alpha', 1000, 'Recognisable Fixture Title');

  // A message shaped like everything this must never write into a response:
  // a url, a path, a query string and a credential.
  const secretUrl = 'https://sab.test/api?apikey=SECRET-KEY-9&mode=queue&file=/media/movies/Recognisable.mkv';
  const { server, logs } = await start(raw, (type) => {
    if (type === 'movie') throw new Error(secretUrl);
    return undefined;
  });
  try {
    const response = await get(server, '/api/media?type=movie&since=whatever');
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
  seedMediaItem(broken, 'alpha', 1000, 'Recognisable Fixture Title');
  broken.exec('DROP TABLE media_item');
  const failing = await start(broken, moviesOnly);
  try {
    const response = await get(failing.server, '/api/media?type=movie');
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

test('the server binds to loopback only', async () => {
  // The listener's own address, not a probe against an external interface: a
  // probe would pass on a machine with no route to that interface and prove
  // nothing about what this bound to.
  const raw = setup();
  const { server } = await start(raw, moviesOnly);
  try {
    assert.equal(server.host, '127.0.0.1', 'the address the listener actually bound');
    assert.equal(server.family, 'IPv4', 'and its family, so a v6 wildcard cannot pass as loopback');
    assert.ok(server.port > 0, 'port 0 was replaced by the one the kernel assigned');
    assert.equal(DEFAULT_PORT, 8787, 'the documented default, which no test in this file binds');
  } finally {
    await server.close();
  }
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
  const raw = setup();
  const { server } = await start(raw, moviesOnly);
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
    await firstAnswered;

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
    await assert.rejects(get(server, '/api/health'));

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
  const raw = setup();
  const feedId = seedFeed(raw, 'https://feeds.test/one.xml');
  const rssItemId = seedRssItem(raw, feedId, 2000, 'One.Movie.1080p.mkv');
  const clientId = seedClient(raw, 'main');
  const torrentId = seedTorrentDownload(raw, rssItemId, clientId, 3000, 'ref-t');
  const nzbId = seedNzbDownload(raw, rssItemId, clientId, 3000, 'ref-n');
  const mediaItemId = seedMediaItem(raw, 'alpha', 1000, 'Gone');
  raw.prepare('INSERT INTO deleted_media_item (media_item_id, plugin_id, deleted_at) VALUES (?, ?, ?)')
    .run(mediaItemId, 'alpha', 4000);

  const { server } = await start(raw, moviesOnly);
  try {
    const items: unknown = JSON.parse(await (await get(server, '/api/rss-items')).text());
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

    const downloads: unknown = JSON.parse(await (await get(server, '/api/downloads')).text());
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

    const deletions: unknown = JSON.parse(await (await get(server, '/api/deletions?type=movie')).text());
    assert.deepEqual(deletions, {
      // `ids`, not `items`: a tombstone is an id and nothing else.
      ids: [mediaItemId],
      cursor: encodeCursor({ updatedAt: 4000, id: mediaItemId }),
      done: true,
    }, 'deletions are scoped by type, because a tombstone carries the plugin that owned the row');

    const foreign = await get(server, '/api/deletions?type=book');
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
  const raw = setup();
  const feedId = seedFeed(raw, 'https://feeds.test/paging.xml');
  const expected: string[] = [];
  for (let index = 1; index <= OVER_ONE_PAGE; index += 1) {
    expected.push(String(seedRssItem(raw, feedId, 1000 + index, `Item.${index}.mkv`)));
  }

  const { server } = await start(raw, moviesOnly);
  try {
    const first = await pageFrom(server, '/api/rss-items');
    // The round trip a real client makes. This route decodes a two-part
    // cursor; handing its own cursor to `decodeUnionCursor` used to typecheck
    // (`UnionCursor` was structurally a `Cursor`), and every cursor the route
    // issued then decoded to `null` -- so a client past 200 rss items never
    // advanced, with nothing anywhere reporting it.
    const second = await pageFrom(server, `/api/rss-items?since=${encodeURIComponent(first.cursor ?? '')}`);
    continues(first, second, rowId, expected);
  } finally {
    await server.close();
  }
});

test('the downloads cursor pages forward across both tables when a client sends it back', async () => {
  assert.equal(PAGE_SIZE, 200, 'the counts below are written for a page size of 200');
  const raw = setup();
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

  const { server } = await start(raw, moviesOnly);
  try {
    const first = await pageFrom(server, '/api/downloads');
    const second = await pageFrom(server, `/api/downloads?since=${encodeURIComponent(first.cursor ?? '')}`);
    continues(first, second, downloadKey, expected);
  } finally {
    await server.close();
  }
});

test('the deletions cursor pages forward when a client sends it back', async () => {
  assert.equal(PAGE_SIZE, 200, 'the counts below are written for a page size of 200');
  const raw = setup();
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

  const { server } = await start(raw, moviesOnly);
  try {
    const first = await pageFrom(server, '/api/deletions?type=movie');
    const second = await pageFrom(
      server,
      `/api/deletions?type=movie&since=${encodeURIComponent(first.cursor ?? '')}`,
    );
    continues(first, second, deletionKey, expected);
  } finally {
    await server.close();
  }
});

test('artwork is served from the real filesystem with its type read from the bytes, and honours If-None-Match', async () => {
  const raw = setup();
  const mediaItemId = seedMediaItem(raw, 'alpha', 1000, 'Has A Poster');
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-server-artwork-'));
  try {
    const path = join(dir, 'a.bin');
    await writeFile(path, PNG_BYTES);
    raw.prepare('INSERT INTO poster (media_item_id, url, width, height, created_at, path) VALUES (?, ?, 100, 100, 1, ?)')
      .run(mediaItemId, 'https://images.test/a.png', path);

    const { server } = await start(raw, moviesOnly);
    try {
      const response = await get(server, `/api/artwork/poster/${mediaItemId}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png', 'sniffed from the bytes, not from the .bin suffix');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES, 'the bytes on disk, by value');

      const etag = response.headers.get('etag');
      assert.ok(etag !== null && etag.startsWith('W/'), 'a weak etag, since the cached path is not a hash of the content');

      const cached = await get(server, `/api/artwork/poster/${mediaItemId}`, { 'if-none-match': etag });
      assert.equal(cached.status, 304, 'the header the request carried reaches readArtwork');
      assert.equal((await cached.arrayBuffer()).byteLength, 0);

      const missing = await get(server, `/api/artwork/logo/${mediaItemId}`);
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
  const raw = setup();
  const { server } = await start(raw, moviesOnly);
  try {
    const types = ['../../etc/passwd', 'movie?apikey=SECRET', '/media/movies', 'a'.repeat(64)];
    const answers = await getAll(server, types.map((type) => `/api/media?type=${encodeURIComponent(type)}`));
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
  const raw = setup();
  const { server } = await start(raw, moviesOnly);
  try {
    const answers = await getAll(server, ['/api/media', '/api/media?type=', '/api/deletions']);
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
  const raw = setup();
  seedMediaItem(raw, 'alpha', 1001, 'Movie 1');
  const { server } = await start(raw, moviesOnly);
  try {
    const cursors = ['!!!', '', 'YWJjZGVm', encodeURIComponent('12.abc')];
    const answers = await getAll(server, cursors.map((cursor) => `/api/media?type=movie&since=${cursor}`));
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

test('anything but a read is refused', async () => {
  // The whole API is read-only, so a write method is refused by the method
  // rather than routed as though it were a GET -- which is what a router that
  // only looked at the path would do, answering a POST with a page of data.
  const raw = setup();
  const { server } = await start(raw, moviesOnly);
  try {
    const answers = await Promise.all(['POST', 'PUT', 'DELETE', 'PATCH'].map(async (method) => {
      const response = await fetch(`http://${server.host}:${server.port}/api/health`, { method });
      return { method, status: response.status, text: await response.text() };
    }));
    for (const { method, status, text } of answers) {
      assert.equal(status, 405, `${method} is not a read`);
      assert.deepEqual(JSON.parse(text), { error: 'method not allowed' });
    }
  } finally {
    await server.close();
  }
});
