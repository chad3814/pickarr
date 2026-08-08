# Manual Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human describe a release the parser refused, and correct one it got wrong, without either becoming a second source of truth.

**Architecture:** Plugins declare their editable fields and convert values to and from a `ParsedRelease`; core renders the form generically and persists only the resulting release, in the same columns a parsed one uses. An edited record is indistinguishable from a parsed one everywhere downstream.

**Tech Stack:** Node 24, TypeScript 7 (`tsgo`, typecheck only), Fastify 5, React 19 + Vite, `node:sqlite`, zod 3, `node:test` + tsx, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-07-manual-metadata-design.md` — read the section named in each task.

## Global Constraints

- **Do not commit anything.** Leave all work in the working tree. The repo owner approves every commit personally and is away; the controller snapshots each task for review without committing.
- **Never use the `any` type.** Not in source, not in tests. Use `unknown` plus a narrowing check.
- Node 24 is not the shell default. Every command needs `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"` first.
- **Verify with `npm run check`** (= lint + typecheck + test), from the repo root. Do not substitute `npm run build` for the typecheck: `build` is four bundlers (`esbuild` ×3, `vite` ×1) and runs no typechecker at all, so a type error passes it silently.
- Lint must introduce **zero** new `error`-level findings. The existing `warning` lines (`no-await-in-loop`, `no-array-sort`, `preserve-caught-error`) are pre-existing and not yours to fix.
- Baseline before you start: **412** tests under `test:server` (249 core, 153 plugin-scenes, the rest plugin-api plus `web/test/format.test.ts`) and **12** under `test:web`. All green.
- `tsconfig.base.json` sets `exactOptionalPropertyTypes: true`, `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`. So: an optional property is *omitted*, never assigned `undefined` — build objects with a conditional spread; no enums; every type-only import says `import type`.
- Running one test file:
  - server/plugin: `node --import tsx --conditions development --test <path>`
  - web: `TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test <path>`
- Match the surrounding comment style: comments explain *why*, especially where a simpler-looking alternative is wrong. Do not narrate what the code plainly does.
- Tests are named as sentences describing the behaviour.
- In web tests, **never** write `assert.equal(screen.queryByText(x), null)` inside `waitFor` — formatting that AssertionError deep-inspects a live DOM element on every retry and OOM-kills the run with no test named. Compare booleans: see `gone()` in `packages/web/test/Browse.test.tsx:73`.

---

### Task 1: Manual field types, and the parser internals the manual path needs

**Files:**
- Modify: `packages/plugin-api/src/types.ts`
- Modify: `packages/plugin-scenes/src/parse.ts` (add `export` to existing declarations only)
- Modify: `packages/plugin-scenes/src/index.ts` (re-export)
- Test: `packages/plugin-scenes/test/build-release.test.ts` (create)

**Spec:** §4 (contract), §5 (identity construction).

**Interfaces:**
- Produces: `ManualField`, `ManualFieldType`, and four optional `MediaTypePlugin` hooks — consumed by every later task. From `parse.ts`: `buildRelease`, `slug`, `canonicalSiteName`, `prettify`, `extractQuality`, `tokensOf`, `matchSitePrefix`, `findSceneDate`, and the types `AnchorSpan`, `Token`, `SiteMatch` — all consumed by Task 2.

`buildRelease` already exists, private, at `packages/plugin-scenes/src/parse.ts:779`, with signature `(site: string, anchor: AnchorSpan | null, sceneTitle: string, sceneSlug: string, quality: QualityTokens) => ParsedRelease | null`. This task exports it rather than writing a second one. Read the comment above it and above `slug` (`:388`) first — the injectivity argument there is what makes this task load-bearing.

- [ ] **Step 1: Add the types to the plugin API**

In `packages/plugin-api/src/types.ts`, above `MediaTypePlugin`:

```ts
export type ManualFieldType = 'text' | 'number' | 'select';

/**
 * One field in the form a human fills in to describe a release by hand.
 *
 * `scope` is what lets a single schema drive three different forms: the whole
 * list when describing a failed item from scratch, the `identity` fields when
 * correcting a group, the `quality` fields when correcting one release. Core
 * renders from this list and never learns what a "site" is.
 */
export interface ManualField {
  readonly name: string;
  readonly label: string;
  readonly type: ManualFieldType;
  readonly scope: 'identity' | 'quality';
  readonly required?: boolean;
  /** Permitted values, for `type: 'select'`. An empty string means "unset". */
  readonly options?: readonly string[];
  readonly placeholder?: string;
  readonly help?: string;
}
```

And on `MediaTypePlugin`, after `refusalReason`:

```ts
  /**
   * The fields a human may fill in to describe a release this plugin handles.
   *
   * A plugin implementing none of the manual hooks simply gets no edit UI;
   * core hides the controls. Dismissing a failed item still works, because
   * that is core's own bookkeeping and needs no plugin knowledge.
   */
  manualFields?(): readonly ManualField[];

  /**
   * Field values turned into a release, or a message naming what is wrong.
   *
   * Must produce a correct `identityKey` and `display` from the
   * `identity`-scoped values alone: core does not send quality values when
   * editing a group, and ignores `media.quality` if one comes back.
   */
  fromManualValues?(
    values: Readonly<Record<string, string>>,
  ): { media: ParsedRelease } | { error: string };

  /**
   * The inverse, to prefill an edit form. Manual values are never stored —
   * only the `ParsedRelease` is — so this is how a form is repopulated, and
   * why a plugin renaming a field later orphans nothing.
   */
  toManualValues?(media: ParsedRelease): Record<string, string>;

  /**
   * Best-effort prefill for a name that failed to parse. Runs on names the
   * parser has already refused, so returning little or nothing is normal.
   * Must never throw: a suggestion is a convenience, not a contract.
   */
  suggestManualValues?(releaseName: string): Record<string, string>;
```

- [ ] **Step 2: Write the failing test**

Create `packages/plugin-scenes/test/build-release.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRelease, slug, parseSceneRelease } from '../src/parse.ts';

test('a hand-built release is byte-identical to the parsed one', () => {
  // The whole point of exporting the builder rather than writing a second
  // one: a manually entered release must land in the same group, and on the
  // same library path, as its parsed siblings.
  const parsed = parseSceneRelease('Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  assert.ok(parsed !== null);

  const built = buildRelease(
    'Brazzers',
    { kind: 'date', key: '2023-04-15', startOffset: 0, endOffset: 0 },
    'Alex Coal',
    slug('Alex Coal'),
    parsed.quality,
  );

  assert.deepEqual(built, parsed);
});

test('an empty site or scene slug is refused rather than keyed on nothing', () => {
  assert.equal(buildRelease('', null, 'Title', slug('Title'), { extras: {} }), null);
  assert.equal(buildRelease('Site', null, '', '', { extras: {} }), null);
});
```

- [ ] **Step 3: Run it and watch it fail**

```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
node --import tsx --conditions development --test packages/plugin-scenes/test/build-release.test.ts
```

Expected: import failure — `buildRelease` and `slug` are not exported.

- [ ] **Step 4: Add the exports**

In `packages/plugin-scenes/src/parse.ts`, add `export` to these existing declarations. **Add the keyword and change nothing else** — no signature changes, no behaviour changes, no reordering:

`buildRelease` (:779) · `slug` (:388) · `prettify` (:395) · `canonicalSiteName` (:1190) · `extractQuality` (:671) · `tokensOf` (:467) · `matchSitePrefix` (:987) · `findSceneDate` (:837) · `interface AnchorSpan` (:823) · `interface Token` (:418) · `interface SiteMatch` (:970)

The last five matter because Task 2's `suggestManualValues` reuses them: `matchSitePrefix` takes a `Token[]` from `tokensOf` and returns a `SiteMatch`. Without these exports Task 2 must write a second quality extractor and a second site matcher, which is exactly the duplication spec §5 forbids.

Re-export `buildRelease` and `slug` from `packages/plugin-scenes/src/index.ts` alongside the existing exports.

- [ ] **Step 5: Verify**

```
npm run check
```

Expected: the new tests pass, and the existing suite is unchanged — 412 server, 12 web.

---

### Task 2: The scenes plugin's manual hooks

**Files:**
- Create: `packages/plugin-scenes/src/manual.ts`
- Modify: `packages/plugin-scenes/src/index.ts` (wire the four hooks)
- Test: `packages/plugin-scenes/test/manual.test.ts` (create)

**Spec:** §5 in full — including "Title order is a field, not an inference" and the field table.

**Interfaces:**
- Consumes: Task 1's types and parser exports.
- Produces (consumed only by `index.ts`): `sceneManualFields()`, `sceneFromManualValues(values, options)`, `sceneToManualValues(media)`, `sceneSuggestManualValues(releaseName, options)`, where `options` is the existing `SceneParseOptions`.

**The title-order rule.** `slug(title)` alone is wrong, and so is always splitting on ` - `. The bracketed-listing shape (`parse.ts:1532`) sorts its title parts and joins with `--`; every other shape slugs the title whole. A dotted name containing `.-.` produces a display title with ` - ` in it and *no* `--` in its key, so punctuation cannot tell you which rule applied. Hence the explicit `titleOrder` field:

```ts
function sceneSlugFor(title: string, order: string): string {
  if (order !== 'any') return slug(title);
  return title
    .split(' - ')
    .map(slug)
    .filter((part) => part.length > 0)
    .toSorted()
    .join('--');
}
```

- [ ] **Step 1: Write the failing tests**

Create `packages/plugin-scenes/test/manual.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneRelease } from '../src/parse.ts';
import {
  sceneManualFields,
  sceneFromManualValues,
  sceneToManualValues,
} from '../src/manual.ts';

// 'Trip For Fuck' must be here: the dateless shape has no first-token
// fallback, so without it that name parses to null and the loop below fails
// before it has tested anything.
const OPTIONS = { sites: ['Bang Bros', 'Brazzers', 'Trip For Fuck'] };

// One name per shape the parser can produce a key with, so the round trip is
// exercised against every way an identity key gets built.
const NAMES = [
  'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB',
  'InTheCrack.E1178.Tracy.Gold.XXX.2160p.MP4-KTR',
  'Bangbros.Chloe.Upgrades.her.Butt.2026.08.03.2160p.MP4-WRB',
  'TripForFuck - Hiyori JAPANESE 2',
  '[Vixen] Kylie - Page Turner - 2023-07-19',
  'Swallowed.26.08.06.Skyler.Nicole.XXX.1080p.MP4-P0RNL0V3R',
  // The shape that makes `titleOrder` necessary: display title 'Alex - Coal',
  // scene slug 'alex-coal' with no component boundary. Split it and the
  // release is silently re-keyed to 'coal--alex'.
  'Site.23.04.15.Alex.-.Coal.XXX.1080p.MP4-WRB',
];

test('values taken from a parsed release rebuild that release exactly', () => {
  // The property that keeps a hand-edited scene in the same group, and on the
  // same library path, as its parsed siblings.
  for (const name of NAMES) {
    const parsed = parseSceneRelease(name, OPTIONS);
    assert.ok(parsed !== null, name);

    const rebuilt = sceneFromManualValues(sceneToManualValues(parsed), OPTIONS);
    assert.ok('media' in rebuilt, `${name}: ${'error' in rebuilt ? rebuilt.error : ''}`);
    assert.deepEqual(rebuilt.media, parsed, name);
  }
});

test('title order is read off the key, not guessed from punctuation', () => {
  const listing = parseSceneRelease('[Vixen] Kylie - Page Turner - 2023-07-19', OPTIONS);
  const dotted = parseSceneRelease('Site.23.04.15.Alex.-.Coal.XXX.1080p.MP4-WRB', OPTIONS);
  assert.ok(listing !== null && dotted !== null);

  assert.equal(sceneToManualValues(listing)['titleOrder'], 'any');
  assert.equal(sceneToManualValues(dotted)['titleOrder'], 'fixed');
  assert.ok(listing.identityKey.includes('--'));
  assert.ok(!dotted.identityKey.includes('--'));
});

test('every declared field has a scope, and identity fields alone build an identity', () => {
  const fields = sceneManualFields();
  assert.ok(fields.length > 0);
  for (const field of fields) {
    assert.ok(field.scope === 'identity' || field.scope === 'quality', field.name);
    if (field.type === 'select') assert.ok(Array.isArray(field.options), field.name);
  }

  // Core sends only identity values when editing a group, so this must work.
  const identityOnly = sceneFromManualValues(
    { site: 'Brazzers', anchorKind: 'date', date: '2023-04-15', title: 'Alex Coal' },
    OPTIONS,
  );
  assert.ok('media' in identityOnly);
  assert.equal(identityOnly.media.identityKey, 'brazzers:2023-04-15:alex-coal');
});

test('a configured site spelling wins over what was typed', () => {
  // Same rule the parser follows: the canonical name decides the library
  // directory, so typing 'bangbros' must not open a second one.
  const result = sceneFromManualValues(
    { site: 'bangbros', anchorKind: 'none', title: 'Some Scene' },
    OPTIONS,
  );
  assert.ok('media' in result);
  assert.equal(result.media.display.subtitle, 'Bang Bros');
  assert.equal(result.media.identityKey, 'bang-bros::some-scene');
});

test('each rejection names the field at fault', () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ site: '', anchorKind: 'none', title: 'T' }, /site/i],
    [{ site: 'S', anchorKind: 'none', title: '' }, /title/i],
    [{ site: 'S', anchorKind: 'date', date: '15-04-2023', title: 'T' }, /date/i],
    [{ site: 'S', anchorKind: 'date', date: '2023-02-30', title: 'T' }, /date/i],
    [{ site: 'S', anchorKind: 'episode', episode: 'eleven', title: 'T' }, /episode/i],
  ];
  for (const [values, pattern] of cases) {
    const result = sceneFromManualValues(values, OPTIONS);
    assert.ok('error' in result, JSON.stringify(values));
    assert.match(result.error, pattern);
  }
});

test('an episode is normalised the way the parser normalises it', () => {
  const result = sceneFromManualValues(
    { site: 'InTheCrack', anchorKind: 'episode', episode: 'E1178', title: 'Tracy Gold' },
    OPTIONS,
  );
  assert.ok('media' in result);
  assert.equal(result.media.identityKey, 'inthecrack:e1178:tracy-gold');
  assert.ok(result.media.display.fields.some((f) => f.label === 'Episode' && f.value === 'E1178'));
});

test('a suggestion for an unparseable name offers what it can and invents nothing', () => {
  // Runs on names the parser already refused, so little or nothing is normal —
  // but it must never throw, and must not fabricate a title.
  const values = sceneSuggestManualValues('agmx.084.4k', OPTIONS);
  assert.equal(typeof values, 'object');
  assert.equal(values['title'] ?? '', '');
});
```

Add `sceneSuggestManualValues` to the import list at the top.

- [ ] **Step 2: Run them and watch them fail**

```
node --import tsx --conditions development --test packages/plugin-scenes/test/manual.test.ts
```

Expected: cannot find module `../src/manual.ts`.

- [ ] **Step 3: Implement `manual.ts`**

Declare the fields from spec §5's table, in that order, with these option lists:

- `anchorKind`: `['date', 'episode', 'none']`
- `titleOrder`: `['fixed', 'any']`, help: "Choose 'any' when the parts either side of ` - ` may appear in either order"
- `resolution`: `['', '4320p', '2160p', '1440p', '1080p', '720p', '540p', '480p']` — the display strings, because the form renders options verbatim; strip the trailing `p` when converting to the number
- `vr`, `upscaled`, `interlaced`: `['', 'yes']`

`sceneFromManualValues(values, options)`:
- Trim every value. `site` and `title` must be non-empty after `slug()`, else `{ error }` naming the field.
- `anchorKind: 'date'` → `date` must match `/^\d{4}-\d{2}-\d{2}$/` **and** be a real calendar date (`Date.UTC` then compare the components back, as `toIsoDate` at `parse.ts:402` does). Anchor: `{ kind: 'date', key: date, startOffset: 0, endOffset: 0 }`.
- `anchorKind: 'episode'` → `/^[Ee]\d+$/`; the key is the lowercased form (`e1178`), matching the parser.
- `anchorKind: 'none'` → anchor `null`.
- Build `quality` with `extras` **always present** even when empty, matching `extractQuality`, or the round-trip `deepEqual` fails. Omit every absent key rather than writing `''` or `undefined` — `exactOptionalPropertyTypes` forbids the latter anyway. Use a conditional spread.
- Site through `canonicalSiteName(site, options.sites ?? [])` before `buildRelease`.
- Call `buildRelease(site, anchor, title, sceneSlugFor(title, values.titleOrder ?? 'fixed'), quality)`. A `null` return means it refused: surface `lastRefusalReason() ?? 'could not build a release'`.

`sceneToManualValues(media)`:
- `site` from `display.subtitle`; `title` from `display.title`.
- `titleOrder` is `'any'` when the identity key's third segment contains `--`, else `'fixed'`.
- Anchor from the key's middle segment: ISO-shaped → `date`; non-empty otherwise → `episode`, upper-cased; empty → `none`.
- Quality tokens back to strings; `resolution` re-suffixed with `p`; `extras.container` to `container`; the three booleans to `'yes'` or `''`.
- Emit a key for **every** declared field, `''` where absent, so the form has no undefined inputs.
- Add a comment noting that `bitrateKbps` and `sizeBytes` have no field and would be dropped, so whoever makes the parser emit them adds fields in the same change.

`sceneSuggestManualValues(releaseName, options)`:
- Wrap the whole body in `try`/`catch` returning `{}`. It must never throw.
- Reuse Task 1's exports: `extractQuality(releaseName, undefined)` for resolution/container, `matchSitePrefix(tokensOf(releaseName), options.sites ?? [])` for a leading known site, `findSceneDate` for a date.
- Do not invent a title. Empty is the honest answer for a name the parser could not decompose.

- [ ] **Step 4: Wire the hooks into the plugin**

In `packages/plugin-scenes/src/index.ts` (note `options` is reassigned by `learnSites`, so read it at call time, not at construction):

```ts
    manualFields: () => sceneManualFields(),
    fromManualValues: (values) => sceneFromManualValues(values, options),
    toManualValues: (media) => sceneToManualValues(media),
    suggestManualValues: (releaseName) => sceneSuggestManualValues(releaseName, options),
```

- [ ] **Step 5: Verify**

```
npm run check
```

If the round-trip test fails for one of the `NAMES`, **report it rather than deleting the name or loosening the assertion.** A shape that will not round-trip is a real finding about the identity model. The one previously-known counterexample is already in the list and `titleOrder` is the fix for it.

---

### Task 3: Migration 3 and the database helpers

**Files:**
- Modify: `packages/core/src/db/migrations.ts`
- Modify: `packages/core/src/db/feed-items.ts`
- Modify: `packages/core/src/db/groups.ts`
- Modify: `packages/core/src/db/releases.ts`
- Test: `packages/core/test/db/manual.test.ts` (create; the directory exists)

**Spec:** §6, and §7.3–§7.4 for what the helpers are for.

**Interfaces:**
- Produces, all consumed by Task 5:
  ```ts
  // feed-items.ts — FeedItemRow and toFeedItemRow do NOT exist yet; create them,
  // modelled on groups.ts's GroupRow/toGroupRow/SELECT trio.
  export interface FeedItemRow {
    id: number; feedId: string; guid: string; rawTitle: string; link: string;
    publishedAt: number | null; firstSeenAt: number;
    parseError: string | null; dismissedAt: number | null;
  }
  export function toFeedItemRow(row: SqlRow): FeedItemRow
  export function getFeedItem(db, id: number): FeedItemRow | null
  export function failedFeedItems(db, query: {
    cursor: { firstSeenAt: number; id: number } | null;
    limit: number;
    includeDismissed: boolean;
  }): FeedItemRow[]
  export function clearParseError(db, id: number): void   // nulls parse_error AND dismissed_at
  export function setDismissedAt(db, id: number, dismissedAt: number): void

  // groups.ts
  export function refreshUpgradeFlag(db, groupId: number): void
  export function updateGroupIdentity(db, g: { id; identityKey; display; searchText }): void
  export function markGroupEdited(db, groupId: number, editedAt: number): void
  export function moveReleasesToGroup(db, fromGroupId: number, toGroupId: number): void
  export function deleteGroup(db, id: number): void
  export function groupHasHistory(db, groupId: number): boolean

  // releases.ts
  export function updateReleaseQuality(db, r: { id; quality: string; score: number }): void
  export function markReleaseEdited(db, releaseId: number, editedAt: number): void
  ```

`setDismissedAt` is deliberately not called `dismissFeedItem`: Task 5 produces an operation by that name, and two functions with one name and different arities across two layers is how an import alias becomes a bug. It also reads correctly beside the existing `setParseError` in the same file.

`markGroupEdited`/`markReleaseEdited` are separate from the update helpers because §7.1 needs to stamp `edited_at` on rows it did *not* otherwise rewrite — a resolve stamps the release and, only when it created it, the group.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/db/manual.test.ts`, one `test()` per behaviour, seeding in the style of `packages/core/test/http/server.test.ts`'s `seedGroups`:
- `failedFeedItems` returns only rows with a `parse_error`; excludes dismissed by default; includes them with `includeDismissed: true`; pages by the `(first_seen_at DESC, id ASC)` cursor.
- `clearParseError` nulls both `parse_error` and `dismissed_at`.
- `groupHasHistory` is false for a bare group, true once a `downloads` row exists, true once an `imported_files` row exists.
- `refreshUpgradeFlag` sets the flag to the best release beating the picked one, clears it when none does, and **leaves `list_rank_at` untouched** — read the timestamp before and after and assert equality. That assertion is the reason this helper exists rather than reusing `flagUpgrade`.
- `markGroupEdited` and `markReleaseEdited` write only `edited_at`.

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/db/manual.test.ts
```

- [ ] **Step 3: Add migration 3**

Read how migration 2 (`discovered_sites`) is registered first: a module-level `const` template string appended to the exported `migrations` array as `{ version: 3, up(db) { db.exec(SQL); } }`. The runner wraps each `up()` in its own transaction, and `db.exec` runs all four statements in one call.

```sql
ALTER TABLE feed_items   ADD COLUMN dismissed_at INTEGER;
ALTER TABLE media_groups ADD COLUMN edited_at    INTEGER;
ALTER TABLE releases     ADD COLUMN edited_at    INTEGER;
CREATE INDEX feed_items_failed
  ON feed_items (first_seen_at DESC, id) WHERE parse_error IS NOT NULL;
```

- [ ] **Step 4: Implement the helpers**

```ts
/**
 * Re-derives the flag and nothing else. `flagUpgrade` cannot be reused here:
 * it also moves `list_rank_at`, and only a new release arriving earns a group
 * a place at the top of the list. Correcting a release's quality is not an
 * arrival.
 */
export function refreshUpgradeFlag(db: DatabaseSync, groupId: number): void {
  const group = getGroup(db, groupId);
  if (group === null) return;
  db.prepare('UPDATE media_groups SET upgrade_release_id = ? WHERE id = ?').run(
    deriveUpgradeReleaseId(db, groupId, group.pickedReleaseId),
    groupId,
  );
}
```

Every other setter takes the single-row `WHERE id = ?` form used throughout `downloads.ts`. `toGroupRow` gains `editedAt`, and the new `toFeedItemRow` includes `parseError` and `dismissedAt`. `PRAGMA foreign_keys = ON` is set, so `moveReleasesToGroup` must run before `deleteGroup`.

- [ ] **Step 5: Verify**

```
npm run check
```

`openTestDatabase` runs every migration from scratch, so a green suite covers the migration.

---

### Task 4: One shared path for committing a release

**Files:**
- Create: `packages/core/src/ingest/commit.ts`
- Modify: `packages/core/src/ingest/ingest.ts`
- Test: `packages/core/test/ingest/commit.test.ts` (create)

**Spec:** §7.1 (the extraction requirement).

**Interfaces:**
- Produces, consumed by Task 5:
  ```ts
  export interface PreparedRelease {   // moves here from ingest.ts, now exported
    identityKey: string; displayJson: string; searchText: string;
    qualityJson: string; score: number;
  }
  export interface CommitOutcome {
    groupId: number; releaseId: number; groupCreated: boolean; upgradeFlagged: boolean;
  }
  export function validateParsed(
    plugin: MediaTypePlugin, parsed: ParsedRelease,
  ): { prepared: PreparedRelease } | { error: string };
  export function commitRelease(
    db: DatabaseSync, prepared: PreparedRelease, plugin: MediaTypePlugin,
    feedItemId: number, now: number,
  ): CommitOutcome;
  ```
  `searchTextFor` (currently private at `ingest.ts:45`) moves here too, called from inside `validateParsed`. Task 5 must never recompute a search text.

`commitRelease` returns `releaseId` because Task 5 stamps `edited_at` on it.

**`validateParsed` owns its own try/catch**, returning `{ error: 'plugin threw: …' }`. It calls `plugin.score`, which is third-party code: in `ingest.ts` that call sits inside `prepareSafely`'s guard, and moving it out unguarded would turn a throwing `score` into a 500 and a rollback in Task 5. `prepareSafely` keeps its own try/catch around `plugin.parse` and delegates the rest.

This is a pure refactor: `ingestEntries` must behave identically, and its existing tests are the proof. **Do not change the bump rule while moving it** — `list_rank_at` moves only when a newly arrived release beats both the picked release and any already-flagged upgrade, and `flagUpgrade` re-derives which release is flagged. A "tidier" version that flags directly is a regression.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/ingest/commit.test.ts`, one `test()` each: `commitRelease` creates a group when the key is new; joins the existing group when it is not; inserts a release against the feed item and returns its id; flags an upgrade and bumps `list_rank_at` when the new release beats a picked one; leaves `list_rank_at` alone when it does not. `validateParsed` rejects an empty `identityKey`, a non-array `display.fields`, and a `NaN` score, each naming the fault; and returns `plugin threw: …` when `score` throws rather than propagating.

- [ ] **Step 2: Run and watch it fail**

```
node --import tsx --conditions development --test packages/core/test/ingest/commit.test.ts
```

- [ ] **Step 3: Extract**

Move the code. Change no logic. `ingestEntries` keeps its transaction handling, its `parseFailures` reporting and its cap.

- [ ] **Step 4: Verify the refactor changed nothing**

```
node --import tsx --conditions development --test packages/core/test/ingest/ingest.test.ts
```

**If you needed to edit an existing ingest test to make it pass, stop and report** — the extraction was supposed to be behaviour-preserving.

- [ ] **Step 5: Full verify**

```
npm run check
```

---

### Task 5: The manual operations

**Files:**
- Create: `packages/core/src/manual/operations.ts`
- Test: `packages/core/test/manual/operations.test.ts` (create; the directory does not exist yet)

**Spec:** §7 in full. Read all four subsections before starting.

**Interfaces:**
- Consumes: everything Tasks 3 and 4 produce.
- Produces, consumed by Task 6:
  ```ts
  export interface ManualDeps {
    db: DatabaseSync;
    registry: PluginRegistry;
    pluginForFeed(feedId: string): MediaTypePlugin | null;
    now(): number;
  }
  export type ManualResult<T> = { ok: T } | { error: string; status: 400 | 404 | 409 };

  export function resolveFeedItem(deps: ManualDeps, feedItemId: number, values: Record<string, string>): ManualResult<{ groupId: number; joinedExisting: boolean }>
  export function dismissFeedItem(deps: ManualDeps, feedItemId: number): ManualResult<{ dismissedAt: number }>
  export function editGroup(deps: ManualDeps, groupId: number, values: Record<string, string>): ManualResult<{ groupId: number; mergedInto: number | null }>
  export function editRelease(deps: ManualDeps, releaseId: number, values: Record<string, string>): ManualResult<{ groupId: number }>
  ```

Carrying the status alongside the message keeps HTTP out of the operations while letting Task 6 map them without a second table of rules. A `fromManualValues` rejection and a `validateParsed` rejection are both **400** — they are bad input, not a bad request shape.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/manual/operations.test.ts`. Use a hand-written fake plugin (see `packages/core/test/ingest/ingest.test.ts:23` for the pattern), not the scenes plugin, so these tests describe core's rules and not the parser's. One `test()` per behaviour:

*resolve* — creates a group and clears `parse_error`; joins an existing group with the same key and reports `joinedExisting: true`; stamps `edited_at` on the release always; stamps it on a group it created; **leaves `edited_at` null on a group it merely joined**; clears `dismissed_at`; **bumps `list_rank_at` when the new release beats a picked one, because a resolve is an arrival**; 409 for an item that already parsed; 404 for an unknown id; 409 naming the feed when `pluginForFeed` returns null; 400 with the plugin's own message when `fromManualValues` rejects; 400 when `validateParsed` rejects.

*dismiss* — sets `dismissed_at`; 409 for an item with no `parse_error`.

*editGroup* — display-only change keeps the key; a new key updates the row; a new key belonging to another group moves the releases, re-derives the target's flag, deletes the source, reports `mergedInto`, stamps `edited_at` on the **target**, and **leaves the target's display and search_text alone**; 409 when the source group has a download; 409 when it has an imported file; `list_rank_at` unchanged in every branch.

*editRelease* — writes quality and the recomputed score; stamps `edited_at`; re-derives the group's upgrade flag; leaves `list_rank_at` unchanged.

*degradation* — a plugin implementing none of the manual hooks: `resolveFeedItem`, `editGroup` and `editRelease` all return 409 rather than throwing, and `dismissFeedItem` still succeeds.

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/manual/operations.test.ts
```

- [ ] **Step 3: Implement**

Each operation runs inside `BEGIN`/`COMMIT` with `ROLLBACK` on throw, matching `ingestEntries`.

`resolveFeedItem`: `fromManualValues` → `validateParsed` → `commitRelease` → `clearParseError` → `markReleaseEdited(outcome.releaseId, now)`, then `markGroupEdited(outcome.groupId, now)` **only when** `outcome.groupCreated`.

`editGroup`: `validateParsed(plugin, media)` supplies `identityKey`, `displayJson` and `searchText` — never recompute a search text here. Merge path: `groupHasHistory(source)` → 409 naming the obstruction; otherwise `moveReleasesToGroup`, `refreshUpgradeFlag(target)`, `markGroupEdited(target, now)`, `deleteGroup(source)`, in that order (foreign keys are on).

`editRelease`: `updateReleaseQuality` with `plugin.score(quality)`, `markReleaseEdited`, `refreshUpgradeFlag(groupId)`.

- [ ] **Step 4: Verify**

```
npm run check
```

---

### Task 6: HTTP endpoints

**Files:**
- Modify: `packages/core/src/http/server.ts`
- Modify: `packages/core/src/http/views.ts`
- Modify: `packages/core/src/main.ts`
- Modify: `packages/core/test/http/server.test.ts` (its `deps()` helper gains a field)
- Test: `packages/core/test/http/manual.test.ts` (create)

**Spec:** §8 in full — seven endpoints, including `/api/manual-preview`.

**Interfaces:**
- Consumes: Task 5's operations.
- Produces: the seven endpoints; `FailedItemView` and `FailedResponse` in `views.ts`; `manualValues` on `GroupView` and `ReleaseView` — all consumed by Tasks 7–9.

**The plumbing this needs, which does not exist yet.** `toGroupView(db, group)` has no access to a plugin and `ServerDeps` has no registry, yet four things need one. So:

- `ServerDeps` gains `registry: PluginRegistry` **and** `pluginForFeed(feedId: string): MediaTypePlugin | null`, both wired in `main.ts` from `config.feeds` and the existing registry.
- `toGroupView(db, group, plugin: MediaTypePlugin | undefined)` takes a third argument; all existing call sites in `server.ts` pass `deps.registry.byId(group.plugin)`.
- `test/http/server.test.ts`'s `deps()` helper (`:41`) gains `registry` and `pluginForFeed`. Its existing assertions must keep passing untouched.
- `ReleaseView.manualValues` **cannot be built from a `ReleaseRow` alone** — `toManualValues` needs the whole `ParsedRelease`. Build it inside `toGroupView`, where the `GroupRow` is in hand:
  ```ts
  plugin?.toManualValues?.({
    identityKey: group.identityKey,
    display: JSON.parse(group.display) as DisplayFields,
    quality: JSON.parse(release.quality) as QualityTokens,
  })
  ```
  Both `manualValues` fields are omitted entirely when the plugin has no hook (`exactOptionalPropertyTypes`: conditional spread, not `undefined`). Their absence is how the SPA decides whether to offer an Edit control.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/http/manual.test.ts`, following the `buildServer(deps(db))` + `server.inject` style of `packages/core/test/http/server.test.ts`. Cover: the schema endpoint returns a field list per plugin id; `/api/failed` lists failures newest-first, paginates by cursor, and hides dismissed items unless `includeDismissed=1`; resolve returns the group view and `joinedExisting`; dismiss; `PATCH /api/groups/:id` returns `mergedInto` on a merge and 409 when refused; `PATCH /api/releases/:id` returns the group with the rescored release; `POST /api/manual-preview` returns an identity key for good values and `{ error }` for bad ones **without writing anything** (assert the group count is unchanged); a malformed body is 400.

Add one test asserting `GroupView.manualValues` and `ReleaseView.manualValues` are present for a plugin with the hook and absent for one without.

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/http/manual.test.ts
```

- [ ] **Step 3: Implement**

Validate every body with zod as the existing routes do — `z.object({ values: z.record(z.string(), z.string()) })`; zod is v3 and the two-argument `z.record` form is already used in `config/schema.ts`. Map `ManualResult`'s status straight onto the reply code.

`/api/failed` follows the browse route's conventions exactly (`server.ts:45`): over-fetch by one to tell "there is more" from "that was everything", and a `"<firstSeenAt>:<id>"` cursor parsed by the same shape as `parseCursor`. Each `FailedItemView` gets `plugin` from the feed (`deps.pluginForFeed(row.feedId)`) and `suggestedValues` from `plugin?.suggestManualValues?.(row.rawTitle) ?? {}`. `includeDismissed` is the literal string `'1'`; anything else is false.

- [ ] **Step 4: Verify**

```
npm run check
```

---

### Task 7: The API client, the shared form, and the preview hook

**Files:**
- Modify: `packages/web/src/api/client.ts`
- Create: `packages/web/src/components/ManualForm.tsx`
- Create: `packages/web/src/api/useIdentityPreview.ts`
- Test: `packages/web/test/ManualForm.test.tsx` (create)

**Spec:** §9, and §8 for the preview endpoint.

**Interfaces:**
- Produces, consumed by Tasks 8 and 9:
  ```tsx
  interface Props {
    fields: ManualField[];
    values: Record<string, string>;
    /** Rendered under the fields. The caller supplies it; the form does no fetching. */
    preview?: string;
    submitLabel: string;
    onChange?(values: Record<string, string>): void;
    onSubmit(values: Record<string, string>): void;
    onCancel(): void;
  }
  export function ManualForm(props: Props)
  ```
  plus `useIdentityPreview(plugin: string, values: Record<string, string>): string` — debounced, calls `/api/manual-preview`, returns the key or the error message. Client methods: `manualFields()`, `failed(cursor, includeDismissed)`, `resolveFeedItem(id, values)`, `dismissFeedItem(id)`, `editGroup(id, values)`, `editRelease(id, values)`, `manualPreview(plugin, values)`.

Do **not** annotate the component's return type: React 19's types have no global `JSX` namespace, and the existing components (`MediaCard.tsx`, `ReleaseRow.tsx`) annotate none. Mirror the response types from `views.ts` into `client.ts` by hand, as the existing types there are.

The preview lives in a hook rather than in `ManualForm` so the form stays presentational and both callers get the debounce for free.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/test/ManualForm.test.tsx`: renders one labelled control per field; a `select` with its options for `type: 'select'`; prefills from `values`; reports the whole edited map on submit; does not submit when a `required` field is empty; renders `preview` when given one. Every control needs a `<label htmlFor>` so tests find it by accessible name. Follow `packages/web/test/Downloads.test.tsx` for setup.

- [ ] **Step 2: Run and watch them fail**

```
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/ManualForm.test.tsx
```

- [ ] **Step 3: Implement**

The form owns its draft state, seeded from `values`, reports the whole map on submit, and calls `onChange` on every keystroke so the caller can drive the preview. No fetching, no knowledge of feed items or groups.

- [ ] **Step 4: Verify**

```
npm run check
```

---

### Task 8: The Failed tab

**Files:**
- Create: `packages/web/src/routes/Failed.tsx`
- Modify: `packages/web/src/App.tsx` (nav link and route)
- Test: `packages/web/test/Failed.test.tsx` (create)

**Spec:** §9.

**Interfaces:** Consumes `ManualForm`, `useIdentityPreview` and the client methods from Task 7.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/test/Failed.test.tsx`: the list renders raw title and refusal reason; **Fix…** opens the form prefilled from `suggestedValues`; submitting removes the row and reports whether it joined an existing group; **Dismiss** removes the row; "Load more" appends without replacing; an item whose plugin has no schema shows no Fix control but still shows Dismiss.

Remember the `waitFor` rule in the Global Constraints — compare booleans, never a DOM node against `null`.

- [ ] **Step 2: Run and watch them fail**

```
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/Failed.test.tsx
```

- [ ] **Step 3: Implement**

Fetch `/api/manual-fields` once on mount, keyed by plugin id. Paginate exactly as `Browse.tsx` does, and **patch the list in place** after a resolve or dismiss — never refetch page one, which discards every page loaded past it.

- [ ] **Step 4: Verify**

```
npm run check
```

---

### Task 9: Editing on Browse

**Files:**
- Modify: `packages/web/src/components/MediaCard.tsx`
- Modify: `packages/web/src/components/ReleaseRow.tsx`
- Modify: `packages/web/src/routes/Browse.tsx`
- Test: `packages/web/test/Browse.test.tsx` (extend)
- Test: `packages/web/test/MediaCard.test.tsx` (extend — it renders `MediaCard` with exactly `{ group, onPick }` today, so new props must be optional or this file breaks)

**Spec:** §9, and §7.3–§7.4 for what each edit means.

**Interfaces:** Consumes `ManualForm`, `useIdentityPreview` and the client methods from Task 7.

`onEditGroup` and `onEditRelease` are **optional** props. Absent → no control rendered, which is also how the §4 degradation rule reaches the UI: a group whose `manualValues` is missing gets no handler and therefore no button.

- [ ] **Step 1: Write the failing tests**

Extend `packages/web/test/Browse.test.tsx`: an **Edit** control on the card opens the identity form prefilled from `group.manualValues`; saving patches that card in place and does not collapse pagination; a per-release **Edit** opens the quality form from `release.manualValues`; a 409 from a refused merge shows the message and leaves the card as it was; a group whose `manualValues` is absent shows no card-level Edit; a release whose `manualValues` is absent shows no row-level Edit.

The existing test `picking after "load more" keeps the pages already loaded` is the model for the pagination assertion — an edit must not regress what the pick fix established.

Extend `packages/web/test/MediaCard.test.tsx` with one test: omitting the edit handlers renders no Edit control.

- [ ] **Step 2: Run and watch them fail**

```
TSX_TSCONFIG_PATH=packages/web/tsconfig.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/Browse.test.tsx
```

- [ ] **Step 3: Implement**

Both handlers take the `group` from the response and patch it into the list by id, exactly as `pick` now does.

- [ ] **Step 4: Verify the whole thing**

```
npm run check
```

Then confirm the two user-visible flows by reading the code paths end to end: a failed item resolved into an existing group appears on Browse under that group; a release edited to a higher resolution rescores and reorders within its card.

---

## Notes for the controller

- Nothing in this plan commits. Snapshot each task with `git stash create` (writes a commit object without touching HEAD or the working tree) and diff consecutive snapshots for review.
- Task 2's round-trip test is the one most likely to surface a genuine design finding rather than an implementation slip. Treat a failure there as information, not as a test to relax.
- Task 6 changes `toGroupView`'s signature and `ServerDeps`' shape, so it touches an existing test file. That is expected and called out in its Files list; a task quietly editing a test not in its list is not.
- Ordering: 1→2 and 3→4→5→6 are strict. Tasks 7→8 and 7→9 depend only on 6.
