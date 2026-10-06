# Fetch host settings: concurrency and timeout per hostname, from the UI

Date: 2026-10-06.

## Problem

The host queues every outbound request per hostname and bounds each with a
timeout (`packages/host/src/fetch/queue.ts`). Both numbers are configurable
in shape -- `FetchLimits` and `FetchTimeouts` each take a `default` and a
`perHost` map -- but `main.ts` fills them from four constants: one in flight
and 30 s for every hostname, four in flight and 300 s for the lookup
service. Nothing reads an operator's preference, nothing changes without a
rebuild, and a CDN that could take five requests at once gets one.

## Goal

An operator sets, per hostname and for the default, how many requests may
run at once and how long one may take, from a `Fetching` section on the
Settings page. A change applies to the next request without a restart and
is written to the config file beside `server`, `database` and `secrets`.

## Decisions already made

- The list offers every hostname the host has fetched since boot, plus every
  hostname with a configured entry, and an editable default row. No add
  form, no delete.
- Persistence is the config file, not a database table. The browser reads
  the effective table over REST rather than from the replica.
- Changes apply live through a settings object the queue consults on every
  request. Running requests are never cancelled by a change.
- The lookup service keeps its 4 / 300 000 ms without a config entry, as a
  built-in fallback for that one hostname.

## Facts this design rests on

Read from the code, not remembered:

- `createHostFetch` builds one `BoundedQueue` per hostname lazily in
  `hostFor`, storing `limit` beside it, and reads the timeout through
  `timeoutFor(hostname)` inside the queued task (`queue.ts`). The bounded
  queue (`util/bounded-queue.ts`) takes its limit once at construction and
  has no way to change it.
- `openConfig` (`config/instance.ts`) returns a `Config` whose `register`
  yields a `ConfigHandle<T>` with `current` and `update(next)`; writes are
  serialised and an unknown namespace survives a write. `main.ts` registers
  `server`, `database` and `secrets` at `resolveSettings`.
- `/api/destinations/:pluginId` (`api/server.ts`) is the shape of a
  session-gated `PUT` that answers refusals as values with a contract-owned
  code list (`DESTINATION_REFUSALS` in `packages/contract/src/destinations.ts`)
  and maps each code to a status.
- The Activities page already reads over REST (`activity/fetchActivity.ts`)
  and renders each queued hostname with its `limit` from the queue's
  `snapshot()`.
- Settings (`settings/Settings.tsx`) is three sections, each a component
  taking a `source` and a submit function the Shell wires from a post helper
  (`postDestination.ts` is the pattern: `sendJson`, refusal narrowing,
  `'offline' | 'expired' | 'unrecognised'` added to the contract's codes).

## 1. Configuration

### 1.1 Schema

A `fetch` namespace in `config/schemas.ts`, registered in `resolveSettings`
beside the other three and carried on `HostSettings` as `fetch`:

```json
"fetch": {
  "default": { "concurrency": 1, "timeoutMs": 30000 },
  "hosts": {
    "openmetadata.nexus": { "concurrency": 4, "timeoutMs": 300000 },
    "cdn.theporndb.net": { "concurrency": 3 }
  }
}
```

- `default`: both fields required. The object defaults to
  `{ concurrency: 1, timeoutMs: 30000 }` when the section or the object is
  absent, so a file without a `fetch` section behaves exactly as today.
- `hosts`: a record keyed by hostname, default `{}`. Each value has
  optional `concurrency` and optional `timeoutMs`. An absent field inherits
  from `default`.
- `concurrency`: integer, 1 to 64. `timeoutMs`: integer, 1 000 to
  300 000. The ceiling sits below `JOB_TIMEOUT_MS` (360 000) so a slow
  service fails as a timeout naming the url rather than as a job killed for
  running long. A key must satisfy `isHostname` (§1.2) and must not be the
  reserved `default`. The schema is `strict` at every level, like
  `serverConfigSchema`.
- A file that fails the schema fails boot with the path and the rule named,
  the way a bad `server.port` does. The queue's own construction-time
  validation (`assertValidLimits`, `assertValidTimeouts`) is removed; the
  schema is the single rule.

### 1.2 `isHostname`

A bare lowercase hostname: `new URL(`http://${value}`)` parses, its
`hostname` equals `value`, and `value` contains no `/`, `:`, `@`, `?`, `#`
or whitespace. This refuses a port, a path, userinfo and an uppercase
spelling, each of which would otherwise create an entry that matches no
request, since the queue keys on `new URL(url).hostname`, which is
lowercase and port-free. Exported from `fetch/settings.ts` and used by the
schema and the route.

### 1.3 Lookup fallback

The lookup service's hostname is `new URL(settings.openmetadataUrl).hostname`
at boot. For that hostname only, with no entry in `hosts`, the effective
values are `LOOKUP_CONCURRENCY` (4) and `LOOKUP_TIMEOUT_MS` (300 000), the
two constants `main.ts` already exports. The fallback applies per field: an
entry that pins only `timeoutMs` still gets 4 for concurrency. The fallback
is a property of the settings object (§2.1), not of the file, so the file
stays empty for an install that never touched it.

## 2. Runtime

### 2.1 `fetch/settings.ts`

```ts
export interface FetchPair { readonly concurrency: number; readonly timeoutMs: number }
export interface FetchHostPatch { readonly concurrency?: number | null; readonly timeoutMs?: number | null }

export interface EffectiveHost {
  readonly hostname: string;
  readonly concurrency: number;
  readonly timeoutMs: number;
  /** Which fields came from `default` rather than an entry or the lookup fallback. */
  readonly inherited: { readonly concurrency: boolean; readonly timeoutMs: boolean };
  /** Whether the file has an entry for this hostname. */
  readonly configured: boolean;
}

export interface FetchSettings {
  limitFor(hostname: string): number;
  timeoutFor(hostname: string): number;
  default(): FetchPair;
  /** Every configured hostname plus every hostname in `seen`, sorted, as effective rows. */
  effective(seen: Iterable<string>): readonly EffectiveHost[];
  saveDefault(pair: FetchPair): Promise<FetchPair | FetchRefusal>;
  saveHost(hostname: string, patch: FetchHostPatch): Promise<EffectiveHost | FetchRefusal>;
}

export function createFetchSettings(deps: {
  handle: ConfigHandle<FetchConfig>;
  lookupHostname: string;
}): FetchSettings;
```

Resolution, per field: the entry's field if present, else the lookup
fallback if `hostname === lookupHostname`, else `default`.

A write validates first (§3.3), builds the next `FetchConfig`, awaits
`handle.update(next)`, and only then replaces the in-memory view. A rejected
`update` propagates and leaves `limitFor`/`timeoutFor` answering the old
values. A `saveHost` whose resulting entry has neither field removes the key
from `hosts`.

### 2.2 `createHostFetch`

Takes `limitFor` and `timeoutFor` functions in place of `limits` and
`timeouts`:

```ts
createHostFetch({
  fetch,
  limitFor: (hostname: string) => number,
  timeoutFor: (hostname: string) => number,
  onChange?,
})
```

- `hostFor` builds the bounded queue with `limitFor(hostname)` on first
  sight. `enqueue` calls `limitFor` again on every request and applies the
  result with `setLimit`, so a saved change is in force for that request's
  slot decision.
- `timeoutFor` is read inside the queued task when the request starts, as
  today, so a change applies to the next request to start, not to one
  already running.
- A `seen(): readonly string[]` method on `QueuedFetch` returns every
  hostname `hostFor` has created, in first-seen order.
- `snapshot()` keeps its `limit` field, now the bounded queue's current
  limit.

Tests that construct a queue with a static map pass
`limitFor: () => n` instead; `queue.test.ts`'s existing cases keep their
meaning.

### 2.3 `BoundedQueue.setLimit`

```ts
setLimit(limit: number): void;  // integer >= 1, else throws as the constructor does
limit(): number;
```

Raising releases waiters while `running < limit` and a waiter exists, each
released waiter incrementing `running` as it would have on a natural
release. Lowering changes the number and nothing else: running tasks finish,
and `run` opens no new slot until `running < limit`. The `idle()` contract is
unchanged.

### 2.4 Wiring

`main.ts` registers the `fetch` namespace, builds `createFetchSettings` with
the handle and the lookup hostname, hands `limitFor`/`timeoutFor` to
`createHostFetch`, and passes `fetchSettings` and `fetch.seen` to the API's
deps. The constants `DEFAULT_HOST_CONCURRENCY` and `DEFAULT_FETCH_TIMEOUT_MS`
move into the schema's defaults; `LOOKUP_CONCURRENCY` and
`LOOKUP_TIMEOUT_MS` stay exported and are read by the settings object.

## 3. API

### 3.1 `GET /api/fetch-hosts`

Session-gated. Answers:

```json
{
  "default": { "concurrency": 1, "timeoutMs": 30000 },
  "hosts": [ { "hostname": "...", "concurrency": 4, "timeoutMs": 300000,
               "inherited": { "concurrency": false, "timeoutMs": false }, "configured": false } ]
}
```

`hosts` is `fetchSettings.effective(fetch.seen())`: configured entries and
seen hostnames merged, sorted by hostname, one row each.

### 3.2 `PUT /api/fetch-hosts/:hostname`

Session-gated, `PUT` only. Body is `FetchHostPatch`: each field present
replaces that field; absent leaves it; `null` clears it to inherited. The
path segment `default` addresses the default pair and takes a body with both
fields required and non-null. Answers 200 with the row as `GET` would list
it, or for `default` the pair.

### 3.3 Refusals

In `packages/contract/src/fetch.ts`:

```ts
export const FETCH_REFUSALS = [
  'invalid-shape',        // body is not an object, or a field is neither a number nor null
  'invalid-hostname',     // path segment fails isHostname
  'invalid-concurrency',  // outside 1..64
  'invalid-timeout',      // outside 1000..300000
  'default-required',     // null or absent field on the default row
] as const;
```

Statuses: `invalid-hostname` 404 (a hostname that cannot exist is the same
404 a plugin id that cannot exist gets); every other code 400. A rejected
config write is a 500 with the live values untouched.

## 4. UI

### 4.1 `settings/Fetching.tsx`

Fourth section of Settings, heading `Fetching`, after Destinations. A table
with `aria-label="Fetch hosts"` and columns `Host`, `In flight`,
`Timeout (s)`, and an action cell.

- First row, host cell `Any other host`: the default pair, both inputs
  always populated, Save enabled when either differs.
- One row per `hosts` entry. An inherited field renders as an empty input
  whose `placeholder` is the effective number; a pinned field renders as a
  value. Typing pins; clearing a pinned field and saving sends `null`.
- Timeouts are entered and displayed in whole seconds and sent as
  milliseconds. A fractional second is refused client-side as a `role="alert"`
  before any request.
- `Save` per row, disabled until a field differs from the last server
  answer, labelled `Saving…` while in flight. On success the row is
  replaced from the response. A refusal renders as `role="alert"` text in the
  row: `In flight must be a whole number from 1 to 64`, `Timeout must be a
  whole number of seconds from 1 to 300`, or `Could not save` for the rest,
  with the session-expired and offline messages the other helpers use.
- `Revert to default` appears only on rows with `configured: true`; it
  sends both fields as `null` and the row re-renders inherited.
- Loads on mount and after each save through `useFetchHosts`, with
  `Loading…` and then `No hosts fetched yet` when `hosts` is empty.

### 4.2 Helpers

`useFetchHosts.ts` (GET, returns `{ data, reload }`), `putFetchHost.ts`
(`FetchHostSubmit = (hostname, patch) => Promise<EffectiveHost | FetchPair |
FetchRefusalOutcome>` over `sendJson`, with the three transport codes added
as `postDestination.ts` does). The Shell wires both into Settings as
`fetchHosts` and `submitFetchHost`.

## 5. Edge cases

- Lowering a limit below the number in flight: the Activities snapshot
  shows, say, `limit 1` beside `3 in flight` until they drain. True, not a
  bug.
- A hostname seen before the last restart with no entry drops off the list
  until it is fetched again. The feeds poll within minutes, so the list
  refills on its own.
- The lookup hostname with no entry shows `configured: false` and both
  fields `inherited: false`, since its values come from the fallback. Pinning
  one field leaves the other on the fallback.
- A hand edit to the `fetch` section while the host runs is not read until
  the next boot, and the next UI save overwrites it: `settings.ts` writes its
  in-memory view and `update` replaces the whole `fetch` key. Every other
  section of the file is kept. The README says so.

## 6. Testing

- `util/bounded-queue.test.ts`: raise releases exactly the headroom; lower
  releases none and opens no slot until running drops below; `setLimit(0)`
  and a fraction throw.
- `fetch/queue.test.ts`: `timeoutFor` read at task start (a change after
  enqueue but before start applies; one after start does not); `limitFor`
  re-read on enqueue and applied; `seen()` in first-seen order; snapshot
  `limit` follows a change.
- `fetch/settings.test.ts`: resolution order per field; each refusal;
  rejected `update` leaves `limitFor` unchanged; both-fields-cleared removes
  the key; the written document round-trips through the schema;
  `isHostname` accepts `a.b`, `localhost`, `xn--n3h.example` and refuses
  `A.b`, `a.b:80`, `a.b/x`, `u@a.b`, `a b`, ``.
- `config/schemas.test.ts`: absent section yields today's constants; a bad
  entry names the hostname in the issue path.
- `api/server.test.ts`: GET merges and sorts; PUT patches one field and
  keeps the other; `null` clears; `default` refuses null; 404 for a bad
  hostname; 401 anonymous; a throwing `update` is 500.
- Web `settings/Fetching.test.tsx`: inherited placeholders with empty inputs;
  Save enabled only on change; seconds to milliseconds on the wire; `null`
  for a cleared field; refusal alert text; `Revert to default` only on
  configured rows; reload after save. `shell/Shell.test.tsx`: the section
  renders.
- `e2e/tests/settings-fetching.spec.ts`: set a host's limit to 3, trigger
  requests, and read `limit 3` in the Activities fetch queue without a
  restart.
- Mutation checks, each named to a test: remove the release loop in
  `setLimit`; read `timeoutFor` at enqueue; swap the in-memory view before
  `update`; send seconds instead of milliseconds.

## Out of scope

- A scheduler or watcher that re-reads a hand-edited file while running.
- Rate limiting (requests per second). The queue bounds concurrency only.
- Per-hostname settings for the job dispatcher's own concurrency.
- Deleting a hostname from the list.
