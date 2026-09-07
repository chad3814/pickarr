# Slice C Implementation Plan — Submitting a Download

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pick reaches a real download client and you can see it there.

**Architecture:** `download_client` gains an `implementation` alongside its `type`, so one column says what is downloaded and the other says which API to speak. Two tables, `torrent_download` and `nzb_download`, record what was submitted and what the client confirmed. Both adapters go through the existing per-hostname fetch queue, except qBittorrent's legacy cookie login, which needs response headers the queue cannot expose.

**Tech Stack:** TypeScript on Node's `node:sqlite`, Drizzle 1.0-rc, `node:test`, the existing `QueuedFetch`.

**Spec:** `docs/superpowers/specs/2026-09-06-download-submit-design.md` — read it alongside this plan; the spec is the authority this plan argues from.

## Global Constraints

- **Credentials are in the database and must never reach a log, an error, or this conversation.** `download_client` holds `api_key`, `username` and `password`. No tooling on this slice selects those columns; no test reaches a real client; every exhaustiveness arm and error message logs **the discriminant alone, never the object** — serialising a client config prints an api key or a password.
- Never the `any` type; never a cast to silence a type error.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly` are all on. Indexed, `Map.get` and `Set` access is checked, never `!`-asserted. Type-only imports must be `import type`. No enums — union types instead.
- Ids are SQLite integer rowids. A client's own reference (`client_ref`, `nzo_id`, an infohash) is stored as a reference, never adopted as a key.
- Rows from `node:sqlite` arrive `unknown`-shaped and must be narrowed via the `{ field: unknown }` plus `String()`/`Number()` pattern used in `host.ts`, `db/migrate.ts` and `media/writer.ts`.
- Prefer async APIs over sync twins; inside an `async` function, `await` it.
- **Timing is never asserted by waiting.** The clock, `sleep`, `Timers` and `abortSignal` are injected; use them rather than a global patch.
- A comment false about the code beside it is a defect equal to a wrong line of code. Four comments went stale across the previous three slices; check what your edits orphan.
- Pickarr 1.x (`packages/core`, `packages/plugin-api`, `packages/plugin-scenes`, `packages/web`, `packages/e2e`) is deployed and **must not be touched**. Read it freely — `clients/qbittorrent.ts`, `clients/sabnzbd.ts` and `clients/types.ts` are the reference implementations — and change nothing.
- **Do not hardcode a cumulative test count.** Three earlier plans predicted totals and were wrong every time. Each task reports the count it started from and the count it ended with. `test:server` stands at **1621**.
- `lint` must stay at **exactly 124 warnings** with **0 in `packages/contract` and `packages/host`**; if a change would add one, fix the cause rather than the count.
- Full gate, each redirected to a file and grepped — never pipe a test run through `grep`: `npm run typecheck`, `npm run test:server`, `npm run lint`, `npm run build` (both `dist/index.js` and `dist/bin.js`), `npm run test-hygiene`, `npm run e2e` (**25 passed**), `npm run test:web` (**377**).
- `packages/web`'s `the selection clears when a term filters the selected group out` is a **measured** flake at roughly one run in three. `packages/web` is untouched by this slice — report it only if it fails **consistently**.

## File Structure

**Created**
- `packages/host/src/clients/redact.ts` — one helper covering all three credential channels.
- `packages/host/src/clients/config.ts` — reads a `download_client` row into a typed config; validates the `type`/`implementation` pairing.
- `packages/host/src/clients/sabnzbd.ts` — the SABnzbd adapter.
- `packages/host/src/clients/qbittorrent.ts` — the qBittorrent adapter, both auth strategies.
- `packages/host/src/clients/select.ts` — chooses a client for a feed.
- `packages/host/src/clients/downloads.ts` — the real `DownloadClients`, and the download row's lifecycle.

**Modified**
- `packages/host/src/db/migrate.ts`, `db/schema.ts` — the rename, `implementation`, and two tables.
- `packages/host/src/fetch/queue.ts` — its error message currently leaks a credential.
- `packages/host/src/host.ts`, `src/main.ts`, `src/index.ts` — wiring.
- `scripts/seed-feed.ts` — the vocabulary rename, plus a new `scripts/seed-client.ts`.

---

### Task 1: Rename `usenet` to `nzb`

**Files:**
- Modify: `packages/host/src/db/migrate.ts`, `packages/host/src/db/schema.ts`, `scripts/seed-feed.ts`
- Test: `packages/host/test/db/migrate.test.ts`

**Interfaces:**
- Produces: `rss_feed.download_type` takes `'torrent' | 'nzb'` for every later task.

Slice B chose `usenet`; this slice's client `type` is `nzb`. A feed's type and a client's type must be compared directly, and one concept spelled two ways on two tables is how they drift. There are **9 occurrences** of `usenet` across `packages` and `scripts` — find them all with `grep -rn usenet packages scripts --include='*.ts'` and paste the list into your report.

- [ ] **Step 1: Write the failing test**

```ts
test('migrating renames an existing feed from usenet to nzb', () => {
  // Seed a feed with the old value under the previous schema version, migrate,
  // and assert it reads 'nzb'. A rename tested only against an empty table
  // proves nothing about the rows you actually have.
});
```

- [ ] **Step 2: Run it and confirm it fails.**

- [ ] **Step 3: Add the migration and change the default**

```sql
UPDATE rss_feed SET download_type = 'nzb' WHERE download_type = 'usenet';
```

The column default also changes from `'torrent'`... it does not — `torrent` stays the default. Only the `usenet` value is renamed. Mirror nothing in `schema.ts` except the comment, since the column's type and nullability are unchanged.

- [ ] **Step 4: Update `scripts/seed-feed.ts`** — its `DownloadType` union, its validator, its `--type=` help text and its error message all say `usenet`.

- [ ] **Step 5: Run it and confirm the tests pass.**

- [ ] **Step 6: Prove the test can fail** — omit the `UPDATE` from the migration; the rename test must fail. Report the count.

- [ ] **Step 7: Run the full gate, then commit**

```bash
git commit -m "Call an nzb feed an nzb, so a feed's type and a client's type are one vocabulary" -- packages scripts
```

---

### Task 2: Redact credentials from error messages

**Files:**
- Create: `packages/host/src/clients/redact.ts`
- Modify: `packages/host/src/fetch/queue.ts`
- Test: `packages/host/test/clients/redact.test.ts`, `packages/host/test/fetch/queue.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Replaces the value of any credential-bearing query parameter with ***. */
  export function redactUrl(url: string): string;
  /** Replaces the value of a credential-bearing header with ***. */
  export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string>;
  /** Replaces the value of a credential-bearing form field with ***. */
  export function redactFormBody(body: string): string;
  ```

**This fixes a live leak, not a hypothetical one.** `fetch/queue.ts` builds `fetch ${url} failed: ${status} ${statusText}`, and SABnzbd's API key travels as `?apikey=`, so any failed SABnzbd call writes the key into an error and every log that carries it.

Credentials reach a client through **three channels**, so one regex is not enough: a query parameter (`apikey`), a header (`Authorization`), and a form body field (`password`). 1.x's `redactApiKeyParam` covers only the first because that is all SABnzbd needed.

- [ ] **Step 1: Write the failing tests**

```ts
test('a credential query parameter keeps its name and loses its value', () => {
  assert.equal(redactUrl('https://h/api?apikey=s3cret&mode=addurl'),
               'https://h/api?apikey=***&mode=addurl');
});
test('a url with no credential parameter is returned unchanged', () => {});
test('an Authorization header loses its value but keeps its scheme', () => {});
test('a password form field loses its value', () => {});
test('redaction is case-insensitive in the parameter name', () => {
  // `ApiKey` and `APIKEY` are the same parameter to a server and must be to us.
});
test('the queue names a failing url without its credential', () => {
  // The regression test for the live leak: a failing request to a url bearing
  // `?apikey=` must produce a message containing neither the key nor the
  // string it was set to.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement the three helpers and use `redactUrl` in the queue's error path.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail** — return the url unchanged from `redactUrl`; the queue test and the parameter test must both fail. Report counts by name.
- [ ] **Step 6: Run the full gate, then commit**

```bash
git commit -m "Keep a credential out of the error that names the request carrying it" -- packages
```

---

### Task 3: Schema for clients and downloads

**Files:**
- Modify: `packages/host/src/db/migrate.ts`, `packages/host/src/db/schema.ts`
- Test: `packages/host/test/db/migrate.test.ts`, `packages/host/test/db/schema.test.ts`

**Interfaces:**
- Produces, for every later task:
  ```
  download_client.implementation  TEXT NOT NULL   -- 'qbittorrent' | 'sabnzbd'
  torrent_download / nzb_download
    id, rss_item_id, download_client_id, client_ref, status, attempts,
    last_error, created_at, updated_at   (+ infohash on torrent_download)
  ```

`HOST_MIGRATIONS` is at version 4, so this is version 5. `migrateHost` is already atomic — each migration and its version record share a savepoint with a matching `RELEASE` on both paths — so you should not touch that; say so in your report if you find you must.

```sql
ALTER TABLE download_client ADD COLUMN implementation TEXT NOT NULL DEFAULT 'qbittorrent';

CREATE TABLE torrent_download (
  id                 INTEGER PRIMARY KEY,
  rss_item_id        INTEGER NOT NULL REFERENCES rss_item (id),
  download_client_id INTEGER NOT NULL REFERENCES download_client (id),
  infohash           TEXT,
  client_ref         TEXT,
  status             TEXT    NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX torrent_download_client_ref
  ON torrent_download (download_client_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX torrent_download_item ON torrent_download (rss_item_id);

CREATE TABLE nzb_download (
  id                 INTEGER PRIMARY KEY,
  rss_item_id        INTEGER NOT NULL REFERENCES rss_item (id),
  download_client_id INTEGER NOT NULL REFERENCES download_client (id),
  client_ref         TEXT,
  status             TEXT    NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX nzb_download_client_ref
  ON nzb_download (download_client_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX nzb_download_item ON nzb_download (rss_item_id);
```

Three things and their reasons:

- **`implementation` needs a `DEFAULT`** because SQLite rejects `ADD COLUMN ... NOT NULL` without one on a populated table. `'qbittorrent'` is that default because it makes the statement legal, **not** because it is a good value to inherit silently — say so in the comment.
- **`client_ref` is nullable on purpose.** A row is written *before* the client is called, so a submission that dies between request and response leaves evidence rather than nothing.
- **The unique index is partial** (`WHERE client_ref IS NOT NULL`) so many unconfirmed rows can coexist while no two rows claim one job. SQLite treats NULLs as distinct anyway; the partial form states the intent.

- [ ] **Step 1: Write the failing tests**

```ts
test('a migration to version 6 adds implementation to a populated download_client row', () => {});
test('two unconfirmed downloads for one client coexist', () => {
  // Both rows have a null client_ref, which is the shape a submission has
  // between the request and the client's answer. This is the property the
  // write path depends on -- but note it holds because SQLite exempts NULL
  // from a unique constraint, NOT because the index is partial, so this
  // test cannot distinguish the partial index from a total one.
});
test('the client_ref index is partial', () => {
  // The `WHERE` clause changes no insert's outcome, so nothing behavioural
  // can pin it. Read it back from `sqlite_master` instead, and name the test
  // for what it is: a drift guard on a deliberate intent marker.
});
test('two downloads cannot claim the same client_ref', () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Add migration 6 and mirror both tables in `schema.ts`.** `schema.test.ts` compares every column's name, type and nullability and every index's columns and uniqueness against the DDL, and will fail until they match. **That failure is the test working** — do not weaken the comparison.
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - make the unique index total (drop the `WHERE`) → the partial-index test must fail. It will **not** break the coexist test: NULLs are distinct in a unique index either way, so no insert changes outcome. An earlier draft of this plan asked for the coexist test here and was wrong.
  - omit `infohash` from `schema.ts` only → a `schema.test.ts` test must fail
  - drop `implementation`'s `DEFAULT` → the populated-row test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git commit -m "Record what was submitted and what the client confirmed, in one table per client type" -- packages
```

---

### Task 4: Read a client row into a typed config

**Files:**
- Create: `packages/host/src/clients/config.ts`
- Test: `packages/host/test/clients/config.test.ts`

**Interfaces:**
- Consumes: `download_client.implementation` (Task 3).
- Produces:
  ```ts
  export type ClientType = 'torrent' | 'nzb';
  export type Implementation = 'qbittorrent' | 'sabnzbd';

  export interface SabnzbdConfig {
    kind: 'sabnzbd'; id: number; baseUrl: string; apiKey: string; category: string;
  }
  export interface QbittorrentBearerConfig {
    kind: 'qbittorrent-bearer'; id: number; baseUrl: string; apiKey: string; category: string;
  }
  export interface QbittorrentLoginConfig {
    kind: 'qbittorrent-login'; id: number; baseUrl: string;
    username: string; password: string; category: string;
  }
  export type ClientConfig = SabnzbdConfig | QbittorrentBearerConfig | QbittorrentLoginConfig;

  export function readClientConfig(raw: DatabaseSync, clientId: number): ClientConfig;
  ```

**The discriminant carries the auth strategy, not just the software.** qBittorrent has two, and which one applies is decided once, here, by whether the row has an `api_key` — rather than re-decided inside the adapter on every request.

**A `type`/`implementation` mismatch is a configuration error, refused when the row is read.** A `torrent` row whose implementation is `sabnzbd` cannot work, and discovering that at the first submission means the failure arrives far from its cause.

- [ ] **Step 1: Write the failing tests**

```ts
test('a sabnzbd row reads as a sabnzbd config', () => {});
test('a qbittorrent row with an api key reads as the bearer strategy', () => {});
test('a qbittorrent row with only a username and password reads as the login strategy', () => {});
test('a qbittorrent row with neither is refused, naming the client and the missing fields', () => {});
test('a torrent row implemented by sabnzbd is refused', () => {
  // The pairing is nonsense: refuse when the row is read, not at first submit.
});
test('an nzb row implemented by qbittorrent is refused', () => {});
test('an unknown implementation is refused, naming only the value', () => {
  // The value, never the row. Serialising a client row prints an api key.
});
test('a refusal message contains no credential', () => {
  // Build a row with a recognisable secret, trigger each refusal, and assert
  // the secret appears in none of the messages.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `readClientConfig`.** Narrow the row rather than asserting its shape. In the unknown-implementation arm, use a `never` assignment for the compile-time guarantee and log **the discriminant alone**.
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - accept a mismatched pairing → both mismatch tests must fail
  - include the row in a refusal message → the no-credential test must fail
  - prefer the login strategy when an api key is present → the bearer test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git commit -m "Decide a client's auth strategy once, when its row is read" -- packages
```

---

### Task 5: The SABnzbd adapter

**Files:**
- Create: `packages/host/src/clients/sabnzbd.ts`
- Test: `packages/host/test/clients/sabnzbd.test.ts`

**Interfaces:**
- Consumes: `SabnzbdConfig` (Task 4), `redactUrl` (Task 2), `QueuedFetch` (existing).
- Produces:
  ```ts
  export interface SubmitResult { ref: string }
  export function createSabnzbdClient(config: SabnzbdConfig, fetch: QueuedFetch): {
    submit(link: string, name: string): Promise<SubmitResult>;
  };
  ```

SABnzbd is the simpler of the two: `addurl` answers with the reference directly.

```
GET {baseUrl}/api?mode=addurl&name=<link>&cat=<category>&nzbname=<name>&apikey=<key>&output=json
→ { "nzo_ids": ["SABnzbd_nzo_abc123"] }
```

Take the **first** id as the ref. Everything goes through the queue, so it inherits pacing, the thirty-second timeout, and the slot-release guarantee.

- [ ] **Step 1: Write the failing tests**

```ts
test('submitting returns the first nzo id as the reference', () => {});
test('an empty nzo_ids array is a failure, not an empty reference', () => {
  // A submission with no id is unrecognisable later; treating '' as a ref
  // would write a row claiming a job nothing can find.
});
test('the api key travels in the query and never in an error message', () => {});
test('the category and display name are sent as the client sees them', () => {});
test('the request goes through the queue, so a second call to the same host waits', () => {
  // Assert by counting in-flight calls, never by elapsed time.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement the adapter.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - return `''` when `nzo_ids` is empty → the empty-array test must fail
  - bypass the queue with a bare `fetch` → the queue test must fail
  - build the error from the raw url → the api-key test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git commit -m "Submit an nzb and keep the reference SABnzbd answers with" -- packages
```

---

### Task 6: qBittorrent, bearer auth and the magnet path

**Files:**
- Create: `packages/host/src/clients/qbittorrent.ts`
- Test: `packages/host/test/clients/qbittorrent.test.ts`

**Interfaces:**
- Consumes: `QbittorrentBearerConfig` (Task 4), `redactHeaders` (Task 2), `QueuedFetch`.
- Produces:
  ```ts
  export const API_KEY_MIN_VERSION = '5.2.0';
  /** The infohash from a magnet link, or null when the link is not one. */
  export function infohashFromMagnet(link: string): string | null;
  export function createQbittorrentClient(config: QbittorrentBearerConfig | QbittorrentLoginConfig, fetch: QueuedFetch): {
    submit(link: string, name: string): Promise<SubmitResult>;
  };
  ```

**qBittorrent's add returns no identifier at all** — unlike SABnzbd. `POST /api/v2/torrents/add` answers with a bare body and nothing to key on.

**A magnet solves that for free.** The link already carries the infohash, which *is* qBittorrent's reference, so a magnet submission is **one request** and needs no lookup. This task covers only that path; Task 7 covers the `.torrent` URL, which needs a second request.

Bearer auth needs qBittorrent **5.2.0** or newer (WebAPI 2.14.1); the header is `Authorization: Bearer <apiKey>`. If the server is older it will reject the header, and the error must say which version is needed rather than reporting a bare 401 or 403.

- [ ] **Step 1: Write the failing tests**

```ts
test('a magnet link yields its infohash without any lookup', () => {
  // Assert exactly one request was made. Two would mean the lookup path ran.
});
test('an infohash is read case-insensitively and stored lowercase', () => {
  // A magnet may spell it either way; two spellings of one hash would defeat
  // the unique index on (download_client_id, client_ref).
});
test('a link that is not a magnet yields null from infohashFromMagnet', () => {});
test('a rejected bearer header names the minimum version', () => {});
test('the bearer token never appears in an error message', () => {});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `infohashFromMagnet` and the bearer submit path.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - store the infohash as given rather than lowercased → the case test must fail
  - perform a lookup even for a magnet → the one-request test must fail
  - include the header in the error → the token test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git commit -m "Take a magnet's infohash as qBittorrent's own reference, so a submit is one request" -- packages
```

---

### Task 7: qBittorrent, the `.torrent` lookup

**Files:**
- Modify: `packages/host/src/clients/qbittorrent.ts`
- Test: `packages/host/test/clients/qbittorrent.test.ts`

**Interfaces:**
- Produces: `submit()` handles a non-magnet link, returning `{ ref: null }` when the add registered but the torrent is not yet visible.
  ```ts
  export interface SubmitResult { ref: string | null }
  ```

**`ref` becomes nullable here, and that is the whole point of the task.** A `.torrent` URL's infohash lives inside the file, so after adding, the torrent must be found via `GET /api/v2/torrents/info?category=<category>` and its `hash` read.

Two readings that look like failures and are not:

- **An empty lookup means the add has not registered yet.** 1.x says so explicitly. The row stays `submitting` with no `last_error`, for a later retry — marking it `failed` would abandon a download that is about to appear.
- **An infohash of all zeros means metadata has not arrived.** It is not a reference. Treat it exactly as an empty lookup.

- [ ] **Step 1: Write the failing tests**

```ts
test('a torrent url is added and its hash found by category', () => {});
test('an empty lookup leaves the reference unresolved rather than failing', () => {
  // Assert ref is null AND that nothing was recorded as an error.
});
test('an all-zero infohash is treated as unresolved, not as a reference', () => {});
test('a lookup matches on category so another client\'s torrents are ignored', () => {
  // The fake answers with a foreign torrent in a different category; assert it
  // is not adopted.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement the lookup path.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - throw on an empty lookup → the unresolved test must fail
  - accept the zero hash as a ref → its test must fail
  - drop the category filter → the foreign-torrent test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git commit -m "Treat a torrent qBittorrent has not registered yet as unresolved rather than failed" -- packages
```

---

### Task 8: qBittorrent's legacy cookie login

**Files:**
- Modify: `packages/host/src/clients/qbittorrent.ts`
- Test: `packages/host/test/clients/qbittorrent.test.ts`

**Interfaces:**
- Consumes: `QbittorrentLoginConfig` (Task 4), `redactFormBody` (Task 2).

**This is the only request in the slice outside the fetch queue, and it needs a reason to be.** `HostFetch`'s methods return parsed bodies, so a caller cannot reach response headers — and the `SID` cookie must be read from `Set-Cookie`. Use a bare `fetch` for the login **only**; every request after it replays the cookie **through the queue**.

Read the cookie with **`getSetCookie()`**. `Headers.get('set-cookie')` folds every cookie in the response into one comma-joined string that cannot be split back apart safely, because a cookie value may itself contain a comma.

**The trap that makes this task worth its own review:** qBittorrent answers a **wrong username or password with HTTP 200** and a body saying so. A `res.ok` check reads that as success, so bad credentials present as a working client that silently never accepts a job. The body must be inspected.

- [ ] **Step 1: Write the failing tests**

```ts
test('a successful login carries the SID cookie into the next request', () => {});
test('a login answering 200 with a refusal body is a failure', () => {
  // The trap. The fake answers 200 and qBittorrent's refusal text; assert the
  // submission fails and the message says the credentials were refused.
});
test('the password never appears in an error message', () => {});
test('the cookie is read with getSetCookie, so a comma in a value survives', () => {
  // A fake returning two Set-Cookie headers, one containing a comma, must
  // yield the correct SID rather than a spliced string.
});
test('only the login bypasses the queue; the add goes through it', () => {
  // Assert by counting in-flight calls per host, never by timing.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement the login strategy.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - accept any 200 as a successful login → the refusal-body test must fail
  - read the cookie with `headers.get('set-cookie')` → the comma test must fail
  - send the add outside the queue too → the queue test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git commit -m "Inspect the body of a qBittorrent login, which answers a refusal with 200" -- packages
```

---

### Task 9: Choosing a client for a feed

**Files:**
- Create: `packages/host/src/clients/select.ts`
- Test: `packages/host/test/clients/select.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** The client a feed's picks go to. Throws when the choice is ambiguous or absent. */
  export function selectClientForFeed(raw: DatabaseSync, feedId: number): number;
  ```

The order is: the feed's own `download_client_id`; otherwise the **only** client whose `type` matches the feed's `download_type`; otherwise a loud error naming the feed and what to fix.

**Never "the first client".** 1.x sent every pick to `downloadClients[0]` regardless of configuration, so a second client could receive nothing at all — which is why a feed can name a client now. A **sole** match is safe because it is unambiguous by construction; a **first** match is the same bug wearing a better name.

- [ ] **Step 1: Write the failing tests**

```ts
test('a feed that names a client gets that client', () => {});
test('a feed naming none falls back to the only client of its type', () => {});
test('two clients of the feed\'s type is an error naming the feed', () => {
  // Not a silent choice. This is the 1.x bug, and the test that forbids it.
});
test('no client of the feed\'s type is an error naming the feed', () => {});
test('a client of the other type is not a candidate', () => {
  // One nzb client exists and the feed is torrent: that is "none", not "one".
});
test('a feed naming a client of the wrong type is an error', () => {
  // An explicit choice can still be wrong, and a magnet handed to an nzb
  // client fails confusingly far from here.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `selectClientForFeed`.**
- [ ] **Step 4: Run and confirm the tests pass.**
- [ ] **Step 5: Prove the tests can fail**
  - take the first matching client instead of requiring a sole one → the two-clients test must fail
  - drop the type filter → the other-type test must fail
  - skip the explicit-choice type check → its test must fail
- [ ] **Step 6: Run the full gate, then commit**

```bash
git commit -m "Fall back to a sole matching client, never to the first one" -- packages
```

---

### Task 10: The real `DownloadClients`, and wiring

**Files:**
- Create: `packages/host/src/clients/downloads.ts`, `scripts/seed-client.ts`
- Modify: `packages/host/src/main.ts`, `packages/host/src/index.ts`
- Test: `packages/host/test/clients/downloads.test.ts`

**Interfaces:**
- Consumes: every earlier task.
- Produces:
  ```ts
  export function createDownloadClients(deps: {
    raw: DatabaseSync; fetch: QueuedFetch; now: () => number;
    log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
  }): DownloadClients;
  ```

`createHost` already takes `downloads: DownloadClients` as an injected dependency and hands it to every plugin as `ctx.downloads`, so this task supplies the real one in place of `main`'s current stub. The double already calls `ctx.downloads.submit(...)`, which means the seam is exercised the moment this lands.

**The row is written before the client is called.** That ordering is the reason `client_ref` is nullable: a submission that dies between the request and the response leaves a `submitting` row rather than nothing at all.

Sequence:

1. Read the rss item to find its feed; `selectClientForFeed` chooses the client (Task 9), and the submission's own `downloadClientId` is verified against it.
2. `readClientConfig` (Task 4) gives the strategy; the adapter follows from `type`.
3. Insert a `submitting` row into the table matching the client's `type`, with the infohash when the link is a magnet.
4. Call the adapter. On a ref, update to `submitted` with `client_ref`. On `null` — the unresolved `.torrent` case — leave it `submitting`. On a throw, set `failed` with a **redacted** `last_error` and rethrow.

**Row updates are conditional — `WHERE id = ? AND status = 'submitting'`.** The previous slice found a late settle deciding a row a newer attempt already owned, because its guard checked the state but not which attempt. The same shape applies here.

- [ ] **Step 1: Write the failing tests**

```ts
test('a submitted torrent gets a row with its infohash and the returned ref', () => {});
test('the row exists before the client is called', () => {
  // Assert from inside the fake adapter that the row is already there and
  // reads `submitting`. This is what makes a crash mid-submit recoverable.
});
test('an unresolved torrent url leaves the row submitting with no error', () => {});
test('a client that throws leaves the row failed with a redacted error', () => {});
test('a submission naming a client the feed does not use is refused', () => {});
test('an nzb feed writes to nzb_download and never to torrent_download', () => {});
test('a late update cannot overwrite a row that is no longer submitting', () => {
  // The conditional-update guard, from the previous slice's blocking bug.
});
```

- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement `createDownloadClients` and wire it into `main`.**
- [ ] **Step 4: Write `scripts/seed-client.ts`** — inserts one `download_client` row from arguments, following `seed-feed.ts`'s `--database=` shape. **It must accept a credential without echoing it**: read the api key or password from an environment variable, never an argv flag, since argv is visible in `ps` and shell history. Say in your report which variables you chose.
- [ ] **Step 5: Run and confirm the tests pass.**
- [ ] **Step 6: Prove the tests can fail**
  - insert the row after calling the adapter → the row-exists-first test must fail
  - drop `AND status = 'submitting'` → the late-update test must fail
  - write to the table matching the feed rather than the client → the nzb test must fail
  - put the raw error into `last_error` → the redaction test must fail
- [ ] **Step 7: Run the full gate, then commit**

```bash
git commit -m "Give a plugin a real download client, and a row that survives a crash mid-submit" -- packages scripts
```

---

## Self-Review

**Spec coverage.** §1's four deliverables → Tasks 3 (schema), 5–8 (adapters), 2 (redaction), 10 (wiring). §1.1's decisions → Global Constraints and: `type`/`implementation` → Tasks 3 and 4; the day-one split → Task 3; `nzb` not `usenet` → Task 1; no marker or salt → no task, deliberately; queue-except-login → Tasks 5–8. §1.2's exclusions → no tasks. §2 client identity → Task 4. §3 the tables → Task 3, with the `infohash`/`client_ref` distinction realised in Task 10's write ordering. §4 transport → Tasks 5, 6, 8. §5 redaction → Task 2. §6 selection → Task 9. §7 the ref asymmetry → Tasks 5, 6, 7. §8's three traps → Task 8 (HTTP 200), Task 7 (zero infohash), and the `None`-category mapping, which belongs to reconcile since nothing in this slice reads a category back — **noted as a gap below**. §9 testing → distributed. §10 consequences → recorded, not work.

**One gap found and closed by this review.** §8 lists a third trap — a category of `None` or the empty string means *no category* — but no task needed it, because nothing in a submit-only slice ever reads a category back from a client. It belongs to reconcile. Rather than inventing a task for it, this is recorded here and in the spec's §10 so the reconcile slice inherits it.

**Placeholder scan.** No "TBD", no "handle edge cases", no "similar to Task N". Test cases are named skeletons with the reason each exists stated beside them; load-bearing steps carry real SQL and real signatures.

**Type consistency.** `ClientConfig`'s union members are Task 4's and Tasks 5, 6 and 8 consume them unchanged. `SubmitResult.ref` is `string` in Task 5 and Task 6 and widens to `string | null` in Task 7 — **deliberate, stated there, and the reason that task exists**; Task 10 handles both. `selectClientForFeed` is Task 9's and Task 10's only caller. `redactUrl`/`redactHeaders`/`redactFormBody` are Task 2's, used by Tasks 5, 6, 8 and 10.

**One thing recorded rather than resolved.** `SubmitResult.ref` widening mid-plan is a wart. The alternative — declaring it nullable in Task 5, where SABnzbd can never return null — would put a case in the type that one adapter cannot produce, and every SABnzbd caller would carry a null check for a value that never arrives. Widening where the nullability becomes real is the lesser evil, and Task 7 says so.
