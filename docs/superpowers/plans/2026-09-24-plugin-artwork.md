# Plugin Artwork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Have plugins fetch artwork from the upstream provider for a resolved media item and its people, filling the artwork pipeline that exists and is never written to.

**Architecture:** A provider-keyed `ArtworkSource` seam in `@pickarr/openmetadata`, one implementation (TMDB), and a dedicated job enqueued at the end of a successful lookup. Person artwork gets the table, writer and route that media items already have.

**Tech Stack:** TypeScript (`verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `node:sqlite` + drizzle, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-plugin-artwork-design.md`

## Global Constraints

- **Never the `any` type.** Narrow with `in` and `typeof`; never `as` a row.
- **Artwork is deliberately NOT replicated.** No sync triggers, no projection, no entry in `HOST_SYNCED_TABLES` — `web/src/store/gather.ts` fetches artwork by url, never as rows (#79). A migration here installs no triggers, and that is the one thing most likely to be done wrong by habit.
- **Migrations on a synced table are `ALTER TABLE ... ADD COLUMN` only.** This plan creates a new, unsynced table, so it does not touch one — but `docs/database-migrations.md` is still required reading.
- **Artwork must never fail a lookup.** Everything here runs in its own job.
- **No credential in a log, ever.** A TMDB bearer token is a credential; `clients/redact.ts` exists and a url carrying a key must go through it.
- **Prefer the async form of an API over its synchronous twin.**
- `afterEach(cleanup)` in any web test file; never hand a live DOM element to `node:assert`.
- Verified facts this plan rests on, each read from the provider's own document rather than remembered: `/3/configuration` returns `images.secure_base_url` plus `poster_sizes`/`backdrop_sizes`/`logo_sizes`/`profile_sizes`; `/3/{movie,tv}/{id}/images` returns `posters`, `backdrops`, `logos`; each entry carries `file_path`, `width`, `height`, `iso_639_1`, `aspect_ratio`, `vote_average`, `vote_count`; a full url is `secure_base_url + size + file_path`; auth is an `Authorization: Bearer` header.
- Gate: `npm run build` → `npm run check` → `npm run e2e`.

---

### Task 1: Person artwork storage, writer and route

**Files:**
- Modify: `packages/contract/src/media.ts` (`attachPersonImage`)
- Modify: `packages/host/src/db/migrate.ts` (`MIGRATION_23`)
- Modify: `packages/host/src/db/schema.ts` (`personImage`)
- Modify: `packages/host/src/media/writer.ts`
- Modify: `packages/host/src/api/artwork-route.ts` (the `person` kind)
- Test: `packages/host/test/db/migrate.test.ts`, `packages/host/test/media/writer.test.ts`, the artwork-route test

**Interfaces:**
- Produces: `MediaWriter.attachPersonImage(personId: number, image: ImageInit): Promise<void>` and `GET /api/artwork/person/:personId`. Task 4 calls the first.

- [ ] **Step 1: Write the migration test first**

Migration 22 is the current maximum; yours is 23. The assertion that matters is the *absence* of triggers:

```ts
test('migration 23 adds person_image, and does not replicate it', () => {
  // Artwork is not synced -- `web/src/store/gather.ts` fetches it by url
  // and holds no artwork rows (#79). Installing triggers here would push
  // every image row into `sync_log` and into every browser's replica, for
  // data no client reads. Asserted as the absence of triggers, because
  // adding them is the habit this table has to resist.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const columns = raw.prepare("SELECT name FROM pragma_table_info('person_image')").all()
    .map((row) => String((row as { name: unknown }).name));
  assert.deepEqual(columns.sort(), ['created_at', 'height', 'id', 'language', 'path', 'person_id', 'title', 'url', 'width']);

  const triggers = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'person_image'",
  ).all();
  assert.deepEqual(triggers, [], 'artwork is not replicated, so this table has no sync triggers');
  raw.close();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:server -- --test-name-pattern="migration 23"`
Expected: FAIL — `person_image` has no columns.

- [ ] **Step 3: Add the migration**

Mirror `poster`'s shape exactly, keyed on the person instead:

```ts
/**
 * `person_image`: a cached picture of a person, the same shape the three
 * media-item artwork tables have.
 *
 * **No `installSyncTriggers` and no `seedSyncLog`**, unlike every other
 * table added since migration 15. Artwork is not replicated: a client
 * fetches it by url through `/api/artwork/...` and holds no artwork rows
 * at all (`web/src/store/gather.ts`, #79). Triggers here would copy every
 * image row into `sync_log` and into every browser, for something no
 * client reads.
 *
 * `UNIQUE (person_id, url)` for the reason `poster_media_item_url` gives:
 * one image is one row however many times a handler re-runs.
 */
const MIGRATION_23 = `
CREATE TABLE person_image (
  id         INTEGER PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES person (id),
  title      TEXT,
  language   TEXT,
  url        TEXT    NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  path       TEXT
);
CREATE UNIQUE INDEX person_image_person_url ON person_image (person_id, url);
`;
```

and `{ version: 23, up: (db) => db.exec(MIGRATION_23) },` in `MIGRATIONS`.

- [ ] **Step 4: Add the drizzle table**, mirroring `poster` in `schema.ts`, so the DDL-parity test passes.

- [ ] **Step 5: Add the writer**

`attachPersonImage` alongside `attachPoster`. It measures through `ArtworkStore` exactly as the three siblings do — **read `attachPoster` and follow it**, including its upsert-on-conflict behaviour, rather than inventing a second shape. Note that `ArtworkStore.put` is keyed `(mediaItemId, url)`; a person is not a media item, so decide deliberately what key a person's file uses and write down why. The id spaces are different, so passing a `personId` where a `mediaItemId` is expected would collide two different rows onto one path — the honest fix is a distinct key, and the docblock should say so.

- [ ] **Step 6: Add the `person` kind to the artwork route**

`ArtworkKind` gains `'person'`. Read that module's docblock first: each kind is **one literal query**, never a template, and the `ORDER BY id ASC LIMIT 1` + `AND path IS NOT NULL` pair is load-bearing for a reason it explains. A person's query keys on `person_id`, so the route needs a second parameter shape — decide whether `/api/artwork/person/:personId` is a separate route entry or a widening of the existing one, and say which and why.

- [ ] **Step 7: Run the gate and commit**

Run: `npm run build && npm run check`

```bash
git add packages/contract packages/host
git commit -m "Store, and serve, a cached picture of a person"
```

---

### Task 2: The source seam and the selection rule

**Files:**
- Create: `packages/openmetadata/src/artwork/source.ts`
- Test: `packages/openmetadata/test/artwork/source.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProviderImage {
    readonly url: string;
    readonly language: string | null;
    readonly score: number;
  }
  export interface MediaImages {
    readonly posters: readonly ProviderImage[];
    readonly backgrounds: readonly ProviderImage[];
    readonly logos: readonly ProviderImage[];
  }
  export interface ArtworkSource {
    mediaImages(kind: string, providerRef: string): Promise<MediaImages>;
    personImages(providerRef: string): Promise<readonly ProviderImage[]>;
  }
  export function bestImage(images: readonly ProviderImage[], language: string): ProviderImage | undefined;
  ```
  Task 3 implements `ArtworkSource`; task 4 calls `bestImage`.

- [ ] **Step 1: Write the failing tests for `bestImage`**

This is the one pure function in the slice, so it carries the heaviest pinning:

```ts
test('the highest score wins', () => {});
test('the configured language beats a higher-scoring foreign image', () => {
  // A poster in a language the operator does not read is worse than a
  // lower-scored one they do, however the provider votes.
});
test('a language-neutral image beats a foreign one, and loses to a matching one', () => {
  // `iso_639_1: null` is a textless image -- usually the best poster there
  // is, and the reason the order is match > neutral > foreign rather than
  // match > everything.
});
test('an empty list answers undefined rather than throwing', () => {
  // A provider with no artwork for an item is ordinary, not an error.
});
test('ties break on score, then stably', () => {
  // Two images, same language, same score: the answer must not depend on
  // sort stability differing between runtimes.
});
```

Spell the expected url literally in each; never compute it from the input array.

- [ ] **Step 2: Run and watch fail** — `npm run test:server -- --test-name-pattern="highest score wins"`

- [ ] **Step 3: Write the module.** `bestImage` sorts by a tier (0 match, 1 neutral, 2 foreign) then by descending score then by url for a stable final tiebreak.

- [ ] **Step 4: Run and watch pass. Mutate:** swap the tier order, drop the score comparison, remove the final tiebreak — each must redden a named test. Report which.

- [ ] **Step 5: Commit**

---

### Task 3: The TMDB source

**Files:**
- Create: `packages/openmetadata/src/artwork/tmdb.ts`
- Test: `packages/openmetadata/test/artwork/tmdb.test.ts`

**Interfaces:**
- Consumes: `ArtworkSource`, `ProviderImage` (task 2); `HostFetch`, `SecretResolver`
- Produces: `export function createTmdbSource(deps: { fetch: HostFetch; resolveSecret: SecretResolver }): ArtworkSource`

Every fact below was read from TMDB's own documents; do not add a field this list does not name without reading them again.

- [ ] **Step 1: Write the failing tests** against a fake `HostFetch` that records urls and returns canned bodies:

```ts
test('a movie’s images become posters, backgrounds and logos', () => {
  // `/3/movie/{ref}/images` answers `posters`, `backdrops` and `logos`.
  // Note the rename: the provider says `backdrops`, this codebase says
  // `background` (the table, the writer and the route all do), and the
  // mapping happens here rather than leaking either name into the other.
});
test('a television kind asks the television endpoint', () => {
  // `kind` is openmetadata's vocabulary, not TMDB's path. Pinned because
  // asking `/3/movie/{id}` for a series id answers a *different show*
  // rather than 404ing, which no test of the happy path would notice.
});
test('a kind TMDB has no images endpoint for asks nothing at all', () => {});
test('the image url is secure_base_url + size + file_path', () => {
  // Spelled literally: `https://image.tmdb.org/t/p/w780/abc.jpg`.
});
test('configuration is fetched once and reused across calls', () => {
  // Counted, because the obvious implementation fetches it per item and
  // nothing about the output would show it.
});
test('the api key travels as a bearer header, never in the url', () => {
  // Asserted on the recorded init *and* on the recorded url: a key in a
  // query string ends up in every log and every error message.
});
test('a person’s profiles become images', () => {});
test('no key configured answers no images rather than throwing', () => {});
```

- [ ] **Step 2: Run, watch fail, implement, watch pass.**

Sizes, chosen at the source to bound the download (see the spec): `w780`
posters, `w1280` backdrops, `w300` logos, `w185` profiles. `score` is
`vote_average`; `language` is `iso_639_1`.

- [ ] **Step 3: Commit**

---

### Task 4: The job

**Files:**
- Create: `packages/openmetadata/src/artwork/job.ts`
- Test: `packages/openmetadata/test/artwork/job.test.ts`

**Interfaces:**
- Consumes: tasks 1, 2 and 3
- Produces: `export const ARTWORK_JOB = 'artwork';` and its `JobHandler`, registered in the plugin's `jobs` map.

- [ ] **Step 1: Write the failing tests**

```ts
test('a resolved item gets one poster, one background and one logo', () => {});
test('each person gets one image', () => {});
test('a provider with no registered source logs once, not once per item', () => {
  // Two items from the same provider, one log. Counted.
});
test('a source that throws leaves the media item alone and fails only the job', () => {});
test('a download the store refuses does not stop the other images', () => {
  // `ArtworkStore.put` rejects bytes `image-size` cannot measure -- an
  // html error page served 200 looks exactly like this. One bad poster
  // must not cost the backdrop and the cast.
});
test('running twice writes one row and one file per slot', () => {
  // The unique indexes make the second write a no-op; this proves the job
  // does not instead throw on the conflict.
});
test('an oversized image is refused after download, as the second line the spec names', () => {});
```

- [ ] **Step 2: Implement, run, mutate.** At minimum: make the per-provider log per-item, and remove the per-image error isolation — each must redden its test.

- [ ] **Step 3: Commit**

---

### Task 5: Enqueue it

**Files:**
- Modify: `packages/openmetadata/src/engine.ts`
- Test: `packages/openmetadata/test/engine-resolved.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test('a resolved lookup enqueues one artwork job for the item it resolved', () => {
  // Spelled literally: the media item id, not derived from the fixture.
});
test('a refused or unresolved lookup enqueues nothing', () => {
  // There is no media item to fetch artwork for.
});
test('the enqueue happens after the resolution is recorded', () => {
  // Order matters only in one direction: a job that ran before
  // `setResolution` could read a row mid-write. Pinned on the recorded
  // call order, which `testing.ts`'s fake already captures.
});
test('a failing enqueue does not fail the lookup', () => {
  // The whole premise of a separate job. If `jobs.enqueue` throws, the
  // release stays identified and the throw is logged, not propagated.
});
```

- [ ] **Step 2: Implement, run, mutate** — remove the try/catch around the enqueue and confirm the last test reddens.

- [ ] **Step 3: Commit**

---

### Task 6: The browser proof

**Files:**
- Modify: `packages/e2e/src/harness-2.ts`, `packages/e2e/tests/shell.spec.ts`

- [ ] **Step 1: Assert the whole path**

One spec: seed a media item with a real poster row and a real cached file, and assert the card renders it. This is the only test that covers row → file → route → `<img>` together, and `getByRole` cannot fake it — `MediaItemCard.onError` removes the `<img>` from the DOM on a 404, so a broken route is visible as an absent element rather than a broken image.

The harness already has `seedTvRelease({ withPoster: true })`, which writes a `poster` row with a `path`. Read it before adding anything; it may already be enough, in which case assert against it rather than building a second seeder.

- [ ] **Step 2: Mutate the route** — break the `person` kind's query and the poster query in turn, and confirm each reddens something.

- [ ] **Step 3: Full gate**

Run: `npm run build && npm run check && npm run e2e`

- [ ] **Step 4: Commit**

---

## Notes for the executor

- **`tpdb` is deliberately unregistered.** Do not write a ThePornDB client from memory to "finish the job" — its contract was not readable when this plan was written, and inventing one is the failure mode this repo has been bitten by most. The correct behaviour for an unregistered provider is task 4's single log.
- **Do not add artwork to the sync surface.** Several instincts in this codebase push the other way, because every other table added since migration 15 is replicated. This one is not, and `gather.ts` is the reason.
- **`HostFetch.bytes` has no size cap** — it reads a whole `arrayBuffer()`. That is why sizes are chosen at the source rather than trusted afterwards, and why task 4 still enforces a cap as a second line.
