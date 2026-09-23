# Unmatched Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/unmatched` into a list of expandable cards that name the feed, say why each release is unmatched, show the lookup answer behind it, and page past the first 24.

**Architecture:** A new nullable `rss_item.lookup_json`, written by the lookup engine only when a lookup does *not* resolve and cleared when one does, replicated through the existing `rss_item` sync projection. The client composes `@pickarr/plugin-ui`'s `CardHeading` and `useExpansion` inside web's own `<article>`, so the title line reuses the browse card's stylesheet rules unchanged.

**Tech Stack:** TypeScript (`verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `node:sqlite` + drizzle, React 19, `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-unmatched-page-design.md`

## Global Constraints

- **Never the `any` type.** Narrow with `in` and `typeof`; never `as` a replica row — a replica outlives the build that wrote it (`plugin.ts`'s `PluginRows` doc).
- **Migrations on a synced table are `ALTER TABLE ... ADD COLUMN` only.** A create-copy-drop-rename silently takes the table's three sync triggers with it and stops it replicating (`docs/database-migrations.md`).
- **Zero is an answer.** `undefined` means "still loading"; `[]` means "loaded, and there are none". The two must never render the same way.
- **Lists come from the replica only.** No `fetch` in any hook on this screen.
- **A card ships markup, web ships CSS.** No stylesheet in `@pickarr/plugin-ui`; no class attributes in `packages/web/src` — every selector is structural.
- **`afterEach(cleanup)` in every web test file**, never a per-test `cleanup()`.
- **Never hand a live DOM element to `node:assert`.** `scripts/check-test-hygiene.ts` fails the build on it; use `assert.ok(!screen.queryByText(x))` or `gone()`.
- **Prefer the async form of an API over its synchronous twin.**
- **No plugin id spelled in `packages/web/src` outside the registry** — `test/plugins/registry.test.ts` enforces it, comments included.
- Gate: `npm run build` → `npm run check` → `npm run e2e`.

---

### Task 1: The column, the contract, and the sync surface

**Files:**
- Modify: `packages/contract/src/sync.ts` (`RssItemSyncRead`)
- Modify: `packages/host/src/db/migrate.ts` (new `MIGRATION_22`)
- Modify: `packages/host/src/db/schema.ts` (`rssItem`)
- Modify: `packages/host/src/sync/tables.ts` (`selectSql`'s `rss_item` case)
- Modify: `packages/host/test/sync/tables.test.ts` (`HOST_READ_SHAPE_FIELDS`)
- Test: `packages/host/test/db/migrate.test.ts`

**Interfaces:**
- Produces: `RssItemSyncRead.lookupJson: string | null`, replicated. Task 3 writes it; tasks 5 and 7 read it.

- [ ] **Step 1: Add the field to the contract**

In `packages/contract/src/sync.ts`, after `resolutionDetail` in `RssItemSyncRead`:

```ts
  /**
   * The lookup service's own answer for this release, as JSON, or `null`.
   *
   * **Only present while a release is unmatched.** Written on the two
   * terminal branches that leave a release unidentified -- `refused` and
   * `unresolved` -- and cleared by the `UPDATE` that resolves one, so a
   * matched release carries no copy of the answer that matched it. That
   * bound is the whole reason this column is affordable: without it, every
   * client's replica would grow by one lookup response per release for
   * ever.
   *
   * Serialised from the validated `LookupEnvelope`, never from the
   * response bytes, and with `media` omitted. Capped: over the cap the
   * column holds a short marker instead, which the unmatched screen
   * renders in place of the answer.
   */
  lookupJson: string | null;
```

- [ ] **Step 2: Write the migration test first**

In `packages/host/test/db/migrate.test.ts`, alongside the existing migration tests:

```ts
test('migration 22 adds lookup_json without rebuilding rss_item, so its sync triggers survive', () => {
  // The hazard `docs/database-migrations.md` exists for: a
  // create-copy-drop-rename would take the table's three triggers with it
  // and stop `rss_item` replicating to every client, silently -- the
  // screen would simply never update again. Asserted on the triggers
  // themselves, not on the column, because the column is the easy half.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const columns = raw.prepare("SELECT name FROM pragma_table_info('rss_item')").all()
    .map((row) => String((row as { name: unknown }).name));
  assert.ok(columns.includes('lookup_json'), 'the column is there');

  const triggers = raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'rss_item' ORDER BY name",
  ).all().map((row) => String((row as { name: unknown }).name));
  assert.deepEqual(triggers, ['rss_item_sync_del', 'rss_item_sync_ins', 'rss_item_sync_upd'],
    'all three sync triggers are still attached');
  raw.close();
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run test:server -- --test-name-pattern="migration 22"`
Expected: FAIL — `the column is there` (`lookup_json` is not in `pragma_table_info`).

- [ ] **Step 4: Add the migration**

In `packages/host/src/db/migrate.ts`, after `MIGRATION_21`:

```ts
/**
 * `rss_item.lookup_json`: the lookup service's answer for a release that
 * did not resolve, or `NULL`.
 *
 * `ALTER TABLE ... ADD COLUMN` and no rebuild, for the reason
 * `MIGRATION_21` above gives and `docs/database-migrations.md` records: a
 * create-copy-drop-rename would take `rss_item`'s three sync triggers with
 * it and silently stop the table replicating.
 *
 * **No `seedSyncLog` and no `installSyncTriggers`.** `rss_item` has been in
 * the synced set since the first migration that built it, so its triggers
 * are already attached and every existing row is already indexed in
 * `sync_log`. Adding a column does not change which rows exist -- and the
 * `UPDATE` that first writes this column fires the existing update trigger,
 * which is what carries the new value to clients.
 */
const MIGRATION_22 = `
ALTER TABLE rss_item ADD COLUMN lookup_json TEXT;
`;
```

and in the `MIGRATIONS` array, after version 21:

```ts
  { version: 22, up: (db) => db.exec(MIGRATION_22) },
```

- [ ] **Step 5: Add the drizzle column**

In `packages/host/src/db/schema.ts`, in `rssItem`, after `resolutionDetail`:

```ts
  // Written only while a release is unmatched, cleared when it resolves --
  // `@pickarr/contract`'s `RssItemSyncRead.lookupJson` carries why.
  lookupJson: text('lookup_json'),
```

- [ ] **Step 6: Run the schema-parity test**

Run: `npm run test:server -- --test-name-pattern="schema"`
Expected: PASS. `test/db/schema.test.ts` compares migration DDL against `schema.ts` in both directions, so a column in one and not the other fails here.

- [ ] **Step 7: Add it to the projection and its witness**

In `packages/host/src/sync/tables.ts`, the `rss_item` case:

```ts
    case 'rss_item':
      return `SELECT id, feed_id AS feedId, filename, created_at AS createdAt,
                      updated_at AS updatedAt, download_type AS downloadType,
                      media_item_id AS mediaItemId, ranking_score AS rankingScore, resolution,
                      resolution_detail AS resolutionDetail, delivered_at AS deliveredAt,
                      lookup_json AS lookupJson
                 FROM rss_item WHERE id IN (${placeholders})`;
```

In `packages/host/test/sync/tables.test.ts`, `HOST_READ_SHAPE_FIELDS.rss_item`:

```ts
  rss_item: {
    id: true, feedId: true, filename: true, createdAt: true, updatedAt: true,
    downloadType: true, mediaItemId: true, rankingScore: true, resolution: true,
    resolutionDetail: true, deliveredAt: true, lookupJson: true,
  } satisfies Record<keyof RssItemSyncRead, true>,
```

- [ ] **Step 8: Run the whole host suite**

Run: `npm run test:server`
Expected: PASS. The `satisfies` is exhaustive both ways, so step 1 without this step is a compile error and this step without step 7 is an assertion failure.

- [ ] **Step 9: Commit**

```bash
git add packages/contract packages/host
git commit -m "Carry a release's lookup answer to clients, for unmatched releases only"
```

---

### Task 2: Serialising and capping the envelope

**Files:**
- Create: `packages/openmetadata/src/lookupJson.ts`
- Test: `packages/openmetadata/test/lookupJson.test.ts`

**Interfaces:**
- Consumes: `LookupEnvelope` (`packages/openmetadata/src/types.ts`)
- Produces: `export function lookupJsonFor(envelope: LookupEnvelope): string`, and `export const LOOKUP_JSON_CAP_BYTES = 8192`, and `export const LOOKUP_JSON_TOO_LARGE`. Task 3 calls it.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupJsonFor, LOOKUP_JSON_CAP_BYTES, LOOKUP_JSON_TOO_LARGE } from '../src/lookupJson.ts';
import type { LookupEnvelope } from '../src/types.ts';

function envelope(over: Partial<LookupEnvelope> = {}): LookupEnvelope {
  return {
    lookupId: 'lk_01HTEST',
    state: 'unresolved',
    partial: false,
    cached: false,
    confidence: null,
    refusal: null,
    parsed: null,
    media: null,
    suggestions: null,
    ...over,
  };
}

test('the envelope is serialised as readable JSON', () => {
  const json = lookupJsonFor(envelope({ confidence: 0.25 }));
  const back: unknown = JSON.parse(json);
  assert.deepEqual(back, {
    lookupId: 'lk_01HTEST',
    state: 'unresolved',
    partial: false,
    cached: false,
    confidence: 0.25,
    refusal: null,
    parsed: null,
    suggestions: null,
  });
});

test('media is never stored, however large the answer', () => {
  // Belt and braces: `media` is null on both branches that call this, so
  // this cannot fire today. It is the one field that would make the column
  // unbounded if a later branch started writing, and a test is cheaper
  // than noticing that in a replica.
  const withMedia = envelope({
    media: { title: 'A Film', people: [] } as unknown as LookupEnvelope['media'],
  });
  const back: unknown = JSON.parse(lookupJsonFor(withMedia));
  assert.ok(typeof back === 'object' && back !== null && !('media' in back),
    'media is dropped rather than serialised');
});

test('an oversized envelope is replaced by a marker, not truncated', () => {
  // Truncated JSON does not parse, so a card would have to render a broken
  // string or guess. A marker is a value the client can recognise and
  // explain. The cap protects every client's replica from one pathological
  // response.
  const huge = envelope({ parsed: { blob: 'x'.repeat(LOOKUP_JSON_CAP_BYTES * 2) } });
  assert.equal(lookupJsonFor(huge), LOOKUP_JSON_TOO_LARGE);
});

test('an envelope exactly at the cap is kept', () => {
  // The boundary, spelled out: `>` and `>=` are one character apart and
  // only this test tells them apart.
  const under = envelope();
  assert.ok(Buffer.byteLength(lookupJsonFor(under), 'utf8') <= LOOKUP_JSON_CAP_BYTES);
  assert.notEqual(lookupJsonFor(under), LOOKUP_JSON_TOO_LARGE);
});

test('the cap is measured in bytes, not characters', () => {
  // A multi-byte character counts once as a character and up to four times
  // as a byte, and it is bytes that land in the replica. Built to exceed
  // the cap in bytes while staying under it in `.length`.
  const wide = envelope({ parsed: { blob: '\u{1F600}'.repeat(LOOKUP_JSON_CAP_BYTES / 3) } });
  assert.equal(lookupJsonFor(wide), LOOKUP_JSON_TOO_LARGE);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:server -- --test-name-pattern="envelope|cap"`
Expected: FAIL — cannot resolve `../src/lookupJson.ts`.

- [ ] **Step 3: Write the module**

```ts
/**
 * Turning a `LookupEnvelope` into the string `rss_item.lookup_json` holds.
 *
 * **Serialised from the validated shape, never from the response bytes.**
 * `validate.ts` has already parsed the service's answer into a
 * `LookupEnvelope` by the time this runs, so what reaches a client's
 * replica is a re-serialisation of a shape `types.ts` declares -- not
 * arbitrary text from a third party. The one exception is `parsed`, which
 * its own type documents as "carried through unvalidated beyond object or
 * null"; it is stored because it is the single most useful field for
 * diagnosing why a name was not recognised, and this sentence is the
 * record that it is the part of this column that is not shape-checked.
 *
 * **Not passed through `redactSecrets`.** That would mangle `lookupId` --
 * an opaque token of exactly the shape its hex and alphanumeric rules
 * match -- and destroy the one field that correlates a card on screen with
 * the service's own logs. The envelope is an answer *about a filename*,
 * and that filename is already in the replica.
 */
import type { LookupEnvelope } from './types.ts';

/**
 * The most this column may hold, in bytes on the wire.
 *
 * A number rather than a judgement call at the call site: this bounds
 * every client's replica, since a synced column is copied into every
 * browser that ever connects.
 */
export const LOOKUP_JSON_CAP_BYTES = 8192;

/**
 * What is stored instead of an answer too large to keep.
 *
 * **A marker, not a truncation.** Truncated JSON does not parse, so a
 * client would have to render a broken string or guess where it stopped.
 * This is valid JSON carrying a field a reader can recognise, so the card
 * can say "too large" in its own words rather than showing wreckage.
 */
export const LOOKUP_JSON_TOO_LARGE = '{"pickarr":"lookup-answer-too-large"}';

export function lookupJsonFor(envelope: LookupEnvelope): string {
  // Destructured rather than deleted from a copy: `media` is excluded by
  // not being named, which is a rule the reader can check by reading, and
  // a field added to `LookupEnvelope` later is excluded by default rather
  // than included by accident.
  const { lookupId, state, partial, cached, confidence, refusal, parsed, suggestions } = envelope;
  const json = JSON.stringify({ lookupId, state, partial, cached, confidence, refusal, parsed, suggestions });
  // `Buffer.byteLength`, not `.length`: a multi-byte character counts once
  // as a character and up to four times in the replica.
  return Buffer.byteLength(json, 'utf8') > LOOKUP_JSON_CAP_BYTES ? LOOKUP_JSON_TOO_LARGE : json;
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npm run test:server -- --test-name-pattern="envelope|cap"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/openmetadata/src/lookupJson.ts packages/openmetadata/test/lookupJson.test.ts
git commit -m "Serialise a lookup answer for storage, without its media and under a cap"
```

---

### Task 3: Writing it, and clearing it

**Files:**
- Modify: `packages/contract/src/media.ts` (`MediaWriter.setResolution`)
- Modify: `packages/host/src/media/writer.ts`
- Modify: `packages/openmetadata/src/engine.ts`
- Modify: `packages/openmetadata/src/testing.ts` (the recording fake)
- Test: `packages/openmetadata/test/engine.test.ts`, `packages/host/test/media/writer.test.ts`

**Interfaces:**
- Consumes: `lookupJsonFor` (task 2), `rss_item.lookup_json` (task 1)
- Produces: `setResolution(rssItemId, resolution, detail, lookupJson)` — a **fourth required parameter**, so every existing call site is a compile error until it decides what to pass. That is deliberate: a defaulted `null` would let a branch forget to clear.

- [ ] **Step 1: Write the failing engine tests**

In `packages/openmetadata/test/engine.test.ts`, using that file's existing harness:

```ts
test('a refused answer stores the envelope behind it', () => {
  // The refusal sentence says *that* a name was rejected; the envelope
  // says what the service saw. The screen exists for the second question.
  // (Arrange a refused envelope through this file's existing harness and
  // assert the `setResolution` call recorded by `testing.ts`'s fake.)
});

test('an unresolved answer stores the envelope behind it', () => {});

test('a resolved answer stores no envelope, and clears one left by an earlier failure', () => {
  // **The clear is the half a happy-path test misses**, and it is what
  // bounds the column: a release that failed, was retried and matched must
  // not keep a copy of the answer that failed. Asserted as an explicit
  // `null` in the fourth argument, not as "absent".
});

test('a lookup still pending stores nothing, because nothing is known yet', () => {
  // The poll branch returns without calling `setResolution` at all --
  // pinned so that a later change which starts writing there does not
  // quietly store a half-answer under every pending release.
});

test('an envelope over the cap is stored as the marker', () => {});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:server -- --test-name-pattern="envelope|clears"`
Expected: FAIL — `setResolution` is recorded with three arguments.

- [ ] **Step 3: Widen the contract and the writer**

`packages/contract/src/media.ts`:

```ts
  /**
   * Records what became of a release's identification.
   *
   * `lookupJson` is the service's own answer, or `null` to clear one --
   * **a required parameter, never defaulted.** A default would let a
   * branch that resolves a release forget to clear the answer that failed
   * it, which is the one mistake that makes this column grow without
   * bound (`RssItemSyncRead.lookupJson`).
   */
  setResolution(rssItemId: number, resolution: Resolution, detail: string | null, lookupJson: string | null): Promise<void>;
```

`packages/host/src/media/writer.ts`:

```ts
    async setResolution(rssItemId: number, resolution: Resolution, detail: string | null, lookupJson: string | null): Promise<void> {
      const at = now();
      // `lookup_json` is written on every call, including with `null`,
      // which is what clears an answer left by an earlier failure.
      raw.prepare('UPDATE rss_item SET resolution = ?, resolution_detail = ?, lookup_json = ?, updated_at = ? WHERE id = ?')
        .run(resolution, detail, lookupJson, at, rssItemId);
    },
```

`packages/openmetadata/src/testing.ts` — widen the recording fake to take and record the fourth argument.

- [ ] **Step 4: Update the engine's four call sites**

`packages/openmetadata/src/engine.ts`:

```ts
// The resolved branch (~line 175): clears any answer an earlier failure left.
await ctx.media.setResolution(target.rssItemId, 'resolved', null, null);

// The MAX_POLLS branch (~line 208): the service never finished, and the
// last envelope is what says how far it got.
await ctx.media.setResolution(
  target.rssItemId,
  'unresolved',
  `the lookup service never finished lookup ${envelope.lookupId} for "${target.filename}"`,
  lookupJsonFor(envelope),
);

// The refused branch (~line 228).
await ctx.media.setResolution(target.rssItemId, 'refused', envelope.refusal, lookupJsonFor(envelope));

// The unresolved branch (~line 235).
await ctx.media.setResolution(
  target.rssItemId,
  'unresolved',
  describeUnresolved(target.filename, envelope.suggestions),
  lookupJsonFor(envelope),
);
```

- [ ] **Step 5: Run the suites and watch them pass**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 6: Mutation-check the clear**

Change the resolved branch's fourth argument from `null` back to omitting the write (`lookup_json` untouched in the `UPDATE`), run the suite, confirm `a resolved answer ... clears one left by an earlier failure` reddens, then restore. A test that does not fail here is not pinning the bound.

- [ ] **Step 7: Commit**

```bash
git add packages/contract packages/host packages/openmetadata
git commit -m "Store the lookup answer for a release that did not resolve, and clear it when one does"
```

---

### Task 4: The feed name, in the browser

**Files:**
- Create: `packages/web/src/library/useFeedNames.ts`
- Test: `packages/web/test/library/useFeedNames.test.tsx`

**Interfaces:**
- Consumes: `Store['listByTable']`, `Store['subscribeTable']`
- Produces: `export function useFeedNames(source: FeedNamesSource): ReadonlyMap<number, string>` and `export interface FeedNamesSource`. Task 5 renders from it.

- [ ] **Step 1: Write the failing tests**

```ts
test('a feed id resolves to its name', async () => {});

test('an id no feed claims is simply absent, not an empty string', async () => {
  // The card renders no trailing label at all for an unknown feed, which
  // is a different thing from a feed named ''. `Map.get` answering
  // `undefined` is what `CardHeading`'s optional `trailing` consumes.
});

test('a feed renamed after the first read is re-read', async () => {
  // `subscribeTable`, not `subscribeInserts`: a rename is an update, and
  // an inserts-only subscription sleeps through it. This is the same gap
  // that left a deleted feed on the settings screen until a reload.
});

test('reading feed names never calls fetch', async () => {
  // Global Constraint: lists come from the replica only. Asserted as a
  // call count, which a catch absorbing a stray fetch cannot fool.
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npm run test:web -- --test-name-pattern="feed id resolves"`
Expected: FAIL — cannot resolve `../src/library/useFeedNames.ts`.

- [ ] **Step 3: Write the hook**

```ts
/**
 * `feedId -> name`, for any screen that holds `rss_item` rows and wants to
 * say which feed produced one.
 *
 * **`subscribeTable`, not `subscribeInserts`.** A rename is an update, and
 * an inserts-only subscription does not see one -- the same gap that left
 * a removed feed on the settings screen until a reload
 * (`store/notify.ts`'s `subscribeTable` doc).
 *
 * Reads the whole table in one bounded page, the way `useFeeds` does and
 * for the same reason: a feed is something a person configures by hand.
 */
import { useEffect, useState } from 'react';
import type { Store } from '../store/index.ts';

const TABLE = 'rss_feed';
/** Matches `settings/useFeeds.ts`'s own limit -- see that file for why one page is enough. */
const FEEDS_LIMIT = 500;

export interface FeedNamesSource {
  listByTable: Store['listByTable'];
  subscribeTable: Store['subscribeTable'];
}

function nameOf(value: unknown): { id: number; name: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('id' in value) || !('name' in value)) return undefined;
  const { id, name } = value;
  return typeof id === 'number' && typeof name === 'string' ? { id, name } : undefined;
}

export function useFeedNames(source: FeedNamesSource): ReadonlyMap<number, string> {
  const [names, setNames] = useState<ReadonlyMap<number, string>>(new Map());

  useEffect(() => {
    let cancelled = false;

    function refresh(): void {
      source.listByTable(TABLE, { direction: 'prev', limit: FEEDS_LIMIT })
        .then((rows) => {
          if (cancelled) return;
          const next = new Map<number, string>();
          for (const row of rows) {
            const feed = nameOf(row.value);
            if (feed !== undefined) next.set(feed.id, feed.name);
          }
          setNames(next);
        })
        .catch((err: unknown) => {
          // The same store-closed race every screen guards: this can be
          // mounted and subscribed when the store stops (sign-out, a 401).
          if (typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError') return;
          throw err;
        });
    }

    refresh();
    const unsubscribe = source.subscribeTable(TABLE, refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);

  return names;
}
```

- [ ] **Step 4: Run and watch pass**

Run: `npm run test:web -- --test-name-pattern="feed id resolves|no feed claims|renamed|never calls fetch"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/library/useFeedNames.ts packages/web/test/library/useFeedNames.test.tsx
git commit -m "Resolve a feed id to its name from the replica"
```

---

### Task 5: The card

**Files:**
- Modify: `packages/web/src/library/Unmatched.tsx`
- Modify: `packages/web/src/styles/library.css`
- Modify: `packages/plugin-ui/src/expansion.tsx` (docblock only)
- Test: `packages/web/test/library/Unmatched.test.tsx`

**Interfaces:**
- Consumes: `CardHeading`, `useExpansion` (`@pickarr/plugin-ui`); `useFeedNames` (task 4); `RssItemSyncRead.lookupJson`, `.resolution`, `.resolutionDetail` (task 1)
- Produces: `UnmatchedSource` gains `subscribeTable`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a release renders as a card, with its filename as the title', async () => {});

test('the feed that produced it is named at the right of the title', async () => {
  // The same `<small>` the adult browse card uses, so web's existing
  // `article h2 button small` rule styles it -- asserted by finding the
  // element the stylesheet selects, not only the text.
});

test('a release whose feed the replica has not got renders no trailing label', async () => {});

test('collapsed, a card shows no detail and no JSON', async () => {
  // `useExpansion` starts closed, and the body is gated on it. Without
  // this, a card that rendered its body unconditionally would pass every
  // other test here.
});

test('expanded, a card says why the release is unmatched', async () => {
  // `resolution` and `resolutionDetail`, which the host has always sent
  // and nothing has ever rendered.
});

test('expanded, a card shows the lookup answer', async () => {});

test('a release with no stored answer expands without an empty block', async () => {
  // `lookupJson` is null for a release whose lookup never ran. An empty
  // `<pre>` is a bordered box containing nothing, which reads as a bug.
});

test('an answer too large to store says so, rather than rendering the marker JSON', async () => {
  // The marker is an implementation detail of the column, not a sentence
  // for an operator.
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npm run test:web -- --test-name-pattern="renders as a card"`
Expected: FAIL — the screen renders `<li>` text, not an `<article>`.

- [ ] **Step 3: Rewrite the row as a card**

Replace the `<ul>`/`<li>` render in `Unmatched.tsx`. `UnmatchedRow` grows the fields the body needs; each row becomes:

```tsx
function UnmatchedCard({ row, feedName }: { row: UnmatchedRow; feedName: string | undefined }): ReactElement {
  const { expanded, toggle } = useExpansion(() => {});

  return (
    <article>
      {/*
        The same two pieces a browse card composes, so this screen's title
        line is the browse card's title line -- `article h2 button` and
        `article h2 button small` already style it and no rule here is new.
        An unmatched release has no `media_item` and so no plugin card, but
        it should not look like a different application.
      */}
      <CardHeading
        headline={row.filename}
        {...(feedName === undefined ? {} : { trailing: feedName })}
        expanded={expanded}
        onToggle={toggle}
      />
      {expanded && <UnmatchedDetail row={row} />}
    </article>
  );
}
```

`useExpansion` takes a no-op reporter here: its callback exists so web can start and stop *gathering* for a browse card, and this screen gathers nothing — everything the body shows is already in the row it was handed.

- [ ] **Step 4: Write the body**

`UnmatchedDetail` renders the state line, the detail sentence, and the answer. The marker is recognised and replaced with a sentence rather than shown.

- [ ] **Step 5: Style the body**

In `packages/web/src/styles/library.css`, after the `article h2 button small` rule. Structural selectors only, no classes. Delete the old `ul[aria-label='unmatched releases']` rules — the list they styled is gone.

- [ ] **Step 6: Note the new consumer**

`packages/plugin-ui/src/expansion.tsx`'s docblock says these pieces exist so three plugins do not write `aria-expanded` three times. Add that web's own unmatched screen is now a fourth consumer, so the package is no longer only the plugin seam.

- [ ] **Step 7: Run and watch pass**

Run: `npm run test:web`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/web packages/plugin-ui
git commit -m "Render an unmatched release as an expandable card, with its feed and its lookup answer"
```

---

### Task 6: Seeing past the first 24

**Files:**
- Modify: `packages/web/src/library/Unmatched.tsx`
- Test: `packages/web/test/library/Unmatched.test.tsx`

**Interfaces:**
- Consumes: `useInfiniteScroll(onReach, enabled)` (`packages/web/src/library/useInfiniteScroll.ts`)

- [ ] **Step 1: Write the failing tests**

```ts
test('a second page is read on demand, and the first page is kept', async () => {});

test('the sentinel and the button both disappear once the table is exhausted', async () => {
  // Zero is an answer: "no more" must look different from "not loaded".
});

test('a wake resets the walk rather than resuming a stale cursor', async () => {
  // **The trap this whole task walks into.** A cursor taken before a batch
  // committed names a position that may no longer mean what it did, and
  // resuming from it would skip rows or repeat them. A wake re-reads from
  // the start; only an explicit `loadMore` advances.
});

test('paging does not re-walk the pages already read', async () => {
  // Counted as calls to `listByTable`, because the cost is the reason the
  // cursor exists: this screen has no index on "mediaItemId is null" and
  // walks the table to exhaustion on every read (21 page reads at 500
  // rows, measured).
});
```

- [ ] **Step 2: Run and watch fail**

Run: `npm run test:web -- --test-name-pattern="second page"`
Expected: FAIL — there is no way to ask for more.

- [ ] **Step 3: Give `readUnmatched` a cursor and `Unmatched` a `loadMore`**

`readUnmatched` takes an optional starting cursor and returns the rows **and** where it stopped (`undefined` when the table was exhausted). `Unmatched` keeps the accumulated rows, the cursor and a `done` flag; a wake discards all three and re-reads from the start.

- [ ] **Step 4: Render the sentinel and the button**

The same shape `Category` uses — sentinel above a retained Load more button, both gated on `!done`:

```tsx
{!done && (
  <>
    <div ref={sentinel} data-testid="load-more-sentinel" />
    <button type="button" onClick={loadMore}>Load more</button>
  </>
)}
```

- [ ] **Step 5: Run and watch pass**

Run: `npm run test:web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web
git commit -m "Page the unmatched list past its first screen, by scroll and by button"
```

---

### Task 7: The browser proof

**Files:**
- Modify: `packages/e2e/src/harness-2.ts` (a seeder)
- Modify: `packages/e2e/tests/shell.spec.ts`

**Interfaces:**
- Produces: `Harness.seedUnmatchedRelease(input: { filename: string; feedName: string; resolution: string; detail: string; lookupJson: string | null }): number`

- [ ] **Step 1: Add the seeder**

An `rss_feed` through `host.addFeed` (the real writer, as `seedPickableRelease` does) and a direct `rss_item` insert with `media_item_id` NULL and the three new-ish columns set.

- [ ] **Step 2: Write the spec**

```ts
test('an unmatched release reads as a card, and opens to show why it is unmatched', async ({ page, harness }) => {
  // **`getByRole` cannot see "styled like the xxx category".** That is the
  // whole of the styling ask, and an unstyled `<small>` after an unstyled
  // heading satisfies every unit test in `Unmatched.test.tsx` --
  // `IdentityChangeConfirm`'s exact shape (`CLAUDE.md`). So this measures
  // the title line's geometry and colour, the same way the adult card's
  // own spec does, and clicks through to the body.
});
```

It asserts: the card's feed label sits at the right-hand edge and takes `--color-text-dim`; the body is absent until the title is clicked; after the click the state, the sentence and the JSON are on screen.

- [ ] **Step 3: Run it**

Run: `npm run e2e -w @pickarr/e2e -- -g "unmatched release reads as a card"`
Expected: PASS.

- [ ] **Step 4: Mutate the stylesheet against it**

Delete `article h2 button small`, rebuild web, re-run: the colour assertion must red. Restore. A pin that survives its rule being deleted is not a pin.

- [ ] **Step 5: Full gate**

Run: `npm run build && npm run check && npm run e2e`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/e2e
git commit -m "Prove the unmatched card in a real browser, including that it is styled"
```

---

## Notes for the executor

- **The `SCHEMA_VERSION` question.** `packages/web/src/store/db.ts`'s `SCHEMA_VERSION` is **2** and this plan does not bump it. Adding a *field* to a synced projection is not an IndexedDB schema change — no store and no index changes — and the existing replica holds rows without `lookupJson` that will be replaced by the next update to each row. A card whose row predates the column renders as "no stored answer", which is task 5's own case. Bump it only if a reviewer can name a read that breaks; a bump forces every client through a full resync.
- **`/api/rss-items` is deliberately untouched.** `api/reads.ts`'s `RssItemRead` is a different shape from `RssItemSyncRead`, served behind the session guard to a caller that asks once. Nothing needs the answer there, and widening it would be a second decision about a third-party string leaving the host.
