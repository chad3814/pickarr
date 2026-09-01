# Browse ⊕ Failed Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Failed tab, interleaving the names the parser refused into Browse's own list as cards ordered by recency, with the set-aside ones on a Dismissed tab of their own.

**Architecture:** One `UNION ALL` over `media_groups` and `feed_items`, each branch bounded by the cursor and limited before the union, ordered `(sort_key DESC, kind ASC, id ASC)`. The server owns that ordering; the client renders whichever card the discriminated union names. The cursor gains a `kind` discriminator because a group id and a feed-item id are unrelated namespaces.

**Tech Stack:** TypeScript, `node:sqlite`, Fastify + zod, React 19, react-router 7, `node:test` + happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-01-browse-failed-merge-design.md`

## Global Constraints

- Never use the `any` type. Never widen a type with a cast to make an error go away.
- `noUncheckedIndexedAccess` is on. Indexed and `Map.get` access is checked, never `!`-asserted — a deleted bounds check must be a compile error, not a swallowed `TypeError`.
- `exactOptionalPropertyTypes` is on. An optional field is absent or a value, never assigned `undefined`; assigning `undefined` is a compile error (TS2412), and that is what enforces "absent, not present-and-null" on view fields.
- Prefer async APIs over sync twins. Inside an `async` function, `await` it.
- A comment or spec sentence false about the code beside it is a defect equal to a wrong line of code.
- Tests must be able to fail. Prove each by mutation, and **the mutation must change observable behaviour** — removing a guard whose behaviour is secured downstream cannot fail and does not count.
- Never hand a live DOM element to `node:assert`'s formatting assertions — it serialises the whole DOM and has caused an OOM kill and multi-minute hangs here. Use `packages/web/test/dom.ts`; `scripts/check-test-hygiene.ts` enforces it by AST and catches `within(row).queryByText(...)` and stored query objects, not only `screen.<query>`.
- Do not mock `setInterval` before a component's first async load — measured at roughly 3 failures in 16 solo runs. Follow `Picks.test.tsx`'s poll tests, which use real timers for this reason.
- A malformed cursor is a 400 and **never** "start from the beginning". That was issue #33: absence and unreadability shared one answer, and a broken cursor passed for a first page, paging forever.
- No new lint warnings. Baseline is exactly: lint exit 0 with **124** warnings, typecheck clean, `test:web` **356**, `test:server` **1435**, `e2e` **25**.
- Gate commands: `npm run typecheck`, `npm run lint`, `npm run test-hygiene`, `npm run test:web`, `npm run test:server`, `npm run build`, and e2e is **`npm run e2e`** (not `test:e2e`). **Redirect each to a file and grep the file** — piping a test run through `grep` hides the failing test's name and output.
- Commit messages: one declarative sentence, no `feat:`/`fix:` prefix, no trailer, no trailing period.

---

## File Structure

**Core (server):**
- `packages/core/src/db/browse-page.ts` — **new.** The merged page query. It spans `media_groups` and `feed_items`, so it belongs to neither `db/groups.ts` nor `db/feed-items.ts`; a third module owning the union keeps both of those single-table.
- `packages/core/src/http/server.ts` — the composite cursor's parse and mint; `/api/browse` rebuilt; `/api/failed` renamed to `/api/dismissed` and narrowed.
- `packages/core/src/http/views.ts` — `BrowseItem`, the new `BrowseResponse`.

**Web:**
- `packages/web/src/components/FailedCard.tsx` — **new.** The card, with `FixForm` moved in from `routes/Failed.tsx`.
- `packages/web/src/components/GroupList.tsx` — a second row kind, composite selection.
- `packages/web/src/routes/Browse.tsx` — renders the union in both views, holds the fix/dismiss handlers.
- `packages/web/src/routes/Dismissed.tsx` — **new**, from `routes/Failed.tsx`.
- `packages/web/src/api/client.ts` — mirrors, `api.dismissed`.
- `packages/web/src/styles/card.css` — `.failed-card` and its poster placeholder.
- `packages/web/src/App.tsx` — nav.

**Deleted:** `packages/web/src/routes/Failed.tsx`.

---

### Task 1: The merged page query

**Files:**
- Create: `packages/core/src/db/browse-page.ts`
- Test: `packages/core/test/db/browse-page.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export type BrowseKind = 'failed' | 'group';
  /** One page boundary in the merged list. `kind` is what makes it total. */
  export interface BrowseCursor {
    sortKey: number;
    kind: BrowseKind;
    id: number;
  }
  export interface BrowsePageRow {
    kind: BrowseKind;
    id: number;
    sortKey: number;
  }
  export function pageOfBrowseItems(
    db: DatabaseSync,
    query: { cursor: BrowseCursor | null; limit: number; search: string | null },
  ): BrowsePageRow[];
  ```

**The ordering, and why each branch's keyset differs.** The merged order is
`(sortKey DESC, kind ASC, id ASC)`, with `kind` compared as the literal strings
so `'failed' < 'group'` alphabetically. A row R comes strictly after cursor C
when `R.sortKey < C.sortKey`, or the sort keys tie and `R.kind > C.kind`, or both
tie and `R.id > C.id`.

Because `kind` is a constant within each branch, that resolves at query-build
time into four cases — and getting this wrong is issue #33 with a new cause, so
derive it rather than pattern-matching the existing single-table version:

| Branch | Cursor kind | Condition |
|---|---|---|
| `group` | `group` | `(list_rank_at < ? OR (list_rank_at = ? AND id > ?))` |
| `group` | `failed` | `list_rank_at <= ?` — every group at the tying stamp sorts after a failed row |
| `failed` | `failed` | `(first_seen_at < ? OR (first_seen_at = ? AND id > ?))` |
| `failed` | `group` | `first_seen_at < ?` — no failed row at the tying stamp sorts after a group |

- [ ] **Step 1: Write the failing tests**

Read the top of `packages/core/test/db/feed-items.test.ts` and
`packages/core/test/db/groups.test.ts` first and reuse whichever fixture helpers
they already have for making a browsable group and a failed feed item. Do not
build a parallel harness; say in your report which helpers you used.

```ts
test('a page interleaves both kinds by recency, newest first', () => {
  const db = freshDb();
  // Deliberately alternating stamps, so a merge that simply concatenated the
  // two lists would come back in a visibly different order.
  const g1 = seedBrowsableGroup(db, { listRankAt: 500 });
  const f1 = seedFailedItem(db, { firstSeenAt: 400 });
  const g2 = seedBrowsableGroup(db, { listRankAt: 300 });
  const f2 = seedFailedItem(db, { firstSeenAt: 200 });

  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: null });
  assert.deepEqual(
    page.map((row) => `${row.kind}:${row.id}`),
    [`group:${g1}`, `failed:${f1}`, `group:${g2}`, `failed:${f2}`],
  );
});

test('a group and a failed item sharing a stamp come back failed-first, always', () => {
  const db = freshDb();
  const g = seedBrowsableGroup(db, { listRankAt: 100 });
  const f = seedFailedItem(db, { firstSeenAt: 100 });
  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: null });
  // `'failed' < 'group'`, and this order has to be the same one the cursor
  // comparison assumes — a tiebreak that differs between the two is how a row
  // gets served twice or skipped.
  assert.deepEqual(page.map((row) => `${row.kind}:${row.id}`), [`failed:${f}`, `group:${g}`]);
});

test('paging never repeats or skips a row, whichever kind the boundary is', () => {
  const db = freshDb();
  // Six rows, three of each kind, with two ties so both boundary kinds occur.
  const ids: string[] = [];
  ids.push(`group:${seedBrowsableGroup(db, { listRankAt: 600 })}`);
  ids.push(`failed:${seedFailedItem(db, { firstSeenAt: 600 })}`);
  ids.push(`group:${seedBrowsableGroup(db, { listRankAt: 500 })}`);
  ids.push(`failed:${seedFailedItem(db, { firstSeenAt: 400 })}`);
  ids.push(`group:${seedBrowsableGroup(db, { listRankAt: 400 })}`);
  ids.push(`failed:${seedFailedItem(db, { firstSeenAt: 300 })}`);
  const expected = [ids[1], ids[0], ids[2], ids[3], ids[4], ids[5]];

  // Walk it one row at a time: a limit of 1 makes every row in turn the
  // boundary, which is the only way to exercise all four keyset cases.
  const seen: string[] = [];
  let cursor: BrowseCursor | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = pageOfBrowseItems(db, { cursor, limit: 1, search: null });
    if (page.length === 0) break;
    const row = page[0];
    if (row === undefined) break;
    seen.push(`${row.kind}:${row.id}`);
    cursor = { sortKey: row.sortKey, kind: row.kind, id: row.id };
  }
  assert.deepEqual(seen, expected);
});

test('the search term matches a group by its search text and a failed item by its raw title', () => {
  const db = freshDb();
  const g = seedBrowsableGroup(db, { listRankAt: 300, searchText: 'alpha scene' });
  const f = seedFailedItem(db, { firstSeenAt: 200, rawTitle: 'Alpha Unparseable' });
  seedBrowsableGroup(db, { listRankAt: 100, searchText: 'beta' });

  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: 'alpha' });
  assert.deepEqual(page.map((row) => `${row.kind}:${row.id}`), [`group:${g}`, `failed:${f}`]);
});

test('the search term is case-insensitive on both sides', () => {
  const db = freshDb();
  // `search_text` is stored already lowercased by `searchTextFor`, but
  // `raw_title` is stored as it arrived — so the failed branch has to fold case
  // at query time and this test is what says so.
  const f = seedFailedItem(db, { firstSeenAt: 200, rawTitle: 'MiXeD Case Title' });
  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: 'mixed case' });
  assert.deepEqual(page.map((row) => `${row.kind}:${row.id}`), [`failed:${f}`]);
});

test('a dismissed failed item never appears', () => {
  const db = freshDb();
  seedFailedItem(db, { firstSeenAt: 200, dismissedAt: 1_000 });
  const g = seedBrowsableGroup(db, { listRankAt: 100 });
  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: null });
  assert.deepEqual(page.map((row) => `${row.kind}:${row.id}`), [`group:${g}`]);
});

test('a non-browsable group never appears', () => {
  const db = freshDb();
  // Picked with nothing better on offer — `BROWSABLE` excludes it, and this
  // query must not widen that rule.
  seedPickedGroupWithNoUpgrade(db, { listRankAt: 200 });
  const f = seedFailedItem(db, { firstSeenAt: 100 });
  const page = pageOfBrowseItems(db, { cursor: null, limit: 10, search: null });
  assert.deepEqual(page.map((row) => `${row.kind}:${row.id}`), [`failed:${f}`]);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm run test:server > /tmp/t1.log 2>&1; grep -nE "browse-page|is not a function" /tmp/t1.log | head`
Expected: `pageOfBrowseItems is not a function`.

- [ ] **Step 3: Implement**

In `packages/core/src/db/browse-page.ts`. `BROWSABLE` is not exported from
`db/groups.ts` today — export it rather than copying the string, because two
copies of "what belongs in the browse list" is precisely the drift
`db/groups.ts`'s own comment warns about.

```ts
import type { DatabaseSync } from 'node:sqlite';
import { BROWSABLE } from './groups.ts';
import { num, str, type SqlRow } from './row.ts';

export type BrowseKind = 'failed' | 'group';

/**
 * One page boundary in the merged list.
 *
 * `kind` is what makes the order total. `media_groups.id` and `feed_items.id`
 * are unrelated namespaces, so `(sortKey, id)` cannot separate two rows that
 * share a stamp — and a tiebreak that is not total is how a row gets served
 * twice or skipped, which is issue #33's failure with a new cause.
 */
export interface BrowseCursor {
  sortKey: number;
  kind: BrowseKind;
  id: number;
}

export interface BrowsePageRow {
  kind: BrowseKind;
  id: number;
  sortKey: number;
}

/**
 * One page of the merged browse list: browsable groups and undismissed parse
 * failures, newest first, ordered `(sort_key DESC, kind ASC, id ASC)`.
 *
 * Each branch is bounded and limited *before* the union, so the outer sort sees
 * at most `2 × limit` rows rather than both tables. Both branches have an index
 * that serves their own ORDER BY — `media_groups_browse (list_rank_at DESC)`
 * and the partial `feed_items_failed (first_seen_at DESC, id) WHERE parse_error
 * IS NOT NULL` — so each is an index scan that stops at `limit`.
 *
 * Rows come back as identity plus sort key only. Hydrating them is the caller's
 * job because the two kinds need different queries, and doing it here would
 * mean this module knowing about views.
 *
 * `kind` is compared as the literal strings, so `'failed' < 'group'`. That is
 * the same expression the cursor comparison below uses, deliberately: one rule
 * written once, rather than an ORDER BY and a WHERE that can drift apart.
 */
export function pageOfBrowseItems(
  db: DatabaseSync,
  query: { cursor: BrowseCursor | null; limit: number; search: string | null },
): BrowsePageRow[] {
  const groupConditions = [BROWSABLE];
  const groupParams: (number | string)[] = [];
  const failedConditions = ['parse_error IS NOT NULL', 'dismissed_at IS NULL'];
  const failedParams: (number | string)[] = [];

  if (query.search !== null) {
    // `instr`, not `LIKE`, for the reason `browseGroups` gives: a term wrapped
    // in `%…%` treats its own `%` and `_` as wildcards. `search_text` is stored
    // already lowercased by `searchTextFor`; `raw_title` is not, so the failed
    // branch folds case in SQL while the group branch folds it in JS.
    groupConditions.push('instr(search_text, ?) > 0');
    groupParams.push(query.search.toLowerCase());
    failedConditions.push('instr(lower(raw_title), ?) > 0');
    failedParams.push(query.search.toLowerCase());
  }

  const cursor = query.cursor;
  if (cursor !== null) {
    // Four cases, derived from `(sortKey DESC, kind ASC, id ASC)`. Where the
    // cursor's kind differs from the branch's, the kind comparison alone
    // settles every tying row and no id term is needed.
    if (cursor.kind === 'group') {
      groupConditions.push('(list_rank_at < ? OR (list_rank_at = ? AND id > ?))');
      groupParams.push(cursor.sortKey, cursor.sortKey, cursor.id);
      // `'failed' < 'group'`: a failed row at the tying stamp sorts *before*
      // this cursor, so only strictly older ones come after it.
      failedConditions.push('first_seen_at < ?');
      failedParams.push(cursor.sortKey);
    } else {
      failedConditions.push('(first_seen_at < ? OR (first_seen_at = ? AND id > ?))');
      failedParams.push(cursor.sortKey, cursor.sortKey, cursor.id);
      // Every group at the tying stamp sorts after a failed row, so the tie is
      // included whole.
      groupConditions.push('list_rank_at <= ?');
      groupParams.push(cursor.sortKey);
    }
  }

  // Each branch is wrapped in its own subquery. SQLite rejects a bare `ORDER
  // BY` on a compound operand — "ORDER BY clause should come after UNION ALL
  // not before" — and the per-branch `LIMIT` is what bounds the outer sort, so
  // the wrapping is how both can coexist. This exact form is verified working.
  const sql = `
    SELECT kind, id, sort_key FROM (
      SELECT 'group' AS kind, id, list_rank_at AS sort_key
        FROM media_groups WHERE ${groupConditions.join(' AND ')}
       ORDER BY list_rank_at DESC, id ASC LIMIT ?
    )
    UNION ALL
    SELECT kind, id, sort_key FROM (
      SELECT 'failed' AS kind, id, first_seen_at AS sort_key
        FROM feed_items WHERE ${failedConditions.join(' AND ')}
       ORDER BY first_seen_at DESC, id ASC LIMIT ?
    )
    ORDER BY sort_key DESC, kind ASC, id ASC LIMIT ?`;

  return db
    .prepare(sql)
    .all(...groupParams, query.limit, ...failedParams, query.limit, query.limit)
    .map((raw) => {
      const row = raw as SqlRow;
      return {
        kind: str(row, 'kind') === 'failed' ? ('failed' as const) : ('group' as const),
        id: num(row, 'id'),
        sortKey: num(row, 'sort_key'),
      };
    });
}
```

**Confirm the indexes are actually used.** Run `EXPLAIN QUERY PLAN` on the
statement above against the real schema and check that each branch's scan uses
its own index — `media_groups_browse` for the group branch, the partial
`feed_items_failed` for the failed branch — and that the only `USE TEMP B-TREE
FOR ORDER BY` is the outer one over the merged stream. That outer sort is
expected and is bounded to `2 × limit` rows by the per-branch limits; a temp
b-tree on a *branch* means that branch is not using its index and is a finding.
Paste the plan output into your report.

- [ ] **Step 4: Run them and confirm they pass**

Run: `npm run test:server > /tmp/t1.log 2>&1; grep -E "^ℹ (pass|fail)" /tmp/t1.log`
Expected: `fail 0`, 1435 + 7 = 1442.

- [ ] **Step 5: Mutation-prove each test**

Each must die to a change in observable behaviour, not to a removed guard:
- Order the outer query `kind DESC` → the tie test fails, and only it.
- Drop the `id > ?` term from the group branch's same-kind case → the one-row-at-a-time paging test repeats a row.
- Use `list_rank_at < ?` instead of `<=` for the group branch when the cursor is `failed` → that same test **skips** a row. Run both of these separately; they fail the same test for opposite reasons, and confirming each individually is the point.
- Drop `lower()` from the failed branch → the case-insensitivity test fails.
- Drop `dismissed_at IS NULL` → the dismissed test fails.
- Replace `BROWSABLE` with `1=1` → the non-browsable test fails.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/db/browse-page.ts packages/core/src/db/groups.ts packages/core/test/db/browse-page.test.ts
git commit -m "Read one page across browsable groups and unparsed feed items, ordered by recency with a total tiebreak"
```

---

### Task 2: The composite cursor

**Files:**
- Modify: `packages/core/src/http/server.ts` (beside `parseCursor`, around `:456-476`)
- Test: whichever core http test file already covers cursor rejection — find it with `grep -rln "Invalid cursor" packages/core/test`

**Interfaces:**
- Consumes: `BrowseCursor`, `BrowseKind` from Task 1.
- Produces:
  ```ts
  function parseBrowseCursor(raw: string): BrowseCursor | null;
  function browseCursorFrom(raw: string | undefined): { cursor: BrowseCursor | null } | { error: string };
  function mintBrowseCursor(row: { sortKey: number; kind: BrowseKind; id: number }): string;
  ```

**Read `parseCursor` and its doc comment first** (`server.ts:404-476`). Three
things in it bind you:

1. **A malformed cursor is a 400, never a first page.** That is issue #33.
2. It splits on `lastIndexOf(':')`, which means a three-component string already
   fails it — `"123:group:5"` yields a sort key of `"123:group"`, which
   `parseNonNegativeInt` rejects. **The reverse must also hold:** a
   two-component cursor must be malformed for `/api/browse`, or a client holding
   a pre-change cursor would silently read the wrong boundary.
3. The sort key may be `0` where the id may not, and both reject `"1e3"`,
   `"0x10"`, `"+1"`, `" 1"` and anything past `Number.MAX_SAFE_INTEGER`. Reuse
   `parseNonNegativeInt` and `parsePositiveInt` — do not hand-roll a parse.

- [ ] **Step 1: Write the failing tests**

```ts
test('a three-component browse cursor round-trips', async () => {
  const { app } = await appWithBrowseFixtures();
  const first = await app.inject({ method: 'GET', url: '/api/browse?limit=1' }).then((r) => r.json());
  assert.match(first.nextCursor, /^\d+:(failed|group):\d+$/);
  const second = await app.inject({ method: 'GET', url: `/api/browse?cursor=${first.nextCursor}&limit=1` });
  assert.equal(second.statusCode, 200);
});

test('a two-component cursor is malformed on browse, and still valid on the other lists', async () => {
  const { app } = await appWithBrowseFixtures();
  // The old shape. Accepting it would read `(sortKey, id)` against a total
  // order that now has three components, which is a wrong boundary rather than
  // a loud failure.
  const stale = await app.inject({ method: 'GET', url: '/api/browse?cursor=100:5' });
  assert.equal(stale.statusCode, 400);
  assert.deepEqual(stale.json(), { error: 'Invalid cursor' });
  // Unchanged for the routes that still order on one table.
  const downloads = await app.inject({ method: 'GET', url: '/api/downloads?cursor=100:5' });
  assert.equal(downloads.statusCode, 200);
});

test('an unknown kind is malformed', async () => {
  const { app } = await appWithBrowseFixtures();
  const res = await app.inject({ method: 'GET', url: '/api/browse?cursor=100:banana:5' });
  assert.equal(res.statusCode, 400);
});

test('a browse cursor rejects the numeric forms the shared parser rejects', async () => {
  const { app } = await appWithBrowseFixtures();
  for (const cursor of ['1e3:group:5', '0x10:group:5', '+1:group:5', ' 1:group:5', '100:group:0']) {
    const res = await app.inject({ method: 'GET', url: `/api/browse?cursor=${encodeURIComponent(cursor)}` });
    assert.equal(res.statusCode, 400, cursor);
  }
  // The sort key may be 0 where the id may not — both stamps come from an
  // injected clock that hands out 0.
  const zero = await app.inject({ method: 'GET', url: '/api/browse?cursor=0:group:5' });
  assert.equal(zero.statusCode, 200);
});
```

Use whatever fixture builder that file already has for an app with browse data
rather than the invented `appWithBrowseFixtures`; name what you used in your
report.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement, beside `parseCursor`**

```ts
/**
 * The `"<sort key>:<kind>:<id>"` string `/api/browse` mints, or `null` when the
 * text is not one of those.
 *
 * The same rule as `parseCursor` above plus a discriminator, not a second rule:
 * the numeric parts go through the same two helpers and reject the same forms,
 * and `null` means malformed here too — a 400 rather than a first page (#33).
 *
 * The two-component form is malformed *for this route*. It stays valid for the
 * routes that order on one table, and accepting it here would mean reading a
 * two-part boundary against a three-part order — a silently wrong page rather
 * than a loud refusal.
 */
function parseBrowseCursor(raw: string): BrowseCursor | null {
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [rawSortKey, rawKind, rawId] = parts;
  if (rawSortKey === undefined || rawKind === undefined || rawId === undefined) return null;
  if (rawKind !== 'failed' && rawKind !== 'group') return null;
  const sortKey = parseNonNegativeInt(rawSortKey);
  const id = parsePositiveInt(rawId);
  if (sortKey === null || id === null) return null;
  return { sortKey, kind: rawKind, id };
}

/** As `cursorFrom`, for the merged list: absence is a first page, unreadability is not. */
function browseCursorFrom(
  raw: string | undefined,
): { cursor: BrowseCursor | null } | { error: string } {
  if (raw === undefined) return { cursor: null };
  const cursor = parseBrowseCursor(raw);
  return cursor === null ? { error: 'Invalid cursor' } : { cursor };
}

function mintBrowseCursor(row: { sortKey: number; kind: BrowseKind; id: number }): string {
  return `${row.sortKey}:${row.kind}:${row.id}`;
}
```

- [ ] **Step 4: Run and confirm passing.**

- [ ] **Step 5: Mutation-prove**

- Accept `parts.length === 2` by falling back to `parseCursor` → the stale-cursor test fails.
- Drop the `rawKind` validation → the unknown-kind test fails.
- Swap `parsePositiveInt` for `parseNonNegativeInt` on the id → the `100:group:0` case fails.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Carry the row kind in the browse cursor so a boundary is total across two id namespaces"
```

---

### Task 3: `/api/browse` returns the union

**Files:**
- Modify: `packages/core/src/http/views.ts` (`BrowseResponse`, around `:286`), `packages/core/src/http/server.ts` (the `/api/browse` handler, around `:810-841`), `packages/web/src/api/client.ts` (mirror + `api.browse`)
- Test: the core http test file covering `/api/browse`

**Interfaces:**
- Consumes: `pageOfBrowseItems`, `BrowseCursor` (Task 1); `browseCursorFrom`, `mintBrowseCursor` (Task 2).
- Produces:
  ```ts
  export type BrowseItem =
    | { kind: 'group'; group: GroupView }
    | { kind: 'failed'; item: FailedItemView };
  export interface BrowseResponse {
    items: BrowseItem[];
    nextCursor: string | null;
  }
  ```
  Client: `api.browse(cursor: string | null, search: string)` keeps its signature and returns the new `BrowseResponse`.

**Hydration is two queries, not one per row.** Collect the page's group ids and
feed-item ids, then build each kind's views in one pass — the discipline
`/api/downloads` states for itself and the defect issues #31 and #33 exist to
stop repeating. `toFailedItemView(row, plugin)` needs the plugin for its
`suggestedValues`; read how the existing `/api/failed` handler resolves that and
do the same.

Preserve the union's order when assembling: build a lookup per kind and map over
`pageOfBrowseItems`'s rows, rather than concatenating the two hydrated lists.

- [ ] **Step 1: Write the failing tests**

```ts
test('a browse page carries both kinds, in the order the query returned them', async () => {
  const { app } = await appWithInterleavedFixtures();
  const body = await app.inject({ method: 'GET', url: '/api/browse?limit=10' }).then((r) => r.json());
  assert.deepEqual(
    body.items.map((item: { kind: string }) => item.kind),
    ['group', 'failed', 'group', 'failed'],
  );
  // Each kind carries its own view, under its own key.
  const group = body.items[0];
  assert.ok(group.group.display);
  const failed = body.items[1];
  assert.ok(failed.item.rawTitle);
  assert.equal('group' in failed, false);
});

test('the two kinds hydrate in a fixed number of queries, not one per row', async () => {
  // Guarded by counting statements rather than by reading: this is the defect
  // issues #31 and #33 both name, and it is invisible until the list is long.
  const { app, statements } = await appWithInterleavedFixtures({ countStatements: true });
  const before = statements.count;
  await app.inject({ method: 'GET', url: '/api/browse?limit=30' });
  const perPage = statements.count - before;
  const { app: bigger, statements: biggerCount } = await appWithInterleavedFixtures({
    countStatements: true,
    rows: 60,
  });
  const beforeBig = biggerCount.count;
  await bigger.inject({ method: 'GET', url: '/api/browse?limit=30' });
  assert.equal(biggerCount.count - beforeBig, perPage, 'query count must not grow with page size');
});

test('paging the route end to end yields every row exactly once', async () => {
  const { app, expectedKeys } = await appWithInterleavedFixtures({ rows: 7 });
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 30; guard += 1) {
    const url = cursor === null ? '/api/browse?limit=2' : `/api/browse?cursor=${cursor}&limit=2`;
    const body = await app.inject({ method: 'GET', url }).then((r) => r.json());
    for (const item of body.items) {
      seen.push(item.kind === 'group' ? `group:${item.group.id}` : `failed:${item.item.id}`);
    }
    cursor = body.nextCursor;
    if (cursor === null) break;
  }
  assert.deepEqual(seen, expectedKeys);
  assert.equal(new Set(seen).size, seen.length, 'no row served twice');
});

test('a term filters both kinds in one response', async () => {
  const { app } = await appWithInterleavedFixtures();
  const body = await app
    .inject({ method: 'GET', url: '/api/browse?q=alpha&limit=10' })
    .then((r) => r.json());
  assert.ok(body.items.some((i: { kind: string }) => i.kind === 'group'));
  assert.ok(body.items.some((i: { kind: string }) => i.kind === 'failed'));
});
```

If the test file has no statement-counting helper, count with a wrapper around
`db.prepare` in the fixture rather than skipping that test — "does the query
count grow with the page" is the one assertion that catches the N+1 this route
has had twice.

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Rebuild the handler.** Over-fetch by one as all three paginated
routes do — a page exactly `limit` long is otherwise ambiguous between "there is
more" and "that was everything" — mint `nextCursor` from the last row with
`mintBrowseCursor`, and use `browseCursorFrom` for the 400.
- [ ] **Step 4: Mirror the types and update `api.browse` in `client.ts`.** Its
signature does not change; its return type does.
- [ ] **Step 5: Run the gate** — typecheck, `test:server`, `test:web`, `lint`.
`test:web` **will fail** here: `Browse.tsx` still expects `response.groups`.
That is expected at this step; Task 5 fixes it. Report the failing test names so
the next task's implementer can check them off.
- [ ] **Step 6: Mutation-prove** — concatenate the hydrated lists instead of
mapping over the query's rows → the order test fails. Hydrate per row → the
query-count test fails.
- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Answer browse as a discriminated union of groups and unparsed names, in one server-owned order"
```

---

### Task 4: `FailedCard`

**Files:**
- Create: `packages/web/src/components/FailedCard.tsx`
- Modify: `packages/web/src/styles/card.css`, `packages/web/src/styles/rows.css` (move the `.failed-*` block), `packages/web/src/styles/base.css` (the comment naming `.failed-row h2`)
- Test: `packages/web/test/FailedCard.test.tsx`

**Interfaces:**
- Consumes: `FailedItemView`, `ManualField`.
- Produces:
  ```ts
  interface Props {
    item: FailedItemView;
    /** Absent when the plugin has no manual hooks, or its feed has left configuration. */
    fields?: ManualField[] | undefined;
    onFix(values: Record<string, string>): void;
    onDismiss(): void;
  }
  export function FailedCard(props: Props): JSX.Element;
  ```

**Move `FixForm` into this file** from `routes/Failed.tsx:28-47`, with its doc
comment intact — it explains why the form is separate from the row, and the
reason still holds: `ManualForm` seeds once and never again, so one form moved
between items would keep showing the first item's suggestions.

**The CSS is nearly a rename.** `.failed-row` (`rows.css:148-156`) and
`.media-card` (`card.css:5-11`) already have byte-identical frames — same
border, radius, `--color-surface`, `--space-4` padding and margin. So:
- Rename `.failed-row` → `.failed-card` and move the `.failed-*` block from
  `rows.css` to `card.css`, beside the card it now matches.
- Add a poster placeholder at the media card's own geometry — `width: 6rem;
  aspect-ratio: 2 / 3` (`card.css:98-99`) — so an interleaved list keeps one
  rhythm instead of alternating between two card heights.
- `base.css:47-48`'s comment names `.failed-row h2` while explaining a
  cascade-layer interaction. Update the name; keep the explanation.
- Keep `.failed-reason` in the error colour. Do **not** invent a new visual
  language for failure — `--color-error` is what this app already uses.

- [ ] **Step 1: Write the failing tests**

Ten cases, each its own test — read `packages/web/test/dom.ts` first:

```tsx
test('the card names the refused title, its reason, and its feed', () => {});
test('the reason renders in the error colour, not as plain body text', () => {});
test('Fix… appears only when the plugin offers fields', () => {});
test('an item whose plugin has no fields still offers Dismiss', () => {
  // Dismissing is core's own bookkeeping and stays available with no schema.
});
test('Fix… opens the form seeded with the suggested values', () => {});
test('submitting the form calls onFix with the typed values', () => {});
test('Cancel closes the form without calling onFix', () => {});
test('a dismissed item shows the Dismissed badge instead of a Dismiss button', () => {
  // Dismissing it again is a 409; it is listed at all only because showing it
  // is how it stays fixable.
});
test('Dismiss calls onDismiss', () => {});
test('the poster slot holds a placeholder at the media card geometry', () => {
  // So an interleaved list does not alternate between two card heights.
});
```

Write real bodies from the existing `MediaCard.test.tsx` fixtures and helpers —
the skeletons above are the cases, not the code.

- [ ] **Step 2: Run and confirm they fail.**
- [ ] **Step 3: Implement the component and the CSS moves.**
- [ ] **Step 4: Run the gate** (`test:web` will still fail on `Browse.tsx` from Task 3 — report which).
- [ ] **Step 5: Mutation-prove all ten**, each dying to one targeted change.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Give a refused name a card of its own, matching the media card frame it will sit beside"
```

---

### Task 5: Browse renders the union in card view

**Files:**
- Modify: `packages/web/src/routes/Browse.tsx`
- Test: `packages/web/test/Browse.test.tsx`

**Interfaces:**
- Consumes: `BrowseItem` (Task 3), `FailedCard` (Task 4).
- Produces: nothing later tasks depend on beyond Browse holding `items: BrowseItem[]`.

`usePagedList<T>` is already generic (`usePagedList.ts:55`), so its element type
becomes `BrowseItem` with no change to the hook.

**Two handlers move here from `routes/Failed.tsx`:**
- `fix(itemId, values)` → `api.resolveFeedItem` → drop the failed item from
  `items` and set the notice `"<title> joined an existing group"` or
  `"became a new group"` from the response's `joinedExisting`.
- `dismiss(itemId)` → `api.dismissFeedItem` → drop the item unconditionally.
  Simpler than Failed's version, which had to choose between dropping and
  flipping depending on its toggle; Browse shows only open items, so a dismissed
  one no longer belongs.

**The resolved group does not appear until the next page load, and the notice is
what says so.** Do not try to patch it in: placing a new group correctly in a
keyset-ordered list means computing where the server would have put it, which is
the client re-deriving the server's ordering rule.

- [ ] **Step 1: Write the failing tests**

```tsx
test('a page of both kinds renders a media card and a failed card', async () => {});
test('the cards appear in the order the response listed them', async () => {
  // Not just "both are present" — the interleaving is the feature.
});
test('fixing an item drops its card and reports where the release went', async () => {});
test('the resolved group does not appear until the next load, and the notice says so', async () => {});
test('dismissing an item drops its card', async () => {});
test('a failed request while fixing reports and leaves the card in place', async () => {});
test('a term that matches nothing leaves an empty list rather than a stale one', async () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.** Render `MediaCard` or `FailedCard` per item by kind. Keep `cardFor(group)` for the group case — it exists so the card's props are written once.
- [ ] **Step 4: Run the gate.** `test:web` should now be green again, including the tests Task 3 broke. Report the number and account for it.
- [ ] **Step 5: Mutation-prove all seven.** Notably: render both kinds but sort by kind → the order test fails.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Render both card kinds in Browse's list, in the order the server sent them"
```

---

### Task 6: `GroupList` and the split view learn the second kind

**Files:**
- Modify: `packages/web/src/components/GroupList.tsx`, `packages/web/src/routes/Browse.tsx`
- Test: `packages/web/test/GroupList.test.tsx`, `packages/web/test/Browse.test.tsx`

**Interfaces:**
- Consumes: `BrowseItem` (Task 3), `FailedCard` (Task 4).
- Produces:
  ```ts
  export interface BrowseSelection {
    kind: 'group' | 'failed';
    id: number;
  }
  interface Props {
    items: readonly BrowseItem[];
    selected: BrowseSelection | null;
    onSelect: (selected: BrowseSelection) => void;
  }
  ```

A bare id cannot address a row any more, for the same reason the cursor needs a
discriminator: the two id spaces overlap, so `id === 7` names two different rows.
Every comparison of a selection to a row compares both halves.

**Unchanged, and must stay unchanged:** `role="listbox"`, `aria-selected` per
row, the roving `tabIndex` so exactly one row is in the tab order, ArrowUp and
ArrowDown moving both selection and DOM focus, and the checked indexed access
(`const target = items[next]; if (target === undefined) return;`) that makes a
deleted bounds check a compile error rather than a swallowed `TypeError`.

A failed row's accessible name is its `rawTitle`. Browse's clearing effect —
which drops a selection a term has filtered out — compares the composite key.

- [ ] **Step 1: Write the failing tests**

```tsx
test('a failed row and a group row with the same id are different rows', () => {
  // The whole reason selection is composite. With a bare id these two collide.
});
test('selecting a failed row shows its card in the detail pane', () => {});
test('selecting a group row shows its media card in the detail pane', () => {});
test('arrow keys move across both kinds and move DOM focus with the selection', () => {});
test('exactly one row is in the tab order, whichever kind is selected', () => {});
test('a failed row is announced by its refused title', () => {});
test('a selection filtered out by a term is cleared once loading settles', () => {});
test("a failed item's Fix… form opens inside the detail pane", () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the gate.**
- [ ] **Step 5: Mutation-prove all eight.** Notably: compare selections by `id` alone → the same-id test fails; drop the `undefined` check on the indexed access → **typecheck** fails rather than a test, which is the point of that shape.
- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Let the split view address rows by kind and id, so a refused name can be selected beside a group"
```

---

### Task 7: The Dismissed tab, the route rename, the nav, and e2e

**Files:**
- Create: `packages/web/src/routes/Dismissed.tsx`
- Delete: `packages/web/src/routes/Failed.tsx`
- Modify: `packages/core/src/http/server.ts` (`/api/failed` → `/api/dismissed`), `packages/web/src/api/client.ts`, `packages/web/src/App.tsx`
- Modify: `packages/e2e/tests/theme.spec.ts`, `packages/e2e/tests/smoke.spec.ts`, `packages/e2e/tests/settings.spec.ts`
- Test: `packages/web/test/Dismissed.test.tsx`; delete `packages/web/test/Failed.test.tsx` — **it exists and holds 20 tests, enumerated below**

**Do this last**, so Failed keeps working until its replacement is complete.

**`packages/web/test/Failed.test.tsx` holds 20 tests and most of them survive
this change.** Match them by NAME, not line number — earlier tasks will have
moved things. Two of them die with their subject; everything else is re-homed.
Enumerated here because the equivalent list was left vague on the Downloads merge
and the count was wrong by four, which nearly deleted live coverage:

- **To `FailedCard.test.tsx` (Task 4 may have covered some already — check before
  duplicating):** *every refused name is listed with the reason it was refused* ·
  *Fix prefills from the suggestions and leaves the rest of the schema blank* ·
  *opening Fix on another row shows that row, not the first one* (this is the one
  that pins why `FixForm` is a separate component — `ManualForm` seeds once) ·
  *the identity preview describes the draft, under the plugin that will build it* ·
  *the values submitted are the whole schema, sent to the row being fixed* ·
  *an item whose plugin has no schema offers no Fix, only Dismiss*
- **To `Browse.test.tsx` (Task 5 may have covered some — check):** *saving a fix
  drops the row and says it joined an existing group* · *a fix that made a new
  group says that instead* · *Dismiss drops the row* · *fixing after "load more"
  keeps the pages already loaded* · *dismissing after "load more" keeps the pages
  already loaded* · *the next page arrives when the end of the list comes into
  view, with no click* · *fixing after a page arrived by scrolling keeps the pages
  already loaded* · *dismissing after a page arrived by scrolling keeps the pages
  already loaded* · *"load more" appends the next page rather than replacing the
  list* · *the schemas are fetched once for the screen, not once per row* · *a
  refused request is reported rather than swallowed*
- **To `Dismissed.test.tsx`:** *dismissed items are asked for only when shown, and
  offer no second dismissal* — keep the second half, which is the `Dismissed`
  badge in place of a button. The "only when shown" half was about the toggle and
  goes with it.
- **Dies with its subject, and say so rather than porting it:** *dismissing while
  dismissed items are shown keeps the row and flips it to the badge.* That
  behaviour no longer exists anywhere — Browse drops a dismissed item
  unconditionally, and the Dismissed tab has no Dismiss button to press.
- **Becomes a nav test for the new tab:** *the Failed tab is reachable from the
  nav.*

Count the re-homed ones off by name before deleting the file. If any is missing,
stop and add it rather than deleting.

**The route follows the meaning.** `/api/failed` becomes `/api/dismissed` and
**loses its `includeDismissed` parameter**: open failed items are queried inside
the browse route's union now, so this route's only consumer wants dismissed ones
and nothing needs "all". The rename is not cosmetic — a route called `failed`
that returns only dismissed items is a false name. It keeps the two-component
cursor, which is why Task 2's test asserts that shape is still valid off browse.

**The nav, and the `<hr>` keeps its meaning:**

```
Browse
Picks
Dismissed
────────────  hr.nav-separator
Settings
ThemeToggle
```

That rule's comment says Settings is a view of the *installation* rather than of
the library, and that the rule is what says so. Dismissed is a view of the
library, so it goes **above** — and that comment needs no change. Do not move it
below the rule; that would make the comment false about the markup beside it.

**Four e2e sites, and one of them is a trap.** Three mention no path at all, so
they were found by grepping the label rather than the href:
- `theme.spec.ts:182` sweeps `['/', '/picks', '/failed', '/settings']` — `/failed` becomes `/dismissed`.
- `smoke.spec.ts:15` asserts a `Failed` nav link is visible — becomes `Dismissed`.
- `settings.spec.ts:42` asserts nav **geometry**: that `hr.nav-separator` sits below the `Failed` link and above `Settings`, deliberately replacing an older `toContainText('Failed—Settings')` because "a rule contributes no text". With `Failed` gone its locator returns null and the test fails on `expect(failed).not.toBeNull()`. The link above the rule becomes `Dismissed`, which preserves the exact property under test.
- `retry.spec.ts:81` asserts `.release-current` reads `Failed` and **must not be touched** — that is a download's status label on a release row, nothing to do with the nav.

- [ ] **Step 1: Write the failing tests**

```tsx
test('the tab lists dismissed items and nothing else', async () => {});
test('a dismissed item still offers Fix…, because that is how it stays fixable', async () => {});
test('fixing one drops it from the list and reports where the release went', async () => {});
test('it shows the Dismissed badge rather than a Dismiss button', async () => {});
test('an empty list says so rather than rendering nothing', async () => {});
```

Plus, in the core http tests: `/api/dismissed` returns only dismissed items,
rejects nothing it used to accept except the removed parameter, and still takes a
two-component cursor.

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement the route rename, the tab, the nav, and the deletions.**
- [ ] **Step 4: Confirm nothing references the deleted screen**

```bash
grep -rn "routes/Failed\|api/failed\|includeDismissed\|'/failed'" packages/*/src packages/*/test packages/e2e/tests | grep -v dist
```
Expected: no output. Ignore `dist/` — stale build artifacts.

- [ ] **Step 5: Run the full gate including e2e**

```bash
npm run typecheck > /tmp/t7tc.log 2>&1; echo "tc:$?"
npm run lint > /tmp/t7l.log 2>&1; echo "lint:$?"; grep -c warning /tmp/t7l.log
npm run test-hygiene > /tmp/t7h.log 2>&1; echo "hyg:$?"
npm run test:web > /tmp/t7w.log 2>&1; grep -E "^ℹ (tests|pass|fail)" /tmp/t7w.log
npm run test:server > /tmp/t7s.log 2>&1; grep -E "^ℹ (pass|fail)" /tmp/t7s.log
npm run build > /tmp/t7b.log 2>&1; echo "build:$?"
npm run e2e > /tmp/t7e.log 2>&1; grep -iE "passed|failed" /tmp/t7e.log | tail -2
```
Expected: lint exit 0 with **124** warnings, typecheck clean, `fail 0` on both
unit suites, build clean, **e2e 25 passed**. If the e2e count moved, say which
spec and why.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Move the set-aside names to a tab of their own and delete the screen the browse list replaced"
```

---

## Self-Review

**Spec coverage.** §1 → Tasks 3-6. §1.1 (no un-dismiss, `BROWSABLE` untouched,
no Picks pagination, no new visual language) → constraints on Tasks 1, 4, 7
rather than work. §1.2 (the accepted 22:1 dilution) → no task; it is a recorded
cost. §2 (the union, its per-branch limits, three queries per page) → Task 1
plus Task 3's query-count test. §3 (the composite cursor) → Task 2, with Task 1
owning the comparison and Task 3 exercising it end to end. §4 (`failed-card`) →
Task 4. §5 (`GroupList`) → Task 6. §6 (the two actions) → Task 5, and again in
Task 7 for the Dismissed tab. §7 (nav) → Task 7. §8 (the Dismissed tab and the
route rename) → Task 7. §9 (testing) → distributed, with §9's four e2e sites
enumerated verbatim in Task 7. §10 (consequences) → the "three lists page
identically" comment correction is in Task 2's scope; flagged below.

**Placeholder scan.** Tasks 4, 5, 6 and 7 list test *cases* as one-line
skeletons, each saying so explicitly and naming the fixtures to build them from.
Every step producing production code carries the actual code, except Task 3
steps 3-4 and Task 7 step 3, which describe edits to handlers whose surrounding
code the implementer must read first — each names the file, the line range, and
the exact behaviour required. No "TBD", no "handle edge cases", no "similar to
Task N".

**Type consistency.** `BrowseKind` and `BrowseCursor` are defined in Task 1 and
imported by Task 2; `BrowsePageRow` carries `sortKey` while the cursor carries
`sortKey`/`kind`/`id`, and `mintBrowseCursor` takes the three fields both share.
`BrowseItem` is `{ kind: 'group'; group }` / `{ kind: 'failed'; item }` in Tasks
3, 5 and 6 alike — note the payload key differs by kind deliberately, so a
consumer cannot read the wrong one without a type error. `BrowseSelection` is
Task 6's and matches `BrowseCursor`'s `kind`/`id` without its `sortKey`.

**Two things I am recording rather than resolving.**

1. **`server.ts:1229`'s comment says "three lists paging identically".** After
   Task 2 that is false: browse carries a third cursor component the other two
   do not. Task 2 must correct that comment — it is in the file Task 2 edits, and
   a comment false about the code beside it is a defect by this plan's own
   constraints. Called out here because it is easy to miss while looking at the
   parser rather than at the routes.
2. **`BROWSABLE` must be exported** from `db/groups.ts` for Task 1 to import. If
   exporting it turns out to expose something the module deliberately keeps
   private, the fallback is a function in `db/groups.ts` that returns the merged
   page's group branch — **not** a second copy of the predicate string, which is
   the drift that module's own comment warns about.
