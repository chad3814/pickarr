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
| `server.port` | top level | HTTP port Pickarr listens on. Overridable with the `PICKARR_PORT` environment variable. The container's healthcheck resolves the port the same way boot does — this field, with that variable winning — so setting either one alone is enough. |
| `database.path` | top level | Path to the SQLite file. Put it under `/config` so it survives container recreation. |
| `trashDir` | top level | Where superseded files are moved instead of deleted. See "Trash is never emptied" below. |
| `plugins.<package>` | plugin | Per-plugin settings, keyed by package name. The bundled scenes plugin takes `libraryRoot`, the destination directory imports land in. |
| `plugins.<package>.pathTemplate` | plugin (scenes) | Where imports land under `libraryRoot`. Defaults to scene naming — see "Naming your files" below. |
| `plugins.<package>.sites` | plugin (scenes) | Optional list of site names. Used only for releases that put the date at the *end* of the name, where nothing separates the site from the title — see "Naming your sites" below. |
| `downloadClients[]` | top level | One or more download clients: `type: "sabnzbd"` or `type: "qbittorrent"`. Configure more than one and use `feeds[].downloadClient` to say which feed's picks go where. A qBittorrent client can only be added by editing this file — see "Using qBittorrent" below. |
| `downloadClients[].url` | download client | Base URL of the client's web UI/API. |
| `downloadClients[].apiKey` | download client | SABnzbd: the API key, required. qBittorrent: an API key generated in Preferences → WebUI → API Key, used instead of `username`/`password` — see "Using qBittorrent" below. Either form accepts a `file:/run/secrets/<name>` reference to read it from a Docker secret instead of embedding it in the config file. |
| `downloadClients[].username` | download client | qBittorrent only. Paired with `password` as the alternative to `apiKey`. Plain text: unlike `apiKey` and `password`, it does not accept a `file:` reference. |
| `downloadClients[].password` | download client | qBittorrent only, paired with `username`. Accepts a `file:/run/secrets/<name>` reference the same way `apiKey` does. |
| `downloadClients[].category` | download client | The category (SABnzbd) or category/tag (qBittorrent) Pickarr uses for its own jobs. **Must be unique to this Pickarr instance** — see below. |
| `downloadClients[].importMode` | download client | `"move"` or `"copy"` — what happens to a completed download when it's imported into the library. **A qBittorrent client requires `"copy"`**; `"move"` is refused when the config is loaded or saved — see "Using qBittorrent" below. |
| `downloadClients[].pathMappings[]` | download client | `{ from, to }` pairs translating the client's view of a completed download's path into the path Pickarr sees on its own filesystem. |
| `siteLookup` | top level | Optional. A metadata service used to confirm site names for releases that put the date at the end. Omit it and those releases file under their first word. |
| `siteLookup.type` | site lookup | `"theporndb"` is the only supported value. |
| `siteLookup.apiKey` | site lookup | The service's API key, or a `file:/run/secrets/<name>` reference. Sent as a bearer token, never in a URL. |
| `siteLookup.baseUrl` | site lookup | Defaults to `https://api.theporndb.net`. |
| `metadata` | top level | Optional. Configures the scene-metadata worker described in "Scene metadata" below. |
| `metadata.enabled` | metadata | Defaults to `true`. Set `false` to turn the worker off entirely, regardless of whether `siteLookup` is configured. |
| `metadata.intervalSeconds` | metadata | How often the worker wakes up to drain its queue. Defaults to 5. |
| `metadata.perTick` | metadata | Groups looked up per wake-up. Defaults to 5 — with the default interval, a ceiling of one request per second before backoff or a rate-limit cooldown slows it further. |
| `metadata.artworkDir` | metadata | Where cached posters are written. Defaults to an `artwork/` directory next to `database.path`. |
| `feeds[]` | top level | One or more RSS feeds to poll. |
| `feeds[].url` | feed | The RSS feed URL, including any indexer API key. |
| `feeds[].plugin` | feed | Which configured plugin package interprets this feed's entries. |
| `feeds[].downloadClient` | feed | Optional. The `downloadClients[].id` that picks on this feed are submitted to. Defaults to the **first entry in `downloadClients`**, so a config that names no client anywhere behaves exactly as it always has. Naming a client that is not configured fails at startup. Editable from the Settings screen. |
| `feeds[].intervalSeconds` | feed | Poll interval in seconds. Defaults to 900. |
| `feeds[].backfill` | feed | Optional, and **absent by default**. Walks the feed's own pagination to build a backlog — see "Backfilling a feed's history" below. Editable from the Settings screen, or by hand. |
| `feeds[].backfill.style` | backfill | `newznab` (sends `offset` and `limit`) or `page` (sends a one-based `page`). Stated, never guessed — a wrong value is caught, see below. |
| `feeds[].backfill.pageSize` | backfill | Items the indexer returns per page. Defaults to 100. Must match reality: too large silently skips items, too small merely re-reads them. |
| `feeds[].backfill.pagesPerPass` | backfill | Pages fetched per pass. Defaults to 2, minimum 2. This is also the rate limit. |
| `feeds[].backfill.maxPages` | backfill | Total pages ever walked for this feed before it stops. Defaults to 100. |

### Using qBittorrent

A qBittorrent client needs **qBittorrent 5.x** — that is the supported floor. Within
5.x, which credential you configure depends on the version:

- **Cookie login** (`username` and `password`) works on every 5.x release. Pickarr
  logs in once and carries the session cookie on later requests, re-logging in once if
  the session expires.
- **API key** (`apiKey`) needs **qBittorrent v5.2.0 or WebAPI v2.14.1**, not 5.x
  generally. An installation on 5.0 or 5.1 has no key to configure yet — use
  `username`/`password` there instead. If you configure an `apiKey` against a server
  too old to have one, authentication fails and the error names v5.2.0 rather than
  leaving you to guess why a valid-looking key doesn't work.

Configure **exactly one** of `apiKey`, or `username` together with `password` — never
both, and never a half-filled pair. Both `apiKey` and `password` accept a
`file:/run/secrets/<name>` reference; `username` does not, since it isn't a secret.
For example, an API-key client:

```json
{
  "id": "qbt",
  "type": "qbittorrent",
  "url": "http://qbittorrent:8080",
  "apiKey": "file:/run/secrets/qbittorrent_api_key",
  "category": "pickarr",
  "importMode": "copy",
  "pathMappings": [{ "from": "/downloads", "to": "/data/downloads" }]
}
```

or the same client with cookie login instead of `apiKey`:

```json
{
  "id": "qbt",
  "type": "qbittorrent",
  "url": "http://qbittorrent:8080",
  "username": "pickarr",
  "password": "file:/run/secrets/qbittorrent_password",
  "category": "pickarr",
  "importMode": "copy",
  "pathMappings": [{ "from": "/downloads", "to": "/data/downloads" }]
}
```

`config.example.json` shows the API-key form; JSON can't carry a comment showing both
side by side, so the alternative is here instead.

**`importMode` must be `"copy"`, and that means the data exists twice for as long as
the torrent seeds.** A torrent's data has to stay in place for qBittorrent to go on
seeding it, so unlike SABnzbd, Pickarr cannot move the file into the library — it copies
it in and leaves the original where qBittorrent put it. Budget download-directory space
for whatever you intend to keep seeding, on top of the library copy. `"move"` is refused
at startup or on save, naming the client, rather than silently stopping a seed.

**Pickarr never removes a finished torrent from qBittorrent.** It marks the download
imported in its own database and leaves the torrent alone, so the job keeps seeding and
stays in qBittorrent's list indefinitely. Pruning that list — the same way `trashDir`
is never emptied — is a decision left to you; see "Trash is never emptied" below.

**A stalled torrent (no seeders) stays visible on the Downloads tab rather than being
failed.** It shows its state and its progress, reporting whatever progress it had
reached when seeders disappeared and then holding there for as long as it's stalled,
and nothing in Pickarr gives up on it automatically. Deciding a stalled torrent isn't
coming and removing it is a human decision, made in qBittorrent or in Pickarr's own UI.

**A qBittorrent client can be added from the Settings tab.** "Add qBittorrent client"
sits beside "Add SABnzbd client" under Download clients, and the new row starts in `copy`
mode with an API key field, because `move` and a missing-or-doubled credential are both
refused on save and neither is a choice worth making a new client fail over. Switch the
row's Authentication control to a username and password if your qBittorrent predates
v5.2.0.

What Settings still cannot do is **change an existing client's type**. Converting a
SABnzbd client into a qBittorrent one, or the reverse, means editing
`config/config.json` — the server accepts it, but nothing in the form offers it.

### Backfilling a feed's history

A feed is normally polled for its current page only, so Pickarr sees a release if it
happens to be looking when that release appears, and knows nothing older than the first
poll. Adding a `backfill` block to a feed makes a second, much slower pass walk that
feed's pagination backwards:

```json
"feeds": [
  {
    "id": "indexer",
    "url": "https://your-indexer.example/rss?t=6000&apikey=...",
    "plugin": "@pickarr/plugin-scenes",
    "backfill": { "style": "newznab", "pageSize": 100 }
  }
]
```

This is safe to re-run and safe to interrupt. Items are deduplicated on
`(feed_id, guid)`, so a page read twice costs a few rejected inserts and nothing else,
and the walk's position is stored per feed and resumed rather than restarted.

**Pagination is not standardised, so you have to say which kind your indexer speaks.**
Newznab-style indexers take `offset` and `limit`; others take `page`. Pickarr does not
guess, because a wrong guess is the one failure that would be silent — an indexer that
ignores the parameter serves page one forever, and every item on it is already known.
If that does happen anyway, the walk notices that two consecutive pages carried the same
items and stops, recording why.

**It runs once an hour and reads two pages, by design.** The poll wants to be frequent
and shallow; the walk wants to be occasional and deep, because it is reading a history
that is not going anywhere. Backfilled titles also go through the same site lookup live
ones do — skipping that would file an old release under a different identity from the
same scene arriving today — so `pagesPerPass` is what keeps the walk from becoming a
burst against that service.

**Backfilled releases do not jump the queue.** A group created from a 2019 release sorts
by when that release was published, not by when Pickarr read it, and a backfilled
release that beats something you have already picked is flagged as an available upgrade
without lifting the group up the Browse list. Learning about the past is not the same
event as something new arriving. A feed that publishes no dates at all cannot be ordered
this way, and its backfilled items will sort as though they had just arrived.

**How to see where a walk has got to**, since there is no UI for it:

```sql
SELECT feed_id, next_page, pages_read, state, detail FROM feed_backfill;
```

`state` is `running` while there is more to read, `done` once a page came back empty,
`exhausted` if `maxPages` stopped it first (raise it and delete the row to continue), or
`broken` if the indexer turned out not to paginate, with `detail` saying which parameter
it ignored.

Each feed's row on the **Settings** screen carries a "Backfill history" selector — `Off`,
`Newznab (offset & limit)`, or `Page number` — and reveals the three numbers once a style
is chosen. There is deliberately no "detect automatically" option: nothing in an RSS
document says how an indexer pages, and a wrong guess is the one failure that would be
silent, so the options are named by what they send in order to be matched against your
indexer's own documentation.

The SABnzbd API key can be supplied two ways: directly as a string in the config, or as
`file:/run/secrets/sabnzbd_api_key`, which Pickarr resolves by reading that file at
startup. Docker Compose secrets are mounted exactly there, so the key never has to sit
in an environment variable, `docker inspect` output, or a crash dump of `process.env`.

### Editing settings from the browser

The `Settings` tab is a form over `config/config.json`: it edits the same file described
above, in place, rather than a separate store the container has to reconcile with it.
Saving validates the result the same way boot does — including rehearsing secret
resolution, so a `file:` reference that is missing or empty fails the save instead of the
next boot — and only then writes the file atomically.

**A save does not take effect on its own.** Pickarr keeps running with the settings it
booted with until it restarts, which is why the tab shows a restart button once a saved
change would actually change behavior. Clicking it asks Pickarr to shut down; whether it
comes back is entirely up to whatever is running the container. Under the shipped
`docker-compose.example.yml`, `restart: unless-stopped` means Docker starts it straight
back up with the new config loaded. Run the container bare, or with `restart: no`, and
there is no such supervisor: the restart button stops Pickarr and it stays stopped until
someone starts it again by hand. Check your restart policy before you rely on the button.

API keys and other secrets are never sent to the browser — the form shows only whether one
is set — and are left untouched by a save unless you explicitly replace them. A field you
left out of the file to track Pickarr's built-in default (`metadata.perTick`, a feed's
`intervalSeconds`, and so on) is written out explicitly the first time you save from this
form, with whatever value was in effect at that moment — it no longer tracks a future
change to the default the way an omitted field does.

The `Settings` tab also offers a database backup: a button that downloads a consistent
copy of `config/pickarr.db`, taken with SQLite's online backup API rather than a plain
file copy, so it is safe to use while Pickarr is running and writing to the database.

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

## Scene metadata

With `siteLookup` configured, a background worker looks up each scene in ThePornDB and
adds a poster, synopsis, and performer list to its card. **Nothing about identity or
grouping changes.** The card's title stays whatever the parser decided; the provider's
answer renders underneath as a second opinion, never a replacement.

**It is lazy.** Nothing is looked up until you look at it. Opening Browse or Picks tells
the server which groups are actually on screen, and only those are queued for a lookup — a
library with ten thousand groups you never scroll to costs nothing. This is the opposite of
site lookup above, which runs proactively on every feed tick because it has to: a release
needs its site settled before it can even be grouped, while a scene's poster and synopsis
are decoration a card can live without until someone is looking at it.

Credentials come from the `siteLookup` block already documented above — the metadata
worker and the site lookup both talk to the same service with the same key, so there is
only one place to configure it. **No `siteLookup` means no metadata**, exactly as it
already means no automatic site lookup; `metadata.enabled` defaulting to `true` does
nothing without it, and Pickarr logs that it is idle rather than pretending otherwise.

**A group with no confirmed site is never looked up.** The query sent to ThePornDB is a
title plus a site name, and a group without one has nothing to send but the title — and
searching a title alone across every site the provider knows is how you confirm the wrong
scene wearing the right name. Such a group simply carries no metadata; nothing retries it
once it gains a site.

**A "no match" answer is cached and never retried.** The first lookup that comes back with
nothing settles the question for that group forever — the same reasoning `discovered_sites`
already applies to a site prefix that isn't a site. Without this, a scene the provider
genuinely does not have would be re-queried and re-refused every time anyone ever browsed
its page.

**The poster cache grows and is never evicted**, the same as `trashDir` below: every
confirmed scene with a poster writes one file under `metadata.artworkDir`, and nothing here
ever deletes one. Reclaiming that space is a decision you make, not one Pickarr makes for
you. If you clear the directory by hand, the affected cards lose their posters, because the
database still records that one was fetched and the poster route will 404 for a file that
is no longer there.

Clearing the path does **not** bring the poster back:

```sql
UPDATE group_metadata SET poster_path = NULL WHERE poster_path IS NOT NULL;
```

That statement only stops the 404 — it does not queue a re-fetch, because the group's
`group_metadata` row still exists, and a group with a row is exactly what the lazy request
endpoint treats as already answered. Nothing re-asks a group that has already been
answered, poster or no poster. Recovering the poster means deleting the group's
`group_metadata` row (and any `metadata_candidates` rows for it) so the group looks
unanswered again, which gets it re-queued the next time it is browsed — a full re-fetch of
title, synopsis, performers and confirmation, not just the poster, and one that can in
principle land on a different verdict than the one already stored. There is no built-in
command for this today; a self-healing re-fetch that keeps everything but the poster is the
obvious phase-2 improvement.

**Picks requests and polls too, the same way Browse does.** `GET /api/picks` reads the
same `group_metadata` table Browse does, so a group already answered before it was picked
shows its poster, title, synopsis and performers immediately — that part was never a
limitation. Picks also asks: it calls `POST /api/metadata/request` for every group it
renders and polls `GET /api/metadata` while any of them is still pending, through the same
`useGroupMetadata` hook Browse uses, so a group that was never browsed and a lookup still
in flight both fill in live, without a reload. The one difference from Browse: `/api/picks`
returns every picked group in a single response rather than paging at 30, so the hook
chunks that list into batches of the endpoint's 100-id cap rather than assuming a whole
list of picks ever fits in one request. If metadata is unavailable server-wide — the worker
disabled, or no `siteLookup` configured — the request endpoint queues nothing and reports
those ids `unavailable`; the next poll then sees each of them settle at `absent` rather than
sit `pending`, so Picks does not poll forever for an answer that can never come.

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
