# Plugin-owned browse cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A plugin owns its browse card body, so a TV row can read
`Jo Jo's Bizarre Adventure S02E47 Dio's World(3)` without web knowing what a
season is.

**Architecture:** A new browser-only package `@pickarr/plugin-ui` holds the
`BrowserPlugin` contract and the shared presentational components. Each
plugin gains a `./browser` subpath export that imports nothing from node.
Web gains one registry, and its four hardcoded plugin lists derive from it.

**Tech Stack:** TypeScript, React 19, Vite (web), esbuild (packages),
`node:test` + `@testing-library/react` + happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-21-plugin-cards-design.md`

## Global Constraints

- **Never the `any` type.** Not in source, not in tests, not behind a cast.
- **No cast to silence a type error** — narrow with `in` guards, as
  `store/gather.ts` and `media/destinations.ts` do. Say so in your report if
  you think a cast is unavoidable.
- **No plugin id spelled in `packages/web/src` outside
  `src/plugins/registry.ts`.**
- **A plugin's browser module imports nothing from node.** Not `node:*`, not
  `@pickarr/openmetadata`, not the plugin's own `index.ts`.
- **Web's `src/` imports only a plugin's `/browser` subpath**, never its
  root. The root reaches `node:sqlite` and fails `npm run build`.
- `afterEach(cleanup)`; **never hand a live DOM element to `node:assert`'s
  equality helpers** — `scripts/check-test-hygiene.ts` fails the build on it.
  Use `assert.ok(!screen.queryByText(x), '…')` or `gone()` from
  `packages/web/test/dom.ts`.
- `t.mock.timers` hangs the web test run. Spy on the real timer instead.
- Prefer async APIs over sync twins; `await` inside `async`.
- Every number you write in a comment must be counted on the tree as it
  stands. Every precedent you cite must exist where you say it does.
- `tsconfig.base.json` sets `customConditions: ["development"]`,
  `verbatimModuleSyntax` and `erasableSyntaxOnly`. No package emits `.d.ts`;
  the `types` field in `exports` points at a file that never exists and
  nothing resolves it. Follow that pattern rather than fixing it here.

---

### Task 1: `@pickarr/plugin-ui`, and proof it reaches the browser

**Files:**
- Create: `packages/plugin-ui/package.json`
- Create: `packages/plugin-ui/tsconfig.json`
- Create: `packages/plugin-ui/src/plugin.ts`
- Create: `packages/plugin-ui/src/index.ts`
- Modify: root `package.json` (the `build` script's package order)
- Create: `packages/web/test/plugins/bundle.test.ts`

**Interfaces:**
- Produces: `BrowserPlugin`, `CardProps` from `@pickarr/plugin-ui`. Every
  later task consumes these.

- [ ] **Step 1: The package manifest.**

`packages/plugin-ui/package.json`:

```json
{
  "name": "@pickarr/plugin-ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "development": "./src/index.ts",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "esbuild src/index.ts --bundle --platform=browser --format=esm --packages=external --outfile=dist/index.js",
    "typecheck": "tsgo --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@pickarr/contract": "*"
  },
  "peerDependencies": {
    "react": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0"
  }
}
```

`packages/plugin-ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["es2023", "dom", "dom.iterable"],
    "jsx": "react-jsx",
    "types": ["node", "react"]
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts", "test/**/*.tsx"]
}
```

- [ ] **Step 2: The contract.**

`packages/plugin-ui/src/plugin.ts`:

```ts
import type { ComponentType } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';

/**
 * Replica rows for one media item, keyed by table name.
 *
 * `unknown`, for the reason `web/src/store/rows.ts` returns `unknown`: the
 * store does not know what shape any table holds, and a plugin's own
 * narrowing is where that knowledge belongs. A replica persists across
 * client builds, so a row written by one build is read against whatever the
 * next build's contract means -- narrow with `in` guards and decline a row
 * that does not match, never assert one.
 *
 * Every table the plugin declared is a key, with an empty array when the
 * item has no rows in it. A caller never has to distinguish "no rows" from
 * "table not fetched".
 */
export type PluginRows = Readonly<Record<string, readonly unknown[]>>;

export interface CardProps {
  /** The media item, already held by the list before anything is gathered. */
  readonly item: MediaItemSyncRead;
  /** This plugin's declared tables, for this item. See {@link PluginRows}. */
  readonly rows: PluginRows;
  /**
   * Releases and their downloads, or `undefined` until the card has
   * expanded and the gather has landed. A card renders its collapsed state
   * without this, which is what keeps a collapsed row free.
   */
  readonly gathered: GatheredItemView | undefined;
  /** Tells web to start gathering. Idempotent; call it when the card expands. */
  readonly onExpand: () => void;
  readonly submit: PickSubmit;
}

export interface BrowserPlugin {
  /** Matches `MediaItemSyncRead.pluginId` and the host plugin's id. */
  readonly id: string;
  /** What the nav, the heading and the route label call this category. */
  readonly label: string;
  /**
   * Replica tables this plugin's card reads. Web fetches exactly these and
   * hands them to `Card` as {@link PluginRows}; the plugin never touches
   * the store.
   */
  readonly tables: readonly string[];
  readonly Card: ComponentType<CardProps>;
}
```

`GatheredItemView` and `PickSubmit` are re-exported by Task 2, which moves
the types that define them. For this task, declare them as the two imports
that will exist and leave `index.ts` exporting only what is written here —
Task 2 completes the module.

- [ ] **Step 3: Write the failing bundle test.**

`packages/web/test/plugins/bundle.test.ts`. This is acceptance 5 and it is
the test that has to exist before anything depends on the seam, because it
is the only thing that catches a node import reaching the browser:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The production bundle carries no node import.
 *
 * **Asserted over the built artifact, not over the import graph**, because
 * the failure this catches is a build-time resolution that no unit test
 * sees: web's `src/` importing a plugin package's *root* entry instead of
 * its `/browser` subpath reaches `node:sqlite` through
 * `@pickarr/openmetadata` -> `drizzle-orm`. Measured before this seam
 * existed: that import fails `npm run build` outright.
 *
 * `node:l` appears in the baseline bundle as an incidental substring and is
 * not an import, so the assertion is on the import forms, not on the two
 * characters.
 */
test('the web bundle imports nothing from node', async () => {
  const dir = join(import.meta.dirname, '../../dist/assets');
  const names = await readdir(dir);
  const scripts = names.filter((name) => name.endsWith('.js'));
  assert.ok(scripts.length > 0, 'no built bundle -- run `npm run build -w @pickarr/web` first');

  for (const name of scripts) {
    const source = await readFile(join(dir, name), 'utf8');
    for (const forbidden of ['from"node:', "from'node:", 'require("node:', 'drizzle', 'DatabaseSync']) {
      assert.ok(!source.includes(forbidden), `${name} contains ${forbidden}`);
    }
  }
});
```

- [ ] **Step 4: Run it and watch it pass on the current tree.**

Run: `npm run build -w @pickarr/web && npx tsx --test packages/web/test/plugins/bundle.test.ts`
Expected: PASS. It must pass *before* the seam exists, so that a later
failure is the seam's doing and not a pre-existing condition.

- [ ] **Step 5: Prove it fails when the hazard is real.**

Temporarily add `import { TV_PLUGIN_ID } from '@pickarr/plugin-tv';` to
`packages/web/src/main.tsx`, add `@pickarr/plugin-tv` to web's
`dependencies`, and run `npm run build -w @pickarr/web`.
Expected: the **build** fails on `node:sqlite`. Record the exact message in
your report, then revert both edits.

This is the two-sided half. A test that only ever passes is not evidence.

- [ ] **Step 6: Add the package to the root build order.**

In the root `package.json`, the `build` script must build `@pickarr/plugin-ui`
after `@pickarr/contract` and before the three plugin packages.

- [ ] **Step 7: Gate and commit.**

Run: `npm install` (to link the new workspace), then `npm run check` and
`npm run build`.

```bash
git add packages/plugin-ui package.json package-lock.json packages/web/test/plugins/bundle.test.ts
git commit -S -m "Add @pickarr/plugin-ui, and pin that the web bundle stays node-free"
```

---

### Task 2: Move `ReleaseList` into `@pickarr/plugin-ui`, unchanged

**Files:**
- Create: `packages/plugin-ui/src/ReleaseList.tsx` (moved from web)
- Create: `packages/plugin-ui/src/types.ts`
- Modify: `packages/plugin-ui/src/index.ts`
- Delete: `packages/web/src/library/ReleaseList.tsx`
- Move: `packages/web/test/library/ReleaseList.test.tsx` →
  `packages/plugin-ui/test/ReleaseList.test.tsx`
- Modify: `packages/web/src/library/MediaItemCard.tsx` (import path only)
- Modify: root `package.json` (`test:web` glob)

**Interfaces:**
- Consumes: Task 1's `CardProps`.
- Produces: `ReleaseList`, `PickSubmit`, `PICK_REFUSAL_MESSAGES`,
  `GatheredItemView`, `GatheredRelease`, `GatheredDownload` from
  `@pickarr/plugin-ui`.

- [ ] **Step 1: Widen the web test glob first, so the moved tests run.**

In the root `package.json`, `test:web` changes from
`"packages/web/test/**/*.test.tsx"` to `"packages/*/test/**/*.test.tsx"`.

Run: `npm run test:web`
Expected: the same count as before the change (**266** at `2a2fde4`; count
it yourself rather than trusting this number). A different count means the
glob picked up something unintended — investigate before continuing.

- [ ] **Step 2: Move the view types.**

`ReleaseList` imports `GatheredDownload`, `GatheredItem` and
`GatheredRelease` from `web/src/store/gather.ts`, which is web's and stays
web's. Copy the three *shapes* into `packages/plugin-ui/src/types.ts` as the
view the seam promises, named `GatheredItemView`, `GatheredReleaseView`,
`GatheredDownloadView`, and have `web/src/store/gather.ts`'s types remain
the source by declaring in web a compile-time check that its `GatheredItem`
is assignable to the view:

```ts
// packages/web/src/store/gather.ts, at the end of the file
import type { GatheredItemView } from '@pickarr/plugin-ui';

/**
 * The gather satisfies the view the seam hands plugins.
 *
 * A type-level assertion and not a runtime one: `@pickarr/plugin-ui` must
 * not import web (web imports it), so the two shapes cannot be one
 * declaration. This line is what fails the build if they drift -- without
 * it, a field removed here would be a plugin's runtime `undefined`.
 */
const _viewIsSatisfied: GatheredItemView = null as unknown as GatheredItem;
void _viewIsSatisfied;
```

If the linter objects to the unused binding, export it instead of `void`-ing
it, and say which you chose in your report.

- [ ] **Step 3: Move the component and its tests verbatim.**

`git mv` both files. Change only the import specifiers — the component body,
its docblock and every assertion stay byte-identical. Web's
`MediaItemCard.tsx` imports `ReleaseList` from `@pickarr/plugin-ui`.

Add `@pickarr/plugin-ui` to web's `dependencies`.

- [ ] **Step 4: Run the moved tests.**

Run: `npm run test:web`
Expected: the same total as Step 1. A moved test that changed behaviour is a
failed move.

- [ ] **Step 5: Gate and commit.**

Run: `npm run check && npm run build && npm run e2e`

```bash
git commit -S -m "Move ReleaseList into @pickarr/plugin-ui, unchanged"
```

---

### Task 3: Hand a card its plugin rows

**Files:**
- Modify: `packages/web/src/store/gather.ts`
- Modify: `packages/web/src/library/useGatheredItem.ts`
- Modify: `packages/web/test/store/gather.test.ts`
- Modify: `packages/web/test/library/useGatheredItem.test.tsx`

**Interfaces:**
- Consumes: Task 1's `PluginRows`.
- Produces: `gatherMediaItem` additionally returns
  `pluginRows: PluginRows` for a caller-supplied table list;
  `useGatheredItem(source, mediaItemId, enabled, tables)`.

- [ ] **Step 1: Write the failing test.**

`gather.ts`'s `byMediaItem` already returns every row for a media item
across every table and discards what it does not recognise. That discard
becomes a partition.

```ts
test('the gather keeps rows from the tables a caller names, and still ignores the rest', async () => {
  const db = await freshDb();
  await seed(db, [
    mediaItemOp({ id: 7, pluginId: 'tv', title: "Dio's World(3)" }),
    pluginOp('tv_release', 1, { mediaItemId: 7, kind: 'episode', seriesTitle: 'JoJo', seriesRef: 'r', seasonNumber: 2, episodeNumber: 47 }),
    pluginOp('movie_detail', 2, { mediaItemId: 7, runtimeMinutes: 116, tagline: null }),
  ]);

  const gathered = await gatherMediaItem(db, 7, ['tv_release']);

  assert.equal(gathered?.pluginRows['tv_release']?.length, 1, 'the named table is carried');
  assert.ok(!('movie_detail' in (gathered?.pluginRows ?? {})), 'an unnamed table is not');
});

test('a named table with no rows is an empty array, not an absent key', async () => {
  const db = await freshDb();
  await seed(db, [mediaItemOp({ id: 7, pluginId: 'tv', title: 'x' })]);

  const gathered = await gatherMediaItem(db, 7, ['tv_release']);

  assert.deepEqual(gathered?.pluginRows['tv_release'], [], 'the key exists and is empty');
});
```

The second test is the one that matters: a card that has to distinguish
"no rows" from "not fetched" will get it wrong, and this is what stops the
distinction existing.

- [ ] **Step 2: Run them and watch them fail.**

Run: `npx tsx --test packages/web/test/store/gather.test.ts`
Expected: FAIL — `gatherMediaItem` takes two arguments.

- [ ] **Step 3: Implement the partition.**

`gatherMediaItem(db, mediaItemId, tables)` seeds `pluginRows` with an empty
array per entry of `tables`, then pushes each row from `byMediaItem` whose
table is in that set. **No new query**: this is the same single
`byMediaItem` read, partitioned instead of discarded. Say that in the
docblock, and say it in terms a reader can check.

- [ ] **Step 4: Thread it through the hook.**

`useGatheredItem` gains a fourth parameter, `tables: readonly string[]`, and
passes it down. The cache key stays `mediaItemId`: a card's table list is
fixed by its plugin and cannot vary for one id.

**Memoise the array at the call site, not here.** A fresh array literal per
render is a new dependency every render, and this hook's effect tears down
and rebuilds two subscriptions when its dependencies change. `BrowserPlugin.tables`
is a stable module-level value, so the call site already has one — but say
so in a comment where the dependency array is, because the next caller will
not know.

- [ ] **Step 5: Decide per-card versus per-page, by measuring.**

The spec leaves this open. A collapsed card needs `pluginRows`, which means
a `by_media_item` read per card on a page of N.

Measure both against a real `fake-indexeddb` replica seeded with 50 items:
count IndexedDB transactions for (a) one read per card, (b) one batched read
for the page passed down. Record both numbers in your report and implement
the one you measured as better. If they are within noise, take (a): it is
the smaller diff and matches the existing per-card poster request.

Do not skip the measurement and reason from first principles. This repo has
a measured case where a per-id read cost 4 transactions where a batched one
cost 1 (`useGatheredItem.ts`'s docblock).

- [ ] **Step 6: Gate and commit.**

Run: `npm run check`

```bash
git commit -S -m "Partition a media item's plugin rows out of the gather it already does"
```

---

### Task 4: `plugin-tv`'s card, and the headline

**Files:**
- Create: `packages/plugin-tv/src/browser.tsx`
- Create: `packages/plugin-tv/src/headline.ts`
- Create: `packages/plugin-tv/test/headline.test.ts`
- Create: `packages/plugin-tv/test/browser.test.tsx`
- Modify: `packages/plugin-tv/package.json`
- Modify: `packages/plugin-tv/tsconfig.json`

**Interfaces:**
- Consumes: `BrowserPlugin`, `CardProps`, `ReleaseList` from
  `@pickarr/plugin-ui`; `TvRead` from `@pickarr/contract`.
- Produces: `tvBrowser: BrowserPlugin` from `@pickarr/plugin-tv/browser`.

- [ ] **Step 1: Write the failing headline test.**

`packages/plugin-tv/test/headline.test.ts`, one case per row of spec §7.1:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TvRead } from '@pickarr/contract';
import { tvHeadline } from '../src/headline.ts';

function tv(over: Partial<TvRead>): TvRead {
  return { mediaItemId: 1, kind: 'episode', seriesTitle: 'Jo Jo’s Bizarre Adventure', seriesRef: 'r', seasonNumber: null, episodeNumber: null, ...over };
}

test('an episode with a season reads series, SxxEyy, then its own title', () => {
  const line = tvHeadline(tv({ seasonNumber: 2, episodeNumber: 47 }), "Dio's World(3)");
  assert.equal(line, "Jo Jo’s Bizarre Adventure S02E47 Dio's World(3)");
});

test('an episode with no season drops S and keeps E', () => {
  const line = tvHeadline(tv({ episodeNumber: 47 }), "Dio's World(3)");
  assert.equal(line, "Jo Jo’s Bizarre Adventure E47 Dio's World(3)");
});

test('a season pack has no episode number to show', () => {
  const line = tvHeadline(tv({ kind: 'season', seasonNumber: 2 }), 'Season 2');
  assert.equal(line, 'Jo Jo’s Bizarre Adventure S02 Season 2');
});

test('a series pack does not say its own name twice', () => {
  // `media_item.title` is the lookup document's `media.title`
  // (`openmetadata/src/engine.ts:141`), which for a series pack is the
  // series name. Without the equality check this reads the series title
  // twice, which is the case this rule exists for.
  const line = tvHeadline(tv({ kind: 'series' }), 'Jo Jo’s Bizarre Adventure');
  assert.equal(line, 'Jo Jo’s Bizarre Adventure');
});

test('numbers past two digits are padded, not truncated', () => {
  const line = tvHeadline(tv({ seasonNumber: 2, episodeNumber: 147 }), 'x');
  assert.equal(line, 'Jo Jo’s Bizarre Adventure S02E147 x');
});
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `npx tsx --test packages/plugin-tv/test/headline.test.ts`
Expected: FAIL — `../src/headline.ts` does not exist.

- [ ] **Step 3: Implement the rule.**

```ts
/** Two digits minimum, and never truncated: episode 147 is `E147`. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function tvHeadline(tv: TvRead, title: string): string {
  const number =
    (tv.seasonNumber === null ? '' : `S${pad(tv.seasonNumber)}`) +
    (tv.episodeNumber === null ? '' : `E${pad(tv.episodeNumber)}`);
  const parts = [tv.seriesTitle, number, title === tv.seriesTitle ? '' : title];
  return parts.filter((part) => part !== '').join(' ');
}
```

Note there is **no branch on `kind`**. Say why in the docblock: the three
kinds differ only in which numbers are null, and branching on `kind` would
be a second rule that could disagree with the data.

- [ ] **Step 4: Run it and watch it pass.**

Run: `npx tsx --test packages/plugin-tv/test/headline.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Mutate the rule and confirm each mutation reds.**

Run each, record the observed pass/fail counts in your report, and revert:

| mutation | must red |
|---|---|
| drop the `title === tv.seriesTitle` check | the series-pack test |
| `padStart(2,'0')` → `String(value)` | the padding tests |
| emit `S` even when `seasonNumber` is null | the no-season test |

A mutation that reds *everything* broke the code rather than changing one
behaviour — rewrite it (`CLAUDE.md`).

- [ ] **Step 6: The card.**

`packages/plugin-tv/src/browser.tsx` exports `tvBrowser`, declaring
`tables: ['tv_release']` and a `Card` that narrows one `tv_release` row with
an `in` guard (never a cast), renders `tvHeadline(...)` in the expander
button, and composes `ReleaseList` from `@pickarr/plugin-ui` when
`gathered` is present. An item with no `tv_release` row renders `item.title`
alone.

- [ ] **Step 7: Write the card's test.**

`packages/plugin-tv/test/browser.test.tsx`, with `afterEach(cleanup)`:
the headline renders in the button's accessible name; a card with no
`tv_release` row falls back to `item.title`; a malformed row (missing
`seriesTitle`) falls back rather than throwing; `onExpand` fires on click.

- [ ] **Step 8: Wire the package.**

`package.json` gains the `./browser` export, a second esbuild entry
(`--platform=browser`), a `react` peer dependency and `@types/react`.
`tsconfig.json` gains `jsx: react-jsx`, the dom libs, `react` in `types`,
and `**/*.tsx` in `include`.

- [ ] **Step 9: Gate and commit.**

Run: `npm run check && npm run build`

```bash
git commit -S -m "Give plugin-tv a browser card, and a headline that names the series and episode"
```

---

### Task 5: `plugin-movie` and `plugin-xxx` browser cards

Batched: these are the same mechanical change twice, and reviewing them as
one diff is what shows they are the same.

**Files:**
- Create: `packages/plugin-movie/src/browser.tsx`, `packages/plugin-movie/test/browser.test.tsx`
- Create: `packages/plugin-xxx/src/browser.tsx`, `packages/plugin-xxx/test/browser.test.tsx`
- Modify: both `package.json` and both `tsconfig.json`, exactly as Task 4
  Step 8 does for `plugin-tv`.

**Interfaces:**
- Produces: `movieBrowser`, `xxxBrowser`.

- [ ] **Step 1: Write both cards.**

Each renders `item.title` in the expander button and composes `ReleaseList`
— **the same output the current shared card produces**. `tables` is `[]` for
both: `MovieRead.runtimeMinutes`/`tagline` and `XxxRead.siteName` are out of
scope (spec §7.2), and declaring tables a card does not read would make the
gather fetch rows nothing uses.

Porting these two unchanged is what proves the seam is not TV-shaped. Do not
improve them while you are here.

- [ ] **Step 2: Write both tests.**

For each: the title renders in the button's accessible name, and `onExpand`
fires on click. Short, because the behaviour is short.

- [ ] **Step 3: Gate and commit.**

Run: `npm run check && npm run build`

```bash
git commit -S -m "Give plugin-movie and plugin-xxx browser cards, rendering what they render today"
```

---

### Task 6: The registry, and the four lists that derive from it

**Files:**
- Create: `packages/web/src/plugins/registry.ts`
- Modify: `packages/web/src/library/MediaItemCard.tsx`
- Modify: `packages/web/src/shell/Shell.tsx`
- Modify: `packages/web/src/shell/useCounts.ts`
- Delete: `packages/web/src/pluginLabels.ts`
- Delete: `packages/web/test/pluginLabels.test.tsx`
- Modify: `packages/web/package.json` (plugins move to `dependencies`)

**Interfaces:**
- Consumes: `tvBrowser`, `movieBrowser`, `xxxBrowser`.
- Produces: `BROWSER_PLUGINS`, and `pluginFor(id)`.

- [ ] **Step 1: The registry.**

```ts
import type { BrowserPlugin } from '@pickarr/plugin-ui';
import { tvBrowser } from '@pickarr/plugin-tv/browser';
import { movieBrowser } from '@pickarr/plugin-movie/browser';
import { xxxBrowser } from '@pickarr/plugin-xxx/browser';

/**
 * Every plugin the browser knows, in display order.
 *
 * **The one place in `packages/web/src` that names a plugin.** The category
 * routes, the nav, the counts and each card's body all derive from this
 * array; `test/plugins/registry.test.ts` fails if an id appears anywhere
 * else under `src/`.
 *
 * **Import the `/browser` subpath, never the package root.** A root import
 * reaches `node:sqlite` through `@pickarr/openmetadata` -> `drizzle-orm`
 * and fails `npm run build` -- not this typecheck, and not any unit test.
 * `test/plugins/bundle.test.ts` is what catches it.
 */
export const BROWSER_PLUGINS: readonly BrowserPlugin[] = [tvBrowser, movieBrowser, xxxBrowser];

export function pluginFor(id: string): BrowserPlugin | undefined {
  return BROWSER_PLUGINS.find((plugin) => plugin.id === id);
}
```

- [ ] **Step 2: Derive the four lists.**

- `useCounts.ts`: `Category` becomes `string`; `CATEGORIES` becomes
  `BROWSER_PLUGINS.map((p) => p.id)`; `Counts` becomes
  `Readonly<Record<string, number>>`; `ZERO_COUNTS` is built by reducing
  `CATEGORIES`, not written as a literal.
- `Shell.tsx`: the three literal `<Route>`s become one `.map` over
  `BROWSER_PLUGINS`; the nav's `pluginLabel(category)` becomes the
  registry's `label`.
- Delete `pluginLabels.ts` and its test. Its `Object.hasOwn` guard existed
  because an unmapped id reached a heading through an object literal's
  prototype; an array of objects has no such hazard. Say that in the commit
  message, so the deletion reads as a decision.

- [ ] **Step 3: `MediaItemCard` renders the plugin's card.**

It keeps the poster and the artwork `onError` fallback, looks the plugin up
by `item.pluginId`, and renders `plugin.Card`. An item whose `pluginId`
matches no registered plugin renders the poster and `item.title` — it must
not throw, and it must not render nothing.

- [ ] **Step 4: Write the no-plugin-ids test.**

`packages/web/test/plugins/registry.test.ts` — acceptance 7:

```ts
test('no plugin id is spelled in packages/web/src outside the registry', async () => {
  // The registry is the seam's whole point. A second place naming `tv`
  // makes adding a plugin two edits again, silently.
  const root = join(import.meta.dirname, '../../src');
  const offenders: string[] = [];
  for (const file of await sourceFiles(root)) {
    if (file.endsWith('plugins/registry.ts')) continue;
    const text = await readFile(file, 'utf8');
    for (const id of ['tv', 'movie', 'xxx']) {
      if (new RegExp(`['"\`]${id}['"\`]`).test(text)) offenders.push(`${file}: ${id}`);
    }
  }
  assert.deepEqual(offenders, [], 'a plugin id is spelled outside the registry');
});
```

If a legitimate offender exists (a route path that must stay literal, say),
do not weaken the test to a substring match — add a named, commented
exemption listing the file and why, so the exemption is reviewable.

- [ ] **Step 5: Run the whole web suite.**

Run: `npm run test:web`
Expected: pass. Tests naming `pluginLabel` are deleted with it; tests
asserting the three routes should pass unchanged, because the routes still
exist — they are merely derived now. A route test that fails means the
derivation changed behaviour.

- [ ] **Step 6: Prove the registry drives everything.**

Temporarily remove `xxxBrowser` from `BROWSER_PLUGINS` and run
`npm run test:web`. Acceptance 8 says its route, nav entry and count all
disappear together. Record which tests red, then restore it. If removing it
reds nothing, the derivation is not load-bearing and the task is not done.

- [ ] **Step 7: Gate and commit.**

Run: `npm run check && npm run build && npm run e2e`

```bash
git commit -S -m "Derive the routes, nav, counts and cards from one plugin registry"
```

---

### Task 7: Styling, the browser proof, and the two-sided pin

**Files:**
- Modify: `packages/web/src/styles/library.css` (or the plugin-owned
  equivalent you choose — say which and why)
- Modify: `packages/e2e/tests/shell.spec.ts`

- [ ] **Step 1: Make the card legible.**

The card body moved packages; its styling must still apply. Read
`CLAUDE.md`'s "getByRole and getByText cannot see whether a component is
legible" entry first: a component shipped with correct roles, ten passing
tests and no stylesheet rule, and the first person to use it reported
working software as broken. Style against the tokens; no raw values outside
`tokens.css`.

- [ ] **Step 2: The browser proof.**

Extend `packages/e2e/tests/shell.spec.ts` to assert a TV row renders
`Jo Jo's Bizarre Adventure S02E47 Dio's World(3)` — acceptance 1, on
rendered text. Use the existing harness's seeding; `boxOf` returns
**document** coordinates, so compare positions with it rather than with
`boundingBox()` directly.

Run `npm run e2e`, never `npx playwright test` from the root — a guard
blocks it because it would run against a stale bundle.

- [ ] **Step 3: The two-sided pin.**

Assert a computed style on the card with exactly one plausible producer, and
prove it both ways: the rule removed → reds; the stylesheet gutted → reds.
Run both mutations and report the **observed** output of each. A one-sided
pin is worthless; issue #90 is this repo's record of that.

- [ ] **Step 4: Gate and commit.**

Run: `npm run check && npm run build && npm run e2e`

```bash
git commit -S -m "Style the plugin cards and prove the TV headline in a real browser"
```

---

## Self-review

**Spec coverage.** §3 packages → Tasks 1, 2, 4, 5. §4 contract → Task 1.
§5 data → Task 3. §6 registry → Task 6. §7.1 TV → Task 4. §7.2 movie/xxx →
Task 5. §8 build/types/tests → Tasks 1, 2, 4, 5. Acceptance 1 → Task 7;
2 → Task 4; 3 → Task 4 Step 7; 4 → Task 5; 5 → Task 1; 6 → Task 1 Step 5;
7 → Task 6 Step 4; 8 → Task 6 Step 6; 9 → Task 7; 10 → every task's gate.

**Type consistency.** `BrowserPlugin`/`CardProps`/`PluginRows` are Task 1's
and are consumed by Tasks 3–6. `GatheredItemView` is Task 2's and is
referenced by Task 1's `CardProps` — Task 1 therefore cannot typecheck its
`CardProps` in isolation, which is why Task 1 Step 2 says Task 2 completes
the module. **An executor must not "fix" that by inlining a second
definition of the view in Task 1.**

**Ordering.** 1 → 2 → 3 → 4 → 5 → 6 → 7. Tasks 4 and 5 are independent of
each other and could run in parallel; both need 3. Task 6 needs 4 and 5.

**Known risks.**
- Task 6 is the only task that can break the production build without
  reddening a unit test. Its gate must include `npm run build`, and Task 1's
  bundle test is what catches it.
- Task 2 moves 269 lines of component and its tests across a package
  boundary. Any behavioural difference there is a failed move, not an
  improvement — the tests must be byte-identical but for imports.
- The web test glob widens in Task 2 Step 1. If the count changes, stop.
