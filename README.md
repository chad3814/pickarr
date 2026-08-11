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
| `plugins.<package>.pathTemplate` | plugin (scenes) | Where imports land under `libraryRoot`. Defaults to scene naming — see "Naming your files" below. |
| `plugins.<package>.sites` | plugin (scenes) | Optional list of site names. Used only for releases that put the date at the *end* of the name, where nothing separates the site from the title — see "Naming your sites" below. |
| `downloadClients[]` | top level | One or more download clients. The MVP supports `type: "sabnzbd"` only. |
| `downloadClients[].url` | download client | Base URL of the SABnzbd instance. |
| `downloadClients[].apiKey` | download client | The SABnzbd API key, or a `file:/run/secrets/<name>` reference to read it from a Docker secret instead of embedding it in the config file. |
| `downloadClients[].category` | download client | The SABnzbd category Pickarr uses for its own jobs. **Must be unique to this Pickarr instance** — see below. |
| `downloadClients[].importMode` | download client | `"move"` or `"copy"` — what happens to a completed download when it's imported into the library. |
| `downloadClients[].pathMappings[]` | download client | `{ from, to }` pairs translating SABnzbd's view of a completed download's path into the path Pickarr sees on its own filesystem. |
| `siteLookup` | top level | Optional. A metadata service used to confirm site names for releases that put the date at the end. Omit it and those releases file under their first word. |
| `siteLookup.type` | site lookup | `"theporndb"` is the only supported value. |
| `siteLookup.apiKey` | site lookup | The service's API key, or a `file:/run/secrets/<name>` reference. Sent as a bearer token, never in a URL. |
| `siteLookup.baseUrl` | site lookup | Defaults to `https://api.theporndb.net`. |
| `feeds[]` | top level | One or more RSS feeds to poll. |
| `feeds[].url` | feed | The RSS feed URL, including any indexer API key. |
| `feeds[].plugin` | feed | Which configured plugin package interprets this feed's entries. |
| `feeds[].intervalSeconds` | feed | Poll interval in seconds. Defaults to 900. |

The SABnzbd API key can be supplied two ways: directly as a string in the config, or as
`file:/run/secrets/sabnzbd_api_key`, which Pickarr resolves by reading that file at
startup. Docker Compose secrets are mounted exactly there, so the key never has to sit
in an environment variable, `docker inspect` output, or a crash dump of `process.env`.

### Naming your files

`pathTemplate` decides where an import lands under `libraryRoot`. The default follows
scene naming:

```json
"pathTemplate": "{sitename}/{sitename}.{date}{episode}.{titledots}.{resolution}-{group}"
```

```
bangbros/bangbros.2026.08.03.chloe.upgrades.her.butt.2160p-WRB.mp4
inthecrack/inthecrack.E1178.tracy.gold.2160p-KTR.mp4
tripforfuck/tripforfuck.hiyori.japanese.2.mp4
```

For a more readable library, `{Site}/{isodate}{episode} - {Title}` gives
`Bang Bros/2026-08-03 - Chloe Upgrades Her Butt.mp4`.

| Placeholder | Renders | Notes |
|---|---|---|
| `{site}` / `{Site}` | `bang bros` / `Bang Bros` | words separated |
| `{sitename}` / `{SiteName}` | `bangbros` / `BangBros` | run together; the lower-case form matches ThePornDB's `short_name` |
| `{title}` / `{Title}` | `chloe upgrades her butt` / `Chloe Upgrades Her Butt` | words separated by spaces |
| `{titledots}` / `{TitleDots}` | `chloe.upgrades.her.butt` / `Chloe.Upgrades.Her.Butt` | scene style |
| `{date}` | `2026.08.03` | scene style; empty when the release carries none |
| `{isodate}` | `2026-08-03` | the same date, dashed |
| `{year}` | `2026` | empty when the release carries none |
| `{episode}` | `E1178` | empty unless the release is numbered rather than dated |
| `{resolution}` | `2160p` | |
| `{container}` | `mp4` | |
| `{group}` | `WRB` | |

Slashes make directories, so `{sitename}/{year}/{title}` nests by site then year. A
placeholder that renders empty takes its surrounding punctuation with it — `{date}{episode} - {Title}`
gives `Hiyori Japanese 2` for a release with neither — and a path segment that renders
empty is dropped rather than becoming a directory with no name. An unrecognised
placeholder is left in the path verbatim, so a typo is visible instead of silently
shortening every filename.

**Changing this moves nothing that is already imported.** Pickarr writes new files to the
new layout and leaves existing ones where they are, so a change part-way through leaves a
library split across two schemes until you move the old files yourself.

The default names the encode, so two encodes of one scene get two paths. That is
deliberate: an upgrade lands on its own path and the superseded file is trashed by group
rather than overwritten by path. Drop `{resolution}` and `{group}` and the two share a
path instead, which also works — the importer refuses an occupied destination until the
old file has been trashed.

Every value comes from the identity key or from the group's own record, never from the
individual release name, which is what keeps two encodes of one scene landing on one
path. (`{site}`, `{Site}` and `{SiteName}` are the group-record ones: the key's site
segment has no word boundaries, so they read the site's canonical name instead. It is
one value per group, so two encodes still render one path.) Two *different* scenes can
never collide under any template — there are tests pinning both directions.

### Naming your sites

Most scene releases put the date between the site and the title
(`Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB`), which is what lets Pickarr tell the
two apart. Some feeds instead put it at the end, and some carry no date at all:

```
Anal.Only.Getting.In.Savannahs.Booty.Savannah.Bond.2022.09.29.Upscaled.2160p
```

Here nothing marks where the site stops — `Anal`, `Anal Only`, and `Anal Only Getting`
are all readings a parser could defend. Pickarr recognises the shape (everything after
the date is encode information, and there is more before the date than after it) and
then needs you to resolve the split. List the sites you follow:

```json
"plugins": {
  "@pickarr/plugin-scenes": {
    "libraryRoot": "/media/scenes",
    "sites": ["Anal Only", "Bangbros", "Bangbros Ass Parade"]
  }
}
```

**Releases with no date need this list, or a lookup, to parse at all.**
`BralessForever.com.Emma.G.and.Rocky.Beach.Days.2160p` has nothing marking where the
site ends, so Pickarr refuses it until `Braless Forever` is a site it knows — there is no
first-word fallback for dateless names, because without a date nothing distinguishes a
scene release from any other release with the same shape. Such a scene files as
`Braless Forever/Emma G And Rocky Beach Days.mp4`, with no date in the name, and it will
not group with a dated release of the same scene.

The longest match wins, so listing both a network and its sub-site files scenes under
the sub-site. Separators and case do not have to match the release: releases write
`Bang Bros` as `BangBros`, `bangbros` and `Bang.Bros`, and all three match a site
configured as any one of those. **The spelling you configure is the one you get** — it
becomes the canonical name, so it decides the directory. Configure `Bang Bros` and
scenes land in `Bang Bros/`; configure `BangBros` and they land in `BangBros/`.

Re-spelling a site does *not* move its identity key: the key holds the separator-free
form all of those spellings collapse to, the same one matching compares. So a site
confirmed after some of its scenes were already ingested still collates with them.

**The list is optional.** Without it Pickarr treats the first word as the site, which
files `Anal Only`'s scenes under `Anal/`. That is a wrong directory, never a wrong
grouping: the whole pre-date run still reaches the identity key either way, so two
different scenes can never merge because of how the split fell.

### Looking sites up automatically

Maintaining that list by hand gets old. With `siteLookup` configured, a site Pickarr
does not recognise is looked up in ThePornDB before the batch is parsed, and confirmed
answers are remembered:

```json
"siteLookup": {
  "type": "theporndb",
  "apiKey": "file:/run/secrets/tpdb_api_key"
}
```

It searches for the first two words of the name, then the first word alone if that found
nothing. Two words first is what keeps it accurate: `bangbros ass` matches no site and
rules itself out, whereas `anal` on its own matches a great many sites that are not
`Anal Only`.

A result is believed only when it **is** one of the release's own leading runs — not
when it merely equals the query, and not merely because the search returned something.
That distinction does real work in both directions:

| Release | Query | Returns | Confirmed |
|---|---|---|---|
| `Free.Use.Fantasy.…` | `Free Use` | `Freeuse Fantasy`, `Free Use MILF`, … | `Freeuse Fantasy` |
| `2.Chicks.Same.Time.…` | `2 Chicks` | `2 Chicks Same Time`, `2 Chicks 1 Dick` | `2 Chicks Same Time` |
| `Bangbros.Ass.Parade.…` | `Bangbros Ass` → `Bangbros` | (none) → `Bang Bros`, … | `Bang Bros` |
| `Getting.In.Savannahs.…` | `Getting In` | `Getting In Deep`, `Getting Into It` | none |

The site is regularly longer than the query that found it, so a rule of "does a result
equal what I searched for" would reject `2 Chicks Same Time`. And because the search is
a substring search over 100k+ names, "did the search return anything" would invent a
site called `Getting In`. Matching against the release's leading runs answers both. The
longest run wins, so a four-word site beats the two-word run inside it, and site names
of more than twelve words are not considered.

Searches are paged. The service caps a page at 100 results and one-word queries often
exceed it (`anal` returns 352, `big` 649), so a search follows up to ten pages — but
stops after the first when the reported total is above 1000, which means the query was
too broad to be naming a site. Each prefix is only ever looked up once, hit or miss.

Answers are cached in the `discovered_sites` table, **including the negatives** — a
prefix that is not a site is asked about once, not every tick. A confirmed row also
keeps the service's `uuid` for the site, so a later feature can address it directly
rather than searching by name again. Your config list always
wins over a discovered one, and Pickarr never writes to your config file. To see what
it has learned:

```sql
SELECT prefix, site, source, source_uuid, found_at FROM discovered_sites ORDER BY prefix;
```

If a lookup *fails* — service down, bad key, rate limited — nothing is cached, and the
name falls back to its first word for that tick. That key is durable: the group stays
where it landed even after lookups recover. Pickarr logs a line naming each affected
title so you can see when it happened.

Changing a site's name only re-spaces or re-cases it — `Bang Bros` to `BangBros` — costs
nothing: the identity key is separator-free, so the group stays put and only the
directory name changes on future imports. Changing it to a *different* name changes the
identity key of its scenes, so anything already picked reappears as a new entry rather
than as an upgrade. Settle the naming before a long run, not during one.

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


### Measuring the parser against a corpus

`npm run corpus -- <file...>` runs the real parser over files of indexer titles, one
title per line, one file per tier, and reports what it does with them:

```bash
npm run corpus -- corpus/uhd.txt corpus/hd.txt corpus/sd.txt
npm run corpus -- corpus/*.txt --sites=sites.txt --examples=5
```

It prints the parse rate per tier, every refusal reason ranked by how many titles it
accounts for (which is what says where to spend effort next), collisions where distinct
content landed on one identity key, and how many site lookups the corpus would ask for —
without sending any.

The harness imports the shipped parser rather than reimplementing it, so what gets tuned
is what runs. It deduplicates, and buckets usenet artefacts (`.par2`, `.partNN.rar`, yEnc
subjects) separately rather than counting them as failures.

**10% of titles are held back by default** and never measured, keyed on the title itself
so the same ones are held across runs and file orderings. Tuning against a set you also
measure on reports overfitting back to you as progress. Check against the holdout at the
end with `--holdout=0`.
```bash
npm ci
npm run check   # lint + typecheck + tests
npm run build   # build every workspace, including the SPA
```
