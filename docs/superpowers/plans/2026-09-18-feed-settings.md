# Adding RSS feeds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator add an RSS feed through the UI — the host's first write endpoint, and the missing half of ingestion.

**Architecture:** `Host.addFeed` owns every invariant and schedules the first poll; `POST /api/feeds` is a thin adapter over it; the 405 guard moves from one global line to a per-route declaration; `rss_feed` joins the synced tables with its url redacted after the SELECT, so the settings list updates live through the replica.

**Tech Stack:** Node 26, `node:sqlite`, Drizzle, React 19, react-router 7, IndexedDB, `node --test` with happy-dom, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-18-feed-settings-design.md` — read it; this plan argues from it.

## Global Constraints

- **Never the `any` type.** Not in source, not in tests, not behind a cast.
- **No cast to silence a type error.** If a cast seems needed, the types are wrong — say so in your report rather than casting. Testing Library's queries take a type parameter; that is the house pattern.
- **No URL, path or credential in any message, log or response body.** A refusal carries a code the client maps to its own words; the server authors no sentence a human reads.
- **`/api` never falls through to `index.html`.** The guard work in Task 1 must not weaken this.
- **The client never reads, stores or forwards a session token.** `credentials: 'same-origin'` and the browser's cookie jar.
- **Lists come from the replica only.** No remote fallback. The settings list reads the replica, not a fetch.
- **A refusal is distinguishable without parsing prose** (spec §2.2). The client must tell "already on file" from "unknown plugin" from "offline" without matching a message string.
- `CLAUDE.md`'s testing hazards apply in full. The ones that bite here: never hand a live DOM element to `node:assert`; `afterEach(cleanup)` rather than a per-test `cleanup()`; `getByRole` cannot see whether a component is legible; and a test whose expected value is computed by the code under test cannot detect that code changing.

### The gate

Run each step **separately** and branch on its exit code. Never pipe a gate command into a grep for a count — a grep for a number cannot fail, and that is how a red build went unnoticed two slices ago.

```bash
for s in lint typecheck test-hygiene build; do
  if npm run "$s" > /tmp/g-$s.txt 2>&1; then echo "PASS $s"; else echo "FAIL $s"; fi
done
```

Then `npm run test:server`, `npm run test:web`, `npm run e2e`.

**Baseline, measured on this worktree at `11b2106`:** lint **110 total / 0 in packages/{contract,host,web,e2e}**, typecheck/test-hygiene/build PASS, `test:server` **2355**, `test:web` **72**, e2e **10**.

Lint must stay **110 / 0** throughout. Suites grow only by the tests you add. **Report the numbers you measure with the arithmetic**, and if something moves that should not, stop and report it rather than adjusting.

Which suite a test lands in is decided by its extension: `test:server` takes `packages/*/test/**/*.test.ts`, `test:web` takes `packages/web/test/**/*.test.tsx` — **`.tsx` only**. A `.test.ts` under `packages/web/test/` runs in `test:server`.

---

## File structure

**Modified:**
- `packages/host/src/api/server.ts` — `Route.methods`, the per-route guard, the request body, `ReadServerDeps.addFeed`, the `/api/feeds` route.
- `packages/host/src/host.ts` — `Host.addFeed`.
- `packages/host/src/main.ts:840` — wires `addFeed` into the read server (the `Host` is already in scope at line ~800).
- `packages/host/src/sync/tables.ts` — `rss_feed` in `HOST_SYNCED_TABLES`, its projection, the redaction hook, the amended docblock.
- `packages/host/src/db/migrate.ts` — triggers and seeding for the new synced table.
- `packages/contract/src/sync.ts` — `RssFeedSyncRead`.
- `packages/web/src/store/rows.ts` — `rss_feed` in `TABLES_WITH_UPDATED_AT`.
- `packages/web/src/shell/Shell.tsx` — the `/settings` route and nav link.
- `packages/web/src/styles/library.css`, `index.css` — the settings screens' styles.
- `packages/e2e/tests/shell.spec.ts` — the browser proof.

**Created:**
- `packages/host/src/feeds/add.ts` — `addFeed`'s invariants, separate from `host.ts` which is already large.
- `packages/web/src/settings/Feeds.tsx`, `AddFeed.tsx`, `useFeeds.ts`.
- Tests mirroring each.

---

## Task 1: Per-route methods, and a request body

**Files:**
- Modify: `packages/host/src/api/server.ts`
- Test: `packages/host/test/api/server.test.ts`

**Interfaces:**
- Produces: `Route.methods: readonly string[]` (required on every route); `RouteRequest.body: unknown` (parsed JSON, `undefined` for GET); `MAX_BODY_BYTES`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a route answers 405 for a method it does not declare, per route', async () => {
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    // Per route, not once: a guard that refused every method on every route
    // would pass a single-route test and break every write this slice adds.
    const getOnly = await post(server, '/api/media?type=movie', cookie, {});
    assert.equal(getOnly.status, 405, 'POST to a GET-only route is refused');
    const postOnly = await get(server, '/api/feeds', cookie);
    assert.equal(postOnly.status, 405, 'GET to a POST-only route is refused');
  } finally {
    await server.close();
  }
});

test('a body larger than the cap is refused before it is parsed', async () => {
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    const huge = JSON.stringify({ name: 'x'.repeat(MAX_BODY_BYTES + 1_000) });
    const answer = await postRaw(server, '/api/feeds', cookie, huge);
    assert.equal(answer.status, 413, 'an oversized body is refused');
    assert.ok(!answer.text.includes('x'.repeat(50)), 'and is not echoed back');
  } finally {
    await server.close();
  }
});

test('every route declares its methods', () => {
  // The count assertion that already guards `open` applies here too: a route
  // added without `methods` must not silently inherit GET.
  for (const route of ROUTES) {
    assert.ok(route.methods.length > 0, `${route.path} declares at least one method`);
  }
});
```

Add `post`, `postRaw` and `get` helpers beside the file's existing `getAll`, following its conventions — every test in that file closes its server in a `finally`, and all of them did before yours.

- [ ] **Step 2: Run and watch them fail**

Run: `npm run test:server`
Expected: FAIL — `methods` does not exist and `/api/feeds` is an unknown route.

- [ ] **Step 3: Implement**

`Route` gains a required `methods`, and every existing entry declares `methods: ['GET']`:

```ts
interface Route {
  readonly path: string;
  /**
   * The HTTP methods this route answers. **Required, not defaulted**: a
   * route added without thinking about its methods is exactly the route
   * that should not silently accept a write. Until this slice the guard was
   * one line rejecting every non-GET before dispatch, which is what kept
   * `/api` read-only; making each route declare its own is what lets one
   * route accept a POST without opening the rest.
   */
  readonly methods: readonly string[];
  readonly open: boolean;
  readonly answer: (route: RouteRequest) => Answer | Promise<Answer>;
}
```

In `refusalFor`, replace the global line with a per-route check. The order matters: an unknown route stays 404, and a method refusal must not leak whether a path exists beyond what the path itself already tells a caller.

```ts
  const route = target === null ? undefined : routeFor(target.pathname);
  if (route !== undefined && !route.methods.includes(request.method ?? '')) {
    return json(405, { error: 'method not allowed' });
  }
```

Read the body only for a request whose method is not GET, cap it, and parse it:

```ts
/** Enough for a feed; small enough that an unbounded client cannot make the host buy memory. */
export const MAX_BODY_BYTES = 16 * 1024;
```

Accumulate chunks, refuse with 413 the moment the running total exceeds the cap — **before** parsing, and without echoing any of it back.

- [ ] **Step 4: Run and watch them pass**

- [ ] **Step 5: Mutation-test**

Make the guard check `ROUTES[0].methods` instead of the matched route's: the per-route test must fail. Restore by copy-aside plus checksum, never `git checkout --`.

- [ ] **Step 6: Gate and commit**

---

## Task 2: `Host.addFeed`

**Files:**
- Create: `packages/host/src/feeds/add.ts`
- Modify: `packages/host/src/host.ts`
- Test: `packages/host/test/feeds/add.test.ts`

**Interfaces:**
- Produces:
  - `type AddFeedInput = { pluginId: string; name: string; url: string; downloadType: 'torrent' | 'nzb'; pollIntervalS: number }`
  - `type AddFeedRefusal = { refusal: 'unknown-plugin' | 'duplicate-url' | 'bad-download-type' | 'bad-poll-interval' }`
  - `Host.addFeed(input: AddFeedInput): Promise<{ id: number } | AddFeedRefusal>`
  - `MIN_POLL_INTERVAL_S = 60`, `MAX_POLL_INTERVAL_S = 86_400`
- Returns a refusal **value**, not a thrown error: the route maps it to a status, and a thrown error would be indistinguishable from a bug.

- [ ] **Step 1: Write the failing tests**

```ts
test('a feed for an unregistered plugin is refused', async () => {
  const { host } = setupHost({ registered: ['movie'] });
  const result = await host.addFeed(input({ pluginId: 'tv' }));
  assert.deepEqual(result, { refusal: 'unknown-plugin' });
});

test('a url already on file is refused, not thrown', async () => {
  // `rss_feed` has a uniqueIndex on url, so without this the second insert
  // raises a raw SQLite constraint violation -- a 500 where the honest
  // answer is "that feed is already here". Driven through a real second
  // insert rather than a stubbed error: the uniqueness lives in the table.
  const { host } = setupHost({ registered: ['movie'] });
  const first = await host.addFeed(input({ url: 'https://tracker.example/rss' }));
  assert.ok('id' in first, 'the first insert succeeds');
  const second = await host.addFeed(input({ url: 'https://tracker.example/rss' }));
  assert.deepEqual(second, { refusal: 'duplicate-url' });
});

test('a poll interval below the floor is refused', async () => {
  // Nothing clamps this today: `host.ts`'s poll handler reschedules at
  // `now + seconds * 1000`, so zero enqueues in the past and spins the
  // dispatcher.
  const { host } = setupHost({ registered: ['movie'] });
  assert.deepEqual(await host.addFeed(input({ pollIntervalS: 0 })), { refusal: 'bad-poll-interval' });
  assert.deepEqual(await host.addFeed(input({ pollIntervalS: 59 })), { refusal: 'bad-poll-interval' });
  assert.deepEqual(await host.addFeed(input({ pollIntervalS: 86_401 })), { refusal: 'bad-poll-interval' });
});

test('a bad download type is refused', async () => {
  const { host } = setupHost({ registered: ['movie'] });
  const result = await host.addFeed({ ...input(), downloadType: 'magnet' as AddFeedInput['downloadType'] });
  assert.deepEqual(result, { refusal: 'bad-download-type' });
});

test('an accepted feed is written and polled at once', async () => {
  // Polling immediately is the point: items arriving is the only real
  // confirmation the url was right, and `main` already makes this same call
  // at boot for feeds on file.
  const { host, raw, scheduled } = setupHost({ registered: ['movie'] });
  const result = await host.addFeed(input({ name: 'Movies HD' }));
  assert.ok('id' in result);
  const row = raw.prepare('SELECT name, plugin_id FROM rss_feed WHERE id = ?').get(result.id);
  assert.deepEqual(row, { name: 'Movies HD', plugin_id: 'movie' });
  assert.deepEqual(scheduled, [result.id], 'the first poll was scheduled');
});
```

`setupHost` builds a real host over a migrated in-memory database with a recording `schedulePoll`; `input()` returns a valid `AddFeedInput` each test overrides one field of.

- [ ] **Step 2: Run, fail, implement, run**

Put the invariants in `packages/host/src/feeds/add.ts`; `host.ts` is already long and this is a self-contained rule set. `Host.addFeed` delegates to it, passing the registered-plugin lookup the host holds.

- [ ] **Step 3: Mutation-test**

Remove the `schedulePoll` call: the last test must fail by name. Widen the interval check to accept 0: the interval test must fail.

- [ ] **Step 4: Gate and commit**

---

## Task 3: `POST /api/feeds`

**Files:**
- Modify: `packages/host/src/api/server.ts`, `packages/host/src/main.ts`
- Test: `packages/host/test/api/server.test.ts`

**Interfaces:**
- Consumes: Task 1's `Route.methods` and `RouteRequest.body`; Task 2's `Host.addFeed` and its refusal union.
- Produces: `ReadServerDeps.addFeed: (input: AddFeedInput) => Promise<{ id: number } | AddFeedRefusal>` — **the function, not the `Host`**. `ReadServerDeps.host` already means the bind interface string, and the server needs one operation rather than the whole interface.

- [ ] **Step 1: Write the failing tests**

```ts
test('a valid feed is accepted and its id returned', async () => {
  const accepted: AddFeedInput[] = [];
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    addFeed: async (i) => { accepted.push(i); return { id: 7 }; },
  });
  try {
    const answer = await post(server, '/api/feeds', cookie, validBody());
    assert.equal(answer.status, 201);
    assert.deepEqual(JSON.parse(answer.text), { id: 7 });
    assert.equal(accepted.length, 1, 'the host was asked exactly once');
  } finally {
    await server.close();
  }
});

test('each refusal answers a distinct code the client can branch on', async () => {
  // Global Constraint: distinguishable without parsing prose. The client
  // maps a code to its own words; the server authors no sentence a human
  // reads, and no url or path appears in any body.
  for (const [refusal, status] of [['duplicate-url', 409], ['unknown-plugin', 422]] as const) {
    const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
      addFeed: async () => ({ refusal }),
    });
    try {
      const answer = await post(server, '/api/feeds', cookie, validBody());
      assert.equal(answer.status, status, `${refusal} answers ${String(status)}`);
      assert.equal(JSON.parse(answer.text).refusal, refusal, 'and names itself in a stable code');
      assert.ok(!answer.text.includes('tracker.example'), 'the url is never echoed');
    } finally {
      await server.close();
    }
  }
});

test('the route is guarded by a session like every read', async () => {
  const { server } = await start(raw, db, moviesOnly);
  try {
    const answer = await post(server, '/api/feeds', null, validBody());
    assert.equal(answer.status, 401, 'no session, no write');
  } finally {
    await server.close();
  }
});

test('a malformed body is refused without reaching the host', async () => {
  let called = 0;
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    addFeed: async () => { called += 1; return { id: 1 }; },
  });
  try {
    const answer = await postRaw(server, '/api/feeds', cookie, '{not json');
    assert.equal(answer.status, 400);
    assert.equal(called, 0, 'the host is not asked to validate transport-level junk');
  } finally {
    await server.close();
  }
});
```

Two helper notes. `validBody()` returns a well-formed feed payload each test
overrides nothing in — write it beside the file's other fixtures. And these
tests pass a fourth argument to `startSignedIn` that it does not take today:
extend it to accept a partial `ReadServerDeps` override, defaulting to what it
already builds, so a test can supply its own `addFeed` without assembling a
whole server. That extension is part of this task.

- [ ] **Step 2: Run, fail, implement, run**

The route validates only the body's *shape* (the fields exist and have the right primitive types) and hands everything else to `addFeed`. Field-level rules live in the host, per the spec — duplicating them here is how they drift.

Wire it in `main.ts` at the `createReadServer` call (~line 840): `addFeed: (i) => host.addFeed(i)`. The `Host` is already in scope from ~line 800.

- [ ] **Step 3: Mutation-test**

Make every refusal answer the same status: the distinct-codes test must fail.

- [ ] **Step 4: Gate and commit**

---

## Task 4: `rss_feed` joins the synced tables

**Files:**
- Modify: `packages/host/src/sync/tables.ts`, `packages/host/src/db/migrate.ts`, `packages/contract/src/sync.ts`, `packages/web/src/store/rows.ts`
- Test: `packages/host/test/sync/tables.test.ts`, `packages/host/test/db/migrate.test.ts`

**Interfaces:**
- Produces: `rss_feed` in `HOST_SYNCED_TABLES`; `RssFeedSyncRead` in the contract; `rss_feed` in the client's `TABLES_WITH_UPDATED_AT`.
- Projection: `id`, `pluginId`, `name`, `downloadType`, `pollIntervalS`, `downloadClientId`, `createdAt`, `updatedAt`, `url` — the url **redacted in `readHostRows`, after the SELECT**.

- [ ] **Step 1: Write the failing tests**

```ts
test('a feed reaches a client with its apikey redacted', async () => {
  seedFeed(raw, { url: 'https://tracker.example/rss?apikey=SECRET' });
  const rows = registry.readRows(raw, 'rss_feed', [1]);
  assert.equal(rowUrl(rows[1]), 'https://tracker.example/rss?apikey=***');
});

test('a passkey-bearing url is NOT redacted today, and this pins that', async () => {
  // Deliberate, and the most important test in this task. `redactUrl` knows
  // one parameter name. Issue #78 broadens it, and when it does this test
  // fails -- which is the point: the gap closing must be observable rather
  // than silent. Do not "fix" this by changing the expectation; change it
  // when #78 changes the behaviour, and say so there.
  seedFeed(raw, { url: 'https://tracker.example/rss?passkey=SECRET' });
  const rows = registry.readRows(raw, 'rss_feed', [1]);
  assert.equal(
    rowUrl(rows[1]),
    'https://tracker.example/rss?passkey=SECRET',
    'redactUrl does not know `passkey`; issue #78 tracks it',
  );
});

test('the projection carries no column the client has no business holding', () => {
  seedFeed(raw, {});
  const row = registry.readRows(raw, 'rss_feed', [1])[1];
  assert.deepEqual(
    Object.keys(row as Record<string, unknown>).sort(),
    ['createdAt', 'downloadClientId', 'downloadType', 'id', 'name', 'pluginId', 'pollIntervalS', 'updatedAt', 'url'],
  );
});
```

Three helpers to write at the top of that file: `seedFeed(raw, overrides)`
inserts one `rss_feed` row with sensible defaults; `rowUrl(row)` reads the
`url` off a projected row narrowed with `typeof`/`in` rather than a cast (the
way `useCounts.ts`'s `categoryOf` narrows); and `registry` is the existing
`createSyncRegistry(raw, [])` the sibling tests already build.

Plus, in the migration test: a feed already on file before the migration appears in `sync_log` afterwards, so an existing replica backfills it.

- [ ] **Step 2: Run, fail, implement, run**

Add the `selectSql` case, then redact in `readHostRows` after the SELECT. **Rewrite `tables.ts`'s docblock**: it currently states the exclusion as a rule with no exception — "a url may not be copied into permanent client storage at all". Say the rule changed, why (the operator must tell two feeds apart), that redaction happens after the SELECT and this is the first table where the projection is not purely SQL, and that `redactUrl` covers only `?apikey=` with #78 tracking the rest.

The migration installs this table's triggers and seeds `sync_log` for rows already on file — `docs/database-migrations.md` is required reading, and a table whose triggers are not re-applied silently stops replicating.

- [ ] **Step 3: Mutation-test**

Remove the redaction call: the apikey test must fail while the passkey test still passes — which is itself the evidence that the two tests are measuring different things.

- [ ] **Step 4: Gate and commit**

---

## Task 5: The settings screens

**Files:**
- Create: `packages/web/src/settings/Feeds.tsx`, `AddFeed.tsx`, `useFeeds.ts`
- Modify: `packages/web/src/shell/Shell.tsx`
- Test: one `.test.tsx` per new file, plus `Shell.test.tsx`

**Interfaces:**
- Consumes: `Store['listByTable']` on `rss_feed`, `Store['subscribeInserts']`, and `RssFeedSyncRead`.
- Produces: `<Feeds source={FeedsSource} submit={(input: AddFeedInput) => Promise<AddFeedOutcome>} />`, and the `/settings` route rendering it.
  - `interface FeedsSource { listByTable: Store['listByTable']; subscribeInserts: Store['subscribeInserts'] }` — narrower than `Store`, so a test binds it to a bare database the way `useCounts.test.tsx`'s `sourceFor` does.
  - `type AddFeedOutcome = { id: number } | AddFeedRefusal | { refusal: 'offline' }` — `offline` is the client's own outcome for a rejected `fetch`, never a server answer, which is what keeps "no answer" distinguishable from "refused".
  - `submit` is injected rather than called directly so a test drives every outcome without a server; the real one posts to `/api/feeds`.
- **Carry the route contract**: put `data-testid="settings"` on the root and add the matching assertion to `Shell.test.tsx` beside the four that exist. The three category routes and `/unmatched` each have one; a route without it can be mis-wired silently.

- [ ] **Step 1: Write the failing tests**

```tsx
test('the list shows a feed by name and host, from the replica', async () => {
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD', url: 'https://tracker.example/rss?apikey=***' })]);
  render(<Feeds source={sourceFor(db)} />);
  await waitFor(() => {
    assert.ok(screen.getByRole('heading', { name: 'Movies HD' }), 'the feed is named');
  });
});

test('adding a feed puts it in the list without a refetch', async () => {
  // The payoff of syncing the table: the POST answers only "accepted", and
  // the row arrives through the replica's own subscription.
  const db = await freshDb();
  render(<Feeds source={sourceFor(db)} submit={async () => ({ id: 1 })} />);
  fillFeedForm({ name: 'Movies HD', url: 'https://tracker.example/rss' });
  fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);
  await waitFor(() => {
    assert.ok(screen.getByRole('heading', { name: 'Movies HD' }));
  });
});

test('each refusal reads as its own sentence, and offline is not a refusal', async () => {
  // Three distinct outcomes, three distinct words. An offline submit that
  // read as "already on file" would send the operator hunting for a feed
  // that is not there.
  for (const [outcome, phrase] of [
    ['duplicate-url', /already/i],
    ['unknown-plugin', /plugin/i],
    ['offline', /could not reach/i],
  ] as const) {
    render(<Feeds source={sourceFor(await freshDb())} submit={submitFor(outcome)} />);
    fillFeedForm({ name: 'X', url: 'https://tracker.example/rss' });
    fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));
    const alert = await screen.findByRole('alert');
    assert.ok(phrase.test(alert.textContent ?? ''), `${outcome} has its own words`);
    cleanup();
  }
});

test('the error is a visible heading, not only an announced one', async () => {
  // CLAUDE.md's longest hazard: a component once passed ten tests with
  // `role`, an `aria-label`, no visible heading and no stylesheet rule, and
  // the first human to see it read it as an error.
  render(<Feeds source={sourceFor(await freshDb())} submit={submitFor('duplicate-url')} />);
  fillFeedForm({ name: 'X', url: 'https://tracker.example/rss' });
  fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));
  const heading = await screen.findByRole('heading', { name: /already/i });
  assert.ok(screen.getByRole('alert').contains(heading), 'the visible heading is inside the announced region');
});
```

Helpers to write: `feedOp({ … })` builds one `upsert` `SyncOp` for `rss_feed`
(an `upsert`, not a `create` — the live tail never emits `create`);
`fillFeedForm({ … })` fills the form's fields; and `submitFor(outcome)`
returns a `submit` resolving to that outcome. `freshDb`, `seed` and
`sourceFor` already exist in `packages/web/test/`.

- [ ] **Step 2: Run, fail, implement, run**

The form's `pluginId` select offers `CATEGORIES` — the same constant the nav uses — and the host stays the authority (spec §4). Say so in the file's docblock, including that a fourth plugin means editing that constant.

- [ ] **Step 3: Mutation-test**

Make every refusal render the same sentence: the three-outcomes test must fail.

- [ ] **Step 4: Gate and commit**

---

## Task 6: Styling and the browser proof

**Files:**
- Modify: `packages/web/src/styles/library.css` (or a new `settings.css` imported the same way), `packages/e2e/tests/shell.spec.ts`

- [ ] **Step 1: Style the screens against the tokens**

No raw values outside `tokens.css` — that file's docblock was rewritten two slices ago to describe reality, so read what it now claims before adding to it.

- [ ] **Step 2: Add the browser proof**

```ts
test('an operator can add a feed and see it listed', async ({ page }) => {
  // The whole slice in one spec: the write route, the host's invariants, the
  // sync round trip, and the list updating from the replica.
  await signIn(page);
  await page.goto(`${harness.origin}/settings`);
  await page.getByLabel('Name').fill('Movies HD');
  await page.getByLabel('Feed url').fill(`${harness.origin}/fixtures/movies.xml`);
  await page.getByRole('button', { name: 'Add feed' }).click();
  await expect(page.getByRole('heading', { name: 'Movies HD' })).toBeVisible();
});
```

Plus one computed-style assertion for the settings screen, the way the browse screens are pinned.

- [ ] **Step 3: Prove the pin**

Remove the settings styles' import, run `npm run e2e`, confirm the new style assertion **fails**, and restore by copy-aside plus checksum. Report which specs failed by name. An assertion that survives its own stylesheet being removed pins nothing.

- [ ] **Step 4: Gate and commit**

---

## Self-review

**Spec coverage.** §1 scope → Global Constraints and Task 2. §2.1 `Host.addFeed` → Task 2. §2.2 the route and the 405 guard → Tasks 1 and 3. §3.1 the projection → Task 4. §3.2 redaction and the amended rule → Task 4, including the passkey pin. §3.3 no client bump, contract type, `TABLES_WITH_UPDATED_AT` → Task 4. §4 the screens → Task 5. §5 testing → every task's test step. §5.1's three traps → Task 4 (the passkey pin), Task 2 (the duplicate driven through a real second insert), Task 1 (the guard tested per route). §6 out of scope → not built. §7 acceptance: 1→T2, 2→T2, 3→T1, 4→T4+T5, 5→T4, 6→T5, 7→T6.

**Ordering and fan-out.** Tasks 1, 2 and 4 are independent of each other; 3 needs 1 and 2; 5 needs 3 and 4; 6 needs 5. Waves: (1, 2, 4) → (3) → (5) → (6).

**Known gap, carried not introduced.** A private tracker's passkey reaches the replica, because `redactUrl` knows only `?apikey=`. Issue #78 is the fix; Task 4 pins the gap with a test so closing it is observable. This plan does not close it and must not appear to.
