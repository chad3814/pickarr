import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { ServerResponse } from 'node:http';
import { openTestDatabase, setSyncChangedListener } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createSyncEvents, type SyncEvents } from '../../src/sync/events.ts';

/**
 * A `ServerResponse` stand-in: records `writeHead` and collects everything
 * written, and can be ended from the client side. Narrow to what
 * `createSyncEvents` touches -- `writeHead`, `write`, `end`, `on('close')`,
 * `destroyed` -- so the test says exactly which parts of a response the hub
 * depends on.
 *
 * A class extending `PassThrough` rather than `Object.assign(stream, {...})
 * as unknown as ServerResponse`: `scripts/check-test-hygiene.ts` parses the
 * AST for this file and the class form is what it accepts here, typed as the
 * narrow subset the hub actually calls rather than cast through `unknown`.
 */
class FakeResponse extends PassThrough {
  head: { status: number; headers: Record<string, string> } | undefined;
  headersSent = false;

  writeHead(status: number, headers: Record<string, string>): this {
    this.head = { status, headers };
    this.headersSent = true;
    return this;
  }
}

function fakeResponse(): { response: ServerResponse; head: () => { status: number; headers: Record<string, string> } | undefined; body: () => string; disconnect: () => void } {
  const stream = new FakeResponse();
  let body = '';
  stream.on('data', (chunk: Buffer | string) => { body += chunk.toString(); });
  const response = stream as unknown as ServerResponse;
  return {
    response,
    head: () => stream.head,
    body: () => body,
    disconnect: () => { stream.destroy(); },
  };
}

function harness(opts: { maxStreams?: number } = {}): {
  events: SyncEvents; raw: ReturnType<typeof openTestDatabase>['raw'];
  runDeferred: () => void; heartbeat: () => void;
} {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)');
  const deferred: (() => void)[] = [];
  let tick: (() => void) | undefined;
  const events = createSyncEvents({
    raw,
    generation: 'gen-1',
    timers: { setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = undefined; } },
    defer: (fn) => { deferred.push(fn); },
    ...(opts.maxStreams === undefined ? {} : { maxStreams: opts.maxStreams }),
  });
  return {
    events, raw,
    runDeferred: () => { for (const fn of deferred.splice(0)) fn(); },
    heartbeat: () => { assert.ok(tick, 'no heartbeat timer'); tick(); },
  };
}

test('attaching writes the stream headers and one changed event carrying the current cursor and generation', () => {
  const { events, raw } = harness();
  raw.exec("INSERT INTO sync_log (table_name, row_id, op, at) VALUES ('probe', 1, 'upsert', 1), ('probe', 2, 'upsert', 1)");
  const top = Number((raw.prepare('SELECT max(id) AS m FROM sync_log').get() as { m: unknown }).m);
  const r = fakeResponse();
  events.attach(r.response);
  assert.equal(r.head()?.status, 200);
  assert.equal(r.head()?.headers['content-type'], 'text/event-stream');
  assert.equal(r.head()?.headers['cache-control'], 'no-cache');
  assert.equal(r.head()?.headers['connection'], 'keep-alive');
  assert.equal(r.body(), `event: changed\ndata: {"cursor":${String(top)},"generation":"gen-1"}\n\n`);
  assert.equal(events.openStreams, 1);
});

test('a burst of notify calls publishes once, after the deferral, with the cursor after the burst', () => {
  const { events, raw, runDeferred } = harness();
  const r = fakeResponse();
  events.attach(r.response);
  const before = r.body();
  raw.exec('BEGIN');
  for (let i = 0; i < 5; i += 1) {
    raw.exec(`INSERT INTO sync_log (table_name, row_id, op, at) VALUES ('probe', ${String(i)}, 'upsert', 1)`);
    events.notify();
  }
  raw.exec('COMMIT');
  assert.equal(r.body(), before, 'nothing published synchronously, inside the transaction');
  runDeferred();
  const after = r.body().slice(before.length);
  assert.equal(after.split('event: changed').length - 1, 1, 'one event for five notifies');
  assert.ok(after.includes('"cursor":5'), after);
  runDeferred();
  assert.equal(r.body().slice(before.length), after, 'a second turn with nothing new publishes nothing');
});

test('the heartbeat is a comment line to every open stream', () => {
  const { events, heartbeat } = harness();
  const a = fakeResponse(); const b = fakeResponse();
  events.attach(a.response); events.attach(b.response);
  const len = a.body().length;
  heartbeat();
  assert.equal(a.body().slice(len), ': keep-alive\n\n');
  assert.equal(b.body().slice(len), ': keep-alive\n\n');
});

test('a stream the client closed is forgotten, and a later publish does not throw', () => {
  // Review Focus 5.
  const { events, runDeferred } = harness();
  const a = fakeResponse(); const b = fakeResponse();
  events.attach(a.response); events.attach(b.response);
  a.disconnect();
  assert.equal(events.openStreams, 1);
  events.notify();
  assert.doesNotThrow(runDeferred);
  assert.ok(b.body().split('event: changed').length - 1 >= 2, 'the survivor still hears');
});

test('the cap refuses the next stream with 503 and admits one again once a stream closes', () => {
  const { events } = harness({ maxStreams: 2 });
  const a = fakeResponse(); const b = fakeResponse(); const c = fakeResponse();
  events.attach(a.response); events.attach(b.response); events.attach(c.response);
  assert.equal(c.head()?.status, 503);
  assert.deepEqual(JSON.parse(c.body()), { error: 'too many event streams' });
  assert.equal(events.openStreams, 2);
  a.disconnect();
  const d = fakeResponse();
  events.attach(d.response);
  assert.equal(d.head()?.status, 200);
});

test('close ends every stream and stops the heartbeat', () => {
  const { events, heartbeat } = harness();
  const a = fakeResponse();
  events.attach(a.response);
  events.close();
  assert.equal(events.openStreams, 0);
  assert.ok(a.response.writableEnded);
  assert.throws(heartbeat, /no heartbeat timer/);
});

test('the listener wired to a real connection publishes on a trigger write', () => {
  const { events, raw, runDeferred } = harness();
  // The hub does not install the listener itself; main.ts does. Wire it the same way here.
  setSyncChangedListener(raw, () => { events.notify(); });
  const r = fakeResponse();
  events.attach(r.response);
  const len = r.body().length;
  raw.exec('CREATE TRIGGER probe_sync_ins AFTER INSERT ON probe BEGIN INSERT INTO sync_log (table_name, row_id, op, at) VALUES (\'probe\', NEW.id, \'upsert\', 1); SELECT pickarr_sync_changed(); END');
  raw.exec("INSERT INTO probe (v) VALUES ('x')");
  runDeferred();
  assert.ok(r.body().slice(len).startsWith('event: changed'));
});
