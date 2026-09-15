# Pickarr 2.0 — The Client Storage Provider

The first client slice. It builds the subsystem that replicates the server's library
into the browser and answers components from that replica. It renders nothing: no
route, no component, no styling. Its consumer in this slice is a test.

**Read `2026-09-14-client-sync-design.md` first.** This document is the other half of
that protocol, and every obligation it places on "the client" lands here.

**This design depends on the `sync-wire` branch**, which normalises the wire to
camelCase, adds the six host read shapes to the contract, and puts a `generation` on
every sync response. §3.2's single index key path and §6 both assume it. If that branch
does not land, this one needs a per-table key map and has no way to detect a rebuilt
database.

## 1. What this delivers

- An IndexedDB replica of every synced table, keyed as the protocol keys rows.
- The tail and the backfill, running concurrently, with cursors that advance
  atomically with the rows they cover.
- One tab elected to do that work, so extra tabs cost nothing.
- A row-level read surface, all of it asynchronous.
- Per-row change subscriptions, plus the two signals per-row subscriptions cannot
  carry: insertions and resets.
- The host-owned gatherer of §7 — everything common to a media item — so the slice
  delivers something a card can be built on rather than only tests.

### 1.1 Decisions taken before this spec

Recorded because each closes off alternatives a reader would otherwise reopen.

- **Sync runs on the main thread**, at idle priority, with a Web Locks lease electing
  one tab. *Rejected:* a `SharedWorker` owning storage (every component read pays a
  round trip and a structured clone), and a dedicated worker writing while the main
  thread reads (two connections to one database, and multi-tab still duplicated
  because each tab has its own worker). The measured work per page is a `fetch`, a
  `JSON.parse` and an IndexedDB put — single-digit milliseconds at this library's
  size — so a worker buys little on speed. What it buys is multi-tab, and a lease
  buys that for about twenty lines.
- **Every read is asynchronous**, including reads that could be answered from memory.
  This is the one decision that cannot be revisited later: an async read surface can
  move into a worker without a component noticing, and a synchronous one never can.
- **The provider is a row-level replica and does not know what a card is.** Joining
  happens above it. See §7.
- **Subscriptions are per row.** *Rejected:* one event per applied batch listing what
  changed, and a bare version counter — both make every consumer re-read on every
  batch, which during a backfill is continuous.
- **No writes.** The host answers 405 to anything but GET, so there is no outbox, no
  optimistic update and no conflict resolution to design. Picks will need all three;
  nothing here may assume they never arrive.

### 1.2 What this slice is not

- **No UI.** Not a route, not a component, not a hook.
- **No remote fallback.** The provider answers from the replica and nothing else. See
  §9.
- **No artwork rows.** Artwork is addressed by URL through a guarded route, not
  replicated. [#79](https://github.com/chad3814/pickarr/issues/79) is the slice that
  changes that, and it changes this one too.
- **No `external_reference`.** The table exists in the schema with no writer; external
  links wait for it.
- **No per-plugin composition.** §7 describes both halves of the join because that is
  the architecture, but `plugins/<id>/compose.ts` decides what a *card* shows, and no
  card exists yet to decide against. The host-owned gatherer ships; its plugin
  counterparts ship with the screens that need them.

## 2. Facts, measured rather than assumed

**2.1 The wire speaks camelCase, as of the `sync-wire` branch.** Before it, host
projections went straight from SQL and spoke snake_case while the plugin read shapes
spoke camelCase — the same logical field was `media_item_id` on three tables and
`mediaItemId` on three others. That split is why §3.2's single index key path is
possible; without it this design needs a per-table key map.

**2.2 Every synced row carries an `id` on its op, not in its value.** The protocol
keys rows; a read shape does not. So the store's key comes from the op envelope
(`{op, table, id, value}`), never from a field inside `value`.

**2.3 The parent plugin shapes carry no `mediaItemId`.** `TvSeasonRead`,
`TvSeriesRead` and `XxxSiteRead` have no such column — many episodes share a season,
many scenes a site — and are reached through the detail rows that point at them. An
index on `value.mediaItemId` is therefore **sparse by nature**, not by configuration.

**2.4 Two ids in the replica can never be resolved from the replica.**
`rss_item.feedId` names an `rss_feed`, and the two download tables' `downloadClientId`
names a `download_client` — neither table is synced, the latter deliberately, because
it holds a service address. A client may surface both ids and can never turn either
into a name without a read-API call.

**2.5 A tombstone must be distinguishable from an absence, and by primary key.** The
`create` rule is "do nothing if the row is already held, including as a tombstone", so
a tombstone has to be findable at its key. It must equally be invisible to every
ordinary read.

**2.7 Web Locks works in Node 26, so the lease is testable for real.** Measured:
`navigator.locks.request` grants, excludes a second `exclusive` holder, honours
`ifAvailable` (returning a null lock rather than queueing), and releases on callback
return. Node's implementation is per-process where the browser's is per-origin, which
is exactly the model a test wants — two "tabs" are two requesters in one process. So
the "only the holder fetches" property needs no stub and is not a mock asserting
itself.

**2.8 `fake-indexeddb` supports all three of §3.2's load-bearing claims.** Measured
against the real schema before committing to it: a compound `['table','id']` key path;
a nested index on `value.mediaItemId` answering one `getAll(7)` with rows from *two
different tables*; and a record with no `value` staying retrievable at its primary key
while absent from that index. Store tests are `.test.ts`, so they run in the **server**
suite (`packages/*/test/**/*.test.ts`) and need no happy-dom — IndexedDB and
`BroadcastChannel` are all they touch, and `indexedDB` is the only one Node lacks.

**2.6 Ops are idempotent, and that is what makes multi-tab safe rather than merely
wasteful.** Two tabs applying the same page converge. So the lease in §5 is an
efficiency measure and its failure mode is duplicated work, never divergence.

## 3. The store

### 3.1 One object store, not one per table

`rows`, with key path `['table', 'id']`.

An object store can only be created inside `onupgradeneeded`, and which plugin tables
exist is decided at runtime by whichever plugins the host has loaded. A store per
table would mean an IndexedDB version bump every time a plugin is added or removed —
a schema migration triggered by configuration. One store is version-stable against
the plugin model, which is the whole architecture this replicates.

*Cost:* every index carries `table` or is global across tables. §3.2 leans into the
second, which turns out to be the more useful shape.

### 3.2 The record, and why `value` is nested

```ts
interface StoredRow {
  table: string;
  id: number;
  /** Absent on a tombstone — see §2.5. */
  value?: unknown;
}
```

Indexes:

| Index | Key path | Answers |
|---|---|---|
| `by_media_item` | `value.mediaItemId` | every row of every table belonging to one media item |
| `by_rss_item` | `value.rssItemId` | a release's downloads |
| `by_table_updated` | `['table', 'value.updatedAt']` | a table in browse order |
| `by_table` | `table` | a whole table, tombstones included |

`by_table_updated` covers **five of the twelve tables**, and that is measured rather
than intended: `media_item`, `rss_item`, `torrent_download`, `nzb_download` and
`person` project `updatedAt`; `role` projects only `createdAt`, and none of the six
plugin read shapes carries either. Browse ordering needs it for `media_item` alone, so
this is adequate — but a later screen wanting a plugin table in modification order has
no index to walk and no column to build one from, and the fix is a projection change
on the server, not here.

`by_media_item` is deliberately **not** compound on `table`. One range query returns a
media item's releases, roles and plugin detail row together, across tables — which is
the query the composition layer makes most, and it is one round trip rather than five.

Nesting the row under `value` rather than spreading it is what makes tombstones work.
IndexedDB skips a record whose index key path is absent, so a tombstone — having no
`value` — **drops out of all three `value.*` indexes automatically** while remaining
findable at `['table', id]`. That is §2.5's requirement met by the schema rather than
by a filter every read has to remember.

A second store, `meta`, holds one record per key: the two cursors, the generation
token and the store's own schema version.

## 4. Applying ops

One function, and the rules are the protocol's:

| Op | Rule |
|---|---|
| `create` | If any record exists at `['table', id]`, **including a tombstone**, do nothing. Otherwise put. |
| `upsert` | Put, replacing whatever is there. |
| `delete` | Put `{table, id}` with no `value`. |

**The cursor advance is in the same `readwrite` transaction as the ops it covers.**
Two transactions mean a crash between them either re-delivers a page — harmless, by
§2.6 — or skips one, which is silent permanent data loss. Only one of those outcomes
is acceptable, and the difference is one transaction boundary.

Subscribers fire **after** the transaction commits, never inside it. A handler that
reads would otherwise re-enter a live transaction, and the read it makes would see its
own batch half-applied.

## 5. Sync, and which tab does it

Cursors absent → `GET /api/sync/bootstrap` → `{since, before, generation}`. Then both
loops run concurrently, as the protocol intends: the tail from `since` upward on a
timer, the backfill from `before` downward at idle priority until it answers a null
cursor and retires.

One tab holds `navigator.locks.request('pickarr-sync', { mode: 'exclusive' })` for its
lifetime and is the only one that fetches. Followers read the same database and learn
of changes over a `BroadcastChannel`. When the leader's tab closes the lock releases
and another tab takes it with no coordination and no timeout to tune.

A follower promoted to leader **re-checks the generation before its first fetch**: it
may have been elected in the middle of a reset (§6).

## 6. Generation, and the reset

`2026-09-14-client-sync-design.md` assumed a client and a server that agree on what
library they are discussing. Nothing enforced it, and 2.0 rebuilds from an empty
database, so the disagreement is reachable by deleting one file: a client holding
`since = 5000` against a fresh log whose maximum id is 80 asks for ops above 5000,
receives nothing, and shows a stale library forever with no error. At a lower cursor
it is worse — new rows land at ids that collide with the stale replica's keys, and two
libraries merge silently.

So every sync response carries a `generation`, minted once per database. On a
mismatch, the leader:

1. Deletes `rows` and `meta`.
2. Re-bootstraps and writes the new cursors and token.
3. **Then** broadcasts `{ type: 'reset', generation }` — after the commit, so a tab
   re-reading sees a consistent store rather than a half-wiped one.

Only the leader can detect this, because only the leader fetches. That is precisely
why the broadcast is load-bearing rather than a courtesy: a follower cannot discover
on its own that what it is already displaying belongs to a database that no longer
exists.

Followers mid-read need no special handling. IndexedDB transaction isolation means a
`readonly` transaction completes against the old data or sees the new store, never a
torn mix.

## 7. The read surface, and where joining lives

The provider is row-level and plugin-blind:

```ts
getRow(table: string, id: number): Promise<unknown | undefined>   // undefined for a tombstone
getRows(table: string, ids: readonly number[]): Promise<Map<number, unknown>>
byMediaItem(mediaItemId: number): Promise<readonly StoredRow[]>   // every table
byRssItem(rssItemId: number): Promise<readonly StoredRow[]>
listByTable(table: string, opts: { fromUpdatedAt?: number; direction: 'next' | 'prev'; limit: number }): Promise<readonly StoredRow[]>
```

`listByTable` walks `by_table_updated`, so `fromUpdatedAt` is an `updatedAt` value and
not a row id — named for what it is, because `from` read as a cursor of unstated kind.
It is only callable for the five tables of §3.2; asking for one of the other seven is
a programming error and throws rather than returning an empty page, which would read
as "this table is empty".

Above it, joining splits the way the server does — by who owns the knowledge:

- **`store/gather.ts`, host-owned and plugin-blind.** Everything common to a media
  item: the item, its `rss_item` releases, the downloads under those, `role` and
  `person`, artwork URLs, `pluginId`, `feedId`. It knows the six host tables and
  nothing else, so adding a plugin never edits it.
- **`plugins/<id>/compose.ts`, one per plugin.** The gathered common part plus that
  plugin's own rows, producing what its cards show: `tv_series`/`tv_season` detail,
  `xxx_site` detail. Selected by `pluginId`, so the common path never branches on
  media type.

This is the seam the server already has, and keeping it means a new plugin is a new
directory rather than an edit to shared code.

## 8. Subscriptions

```ts
subscribe(table: string, id: number, cb: () => void): () => void
subscribeInserts(table: string, cb: (ids: readonly number[]) => void): () => void
subscribeReset(cb: () => void): () => void
```

The registry is `Map<'table:id', Set<cb>>`, so emitting costs one lookup per changed
row rather than a scan of every subscriber.

`subscribeInserts` exists because a per-row subscription cannot announce a row that
did not exist when it was registered — and delivering rows that did not exist is the
tail's entire job. A list subscribes to inserts on `media_item` and to each row it
currently holds; a card subscribes to its own rows.

`subscribeReset` is §6's broadcast. Every tab subscribes, the leader included, so
there is one code path rather than a leader's and a follower's.

## 9. Consequences

- **No screen works offline on a cold load**, because artwork comes from the network
  even when every row is local (§1.2). Every screen works offline on a warm one.
- **`feedId` and `downloadClientId` display as ids or not at all** (§2.4). The first
  component that wants a feed *name* forces a decision: sync `rss_feed`, or call the
  read API.
- **The provider cannot tell "not yet replicated" from "does not exist".** During a
  backfill those are the same answer — `undefined` — and the composition layer decides
  between a placeholder and a read-API call. Folding a remote fetch into `getRow`
  would make it impossible to tell from a call site whether a screen needs the
  network, which is the property §1.2 is protecting.
- **A reset is visible as data reloading**, not as an error. An operator who rebuilds
  the database gets a client that recovers by itself; the console says why.
- **Two obligations now live in one function.** §4's `create` and `delete` rules are
  the whole of what the server cannot enforce. If `apply` is wrong, a stale backfill
  page overwrites newer state or resurrects a deleted row, and nothing server-side
  will ever notice.

## 10. What the tests must prove

1. A `create` for a row already held is a no-op — value unchanged.
2. A `create` for a row held **as a tombstone** is a no-op, and the tombstone stands.
3. A `delete` leaves a tombstone: `getRow` answers `undefined`, and the record is
   still at its key.
4. A tombstone appears in no `value.*` index query.
5. An `upsert` over a tombstone revives the row.
6. Ops and the cursor advance commit together: a transaction aborted mid-batch leaves
   neither.
7. Applying one page twice leaves the store identical (§2.6).
8. Two appliers interleaved over the same page converge.
9. `byMediaItem` returns rows from several tables in one query.
10. A subscriber fires after commit, and a subscriber that reads inside its callback
    sees the whole batch.
11. `subscribeInserts` reports a row that no subscription covered.
12. A mismatched `generation` wipes, re-bootstraps and broadcasts, in that order.
13. A follower promoted mid-reset re-checks the generation before fetching.
14. Only the lock holder fetches; a second tab with no lock fetches nothing.
15. The backfill retires on a null cursor and the tail keeps running.

## 11. Testing approach

`fake-indexeddb` as a dev dependency — happy-dom provides no IndexedDB. Web Locks and
`BroadcastChannel` are stubbed, and the stubs are part of the test surface rather than
ambient: property 14 is about the lease, so a test that cannot deny the lock cannot
assert it.

The existing web suite's hazards apply in full and are in `CLAUDE.md`. The two that
bite hardest here: never hand a live object to `node:assert` as an operand, and a
timing assertion spies on the real `setTimeout` rather than replacing it, because fake
timers hang this suite.
