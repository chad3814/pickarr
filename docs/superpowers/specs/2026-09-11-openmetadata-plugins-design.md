# Pickarr 2.0 Slice G — The First Media Plugins

The seventh slice of the 2.0 backend, and the first real consumer of the plugin
contract. Three plugins — tv, movie and xxx — turn the filenames a feed poll
delivered into identified `media_item` rows, by asking one service:
`POST https://openmetadata.nexus/api/v1/lookup`.

Until this slice, `SHIPPED_PLUGINS` in `packages/host/src/main.ts` is an empty
list and the only implementation of `MediaPlugin` anywhere in the tree is
`packages/host/test/double/plugin.ts`. The host polls feeds, stores rss items,
offers them to plugins, and has nobody to give them to. This slice gives it
three.

## 1. What this delivers

- **`@pickarr/openmetadata`** — a typed, validated client for the lookup API,
  and the whole lookup→poll→apply state machine as a plugin factory.
- **Three thin plugin packages** — `@pickarr/plugin-tv`,
  `@pickarr/plugin-movie`, `@pickarr/plugin-xxx` — each a spec plus its own
  tables.
- **A secret-resolver seam** in the host: `(key: string) => Promise<string>`,
  stubbed against the environment, so the secret store being built elsewhere
  drops in at one call site.
- **Three plugins wired into the running process**, so a seeded feed is
  identified end to end.

### 1.1 The decisions taken before this spec

- **One shared flow engine, three thin plugins.** The engine owns the client,
  the state table, `onNewRssItems`, the `lookup` and `poll` job handlers, and
  the branch that reads an answer. A plugin is a spec: `id`, `mediaType`, the
  wire `category`, its own migrations, and one `apply` function. The flow is
  where the correctness lives — partial-before-status, refusal against
  unresolved, the dedup race — and the three media types differ in *what a
  resolved answer means*, not in how an answer arrives. A plugin-as-spec
  factory rather than an adapter interface: a spec can carry extra job
  handlers, so the interface bought nothing the factory does not already
  allow.
- **Lookup and identification only.** `onDownloadRequest` stays the thin
  `ctx.downloads.submit` call the contract provides; `onDownloadedFile` logs.
  See §6.
- **An episode is the media item; its parents are the plugin's rows.** One
  `media_item` per downloadable thing, claiming the episode's own
  `providerRef`. `tv_series` and `tv_season` hold the parents, keyed by
  `providerRef`. The alternative — a `media_item` per entity — would sync
  series and season rows to read clients with no rss item behind them.
- **No dedup past the provider-ref claim.** `claimProviderRef` stays, because
  the host's unique index on `(provider, provider_ref)` is what resolves two
  items racing for one reference. Nothing further is attempted here:
  `lookup_id`, `provider_ref` and `confidence` are recorded on the plugin's own
  row, and a client is better placed to decide that two differently-named
  releases are the same thing.
- **The service's verdict is believed.** `state: 'resolved'` resolves. No
  confidence floor, because the numbers to choose one from do not exist yet;
  `confidence` is recorded so a threshold can later be measured rather than
  invented.
- **The API key comes from a resolver, not from `process.env`.** No plugin
  reads the environment. See §2.3.

### 1.2 What this slice is not

- **No artwork.** Neither `LookupEnvelope` nor `GET /api/v1/media/{id}` carries
  an image URL, so there is no artwork job, and
  `attachPoster`/`attachBackground`/`attachLogo` go unused by these plugins.
  Posters need a second source and that is a later slice.
- **No import.** No path templates, no renaming, no moving files.
- **No download submission beyond the contract's own call.** Picking a client
  by feed, recording the submission, retrying it: slice C and D's tables exist,
  and wiring them to these plugins is a later slice.
- **No `books` plugin.** `MediaType` has a fourth value and the API a fourth
  category; nothing here uses either.
- **No confidence threshold and no suggestion tables.** `suggestions` reaches a
  human as text in `rss_item.resolution_detail`, and nothing more.
- **No configuration UI or API.** The base url and the key come from the
  environment through the resolver; feeds stay seeded rows, as in every slice
  since B.

## 2. Packages, ids, and wiring

### 2.1 The four packages

| Package | Plugin id / table prefix | `mediaType` | Wire `category` |
| --- | --- | --- | --- |
| `@pickarr/openmetadata` | — (library) | — | — |
| `@pickarr/plugin-tv` | `tv` | `tv` | `tv` |
| `@pickarr/plugin-movie` | `movie` | `movie` | `movies` |
| `@pickarr/plugin-xxx` | `xxx` | `xxx` | `xxx` |

The id doubles as the required table prefix: `migratePlugin`
(`packages/host/src/db/migrate.ts`) diffs `sqlite_master` after each migration
and throws on any table that does not start with `<pluginId>_`. So the ids stay
short, and they are also what `rss_feed.plugin_id` names when a feed is seeded.

`movie` against the API's `movies` is the one asymmetry: the singular is the
contract's `MediaType`, the plural is the wire category. The mapping lives in
the plugin's spec, so nothing else in the tree has to remember it.

`@pickarr/openmetadata` depends on `@pickarr/contract`, `drizzle-orm` and
`node:sqlite`, and deliberately not on `@pickarr/host` — the rule the test
double keeps, and for its reason: a plugin that reached into the host's own
modules would prove the host composes with itself rather than that the contract
is sufficient for a plugin written against it.

### 2.2 The build

Root `package.json`'s `workspaces` already globs `packages/*`. The `build`
script names its packages explicitly and in dependency order, so it gains
`-w @pickarr/openmetadata` after `@pickarr/contract`, then the three plugin
packages, then `@pickarr/host` last. Each new package carries the same
`tsconfig.json` and `esbuild`/`tsgo` script pair as `@pickarr/contract`.

### 2.3 The secret resolver

The plugins are handed `Secrets['get']` from `packages/host/src/secrets/instance.ts`:

```ts
get(name: string): Promise<string>;
```

**This slice originally shipped a stub of that signature**, because the real
store was being built in parallel and the seam mattered more than what sat
behind it. The store landed on `pickarr-2` before this branch merged, the
stub is gone, and the shape did not have to change: the stub was written
against the signature the store was going to have, and `createSecrets` has
it.

What the store adds that the stub could not is where a credential may come
from. It resolves `openmetadata-api-key` through a chain — the environment
(`PICKARR_SECRET_OPENMETADATA_API_KEY`, derived by `envNameFor`), then the
secrets directory, then the `secret` table — with the order as its contract:
a container deployment overrides what the settings UI stored, and the
settings UI need not know. Results are memoized per name and the memo is
dropped on write, so a corrected credential takes effect without a restart.

It remains `async` and per-request, for the reason the stub was: a resolver
called per request serves a rotated credential where a value read once at
boot cannot.

**The resolved value is a credential.** It is used only as an `Authorization`
header. It is never logged, never written to a table, never put in a job
payload, and never handed to `node:assert` — tests use a fake key.

**This one is enforced by discipline, not by the build.** It is the same rule
`scripts/check-test-hygiene.ts`'s rule 3 enforces for the credentials it knows
about, and that check *structurally cannot reach this one*: `yieldsCredential`
matches an operand that is a call to a name on `CREDENTIAL_PRODUCERS`, or a
local bound to one. This key arrives as `await secrets.get(…)` — a call
through a *property* of a local bound to `createSecrets(…)`, which the check
does not follow. Adding a name to the list does not help; teaching the check
to follow a factory binding through to the object it returned is a separate
piece of work, and not this slice's.

**Plugins are constructed after the store, not before the database.** They
used to be built first, so that two plugins claiming one media type were
refused before anything was opened. They cannot be: a plugin takes
`secrets.get`, the chain ends at the `secret` table, and there is no store
until there is a connection. The refusal now lands after `migrateHost` and
before anything is registered or polled — the earliest point that still has a
resolver to hand.

Also **warned at boot**: when the real plugins were constructed, `main` asks
the store for the key once and logs a line if the chain cannot answer,
because per-request resolution alone means a deployment with no key
configured boots cleanly and only dead-letters lookups minutes later. It asks
*through the store* rather than of one variable, so an operator who used the
secrets directory or the table is not warned at for being configured
correctly. The resolved value is discarded unread; the line names the
variable, never the value. A warning rather than a refusal, because a host
serving reads with one plugin misconfigured is the right behaviour.

### 2.4 The process

`SHIPPED_PLUGINS`, today an empty module-level const, becomes:

```ts
export function shippedPlugins(deps: {
  now: () => number;
  resolveSecret: ResolveSecret;
  baseUrl: string;
}): readonly MediaPlugin[]
```

called inside `main`. That file's own rule is that nothing runs at module
scope, and the three plugins need their dependencies injected — which is also
what lets a test construct them without a process.

`baseUrl` is resolved beside the other `PICKARR_*` variables, from
`PICKARR_OPENMETADATA_URL`, defaulting to `https://openmetadata.nexus`. It is
resolved by the same shape of function as `resolveReadPort` and friends —
taking the variable's value rather than reading `process.env` itself — so it
is testable, and so a malformed url is refused at boot rather than at the first
lookup.

## 3. The engine

### 3.1 The wire layer

The spec's schemas become types: `LookupEnvelope`, `Media`, `MediaParent`,
`MediaPerson`, `MediaSuggestions`. Every response is validated at the boundary
by narrowing functions in the style of the test double's `read*` helpers: no
casts, nothing typed `any`, and a malformed field throwing a `TypeError` that
names the field. A service that changes shape therefore fails a job with a
diagnosis, rather than writing a row built from `undefined`.

Two calls:

- **`POST /api/v1/lookup`** with `{ items: [{ category, name }] }` — always the
  batch shape, even for a single name. The batch always answers HTTP 200 with a
  per-entry state, where a single lookup can answer 202; sending one shape means
  reading one shape. Chunked at the spec's 100-item ceiling.
- **`GET /api/v1/lookup/{id}`** for a poll.

Both carry `Authorization: Bearer <resolved key>` and go through
`ctx.fetch.json`, so they are queued per hostname (default: one in flight) and
bounded by the host's 30-second per-request timeout.

### 3.2 Matching answers to names is positional

The batch response is documented as "one entry per item, in order" and the
entries carry **no echoed `name`**. The engine therefore zips `results` to the
names it sent by index, and throws when the lengths differ rather than risk
assigning one item's identity to another. The throw fails the job, which
retries and then dead-letters visibly.

This is the one place the host's existing test double is actively misleading:
its fake service echoes `name` and the double matches on it. Our fake
(§5.1) does not.

### 3.3 The branch, in the order that reads an answer correctly

`lookup` and `poll` share it. Per envelope:

1. **`partial === true || state === 'pending'`** — the answer is not here.
   Enqueue a `poll` job at `now + 30s` carrying `lookupId`, `rssItemId` and the
   poll count; the resolution stays `pending`. Both conditions, because the
   API has `pending` as a *state* and `partial` as a separate flag, and either
   one means the payload is blank. Read first, and per entry rather than once
   per response: a partial entry carries the state it *expects* to reach.
2. **`refusal !== null`** — the service identified a non-media file. A
   successful answer, not an error: `setResolution(id, 'refused', refusal)`,
   terminal, no retry, no media rows. Folding this into `unresolved` would
   retry a subtitle forever and show it to a reader as a problem they cannot
   fix.
3. **`state === 'unresolved'`** — the name was not recognised, which is the
   state a human might fix. `setResolution(id, 'unresolved', detail)`. When
   `suggestions` is present the detail names what *was* recognised — the site,
   and the performers found in the title — so "we have never seen this" reads
   differently from "we know the site, not the scene". Nothing is enqueued; a
   retry happens on request.
4. **`state === 'resolved'` with `media === null`** — impossible per the
   schema, so it throws rather than quietly writing nothing.
5. **Resolved, with media** — §3.4.

### 3.4 Applying a resolved answer

In this order:

0. `spec.check(media)`, the plugin's pre-flight — **before anything is
   written**. A plugin that cannot represent an answer must refuse it here
   and nowhere later. See below.
1. `createMediaItem({ pluginId, title, releaseDate, description: overview })`.
   Created late, as the double does, so branches 2–4 have no row to clean up.
   `releaseDate` is the API's `releaseDate`; `year` is not stored separately —
   it is derivable, and a second column for it could disagree with the first.
2. `claimProviderRef(mediaItemId, provider, providerRef)`.
3. `dropMediaItem(claim.dropped)` when the claim was lost. Nothing points at
   our row yet, so dropping it leaves nothing dangling.
4. `relinkRssItem(rssItemId, claim.kept)`.
5. Update the `<id>_lookup` row with `media_item_id`, `lookup_id`,
   `provider_ref` and `confidence`.
6. `spec.apply({ media, mediaItemId, ctx, db })` — the plugin's own rows, §4.
7. People: for each entry in `media.people`, `upsertPerson({ name, providerRef })`
   then `attachRole(mediaItemId, { personId, role, name: characterName,
   billingOrder })`, one at a time and in the order the service gave them,
   because `attachRole` needs the id the upsert returns and billing order is
   the order rows should land in. `role` is passed through as the service sends
   it (`cast`, `director`, …); the engine invents no vocabulary of its own.
8. `setResolution(rssItemId, 'resolved', null)`.

Every step is idempotent or keyed, so a handler the runner retries after a
crash re-writes rather than duplicates: `claimProviderRef` resolves its own
race, `attachRole` is keyed on `(mediaItemId, personId, role)`, and the
plugin's own writes are upserts (§4).

**Step 0, and why `LookupPluginSpec` has a pre-flight at all.** This section
and §4.3–4.5 were written separately and neither saw the other: this one
fixed the write order, and those three each told their plugin to throw for a
`kind` it cannot represent — from inside `apply`, which is step 6. That is
four steps too late. A mis-sent category or a service bug would leave a
`media_item` holding the provider-ref claim, an `rss_item` relinked to it and
the resolution stuck `pending` forever, while the job dead-lettered with
nothing on any path to undo any of it. The three outcomes that identify
nothing (§3.3's branches 1–3) were the whole of what "created late" was
weighed against; **a plugin refusing the answer is a fourth**, and the only
place it costs nothing is before step 1.

So `LookupPluginSpec` carries `check(media: Media): void`, called here and
nowhere else. It is synchronous and must stay cheap — it reads the answer and
touches nothing else, so it has no failure of its own to contribute, which is
what makes it safe to run before any row exists. Each plugin's `kind` guard
lives there, as does tv's refusal of a release that names no series (§4.3),
which needs only `media.parents`. The guards remain inside `apply` as well:
`apply` is exported and driven directly by each plugin's own tests, and tv's
also narrows `media.kind` for the branches below it. The copy in `check` is
the one that matters; the copy in `apply` is the one that cannot be removed.

**`check` is required, not optional**, and the duplication above is exactly
why. Because every plugin also guards inside `apply`, a plugin that defined
`apply` and forgot `check` would still refuse the answer — one write too
late, which is the defect this hook exists to close, reintroduced silently
and passing every test it has. An optional hook makes that omission
something the compiler permits; a required one makes it something the
compiler catches, at the cost of an empty body in a plugin that genuinely
refuses nothing. No such plugin exists yet: all three refuse at least a
`kind`.

### 3.5 `onNewRssItems`

Inserts one `<id>_lookup` row per rss item id, then enqueues one `lookup` job
per chunk of at most 100 ids, recording each returned job id on the rows it
covers — a job id nothing keeps is a job nobody can trace back to the rows it
is identifying. An empty id list returns without a write.

**The insert tolerates a conflict** (`ON CONFLICT DO NOTHING` against the
unique index on `rss_item_id`), because this call is re-offered after it
fails. `feeds/reader.ts` marks nothing delivered when a plugin's
`onNewRssItems` rejects — a feed names exactly one plugin, so a failure is
all-or-nothing for the batch — and re-offers every undelivered row on the
next poll. A plain insert that had succeeded before the enqueue loop failed
would therefore meet its own rows on the retry and throw for ever, silently
wedging that feed for every later item too. Tolerating the conflict makes the
re-invocation a recovery: the rows stand, a fresh job is enqueued, and the
`lookup_job_id` update covers the chunk again.

The filenames themselves are read with hand-written SQL against `rss_item`
through `ctx.db`, for the reason the double's `readRssItems` documents:
`MediaReader` reaches rss items only *through* a media item, and these have
none yet. Names are returned in the caller's order, not sqlite's, so the order
answers are applied in — and therefore which of two items claiming one
provider ref wins — is the caller's.

### 3.6 The poll ceiling

A poll that answers `pending` enqueues the next poll, which means the job
runner's `attempts` never increments and nothing bounds the sequence. So the
poll count rides in the payload: after 20 polls — ten minutes at 30-second
intervals — the engine stops and writes `unresolved`, with the lookup id in the
detail so the answer can still be fetched by hand. A lookup the service never
finishes is then visible, rather than `pending` forever.

### 3.7 Failures

Errors propagate. Nothing here catches a fetch failure to carry on: a thrown
error is how the job runner learns to retry, and how a dead letter appears when
retries are exhausted. `ctx.fetch.json` throws `FetchFailedError` with the
numeric status for any non-2xx, so a 401 (a bad or revoked key), 429 or 503 is
logged through `ctx.log` with its status and the *redacted* url, and never with
the key.

`Retry-After` is not reachable through `HostFetch`, which returns parsed bodies
and no headers. A rate limit therefore retries on `jobs/backoff.ts`'s curve
rather than on the service's advice. Accepting that is cheaper than widening
`HostFetch` for one header, and the per-hostname queue already holds these
requests to one in flight.

The `AbortSignal` the dispatcher passes is forwarded into both fetches, so a
job approaching the five-minute ceiling unwinds instead of being abandoned
mid-request.

## 4. The tables

### 4.1 The shared state table, generated per prefix

The engine exports `lookupTableMigration(pluginId)` and the matching Drizzle
object, so the three tables are identical by construction rather than by three
copies of the DDL staying in step:

```sql
CREATE TABLE <id>_lookup (
  id            INTEGER PRIMARY KEY,
  rss_item_id   INTEGER NOT NULL REFERENCES rss_item (id),
  media_item_id INTEGER REFERENCES media_item (id),
  lookup_job_id INTEGER,
  lookup_id     TEXT,
  provider_ref  TEXT,
  confidence    REAL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX <id>_lookup_rss_item ON <id>_lookup (rss_item_id);
```

Keyed per rss item, not per media item: the dedup points two rss items at one
media item, and a per-media-item key would make the loser's row collide with
the winner's. `lookup_id` is the service's own id — what a poll asks about, and
what a support question quotes, which is why it is recorded as soon as an
answer arrives and whatever that answer turns out to be: written only on the
resolved path it would be null for exactly the rows anyone asks about, an item
that polled for ten minutes or one that ended `unresolved` or `refused`. This
is each plugin's migration 1.

Foreign keys name the host's tables, and the Drizzle objects carry no
`.references()`, because those targets belong to the host's schema and a plugin
has no business importing them.

### 4.2 `details`, and the one thing this spec cannot verify

`Media.details` is `additionalProperties` in the OpenAPI document, and its keys
are documented only for `scene` (`siteName`, `siteRef`, `durationSeconds`,
`releasedOn`) and `movie` (`runtimeMinutes`, `imdbId`, `tagline`,
`collectionName`). **Nothing says what an episode's details carry**, so a
season or episode number is a guess from this document alone.

Two things handle that. Every type's own row carries a `details_json` TEXT
column holding the object verbatim, so no field the service sends is lost to a
missing column and learning a key later needs no re-lookup. And the known keys
are read defensively: present and of the right type, or null.

Implementation begins with one real request per category against the live API,
with a real key, to learn the tv keys and confirm the two documented sets. The
observed keys go into this spec as an amendment before the tv tables are
written.

### 4.3 tv (migration 2)

```sql
CREATE TABLE tv_series (
  id             INTEGER PRIMARY KEY,
  provider       TEXT NOT NULL,
  provider_ref   TEXT NOT NULL,
  title          TEXT NOT NULL,
  first_air_date TEXT,
  overview       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX tv_series_provider_ref ON tv_series (provider, provider_ref);

CREATE TABLE tv_season (
  id            INTEGER PRIMARY KEY,
  series_id     INTEGER NOT NULL REFERENCES tv_series (id),
  provider      TEXT NOT NULL,
  provider_ref  TEXT NOT NULL,
  season_number INTEGER,
  title         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX tv_season_provider_ref ON tv_season (provider, provider_ref);

CREATE TABLE tv_release (
  id             INTEGER PRIMARY KEY,
  media_item_id  INTEGER NOT NULL REFERENCES media_item (id),
  kind           TEXT NOT NULL,
  series_id      INTEGER NOT NULL REFERENCES tv_series (id),
  season_id      INTEGER REFERENCES tv_season (id),
  episode_number INTEGER,
  details_json   TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX tv_release_media_item ON tv_release (media_item_id);
```

`tv_release` rather than `tv_episode`: it holds one row per *downloadable
thing*, and an episode is only the commonest of the three shapes a tv feed
delivers. `kind` records which — `episode`, `season` or `series` — so a reader
never has to infer it from which of `season_id` and `episode_number` are null.

`apply` walks `media.parents`, documented nearest first — so an episode's are
`[season, series]`. It upserts the series by `(provider, provider_ref)`, then
the season under it, then one `tv_release` row against the media item.
`series_id` is on the release as well as reachable through the season, because
a full-series pack has no season to reach it through, and it is `NOT NULL`
because every one of the three shapes names a series.

The three kinds, all handled:

- **`episode`** — series and season upserted from `parents`; `kind:
  'episode'`, `season_id` set, `episode_number` from `details`.
- **`season`** — a season pack. The media item *is* the season: the series
  comes from `parents`, the season row is upserted from the answer itself, and
  the release row is `kind: 'season'` with that `season_id` and a null
  `episode_number`.
- **`series`** — a full-series pack. Series upserted from the answer itself;
  the release row is `kind: 'series'` with a null `season_id` and a null
  `episode_number`.

An answer of any kind whose `parents` do not yield a series — and which is not
itself a `series` — throws: a release with no series is not something this
schema can record, and inventing a placeholder series would put a row in the
library that names nothing.

Any other `kind` — `movie`, `book`, `scene` — throws. A category answering
with a kind that cannot belong to it is a service bug or a mis-sent category,
and writing a row for it would bury the evidence.

**Both refusals belong in `check`, not in `apply`** — the pre-flight §3.4's
step 0 runs before the shared `media_item` exists. Both read only `media.kind`
and `media.parents`, so both can. They are repeated inside `apply` for the
reason §3.4 gives.

### 4.4 movie (migration 2)

```sql
CREATE TABLE movie_detail (
  id              INTEGER PRIMARY KEY,
  media_item_id   INTEGER NOT NULL REFERENCES media_item (id),
  runtime_minutes INTEGER,
  imdb_id         TEXT,
  tagline         TEXT,
  collection_name TEXT,
  details_json    TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX movie_detail_media_item ON movie_detail (media_item_id);
```

`kind: 'movie'` only; anything else throws, from `check` (§3.4's step 0),
before the shared rows are written. `parents` is expected to be empty and is
ignored if it is not — a movie has no parent this slice models.

### 4.5 xxx (migration 2)

```sql
CREATE TABLE xxx_site (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX xxx_site_provider_ref ON xxx_site (provider, provider_ref);

CREATE TABLE xxx_scene (
  id               INTEGER PRIMARY KEY,
  media_item_id    INTEGER NOT NULL REFERENCES media_item (id),
  site_id          INTEGER REFERENCES xxx_site (id),
  duration_seconds INTEGER,
  released_on      TEXT,
  details_json     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX xxx_scene_media_item ON xxx_scene (media_item_id);
```

`kind: 'scene'` only, refused from `check` (§3.4's step 0) before the shared
rows are written. The site comes from `details.siteName` and
`details.siteRef`; `site_id` is nullable because a scene whose details name no
site is still a scene worth recording. Two scenes from one site share one
`xxx_site` row through the upsert.

### 4.6 Upserts, not inserts

Every write in §4.3–4.5 is an upsert keyed on the unique index above it —
`ON CONFLICT … DO UPDATE`, with `updated_at` from the injected clock. A job the
runner retries after a crash therefore re-writes its rows rather than failing
on a constraint or duplicating a series.

## 5. Testing

### 5.1 One fake service, at the real wire shape

`@pickarr/openmetadata` exports `createFakeLookupService(script)` from a
`./testing` subpath: scripted by name for a batch and by lookup id for
successive polls, answering HTTP 200 with `results` **in request order and
with no echoed name**, exactly as the document specifies. It records the
requests it received, so a test can assert what was asked as well as what was
written.

Exported rather than kept in a test directory because all three plugin
packages and the host's flow test need it, and three fakes would be three
chances to encode the wire shape wrongly — which is the failure this slice is
most exposed to.

### 5.2 Engine tests

`packages/openmetadata/test/`, with fake `MediaWriter` and `MediaReader`
recording calls, so these tests are independent of the host's schema:

- each malformed or missing field throws naming that field; an unknown key in
  `details` survives into `details_json`
- the positional zip, and the length-mismatch throw
- branch order: `partial` with `state: 'resolved'` polls rather than resolving;
  `state: 'pending'` likewise; a `refusal` is terminal and writes no media
  rows; `unresolved` with `suggestions` names the site and performers in the
  detail; `unresolved` without them does not; resolved-with-null-media throws
- chunking at 100 names, and one job per chunk
- the poll ceiling: the twenty-first poll writes `unresolved` naming the lookup
  id
- the `Authorization` header is sent, and `resolveSecret` is awaited once per
  request (a fake key; never an assertion operand)
- a lost `claimProviderRef` race drops the loser and relinks the rss item to
  the winner
- `lookup_id`, `provider_ref` and `confidence` land on the plugin's row

### 5.3 Per-plugin tests

`packages/plugin-{tv,movie,xxx}/test/` drive `apply` against an in-memory
`node:sqlite` holding that plugin's own migrated tables. Foreign keys are left
off in these tests, since the host tables the DDL references are not present —
the host enables `PRAGMA foreign_keys = ON` in `db/open.ts`, and the flow test
(§5.4) is where that constraint is exercised.

- tv: an episode writes series → season → release; a second answer for another
  episode of the same season adds one release row and creates no second series
  or season; a season pack writes `kind: 'season'` with a null episode number;
  a series pack writes `kind: 'series'` with a null season; an episode whose
  parents name no series throws; a `kind` of `movie` throws
- movie: the four documented detail keys land, absent ones are null, and
  `details_json` holds the object verbatim
- xxx: a scene writes its site and scene rows; a second scene from the same
  site reuses the site row; a scene with no site in its details still writes
- every plugin: re-applying the same answer changes `updated_at` and adds no
  rows

### 5.4 One flow test in the host

`packages/host/test/` wires the three real plugins into the real host — real
migrations, real dispatcher, real jobs, the §5.1 fake service — and asserts
that a seeded feed per plugin ends with the expected `media_item`, `person`,
`role` and `rss_item.resolution` rows, that each plugin's tables carry its
prefix (which `migratePlugin` enforces, so a violation fails at boot), and that
an item for one plugin's feed is never delivered to another's.

### 5.5 Verification

`npm run check` — lint, typecheck, test hygiene, the server and web suites —
and `npm run build`. Both green before this slice is done.

## 6. The two entry points this slice does not develop

`MediaPlugin` requires all three, and neither of these is a stub:

- **`onDownloadRequest`** calls `ctx.downloads.submit({ rssItemId,
  downloadClientId })`, taking the client from the `rss_feed` row the item came
  from. When that column is null it throws, naming the feed: the column's
  meaning is "the host's default client", and `DownloadSubmission.downloadClientId`
  is a required number with no way to express that default. Picking a client on
  the plugin's behalf — the only `download_client` row, say — would be the
  plugin inventing host policy. So the gap is left visible as a failed job, and
  closing it belongs to the slice that wires submission up properly, either by
  widening the contract or by resolving the default in the host. Recording the
  submission, retrying it and reconciling it are slices C and D's tables and
  that same later slice's wiring.
- **`onDownloadedFile`** logs the path and size through `ctx.log`. Importing is
  out of scope (§1.2), and a plugin that threw here would fail a job for work
  it was never asked to do.

## 7. What accepting this design costs

- **A lookup the service never finishes becomes `unresolved` after ten
  minutes**, not `pending` forever — but the distinction is lost: a reader
  cannot tell "the service gave up" from "the name was not recognised" except
  by the detail text. A dedicated resolution would need a contract change.
- **No `Retry-After`.** A 429 retries on the host's backoff curve, which may be
  sooner or later than the service asked. Nothing here reads the header,
  because `HostFetch` cannot expose it.
- **Duplicate releases stay duplicates.** Two rss items for the same episode
  from different sites resolve to one media item only if the service returns the
  same `providerRef` for both. Anything subtler is a client's problem, by
  choice.
- **tv's detail keys are unverified** until the probe in §4.2 runs.
  `details_json` is what keeps that from becoming a migration.
- **A crash between `createMediaItem` and `claimProviderRef` orphans a row.**
  §3.4's step 1 writes a `media_item` that nothing yet points at; step 2 is
  what gives it an identity and what another item racing for the same
  reference would find. A process death in between leaves a row that no
  `rss_item` links to, that holds no provider reference, and that therefore
  nothing will ever claim, drop or reach — the retry starts over and creates a
  fresh one. Narrow, and non-corrupting: the orphan is invisible to the dedup
  and to every read filtered by plugin and rss item, so no later answer is
  wrong because of it. It is unbounded only across repeated crashes in that
  one window, and closing it would mean a transaction spanning two
  `MediaWriter` calls, which the contract does not offer.
- **The engine's flow is shared, so a divergence later costs a fork.** If one
  media type needs a materially different flow — a two-stage lookup, say — it
  either grows a branch in the shared engine or stops using it. The bet is that
  identification is the same problem three times, and the state table and the
  branch order are the evidence for it.
