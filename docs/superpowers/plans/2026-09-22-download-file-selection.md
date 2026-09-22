# Download File Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A finished download that is a directory imports the right file(s): the plugin chooses which entries of the download go to the library, and the host lists and copies them.

**Architecture:** The host gains `LibraryImporter.list` (a recursive, path-safe listing of a download) and `place` takes `(download, entry, resolveTokens)`. The shared openmetadata engine lists, asks the plugin what it `expects`, runs a pure `select`, and places each chosen entry that a per-plugin `<id>_placement` table has not already recorded.

**Tech Stack:** TypeScript (Node ≥ 24, `node:test`, `node:sqlite`), npm workspaces, oxlint, tsgo, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-22-download-file-selection-design.md` — read it before starting any task.

## Global Constraints

- Never use the `any` type; avoid `unknown` except where narrowing untyped input (the codebase already does this for `ctx.db` and caught errors).
- 2-space indents; semicolons always.
- **No path in any log line or thrown message** — not an absolute path, not a relative path, not a filename (spec §8). Logs carry ids, refusal codes, `errno`, and counts only.
- Every refusal is returned as a value from the host, and the engine logs then **throws** so the download row stays `completed` (spec §6, §8). Nothing calls `failRow`.
- Video extensions, verbatim: `mkv mp4 m4v avi mov wmv mpg mpeg ts m2ts webm iso` (spec §3).
- `sample` is matched case-insensitively against the **relative** path only (spec §3).
- New `ImportRefusalCode`s: `list-failed`, `foreign-entry`. Selection refusal codes (engine-local, not `ImportRefusalCode`): `no-video-file`, `too-many-video-files`, `episode-marker-missing`, `episode-marker-duplicate` (spec §5, §6).
- Unmatched destination: `<root>/<unmatched>/<release name>/<relative path>`; release name is the directory's name as-is, or a single file's name minus its extension (spec §4.3).
- The placement table is each plugin's **version 3** migration (spec §7).
- Use async `node:fs/promises` APIs; no `*Sync` filesystem calls in `src`.
- Read `docs/database-migrations.md` before Task 2 (a migration adds a table).
- Verification before any task is called done: `npm run lint`, `npm run typecheck`, `npm run test-hygiene`, `npm test`, `npm run build` — all from the worktree root. (`npm run check` runs the first four.)
- Commit after each task. Never push.

## Review Focus

1. **A release whose own directory name contains "sample"** (e.g. *The Sample (2019)*) — the film must still be found; only the relative path is checked. Pinned in Task 1.
2. **Upper-case or mixed-case extensions and markers** (`MOVIE.ISO`, `s01e02`) — must be treated like lower case. Pinned in Task 1.
3. **A single-file download that is unmatched** — must land inside its own `<stem>/` directory, not loose in `_unmatched/`. Pinned in Task 3.
4. **A download path that ends in `/..` or whose release name is `.`/`..`** — must be refused, not written into the library root (the extra release-name segment would otherwise let `_unmatched/../file` resolve inside the root). Pinned in Task 3.
5. **A pack partly placed, then retried** — must resume without `destination-exists`, and an unrecorded file that *is* already there must still refuse. Pinned in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/openmetadata/src/select.ts` (create) | Pure selection: candidates, `SxxEyy` markers, `select()` |
| `packages/openmetadata/src/placement.ts` (create) | `<id>_placement` migration generator, `isPlaced`, `recordPlacement` |
| `packages/openmetadata/src/index.ts` (modify) | Export the two modules above |
| `packages/contract/src/library.ts` (modify) | `DownloadEntry`, `list`, new `place` signature, two new refusal codes |
| `packages/contract/src/plugin.ts` (modify) | `DownloadedFile.path` / `sizeBytes` docs |
| `packages/contract/src/index.ts` (modify) | Export `DownloadEntry` |
| `packages/host/src/media/import.ts` (modify) | `list`, entry ownership check, new unmatched layout, copy from `entry.path` |
| `packages/openmetadata/src/testing.ts` (modify) | Harness fake for `list`, scripted `place` queue, recorded entries |
| `packages/openmetadata/src/engine.ts` (modify) | `expects` on the spec; list → select → place-unplaced → record |
| `packages/host/test/double/plugin.ts` (modify) | Double lists and places every entry |
| `packages/plugin-{movie,xxx,tv}/src/migrations.ts` (modify) | Version 3: placement table |
| `packages/plugin-{movie,xxx}/src/index.ts` (modify) | `expects: single` |
| `packages/plugin-tv/src/expects.ts` (create) | TV `expects` from `tv_release.kind` / `tv_season.season_number` |
| `packages/plugin-tv/src/index.ts` (modify) | Wire `expects` |

---

### Task 1: Pure selection (`select.ts`)

**Files:**
- Create: `packages/openmetadata/src/select.ts`
- Modify: `packages/openmetadata/src/index.ts`
- Test: `packages/openmetadata/test/select.test.ts`

**Interfaces:**
- Consumes: nothing (generic over `{ readonly relativePath: string }`, so it does not wait for the contract change).
- Produces:
  ```ts
  export type Expectation =
    | { readonly kind: 'single' }
    | { readonly kind: 'episodes'; readonly season: number | null };
  export type SelectionRefusalCode =
    | 'no-video-file' | 'too-many-video-files' | 'episode-marker-missing' | 'episode-marker-duplicate';
  export interface SelectionRefusal { readonly refusal: SelectionRefusalCode }
  export interface Selection<T> { readonly chosen: readonly T[] }
  export function isCandidate(relativePath: string): boolean;
  export function episodeMarker(filename: string): { season: number; episodes: readonly number[] } | null;
  export function select<T extends { readonly relativePath: string }>(
    entries: readonly T[],
    expectation: Expectation | 'unmatched',
  ): Selection<T> | SelectionRefusal;
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/openmetadata/test/select.test.ts`:

```ts
/**
 * `select`: which entries of a finished download a plugin copies (design
 * spec 2026-09-22 §3-§4). Pure, so every rule is pinned against literal
 * relative paths -- nothing here is computed by the code under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeMarker, isCandidate, select } from '../src/select.ts';
import type { Expectation } from '../src/select.ts';

const SINGLE: Expectation = { kind: 'single' };
const SEASON_1: Expectation = { kind: 'episodes', season: 1 };
const SERIES: Expectation = { kind: 'episodes', season: null };

function entries(...relativePaths: string[]): { relativePath: string }[] {
  return relativePaths.map((relativePath) => ({ relativePath }));
}

function chosen(result: ReturnType<typeof select<{ relativePath: string }>>): string[] {
  assert.ok('chosen' in result, `expected a selection, got ${JSON.stringify(result)}`);
  return result.chosen.map((entry) => entry.relativePath);
}

test('a candidate is a video extension, compared case-insensitively', () => {
  for (const name of ['a.mkv', 'a.MP4', 'a.m4v', 'a.avi', 'a.mov', 'a.wmv', 'a.mpg', 'a.mpeg',
    'a.ts', 'a.m2ts', 'a.webm', 'a.iso', 'MOVIE.ISO']) {
    assert.equal(isCandidate(name), true, name);
  }
  for (const name of ['a.nfo', 'a.srt', 'a.mds', 'a.mds.mds', 'a.jpg', 'mkv', 'a.mkv.part', '.mkv']) {
    assert.equal(isCandidate(name), false, name);
  }
});

test('anything with "sample" in its relative path is not a candidate, in any case', () => {
  assert.equal(isCandidate('Sample/film.mkv'), false);
  assert.equal(isCandidate('film.sample.mkv'), false);
  assert.equal(isCandidate('SAMPLE-film.mkv'), false);
  assert.equal(isCandidate('extras/Samples/x.mkv'), false);
});

test('the Swiss Family Robinson layout chooses exactly the iso', () => {
  const result = select(entries(
    'Swiss Family Robinson (1960) (USA).iso',
    'Swiss Family Robinson (1960) (USA).mds.mds',
  ), SINGLE);
  assert.deepEqual(chosen(result), ['Swiss Family Robinson (1960) (USA).iso']);
});

test('single: a film beside its sample is chosen', () => {
  assert.deepEqual(chosen(select(entries('film.mkv', 'Sample/sample.mkv', 'film.nfo'), SINGLE)), ['film.mkv']);
});

test('the download directory\'s own name is never consulted: it is not part of any relative path', () => {
  // A download at `/downloads/The.Sample.2019/` lists `film.mkv`, not
  // `The.Sample.2019/film.mkv` -- the host strips the root. Pinned so that
  // nobody "helpfully" passes the full path to isCandidate.
  assert.deepEqual(chosen(select(entries('film.mkv'), SINGLE)), ['film.mkv']);
});

test('a film whose own filename contains "sample" is excluded -- spec §3, literally', () => {
  // Scene releases usually name the file after the folder, so *The Sample
  // (2019)* delivered as `The.Sample.2019.mkv` finds no candidate. This is
  // what spec §3 says; it is pinned so that changing it is a decision.
  assert.deepEqual(select(entries('The.Sample.2019.mkv', 'The.Sample.2019.nfo'), SINGLE), { refusal: 'no-video-file' });
});

test('single: zero candidates refuses no-video-file', () => {
  assert.deepEqual(select(entries('a.nfo', 'b.srt'), SINGLE), { refusal: 'no-video-file' });
  assert.deepEqual(select(entries(), SINGLE), { refusal: 'no-video-file' });
});

test('single: two candidates refuses too-many-video-files rather than choosing by size', () => {
  assert.deepEqual(select(entries('a.mkv', 'b.mkv'), SINGLE), { refusal: 'too-many-video-files' });
});

test('episodeMarker reads SxxEyy and multi-episode forms, case-insensitively', () => {
  assert.deepEqual(episodeMarker('Show.S01E02.mkv'), { season: 1, episodes: [2] });
  assert.deepEqual(episodeMarker('show.s01e02.720p.mkv'), { season: 1, episodes: [2] });
  assert.deepEqual(episodeMarker('Show.S1E2.mkv'), { season: 1, episodes: [2] });
  assert.deepEqual(episodeMarker('Show.S01E01E02.mkv'), { season: 1, episodes: [1, 2] });
  assert.deepEqual(episodeMarker('Show.S01E01-E02.mkv'), { season: 1, episodes: [1, 2] });
  assert.deepEqual(episodeMarker('Show.S02E105.mkv'), { season: 2, episodes: [105] });
  assert.equal(episodeMarker('Show.Extras.mkv'), null);
});

test('episodes: every candidate is chosen, numbering need not be contiguous', () => {
  const result = select(entries('S1/Show.S01E01.mkv', 'S1/Show.S01E02.mkv', 'S1/Show.S01E05.mkv', 'Show.nfo'), SEASON_1);
  assert.deepEqual(chosen(result), ['S1/Show.S01E01.mkv', 'S1/Show.S01E02.mkv', 'S1/Show.S01E05.mkv']);
});

test('episodes: the marker is read from the filename, not from a directory', () => {
  assert.deepEqual(
    select(entries('Show.S01E01/extras.mkv'), SEASON_1),
    { refusal: 'episode-marker-missing' },
  );
});

test('episodes: a candidate with no marker refuses episode-marker-missing', () => {
  assert.deepEqual(
    select(entries('Show.S01E01.mkv', 'extras.mkv'), SEASON_1),
    { refusal: 'episode-marker-missing' },
  );
});

test('episodes: a repeated season/episode pair refuses episode-marker-duplicate', () => {
  assert.deepEqual(
    select(entries('Show.S01E02.720p.mkv', 'Show.S01E02.1080p.mkv'), SEASON_1),
    { refusal: 'episode-marker-duplicate' },
  );
  // A multi-episode file overlapping a single one is a duplicate too.
  assert.deepEqual(
    select(entries('Show.S01E01E02.mkv', 'Show.S01E02.mkv'), SEASON_1),
    { refusal: 'episode-marker-duplicate' },
  );
});

test('episodes: a season pack holding another season refuses too-many-video-files', () => {
  assert.deepEqual(
    select(entries('Show.S01E01.mkv', 'Show.S02E05.mkv'), SEASON_1),
    { refusal: 'too-many-video-files' },
  );
});

test('episodes: a series pack, or a season pack of unknown number, accepts any season', () => {
  const files = entries('Show.S01E01.mkv', 'Show.S02E01.mkv');
  assert.deepEqual(chosen(select(files, SERIES)), ['Show.S01E01.mkv', 'Show.S02E01.mkv']);
});

test('episodes: zero candidates refuses no-video-file', () => {
  assert.deepEqual(select(entries('Show.nfo', 'Sample/Show.S01E01.mkv'), SEASON_1), { refusal: 'no-video-file' });
});

test('episodes: refusals are checked in order -- missing before season before duplicate', () => {
  // All three problems at once: the first rule in spec order wins.
  assert.deepEqual(
    select(entries('extras.mkv', 'Show.S02E01.mkv', 'Show.S01E01.mkv', 'Show.S01E01.x.mkv'), SEASON_1),
    { refusal: 'episode-marker-missing' },
  );
  assert.deepEqual(
    select(entries('Show.S02E01.mkv', 'Show.S01E01.mkv', 'Show.S01E01.x.mkv'), SEASON_1),
    { refusal: 'too-many-video-files' },
  );
});

test('unmatched: every entry is chosen, sidecars and samples included', () => {
  const files = entries('film.iso', 'film.mds.mds', 'Sample/sample.mkv');
  assert.deepEqual(chosen(select(files, 'unmatched')), ['film.iso', 'film.mds.mds', 'Sample/sample.mkv']);
});

test('the chosen entries are the objects passed in, not copies', () => {
  const input = [{ relativePath: 'a.mkv', path: '/x/a.mkv', sizeBytes: 3 }];
  const result = select(input, SINGLE);
  assert.ok('chosen' in result);
  assert.equal(result.chosen[0], input[0]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/select.test.ts`
Expected: FAIL — cannot find module `../src/select.ts`.

- [ ] **Step 3: Implement**

Create `packages/openmetadata/src/select.ts`:

```ts
/**
 * Which entries of a finished download a plugin copies into its library
 * (design spec 2026-09-22 §3-§4).
 *
 * Pure: it reads relative paths and nothing else, so the host keeps the
 * filesystem and this module keeps the judgement. Generic over the entry so
 * the objects chosen are the objects passed in -- the engine hands them
 * straight back to `LibraryImporter.place`, which checks they belong to the
 * download.
 */

/** Spec §3, verbatim. Lower case; extensions are lower-cased before lookup. */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mkv', 'mp4', 'm4v', 'avi', 'mov', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'webm', 'iso',
]);

/**
 * `S` + one or two digits, `E` + one to three digits, then any further
 * `E<digits>` or `-E<digits>` groups (spec §4.2).
 */
const MARKER = /s(\d{1,2})e(\d{1,3})((?:-?e\d{1,3})*)/i;
const FURTHER_EPISODE = /e(\d{1,3})/gi;

export type Expectation =
  | { readonly kind: 'single' }
  | { readonly kind: 'episodes'; readonly season: number | null };

export type SelectionRefusalCode =
  | 'no-video-file'
  | 'too-many-video-files'
  | 'episode-marker-missing'
  | 'episode-marker-duplicate';

export interface SelectionRefusal {
  readonly refusal: SelectionRefusalCode;
}

export interface Selection<T> {
  readonly chosen: readonly T[];
}

function lastSegment(relativePath: string): string {
  const segments = relativePath.split('/');
  return segments[segments.length - 1] ?? '';
}

/** Spec §3: a video extension, and no `sample` anywhere in the relative path. */
export function isCandidate(relativePath: string): boolean {
  if (relativePath.toLowerCase().includes('sample')) return false;
  const name = lastSegment(relativePath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return VIDEO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** The season and every episode a filename's marker names, or `null`. */
export function episodeMarker(filename: string): { season: number; episodes: readonly number[] } | null {
  const match = MARKER.exec(filename);
  if (match === null) return null;
  const [, season, first, rest] = match;
  if (season === undefined || first === undefined) return null;
  const further = [...(rest ?? '').matchAll(FURTHER_EPISODE)].map((group) => Number(group[1]));
  return { season: Number(season), episodes: [Number(first), ...further] };
}

function selectEpisodes<T extends { readonly relativePath: string }>(
  candidates: readonly T[],
  season: number | null,
): Selection<T> | SelectionRefusal {
  const markers = candidates.map((entry) => episodeMarker(lastSegment(entry.relativePath)));
  // Spec order: missing, then another season, then a duplicate.
  const present = markers.filter((marker) => marker !== null);
  if (present.length !== markers.length) return { refusal: 'episode-marker-missing' };
  if (season !== null && present.some((marker) => marker.season !== season)) {
    return { refusal: 'too-many-video-files' };
  }
  const seen = new Set<string>();
  for (const marker of present) {
    for (const episode of marker.episodes) {
      const key = `${marker.season}:${episode}`;
      if (seen.has(key)) return { refusal: 'episode-marker-duplicate' };
      seen.add(key);
    }
  }
  return { chosen: candidates };
}

export function select<T extends { readonly relativePath: string }>(
  entries: readonly T[],
  expectation: Expectation | 'unmatched',
): Selection<T> | SelectionRefusal {
  // Spec §4.3: an unmatched release is copied whole; there is nothing to
  // judge it against.
  if (expectation === 'unmatched') return { chosen: entries };
  const candidates = entries.filter((entry) => isCandidate(entry.relativePath));
  if (candidates.length === 0) return { refusal: 'no-video-file' };
  if (expectation.kind === 'single') {
    return candidates.length === 1 ? { chosen: candidates } : { refusal: 'too-many-video-files' };
  }
  return selectEpisodes(candidates, expectation.season);
}
```

Append to `packages/openmetadata/src/index.ts`:

```ts
export type { Expectation, Selection, SelectionRefusal, SelectionRefusalCode } from './select.ts';
export { episodeMarker, isCandidate, select } from './select.ts';
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/select.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add packages/openmetadata/src/select.ts packages/openmetadata/src/index.ts packages/openmetadata/test/select.test.ts
git commit -m "Choose a download's files by what the plugin expects, as a pure function"
```

---

### Task 2: Placement table and each plugin's version 3

**Files:**
- Create: `packages/openmetadata/src/placement.ts`
- Modify: `packages/openmetadata/src/index.ts`
- Modify: `packages/plugin-movie/src/migrations.ts`, `packages/plugin-xxx/src/migrations.ts`, `packages/plugin-tv/src/migrations.ts`
- Test: `packages/openmetadata/test/placement.test.ts`; add one test each to `packages/plugin-movie/test/apply.test.ts`, `packages/plugin-xxx/test/apply.test.ts`, `packages/plugin-tv/test/apply.test.ts`

**Interfaces:**
- Consumes: `Migration` from `@pickarr/contract`.
- Produces:
  ```ts
  export function placementTableName(pluginId: string): string;         // `${pluginId}_placement`
  export function placementTableMigration(pluginId: string, version: number): Migration;
  export function isPlaced(raw: DatabaseSync, pluginId: string, rssItemId: number, relativePath: string): boolean;
  export function recordPlacement(raw: DatabaseSync, pluginId: string, rssItemId: number, relativePath: string, at: number): void;
  ```

- [ ] **Step 1: Read `docs/database-migrations.md`.** This migration only creates a new table (no rebuild), which that doc permits; the table is not in any plugin's `synced` list and must not be added to one.

- [ ] **Step 2: Write the failing tests**

Create `packages/openmetadata/test/placement.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  isPlaced, placementTableMigration, placementTableName, recordPlacement,
} from '../src/placement.ts';

function database(): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('CREATE TABLE rss_item (id INTEGER PRIMARY KEY)');
  placementTableMigration('tv', 3).up(raw);
  return raw;
}

test('the table is named with the plugin prefix, at the version the plugin chose', () => {
  assert.equal(placementTableName('tv'), 'tv_placement');
  assert.equal(placementTableMigration('movie', 3).version, 3);
  const raw = database();
  const row = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tv_placement'").get();
  assert.ok(row !== undefined, 'tv_placement was not created');
});

test('an entry is placed only once recorded, per rss item and relative path', () => {
  const raw = database();
  assert.equal(isPlaced(raw, 'tv', 7, 'S1/a.mkv'), false);
  recordPlacement(raw, 'tv', 7, 'S1/a.mkv', 1);
  assert.equal(isPlaced(raw, 'tv', 7, 'S1/a.mkv'), true);
  assert.equal(isPlaced(raw, 'tv', 8, 'S1/a.mkv'), false, 'another rss item is not placed');
  assert.equal(isPlaced(raw, 'tv', 7, 'S1/b.mkv'), false, 'another entry is not placed');
});

test('recording the same entry twice is not an error', () => {
  const raw = database();
  recordPlacement(raw, 'tv', 7, 'a.mkv', 1);
  recordPlacement(raw, 'tv', 7, 'a.mkv', 2);
  const count = raw.prepare('SELECT COUNT(*) AS n FROM tv_placement').get()?.['n'];
  assert.equal(count, 1);
});
```

In each plugin's `test/apply.test.ts` add (shown for tv; use `MOVIE_MIGRATIONS`/`movie_placement` and `XXX_MIGRATIONS`/`xxx_placement` for the other two — write each out in full in its own file):

```ts
test('migration 3 creates the placement table the engine records imports in', () => {
  const harness = createTestHarness();
  for (const migration of TV_MIGRATIONS) migration.up(harness.raw);
  assert.deepEqual(TV_MIGRATIONS.map((migration) => migration.version), [2, 3]);
  const row = harness.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tv_placement'")
    .get();
  assert.ok(row !== undefined, 'tv_placement was not created');
});
```

(Check the top of each `apply.test.ts` for the existing `createTestHarness` / migrations imports and add whichever are missing: `import { createTestHarness } from '@pickarr/openmetadata/testing';` and the plugin's `*_MIGRATIONS` from `../src/migrations.ts`.)

- [ ] **Step 3: Run to verify failure**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/placement.test.ts packages/plugin-*/test/apply.test.ts`
Expected: FAIL — module `../src/placement.ts` not found; plugin versions `[2]`.

- [ ] **Step 4: Implement**

Create `packages/openmetadata/src/placement.ts`:

```ts
/**
 * Which entries of a download this plugin has already put in its library
 * (design spec 2026-09-22 §7), so a retried pack resumes instead of meeting
 * its own earlier copies as `destination-exists`.
 *
 * **A generator, listed by each plugin as its own migration**, not prepended
 * by the engine the way `lookupTableMigration` is: the engine owns version 1
 * and each plugin's own migrations begin at 2, so an engine-appended version
 * would collide with the next migration a plugin writes.
 *
 * Written after the copy. A crash between the rename and the insert leaves
 * one file placed and unrecorded, and the retry answers `destination-exists`
 * for it; the spec names this window and leaves it open.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '@pickarr/contract';

export function placementTableName(pluginId: string): string {
  return `${pluginId}_placement`;
}

export function placementTableMigration(pluginId: string, version: number): Migration {
  const table = placementTableName(pluginId);
  return {
    version,
    up: (db) => db.exec(`
CREATE TABLE ${table} (
  id            INTEGER PRIMARY KEY,
  rss_item_id   INTEGER NOT NULL REFERENCES rss_item (id),
  relative_path TEXT NOT NULL,
  placed_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX ${table}_entry ON ${table} (rss_item_id, relative_path);
`),
  };
}

export function isPlaced(raw: DatabaseSync, pluginId: string, rssItemId: number, relativePath: string): boolean {
  const row = raw
    .prepare(`SELECT 1 AS found FROM ${placementTableName(pluginId)} WHERE rss_item_id = ? AND relative_path = ?`)
    .get(rssItemId, relativePath);
  return row !== undefined;
}

export function recordPlacement(
  raw: DatabaseSync,
  pluginId: string,
  rssItemId: number,
  relativePath: string,
  at: number,
): void {
  raw
    .prepare(`INSERT INTO ${placementTableName(pluginId)} (rss_item_id, relative_path, placed_at)
      VALUES (?, ?, ?) ON CONFLICT (rss_item_id, relative_path) DO NOTHING`)
    .run(rssItemId, relativePath, at);
}
```

Append to `packages/openmetadata/src/index.ts`:

```ts
export { isPlaced, placementTableMigration, placementTableName, recordPlacement } from './placement.ts';
```

In `packages/plugin-tv/src/migrations.ts`, import and append (literal id: `migrations.ts` must not import from `index.ts`, which imports it):

```ts
import { placementTableMigration } from '@pickarr/openmetadata';
// ...existing version 2 object stays exactly as it is...
export const TV_MIGRATIONS: readonly Migration[] = [{
  version: 2,
  up: /* unchanged */,
}, placementTableMigration('tv', 3)];
```

Do the same in `plugin-movie` (`placementTableMigration('movie', 3)`) and `plugin-xxx` (`placementTableMigration('xxx', 3)`). Update each file's header comment to mention version 3.

- [ ] **Step 5: Run to verify it passes**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/placement.test.ts packages/plugin-*/test/*.test.ts packages/host/test/plugins/flow.test.ts`
Expected: PASS (the flow test runs real `migratePlugin`, which enforces the `<id>_` prefix).

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add packages/openmetadata packages/plugin-movie packages/plugin-xxx packages/plugin-tv
git commit -m "Give each plugin a table recording which download entries it placed"
```

---

### Task 3: Contract and host — `list`, and `place` taking an entry

This task changes the `LibraryImporter` contract, so every implementer and caller changes together to keep the tree compiling: the host importer, the openmetadata test harness, the host test double, and the engine (interim: it lists and places every entry; Task 4 adds selection).

**Files:**
- Modify: `packages/contract/src/library.ts`, `packages/contract/src/plugin.ts:22-39`, `packages/contract/src/index.ts`
- Modify: `packages/host/src/media/import.ts`
- Modify: `packages/openmetadata/src/testing.ts:331-457`
- Modify: `packages/openmetadata/src/engine.ts` (`onDownloadedFile`)
- Modify: `packages/host/test/double/plugin.ts:752-786`
- Test: `packages/host/test/media/import.test.ts`, `packages/openmetadata/test/engine-jobs.test.ts`

**Interfaces:**
- Produces (contract):
  ```ts
  export interface DownloadEntry {
    readonly path: string;
    readonly relativePath: string;
    readonly sizeBytes: number;
  }
  export interface LibraryImporter {
    list(file: DownloadedFile): Promise<readonly DownloadEntry[] | ImportRefusal>;
    place(file: DownloadedFile, entry: DownloadEntry, resolveTokens: () => Promise<TokenValues>): Promise<ImportOutcome>;
  }
  // ImportRefusalCode gains: 'list-failed' | 'foreign-entry'
  ```
- Produces (harness, `@pickarr/openmetadata/testing`):
  ```ts
  interface RecordedImport { readonly file: DownloadedFile; readonly entry: DownloadEntry; readonly values: TokenValues }
  interface TestHarness {
    // existing members, plus:
    answerList(result: readonly DownloadEntry[] | ImportRefusal): void;   // next list() answers this
    answerImports(outcomes: readonly (ImportOutcome | undefined)[]): void; // queue; undefined = default success
    // answerImport(outcome) stays, as answerImports([outcome])
  }
  ```

- [ ] **Step 1: Contract**

In `packages/contract/src/library.ts`:
1. Add `'list-failed'` and `'foreign-entry'` to `ImportRefusalCode`, and doc bullets under "The rest are the copy's own":
   - `list-failed` — the filesystem refused the listing of the download. `errno` carries the code and nothing else, for the reason `copy-failed` gives.
   - `foreign-entry` — the entry handed to `place` is not a file inside the download it was handed with, so a plugin cannot use `place` to copy an arbitrary file.
2. Add `DownloadEntry` (doc: "One regular file inside a finished download, as `list` found it. `path` is absolute and host-built, handed back to `place` and never logged; `relativePath` is `/`-separated under the download root, and a plain-file download lists as its own basename.").
3. Add `list` to `LibraryImporter` with a doc: recursive; regular files only, symlinks below the root skipped, not followed (the root itself is followed, since a client may hand over a symlinked download); sorted by `relativePath` by plain code-unit comparison; a refusal only as `list-failed`.
4. Change `place`'s signature to `(file, entry, resolveTokens)` and extend its doc: `file` is the whole download, `entry` is what is copied; the unmatched destination is `<root>/<unmatched>/<release name>/<entry.relativePath>` (spec §4.3); `foreign-entry` for an entry not inside `file.path`.

In `packages/contract/src/plugin.ts`, document `DownloadedFile.path` as "the client's completed path, mapped: a file for a single-file download, a directory otherwise. `LibraryImporter.list` is what looks inside it." and `sizeBytes` as "the size `stat` reported for `path` — meaningless for a directory; `DownloadEntry.sizeBytes` is each file's."

In `packages/contract/src/index.ts`, add `DownloadEntry` to the type exports from `./library.ts`.

- [ ] **Step 2: Write the failing host tests**

In `packages/host/test/media/import.test.ts`:

(a) Change imports to add `basename` from `node:path` and `DownloadEntry` from `@pickarr/contract`.

(b) Extend `Harness` and `withHarness`:

```ts
  /** An entry for a plain-file download: the file itself, under its own basename. */
  entryFor: (file: DownloadedFile) => DownloadEntry;
  /** `place` with an explicit entry. */
  placeEntry: (file: DownloadedFile, entry: DownloadEntry, values: TokenValues) => Promise<ImportOutcome>;
  list: (file: DownloadedFile) => ReturnType<ReturnType<typeof createLibraryImporter>['list']>;
```

and in `withHarness`:

```ts
    function entryFor(file: DownloadedFile): DownloadEntry {
      return { path: file.path, relativePath: basename(file.path), sizeBytes: file.sizeBytes };
    }

    function placeWith(copyFile?: CopyFile): Harness['place'] {
      const importer = copyFile === undefined
        ? createLibraryImporter({ raw, pluginId: PLUGIN_ID })
        : createLibraryImporter({ raw, pluginId: PLUGIN_ID, copyFile });
      return async (file, values) => importer.place(
        file,
        entryFor(file),
        typeof values === 'function' ? values : async () => values,
      );
    }
    const importer = createLibraryImporter({ raw, pluginId: PLUGIN_ID });
    // ...in the harness object:
      entryFor,
      placeEntry: async (file, entry, values) => importer.place(file, entry, async () => values),
      list: async (file) => importer.list(file),
```

(c) Update the two unmatched-layout tests to the new §4.3 layout — the source is a single file named `${PATH_MARKER}.mkv`, so its release directory is `${PATH_MARKER}`:

```ts
    assert.deepEqual(await tree(h.root), [join('_pickarr', 'unmatched', PATH_MARKER, `${PATH_MARKER}.mkv`)]);
```
```ts
    assert.deepEqual(await tree(h.root), [join('_unmatched', PATH_MARKER, `${PATH_MARKER}.mkv`)]);
```
Rename the first test to `'spec 4.3: an unmatched single-file download lands in its own directory, named for the file without its extension'`.

(d) Add these tests:

```ts
/** A directory download under `<dir>/downloads/<name>/`, holding `files` (relative path -> bytes). */
async function directoryDownload(h: Harness, name: string, files: Record<string, string>): Promise<DownloadedFile> {
  const root = join(h.dir, 'downloads', name);
  for (const [relativePath, bytes] of Object.entries(files)) {
    const path = join(root, ...relativePath.split('/'));
    // eslint-disable-next-line no-await-in-loop -- fixture setup, order irrelevant
    await mkdir(join(path, '..'), { recursive: true });
    // eslint-disable-next-line no-await-in-loop -- see above
    await writeFile(path, bytes);
  }
  return h.file({ path: root, sizeBytes: 4096 });
}

test('list: a plain file lists as itself, under its own basename', async () => {
  await withHarness({}, async (h) => {
    assert.deepEqual(await h.list(h.file()), [
      { path: h.source, relativePath: `${PATH_MARKER}.mkv`, sizeBytes: SOURCE_BYTES.length },
    ]);
  });
});

test('list: a directory lists every regular file below it, nested, sorted, with sizes', async () => {
  await withHarness({}, async (h) => {
    const file = await directoryDownload(h, 'Release', { 'b.mkv': 'bb', 'a.nfo': 'a', 'Sub/c.srt': 'ccc' });
    assert.deepEqual(await h.list(file), [
      { path: join(file.path, 'Sub', 'c.srt'), relativePath: 'Sub/c.srt', sizeBytes: 3 },
      { path: join(file.path, 'a.nfo'), relativePath: 'a.nfo', sizeBytes: 1 },
      { path: join(file.path, 'b.mkv'), relativePath: 'b.mkv', sizeBytes: 2 },
    ]);
  });
});

test('list: a symlink inside the download is skipped, not followed', async () => {
  await withHarness({}, async (h) => {
    const file = await directoryDownload(h, 'Release', { 'a.mkv': 'a' });
    await symlink(h.source, join(file.path, 'link.mkv'));
    await mkdir(join(h.dir, 'elsewhere'));
    await writeFile(join(h.dir, 'elsewhere', 'x.mkv'), 'x');
    await symlink(join(h.dir, 'elsewhere'), join(file.path, 'linkdir'));
    const listed = await h.list(file);
    assert.ok(!('refusal' in listed));
    assert.deepEqual(listed.map((entry) => entry.relativePath), ['a.mkv']);
  });
});

test('list: a download that is not there refuses list-failed with an errno and no path', async () => {
  await withHarness({}, async (h) => {
    const outcome = await h.list(h.file({ path: join(h.dir, 'downloads', `${PATH_MARKER}-gone`) }));
    assert.deepEqual(outcome, { refusal: 'list-failed', errno: 'ENOENT' });
    assert.ok(!JSON.stringify(outcome).includes(PATH_MARKER));
  });
});

test('spec 9: the Swiss Family Robinson iso, placed from inside its directory, lands at the shaped path', async () => {
  await withHarness({}, async (h) => {
    h.destination({ shape: '{title}.{ext}' });
    const file = await directoryDownload(h, 'Swiss.Family.Robinson.1960.WIDESCREEN.NTSC.USA.DVD9-AndreMor', {
      'Swiss Family Robinson (1960) (USA).iso': 'iso bytes',
      'Swiss Family Robinson (1960) (USA).mds.mds': 'mds',
    });
    const listed = await h.list(file);
    assert.ok(!('refusal' in listed));
    const iso = listed.find((entry) => entry.relativePath.endsWith('.iso'));
    assert.ok(iso !== undefined);

    const outcome = await h.placeEntry(file, iso, { title: 'Swiss Family Robinson', ext: 'iso' });

    assert.deepEqual(outcome, { placed: 'library' });
    assert.equal(await readFile(join(h.root, 'Swiss Family Robinson.iso'), 'utf8'), 'iso bytes');
  });
});

test('spec 4.3: an unmatched directory download keeps its layout under a directory named as the download is', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const file = await directoryDownload(h, 'Some.Release.2020-GRP', { 'a.mkv': 'a', 'Sub/b.srt': 'b' });
    const listed = await h.list(file);
    assert.ok(!('refusal' in listed));
    for (const entry of listed) {
      // eslint-disable-next-line no-await-in-loop -- sequential, as the engine places them
      assert.deepEqual(await h.placeEntry(h.file({ ...file, mediaItemId: null }), entry, TV_VALUES), { placed: 'unmatched' });
    }
    // The dots in the directory name are kept: it is not a filename, so
    // nothing is taken off it as an extension.
    assert.deepEqual(await tree(h.root), [
      join('_unmatched', 'Some.Release.2020-GRP', 'Sub', 'b.srt'),
      join('_unmatched', 'Some.Release.2020-GRP', 'a.mkv'),
    ]);
  });
});

test('an entry that is not inside the download is refused foreign-entry, and nothing is copied', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    const file = await directoryDownload(h, 'Release', { 'a.mkv': 'a' });
    const outside: DownloadEntry = { path: h.source, relativePath: 'a.mkv', sizeBytes: 1 };
    const lying: DownloadEntry = { path: join(file.path, 'a.mkv'), relativePath: 'b.mkv', sizeBytes: 1 };
    const escaping: DownloadEntry = { path: h.source, relativePath: `../${PATH_MARKER}.mkv`, sizeBytes: 1 };
    for (const entry of [outside, lying, escaping]) {
      // eslint-disable-next-line no-await-in-loop -- each asserts an empty library
      assertRefusal(await h.placeEntry(file, entry, TV_VALUES), 'foreign-entry');
    }
    // A plain-file download whose entry names another basename is foreign too.
    assertRefusal(
      await h.placeEntry(h.file(), { path: h.source, relativePath: 'other.mkv', sizeBytes: 1 }, TV_VALUES),
      'foreign-entry',
    );
    assert.deepEqual(await tree(h.root), []);
  });
});

test('spec 4.3: a directory download whose release name is `..` or `.` is refused, not written into the library root', async () => {
  await withHarness({}, async (h) => {
    h.destination({});
    for (const tail of ['..', '.']) {
      // A directory-shaped download: `basename` of it is `..` / `.` (measured),
      // and `join` normalises the entry path, so the entry is genuinely
      // inside it and passes the ownership check. Only the release-name rule
      // stands between this and `_unmatched/../x.mkv`, which resolves to
      // `<root>/x.mkv` -- inside the root, so the final `startsWith` check
      // would let it through.
      const path = `${join(h.dir, 'downloads')}/${tail}`;
      const file = h.file({ path, mediaItemId: null });
      const entry: DownloadEntry = { path: join(path, 'x.mkv'), relativePath: 'x.mkv', sizeBytes: 1 };
      // eslint-disable-next-line no-await-in-loop -- each asserts an empty library
      assertRefusal(await h.placeEntry(file, entry, TV_VALUES), 'escapes-root');
    }
    assert.deepEqual(await tree(h.root), []);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --import tsx --conditions development --test packages/host/test/media/import.test.ts`
Expected: FAIL — typecheck-level errors are not reported by tsx, so expect runtime failures: `h.list is not a function` / wrong unmatched tree.

- [ ] **Step 4: Implement the host importer**

In `packages/host/src/media/import.ts`:

1. Imports: `import { copyFile as realCopyFile, lstat, mkdir, readdir, rename, stat } from 'node:fs/promises';`, `import { basename, dirname, join, resolve, sep } from 'node:path';`, add `DownloadEntry` to the contract type import.

2. Replace `unmatchedDestination` with:

```ts
/**
 * Design spec 2026-09-22 §4.3's destination for a release nothing matched:
 * `<unmatched>/<release name>/<relative path>`, relative to the root.
 *
 * The release name is its own segment, so it is checked on its own: `..`
 * here would otherwise resolve `_unmatched/../file` to a path *inside* the
 * root, which the final `startsWith` check cannot see. `basename('/a/..')`
 * is `'..'` (measured), so this is reachable from a source path.
 */
function unmatchedDestination(
  unmatchedDir: string,
  releaseName: string,
  relativePath: string,
): { path: string } | ImportRefusal {
  const unmatched = unmatchedDirSegments(unmatchedDir);
  if ('refusal' in unmatched) {
    return refuse(unmatched.refusal === 'escapes-root' ? 'escapes-root' : 'unmatched-dir-is-root');
  }
  if (releaseName === '') return refuse('empty-filename');
  if (releaseName === '.' || releaseName === '..') return refuse('escapes-root');
  return { path: [...unmatched.segments, releaseName, relativePath].join('/') };
}

/**
 * The directory an unmatched download is kept under (§4.3): a directory's
 * own name, or a single file's name without its extension.
 */
function releaseName(file: DownloadedFile, entry: DownloadEntry): string {
  const name = basename(file.path);
  if (entry.path !== file.path) return name;
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

/**
 * Whether `entry` is really a file inside `file` (spec §5): its relative
 * path is plain segments, and joining it to the download gives its path. A
 * plain-file download's only entry is the file itself under its basename.
 */
function isForeign(file: DownloadedFile, entry: DownloadEntry): boolean {
  const segments = entry.relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return true;
  if (entry.path === file.path) return segments.length !== 1 || segments[0] !== basename(file.path);
  return resolve(file.path, ...segments) !== resolve(entry.path);
}

/** Every regular file below `dir`, relative to it. Symlinks are skipped, not followed. */
async function walk(dir: string, prefix: string): Promise<DownloadEntry[]> {
  const children = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(children.map(async (child): Promise<DownloadEntry[]> => {
    const path = join(dir, child.name);
    const relativePath = prefix === '' ? child.name : `${prefix}/${child.name}`;
    // A `Dirent` describes the link, not its target, so a symlink is
    // neither a directory nor a file here and falls through to `[]`.
    if (child.isDirectory()) return walk(path, relativePath);
    if (!child.isFile()) return [];
    const { size } = await lstat(path);
    return [{ path, relativePath, sizeBytes: size }];
  }));
  return nested.flat();
}

function byRelativePath(a: DownloadEntry, b: DownloadEntry): number {
  if (a.relativePath < b.relativePath) return -1;
  return a.relativePath > b.relativePath ? 1 : 0;
}
```

3. In `createLibraryImporter`, `relativeDestination` takes `(file, entry, destination, resolveTokens)` and its unmatched branch becomes `return unmatchedDestination(destination.unmatchedDir, releaseName(file, entry), entry.relativePath);`.

4. Add `list` to the returned object:

```ts
    async list(file): Promise<readonly DownloadEntry[] | ImportRefusal> {
      try {
        // `stat`, not `lstat`, for the root alone: a client may hand over a
        // symlinked download, and following it is what the operator meant.
        const top = await stat(file.path);
        if (top.isFile()) return [{ path: file.path, relativePath: basename(file.path), sizeBytes: top.size }];
        if (!top.isDirectory()) return [];
        return (await walk(file.path, '')).toSorted(byRelativePath);
      } catch (error) {
        // Every `node:fs` message quotes the path -- see the module doc.
        return { refusal: 'list-failed', errno: importErrno(error) };
      }
    },
```

5. `place(file, entry, resolveTokens)`: first line after reading the destination row and root check, **before** `relativeDestination`: `if (isForeign(file, entry)) return refuse('foreign-entry');`. Pass `entry` to `relativeDestination`. Copy from `entry.path`: `await copyFile(entry.path, temporary);`.

6. Update the module doc: add a `## Listing` section (what `list` returns, symlinks, the root followed, `list-failed`); in "The unmatched directory is re-checked" / the `escapes-root` comment near line 311, replace the `_unmatched/..` example with the release-name check above; state that the copy source is `entry.path`.

- [ ] **Step 5: Implement the openmetadata harness**

In `packages/openmetadata/src/testing.ts`:
- `RecordedImport` gains `readonly entry: DownloadEntry;` (doc: "The entry that was placed; `file` is the whole download.").
- `TestHarness` gains `answerList` and `answerImports` per the Interfaces block; keep `answerImport(outcome)` implemented as `answerImports([outcome])`.
- Replace the `library` object:

```ts
  let nextList: readonly DownloadEntry[] | ImportRefusal | null = null;
  const scriptedImports: (ImportOutcome | undefined)[] = [];

  const library: LibraryImporter = {
    async list(file): Promise<readonly DownloadEntry[] | ImportRefusal> {
      const scripted = nextList;
      nextList = null;
      // By default a download is one plain file, listed as itself -- what
      // every test written before listing existed was describing.
      return scripted ?? [{ path: file.path, relativePath: baseName(file.path), sizeBytes: file.sizeBytes }];
    },
    async place(file, entry, resolveTokens): Promise<ImportOutcome> {
      const values = await resolveTokens();
      imports.push({ file, entry, values });
      return scriptedImports.shift() ?? { placed: file.mediaItemId === null ? 'unmatched' : 'library' };
    },
  };
```

- Add a private `baseName(path)` in `testing.ts` (split on `/` and `\`, last segment — same body as `tokens.ts`'s private `baseName`; do not export either).
- In the returned object: `answerList(result) { nextList = result; }`, `answerImports(outcomes) { scriptedImports.push(...outcomes); }`, `answerImport(outcome) { scriptedImports.push(outcome); }`.
- Update `imports`' doc: the values are resolved over the entry.

- [ ] **Step 6: Interim engine — list, then place every entry**

Replace the body of `onDownloadedFile` in `packages/openmetadata/src/engine.ts` with:

```ts
    async onDownloadedFile(file, ctx) {
      const listing = await ctx.library.list(file);
      if ('refusal' in listing) refuseDownload(ctx, spec.id, file, listing.refusal, listing.errno);

      let copied = 0;
      let placed: ImportPlacement['placed'] | null = null;
      for (const entry of listing) {
        // Tokens resolve over the entry, not the download, so `{filename}`
        // and `{ext}` describe the file being copied rather than its folder.
        const entryFile: DownloadedFile = { ...file, path: entry.path, sizeBytes: entry.sizeBytes };
        // eslint-disable-next-line no-await-in-loop -- one copy at a time, stopping at the first refusal, so a retry resumes in order
        const outcome = await ctx.library.place(file, entry, async () => resolveTokens(spec.tokens, entryFile, ctx));
        if ('refusal' in outcome) refuseDownload(ctx, spec.id, file, outcome.refusal, outcome.errno);
        copied += 1;
        placed = outcome.placed;
      }

      ctx.log('a download finished', {
        rssItemId: file.rssItemId,
        mediaItemId: file.mediaItemId,
        listed: listing.length,
        copied,
        placed,
      });
    },
```

and add, at module scope in `engine.ts`, moving the existing long comments about "the ids and the verdict, never `file.path`" and "thrown, having been returned as a value" onto it:

```ts
/**
 * Logs a refused download by ids and code and throws, so `deliverCompleted`
 * leaves the row `completed` for the next tick. `never`, so a caller's
 * narrowing continues past it.
 */
function refuseDownload(
  ctx: PluginContext,
  pluginId: string,
  file: DownloadedFile,
  refusal: string,
  errno: string | null,
): never {
  ctx.log('could not put a finished download in the library', {
    rssItemId: file.rssItemId,
    mediaItemId: file.mediaItemId,
    refusal,
    errno,
  });
  throw new Error(`${pluginId}: this download was not imported (${refusal})`);
}
```

Import `ImportPlacement` as a type from `@pickarr/contract`.

- [ ] **Step 7: Update the engine tests for the interim shape**

In `packages/openmetadata/test/engine-jobs.test.ts`:
- `'a finished download is handed to the host…'`: additionally `assert.deepEqual(harness.imports[0]?.entry, { path: downloaded().path, relativePath: 'a.mp4', sizeBytes: 10 });`
- The two "the line it logs…" tests: expected detail becomes `{ rssItemId: 7, mediaItemId: 42, listed: 1, copied: 1, placed: 'library' }` and `{ rssItemId: 7, mediaItemId: null, listed: 1, copied: 1, placed: 'unmatched' }`.
- Add:

```ts
test('a listing refusal is logged with its errno and thrown, and nothing is placed', async () => {
  const { plugin, harness } = build();
  harness.answerList({ refusal: 'list-failed', errno: 'EACCES' });

  await assert.rejects(() => plugin.onDownloadedFile(downloaded(), harness.ctx), /list-failed/);
  assert.equal(harness.imports.length, 0);
  assert.deepEqual(harness.logs[0]?.detail, { rssItemId: 7, mediaItemId: 42, refusal: 'list-failed', errno: 'EACCES' });
  assert.ok(!serialisedLogs(harness).includes(PATH_MARKER));
});

test('each entry resolves its tokens over its own path, not the download directory', async () => {
  const { plugin, harness } = build();
  const dir = `/downloads/${PATH_MARKER}`;
  harness.answerList([{ path: `${dir}/Show.S01E01.mkv`, relativePath: 'Show.S01E01.mkv', sizeBytes: 5 }]);

  await plugin.onDownloadedFile(downloaded({ path: dir, sizeBytes: 4096 }), harness.ctx);

  assert.equal(harness.imports[0]?.file.path, dir, 'place is handed the whole download');
  assert.equal(harness.imports[0]?.entry.relativePath, 'Show.S01E01.mkv');
});
```

- [ ] **Step 8: Host test double**

In `packages/host/test/double/plugin.ts`, replace the body of `onDownloadedFile` (keep its leading comment, changing "the same two steps the engine takes" to "the same steps the engine takes: list, then place each entry"):

```ts
    async onDownloadedFile(file, ctx) {
      const refuse = (refusal: string, errno: string | null): never => {
        // The ids and the verdict, never a path -- importer design spec §7,
        // and the same line the engine logs.
        ctx.log('could not put a finished download in the library', {
          rssItemId: file.rssItemId, mediaItemId: file.mediaItemId, refusal, errno,
        });
        throw new Error(`${DOUBLE_ID}: this download was not imported (${refusal})`);
      };

      const listing = await ctx.library.list(file);
      if ('refusal' in listing) refuse(listing.refusal, listing.errno);

      let copied = 0;
      let placed: 'library' | 'unmatched' | null = null;
      for (const entry of listing) {
        const entryFile = { ...file, path: entry.path, sizeBytes: entry.sizeBytes };
        // eslint-disable-next-line no-await-in-loop -- one copy at a time, as the engine does
        const outcome = await ctx.library.place(file, entry, async () => {
          const entries = Object.entries(TOKENS);
          const values = await Promise.all(entries.map(async ([, resolve]) => resolve(entryFile, ctx)));
          return Object.fromEntries(entries.map(([name], index) => [name, values[index] ?? null]));
        });
        if ('refusal' in outcome) refuse(outcome.refusal, outcome.errno);
        copied += 1;
        placed = outcome.placed;
      }
      ctx.log('a download finished', {
        rssItemId: file.rssItemId, mediaItemId: file.mediaItemId, listed: listing.length, copied, placed,
      });
    },
```

- [ ] **Step 9: Run everything touched**

Run: `node --import tsx --conditions development --test packages/host/test/media/import.test.ts packages/openmetadata/test/*.test.ts packages/host/test/plugins/flow.test.ts packages/host/test/clients/deliver.test.ts`
Expected: PASS. Then `npm run typecheck` — expect it to find every other `place(file, resolveTokens)` call site; fix each to the new signature (there should be none outside the files above; `packages/e2e/src/harness-2.ts` has an empty `onDownloadedFile` and needs no change).

- [ ] **Step 10: Lint, typecheck, full server tests, commit**

```bash
npm run lint && npm run typecheck && npm run test:server
git add packages/contract packages/host packages/openmetadata
git commit -m "List a finished download, and place one entry of it at a time"
```

---

### Task 4: The engine chooses, and resumes; plugins say what they expect

**Files:**
- Modify: `packages/openmetadata/src/engine.ts` (`LookupPluginSpec`, `onDownloadedFile`)
- Create: `packages/plugin-tv/src/expects.ts`
- Modify: `packages/plugin-tv/src/index.ts`, `packages/plugin-movie/src/index.ts`, `packages/plugin-xxx/src/index.ts`
- Test: `packages/openmetadata/test/engine-jobs.test.ts`, `packages/plugin-tv/test/expects.test.ts` (create), `packages/plugin-movie/test/apply.test.ts`, `packages/plugin-xxx/test/apply.test.ts`, `packages/host/test/plugins/flow.test.ts`

**Interfaces:**
- Consumes: `select`, `Expectation` (Task 1); `isPlaced`, `recordPlacement`, `placementTableMigration` (Task 2); `list`/`place(file, entry, …)` and harness `answerList`/`answerImports` (Task 3).
- Produces:
  ```ts
  // LookupPluginSpec
  expects(file: DownloadedFile, ctx: PluginContext): Promise<Expectation>;
  // plugin-tv
  export const expectsTv: (file: DownloadedFile, ctx: PluginContext) => Promise<Expectation>;
  ```

- [ ] **Step 1: Write the failing engine tests**

In `packages/openmetadata/test/engine-jobs.test.ts`, change `build` to take an expectation and migrate the placement table:

```ts
function build(service?: { fetch: HostFetch }, expectation: Expectation = { kind: 'single' }) {
  // ...
    migrations: [placementTableMigration('xxx', 2)],
    expects: async () => expectation,
  // ...
}
```

(Import `placementTableMigration` from `../src/placement.ts` and `Expectation` from `../src/select.ts`. Every other `createLookupPlugin({...})` literal in this file and in `engine-branch.test.ts` / `engine-resolved.test.ts` gains `expects: async () => ({ kind: 'single' })` — typecheck will list them.)

Update the success-log expectations from Task 3 to the final shape `{ rssItemId, mediaItemId, listed: 1, chosen: 1, copied: 1, alreadyPlaced: 0, placed: 'library' }` (and the `null`/`'unmatched'` variant). Then add:

```ts
const DIR = `/downloads/${PATH_MARKER}`;
function listing(...relativePaths: string[]): DownloadEntry[] {
  return relativePaths.map((relativePath) => ({ path: `${DIR}/${relativePath}`, relativePath, sizeBytes: 1 }));
}

test('single: the one video file is placed and the sidecar is not', async () => {
  const { plugin, harness } = build();
  harness.answerList(listing('film.iso', 'film.mds.mds'));

  await plugin.onDownloadedFile(downloaded({ path: DIR }), harness.ctx);

  assert.deepEqual(harness.imports.map((recorded) => recorded.entry.relativePath), ['film.iso']);
});

test('a selection refusal is logged and thrown, and nothing is placed', async () => {
  const { plugin, harness } = build();
  harness.answerList(listing('a.mkv', 'b.mkv'));

  await assert.rejects(() => plugin.onDownloadedFile(downloaded({ path: DIR }), harness.ctx), /too-many-video-files/);
  assert.equal(harness.imports.length, 0);
  assert.deepEqual(harness.logs[0]?.detail, {
    rssItemId: 7, mediaItemId: 42, refusal: 'too-many-video-files', errno: null,
  });
  assert.ok(!serialisedLogs(harness).includes(PATH_MARKER));
  assert.ok(!serialisedLogs(harness).includes('a.mkv'), 'a relative path reached the log');
});

test('episodes: the plugin\'s season is what the pack is checked against', async () => {
  const { plugin, harness } = build(undefined, { kind: 'episodes', season: 1 });
  harness.answerList(listing('Show.S01E01.mkv', 'Show.S02E01.mkv'));

  await assert.rejects(() => plugin.onDownloadedFile(downloaded({ path: DIR }), harness.ctx), /too-many-video-files/);
});

test('unmatched: every entry is placed, and expects is not asked', async () => {
  let asked = 0;
  const plugin = createLookupPlugin({
    id: 'xxx', mediaType: 'xxx', category: 'xxx', migrations: [placementTableMigration('xxx', 2)],
    check: (): void => {}, apply: async () => {}, tokens: NAMED_TOKENS,
    expects: async () => { asked += 1; return { kind: 'single' }; },
  }, { now: () => NOW, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'test-key' });
  const harness = createTestHarness();
  for (const migration of plugin.migrations) migration.up(harness.raw);
  harness.answerList(listing('a.mkv', 'b.nfo', 'Sample/s.mkv'));

  await plugin.onDownloadedFile(downloaded({ path: DIR, mediaItemId: null }), harness.ctx);

  assert.equal(asked, 0, 'an unmatched release has no media item to ask about');
  assert.deepEqual(harness.imports.map((recorded) => recorded.entry.relativePath), ['a.mkv', 'b.nfo', 'Sample/s.mkv']);
});

test('a pack that failed part way resumes on the next tick without meeting its own copies', async () => {
  const { plugin, harness } = build(undefined, { kind: 'episodes', season: 1 });
  const pack = listing('S.S01E01.mkv', 'S.S01E02.mkv', 'S.S01E03.mkv');
  harness.answerList(pack);
  harness.answerImports([undefined, { refusal: 'copy-failed', errno: 'ENOSPC' }]);

  await assert.rejects(() => plugin.onDownloadedFile(downloaded({ path: DIR }), harness.ctx), /copy-failed/);
  assert.deepEqual(harness.imports.map((recorded) => recorded.entry.relativePath), ['S.S01E01.mkv', 'S.S01E02.mkv']);

  harness.answerList(pack);
  await plugin.onDownloadedFile(downloaded({ path: DIR }), harness.ctx);

  // E01 was recorded and is not asked for again; E02 failed and is retried.
  assert.deepEqual(
    harness.imports.slice(2).map((recorded) => recorded.entry.relativePath),
    ['S.S01E02.mkv', 'S.S01E03.mkv'],
  );
  assert.deepEqual(harness.logs.at(-1)?.detail, {
    rssItemId: 7, mediaItemId: 42, listed: 3, chosen: 3, copied: 2, alreadyPlaced: 1, placed: 'library',
  });
});

test('an unrecorded entry that answers destination-exists is still refused', async () => {
  const { plugin, harness } = build();
  harness.answerImport({ refusal: 'destination-exists', errno: null });

  await assert.rejects(() => plugin.onDownloadedFile(downloaded(), harness.ctx), /destination-exists/);
  const rows = harness.raw.prepare('SELECT COUNT(*) AS n FROM xxx_placement').get()?.['n'];
  assert.equal(rows, 0, 'a refused entry was recorded as placed');
});

test('a download whose every entry was already placed copies nothing and says so', async () => {
  const { plugin, harness } = build();
  await plugin.onDownloadedFile(downloaded(), harness.ctx);
  await plugin.onDownloadedFile(downloaded(), harness.ctx);

  assert.equal(harness.imports.length, 1);
  assert.deepEqual(harness.logs.at(-1)?.detail, {
    rssItemId: 7, mediaItemId: 42, listed: 1, chosen: 1, copied: 0, alreadyPlaced: 1, placed: null,
  });
});
```

(Import `DownloadEntry` as a type from `@pickarr/contract`.)

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/engine-jobs.test.ts`
Expected: FAIL — sidecar placed, no refusal for two videos, no resume.

- [ ] **Step 3: Implement the engine**

In `LookupPluginSpec` add, with a doc modelled on `check`'s ("**Required, not optional**…"):

```ts
  /**
   * What a finished download of this matched media item should hold
   * (design spec 2026-09-22 §6): one video file, or a pack of episodes.
   * Asked only for a matched release -- an unmatched one is copied whole.
   * A throw leaves the row `completed` for the next tick, like a resolver's.
   */
  expects(file: DownloadedFile, ctx: PluginContext): Promise<Expectation>;
```

Replace `onDownloadedFile` with:

```ts
    async onDownloadedFile(file, ctx) {
      const { raw } = ownTables(ctx);
      const listing = await ctx.library.list(file);
      if ('refusal' in listing) refuseDownload(ctx, spec.id, file, listing.refusal, listing.errno);

      // Spec §4.3: nothing matched, so there is nothing to ask the plugin
      // and nothing to judge the download against -- it is copied whole.
      const expectation = file.mediaItemId === null ? 'unmatched' : await spec.expects(file, ctx);
      const selection = select(listing, expectation);
      if ('refusal' in selection) refuseDownload(ctx, spec.id, file, selection.refusal, null);

      let copied = 0;
      let alreadyPlaced = 0;
      let placed: ImportPlacement['placed'] | null = null;
      for (const entry of selection.chosen) {
        // Spec §7: a retry skips what an earlier attempt placed, so a pack
        // that stopped at ENOSPC resumes instead of refusing its own copies.
        if (isPlaced(raw, spec.id, file.rssItemId, entry.relativePath)) {
          alreadyPlaced += 1;
          continue;
        }
        const entryFile: DownloadedFile = { ...file, path: entry.path, sizeBytes: entry.sizeBytes };
        // eslint-disable-next-line no-await-in-loop -- one copy at a time, stopping at the first refusal, so a retry resumes in order
        const outcome = await ctx.library.place(file, entry, async () => resolveTokens(spec.tokens, entryFile, ctx));
        if ('refusal' in outcome) refuseDownload(ctx, spec.id, file, outcome.refusal, outcome.errno);
        recordPlacement(raw, spec.id, file.rssItemId, entry.relativePath, deps.now());
        copied += 1;
        placed = outcome.placed;
      }

      ctx.log('a download finished', {
        rssItemId: file.rssItemId,
        mediaItemId: file.mediaItemId,
        listed: listing.length,
        chosen: selection.chosen.length,
        copied,
        alreadyPlaced,
        placed,
      });
    },
```

Imports in `engine.ts`: `select` and `type Expectation` from `./select.ts`; `isPlaced`, `recordPlacement` from `./placement.ts`. Add `Expectation` to the `LookupPluginSpec` re-export line in `index.ts` if not already exported by Task 1 (it is).

- [ ] **Step 4: Run engine tests**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/*.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing plugin tests**

Create `packages/plugin-tv/test/expects.test.ts`, seeding through `applyTv` exactly as `tokens.test.ts` does (copy its `parent`, `seeded` helpers; build `Media` of each kind):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DownloadedFile, PluginContext } from '@pickarr/contract';
import type { Media, MediaKind, MediaParent } from '@pickarr/openmetadata';
import { createTestHarness } from '@pickarr/openmetadata/testing';
import { applyTv } from '../src/apply.ts';
import { expectsTv } from '../src/expects.ts';
import { TV_MIGRATIONS } from '../src/migrations.ts';

const NOW = 1_700_000_000_000;

function parent(kind: MediaKind, providerRef: string, title: string): MediaParent {
  return { id: `id-${providerRef}`, kind, title, releaseDate: '2024-06-26', year: 2024, provider: 'tmdb', providerRef };
}

const SERIES = parent('series', 'tmdb:series:100', 'The Bear');
const SEASON = parent('season', 'tmdb:season:10', 'Season 3');

function media(kind: 'episode' | 'season' | 'series', details: Record<string, number>): Media {
  const self = kind === 'series' ? SERIES : kind === 'season' ? SEASON : parent('episode', 'tmdb:episode:1', 'Tomorrow');
  const parents = kind === 'series' ? [] : kind === 'season' ? [SERIES] : [SEASON, SERIES];
  return { ...self, overview: null, details, parents, people: [] };
}
```

Then write `seeded(media)` by copying `tokens.test.ts`'s `seeded` verbatim (read that file for its body: it creates the harness, runs `TV_MIGRATIONS`, creates a media item through `harness.ctx.media.createMediaItem`, and calls `applyTv`). Returns `{ ctx, mediaItemId }` — adjust the copy to return the id it created. Then:

```ts
function file(mediaItemId: number): DownloadedFile {
  return { path: '/downloads/pack', sizeBytes: 4096, downloadClientId: 1, rssItemId: 7, mediaItemId };
}

test('an episode expects a single file', async () => {
  const { ctx, mediaItemId } = await seeded(media('episode', { seasonNumber: 3, episodeNumber: 1 }));
  assert.deepEqual(await expectsTv(file(mediaItemId), ctx), { kind: 'single' });
});

test('a season pack expects episodes of its own season number', async () => {
  const { ctx, mediaItemId } = await seeded(media('season', { seasonNumber: 3 }));
  assert.deepEqual(await expectsTv(file(mediaItemId), ctx), { kind: 'episodes', season: 3 });
});

test('a season pack whose number is unknown expects episodes of any season', async () => {
  const { ctx, mediaItemId } = await seeded(media('season', {}));
  assert.deepEqual(await expectsTv(file(mediaItemId), ctx), { kind: 'episodes', season: null });
});

test('a series pack expects episodes of any season', async () => {
  const { ctx, mediaItemId } = await seeded(media('series', {}));
  assert.deepEqual(await expectsTv(file(mediaItemId), ctx), { kind: 'episodes', season: null });
});

test('a media item with no tv_release row throws, so the row is retried rather than guessed at', async () => {
  const harness = createTestHarness();
  for (const migration of TV_MIGRATIONS) migration.up(harness.raw);
  await assert.rejects(() => expectsTv(file(999), harness.ctx), /no tv_release/);
});
```

(If `applyTv` reads the season number from a key other than `seasonNumber` — see `SEASON_NUMBER_KEY` in `apply.ts` — use that key. Check how `applyTv` treats a `season`-kind `Media`'s own number: it is `upsertSeason`'s input; read `apply.ts:135-230` before writing fixtures.)

In `packages/plugin-movie/test/apply.test.ts` and `packages/plugin-xxx/test/apply.test.ts` add:

```ts
test('a film expects a single file', async () => {
  const plugin = createMoviePlugin({ now: () => 1, baseUrl: 'https://openmetadata.test', resolveSecret: async () => 'k' });
  // `expects` is not on MediaPlugin; exercise it through a download instead.
  const harness = createTestHarness();
  for (const migration of plugin.migrations) migration.up(harness.raw);
  harness.answerList([
    { path: '/d/r/a.mkv', relativePath: 'a.mkv', sizeBytes: 1 },
    { path: '/d/r/b.mkv', relativePath: 'b.mkv', sizeBytes: 1 },
  ]);
  await assert.rejects(
    () => plugin.onDownloadedFile({ path: '/d/r', sizeBytes: 1, downloadClientId: 1, rssItemId: 7, mediaItemId: 1 }, harness.ctx),
    /too-many-video-files/,
  );
});
```

(xxx: `createXxxPlugin`, "a scene expects a single file". Import the factory from `../src/index.ts`.)

- [ ] **Step 6: Implement the plugins**

Create `packages/plugin-tv/src/expects.ts`:

```ts
/**
 * What a finished television download should hold (design spec 2026-09-22
 * §6): one file for an episode, a pack of episodes for a season or a series.
 *
 * A season pack carries its own season number so `select` can refuse a file
 * from another season; a series pack, and a season whose number the service
 * never gave, carry `null` and accept any.
 */
import { DatabaseSync } from 'node:sqlite';
import type { DownloadedFile, PluginContext } from '@pickarr/contract';
import type { Expectation } from '@pickarr/openmetadata';

function connection(ctx: PluginContext): DatabaseSync {
  if (!(ctx.db instanceof DatabaseSync)) throw new TypeError('plugin-tv: ctx.db is not a node:sqlite DatabaseSync');
  return ctx.db;
}

export async function expectsTv(file: DownloadedFile, ctx: PluginContext): Promise<Expectation> {
  if (file.mediaItemId === null) throw new Error('plugin-tv: expects asked about an unmatched release');
  const row = connection(ctx).prepare(`
    SELECT r.kind AS kind, n.season_number AS season
      FROM tv_release r LEFT JOIN tv_season n ON n.id = r.season_id
     WHERE r.media_item_id = ?
  `).get(file.mediaItemId);
  // Thrown, not defaulted: a matched tv media item with no release row is a
  // broken invariant, and guessing `single` would refuse a real pack forever.
  if (row === undefined) throw new Error(`plugin-tv: no tv_release for media item ${file.mediaItemId}`);
  const kind = row['kind'];
  const season = row['season'];
  if (kind === 'episode') return { kind: 'single' };
  if (kind === 'series') return { kind: 'episodes', season: null };
  if (kind === 'season') return { kind: 'episodes', season: typeof season === 'number' ? season : null };
  throw new Error(`plugin-tv: tv_release.kind is ${String(kind)}`);
}
```

`packages/plugin-tv/src/index.ts`: import `expectsTv`, pass `expects: expectsTv` in the spec, and `export { expectsTv } from './expects.ts';`.

`packages/plugin-movie/src/index.ts` and `packages/plugin-xxx/src/index.ts`: add `expects: async () => ({ kind: 'single' }),` with a one-line comment ("A film is one file; spec 2026-09-22 §4.1." / "A scene is one file; …").

- [ ] **Step 7: Flow test through the real host**

In `packages/host/test/plugins/flow.test.ts`, add after the spec 8.2 test (reusing `fixture`, `identifiedEpisode`, `destinationFor`):

```ts
test('spec 2026-09-22 §4.1: an episode delivered as a directory places its one video and nothing else', async () => {
  const result = fixture();
  const { raw, host } = result;
  const { rssItemId, mediaItemId } = await identifiedEpisode(result);

  const dir = await mkdtemp(join(tmpdir(), 'pickarr-flow-import-'));
  try {
    const root = join(dir, 'tv');
    await mkdir(root);
    const download = join(dir, 'downloads', 'The.Bear.S03E01.1080p-GRP');
    await mkdir(join(download, 'Sample'), { recursive: true });
    await writeFile(join(download, 'The.Bear.S03E01.1080p-GRP.mkv'), 'the episode');
    await writeFile(join(download, 'The.Bear.S03E01.1080p-GRP.nfo'), 'info');
    await writeFile(join(download, 'Sample', 'sample.mkv'), 'sample');
    destinationFor(raw, 'tv', root, '{series}/Season {season}/{series} - S{season}E{episode}.{ext}');

    await host.deliverToPlugin('tv', { path: download, sizeBytes: 4096, downloadClientId: 1, rssItemId, mediaItemId });

    assert.equal(
      await readFile(join(root, 'The Bear', 'Season 03', 'The Bear - S03E01.mkv'), 'utf8'),
      'the episode',
    );
    const placed = raw.prepare('SELECT relative_path AS p FROM tv_placement').all().map((row) => row['p']);
    assert.deepEqual(placed, ['The.Bear.S03E01.1080p-GRP.mkv']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 8: Run to verify it passes**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/*.test.ts packages/plugin-*/test/*.test.ts packages/host/test/plugins/flow.test.ts`
Expected: PASS.

- [ ] **Step 9: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add packages/openmetadata packages/plugin-tv packages/plugin-movie packages/plugin-xxx packages/host/test/plugins/flow.test.ts
git commit -m "Place only the files a plugin expects, and resume a pack that stopped part way"
```

---

### Task 5: Whole-tree verification

**Files:** none new; fix whatever the gates find.

- [ ] **Step 1: Run every gate from the worktree root**

```bash
npm run lint
npm run typecheck
npm run test-hygiene
npm test
npm run build
```
Expected: all succeed. Record the output of each in the task report.

- [ ] **Step 2: Grep for leaks and stale docs**

```bash
grep -rn "basename(file.path)" packages/host/src packages/openmetadata/src
grep -rn "place(file, async\|place(file, resolveTokens" packages --include='*.ts' | grep -v node_modules
grep -rn "<unmatched>/<filename>\|<root>/<unmatched>/<filename>" packages --include='*.ts' | grep -v node_modules
```
Expected: no hits except `releaseName`/`isForeign` in `import.ts`. Update any doc comment still describing `<root>/<unmatched>/<filename>` or a single-file `place` (e.g. `contract/src/library.ts` `ImportPlacement` doc, `host/src/clients/deliver.ts` module doc's "measures the file").

- [ ] **Step 3: Commit any fixes**

```bash
git add -A packages
git commit -m "Bring comments in line with listing and per-entry placement"
```
(Skip if nothing changed.)
