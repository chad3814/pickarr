# Pickarr

Sonarr, Radarr, and Whisparr are automation tools: you tell them what you want and
they acquire it. Pickarr inverts that. It reads RSS feeds, works out what each release
actually *is*, collates the different versions of the same thing into a single pickable
group, and shows the result for a human to browse. Nothing downloads without a click.

Pickarr remembers what you picked. When a better version of something you already own
shows up in a feed later, that group jumps back to the top of the list flagged as an
upgrade, and you decide whether to take it.

The MVP follows one or more RSS feeds, sends picks to SABnzbd, and imports completed
files into a fixed library layout. It runs as a single Docker container.

See `docs/superpowers/specs/2026-08-04-pickarr-design.md` for the full design
rationale, including what is deliberately out of scope for this release.

## Quick start

```bash
cp config.example.json config/config.json
mkdir -p secrets
printf '%s' 'your-32-char-sabnzbd-api-key' > secrets/sabnzbd_api_key
# edit config/config.json: set your feed URL(s) and libraryRoot

docker compose -f docker-compose.example.yml up --build
```

Edit `config/config.json` for your indexer, library path, and SABnzbd category before
starting. The compose file mounts `./config` into the container at `/config`, so
`config/config.json` and the SQLite database that Pickarr creates alongside it both
live on the host.

## Configuration

`config/config.json` is validated at startup; an invalid config fails the container
immediately rather than starting in a broken state.

| Field | Belongs to | Meaning |
|---|---|---|
| `server.port` | top level | HTTP port Pickarr listens on. Overridable with the `PICKARR_PORT` environment variable, which is also what the container's healthcheck reads. |
| `database.path` | top level | Path to the SQLite file. Put it under `/config` so it survives container recreation. |
| `trashDir` | top level | Where superseded files are moved instead of deleted. See "Trash is never emptied" below. |
| `plugins.<package>` | plugin | Per-plugin settings, keyed by package name. The bundled scenes plugin takes `libraryRoot`, the destination directory imports land in. |
| `downloadClients[]` | top level | One or more download clients. The MVP supports `type: "sabnzbd"` only. |
| `downloadClients[].url` | download client | Base URL of the SABnzbd instance. |
| `downloadClients[].apiKey` | download client | The SABnzbd API key, or a `file:/run/secrets/<name>` reference to read it from a Docker secret instead of embedding it in the config file. |
| `downloadClients[].category` | download client | The SABnzbd category Pickarr uses for its own jobs. **Must be unique to this Pickarr instance** — see below. |
| `downloadClients[].importMode` | download client | `"move"` or `"copy"` — what happens to a completed download when it's imported into the library. |
| `downloadClients[].pathMappings[]` | download client | `{ from, to }` pairs translating SABnzbd's view of a completed download's path into the path Pickarr sees on its own filesystem. |
| `feeds[]` | top level | One or more RSS feeds to poll. |
| `feeds[].url` | feed | The RSS feed URL, including any indexer API key. |
| `feeds[].plugin` | feed | Which configured plugin package interprets this feed's entries. |
| `feeds[].intervalSeconds` | feed | Poll interval in seconds. Defaults to 900. |

The SABnzbd API key can be supplied two ways: directly as a string in the config, or as
`file:/run/secrets/sabnzbd_api_key`, which Pickarr resolves by reading that file at
startup. Docker Compose secrets are mounted exactly there, so the key never has to sit
in an environment variable, `docker inspect` output, or a crash dump of `process.env`.

## Operational notes

**No authentication.** Pickarr has no login and no session handling — anyone who can
reach its port can browse and pick. Run it on a trusted LAN or put it behind a reverse
proxy that handles auth; do not expose it directly to the internet.

**Trash is never emptied.** When an import supersedes a previously-imported file, the
old file moves to `trashDir` instead of being deleted. Pickarr never removes anything
from `trashDir` itself — that directory only grows. This is deliberate: it is the only
destructive operation anywhere in the system, so reclaiming that disk space is a manual
decision you make, not something Pickarr decides for you.

**Each Pickarr instance needs its own SABnzbd category.** Pickarr recovers downloads by
matching an SABnzbd label to a row in its own database, and that label is unique only
within one Pickarr instance's database — it carries no per-installation salt. If two
Pickarr instances shared a SABnzbd category, each could pick up and "recover" the
other's job. If you run more than one Pickarr instance against the same SABnzbd server,
give each its own category.

## Building the image directly

```bash
docker build -t pickarr:latest .
docker run -d \
  -p 8080:8080 \
  -v "$(pwd)/config:/config" \
  -v /srv/media/scenes:/media/scenes \
  -v /srv/downloads:/data/downloads \
  -v /srv/trash:/data/trash \
  -v "$(pwd)/secrets:/run/secrets:ro" \
  pickarr:latest
```

`@pickarr/web` (React, Vite) is built into static assets during the image build and is
not present as a dependency in the runtime image — the running container only needs
Node, Fastify, and SQLite.

## Development

```bash
npm ci
npm run check   # lint + typecheck + tests
npm run build   # build every workspace, including the SPA
```
