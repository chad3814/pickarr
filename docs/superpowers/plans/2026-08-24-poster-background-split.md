# Poster/Background Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a scene's portrait poster and its landscape background as two separate images, classified by measured aspect ratio rather than by URL shape, with no change to what the user sees.

**Architecture:** `group_metadata` gains a second nullable image pair. `cacheImage` splits so that an image is downloaded and measured *before* its destination is chosen, letting the measurement — not the provider's field name — decide which column it lands in. A migration re-files existing rows by URL where SQL can be certain, and an offline backfill script measures the few it cannot. The SPA keeps rendering exactly what it renders today via a deliberately temporary fallback.

**Tech Stack:** Node 24, TypeScript (strict, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`), `node:sqlite`, fastify 5, zod 3, `node:test` + happy-dom for the web suite, Playwright for e2e. One new runtime dependency: `image-size` 2.0.2.

**Spec:** `docs/superpowers/specs/2026-08-24-poster-background-split-design.md`

## Global Constraints

- **`image-size` 2.0.2 is the only new dependency**, added to `packages/core/package.json` dependencies. Nothing else may be added.
- **No `any`, no `as unknown as`.** `typescript/no-explicit-any` is `error`; the repo has an open issue about existing casts and must not gain another.
- Strict TypeScript: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules`. Relative imports carry `.ts` extensions; type-only imports use `import type`.
- 2-space indent; semicolons always.
- **Preserve every existing comment verbatim** unless a task explicitly says to change one. This codebase treats comments as documentation and several here are long and load-bearing.
- **Test file extensions select the suite.** `packages/*/test/**/*.test.ts` runs in `test:server` with **no DOM**; `packages/web/test/**/*.test.tsx` runs in `test:web` with happy-dom. A DOM-driving test must be `.tsx`.
- **The user-visible output must not change.** Task 7 exists to guarantee that. If any e2e spec's rendering changes, something is wrong.
- Gate after every task: `npm run lint && npm run typecheck && npm test && npm run build`. Tasks touching the SPA or routes also run `npm run e2e -w @pickarr/e2e`. Report both `npm test` suite counts separately.
- Commit after every task, subject in the repo's convention: a descriptive sentence, usually with a "so …" clause. Never a `Fix X: do Y` form. **Do not push.**

### Two refinements to the spec, decided while reading the code

1. **§5.2 describes measuring between the temp write and the rename. The actual code makes that unnecessary.** `cacheImage` calls `readBodyWithinCap`, which returns the bytes *in memory*, and only then writes the temp file. So measurement happens on the in-memory buffer before any disk write — simpler, no re-read, and it removes the awkwardness of a temp filename that would otherwise have to be chosen before the key is known. The spec's intent is unchanged.
2. **`MetadataCandidate.backgroundUrl` is optional, not required.** `@pickarr/plugin-api` is a published contract that third-party plugins implement, and `posterUrl` has ~30 construction sites across 17 files. Optional matches the house precedent for `MetadataView.performers`, `performerNames` and `ReleaseRow`'s `hasFailed`, each documented as keeping older callers working.

---

## File Structure

**Modified:**

| File | Change |
|---|---|
| `packages/core/package.json` | `image-size` dependency |
| `packages/core/src/db/migrations.ts` | migration 15 |
| `packages/core/src/db/metadata.ts` | `GroupMetadata` fields, `COLUMNS`, upsert, `setBackgroundPath` |
| `packages/core/src/media/artwork.ts` | `cacheImage` split, `groupArtworkKey`, `classifyArtwork` |
| `packages/core/src/clients/theporndb.ts` | `readPosterCandidate`, `readBackgroundCandidate` |
| `packages/plugin-api/src/types.ts` | `MetadataCandidate.backgroundUrl` |
| `packages/core/src/pipeline/metadata.ts` | cache and classify both images |
| `packages/core/src/http/views.ts` | `hasBackground` |
| `packages/core/src/http/server.ts` | `GET /api/groups/:id/background` |
| `packages/core/src/media/repair-posters.ts` | writes the background columns |
| `packages/web/src/api/client.ts` | `hasBackground` on the view type |
| `packages/web/src/components/MediaCard.tsx` | temporary poster-else-background fallback |

**Created:** `packages/core/src/media/classify.ts`, `scripts/reclassify-artwork.ts`, `packages/core/src/media/reclassify.ts`, plus one test file per unit below.

---

### Task 1: The data layer — columns, migration 15, and the upsert

**Files:**
- Modify: `packages/core/src/db/migrations.ts`, `packages/core/src/db/metadata.ts`
- Test: `packages/core/test/db/metadata.test.ts`, `packages/core/test/db/migrations.test.ts` (create if absent)

**Interfaces:**
- Produces: `GroupMetadata.backgroundUrl: string | null`, `GroupMetadata.backgroundPath: string | null`, `setBackgroundPath(db, groupId, path)`, and migration version 15.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/db/metadata.test.ts`, add:

```ts
test('a background url round-trips through the upsert, and its path is not blanked by a refetch', () => {
  const db = openTestDatabase();
  recordMetadataAnswer(db, {
    groupId: 1,
    source: 'theporndb',
    confirmed: {
      sourceUuid: 'u1', title: 'T', siteUuid: null, siteId: null, siteName: 'S',
      date: null, performers: [], durationSeconds: null, synopsis: null,
      posterUrl: 'https://cdn/poster.jpg', backgroundUrl: 'https://cdn/bg.jpg', slug: null,
    },
    now: 1_000,
  });
  setBackgroundPath(db, 1, 'group-background-1.jpg');
  setPosterPath(db, 1, 'group-poster-1.jpg');

  // A refetch must not blank either cached file — the same guarantee the
  // existing poster_path regression test asserts, now for both.
  recordMetadataAnswer(db, {
    groupId: 1,
    source: 'theporndb',
    confirmed: {
      sourceUuid: 'u1', title: 'T2', siteUuid: null, siteId: null, siteName: 'S',
      date: null, performers: [], durationSeconds: null, synopsis: null,
      posterUrl: 'https://cdn/poster2.jpg', backgroundUrl: 'https://cdn/bg2.jpg', slug: null,
    },
    now: 2_000,
  });

  const row = getGroupMetadata(db, 1);
  assert.equal(row?.title, 'T2');
  assert.equal(row?.posterUrl, 'https://cdn/poster2.jpg');
  assert.equal(row?.backgroundUrl, 'https://cdn/bg2.jpg');
  assert.equal(row?.posterPath, 'group-poster-1.jpg');
  assert.equal(row?.backgroundPath, 'group-background-1.jpg');
});
```

Create `packages/core/test/db/migrations.test.ts` with one test per classification branch. Seed rows through raw SQL at the pre-migration shape, run migrations, assert placement:

```ts
test('migration 15 files a background URL as a background', () => {
  const db = openAtVersion(14);
  db.exec(`INSERT INTO group_metadata (group_id, state, source, poster_url, poster_path, fetched_at)
           VALUES (1, 'confirmed', 'theporndb',
                   'https://cdn.theporndb.net/scene/aa/bb/background/bg-x.jpg', '1.jpg', 1)`);
  migrate(db);
  const row = getGroupMetadata(db, 1);
  assert.equal(row?.posterUrl, null);
  assert.equal(row?.posterPath, null);
  assert.equal(row?.backgroundUrl, 'https://cdn.theporndb.net/scene/aa/bb/background/bg-x.jpg');
  // The file is not renamed; the column keeps pointing at it.
  assert.equal(row?.backgroundPath, '1.jpg');
});

test('migration 15 discards a synthesised crop under either name', () => {
  const db = openAtVersion(14);
  db.exec(`INSERT INTO group_metadata (group_id, state, source, poster_url, poster_path, fetched_at)
           VALUES (2, 'confirmed', 'theporndb',
                   'https://thumb.theporndb.net/abc=/800x1200/smart/scene%2Fx.jpg', '2.jpg', 1)`);
  migrate(db);
  const row = getGroupMetadata(db, 2);
  assert.equal(row?.posterUrl, null);
  assert.equal(row?.posterPath, null);
  assert.equal(row?.backgroundUrl, null);
  assert.equal(row?.backgroundPath, null);
});

test('migration 15 leaves a real poster alone', () => {
  const db = openAtVersion(14);
  db.exec(`INSERT INTO group_metadata (group_id, state, source, poster_url, poster_path, fetched_at)
           VALUES (3, 'confirmed', 'theporndb',
                   'https://cdn.theporndb.net/scene/aa/bb/poster/p.jpg', '3.jpg', 1)`);
  migrate(db);
  const row = getGroupMetadata(db, 3);
  assert.equal(row?.posterUrl, 'https://cdn.theporndb.net/scene/aa/bb/poster/p.jpg');
  assert.equal(row?.posterPath, '3.jpg');
  assert.equal(row?.backgroundUrl, null);
});
```

`openAtVersion(14)` is a helper this file needs: open an in-memory database and run migrations 1..14 only. If the existing migration test setup makes that awkward, an acceptable alternative is to run all migrations and then assert on rows inserted *before* the run by opening at version 14 via a direct `schema_migrations` insert — but say in the report which route you took and why.

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd /Users/chad/Projects/pickarr/worktrees/poster-background-split
node --import tsx --conditions development --test packages/core/test/db/metadata.test.ts packages/core/test/db/migrations.test.ts
```

Expected: failures naming `backgroundUrl`/`setBackgroundPath` as missing, not a syntax error.

- [ ] **Step 3: Add migration 15**

Append to the array in `packages/core/src/db/migrations.ts`:

```ts
  // Poster and background are two different pictures of two different shapes,
  // and until now the second was stored under the first's name: when TPDB
  // offered a synthesised portrait crop, `readPosterUrl` substituted the
  // landscape background and it was written to `poster_path`.
  //
  // Classification here is by URL because SQL is all a migration has. The
  // ambiguous remainder — studio-CDN images whose shape nothing records — is
  // deliberately left as a poster rather than guessed at, and corrected by
  // `scripts/reclassify-artwork.ts`, which can measure the cached file.
  //
  // No file is renamed. `poster_path` holds a bare filename, so moving the
  // value to `background_path` leaves it pointing at the same file, which
  // keeps serving. A migration could not rename anyway: it gets a database and
  // no `artworkDir`, which main.ts resolves.
  //
  // A crop is discarded under both names. Its old justification — better than
  // no image at all — expired when the card gained a performer-portrait
  // fallback: an upscaled, logo-stamped centre-slice would otherwise outrank a
  // real headshot, because the card prefers the poster.
  {
    version: 15,
    up(db) {
      db.exec(`
        ALTER TABLE group_metadata ADD COLUMN background_url  TEXT;
        ALTER TABLE group_metadata ADD COLUMN background_path  TEXT;

        UPDATE group_metadata
           SET background_url = poster_url,
               background_path = poster_path,
               poster_url = NULL,
               poster_path = NULL
         WHERE poster_url LIKE '%/background/%';

        UPDATE group_metadata
           SET poster_url = NULL,
               poster_path = NULL
         WHERE poster_url LIKE '%/800x1200/%'
            OR poster_url LIKE '%/smart/%';
      `);
    },
  },
```

Order matters: the background move runs first, so a URL that is both a `/background/` path and carries `/smart/` is filed as a background rather than discarded.

- [ ] **Step 4: Extend the row reader, COLUMNS, and the upsert**

In `packages/core/src/db/metadata.ts`, add to the object the row reader returns, after `posterPath`:

```ts
    backgroundUrl: maybeStr(row, 'background_url'),
    backgroundPath: maybeStr(row, 'background_path'),
```

Add the two fields to the `GroupMetadata` interface with a comment giving the §3 definitions:

```ts
  /** Portrait artwork, ~2:3. See `classifyArtwork`: the column is decided by
   *  measured aspect, never by the provider's field name. */
  posterUrl: string | null;
  posterPath: string | null;
  /** Landscape artwork, ~16:9. Same rule. */
  backgroundUrl: string | null;
  backgroundPath: string | null;
```

`COLUMNS` becomes — note the two new names sit immediately after `poster_path`, and every positional list below depends on that order:

```ts
const COLUMNS = `group_id, state, source, source_uuid, title, performers, release_date,
                 duration_s, synopsis, poster_url, poster_path, background_url,
                 background_path, scene_slug, fetched_at`;
```

The upsert's `VALUES` gains two entries — a placeholder for `background_url` and a literal `NULL` for `background_path`, mirroring `poster_path`:

```sql
INSERT INTO group_metadata (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)
```

`DO UPDATE SET` gains `background_url = excluded.background_url` **and must not gain `background_path`.** Extend the existing comment above it, which already explains why `poster_path` is absent, to say the same now holds for `background_path`.

The `.run(...)` argument list gains `confirmed?.backgroundUrl ?? null` between the `posterUrl` argument and the `sceneSlug` argument.

Finally, beside `setPosterPath`:

```ts
export function setBackgroundPath(db: DatabaseSync, groupId: number, backgroundPath: string): void {
  db.prepare('UPDATE group_metadata SET background_path = ? WHERE group_id = ?').run(
    backgroundPath,
    groupId,
  );
}
```

- [ ] **Step 5: Add `backgroundUrl` to the candidate type**

In `packages/plugin-api/src/types.ts`, inside `MetadataCandidate`, after `posterUrl`:

```ts
  /**
   * Landscape artwork, where the provider offers it separately from the
   * poster.
   *
   * Optional rather than required: this is a published contract that
   * third-party plugins implement, and `posterUrl` has some thirty
   * construction sites. The same reasoning `MetadataView.performers` and
   * `ReleaseRow`'s `hasFailed` record — a new key must not break every caller
   * written before it existed.
   *
   * Which column either URL ends up in is decided by measuring the downloaded
   * image, not by which field it arrived in. See `classifyArtwork`.
   */
  readonly backgroundUrl?: string | null;
```

- [ ] **Step 6: Run the tests and the gate**

```bash
node --import tsx --conditions development --test packages/core/test/db/metadata.test.ts packages/core/test/db/migrations.test.ts
npm run lint && npm run typecheck && npm test && npm run build
```

Expected: the new tests pass; both suites green.

- [ ] **Step 7: Commit**

```bash
git add -A packages/core packages/plugin-api
git commit -m "Give a group a background alongside its poster, so a landscape image stops being stored under a portrait's name

Migration 15 re-files by URL where SQL can be certain — a /background/ path
moves, a synthesised 800x1200 crop is discarded — and deliberately leaves the
ambiguous studio-CDN remainder as a poster rather than guessing, for
reclassify-artwork.ts to measure later. No file is renamed: poster_path holds a
bare filename, so moving the value leaves it pointing at the same file.

background_path is absent from the upsert's DO UPDATE SET for the same reason
poster_path already is — it names a file on disk rather than part of a provider
answer, and updating it from excluded would blank a cached image on every
refetch."
```

---

### Task 2: `classifyArtwork` — measured aspect, not inferred

**Files:**
- Create: `packages/core/src/media/classify.ts`, `packages/core/test/media/classify.test.ts`
- Modify: `packages/core/package.json`

**Interfaces:**
- Produces: `type ArtworkKind = 'poster' | 'background'` and `classifyArtwork(bytes: Uint8Array): ArtworkKind | null`.

- [ ] **Step 1: Add the dependency**

```bash
npm install image-size@2.0.2 -w @pickarr/core
```

Verify it landed in `packages/core/package.json` dependencies and that `package-lock.json` changed. It is pure JavaScript with no transitive dependencies and ships its own types.

- [ ] **Step 2: Write the failing tests**

`packages/core/test/media/classify.test.ts`. The fixtures need real image headers; build them with a helper per format, and assert the round-trip so a malformed fixture fails loudly rather than silently classifying:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from 'image-size';
import { classifyArtwork } from '../../src/media/classify.ts';

/** A minimal but valid PNG carrying the given dimensions in its IHDR. */
function png(width: number, height: number): Uint8Array { /* built in step 4 */ }

test('a landscape image is a background', () => {
  const bytes = png(1279, 719);
  // Round-trip guard: a fixture image-size cannot read would make the
  // classification assertion below meaningless.
  assert.deepEqual(imageSize(bytes), { width: 1279, height: 719, type: 'png' });
  assert.equal(classifyArtwork(bytes), 'background');
});

test('a portrait image is a poster', () => {
  assert.equal(classifyArtwork(png(800, 1200)), 'poster');
});

test('a square image is a poster, because the 2:3 slot crops it least', () => {
  assert.equal(classifyArtwork(png(500, 500)), 'poster');
});

test('bytes that are not an image classify as nothing rather than throwing', () => {
  assert.equal(classifyArtwork(new Uint8Array([1, 2, 3, 4])), null);
});
```

Add the same landscape/portrait pair for JPEG and WebP, since those are the other two types `IMAGE_EXTENSIONS` accepts and each encodes dimensions differently — PNG in `IHDR`, JPEG in an `SOF` marker, WebP in a `VP8`/`VP8L`/`VP8X` chunk. If hand-building a valid JPEG or WebP header proves fiddlier than it is worth, commit three tiny real images under `packages/core/test/fixtures/` and read them instead; say in the report which route you took.

- [ ] **Step 3: Run and watch them fail**

```bash
node --import tsx --conditions development --test packages/core/test/media/classify.test.ts
```

Expected: `Cannot find module '../../src/media/classify.ts'`.

- [ ] **Step 4: Write the classifier**

`packages/core/src/media/classify.ts`:

```ts
import { imageSize } from 'image-size';

export type ArtworkKind = 'poster' | 'background';

/**
 * Which slot a downloaded image belongs in, from the image itself.
 *
 * URL shape is a decent heuristic and an unreliable rule. Of the three
 * studio-CDN images in this library whose shape nothing in the payload records,
 * one is a background and one is a poster — and the guess their filenames
 * invite (`1x.webp` and `scenedefault` read like stills, `tour_carlykiss.jpg`
 * reads like a thumbnail) gets the first right and the second wrong. A rule
 * built on URLs would have misfiled one of the only two anyone could verify.
 *
 * Square counts as a poster: the destination that crops it least is the 2:3
 * slot, and a square scene still is likelier to be a cropped portrait than a
 * cropped landscape.
 *
 * `null` for anything that cannot be measured. The caller then has bytes it
 * cannot place, which is a reason to store nothing rather than to guess — and
 * it never throws, because this runs inside the metadata worker's tick.
 *
 * Known limitation: EXIF orientation is not read, so a JPEG stored landscape
 * with a rotation flag that makes it *display* portrait is classified as a
 * background. TPDB's CDN is unlikely to serve one; a studio CDN is where it
 * would appear. The fix, if it is ever needed, is an orientation read here plus
 * a re-run of `reclassify-artwork`, not a schema change.
 */
export function classifyArtwork(bytes: Uint8Array): ArtworkKind | null {
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = imageSize(bytes));
  } catch {
    return null;
  }
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return null;
  return width > height ? 'background' : 'poster';
}
```

- [ ] **Step 5: Run the tests, then the gate**

```bash
node --import tsx --conditions development --test packages/core/test/media/classify.test.ts
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add -A packages/core
git commit -m "Classify artwork by its measured aspect, so a URL's shape stops deciding what kind of image it is

Of the three studio-CDN images in this library whose shape nothing records, one
is a background and one is a poster, and the guess their filenames invite gets
the second wrong. image-size reads the dimensions — a sixth runtime dependency,
accepted because a wrong measurement is a wrong classification and this is a
poor place to be subtly wrong.

Square counts as a poster: the 2:3 slot crops it least, and a square still is
likelier to be a cropped portrait than a cropped landscape. EXIF orientation is
not read, and that limitation is recorded on the function rather than hidden."
```

---

### Task 3: Split `cacheImage` so the destination is chosen after measuring

**Files:**
- Modify: `packages/core/src/media/artwork.ts`
- Test: `packages/core/test/media/artwork.test.ts`

**Interfaces:**
- Produces: `fetchImage(deps, url): Promise<{ bytes: Uint8Array; extension: string } | null>`, `writeImage(deps, key, bytes, extension): Promise<string | null>`, `groupArtworkKey(groupId, kind)`, and `cacheImage` retained as a thin wrapper over the two.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/media/artwork.test.ts`:

```ts
test('fetchImage returns the bytes and the extension without writing anything', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const bytes = new Uint8Array([1, 2, 3]);
  const deps = testDeps(dir, async () => new Response(bytes, {
    headers: { 'content-type': 'image/png' },
  }));

  const got = await fetchImage(deps, 'https://example/x');
  assert.deepEqual(got?.bytes, bytes);
  assert.equal(got?.extension, 'png');
  // Nothing on disk yet: the destination is not known until the caller has
  // classified these bytes.
  assert.deepEqual(await readdir(dir), []);
});

test('writeImage names the file from the key and leaves no temp behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const name = await writeImage(testDeps(dir), 'group-poster-7', new Uint8Array([1]), 'jpg');
  assert.equal(name, 'group-poster-7.jpg');
  assert.deepEqual(await readdir(dir), ['group-poster-7.jpg']);
});

test('groupArtworkKey mirrors the performer convention', () => {
  assert.equal(groupArtworkKey(7, 'poster'), 'group-poster-7');
  assert.equal(groupArtworkKey(7, 'background'), 'group-background-7');
});

test('cacheImage still behaves as before, so existing callers are unaffected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'artwork-'));
  const deps = testDeps(dir, async () => new Response(new Uint8Array([1]), {
    headers: { 'content-type': 'image/webp' },
  }));
  assert.equal(await cacheImage(deps, 'performer-face-3', 'https://example/x'), 'performer-face-3.webp');
});
```

Keep every existing test in that file passing unchanged — that is the evidence the split preserved behaviour.

- [ ] **Step 2: Run and watch them fail**

```bash
node --import tsx --conditions development --test packages/core/test/media/artwork.test.ts
```

- [ ] **Step 3: Perform the split**

`cacheImage`'s body divides at the point the bytes are in hand. Everything from the deadline through `readBodyWithinCap` becomes `fetchImage`; the temp-then-rename becomes `writeImage`. **Move the existing comments with the code they explain** — the total-operation deadline rationale, the attacker-controlled `Content-Length` note, and the temp-then-rename atomicity paragraph each belong to exactly one half.

Two things change, and both need saying in comments:

- **The temp filename no longer contains the key.** It was `.${key}.${randomUUID()}.part`; in `writeImage` the key is known, so it can stay — but `fetchImage` writes nothing, so the temp file only exists inside `writeImage` and the uniqueness argument (two overlapping downloads for one key must not share a temp path) is unchanged. Keep that comment where the temp path is built.
- **`deps.log` messages currently name the key**, which `fetchImage` no longer has. Log the URL instead, and note that the key is not available at fetch time because it depends on the classification.

Then add:

```ts
/**
 * Keys for a group's two cached images.
 *
 * New group artwork stops using the bare group id, and that is load-bearing.
 * A background cached before migration 15 sits on disk at `<id>.jpg` and the
 * migration deliberately leaves it there. If a newly-fetched poster for that
 * group were also written to `<id>.jpg` it would overwrite the background —
 * so nothing writes the bare name again.
 */
export function groupArtworkKey(groupId: number, kind: ArtworkKind): string {
  return `group-${kind}-${groupId}`;
}
```

Retain `cacheImage` as `fetchImage` followed by `writeImage`, so `cachePerformerArtwork` and the repair script keep working untouched.

- [ ] **Step 4: Run the tests and the gate**

```bash
node --import tsx --conditions development --test packages/core/test/media/artwork.test.ts
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/core
git commit -m "Split downloading an image from naming it, so the measurement can choose the destination

cacheImage already had the bytes in memory before it wrote anything, so the
split falls where readBodyWithinCap returns: fetchImage validates and returns
bytes, writeImage renames a temp file into place under a key the caller now
chooses after classifying. cacheImage stays as the composition of the two, so
performer artwork and the repair script are untouched.

groupArtworkKey mirrors performerArtworkKey, and the bare group id is retired
because a pre-migration background still sits under it — a new poster written
to the same name would overwrite the image the migration deliberately left in
place."
```

---

### Task 4: Split the provider's readers

**Files:**
- Modify: `packages/core/src/clients/theporndb.ts`
- Test: `packages/core/test/clients/theporndb.test.ts`

**Interfaces:**
- Consumes: `MetadataCandidate.backgroundUrl` from Task 1.
- Produces: `readPosterCandidate` and `readBackgroundCandidate`, and `posterUrl`/`backgroundUrl` both populated on each parsed scene.

- [ ] **Step 1: Write the failing tests**

```ts
test('a synthesised crop yields no poster candidate, and its source as the background', () => {
  const crop = `https://thumb.theporndb.net/abc=/800x1200/smart/filters:watermark(sites%2Fx%2Flogo.png,0,0,0)/scene%2Faa%2Fbb%2Fbackground%2Fbg-x.jpg`;
  const scene = parseScene({ posters: { large: crop } });
  assert.equal(scene.posterUrl, null);
  assert.equal(scene.backgroundUrl, 'https://cdn.theporndb.net/scene/aa/bb/background/bg-x.jpg');
});

test('a real poster and a background are both read, independently', () => {
  const scene = parseScene({
    posters: { large: 'https://cdn.theporndb.net/scene/aa/poster/p.jpg' },
    background: { full: 'https://cdn.theporndb.net/scene/aa/background/b.jpg' },
  });
  assert.equal(scene.posterUrl, 'https://cdn.theporndb.net/scene/aa/poster/p.jpg');
  assert.equal(scene.backgroundUrl, 'https://cdn.theporndb.net/scene/aa/background/b.jpg');
});

test('the studio image field is a background candidate, not a poster one', () => {
  // The client's own comment records this field as 1279x719, so it has never
  // been safe to call it a poster.
  const scene = parseScene({ image: 'https://studio.example/still.jpg' });
  assert.equal(scene.posterUrl, null);
  assert.equal(scene.backgroundUrl, 'https://studio.example/still.jpg');
});

test('the posters set prefers large over full, and falls through to the bare poster field', () => {
  assert.equal(
    parseScene({ posters: { large: 'https://cdn.theporndb.net/a/poster/l.jpg', full: 'https://cdn.theporndb.net/a/poster/f.jpg' } }).posterUrl,
    'https://cdn.theporndb.net/a/poster/l.jpg',
  );
  assert.equal(parseScene({ poster: 'https://cdn.theporndb.net/a/poster/p.jpg' }).posterUrl,
    'https://cdn.theporndb.net/a/poster/p.jpg');
});
```

`parseScene` is whatever helper that test file already uses to drive the scene reader; follow its existing shape rather than inventing one.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Replace `readPosterUrl` with the two readers**

```ts
/**
 * Poster candidates, in preference order — and only candidates.
 *
 * This no longer reaches for the background when the offered poster turns out
 * to be a synthesised crop of one. That substitution is what filed landscape
 * images under a portrait's name for this library's whole history; the
 * background now has its own reader and its own column.
 *
 * The studio `image` field has moved to `readBackgroundCandidate`. That is not
 * a new judgement — `readOfferedPoster` already documented it as 1279x719 and
 * warned that nothing downstream may assume a portrait aspect ratio.
 *
 * Nothing here decides a shape. `classifyArtwork` does that, from the image.
 */
function readPosterCandidate(record: Record<string, unknown>): string | null {
  const fromSet = readSizedImage(record['posters'], ['large', 'full']);
  const offered = fromSet ?? str(record, 'poster');
  if (offered === null || isBackgroundCrop(offered)) return null;
  return offered;
}

/**
 * Background candidates, in preference order.
 *
 * `full` before `large`, the opposite of the poster preference and for the
 * opposite reason: this reader exists partly to undo a downscaled, re-cropped
 * rendition, so it asks for the original.
 *
 * `backgroundFromCrop` is the second source because a crop URL carries its own
 * source encoded whole, so the original needs no request to discover. The crop
 * itself is never returned — see the design's §4.1: it is portrait, so it would
 * be filed as a poster and would outrank a real performer portrait on the card.
 */
function readBackgroundCandidate(record: Record<string, unknown>): string | null {
  const fromObject = readSizedImage(record['background'], ['full', 'large']);
  if (fromObject !== null && !isBackgroundCrop(fromObject)) return fromObject;

  const offered = readSizedImage(record['posters'], ['large', 'full']) ?? str(record, 'poster');
  if (offered !== null && isBackgroundCrop(offered)) {
    const recovered = backgroundFromCrop(offered);
    if (recovered !== null) return recovered;
  }

  return str(record, 'image');
}
```

Delete `readOfferedPoster` and `readPosterUrl`, moving anything still true from their comments onto the two readers. At the scene-construction site, `posterUrl: readPosterUrl(record)` becomes:

```ts
      posterUrl: readPosterCandidate(record),
      backgroundUrl: readBackgroundCandidate(record),
```

- [ ] **Step 4: Run the tests and the gate**

Existing tests in that file that assert the old substitution behaviour will now fail — that is the point of the task. Update each to assert the new placement, and say in your report how many changed and what each asserted before.

```bash
node --import tsx --conditions development --test packages/core/test/clients/theporndb.test.ts
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/core
git commit -m "Read the poster and the background as two separate candidates, so neither substitutes for the other

readPosterUrl returned the background whenever the offered poster was a
synthesised crop of one, and that substitution is why 1,494 of this library's
1,508 stored posters are backgrounds. The two readers now have their own
destinations, the crop is never returned under either name, and the studio image
field moves to the background reader — applying the very warning
readOfferedPoster already carried about it being 1279x719.

Neither reader decides a shape. classifyArtwork does that, from the image."
```

---

### Task 5: Cache and classify both images in the pipeline

**Files:**
- Modify: `packages/core/src/pipeline/metadata.ts`
- Test: `packages/core/test/pipeline/metadata.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 in full.

- [ ] **Step 1: Write the failing tests**

```ts
test('each image is stored in the column its measurement dictates, not its field name', async () => {
  // The provider offers them the wrong way round: a landscape image in the
  // poster field and a portrait one in the background field.
  const harness = metadataHarness({
    poster: landscapePng(1279, 719),
    background: portraitPng(800, 1200),
  });
  await harness.run();
  const row = getGroupMetadata(harness.db, 1);
  assert.equal(row?.posterPath, 'group-poster-1.png');
  assert.equal(row?.backgroundPath, 'group-background-1.png');
  // And the bytes prove which went where.
  assert.deepEqual(await harness.fileFor('group-poster-1.png'), portraitPng(800, 1200));
});

test('a poster that downloads and a background that 404s leaves one column set', async () => {
  const harness = metadataHarness({ poster: portraitPng(800, 1200), background: 404 });
  await harness.run();
  const row = getGroupMetadata(harness.db, 1);
  assert.equal(row?.posterPath, 'group-poster-1.png');
  assert.equal(row?.backgroundPath, null);
});

test('two candidates measuring the same shape yield that column and leave the other null', async () => {
  const harness = metadataHarness({
    poster: landscapePng(1279, 719),
    background: landscapePng(1920, 1080),
  });
  await harness.run();
  const row = getGroupMetadata(harness.db, 1);
  assert.equal(row?.posterPath, null);
  assert.notEqual(row?.backgroundPath, null);
});

test('an already-cached image is not re-fetched', async () => {
  // The existing rule and its long comment apply to both columns now.
  const harness = metadataHarness({ poster: portraitPng(800, 1200) });
  await harness.run();
  const before = harness.fetchCount;
  await harness.run();
  assert.equal(harness.fetchCount, before);
});
```

Follow the harness shape that file already uses; add helpers for the two fixture images rather than inlining bytes four times.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Rewrite the caching block**

Replace the single-poster block. Keep its long comment about why a moved poster is not re-fetched — it now governs both columns, so extend rather than replace it, and say that the "worth doing for all three or none" argument now covers four fields.

```ts
  // Each column prefers the reader named for it and falls back to the other,
  // so the rule is total: two candidates that both measure landscape yield a
  // background and no poster, rather than an arbitrary winner. The provider's
  // field names are a hint about where to look, never the answer.
  const existing = getGroupMetadata(deps.db, row.groupId);
  const wanted: ReadonlyArray<{ url: string; from: ArtworkKind }> = confirmed === null
    ? []
    : [
        ...(confirmed.posterUrl === null ? [] : [{ url: confirmed.posterUrl, from: 'poster' as const }]),
        ...((confirmed.backgroundUrl ?? null) === null
          ? []
          : [{ url: confirmed.backgroundUrl as string, from: 'background' as const }]),
      ];

  // One fetch per distinct URL: a provider that repeats an image across fields
  // must not cost two downloads of the same bytes.
  const seen = new Map<string, ArtworkKind | null>();
  const measured: Array<{ kind: ArtworkKind; bytes: Uint8Array; extension: string; from: ArtworkKind }> = [];
  for (const candidate of wanted) {
    if (seen.has(candidate.url)) continue;
    const fetched = await fetchImage(deps.artwork, candidate.url);
    if (fetched === null) {
      seen.set(candidate.url, null);
      continue;
    }
    const kind = classifyArtwork(fetched.bytes);
    seen.set(candidate.url, kind);
    if (kind !== null) measured.push({ kind, ...fetched, from: candidate.from });
  }

  for (const kind of ['poster', 'background'] as const) {
    const alreadyCached = kind === 'poster' ? existing?.posterPath : existing?.backgroundPath;
    if ((alreadyCached ?? null) !== null) continue;
    // Prefer the candidate that came from the matching reader, then any other
    // image that measured this shape.
    const pick = measured.find((m) => m.kind === kind && m.from === kind)
      ?? measured.find((m) => m.kind === kind);
    if (pick === undefined) continue;
    const name = await writeImage(deps.artwork, groupArtworkKey(row.groupId, kind), pick.bytes, pick.extension);
    if (name === null) continue;
    if (kind === 'poster') setPosterPath(deps.db, row.groupId, name);
    else setBackgroundPath(deps.db, row.groupId, name);
  }
```

- [ ] **Step 4: Run the tests and the gate**

```bash
node --import tsx --conditions development --test packages/core/test/pipeline/metadata.test.ts
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/core
git commit -m "Store each fetched image in the column its measurement dictates, so a provider's field name stops deciding

Both candidates are fetched, measured, and placed: each column prefers the
reader named for it and falls back to the other, which makes the rule total
rather than leaving two same-shaped candidates to an arbitrary winner. A URL
repeated across fields is fetched once.

The existing don't-refetch-a-cached-image rule now guards both columns, and its
comment about a moved image being stale decoration rather than a wrong answer
extends to four fields instead of three."
```

---

### Task 6: `hasBackground` and the background route

**Files:**
- Modify: `packages/core/src/http/views.ts`, `packages/core/src/http/server.ts`
- Test: `packages/core/test/http/metadata.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('the view reports each image independently', () => {
  const view = metadataView({ posterPath: null, backgroundPath: 'group-background-1.jpg' });
  assert.equal(view.hasPoster, false);
  assert.equal(view.hasBackground, true);
});

test('GET /api/groups/:id/background serves the file', async () => {
  const { server } = await withBackground('group-background-1.jpg');
  const response = await server.inject({ method: 'GET', url: '/api/groups/1/background' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/jpeg');
});

test('GET /api/groups/:id/background 404s when the column is null', async () => {
  const { server } = await withBackground(null);
  assert.equal((await server.inject({ method: 'GET', url: '/api/groups/1/background' })).statusCode, 404);
});

test('GET /api/groups/:id/background 404s when the row outlives the file', async () => {
  const { server } = await withBackground('missing.jpg');
  assert.equal((await server.inject({ method: 'GET', url: '/api/groups/1/background' })).statusCode, 404);
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Add the field and the route**

In `views.ts`, add `hasBackground: boolean;` to the `'confirmed'` variant beside `hasPoster`, and `hasBackground: metadata.backgroundPath !== null,` where `hasPoster` is derived.

In `server.ts`, add a `/api/groups/:id/background` handler immediately after the poster one, identical in shape — `idParamsSchema`, the null-column 404, the `readFile` 404, `POSTER_CONTENT_TYPES` for the content type, and the same `cache-control: public, max-age=86400`. Its comment should point at the poster route's long rationale for why this is a route rather than a `@fastify/static` mount rather than repeating it, and say what differs: nothing but the column.

- [ ] **Step 4: Run the tests, the gate, and e2e**

```bash
node --import tsx --conditions development --test packages/core/test/http/metadata.test.ts
npm run lint && npm run typecheck && npm test && npm run build
npm run e2e -w @pickarr/e2e
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/core
git commit -m "Expose the background as its own route and flag, so the SPA can tell the two images apart"
```

---

### Task 7: Keep the card rendering exactly what it renders today

**Files:**
- Modify: `packages/web/src/api/client.ts`, `packages/web/src/components/MediaCard.tsx`
- Test: `packages/web/test/MediaCard.test.tsx`

- [ ] **Step 1: Write the failing tests**

`.tsx` because these drive the DOM.

```tsx
test('a group with only a background still shows an image, from the background route', () => {
  render(<MediaCard {...props({ hasPoster: false, hasBackground: true })} />);
  const image = screen.getByRole('img', { name: /poster for/i });
  assert.equal(image.getAttribute('src'), '/api/groups/1/background');
});

test('a poster wins when both exist', () => {
  render(<MediaCard {...props({ hasPoster: true, hasBackground: true })} />);
  assert.equal(screen.getByRole('img', { name: /poster for/i }).getAttribute('src'),
    '/api/groups/1/poster');
});

test('neither image means no thumbnail at all, as before', () => {
  render(<MediaCard {...props({ hasPoster: false, hasBackground: false })} />);
  assert.equal(screen.queryByRole('img', { name: /poster for/i }), null);
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/MediaCard.test.tsx
```

- [ ] **Step 3: Add the field and the fallback**

`client.ts` gains `hasBackground: boolean;` beside `hasPoster` in the confirmed variant of the metadata view.

In `MediaCard.tsx`, the block currently gated on `metadata.state === 'confirmed' && metadata.hasPoster` becomes gated on either image, with the src chosen by preference:

```tsx
  /**
   * TEMPORARY, and phase 2b deletes it deliberately.
   *
   * Before the poster/background split, 1,494 of this library's 1,508 stored
   * "posters" were landscape backgrounds. The moment `hasPoster` started telling
   * the truth those cards would have gone blank, so this reproduces the old
   * rendering exactly: whichever image the group has, preferring the poster.
   *
   * Phase 2b replaces it with poster, then the first performer portrait, then a
   * placeholder — and moves the background to the image gallery, where a
   * landscape image is not cropped into a 2:3 slot. Do not mistake this for the
   * intended design.
   */
  const thumbnail =
    metadata.state !== 'confirmed'
      ? null
      : metadata.hasPoster
        ? `/api/groups/${group.id}/poster`
        : metadata.hasBackground
          ? `/api/groups/${group.id}/background`
          : null;
```

and the render gate becomes `{thumbnail !== null && ( … )}` with `src={thumbnail}`. The `alt` text stays exactly as it is, so the existing accessible-name queries keep matching.

- [ ] **Step 4: Run the tests, the gate, and e2e**

The e2e specs that assert a poster renders (`card-layout.spec.ts`, `metadata-modal.spec.ts`) must pass **unchanged**. If any needs editing, the fallback is wrong — report it rather than adjusting the spec.

```bash
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/MediaCard.test.tsx
npm run lint && npm run typecheck && npm test && npm run build
npm run e2e -w @pickarr/e2e
```

- [ ] **Step 5: Commit**

```bash
git add -A packages/web
git commit -m "Show the background when there is no poster, so the split changes nothing a user can see

1,494 of this library's 1,508 stored posters are backgrounds, so the moment
hasPoster tells the truth those cards would go blank. This reproduces the old
rendering exactly and is marked temporary at the call site: phase 2b replaces it
with poster, then performer portrait, then a placeholder, and sends the
background to the gallery."
```

---

### Task 8: Repoint the repair script and add the backfill

**Files:**
- Modify: `packages/core/src/media/repair-posters.ts`, `packages/core/test/media/repair-posters.test.ts`
- Create: `packages/core/src/media/reclassify.ts`, `scripts/reclassify-artwork.ts`, `packages/core/test/media/reclassify.test.ts`
- Modify: `package.json` (a `reclassify-artwork` script beside `repair-posters`)

- [ ] **Step 1: Write the failing tests for the backfill**

```ts
test('a poster column holding a landscape image is moved to the background column', async () => {
  const { db, dir } = await seed({ groupId: 1, posterPath: '1.jpg', bytes: landscapeJpeg(1279, 719) });
  const report = await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} });
  assert.deepEqual(report, { examined: 1, moved: 1, unreadable: 0 });
  const row = getGroupMetadata(db, 1);
  assert.equal(row?.posterPath, null);
  assert.equal(row?.backgroundPath, '1.jpg');
  // The url travels with the path, or the row would name one image and serve another.
  assert.equal(row?.posterUrl, null);
});

test('a correctly-filed image is left alone, so the script is a no-op once clean', async () => {
  const { db, dir } = await seed({ groupId: 1, posterPath: '1.jpg', bytes: portraitJpeg(800, 1200) });
  assert.deepEqual(await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} }),
    { examined: 1, moved: 0, unreadable: 0 });
});

test('dry-run reports what it would move and changes nothing', async () => {
  const { db, dir } = await seed({ groupId: 1, posterPath: '1.jpg', bytes: landscapeJpeg(1279, 719) });
  assert.deepEqual(await reclassifyArtwork({ db, dir, dryRun: true, log: () => {} }),
    { examined: 1, moved: 1, unreadable: 0 });
  assert.equal(getGroupMetadata(db, 1)?.posterPath, '1.jpg');
});

test('a row whose file is missing is counted, not crashed on', async () => {
  const { db, dir } = await seed({ groupId: 1, posterPath: 'gone.jpg', bytes: null });
  assert.deepEqual(await reclassifyArtwork({ db, dir, dryRun: false, log: () => {} }),
    { examined: 1, moved: 0, unreadable: 1 });
});
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Write the backfill**

`packages/core/src/media/reclassify.ts` exports `reclassifyArtwork(deps): Promise<{ examined: number; moved: number; unreadable: number }>`. It reads every row with a `poster_path` or `background_path`, measures the file with `classifyArtwork`, and where the measurement disagrees with the column, moves both the url and the path to the other pair. Offline: no network, no API key. Re-runnable, and a no-op once clean.

Its doc comment should say what it is for — migration 15 classifies by URL because SQL cannot measure, and deliberately leaves ambiguous studio-CDN rows as posters; this is what corrects them, including the one known background currently filed as a poster.

`scripts/reclassify-artwork.ts` is a thin CLI over it, following `scripts/repair-background-posters.ts` exactly for argument parsing, `--dry-run`, and its "stop Pickarr first" warning. Add `"reclassify-artwork": "node --import tsx --conditions development scripts/reclassify-artwork.ts"` to the root `package.json` scripts beside `repair-posters`.

- [ ] **Step 4: Repoint the repair script**

`repair-posters.ts` recovers a background from a crop URL and caches it. Change its destination to the background columns: `setBackgroundPath` rather than `setPosterPath`, and update the url column it writes. Add a line to its doc comment saying it predates the poster/background split and now writes the background pair. Its own tests move with it.

- [ ] **Step 5: Run the tests and the gate**

```bash
node --import tsx --conditions development --test packages/core/test/media/reclassify.test.ts packages/core/test/media/repair-posters.test.ts
npm run lint && npm run typecheck && npm test && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add -A packages/core scripts package.json
git commit -m "Add an offline backfill that measures cached images, so the rows SQL could not classify get corrected

Migration 15 files by URL because a migration has only SQL, and it deliberately
leaves ambiguous studio-CDN rows as posters rather than guessing. This measures
the cached file and moves the row when the measurement disagrees — no network,
re-runnable, a no-op once clean. The repair script's destination moves to the
background columns, which is where the image it recovers has always belonged."
```

---

### Task 9: Verify against the real library

No production code. This is the check the suite cannot make: fixtures prove branches, and only real data proves the classification matches reality.

- [ ] **Step 1: Copy the backups**

Both files in `/Users/chad/Projects/pickarr/` are already copies and the live installation is on another machine, but work on a further copy so they stay pristine.

```bash
cp /Users/chad/Projects/pickarr/pickarr-2026-08-24.db /tmp/verify-a.db
cp /Users/chad/Projects/pickarr/pickarr-2026-08-24-2.db /tmp/verify-b.db
```

- [ ] **Step 2: Record the pre-migration classification**

```bash
for D in /tmp/verify-a.db /tmp/verify-b.db; do
  echo "== $D"
  sqlite3 "$D" "
  select
    (select count(*) from group_metadata where poster_url like '%/background/%') as background,
    (select count(*) from group_metadata where poster_url like '%/800x1200/%' or poster_url like '%/smart/%') as crop,
    (select count(*) from group_metadata where poster_url is not null
        and poster_url not like '%/background/%'
        and poster_url not like '%/800x1200/%'
        and poster_url not like '%/smart/%') as other;"
done
```

Expected: `verify-a` 952 / 0 / 11, `verify-b` 1494 / 0 / 14. A different answer means the migration's `LIKE` patterns do not match what is actually stored — investigate before running it.

- [ ] **Step 3: Run the migration and assert the outcome**

Open each copy through the app's own `migrate`, then:

```bash
for D in /tmp/verify-a.db /tmp/verify-b.db; do
  echo "== $D"
  sqlite3 "$D" "
  select
    (select count(*) from group_metadata where background_path is not null) as background_rows,
    (select count(*) from group_metadata where poster_path is not null) as poster_rows,
    (select max(version) from schema_migrations) as version;"
done
```

Expected: `verify-a` 952 backgrounds / 11 posters, `verify-b` 1494 / 14, version 15 on both.

- [ ] **Step 4: Dry-run the backfill and read what it would move**

The artwork files are not on this machine, so every row will count as `unreadable` — that is the expected result here, and it confirms the script does not crash on a library whose files are absent. Record the counts.

If an artwork directory *is* available, the expected finding is the one studio-CDN background currently filed as a poster; anything else moving is a classification bug worth understanding before the script runs for real.

- [ ] **Step 5: Full gate and e2e one last time**

```bash
npm run lint && npm run typecheck && npm test && npm run build
npm run e2e -w @pickarr/e2e
```

- [ ] **Step 6: Commit only if the verification changed something**

```bash
git status --short
```

---

## Self-Review

**Spec coverage.** §3 columns and definitions → Task 1. §3.1 measured classification → Task 2. §3.2 dimensions not stored → Task 2 (the classifier returns a kind, nothing persists width or height). §4 the two readers → Task 4; §4.1 the crop discarded → Tasks 1 (migration) and 4 (fetcher). §5.1 keys → Task 3. §5.2 where measurement happens → Tasks 2, 3 and 5, with the in-memory refinement recorded in Global Constraints. §5.3 migration and backfill → Tasks 1 and 8. §6 API and the no-op SPA → Tasks 6 and 7. §7 gallery groundwork → nothing to build; Task 6 leaves four addressable routes. §8 the upsert asymmetry → Task 1. §9 testing → distributed across every task. §10 verification → Task 9. §11 risks: the dependency is Task 2, the EXIF limitation is a comment in Task 2, the misfiled rows are Tasks 1 and 8, and the phase-2b warning is a comment in Task 7.

**Placeholder scan.** One deliberate hole: `png(width, height)` in Task 2's test is marked `/* built in step 4 */`, because a byte-accurate PNG header is better written against a live `image-size` than transcribed from a plan. Task 2 names the fallback — commit three tiny real images as fixtures — so the step cannot stall. Task 4's `parseScene` and Task 5's `metadataHarness` refer to helpers those test files already have; the instruction is to follow them rather than invent, which is why they are not spelled out.

**Type consistency.** `ArtworkKind` is declared in Task 2 (`media/classify.ts`) and imported by Tasks 3 and 5. `fetchImage`, `writeImage` and `groupArtworkKey` are declared in Task 3 and used in Task 5 under exactly those names. `setBackgroundPath` is declared in Task 1 and called in Tasks 5 and 8. `GroupMetadata.backgroundUrl`/`backgroundPath` are declared in Task 1 and read in Tasks 5, 6, 8 and 9. `MetadataCandidate.backgroundUrl` is optional, so every read goes through `?? null` — Task 5's construction does this explicitly. `hasBackground` is added to the server view in Task 6 and to the web client type in Task 7, spelled identically.
