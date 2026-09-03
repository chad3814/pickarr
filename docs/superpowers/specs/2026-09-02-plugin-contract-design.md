# Pickarr 2.0 — The Plugin Contract and the Event Spine

The first slice of the 2.0 backend. It defines what a media plugin is, what the
host gives it, what the host asks of it, and the durable machinery that carries a
multi-hop flow across a restart. It ships no real plugin.

**Section 12 supersedes anything below that it contradicts.** The slice is built,
and implementing it disproved several claims made here in advance. They are
corrected in place where leaving them would mislead, and logged in 12 either way.

## 1. What this delivers

Pickarr 2.0 splits into shared infrastructure — RSS reading, download clients,
external fetching — and plugin processors, which parse names, retrieve metadata
and react to download state. That split exists in 1.x by convention. This slice
makes it structural: a contract, the services behind it, and a job runner.

### 1.1 The decisions taken before this spec

Recorded because each closes off alternatives a reader would otherwise wonder
about.

- **Greenfield.** 2.0 starts on an empty database and rebuilds from feeds.
  Nothing migrates. The new model owes the old one nothing.
- **Contract before model.** The tables are derived from what the flows need
  rather than designed first, because the flows are what we understand.
- **Plugins own their workflows; the host provides services.** The alternative —
  a host-driven pipeline calling pure plugin functions — was considered and
  rejected. See §3.
- **A durable job table**, not in-memory work and not row-state reconciliation.
- **Drizzle ORM 1.0-rc**, with each plugin exporting its own schema and
  migrations. See §7, which records what was verified rather than assumed.
- **Shared tables have one writer.** Plugins use Drizzle freely on their own
  tables and call narrow host operations for shared rows. See §4.

### 1.2 What this slice is not

- **No real plugin.** Its consumer is a test double (§10).
- **No images.** The parser service returns no image URLs at all, so artwork
  comes from providers directly — separate credentials, separate hosts, and the
  artwork-classification problem 1.x already solved once. Own slice.
- **No download-client integration.** `onDownloadedFile` is in the contract
  because a plugin must be able to react, but the scanner that calls it is its
  own slice.
- **No client or protocol work.** Pagination, update deltas and the websocket
  question all come later.

## 2. Why the contract changes shape

1.x's `MediaTypePlugin` (`packages/plugin-api/src/types.ts:186-314`) has **16
members: two `readonly` properties, three required methods and eleven optional
ones.** Every method is a pure synchronous function. `parse(name)` returns a
`ParsedRelease | null`. `metadataQuery(group)` returns a query the **host**
executes. `confirmMetadata(candidates, query)` receives candidates the host
fetched. The scenes plugin touches the database not at all — no `DatabaseSync`,
no SQL, nothing.

So the boundary 2.0 wants is already there, and it is good. Two things defeat it:

**Eleven optional methods is not one contract.** It is several fused together,
each plugin implementing a different subset, with nothing in the type saying
which combinations are coherent. A reader cannot tell whether a plugin
implementing `siteCandidates` but not `learnSites` is valid.

**Nothing in it is asynchronous.** 2.0's flows are: create rows, batch lookup,
possibly poll a `202`, update rows, fetch images, maybe auto-download. A contract
of pure synchronous functions cannot express that, and the host driving it would
have to know each plugin's hop sequence.

## 3. What the host asks of a plugin

```ts
interface MediaPlugin {
  /** Also the required prefix for every table this plugin declares. */
  readonly id: string;
  readonly mediaType: 'tv' | 'movie' | 'xxx' | 'book';
  /** Drizzle schema for this plugin's own tables. */
  readonly schema: PluginSchema;
  readonly migrations: readonly Migration[];
  /** Handlers for the job kinds this plugin enqueues. Keys are kind names. */
  readonly jobs: Readonly<Record<string, JobHandler>>;

  onNewRssItems(ids: readonly number[], ctx: PluginContext): Promise<void>;
  onDownloadedFile(file: DownloadedFile, ctx: PluginContext): Promise<void>;
  onDownloadRequest(rssItemId: number, ctx: PluginContext): Promise<void>;
}
```

**Three entry points, none optional.** If a plugin cannot answer all three it is
not a plugin.

**This does not reduce the number of entry points, and an earlier draft of this
spec wrongly claimed it did.** A plugin's `jobs` map is open-ended: one with
eleven job kinds has eleven entry points, sitting behind `JobHandler` instead of
in the interface. The surface moves; it does not shrink. Three things do change,
and they are the actual argument:

- **The host's coupling stops growing.** `MediaPlugin` is fixed at three methods
  no matter how elaborate a plugin's flow becomes. In 1.x every new plugin need
  meant a new optional method on a type the host and all plugins shared.
- **The handlers are uniform.** Every one is `(payload, ctx) => Promise<void>`,
  retryable, and required to be idempotent. The eleven optional methods each had
  a bespoke signature, and nothing in the type said which combinations were
  coherent — whether `siteCandidates` without `learnSites` was valid was
  unanswerable from the type.
- **Optionality is gone.** A job kind a plugin enqueues but does not handle is a
  dead-letter row with `last_error` set, not a silently absent method. The
  failure is visible where the old one was invisible.

**Why plugins own the flow rather than the host.** The rejected alternative kept
plugins pure and had the host run a fixed pipeline, calling the plugin at
decision points. It is a cleaner boundary — a plugin given no IO cannot do IO.
It was rejected because the flows differ per media type in ways a fixed pipeline
would have to anticipate: books may not use the parser service at all, tv resolves
through a season and series hierarchy that movies have no analogue for, and xxx
needs a site lookup none of the others do. A host pipeline general enough to
cover those is a pipeline with a plugin hook at every step, which is the
seventeen-method problem wearing a different hat.

The cost of plugins owning flows is normally four copies of retry logic. §5
removes that cost: the job runner is host infrastructure, so backoff, attempt
limits and dead-lettering are written once and plugins only supply what each job
*does*.

## 4. What the host hands a plugin

```ts
interface PluginContext {
  /** Drizzle, bound to this plugin's own tables only. */
  db: PluginDatabase;
  /** The only way to write shared rows. */
  media: MediaWriter;
  jobs: JobQueue;
  fetch: HostFetch;
  downloads: DownloadClients;
  log: Logger;
}
```

The rule is short enough to remember: **your tables, your Drizzle; shared
tables, my functions.**

`MediaWriter` exists because two invariants would otherwise be re-implemented in
every plugin:

```ts
interface MediaWriter {
  createMediaItem(init: MediaItemInit): Promise<number>;
  /**
   * The dedup. If a media item already exists for (provider, providerRef),
   * returns it and the caller's item is dropped; otherwise claims the ref.
   * A unique index on (provider, provider_ref) makes the race a constraint
   * violation rather than two rows.
   */
  claimProviderRef(mediaItemId: number, provider: string, ref: string):
    Promise<{ kept: number; dropped: number | null }>;
  /** Repoints an rss item at a different media item. */
  relinkRssItem(rssItemId: number, mediaItemId: number): Promise<void>;
  attachPoster(mediaItemId: number, poster: PosterInit): Promise<void>;
  attachBackground(mediaItemId: number, background: BackgroundInit): Promise<void>;
  upsertPerson(person: PersonInit): Promise<number>;
  attachRole(mediaItemId: number, role: RoleInit): Promise<void>;
  setResolution(rssItemId: number, resolution: Resolution, detail?: string): Promise<void>;
}
```

`claimProviderRef` is the load-bearing one. The flow's dedup step — *search for
an existing item matching the provider id; if one exists, repoint the rss item
and drop the new media item* — is a race whenever two rss items resolve to the
same reference at once. Making it one host operation over a unique index turns
that race into a constraint violation the operation itself resolves, instead of
four plugins each hoping to lose it gracefully.

## 5. The job runner

```
jobs(
  id INTEGER PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  run_at INTEGER NOT NULL,
  state TEXT NOT NULL,          -- ready | running | done | dead
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

Single-process, so a claim is one transactional statement: `UPDATE jobs SET
state='running' WHERE id = (SELECT id FROM jobs WHERE state='ready' AND run_at <=
:now ORDER BY run_at, id LIMIT 1) RETURNING *`. Retry is exponential backoff
written to `run_at`. Past `max_attempts` a job goes `dead` and **stays** — a
dead-letter row that can be read, not a log line that scrolls away.

`state='running'` at startup means the process died mid-job. Those are returned
to `ready`: every handler must therefore be safe to run twice, which is a
requirement on handlers rather than a promise from the runner.

No ordering guarantee beyond `(run_at, id)`. The flows are per-item, so none is
needed, and promising one would constrain the runner for nothing.

## 6. The per-hostname fetch queue

```ts
interface HostFetch {
  json<T>(url: string, init?: RequestInit): Promise<T>;
  bytes(url: string, init?: RequestInit): Promise<Uint8Array>;
}
```

One active request per hostname, others queued behind it. The hostname is
derived from the URL, so a plugin cannot accidentally opt out. This is the only
way a plugin reaches the network, which is what makes "one at a time per host" a
property of the system rather than a habit.

Serialising per host means a slow host delays only its own queue. A job waiting
on the queue holds its `running` claim, so a host that hangs holds one job, not
the runner.

## 7. Persistence: Drizzle 1.0-rc, verified

Every claim here was tested, because the driver we need is not in the released
version.

- **`node:sqlite` support exists only on the 1.0 pre-release line.** `latest` is
  `0.45.2` and exports no such driver; `1.0.0-rc.4` exports
  `./node-sqlite/{driver,session,migrator}`. The published documentation
  describes 1.0. **Pin the exact rc.**
- **It accepts an existing connection**: `drizzle({ client: myDatabaseSync })`.
  Passing the handle positionally silently opens a *separate* database — with
  `:memory:` that is two databases and a confusing "no such table". Adoption is
  therefore incremental: we keep our own connection, our own PRAGMAs, and raw SQL
  wherever the builder fights us.
- **A partial index survives**, which matters because 1.x's
  `feed_items_failed (first_seen_at DESC, id) WHERE parse_error IS NOT NULL` is
  the kind of thing an ORM usually cannot express. Declared as
  `index(...).on(desc(t.firstSeenAt), t.id).where(sql\`... IS NOT NULL\`)`, it
  typechecks and `drizzle-kit generate` emits
  `CREATE INDEX ... ("first_seen_at" desc, \`id\`) WHERE ... IS NOT NULL`.
- **A keyset comparison survives**: `(sortKey DESC, id ASC)` strictly after a
  boundary, built from `and`/`or`/`lt`/`gt`, returns the right rows.
- **Drizzle's own `.d.ts` files fail `exactOptionalPropertyTypes`**, which this
  project sets. `tsconfig.base.json` already sets `skipLibCheck: true`, so this
  is invisible — but it is why that setting must stay on.
- **`drizzle-kit generate` is repo-scoped**, reading schema by glob. Workspace
  plugins under `packages/plugin-*/src/schema.ts` are covered. A genuinely
  third-party plugin would have to ship its own migration folder for the host to
  apply, which is a second mechanism and is out of scope until one exists.

Plugins are **wired explicitly**, as in 1.x — constructed and registered in the
host's startup, not discovered from a directory or a config glob. That is what
keeps the migration story above simple: every plugin is a workspace package the
generator can already see. Genuine drop-in plugins would need each to ship its
own generated migration folder, and that is deferred until one exists.

Plugin tables must be prefixed with the plugin id (`xxx_site`, `tv_season`), and
plugin migrations run after the host's, because plugin tables reference
`media_item`.

**Ids are SQLite integer rowids**, as in 1.x (`id INTEGER PRIMARY KEY`), not
uuids. This is not incidental: the read API's stated flow — "the client provides
a media type and the last media item id it has" — is keyset pagination, which
needs ids that are monotonic and orderable. The parser service's own ids are
uuids; those are stored as provider references, never adopted as our keys.

## 8. Three findings from the parser service, as decisions

The service is `https://media-name-parser.vercel.app`; its OpenAPI defines
`POST /api/v1/lookup` taking one `{category, name}` or `{items: [...]}` up to
100, and `GET /api/v1/lookup/{id}`.

**`partial: true` gets its own hop, and it is per item rather than per
response.** A *single* lookup that runs out of time answers HTTP `202`. A
**batch always answers 200**, with each entry carrying its own `status` and its
own `partial` flag — so the response arriving tells you nothing about whether the
answers did. Since we always batch, the `202` status never reaches us at the HTTP
level and **every result must be scanned individually for `partial`**.

The flow as first described — "when the request returns, update the media items"
— had no step for an answer that has not arrived. The lookup handler, seeing a
`partial` entry, enqueues a **poll** job carrying that entry's `lookupId`, with
backoff. Other entries in the same batch proceed immediately. This is what the
durable table is for.

**`refusal` and `unresolved` are different, and neither is an error.** A subtitle
or sidecar answers `state: resolved` with a `refusal` string: that is a
*successful* identification of a non-media file. `unresolved` means the name was
not recognised.

**Refusals should be rare here**, because feeds hand us media filenames rather
than the contents of a completed download — so this is a state to handle, not a
state to expect. The reason to build it anyway is that the alternative to
handling it is misfiling it: without a distinct state, a refusal has to land in
`unresolved`, where it would be retried forever and shown to a reader as a
problem they cannot fix. So `rss_item.resolution` is
`pending | resolved | refused | unresolved`:

| Resolution | Meaning | Retried | Shown as a problem |
|---|---|---|---|
| `pending` | not yet looked up | — | no |
| `resolved` | identified, media rows exist | no | no |
| `refused` | identified as not media | **no** | **no** |
| `unresolved` | not recognised | on request | yes |

`unresolved` is the direct descendant of 1.x's "failed to parse". `refused` has
no 1.x equivalent and must not be conflated with it: retrying a subtitle forever,
or showing it to a reader as a failure, are both wrong.

**Books are the weakest fit.** The service's provider enum is `tmdb | ibdb |
tpdb`, while the book media shape wants isbn10, isbn13, asin, a hardcover id and
a tbdb id. `books` is in its category enum, but the book plugin should be
expected to reach past this service in a way tv, movie and xxx do not — which is
an argument for plugins owning their flows (§3) rather than against it.

## 9. The flows

**New items.** The host's feed reader inserts `rss_item` rows and calls
`onNewRssItems(ids)`, which returns `{ unowned, failures }` — both fields are data
the caller must read, not exceptions. The plugin enqueues one `lookup` job per
batch of up to 100 and **creates nothing yet**.

The media item is created in the `lookup` handler's resolved branch, once the
answer is in hand. This is a correction: an earlier draft of this section had the
plugin create the media item here, before the lookup. That is not implementable —
`MediaWriter` has no method to update a media item, so a row created before the
answer arrives could never receive the looked-up title. Creating early would also
require being able to *unlink* an rss item in order to refuse one, which the
contract cannot express either (see 12).

The `lookup` handler calls the parser service through `ctx.fetch`, then per
result: `refusal` → `setResolution(refused)`; `unresolved` → `setResolution(unresolved)`;
`partial` → enqueue `poll`; resolved → `claimProviderRef`, and if an existing
item was kept, `relinkRssItem` onto it and drop the new one. Then
`setResolution(resolved)`, write the specific row's provider fields, `upsertPerson`
and `attachRole` for each person, and enqueue whatever the plugin does next —
images once slice B exists, an auto-download if the plugin wants one.

**A download request.** The client sends an rss item id. The host resolves which
feed it came from, and therefore which plugin, and calls
`onDownloadRequest(rssItemId)`. The plugin enqueues its own job, which submits to
the right download client through `ctx.downloads`.

**A downloaded file.** Out of scope here; `onDownloadedFile` exists so the
scanner slice has something to call.

## 10. Testing

The contract's consumer in this slice is a **test-double plugin** that implements
all three entry points and runs the full new-items flow against a fake feed and a
fake parser service. It must exercise: a resolved item, a refusal, an unresolved
item, a `202` followed by a poll, and two items resolving to the same provider ref
so `claimProviderRef` has a winner and a loser.

Beyond that:

- **The job runner survives a restart.** A job left `running` returns to `ready`,
  and a handler that runs twice does not double-write. Test by claiming a job,
  discarding the runner, and starting a new one.
- **Backoff and dead-lettering.** A handler that always throws reaches `dead`
  after `max_attempts` and its row remains with `last_error` set.
- **The fetch queue serialises per host.** Two concurrent requests to one
  hostname do not overlap; requests to different hostnames do. Assert on
  observed concurrency, not on elapsed time.
- **`claimProviderRef` under contention.** Two writers, same ref: one keeps, one
  is told what it lost to. The unique index is what makes this deterministic, so
  the test must run against the real index.
- **Plugin migrations apply and are tracked per plugin.** A plugin added later
  runs only its own migrations.

Every rule with more than one branch is mutation-checked per branch: break that
branch, prove that test and no other fails.

## 11. Consequences

- **The contract is validated by a double, not a plugin.** The first real plugin
  will find something this slice got wrong. That is the accepted cost of
  designing the contract first, and the risk is bounded by the double covering
  all five flow outcomes rather than the happy path.
- **Every job handler must be idempotent**, because crash recovery re-runs
  claimed jobs. That is a real constraint on plugin authors and belongs in the
  contract's documentation, not just here.
- **A pre-release dependency sits under persistence.** Bounded by keeping our own
  `DatabaseSync` and raw SQL always available, but if 1.0 stalls we are on an rc
  indefinitely.
- **Plugins can write shared rows only through `MediaWriter`**, so any shared-row
  capability a plugin needs and does not have becomes a host change. That is the
  intended trade: the shared model keeps one writer.

## 12. Corrections from implementation

This section is authoritative where it contradicts anything above. Every entry
was found by building the slice — the test-double plugin of Task 7 exists to
surface exactly this, and it earned its place.

### 12.1 What the contract cannot express

Three gaps, all verified in code rather than argued. None breaks the delivered
slice; each is the first thing a real plugin will want.

- **`MediaWriter` cannot update a media item.** This is what makes the original
  9 flow impossible, and 9 has been corrected. Whether to add
  `updateMediaItem` or keep create-when-resolved is a decision for the first
  real plugin, not for a double.
- **An rss item cannot be unlinked.** `relinkRssItem` takes a non-null id and
  `rss_item.media_item_id` carries a foreign key, so `dropMediaItem` throws
  (`errcode 787`) while any item still points at the row. The consequence is
  wider than "cannot refuse after linking": **any row ever linked pins its media
  item permanently.** The fix is a signature change — `mediaItemId: number |
  null` — rather than a new method.
- **`PluginContext` has no clock.** A plugin's own rows would be stamped
  `Date.now()` while `MediaWriter`'s come from the host's injected `now`, inside
  one logical write. The double had to be constructed with its own clock; without
  it, Task 7's crash test could not compare rows at all. Note the host itself has
  two clocks today — `migrate.ts` stamps `applied_at` with `Date.now()` — so this
  wants fixing in one pass or the inconsistency merely moves.

### 12.2 The one-writer rule is convention, not enforcement

4 and 11 say plugins write shared rows only through `MediaWriter`. That is not
enforced and cannot be, as built: `ctx.db` is the whole raw `node:sqlite`
connection, so a plugin can insert a `jobs` row under **another plugin's**
`plugin_id` and have the victim's handler run it, and can rewrite any `rss_item`.

The `Runner.enqueue(pluginId, job)` seam does hold through the contract API — a
plugin's `ctx.jobs` closes over its own id and cannot name another's. The raw
handle goes around the seam rather than through it. `MediaWriter` is also
plugin-agnostic: eight of its nine methods take no plugin id at all, and the
ninth stores one without checking it, so `setResolution` and `dropMediaItem`
reach another plugin's rows through the sanctioned API.

Real enforcement needs a restricted per-plugin handle. That is design work for
the slice that ships real plugins; until then the rule is a convention, and this
paragraph exists so nobody mistakes it for a guarantee.

### 12.3 Corrections to the claims above

| § | Said | Actually | 
|---|---|---|
| 3 | `MediaPlugin` has `readonly schema: PluginSchema` | No such member, and **nothing named `PluginSchema` exists**. The host cannot use it and the double proves a plugin does not need it. Dropped. |
| 4 | `db: PluginDatabase`, "Drizzle bound to this plugin's own tables only" | `db: unknown`, the whole raw connection. See 12.2. |
| 4 | `log: Logger` | An inline `(message, detail?) => void`. |
| 4 | `MediaWriter` has 8 methods; `setResolution(…, detail?)` | Nine methods — `dropMediaItem` was added — and `detail` is a required `string \| null`, because `exactOptionalPropertyTypes` makes an optional property mean something different. |
| 5 | "a claim is one transactional statement" | It is now. It was two, and a crash between them readied a process-killing job forever. 5 also omits that `recover` dead-letters a row already at its last attempt. |
| 6 | "a host that hangs holds one job, not the runner" | False as built: `runOnce` is the only pump and it is serial, so a hung handler holds the only worker. The sentence describes a pool a later slice adds. No deadlock exists in the delivered flow. |
| 7 | `drizzle-kit generate` is repo-scoped and covers plugin schemas | No drizzle config exists and `drizzle-kit` is unused. Migrations are hand-written. |
| 7 | "plugin migrations run after the host's" | Unenforced. Registering a plugin before `migrateHost` succeeds, creates a table with a dangling foreign key, and records the version as applied — so a mis-ordered startup is permanent. |
| 9 | "one `lookup` job per batch of up to 100" | The double enqueues one job whatever the batch size, disclosed in its own comment. It is a double; a real plugin must honour the cap. |
| 9 | "write the specific row's provider fields" | `external_reference` exists in the schema with no `MediaWriter` method, so a media item's secondary provider ids are unreachable through the contract. |
| 10 | "a handler that runs twice does not double-write" | No such test existed **and the property was false** — the attach writes were bare inserts and `role` had no unique index. Both fixed, and the test now exists. |
| 1.2 | the host provides a throwing `DownloadClients` and a test asserts the throw | Neither existed. A test now asserts a submit reaches the injected client and that the reference it answers is read. |

### 12.4 One verified fact that corrects 7

7 records the Drizzle calls as verified. One is wrong for the pinned
`drizzle-orm@1.0.0-rc.4`: **`drizzle({ client: raw, schema })` does not compile.**
SQLite's config is `Omit<DrizzleConfig, 'schema'>` — v1 replaced the key with
`relations`. The working form is:

```ts
drizzle({ client: raw, relations: defineRelations(schema) })
```

after which `db.query.mediaItem` resolves and `db.$client` is unchanged. Until
this was wired, `schema.ts` had no importers at all and duplicated the migration
DDL with nothing keeping the two in step; they are now checked against each other
by test.

### 12.5 Conditions and follow-ups

Recorded here rather than in a review file, because review files are scratch and
these outlive the branch.

**Two conditions.** Each names the event that makes it urgent, because a note
without a trigger decays into background noise.

- **`migrateHost` is not atomic** — it `exec`s the initial schema and then
  records the version in a separate statement, the same defect fixed in
  `migratePlugin`. It is worse than that one was: a crash between the two kills
  every later boot on `table download_client already exists`. It is harmless
  today only because `openDatabase` has no caller, so all call sites are
  in-memory tests and recovery is deleting an empty file. **Fix before either a
  production startup calls `openDatabase`, or `HOST_MIGRATIONS` gains a version
  2.**
- **`notifyNewRssItems` has no caller.** Returning `{ unowned, failures }`
  removed a bug where one plugin's failure hid another's, but it moved the
  obligation onto a caller that does not exist yet. **Whoever writes the
  rss-poll job must read both fields**; a caller that ignores `failures`
  reintroduces the silent loss by another route.

**Shared tables have a writer and no reader.** `MediaWriter` covers writes;
nothing reads. The test double hand-writes SQL against `rss_item` through the
untyped `ctx.db`, which is the same hole 12.2 describes, reached from the other
side. The read API is slice D's, and until it exists every plugin will improvise
one.

**`role` has no reader and no dedup beyond its unique index.** A deduped media
item can accumulate a duplicate cast entry that nothing would surface.

**Unreached by any test, deliberately or otherwise.** `onDownloadedFile` has no
caller by design, as 1.2 says. `attachPoster` and `attachBackground` are never
executed by a test — artwork is slice B's, and they were built for it. Five
tables have no writer, `external_reference` is unreachable through the contract
(12.3), and `ranking_score` is never written.

**A note on 1.x, which this slice does not touch.** `packages/web`'s
`Browse.test.tsx` has two distinct flaky tests, both measured during this work
rather than inferred: `the selection clears when a term filters the selected
group out` fails roughly one run in three, and `picking costs one request, not a
refetch` was seen failing once and did not reproduce. Neither is caused by 2.0 —
they are recorded so a future run does not mistake either for a regression it
introduced.
