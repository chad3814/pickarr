# Image Grid Browse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A List / Grid toggle on every category page; the grid shows one image per item, posters for films and backgrounds for television and adult, and a tile opens the item's card in a dialog.

**Architecture:** The catalog record gains the rank-0 `poster` and `background` row ids, picked from rows the recompute already reads, so a page of tiles costs no extra replica read. Each plugin declares which kind its tiles use. Web adds a grid component that lists through the catalog and a dialog lifted out of the gallery into `plugin-ui`; the list view is untouched.

**Tech Stack:** TypeScript, React 19, react-router 7, IndexedDB via fake-indexeddb in tests, node:test with `@testing-library/react`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-image-grid-browse-design.md`

## Global Constraints

- Never use the `any` type. Prefer async APIs over sync twins.
- A plugin id is never spelled in `packages/web/src` outside `plugins/registry.ts` (`test/plugins/registry.test.ts` fails the build). The grid reads `pluginFor(pluginId).tile`.
- `packages/web/src` imports a plugin's `/browser` subpath only, never its package root.
- `SCHEMA_VERSION` goes from 4 to 5, once, in Task 1. No in-place migration of the catalog: a bump wipes every store and the next start bootstraps.
- `BrowserPlugin.tile` is required and undefaulted. `CardProps.initiallyExpanded` is optional and defaults to `false`.
- Every web test file keeps `afterEach(cleanup)`. Never hand a live DOM node to `node:assert`; compare booleans (`assert.ok(node.contains(document.activeElement))`).
- A comment must be true of the code beside it. Every number a test pins is spelled literally at least once.
- Web tests run with: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test <file>`. Server-side store tests (`.ts`) run with: `node --import tsx --conditions development --test <file>`. plugin-ui tests are `.tsx` and use the web runner.
- `npm run check` is the gate before every commit that touches more than a test file. Never pipe `npm run e2e`; redirect to a file.
- The CSS keeps `library.css`'s convention: comments say what a rule is for; no plugin ships a stylesheet.

## Review Focus

Five inputs the spec implies but no acceptance test exercises directly, most likely to bite first. Each has its test in the owning task.

1. **A rank-0 image that 404s and is then replaced by a re-rank.** The tile must retry the new id rather than stay latched on the old failure. Task 6 pins it.
2. **A record whose image id points at a kind the plugin does not use.** A film record with a `background` but no `poster` must show the placeholder, not the background. Task 6 pins it.
3. **The open dialog's item leaving the page.** A filter change that drops the item, or a tombstone, must close the dialog and move focus to the grid list, not leave a dialog over a tile that no longer exists. Task 6 pins it.
4. **A view change with a search keystroke pending.** Like `setFilter`, `setView` must carry the pending text into the URL rather than drop it. Task 5 pins it.
5. **A tombstoned `background` that was rank-0 while a lower-ranked one remains.** The record must fall back to the survivor. Task 1 pins it.

---

### Task 1: The catalog record carries the rank-0 poster and background ids

**Files:**
- Modify: `packages/web/src/store/catalog.ts` (the `CatalogRecord` interface and `isCatalogRecord`)
- Modify: `packages/web/src/store/catalog-apply.ts` (`affectedMediaItems`, `recomputeOne`, module doc)
- Modify: `packages/web/src/store/db.ts:44` (`SCHEMA_VERSION`)
- Modify: `packages/web/test/store/db.test.ts:90` (the version pin)
- Modify: `packages/web/test/library/useCatalogItems.test.tsx` (the hand-built records in `seed` need the two fields)
- Modify: `packages/web/test/library/Category.test.tsx` (`markPicked` spreads an existing record, so it is unaffected; confirm)
- Test: `packages/web/test/store/catalog-apply.test.ts`

**Interfaces:**
- Produces: `CatalogRecord` with `poster: number | null` and `background: number | null`. `SCHEMA_VERSION === 5`. Nothing else changes shape.

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/test/store/catalog-apply.test.ts`, after the existing builders (the file already has `item`, `release`, `torrent`, `nzb`, `role`, `person`, `del`, `record`, `seed`-equivalent `applyBatch` calls, `CURSORS`, and `countingReleaseReads`):

```ts
/** A `poster`, `background` or `logo` row as the host replicates it: no `url`, no `path`. */
const artwork = (table: 'poster' | 'background' | 'logo', id: number, mediaItemId: number, rank: number): SyncOp =>
  ({ op: 'create', table, id, value: { id, mediaItemId, width: 10, height: 15, language: null, rank, createdAt: 1 } });

test('the record carries the rank-0 poster and background by rank then id, whatever order the batch came in', async () => {
  const db = await freshDb();
  await applyBatch(db, [
    artwork('poster', 22, 1, 0),
    artwork('background', 31, 1, 1),
    item(1, 'Show', null),
    artwork('poster', 20, 1, 1),
    artwork('poster', 21, 1, 0),
    artwork('background', 30, 1, 0),
    // Another item's rank-0 poster must not leak in.
    artwork('poster', 40, 2, 0),
    item(2, 'Other', null),
  ], CURSORS);
  const rec = await record(db, 1);
  assert.equal(rec?.poster, 21, 'rank 0, and the lower id of the two rank-0 posters');
  assert.equal(rec?.background, 30);
  assert.equal((await record(db, 2))?.poster, 40);
});

test('a record with no images carries null for both, and logos and people pictures never fill them', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'Show', null), artwork('logo', 50, 1, 0)], CURSORS);
  const rec = await record(db, 1);
  assert.equal(rec?.poster, null);
  assert.equal(rec?.background, null);
});

test('a better-ranked poster arriving later rewrites the record, and a tombstoned rank-0 background falls back to the survivor', async () => {
  const db = await freshDb();
  await applyBatch(db, [item(1, 'Show', null), artwork('poster', 20, 1, 1), artwork('background', 30, 1, 0), artwork('background', 31, 1, 1)], CURSORS);
  assert.equal((await record(db, 1))?.poster, 20);

  const later = await applyBatch(db, [artwork('poster', 21, 1, 0)], { since: 2, before: null });
  assert.deepEqual(later.catalog, [1], 'a poster op affects its item');
  assert.equal((await record(db, 1))?.poster, 21);

  await applyBatch(db, [del('background', 30)], { since: 3, before: null });
  assert.equal((await record(db, 1))?.background, 31, 'the rank-1 background is now the best there is');
});

test('an artwork-only batch recomputes the item without reading a single release (#108 holds)', async () => {
  const db = await freshDb();
  const releases = Array.from({ length: 20 }, (_, i) => release(100 + i, 1, `r${String(i)}.mkv`));
  await applyBatch(db, [item(1, 'Show', null), ...releases, torrent(500, 100)], CURSORS);
  const { reads } = await countingReleaseReads(() => applyBatch(db, [artwork('poster', 20, 1, 0)], { since: 2, before: null }));
  assert.equal(reads, 0, 'a poster cannot change picked, so the previous bit is carried');
  const rec = await record(db, 1);
  assert.equal(rec?.picked, 1);
  assert.equal(rec?.poster, 20);
});
```

In `packages/web/test/store/db.test.ts`, change the pin at line 90:

```ts
    assert.equal(SCHEMA_VERSION, 5, 'the current schema: the catalog record grew poster and background in phase 8');
```

In `packages/web/test/library/useCatalogItems.test.tsx`, the `seed` helper builds `CatalogRecord` literals; add the two fields so it compiles:

```ts
    const record: CatalogRecord = {
      id: item.id,
      pluginId: 'tv',
      updatedAt: item.updatedAt,
      picked: item.picked,
      haystack: item.title.toLowerCase(),
      poster: null,
      background: null,
    };
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --conditions development --test packages/web/test/store/catalog-apply.test.ts packages/web/test/store/db.test.ts`
Expected: the four new tests fail (`rec?.poster` is `undefined`), the version pin fails (`4 !== 5`). Also run `npx tsgo --noEmit -p tsconfig.test-web.json` and expect an error on the `CatalogRecord` literal in `useCatalogItems.test.tsx` until Step 3 lands.

- [ ] **Step 3: Implement**

`packages/web/src/store/catalog.ts`:

```ts
export interface CatalogRecord {
  id: number;
  pluginId: string;
  updatedAt: number;
  picked: 0 | 1;
  haystack: string;
  /** The item's rank-0 `poster` row id, ties by lowest id; `null` when the replica holds none. What a film's grid tile shows. */
  poster: number | null;
  /** The item's rank-0 `background` row id, same order; `null` when none. What a television or adult grid tile shows. */
  background: number | null;
}
```

and in `isCatalogRecord` add two conjuncts:

```ts
    && (value.poster === null || typeof value.poster === 'number')
    && (value.background === null || typeof value.background === 'number');
```

`packages/web/src/store/db.ts:44`: `export const SCHEMA_VERSION = 5;` and extend the constant's doc comment with one sentence: "5 added `poster` and `background` to the catalog record (phase 8); a bump wipes and bootstraps, so no record is ever read in the old shape."

`packages/web/src/store/catalog-apply.ts`, in `affectedMediaItems`, add a case beside `'role'`:

```ts
      case 'poster':
      case 'background':
        // An image arriving, re-ranking or leaving changes which row the
        // tile shows and nothing else: no download moved, so the hint
        // stays empty and the recompute carries `picked`.
        for (const v of [next, previous]) { const m = numberField(v, 'mediaItemId'); if (m !== undefined) hint(m); }
        break;
```

In `recomputeOne`, after `const roles = ...`, add:

```ts
  const bestOf = (table: 'poster' | 'background'): number | null => {
    const best = linked
      .filter((r) => r.table === table)
      .map((r) => ({ id: r.id, rank: numberField(r.value, 'rank') }))
      .filter((r): r is { id: number; rank: number } => r.rank !== undefined)
      .sort((a, b) => a.rank - b.rank || a.id - b.id)[0];
    return best === undefined ? null : best.id;
  };
```

and extend the record literal:

```ts
  const record: CatalogRecord = {
    id, pluginId, updatedAt, picked, haystack: buildHaystack(parts),
    poster: bestOf('poster'), background: bestOf('background'),
  };
```

Update the module doc's table list ("Only six tables matter here") to eight, naming `poster` and `background`, and the cost sentence: "The haystack costs two reads per affected item plus one per role with a person id, and the two image ids come from the first of those reads." Also update the doc comment on `PickedHint`'s `full` field if it enumerates the affecting tables (it does not; leave it).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --conditions development --test packages/web/test/store/catalog-apply.test.ts packages/web/test/store/db.test.ts packages/web/test/store/catalog.test.ts` and the web runner on `packages/web/test/library/useCatalogItems.test.tsx packages/web/test/library/Category.test.tsx`.
Expected: all pass.

- [ ] **Step 5: Mutation check**

Swap `poster: bestOf('poster'), background: bestOf('background')` to `poster: bestOf('background'), background: bestOf('poster')`: the first test reds. Change `a.rank - b.rank` to `b.rank - a.rank`: the first and third red. Remove the new `case 'poster': case 'background':`: the third reds on `later.catalog`. Restore before Step 6.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/store packages/web/test/store packages/web/test/library/useCatalogItems.test.tsx
git commit -m "Carry the rank-0 poster and background ids on the catalog record, bumping the replica schema to 5"
```

---

### Task 2: `useCatalogItems` hands back the page's records

**Files:**
- Modify: `packages/web/src/library/useCatalogItems.ts`
- Test: `packages/web/test/library/useCatalogItems.test.tsx`

**Interfaces:**
- Consumes: `CatalogRecord` from Task 1.
- Produces: `export interface CatalogItemsResult extends MediaItemsResult { records: ReadonlyMap<number, CatalogRecord> }`, returned by `useCatalogItems`. `records` holds every record whose item is in `items`, keyed by item id, and is replaced on every window reload and page append.

- [ ] **Step 1: Write the failing test**

Append to `packages/web/test/library/useCatalogItems.test.tsx` (the file has `seed(db, items)`, a `Probe`-style render helper, and `source` construction already; follow its existing first test's pattern for rendering a hook):

```ts
test('the result carries the page\'s catalog records keyed by item id, so a caller has the image ids without another read', async () => {
  const db = await freshDb();
  await seed(db, [
    { id: 1, title: 'Alpha', updatedAt: 10, picked: 0 },
    { id: 2, title: 'Beta', updatedAt: 20, picked: 1 },
  ]);
  // Give one record an image, straight into the store, the way the catalog phase would.
  const tx = db.transaction('catalog', 'readwrite');
  const current = await request<CatalogRecord | undefined>(tx.objectStore('catalog').get(2));
  if (current === undefined) throw new Error('seed wrote no record 2');
  tx.objectStore('catalog').put({ ...current, poster: 77 });
  await done(tx);

  let seen: ReadonlyMap<number, CatalogRecord> | undefined;
  function RecordsProbe(): ReactElement {
    const result = useCatalogItems(sourceFor(db), { pluginId: 'tv', filter: 'all', term: '' });
    seen = result.records;
    return <output>{result.items.map((item) => item.id).join(',')}</output>;
  }
  render(<RecordsProbe />);
  await waitFor(() => { assert.equal(screen.getByRole('status').textContent, '2,1'); });

  assert.deepEqual([...(seen?.keys() ?? [])].toSorted(), [1, 2]);
  assert.equal(seen?.get(2)?.poster, 77);
  assert.equal(seen?.get(1)?.poster, null);
});
```

If the file names its source builder differently from `sourceFor`, use its name; add `import { request } from '../../src/store/idb.ts';` if absent.

- [ ] **Step 2: Run the test to verify it fails**

Run the web runner on `packages/web/test/library/useCatalogItems.test.tsx`.
Expected: FAIL, `result.records` is `undefined` (typecheck also fails on the property).

- [ ] **Step 3: Implement**

In `packages/web/src/library/useCatalogItems.ts`:

```ts
/** `MediaItemsResult` plus the catalog records behind the items, keyed by item id -- the grid reads its image ids from these. */
export interface CatalogItemsResult extends MediaItemsResult {
  records: ReadonlyMap<number, CatalogRecord>;
}

/** `records`' media items in catalog order, and the records themselves by id; a record with no usable `media_item` row contributes to neither. */
async function resolveItems(
  source: CatalogItemsSource,
  records: readonly CatalogRecord[],
): Promise<{ items: readonly MediaItemSyncRead[]; records: ReadonlyMap<number, CatalogRecord> }> {
  const rows = await source.getRows('media_item', records.map((record) => record.id));
  const items: MediaItemSyncRead[] = [];
  const byId = new Map<number, CatalogRecord>();
  for (const record of records) {
    const value = rows.get(record.id);
    if (!isMediaItem(value)) continue;
    items.push(value);
    byId.set(record.id, record);
  }
  return { items, records: byId };
}
```

Change the hook's signature to return `CatalogItemsResult`, add `const [records, setRecords] = useState<ReadonlyMap<number, CatalogRecord>>(new Map());`, reset it alongside `setItems([])`, and at both resolve sites:

```ts
      const resolved = await resolveItems(source, records);
      if (cancelled) return;
      windowGenerationRef.current += 1;
      setItems(resolved.items);
      setRecords(resolved.records);
```

```ts
        const more = await resolveItems(source, records);
        if (generation !== windowGenerationRef.current) return;
        setItems((current) => [...current, ...more.items]);
        setRecords((current) => new Map([...current, ...more.records]));
```

Return `{ items, records, loadMore, done, empty: ... }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the web runner on `packages/web/test/library/useCatalogItems.test.tsx packages/web/test/library/Category.test.tsx`.
Expected: all pass (`Category` passes the result to `ItemList`, which ignores `records`).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/library/useCatalogItems.ts packages/web/test/library/useCatalogItems.test.tsx
git commit -m "Return the page's catalog records from useCatalogItems, keyed by item id"
```

---

### Task 3: The plugin seam: `tile`, `initiallyExpanded`

**Files:**
- Modify: `packages/plugin-ui/src/plugin.ts` (`BrowserPlugin`, `CardProps`)
- Modify: `packages/plugin-ui/src/expansion.tsx` (`useExpansion`)
- Modify: `packages/plugin-movie/src/browser.tsx:77-78,95-100`, `packages/plugin-tv/src/browser.tsx:155-156,177-182`, `packages/plugin-xxx/src/browser.tsx:61-62,95-100`
- Modify: `packages/web/src/library/MediaItemCard.tsx`
- Test: `packages/plugin-ui/test/expansion.test.tsx` (create if absent; check `ls packages/plugin-ui/test`), `packages/web/test/plugins/registry.test.ts`, `packages/web/test/library/MediaItemCard.test.tsx`

**Interfaces:**
- Produces: `BrowserPlugin.tile: 'poster' | 'background'` (required); `CardProps.initiallyExpanded?: boolean`; `useExpansion(onExpandedChange, initiallyExpanded = false)`; `MediaItemCardProps.initiallyExpanded?: boolean`. Film is `'poster'`; television and adult are `'background'`.

- [ ] **Step 1: Write the failing tests**

In `packages/web/test/plugins/registry.test.ts`, extend the test at line 198 ("the registry holds the three shipped plugins...") or add beside it:

```ts
test('each plugin declares the image kind its grid tiles show: posters for film, backgrounds for television and adult', () => {
  assert.deepEqual(
    BROWSER_PLUGINS.map((plugin) => [plugin.id, plugin.tile]),
    [['tv', 'background'], ['movie', 'poster'], ['xxx', 'background']],
  );
});
```

In `packages/plugin-ui/test/expansion.test.tsx` (create with `afterEach(cleanup)` and the usual imports if it does not exist):

```tsx
test('useExpansion starts closed unless told otherwise, and reports the first toggle either way', () => {
  const seen: boolean[] = [];
  function Probe({ initiallyExpanded }: { initiallyExpanded?: boolean }): ReactElement {
    const { expanded, toggle } = useExpansion((next) => { seen.push(next); }, initiallyExpanded);
    return <button type="button" aria-pressed={expanded} onClick={toggle}>toggle</button>;
  }
  render(<Probe />);
  assert.equal(screen.getByRole('button').getAttribute('aria-pressed'), 'false', 'closed by default');
  cleanup();
  render(<Probe initiallyExpanded />);
  const button = screen.getByRole('button');
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'open when asked');
  fireEvent.click(button);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(seen, [false], 'the toggle reports the new state; opening on mount is not a change');
});
```

In `packages/web/test/library/MediaItemCard.test.tsx`, find how an existing test renders the card with a fake `GatheredSource` (its `gatherMediaItem` stub) and add:

```tsx
test('a card asked to open expanded gathers on mount, before anyone clicks', async () => {
  let gathers = 0;
  const source: GatheredSource = {
    gatherMediaItem: () => { gathers += 1; return Promise.resolve(undefined); },
    subscribe: () => () => {},
  };
  render(<MediaItemCard source={source} item={ITEM} rows={{}} submit={acceptsPick} identify={throwsOnUse} initiallyExpanded />);
  await waitFor(() => { assert.equal(gathers, 1); });
});
```

Reuse that file's own `ITEM`, `acceptsPick` and `throwsOnUse` names (check them; the file's existing tests define equivalents). If `GatheredSource` requires more members, satisfy them the way the file's other tests do.

- [ ] **Step 2: Run the tests to verify they fail**

Run `npx tsgo --noEmit -p packages/plugin-ui/tsconfig.json` and the web runner on the three test files.
Expected: typecheck errors on `plugin.tile` and `initiallyExpanded`; the registry test fails on `undefined` tiles.

- [ ] **Step 3: Implement**

`packages/plugin-ui/src/plugin.ts`, in `BrowserPlugin` after `tables`:

```ts
  /**
   * Which image a grid tile shows for this plugin's items (design spec
   * 2026-10-04 §2.1): the item's rank-0 poster or its rank-0 background.
   * Required and undefaulted, so a plugin added later renders the grid
   * someone chose for it rather than whichever kind a default picked.
   */
  readonly tile: 'poster' | 'background';
```

In `CardProps` after `onExpandedChange`:

```ts
  /**
   * Open with the detail section showing. The grid's dialog sets this
   * (§2.2); the list never does. `useExpansion` takes it as its starting
   * state, so the heading is still a toggle afterwards.
   */
  readonly initiallyExpanded?: boolean;
```

`packages/plugin-ui/src/expansion.tsx`:

```ts
export function useExpansion(onExpandedChange: (expanded: boolean) => void, initiallyExpanded = false): Expansion {
  const [expanded, setExpanded] = useState(initiallyExpanded);
```

Each plugin's card destructures `initiallyExpanded` and passes it: `const { expanded, toggle } = useExpansion(onExpandedChange, initiallyExpanded);` with `initiallyExpanded` added to the destructured `CardProps` in `MovieCard`, `TvCard`, `XxxCard`. Each `*Browser` literal gains `tile: 'poster'` (movie) or `tile: 'background'` (tv, xxx).

`packages/web/src/library/MediaItemCard.tsx`:

```ts
export interface MediaItemCardProps {
  source: GatheredSource;
  item: MediaItemSyncRead;
  rows: PluginRows;
  submit: PickSubmit;
  identify: IdentifySubmit;
  /** Open expanded, gathering on mount: what the grid's dialog asks for (design spec 2026-10-04 §3.4). */
  initiallyExpanded?: boolean;
}

export function MediaItemCard({ source, item, rows, submit, identify, initiallyExpanded = false }: MediaItemCardProps): ReactElement {
  const [expanded, setExpanded] = useState(initiallyExpanded);
```

and pass `initiallyExpanded={initiallyExpanded}` to `<plugin.Card ... />`.

- [ ] **Step 4: Run the tests to verify they pass**

Run `npm run typecheck` and the web runner on `packages/plugin-ui/test packages/web/test/plugins packages/web/test/library/MediaItemCard.test.tsx` (glob the directories' `*.test.tsx`).
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-ui/src packages/plugin-ui/test packages/plugin-movie/src/browser.tsx packages/plugin-tv/src/browser.tsx packages/plugin-xxx/src/browser.tsx packages/web/src/library/MediaItemCard.tsx packages/web/test
git commit -m "Let a plugin declare its grid tile's image kind, and a card open expanded"
```

---

### Task 4: `Dialog`, lifted out of `Gallery`

**Files:**
- Create: `packages/plugin-ui/src/Dialog.tsx`
- Modify: `packages/plugin-ui/src/Gallery.tsx`
- Modify: `packages/plugin-ui/src/index.ts` (export `Dialog`, `DialogProps`)
- Modify: `packages/web/src/styles/library.css:726-740` (`.gallery-backdrop` → `.dialog-backdrop`)
- Modify: any e2e spec or test that names `.gallery-backdrop` (`grep -rn gallery-backdrop packages/` and rename)
- Create: `packages/plugin-ui/test/Dialog.test.tsx`
- Modify: `packages/plugin-ui/test/Gallery.test.tsx` (the four dialog-behaviour tests move)

**Interfaces:**
- Produces:
  ```ts
  export interface DialogProps {
    readonly label?: string;        // aria-label, for a dialog with no visible heading
    readonly labelledBy?: string;   // aria-labelledby, for one with a heading
    readonly className: string;     // the panel's class; the backdrop is always `dialog-backdrop`
    readonly onClose: () => void;
    /** Keys other than Escape and Tab, which Dialog handles itself. */
    readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
    readonly children: ReactNode;
  }
  export function Dialog(props: DialogProps): ReactElement
  ```
  Behaviour: focus moves to the panel on mount and returns to the previously focused element on unmount if it is still in the document; backdrop click and Escape call `onClose`; Tab and Shift+Tab wrap inside the panel; clicks inside do not reach the backdrop.

- [ ] **Step 1: Move the behaviour tests and write Dialog's**

Create `packages/plugin-ui/test/Dialog.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Dialog } from '../src/Dialog.tsx';

afterEach(cleanup);

function noop(): void {}

test('a dialog is labelled by its label, is modal, and moves focus in when it opens', () => {
  render(<Dialog label="Severance" className="item-dialog" onClose={noop}><button type="button">Close</button></Dialog>);
  const dialog = screen.getByRole('dialog', { name: 'Severance' });
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(dialog.contains(document.activeElement), 'focus is inside the dialog');
});

test('Escape and a backdrop click close it; a click inside does not', () => {
  let closed = 0;
  const { container } = render(<Dialog label="x" className="item-dialog" onClose={() => { closed += 1; }}><button type="button">Inside</button></Dialog>);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  assert.equal(closed, 1, 'Escape asked to close');
  fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
  assert.equal(closed, 1, 'a click inside stays inside');
  const backdrop = container.querySelector('.dialog-backdrop');
  assert.ok(backdrop instanceof HTMLElement, 'the backdrop is a real element with the class the stylesheet keys on');
  fireEvent.click(backdrop);
  assert.equal(closed, 2, 'the backdrop closes');
});

test('Tab wraps within the dialog, and Shift+Tab wraps the other way', () => {
  render(<Dialog label="x" className="item-dialog" onClose={noop}><button type="button">Close</button></Dialog>);
  const closeButton = screen.getByRole('button', { name: 'Close' });
  closeButton.focus();
  const tabNotCancelled = fireEvent.keyDown(closeButton, { key: 'Tab' });
  assert.equal(tabNotCancelled, false, 'Tab from the last (and only) element was intercepted, not left to default traversal');
  assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus is still inside the dialog after Tab');
  const shiftTabNotCancelled = fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
  assert.equal(shiftTabNotCancelled, false, 'Shift+Tab from the first (and only) element was intercepted, not left to default traversal');
  assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus is still inside the dialog after Shift+Tab');
});

test('closing returns focus to the control that opened it', () => {
  function Harness({ open }: { open: boolean }): ReactElement {
    return (
      <div>
        <button type="button">Open</button>
        {open && <Dialog label="x" className="item-dialog" onClose={noop}><button type="button">Close</button></Dialog>}
      </div>
    );
  }
  const { rerender } = render(<Harness open={false} />);
  const openButton = screen.getByRole('button', { name: 'Open' });
  openButton.focus();
  rerender(<Harness open />);
  assert.ok(screen.getByRole('dialog').contains(document.activeElement), 'focus moved in');
  rerender(<Harness open={false} />);
  assert.ok(openButton.contains(document.activeElement) || document.activeElement === openButton, 'focus is back on the opener');
});

test('other keys reach the caller, so a gallery can walk with the arrows', () => {
  const keys: string[] = [];
  render(<Dialog label="x" className="gallery" onClose={noop} onKeyDown={(event) => { keys.push(event.key); }}><button type="button">Close</button></Dialog>);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  assert.deepEqual(keys, ['ArrowRight'], 'Escape is the dialog\'s own and is not forwarded');
});
```

In `packages/plugin-ui/test/Gallery.test.tsx`, delete the tests `Escape closes the gallery`, `focus moves into the gallery when it opens`, `Tab wraps within the dialog, and Shift+Tab wraps the other way`, and `closing the gallery returns focus to the control that opened it` (they now live in `Dialog.test.tsx`), and keep every other gallery test unchanged. Keep `the arrow keys walk the set too` since that is the gallery's own.

- [ ] **Step 2: Run the tests to verify they fail**

Run the web runner on `packages/plugin-ui/test/Dialog.test.tsx`.
Expected: FAIL, module `../src/Dialog.tsx` not found.

- [ ] **Step 3: Implement `Dialog` and refit `Gallery`**

`packages/plugin-ui/src/Dialog.tsx`:

```tsx
/**
 * A modal dialog: a backdrop that closes on click, a panel with
 * `role="dialog"` and `aria-modal`, focus moved in on open and returned to
 * the opener on close, Escape, and a Tab trap. Lifted out of `Gallery`
 * (design spec 2026-10-04 §2.3) so the gallery and the grid's item dialog
 * share one implementation rather than two drifting copies.
 *
 * The caller styles the panel through `className` -- `library.css` has a
 * rule per dialog kind -- and the backdrop is always `dialog-backdrop`, the
 * one rule they share. A dialog that is merely in the accessibility tree
 * renders as an unstyled block (CLAUDE.md's IdentityChangeConfirm entry),
 * which is why the class is part of the contract and not decoration.
 */
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

export interface DialogProps {
  readonly label?: string;
  readonly labelledBy?: string;
  readonly className: string;
  readonly onClose: () => void;
  /** Receives every key except Escape and Tab, which the dialog handles itself. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Dialog({ label, labelledBy, className, onClose, onKeyDown, children }: DialogProps): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus moves in on open so Escape and Tab reach the dialog rather than
  // the page behind the backdrop, and goes back to the opener on close if
  // the opener is still in the document.
  useEffect(() => {
    const opener = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') {
      onKeyDown?.(event);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={handleKeyDown}
        onClick={(event) => { event.stopPropagation(); }}
      >
        {children}
      </div>
    </div>
  );
}
```

`packages/plugin-ui/src/Gallery.tsx`: remove `FOCUSABLE_SELECTOR`, `dialogRef`, the focus effect and the Tab/Escape branches of `handleKeyDown`, keeping only the arrow handling:

```tsx
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      step(event.key === 'ArrowRight' ? 1 : -1);
    }
  }

  return (
    <Dialog labelledBy={headingId} className="gallery" onClose={onClose} onKeyDown={handleKeyDown}>
      <h2 id={headingId}>{current.caption}</h2>
      {/* ...the img, controls and Close button exactly as before... */}
    </Dialog>
  );
```

Keep the gallery's module and inline comments true: the comment about focus moving in and the trap now points at `Dialog`.

`packages/plugin-ui/src/index.ts`: add `export { Dialog } from './Dialog.tsx'; export type { DialogProps } from './Dialog.tsx';`.

`packages/web/src/styles/library.css`: rename the `.gallery-backdrop` selector to `.dialog-backdrop` and reword its comment: "Every dialog's backdrop (`plugin-ui`'s `Dialog`): a real overlay, because a dialog that is merely in the accessibility tree renders as an unstyled block of text -- see the IdentityChangeConfirm entry in CLAUDE.md. The panel inside is styled per kind: `.gallery` below, `.item-dialog` in the grid section." Run `grep -rn "gallery-backdrop" packages/ --include='*.ts' --include='*.tsx' --include='*.css'` and rename every hit.

- [ ] **Step 4: Run the tests to verify they pass**

Run the web runner on `packages/plugin-ui/test/Dialog.test.tsx packages/plugin-ui/test/Gallery.test.tsx`, then `npm run check`.
Expected: all pass; the gallery's own tests are unchanged and green.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-ui packages/web/src/styles/library.css packages/e2e
git commit -m "Lift the gallery's dialog into a shared Dialog with the focus trap, Escape and backdrop"
```

---

### Task 5: `view` in the URL and a View control

**Files:**
- Modify: `packages/web/src/library/useBrowseQuery.ts`
- Modify: `packages/web/src/library/BrowseControls.tsx`
- Test: `packages/web/test/library/useBrowseQuery.test.tsx`, `packages/web/test/library/BrowseControls.test.tsx`

**Interfaces:**
- Produces: `export type BrowseView = 'list' | 'grid'`; `export function parseView(raw: string | null): BrowseView`; `BrowseQuery.view: BrowseView`; `BrowseQueryControls.view: BrowseView` and `setView(v: BrowseView): void`; `BrowseControlsProps.view: BrowseView` and `onView(v: BrowseView): void`. `list` writes no `view` param.

- [ ] **Step 1: Write the failing tests**

In `packages/web/test/library/useBrowseQuery.test.tsx`, extend `Probe` with `<output data-testid="view">{query.view}</output>` and two buttons `set-grid` / `set-list` calling `controls.setView('grid')` / `controls.setView('list')`; then add:

```tsx
test('view is read from the URL, anything unrecognised reads as list, and list writes no param', () => {
  renderAt('/tv?view=grid&filter=picked');
  assert.equal(text('view'), 'grid');
  fireEvent.click(screen.getByRole('button', { name: 'set-list' }));
  assert.equal(text('search'), '?filter=picked', 'list is the default and is not spelled');
  assert.equal(text('nav'), 'REPLACE');
  cleanup();
  renderAt('/tv?view=mosaic');
  assert.equal(text('view'), 'list');
});

test('switching the view keeps the filter and the search, including a keystroke still pending', async () => {
  renderAt('/tv?filter=unpicked');
  fireEvent.click(screen.getByRole('button', { name: 'type-dune' }));
  fireEvent.click(screen.getByRole('button', { name: 'set-grid' }));
  assert.equal(text('search'), '?filter=unpicked&q=dune&view=grid', 'the pending text travelled with the view change, as it does with a filter change');
  assert.equal(text('view'), 'grid');
  await waitFor(() => { assert.equal(text('q'), 'dune'); });
});
```

In `packages/web/test/library/BrowseControls.test.tsx`, extend `setup` to pass `view` and collect `views` through `onView`, then add:

```tsx
test('a View group with List and Grid radios, checked by the view, each firing onView', () => {
  const { views } = setup('all', '', 'grid');
  const group = screen.getByRole('group', { name: 'View' });
  const list = within(group).getByRole('radio', { name: 'List' });
  const grid = within(group).getByRole('radio', { name: 'Grid' });
  assert.equal(grid instanceof HTMLInputElement && grid.checked, true);
  assert.equal(list.getAttribute('name'), 'view', 'its own radio group, so it cannot steal the Show group\'s selection');
  fireEvent.click(list);
  assert.deepEqual(views, ['list']);
});
```

Import `within` from `@testing-library/react`.

- [ ] **Step 2: Run the tests to verify they fail**

Run the web runner on the two files. Expected: typecheck/compile failures on `query.view`, `controls.setView`, the `view` prop.

- [ ] **Step 3: Implement**

`packages/web/src/library/useBrowseQuery.ts`:

```ts
/** The two ways a category page shows its result (design spec 2026-10-04 §3.1). `list` is the default and is never written to the URL. */
export type BrowseView = 'list' | 'grid';

export function parseView(raw: string | null): BrowseView {
  return raw === 'grid' ? 'grid' : 'list';
}
```

Add `view: BrowseView` to `BrowseQuery`, and `view: BrowseView; setView(v: BrowseView): void;` to `BrowseQueryControls`. `paramsFor(filter, q, view)` sets `view` only when `view !== 'list'`. In the hook: `const view = parseView(params.get('view'));`, a `viewRef` mirroring `filterRef`, `write(nextFilter, nextQ, nextView)`, `setFilter` passes `viewRef.current`, `setInputDebounced` passes `viewRef.current` at both write sites, and:

```ts
  const setView = useCallback(
    (v: BrowseView) => {
      // The same shape as `setFilter`: a keystroke still in its debounce
      // travels with the change rather than being dropped on the floor.
      let nextQ = q;
      if (timer.current !== undefined) {
        clearTimeout(timer.current);
        timer.current = undefined;
        nextQ = pendingQ.current;
      }
      write(filterRef.current, nextQ, v);
    },
    [write, q],
  );
```

Return `query: { filter, q, term: normalizeTerm(q), view }` and `controls: { filter, input, view, setFilter, setInput: setInputDebounced, setView }`. Update the module doc's URL example to `?view=grid&filter=unpicked&q=dune`.

`packages/web/src/library/BrowseControls.tsx`: props gain `view: BrowseView; onView(v: BrowseView): void;`, and after the Show fieldset:

```tsx
      <fieldset>
        <legend>View</legend>
        {VIEWS.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name="view"
              value={option.value}
              checked={view === option.value}
              onChange={() => { onView(option.value); }}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
```

with `const VIEWS: ReadonlyArray<{ value: BrowseView; label: string }> = [{ value: 'list', label: 'List' }, { value: 'grid', label: 'Grid' }];`.

`Category.tsx` must pass `view={controls.view} onView={controls.setView}` for the build to compile; do that here (one line), the view switch itself is Task 7.

- [ ] **Step 4: Run the tests to verify they pass**

Run the web runner on `packages/web/test/library/useBrowseQuery.test.tsx packages/web/test/library/BrowseControls.test.tsx packages/web/test/library/Category.test.tsx`.
Expected: all pass.

- [ ] **Step 5: Mutation check**

In `paramsFor`, write `view` unconditionally: the first test reds on `?filter=picked`. In `setView`, drop the pending-keystroke branch: the second test reds. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/library/useBrowseQuery.ts packages/web/src/library/BrowseControls.tsx packages/web/src/library/Category.tsx packages/web/test/library
git commit -m "Carry the browse view in the URL, list by default, with a View control beside Show and Search"
```

---

### Task 6: `ItemGrid`: tiles, placeholders, the item dialog, and its styles

**Files:**
- Create: `packages/web/src/library/ItemGrid.tsx`
- Modify: `packages/web/src/styles/library.css` (tile and item-dialog rules, after the gallery section)
- Modify: `packages/web/src/styles/tokens.css:130-132` (two tokens)
- Create: `packages/web/test/library/ItemGrid.test.tsx`

**Interfaces:**
- Consumes: `CatalogItemsResult` (Task 2), `pluginFor(id).tile` (Task 3), `MediaItemCard` with `initiallyExpanded` (Task 3), `Dialog` (Task 4), `emptyPluginRows`, `usePluginRows`, `useInfiniteScroll`.
- Produces:
  ```ts
  export interface ItemGridProps {
    store: CategorySource;        // import type from './Category.tsx' would be circular; define GridSource = GatheredSource & PluginRowsSource here and have Category pass its store
    pluginId: string;
    tables: readonly string[];
    submit: PickSubmit;
    identify: IdentifySubmit;
    result: CatalogItemsResult;
    emptyMessage: string;
  }
  export function ItemGrid(props: ItemGridProps): ReactElement | null
  ```

- [ ] **Step 1: Write the failing tests**

Create `packages/web/test/library/ItemGrid.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { IdentifySubmit } from '@pickarr/plugin-ui';
import type { CatalogRecord } from '../../src/store/catalog.ts';
import { ItemGrid, type GridSource } from '../../src/library/ItemGrid.tsx';
import type { CatalogItemsResult } from '../../src/library/useCatalogItems.ts';
import type { PickSubmit } from '../../src/library/postPick.ts';

afterEach(cleanup);

function mediaItem(id: number, pluginId: string, title: string): MediaItemSyncRead {
  return { id, pluginId, createdAt: id, updatedAt: id, provider: null, providerRef: null, title, releaseDate: null, description: null };
}
function recordOf(id: number, pluginId: string, title: string, poster: number | null, background: number | null): CatalogRecord {
  return { id, pluginId, updatedAt: id, picked: 0, haystack: title.toLowerCase(), poster, background };
}
function resultOf(items: readonly MediaItemSyncRead[], records: readonly CatalogRecord[], done = true): CatalogItemsResult {
  return { items, records: new Map(records.map((r) => [r.id, r])), loadMore: () => {}, done, empty: items.length === 0 && done };
}
const source: GridSource = {
  gatherMediaItem: () => Promise.resolve(undefined),
  subscribe: () => () => {},
  pluginRowsByMediaItems: () => Promise.resolve({ rows: new Map(), heldIds: new Map() }),
  subscribeInserts: () => () => {},
  subscribeTouched: () => () => {},
};
const acceptsPick: PickSubmit = () => Promise.resolve({ accepted: true });
const neverIdentify: IdentifySubmit = { identify: () => Promise.reject(new Error('unused')), suggest: () => Promise.reject(new Error('unused')) };
const NO_TABLES: readonly string[] = [];

function renderGrid(pluginId: string, result: CatalogItemsResult): void {
  render(<ItemGrid store={source} pluginId={pluginId} tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={result} emptyMessage="Nothing here yet." />);
}

test('a film grid shows each item\'s poster; a television grid shows backgrounds; both name the tile by the title', () => {
  renderGrid('movie', resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', 41, 91)]));
  const list = screen.getByRole('list');
  assert.equal(list.getAttribute('data-tile'), 'poster');
  const tile = within(list).getByRole('button', { name: 'Arrival' });
  const img = tile.querySelector('img');
  assert.equal(img?.getAttribute('src'), '/api/artwork/poster/41');
  assert.equal(img?.getAttribute('alt'), '', 'the caption is the name; the image says nothing twice');
  cleanup();
  renderGrid('tv', resultOf([mediaItem(2, 'tv', 'Severance')], [recordOf(2, 'tv', 'Severance', 42, 92)]));
  assert.equal(screen.getByRole('list').getAttribute('data-tile'), 'background');
  assert.equal(screen.getByRole('button', { name: 'Severance' }).querySelector('img')?.getAttribute('src'), '/api/artwork/background/92');
});

test('a record with no image of the plugin\'s kind shows the placeholder under the title, even when it has the other kind', () => {
  renderGrid('movie', resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', null, 91)]));
  const tile = screen.getByRole('button', { name: /Arrival/ });
  assert.ok(!tile.querySelector('img[src]'), 'no image is requested');
  assert.ok(within(tile).getByRole('img', { name: 'No poster for Arrival' }), 'the placeholder names what is missing');
});

test('an image that fails latches to the placeholder, and a new id for the tile is tried afresh', async () => {
  const first = resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', 41, null)]);
  const { rerender } = render(<ItemGrid store={source} pluginId="movie" tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={first} emptyMessage="x" />);
  const img = screen.getByRole('button', { name: /Arrival/ }).querySelector('img');
  assert.ok(img);
  fireEvent.error(img);
  await waitFor(() => { assert.ok(screen.getByRole('img', { name: 'No poster for Arrival' })); });
  // The same record again: still the placeholder, no retry.
  rerender(<ItemGrid store={source} pluginId="movie" tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={first} emptyMessage="x" />);
  assert.ok(!screen.getByRole('button', { name: /Arrival/ }).querySelector('img[src]'));
  // A re-rank changes the id: the tile tries the new image.
  const reranked = resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', 43, null)]);
  rerender(<ItemGrid store={source} pluginId="movie" tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={reranked} emptyMessage="x" />);
  assert.equal(screen.getByRole('button', { name: 'Arrival' }).querySelector('img')?.getAttribute('src'), '/api/artwork/poster/43');
});

test('activating a tile opens one dialog named for the item with the card expanded; a second tile replaces it', async () => {
  renderGrid('movie', resultOf(
    [mediaItem(1, 'movie', 'Arrival'), mediaItem(2, 'movie', 'Dune')],
    [recordOf(1, 'movie', 'Arrival', 41, null), recordOf(2, 'movie', 'Dune', 42, null)],
  ));
  fireEvent.click(screen.getByRole('button', { name: 'Arrival' }));
  const dialog = screen.getByRole('dialog', { name: 'Arrival' });
  assert.ok(within(dialog).getByRole('heading', { name: /Arrival/ }), 'the card is inside');
  assert.equal(within(dialog).getByRole('button', { name: /Arrival/ }).getAttribute('aria-expanded'), 'true', 'opened expanded');
  fireEvent.click(screen.getAllByRole('button', { name: 'Dune' })[0] as HTMLElement);
  await waitFor(() => { assert.equal(screen.getAllByRole('dialog').length, 1); });
  assert.ok(screen.getByRole('dialog', { name: 'Dune' }));
});

test('Escape, the backdrop and Close each close the dialog and return focus to the tile', () => {
  renderGrid('movie', resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', 41, null)]));
  const tile = screen.getByRole('button', { name: 'Arrival' });
  tile.focus();
  fireEvent.click(tile);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  assert.ok(!screen.queryByRole('dialog'), 'Escape closed it');
  assert.ok(tile.contains(document.activeElement) || document.activeElement === tile, 'focus is back on the tile');
  fireEvent.click(tile);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
  assert.ok(!screen.queryByRole('dialog'), 'Close closed it');
});

test('a dialog whose item leaves the page closes, and focus lands on the grid', async () => {
  const two = resultOf([mediaItem(1, 'movie', 'Arrival'), mediaItem(2, 'movie', 'Dune')], [recordOf(1, 'movie', 'Arrival', 41, null), recordOf(2, 'movie', 'Dune', 42, null)]);
  const { rerender } = render(<ItemGrid store={source} pluginId="movie" tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={two} emptyMessage="x" />);
  fireEvent.click(screen.getByRole('button', { name: 'Arrival' }));
  assert.ok(screen.getByRole('dialog', { name: 'Arrival' }));
  const one = resultOf([mediaItem(2, 'movie', 'Dune')], [recordOf(2, 'movie', 'Dune', 42, null)]);
  rerender(<ItemGrid store={source} pluginId="movie" tables={NO_TABLES} submit={acceptsPick} identify={neverIdentify} result={one} emptyMessage="x" />);
  await waitFor(() => { assert.ok(!screen.queryByRole('dialog')); });
  assert.ok(screen.getByRole('list').contains(document.activeElement) || document.activeElement === screen.getByRole('list'), 'focus went to the grid, since the tile is gone');
});

test('an empty result says so, and a page that is not done shows the sentinel and Load more', () => {
  renderGrid('movie', resultOf([], []));
  assert.ok(screen.getByText('Nothing here yet.'));
  cleanup();
  renderGrid('movie', resultOf([mediaItem(1, 'movie', 'Arrival')], [recordOf(1, 'movie', 'Arrival', 41, null)], false));
  assert.ok(screen.getByTestId('load-more-sentinel'));
  assert.ok(screen.getByRole('button', { name: 'Load more' }));
});
```

Check `PluginRowsSource`'s method shape in `usePluginRows.ts` and `GatheredSource` in `useGatheredItem.ts` before finalising the `source` stub; satisfy each required member the way `Category.test.tsx`'s `sourceFor` does. `CardHeading` renders the expander as a button with `aria-expanded`; confirm in `expansion.tsx` and adjust the attribute assertion if the button exposes expansion differently.

- [ ] **Step 2: Run the tests to verify they fail**

Run the web runner on `packages/web/test/library/ItemGrid.test.tsx`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `ItemGrid`**

`packages/web/src/library/ItemGrid.tsx`:

```tsx
/**
 * The grid view of a category (design spec 2026-10-04 §3.3, §3.4): one
 * tile per item showing the image kind its plugin declared, and a dialog
 * holding the item's card when a tile is activated.
 *
 * **Why the catalog record and not a read per tile.** The record carries
 * the rank-0 `poster` and `background` ids (§1), picked during the
 * recompute from rows it already read, so a page of tiles costs the same
 * two requests the filtered list already makes. A read per tile through
 * `by_media_item` would return every release and role too -- the cost #110
 * removed from the card -- and a new rows index would be a read per tile
 * and a reindex of every replica.
 *
 * **The kind comes from the plugin.** `pluginFor(pluginId).tile` is the one
 * place that knows whether this category is browsed by poster or by
 * background; `test/plugins/registry.test.ts` refuses a plugin id spelled
 * here, which is what keeps that true.
 *
 * **One dialog, the same card.** Activating a tile opens `MediaItemCard`
 * with `initiallyExpanded`, so picking, retrying and identifying inside the
 * dialog are the card's own behaviour against the same `submit` and
 * `identify`. If the open item leaves the page -- a filter no longer
 * matches it, or it was tombstoned -- the dialog closes and focus goes to
 * the list, since the tile that would take it back is gone.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import { Dialog, ImagePlaceholder, type IdentifySubmit } from '@pickarr/plugin-ui';
import { pluginFor } from '../plugins/registry.ts';
import { artworkUrl } from '../store/gather.ts';
import type { CatalogRecord } from '../store/catalog.ts';
import type { CatalogItemsResult } from './useCatalogItems.ts';
import type { GatheredSource } from './useGatheredItem.ts';
import { usePluginRows, emptyPluginRows, type PluginRowsSource } from './usePluginRows.ts';
import { useInfiniteScroll } from './useInfiniteScroll.ts';
import { MediaItemCard } from './MediaItemCard.tsx';
import type { PickSubmit } from './postPick.ts';

export interface GridSource extends GatheredSource, PluginRowsSource {}

export interface ItemGridProps {
  store: GridSource;
  pluginId: string;
  tables: readonly string[];
  submit: PickSubmit;
  identify: IdentifySubmit;
  result: CatalogItemsResult;
  emptyMessage: string;
}

type TileKind = 'poster' | 'background';

/** The capitalised kind for a placeholder label: `No poster for …`, `No background for …`. */
function kindLabel(kind: TileKind): string {
  return kind === 'poster' ? 'poster' : 'background';
}

interface TileProps {
  item: MediaItemSyncRead;
  kind: TileKind;
  imageId: number | null;
  onOpen: (id: number) => void;
}

function Tile({ item, kind, imageId, onOpen }: TileProps): ReactElement {
  // Latched per image id, not per tile: a 404 on this id stays a
  // placeholder, and a re-rank that changes the id is a fresh attempt.
  const [failedId, setFailedId] = useState<number | null>(null);
  const showImage = imageId !== null && failedId !== imageId;
  return (
    <li>
      <button type="button" aria-haspopup="dialog" onClick={() => { onOpen(item.id); }}>
        {showImage ? (
          <img src={artworkUrl(kind, imageId)} alt="" onError={() => { setFailedId(imageId); }} />
        ) : (
          <ImagePlaceholder label={`No ${kindLabel(kind)} for ${item.title}`} />
        )}
        <span>{item.title}</span>
      </button>
    </li>
  );
}

export function ItemGrid({ store, pluginId, tables, submit, identify, result, emptyMessage }: ItemGridProps): ReactElement | null {
  const { items, records, loadMore, done, empty } = result;
  const kind: TileKind = pluginFor(pluginId)?.tile ?? 'poster';

  const mediaItemIds = useMemo(() => items.map((item) => item.id), [items]);
  const pluginRows = usePluginRows(store, mediaItemIds, tables);
  const emptyRows = useMemo(() => emptyPluginRows(tables), [tables]);
  const sentinel = useInfiniteScroll(loadMore, !done);

  const [openId, setOpenId] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const openItem = openId === null ? undefined : items.find((item) => item.id === openId);

  // The open item left the page: close, and put focus somewhere real.
  useEffect(() => {
    if (openId !== null && openItem === undefined) {
      setOpenId(null);
      listRef.current?.focus();
    }
  }, [openId, openItem]);

  if (items.length === 0 && !empty) return null;
  if (empty) return <p>{emptyMessage}</p>;

  return (
    <div>
      <ul className="tiles" data-tile={kind} ref={listRef} tabIndex={-1}>
        {items.map((item) => (
          <Tile key={item.id} item={item} kind={kind} imageId={imageFor(records.get(item.id), kind)} onOpen={setOpenId} />
        ))}
      </ul>
      {!done && (
        <>
          <div ref={sentinel} data-testid="load-more-sentinel" />
          <button type="button" onClick={loadMore}>Load more</button>
        </>
      )}
      {openItem !== undefined && (
        <Dialog label={openItem.title} className="item-dialog" onClose={() => { setOpenId(null); }}>
          <button type="button" onClick={() => { setOpenId(null); }}>Close</button>
          <MediaItemCard
            source={store}
            item={openItem}
            rows={pluginRows.get(openItem.id) ?? emptyRows}
            submit={submit}
            identify={identify}
            initiallyExpanded
          />
        </Dialog>
      )}
    </div>
  );
}

function imageFor(record: CatalogRecord | undefined, kind: TileKind): number | null {
  if (record === undefined) return null;
  return kind === 'poster' ? record.poster : record.background;
}
```

Check `artworkUrl`'s exported signature in `store/gather.ts` (`artworkUrl(kind: ArtworkUrlKind, id: number)`); if `ArtworkUrlKind` does not include both `'poster'` and `'background'`, build the url as `` `/api/artwork/${kind}/${String(imageId)}` `` and say why in a comment. The `?? 'poster'` fallback on `pluginFor` is for the typed `undefined`; the registry test proves `pluginId` is always registered on a category route, so note that beside it rather than throwing.

`packages/web/src/styles/tokens.css`, beside `--size-poster`:

```css
  --size-tile-poster: 9rem;        /* a poster tile's minimum width; 2:3, so 13.5rem tall */
  --size-tile-background: 16rem;   /* a background tile's minimum width; 16:9, so 9rem tall */
```

and add one sentence to the size tokens' comment: "Two more since phase 8: the minimum widths the grid's `auto-fill` columns use for poster and background tiles."

`packages/web/src/styles/library.css`, after the gallery section:

```css
/* The grid view (design spec 2026-10-04 §3.3): `auto-fill` columns at the
   plugin's tile width, every tile a button whose whole face is the image
   with the title beneath. `data-tile` picks the aspect ratio, so a film
   grid is posters and a television grid is backgrounds from the same
   rules. */
.tiles {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: var(--space-3);
  grid-template-columns: repeat(auto-fill, minmax(var(--size-tile-poster), 1fr));
}
.tiles[data-tile='background'] { grid-template-columns: repeat(auto-fill, minmax(var(--size-tile-background), 1fr)); }
.tiles button {
  display: flex; flex-direction: column; gap: var(--space-1);
  width: 100%; padding: 0; border: 1px solid var(--color-line); border-radius: var(--radius-md);
  background: var(--color-surface); color: var(--color-text); cursor: pointer; text-align: left;
  overflow: hidden;
}
.tiles button:is(:hover, :focus-visible) { border-color: var(--color-line-strong); }
.tiles img, .tiles .placeholder { display: block; width: 100%; aspect-ratio: 2 / 3; object-fit: cover; }
.tiles[data-tile='background'] img, .tiles[data-tile='background'] .placeholder { aspect-ratio: 16 / 9; }
.tiles .placeholder { box-sizing: border-box; padding: 1.5rem; color: var(--color-text-dim); background: var(--color-surface-2); }
.tiles span {
  padding: 0 var(--space-2) var(--space-2); font-size: var(--text-body);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* The item dialog: the card, in a panel that scrolls when its detail
   section is taller than the viewport. Shares `.dialog-backdrop` with the
   gallery. */
.item-dialog {
  max-width: min(60rem, 100%); max-height: 100%; overflow: auto;
  padding: var(--space-3); border-radius: var(--radius-md);
  background: var(--color-bg); color: var(--color-text);
  box-shadow: var(--shadow-dialog);
}
.item-dialog > button { float: right; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run the web runner on `packages/web/test/library/ItemGrid.test.tsx`. Expected: all pass. Then `npm run check`.

- [ ] **Step 5: Mutation check**

Replace `kind` with the literal `'poster'` in `imageFor`'s call: the first test reds on the television assertion. Remove `failedId !== imageId` (never latch): the third test reds. Drop the leaving-item effect: the sixth reds. Make `Dialog`'s `onClose` a no-op here: the fifth reds. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/library/ItemGrid.tsx packages/web/src/styles packages/web/test/library/ItemGrid.test.tsx
git commit -m "Add the grid view's tiles, placeholders and item dialog"
```

---

### Task 7: `Category` switches views

**Files:**
- Modify: `packages/web/src/library/Category.tsx`
- Test: `packages/web/test/library/Category.test.tsx`

**Interfaces:**
- Consumes: `BrowseQuery.view` (Task 5), `ItemGrid` and `GridSource` (Task 6), `useCatalogItems` returning `CatalogItemsResult` (Task 2).
- Produces: `CategorySource` unchanged (it already extends `GatheredSource` and `PluginRowsSource`, so it satisfies `GridSource`).

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/test/library/Category.test.tsx`:

```tsx
test('view=grid lists through the catalog as tiles, and the toggle writes the URL both ways', async () => {
  const db = await freshDb();
  await seed(db, [mediaItem({ id: 1, pluginId: 'tv', title: 'Alpha Show', updatedAt: 10 })]);
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />, '/tv?view=grid');
  await waitFor(() => { assert.ok(screen.getByRole('list')); });
  assert.equal(screen.getByRole('list').getAttribute('data-tile'), 'background', 'television browses by background');
  assert.ok(screen.getByRole('button', { name: /Alpha Show/ }));
  assert.ok(!screen.queryByRole('heading', { name: /Alpha Show/ }), 'no list card is rendered alongside the grid');

  fireEvent.click(screen.getByRole('radio', { name: 'List' }));
  await waitFor(() => { assert.ok(screen.getByRole('heading', { name: /Alpha Show/ })); });
  assert.ok(!screen.queryByRole('list'), 'the grid is gone');
});

test('the grid honours the filter and the search, and a grid with nothing to show says what it is empty of', async () => {
  const db = await freshDb();
  await seedPickedAndNot(db);
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />, '/tv?view=grid&filter=picked');
  await waitFor(() => { assert.equal(screen.getAllByRole('listitem').length, 2); });
  assert.ok(screen.getByRole('button', { name: /Gamma Show/ }));
  assert.ok(!screen.queryByRole('button', { name: /Beta Show/ }));
  cleanup();
  renderAt(<Category store={sourceFor(db)} pluginId="tv" tables={NO_TABLES} submit={acceptsPick} identify={throwsOnUse} />, '/tv?view=grid&filter=unpicked&q=zzz');
  await waitFor(() => { assert.ok(screen.getByText('Nothing matches "zzz" among unpicked items')); });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run the web runner on `packages/web/test/library/Category.test.tsx`. Expected: the two new tests fail (no `list`, no tiles).

- [ ] **Step 3: Implement**

In `Category.tsx`, import `ItemGrid` and replace the result branch:

```tsx
      {store === undefined || identify === undefined ? null : query.view === 'grid' ? (
        <GridView
          key={`grid|${query.filter}|${query.term}`}
          store={store}
          pluginId={pluginId}
          tables={tables}
          submit={submit}
          identify={identify}
          query={query}
        />
      ) : query.filter === 'all' && query.term === '' ? (
        <DefaultList key="list" store={store} pluginId={pluginId} tables={tables} submit={submit} identify={identify} />
      ) : (
        <FilteredList
          key={`list|${query.filter}|${query.term}`}
          ...
        />
      )}
```

and add:

```tsx
/**
 * The grid always reads through the catalog, the empty filter included:
 * the tile ids live on the record and nowhere the rows store can answer
 * in one read (design spec 2026-10-04 §3.2). The list keeps its rows-store
 * fast path for the unfiltered case.
 */
function GridView({ store, pluginId, tables, submit, identify, query }: ListProps & { query: BrowseQuery }): ReactElement | null {
  const result = useCatalogItems(store, { pluginId, filter: query.filter, term: query.term });
  const emptyMessage = query.filter === 'all' && query.term === '' ? 'Nothing here yet.' : emptySentence(query);
  return <ItemGrid store={store} pluginId={pluginId} tables={tables} submit={submit} identify={identify} result={result} emptyMessage={emptyMessage} />;
}
```

Update the module doc's first paragraph to name the two views and where `view` comes from.

- [ ] **Step 4: Run the tests to verify they pass**

Run the web runner on `packages/web/test/library/Category.test.tsx`, then `npm run check`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/library/Category.tsx packages/web/test/library/Category.test.tsx
git commit -m "Switch a category between its list and its grid from the URL's view"
```

---

### Task 8: End to end: a background tile, its dialog, a pick inside it

**Files:**
- Modify: `packages/e2e/src/harness-2.ts` (`Harness.seedArtwork`, implemented beside `seedPoster`; `seedPoster` becomes a call to it)
- Create: `packages/e2e/tests/grid.spec.ts`

**Interfaces:**
- Produces: `Harness.seedArtwork(kind: 'poster' | 'background', mediaItemId: number, rank: number): number`, same semantics as `seedPoster`, inserting into the named table.

- [ ] **Step 1: Add `seedArtwork` to the harness**

In the `Harness` interface, beside `seedPoster`:

```ts
  /**
   * {@link Harness.seedPoster} for either media-item artwork kind. The grid
   * browses television and adult by background, so a spec of that view
   * needs a `background` row; the same 1x1 png serves both tables.
   */
  seedArtwork(kind: 'poster' | 'background', mediaItemId: number, rank: number): number;
```

In the implementation, replace `seedPoster`'s body with a call and add the general form. The table name is interpolated from a two-member union, never from caller input:

```ts
      function seedArtwork(kind: 'poster' | 'background', mediaItemId: number, rank: number): number {
        const table = kind === 'poster' ? 'poster' : 'background';
        const result = raw.prepare(
          `INSERT INTO ${table} (media_item_id, url, width, height, rank, created_at, path) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(mediaItemId, `http://artwork.invalid/${kind}-${String(mediaItemId)}-${String(rank)}.png`, 1, 1, rank, Date.now(), posterPath);
        return Number(result.lastInsertRowid);
      }
      function seedPoster(mediaItemId: number, rank: number): number {
        return seedArtwork('poster', mediaItemId, rank);
      }
```

Keep `seedPoster`'s existing doc comment on the interface; move its implementation comment about `width`/`height` and the `.invalid` url to `seedArtwork`. Add `seedArtwork` to the returned harness object.

- [ ] **Step 2: Write the spec**

Create `packages/e2e/tests/grid.spec.ts`:

```ts
/**
 * The grid view (design spec 2026-10-04): a television item browsed by its
 * background, the tile opening the item's card in a dialog, and a pick made
 * from inside that dialog -- the one path a unit test cannot drive, because
 * the pick's status comes back through the host and the replica.
 *
 * Credentials typed here are the repo literals every other spec types
 * (`scripts/check-test-hygiene.ts`, rule 4).
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../src/harness-2.ts';

const PASSWORD = 'correct horse battery staple, not a real credential';
const FILENAME = 'a.show.s01e01.1080p.web-dl.h265-GRP.mkv';

async function claimInstall(page: Page, email: string, claimToken: string): Promise<void> {
  await page.getByRole('button', { name: 'First time here? Claim this install' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Claim token').fill(claimToken);
  await page.getByRole('button', { name: 'Claim this install' }).click();
}

test('a television tile shows the background, opens the card in a dialog, takes a pick, and gives focus back on Escape', async ({ page, harness }) => {
  const { mediaItemId } = await harness.seedPickableRelease({
    pluginId: 'tv',
    title: 'A Show',
    filename: FILENAME,
    lookupState: 'resolved',
    withDownloadClient: true,
  });
  const backgroundId = harness.seedArtwork('background', mediaItemId, 0);

  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  // A deep link with the view in it, the way a bookmark would arrive.
  await page.goto(`${harness.origin}/tv?view=grid`);
  const grid = page.getByRole('list');
  await expect(grid).toHaveAttribute('data-tile', 'background', { timeout: 15_000 });

  const tile = grid.getByRole('button', { name: 'A Show' });
  const image = tile.locator('img');
  await expect(image).toHaveAttribute('src', `/api/artwork/background/${String(backgroundId)}`, { timeout: 15_000 });
  // Real bytes decoded, not merely a src attribute: the route served the file.
  await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);

  // The grid is laid out by `.tiles`, not by the UA's list defaults.
  await expect(grid).toHaveCSS('display', 'grid');

  await tile.click();
  const dialog = page.getByRole('dialog', { name: 'A Show' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /A Show/ })).toBeVisible();

  const pick = dialog.getByRole('button', { name: `Pick ${FILENAME}` });
  await expect(pick).toBeVisible({ timeout: 15_000 });
  await pick.click();
  await expect(pick).toBeHidden({ timeout: 15_000 });

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(tile).toBeFocused();
});
```

Before relying on `Pick ${FILENAME}` and the status taking the button's place, read `packages/e2e/tests/shell.spec.ts`'s pick spec (search `an operator can pick a release and watch its status`) and mirror its post-click assertion exactly if it differs from "the Pick button is hidden". Keep the sum of declared step timeouts under `playwright.config.ts`'s 90 s (`scripts/check-e2e-timeout-budget.test.ts` enforces it): the timeouts above sum to 70 s.

- [ ] **Step 3: Run the spec**

Run: `cd packages/e2e && npx playwright test grid.spec.ts > /tmp/grid-e2e.log 2>&1; echo $?` and read the log. Expected: 1 passed. If the tile's `src` never appears, the catalog recompute path or the registry tile is wrong: check `/api/sync` carries the `background` row and that the record has its id.

- [ ] **Step 4: Run the full gate and the whole e2e suite**

Run `npm run check > /tmp/check.log 2>&1; echo $?` and `npm run e2e > /tmp/e2e.log 2>&1; echo $?`. Expected: both 0.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e
git commit -m "Prove the grid end to end: a background tile, its dialog, a pick inside it, focus back on Escape"
```

---

## Self-review

- **Spec coverage.** §1.1 record and version: Task 1. §1.2 recompute and affected tables: Task 1. §2.1 `tile`: Task 3. §2.2 `initiallyExpanded`: Task 3. §2.3 `Dialog`: Task 4. §3.1 URL and controls: Task 5 (plus the one-line prop pass in `Category`). §3.2 source and `records`: Tasks 2 and 7. §3.3 tiles: Task 6. §3.4 dialog: Task 6. §4 edge cases: the leaving item and the latch are in Task 6; keyboard-only is `Dialog`'s trap (Task 4) plus buttons-in-a-list (Task 6); `?view=grid` elsewhere is parsed only by `useBrowseQuery` inside `Category` (Task 5). §5 e2e: Task 8.
- **Placeholders.** None; every step has its code. Two steps tell the implementer to confirm a helper's name against the file before using it, which is a check, not a gap.
- **Type consistency.** `CatalogItemsResult.records: ReadonlyMap<number, CatalogRecord>` (Task 2) is what `ItemGrid` reads (Task 6) and `resultOf` builds in its tests. `GridSource = GatheredSource & PluginRowsSource` (Task 6) is satisfied by `CategorySource` (Task 7). `BrowseView` (Task 5) is what `BrowseControls` and `Category` consume. `Dialog`'s `className` is required and `ItemGrid` passes `item-dialog`, `Gallery` passes `gallery`.
- **Review Focus.** Each of the five has a named test: 1 and 2 and 3 in Task 6, 4 in Task 5, 5 in Task 1.
