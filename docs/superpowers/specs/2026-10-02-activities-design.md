# Activities: what the host is doing right now

## Problem

Pickarr runs work the operator cannot see: lookup, poll, reconcile, artwork and backfill
jobs in the `jobs` table, outbound requests queued per hostname in the fetch layer, and
downloads moving through their statuses. Today the only windows onto any of it are the
host's log and, for downloads, one card at a time. Two consequences:

1. A stuck or dead job is invisible until its effect is missed. Phase 2 made the
   reconcile cycle survive outages and gave a refused import a counter; both are visible
   only in the log.
2. The `jobs` table is never pruned. A reconcile job every ten seconds per download
   client leaves about 360 `done` rows per client per hour, for ever.

## Goal

A page that shows, live, what the host is doing: jobs that are running, waiting or dead,
the jobs that just finished, the outbound fetch queue, and every download in progress.
Finished jobs stop accumulating.

## Decisions already made

| Question | Decision |
|---|---|
| Contents | Jobs (running, waiting, dead), recently finished jobs, the fetch queue, active downloads |
| Finished jobs | `done` rows older than 24 hours are pruned; `dead` rows are never pruned |
| Actions | None. The page observes. A retry or dismiss surface is a later phase. |
| How jobs reach the browser | A read route, not replication: `jobs` is not a synced table, and syncing it would push hundreds of rows per client per hour into every replica |
| How URLs are shown | Never raw. Method plus `redactUrl`'s output with the query string dropped — the same trust level as the host's own log lines |

## Facts this design rests on

Read from the tree on 2026-10-02:

- `jobs` holds `id, plugin_id, kind, payload_json, attempts, max_attempts, run_at, state,
  last_error, created_at, updated_at, started_at`; `state` is `ready | running | done |
  dead`. `last_error` is redacted at its one write site (`jobs/run-job.ts`). Nothing
  deletes a row. `jobs` is not in `HOST_SYNCED_TABLES`, and `sync/tables.ts` says why.
- Two job kinds share the string `poll` under different plugin ids (the host's feed poll
  and openmetadata's lookup poll).
- Payloads carry ids, and the artwork job's carries people's names and provider
  references.
- The fetch layer (`fetch/queue.ts`, `util/bounded-queue.ts`) keeps one bounded queue per
  hostname with a running count and a waiting list of resolvers. It records no URL. URLs
  can carry an API key in the query string or a passkey in a path segment;
  `clients/redact.ts`'s `redactUrl` masks both, and the codebase's rule is that no
  response body carries a URL, path or query string.
- The event hub (`sync/events.ts`) writes named events to open streams; the browser's
  `EventSource` drops an event type nobody listens for.
- `torrent_download` and `nzb_download` are synced. Non-terminal statuses are
  `submitting`, `submitted`, `downloading` and `completed`; `delivered` and `failed` are
  terminal. Nothing in the browser lists downloads across media items.
- The dispatcher runs a safety sweep every `SAFETY_INTERVAL_MS` (60 s).

## 1. The read route

`GET /api/activity`, in `ROUTES` like every other route, `methods: ['GET']`, not `open`,
so the session check runs before the method check. It answers:

```ts
interface ActivityRead {
  jobs: {
    running: ActivityJob[];
    waiting: ActivityJob[];   // state 'ready', soonest run_at first
    dead: ActivityJob[];      // newest first
    recent: ActivityJob[];    // state 'done', newest first, at most 50
  };
  fetches: ActivityHost[];    // one per hostname with anything queued or in flight
}
interface ActivityJob {
  id: number;
  pluginId: string;
  kind: string;
  attempts: number;
  maxAttempts: number;
  runAt: number;
  startedAt: number | null;
  updatedAt: number;
  lastError: string | null; // non-null only when state is 'dead'
}
interface ActivityHost {
  hostname: string;
  limit: number;
  inFlight: ActivityRequest[];
  waiting: ActivityRequest[];
}
interface ActivityRequest {
  method: string;
  /** `redactUrl(url)` with the query string removed: origin and path, passkeys masked. */
  target: string;
}
```

The types live in `@pickarr/contract` beside the other read shapes, and the browser
narrows what it receives rather than casting, as every other reader does.

**No `payload`, no `payload_json`.** The page has no use for a job's arguments, and a
payload can carry a person's name. The route's `SELECT` names its columns and never
`payload_json`.

`recent` is capped at 50 by the query. Nothing paginates.

## 2. Instrumenting the fetch queue

`createHostFetch` already routes every request through a per-hostname bounded queue. It
gains a record per request: the method and `target` computed **once, at enqueue time**,
from `redactUrl(url)` with everything from `?` onward removed. The record moves from the
hostname's `waiting` list to its `inFlight` set when the slot is granted, and is dropped
when the request settles. The raw URL is never stored.

`createHostFetch` returns, beside `json`, `bytes` and `text`, a `snapshot(): ActivityHost[]`
that reads the records synchronously, so counts and lists always agree with each other.
`QueuedFetch` is the type that gains it; `HostFetch` in the contract (what a plugin sees)
is unchanged.

## 3. Nudges

The event hub gains a second event, `activity`, with no data, coalesced per event-loop turn
exactly as `changed` is. Two sources feed it:

- **Jobs.** `db/open.ts` registers a second function on every connection,
  `pickarr_activity_changed()`, a no-op until the host installs a listener. `main.ts`
  installs three triggers on `jobs` (insert, update, delete) whose body is one call to
  it. They are created at boot like the sync triggers (`DROP TRIGGER IF EXISTS` then
  `CREATE`), not by a migration, and they write nothing. Every job state change — claim,
  completion, failure, dead-letter, sweep, prune — therefore reaches the hub without a
  change to the job runner.
- **The fetch queue.** `createHostFetch` takes an optional `onChange` callback and calls
  it whenever a record is added, granted or dropped. `main.ts` wires it to the hub.

The same measured facts from the live-push design apply: the function must be registered
on every connection (a trigger calling an unregistered function fails the write), and
`directOnly` must not be set.

## 4. Pruning

Migration 26 adds `CREATE INDEX jobs_done_updated ON jobs (updated_at) WHERE state =
'done'`. `jobs` is not synced, so nothing about triggers or replication applies.

The dispatcher's existing safety sweep also runs
`DELETE FROM jobs WHERE state = 'done' AND updated_at < ?` with `now − 86_400_000`. It
deletes `done` rows only: a `dead` row stays until something acts on it, a `ready` or
`running` row is never a candidate, and a row that finished a moment ago stays for a day.
The delete fires the `jobs` triggers, so the page refreshes.

## 5. The browser

**Route and nav.** `/activities` is registered in `Shell.tsx` the way `unmatched` and
`settings` are, with a nav tab labelled `Activities`. The page component takes its
dependencies as required props, like `Settings` and `Unmatched`.

**Jobs and fetches.** A `useActivity` hook fetches `GET /api/activity` through the shared
`sendJson` helper:

- on mount;
- on an `activity` event;
- every 30 seconds as a fallback.

Only the leader tab holds the event stream, so `sync.ts` listens for `activity` beside
`changed` and relays it over the BroadcastChannel as `{ type: 'activity' }`, exactly as it
relays `changed`; every tab's hook refetches on either. A 401 is the shared `expired`
outcome and returns the tab to sign-in with the existing notice.

Before the first answer the section reads `Loading…`. After a failed refetch it keeps the
last answer and shows `Couldn't reach Pickarr` beside it, as real text in a styled
element.

**Active downloads.** A new store read, `activeDownloads()`, reads both download tables
from the replica, keeps rows whose status is not `delivered` or `failed`, and joins each
to its `rss_item` filename, its `media_item` title (through `rss_item.media_item_id`,
which may be null for an unmatched release) and its `download_client` name. The page
subscribes to both download tables with `subscribeTable` and re-reads on a change. No
host work.

**Display.** Four sections, each a heading and a list of real text:

- `Running`, `Waiting`, `Dead`: one line per job — `<pluginId> <kind>`, attempt `n of m`,
  and for waiting jobs when it runs next, for dead jobs the `lastError`. Kind and plugin
  are shown as the host spelled them, never mapped through a list this build knows.
- `Recently finished`: `<pluginId> <kind>` and when.
- `Fetch queue`: one block per host — hostname, `k in flight, n waiting, limit l`, then
  each request as `METHOD target`.
- `Downloads in progress`: filename, title (or `unmatched`), client name, status, and
  the percentage while `downloading`.

An empty list says so: `Nothing running`, `Nothing waiting`, `No dead jobs`, `Nothing
finished recently`, `No requests queued`, `No downloads in progress`.

## 6. Edge cases

- **A kind the page does not know.** Shown as spelled. The plugin id is always beside
  it, because `poll` belongs to two plugins.
- **A dead job's error.** Shown verbatim as stored; it was redacted at the write site
  and the page adds nothing.
- **Host unreachable.** The jobs and fetches section keeps its last answer and says so;
  the downloads section is unaffected.
- **A follower tab.** It has no stream; the relayed `activity` message is what wakes it.
- **A queue snapshot mid-request.** One synchronous read, so the lists and counts agree.
- **Pruning racing a job.** Only `done` rows older than a day are candidates.
- **An old browser bundle** with no `activity` listener: `EventSource` drops the event;
  nothing breaks.

## 7. Testing

Every test is written to fail first.

- **Host**
  - The route refuses an anonymous request before the method check; `POST` is `405`.
  - A signed-in `GET` answers the four job lists in the stated orders; no object anywhere
    in the body has a `payload` or `payloadJson` key.
  - `recent` holds at most 50, newest first.
  - A dead job carries `lastError`; a waiting one carries `null`.
  - The fetch snapshot shows a waiting and an in-flight request, with the query string
    gone and a path passkey masked, and the raw URL appears nowhere in the body.
  - Every connection has `pickarr_activity_changed`; a `jobs` insert, update and delete
    each nudge the hub once per turn; the hub writes `event: activity`.
  - The sweep deletes a `done` row older than a day and leaves a fresh `done` row, a
    `dead` row and a `ready` row.
  - Migration 26 adds the index.
- **Web**
  - The page renders all six headings and their empty-state sentences as visible text.
  - An `activity` event refetches; the fallback poll asks the scheduler for 30 000 ms.
  - A follower tab refetches on the relayed message; the leader relays it.
  - A 401 yields `expired` and the sign-in notice.
  - `activeDownloads()` excludes `delivered` and `failed`, joins filename, title and
    client name, and shows `unmatched` for a null media item.
  - A change to a download table re-renders the downloads list.
  - Loading and unreachable states show their sentences.
- **e2e**
  - Sign in, open Activities: a seeded download client's reconcile job appears under
    Running or Waiting within a second, and a seeded in-progress download appears under
    Downloads in progress.
- **Mutations.** Each must make a test fail: add `payload_json` to the route's `SELECT`;
  remove the 50 cap; keep the query string in `target`; skip `redactUrl`; let the sweep
  delete `dead` rows; drop the `activity` relay; let `activeDownloads()` include
  `delivered`.

## Out of scope

- Retrying, cancelling or dismissing a job.
- Cancelling a download or a queued request.
- Replicating `jobs`.
- Pruning `dead` rows.
