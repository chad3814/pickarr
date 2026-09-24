# Plugin-fetched artwork for media items and people

**Date:** 2026-09-24
**Status:** proposed

## The problem

Pickarr has a complete artwork pipeline that nothing ever feeds.

`poster`, `background` and `logo` tables exist, each keyed
`UNIQUE (media_item_id, url)` with `width`, `height` and a cached `path`.
`MediaWriter` has `attachPoster`, `attachBackground` and `attachLogo`.
`ArtworkStore` measures bytes, refuses what it cannot measure, and caches
to disk. `GET /api/artwork/:kind/:mediaItemId` serves them.
`web/src/store/gather.ts` already hands every card three urls, and
`MediaItemCard` already renders an `<img>`.

**Not one of those rows is ever written.** The `<img>` 404s on every card;
`MediaItemCard.onError` removes it, which is why the browse screens look
the way they do. The plumbing was built for 1.x, which fetched from
ThePornDB directly.

### Why the obvious source does not work

The natural answer is "the lookup service provides them". It does not.
Read from the live document at `openmetadata.nexus/api/openapi.json`:

| | |
|---|---|
| `Media` fields | `id, kind, title, releaseDate, year, provider, providerRef, overview, details, parents, versions, people` |
| `people[]` fields | `providerRef, name, role, characterName, billingOrder` |
| `details` values | `string \| number \| null`, documented keys `siteName`, `siteRef`, `durationSeconds`, `releasedOn`, `runtimeMinutes`, `imdbId`, `tagline`, `collectionName` |
| endpoints | `/health`, `/lookup`, `/lookup/{id}`, `/media/{id}` — the last returns "the same object the lookup envelope embeds" |

There is no image field anywhere in that document, and no artwork
endpoint. openmetadata is an *identity* service: it tells you what a
release is, not what it looks like.

What it does give is the pair that makes artwork reachable —
`provider` and `providerRef`, on the media record and on every person.
So artwork is a *provider* concern, and the plugin is where it belongs.

## What this builds

A seam, one provider behind it, and the person half of the storage that
media items already have.

```
resolved lookup ─┬─> media_item, people            (today)
                 └─> enqueue artwork job            (new)
                          │
                          ├─ ArtworkSource for `media.provider`
                          │     tmdb ──> /3/{kind}/{ref}/images
                          │     tpdb ──> not registered yet (below)
                          │
                          ├─ pick one poster, one background, one logo
                          ├─ pick one image per person
                          └─ fetch bytes ──> MediaWriter.attach*  ──> ArtworkStore
```

### Only TMDB, and why the other provider waits

Two providers appear in this codebase: `tmdb` (television and film) and
`tpdb` (adult). **This slice registers TMDB only.**

That is a deliberate stop, not an oversight. TMDB's contract is public and
was read before this spec was written — `/3/movie/{id}/images` returns
`posters`, `backdrops` and `logos`, each entry carrying `file_path`,
`width`, `height`, `iso_639_1`, `aspect_ratio`, `vote_average` and
`vote_count`; `/3/configuration` returns `images.secure_base_url` and the
size lists; authentication is a bearer token. Every claim this design
makes about TMDB is checkable against those two documents.

ThePornDB's is not checkable the same way: reading it needs a key, and
going looking for the operator's credential to satisfy my own curiosity is
not a thing to do. Specifying a client from memory is how this repo's
worst defects have started, so `tpdb` is left **unregistered and loud** —
the job records `no artwork source for provider "tpdb"` once per provider,
not per item, and does nothing. Adding it later is one `ArtworkSource`
implementation and its registration.

### A job, not the resolved branch

Artwork runs as its own job, enqueued at the end of a successful lookup.

Inline would be wrong for a reason the `lookup_json` work already proved
expensive: `applyResolved` currently relinks the release, writes the
plugin's rows and records the resolution, and anything that throws in the
middle strands state. Artwork is the worst possible thing to add there —
one configuration call, one images call, and up to four binary downloads
from a CDN this host does not control. A slow image server would make the
lookup job's duration depend on it, and a failing one would fail the
lookup and re-run the whole identification on retry.

As its own job it retries on its own schedule, dead-letters on its own,
and a release stays identified whatever its pictures do.

### One image per slot, and sized at the source

**One poster, one background, one logo, one image per person.** Chosen by
`vote_average`, preferring an image whose `iso_639_1` matches the
configured language and then a language-neutral one (`null`), which is how
a poster with no text on it wins over a foreign-language one. Issue #79
already records that the serving route returns only the lowest-id row per
kind, so storing twelve posters would multiply disk for something nothing
can show.

**The url asks for a sized variant, not `original`.** This matters more
than it looks: `HostFetch.bytes` reads a whole `arrayBuffer()` with no
size cap, so this feature is the first thing in Pickarr to pull arbitrary
third-party binaries in bulk, and an unbounded `original` from a CDN is an
unbounded allocation in the host. TMDB publishes sized variants, so
`w780` for a poster, `w1280` for a backdrop, `w300` for a logo and `w185`
for a face bounds each download by construction — at the source, rather
than by a guard this side that has to be remembered. It also happens to be
the right call for a card that renders a 96px-wide poster.

A cap is still enforced after the download as a second line, because
"sized" is the provider's promise rather than ours.

### Person artwork

`person` has no artwork table, no writer and no route, where a media item
has all three. This adds the matching set:

- `person_image`, keyed `UNIQUE (person_id, url)`, the same columns the
  three media tables carry.
- `MediaWriter.attachPersonImage(personId, image)`, alongside the three
  that exist.
- `GET /api/artwork/person/:personId`, alongside the three kinds served.

**No UI renders a person today**, and this does not add one.
`store/gather.ts` already carries `roles`, so the client has the people
and will have their pictures; a card that shows a cast is a separate
change. Building the storage without the screen is deliberate — the data
has to exist before anything can render it, and the route is what makes
it verifiable rather than write-only.

### Credentials and absence

`resolveSecret('TMDB_API_KEY')`, the same chain the lookup key uses.

**Absent is not an error.** A host with no TMDB key logs once that artwork
is unavailable and skips the job, exactly as a host with no
openmetadata key logs and declines to look anything up. An operator who
does not want artwork should not have to configure anything to avoid it.

## Components

| File | Responsibility |
|---|---|
| `packages/contract/src/media.ts` | `attachPersonImage`, and `ImageInit` unchanged |
| `packages/host/src/db/migrate.ts` | `person_image` table, `installSyncTriggers` **not** called — artwork is not replicated (`gather.ts`, #79) |
| `packages/host/src/db/schema.ts` | the drizzle table, for DDL parity |
| `packages/host/src/media/writer.ts` | `attachPersonImage`, measuring through `ArtworkStore` like its three siblings |
| `packages/host/src/api/artwork-route.ts` | the `person` kind |
| `packages/openmetadata/src/artwork/source.ts` | the `ArtworkSource` seam and the provider registry |
| `packages/openmetadata/src/artwork/tmdb.ts` | TMDB's implementation: configuration cache, images call, selection |
| `packages/openmetadata/src/artwork/job.ts` | the job handler: source lookup, fetch, attach, per-provider skip |
| `packages/openmetadata/src/engine.ts` | enqueue at the end of `applyResolved` |

## Testing

- **Selection is a pure function and gets pinned hardest**: highest vote
  wins; the configured language beats a neutral image; a neutral image
  beats a foreign one; an empty array yields nothing rather than throwing.
- **The job never fails a lookup.** A source that throws, a download that
  404s, a byte string `image-size` refuses — each leaves the media item
  identified and the job's own failure visible, and none of them reaches
  `applyResolved`.
- **An unregistered provider logs once**, not once per item. Driven with
  two items from the same provider and a counted log.
- **No key means no job and no error.**
- **Idempotence**: running the job twice writes one row per slot and one
  file, which the unique indexes enforce and a second run must prove.
- **The migration adds `person_image` without touching a synced table**,
  and installs no sync triggers — artwork is deliberately not replicated.
- **Browser**: a card with a seeded poster row renders it, which is the
  one assertion that proves the whole path — row, file, route, `<img>` —
  and the only one `getByRole` cannot fake.

## Out of scope

- **ThePornDB.** See above. One `ArtworkSource` and one registration when
  its contract can be read.
- **A cast on the card.** Person artwork is stored and served; rendering
  it is a UI change with its own design.
- **Serving more than one image per kind** (#79). Unchanged by this.
- **Backfilling** artwork for media items resolved before this shipped.
  The job is enqueued on resolve; existing items get nothing until they
  are re-identified. A backfill is a separate, easy follow-up once the
  job exists.
