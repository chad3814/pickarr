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
`1080i`, `2160p`) or is `null`. A value that matches ignoring case
(`1080P`) is stored lowercased. Anything else the service sends -- another
type, another string -- is stored as `null`.

The check exists because the value reaches a library path through
`{resolution}` and `parsed` is otherwise unvalidated third-party text. It is
one function, `normalizeVideoResolution(value: unknown): string | null` in
`@pickarr/contract`. The host writer and `packages/openmetadata` both depend
on it, and neither may depend on the other. The host migration's backfill
restates it in SQL (`lower(...)` then `GLOB`). A migration is frozen once
applied, so it must not call a helper that could later change, and the
migration test pins the two against the same cases.

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
   case of its own. The same `UPDATE` sets `updated_at` for the rows it
   changes, from SQLite's clock in milliseconds
   (`CAST(unixepoch('subsec') * 1000 AS INTEGER)`), so an `/api` reader paging
   by `updated_at` sees the backfilled value; every other row keeps its own.
5. Rotate `sync.generation` by deleting its `host_state` row through a new
   `forgetSyncGeneration(raw)` in `db/host-state.ts`. `ensureSyncGeneration`
   mints a fresh value on its next call. A rebuilt database has no row
   either, and that is already how it signals a reset, so the migration
   reuses that mechanism instead of choosing a value itself.

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
  The writer throws if `normalizeVideoResolution(value) !== value`, so only
  `null` or an already-normalized value is stored. It is a shared writer that
  any plugin can call, so the host does not trust every caller to have run
  `videoResolutionOf` first.
- New `normalizeVideoResolution(value: unknown): string | null`, described
  under "Accepted values".
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
  never by casting, and passes it through `normalizeVideoResolution`.
- `applyEnvelope` calls `ctx.media.setVideoResolution(target.rssItemId,
  videoResolutionOf(envelope))` once, just after the partial/pending block.
  So every terminal outcome writes it -- resolved, unresolved and refused
  (always `null`) -- and none can forget to. The MAX_POLLS expiry inside
  that block makes the same call, because the service's last envelope is
  the best parse there is.
- A partial or pending answer that polls again writes nothing to
  `rss_item`, even when it already carries a parse. Every write there moves
  `updated_at`, and `/unmatched`'s Retry button reads an advance as "the
  retry landed": writing on a partial answer would re-enable the button
  while polling continues, and rewrite the row -- one more sync-log entry
  per client -- on every poll.
- `setVideoResolution` is a no-op when the stored value already equals the
  new one (`... WHERE id = ? AND video_resolution IS NOT ?`), so re-reading
  an unchanged parse leaves `updated_at` alone for the same two reasons.
- A later answer for the same release, such as a retry from `/unmatched`,
  overwrites the value. The service's latest parse is the one kept.

## 4. Backfill for already-resolved releases

A resolved release's lookup answer was cleared when it was linked
(`relinkRssItem`), so these rows have nothing stored to read from.

**Marking and enqueueing.** `packages/openmetadata` exports
`videoResolutionBackfillMigration(pluginId: string, version: number): Migration`.
Each plugin's `migrations.ts` lists it explicitly at **version 4**. The engine
owns version 1, and every plugin already uses 2 (its own tables) and 3
(`placementTableMigration`). Having each plugin assign the number means a
collision is visible in its own list, rather than the engine appending a
version a plugin might also use. This is the pattern
`placementTableMigration(pluginId, version)` already set. `up(db)`:

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
   the service's maximum batch. Before selecting, clear the mark on any
   marked row whose `rss_item` no longer exists. A row the join can never
   return would otherwise stay marked, and step 4 would re-enqueue the job
   for ever.
2. One batch `POST /api/v1/lookup` with the plugin's category and those
   filenames -- the existing `client.batch`. It is a fresh question keyed on
   the name, and the service answers from its cache where it has one.
3. For each answer, in order:
   - if `videoResolutionOf(answer)` is non-null, `setVideoResolution` with it
     and clear that row's mark, whatever the answer's state;
   - else, if the answer is terminal (not `partial`, and `state` is not
     `pending`), `setVideoResolution(rssItemId, null)` and clear the mark;
   - else -- a partial or pending answer with no usable parse -- write
     nothing and leave the mark. The answer has not arrived and nothing
     polls a backfill's lookup, so clearing it would settle `null` for good.
     Whether a live partial answer carries `parsed` at all is unverified: a
     probe could not produce one.

   Nothing else is written -- no media item, cast, artwork or lookup state
   -- so the release's identification is untouched even if the fresh answer
   disagrees with the one that identified it.
4. If marked rows remain -- counted with the same join as step 1 -- enqueue
   the same job kind again: at once if this batch cleared any mark, or with
   `runAt` = now + `BACKFILL_RETRY_DELAY_MS` if it cleared none, so a batch
   the service has answered only partially cannot hot-loop.

**Failure.** An HTTP failure or 429 on the batch call does not throw. The
handler logs the error's message (never a filename), enqueues the same job
kind again with `runAt` = now + `BACKFILL_RETRY_DELAY_MS` (ten minutes, from
the plugin's injected clock), and returns with every mark intact. Throwing
would hand it to the runner's backoff -- 1s, 2s, 4s, 8s over five attempts,
about fifteen seconds -- which an outage or a rate limit easily outlasts, and
a dead-lettered backfill is never enqueued again: the plugin migration
inserts the only job row there will ever be. A fault in the local writes
after the answer arrives still throws; the rows before it stay written and
cleared, and the rest stay marked.

A terminal answer with no usable resolution still clears its mark and
stores `null`, so the job always makes progress and cannot loop.

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
  - A backfilled row's `updated_at` moves; an untouched row's does not.
  - `sync.generation` changes.
- `setVideoResolution` writes and logs, throws on a value outside the
  pattern, and leaves `updated_at` alone when the value is unchanged.
- `sync/tables.ts`' key-set test carries the three new names and neither
  old one.
- `tokens.test.ts` counts become 8/7/6. `{resolution}` saves in a shape and
  resolves at import, both with a value and with `null`.
- `normalizeVideoResolution`'s cases, and the migration's SQL restatement,
  run against one shared table of inputs.
- The backfill migration's job row is dispatched by the real runner, the
  coupling test above.

**openmetadata**
- `videoResolutionOf` accepts the pattern. It rejects a missing `parsed`, a
  missing `quality`, a non-string, and a string outside the pattern.
- `applyEnvelope` writes the resolution on each terminal outcome and at
  MAX_POLLS expiry, refused writes `null`, and a partial or pending answer
  that polls again writes nothing.
- The backfill migration:
  - It marks resolved rows only.
  - It inserts the job only when something was marked.
- The backfill handler:
  - It batches at 100.
  - It writes only the resolution.
  - It clears the mark on a terminal `null` answer.
  - It leaves the mark, and writes nothing, on a partial answer with no
    parse; it stores and clears on a partial answer that carries one.
  - It re-enqueues with the delay after a batch that cleared nothing, and
    without it after one that cleared something.
  - It re-enqueues while marks remain.
  - It clears a mark whose release was deleted, and does not re-enqueue for it.
  - On HTTP failure it does not throw: marks intact, nothing written, one
    delayed successor, one log line naming no filename.

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
