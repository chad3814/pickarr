### Task 3: Ask the provider

**Files:**
- Modify: `packages/core/src/clients/theporndb.ts` (add near `searchScenes`; refactor `readPerformers` at 205-254)
- Test: `packages/core/test/clients/theporndb.test.ts` (extend)

**Interfaces produced,** consumed by Tasks 4 and 6:

```ts
export interface PerformerSearchResult {
  readonly performer: MetadataPerformer;
  readonly aliases: readonly string[];
}
export interface PerformerSearchPage {
  readonly results: readonly PerformerSearchResult[];
  /**
   * True when the provider reported pages beyond the one read. The caller's rule
   * is "exactly one exact match", which a truncated set can get wrong, so this
   * is the signal that makes the truncation loggable instead of silent. It lives
   * on the return value rather than being logged here because the client has no
   * `log` dependency — and giving it one to say this would be the wrong seam.
   */
  readonly truncated: boolean;
}
export interface PerformerLookupClient {
  readonly source: string;
  searchPerformers(query: string): Promise<PerformerSearchPage>;
}
```

`createTpdbClient`'s return type becomes `SiteLookupClient & SceneLookupClient & PerformerLookupClient`.

**The endpoint, confirmed against the live API:**

```
GET {baseUrl}/performers?q=<query>&page=1&per_page=100
Authorization: Bearer <apiKey>
Accept: application/json
```

**The response body** (fields this uses; everything else is tolerated and ignored):

```json
{ "data": [ { "id": "32aa4b68-…", "slug": "jessica-jaymes", "name": "Jessica Jaymes",
              "full_name": "Jessica Jaymes (2005)", "is_parent": true,
              "aliases": ["Jessi Jaymes"], "image": "https://…", "face": "https://…" } ],
  "meta": { "total": 210, "per_page": 25, "current_page": 3, "last": 10 } }
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/clients/theporndb.test.ts`. **Use the file's existing fixtures — do not invent new ones:** `respondWith(body, init?)` at line 39 returns a `FetchImpl & { urls: string[] }`, and `CONFIG` at line 28 is a complete `SiteLookupConfig` (it needs `type: 'theporndb'`, which a bare `{baseUrl, apiKey}` object omits and which would not typecheck). Every test below is written against those two.

```ts
test('searchPerformers reads a top-level result as a canonical performer', async () => {
  // `is_parent` is the whole point of this test. `readPerformers` derives kind
  // from a nested `parent`, which a scene's site-performers have and a top-level
  // /performers result does not — it *is* the parent. Reusing that reader here
  // would stamp every linked performer `performer-site` and point them all at
  // alias pages, which is invisible until a user clicks one.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{
        id: '32aa4b68-4dbe-49f2-92a5-0e54e5074f4b',
        slug: 'jessica-jaymes',
        name: 'Jessica Jaymes',
        full_name: 'Jessica Jaymes (2005)',
        is_parent: true,
        aliases: ['Jessi Jaymes'],
        image: 'https://cdn.invalid/image.jpg',
        face: 'https://cdn.invalid/face.jpg',
      }],
      meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  const page = await client.searchPerformers('Jessica Jaymes');

  assert.equal(page.truncated, false);
  assert.equal(page.results.length, 1);
  assert.deepEqual(page.results[0]?.performer, {
    sourceUuid: '32aa4b68-4dbe-49f2-92a5-0e54e5074f4b',
    slug: 'jessica-jaymes',
    // `name`, never `full_name`: the latter carries a disambiguation suffix that
    // could never equal a two-word query.
    name: 'Jessica Jaymes',
    kind: 'performer',
    faceUrl: 'https://cdn.invalid/face.jpg',
    imageUrl: 'https://cdn.invalid/image.jpg',
  });
  assert.deepEqual(page.results[0]?.aliases, ['Jessi Jaymes']);
});

test('a provider reporting more pages than were read is reported as truncated', () => {
  // The match rule turns on *how many* candidates match exactly. A second exact
  // match sitting on page two would turn "link nothing, this is ambiguous" into
  // a confident wrong link, so the caller has to be able to say it judged on a
  // partial set rather than doing so in silence.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true }],
      meta: { total: 210, per_page: 100, current_page: 1, last: 3 },
    }),
  );

  return client.searchPerformers('N').then((page) => assert.equal(page.truncated, true));
});

test('a body with no meta block is not treated as truncated', () => {
  // `truncated` is a claim that more pages exist. An absent `meta` is not
  // evidence of that, and defaulting it to true would log a truncation warning
  // on every search against a provider that stops sending the block.
  const client = createTpdbClient(
    CONFIG,
    respondWith({ data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true }] }),
  );

  return client.searchPerformers('N').then((page) => assert.equal(page.truncated, false));
});

test('a result without is_parent is a site alias, not a canonical performer', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ id: 'u1', slug: '6061-alice-maze', name: 'Alice Maze', is_parent: false }],
      meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.equal(
    (await client.searchPerformers('Alice Maze')).results[0]?.performer.kind,
    'performer-site',
  );
});

test('a result missing its slug or uuid is dropped rather than stored empty', async () => {
  // The slug is the whole link, and an absent uuid collides with every other
  // such row under UNIQUE (source, source_uuid) — the same reason
  // `readPerformers` drops these.
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [
        { id: 'u1', name: 'No Slug', is_parent: true },
        { slug: 'no-uuid', name: 'No Uuid', is_parent: true },
        { id: 'u2', slug: 'fine', name: 'Fine Person', is_parent: true },
      ],
      meta: { total: 3, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.deepEqual(
    (await client.searchPerformers('x')).results.map((r) => r.performer.name),
    ['Fine Person'],
  );
});

test('missing aliases read as an empty list, not undefined', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({
      data: [{ id: 'u1', slug: 's', name: 'N', is_parent: true }],
      meta: { total: 1, per_page: 100, current_page: 1, last: 1 },
    }),
  );

  assert.deepEqual((await client.searchPerformers('x')).results.map((r) => r.aliases), [[]]);
});

test('an empty query never reaches the provider', async () => {
  let called = false;
  const client = createTpdbClient(
    CONFIG,
    async (url) => { called = true; return respondWith({ data: [] })(url); },
  );

  assert.deepEqual(await client.searchPerformers('   '), { results: [], truncated: false });
  assert.equal(called, false);
});

test('the api key never appears in a searchPerformers error', async () => {
  const client = createTpdbClient(
    CONFIG,
    async () => { throw new Error(`connect ECONNREFUSED with Bearer ${API_KEY}`); },
  );

  await assert.rejects(
    () => client.searchPerformers('Jessica Jaymes'),
    (error: Error) => !error.message.includes(API_KEY),
  );
});

test('a 429 from searchPerformers is RateLimited with the Retry-After', async () => {
  const client = createTpdbClient(
    CONFIG,
    respondWith({}, { status: 429, headers: { 'Retry-After': '120' } }),
  );

  await assert.rejects(() => client.searchPerformers('x'), (error: Error) => {
    assert.ok(error instanceof RateLimited);
    assert.equal(error.retryAfterMs, 120_000);
    return true;
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/clients/theporndb.test.ts
```

Expected: `searchPerformers` is not a function.

- [ ] **Step 3: Factor the shared performer reader**

`readPerformers` (lines 205-254) and the new reader agree on five of six fields and differ only on how `kind` is decided. Extract the agreement rather than copying it — and keep `readPerformers`' existing doc comment, which explains the `parent` preference and is still true of that caller.

```ts
/**
 * The five fields both performer shapes spell identically, or `null` when the
 * record cannot be stored at all.
 *
 * `kind` is the parameter because it is the one thing the two endpoints disagree
 * about, and they disagree for a real reason: a scene's `performers[]` are site
 * aliases carrying a nested canonical `parent`, while a `/performers` search
 * returns the canonical entity itself, which says so with `is_parent`. One
 * reader deciding `kind` by looking for a `parent` would answer
 * `'performer-site'` for every search result — every linked performer pointed at
 * an alias page, and nothing to notice it by.
 *
 * A record missing slug, uuid or name yields `null` rather than a row with an
 * empty one: the slug is the whole link, and an absent uuid collides with every
 * other such record under `UNIQUE (source, source_uuid)`.
 */
function readPerformerFields(
  record: Record<string, unknown>,
  kind: MetadataPerformer['kind'],
  nameFallback: Record<string, unknown> | null = null,
): MetadataPerformer | null {
  const slug = str(record, 'slug');
  const sourceUuid = str(record, 'id');
  const name = str(record, 'name') ?? (nameFallback === null ? null : str(nameFallback, 'name'));
  if (slug === null || sourceUuid === null || name === null) return null;
  return { sourceUuid, slug, name, kind, faceUrl: str(record, 'face'), imageUrl: str(record, 'image') };
}
```

Then rewrite `readPerformers`' loop body to use it, passing `parent === null ? 'performer-site' : 'performer'` and `site` as the `nameFallback`. **Run the full suite here** — the existing scene-metadata tests are the proof this refactor changed no behaviour.

- [ ] **Step 4: Add the search method**

Add the two interfaces near `SceneLookupClient` (line 146), widen `createTpdbClient`'s return type, and add the method beside `searchScenes`. Model the body on `searchScenes` — one page, `RateLimited` on 429, `redactToken` on every thrown message — not on `searchSites`, which walks pages.

```ts
    /**
     * One page, like `searchScenes` and unlike `searchSites`' `MAX_PAGES` walk.
     *
     * `PER_PAGE` (100) rather than a smaller page, and that is a correctness
     * argument rather than a throughput one: the caller's rule is "exactly one
     * exact match", which is only honestly decidable over the results actually
     * seen. A narrow page hides a second exact match on page two and converts an
     * ambiguity — link nothing — into a confident wrong link. When `meta.last`
     * says there were more pages the caller is told, so a truncated judgement is
     * logged rather than silent.
     */
    async searchPerformers(query: string): Promise<PerformerSearchPage> {
      if (query.trim().length === 0) return { results: [], truncated: false };
      const url = `${base}/performers?q=${encodeURIComponent(query)}&page=1&per_page=${PER_PAGE}`;
      const signal = AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS);
      const timedOut = abortRejection(signal);

      let response: Response;
      try {
        response = await Promise.race([
          fetchImpl(url, {
            headers: { Authorization: `Bearer ${config.apiKey}`, Accept: 'application/json' },
            signal,
          }),
          timedOut,
        ]);
      } catch (error) {
        throw new Error(
          `performer search for "${query}" failed: ${redactToken((error as Error).message, config.apiKey)}`,
        );
      }

      if (response.status === 429) {
        throw new RateLimited(retryAfterMs(response.headers.get('retry-after')));
      }
      if (!response.ok) {
        throw new Error(
          `performer search for "${query}" returned HTTP ${response.status} ${response.statusText}`,
        );
      }

      let body: unknown;
      try {
        // Raced against the same deadline as the fetch above — see the comment
        // on the site-search loop for why headers arriving is not enough to
        // consider the request safe from stalling.
        body = await Promise.race([response.json(), timedOut]);
      } catch (error) {
        throw new Error(
          `performer search for "${query}" returned unreadable JSON: ${redactToken((error as Error).message, config.apiKey)}`,
        );
      }

      return readPerformerPage(body);
    },
```

That error handling is `searchScenes`' verbatim with only the url, the noun in each message, and the reader changed. Do not paraphrase it — the redaction on the two `catch` paths and the shared `timedOut` race are both load-bearing, and the 429 must throw `RateLimited` rather than a plain `Error` or the pass cannot tell a rate limit from a fault.

Then the page reader, beside `readScenes`:

```ts
/**
 * Reads a performer search page, tolerating everything we do not use.
 *
 * `is_parent` decides `kind`, and it is compared against `true` rather than
 * coerced: a provider that starts sending `"true"`, `1` or `null` must read as
 * "not stated" and fall to the alias namespace, not be silently truthy. Getting
 * this wrong is invisible until a user clicks a performer and lands on the wrong
 * page.
 *
 * `truncated` is `meta.last > 1`, and an absent or unreadable `meta` reads as
 * `false`. It is a positive claim that more pages exist; defaulting it to true
 * would warn about truncation on every search the moment the provider stopped
 * sending the block.
 */
function readPerformerPage(body: unknown): PerformerSearchPage {
  if (body === null || typeof body !== 'object') return { results: [], truncated: false };
  const record = body as Record<string, unknown>;

  const results: PerformerSearchResult[] = [];
  const data = record['data'];
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (entry === null || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const performer = readPerformerFields(
        row,
        row['is_parent'] === true ? 'performer' : 'performer-site',
      );
      if (performer === null) continue;
      const aliases = row['aliases'];
      results.push({
        performer,
        aliases: Array.isArray(aliases)
          ? aliases.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0)
          : [],
      });
    }
  }

  const meta = record['meta'];
  const last =
    meta !== null && typeof meta === 'object' ? (meta as Record<string, unknown>)['last'] : null;
  return { results, truncated: typeof last === 'number' && last > 1 };
}
```

- [ ] **Step 5: Run the tests**

```
node --import tsx --conditions development --test packages/core/test/clients/theporndb.test.ts
npm run check
```

- [ ] **Step 6: Prove the mislabel guard bites**

Change the `kind` argument at the search call site to always `'performer'` and re-run: the `is_parent: false` test must fail. Then change it to `'performer-site'` always: the first test must fail. Restore. Report both.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/clients/theporndb.ts packages/core/test/clients/theporndb.test.ts
git commit -m "Search the performer directory, reading kind from is_parent"
```

---

