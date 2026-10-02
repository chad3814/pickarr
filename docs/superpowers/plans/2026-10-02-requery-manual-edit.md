# Requery and Manual Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From a release line or an unmatched card, run the lookup again, look the release up under a corrected name, or link it to a known media item chosen from an autocomplete; a media item that loses its last release is deleted with its plugin rows and artwork.

**Architecture:** The host gains one primitive, `reassignRelease`, that relinks a release inside a savepoint and drops the previous media item when it is orphaned, calling a new `MediaPlugin.onMediaItemDropped` hook so the plugin deletes its own rows first. A second hook, `onLookupRequest(rssItemId, hint)`, lets the engine enqueue a lookup whose payload may carry a name override; its resolved path now relinks through `reassignRelease`. One guarded route, `POST /api/releases/:id/identify`, serves three request modes. In the browser, `plugin-ui` gains an `IdentifySubmit` seam, an ARIA-combobox `IdentifyForm`, and Requery/Edit on the release line; `web` implements the seam over `sendJson` and the replica's catalog and adds Edit to the unmatched card.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `node:sqlite` savepoints, drizzle for the engine's own table, `node:http` routes, React 19, `node:test`, `@testing-library/react`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-requery-manual-edit-design.md`

## Global Constraints

- Worktree `/Users/chad/Projects/pickarr/worktrees/phase6-requery-manual-edit`, branch `phase6-requery-manual-edit`. Never edit `worktrees/main`, never push, never merge, never bare `git stash`.
- Route `POST /api/releases/:id/identify`, guarded (`open: false`). Body shapes exactly: `{ mode: 'requery' }`, `{ mode: 'name'; name: string }` (non-empty after trim), `{ mode: 'media-item'; mediaItemId: number }`. Answers `202 { accepted: true }` for `requery`/`name`, `200 { outcome: 'linked', mediaItemId }` for `media-item`.
- Refusal codes and statuses: `invalid-shape` 400 (route-level, bad shape or empty name); `unknown-release` 422; `plugin-not-registered` 422; `unknown-media-item` 422; `wrong-plugin` 422; `already-linked` 409. Codes live in `@pickarr/contract` as `IDENTIFY_RELEASE_REFUSALS`; the browser never re-spells one.
- No title, name or filename in any response body or log line.
- `/api/unmatched/:id/retry` is unchanged.
- `reassignRelease` runs inside savepoint `reassign_release`: relink (clears `lookup_json`), `lookup_state = 'resolved'`, `lookup_state_detail = NULL`, target `media_item.updated_at = now`; previous item (non-null, ≠ target): if no other `rss_item` points at it, `onMediaItemDropped` → `DELETE FROM role WHERE media_item_id = ?` → `dropMediaItem`; else bump its `updated_at`. Any throw rolls back.
- Hook signatures verbatim: `onMediaItemDropped(mediaItemId: number, ctx: PluginContext): Promise<void>`; `onLookupRequest(rssItemId: number, hint: { name: string } | undefined, ctx: PluginContext): Promise<void>`. Both required.
- Engine: `LookupPluginSpec.dropRows(mediaItemId: number, raw: DatabaseSync): void`; `onLookupRequest` sets `pending`/`NULL` detail, upserts the lookup row with do-nothing, enqueues `{ rssItemIds: [id], names: { [id]: name } }` (`names` only with a hint); the job posts `names[id] ?? filename`; `applyResolved` relinks through `ctx.media.reassignRelease`. A lookup never unlinks.
- Browser labels verbatim: buttons `Requery` / `Requerying…`, `Edit`, `Save`, `Cancel`; input label `Title`; look-up option `Look up as "<typed>"`; option text `Title (Year)` or `Title`; status span `Looking up…` for `pending`, the word `unresolved` / `refused` for those states, nothing for `resolved`. Suggestions capped at 8, debounced `150` ms.
- Combobox: `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `autoComplete="off"`; `<ul role="listbox">` of `<li role="option">` with `aria-selected`; ArrowDown/ArrowUp wrap, Enter chooses, Escape closes the list (not the form).
- Refusal sentences render in `<div role="alert"><span>…</span></div>`; every sentence distinct. No class attributes in `web`; `library.css` uses structural selectors.
- No `any`; narrow instead of cast. A comment must be true of the code beside it. `afterEach(cleanup)`; never a live DOM node to `node:assert`; no `t.mock.timers` (spy on `setTimeout`'s delay). `.tsx` tests run under the web runner's node invocation plus the file path (`npm run test:web -- <file>` does not filter); `.ts` under the server runner.
- Gate: `npm run check > file 2>&1; echo $?`. `timeout` is not a macOS command. Signing: retry once, then `git -c commit.gpgsign=false commit …` and report UNSIGNED.

## Review Focus

1. **A name padded with whitespace or inner runs** (`"  dune   part two "`). The form posts the trimmed string; the host trims again and refuses `invalid-shape` only when nothing is left; the job posts the trimmed name. Test in Tasks 2 and 3.
2. **Suggestion responses resolving out of order** (a slow query for `du` landing after `dune`'s). The listbox must show results for the current input only. Test in Task 3.
3. **Escape with the list closed** must not cancel the form or clear the input; only Cancel leaves. Test in Task 3.
4. **An unmatched card whose feed row has not replicated** has no plugin id to suggest within; Edit is not rendered until the feed is known. Test in Task 4.
5. **Requery on a release whose lookup is already `pending`** is accepted (a duplicate lookup is tolerated by design) and the button goes pending; nothing refuses it. Test in Task 2.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/contract/src/identify.ts` (new), `index.ts`, `plugin.ts`, `media.ts` | codes, request/outcome types, the two hooks, `MediaWriter.reassignRelease` | 1 |
| `packages/host/src/media/reassign.ts` (new), `media/writer.ts`, `host.ts` | the primitive and its wiring | 1 |
| `packages/openmetadata/src/engine.ts`, `testing.ts`; `packages/plugin-{tv,movie,xxx}/src/{index,apply}.ts`; `packages/e2e/src/harness-2.ts`; `packages/host/test/double/plugin.ts` | hook implementations, `dropRows`, `names` payload, `applyResolved` via reassign | 1 |
| `packages/host/src/media/identify.ts` (new), `host.ts`, `api/server.ts`, `api/request-shapes.ts`, `api/refusal-status.ts`, `api/path-params.ts`, `main.ts`, `packages/e2e/src/harness-2.ts` | `identifyRelease` and the route | 2 |
| `packages/plugin-ui/src/types.ts`, `plugin.ts`, `IdentifyForm.tsx` (new), `ReleaseList.tsx`, `index.ts`; `packages/plugin-{tv,movie,xxx}/src/browser.tsx` | the browser seam, the combobox form, the release line | 3 |
| `packages/web/src/library/postIdentify.ts` (new), `suggestCandidates.ts` (new), `Category.tsx`, `MediaItemCard.tsx`, `Unmatched.tsx`, `useFeedNames.ts`, `shell/Shell.tsx`, `styles/library.css` | wiring, the unmatched card's Edit, styling | 4 |
| `packages/e2e/tests/identify.spec.ts` (new) | e2e | 5 |

Task 1 first. Tasks 2 and 3 depend only on Task 1 and may run in parallel. Task 4 depends on 2 and 3. Task 5 last.

---

### Task 1: The contract, the primitive, and every implementer

**Files:**
- Create: `packages/contract/src/identify.ts`; modify `packages/contract/src/index.ts`, `plugin.ts` (`MediaPlugin` ~160-228), `media.ts` (`MediaWriter` ~86-210)
- Create: `packages/host/src/media/reassign.ts`; modify `packages/host/src/media/writer.ts` (`createMediaWriter` ~60; add the member), `packages/host/src/host.ts` (`createMediaWriter` call ~541; `ctxFor` ~543)
- Modify: `packages/openmetadata/src/engine.ts` (`readLookupPayload` ~544, `readRssItems` ~532, `lookup` handler ~716-740, `applyResolved` ~198, `LookupPluginSpec` ~381-421, `createLookupPlugin` ~692 and its `onNewRssItems` ~778), `packages/openmetadata/src/testing.ts` (`createRecordingMedia`, harness `rss_item` table ~427)
- Modify: `packages/plugin-tv/src/index.ts` + `apply.ts`, `packages/plugin-movie/src/index.ts` + `apply.ts`, `packages/plugin-xxx/src/index.ts` + `apply.ts` (`dropRows`)
- Modify: `packages/e2e/src/harness-2.ts` (`stubPlugin` ~230-245), `packages/host/test/double/plugin.ts`
- Test: `packages/host/test/media/reassign.test.ts` (new), `packages/openmetadata/test/engine-jobs.test.ts`, `engine-resolved.test.ts`, `packages/plugin-tv/test/*`, `plugin-movie/test/*`, `plugin-xxx/test/*` (one `dropRows` test each; find each package's existing apply test file)

**Interfaces:**
- Produces (contract):

```ts
// contract/src/identify.ts
export const IDENTIFY_RELEASE_REFUSALS = ['unknown-release', 'plugin-not-registered', 'unknown-media-item', 'wrong-plugin', 'already-linked'] as const;
export type IdentifyReleaseRefusalCode = (typeof IDENTIFY_RELEASE_REFUSALS)[number];
export type IdentifyRequest =
  | { readonly mode: 'requery' }
  | { readonly mode: 'name'; readonly name: string }
  | { readonly mode: 'media-item'; readonly mediaItemId: number };
export type IdentifyReleaseOutcome =
  | { readonly accepted: true }
  | { readonly outcome: 'linked'; readonly mediaItemId: number }
  | { readonly refusal: IdentifyReleaseRefusalCode };
// contract/src/plugin.ts — MediaPlugin
onMediaItemDropped(mediaItemId: number, ctx: PluginContext): Promise<void>;
onLookupRequest(rssItemId: number, hint: { name: string } | undefined, ctx: PluginContext): Promise<void>;
// contract/src/media.ts — MediaWriter
reassignRelease(rssItemId: number, mediaItemId: number): Promise<void>;
```
- Produces (host): `reassignRelease(deps: ReassignDeps, rssItemId: number, mediaItemId: number): Promise<void>` with `ReassignDeps = { raw: DatabaseSync; relink: MediaWriter['relinkRssItem']; drop: MediaWriter['dropMediaItem']; now: () => number; dropRows: (pluginId: string, mediaItemId: number) => Promise<void> }`; `createMediaWriter(db, now, artwork, hooks: { dropRows: ReassignDeps['dropRows'] })`.
- Produces (engine): `LookupPluginSpec.dropRows(mediaItemId: number, raw: DatabaseSync): void`; lookup payload `{ rssItemIds: number[]; names?: Record<string, string> }`.

- [ ] **Step 1: Write the failing tests**

`packages/host/test/media/reassign.test.ts` (model the DB setup on `packages/host/test/media/writer.test.ts`: `openTestDatabase`, `migrateHost`, `withArtworkStore`, `insertFeed`; read its first 110 lines):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createMediaWriter } from '../../src/media/writer.ts';
import { reassignRelease, type ReassignDeps } from '../../src/media/reassign.ts';
// reuse writer.test.ts's withArtworkStore/insertFeed by extracting them to test/media/support.ts if they are not already shared

const NOW = 1_700_000_000_000;
function seedItem(raw: DatabaseSync, id: number, pluginId = 'tv'): void {
  raw.prepare('INSERT INTO media_item (id, plugin_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, pluginId, `Title ${String(id)}`, 1, 1);
}
function seedRelease(raw: DatabaseSync, id: number, feedId: number, mediaItemId: number | null): void {
  raw.prepare(`INSERT INTO rss_item (id, feed_id, filename, link, created_at, updated_at, download_type, media_item_id, lookup_state, lookup_json)
    VALUES (?, ?, ?, '', 1, 1, 'torrent', ?, 'unresolved', '{"old":"answer"}')`).run(id, feedId, `f${String(id)}.mkv`, mediaItemId);
}
function seedRole(raw: DatabaseSync, mediaItemId: number): void {
  raw.prepare("INSERT INTO person (id, name, provider_ref, created_at, updated_at) VALUES (1, 'Someone', 'p1', 1, 1) ON CONFLICT DO NOTHING").run();
  raw.prepare("INSERT INTO role (media_item_id, person_id, role, created_at) VALUES (?, 1, 'actor', 1)").run(mediaItemId);
}
function item(raw: DatabaseSync, id: number): Record<string, unknown> | undefined { return raw.prepare('SELECT * FROM media_item WHERE id = ?').get(id); }
function release(raw: DatabaseSync, id: number): Record<string, unknown> | undefined { return raw.prepare('SELECT * FROM rss_item WHERE id = ?').get(id); }

function fixture(dropRows: ReassignDeps['dropRows'] = async () => {}) {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  return withArtworkStore(async (artwork) => {
    const writer = createMediaWriter(db, () => NOW, artwork, { dropRows });
    const deps: ReassignDeps = { raw, relink: writer.relinkRssItem, drop: writer.dropMediaItem, now: () => NOW, dropRows };
    const feedId = insertFeed(raw, 'http://feed.invalid/a');
    return { raw, deps, feedId, writer };
  });
}

test('moving a release relinks it, marks it resolved, clears its stored answer, and bumps the target', async () => {
  const { raw, deps, feedId } = await fixture();
  seedItem(raw, 1); seedItem(raw, 2); seedRelease(raw, 10, feedId, 1); seedRelease(raw, 11, feedId, 1);
  await reassignRelease(deps, 10, 2);
  const moved = release(raw, 10);
  assert.equal(moved?.['media_item_id'], 2);
  assert.equal(moved?.['lookup_state'], 'resolved');
  assert.equal(moved?.['lookup_state_detail'], null);
  assert.equal(moved?.['lookup_json'], null);
  assert.equal(item(raw, 2)?.['updated_at'], NOW, 'the target is bumped so its card re-gathers');
  assert.ok(item(raw, 1), 'the previous item still has release 11 and stays');
  assert.equal(item(raw, 1)?.['updated_at'], NOW, 'and is bumped so its card re-gathers without release 10');
});

test('an orphaned previous item is dropped: plugin rows first, then roles, then the item with a tombstone', async () => {
  const order: string[] = [];
  const { raw, deps, feedId } = await fixture(async (pluginId, id) => {
    order.push(`dropRows:${pluginId}:${String(id)}`);
    assert.ok(item(raw, id), 'the item still exists when the plugin is asked, so its FK rows can be found');
  });
  seedItem(raw, 1); seedItem(raw, 2); seedRelease(raw, 10, feedId, 1); seedRole(raw, 1);
  await reassignRelease(deps, 10, 2);
  assert.deepEqual(order, ['dropRows:tv:1']);
  assert.equal(item(raw, 1), undefined);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM role WHERE media_item_id = 1').get()?.['n'], 0);
  assert.equal(raw.prepare('SELECT media_item_id FROM deleted_media_item WHERE media_item_id = 1').get()?.['media_item_id'], 1);
});

test('a throwing plugin hook rolls the whole move back, relink included', async () => {
  const { raw, deps, feedId } = await fixture(async () => { throw new Error('plugin refused'); });
  seedItem(raw, 1); seedItem(raw, 2); seedRelease(raw, 10, feedId, 1);
  await assert.rejects(reassignRelease(deps, 10, 2), /plugin refused/);
  assert.equal(release(raw, 10)?.['media_item_id'], 1);
  assert.equal(release(raw, 10)?.['lookup_json'], '{"old":"answer"}');
  assert.ok(item(raw, 1));
});

test('a release with no previous item is linked and nothing is dropped; the same item twice is a bump', async () => {
  const calls: number[] = [];
  const { raw, deps, feedId } = await fixture(async (_p, id) => { calls.push(id); });
  seedItem(raw, 2); seedRelease(raw, 10, feedId, null);
  await reassignRelease(deps, 10, 2);
  assert.equal(release(raw, 10)?.['media_item_id'], 2);
  await reassignRelease(deps, 10, 2);
  assert.deepEqual(calls, []);
  assert.ok(item(raw, 2));
});

test('the writer exposes reassignRelease and it reaches the same rule', async () => {
  const { raw, feedId, writer } = await fixture();
  seedItem(raw, 1); seedItem(raw, 2); seedRelease(raw, 10, feedId, 1);
  await writer.reassignRelease(10, 2);
  assert.equal(release(raw, 10)?.['media_item_id'], 2);
  assert.equal(item(raw, 1), undefined, 'orphan dropped through the writer path too');
});
```

Engine tests, appended to `packages/openmetadata/test/engine-jobs.test.ts` (read its fixture; it builds the plugin with `createLookupPlugin` and a harness whose `ctx.jobs.enqueue` records):

```ts
test('onLookupRequest marks the release pending, keeps its lookup row, and enqueues one job carrying the name only when hinted', async () => {
  const { plugin, harness, rssItemId } = fixture();   // adapt to the file's own fixture name
  await plugin.onLookupRequest(rssItemId, undefined, harness.ctx);
  assert.deepEqual(harness.media.calls.setLookupState.at(-1), [rssItemId, 'pending', null, null]);
  assert.deepEqual(harness.enqueued.at(-1)?.payload, { rssItemIds: [rssItemId] });
  await plugin.onLookupRequest(rssItemId, { name: 'Dune Part Two 2024' }, harness.ctx);
  assert.deepEqual(harness.enqueued.at(-1)?.payload, { rssItemIds: [rssItemId], names: { [String(rssItemId)]: 'Dune Part Two 2024' } });
  assert.equal(harness.raw.prepare(`SELECT count(*) AS n FROM ${PLUGIN_ID}_lookup WHERE rss_item_id = ?`).get(rssItemId)?.['n'], 1, 'the do-nothing upsert kept one row');
});

test('the lookup job posts the hinted name in place of the filename, and the filename otherwise', async () => {
  // Drive `plugin.jobs.lookup` with a payload carrying `names` for one of two ids and a fetch stub that records the posted body; assert the posted names array is [name, filename-of-the-other].
});

test('onMediaItemDropped delegates to the spec\'s dropRows with the raw connection', async () => {
  const seen: number[] = [];
  const { plugin, harness } = fixture({ dropRows: (id) => { seen.push(id); } });
  await plugin.onMediaItemDropped(42, harness.ctx);
  assert.deepEqual(seen, [42]);
});
```

In `engine-resolved.test.ts`, change the assertion that `relinkRssItem` was called to `reassignRelease` with `(rssItemId, claim.kept)`, and add: "a resolved answer for a release already linked elsewhere relinks through `reassignRelease`" (the recording media records the call; the host's rule is tested in `reassign.test.ts`).

Plugin tests: in each plugin's existing apply test file, one test: after `apply` wrote rows for item 1 and item 2, `dropRows(1, raw)` leaves no `tv_release`/`movie_detail`/`xxx_scene` row with `media_item_id = 1` and keeps item 2's; for tv, `tv_series` and `tv_season` rows remain.

- [ ] **Step 2: Run and watch them fail** — `node --import tsx --conditions development --test packages/host/test/media/reassign.test.ts packages/openmetadata/test/engine-jobs.test.ts 2>&1 | grep -E "^not ok|Cannot find|error" | head` — FAIL.

- [ ] **Step 3: Contract**

`contract/src/identify.ts` with the Interfaces block and this docblock:

```ts
/**
 * Re-identifying a release after the fact (design spec 2026-10-02): run the
 * lookup again, run it under a corrected name, or link the release to a
 * media item the library already has.
 *
 * Codes only. `invalid-shape` is not here because the route decides it
 * before the host is asked, as `/api/picks` does. The browser maps each
 * code to its own sentence (`@pickarr/plugin-ui`'s
 * `IDENTIFY_REFUSAL_MESSAGES`) and never re-spells one.
 */
```
Export the three types and the constant from `index.ts`. Add the two hooks to `MediaPlugin` after `onDownloadRequest`, each with a one-paragraph docblock (why required; what the host does after `onMediaItemDropped`; that `onLookupRequest` may be asked about a matched release and must never unlink). Add `reassignRelease` to `MediaWriter` after `relinkRssItem`: "relink, then drop the previous item if nothing else points at it; the host's one move primitive, which the engine's resolved path uses instead of `relinkRssItem` so a re-lookup of a matched release cleans up after itself."

- [ ] **Step 4: `media/reassign.ts`**

```ts
/**
 * Moves a release to a media item and cleans up behind it (design spec
 * 2026-10-02 §1.2). The one place `rss_item.media_item_id` changes from a
 * non-null value, and the one place a media item is dropped for having no
 * releases left.
 *
 * **One savepoint for the whole move.** The plugin's own rows go first,
 * because `tv_release`, `movie_detail` and `xxx_scene` reference the item
 * with `PRAGMA foreign_keys = ON` and no cascade; roles next for the same
 * reason; `dropMediaItem` last (its own nested savepoint writes the
 * tombstone and clears artwork rows). A throw anywhere -- a plugin hook
 * included -- rolls back to before the relink, so the release is never
 * left pointing somewhere while its old item is half-deleted.
 *
 * Both items' `updated_at` are set to now. That is what carries the move to
 * the browser: `useGatheredItem` re-gathers on a `media_item` row change,
 * and the sync log emits the rows because they changed.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MediaWriter } from '@pickarr/contract';

export interface ReassignDeps {
  raw: DatabaseSync;
  relink: MediaWriter['relinkRssItem'];
  drop: MediaWriter['dropMediaItem'];
  now: () => number;
  /** The owning plugin deletes its rows for the item; `host.ts` binds this to `MediaPlugin.onMediaItemDropped`. */
  dropRows: (pluginId: string, mediaItemId: number) => Promise<void>;
}

function previousLink(raw: DatabaseSync, rssItemId: number): number | null | undefined {
  const row = raw.prepare('SELECT media_item_id FROM rss_item WHERE id = ?').get(rssItemId);
  if (row === undefined) return undefined;
  const value = row['media_item_id'];
  return typeof value === 'number' ? value : null;
}

function pluginOf(raw: DatabaseSync, mediaItemId: number): string | undefined {
  const row = raw.prepare('SELECT plugin_id FROM media_item WHERE id = ?').get(mediaItemId);
  const value = row?.['plugin_id'];
  return typeof value === 'string' ? value : undefined;
}

function releasesPointingAt(raw: DatabaseSync, mediaItemId: number): number {
  const row = raw.prepare('SELECT count(*) AS n FROM rss_item WHERE media_item_id = ?').get(mediaItemId);
  const n = row?.['n'];
  return typeof n === 'number' ? n : 0;
}

export async function reassignRelease(deps: ReassignDeps, rssItemId: number, mediaItemId: number): Promise<void> {
  const { raw } = deps;
  const previous = previousLink(raw, rssItemId);
  if (previous === undefined) throw new Error(`reassignRelease: no rss item ${String(rssItemId)}`);
  const at = deps.now();
  raw.exec('SAVEPOINT reassign_release');
  try {
    await deps.relink(rssItemId, mediaItemId);
    raw.prepare("UPDATE rss_item SET lookup_state = 'resolved', lookup_state_detail = NULL, updated_at = ? WHERE id = ?").run(at, rssItemId);
    raw.prepare('UPDATE media_item SET updated_at = ? WHERE id = ?').run(at, mediaItemId);
    if (previous !== null && previous !== mediaItemId) {
      if (releasesPointingAt(raw, previous) === 0) {
        const pluginId = pluginOf(raw, previous);
        if (pluginId === undefined) throw new Error(`reassignRelease: media item ${String(previous)} vanished mid-move`);
        await deps.dropRows(pluginId, previous);
        raw.prepare('DELETE FROM role WHERE media_item_id = ?').run(previous);
        await deps.drop(previous);
      } else {
        raw.prepare('UPDATE media_item SET updated_at = ? WHERE id = ?').run(at, previous);
      }
    }
  } catch (err) {
    raw.exec('ROLLBACK TO reassign_release');
    raw.exec('RELEASE reassign_release');
    throw err;
  }
  raw.exec('RELEASE reassign_release');
}
```

`writer.ts`: `createMediaWriter(db, now, artwork, hooks: { dropRows: ReassignDeps['dropRows'] })`; build the writer object as `const writer: MediaWriter = { …, reassignRelease: (r, m) => reassignRelease({ raw, relink: writer.relinkRssItem, drop: writer.dropMediaItem, now, dropRows: hooks.dropRows }, r, m) }` (a `const` self-reference inside an arrow is fine at call time). Update `MediaWriter`'s "ten of its eleven methods" doc sentence to the new count.

`host.ts`: `const media = createMediaWriter(deps.db, deps.now, artwork, { dropRows: async (pluginId, mediaItemId) => { const plugin = plugins.get(pluginId); if (plugin === undefined) throw new PluginNotRegisteredError(pluginId); await plugin.onMediaItemDropped(mediaItemId, ctxFor(pluginId)); } });` — `plugins` and `ctxFor` are declared in the same scope; the closure reads them at call time. Check `PluginNotRegisteredError`'s constructor signature in `errors.ts`.

- [ ] **Step 5: Engine, plugins, stubs**

`engine.ts`:
- `readLookupPayload` returns `{ ids: number[]; names: ReadonlyMap<number, string> }`: `names` is read from `payload.names` when it is a record of string values keyed by numeric strings; anything else throws `TypeError('openmetadata: names must map rss item ids to strings')`.
- `lookup` handler: `const { ids, names } = readLookupPayload(job.payload); const items = readRssItems(raw, ids); const posted = items.map((item) => names.get(item.id) ?? item.filename);` and `batch(spec.category, posted)`. The envelope target keeps `filename: item.filename` (the real one, for logs and `describeUnresolved`).
- `applyResolved`: replace `await ctx.media.relinkRssItem(target.rssItemId, claim.kept);` with `await ctx.media.reassignRelease(target.rssItemId, claim.kept);` and rewrite the comment above it: the move primitive relinks and, when this release was the last on a different item, drops that item; for a first link it is a relink with a bump.
- `LookupPluginSpec.dropRows` with a docblock (what the host deletes afterwards, why plugin tables need it: FKs without cascade).
- In `createLookupPlugin`: 
  ```ts
  async onMediaItemDropped(mediaItemId, ctx) { spec.dropRows(mediaItemId, asDatabase(ctx.db)); },
  async onLookupRequest(rssItemId, hint, ctx) {
    const { raw, db } = ownTables(ctx);
    const at = deps.now();
    await ctx.media.setLookupState(rssItemId, 'pending', null, null);
    await db.insert(table).values([{ rssItemId, mediaItemId: null, lookupJobId: null, lookupId: null, providerRef: null, confidence: null, createdAt: at, updatedAt: at }]).onConflictDoNothing();
    const payload = hint === undefined ? { rssItemIds: [rssItemId] } : { rssItemIds: [rssItemId], names: { [String(rssItemId)]: hint.name } };
    const jobId = await ctx.jobs.enqueue({ kind: LOOKUP_JOB, payload });
    await db.update(table).set({ lookupJobId: jobId, updatedAt: at }).where(eq(table.rssItemId, rssItemId));
  },
  ```
  with a docblock: a lookup never unlinks; a matched release stays linked until a resolved answer moves it through `reassignRelease`.
- `testing.ts`: `createRecordingMedia` gains `reassignRelease` recording `[rssItemId, mediaItemId]` under `calls.reassignRelease`; the harness's `rss_item` table gains `media_item_id INTEGER` so `applyResolved`'s path has the column. Read the file's recording pattern first and follow it exactly.

Plugins: `plugin-tv/src/apply.ts` exports `dropTvRows(mediaItemId, raw)` = `DELETE FROM tv_release WHERE media_item_id = ?` (doc: series and seasons are shared across items and stay); `plugin-movie` `dropMovieRows` deletes `movie_detail`; `plugin-xxx` `dropXxxRows` deletes `xxx_scene` (sites stay). Each `index.ts` passes `dropRows` in its spec.

`e2e/src/harness-2.ts` `stubPlugin`: `async onMediaItemDropped() {}` (the stub writes no plugin rows for seeded items? — check `seedTvRelease`: it does insert `tv_release` rows; the tv stub must `DELETE FROM tv_release WHERE media_item_id = ?` too; mirror per category using `PLUGIN_SCHEMA`'s knowledge) and `async onLookupRequest(rssItemId, _hint, ctx) { await ctx.media.setLookupState(rssItemId, 'pending', null, null); }` with a comment: enough for the browser to show `Looking up…`; no service is asked in an e2e run. `host/test/double/plugin.ts` and any other `MediaPlugin` literal in tests: add both hooks (no-ops).

- [ ] **Step 6: Run, gate, commit**

Named tests PASS; `npm run check > /tmp/p6-t1.log 2>&1; echo "exit $?"; rm -f /tmp/p6-t1.log` — exit 0.

```bash
git add -A packages && git commit -m "Let a release move between media items, dropping an item left with none, and let a lookup be asked again by name"
```

---

### Task 2: `identifyRelease` and the route

**Files:**
- Create: `packages/host/src/media/identify.ts`
- Modify: `packages/host/src/host.ts` (`Host` interface after `retryLookup` ~187; implementation after `retryLookup` ~842), `api/server.ts` (`ReadServerDeps` after `retryLookup` ~373; `ROUTES` after the retry entry ~1207; module route count), `api/request-shapes.ts`, `api/refusal-status.ts`, `api/path-params.ts` (`identifyIdFrom = idAt(pathname, 5, 3)`), `main.ts` (~1020), `packages/e2e/src/harness-2.ts` (the `ReadServerDeps` it builds)
- Test: `packages/host/test/media/identify.test.ts` (new), `packages/host/test/api/server.test.ts`, `packages/host/test/api/refusal-status.test.ts` if it exists

**Interfaces:**
- Consumes: Task 1's contract types; `MediaWriter.reassignRelease`; `MediaPlugin.onLookupRequest`.
- Produces: `identifyRelease(deps: IdentifyDeps, rssItemId: number, request: IdentifyRequest): Promise<IdentifyReleaseOutcome>` with `IdentifyDeps = { raw: DatabaseSync; pluginFor: (pluginId: string) => MediaPlugin | undefined; ctxFor: (pluginId: string) => PluginContext; reassign: MediaWriter['reassignRelease'] }`; `Host.identifyRelease(rssItemId, request)`; `ReadServerDeps.identifyRelease`; `isIdentifyBody(value): value is IdentifyRequest` (trims `name`, rejects empty); `statusForIdentifyRefusal(code): number`.

- [ ] **Step 1: Write the failing tests**

`packages/host/test/media/identify.test.ts` (model on `retry.test.ts`: `setup()`, `seedRelease`, `seedMediaItem`; the feed must carry `plugin_id`):

```ts
test('media-item mode moves the release and answers linked', …);           // reassign recorded with (10, 2); outcome { outcome: 'linked', mediaItemId: 2 }
test('requery and name modes ask the owning plugin, with and without the hint', …);  // pluginFor('tv').onLookupRequest called with (10, undefined) then (10, { name: 'Dune' }); outcome { accepted: true }
test('a padded name reaches the plugin trimmed at the ends only', …);       // Review Focus 1: the route hands the host '  Dune   Part Two ' already trimmed to 'Dune   Part Two'; the host passes it through unchanged — inner runs are the lookup service's business — so assert the plugin saw exactly 'Dune   Part Two'
test('each refusal from its condition', …);                                 // unknown-release; plugin-not-registered (feed names 'ghost'); unknown-media-item; wrong-plugin (item plugin 'movie', release feed 'tv'); already-linked (release already on 2)
test('a release whose lookup is already pending is still re-asked', …);     // Review Focus 5: seedRelease with lookup_state 'pending'; requery → accepted, plugin called
test('a throwing plugin surfaces as a fault, not a refusal', …);
```

`server.test.ts` additions (model on the retry specs at ~2204-2290):

```ts
test('identify: media-item answers 200 linked, requery and name answer 202, and the id travels from the path', …);  // stub identifyRelease records (id, request); POST /api/releases/860531/identify with each body
test('identify: each refusal answers its own status', …);                    // table of the five codes → 422/422/422/422/409; body equals { refusal }
test('identify: a bad body is 400 invalid-shape and the host is never asked', …);  // {}, { mode: 'name', name: '   ' }, { mode: 'media-item', mediaItemId: '7' }, { mode: 'other' }
test('identify: a non-integer id is 404', …);
// the guard probe table already covers 401-before-405 for every ROUTES entry
```

- [ ] **Step 2: Run and watch them fail** — FAIL.

- [ ] **Step 3: Implement**

`media/identify.ts`:

```ts
/**
 * `POST /api/releases/:id/identify`'s rule (design spec 2026-10-02 §1.3):
 * validate the release and, for `media-item`, the target; then either move
 * the release (synchronously, through `reassignRelease`) or ask its plugin
 * to look it up again (asynchronously, through `onLookupRequest`). The
 * route turns the outcome into a status; this file never sees HTTP.
 */
export async function identifyRelease(deps: IdentifyDeps, rssItemId: number, request: IdentifyRequest): Promise<IdentifyReleaseOutcome> {
  const release = deps.raw.prepare('SELECT r.media_item_id AS mediaItemId, f.plugin_id AS pluginId FROM rss_item r JOIN rss_feed f ON f.id = r.feed_id WHERE r.id = ?').get(rssItemId);
  if (release === undefined) return { refusal: 'unknown-release' };
  const pluginId = release['pluginId'];
  if (typeof pluginId !== 'string') return { refusal: 'unknown-release' };
  const plugin = deps.pluginFor(pluginId);
  if (plugin === undefined) return { refusal: 'plugin-not-registered' };
  if (request.mode === 'media-item') {
    const target = deps.raw.prepare('SELECT plugin_id FROM media_item WHERE id = ?').get(request.mediaItemId);
    if (target === undefined) return { refusal: 'unknown-media-item' };
    if (target['plugin_id'] !== pluginId) return { refusal: 'wrong-plugin' };
    if (release['mediaItemId'] === request.mediaItemId) return { refusal: 'already-linked' };
    await deps.reassign(rssItemId, request.mediaItemId);
    return { outcome: 'linked', mediaItemId: request.mediaItemId };
  }
  await plugin.onLookupRequest(rssItemId, request.mode === 'name' ? { name: request.name } : undefined, deps.ctxFor(pluginId));
  return { accepted: true };
}
```

`host.ts`: `identifyRelease(rssItemId, request) { return identifyReleaseRule({ raw: deps.raw, pluginFor: (id) => plugins.get(id), ctxFor, reassign: media.reassignRelease }, rssItemId, request); }` with a `Host` interface doc.

`request-shapes.ts`:

```ts
/** `POST /api/releases/:id/identify`'s body: one of three modes. `name` is trimmed here, so the host and the plugin see the operator's words without their padding; an empty result is not a shape. */
export function isIdentifyBody(value: unknown): value is IdentifyRequest { … }
export function trimIdentifyBody(body: IdentifyRequest): IdentifyRequest { return body.mode === 'name' ? { mode: 'name', name: body.name.trim() } : body; }
```
(Guard first, then trim; the guard rejects a `name` whose trim is empty.)

`refusal-status.ts`: `statusForIdentifyRefusal` — exhaustive switch: `already-linked` 409, the other four 422. `path-params.ts`: `identifyIdFrom`. `server.ts` route:

```ts
  {
    path: '/api/releases/:id/identify',
    methods: ['POST'],
    open: false,
    answer: async ({ deps, pathname, body }) => {
      const id = identifyIdFrom(pathname);
      if (id === undefined) return UNKNOWN_ROUTE;
      if (!isIdentifyBody(body)) return json(400, { refusal: 'invalid-shape' });
      const result = await deps.identifyRelease(id, trimIdentifyBody(body));
      if ('refusal' in result) return json(statusForIdentifyRefusal(result.refusal), { refusal: result.refusal });
      return 'accepted' in result ? json(202, result) : json(200, result);
    },
  },
```
Route count in the module doc: 21. `main.ts` and the harness wire `identifyRelease: (id, request) => host.identifyRelease(id, request)`; `server.test.ts`'s `start` gets a throwing default stub like `retryLookup`'s.

- [ ] **Step 4: Run, gate, commit** — `npm run check > /tmp/p6-t2.log 2>&1; echo "exit $?"; rm -f /tmp/p6-t2.log` — exit 0.

```bash
git add -A packages && git commit -m "Serve POST /api/releases/:id/identify: requery, look up by name, or link to a known media item"
```

---

### Task 3: The browser seam, the combobox form, and the release line

**Files:**
- Modify: `packages/plugin-ui/src/types.ts` (after `PickSubmit` ~88 and `PICK_REFUSAL_MESSAGES` ~115), `plugin.ts` (`CardProps`), `index.ts` (exports)
- Create: `packages/plugin-ui/src/IdentifyForm.tsx`
- Modify: `packages/plugin-ui/src/ReleaseList.tsx` (`ReleaseListProps` ~90, `ReleaseRow` ~201-294, `ReleaseList` ~296)
- Modify: `packages/plugin-tv/src/browser.tsx` (~155-170), `packages/plugin-movie/src/browser.tsx` (~92), `packages/plugin-xxx/src/browser.tsx` (~88)
- Test: `packages/plugin-ui/test/IdentifyForm.test.tsx` (new), `ReleaseList.test.tsx`

**Interfaces:**
- Consumes: `IdentifyRequest`, `IdentifyReleaseRefusalCode`, `IDENTIFY_RELEASE_REFUSALS` from `@pickarr/contract` (Task 1).
- Produces (plugin-ui, all exported from `index.ts`):

```ts
export type IdentifyOutcome =
  | { accepted: true }
  | { outcome: 'linked'; mediaItemId: number }
  | { refusal: IdentifyReleaseRefusalCode | 'offline' | 'expired' | 'unrecognised' };
export interface Candidate { mediaItemId: number; title: string; year: string | null; }
export interface IdentifySubmit {
  identify(rssItemId: number, request: IdentifyRequest): Promise<IdentifyOutcome>;
  suggest(pluginId: string, term: string): Promise<readonly Candidate[]>;
}
export const IDENTIFY_REFUSAL_MESSAGES: Record<IdentifyReleaseRefusalCode | 'offline' | 'expired' | 'unrecognised', string>;
export const REQUERY_LABELS = { idle: 'Requery', pending: 'Requerying…' } as const;
export const SUGGEST_DEBOUNCE_MS = 150;
export const SUGGEST_LIMIT = 8;
export interface IdentifyFormProps { pluginId: string; rssItemId: number; identify: IdentifySubmit; onDone(): void; onCancel(): void; }
export function IdentifyForm(props: IdentifyFormProps): ReactElement;
// CardProps gains `readonly identify: IdentifySubmit`; ReleaseListProps gains `identify: IdentifySubmit; pluginId: string`
```

- [ ] **Step 1: Write the failing tests**

`IdentifyForm.test.tsx` (web runner; `afterEach(cleanup)`; a `stubIdentify` whose `suggest` is controllable and whose `identify` records requests):

```ts
test('renders a labelled combobox with the ARIA wiring and an empty, closed list', …);
  // getByRole('combobox', { name: 'Title' }); aria-autocomplete 'list'; aria-expanded 'false'; aria-controls names the listbox id; Save disabled
test('typing asks suggest after the debounce, for the plugin, and lists up to eight candidates plus the look-up option', …);
  // spy setTimeout delays include 150; suggest called with ('tv', 'dune'); options: 'Dune (2021)', 'Dune: Part Two (2024)', 'Untitled' (null year → no parens), last option 'Look up as "dune"'
test('arrow keys move the highlight with wrapping and aria-activedescendant follows; Enter chooses; Escape closes the list but keeps the form and the input', …);
  // Review Focus 3: after Escape, combobox still present, value unchanged, onCancel not called
test('choosing a candidate posts media-item; choosing the look-up option posts name, trimmed', …);
  // Review Focus 1: input '  Dune   Part Two ' → { mode: 'name', name: 'Dune   Part Two' }
test('editing after a choice reverts to name mode', …);
test('a stale suggestion response is ignored', …);
  // Review Focus 2: hold the first suggest promise ('du'), type 'dune' and resolve its promise first, then resolve the first; listbox shows 'dune' results
test('accepted and linked call onDone; a refusal shows its sentence in an alert and keeps the form', …);
test('Save is disabled while empty and while a request is in flight', …);
```

`ReleaseList.test.tsx` additions:

```ts
test('each release line offers Requery and Edit after Pick, and Requery stays pending until the row\'s updatedAt advances', …);
  // click Requery → label 'Requerying…', disabled; resolve identify with { accepted: true }; still pending; rerender with updatedAt + 1 → 'Requery' enabled
test('a Requery refusal re-enables the button and announces the sentence', …);
test('Edit swaps the three buttons for the form; Cancel restores them', …);
test('the line shows Looking up… for pending, the word for unresolved and refused, and nothing for resolved', …);
```

- [ ] **Step 2: Run and watch them fail** — FAIL.

- [ ] **Step 3: Implement**

`types.ts`: the types and constants above. `IDENTIFY_REFUSAL_MESSAGES`:

```ts
  'unknown-release': 'Pickarr no longer has that release on file. Reload the page and try again.',
  'plugin-not-registered': 'No plugin in this Pickarr handles that kind of media, so nothing can identify this release.',
  'unknown-media-item': 'That title is no longer in the library. Pick another or look the release up by name.',
  'wrong-plugin': 'That title belongs to a different category than this release’s feed.',
  'already-linked': 'This release already belongs to that title.',
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  expired: SESSION_EXPIRED_MESSAGE,
  unrecognised: 'Pickarr refused the change, but did not say why. The host may be a different version than this page expects — reload and try again.',
```

`IdentifyForm.tsx`: state `input`, `chosen: number | null`, `options: Candidate[]`, `open`, `highlight: number`, `pending`, `error`; a `requestSeq` ref so a response whose sequence is older than the latest is dropped; a debounce timer ref cleared on unmount. Ids: `identify-${rssItemId}-input`, `-listbox`, `-option-${i}`. The look-up option is index `options.length`. Render:

```tsx
<form onSubmit={(e) => { e.preventDefault(); void save(); }}>
  <label htmlFor={inputId}>Title</label>
  <input id={inputId} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listboxId}
         aria-activedescendant={open ? `${optionId}-${String(highlight)}` : undefined} autoComplete="off"
         value={input} onChange={onInput} onKeyDown={onKey} />
  <ul id={listboxId} role="listbox" hidden={!open}>
    {options.map((c, i) => <li key={c.mediaItemId} id={`${optionId}-${String(i)}`} role="option" aria-selected={i === highlight} onMouseDown={() => choose(i)}>{label(c)}</li>)}
    {trimmed !== '' && <li id={`${optionId}-${String(options.length)}`} role="option" aria-selected={highlight === options.length} onMouseDown={() => choose(options.length)}>Look up as "{trimmed}"</li>}
  </ul>
  <button type="submit" disabled={trimmed === '' || pending}>Save</button>
  <button type="button" onClick={onCancel}>Cancel</button>
  {error !== null && <div role="alert"><span>{error}</span></div>}
</form>
```
`exactOptionalPropertyTypes`: omit `aria-activedescendant` rather than pass `undefined` if the JSX typing objects (spread a conditional props object). `onMouseDown` rather than `onClick` so the input's blur does not close the list first.

`ReleaseList.tsx`: `ReleaseRow` gains `identify`, `pluginId`; state `editing`, `requeryingSince: number | undefined` (pending = `requeryingSince !== undefined && release.row.updatedAt === requeryingSince`, as `RetryButton` does), `requeryError`. Buttons after Pick: Requery (`aria-labelledby` composed with the filename id, as Pick's is), Edit. `editing` renders `<IdentifyForm … onDone={() => { setEditing(false); setRequeryingSince(release.row.updatedAt); }} onCancel={() => setEditing(false)} />` in place of the three buttons. Status span after the resolution span: `lookupState === 'pending' ? 'Looking up…' : lookupState === 'unresolved' || lookupState === 'refused' ? lookupState : null`. `ReleaseList` passes `identify` and `pluginId` through. Docblock additions true of the code.

`plugin.ts`: `CardProps.identify`. Three `browser.tsx`: destructure `identify` and pass `<ReleaseList releases={…} submit={submit} identify={identify} pluginId={item.pluginId} />`. Any `CardProps` fixture in plugin tests gains `identify` (a throwing stub).

- [ ] **Step 4: Run, gate, commit** — exit 0.

```bash
git add -A packages && git commit -m "Offer Requery and Edit on every release line, with a combobox over the library's titles"
```

---

### Task 4: Wire the browser, and Edit on the unmatched card

**Files:**
- Create: `packages/web/src/library/postIdentify.ts`, `packages/web/src/library/suggestCandidates.ts`
- Modify: `packages/web/src/library/Category.tsx` (`CategoryProps`/`ListProps`/`ItemList` add `identify`), `MediaItemCard.tsx` (pass `identify` to `plugin.Card`), `shell/Shell.tsx` (~284, ~298), `Unmatched.tsx` (`UnmatchedProps` ~141, `UnmatchedDetail` Actions ~636, `UnmatchedRow`/feed plugin), `useFeedNames.ts` (value becomes `{ name: string; pluginId: string }`), `styles/library.css`
- Test: `packages/web/test/library/postIdentify.test.tsx` (new), `suggestCandidates.test.ts` (new, server runner, under `test/library/` but `.ts` — check which runner globs it; if the web glob is `*.test.tsx` only and the server glob covers `packages/*/test/**/*.test.ts`, it runs under the server runner), `Category.test.tsx`, `MediaItemCard.test.tsx`, `Unmatched.test.tsx`, `useFeedNames.test.tsx`, `shell/Shell.test.tsx`

**Interfaces:**
- Consumes: Task 3's `IdentifySubmit`, `Candidate`, `IdentifyOutcome`, `IDENTIFY_REFUSAL_MESSAGES`, `SUGGEST_LIMIT`; Task 2's route; `Store.listCatalog`, `getRows`, `normalizeTerm`.
- Produces: `postIdentify(rssItemId, request): Promise<IdentifyOutcome>`; `suggestCandidates(source: { listCatalog; getRows }, pluginId, term): Promise<readonly Candidate[]>`; `identifySubmit(store): IdentifySubmit` (binds both); `UnmatchedProps.identify: IdentifySubmit`.

- [ ] **Step 1: Write the failing tests**

`postIdentify.test.tsx` (pattern: `postRetry.test.tsx` with `fetchStub`/`jsonResponse`): URL `/api/releases/9/identify`, method POST, each of the three bodies serialised exactly; 202 `{accepted:true}` → `accepted`; 200 `{outcome:'linked',mediaItemId:4}` → `linked`; each refusal code; 401 → `expired`; rejected fetch → `offline`; `{error}` 500 → `unrecognised`; all sentences in `IDENTIFY_REFUSAL_MESSAGES` distinct.

`suggestCandidates.test.ts`: seed catalog records and `media_item` rows directly (as `useCatalogItems.test.tsx` does); `suggestCandidates(source, 'tv', 'Dune ')` normalises the term, returns at most `SUGGEST_LIMIT`, scoped to `tv`, `year` from `releaseDate.slice(0, 4)`, `null` when absent, titles in catalog order.

`Unmatched.test.tsx`: Actions shows `Edit` beside Retry once the feed row is known, not before (Review Focus 4: render with the `rss_item` seeded but no `rss_feed`; `Edit` absent; seed the feed; `Edit` appears); clicking Edit renders the combobox with the feed's plugin id (suggest stub records `pluginId`); Retry unchanged.

`useFeedNames.test.tsx`: the value carries `pluginId`. `Category.test.tsx`/`MediaItemCard.test.tsx`/`Shell.test.tsx`: `identify` plumbed (a throwing stub in tests; Shell wires the real one).

- [ ] **Step 2: Run and watch them fail** — FAIL.

- [ ] **Step 3: Implement**

`postIdentify.ts` mirrors `postRetry.ts`: `sendJson(`/api/releases/${String(rssItemId)}/identify`, { method: 'POST', body: request })`; `answered` with `body.accepted === true` → accepted; `isRecord(body) && body.outcome === 'linked' && typeof body.mediaItemId === 'number'` → linked; a known code (`new Set(IDENTIFY_RELEASE_REFUSALS)`) → refusal; else `unrecognised`.

`suggestCandidates.ts`:

```ts
export async function suggestCandidates(source: Pick<Store, 'listCatalog' | 'getRows'>, pluginId: string, raw: string): Promise<readonly Candidate[]> {
  const term = normalizeTerm(raw);
  if (term === '') return [];
  const records = await source.listCatalog({ pluginId, filter: 'all', term }, { limit: SUGGEST_LIMIT });
  const rows = await source.getRows('media_item', records.map((r) => r.id));
  return records.flatMap((r) => {
    const value = rows.get(r.id);
    if (!isMediaItem(value)) return [];
    const releaseDate = typeof value.releaseDate === 'string' && value.releaseDate.length >= 4 ? value.releaseDate.slice(0, 4) : null;
    return [{ mediaItemId: r.id, title: value.title, year: releaseDate }];
  });
}
export function identifySubmit(store: Pick<Store, 'listCatalog' | 'getRows'>): IdentifySubmit {
  return { identify: postIdentify, suggest: (pluginId, term) => suggestCandidates(store, pluginId, term) };
}
```

`Shell.tsx`: `const identify = useMemo(() => (store === undefined ? undefined : identifySubmit(store)), [store]);` and pass `identify={identify}` to `CategoryScreen` and `Unmatched` (both render nothing until `store` exists, so the prop is defined when used; type it as required on the screens and guard at the route as the `store === undefined ? null :` pattern already does). `Category.tsx` → `ItemList` → `MediaItemCard` → `plugin.Card`'s `identify`.

`useFeedNames.ts`: the map value becomes `{ name: string; pluginId: string }` (narrow both; a feed row missing either is skipped). `Unmatched.tsx`: `feedLabel` reads `.name`; `UnmatchedDetail` gets `feed: { name; pluginId } | undefined` and renders `Edit` only when `feed !== undefined`; Edit swaps Retry+Edit for `<IdentifyForm pluginId={feed.pluginId} rssItemId={row.id} identify={identify} onDone={…set awaiting on the row's updatedAt…} onCancel={…} />`. Update the docblocks that describe the hook's value and the Actions pair.

`library.css` (structural, no classes): `ul[aria-label='releases'] li > form, dl form { display: flex; flex-wrap: wrap; gap: var(--space-2); flex-basis: 100%; }`, `[role='combobox'] { min-width: 20rem; }`, `[role='listbox'] { list-style: none; margin: 0; padding: 0; border: 1px solid var(--color-line); }`, `[role='listbox'][hidden] { display: none; }`, `[role='option'] { padding: var(--space-1) var(--space-2); cursor: pointer; }`, `[role='option'][aria-selected='true'] { background: var(--color-accent-soft, var(--color-accent)); }`. Check `tokens.css` for the real colour/space tokens and use existing ones without fallbacks.

- [ ] **Step 4: Run, gate, commit** — exit 0.

```bash
git add -A packages && git commit -m "Wire Requery and Edit into the category pages and the unmatched card"
```

---

### Task 5: End to end, mutations, gate

- [ ] **Step 1: e2e spec** — `packages/e2e/tests/identify.spec.ts`, copying `claimInstall` from `shell.spec.ts`:

```ts
test('editing a release moves it to the chosen title and drops the title it left empty', async ({ page, harness }) => {
  await harness.seedPickableRelease({ pluginId: 'tv', title: 'A Show', filename: 'A.Show.S01E01.mkv', lookupState: 'resolved', withDownloadClient: false });
  harness.seedMediaItem('tv', 'B Show');
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();
  await page.getByRole('button', { name: 'A Show' }).click();
  await page.getByRole('button', { name: /^Edit A\.Show/ }).click();
  const box = page.getByRole('combobox', { name: 'Title' });
  await box.fill('B Show');
  await page.getByRole('option', { name: 'B Show' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'A Show' })).toHaveCount(0, { timeout: 15_000 });
  await page.getByRole('button', { name: 'B Show' }).click();
  await expect(page.getByText('A.Show.S01E01.mkv')).toBeVisible({ timeout: 15_000 });
});

test('requery on a matched release is accepted and the line says it is looking', async ({ page, harness }) => {
  await harness.seedPickableRelease({ pluginId: 'tv', title: 'A Show', filename: 'A.Show.S01E02.mkv', lookupState: 'resolved', withDownloadClient: false });
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await page.getByRole('button', { name: 'A Show' }).click();
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/identify')),
    page.getByRole('button', { name: /^Requery A\.Show/ }).click(),
  ]);
  expect(response.status()).toBe(202);
  await expect(page.getByText('Looking up…')).toBeVisible({ timeout: 15_000 });
});
```
Read `seedMediaItem`'s signature (sync, returns the id) and whether `seedPickableRelease` names the tv card `A Show` via a `tv_release` headline (`shell.spec.ts`'s pick spec clicks `getByRole('button', { name: 'A Show' })`, so yes). Keep each spec's step timeouts within the 90 s budget.

- [ ] **Step 2: Run the e2e suite** (`npm run e2e > /tmp/p6-e2e.log 2>&1; echo $?`; read the tail; delete).

- [ ] **Step 3: Mutations** (one at a time; `git checkout -- <file>` after; a mutant reddening nothing means a missing test — add it):

| Mutation | File | Covering tests |
|---|---|---|
| orphan check counts the moved release too (`> 1` → `> 0` inverted) so a non-orphan is dropped | `host/src/media/reassign.ts` | `reassign.test.ts` |
| `dropRows` called after `drop` | `host/src/media/reassign.ts` | `reassign.test.ts` (hook asserts the item still exists) |
| target `updated_at` bump removed | `host/src/media/reassign.ts` | `reassign.test.ts` |
| `names` ignored by the job | `openmetadata/src/engine.ts` | `engine-jobs.test.ts` |
| `onLookupRequest` omits `names` when hinted | `openmetadata/src/engine.ts` | `engine-jobs.test.ts` |
| `wrong-plugin` check removed | `host/src/media/identify.ts` | `identify.test.ts` |
| `already-linked` check removed | `host/src/media/identify.ts` | `identify.test.ts` |
| `isIdentifyBody` accepts an empty trimmed name | `host/src/api/request-shapes.ts` | `server.test.ts` |
| `aria-activedescendant` never set | `plugin-ui/src/IdentifyForm.tsx` | `IdentifyForm.test.tsx` |
| Save enabled when empty | `plugin-ui/src/IdentifyForm.tsx` | `IdentifyForm.test.tsx` |
| look-up option omitted | `plugin-ui/src/IdentifyForm.tsx` | `IdentifyForm.test.tsx` |
| stale-response guard removed | `plugin-ui/src/IdentifyForm.tsx` | `IdentifyForm.test.tsx` |
| Requery clears pending on 202 | `plugin-ui/src/ReleaseList.tsx` | `ReleaseList.test.tsx` |
| Unmatched renders Edit with no feed row | `web/src/library/Unmatched.tsx` | `Unmatched.test.tsx` |
| `suggestCandidates` ignores `pluginId` | `web/src/library/suggestCandidates.ts` | `suggestCandidates.test.ts` |

- [ ] **Step 4: Final gate** — `npm run check > /tmp/p6-final.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)" /tmp/p6-final.log; rm -f /tmp/p6-final.log` — exit 0, `fail 0`.

```bash
git add -A packages && git commit -m "Pin requery and manual edit end to end"
```

Nothing is pushed or merged.
