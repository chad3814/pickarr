# Adding RSS feeds — design

**Status:** approved in chat 2026-09-18. The host's first write surface.

## 1. The gap this closes

2.0 can poll a feed, look its items up, collate them onto a media item, submit
a download and reconcile it. It cannot acquire a feed. `rss_feed` has **no
production writer** — `main` schedules a poll for every row already on file,
`feeds/reader.ts` polls them, `clients/select.ts` picks a client per feed, and
the only code that ever inserts one is a test helper in
`packages/openmetadata/src/testing.ts`.

So this is not "a settings screen". It is the missing half of ingestion, and
the host's first write endpoint.

**Scope is feeds only.** `download_client` has no production writer either,
and closing both would drag credential handling — an api key or a
username/password resolved through the `secret` table — into a UI slice.
A feed works without one: `rss_feed.download_client_id` is nullable and means
"the host's default client". A feed with none polls, its items arrive, and
the browse screens show them. Only *picking* from such a feed fails, loudly
and by design (`packages/openmetadata/src/engine.ts`'s `onDownloadRequest`
throws rather than invent host policy), and picking is not built: the client
is read-only until `POST /api/picks`.

## 2. The write path

### 2.1 `Host.addFeed`

A new operation on the `Host` interface, beside `requestDownload`,
`schedulePoll` and `scheduleReconcile`. The route is a thin adapter; the host
owns every invariant, and is testable with no HTTP at all — which is how every
other host operation here is tested.

It refuses, with a **typed** refusal rather than a raw error:

- a `pluginId` naming no **registered** plugin. The host holds that map; a
  feed owned by an unregistered plugin would poll and its items would go
  unowned, which `notifyNewRssItems` already reports as `unowned` and nothing
  would ever claim.
- a `url` already on file. `rss_feed` has a `uniqueIndex` on `url`, so without
  this a duplicate surfaces as a raw SQLite constraint violation — a 500 where
  the honest answer is "that feed is already here".
- a `downloadType` outside `torrent` | `nzb`.
- a `pollIntervalS` outside **60 to 86400 seconds**. Both ends have a reason.
  Nothing clamps this value today: `host.ts`'s poll handler reschedules at
  `now + seconds * 1000`, so zero or a negative interval enqueues the next
  poll in the past and spins the dispatcher — the lower bound is what stops a
  typo from becoming a busy loop against someone else's tracker. The upper
  bound catches the other typo: an interval of `9000000` is a feed that looks
  configured and never polls again.

On success it calls `schedulePoll(id, now)` — the identical call `main` makes
at boot for feeds already on file. **A feed added through the UI starts
working at once rather than at the next restart**, which matters because
items arriving is the only real confirmation the url was right.

### 2.2 `POST /api/feeds`, and the guard that has to change

Session-guarded like every read. The response says only whether the request
was accepted; what the feed then does arrives through the replica.

Each refusal in §2.1 is **distinguishable by the client without parsing
prose** — the form has to tell "already on file" from "unknown plugin" from
"offline" in its own words, and matching on a message string is how that
breaks the first time the wording changes. The response carries no url, no
path and no server-authored sentence (Global Constraint); the client owns the
words a human reads.

**The structural change is the 405 guard.** `server.ts:821` currently rejects
every non-GET method in one line, before route dispatch. It becomes
per-route: each `ROUTES` entry declares the methods it accepts, and anything
else still answers 405. Two reasons this is the careful part — it is the
mechanism that has kept `/api` read-only until now, and `POST /api/picks`
needs exactly the same change, so this slice pays for it once and the pick
route inherits a pattern instead of an argument.

## 3. The read path

### 3.1 `rss_feed` joins the synced tables

Projected: `id`, `pluginId`, `name`, `downloadType`, `pollIntervalS`,
`downloadClientId`, `createdAt`, `updatedAt`, and `url`.

`downloadClientId` travels for the reason `tables.ts` already gives for
`rss_item.feedId` — it names a table that is out and will stay out, and a
client grouping by it needs the id rather than the row. An id is not a url.

### 3.2 The url is redacted, and this amends a stated rule

`sync/tables.ts` today gives `rss_feed`'s exclusion as a rule with no
exception:

> `rss_feed` holds a feed's url, which for a private tracker carries the
> passkey — the same reason `selectSql` below drops `rss_item.link`, and a url
> may not be copied into permanent client storage at all.

**That rule is amended here, deliberately.** The operator needs to tell two
feeds apart, and this codebase already stores a redacted url in a column
elsewhere. `redactUrl` (`clients/redact.ts`) is applied in `readHostRows`,
**after** the SELECT — making `rss_feed` the first synced table whose
projection is not purely SQL, which is worth stating rather than leaving to be
noticed. `tables.ts`'s own docblock is rewritten to say the rule changed and
why, because a file that still states the old rule while the code does the
opposite is the failure this project keeps hitting.

**And the gap is recorded, because the amendment leans on redaction that does
not yet cover the cases that matter.** `redactUrl` knows exactly one parameter
name, `apikey`. Measured in issue #78: `?passkey=`, `?token=` and
`/announce/SECRET/` all pass through **unchanged**, and a path-segment passkey
is undetectable in principle — nothing distinguishes a secret path segment
from a category slug.

So a private tracker's passkey will reach the replica today. **Issue #78 is
the fix and this slice raises its severity**: a redacted url in the replica is
permanent storage on every device the operator has signed into, not merely a
response body reachable by a caller holding a session. That escalation is
recorded on the issue itself, not only here.

This was decided with the gap on the table, not in ignorance of it.

### 3.3 No client schema bump

The replica's object store is generic, keyed `['table','id']`, so a new synced
table needs no `SCHEMA_VERSION` change and forces no resync. Existing replicas
pick feeds up through the ordinary backfill, because the migration seeds
`sync_log` for rows already on file — the same seeding every synced table
received. Installing this table's triggers is a migration concern and
`docs/database-migrations.md` is required reading for it.

The client side is a `RssFeedSyncRead` contract type beside the other six, and
`rss_feed` added to the client's `TABLES_WITH_UPDATED_AT` so `listByTable` will
page it.

This is the first host table added to the synced set since the protocol was
built, so it is also the first real test of whether that protocol extends the
way it was designed to.

## 4. The screens

A fifth route, `/settings`, with a nav link beside the three categories and
`/unmatched`. Two components: the list of feeds, read from the replica, and
the add form.

Fields: `name`, `url`, `pluginId`, `downloadType`, `pollIntervalS`. No
download client — none can exist, and absent already means "the host's
default".

**The form offers the three ids in `CATEGORIES`, and the host stays the
authority.** That constant is already this same duplication — the nav shows
three tabs because three plugins are registered — so reusing it adds no
surface. A `pluginId` the host has not registered is refused, and the refusal
reaches the user as words. *Limitation, recorded rather than discovered:*
registering a fourth plugin means editing that constant. The alternative is a
new endpoint listing registered plugins, for the sake of one `<select>`.

Errors follow `SignIn`'s hardened pattern: a fixed sentence per refusal, never
echoing the server's body (Global Constraint), and **refused** distinguished
from **never got an answer** — an offline submit must not read as a rejected
feed. Two refusals need distinct words: a url already on file, and an unknown
plugin.

After a successful add the list updates itself through the replica's live
subscription, with no refetch — the same mechanism by which `/unmatched`
learns a release was matched.

## 5. Testing

- **Host level:** `Host.addFeed`'s four refusals and its success path,
  including that it schedules the first poll. No HTTP.
- **Route level:** the method guard. A `GET` to a POST-only route and a `POST`
  to a GET-only route both answer 405, and `/api` still never falls through to
  `index.html`.
- **Sync level:** the projection excludes nothing it should carry and redacts
  the url; a feed inserted by `addFeed` reaches a replica through the log.
- **Component level:** the form's two refusals and its offline case render
  distinguishable words; the list updates from a subscription rather than a
  refetch.
- **Browser:** adding a feed through the UI puts it in the list, in a real
  engine.

### 5.1 What the tests must pin, given this project's history

Every slice so far has produced at least one test that passed while proving
nothing. Three specific traps here:

- A redaction test asserting `?apikey=` is stripped proves what `redactUrl`
  already guarantees. The test that matters asserts a **passkey-bearing url is
  still exposed today** — pinning the known gap so that closing #78 is
  observable rather than silent.
- The duplicate-url refusal must be driven through a real second insert, not a
  stubbed error. The uniqueness lives in the database.
- The method guard must be tested per route, not once. A guard that answers
  405 for every method on every route would pass a single-route test and break
  every write this slice exists to allow.

## 6. Out of scope

- **Download clients** — no writer, and credentials belong in their own slice.
- **Editing or deleting a feed** — this adds one. Editing needs a different
  route shape and a different set of refusals.
- **Picking** — `POST /api/picks`, agreed shape, still its own slice.
- **Broadening `redactUrl`** — issue #78.
- **A registered-plugins endpoint** — the form uses `CATEGORIES` (§4).

## 7. Acceptance

1. `Host.addFeed` refuses an unregistered plugin, a duplicate url, a bad
   download type and an out-of-range interval, each distinguishably.
2. A feed added through `POST /api/feeds` is polled without a restart.
3. `GET` on a POST-only route answers 405, and vice versa; `/api` never falls
   through to `index.html`.
4. A feed reaches the replica with its url redacted, and the settings list
   shows it without a refetch.
5. A test records that a passkey-bearing url is *not* redacted today, so #78
   closing is observable.
6. The add form distinguishes a duplicate url, an unknown plugin, and being
   offline.
7. Each new screen has an assertion that fails if its stylesheet is deleted.
