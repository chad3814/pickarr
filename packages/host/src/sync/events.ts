/**
 * Server-sent events for the sync tail: the host's end of
 * `GET /api/sync/events` (design spec 2026-10-01 §1-2).
 *
 * **A nudge, never a row.** Each event carries the current `sync_log`
 * cursor and the install's generation. A browser whose cursor is behind
 * fetches `GET /api/sync` exactly as it always has; nothing about a row
 * travels here.
 *
 * **Coalesced per event-loop turn.** `notify` is called by the sync
 * triggers through `pickarr_sync_changed()`, once per logged row and inside
 * the writing statement. It sets a flag and defers one `publish` with
 * `deps.defer` (`setImmediate` in production). `node:sqlite` is synchronous,
 * so a statement or an await-free transaction has committed before that
 * turn runs, and the cursor read then is the committed one.
 *
 * **`publish` checks rather than assumes that.** `GET /api/sync` reads on
 * the same connection as the writer, and SQLite shows a connection its own
 * uncommitted writes -- so a transaction spanning an `await` would not just
 * be "early" if a nudge went out mid-transaction, it would let a request on
 * this connection read uncommitted rows. `publish` tests
 * `deps.raw.isTransaction` and, if still inside one, re-defers itself
 * instead of publishing, leaving `pending` true so nothing else schedules a
 * second retry in the meantime. No write path in the host spans an `await`
 * today, so the check is never actually exercised in production -- but that
 * is a fact about today's write paths, not a property this module can lean
 * on without checking.
 *
 * **Bounded.** `maxStreams` open responses; the next is answered 503 so the
 * browser falls back to polling and `EventSource` retries later.
 */
import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

export interface SyncEventsDeps {
  raw: DatabaseSync;
  generation: string;
  /** Injected so a test can drive the heartbeat; `main.ts` passes the globals. */
  timers: { setInterval(fn: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  /** Injected so a test can drive coalescing; `main.ts` passes `setImmediate`. */
  defer: (fn: () => void) => void;
  /** Open responses allowed at once; the next is refused with a 503. Default 32. */
  maxStreams?: number;
  /** Comment-line heartbeat interval, in ms. Default 25_000. */
  heartbeatMs?: number;
}

export interface SyncEvents {
  /** The trigger-called listener: marks a change and defers one publish. Safe to call inside a transaction. */
  notify(): void;
  /** Writes the stream headers and the initial `changed` event, or a 503 JSON body when full. */
  attach(response: ServerResponse): void;
  readonly openStreams: number;
  /** Ends every open stream and stops the heartbeat. */
  close(): void;
}

const DEFAULT_MAX_STREAMS = 32;
const DEFAULT_HEARTBEAT_MS = 25_000;

function topOfLog(raw: DatabaseSync): number {
  const row = raw.prepare('SELECT coalesce(max(id), 0) AS top FROM sync_log').get();
  const top = row?.['top'];
  return typeof top === 'number' ? top : 0;
}

export function createSyncEvents(deps: SyncEventsDeps): SyncEvents {
  const maxStreams = deps.maxStreams ?? DEFAULT_MAX_STREAMS;
  const streams = new Set<ServerResponse>();
  let pending = false;
  let closed = false;

  function send(response: ServerResponse, chunk: string): void {
    try {
      response.write(chunk);
    } catch {
      // A backstop, not a known path: `write()` on a destroyed Node stream
      // returns `false` rather than throwing (confirmed on `node:stream`),
      // so nothing observed here has actually hit this `catch`. `'close'`
      // (below) and `prune`'s `destroyed` check are what remove a gone
      // response; this stays in case some future response shape disagrees.
      streams.delete(response);
    }
  }

  /**
   * A belt, not the removal path. `'close'` (registered in `attach`, below)
   * is what normally drops a response that went away. This additionally
   * drops one whose `destroyed` flag is already `true` by the time a
   * `publish`, a heartbeat tick, or the next `attach` reaches it -- which
   * matters when something destroyed the response without ever firing
   * `'close'` on this hub's listener (the registry was never told), and is
   * also what `test/sync/events.test.ts`'s fake response relies on, since
   * its `destroy()` is synchronous while its `'close'` only fires on a
   * later tick. Nothing here claims that gap exists on a real
   * `http.ServerResponse`; measured on one, `destroyed` and `'close'`
   * arrive in the same tick, so `'close'` alone removes it just as fast.
   */
  function prune(): void {
    for (const response of streams) if (response.destroyed) streams.delete(response);
  }

  function changedEvent(): string {
    return `event: changed\ndata: ${JSON.stringify({ cursor: topOfLog(deps.raw), generation: deps.generation })}\n\n`;
  }

  function publish(): void {
    if (closed) {
      pending = false;
      return;
    }
    if (deps.raw.isTransaction) {
      // Still inside the writing transaction when this deferred turn ran --
      // re-defer rather than read `sync_log` on a connection that would see
      // its own uncommitted write. `pending` stays `true`, so this is the
      // only retry queued; the module docblock above says why this branch
      // is unreached by any write path today.
      deps.defer(publish);
      return;
    }
    pending = false;
    prune();
    const event = changedEvent();
    for (const response of streams) send(response, event);
  }

  const heartbeat = deps.timers.setInterval(() => {
    prune();
    for (const response of streams) send(response, ': keep-alive\n\n');
  }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  return {
    notify() {
      if (pending || closed) return;
      pending = true;
      deps.defer(publish);
    },
    attach(response) {
      prune();
      if (closed) {
        // Distinct from the cap's refusal below: the hub itself is gone,
        // not merely full, and a reconnecting `EventSource` is told so
        // rather than being given a reason ("too many") that would suggest
        // retrying sooner would help.
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'event streams closed' }));
        return;
      }
      if (streams.size >= maxStreams) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'too many event streams' }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        // nginx buffers a proxied response by default, which would hold
        // every event behind its own buffer instead of flushing it to the
        // client as written; this tells it not to.
        'x-accel-buffering': 'no',
      });
      streams.add(response);
      // The removal path: on a real `http.ServerResponse`, `'close'` is how
      // a client disconnect is noticed at all, and it fires without this
      // hub ever calling `prune`, `publish` or the heartbeat again -- an
      // idle stream nobody touches otherwise still has to be let go.
      response.on('close', () => { streams.delete(response); });
      send(response, changedEvent());
    },
    get openStreams() { prune(); return streams.size; },
    close() {
      closed = true;
      deps.timers.clearInterval(heartbeat);
      for (const response of streams) response.end();
      streams.clear();
    },
  };
}
