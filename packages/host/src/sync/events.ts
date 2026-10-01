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
 * turn runs, and the cursor read then is the committed one. A transaction
 * that spans an `await` would publish early; the browser then reads what
 * is committed and gets the rest on its fallback poll. No write path does
 * that today.
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
      streams.delete(response);
    }
  }

  /**
   * Drops a response already gone. `destroyed` flips to `true` the moment
   * something destroys the underlying socket -- synchronously, in the same
   * tick -- while the `close` event the handler below also listens for only
   * fires on a later tick (measured on `node:stream`, Node 24). Without this,
   * a stream that closed moments ago still counts toward `openStreams` and
   * the cap until that later tick runs, which is wrong for both: a close
   * immediately followed by a publish or by the next `attach` must see the
   * slot as free *now*.
   */
  function prune(): void {
    for (const response of streams) if (response.destroyed) streams.delete(response);
  }

  function changedEvent(): string {
    return `event: changed\ndata: ${JSON.stringify({ cursor: topOfLog(deps.raw), generation: deps.generation })}\n\n`;
  }

  function publish(): void {
    pending = false;
    if (closed) return;
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
      if (closed || streams.size >= maxStreams) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'too many event streams' }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      streams.add(response);
      // Defensive: the normal path a real disconnect is noticed on, for a
      // response `prune` never gets called against again (an idle stream
      // nobody attaches, notifies or hits the heartbeat on).
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
