# Pickarr 2.0 Slice B — The Feed Reader, and Artwork Through the Double

The second slice of the 2.0 backend. Slice A built a contract and the machinery
under it, with a test double as its only consumer and **nothing feeding it** —
no code creates `rss_item` rows, so `notifyNewRssItems` has never been called
outside a test. This slice supplies the producer, turns the fetch subsystem into
something worth having, and proves the artwork path end to end without building
a real provider integration.

It is also the first 2.0 code that runs unattended.

## 1. What this delivers

- A **feed reader**: poll a feed, parse it, insert what is new, notify the owning
  plugin.
- A **real fetch subsystem**: per-hostname queues with a configurable
  concurrency, replacing slice A's hard-wired one-at-a-time chain.
- An **artwork path**: the double fetches predetermined images, and
  `MediaWriter` measures and caches them.
- A **runnable host process** with a pump, so jobs run because the host is up
  rather than because a test called `runOnce`.

### 1.1 The decisions taken before this spec

- **Feeds are rows, seeded — there is no config surface.** Slice A made
  `rss_feed` a table (`rss_item.feed_id` is an integer foreign key, and dispatch
  reads the feed row to find the owning plugin), while 1.x kept feeds in a JSON
  config at `PICKARR_CONFIG`. This slice does not port that config. A seed
  script inserts rows; the reader polls whatever rows exist. Feed management
  belongs to the API slice. The consequence is accepted deliberately: a fresh
  install polls nothing until someone seeds a feed.
- **An item is identified by `(feed_id, guid)`.** 1.x already learned this — its
  `FeedEntry` is `{ guid, title, link, publishedAt }`. `rss_item` has no `guid`
  column yet, so the migration adds one. A feed that omits `guid` falls back to
  the link, because RSS does not require one.
- **Fetch concurrency belongs to the fetch subsystem, not the job runner.** A
  single job may hand the subsystem twenty requests; the subsystem decides how
  many go out per host. Jobs therefore stay **serial** — one pump, no worker
  pool — until something needs otherwise.
- **Artwork bytes are cached to disk beside the database**, as in 1.x, so images
  survive a container recreation inside the `/config` volume.
- **`MediaWriter` writes the file and the row together.** It takes bytes, not
  dimensions. 1.x needed a repair script — `reclassify-artwork` — precisely
  because a row and its file could disagree, and it had to move "row, url and
  path together". One writer for the pair removes that failure by construction.
- **Jobs are the scheduler.** A `poll` job re-enqueues itself with
  `runAt: now + interval`. Nothing about the schedule lives in memory.
- **Still no real plugin.** The double remains the only consumer, augmented with
  an artwork step. A real plugin is its own slice.

### 1.2 What this slice is not

- **No provider integration.** The double's images come from a predetermined
  list served by its fake service, not from a metadata provider. Credentials,
  rate limits and provider-specific artwork endpoints are the real plugin's
  problem.
- **No backfill.** 1.x walks a feed's history with a `feed_backfill` table and
  indexer paging hints it is told rather than detects. This slice reads the
  front page only. Backfill is additive later.
- **No read API and no client work.** Nothing serves the cached images yet; they
  are on disk and in rows, and the API slice exposes them.
- **No download clients.** `rss_feed.download_client_id` stays unread.

## 2. The fetch subsystem becomes real queues

Slice A's `createHostFetch` keys a `Map<string, Promise<unknown>>` and chains
each request onto the previous one's *gate*. That gives a concurrency of exactly
one per hostname, with nothing to tune, and the design cannot generalise: a chain
expresses "after the last one", not "while fewer than N are running".

This slice replaces it with a queue per hostname holding a running count and a
list of waiters — the shape of `async`'s `queue`. Each queue has a concurrency,
resolved when the hostname is first seen:

```ts
export interface FetchLimits {
  /** Applied to any hostname without a specific entry. */
  default: number;
  /** Keyed by exact hostname, e.g. `{ 'cdn.example.com': 10 }`. */
  perHost?: Readonly<Record<string, number>>;
}
export function createHostFetch(deps: {
  fetch: typeof globalThis.fetch;
  limits?: FetchLimits;
}): HostFetch;
```

**The default is 1**, so behaviour is unchanged until someone raises it. Nothing
in this slice sets `perHost`; the knob exists because the tuning it enables —
a CDN at 10, an API at 1 — is the reason the subsystem is shaped this way.

Two properties from slice A must survive, and both are already tested:

- The hostname is derived from the url inside the queue, never supplied by the
  caller, so a plugin cannot opt out of the limit.
- **A rejected request must release its slot.** Slice A's `finally` exists for
  this, and dropping it wedges a hostname permanently and silently. With a
  running count instead of a chain the same hazard applies to the decrement,
  and it is the single most important thing to test here.

`HostFetch` itself is unchanged — still `json<T>` and `bytes`. But
`packages/contract/src/fetch.ts`'s doc comment promises "one active at a time
per host" as a property of the system. That promise is now configurable, so the
comment must say so.

## 3. The feed reader

A `poll` job per feed. Reading RSS is shared infrastructure, so the handler is
the host's — but `jobs.plugin_id` is `NOT NULL` and handlers are keyed by
`(pluginId, kind)`, so a job with no plugin cannot be expressed.

**The host claims the reserved plugin id `host`.** It registers its own handlers
under that id, and `register` refuses a `MediaPlugin` whose id is `host` so the
namespace cannot be taken. This keeps the dispatch table one shape rather than
adding a parallel path for host jobs, and keeps `plugin_id` meaning "whose
handler runs this" for every row. The reserved id declares no tables, so
`migratePlugin`'s prefix rule never applies to it.

**Fetching.** Through `ctx.fetch`-equivalent host fetch, so a feed's host is
rate-limited like any other. 1.x uses a 30 second timeout; this slice keeps that
number.

**Parsing.** 1.x's `parse-rss.ts` uses `fast-xml-parser` and yields
`{ guid, title, link, publishedAt }`. This slice re-implements that shape rather
than importing it — 1.x is deployed and must not be touched, and the 2.0 reader
wants `filename` where 1.x wants `title`. The parser is a pure function from XML
text to entries, which makes it cheap to test against real feed samples.

**What a row needs that an entry does not carry.** `rss_item.download_type` is
`NOT NULL` and nothing supplies it: it is absent from `rss_feed`, and 1.x carried
it in feed config. It goes on the feed as
`download_type TEXT NOT NULL` holding `torrent` or `usenet`, since an indexer
feed is one or the other throughout. `poll_interval_s INTEGER NOT NULL` joins it,
so feeds can differ without a config file.

**`published_at` is deliberately omitted.** 1.x parses it; nothing here orders by
it, and `created_at` records when we first saw the item. Adding a column nothing
reads is the smell this project keeps finding.

## 4. Item identity and the insert path

The reader inserts with
`INSERT ... ON CONFLICT (feed_id, guid) DO NOTHING RETURNING id`, which yields a
row **only for entries it actually inserted** — a conflicted entry returns
nothing at all. Those returned ids, and no others, reach `notifyNewRssItems`.

This is the correctness core of the slice. A poll that re-notifies every item it
sees would re-run a lookup for the whole feed on every cycle, and the parser
service is a paid dependency. Two mistakes produce that, and each needs its own
test:

- collecting ids by re-selecting the feed's rows rather than by taking what the
  insert returned, and
- treating a conflicted insert as an insert.

`notifyNewRssItems` returns `{ unowned, failures }`, and slice A recorded a
condition against this exact moment: it had no caller, so nothing forced anyone
to read either field. **The reader is that caller and must read both.** An
unowned id means a feed names a plugin that is not registered, which is a
seeding error worth surfacing loudly; a failure means a plugin threw. Neither
may be dropped on the floor.

## 5. The pump and the process

An entry point that opens the database, migrates, registers plugins, and then
loops:

```
while (running) {
  if (!await host.runOnce()) await sleep(1_000);
}
```

`runOnce` returns false when nothing is ready, which is what makes a sleep
correct rather than a guess. `recover()` runs once at startup — that is what it
is for, and slice A's runner already dead-letters a job that a crash left at its
last attempt rather than readying it forever.

Shutdown drains: stop claiming new jobs on `SIGINT`/`SIGTERM`, let the in-flight
one finish, then close the database. A job killed mid-flight is safe — that is
what `recover()` handles — but draining makes the common case clean.

**The poll job reschedules itself as its last act.** If that enqueue is lost, the
feed stops forever, and nothing else in the system would notice. A test must kill
a poll job's re-enqueue and assert the feed goes quiet, because a suite where
every job succeeds cannot see this.

## 6. Artwork: fetch, measure, cache

The double's fake service returns a predetermined list of image urls. The
double's `artwork` job fetches each through the host fetch — different hosts
proceeding in parallel is the first real use of §2 — and hands the bytes to
`MediaWriter`.

**Measuring, not trusting.** 1.x's `classifyArtwork` reads the bytes with
`image-size` and calls anything wider than it is tall a background, anything else
a poster, and `null` when the bytes cannot be measured. It exists because
migration 15 had to classify by url shape and left the ambiguous remainder filed
as posters, which `reclassify-artwork` then repaired by measuring cached files
offline. 2.0 measures on the way in, so the repair script has no reason to exist.

`poster`, `background` and `logo` all have `width` and `height` as `NOT NULL`.
Because `MediaWriter` measures, a caller cannot supply a wrong dimension — the
fields leave the init types entirely.

**Unmeasurable bytes are refused, not guessed.** `image-size` throwing means the
response was not an image: an html error page served with status 200, or a
truncated download. Storing that as a poster with invented dimensions is how 1.x
got rows it later had to repair. The attach rejects and the job retries.

**The cache directory** defaults to `artwork/` beside the database file, matching
1.x's `resolveArtworkDir`, so it sits inside the documented `/config` volume.

**Deleting a row deletes its file.** `dropMediaItem` already removes a media item
that lost a provider-ref claim; its artwork rows go with it, and now so do their
files. An orphaned file is a leak; an orphaned row is worse, because something
will try to serve it.

## 7. `MediaWriter`'s new surface

Three changes, all to the artwork methods:

```ts
export interface ImageInit {
  /** Where it came from, kept so a re-fetch is possible. */
  url: string;
  title: string | null;
  language: string | null;
  /** Measured here; never supplied. */
  bytes: Uint8Array;
}
attachPoster(mediaItemId: number, image: ImageInit): Promise<void>;
attachBackground(mediaItemId: number, image: ImageInit): Promise<void>;
attachLogo(mediaItemId: number, image: ImageInit): Promise<void>;
```

`attachLogo` is new. `logo` is the one artwork table slice A left with **no
writer at all and no unique index**, so it also gains
`UNIQUE (media_item_id, url)` to match its siblings — the index that makes a
re-run idempotent rather than duplicating rows, which is the defect the whole of
slice A's final review turned on.

`background`'s `description` column has no home in `ImageInit` and nothing writes
it. It is left unwritten rather than given a field no caller would fill.

This makes `MediaWriter` do filesystem I/O for the first time. That is the cost
of one writer for the row-and-file pair, and it is the right trade: the
alternative is two writers that can disagree, which 1.x proved is not
theoretical.

## 8. Migration, and a condition that comes due

`HOST_MIGRATIONS` gains **version 2**:

- `rss_item.guid TEXT`, with `UNIQUE (feed_id, guid)`
- `path TEXT` on `poster`, `background` and `logo`
- `UNIQUE (media_item_id, url)` on `logo`
- `download_type TEXT NOT NULL` and `poll_interval_s INTEGER NOT NULL` on
  `rss_feed`. Both need a default or a backfill value, since the table may
  already hold seeded rows.

**`migrateHost` must be made atomic first.** Slice A recorded this as a condition
with two triggers — "before a production startup calls `openDatabase`, or
`HOST_MIGRATIONS` gains a version 2" — and this slice trips both. Today it
`exec`s the schema and records the version in a separate statement, so a crash
between them leaves a database that fails every later boot on
`table download_client already exists`. `migratePlugin` was fixed with a
savepoint; this is the same fix on its sibling, sixty lines away.

Because 2.0 is greenfield and rebuilds from feeds, an existing database may
simply be deleted instead of migrated. The migration is written properly anyway:
the version table is the mechanism the host uses for every future change, and a
version 2 that only works on an empty database teaches the wrong lesson to
version 3.

## 9. The flows

**Polling.** The pump claims a `poll` job whose `run_at` has passed. The reader
fetches the feed through its hostname's queue, parses entries, inserts with
`ON CONFLICT DO NOTHING`, and calls `notifyNewRssItems` with the inserted ids
only. It reads both fields of the outcome. It re-enqueues itself at
`now + interval`.

**Lookup**, unchanged from slice A: the plugin enqueues `lookup`, the handler
batches names to the parser service, and each entry's own `status` and `partial`
flag decide its fate. A batch always answers HTTP 200, so the response arriving
says nothing about whether the answers did.

**Artwork.** On resolving an item, the plugin enqueues `artwork` carrying the
media item id and the urls. The handler fetches each, and calls the matching
attach. Failure retries with the runner's backoff; exhaustion dead-letters,
leaving a media item with no artwork rather than no media item.

## 10. Testing

The two properties most likely to break silently, and least likely to be caught
by a green suite:

1. **A re-poll notifies nothing.** Poll the same feed twice against an unchanged
   feed body and assert `notifyNewRssItems` is called with an empty id list the
   second time — and that no new `rss_item` rows appeared. Then poll with one
   added entry and assert exactly that one id is handed over.
2. **A rejected fetch releases its slot.** With a concurrency of 1, make the
   first request reject and assert a second request to the *same* hostname still
   runs. With a concurrency of 2, assert two run at once and a third waits.
   Concurrency must be asserted by counting in-flight calls, never by timing.

Also: a poll job that loses its re-enqueue goes quiet (§5); unmeasurable bytes
are refused rather than stored (§6); a dropped media item takes its artwork files
with it (§6); attaching the same url twice leaves one row and one file (§7); and
a `version 2` migration that throws leaves no trace (§8).

The double's artwork step exercises `attachPoster` and `attachBackground`, which
slice A shipped with **no test calling them at all**.

## 11. Consequences, and what stays open

- **The fetch subsystem stops being decoration.** Slice A's review called the
  per-hostname queue "correct, but barely load-bearing yet". Artwork fetching
  across several hosts is the workload that makes it matter.
- **The process can now lose data by not running.** A feed's items exist only if
  something polled while they were on the front page. Without backfill (§1.2),
  downtime longer than a feed's front page is a gap that never fills. That is
  acceptable for 2.0's rebuild-from-feeds model and worth stating plainly.
- **`PluginContext` still has no clock.** The double stamps its own rows with its
  own clock while `MediaWriter` uses the host's injected one, inside one logical
  write. Slice A recorded this; it is not fixed here, and the host has two clocks
  until it is.
- **`ctx.db` is still the whole raw connection**, so the one-writer rule stays a
  convention. Artwork makes it slightly worse in principle — a plugin could write
  a `poster` row with a path to a file that does not exist — and slightly better
  in practice, because the only sanctioned path now writes both together.
- **Nothing reads any of it.** Shared tables still have writers and no readers.
  Cached images sit on disk with no route serving them until the API slice.
