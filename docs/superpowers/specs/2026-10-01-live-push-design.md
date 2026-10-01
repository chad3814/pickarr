# Live push: server-sent events for the sync tail, and cards that wake on updates (#105)

## Problem

The browser learns of a change by polling. One leader tab asks `GET /api/sync` every
three seconds (`TAIL_INTERVAL_MS`, `packages/web/src/store/sync.ts:63`); other tabs
hear about changes from it over a BroadcastChannel. Two consequences:

1. A change made on the host takes up to three seconds to show, and an idle tab costs
   one request every three seconds for ever. Phase 2's 10-second client polling made
   this the slowest link between a download progressing and the screen moving.
2. **#105.** `usePluginRows` wakes a browse card only when a plugin row is *inserted*.
   An update to a row it already shows (a corrected series title, a season number that
   was `null` and is now known) or a delete of such a row does not reach the screen
   until the page remounts. The replica is current; only the rendering is stale.

## Goal

A change on the host reaches an open browser in well under a second, an idle tab costs
almost nothing, and a card re-renders when any plugin row it shows is inserted, updated
or deleted. Everything that already makes the replica correct (the sync log, the
cursor, backfill, the generation reset) is left exactly as it is.

## Decisions already made

| Question | Decision |
|---|---|
| Transport | Server-sent events, not WebSockets: Pickarr needs host→browser only, every browser→host action is already a `POST`, `EventSource` reconnects on its own, and no dependency or proxy `Upgrade` handling is needed. |
| What is pushed | A nudge (`cursor`, `generation`), never the rows. Data still travels through `GET /api/sync`. |
| How the host notices a write | The sync triggers call a Node-registered SQLite function. |
| #105 | A `touched` channel plus the row ids the hook already shows. |

## Verified before designing

Measured against `node:sqlite` on Node 24.20 (2026-10-01), not assumed:

- A trigger body may call a function registered with `DatabaseSync.function()`, and the
  call fires for each affected row, **inside** the writing transaction, before commit.
- `directOnly: true` forbids the function inside a trigger ("unsafe use"), so it must
  not be set.
- A connection on which the function is **not** registered fails every write that
  fires such a trigger: `no such function`. Registration is therefore not optional on
  any connection that holds the synced tables.

## 1. Host: noticing a write

**The function.** `db/open.ts` registers `pickarr_sync_changed()` on every connection it
opens, test connections included, as a no-op returning `NULL`. Nothing else may open a
connection to a Pickarr database without it; the three measurements above are why.

**The triggers.** `sync/log.ts`'s `syncTriggerSql` adds one statement to each of the
three trigger bodies: `SELECT pickarr_sync_changed();`. The triggers are dropped and
recreated on every boot (`installSyncTriggers`), so this is not a migration and freezes
nothing. `docs/database-migrations.md`'s rules about triggers surviving a migration are
unchanged.

**The listener.** `main.ts` wires one listener into the host's own connection. On any
call it sets a flag and, if none is pending, schedules one `setImmediate`. When that
runs it reads `max(id)` from `sync_log` and `ensureSyncGeneration`'s value, and hands
both to the stream registry (§2). So a burst of writes in one event-loop turn costs one
read and one nudge.

**Why a nudge after the turn is enough -- and why `publish` checks rather than
assumes it.** `node:sqlite` is synchronous: a single statement, or a transaction written
without an `await` inside it, has committed before the turn ends, so the browser's fetch
(which arrives on a later turn) reads committed rows. A transaction that spans an
`await` would be a different story: `GET /api/sync` reads on the same connection as the
writer, and SQLite shows a connection its own uncommitted writes, so a nudge published
mid-transaction would be read by a request on *this* connection before `COMMIT`, not
merely early relative to some other reader. `publish` (`sync/events.ts`) does not take
this on faith -- it checks `DatabaseSync.isTransaction` and, if still inside one,
re-defers itself via `deps.defer` instead of publishing, leaving `pending` true so the
already-queued retry is the only one. No write path in the host spans an `await` today,
so the check never actually fires in production; it exists because that is true of the
code today, not forever, and the next transaction site that *does* span an `await` gets
a safe nudge instead of a silently false claim.

## 2. Host: the stream

`GET /api/sync/events`. In `server.ts`'s `ROUTES` like every other route, with
`methods: ['GET']` and not `open`, so `refusalFor` applies the session check before the
method check, as for every guarded route. It is the one route whose answer is a stream
rather than a JSON body: the route handler writes the headers (`content-type:
text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`) and keeps the
response open. `server.ts`'s `REQUEST_TIMEOUT_MS` bounds how long a request takes to
arrive, not how long a response stays open, so nothing there closes it.

**Events.**

- `event: changed`, `data: {"cursor": <max sync_log id>, "generation": "<value>"}`,
  sent on every nudge from §1 and once immediately on connect, so a browser that
  reconnected learns at once whether it missed anything.
- A comment line (`: keep-alive`) every 25 seconds, so a reverse proxy does not close an
  idle stream.

**Registry.** `sync/events.ts` holds the open responses. `publish(cursor, generation)`
writes to each; a write that throws removes that response. The registry caps open
streams at 32 and answers the 33rd with `503 { error: 'too many event streams' }`. A
browser then falls back to polling (§3) and `EventSource` retries. `main.ts`'s shutdown
ends every open stream.

Nothing about a row ever travels on this stream: a cursor is a `sync_log` id and the
generation is already public on every sync response.

## 3. Browser: the leader listens

Only the leader tab (`leader.ts`'s lease holder) opens the stream. Followers hear about
changes exactly as today, over the BroadcastChannel, and nothing in `leader.ts` changes.

`sync.ts`'s `startSync` takes a new injected dependency, `events`, an `EventSource`
factory, beside its existing `fetch`, `schedule`, `now` and `locks`. The real adapter in
`store/adapters.ts` builds a browser `EventSource` for `/api/sync/events`. A test hands
in a fake it drives by hand.

- **A `changed` event** whose `cursor` is greater than the local tail cursor runs the
  tail fetch at once, through the same code the interval uses. One whose cursor is not
  greater does nothing. One whose `generation` differs from the local one runs the
  existing `reset()`.
- **The fallback poll stays, slower.** `TAIL_INTERVAL_MS` is replaced by two constants:
  `TAIL_INTERVAL_STREAMING_MS = 30_000` while the stream is open and
  `TAIL_INTERVAL_POLLING_MS = 3_000` while it is not. `EventSource`'s `open` and `error`
  events flip between them. It covers a nudge lost in a proxy, an early nudge from a
  spanning transaction, and a host without the stream.
- **A dead session.** `EventSource` cannot report a status code. The fallback poll still
  goes through `withUnauthenticatedCheck` (`shell/Shell.tsx`), so an expired session
  reaches sign-in exactly as it does today, within one poll.
- **Stopping.** `stop()` closes the stream along with everything it already stops. A
  leader that loses its lease closes it too.

## 4. #105: cards wake on updates and deletes

**The channel.** `store/notify.ts` gains `subscribeTouched(table, cb)`. It fires once per
batch with the ids the batch wrote to `table`, inserts, updates and deletes alike:
`Changed.touched` from `store/apply.ts`, which already exists and already feeds
`subscribeTable`. The follower path (`sync.ts`'s `onMessage` → `emit`) carries it
unchanged, because `SerializedChanged` already carries `touched`.

**The ids.** `pluginRowsByMediaItems` (`store/*`) returns each row's id beside its value.
`PluginRows` gains the id per row. The sync protocol put the key on the op rather than in
the value; this carries that key one step further, to the hook that needs it.

**The hook.** `usePluginRows` keeps the set of row ids it is currently showing, per
table. It subscribes to `subscribeTouched` for each declared plugin table and drops its
`subscribeInserts` subscription, so no change wakes it twice. On a wake, for each id:

- if the hook holds the id, it refetches: the row was updated or deleted, and a tombstone
  needs no value for this to work;
- otherwise it reads the row and refetches if `mediaItemOf(value)` is one of the page's
  items: the row is new to this page;
- a read that finds nothing (a tombstone for a row it never held) is ignored.

One refetch per wake, however many ids matched.

`useGatheredItem` already subscribes per row and is unchanged.

## 5. Testing

Every test is written to fail first.

**Host**

- Every connection `openDatabase`/`openTestDatabase` returns has `pickarr_sync_changed`
  registered: a write that fires a sync trigger on a bare test connection does not
  throw.
- The listener fires once for a burst of writes in one turn, with the cursor equal to
  `max(sync_log.id)` after the burst.
- The route: an anonymous request is refused `401` before the method check; a `POST` is
  `405`; an authenticated `GET` receives the headers above, an immediate `changed` event,
  and a further `changed` after a write, with the right cursor and generation.
- A heartbeat comment arrives on the 25-second timer (driven by injected timers).
- The 33rd stream is refused `503`; closing one admits the next.
- Shutdown ends every open stream.

**Web**

- A `changed` event with a greater cursor fetches the tail at once; an equal or lower one
  does not; a different generation resets.
- The scheduler is asked for 30 000 ms while the stream is open and 3 000 ms after an
  `error`, and back again after `open`.
- A follower tab builds no `EventSource`. `stop()` closes the stream.
- #105: an update to a held plugin row refetches; a delete of a held row refetches; a new
  row for one of the page's items refetches; a row for another item does not; one wake
  with several matching ids refetches once.

**e2e**

- The spec "a healthy tab does not poll the tail far faster than its 3-second rate" is
  replaced by two: a row seeded on the host appears on screen within one second, and a
  quiet tab makes at most one `/api/sync` request in ten seconds.

**Mutations.** Remove each of these in turn and confirm a test fails:

- the `SELECT pickarr_sync_changed();` statement in the trigger body
- the `setImmediate` coalescing (nudge synchronously instead)
- the route's guard (`open: true`)
- the `cursor >` comparison
- the held-id check in the hook
- the cadence switch on `open`/`error`

## Out of scope

- Pushing rows themselves, or replacing `/api/sync`.
- Per-row waking for `useGatheredItem` (already in place).
- An Activities page or any new consumer of the stream (Phase 4 adds consumers; this
  phase adds the channel).
- WebSockets.
