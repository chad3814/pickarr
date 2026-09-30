# Video resolution, stored (issue #98)

## Problem

`rss_item.resolution` is the **lookup state** (`'pending' | 'resolved' |
'refused' | 'unresolved'`), not a video resolution, and 2.0 stores a video
resolution nowhere. Two consequences, both in #98:

1. The browse card's release line printed the lookup state beside the
   filename, where an operator reads it as quality. Branch
   `release-line-polish` (commit `7f1e8e8`) replaced it with a parse of the
   filename in the browser. That is a stopgap and this design replaces it.
2. The importer's `{resolution}` path token was removed because it could
   only ever resolve to nothing.

## Goal

Every release carries a stored video resolution taken from the lookup
service's own parse, shown on the release line (or `unknown`), and usable as
`{resolution}` in a library path shape. The misleading column name is fixed
in the same change.

**Success:** a release line shows its stored resolution or `unknown`; no
code in the browser parses a filename; `{resolution}` saves in a shape and
resolves at import; nothing in the tree still calls the lookup state a
"resolution".

## Decisions already made

| Question | Decision |
|---|---|
| Source of the value | The lookup service's `parsed.quality.resolution`, not a parser of our own |
| Releases resolved before this change | Asked about again, once, by a backfill job that stores only the resolution |
| Rename `resolution` → `lookup_state` | Yes, in this change |
| How the backfill is started | A plugin migration inserts the job row directly |

## What the service actually sends

Measured against `https://openmetadata.nexus` on 2026-09-30, not read off the
OpenAPI document, which gives `parsed` no shape at all:

```
The.Bear.S03E01.2160p.WEB.h265-ETHEL.mkv          resolved    quality.resolution "2160p"
Oppenheimer.2023.1080p.BluRay.x264-GROUP.mkv      resolved    quality.resolution "1080p"
Some.Show.S01E01.720p.HDTV.x264-GRP               unresolved  quality.resolution "720p"
Dune.Part.Two.2024.UHD.BluRay.REMUX.HDR.HEVC-GRP  resolved    quality.resolution null, quality.source "UHD"
```

- `parsed.quality.resolution` is a string or `null`, present on resolved
  **and** unresolved answers.
- A bare `UHD`/`4K` is **not** read as `2160p` by the service. That is
  accepted: this design stores the service's answer, not a second opinion.
- `GET /api/v1/lookup/{id}` returns the same `parsed` (verified), but may
  404 once an answer expires, so the backfill does not rely on it.
- For a refused lookup the document says `parsed` "is the stored refusal
  record rather than a parse", so a refused release gets `null`.

## Accepted values

A stored video resolution matches `^[0-9]{3,4}[pi]$` (`480p`, `720p`,
`1080i`, `2160p`) or is `null`. Anything else the service sends --
another type, another string -- is stored as `null`.

The check exists because the value reaches a library path through
`{resolution}` and `parsed` is otherwise unvalidated third-party text. It is
applied in two places that must agree: `videoResolutionOf` in
`packages/openmetadata` (a regex) and the host migration's backfill (`GLOB`).

## 1. Data model: host migration

One new host migration (the next `HOST_MIGRATIONS` version), one savepoint,
in this order:

1. `ALTER TABLE rss_item RENAME COLUMN resolution TO lookup_state`
2. `ALTER TABLE rss_item RENAME COLUMN resolution_detail TO lookup_state_detail`
3. `ALTER TABLE rss_item ADD COLUMN video_resolution TEXT` -- nullable, no
   default.
4. Backfill unmatched rows from the answer they still hold:
   `UPDATE rss_item SET video_resolution = json_extract(lookup_json, '$.parsed.quality.resolution')`
   where `lookup_json` is not null, is valid JSON, and the extracted value
   `GLOB`s as three or four digits followed by `p` or `i`. The marker
   `LOOKUP_JSON_TOO_LARGE` has no `parsed` and extracts `NULL`, so it needs no
   case of its own.
5. Rotate `sync.generation` to a fresh random value through
   `db/host-state.ts`'s writer.

`docs/database-migrations.md` measures `RENAME COLUMN` and `ADD COLUMN` as
keeping the sync triggers, with their bodies rewritten, so no trigger reinstall
is needed. The step 4 `UPDATE` logs through them normally.

**Why rotate the generation.** Every client's replica holds `rss_item` rows
keyed `resolution`/`resolutionDetail`. A generation change is what clients
already treat as "discard the replica and bootstrap again" (`store/sync.ts`),
so after this migration no client ever holds a row in the old shape, and no
client code has to read both names. The cost is one full re-bootstrap per
client, once, on upgrade. The migration calls into `host-state.ts`, so that
helper's docblock says a migration depends on it, per the migrations guide's
rule.

Indexes naming `resolution`, if any, are rewritten by `RENAME COLUMN`. The
implementation checks `sqlite_master` rather than assuming.

## 2. Contract

`@pickarr/contract`:

- `RssItemSyncRead`: `resolution` → `lookupState`, `resolutionDetail` →
  `lookupStateDetail`, new `videoResolution: string | null`.
- `type Resolution` → `type LookupState`. Same four values.
- `MediaWriter.setResolution` → `setLookupState`. Same parameters, same
  required, never-defaulted `lookupJson`.
- New `MediaWriter.setVideoResolution(rssItemId: number, value: string | null): Promise<void>`.
  The writer re-checks the accepted pattern and throws on anything else. It
  is a shared writer that any plugin can call, so the host does not trust
  every caller to have run `videoResolutionOf` first.
- `tokens.ts`: `resolution` returns to the television, film and xxx token
  lists. The "`resolution` is not here" section is rewritten to say what the
  token now reads.
- `MediaPlugin.tokens`' docblock: the parenthetical about `resolution` being
  removed, and the counts (7/6/5 → 8/7/6), are updated.

`packages/openmetadata`'s own wire type `LookupState` (`'resolved' |
'unresolved' | 'pending'`, the envelope's `state`) is renamed
`EnvelopeState`, so the two never meet in one file under one name.

Every reader and writer of the old names moves with it: `host/src/media/writer.ts`,
`host/src/feeds/reader.ts` (inserts `lookup_state = 'pending'`),
`host/src/sync/tables.ts`' projection, `host/src/api/reads.ts`,
`host/src/db/schema.ts`, `web/src/library/Unmatched.tsx`,
`packages/e2e/src/harness-2.ts`'s seeding SQL, and the tests. There are about
60 files with non-comment references, most of them tests.

## 3. Write path for new lookups

- `videoResolutionOf(envelope: LookupEnvelope): string | null`, in
  `packages/openmetadata`. It reads `parsed.quality.resolution` by narrowing,
  never by casting, and returns it only if it matches the accepted pattern.
- `applyEnvelope` calls `ctx.media.setVideoResolution(target.rssItemId,
  videoResolutionOf(envelope))` once, beside the existing "recorded before
  the branch below decides anything" `lookupId` update. So every outcome
  writes it -- resolved, unresolved, refused (always `null`), and a
  pending/partial answer that already carries a parse -- and no terminal
  branch can forget to.
- A later answer for the same release, such as a retry from `/unmatched`,
  overwrites the value. The service's latest parse is the one kept.

## 4. Backfill for already-resolved releases

A resolved release's lookup answer was cleared when it was linked
(`relinkRssItem`), so these rows have nothing stored to read from.

**Marking and enqueueing.** `packages/openmetadata` exports
`videoResolutionBackfillMigration(pluginId: string, version: number): Migration`.
Each plugin's `migrations.ts` lists it explicitly at **version 3**. The engine
owns version 1 and every plugin already uses 2. Having each plugin assign the
number means a collision is visible in its own list, rather than the engine
appending a version a plugin might also use. `up(db)`:

1. `ALTER TABLE <plugin>_lookup ADD COLUMN video_resolution_backfill INTEGER NOT NULL DEFAULT 0`
2. Set it to `1` for every lookup row whose `rss_item.lookup_state = 'resolved'`.
3. If step 2 marked anything, insert one row into the host's `jobs` table:
   `plugin_id` = the plugin, `kind` = `video-resolution-backfill`,
   `payload_json` = `'{}'`, `attempts` 0, `max_attempts` 5 (the host's
   `DEFAULT_MAX_ATTEMPTS`, restated because a migration cannot import the host),
   `run_at`/`created_at`/`updated_at` = now in milliseconds from SQLite's own
   clock, `state` `'ready'`, `last_error` `NULL`.

Host migrations run before plugin migrations, so `lookup_state` and
`video_resolution` exist by the time this runs.

**The coupling this accepts.** The migration writes a host-owned table's
columns directly. Its docblock names every column it writes. A host test
registers a lookup plugin against a database migrated to the current host
schema and asserts the job row is dispatched to the handler. So a later
change to `jobs` fails that test, rather than the backfill silently never
running.

**The job** (`video-resolution-backfill`, added to `createLookupPlugin`'s
`jobs`):

1. Select up to 100 marked rows joined to `rss_item` for the filename. 100 is
   the service's maximum batch.
2. One batch `POST /api/v1/lookup` with the plugin's category and those
   filenames -- the existing `client.batch`. It is a fresh question keyed on
   the name, and the service answers from its cache where it has one.
3. For each answer, in order: `setVideoResolution(rssItemId,
   videoResolutionOf(answer))`, then clear that row's mark. Nothing else is
   written -- no media item, cast, artwork or lookup state -- so the
   release's identification is untouched even if the fresh answer disagrees
   with the one that identified it.
4. If marked rows remain, enqueue the same job kind again.

**Failure.** An HTTP failure or 429 throws, so the runner's retry and backoff
apply. After the last attempt the job dead-letters and the rows it had not
reached stay marked; the dead-letter row is how anyone learns of it. An
answer with no usable resolution still clears its mark and stores `null`, so
the job always makes progress and cannot loop.

A fresh install has no resolved rows when this migration runs, so it marks
nothing and enqueues nothing.

## 5. Display

- `ReleaseList` shows `release.row.videoResolution ?? 'unknown'` in the span
  that commit `7f1e8e8` fills from the filename.
  `packages/plugin-ui/src/videoResolution.ts` and its test are deleted, and
  the docblock sentence pointing at them is rewritten.
- The rest of `7f1e8e8` stays as it is: the download-type icon, the
  percentage shown only while `downloading`, and `useGatheredItem`'s
  per-download subscriptions.
- `Unmatched.tsx` changes only to read `lookupState`/`lookupStateDetail`.
  Its "resolution" label and comment become "lookup state". It does not gain
  a video resolution; nobody asked for one there.

## 6. `{resolution}` token

- A shared `resolveResolution` in `packages/openmetadata/src/tokens.ts` reads
  `rss_item.video_resolution` for `file.rssItemId`.
- Each of the three plugins' `tokens` maps gains `resolution:
  resolveResolution`, written out per plugin like the other shared tokens.
- `null` follows the shape code's existing rule (`host/src/media/shape.ts`):
  a `null` value contributes nothing to its segment, and a non-final segment
  left empty is dropped. So `Film {resolution}` on a release with no stated
  resolution yields `Film ` -- trailing space included -- exactly as any other
  `null` token does today. The #98 comment in `openmetadata/src/tokens.ts`
  that explains the removal is rewritten.

## 7. Testing

Every item below is a test written to fail first.

**Host**
- The migration, on a database seeded at the previous version:
  - The renames keep all three `rss_item` triggers logging.
  - An unmatched row with `parsed.quality.resolution` `"1080p"` backfills.
  - `"hello"`, `42`, `null`, the too-large marker and malformed JSON all leave
    `null`.
  - A resolved row stays `null`.
  - `sync.generation` changes.
- `setVideoResolution` writes and logs, and throws on a value outside the
  pattern.
- `sync/tables.ts`' key-set test carries the three new names and neither
  old one.
- `tokens.test.ts` counts become 8/7/6. `{resolution}` saves in a shape and
  resolves at import, both with a value and with `null`.
- The backfill migration's job row is dispatched by the real runner, the
  coupling test above.

**openmetadata**
- `videoResolutionOf` accepts the pattern. It rejects a missing `parsed`, a
  missing `quality`, a non-string, and a string outside the pattern.
- `applyEnvelope` writes the resolution on each of the five outcomes, and
  refused writes `null`.
- The backfill migration:
  - It marks resolved rows only.
  - It inserts the job only when something was marked.
- The backfill handler:
  - It batches at 100.
  - It writes only the resolution.
  - It clears the mark on a `null` answer.
  - It re-enqueues while marks remain.
  - It throws on HTTP failure with the marks intact.

**Web / plugin-ui**
- `ReleaseList` shows the stored value, and `unknown` for `null`.
- The `Unmatched` tests move to the new names.

**e2e**
- The harness seeds the new columns. The shell and media-details specs pass.

**Mutation checks before completion.** Remove each of these in turn and
confirm a test fails:
- the pattern check (in each of the two places);
- the generation rotation;
- the mark clear;
- the re-enqueue.

## Out of scope

- Any other quality field the service parses (`source`, `hdr`, codecs).
- Showing the resolution on the Unmatched screen.
- Ranking or filtering by resolution.
