# qBittorrent download client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add qBittorrent as a second `DownloadClient`, so a feed served by a torrent indexer has somewhere to send its picks.

**Architecture:** `downloadClientSchema` becomes a discriminated union on the `type` literal it already carries. Three small changes to the `DownloadClient` interface make room for a client that POSTs, that must not have its finished jobs removed, and that needs the job marker separately from the job name. A new `clients/qbittorrent.ts` implements the interface against the WebUI API. The union then has to be carried through `config/editable.ts`, the HTTP submission schema and the Settings form, because `applyEdits` rebuilds the client list from the form's submission and would otherwise delete a qBittorrent client's credentials on an unrelated save.

**Tech Stack:** TypeScript, zod (config schemas), `node:test` + `node:assert/strict`, oxlint, tsgo, React (Settings form).

**Spec:** `docs/superpowers/specs/2026-08-23-qbittorrent-client-design.md`

## Global Constraints

- **Never `any`, never `unknown`.** Project-wide rule. Use the `JsonValue` helpers in `packages/core/src/json.ts` (`asJsonObject`, `asJsonArray`, `asText`) for anything parsed off the wire.
- 2-space indent, semicolons always, including where optional.
- Prefer async APIs over their `*Sync` twins.
- **qBittorrent 5.x is the minimum supported version.** The API key specifically requires **v5.2.0 or WebAPI v2.14.1**; cookie login works throughout 5.x.
- **No credential — api key, password, or bearer header — may appear in a thrown error, a log line, or a test snapshot.**
- Commit messages: one declarative sentence subject, prose body at ~80 columns, no trailers, **no closing keywords** (`Closes #49` auto-closes the issue early — write "Reported as #49." instead).
- Commits are SSH-signed through a 1Password agent; `git commit` may block on approval. Wait for it.
- Verification for every task: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` all pass before the task is done.

## File Structure

| File | Responsibility |
|---|---|
| `packages/core/src/clients/types.ts` | *modify* — `FetchLike` gains an init; `remove` becomes optional; `addUrl` gains `label` |
| `packages/core/src/clients/path-mappings.ts` | *create* — `applyPathMappings`, shared by both clients |
| `packages/core/src/clients/qbittorrent.ts` | *create* — the client: auth, `addUrl`, `snapshot`, `mapPath`, state table |
| `packages/core/src/clients/sabnzbd.ts` | *modify* — delegate `mapPath`; document the ignored `label` |
| `packages/core/src/config/schema.ts` | *modify* — the union, the qBittorrent member, per-member exported types |
| `packages/core/src/config/load.ts` | *modify* — exactly-one-credential and no-`move` rules |
| `packages/core/src/config/editable.ts` | *modify* — editable union, `toEditableConfig`, `applyEdits` |
| `packages/core/src/http/server.ts` | *modify* — submission schema union |
| `packages/core/src/main.ts` | *modify* — construct by `type` |
| `packages/core/src/pipeline/reconcile.ts` | *modify* — skip cleanup when `remove` is absent |
| `packages/core/src/pipeline/pick.ts` | *modify* — pass `label` to `addUrl` |
| `packages/web/src/components/settings/DownloadClientFields.tsx` | *modify or create* — credential fields per type |
| `packages/web/src/api/client.ts` | *modify* — the editable client type mirrors the union |

---

### Task 1: Widen `FetchLike`

**Files:**
- Modify: `packages/core/src/clients/types.ts:102`
- Test: `packages/core/test/clients/sabnzbd.test.ts` (existing, must stay green)

**Interfaces:**
- Consumes: nothing.
- Produces: `FetchLike = (url: string, init?: RequestInit) => Promise<Response>` — every later task's fetch double has this shape.

- [ ] **Step 1: Make the change**

```ts
/**
 * The injectable HTTP seam every client is built with.
 *
 * `init` is optional because SABnzbd never needs it — every parameter it sends,
 * including the api key, rides in the query string (`endpoint` below). It exists
 * for qBittorrent, which POSTs a form body to `auth/login` and `torrents/add`
 * and sends a bearer header. One seam rather than two: a second `HttpLike` used
 * only by torrent clients would mean two kinds of test double, and the third
 * client would pick one by coin flip.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
```

- [ ] **Step 2: Verify nothing else moved**

Run: `npm run typecheck`
Expected: clean. `healthcheck.ts:20` declares its own private `FetchLike` and is untouched; SABnzbd's call sites pass one argument and still satisfy the wider type.

- [ ] **Step 3: Run the existing client tests**

Run: `node --import tsx --conditions development --test packages/core/test/clients/sabnzbd.test.ts`
Expected: PASS, same count as before.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/clients/types.ts
git commit
```

---

### Task 2: Make `remove` optional and teach reconcile to skip it

**Files:**
- Modify: `packages/core/src/clients/types.ts` (the `remove` member)
- Modify: `packages/core/src/pipeline/reconcile.ts:738-746`
- Test: `packages/core/test/pipeline/reconcile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `remove?(ref: string, deleteFiles: boolean): Promise<void>` — Task 6's client omits it entirely.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/pipeline/reconcile.test.ts`, beside the existing cleanup tests:

```ts
test('a client with no remove keeps its finished job, and reports none removed', async () => {
  const db = openTestDatabase();
  // Seed exactly as the existing "a finished job is dropped from the client"
  // test does, then strip the method rather than stubbing it, so the assertion
  // is about absence and not about a stub that was never called.
  const client = clientFor(db);
  const withoutRemove: DownloadClient = { ...client };
  delete withoutRemove.remove;

  const result = await reconcileClient(deps(db), withoutRemove);

  assert.equal(result.removed, 0);
  assert.equal(result.imported, 1, 'the rest of the pass still runs');
  db.close();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/core/test/pipeline/reconcile.test.ts`
Expected: FAIL — `TypeError: client.remove is not a function`.

- [ ] **Step 3: Make the interface change**

In `clients/types.ts`, change the signature and extend the existing doc comment. Keep every word already there — the argument about why the client deletes rather than Pickarr is unchanged — and add:

```ts
  /**
   * ... existing comment unchanged ...
   *
   * **Optional, because a torrent client must not have this called at all.**
   * qBittorrent's `/torrents/delete` removes the job from the client whether or
   * not `deleteFiles` is set, which stops the seed and abandons the ratio;
   * there is no "forget this but keep seeding" operation, so the correct number
   * of calls is zero. A client that declines to reclaim finished jobs omits the
   * method, and `reconcileClient` skips cleanup for it. Optionality rather than
   * a `reclaimsFinishedJobs` flag: a flag would leave a method on the interface
   * that must never be called, which is the shape of a future bug.
   */
  remove?(ref: string, deleteFiles: boolean): Promise<void>;
```

- [ ] **Step 4: Skip the cleanup loop**

In `pipeline/reconcile.ts`, immediately before the `for (const entry of snapshot.history)` cleanup loop at :738:

```ts
  // A client with no `remove` does not reclaim finished jobs — see the method's
  // comment in clients/types.ts. Skipping the whole loop rather than each call
  // keeps `result.removed` honest: nothing was attempted, so nothing is counted.
  const remove = client.remove?.bind(client);
  if (remove !== undefined) {
    for (const entry of snapshot.history) {
      // ... existing body, calling `remove(entry.ref, true)` ...
    }
  }
```

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --conditions development --test packages/core/test/pipeline/reconcile.test.ts`
Expected: PASS, including the existing "a finished job is dropped from the client" test, which proves the skip did not disable cleanup for clients that do implement it.

- [ ] **Step 6: Full verification and commit**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/clients/types.ts packages/core/src/pipeline/reconcile.ts packages/core/test/pipeline/reconcile.test.ts
git commit
```

---

### Task 3: Pass the job marker to `addUrl`

**Files:**
- Modify: `packages/core/src/clients/types.ts` (the `addUrl` member)
- Modify: `packages/core/src/clients/sabnzbd.ts` (accept and ignore `label`)
- Modify: `packages/core/src/pipeline/pick.ts` (the `addUrl` call site)
- Test: `packages/core/test/pipeline/pick.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `addUrl(url: string, name: string, label: string): Promise<string>`. `label` is `downloadLabel(token, id)` from `db/downloads.ts`; `name` is `clientJobName(token, title, id)`, which contains the label. Task 7 uses `label` as the qBittorrent tag.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/pipeline/pick.test.ts`:

```ts
test('the marker reaches addUrl separately from the name it is embedded in', async () => {
  const db = openTestDatabase();
  const calls: { name: string; label: string }[] = [];
  const client = stubClient({
    addUrl: async (_url, name, label) => {
      calls.push({ name, label });
      return 'ref-1';
    },
  });

  await pickRelease(deps(db), 1, () => client);

  assert.equal(calls.length, 1);
  // The label is the marker alone, and the name is the title carrying it.
  assert.match(calls[0]!.label, /^pickarr-[0-9a-f]{8}-1$/);
  assert.ok(calls[0]!.name.endsWith(`[${calls[0]!.label}]`));
  db.close();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/core/test/pipeline/pick.test.ts`
Expected: FAIL — `label` is `undefined`, so the `/^pickarr-/` match fails.

- [ ] **Step 3: Change the interface**

```ts
  /**
   * ... existing comment about `name` unchanged ...
   *
   * `label` is that same marker on its own — `downloadLabel` rather than
   * `clientJobName`. The caller holds both and builds one from the other, so
   * passing both is strictly less lossy than making a client re-derive it. A
   * client that needs the marker in a field of its own gets it here instead of
   * carrying a second copy of `LABEL_MARKER_PATTERN`; a marker vocabulary in two
   * places is how #30 happened. SABnzbd ignores it — its marker travels inside
   * the name, as `nzbname`.
   */
  addUrl(url: string, name: string, label: string): Promise<string>;
```

- [ ] **Step 4: Accept and ignore it in SABnzbd**

```ts
    // `label` is deliberately unused: SABnzbd carries the marker inside `name`,
    // which it echoes back as `nzbname`. Named rather than dropped from the
    // signature so the interface's third parameter is visibly accounted for.
    async addUrl(url: string, name: string, _label: string): Promise<string> {
```

Check `.oxlintrc.json` for the unused-argument convention before choosing the `_` prefix; match whatever the repo already does.

- [ ] **Step 5: Update the call site**

In `pipeline/pick.ts`, the `client.addUrl(...)` call already has the download id and the token in scope to build `clientJobName`. Pass `downloadLabel(token, id)` as the third argument, computed once and shared with the name rather than built twice.

- [ ] **Step 6: Run the tests, verify, commit**

```bash
node --import tsx --conditions development --test packages/core/test/pipeline/pick.test.ts
npm run lint && npm run typecheck && npm run test && npm run build
git add -A && git commit
```

---

### Task 4: Extract `applyPathMappings`

**Files:**
- Create: `packages/core/src/clients/path-mappings.ts`
- Modify: `packages/core/src/clients/sabnzbd.ts:571-578`
- Test: `packages/core/test/clients/path-mappings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `applyPathMappings(mappings: readonly PathMapping[], clientPath: string): string`. Task 8's `mapPath` delegates to it.

- [ ] **Step 1: Write the test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPathMappings } from '../../src/clients/path-mappings.ts';

const MAPPINGS = [{ from: '/downloads', to: '/mnt/dl' }];

test('an exact match is translated', () => {
  assert.equal(applyPathMappings(MAPPINGS, '/downloads'), '/mnt/dl');
});

test('a path under the mapping keeps its remainder', () => {
  assert.equal(applyPathMappings(MAPPINGS, '/downloads/a/b.mkv'), '/mnt/dl/a/b.mkv');
});

test('a prefix that is not a path segment is not a match', () => {
  // `/downloads2` starts with `/downloads` as a string but is a different
  // directory. This is the property the `/` check exists for.
  assert.equal(applyPathMappings(MAPPINGS, '/downloads2/a.mkv'), '/downloads2/a.mkv');
});

test('an unmapped path is returned unchanged', () => {
  assert.equal(applyPathMappings(MAPPINGS, '/elsewhere/a.mkv'), '/elsewhere/a.mkv');
});

test('the first matching mapping wins', () => {
  const two = [{ from: '/d', to: '/first' }, { from: '/d', to: '/second' }];
  assert.equal(applyPathMappings(two, '/d/x'), '/first/x');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --import tsx --conditions development --test packages/core/test/clients/path-mappings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
import type { PathMapping } from '../config/schema.ts';

/**
 * Translates a client-reported path into one Pickarr can open.
 *
 * Shared by every client rather than copied per client, and that is worth a
 * sentence: this is the translation a recursive delete used to be aimed
 * through, which is why `DownloadClient.remove` argues for asking the client to
 * delete rather than doing it here. Two copies free to drift is not a risk
 * worth the eight lines it would save.
 *
 * The `/` in the prefix test is load-bearing: without it `/downloads2` matches
 * a mapping for `/downloads` and every path under a sibling directory is
 * rewritten into the wrong tree.
 */
export function applyPathMappings(
  mappings: readonly PathMapping[],
  clientPath: string,
): string {
  for (const mapping of mappings) {
    if (clientPath === mapping.from || clientPath.startsWith(`${mapping.from}/`)) {
      return mapping.to + clientPath.slice(mapping.from.length);
    }
  }
  return clientPath;
}
```

If `PathMapping` is not already exported from `config/schema.ts`, export it there (`export type PathMapping = z.infer<typeof pathMappingSchema>;`) rather than redeclaring the shape.

- [ ] **Step 4: Delegate from SABnzbd**

```ts
    mapPath(clientPath) {
      return applyPathMappings(mappings, clientPath);
    },
```

- [ ] **Step 5: Run, verify, commit**

```bash
node --import tsx --conditions development --test packages/core/test/clients/path-mappings.test.ts
npm run lint && npm run typecheck && npm run test && npm run build
git add -A && git commit
```

The existing SABnzbd `mapPath` tests must pass untouched — that is what makes this refactor behaviour-preserving rather than merely plausible.

---

### Task 5: The config union

**Files:**
- Modify: `packages/core/src/config/schema.ts:29-63`
- Modify: `packages/core/src/config/load.ts`
- Test: `packages/core/test/config/load.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `sabnzbdClientSchema`, `qbittorrentClientSchema`, `downloadClientSchema = z.discriminatedUnion('type', [...])`
  - `export type SabnzbdClientConfig = z.infer<typeof sabnzbdClientSchema>;`
  - `export type QbittorrentClientConfig = z.infer<typeof qbittorrentClientSchema>;`
  - `export type DownloadClientConfig = z.infer<typeof downloadClientSchema>;` (now the union)

  Tasks 6-8 take `QbittorrentClientConfig`; `createSabnzbdClient` narrows to `SabnzbdClientConfig`.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/config/load.test.ts`:

```ts
const QB_BASE = {
  id: 'qb',
  type: 'qbittorrent' as const,
  url: 'http://localhost:8080',
  category: 'pickarr',
  importMode: 'copy' as const,
};

test('a qbittorrent client with an api key parses', () => {
  const config = parseConfig(withClients([{ ...QB_BASE, apiKey: `qbt_${'a'.repeat(28)}` }]));
  assert.equal(config.downloadClients[0]?.type, 'qbittorrent');
});

test('a qbittorrent client with a username and password parses', () => {
  const config = parseConfig(withClients([{ ...QB_BASE, username: 'admin', password: 'hunter2' }]));
  assert.equal(config.downloadClients[0]?.type, 'qbittorrent');
});

test('both credentials at once is refused, naming the client', () => {
  assert.throws(
    () => parseConfig(withClients([{ ...QB_BASE, apiKey: `qbt_${'a'.repeat(28)}`, username: 'admin', password: 'x' }])),
    /qb.*exactly one/i,
  );
});

test('neither credential is refused, naming the client', () => {
  assert.throws(() => parseConfig(withClients([QB_BASE])), /qb.*exactly one/i);
});

test('a username with no password is refused, naming the client', () => {
  assert.throws(
    () => parseConfig(withClients([{ ...QB_BASE, username: 'admin' }])),
    /qb.*exactly one/i,
  );
});

test('move mode on a torrent client is refused, naming the client', () => {
  assert.throws(
    () => parseConfig(withClients([{ ...QB_BASE, importMode: 'move', apiKey: `qbt_${'a'.repeat(28)}` }])),
    /qb.*move.*seed/i,
  );
});

test('a malformed api key is refused', () => {
  assert.throws(() => parseConfig(withClients([{ ...QB_BASE, apiKey: 'not-a-key' }])), /apiKey/);
});

test('a file: reference is exempt from the api key shape check', () => {
  const config = parseConfig(withClients([{ ...QB_BASE, apiKey: 'file:/run/secrets/qb' }]));
  assert.equal(config.downloadClients[0]?.type, 'qbittorrent');
});
```

Write `withClients(clients)` as a local helper returning a minimal valid config object with those `downloadClients` — copy the shape from the file's existing fixtures rather than inventing one.

- [ ] **Step 2: Run and watch them fail**

Run: `node --import tsx --conditions development --test packages/core/test/config/load.test.ts`
Expected: FAIL — `type` must be `'sabnzbd'`.

- [ ] **Step 3: Write the schema**

```ts
const QBITTORRENT_API_KEY = /^qbt_[A-Za-z0-9]{28}$/;

export const sabnzbdClientSchema = z.object({
  // ... every field exactly as downloadClientSchema has today, unchanged ...
});

export const qbittorrentClientSchema = z.object({
  id: z.string().min(1),
  type: z.literal('qbittorrent'),
  url: z.string().url(),
  /**
   * Requires qBittorrent v5.2.0 or WebAPI v2.14.1 — the whole supported range
   * does not have it, which is why username/password stays. Documented shape:
   * `qbt_` and 28 alphanumerics. A `file:` reference is exempt for the same
   * reason SABnzbd's apiKey is: the schema is looking at the path, and
   * loadConfig re-checks once it has resolved.
   */
  apiKey: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith(SECRET_REFERENCE_PREFIX) || QBITTORRENT_API_KEY.test(value),
      `apiKey must look like "qbt_" followed by 28 alphanumerics, or be a "${SECRET_REFERENCE_PREFIX}" reference to a file containing such a key`,
    )
    .optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  category: z.string().min(1),
  importMode: z.enum(['move', 'copy']),
  pathMappings: z.array(pathMappingSchema).default([]),
});

export const downloadClientSchema = z.discriminatedUnion('type', [
  sabnzbdClientSchema,
  qbittorrentClientSchema,
]);

export type SabnzbdClientConfig = z.infer<typeof sabnzbdClientSchema>;
export type QbittorrentClientConfig = z.infer<typeof qbittorrentClientSchema>;
export type DownloadClientConfig = z.infer<typeof downloadClientSchema>;
export type PathMapping = z.infer<typeof pathMappingSchema>;
```

- [ ] **Step 4: Add the two cross-field rules in `parseConfig`**

Put them in `config/load.ts` beside the existing loop that refuses a feed naming an unconfigured plugin — same shape, same style of message:

```ts
  for (const client of parsed.downloadClients) {
    if (client.type !== 'qbittorrent') continue;

    // Exactly one credential. Both is ambiguous about which the client would
    // use; neither cannot authenticate at all. Settled here rather than at the
    // first request, where it would surface as a 403 an hour into a run.
    const hasKey = client.apiKey !== undefined;
    const hasLogin = client.username !== undefined && client.password !== undefined;
    const halfLogin = (client.username === undefined) !== (client.password === undefined);
    if (halfLogin || hasKey === hasLogin) {
      throw new Error(
        `downloadClients.${client.id}: a qbittorrent client needs exactly one of apiKey, or username and password together`,
      );
    }

    // Move would take the file out from under the torrent and stop the seed.
    // A literal 'copy' in the schema would say this more strongly, but it would
    // also force config/editable.ts and the Settings form's importMode control
    // to become conditional on client type — a UI change in service of a
    // validation. Cross-field rules already live here.
    if (client.importMode === 'move') {
      throw new Error(
        `downloadClients.${client.id}: importMode must be "copy" for a qbittorrent client — moving the file would stop the torrent seeding`,
      );
    }
  }
```

- [ ] **Step 5: Fix the fallout**

`createSabnzbdClient(config: DownloadClientConfig)` now receives a union. Narrow its parameter to `SabnzbdClientConfig`. `main.ts` will not compile until Task 9; that is expected — for this task, narrow the factory and let `main.ts` keep calling it, since every config entry is still a SABnzbd one until Task 9 lands. If `tsc` objects at `main.ts:212`, add the narrowing switch from Task 9 now and mark Task 9's step 1 done.

- [ ] **Step 6: Run, verify, commit**

```bash
node --import tsx --conditions development --test packages/core/test/config/load.test.ts
npm run lint && npm run typecheck && npm run test && npm run build
git add -A && git commit
```

---

### Task 6: The client — construction and authentication

**Files:**
- Create: `packages/core/src/clients/qbittorrent.ts`
- Test: `packages/core/test/clients/qbittorrent.test.ts`

**Interfaces:**
- Consumes: `FetchLike` (Task 1), `QbittorrentClientConfig` (Task 5), `applyPathMappings` (Task 4).
- Produces: `createQbittorrentClient(config: QbittorrentClientConfig, fetchImpl?: FetchLike): DownloadClient`. Tasks 7 and 8 fill in `addUrl` and `snapshot`.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQbittorrentClient } from '../../src/clients/qbittorrent.ts';
import type { QbittorrentClientConfig } from '../../src/config/schema.ts';

const KEY = `qbt_${'a'.repeat(28)}`;

function config(over: Partial<QbittorrentClientConfig> = {}): QbittorrentClientConfig {
  return {
    id: 'qb', type: 'qbittorrent', url: 'http://qb.test',
    category: 'pickarr', importMode: 'copy', pathMappings: [],
    ...over,
  };
}

interface Call { url: string; init: RequestInit | undefined; }

function recorder(handler: (url: string) => Response): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url); },
  };
}

test('an api key rides in a bearer header and no login is issued', async () => {
  const { calls, fetchImpl } = recorder(() => new Response('[]', { status: 200 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  await client.snapshot();

  assert.equal(calls.length, 1, 'no auth/login request');
  assert.ok(!calls[0]!.url.includes('auth/login'));
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get('authorization'), `Bearer ${KEY}`);
});

test('username and password log in once and reuse the cookie', async () => {
  const { calls, fetchImpl } = recorder((url) =>
    url.includes('auth/login')
      ? new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc123; path=/' } })
      : new Response('[]', { status: 200 }));
  const client = createQbittorrentClient(config({ username: 'admin', password: 'pw' }), fetchImpl);

  await client.snapshot();
  await client.snapshot();

  assert.equal(calls.filter((c) => c.url.includes('auth/login')).length, 1);
  const headers = new Headers(calls[2]!.init?.headers);
  assert.equal(headers.get('cookie'), 'SID=abc123');
});

test('a 403 on the cookie path re-logs in once and retries', async () => {
  let served = 0;
  const { calls, fetchImpl } = recorder((url) => {
    if (url.includes('auth/login')) {
      return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=fresh; path=/' } });
    }
    served += 1;
    return served === 1 ? new Response('', { status: 403 }) : new Response('[]', { status: 200 });
  });
  const client = createQbittorrentClient(config({ username: 'admin', password: 'pw' }), fetchImpl);

  await client.snapshot();

  assert.equal(calls.filter((c) => c.url.includes('auth/login')).length, 2);
});

test('a second 403 fails rather than looping', async () => {
  const { fetchImpl } = recorder((url) =>
    url.includes('auth/login')
      ? new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=x; path=/' } })
      : new Response('', { status: 403 }));
  const client = createQbittorrentClient(config({ username: 'admin', password: 'pw' }), fetchImpl);

  await assert.rejects(client.snapshot(), /403/);
});

test('a 403 with an api key names the version requirement', async () => {
  const { fetchImpl } = recorder(() => new Response('', { status: 403 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  await assert.rejects(client.snapshot(), /5\.2\.0/);
});

test('no credential appears in a thrown error', async () => {
  const { fetchImpl } = recorder(() => new Response('', { status: 500 }));
  for (const cfg of [config({ apiKey: KEY }), config({ username: 'admin', password: 'hunter2' })]) {
    const client = createQbittorrentClient(cfg, fetchImpl);
    const error = await client.snapshot().then(() => null, (e: Error) => e);
    assert.ok(error);
    assert.ok(!error.message.includes(KEY), 'api key leaked');
    assert.ok(!error.message.includes('hunter2'), 'password leaked');
  }
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --import tsx --conditions development --test packages/core/test/clients/qbittorrent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write construction and the two auth strategies**

Structure it as two request functions chosen once at construction, not one function with an `if` inside. The key path has no login, no cookie and no retry branch, because an API key cannot call the auth endpoints at all — collapsing them behind a shared `authenticate()` that no-ops on one side hides that.

```ts
const TIMEOUT_MS = 20_000;

/** The version that introduced API key auth. Named because the error message cites it. */
const API_KEY_MIN_VERSION = '5.2.0';

export function createQbittorrentClient(
  config: QbittorrentClientConfig,
  fetchImpl: FetchLike = (url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
): DownloadClient {
  const base = config.url.replace(/\/+$/, '');
  const request = config.apiKey === undefined ? cookieRequest() : keyRequest(config.apiKey);
  // ... `addUrl` (Task 7), `snapshot` (Task 8) ...
}
```

Both strategies expose the same `(path: string, body?: URLSearchParams) => Promise<Response>`; `body` present means POST. **Never include headers or the config in a thrown error** — the api key is in a header here, not the query string, so SABnzbd's "don't print the URL" rule does not transfer and needs restating for this file.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --conditions development --test packages/core/test/clients/qbittorrent.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add -A && git commit
```

---

### Task 7: The client — `addUrl`

**Files:**
- Modify: `packages/core/src/clients/qbittorrent.ts`
- Test: `packages/core/test/clients/qbittorrent.test.ts`

**Interfaces:**
- Consumes: Task 6's `request`, Task 3's `label` parameter.
- Produces: a working `addUrl` returning the torrent hash.

- [ ] **Step 1: Write the failing tests**

```ts
test('addUrl posts the four fields and resolves the hash from the tag lookup', async () => {
  const { calls, fetchImpl } = recorder((url) =>
    url.includes('torrents/info')
      ? new Response(JSON.stringify([{ hash: 'HASH1' }]), { status: 200 })
      : new Response('Ok.', { status: 200 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  const ref = await client.addUrl('magnet:?xt=1', 'Scene [pickarr-abc12345-7]', 'pickarr-abc12345-7');

  assert.equal(ref, 'HASH1');
  const body = new URLSearchParams(String(calls[0]!.init?.body));
  assert.equal(body.get('urls'), 'magnet:?xt=1');
  assert.equal(body.get('category'), 'pickarr');
  // These two are asserted separately and by name: swapping them would still
  // return a hash and still pass a test that only checked the answer.
  assert.equal(body.get('rename'), 'Scene [pickarr-abc12345-7]');
  assert.equal(body.get('tags'), 'pickarr-abc12345-7');
  assert.ok(calls[1]!.url.includes('tag=pickarr-abc12345-7'));
});

test('addUrl throws naming the label when the lookup finds nothing', async () => {
  const { fetchImpl } = recorder((url) =>
    url.includes('torrents/info')
      ? new Response('[]', { status: 200 })
      : new Response('Ok.', { status: 200 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  await assert.rejects(client.addUrl('magnet:?xt=1', 'n', 'pickarr-abc12345-7'), /pickarr-abc12345-7/);
});

test('addUrl throws rather than choosing when the lookup finds two', async () => {
  const { fetchImpl } = recorder((url) =>
    url.includes('torrents/info')
      ? new Response(JSON.stringify([{ hash: 'A' }, { hash: 'B' }]), { status: 200 })
      : new Response('Ok.', { status: 200 }));
  const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);

  await assert.rejects(client.addUrl('magnet:?xt=1', 'n', 'pickarr-abc12345-7'), /pickarr-abc12345-7/);
});
```

- [ ] **Step 2: Run and watch them fail**

Expected: FAIL — `addUrl` is not implemented.

- [ ] **Step 3: Implement**

```ts
    async addUrl(url: string, name: string, label: string): Promise<string> {
      await request('/api/v2/torrents/add', new URLSearchParams({
        urls: url,
        category: config.category,
        rename: name,
        tags: label,
      }));

      // The tag identifies the job, not the name, and the reason is magnets:
      // qBittorrent has no metadata at add time and reports the infohash as the
      // name until it arrives (the `metaDL` state), so a lookup keyed on the
      // name we sent would miss intermittently depending on swarm speed. A tag
      // is set at add time and does not depend on metadata.
      //
      // The marker is per-installation salted (#28), so two Pickarr instances
      // against one qBittorrent do not read each other's torrents.
      const found = asJsonArray(await json(`/api/v2/torrents/info?tag=${encodeURIComponent(label)}`));
      const first = asJsonObject(found[0]);
      if (found.length !== 1 || first === null) {
        // Zero means the add has not registered yet — recoverable, because the
        // next reconcile finds the job by its marker and adopts it. Two means
        // two downloads share a marker, which is a bug elsewhere and must not
        // be resolved by picking arbitrarily.
        throw new Error(
          `qbittorrent: expected exactly one torrent tagged ${label}, found ${found.length}`,
        );
      }
      return asText(first['hash']);
    },
```

- [ ] **Step 4: Run, verify, commit**

```bash
node --import tsx --conditions development --test packages/core/test/clients/qbittorrent.test.ts
npm run lint && npm run typecheck && npm run test && npm run build
git add -A && git commit
```

---

### Task 8: The client — `snapshot`, the state table, and `mapPath`

**Files:**
- Modify: `packages/core/src/clients/qbittorrent.ts`
- Test: `packages/core/test/clients/qbittorrent.test.ts`

**Interfaces:**
- Consumes: Task 6's `request`, Task 4's `applyPathMappings`.
- Produces: a complete `DownloadClient`.

- [ ] **Step 1: Write the failing tests**

```ts
const QUEUE_STATES = ['downloading', 'metaDL', 'stalledDL', 'queuedDL', 'forcedDL',
  'allocating', 'checkingDL', 'checkingResumeData', 'moving', 'pausedDL', 'stoppedDL'];
const DONE_STATES = ['uploading', 'stalledUP', 'queuedUP', 'forcedUP', 'checkingUP',
  'pausedUP', 'stoppedUP'];
const FAILED_STATES = ['error', 'missingFiles'];

function torrent(state: string) {
  return {
    hash: 'H', name: 'N', category: 'pickarr', state,
    progress: 0.5, content_path: '/downloads/N',
  };
}

test('every documented state lands where the table says', async () => {
  for (const state of QUEUE_STATES) {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify([torrent(state)])));
    const snap = await createQbittorrentClient(config({ apiKey: KEY }), fetchImpl).snapshot();
    assert.equal(snap.queue.length, 1, state);
    assert.equal(snap.history.length, 0, state);
  }
  for (const state of DONE_STATES) {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify([torrent(state)])));
    const snap = await createQbittorrentClient(config({ apiKey: KEY }), fetchImpl).snapshot();
    assert.equal(snap.history[0]?.outcome, 'completed', state);
  }
  for (const state of FAILED_STATES) {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify([torrent(state)])));
    const snap = await createQbittorrentClient(config({ apiKey: KEY }), fetchImpl).snapshot();
    assert.equal(snap.history[0]?.outcome, 'failed', state);
  }
});

test('an unrecognised state reads as queue and warns once', async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: string[]) => { warnings.push(args.join(' ')); };
  try {
    const { fetchImpl } = recorder(() => new Response(JSON.stringify([torrent('teleporting')])));
    const client = createQbittorrentClient(config({ apiKey: KEY }), fetchImpl);
    const first = await client.snapshot();
    await client.snapshot();
    assert.equal(first.queue.length, 1, 'unrecognised is queue, never failed');
    assert.equal(warnings.filter((w) => w.includes('teleporting')).length, 1);
  } finally {
    console.warn = original;
  }
});

test('progress becomes a whole percentage, and content_path is mapped', async () => {
  const { fetchImpl } = recorder(() =>
    new Response(JSON.stringify([{ ...torrent('downloading'), progress: 0.5 }])));
  const client = createQbittorrentClient(
    config({ apiKey: KEY, pathMappings: [{ from: '/downloads', to: '/mnt/dl' }] }),
    fetchImpl,
  );

  const snap = await client.snapshot();

  // 0.5, not 0 — the interface wants 0-100 (sabnzbd.ts parses an int, and
  // Downloads.tsx renders `{percentage}%`), and qBittorrent reports 0-1.
  assert.equal(snap.queue[0]?.percentage, 50);
  assert.equal(client.mapPath('/downloads/N'), '/mnt/dl/N');
});

test('an empty category is normalised to null', async () => {
  const { fetchImpl } = recorder(() =>
    new Response(JSON.stringify([{ ...torrent('downloading'), category: '' }])));
  const snap = await createQbittorrentClient(config({ apiKey: KEY }), fetchImpl).snapshot();
  assert.equal(snap.queue[0]?.category, null);
});

test('remove is not implemented', () => {
  const { fetchImpl } = recorder(() => new Response('[]'));
  assert.equal(createQbittorrentClient(config({ apiKey: KEY }), fetchImpl).remove, undefined);
});
```

- [ ] **Step 2: Run and watch them fail**

Expected: FAIL — `snapshot` returns nothing useful.

- [ ] **Step 3: Implement the table and `snapshot`**

```ts
/**
 * Where each qBittorrent state lands. An explicit table with a warning for
 * anything outside it, the same discipline `historyOutcome` in sabnzbd.ts
 * follows and for the same reason: reading an unknown state as a failure is
 * what marked ordinary multi-part downloads failed while SABnzbd was still
 * unpacking them.
 *
 * Both `paused*` and `stopped*` are here, and the documentation did not settle
 * which is right. The WebUI API 5.0 wiki lists `pausedUP`/`pausedDL` and does
 * not mention `stopped*`; qBittorrent 5.0 renamed the concept to Stop in its
 * user interface and the docs do not say whether the API followed. Two extra
 * rows against a completed torrent reading as unrecognised is not a close call.
 * Trim this once a real server has answered — the warning below is what tells
 * you which it emits.
 *
 * A seeding torrent is `completed`: from Pickarr's side the download finished
 * when the data arrived, and that the client goes on uploading is the client's
 * business. Reading `uploading` as queue would leave the row downloading
 * forever.
 */
const STATE_READING: Record<string, 'queue' | 'completed' | 'failed'> = {
  downloading: 'queue', metaDL: 'queue', stalledDL: 'queue', queuedDL: 'queue',
  forcedDL: 'queue', allocating: 'queue', checkingDL: 'queue',
  checkingResumeData: 'queue', moving: 'queue', pausedDL: 'queue', stoppedDL: 'queue',
  uploading: 'completed', stalledUP: 'completed', queuedUP: 'completed',
  forcedUP: 'completed', checkingUP: 'completed', pausedUP: 'completed',
  stoppedUP: 'completed',
  error: 'failed', missingFiles: 'failed',
};
```

`snapshot` issues one unfiltered `GET /api/v2/torrents/info`, matching the contract that a snapshot is everything the server holds so `complete` can mean something. Set `complete: true` on a successful request and comment that, unlike SABnzbd, there is no paging and no reported total to disagree with — a reader who knows that implementation will look for the partial case.

An unrecognised state reads as `queue` and warns once per process (a module-level `Set` of already-warned states, reset by an exported `resetQbittorrentWarningsForTests()` following `resetReconcileWarningsForTests`'s precedent). Queue is the reading that changes nothing; the interface is explicit that a snapshot may never be used to conclude absence.

- [ ] **Step 4: Run, verify, commit**

```bash
node --import tsx --conditions development --test packages/core/test/clients/qbittorrent.test.ts
npm run lint && npm run typecheck && npm run test && npm run build
git add -A && git commit
```

---

### Task 9: Construct the right client

**Files:**
- Modify: `packages/core/src/main.ts:211-212`
- Test: `packages/core/test/main.test.ts`

**Interfaces:**
- Consumes: `createQbittorrentClient` (Task 6), the config union (Task 5).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Assert that a config carrying one client of each type builds two clients, and that the qBittorrent one has no `remove`. If `main.ts` has no seam for this, assert through whatever `main.test.ts` already uses to observe the built clients rather than adding one.

- [ ] **Step 2: Implement**

```ts
  for (const clientConfig of config.downloadClients) {
    // Exhaustive over the union, so a third client type is a type error here
    // rather than a silent SABnzbd.
    switch (clientConfig.type) {
      case 'sabnzbd':
        clients.set(clientConfig.id, createSabnzbdClient(clientConfig));
        break;
      case 'qbittorrent':
        clients.set(clientConfig.id, createQbittorrentClient(clientConfig));
        break;
    }
  }
```

- [ ] **Step 3: Run, verify, commit**

---

### Task 10: Carry the union through the editable config

**Files:**
- Modify: `packages/core/src/config/editable.ts:26-34, 154-162, 299-318`
- Test: `packages/core/test/config/editable.test.ts`

**Interfaces:**
- Consumes: the config union (Task 5).
- Produces: `EditableDownloadClient` as a union with `sabnzbd` and `qbittorrent` members; the qBittorrent member carries `apiKey`, `username`, `password` as `SecretView | null`.

**This is the task that prevents data loss.** `applyEdits` rebuilds the list (`next['downloadClients'] = clients`), so a client the form cannot represent is deleted by an unrelated save.

- [ ] **Step 1: Write the failing test**

```ts
test('a qbittorrent client survives a Settings save that changed something else', () => {
  const existing = {
    downloadClients: [{
      id: 'qb', type: 'qbittorrent', url: 'http://qb.test',
      username: 'admin', password: 'hunter2',
      category: 'pickarr', importMode: 'copy', pathMappings: [],
    }],
    // ... rest of a minimal config ...
  };
  const editable = toEditableConfig(parseConfig(existing));
  // Change something unrelated, exactly as the form would.
  const submitted = { ...toSubmission(editable), trashDir: '/new/trash' };

  const next = applyEdits(existing, submitted);

  const client = asJsonObject(asJsonArray(next['downloadClients'])[0]);
  assert.equal(asText(client?.['type']), 'qbittorrent');
  assert.equal(asText(client?.['username']), 'admin');
  assert.equal(asText(client?.['password']), 'hunter2', 'the password must survive');
  assert.equal(client?.['apiKey'], undefined, 'and no empty apiKey is invented');
});
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — the password is gone, or `toEditableConfig` will not typecheck against the union.

- [ ] **Step 3: Implement**

`EditableDownloadClient` becomes a union mirroring the config. `toEditableConfig` maps each member to its own shape; secrets go through the existing `viewSecret`, so nothing reaches the browser in the clear. `applyEdits` keeps using `mergeKnownFields(existingClient, {...})` per client — that is what preserves a field neither the schema nor the form knows about — and resolves each secret with `editedSecret` against the matching previous value, exactly as it does for `apiKey` today.

- [ ] **Step 4: Run, verify, commit**

---

### Task 11: The HTTP submission schema

**Files:**
- Modify: `packages/core/src/http/server.ts:326-335`
- Test: `packages/core/test/http/server.test.ts`

**Interfaces:**
- Consumes: Task 10's editable union.
- Produces: a `configSubmissionSchema` whose `downloadClients` is the matching discriminated union.

- [ ] **Step 1: Write the failing test**

`PUT /api/config` with a qBittorrent client in the body round-trips; the same body with both credentials is a 400 naming the client.

- [ ] **Step 2-4: Implement, run, commit**

Mirror the config union with `secretEditSchema` in place of the raw strings, as the SABnzbd member already does for `apiKey`.

---

### Task 12: Settings form credential fields

**Files:**
- Modify: `packages/web/src/api/client.ts` (the `EditableDownloadClient` mirror)
- Modify: `packages/web/src/components/settings/` — the download-client fields component
- Test: `packages/web/test/Settings.test.tsx`

**Interfaces:**
- Consumes: Task 11's wire shape.
- Produces: nothing later depends on.

- [ ] **Step 1: Write the failing tests**

A qBittorrent client renders `username` and `password` fields and no `apiKey` field when it has a login; the reverse when it has a key. Filling both shows the exactly-one error without a round trip. A save round-trips the client unchanged.

- [ ] **Step 2-4: Implement, run, commit**

Use `fetchStub`/`jsonResponse` from `packages/web/test/fetchStub.ts` (#58) rather than casting `globalThis.fetch`, and `afterEach(cleanup)` rather than a per-test `cleanup()` — `docs/known-issues.md` explains what a skipped cleanup does to this suite.

---

### Task 13: Documentation

**Files:**
- Modify: `README.md`, `config.example.json`, `docs/known-issues.md`

- [ ] **Step 1: `config.example.json`** gains a commented qBittorrent client showing both credential forms, with only one active.

- [ ] **Step 2: `README.md`** — the download-client section names both types, states the 5.x floor and the 5.2.0 API-key requirement, and says plainly that copy mode means the data exists twice for as long as the torrent seeds.

- [ ] **Step 3: `docs/known-issues.md`** — a paragraph under Download client recording that Pickarr never prunes qBittorrent's list, for the same reason it never empties `trashDir`, and that a stalled torrent stays pending by design.

- [ ] **Step 4: Commit**

---

## Self-Review

**Spec coverage.** §4 auth → Tasks 5, 6. §5.1 → Task 1. §5.2 → Task 2. §5.3 → Task 3. §6 config → Task 5. §7.1 requests → Task 6. §7.2 `addUrl` → Task 7. §7.3 `snapshot` → Task 8. §7.4 no `remove` → Tasks 2, 8. §7.5 `mapPath` → Task 4. §8 state table → Task 8. §9.1/9.2 round trip → Tasks 10, 11, 12. §9.3 construction → Task 9. §10 tests → distributed. §11 risks → Task 13 documents the two that are operational.

**Type consistency.** `createQbittorrentClient(config: QbittorrentClientConfig, fetchImpl?: FetchLike)` is used identically in Tasks 6-9. `applyPathMappings(mappings, clientPath)` is defined in Task 4 and consumed in Tasks 4 and 8. `addUrl(url, name, label)` is defined in Task 3 and implemented in Task 7. `label` is `downloadLabel(token, id)` throughout.

**Known gap, deliberate.** Task 9's test depends on what seam `main.test.ts` already has; the step says to assert through it rather than invent one. If none exists, the construction switch is covered by typecheck exhaustiveness and Task 12's round-trip test, and that is worth saying in the task's commit rather than adding a seam to `main.ts` for one assertion.
