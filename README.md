# Pickarr

Sonarr, Radarr, and Whisparr are automation tools: you tell them what you want and they
acquire it. Pickarr inverts that. It reads RSS feeds, works out what each release
actually *is*, collates the different versions of the same thing into a single pickable
group, and shows the result for a human to browse. Nothing downloads without a click.

Pickarr remembers what you picked. When a better version of something you already own
shows up in a feed later, that group jumps back to the top of the list flagged as an
upgrade, and you decide whether to take it.

## The state of play

This documents **2.0**, a rewrite in progress. It builds, it containerises, and it
runs -- but the browser client so far is one sign-in form and three counts that climb
as the replica fills. There is nothing to browse and nothing to pick yet, so run it to
watch 2.0 work, not to replace 1.x.

2.0 is greenfield: it starts on an empty database and rebuilds from feeds, so it shares
no schema with 1.x and nothing migrates. The two implementations sit side by side in
this repo.

| | Package | State |
|---|---|---|
| **2.0** | `packages/host` | The host — boot, config, secrets, auth, jobs, download clients, the read and sync APIs |
| | `packages/contract` | What a plugin is: the types the host and plugins agree on |
| | `packages/openmetadata` | The base every shipped plugin is built from: one lookup service, one API key |
| | `packages/plugin-tv`, `packages/plugin-movie`, `packages/plugin-xxx` | The three shipped plugins |
| | `packages/web` | The browser client, built against 2.0's sync API and served by the host |
| **1.x** | `packages/core` | Frozen. The whole 1.x application; no longer what `Dockerfile` builds |
| | `packages/plugin-scenes` | Frozen. 1.x's scene parser, against the old plugin interface |

`Dockerfile` builds 2.0, not 1.x: `packages/contract`, `packages/openmetadata`, the three
plugins, `packages/host`, and `packages/web`'s built bundle, which the host serves itself
from a static route alongside its JSON and artwork routes. 1.x does not ship in this
image at all — there is no container for it here.

The design documents are in `docs/superpowers/specs/`. Everything dated `2026-09` is
2.0, in slice order; `docs/database-migrations.md` is required reading before you write
a migration.

## Running the 2.0 host

Node 24 or newer.

```bash
npm ci
npm start -w @pickarr/host
```

That runs from TypeScript source through `tsx`. For a built host, `npm run build` first
and then `node packages/host/dist/bin.js`.

On first boot it prints a claim token:

```
[host] this install is unclaimed: the first sign-up must carry claim token <token>
```

The first sign-up must carry that token, and spending it is what creates the account.
It is single-use and only a *successful* sign-up spends it, so a refused attempt leaves
it usable; it is reprinted on every boot until an account exists. See
[Authentication](#authentication).

A fresh install polls nothing, because it has no feeds and no download clients, and
there is no write API yet to create them. Two scripts do it:

```bash
npm run seed-feed -- --database=/config/pickarr.db --plugin=tv \
  --name="Example feed" --url=https://example.test/feed.xml --type=torrent

PICKARR_CLIENT_API_KEY=... npm run seed-client -- --database=/config/pickarr.db \
  --name="My qBittorrent" --type=torrent --implementation=qbittorrent \
  --url=http://qbt.example.test:8080 --category=pickarr --import-mode=copy
```

Both run the host's migrations first, so they work against a database file the host has
never opened. `rss_feed.url` is `UNIQUE`: re-seeding a url already on file fails loudly
naming the existing row rather than silently overwriting it. Each script's docblock has
the full argument list.

### Which user the container runs as

Set `PUID` and `PGID` and the container runs as that user instead of root:

```yaml
services:
  pickarr:
    environment:
      PUID: 1000
      PGID: 1000
```

Without them it runs as root, exactly as it always has — so this changes nothing for an
existing install until you ask for it. `id -u` and `id -g` on the host print the pair
you want.

The reason to bother is what ends up in your `./config` directory. A container running
as root writes root-owned files there, and you then cannot read, back up or delete your
own database without `sudo`. Set these and the files belong to you. The names are
`PUID`/`PGID` rather than `UID`/`GID` because `UID` is a readonly builtin in `bash` and
`zsh`, so `UID=1000 docker compose up` fails in your own shell — this is the same reason
every other *arr image spells them this way, and the values are interchangeable with
theirs.

Two limits worth knowing:

- Only the config directory is taken over, and only when its ownership does not already
  match, so a restart against a directory that is already right costs nothing. If
  `database.path` points **outside** that directory, create that location with the right
  owner yourself — the entrypoint does not read the config file to find it.
- Library destinations are never chowned. They hold media you already own, and an
  entrypoint that recursively rewrites ownership of someone's library is a worse bug
  than the one it fixes. `PUID`/`PGID` is what makes *new* files Pickarr copies there
  land with the right owner.

A `PUID` that is not a number, or one set without a `PGID`, stops the container with a
message rather than quietly falling back to root — a typo that boots anyway would show
up days later as a directory of root-owned files.

One thing `PUID` does **not** cover: `docker exec` runs straight from the image and
never passes through the entrypoint, so it lands you a root shell even when the server
itself is running as you. Anything you do by hand in there writes root-owned files —
the exact problem you set `PUID` to avoid. Pass the user explicitly:

```bash
docker exec -u 1000:1000 pickarr sh
```

## Configuration

Two sources, and the environment always wins. Neither has to exist: a host with no
config file and no variables set boots entirely on defaults.

### The config file

`PICKARR_CONFIG` names it, defaulting to `/config/pickarr.config.json`. Its top-level
keys are namespaces, one per subsystem, and each namespace is strict — an unrecognised
key inside one is a boot failure rather than a setting that silently does nothing.

```json
{
  "server": { "host": "0.0.0.0", "port": 7676 },
  "database": { "path": "/config/pickarr.db" },
  "secrets": { "baseDir": "/run/secrets" }
}
```

| Key | Default | Meaning |
|---|---|---|
| `server.host` | `0.0.0.0` | Bind address. Not loopback: from the auth slice on, a session is what protects this socket rather than the interface it listens on. |
| `server.port` | `7676` | Port for the read and sync API. |
| `server.publicUrl` | *(none)* | The externally reachable origin, for a host behind a reverse proxy. Must be an origin — no path, query string or fragment. Absent means "derive it from the bind address". |
| `server.trustedOrigins` | `[]` | Further origins a browser may sign in from. A request whose origin is a private-range IP literal is trusted without configuration; a **hostname** never is, because nothing distinguishes yours from an attacker-controlled name. List the direct address here when you also reach the host past the proxy. |
| `server.trustedProxies` | loopback + RFC1918 + ULA | CIDRs whose addresses are proxies rather than clients, for resolving the client IP that rate limiting buckets on. Any host inside these ranges can forge `x-forwarded-for`; narrow it to your proxy to prevent that. |
| `server.ipAddressHeaders` | *(none)* | Headers to read the client address from, in order. Absent leaves the library default, `x-forwarded-for`. |
| `database.path` | `/config/pickarr.db` | The SQLite file. Artwork is stored in a directory derived from it. |
| `secrets.baseDir` | `/run/secrets` | Where the secrets chain looks for files. |

An absent file and an empty one are the same thing. A file that does not parse is
**not**: reading a hand-edit with a trailing comma as "no configuration" would boot on
defaults and then overwrite the edit on the next write. Writes go to a temp file in the
same directory and are renamed over the target, so a crash mid-write cannot leave an
unbootable install.

### Environment variables

| Variable | Overrides |
|---|---|
| `PICKARR_CONFIG` | The config file's path. |
| `PICKARR_DATABASE` | `database.path` |
| `PICKARR_READ_API_HOST` | `server.host` |
| `PICKARR_READ_API_PORT` | `server.port` |
| `PICKARR_PUBLIC_URL` | `server.publicUrl` |
| `PICKARR_TRUSTED_ORIGINS` | `server.trustedOrigins`, comma-separated |
| `PICKARR_TRUSTED_PROXIES` | `server.trustedProxies`, comma-separated |
| `PICKARR_IP_ADDRESS_HEADERS` | `server.ipAddressHeaders`, comma-separated |
| `PICKARR_OPENMETADATA_URL` | Where the lookup service lives (default `https://openmetadata.nexus`). An origin, and it may carry no username or password. |
| `BETTER_AUTH_SECRET` | The session signing secret. Generated and persisted on first boot if unset, so it only needs setting to share one across replicas. |
| `PICKARR_SECRET_<NAME>` | One credential — see [Secrets](#secrets). |

Two more are read by the container's entrypoint rather than by the host, so they do
nothing outside Docker:

| Variable | Meaning |
|---|---|
| `PUID` | The user id to run as. Unset means root, which is what the image did before this existed. |
| `PGID` | The group id to run as. Required whenever `PUID` is set. |

Deliberately **not** `PICKARR_PORT`: 1.x reads that for its own port, and a machine
running both would have one variable meaning two things.

An empty value is not a value. `PICKARR_READ_API_HOST=''` would bind every interface if
it reached the listener, and `PICKARR_CONFIG=''` would mean "read the file `''`", so
every one of these treats empty as unset and falls back to its default.

A value that is present but is not a port is a different matter, and only
`PICKARR_READ_API_PORT` can be one: it refuses `0`, `70000`, `abc`, and even `' 7676'`
with a leading space, rather than starting on a port the operator did not ask for.

## Secrets

A credential is resolved from three places in order: the environment, then a file under
`secrets.baseDir`, then the `secret` table in the database. The order is the whole
contract — it lets a container deployment override a credential the settings UI stored,
without the settings UI knowing.

A secret's name is 1–64 lowercase alphanumerics, underscores and hyphens, starting
alphanumeric. Its environment variable is that name uppercased with hyphens turned into
underscores, under the `PICKARR_SECRET_` prefix: `openmetadata-api-key` is
`PICKARR_SECRET_OPENMETADATA_API_KEY`. The prefix is not decoration — without it a
secret named `path` resolves from the container's own `PATH`, and that string would go
to a third-party service as its API key.

**The one secret a working install needs is `openmetadata-api-key`.** All three shipped
plugins look up metadata through that service, and without a key each one dead-letters
every lookup job. The host checks the chain at boot and warns rather than refusing,
because a host serving reads with one plugin misconfigured is the right behaviour.

One failure is worth knowing in advance: a missing variable and a missing file both fall
through to the next source, but a secrets *directory* that exists and cannot be read
**halts** the chain, so no database-stored credential resolves at all. In Docker
`/run/secrets` is routinely root-owned, which makes this a live failure rather than a
theoretical one. It reports as `SecretsFileUnreadable`, distinct from "this credential
was never configured", so a permissions problem does not send you to the settings UI.

## Authentication

One account per install, created by whoever holds the claim token, using email and
password through [better-auth](https://better-auth.com).

The token exists because the bind default is `0.0.0.0`: without it, "the first user
claims the install" would mean anyone on the network can claim it between first boot and
the owner signing up. It is generated on first boot, printed to the console the owner
just started the process in, and never written anywhere a request can reach.

Every route requires a session except `/api/health`, which is open because a container
health check has no credential to offer and the body it answers names nothing a caller
could not guess. The test suite asserts that count rather than trusting it.

### Behind a reverse proxy

Set `server.publicUrl` (or `PICKARR_PUBLIC_URL`) to the origin browsers actually use.
Sign-in is rejected if the request's origin is not trusted, and the bound address is
not the one a browser sees.

**If you also reach the host directly, list that address too.** `publicUrl` is the
canonical origin — it is Better Auth's `baseURL` — so it can only be one. A deployment
proxied at `https://pickarr.example` that you also open at `http://box:7676` needs:

```json
{ "server": {
    "publicUrl": "https://pickarr.example",
    "trustedOrigins": ["http://box:7676"]
} }
```

Without the second, that address answers `Invalid origin` and the install cannot be
claimed from it. A private-range IP literal — `http://192.168.1.9:7676` — is trusted
without configuration, because the address proves where the request came from; a
hostname is not, because nothing distinguishes yours from an attacker-controlled name
that resolves anywhere.

**Rate limiting needs the client's address.** It comes from `x-forwarded-for`, and a
value carrying more than one hop resolves only if the proxy's own address matches
`server.trustedProxies`. The default covers loopback, RFC1918 and ULA, so a proxy on
your LAN or in a Docker network works unconfigured — at the cost that any host in
those ranges can forge the header. Narrow it to your proxy's address to remove that.
A host with no `trustedProxies` match logs `could not determine a client IP` and puts
every caller in one shared bucket.

## The API

Eight routes, all `GET`, all under `/api`.

| Route | Answers |
|---|---|
| `/api/health` | `{ ok, version }`. The only open route. |
| `/api/media?type=` | A page of media items for one plugin's media type. |
| `/api/rss-items` | A page of feed items. Not type-scoped: a feed's `plugin_id` says who polls it, not who may read what it found. |
| `/api/downloads` | A page across both download tables, so its cursor names which table a row came from. |
| `/api/deletions?type=` | Tombstone ids for one plugin. Type-scoped, because a tombstone has no media item left to join to. |
| `/api/artwork/:kind/:mediaItemId` | An image, with `ETag` handling. |
| `/api/sync?since=` | The tail of the invalidation log: what has changed since a cursor. |
| `/api/sync/backfill?before=` | Current state walked backwards, newest media item first, for a client that has nothing yet. |

The last two are the client replication surface, and they run concurrently rather than
in sequence: a fresh client pages history backwards while new changes keep arriving on
the tail, so it does not sit blank waiting for a large backfill. `sync_log` records
*that* a row changed rather than what it changed to, and the server reads current state
when it answers — which makes delivering an op twice a no-op.

The two cursors carry different op kinds, and a client must honour the difference. The
tail sends `upsert` and `delete`; the backfill sends `create`. A `create` never
overwrites a row the client already holds, and a `delete` writes a tombstone rather than
removing the row — together, those are what stop a backfill page held across a tail
delivery from resurrecting a deleted row or reverting an edited one.
`docs/superpowers/specs/2026-09-14-client-sync-design.md` argues it in full.

## Development

```bash
npm run check      # lint, typecheck, test-hygiene, tests
npm run test       # server and web suites
npm run e2e        # Playwright, downloads a browser on first run
```

`npm run check` is the gate. `test-hygiene` is a build-time check for hazards that are
invisible at runtime — a live DOM element handed to `node:assert`, a credential column
named in a SQL string outside the one module allowed to name it.

`CLAUDE.md` records the ways this test suite has been green while proving less than it
appeared to. Read it before writing tests; each entry is there because it has already
recurred at least once.
