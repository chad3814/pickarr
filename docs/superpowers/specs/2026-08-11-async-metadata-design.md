# Asynchronous metadata — Design

Date: 2026-08-11
Status: approved for planning
Branch: `async-metadata`

## 1. What this adds

A group on Browse currently shows only what the parser read out of a release name: a
site, a title made of dotted words, a date. This adds a second layer — the canonical
title, the performers, the release date, the running time, a synopsis, and cover art —
fetched from ThePornDB and rendered alongside the parsed fields.

The fetch is asynchronous, and that is the substance of the design rather than an
implementation detail. `resolveSitesForBatch` already talks to the same service, but it
does so *synchronously, before parse*, and its own comment explains why that ordering is
forced:

> Ordering is the whole point. `parse` is synchronous and its output is an identity key
> that outlives the tick, so a site learned *after* a name is parsed cannot be applied to
> it without re-keying a group the user may already have picked.

Scene metadata is under no such constraint, because **it never reaches the identity
key**. That is what makes it safe to fetch late, off the ingest path, at whatever rate
the service tolerates.

## 2. Scope

In scope:

- A lazy, queued, rate-limited metadata worker.
- Storage for confirmed metadata, cached negatives, and rejected near-misses.
- A locally-cached poster per group, served by Pickarr.
- A strict confirmation rule, owned by the plugin.
- Browse cards rendering metadata alongside the parsed display.

Explicitly out of scope:

- **Changing identity or grouping.** Metadata is display-only. Using it to collate two
  groups the parser read differently is real and wanted, but it is phase 2: it re-keys
  groups after the fact, and issue #39 already tracks the pain of a group re-keying
  itself. Phase 2 will offer a *suggestion a human confirms*, reusing the shape issue #41
  describes.
- **Adopting metadata into the display.** The parsed title stays the title on screen. A
  "use this title" action is phase 2.
- **Refresh.** Metadata is fetched once. Nothing re-checks a scene whose details later
  change upstream.
- **Performer or site pages.** We store performer names as text, not entities.
- **Artwork eviction.** See §10.

## 3. Why lazy, and what stops it looping

Metadata is requested for the groups the SPA actually rendered, not for every group
ingested. A feed backfill can create thousands of groups in a tick; enriching all of them
would spend thousands of requests on cards nobody opens.

The hazard of a lazy trigger is the opposite one: browsing the same page repeatedly
re-asking the same questions forever. The rule that prevents it is the one
`discovered_sites` already established —

> `site IS NULL` is a real answer — "this prefix is not a site" — and is the reason the
> table exists rather than a plain list.

A `group_metadata` row means *answered*, and `state = 'none'` is an answer. The request
endpoint enqueues only groups with **no** `group_metadata` row and **no** queue row. A
group that has been looked up and matched nothing is never looked up again.

`GET /api/browse` stays a pure read. The SPA asks for metadata with an explicit `POST`,
like every other write in this system.

## 4. Data model

Migration 5. Three new tables, and one new column on an existing one.

(Migration 4 is `rekeySiteSegments`, from "Key a scene by a site's identity, not by how
the release spelled it". Nothing here depends on it beyond the version number, but it must
land first, because it deletes and merges `media_groups` rows and every table below
carries a `group_id` foreign key into them.)

```sql
CREATE TABLE group_metadata (
  group_id     INTEGER PRIMARY KEY REFERENCES media_groups (id),
  state        TEXT    NOT NULL,   -- 'confirmed' | 'none'
  source       TEXT    NOT NULL,
  source_uuid  TEXT,               -- the provider's scene uuid, when confirmed
  title        TEXT,
  performers   TEXT,               -- JSON array of names
  release_date TEXT,               -- ISO yyyy-mm-dd, as the provider gives it
  duration_s   INTEGER,
  synopsis     TEXT,
  poster_url   TEXT,               -- what was downloaded; kept for diagnosis, and so a
                                   -- later re-fetch has somewhere to fetch from
  poster_path  TEXT,               -- relative path inside the artwork cache
  fetched_at   INTEGER NOT NULL
);

CREATE TABLE metadata_queue (
  group_id     INTEGER PRIMARY KEY REFERENCES media_groups (id),
  requested_at INTEGER NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      INTEGER NOT NULL,
  last_error   TEXT
);
CREATE INDEX metadata_queue_due ON metadata_queue (next_at);

CREATE TABLE metadata_candidates (
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES media_groups (id),
  source      TEXT    NOT NULL,
  source_uuid TEXT,
  title       TEXT    NOT NULL,
  scene_date  TEXT,
  reason      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX metadata_candidates_group ON metadata_candidates (group_id);

ALTER TABLE discovered_sites ADD COLUMN source_id INTEGER;
```

`state` is an explicit column rather than something inferred from `source_uuid IS NULL`.
`discovered_sites` had to make its uuid nullable so that a provider publishing no
identifier could still answer positively, which means nullability cannot also carry
"was there a match".

A queue row is deleted the moment an answer is written, so *pending* is exactly *has a
queue row*, and the table stays proportional to outstanding work rather than to history.

`metadata_candidates` holds what was rejected and why. It is never displayed. It exists
so phase 2 has evidence to work from, and so the confirmation rule can be measured
against a corpus the way the parser already is — see §12.

Near-misses are written **once, in the same transaction as the answer they accompany**.
A group is only ever answered once, so the rows cannot accumulate across retries; a
lookup that failed outright writes neither an answer nor a candidate, because it produced
no candidates to judge.

### 4.1 `discovered_sites.source_id`

`GET /scenes` filters by `site_id=<integer>`. `discovered_sites` stores only the uuid,
and migration 2's comment says that was deliberate:

> ThePornDB also publishes a numeric id, but `GET /sites/<id>` and `GET /sites/<uuid>`
> return the same record, so storing both would be two columns for one fact.

True for *fetching a site record*; not true for *filtering scenes*, where the parameter
accepts only the integer. Hence the new nullable column.

Rows written before this migration have no integer id. Those groups query with `q=`
alone and are filtered afterwards by comparing the result's own `site` object, which the
confirmation rule does regardless — so the query is broader but the verdict is not weaker.

**The column backfills itself.** A scene response embeds a `site` object carrying both
`uuid` and `id`. The first successful scene lookup for a site therefore learns its
integer id at no extra cost, and the worker writes it back. No `/sites/<uuid>`
round-trip, no migration backfill pass.

## 5. Plugin contract

Two optional hooks, mirroring `siteCandidates`/`learnSites`. That pair's comment states
the principle this follows:

> These two hooks are the seam: the host collects candidates for a whole batch, resolves
> them however it likes, hands back the confirmed ones, and only then parses.

```ts
export interface GroupIdentity {
  readonly identityKey: string;
  readonly display: DisplayFields;
}

export interface MetadataQuery {
  /** Search strings to try, in order. The first yielding a confirmation wins. */
  readonly queries: readonly string[];
  /** Site to narrow by. Core resolves the name to a provider id via its own cache. */
  readonly siteName?: string;
  /** The group's own date, ISO yyyy-mm-dd, when it has one. */
  readonly date?: string;
}

export interface MetadataCandidate {
  readonly sourceUuid: string | null;
  readonly title: string;
  readonly siteUuid: string | null;
  readonly siteId: number | null;
  readonly siteName: string;
  readonly date: string | null;
  readonly performers: readonly string[];
  readonly durationSeconds: number | null;
  readonly synopsis: string | null;
  readonly posterUrl: string | null;
}

export interface MetadataRejection {
  readonly candidate: MetadataCandidate;
  readonly reason: string;
}

export interface MetadataVerdict {
  readonly confirmed: MetadataCandidate | null;
  readonly nearMisses: readonly MetadataRejection[];
}
```

On `MediaTypePlugin`:

```ts
metadataQuery?(group: GroupIdentity): MetadataQuery | null;
confirmMetadata?(
  candidates: readonly MetadataCandidate[],
  query: MetadataQuery,
): MetadataVerdict;
```

A plugin implementing neither gets no metadata, and core hides the panel — the same way a
plugin implementing no manual hooks gets no edit UI.

The plugin returns a site *name*; core resolves it to an id. Site discovery, its cache,
and its identifiers are core's, and the plugin has no business knowing that a site has a
numeric id at ThePornDB.

`GroupIdentity` carries `display` because that is where the site name now lives.
`path-template.ts` reads `display.subtitle` for `{site}`/`{Site}`/`{SiteName}` and
documents it as *"the site's canonical name"*, so `metadataQuery` reads the same field
rather than reconstructing a name from the key.

**`subtitle` is optional on `DisplayFields`.** A group without one has no site — dateless
releases from an unknown site are the case that produces this. `metadataQuery` returns
`null` for such a group, which leaves it unenqueued rather than searching on title alone;
§13 records the consequence.

## 6. The confirmation rule

Owned by `plugin-scenes`. Two corroborating axes, because one is not enough: a title
alone matches other scenes with the same title, and a site alone matches everything that
site ever published.

Candidates are first filtered to those whose site matches the group's — by integer id
when known, else uuid, else the comparison-key of the name (lowercased, alphanumerics
only), which is the same normalisation `resolve-sites.ts` uses.

Since migration 4, that last comparison needs no normalisation of our side at all: the
identity key's site segment already *is* that form. `parse.ts` builds it with
`value.toLowerCase().replace(/[^a-z0-9]+/g, '')`, character for character what
`comparisonKey` computes, and `site-key.test.ts` pins it (`identityKey.startsWith('touchmywife:')`).
So the fallback is comparison-key of the provider's site name against the key's own site
segment, with nothing in between to disagree.

| Group has | Confirmed when | Otherwise |
|---|---|---|
| site + date | site matches **and** scene date is within `DATE_TOLERANCE_DAYS` | near-miss |
| site, no date | site matches **and** title comparison-key matches | near-miss |

```ts
/**
 * How far a scene's published date may sit from the date in the release name.
 *
 * Scene dates are wiggly. The date a release name carries is the date whoever
 * packaged it used, which is not reliably the date the site published under —
 * timezones, staggered regional releases, and a site's own backdating all move
 * it by a day or two.
 *
 * This is a filter, not a decision. A site publishing daily has five scenes
 * inside this window, so the window narrows the field and the tiebreak below
 * settles it.
 */
const DATE_TOLERANCE_DAYS = 2;
```

**Tiebreak, when more than one candidate survives the window:**

1. An exact date match wins outright.
2. Otherwise the closest date wins.
3. If two remain equally close, a title comparison-key match wins.
4. If two remain indistinguishable after all three, **there is no confirmation.** Both
   are recorded as near-misses with reason `ambiguous: N candidates within date window`.

Step 4 is the point of the rule. A daily-publishing site guarantees several plausible
candidates for every scene, and picking one by position in the response would attach a
different scene's performers to a card and never say so. The existing
`MIN_CONFIRMED_SITE_LENGTH` comment settles the same trade the same way: *"The parse rate
drops and the output improves, which is the second time that pair has come up — rate is
not the objective."*

Near-miss reasons are a small closed vocabulary, so they can be counted:
`site differed`, `date outside window`, `title differed`, `ambiguous: N candidates within
date window`.

## 7. The provider client

`searchScenes` joins `searchSites` in `clients/theporndb.ts`, sharing `redactToken`, the
defensive body reader, and the bearer-token header. The existing split holds: the client
returns results, the plugin returns the verdict.

```
GET /scenes?q=<title>&site_id=<integer>   # site_id omitted when unknown
```

Response fields consumed, from `data[]`:

| Field | Becomes | Notes |
|---|---|---|
| `id` | `sourceUuid` | **A uuid string.** See below. |
| `title` | `title` | |
| `description` | `synopsis` | Stored verbatim. See below. |
| `date` | `date` | ISO `yyyy-mm-dd`. |
| `duration` | `durationSeconds` | Assumed seconds; **verify against the live API**. |
| `performers[].name` | `performers` | **Not `full_name`** — that carries a disambiguation suffix, e.g. `Jessica Jaymes (2005)`. |
| `site.uuid`, `site.id`, `site.name` | site match + `source_id` backfill | |
| `posters.large` → `posters.full` → `poster` → `image` | `posterUrl` | First present wins. |

**The id naming is inverted between the two objects, and this is not a typo.** On a
scene, `id` is the uuid string and `_id` is an integer. On the nested site object, `uuid`
is the uuid and `id` is the integer. The reader carries a comment saying so, because it
reads like a bug and someone will otherwise "correct" it into one.

**One page, not ten.** `searchSites` walks up to `MAX_PAGES = 10` because one-word site
queries return hundreds of results (`anal` → 352, `big` → 649) and the answer can sit
anywhere in them. A scene query is a full title plus a site filter; a match that is not on
page one is one the confirmation rule was going to reject anyway. Paging would spend
requests to collect candidates we then discard.

**Poster preference favours TPDB's own CDN** (`posters.*`, `poster`) over the studio CDN
(`image`, `poster_image`), which is likelier to rotate paths or refuse a foreign referrer.
The example payload's `image` is 1279×719, so **posters are not reliably portrait** and
the card must not assume an aspect ratio.

**`description` is stored exactly as received.** The sample contains `Sam\\'s` — the
provider's own escaping is inconsistent. React escapes on render, so there is no injection
concern, and un-escaping heuristics would only invent a second kind of corruption.

The body reader is defensive in the same way `readSites` is: unknown fields are ignored,
and a structurally broken entry yields no candidate rather than a half-populated one.

## 8. The worker

`pipeline/metadata.ts`, one exported pass, driven by a third scheduler timer.

The timer uses `tryRun`, not `run`, for the reason the scheduler documents for reconcile —
a tick is *"a sample, not a work item"*. If the previous pass is still running, this tick
has nothing to contribute that the next will not.

Each pass:

1. Claims up to `perTick` rows with `next_at <= now`, oldest `requested_at` first.
2. For each, in sequence: build the query via `metadataQuery`, resolve the site id, search,
   confirm, write the answer, download the poster on a confirmation.
3. Stops early on a cooldown (§8.1).

Sequential, not concurrent. It is simpler, it is self-rate-limiting, and `searchSites`
already establishes the sequential-await pattern with a justified `eslint-disable`.

### 8.1 Failure, backoff, and 429

The distinction is the one `resolveSitesForBatch` already draws, and for the same reason:

- **A search that ran and matched nothing** is an answer. Write `state = 'none'`, delete
  the queue row. Never asked again.
- **A lookup that could not be made** — network, auth, 5xx — learned nothing. Write no
  metadata row. Increment `attempts`, record `last_error`, push `next_at` out on
  exponential backoff capped at six hours. *"Nothing was learned, and recording one would
  make an outage permanent."*

Backoff never gives up and never floods, which is the failure mode issue #38 describes for
the parse-failure log.

**A 429 stops the whole pass.** The worker reads `Retry-After`, sets a cooldown until that
moment, and returns without touching the remaining rows. Continuing would spend one
request per row discovering the same rate limit repeatedly. Rows not reached keep their
`next_at` and are picked up normally.

Every distinct failure is logged once per pass with the group id, not once per attempt.

## 9. Configuration

A new optional top-level block. Absent, it takes the defaults below.

```json
"metadata": {
  "enabled": true,
  "intervalSeconds": 5,
  "perTick": 5,
  "artworkDir": "/config/artwork"
}
```

| Field | Default | Meaning |
|---|---|---|
| `metadata.enabled` | `true` | Whether the worker runs at all. Off means no lookups and no queue draining; existing metadata is still served. |
| `metadata.intervalSeconds` | `5` | How often the worker wakes. |
| `metadata.perTick` | `5` | Most groups one pass will look up. With the default interval that is a ceiling of one request per second, before backoff or cooldown. |
| `metadata.artworkDir` | `artwork/` beside the SQLite file | Where posters are cached. |

**Credentials come from the existing `siteLookup` block**, which already carries the API
key and base URL for the same service. Renaming that key would break every documented
config for a cosmetic gain. **No `siteLookup` means no metadata**, exactly as it already
means no site lookup — the worker logs that it is idle for want of credentials, once at
startup rather than every tick.

Validated at startup by the same schema that rejects everything else, so a bad value fails
the container rather than surfacing as a silent non-fetch.

## 10. Artwork

Downloaded by the worker immediately after a confirmation, into a cache directory that
defaults to `artwork/` beside the SQLite file. That path is already on the `/config` mount
in the documented compose file, so posters survive container recreation without asking
anyone for a new volume. Overridable with `metadata.artworkDir`.

This is the only place Pickarr writes remote binary content to disk, so it is constrained
deliberately:

- **Content-type allowlist:** `image/jpeg`, `image/png`, `image/webp`. Anything else is
  not written, and the metadata row is stored without a poster.
- **The extension comes from the validated content type, never from the URL**, so a URL
  ending `.php`, or containing `..%2f`, cannot steer the path.
- **The filename is `<group_id>.<ext>`** — an integer from our own database, which cannot
  contain a path separator. Safer than sanitising a provider-supplied string, and it needs
  no argument about whether the sanitising is exhaustive.
- **A 5 MiB cap**, streamed and aborted on exceeding it, so a hostile or broken response
  cannot fill the disk.
- **Written to a temp file and renamed**, so a crash mid-download cannot leave a truncated
  file that still looks like a valid image.
- **`fs.promises` throughout.** This shares an event loop with Fastify; a sync write stalls
  every other request in flight.

A poster failure is not a metadata failure. The metadata row is written either way, with
`poster_path` left null.

**Nothing is ever evicted.** This matches the stance the README already takes on
`trashDir`, and it is stated rather than hidden: growth is one image per group ever
browsed, bounded by 5 MiB each. See §13 for the consequence.

## 11. HTTP and web

### 11.1 Endpoints

**`POST /api/metadata/request`** — body `{ groupIds: number[] }`, length-capped at the
browse page limit. Inserts queue rows only for groups with neither a `group_metadata` row
nor an existing queue row. Returns `{ queued, alreadyAnswered, pending }`. Idempotent, so
a re-render or a double-tap costs nothing.

A group whose plugin implements neither hook is **never enqueued** — it would occupy a
queue row the worker could only ever discard. Such ids come back counted as
`alreadyAnswered`, since from the client's side the question is equally settled.

**`GET /api/metadata?ids=…`** — returns, per id, the stored metadata or
`{ state: 'pending' }` / `{ state: 'absent' }`. One request polls a whole page.

**`GET /api/groups/:id/poster`** — `sendFile` from the artwork cache; 404 when there is no
poster or the file is gone. Registered as an explicit route rather than served by the
static plugin, so no arbitrary path under the cache dir is reachable.

**`GET /api/browse`** gains a `metadata` field per group and remains a pure read.

Metadata for a page is fetched in **one keyed query**, not one per group. Issue #31 records
`/api/downloads` returning every row with one query per row, polled every three seconds, as
a defect; there is no reason to add a second instance of a known bug.

### 11.2 SPA

`useGroupMetadata` collects the group ids actually rendered, sends one `POST`, then polls
`GET /api/metadata` while anything is pending — with backoff, and a stop once nothing is
pending — patching cards in place. `useIdentityPreview.ts` is the existing precedent for a
hook that asks core about a group.

`MediaCard` gains an optional metadata panel rendered **alongside** the parsed display, not
replacing it. Parser-derived identity stays what the card asserts; the metadata panel is
visibly a second opinion. That keeps phase 1 non-destructive and leaves "adopt this title"
to phase 2.

The panel must tolerate a missing poster, a missing synopsis, and an empty performer list
independently — the provider populates these unevenly.

## 12. Testing

- **`core/test/clients/theporndb.test.ts`** — scene search against the documented payload:
  field extraction, the `id`/`_id` inversion, `performers[].name` over `full_name`, poster
  preference order, a garbage entry yielding no candidate rather than a partial one, token
  redaction on failure, and that only one page is requested.
- **`plugin-scenes/test/confirm-metadata.test.ts`** — the §6 table in both directions: exact
  date, date at the window edge, date one day outside it, the dateless path, each near-miss
  reason, and the ambiguity tiebreak with several same-site candidates inside the window.
  This is where the rule earns its keep, so it gets the most cases.
- **`core/test/pipeline/metadata.test.ts`** — negatives cached; failures *not* cached;
  backoff advancing and capping; 429 aborting the pass and leaving later rows untouched;
  `perTick` respected; `source_id` backfilled from a scene response; a poster failure still
  writing the metadata row.
- **`core/test/db/metadata.test.ts`** — queue insert idempotence, and the rule that an
  answered group is not re-enqueued.
- **Artwork** — content-type rejection, byte-cap abort, temp-then-rename, extension taken
  from content type and not the URL.
- **`core/test/http/metadata.test.ts`** — the three endpoints, plus an assertion that browse
  issues one metadata query per page rather than one per group.
- **`web/test/MediaCard.test.tsx`** — the panel with metadata, without it, and with each
  field independently absent. Avoiding `assert.equal(screen.queryByText(x), null)`, which
  issue #40 records as OOM-killing the web run.

- **`e2e/tests/metadata.spec.ts`** — one Playwright journey, using the harness added in
  "Test across the client/server seam, in a real browser": browse a page with a stubbed
  provider, assert the card starts without metadata, and assert it fills in without a
  reload. The request/worker/poll loop is the one part of this feature that exists only
  in the seam between client and server, so unit tests on either side can both pass while
  the card never updates. That is exactly the gap `packages/e2e` was added to close.

A corpus-style harness for the confirmation rule is **not** in this phase, but
`metadata_candidates` is the table it would read, which is part of why near-misses are
persisted.

## 13. Known risks

- **Deleting the artwork directory leaves cards without posters.** The metadata row still
  records that one was fetched, and nothing re-fetches it. Recovering means clearing the
  paths by hand:
  `UPDATE group_metadata SET poster_path = NULL WHERE poster_path IS NOT NULL;`
  Self-healing re-fetch is the obvious phase-2 improvement; this phase documents the
  footgun instead of hiding it.
- **The artwork cache only grows**, exactly as `trashDir` does. One image per browsed
  group, capped at 5 MiB each. Reclaiming the space is a manual decision.
- **A confirmed match can still be wrong.** Two corroborating axes make it unlikely, not
  impossible — a site that publishes two scenes on one date with similar titles can defeat
  it. The near-miss table is the only visibility into how often the rule is close to the
  edge.
- **`duration` units are assumed to be seconds.** The documented example shows `1000`,
  which is plausible either way. Verify against the live API before trusting the rendered
  running time.
- **Lazy fetching means an unbrowsed group has no metadata**, so anything later built on
  metadata coverage — phase 2's merge suggestions especially — sees a partial picture
  skewed toward what has been looked at.
- **A group with no site gets no metadata at all.** `display.subtitle` is optional, and a
  group without one is never enqueued — searching on title alone across every site the
  provider knows is how you confirm the wrong scene. These are the same dateless,
  unknown-site releases the README already says need a configured site list to parse
  correctly, so the fix is again `siteLookup`'s rather than this feature's.
- **A group whose site was never discovered queries with `q=` alone.** Precision then rests
  entirely on the post-filter, and a common title may return only same-titled scenes from
  other sites, all of which are correctly rejected — producing a cached `none` for a scene
  the provider does know. Discovering the site first is what fixes it, which is
  `siteLookup`'s job, not this feature's.
