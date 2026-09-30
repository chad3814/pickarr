# Video Resolution, Stored (#98) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store each release's video resolution from the lookup service's own parse, show it on the release line, make it available as `{resolution}` in library path shapes, and rename the misnamed lookup-state column.

**Architecture:** One host migration renames `rss_item.resolution`/`resolution_detail` to `lookup_state`/`lookup_state_detail`, adds `video_resolution`, backfills unmatched rows from their stored lookup answer, and forces every client to re-bootstrap. The lookup engine writes the value on every answer through a new `MediaWriter.setVideoResolution`. A per-plugin migration marks already-resolved releases and enqueues a backfill job that asks the service again and stores only the resolution. One contract helper, `normalizeVideoResolution`, is the single definition of an accepted value.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `node:sqlite` with Drizzle, `node:test`, React plus `@testing-library/react` under jsdom, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-09-30-video-resolution-design.md`

## Global Constraints

- Worktree: `/Users/chad/Projects/pickarr/worktrees/release-line-polish`, branch `release-line-polish`. Never edit `worktrees/main`, and never push.
- Accepted value: `^[0-9]{3,4}[pi]$` after lowercasing; anything else is `null`.
- Host migration **24**. Plugin backfill migration **version 4** in each of `tv`, `movie`, `xxx`.
- New names: column `lookup_state`, `lookup_state_detail`, `video_resolution`; wire `lookupState`, `lookupStateDetail`, `videoResolution`; contract type `LookupState`; methods `setLookupState`, `setVideoResolution`; openmetadata wire type `EnvelopeState`.
- Backfill job kind `video-resolution-backfill`, batch size 100 (`MAX_BATCH`), `max_attempts` 5, marker column `video_resolution_backfill`.
- No `any`. No casts where a narrowing works. Prefer async APIs. Never log a row's contents or a credential.
- `CLAUDE.md`'s testing hazards apply: `afterEach(cleanup)` in web tests, never hand a live DOM node to `node:assert`, never `t.mock.timers` in web tests.
- The gate is `npm run check` (lint, typecheck, test hygiene, both test suites). Every task ends green.
- Match the surrounding comment style. Pickarr docblocks explain *why*. A comment that claims something must be true of the code beside it.

## Review Focus

1. **A replica row that predates the field.** If a client's reset fails or an old tab is open, the new bundle can read an `rss_item` with no `videoResolution` key. The line must show `unknown`, not `undefined`, and must not crash. Test in Task 6.
2. **A release deleted after it was marked.** The backfill's join can never return it. It must be cleared rather than re-enqueuing the job for ever. Test in Task 4.
3. **A value in the wrong case or shape** (`1080P`, `4K`, `1080`, `1080p/`, a number). Store `1080p` for the first and `null` for the rest, and never let a `/` into a path. Test in Task 2.
4. **The service down or rate-limiting for the whole backfill.** The job throws, marks stay intact, and nothing is half-written. Test in Task 4.
5. **A fresh answer that disagrees with the one that identified the release.** The backfill must write only the resolution and must not relink, re-apply or change the lookup state. Test in Task 4.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/contract/src/videoResolution.ts` (new) | `normalizeVideoResolution`, the one definition of an accepted value | 2 |
| `packages/contract/src/media.ts`, `sync.ts`, `index.ts` | renamed type, fields and methods; new `videoResolution`; `setVideoResolution` | 1, 2 |
| `packages/host/src/db/migrate.ts` | migration 24 | 1, 2 |
| `packages/host/src/db/host-state.ts` | `forgetSyncGeneration` | 1 |
| `packages/host/src/db/schema.ts`, `sync/tables.ts`, `api/reads.ts`, `feeds/reader.ts`, `media/writer.ts` | column renames; projection and read of `video_resolution`; the writer method | 1, 2 |
| `packages/openmetadata/src/types.ts`, `validate.ts`, `index.ts` | `EnvelopeState` | 1 |
| `packages/openmetadata/src/quality.ts` (new) | `videoResolutionOf(envelope)` | 3 |
| `packages/openmetadata/src/engine.ts` | `applyEnvelope` writes the value; registers the backfill job | 3, 4 |
| `packages/openmetadata/src/backfill.ts` (new) | `videoResolutionBackfillMigration`, `createVideoResolutionBackfillJob`, `VIDEO_RESOLUTION_BACKFILL_JOB` | 4 |
| `packages/openmetadata/src/testing.ts` | recording writer renamed and extended; harness stubs gain `lookup_state`, `video_resolution`, `jobs` | 1, 2, 4 |
| `packages/plugin-{tv,movie,xxx}/src/migrations.ts` | list the backfill migration at version 4 | 4 |
| `packages/openmetadata/src/tokens.ts`, `packages/plugin-*/src/tokens.ts`, `packages/contract/src/tokens.ts` | `resolveResolution`; `resolution` back on all three lists | 5 |
| `packages/plugin-ui/src/ReleaseList.tsx`; delete `videoResolution.ts` and its test | display the stored value | 6 |
| `packages/web/src/library/Unmatched.tsx` | read the renamed fields | 1 |
| `packages/e2e/src/harness-2.ts` | seed the renamed columns | 1 |

---

### Task 1: Rename the lookup state everywhere (migration 24, part 1)

A column rename breaks every reader at once, so this task is atomic: the migration, the contract, every source file and every test move together, and the suite is green only at the end.

**Files:**
- Modify: `packages/host/src/db/migrate.ts` (new `migration24`, list entry)
- Modify: `packages/host/src/db/host-state.ts` (new `forgetSyncGeneration`)
- Modify: `packages/contract/src/media.ts:10`, `:200-205`, `:241-242`; `packages/contract/src/sync.ts:236-245`; `packages/contract/src/index.ts:30`
- Modify: `packages/host/src/db/schema.ts:153-154`, `packages/host/src/feeds/reader.ts:77-78`, `packages/host/src/sync/tables.ts:379-380`, `packages/host/src/api/reads.ts:296`, `:634-635`, `packages/host/src/media/writer.ts:8`, `:403-414`
- Modify: `packages/openmetadata/src/types.ts:13`, `:72`, `validate.ts:16`, `:65-68`, `index.ts:7`, `engine.ts` (four `setResolution` calls), `testing.ts:29`, `:215`, `:231`, `:301-304`
- Modify: `packages/web/src/library/Unmatched.tsx:259-262`, `:339-340`, `:589-599`
- Modify: `packages/e2e/src/harness-2.ts:533-555`, `:883-991`
- Test: `packages/host/test/db/migrate.test.ts`, and every test the typecheck names

**Interfaces:**
- Produces:
  - `type LookupState = 'pending' | 'resolved' | 'refused' | 'unresolved'`
  - `MediaWriter.setLookupState(rssItemId: number, state: LookupState, detail: string | null, lookupJson: string | null): Promise<void>`
  - `RssItemSyncRead.lookupState: string`, `RssItemSyncRead.lookupStateDetail: string | null`; the same two on `RssItemRead`
  - `forgetSyncGeneration(raw: DatabaseSync): void`
  - openmetadata `type EnvelopeState = 'resolved' | 'unresolved' | 'pending'`
  - `RecordingMedia.lookupStates: ReadonlyMap<number, { state: LookupState; detail: string | null; lookupJson: string | null }>`

- [ ] **Step 1: Write the failing migration test**

Append to `packages/host/test/db/migrate.test.ts`. It needs `readHostState`, `writeHostState` and `SYNC_GENERATION_KEY` from `../../src/db/host-state.ts`; add that import.

```ts
test('migration 24 renames the lookup state columns in place, so rss_item keeps replicating', () => {
  // A rename, not a rebuild: `docs/database-migrations.md` measures RENAME
  // COLUMN as keeping all three triggers with their bodies rewritten, and a
  // rebuild as silently dropping them. Asserted by writing through the
  // triggers, because a trigger that survived with a body still naming
  // `resolution` would fail on the first UPDATE, not at migration time.
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 23));
  raw.exec(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('tv', 'f', 'http://f', 1, 1);
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution, resolution_detail)
      VALUES (1, 'a.mkv', 'http://a', 1, 1, 'torrent', 'unresolved', 'not recognised');
  `);
  migrateHost(raw);

  const columns = raw.prepare("SELECT name FROM pragma_table_info('rss_item')").all()
    .map((row) => String((row as { name: unknown }).name));
  assert.ok(columns.includes('lookup_state') && columns.includes('lookup_state_detail'), 'renamed');
  assert.ok(!columns.includes('resolution') && !columns.includes('resolution_detail'), 'and the old names are gone');

  const row = raw.prepare('SELECT lookup_state, lookup_state_detail FROM rss_item WHERE id = 1').get();
  assert.deepEqual({ ...row }, { lookup_state: 'unresolved', lookup_state_detail: 'not recognised' }, 'values carried across');

  const before = Number((raw.prepare('SELECT count(*) AS n FROM sync_log').get() as { n: unknown }).n);
  raw.exec("UPDATE rss_item SET lookup_state = 'resolved' WHERE id = 1");
  const after = Number((raw.prepare('SELECT count(*) AS n FROM sync_log').get() as { n: unknown }).n);
  assert.equal(after, before + 1, 'an update after the rename still logs');
  raw.close();
});

test('migration 24 forgets the sync generation, so every client re-bootstraps into the new shape', () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 23));
  writeHostState(raw, SYNC_GENERATION_KEY, 'before-the-rename', 1);
  migrateHost(raw);
  assert.equal(readHostState(raw, SYNC_GENERATION_KEY), null, 'the next ensureSyncGeneration mints a new one');
  raw.close();
});
```

Check the `rss_feed` insert against the schema at version 23 before running. If `plugin_id` is no longer a column there, copy the `INSERT INTO rss_feed` used by the migration 22 test instead.

- [ ] **Step 2: Run the test and watch it fail**

Run: `node --import tsx --conditions development --test packages/host/test/db/migrate.test.ts 2>&1 | grep -E "^not ok|✖" | head`
Expected: both new tests FAIL (`lookup_state` missing; the generation is still `'before-the-rename'`).

- [ ] **Step 3: Add `forgetSyncGeneration`**

In `packages/host/src/db/host-state.ts`, directly after `ensureSyncGeneration`:

```ts
/**
 * Deletes this database's sync generation, so the next
 * `ensureSyncGeneration` mints a fresh one and every client discards its
 * replica and bootstraps again.
 *
 * **A delete rather than a new value**, because absence is already what a
 * rebuilt database looks like -- see `ensureSyncGeneration`. A migration
 * that changes the shape of a synced row calls this so no client keeps a
 * row in the old shape.
 *
 * **Migration 24 calls this**, so it is part of that migration's contract
 * (`docs/database-migrations.md`): it must go on meaning "the next boot
 * mints a new generation".
 */
export function forgetSyncGeneration(raw: DatabaseSync): void {
  raw.prepare('DELETE FROM host_state WHERE key = ?').run(SYNC_GENERATION_KEY);
}
```

- [ ] **Step 4: Add migration 24**

In `packages/host/src/db/migrate.ts`, import `forgetSyncGeneration` from `./host-state.ts`, and add after `migration20`'s docblock and function:

```ts
/**
 * Issue #98: `rss_item.resolution` was never a video resolution. It is the
 * lookup state, `@pickarr/contract`'s `LookupState`, and its name had the
 * browse list and the importer both reading it as one.
 *
 * **Renamed in place.** `RENAME COLUMN` keeps all three sync triggers and
 * rewrites their bodies (`docs/database-migrations.md`'s table), so
 * `rss_item` goes on replicating with nothing reinstalled.
 *
 * **Then the sync generation is forgotten.** Every client's replica holds
 * `rss_item` rows keyed `resolution`; a new generation is what makes a client
 * discard its replica and bootstrap again (`web/src/store/sync.ts`), so no
 * client code has to read both names. That costs one full re-bootstrap per
 * client, once.
 */
function migration24(db: DatabaseSync): void {
  db.exec(`
ALTER TABLE rss_item RENAME COLUMN resolution TO lookup_state;
ALTER TABLE rss_item RENAME COLUMN resolution_detail TO lookup_state_detail;
`);
  forgetSyncGeneration(db);
}
```

Append `{ version: 24, up: (db) => migration24(db) },` to `HOST_MIGRATIONS`.

- [ ] **Step 5: Rename the contract**

`packages/contract/src/media.ts`:
- line 10: `export type LookupState = 'pending' | 'resolved' | 'refused' | 'unresolved';` Keep the docblock above it and add one sentence: "Called `Resolution`, and stored in a column named `resolution`, until issue #98: it is a lookup's outcome, never a video resolution."
- `setResolution(rssItemId, resolution: Resolution, …)` becomes `setLookupState(rssItemId: number, state: LookupState, detail: string | null, lookupJson: string | null): Promise<void>`. The docblock is unchanged apart from the name.
- `RssItemRead`: `resolution: string` → `lookupState: string`, `resolutionDetail` → `lookupStateDetail`.

`packages/contract/src/sync.ts`, `RssItemSyncRead`: the same two renames. Rewrite the docblock above `lookupState` to open "What became of this release's identification -- `./media.ts`'s `LookupState`."

`packages/contract/src/index.ts:30`: export `LookupState` in place of `Resolution`.

- [ ] **Step 6: Rename the host sources**

- `db/schema.ts:153-154`: `lookupState: text('lookup_state').notNull(), lookupStateDetail: text('lookup_state_detail'),`
- `feeds/reader.ts:77-78`: the column list names `lookup_state`. The literal stays `'pending'`.
- `sync/tables.ts:379-380`: `lookup_state AS lookupState, lookup_state_detail AS lookupStateDetail,`
- `api/reads.ts:296`: `lookup_state, lookup_state_detail` in `RSS_ITEM_COLUMNS`. `:634-635`:
  ```ts
      lookupState: asText((row as { lookup_state: unknown }).lookup_state),
      lookupStateDetail: asTextOrNull((row as { lookup_state_detail: unknown }).lookup_state_detail),
  ```
- `media/writer.ts`: import `LookupState` in place of `Resolution`, and:
  ```ts
    async setLookupState(
      rssItemId: number,
      state: LookupState,
      detail: string | null,
      lookupJson: string | null,
    ): Promise<void> {
      const at = now();
      // `lookup_json` is written on every call, including with `null`,
      // which is what clears an answer left by an earlier failure.
      raw.prepare('UPDATE rss_item SET lookup_state = ?, lookup_state_detail = ?, lookup_json = ?, updated_at = ? WHERE id = ?')
        .run(state, detail, lookupJson, at, rssItemId);
    },
  ```

- [ ] **Step 7: Rename in openmetadata**

- `types.ts:13`: `export type EnvelopeState = 'resolved' | 'unresolved' | 'pending';` Add a docblock line: "Named `LookupState` until #98 gave that name to the contract's four-value outcome; this is the envelope's own three-value `state`." `:72`: `readonly state: EnvelopeState;`
- `validate.ts:16` and `:65-68`: `EnvelopeState`. `index.ts:7`: export `EnvelopeState`.
- `engine.ts`: each `ctx.media.setResolution(` becomes `ctx.media.setLookupState(`. The comment at `:218` that names `setResolution`'s fourth argument names `setLookupState`'s.
- `testing.ts`: import `LookupState` in place of `Resolution`. `resolutions` becomes `lookupStates`, typed `ReadonlyMap<number, { state: LookupState; detail: string | null; lookupJson: string | null }>` in both the interface and the local `Map`. The recording method:
  ```ts
    async setLookupState(rssItemId, state, detail, lookupJson): Promise<void> {
      record('setLookupState', rssItemId, state, detail, lookupJson);
      lookupStates.set(rssItemId, { state, detail, lookupJson });
    },
  ```
  The returned object carries `lookupStates` instead of `resolutions`.

- [ ] **Step 8: Rename in web and e2e**

`packages/web/src/library/Unmatched.tsx`:
- `:260`/`:262`: `readonly lookupState: string | undefined;`, `readonly lookupStateDetail: string | undefined;`
- `:339-340`: `lookupState: textOf(value, 'lookupState'), lookupStateDetail: textOf(value, 'lookupStateDetail'),`
- `:595-599`: `row.lookupState`, `row.lookupStateDetail`.
- The `<dt>` label beside them reads `Lookup state`, and the comment at `:589` says what the field is now.
- Rewrite the docblock at `:495-503` so it says the field is the lookup state, and drop its sentence that `ReleaseList` shows a video resolution under the old name.

`packages/e2e/src/harness-2.ts`: in both seeding functions the parameter becomes `lookupState: string` (`:547`, `:555`). The SQL column lists name `lookup_state, lookup_state_detail` (`:926`, `:989`). Update the docblock at `:533`. Then update every caller in `packages/e2e/tests/*.spec.ts`:
`grep -rn "resolution:" packages/e2e/tests` and rename each key to `lookupState:`.

- [ ] **Step 9: Move the tests**

Rename, then let the typecheck find the rest:

```bash
cd /Users/chad/Projects/pickarr/worktrees/release-line-polish
git grep -lE "setResolution|resolutionDetail|resolution_detail|media\.resolutions" -- 'packages/*/test' \
  | xargs perl -pi -e 's/setResolution/setLookupState/g; s/resolutionDetail/lookupStateDetail/g; s/resolution_detail/lookup_state_detail/g; s/media\.resolutions/media.lookupStates/g'
npm run typecheck 2>&1 | grep -E "error TS" | head -60
```

Fix each reported site by hand. None of these can be done blindly, because the word `resolution` also appears in unrelated tests (`theme.test.tsx`, `shape.test.ts`):
- An `RssItemSyncRead`/`RssItemRead` fixture key `resolution:` becomes `lookupState:`. If its value was a video resolution (`'1080p'`, `'2160p'`, `'720p'`), make it `'resolved'`.
- A recorded read `?.resolution` on `lookupStates` becomes `?.state`.
- SQL in a host test that names the `resolution` column names `lookup_state`.

Then:

```bash
git grep -nE "\bresolution\b" -- 'packages/*/src' 'packages/*/test' | grep -vE "^\S+:\s*(\*|//)"
```

Expected: every remaining hit is prose about an unrelated resolution (the theme, token shapes, client IP), or `ReleaseList`'s filename parser, which Task 6 removes. Anything else is a missed rename.

- [ ] **Step 10: Run the gate**

Run: `npm run check > /tmp/pickarr-check.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)|error TS|^✖" /tmp/pickarr-check.log | head -20`
Expected: exit 0, `fail 0` in both suites.

- [ ] **Step 11: Commit**

```bash
git add -A packages && git commit -m "Rename rss_item.resolution to lookup_state (#98)

It was never a video resolution: it is the lookup's outcome, and the name had the
browse list and the importer both reading it as one. Renamed in place so the sync
triggers survive, and the sync generation is forgotten so every client
re-bootstraps rather than holding rows under two names."
```

---

### Task 2: Store a video resolution (migration 24, part 2, and the writer)

Migration 24 has not been applied anywhere outside this branch, so extending it here is allowed. It is frozen from the first time it is merged.

**Files:**
- Create: `packages/contract/src/videoResolution.ts`, `packages/contract/test/videoResolutionCases.ts`
- Test: `packages/contract/test/videoResolution.test.ts`
- Modify: `packages/contract/src/index.ts`, `media.ts` (`MediaWriter`, `RssItemRead`), `sync.ts` (`RssItemSyncRead`)
- Modify: `packages/host/src/db/migrate.ts` (`migration24`), `db/schema.ts`, `sync/tables.ts:379-381`, `api/reads.ts:296`, `:634`, `media/writer.ts`
- Modify: `packages/openmetadata/src/testing.ts` (recording writer)
- Test: `packages/host/test/db/migrate.test.ts`, `packages/host/test/media/writer.test.ts`, `packages/host/test/sync/tables.test.ts`

**Interfaces:**
- Consumes: Task 1's names.
- Produces:
  - `normalizeVideoResolution(value: unknown): string | null`, exported from `@pickarr/contract`
  - `MediaWriter.setVideoResolution(rssItemId: number, value: string | null): Promise<void>`
  - `RssItemSyncRead.videoResolution: string | null`, `RssItemRead.videoResolution: string | null`
  - `RecordingMedia.videoResolutions: ReadonlyMap<number, string | null>`

- [ ] **Step 1: Write the failing helper test**

The case table lives in its own module, `packages/contract/test/videoResolutionCases.ts`, not in a `.test.ts` file. The host migration test imports it too, and importing a `.test.ts` module from another test file would register its tests a second time.

```ts
/**
 * Every case the accepted-value rule has to decide, shared by
 * `normalizeVideoResolution`'s test and the host migration's SQL
 * restatement of it (`host/test/db/migrate.test.ts`), so the two cannot
 * disagree without one of them failing.
 */
export const VIDEO_RESOLUTION_CASES: readonly (readonly [unknown, string | null])[] = [
  ['480p', '480p'],
  ['720p', '720p'],
  ['1080p', '1080p'],
  ['1080i', '1080i'],
  ['2160p', '2160p'],
  ['4320p', '4320p'],
  ['1080P', '1080p'],
  ['1080', null],
  ['p', null],
  ['10800p', null],
  ['80p', null],
  ['4K', null],
  ['UHD', null],
  ['1080p/', null],
  [' 1080p', null],
  ['', null],
  [1080, null],
  [null, null],
  [undefined, null],
];
```

`packages/contract/test/videoResolution.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoResolution } from '../src/videoResolution.ts';
import { VIDEO_RESOLUTION_CASES } from './videoResolutionCases.ts';

test('the accepted values, lowercased, and null for everything else', () => {
  for (const [input, expected] of VIDEO_RESOLUTION_CASES) {
    assert.equal(normalizeVideoResolution(input), expected, `input ${JSON.stringify(input) ?? 'undefined'}`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/contract/test/videoResolution.test.ts`
Expected: FAIL, cannot find module `../src/videoResolution.ts`.

- [ ] **Step 3: Write the helper**

`packages/contract/src/videoResolution.ts`:

```ts
/**
 * The one definition of a video resolution Pickarr will store.
 *
 * **Here, in the contract, because two packages must agree on it and
 * neither may depend on the other**: the host's `MediaWriter` refuses
 * anything else, and `@pickarr/openmetadata` narrows the lookup service's
 * `parsed.quality.resolution` through it. The host migration that backfills
 * the column restates it in SQL, because a migration is frozen once applied
 * and must not call a helper that could change; `host/test/db/migrate.test.ts`
 * runs that SQL over the same cases this module's test does.
 *
 * **Why so strict.** The value is interpolated into library paths as
 * `{resolution}`, and it arrives as text from a third party whose `parsed`
 * object the OpenAPI document gives no shape at all. A scan height and a scan
 * letter is everything the token needs and nothing a path can be hurt by.
 */
const VIDEO_RESOLUTION = /^[0-9]{3,4}[pi]$/;

/** `value` lowercased if it is a scan height and a scan letter (`1080p`, `720i`), otherwise `null`. */
export function normalizeVideoResolution(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  return VIDEO_RESOLUTION.test(lowered) ? lowered : null;
}
```

Export it from `packages/contract/src/index.ts` beside the other value exports:
`export { normalizeVideoResolution } from './videoResolution.ts';`

- [ ] **Step 4: Run the helper test**

Run: `node --import tsx --conditions development --test packages/contract/test/videoResolution.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing migration, writer and projection tests**

Append to `packages/host/test/db/migrate.test.ts`, importing `VIDEO_RESOLUTION_CASES` from `../../../contract/test/videoResolutionCases.ts`.

```ts
test("migration 24 backfills an unmatched release's video resolution from its stored answer, by the contract's rule", () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 23));
  raw.exec("INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('tv', 'f', 'http://f', 1, 1)");
  const insert = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, resolution, lookup_json)
    VALUES (1, ?, ?, 1, 1, 'torrent', 'unresolved', ?)
  `);
  const expected = new Map<number, string | null>();
  for (const [index, [input, want]] of VIDEO_RESOLUTION_CASES.entries()) {
    const quality = input === undefined ? {} : { resolution: input };
    const id = Number(insert.run(`case-${index}.mkv`, `http://${index}`, JSON.stringify({ parsed: { quality } })).lastInsertRowid);
    expected.set(id, want);
  }
  const noAnswer = Number(insert.run('no-answer.mkv', 'http://n', null).lastInsertRowid);
  const tooLarge = Number(insert.run('too-large.mkv', 'http://t', '{"pickarr":"lookup-answer-too-large"}').lastInsertRowid);
  const malformed = Number(insert.run('malformed.mkv', 'http://m', 'not json').lastInsertRowid);
  migrateHost(raw);

  const read = raw.prepare('SELECT video_resolution FROM rss_item WHERE id = ?');
  const valueOf = (id: number): unknown => (read.get(id) as { video_resolution: unknown }).video_resolution;
  for (const [id, want] of expected) assert.equal(valueOf(id), want, `row ${id}`);
  assert.equal(valueOf(noAnswer), null, 'nothing stored, nothing backfilled');
  assert.equal(valueOf(tooLarge), null, 'the too-large marker has no parse');
  assert.equal(valueOf(malformed), null, 'malformed JSON is not an error, and is not a value');
  raw.close();
});
```

Append to `packages/host/test/media/writer.test.ts`, which already has `insertFeed`, `insertRssItem` and `unusedArtwork`. Task 1 moved its `insertRssItem` and `readRssItem` to `lookup_state`.

```ts
function storedVideoResolution(raw: DatabaseSync, id: number): unknown {
  const row = raw.prepare('SELECT video_resolution FROM rss_item WHERE id = ?').get(id);
  return row === undefined ? undefined : row['video_resolution'];
}

test('setVideoResolution stores a normalized value or null, and moves updated_at', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const itemId = insertRssItem(raw, insertFeed(raw, 'https://example.test/feed'), 500);
  const writer = createMediaWriter(db, () => 999, unusedArtwork);

  await writer.setVideoResolution(itemId, '2160p');
  assert.equal(storedVideoResolution(raw, itemId), '2160p');
  assert.equal(readRssItem(raw, itemId)?.updated_at, 999, 'a write the sync log sees');

  await writer.setVideoResolution(itemId, null);
  assert.equal(storedVideoResolution(raw, itemId), null, 'null clears it');
});

test('setVideoResolution refuses a value the contract would not normalize to itself', async () => {
  // The writer is shared by every plugin and closes over no plugin id, so it
  // is the one place a caller that skipped `normalizeVideoResolution` is caught.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const itemId = insertRssItem(raw, insertFeed(raw, 'https://example.test/feed'), 500);
  const writer = createMediaWriter(db, () => 999, unusedArtwork);
  for (const bad of ['1080P', '4K', '1080p/', '']) {
    await assert.rejects(writer.setVideoResolution(itemId, bad), /video resolution/, `refused ${bad}`);
  }
  assert.equal(storedVideoResolution(raw, itemId), null, 'and nothing was written');
});
```

In `packages/host/test/sync/tables.test.ts`, find the assertion that lists `rss_item`'s projected keys (search for `lookupStateDetail`) and add `'videoResolution'` in the position the projection will emit it (after `lookupStateDetail`).

- [ ] **Step 6: Run them and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/db/migrate.test.ts packages/host/test/media/writer.test.ts packages/host/test/sync/tables.test.ts 2>&1 | grep -E "^not ok|✖|error" | head`
Expected: FAIL (no `video_resolution` column; no `setVideoResolution`; key missing).

- [ ] **Step 7: Extend migration 24**

Replace `migration24`'s `db.exec` block with the one below. Add a paragraph to its docblock: "**And `video_resolution` is added**, backfilled only for unmatched releases, because they are the only ones still holding a lookup answer (`relinkRssItem` clears it on a match). The `WHERE` restates `@pickarr/contract`'s `normalizeVideoResolution` in SQL -- `lower`, then three or four digits and `p` or `i`. It is restated rather than called because this migration is frozen once applied; the migration test runs it over the contract's own cases."

```ts
  db.exec(`
ALTER TABLE rss_item RENAME COLUMN resolution TO lookup_state;
ALTER TABLE rss_item RENAME COLUMN resolution_detail TO lookup_state_detail;
ALTER TABLE rss_item ADD COLUMN video_resolution TEXT;
UPDATE rss_item
   SET video_resolution = lower(json_extract(lookup_json, '$.parsed.quality.resolution'))
 WHERE json_valid(lookup_json)
   AND json_type(lookup_json, '$.parsed.quality.resolution') = 'text'
   AND (lower(json_extract(lookup_json, '$.parsed.quality.resolution')) GLOB '[0-9][0-9][0-9][pi]'
     OR lower(json_extract(lookup_json, '$.parsed.quality.resolution')) GLOB '[0-9][0-9][0-9][0-9][pi]');
`);
```

`json_valid(NULL)` is NULL, so a row with no answer is excluded. `json_type(...) = 'text'` excludes the number `1080`, JSON `null` and a missing path.

- [ ] **Step 8: Add the column to the contract, schema, projection and read**

- `contract/src/sync.ts`, `RssItemSyncRead`, after `lookupStateDetail`:
  ```ts
  /**
   * The lookup service's parse of this release's video resolution --
   * `normalizeVideoResolution`'s output, so `1080p`, `2160p`, or `null` when
   * the name stated none or no answer has arrived. Written by the lookup
   * engine on every answer (issue #98).
   */
  videoResolution: string | null;
  ```
- `contract/src/media.ts`, `RssItemRead`: `videoResolution: string | null;` with a one-line doc pointing at `RssItemSyncRead.videoResolution`.
- `contract/src/media.ts`, `MediaWriter`, after `setLookupState`:
  ```ts
  /**
   * Records a release's video resolution, or clears it with `null`.
   *
   * Throws for any value `normalizeVideoResolution` would not return
   * unchanged. This writer is shared by every plugin (see this interface's
   * docblock), so it is the one place a caller that skipped the
   * normalization is caught before the value can reach a library path.
   */
  setVideoResolution(rssItemId: number, value: string | null): Promise<void>;
  ```
- `host/src/db/schema.ts`, after `lookupStateDetail`: `videoResolution: text('video_resolution'),`
- `host/src/sync/tables.ts:380`: add `video_resolution AS videoResolution,` after `lookup_state_detail AS lookupStateDetail,`.
- `host/src/api/reads.ts:296`: add `video_resolution` to `RSS_ITEM_COLUMNS`. In `toRssItemRead`:
  `videoResolution: asTextOrNull((row as { video_resolution: unknown }).video_resolution),`
- `host/src/media/writer.ts`, import `normalizeVideoResolution` from `@pickarr/contract`, and after `setLookupState`:
  ```ts
    async setVideoResolution(rssItemId: number, value: string | null): Promise<void> {
      if (value !== null && normalizeVideoResolution(value) !== value) {
        throw new TypeError('media writer: not a video resolution Pickarr stores');
      }
      raw.prepare('UPDATE rss_item SET video_resolution = ?, updated_at = ? WHERE id = ?')
        .run(value, now(), rssItemId);
    },
  ```
  The message names no value, because it is a string from a third party.
- `openmetadata/src/testing.ts`, in `RecordingMedia`: `readonly videoResolutions: ReadonlyMap<number, string | null>;`. Add a local `const videoResolutions = new Map<number, string | null>();`, return it, and add the recording method:
  ```ts
    async setVideoResolution(rssItemId, value): Promise<void> {
      record('setVideoResolution', rssItemId, value);
      videoResolutions.set(rssItemId, value);
    },
  ```

- [ ] **Step 9: Fix the fixtures the typecheck names**

Run: `npm run typecheck 2>&1 | grep "error TS" | head -40`
Every `RssItemSyncRead`/`RssItemRead` fixture gains `videoResolution: null`. Every other `MediaWriter` implementation the typecheck names (host test doubles) gains a `setVideoResolution` that records or no-ops, matching its neighbours.

- [ ] **Step 10: Run the gate**

Run: `npm run check > /tmp/pickarr-check.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)|error TS|^✖" /tmp/pickarr-check.log | head`
Expected: exit 0, `fail 0`.

- [ ] **Step 11: Commit**

```bash
git add -A packages && git commit -m "Store a release's video resolution, backfilled for unmatched releases (#98)"
```

---

### Task 3: The lookup engine writes the resolution on every answer

**Files:**
- Create: `packages/openmetadata/src/quality.ts`
- Test: `packages/openmetadata/test/quality.test.ts`
- Modify: `packages/openmetadata/src/engine.ts:299-303` (`applyEnvelope`'s first statement)
- Modify: `packages/openmetadata/src/testing.ts` (`BASE` is unchanged; add `withResolution`)
- Test: `packages/openmetadata/test/engine-branch.test.ts`

**Interfaces:**
- Consumes: `normalizeVideoResolution` (Task 2), `MediaWriter.setVideoResolution` (Task 2), `RecordingMedia.videoResolutions` (Task 2).
- Produces:
  - `videoResolutionOf(envelope: LookupEnvelope): string | null` from `packages/openmetadata/src/quality.ts`, exported from the package index
  - `withResolution(envelope: LookupEnvelope, resolution: unknown): LookupEnvelope` in `testing.ts`

- [ ] **Step 1: Write the failing tests**

`packages/openmetadata/test/quality.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoResolutionOf } from '../src/quality.ts';
import { resolvedEnvelope, refusedEnvelope } from '../src/testing.ts';
import type { LookupEnvelope } from '../src/types.ts';

function withParsed(parsed: LookupEnvelope['parsed']): LookupEnvelope {
  return { ...refusedEnvelope({ lookupId: 'l', refusal: 'x' }), refusal: null, parsed };
}

test("reads parsed.quality.resolution, the shape the live service sends", () => {
  // Shape measured against openmetadata.nexus on 2026-09-30 (spec, "What the
  // service actually sends"); not in the OpenAPI document.
  assert.equal(videoResolutionOf(withParsed({ quality: { resolution: '2160p', source: 'WEB' } })), '2160p');
  assert.equal(videoResolutionOf(withParsed({ quality: { resolution: '1080P' } })), '1080p', 'normalized');
});

test('anything missing or malformed is null, never a throw', () => {
  assert.equal(videoResolutionOf(withParsed(null)), null, 'no parse');
  assert.equal(videoResolutionOf(withParsed({})), null, 'no quality');
  assert.equal(videoResolutionOf(withParsed({ quality: null })), null, 'quality null');
  assert.equal(videoResolutionOf(withParsed({ quality: 'high' })), null, 'quality not an object');
  assert.equal(videoResolutionOf(withParsed({ quality: { resolution: null, source: 'UHD' } })), null, "the service's own UHD answer");
  assert.equal(videoResolutionOf(withParsed({ quality: { resolution: 1080 } })), null, 'a number');
  assert.equal(videoResolutionOf(withParsed({ quality: { resolution: '../1080p' } })), null, 'a path');
  assert.equal(
    videoResolutionOf(resolvedEnvelope({ lookupId: 'l', media: { id: 'm', kind: 'movie', title: 't', releaseDate: null, year: null, provider: 'tmdb', providerRef: 'tmdb:movie:1', overview: null, details: {}, parents: [], people: [] } })),
    null,
    'the harness default carries no parse',
  );
});
```

Add to `packages/openmetadata/src/testing.ts`, after `pendingEnvelope`:

```ts
/** `envelope` with the parse the live service sends for a name stating `resolution` -- the shape `videoResolutionOf` reads. */
export function withResolution(envelope: LookupEnvelope, resolution: unknown): LookupEnvelope {
  return { ...envelope, parsed: { quality: { resolution } } };
}
```

Append to `packages/openmetadata/test/engine-branch.test.ts`, which has `fixture()` (a harness, `deps` and one `rssItemId` for `item.mkv`). Add `withResolution` and `type LookupEnvelope` to its imports:

```ts
test('every non-resolved outcome records the video resolution the answer parsed, before the branch decides anything', async () => {
  // One write at the top rather than one per branch, so no terminal branch
  // can forget it -- and a partial answer that already carries a parse
  // records it too. The resolved outcome is `engine-resolved.test.ts`'s.
  const cases: readonly [string, LookupEnvelope, string | null][] = [
    ['unresolved', withResolution(unresolvedEnvelope({ lookupId: 'b' }), '720p'), '720p'],
    ['refused', refusedEnvelope({ lookupId: 'c', refusal: 'a sidecar' }), null],
    ['partial', withResolution(partialEnvelope({ lookupId: 'd' }), '2160p'), '2160p'],
    ['pending', pendingEnvelope({ lookupId: 'e' }), null],
    ['malformed', withResolution(unresolvedEnvelope({ lookupId: 'f' }), '4K'), null],
  ];
  for (const [name, envelope, expected] of cases) {
    const { harness, deps, rssItemId } = fixture();
    // eslint-disable-next-line no-await-in-loop -- one fresh fixture per case, in order
    await applyEnvelope(envelope, { rssItemId, filename: 'item.mkv', polls: 0 }, deps);
    assert.ok(harness.media.videoResolutions.has(rssItemId), `${name}: written`);
    assert.equal(harness.media.videoResolutions.get(rssItemId), expected, `${name}: value`);
  }
});
```

Append to `packages/openmetadata/test/engine-resolved.test.ts`, which has `fixture()` (one `rssItemId` for `dune.mkv`) and `movieMedia()`. Add `withResolution` to its imports:

```ts
test('a resolved answer records its parsed video resolution too', async () => {
  const { harness, deps, rssItemId } = fixture();
  await applyEnvelope(
    withResolution(resolvedEnvelope({ lookupId: 'lookup-r', media: movieMedia() }), '2160p'),
    { rssItemId, filename: 'dune.mkv', polls: 0 },
    deps,
  );
  assert.equal(harness.media.videoResolutions.get(rssItemId), '2160p');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/quality.test.ts packages/openmetadata/test/engine-branch.test.ts packages/openmetadata/test/engine-resolved.test.ts 2>&1 | grep -E "^not ok|✖" | head`
Expected: FAIL (no `quality.ts`; nothing recorded in `videoResolutions`).

- [ ] **Step 3: Write `videoResolutionOf`**

`packages/openmetadata/src/quality.ts`:

```ts
/**
 * The video resolution a lookup answer parsed from the release name.
 *
 * **`parsed.quality.resolution`, a path the OpenAPI document does not
 * give.** `parsed` is typed there as an open object and carried through
 * `validate.ts` as one. The path was read off live answers
 * (`docs/superpowers/specs/2026-09-30-video-resolution-design.md`, "What the
 * service actually sends"), so every step of it is narrowed here and a miss
 * anywhere is `null`, never a throw: a lookup must not fail because the
 * parse changed shape.
 *
 * A refused answer's `parsed` is the stored refusal record rather than a
 * parse, per the document, so it has no `quality` and reads as `null`.
 */
import { normalizeVideoResolution } from '@pickarr/contract';
import type { LookupEnvelope } from './types.ts';

export function videoResolutionOf(envelope: LookupEnvelope): string | null {
  const quality = envelope.parsed?.['quality'];
  if (typeof quality !== 'object' || quality === null || !('resolution' in quality)) return null;
  return normalizeVideoResolution(quality.resolution);
}
```

Export it from `packages/openmetadata/src/index.ts`: `export { videoResolutionOf } from './quality.ts';`

- [ ] **Step 4: Call it from `applyEnvelope`**

In `packages/openmetadata/src/engine.ts`, import `videoResolutionOf` from `./quality.ts`. Directly after the `lookupId` update at the top of `applyEnvelope` (`:299-303`), add:

```ts
  // The video resolution the answer parsed (issue #98), recorded here for
  // the same reason `lookupId` is recorded above: before the branch below
  // decides anything, so no outcome -- a refusal, a partial answer, the ten
  // minutes of polling that end `unresolved` -- can skip it. A later answer
  // for the same release overwrites it; the latest parse is the one kept.
  await ctx.media.setVideoResolution(target.rssItemId, videoResolutionOf(envelope));
```

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/*.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `fail 0`. If an existing test asserts the exact sequence of `media.calls`, it will now see `setVideoResolution` second. Update that expectation, and nothing else about it.

- [ ] **Step 6: Run the gate**

Run: `npm run check > /tmp/pickarr-check.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)|error TS" /tmp/pickarr-check.log`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A packages && git commit -m "Record the lookup service's parsed video resolution on every answer (#98)"
```

---

### Task 4: Backfill the releases resolved before this change

**Files:**
- Create: `packages/openmetadata/src/backfill.ts`
- Test: `packages/openmetadata/test/backfill.test.ts`
- Modify: `packages/openmetadata/src/engine.ts` (register the job in `createLookupPlugin`), `index.ts`
- Modify: `packages/openmetadata/src/testing.ts` (harness stubs)
- Modify: `packages/plugin-tv/src/migrations.ts:56`, `packages/plugin-movie/src/migrations.ts:32`, `packages/plugin-xxx/src/migrations.ts:43`
- Test: `packages/host/test/plugins/backfill.test.ts` (new: the coupling test against the real host schema)

**Interfaces:**
- Consumes: `videoResolutionOf` (Task 3), `setVideoResolution` (Task 2), `MAX_BATCH` and `createLookupClient` (existing, `client.ts`), `lookupTableName` (existing).
- Produces:
  - `VIDEO_RESOLUTION_BACKFILL_JOB = 'video-resolution-backfill'`
  - `videoResolutionBackfillMigration(pluginId: string, version: number): Migration`
  - `createVideoResolutionBackfillJob(deps: { pluginId: string; category: LookupCategory; batch: (ctx: PluginContext, signal: AbortSignal | undefined, names: readonly string[]) => Promise<readonly LookupEnvelope[]> }): JobHandler`

- [ ] **Step 1: Extend the harness stubs**

In `packages/openmetadata/src/testing.ts`'s `createTestHarness`, give the `rss_item` stub the two columns the backfill reads, and add a `jobs` stub with the host's columns. Update the docblock's list of stubs to name both.

```ts
  raw.exec("CREATE TABLE rss_item (id INTEGER PRIMARY KEY, feed_id INTEGER, filename TEXT NOT NULL, lookup_state TEXT NOT NULL DEFAULT 'pending', video_resolution TEXT)");
  // The host's `jobs` columns, for `videoResolutionBackfillMigration`, which
  // writes one row there directly. The real table is pinned against that
  // insert by `host/test/plugins/backfill.test.ts`, not by this stub.
  raw.exec(`CREATE TABLE jobs (
    id INTEGER PRIMARY KEY, plugin_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL, run_at INTEGER NOT NULL,
    state TEXT NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
```

- [ ] **Step 2: Write the failing tests**

`packages/openmetadata/test/backfill.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIDEO_RESOLUTION_BACKFILL_JOB,
  createVideoResolutionBackfillJob,
  videoResolutionBackfillMigration,
} from '../src/backfill.ts';
import { lookupTableMigration } from '../src/table.ts';
import { MAX_BATCH } from '../src/client.ts';
import { createTestHarness, unresolvedEnvelope, withResolution, type TestHarness } from '../src/testing.ts';
import type { LookupEnvelope } from '../src/types.ts';

const NOW = 1_700_000_000_000;

/** A harness at plugin version 1, with `rows` releases in the given lookup states, each with a lookup row. */
function seeded(rows: readonly string[]): { harness: TestHarness; ids: number[] } {
  const harness = createTestHarness();
  lookupTableMigration('movie').up(harness.raw);
  const ids = rows.map((state, index) => {
    const id = harness.insertRssItem(`release-${index}.mkv`);
    harness.raw.prepare('UPDATE rss_item SET lookup_state = ? WHERE id = ?').run(state, id);
    harness.raw.prepare('INSERT INTO movie_lookup (rss_item_id, created_at, updated_at) VALUES (?, ?, ?)').run(id, NOW, NOW);
    return id;
  });
  return { harness, ids };
}

function marked(harness: TestHarness): number[] {
  return harness.raw.prepare('SELECT rss_item_id FROM movie_lookup WHERE video_resolution_backfill = 1 ORDER BY rss_item_id')
    .all().map((row) => Number((row as { rss_item_id: unknown }).rss_item_id));
}

function queuedJobs(harness: TestHarness): { plugin_id: unknown; kind: unknown; state: unknown; max_attempts: unknown }[] {
  return harness.raw.prepare('SELECT plugin_id, kind, state, max_attempts FROM jobs').all()
    .map((row) => ({ ...(row as { plugin_id: unknown; kind: unknown; state: unknown; max_attempts: unknown }) }));
}

test('the migration marks resolved releases only, and queues one job for them', () => {
  const { harness, ids } = seeded(['resolved', 'unresolved', 'resolved', 'refused', 'pending']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  assert.deepEqual(marked(harness), [ids[0], ids[2]]);
  assert.deepEqual(queuedJobs(harness), [
    { plugin_id: 'movie', kind: VIDEO_RESOLUTION_BACKFILL_JOB, state: 'ready', max_attempts: 5 },
  ]);
});

test('the migration queues nothing when nothing is resolved -- a fresh install', () => {
  const { harness } = seeded(['pending', 'unresolved']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  assert.deepEqual(marked(harness), []);
  assert.deepEqual(queuedJobs(harness), [], 'no job for an empty backfill');
});

test('the migration carries the version the plugin gave it', () => {
  assert.equal(videoResolutionBackfillMigration('movie', 4).version, 4);
});

/** A backfill handler over a scripted batch, recording every request. */
function handler(answer: (names: readonly string[]) => readonly LookupEnvelope[]) {
  const requests: (readonly string[])[] = [];
  const run = createVideoResolutionBackfillJob({
    pluginId: 'movie',
    category: 'movies',
    batch: async (_ctx, _signal, names) => {
      requests.push(names);
      return answer(names);
    },
  });
  return { run, requests };
}

const answerEach = (resolution: unknown) => (names: readonly string[]) =>
  names.map((name) => withResolution(unresolvedEnvelope({ lookupId: name }), resolution));

test('the job stores only the resolution, clears each mark, and asks again for the rest', async () => {
  const { harness, ids } = seeded(Array.from({ length: MAX_BATCH + 3 }, () => 'resolved'));
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  const { run, requests } = handler(answerEach('1080p'));

  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);

  assert.equal(requests.length, 1, 'one batch request');
  assert.equal(requests[0]?.length, MAX_BATCH, 'of the service maximum');
  assert.equal(marked(harness).length, 3, 'the rest are still marked');
  assert.deepEqual(harness.enqueued.map((job) => job.kind), [VIDEO_RESOLUTION_BACKFILL_JOB], 'and asked for again');
  assert.equal(harness.media.videoResolutions.get(ids[0] ?? -1), '1080p');
  // Review Focus 5: a fresh answer must not re-identify the release.
  const written = new Set(harness.media.calls.map((call) => call.method));
  assert.deepEqual([...written], ['setVideoResolution'], 'nothing but the resolution is written');
});

test('the last batch does not re-enqueue', async () => {
  const { harness } = seeded(['resolved', 'resolved']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  const { run } = handler(answerEach('720p'));
  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);
  assert.deepEqual(marked(harness), []);
  assert.deepEqual(harness.enqueued, [], 'nothing left, nothing queued');
});

test('an answer with no usable resolution stores null and still clears the mark, so the job cannot loop', async () => {
  const { harness, ids } = seeded(['resolved']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  const { run } = handler(answerEach('4K'));
  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);
  assert.equal(harness.media.videoResolutions.get(ids[0] ?? -1), null);
  assert.deepEqual(marked(harness), []);
});

test('a marked release that was deleted is cleared and never asked about', async () => {
  // Review Focus 2: the join can never return it, so without this the
  // "marks remain" count would re-enqueue the job for ever.
  const { harness, ids } = seeded(['resolved', 'resolved']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  harness.raw.prepare('DELETE FROM rss_item WHERE id = ?').run(ids[1] ?? -1);
  const { run, requests } = handler(answerEach('1080p'));
  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);
  assert.deepEqual(requests, [['release-0.mkv']], 'only the release that exists is asked about');
  assert.deepEqual(marked(harness), [], 'the orphan is cleared too');
  assert.deepEqual(harness.enqueued, [], 'and nothing is re-enqueued for it');
});

test('a failing service throws with every mark intact', async () => {
  // Review Focus 4: the runner's retry and backoff take over; a dead-letter
  // row is how anyone learns the backfill stopped.
  const { harness, ids } = seeded(['resolved', 'resolved']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  const { run } = handler(() => { throw new Error('429'); });
  await assert.rejects(run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx));
  assert.deepEqual(marked(harness), ids);
  assert.equal(harness.media.videoResolutions.size, 0, 'nothing half-written');
});

test('with nothing marked, the job asks nothing', async () => {
  const { harness } = seeded(['pending']);
  videoResolutionBackfillMigration('movie', 4).up(harness.raw);
  const { run, requests } = handler(answerEach('1080p'));
  await run({ id: 1, kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {}, attempts: 1 }, harness.ctx);
  assert.deepEqual(requests, []);
});
```

`packages/host/test/plugins/backfill.test.ts`, the coupling test against the real schema. Copy the `createDispatcher` options and the `noopLog`/`noopSleep`/`realAbortSignal` helpers from `packages/host/test/jobs/dispatcher.test.ts`. The handler map resolves the backfill kind to a recorder:

```ts
test("the backfill migration's job row is one the real dispatcher runs", async () => {
  // `videoResolutionBackfillMigration` writes the host's `jobs` table with
  // raw SQL, because a plugin migration cannot reach `JobQueue`. This is what
  // stops a later change to `jobs` from silently turning that row into one
  // nothing ever runs.
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const plugin = shippedPlugins({ now: () => Date.now(), resolveSecret: async () => 'k', baseUrl: 'https://lookup.example.test' })
    .find((each) => each.id === 'movie');
  assert.ok(plugin !== undefined);
  migratePlugin(raw, 'movie', plugin.migrations.filter((m) => m.version < 4));
  raw.exec(`
    INSERT INTO rss_feed (plugin_id, name, url, created_at, updated_at) VALUES ('movie', 'f', 'http://f', 1, 1);
    INSERT INTO rss_item (feed_id, filename, link, created_at, updated_at, download_type, lookup_state)
      VALUES (1, 'Film.2023.1080p.mkv', 'http://a', 1, 1, 'torrent', 'resolved');
    INSERT INTO movie_lookup (rss_item_id, created_at, updated_at) VALUES (1, 1, 1);
  `);
  migratePlugin(raw, 'movie', plugin.migrations);

  const ran: string[] = [];
  const { timers } = createFakeTimers();
  const dispatcher = createDispatcher(raw, { now: () => Date.now(), timers, log: noopLog, sleep: noopSleep, abortSignal: realAbortSignal });
  dispatcher.start(
    (pluginId, kind) => (pluginId === 'movie' && kind === 'video-resolution-backfill'
      ? async () => { ran.push(kind); }
      : undefined),
    () => fakeCtx,
  );
  for (let tries = 0; ran.length === 0 && tries < 50; tries += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  dispatcher.stop();
  assert.deepEqual(ran, ['video-resolution-backfill']);
  raw.close();
});
```

Copy `fakeCtx` and `createFakeTimers` from `dispatcher.test.ts`. If `dispatcher.start` does not run a due job without a timer firing, fire `setTimeoutCalls[0].fn()` exactly as that file's tests do. Read one of its "runs a ready job" tests first and follow it.

- [ ] **Step 3: Run them and watch them fail**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/backfill.test.ts packages/host/test/plugins/backfill.test.ts 2>&1 | grep -E "^not ok|✖|Cannot find" | head`
Expected: FAIL, `../src/backfill.ts` not found.

- [ ] **Step 4: Write `backfill.ts`**

`packages/openmetadata/src/backfill.ts`:

```ts
/**
 * The one-off backfill of video resolutions for releases identified before
 * Pickarr recorded one (issue #98).
 *
 * **Why a second question to the service, and why only this answer is
 * kept.** A matched release's lookup answer is cleared when it is linked
 * (`MediaWriter.relinkRssItem`), so there is nothing stored to read a
 * resolution from. The service is asked again by filename -- a fresh batch,
 * cached on its side -- and only `setVideoResolution` is called with what
 * comes back. The media item, cast, artwork and lookup state are left alone,
 * so a fresh answer that disagrees with the one that identified the release
 * changes nothing but this one column.
 */
import { DatabaseSync } from 'node:sqlite';
import type { JobHandler, Migration, PluginContext } from '@pickarr/contract';
import { MAX_BATCH } from './client.ts';
import { videoResolutionOf } from './quality.ts';
import { lookupTableName } from './table.ts';
import type { LookupCategory, LookupEnvelope } from './types.ts';

export const VIDEO_RESOLUTION_BACKFILL_JOB = 'video-resolution-backfill';

/** The host's `DEFAULT_MAX_ATTEMPTS`, restated: a plugin migration cannot import the host. */
const MAX_ATTEMPTS = 5;

/**
 * Marks every release already identified, and queues one backfill job for
 * them. Listed by each plugin at the version it assigns -- 4 in all three
 * shipped plugins, after `placementTableMigration` at 3 -- so a collision is
 * visible in that plugin's own list.
 *
 * **It writes the host's `jobs` table with raw SQL**, because a migration is
 * handed the connection and not `JobQueue`. The columns it names are
 * `plugin_id`, `kind`, `payload_json`, `attempts`, `max_attempts`, `run_at`,
 * `state`, `last_error`, `created_at` and `updated_at`;
 * `host/test/plugins/backfill.test.ts` runs the row it writes through the
 * real dispatcher, so a change to that table fails there rather than
 * leaving a job nothing runs. Timestamps come from SQLite's own clock, in
 * milliseconds like every other job row, because a migration is given no
 * clock either.
 *
 * A fresh install has no identified release when this runs, so it marks
 * nothing and queues nothing.
 */
export function videoResolutionBackfillMigration(pluginId: string, version: number): Migration {
  const table = lookupTableName(pluginId);
  return {
    version,
    up: (db) => {
      db.exec(`
ALTER TABLE ${table} ADD COLUMN video_resolution_backfill INTEGER NOT NULL DEFAULT 0;
UPDATE ${table} SET video_resolution_backfill = 1
 WHERE rss_item_id IN (SELECT id FROM rss_item WHERE lookup_state = 'resolved');
`);
      const marked = db.prepare(`SELECT 1 AS found FROM ${table} WHERE video_resolution_backfill = 1 LIMIT 1`).get();
      if (marked === undefined) return;
      db.prepare(`
INSERT INTO jobs (plugin_id, kind, payload_json, attempts, max_attempts, run_at, state, last_error, created_at, updated_at)
VALUES (?, ?, '{}', 0, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER), 'ready', NULL,
        CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER))
`).run(pluginId, VIDEO_RESOLUTION_BACKFILL_JOB, MAX_ATTEMPTS);
    },
  };
}

export interface VideoResolutionBackfillDeps {
  readonly pluginId: string;
  readonly category: LookupCategory;
  /** One batch lookup by filename -- `createLookupPlugin` passes its own client's `batch`. */
  readonly batch: (ctx: PluginContext, signal: AbortSignal | undefined, names: readonly string[]) => Promise<readonly LookupEnvelope[]>;
}

/** `PluginContext.db` narrowed, the same check `engine.ts`'s `asDatabase` makes. */
function connection(ctx: PluginContext): DatabaseSync {
  if (!(ctx.db instanceof DatabaseSync)) {
    throw new TypeError('openmetadata: ctx.db is not a node:sqlite DatabaseSync');
  }
  return ctx.db;
}

/**
 * One batch of the backfill: up to `MAX_BATCH` marked releases, one request,
 * each answer's resolution stored and its mark cleared, then the same job
 * again if marks remain.
 *
 * **Orphans are cleared first.** A marked lookup row whose release was
 * deleted can never be returned by the join below, and counting it as
 * remaining would re-enqueue this job for ever.
 *
 * **A failure throws with every mark intact** -- nothing is written until
 * the whole batch has answered -- so the runner's retry and backoff apply,
 * and after the last attempt the dead-letter row is the record.
 */
export function createVideoResolutionBackfillJob(deps: VideoResolutionBackfillDeps): JobHandler {
  const table = lookupTableName(deps.pluginId);
  return async (_job, ctx, signal) => {
    const raw = connection(ctx);
    raw.prepare(`
UPDATE ${table} SET video_resolution_backfill = 0
 WHERE video_resolution_backfill = 1 AND rss_item_id NOT IN (SELECT id FROM rss_item)
`).run();
    const rows = raw.prepare(`
SELECT l.rss_item_id AS rssItemId, r.filename AS filename
  FROM ${table} l JOIN rss_item r ON r.id = l.rss_item_id
 WHERE l.video_resolution_backfill = 1
 ORDER BY l.id LIMIT ?
`).all(MAX_BATCH).map((row) => {
      const rssItemId = row['rssItemId'];
      const filename = row['filename'];
      if (typeof rssItemId !== 'number' || typeof filename !== 'string') {
        throw new TypeError('openmetadata: a backfill row is not an id and a filename');
      }
      return { rssItemId, filename };
    });
    if (rows.length === 0) return;

    const answers = await deps.batch(ctx, signal, rows.map((row) => row.filename));
    const clear = raw.prepare(`UPDATE ${table} SET video_resolution_backfill = 0 WHERE rss_item_id = ?`);
    for (const [index, row] of rows.entries()) {
      const answer = answers[index];
      if (answer === undefined) throw new Error(`openmetadata: no backfill answer for release ${row.rssItemId}`);
      // eslint-disable-next-line no-await-in-loop -- one small UPDATE each; ordered so a throw leaves every later mark in place
      await ctx.media.setVideoResolution(row.rssItemId, videoResolutionOf(answer));
      clear.run(row.rssItemId);
    }

    const remaining = raw.prepare(`
SELECT 1 AS found FROM ${table} l JOIN rss_item r ON r.id = l.rss_item_id
 WHERE l.video_resolution_backfill = 1 LIMIT 1
`).get();
    if (remaining !== undefined) {
      await ctx.jobs.enqueue({ kind: VIDEO_RESOLUTION_BACKFILL_JOB, payload: {} });
    }
  };
}
```

Export from `packages/openmetadata/src/index.ts`:

```ts
export {
  VIDEO_RESOLUTION_BACKFILL_JOB,
  createVideoResolutionBackfillJob,
  videoResolutionBackfillMigration,
} from './backfill.ts';
```

- [ ] **Step 5: Register the job in the engine, and list the migration in each plugin**

In `createLookupPlugin` (`engine.ts:678`), after `const artwork = …`:

```ts
  const backfill = createVideoResolutionBackfillJob({
    pluginId: spec.id,
    category: spec.category,
    batch: (ctx, signal, names) => logged(ctx, deps.baseUrl, () => clientFor(ctx, signal).batch(spec.category, names)),
  });
```

Add `[VIDEO_RESOLUTION_BACKFILL_JOB]: backfill` to the `jobs` object. Update the `jobs` docblock on `LookupPluginSpec` ("Job handlers beyond the engine's `lookup` and `poll`") to name artwork and the backfill as well.

In each plugin's `migrations.ts`, import `videoResolutionBackfillMigration` from `@pickarr/openmetadata` beside `placementTableMigration`, and append it:

```ts
}, placementTableMigration('tv', 3), videoResolutionBackfillMigration('tv', 4)];
```

Do the same with `'movie'` and `'xxx'`.

- [ ] **Step 6: Run the tests**

Run: `node --import tsx --conditions development --test packages/openmetadata/test/backfill.test.ts packages/host/test/plugins/backfill.test.ts packages/openmetadata/test/engine-jobs.test.ts 2>&1 | grep -E "^ℹ (pass|fail)|^not ok"`
Expected: `fail 0`. `engine-jobs.test.ts` may assert the exact job-kind set or the migration versions of a built plugin. Update those expectations to include the backfill, and nothing else.

- [ ] **Step 7: Run the gate**

Run: `npm run check > /tmp/pickarr-check.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)|error TS" /tmp/pickarr-check.log`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add -A packages && git commit -m "Backfill video resolutions for releases identified before they were recorded (#98)"
```

---

### Task 5: Restore the `{resolution}` path token

**Files:**
- Modify: `packages/openmetadata/src/tokens.ts` (new `resolveResolution`; rewrite the #98 paragraph at `:11-24`), `index.ts`
- Modify: `packages/contract/src/tokens.ts:57-68` (rewrite the section), `:93-127` (the three lists)
- Modify: `packages/contract/src/plugin.ts` (`MediaPlugin.tokens` docblock's parenthetical and counts)
- Modify: `packages/plugin-tv/src/tokens.ts`, `packages/plugin-movie/src/tokens.ts`, `packages/plugin-xxx/src/tokens.ts`
- Test: `packages/host/test/plugins/tokens.test.ts`, `packages/openmetadata/test/tokens.test.ts`

**Interfaces:**
- Consumes: `rss_item.video_resolution` (Task 2).
- Produces: `resolveResolution: TokenResolver`, exported from `@pickarr/openmetadata`. The token name `resolution` sits immediately before `filename` in all three lists.

- [ ] **Step 1: Write the failing tests**

In `packages/host/test/plugins/tokens.test.ts`, change the three list assertions to:

```ts
    'series', 'season', 'episode', 'title', 'releaseDate', 'resolution', 'filename', 'ext',
```
```ts
    'title', 'year', 'releaseDate', 'collection', 'resolution', 'filename', 'ext',
```
```ts
    'site', 'title', 'releaseDate', 'resolution', 'filename', 'ext',
```

Replace the test `'no plugin declares {resolution}, because nothing in 2.0 records one'` with:

```ts
test('every shipped plugin declares {resolution}, now that the lookup engine records one', () => {
  // Issue #98 removed it while `rss_item.resolution` was the lookup state,
  // which would have named an episode `… resolved.mkv`. The token now reads
  // `rss_item.video_resolution`, which every plugin's releases carry, so it
  // is declared by all three -- asserted here because no test inside one
  // plugin can see the other two.
  for (const plugin of shipped().values()) {
    assert.ok(tokenNames(plugin).includes('resolution'), `"${plugin.id}" does not declare "resolution"`);
  }
});
```

In `packages/openmetadata/test/tokens.test.ts`, beside the other shared resolvers' tests:

```ts
test('{resolution} is the release\'s stored video resolution, and null when there is none', async () => {
  const harness = createTestHarness();
  const known = harness.insertRssItem('Film.2023.1080p.mkv');
  const unknown = harness.insertRssItem('Film.2023.mkv');
  harness.raw.prepare("UPDATE rss_item SET video_resolution = '1080p' WHERE id = ?").run(known);
  assert.equal(await resolveResolution(downloaded({ rssItemId: known }), harness.ctx), '1080p');
  assert.equal(await resolveResolution(downloaded({ rssItemId: unknown }), harness.ctx), null);
  assert.equal(await resolveResolution(downloaded({ rssItemId: 9999 }), harness.ctx), null, 'a release that is gone is a hole, not a throw');
});
```

`downloaded` is that file's existing `DownloadedFile` builder. Add `resolveResolution` to its import from `../src/tokens.ts`, and `createTestHarness` from `../src/testing.ts` if it is not already imported.

- [ ] **Step 2: Run them and watch them fail**

Run: `node --import tsx --conditions development --test packages/host/test/plugins/tokens.test.ts packages/openmetadata/test/tokens.test.ts 2>&1 | grep -E "^not ok|✖" | head`
Expected: FAIL.

- [ ] **Step 3: Write the resolver**

In `packages/openmetadata/src/tokens.ts`, after `resolveReleaseDate`:

```ts
/**
 * `rss_item.video_resolution`: the lookup service's parse of the release's
 * video resolution (`1080p`), recorded by the engine on every answer and
 * already normalized to a scan height and letter, so it can hold no
 * separator. `null` -- a hole the shape drops -- for a name that stated none.
 *
 * Read by the release, not the media item: two releases of one film can be
 * two resolutions, and the file being placed came from exactly one of them.
 */
export const resolveResolution: TokenResolver = async (file, ctx) =>
  queryText(ctx, 'SELECT video_resolution FROM rss_item WHERE id = ?', file.rssItemId);
```

Rewrite the `**\`resolution\` is gone, and §3 is wrong about it**` paragraph at the top of the file as: "**`resolution` is back, and reads a real video resolution** (issue #98). §3 took it from `rss_item.resolution`, which was the lookup state; that column is now `lookup_state`, and the engine records the service's parse in `rss_item.video_resolution`, which is what `resolveResolution` reads." Export `resolveResolution` from `index.ts` in the tokens block.

In each plugin's `tokens.ts`, import `resolveResolution` and add `resolution: resolveResolution,` immediately before `filename:`.

In `packages/contract/src/tokens.ts`, add `'resolution'` immediately before `'filename'` in `TV_TOKEN_NAMES`, `MOVIE_TOKEN_NAMES` and `XXX_TOKEN_NAMES`. Replace the section `## \`resolution\` is not here, and design spec §3 is wrong about it` with:

```
 * ## `resolution` is the video resolution, not the lookup state
 *
 * §3 listed `resolution` among the tokens that "come from `rss_item`",
 * meaning `rss_item.resolution` -- which was the lookup state, and would have
 * named an episode `The Bear - S03E01 resolved.mkv`. Issue #98 renamed that
 * column `lookup_state` and added `video_resolution`, the lookup service's
 * own parse, normalized by `normalizeVideoResolution`. `{resolution}` reads
 * the latter, and is on every list because every release has one.
```

In `packages/contract/src/plugin.ts`'s `MediaPlugin.tokens` docblock, replace "Includes the four tokens every plugin shares -- … (`resolution` was a fifth until this branch removed it: … five for xxx.)" so it says five shared tokens (`title`, `releaseDate`, `resolution`, `filename`, `ext`), that `resolution` comes from `rss_item.video_resolution`, and that the counts are eight for television, seven for film and six for xxx. Add `'resolution'` to the shared-token loop in `tokens.test.ts`'s "every shipped plugin declares the tokens that come from the shared row and the source path" test.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --conditions development --test packages/host/test/plugins/tokens.test.ts packages/openmetadata/test/tokens.test.ts packages/host/test/media/destinations.test.ts 2>&1 | grep -E "^ℹ (pass|fail)|^not ok"`
Expected: `fail 0`. `destinations.test.ts` names `resolution` three times. If a test there asserts `{resolution}` is refused `unknown-token`, invert it to assert the shape saves, keeping the test's other cases.

- [ ] **Step 5: Run the gate and commit**

Run: `npm run check > /tmp/pickarr-check.log 2>&1; echo "exit $?"`
Expected: exit 0.

```bash
git add -A packages && git commit -m "Restore {resolution}, now reading the stored video resolution (#98)"
```

---

### Task 6: Show the stored resolution on the release line

**Files:**
- Modify: `packages/plugin-ui/src/ReleaseList.tsx` (import `:90`, the span `:261`, top docblock `:7-11`)
- Delete: `packages/plugin-ui/src/videoResolution.ts`, `packages/plugin-ui/test/videoResolution.test.ts`
- Test: `packages/plugin-ui/test/ReleaseList.test.tsx`

**Interfaces:**
- Consumes: `RssItemSyncRead.videoResolution` (Task 2).

- [ ] **Step 1: Rewrite the failing tests**

In `packages/plugin-ui/test/ReleaseList.test.tsx`, give the `rssItem` helper a `videoResolution` option, defaulting to `null`, and pass it through to the row. Replace the test `"a row shows the release's video resolution from its filename, and unknown when it has none"` with:

```ts
test("a row shows the release's stored video resolution, and unknown when it has none", () => {
  // The stored value, not a parse of the filename: this name says 2160p and
  // the row says 1080p, which is only possible if the component reads the
  // field.
  const releases: GatheredRelease[] = [
    { id: 1, row: rssItem({ id: 1, filename: 'the.thing.2160p.mkv', videoResolution: '1080p' }), downloads: [] },
    { id: 2, row: rssItem({ id: 2, filename: 'the.thing.1080p.mkv', videoResolution: null }), downloads: [] },
  ];
  render(<ReleaseList releases={releases} submit={accepts} />);

  const spans = (filename: string): string[] =>
    [...screen.getByRole('listitem', { name: filename }).querySelectorAll('span')].map((span) => span.textContent ?? '');
  assert.ok(spans('the.thing.2160p.mkv').includes('1080p'), 'the stored value');
  assert.ok(!spans('the.thing.2160p.mkv').includes('2160p'), 'not the filename');
  assert.ok(spans('the.thing.1080p.mkv').includes('unknown'), 'null reads as unknown');
});

test('a replica row from before the field existed reads as unknown, not undefined', () => {
  // Review Focus 1: a replica that missed the re-bootstrap holds rows with
  // no `videoResolution` key at all.
  const { videoResolution: _dropped, ...legacy } = rssItem({ id: 1, filename: 'old.row.mkv' });
  const release = { id: 1, row: legacy, downloads: [] } as unknown as GatheredRelease;
  render(<ReleaseList releases={[release]} submit={accepts} />);
  const text = screen.getByRole('listitem', { name: 'old.row.mkv' }).textContent ?? '';
  assert.ok(text.includes('unknown'));
  assert.ok(!text.includes('undefined'));
});
```

The second test's `as unknown as` is the one cast in this plan, and it is the point of the test: the type says the key exists, and the replica can say otherwise. Keep the comment.

Update `'a release with a download shows its filename, resolution and download status'`: give its row `videoResolution: '2160p'`, so `includes('2160p')` is proven by the field and not just by the filename.

- [ ] **Step 2: Run them and watch them fail**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/plugin-ui/test/ReleaseList.test.tsx 2>&1 | grep -E "^not ok|✖" | head`
Expected: the stored-value test FAILS, because the component still parses the filename.

- [ ] **Step 3: Read the field and delete the parser**

In `ReleaseList.tsx`, remove the `videoResolutionOf` import and render:

```tsx
      <span>{release.row.videoResolution ?? 'unknown'}</span>
```

Replace the top docblock's resolution paragraph with: "**The resolution is `row.videoResolution`, the lookup service's parse** (issue #98), or `unknown` when it has none. The row once printed `row.resolution`, which was the lookup state, and for one commit parsed the filename in the browser instead."

Delete the parser and its test:

```bash
git rm packages/plugin-ui/src/videoResolution.ts packages/plugin-ui/test/videoResolution.test.ts
```

- [ ] **Step 4: Run the gate**

Run: `npm run check > /tmp/pickarr-check.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)" /tmp/pickarr-check.log`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A packages && git commit -m "Show the stored video resolution on a release line, and drop the filename parser (#98)"
```

---

### Task 7: End-to-end, mutation checks, and closing the loop

**Files:**
- Modify: `packages/e2e/tests/*.spec.ts` only if a spec asserts on the release line's resolution text

- [ ] **Step 1: Run the browser specs**

Run: `npm run e2e -- tests/shell.spec.ts tests/media-details.spec.ts 2>&1 | tail -8`
Expected: every test passes. A failure that names `lookup_state`, `resolution` or `videoResolution` is a missed rename from Task 1 or 2. Fix it there and re-run.

- [ ] **Step 2: Mutate each guard and watch a test fail**

For each row, make the change, run the named file, confirm at least one `fail`, and restore with `git checkout -- <file>`:

| Mutation | File to change | Tests to run |
|---|---|---|
| `VIDEO_RESOLUTION` becomes `/^.*$/` | `packages/contract/src/videoResolution.ts` | `packages/contract/test/videoResolution.test.ts` |
| drop `lower(...)` from the backfill `SET` | `packages/host/src/db/migrate.ts` | `packages/host/test/db/migrate.test.ts` |
| delete the `forgetSyncGeneration(db)` line | `packages/host/src/db/migrate.ts` | `packages/host/test/db/migrate.test.ts` |
| delete the writer's `throw` | `packages/host/src/media/writer.ts` | `packages/host/test/media/writer.test.ts` |
| delete `setVideoResolution` from `applyEnvelope` | `packages/openmetadata/src/engine.ts` | `packages/openmetadata/test/engine-branch.test.ts` |
| delete `clear.run(row.rssItemId)` | `packages/openmetadata/src/backfill.ts` | `packages/openmetadata/test/backfill.test.ts` |
| delete the orphan `UPDATE` | `packages/openmetadata/src/backfill.ts` | `packages/openmetadata/test/backfill.test.ts` |
| delete the re-enqueue | `packages/openmetadata/src/backfill.ts` | `packages/openmetadata/test/backfill.test.ts` |
| rename a `jobs` column in the migration's `INSERT` | `packages/openmetadata/src/backfill.ts` | `packages/host/test/plugins/backfill.test.ts` |

A mutation that turns nothing red is a missing test. Write it in the task that owns the code before going further.

- [ ] **Step 3: Confirm nothing still calls the lookup state a resolution**

Run: `git grep -nE "\bresolution\b" -- 'packages/*/src' | grep -vE "^\S+:\s*(\*|//)"`
Expected: only the token name `resolution` and `resolveResolution`, plus unrelated uses (theme, client IP, shape comments).

- [ ] **Step 4: Final gate and commit**

Run: `npm run check > /tmp/pickarr-check.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail|skipped)" /tmp/pickarr-check.log; rm -f /tmp/pickarr-check.log`
Expected: exit 0, `fail 0`, and one server test skipped, as on `main`.

```bash
git add -A && git commit -m "Pin the e2e specs to the renamed lookup state (#98)" || true
```

The `|| true` is for the case where Step 1 needed no spec change. Nothing is pushed or merged. Report to the user, including that issue #98 can be closed once the branch merges.
