# Fetch Host Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator set, per hostname and for the default, how many requests the host runs at once and how long one may take, from a `Fetching` section on Settings, with the change applied to the next request and written to the config file.

**Architecture:** A `fetch` namespace in the config file is read through a `FetchSettings` object that the fetch queue consults on every request; the bounded queue gains a mutable limit. A `GET` and a `PUT` under `/api/fetch-hosts` read and write the settings, answering refusals as values. The web Settings page gains a section that reads over REST and saves per row.

**Tech Stack:** Node 24, `node:sqlite`, zod 4, React 19, `node:test`, `@testing-library/react`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-fetch-host-settings-design.md`

## Global Constraints

- `concurrency` is an integer from 1 to 64. `timeoutMs` is an integer from 1 000 to 3 600 000.
- Defaults when the `fetch` section is absent: `concurrency: 1`, `timeoutMs: 30000`.
- The lookup hostname falls back to `LOOKUP_CONCURRENCY` (4) and `LOOKUP_TIMEOUT_MS` (300 000) per field when its entry is absent or lacks that field.
- The path segment `default` is reserved for the default pair and is refused as a hostname.
- A hostname key must satisfy `isHostname`: lowercase, parses as the whole `hostname` of `http://<value>`, contains none of `/ : @ ? #` or whitespace, non-empty.
- Running requests are never cancelled by a settings change.
- A rejected config write leaves the live values unchanged and is a 500.
- Never use the `any` TypeScript type. `exactOptionalPropertyTypes` is on: build optional fields by conditional spread, never `field: undefined`.
- Every test asserts literal expected values; no expected value is computed by the code under test.
- Web tests use `afterEach(cleanup)` and never hand a live DOM node to `node:assert`.

## Review Focus

1. A hostname with a port or uppercase letters typed into the file by hand would match no request; the schema refuses it at boot naming the key. Pinned in Task 2.
2. Lowering a limit while requests wait must release none of them and must not strand the queue: when running drops below the new limit, waiters resume. Pinned in Task 1.
3. A timeout change made while a request waits for a slot applies to that request when it starts, because the ceiling is a property of the service and queue time is not. Pinned in Task 5.
4. A `PUT` whose config write throws must not change `limitFor`, or the UI would show a value that is not on disk and is lost at restart. Pinned in Task 4.
5. Clearing both fields on a configured host must remove its key from the file rather than leave `{}`; otherwise the row shows as configured forever. Pinned in Task 4.

---

### Task 1: `BoundedQueue.setLimit` and `limit()`

**Files:**
- Modify: `packages/host/src/util/bounded-queue.ts`
- Test: `packages/host/test/util/bounded-queue.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BoundedQueue.setLimit(limit: number): void` and `BoundedQueue.limit(): number`, used by Task 5.

- [ ] **Step 1: Write the failing tests**

Append to `packages/host/test/util/bounded-queue.test.ts` (the file already defines `deferred<T>()` and `tick()`):

```ts
test('setLimit raised releases exactly the new headroom\'s worth of waiters', async () => {
  const queue = createBoundedQueue(1);
  const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
  let started = 0;
  const runs = gates.map((gate) => queue.run(async () => {
    started += 1;
    await gate.promise;
  }));
  await tick();
  assert.equal(started, 1, 'one slot, one task running');

  queue.setLimit(3);
  await tick();
  assert.equal(started, 3, 'raising to three starts two more and no more');
  assert.equal(queue.limit(), 3);

  for (const gate of gates) gate.resolve();
  await Promise.all(runs);
});

test('setLimit lowered cancels nothing and opens no slot until running drops below the new limit', async () => {
  const queue = createBoundedQueue(3);
  const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
  let started = 0;
  const runs = gates.map((gate) => queue.run(async () => {
    started += 1;
    await gate.promise;
  }));
  await tick();
  assert.equal(started, 3);

  queue.setLimit(1);
  await tick();
  assert.equal(started, 3, 'the three in flight keep running');
  assert.equal(queue.active(), 3);

  gates[0]!.resolve();
  await tick();
  assert.equal(started, 3, 'two still running is not below a limit of one, so the fourth waits');

  gates[1]!.resolve();
  await tick();
  assert.equal(started, 3, 'one running equals the limit; still no slot');

  gates[2]!.resolve();
  await tick();
  assert.equal(started, 4, 'running fell to zero, so the waiter resumes');

  gates[3]!.resolve();
  await Promise.all(runs);
});

test('setLimit refuses the same values the constructor does', () => {
  const queue = createBoundedQueue(2);
  assert.throws(() => queue.setLimit(0), /bounded queue limit must be an integer of at least 1, got 0/);
  assert.throws(() => queue.setLimit(1.5), /got 1\.5/);
  assert.equal(queue.limit(), 2, 'a refused value changes nothing');
});
```

- [ ] **Step 2: Run the file to see the three fail**

Run: `node --import tsx --conditions development --test packages/host/test/util/bounded-queue.test.ts 2>&1 | grep -E "^(✖|ℹ (pass|fail))"`
Expected: three `✖` lines mentioning `setLimit`, on `queue.setLimit is not a function`.

- [ ] **Step 3: Implement**

In `packages/host/src/util/bounded-queue.ts`, change the interface and the factory:

```ts
export interface BoundedQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
  active(): number;
  idle(): Promise<void>;
  /** The number of tasks allowed to run at once, as of the last `setLimit` or construction. */
  limit(): number;
  /**
   * Changes the ceiling for every task from now on. Raising it starts as
   * many waiting tasks as the new headroom allows; lowering it starts
   * none and cancels none -- running tasks finish, and `run` opens no new
   * slot until `active()` is below the new limit. Refuses the same values
   * the constructor does.
   */
  setLimit(limit: number): void;
}
```

Inside `createBoundedQueue`, make `limit` a `let` (rename the parameter to `initialLimit` and write `let limit = initialLimit;` after the assertion). In the `finally` of `run`, replace the `const next = waiting.shift(); if (next) { next(); } else if (isIdle()) {...}` block with a call to a shared release step, and add the two methods:

```ts
  /** Starts waiters while there is headroom. One waiter per free slot; each one increments `running` when it resumes. */
  function release(): void {
    while (running < limit && waiting.length > 0) {
      running += 1;
      waiting.shift()?.();
    }
    if (isIdle()) settleIdleWaiters();
  }
```

and change `run` so the waiter does not increment `running` itself when resumed by `release`:

```ts
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (running >= limit) {
        // Resumed by `release`, which has already counted this task.
        await new Promise<void>((resolve) => { waiting.push(resolve); });
      } else {
        running += 1;
      }
      try {
        return await task();
      } finally {
        running -= 1;
        release();
      }
    },
```

then:

```ts
    limit(): number {
      return limit;
    },

    setLimit(next: number): void {
      assertValidLimit(next);
      limit = next;
      release();
    },
```

- [ ] **Step 4: Run the whole file**

Run: `node --import tsx --conditions development --test packages/host/test/util/bounded-queue.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `fail 0`, and the pass count is the old count plus three.

- [ ] **Step 5: Mutation check**

Change `while (running < limit && waiting.length > 0)` to `if (running < limit && waiting.length > 0)` (one release per call). Run the file. Expected: the "raised releases exactly the new headroom" test fails on `started` being 2. Revert.

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/util/bounded-queue.ts packages/host/test/util/bounded-queue.test.ts
git commit -m "BoundedQueue.setLimit: a mutable ceiling that releases headroom when raised and drains when lowered"
```

---

### Task 2: `isHostname` and the `fetch` config schema

**Files:**
- Create: `packages/host/src/fetch/hostname.ts`
- Modify: `packages/host/src/config/schemas.ts`
- Test: `packages/host/test/fetch/hostname.test.ts`, `packages/host/test/config/schemas.test.ts`

**Interfaces:**
- Consumes: the contract constants from Task 3 are NOT used here; the bounds are literals in this file so the schema has no dependency on the contract package. Task 3 re-states them; Task 4's test asserts the two agree.
- Produces: `isHostname(value: string): boolean`; `fetchConfigSchema`, `FetchConfig`, `FetchHostEntry`, `FETCH_DEFAULTS` from `config/schemas.ts`.

- [ ] **Step 1: Write the failing tests**

Create `packages/host/test/fetch/hostname.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHostname } from '../../src/fetch/hostname.ts';

test('accepts bare lowercase hostnames', () => {
  for (const value of ['a.b', 'localhost', 'xn--n3h.example', 'cdn.theporndb.net', '127.0.0.1', 'a-b.c0']) {
    assert.equal(isHostname(value), true, value);
  }
});

test('refuses anything the queue would never key a request on', () => {
  // The queue keys on `new URL(url).hostname`, which is lowercase and
  // carries no port, path, userinfo or whitespace; an entry spelled any
  // of these ways would match no request and silently do nothing.
  for (const value of ['A.b', 'a.b:80', 'a.b/x', 'u@a.b', 'a b', '', 'http://a.b', 'a.b?x=1', 'a.b#f', '[::1]']) {
    assert.equal(isHostname(value), false, JSON.stringify(value));
  }
});
```

Append to `packages/host/test/config/schemas.test.ts` (add `fetchConfigSchema` to the import):

```ts
test('an absent fetch section yields the two constants the queue used to carry', () => {
  assert.deepEqual(fetchConfigSchema.parse(undefined), {
    default: { concurrency: 1, timeoutMs: 30000 },
    hosts: {},
  });
});

test('a fetch host entry may pin one field and inherit the other', () => {
  assert.deepEqual(
    fetchConfigSchema.parse({ hosts: { 'cdn.example': { concurrency: 3 } } }),
    { default: { concurrency: 1, timeoutMs: 30000 }, hosts: { 'cdn.example': { concurrency: 3 } } },
  );
});

test('a fetch host key that is not a bare lowercase hostname is refused naming the key', () => {
  assert.throws(
    () => fetchConfigSchema.parse({ hosts: { 'CDN.example:443': { concurrency: 3 } } }),
    /CDN\.example:443/,
  );
});

test('fetch bounds are enforced and the path names the host and field', () => {
  assert.throws(() => fetchConfigSchema.parse({ hosts: { 'a.b': { concurrency: 0 } } }), /hosts.*a\.b.*concurrency/s);
  assert.throws(() => fetchConfigSchema.parse({ hosts: { 'a.b': { concurrency: 65 } } }), /concurrency/);
  assert.throws(() => fetchConfigSchema.parse({ hosts: { 'a.b': { timeoutMs: 999 } } }), /timeoutMs/);
  assert.throws(() => fetchConfigSchema.parse({ hosts: { 'a.b': { timeoutMs: 3600001 } } }), /timeoutMs/);
  assert.throws(() => fetchConfigSchema.parse({ default: { concurrency: 1.5, timeoutMs: 30000 } }), /concurrency/);
  assert.throws(() => fetchConfigSchema.parse({ hosts: { 'a.b': { retries: 2 } } }), /retries|unrecognized/i);
});
```

- [ ] **Step 2: Run both files to see them fail**

Run: `node --import tsx --conditions development --test packages/host/test/fetch/hostname.test.ts packages/host/test/config/schemas.test.ts 2>&1 | grep -E "^(✖|ℹ (pass|fail))|Cannot find"`
Expected: a module-not-found for `hostname.ts` and a failure that `fetchConfigSchema` is not exported.

- [ ] **Step 3: Implement `isHostname`**

Create `packages/host/src/fetch/hostname.ts`:

```ts
/**
 * Whether `value` is a hostname the fetch queue could ever key a request
 * on. The queue keys on `new URL(url).hostname`, which is lowercase and
 * carries no port, path, userinfo, query or fragment -- so a config entry
 * spelled with any of those would match nothing and do nothing, silently.
 * Checked by parsing rather than by a hand-written grammar: whatever the
 * URL parser calls the hostname of `http://<value>` is the only spelling
 * that can match, and the equality check is what refuses every
 * normalisation (case folding, a dropped default port, a stripped path).
 *
 * An IPv6 literal (`[::1]`) is refused too: the parser keeps the brackets
 * in `hostname`, so an entry would have to carry them, and nothing in this
 * host fetches a bracketed address today. Left out rather than
 * special-cased.
 */
export function isHostname(value: string): boolean {
  if (value.length === 0) return false;
  if (/[\s/:@?#[\]]/.test(value)) return false;
  if (value !== value.toLowerCase()) return false;
  try {
    return new URL(`http://${value}`).hostname === value;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Implement the schema**

In `packages/host/src/config/schemas.ts`, add after `secretsConfigSchema`:

```ts
import { isHostname } from '../fetch/hostname.ts';

/** The two values the fetch queue applied to every hostname before this section existed. */
export const FETCH_DEFAULTS = { concurrency: 1, timeoutMs: 30_000 } as const;

const fetchConcurrency = z.number().int().min(1).max(64);
const fetchTimeoutMs = z.number().int().min(1_000).max(3_600_000);

/**
 * One hostname's entry. Either field may be absent, and an absent field
 * inherits `default`; `fetch/settings.ts` removes an entry that has
 * neither rather than writing `{}`.
 */
export const fetchHostEntrySchema = z.object({
  concurrency: fetchConcurrency.optional(),
  timeoutMs: fetchTimeoutMs.optional(),
}).strict();

/**
 * `fetch`: how many requests may run at once per hostname and how long one
 * may take. Keys of `hosts` are exact hostnames (`isHostname`): the queue
 * keys on `new URL(url).hostname`, so a key with a port or an uppercase
 * letter would match no request, and refusing it at boot names the key
 * instead of letting it do nothing.
 */
export const fetchConfigSchema = z.object({
  default: z.object({
    concurrency: fetchConcurrency.default(FETCH_DEFAULTS.concurrency),
    timeoutMs: fetchTimeoutMs.default(FETCH_DEFAULTS.timeoutMs),
  }).strict().prefault({}),
  hosts: z.record(
    z.string().refine(isHostname, { message: 'fetch.hosts keys must be bare lowercase hostnames' }),
    fetchHostEntrySchema,
  ).default({}),
}).strict().prefault({});

export type FetchConfig = z.infer<typeof fetchConfigSchema>;
export type FetchHostEntry = z.infer<typeof fetchHostEntrySchema>;
```

Put the `import` with the other imports at the top of the file.

- [ ] **Step 5: Run both files**

Run: `node --import tsx --conditions development --test packages/host/test/fetch/hostname.test.ts packages/host/test/config/schemas.test.ts 2>&1 | grep -E "^(✖|ℹ (pass|fail))"`
Expected: `fail 0`. If the key-refusal test's message does not include the key, print the thrown error once and adjust the regex to the path zod 4 reports, keeping `CDN\.example:443` in it.

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/fetch/hostname.ts packages/host/src/config/schemas.ts packages/host/test/fetch/hostname.test.ts packages/host/test/config/schemas.test.ts
git commit -m "fetch config schema: default pair plus per-hostname entries, keys checked as bare hostnames"
```

---

### Task 3: Contract types for the fetch-hosts API

**Files:**
- Create: `packages/contract/src/fetch.ts`
- Modify: `packages/contract/src/index.ts`

**Interfaces:**
- Produces: `FetchPair`, `FetchHostPatch`, `FetchHostRead`, `FetchHostsRead`, `FETCH_REFUSALS`, `FetchRefusalCode`, `FetchRefusalBody`, `FETCH_DEFAULT_HOST`, `FETCH_CONCURRENCY_MIN/MAX`, `FETCH_TIMEOUT_MIN_MS/MAX_MS`. Used by Tasks 4, 6, 8.

- [ ] **Step 1: Create the module**

Create `packages/contract/src/fetch.ts`:

```ts
/**
 * `GET /api/fetch-hosts` and `PUT /api/fetch-hosts/:hostname`: how many
 * requests the host runs at once per hostname and how long one may take.
 * Design spec 2026-10-06 §3.
 */

/** Both values, as the default row holds them. */
export interface FetchPair {
  readonly concurrency: number;
  readonly timeoutMs: number;
}

/**
 * A `PUT` body. A field present replaces that field; absent leaves it;
 * `null` clears it back to inherited. The default row refuses `null`.
 */
export interface FetchHostPatch {
  readonly concurrency?: number | null;
  readonly timeoutMs?: number | null;
}

/** One row of the effective table, as `GET` lists it and `PUT` answers it. */
export interface FetchHostRead {
  readonly hostname: string;
  readonly concurrency: number;
  readonly timeoutMs: number;
  /** Which fields came from the default row rather than an entry or the lookup fallback. */
  readonly inherited: { readonly concurrency: boolean; readonly timeoutMs: boolean };
  /** Whether the config file has an entry for this hostname. */
  readonly configured: boolean;
}

export interface FetchHostsRead {
  readonly default: FetchPair;
  /** Configured hostnames and hostnames seen since boot, merged and sorted by hostname. */
  readonly hosts: readonly FetchHostRead[];
}

/** The reserved path segment that addresses the default pair. Never a hostname. */
export const FETCH_DEFAULT_HOST = 'default';

export const FETCH_CONCURRENCY_MIN = 1;
export const FETCH_CONCURRENCY_MAX = 64;
export const FETCH_TIMEOUT_MIN_MS = 1_000;
export const FETCH_TIMEOUT_MAX_MS = 3_600_000;

export const FETCH_REFUSALS = [
  /** The body is not an object, or a field is neither an integer nor null. */
  'invalid-shape',
  /** The hostname fails `isHostname`, or is the reserved `default` passed as a host. */
  'invalid-hostname',
  /** `concurrency` outside 1..64. */
  'invalid-concurrency',
  /** `timeoutMs` outside 1000..3600000. */
  'invalid-timeout',
  /** `null` or an absent field on the default row. */
  'default-required',
] as const;

export type FetchRefusalCode = (typeof FETCH_REFUSALS)[number];

export interface FetchRefusalBody {
  readonly refusal: FetchRefusalCode;
}
```

- [ ] **Step 2: Export from the index**

In `packages/contract/src/index.ts`, after the `destinations.ts` exports, add:

```ts
export type { FetchHostPatch, FetchHostRead, FetchHostsRead, FetchPair, FetchRefusalBody, FetchRefusalCode } from './fetch.ts';
export {
  FETCH_CONCURRENCY_MAX,
  FETCH_CONCURRENCY_MIN,
  FETCH_DEFAULT_HOST,
  FETCH_REFUSALS,
  FETCH_TIMEOUT_MAX_MS,
  FETCH_TIMEOUT_MIN_MS,
} from './fetch.ts';
```

- [ ] **Step 3: Build and typecheck the contract**

Run: `npm run build -w @pickarr/contract && npm run typecheck -w @pickarr/contract`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add packages/contract/src/fetch.ts packages/contract/src/index.ts
git commit -m "contract: the fetch-hosts API's read, patch and refusal shapes"
```

---

### Task 4: `fetch/settings.ts`

**Files:**
- Create: `packages/host/src/fetch/settings.ts`
- Test: `packages/host/test/fetch/settings.test.ts`

**Interfaces:**
- Consumes: `ConfigHandle<T>` from `config/instance.ts`; `FetchConfig`, `FetchHostEntry` from `config/schemas.ts`; `isHostname`; the contract types from Task 3.
- Produces:

```ts
export interface FetchRefusal { readonly refusal: FetchRefusalCode }
export interface FetchSettings {
  limitFor(hostname: string): number;
  timeoutFor(hostname: string): number;
  read(seen: Iterable<string>): FetchHostsRead;
  saveDefault(patch: FetchHostPatch): Promise<FetchPair | FetchRefusal>;
  saveHost(hostname: string, patch: FetchHostPatch): Promise<FetchHostRead | FetchRefusal>;
}
export function createFetchSettings(deps: {
  handle: ConfigHandle<FetchConfig>;
  lookupHostname: string;
  lookupFallback: FetchPair;
}): FetchSettings;
```

  (The spec's `default()` and `effective(seen)` are folded into `read(seen)`, which is the exact body `GET` answers.)

- [ ] **Step 1: Write the failing tests**

Create `packages/host/test/fetch/settings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FETCH_CONCURRENCY_MAX, FETCH_CONCURRENCY_MIN, FETCH_TIMEOUT_MAX_MS, FETCH_TIMEOUT_MIN_MS } from '@pickarr/contract';
import type { ConfigHandle } from '../../src/config/instance.ts';
import { type FetchConfig, fetchConfigSchema } from '../../src/config/schemas.ts';
import { createFetchSettings } from '../../src/fetch/settings.ts';

const LOOKUP = 'openmetadata.nexus';
const LOOKUP_FALLBACK = { concurrency: 4, timeoutMs: 300_000 } as const;

/** A `ConfigHandle` over memory that records every document written and can be told to fail. */
function memoryHandle(initial: unknown, failWith?: Error): { handle: ConfigHandle<FetchConfig>; written: FetchConfig[] } {
  let current = fetchConfigSchema.parse(initial);
  const written: FetchConfig[] = [];
  const handle: ConfigHandle<FetchConfig> = {
    get current() { return current; },
    async update(next) {
      if (failWith !== undefined) throw failWith;
      written.push(next);
      current = next;
    },
  };
  return { handle, written };
}

function settingsOver(initial: unknown, failWith?: Error) {
  const { handle, written } = memoryHandle(initial, failWith);
  return { settings: createFetchSettings({ handle, lookupHostname: LOOKUP, lookupFallback: LOOKUP_FALLBACK }), written };
}

test('the bounds the schema enforces are the ones the contract publishes', () => {
  assert.doesNotThrow(() => fetchConfigSchema.parse({ default: { concurrency: FETCH_CONCURRENCY_MIN, timeoutMs: FETCH_TIMEOUT_MIN_MS } }));
  assert.doesNotThrow(() => fetchConfigSchema.parse({ default: { concurrency: FETCH_CONCURRENCY_MAX, timeoutMs: FETCH_TIMEOUT_MAX_MS } }));
  assert.throws(() => fetchConfigSchema.parse({ default: { concurrency: FETCH_CONCURRENCY_MAX + 1, timeoutMs: 30000 } }));
  assert.throws(() => fetchConfigSchema.parse({ default: { concurrency: 1, timeoutMs: FETCH_TIMEOUT_MAX_MS + 1 } }));
});

test('resolution per field: the entry, then the lookup fallback for that one hostname, then default', () => {
  const { settings } = settingsOver({
    default: { concurrency: 2, timeoutMs: 20_000 },
    hosts: { 'cdn.example': { concurrency: 5 }, [LOOKUP]: { timeoutMs: 120_000 } },
  });
  assert.equal(settings.limitFor('cdn.example'), 5);
  assert.equal(settings.timeoutFor('cdn.example'), 20_000, 'no timeout in the entry, so default');
  assert.equal(settings.limitFor(LOOKUP), 4, 'no concurrency in the entry, so the lookup fallback, not default');
  assert.equal(settings.timeoutFor(LOOKUP), 120_000, 'the entry wins over the fallback');
  assert.equal(settings.limitFor('unseen.example'), 2);
  assert.equal(settings.timeoutFor('unseen.example'), 20_000);
});

test('read merges configured and seen hostnames, sorted, with inherited and configured flags', () => {
  const { settings } = settingsOver({ hosts: { 'cdn.example': { concurrency: 5 } } });
  assert.deepEqual(settings.read(['tracker.example', 'cdn.example', LOOKUP]), {
    default: { concurrency: 1, timeoutMs: 30000 },
    hosts: [
      { hostname: 'cdn.example', concurrency: 5, timeoutMs: 30000, inherited: { concurrency: false, timeoutMs: true }, configured: true },
      { hostname: LOOKUP, concurrency: 4, timeoutMs: 300000, inherited: { concurrency: false, timeoutMs: false }, configured: false },
      { hostname: 'tracker.example', concurrency: 1, timeoutMs: 30000, inherited: { concurrency: true, timeoutMs: true }, configured: false },
    ],
  });
});

test('saveHost pins one field, leaves the other, writes the document, and the live values follow', async () => {
  const { settings, written } = settingsOver({ hosts: { 'cdn.example': { timeoutMs: 60_000 } } });

  const row = await settings.saveHost('cdn.example', { concurrency: 3 });

  assert.deepEqual(row, { hostname: 'cdn.example', concurrency: 3, timeoutMs: 60000, inherited: { concurrency: false, timeoutMs: false }, configured: true });
  assert.deepEqual(written, [{ default: { concurrency: 1, timeoutMs: 30000 }, hosts: { 'cdn.example': { concurrency: 3, timeoutMs: 60000 } } }]);
  assert.equal(settings.limitFor('cdn.example'), 3);
  assert.doesNotThrow(() => fetchConfigSchema.parse(written[0]), 'what was written round-trips through the schema');
});

test('null clears a field to inherited, and clearing both removes the key from the file', async () => {
  const { settings, written } = settingsOver({ hosts: { 'cdn.example': { concurrency: 3, timeoutMs: 60_000 } } });

  const partial = await settings.saveHost('cdn.example', { timeoutMs: null });
  assert.deepEqual(partial, { hostname: 'cdn.example', concurrency: 3, timeoutMs: 30000, inherited: { concurrency: false, timeoutMs: true }, configured: true });

  const cleared = await settings.saveHost('cdn.example', { concurrency: null });
  assert.deepEqual(cleared, { hostname: 'cdn.example', concurrency: 1, timeoutMs: 30000, inherited: { concurrency: true, timeoutMs: true }, configured: false });
  assert.deepEqual(written[1], { default: { concurrency: 1, timeoutMs: 30000 }, hosts: {} }, 'no `{}` entry left behind');
});

test('an empty patch on an unconfigured host writes nothing and answers the effective row', async () => {
  const { settings, written } = settingsOver({});
  const row = await settings.saveHost('cdn.example', {});
  assert.equal(row.hasOwnProperty('refusal'), false);
  assert.deepEqual(written, [], 'nothing to write');
});

test('saveHost refusals, each by name, and none of them writes', async () => {
  const { settings, written } = settingsOver({});
  assert.deepEqual(await settings.saveHost('CDN.example', { concurrency: 2 }), { refusal: 'invalid-hostname' });
  assert.deepEqual(await settings.saveHost('default', { concurrency: 2 }), { refusal: 'invalid-hostname' });
  assert.deepEqual(await settings.saveHost('cdn.example', { concurrency: 0 }), { refusal: 'invalid-concurrency' });
  assert.deepEqual(await settings.saveHost('cdn.example', { concurrency: 65 }), { refusal: 'invalid-concurrency' });
  assert.deepEqual(await settings.saveHost('cdn.example', { concurrency: 2.5 }), { refusal: 'invalid-concurrency' });
  assert.deepEqual(await settings.saveHost('cdn.example', { timeoutMs: 999 }), { refusal: 'invalid-timeout' });
  assert.deepEqual(await settings.saveHost('cdn.example', { timeoutMs: 3_600_001 }), { refusal: 'invalid-timeout' });
  assert.deepEqual(written, []);
});

test('saveDefault requires both fields non-null and answers the pair', async () => {
  const { settings, written } = settingsOver({});
  assert.deepEqual(await settings.saveDefault({ concurrency: 2 }), { refusal: 'default-required' });
  assert.deepEqual(await settings.saveDefault({ concurrency: 2, timeoutMs: null }), { refusal: 'default-required' });
  assert.deepEqual(await settings.saveDefault({ concurrency: 0, timeoutMs: 20_000 }), { refusal: 'invalid-concurrency' });
  assert.deepEqual(await settings.saveDefault({ concurrency: 2, timeoutMs: 20_000 }), { concurrency: 2, timeoutMs: 20000 });
  assert.deepEqual(written, [{ default: { concurrency: 2, timeoutMs: 20000 }, hosts: {} }]);
  assert.equal(settings.limitFor('anything.example'), 2);
});

test('a rejected config write propagates and leaves the live values unchanged', async () => {
  const { settings } = settingsOver({ hosts: { 'cdn.example': { concurrency: 3 } } }, new Error('disk full'));
  await assert.rejects(settings.saveHost('cdn.example', { concurrency: 7 }), /disk full/);
  assert.equal(settings.limitFor('cdn.example'), 3, 'the swap happens after the write, not before');
  await assert.rejects(settings.saveDefault({ concurrency: 9, timeoutMs: 9_000 }), /disk full/);
  assert.equal(settings.limitFor('other.example'), 1);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --import tsx --conditions development --test packages/host/test/fetch/settings.test.ts 2>&1 | grep -E "Cannot find|^ℹ fail"`
Expected: module not found for `settings.ts`.

- [ ] **Step 3: Implement**

Create `packages/host/src/fetch/settings.ts`:

```ts
/**
 * The live view of the config file's `fetch` section, and the only thing
 * that writes it.
 *
 * `createHostFetch` (`./queue.ts`) asks `limitFor` and `timeoutFor` on
 * every request, so a save here is in force for the next request without a
 * restart. The in-memory view is replaced only after `handle.update`
 * resolves: a write that fails leaves the queue answering what is on disk,
 * which is also what the next boot will read.
 *
 * Resolution is per field: an entry's own value, then -- for the lookup
 * service's hostname alone -- the fallback `main.ts` always gave it, then
 * `default`. The fallback lives here rather than in the file so an install
 * that never touched the section has an empty section.
 */
import type { FetchHostPatch, FetchHostRead, FetchHostsRead, FetchPair, FetchRefusalCode } from '@pickarr/contract';
import {
  FETCH_CONCURRENCY_MAX,
  FETCH_CONCURRENCY_MIN,
  FETCH_DEFAULT_HOST,
  FETCH_TIMEOUT_MAX_MS,
  FETCH_TIMEOUT_MIN_MS,
} from '@pickarr/contract';
import type { ConfigHandle } from '../config/instance.ts';
import type { FetchConfig, FetchHostEntry } from '../config/schemas.ts';
import { isHostname } from './hostname.ts';

export interface FetchRefusal {
  readonly refusal: FetchRefusalCode;
}

export interface FetchSettings {
  limitFor(hostname: string): number;
  timeoutFor(hostname: string): number;
  /** The effective table: every configured hostname plus every one in `seen`, sorted. */
  read(seen: Iterable<string>): FetchHostsRead;
  saveDefault(patch: FetchHostPatch): Promise<FetchPair | FetchRefusal>;
  saveHost(hostname: string, patch: FetchHostPatch): Promise<FetchHostRead | FetchRefusal>;
}

function refuse(refusal: FetchRefusalCode): FetchRefusal {
  return { refusal };
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** `undefined` and `null` pass (absent and clear); a number must be an integer in range. */
function checkConcurrency(value: number | null | undefined): FetchRefusal | undefined {
  if (value === undefined || value === null) return undefined;
  return inRange(value, FETCH_CONCURRENCY_MIN, FETCH_CONCURRENCY_MAX) ? undefined : refuse('invalid-concurrency');
}

function checkTimeout(value: number | null | undefined): FetchRefusal | undefined {
  if (value === undefined || value === null) return undefined;
  return inRange(value, FETCH_TIMEOUT_MIN_MS, FETCH_TIMEOUT_MAX_MS) ? undefined : refuse('invalid-timeout');
}

/** The entry after `patch`: present replaces, absent keeps, `null` drops. Built by spread so no field is ever `undefined`. */
function patched(previous: FetchHostEntry, patch: FetchHostPatch): FetchHostEntry {
  const concurrency = patch.concurrency === undefined ? previous.concurrency : patch.concurrency ?? undefined;
  const timeoutMs = patch.timeoutMs === undefined ? previous.timeoutMs : patch.timeoutMs ?? undefined;
  return {
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

export function createFetchSettings(deps: {
  handle: ConfigHandle<FetchConfig>;
  lookupHostname: string;
  lookupFallback: FetchPair;
}): FetchSettings {
  let config: FetchConfig = deps.handle.current;

  function resolve(hostname: string): FetchHostRead {
    const entry = config.hosts[hostname];
    const fallback = hostname === deps.lookupHostname ? deps.lookupFallback : undefined;
    return {
      hostname,
      concurrency: entry?.concurrency ?? fallback?.concurrency ?? config.default.concurrency,
      timeoutMs: entry?.timeoutMs ?? fallback?.timeoutMs ?? config.default.timeoutMs,
      inherited: {
        concurrency: entry?.concurrency === undefined && fallback === undefined,
        timeoutMs: entry?.timeoutMs === undefined && fallback === undefined,
      },
      configured: entry !== undefined,
    };
  }

  async function write(next: FetchConfig): Promise<void> {
    await deps.handle.update(next);
    config = next;
  }

  return {
    limitFor: (hostname) => resolve(hostname).concurrency,
    timeoutFor: (hostname) => resolve(hostname).timeoutMs,

    read(seen) {
      const names = new Set<string>([...Object.keys(config.hosts), ...seen]);
      return {
        default: config.default,
        hosts: [...names].toSorted().map(resolve),
      };
    },

    async saveDefault(patch) {
      if (patch.concurrency === undefined || patch.concurrency === null
        || patch.timeoutMs === undefined || patch.timeoutMs === null) {
        return refuse('default-required');
      }
      const refused = checkConcurrency(patch.concurrency) ?? checkTimeout(patch.timeoutMs);
      if (refused !== undefined) return refused;
      const next: FetchConfig = {
        default: { concurrency: patch.concurrency, timeoutMs: patch.timeoutMs },
        hosts: config.hosts,
      };
      await write(next);
      return next.default;
    },

    async saveHost(hostname, patch) {
      if (hostname === FETCH_DEFAULT_HOST || !isHostname(hostname)) return refuse('invalid-hostname');
      const refused = checkConcurrency(patch.concurrency) ?? checkTimeout(patch.timeoutMs);
      if (refused !== undefined) return refused;

      const previous = config.hosts[hostname];
      const entry = patched(previous ?? {}, patch);
      const hosts: Record<string, FetchHostEntry> = { ...config.hosts };
      if (Object.keys(entry).length === 0) delete hosts[hostname];
      else hosts[hostname] = entry;

      // An unconfigured host patched with nothing is the one case with
      // nothing to write; answering the row is still right.
      const unchanged = previous === undefined && Object.keys(entry).length === 0;
      if (!unchanged) await write({ default: config.default, hosts });
      return resolve(hostname);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --conditions development --test packages/host/test/fetch/settings.test.ts 2>&1 | grep -E "^(✖|ℹ (pass|fail))"`
Expected: `fail 0`, 10 pass. If `hasOwnProperty` trips lint, use `assert.equal('refusal' in row, false)`.

- [ ] **Step 5: Mutation checks**

Swap the two lines in `write` so `config = next` runs before `await deps.handle.update(next)`. Expected: the rejected-write test fails. Revert. Then change `if (Object.keys(entry).length === 0) delete hosts[hostname]; else` to always assign. Expected: the both-cleared test fails on `configured: true` and on `{}` in the written document. Revert.

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/fetch/settings.ts packages/host/test/fetch/settings.test.ts
git commit -m "fetch/settings: the live view of the fetch config section, written only through it"
```

---

### Task 5: `createHostFetch` consults resolvers and reports seen hostnames

**Files:**
- Modify: `packages/host/src/fetch/queue.ts`
- Test: `packages/host/test/fetch/queue.test.ts`

**Interfaces:**
- Consumes: `BoundedQueue.setLimit`/`limit()` from Task 1.
- Produces: `createHostFetch({ fetch, limitFor, timeoutFor, onChange? })`; `QueuedFetch.seen(): readonly string[]`. The `FetchLimits`/`FetchTimeouts` interfaces and the four `assertValid*` functions are deleted.

- [ ] **Step 1: Add a static-policy helper to the test file and convert existing constructions**

At the top of `packages/host/test/fetch/queue.test.ts`, after `tick()`:

```ts
/**
 * The two resolver functions `createHostFetch` now takes, built from the
 * static shape the tests used to pass. Static here on purpose: these tests
 * are about the queue, and `settings.test.ts` is about where numbers come
 * from.
 */
function policy(opts: {
  limits?: { default: number; perHost?: Record<string, number> };
  timeouts?: { default: number; perHost?: Record<string, number> };
}): { limitFor: (hostname: string) => number; timeoutFor: (hostname: string) => number } {
  return {
    limitFor: (hostname) => opts.limits?.perHost?.[hostname] ?? opts.limits?.default ?? 1,
    timeoutFor: (hostname) => opts.timeouts?.perHost?.[hostname] ?? opts.timeouts?.default ?? 30_000,
  };
}
```

Then rewrite every `createHostFetch({ fetch: X, limits: L, timeouts: T })` call as `createHostFetch({ fetch: X, ...policy({ limits: L, timeouts: T }) })`, and every `createHostFetch({ fetch: X })` as `createHostFetch({ fetch: X, ...policy({}) })`. Delete the tests that asserted construction-time validation (the ones at the current lines 236–246 and 475–515 that assert `createHostFetch` throws for a 0, negative, fractional or NaN limit or timeout): the schema owns that rule now (Task 2).

- [ ] **Step 2: Write the failing tests**

Append:

```ts
test('timeoutFor is read when a request starts, so a change made while it waits applies to it', async () => {
  // `AbortSignal.timeout` is real here; the numbers are small.
  let timeoutMs = 10_000;
  const track = trackingFetch();
  const hostFetch = createHostFetch({
    fetch: track.fetchFn,
    limitFor: () => 1,
    timeoutFor: () => timeoutMs,
  });
  const first = hostFetch.json<Echo>('https://a.example/1');
  const second = hostFetch.json<Echo>('https://a.example/2');
  await tick();
  timeoutMs = 20; // tightened while `second` waits for the one slot
  track.releaseNext();
  await first;
  await assert.rejects(second, /timed out after 20ms/, 'the second read the new ceiling when it started');
});

test('limitFor is re-read on every enqueue and applied to the hostname\'s queue', async () => {
  let limit = 1;
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn, limitFor: () => limit, timeoutFor: () => 30_000 });
  const a = hostFetch.json<Echo>('https://a.example/1');
  const b = hostFetch.json<Echo>('https://a.example/2');
  await tick();
  assert.equal(track.activeNow(), 1);

  limit = 3;
  const c = hostFetch.json<Echo>('https://a.example/3');
  await tick();
  assert.equal(track.activeNow(), 3, 'the third enqueue raised the limit and released the waiter too');
  assert.equal(hostFetch.snapshot()[0]?.limit, 3);

  track.releaseNext(); track.releaseNext(); track.releaseNext();
  await Promise.all([a, b, c]);
});

test('seen lists every hostname that has had a request, in first-seen order', async () => {
  const track = trackingFetch();
  const hostFetch = createHostFetch({ fetch: track.fetchFn, limitFor: () => 2, timeoutFor: () => 30_000 });
  assert.deepEqual(hostFetch.seen(), []);
  const a = hostFetch.json<Echo>('https://b.example/1');
  const b = hostFetch.json<Echo>('https://a.example/1');
  await tick();
  assert.deepEqual(hostFetch.seen(), ['b.example', 'a.example']);
  track.releaseNext(); track.releaseNext();
  await Promise.all([a, b]);
  assert.deepEqual(hostFetch.seen(), ['b.example', 'a.example'], 'completion removes nothing');
});
```

- [ ] **Step 3: Run the file to see the three new tests fail and the converted ones fail on the type**

Run: `node --import tsx --conditions development --test packages/host/test/fetch/queue.test.ts 2>&1 | grep -E "^(✖|ℹ (pass|fail))"`
Expected: the three new tests fail (`seen is not a function`, limits unchanged); the converted tests may still pass since the old `deps` ignores unknown keys.

- [ ] **Step 4: Implement**

In `packages/host/src/fetch/queue.ts`:

1. Delete `FetchLimits`, `FetchTimeouts`, `assertValidLimit`, `assertValidLimits`, `assertValidTimeout`, `assertValidTimeouts`, and the `DEFAULT_TIMEOUT_MS` constant if nothing else uses it. Remove the `isValidLimit` import.
2. Add to `QueuedFetch`:

```ts
  /** Every hostname a request has been made to since construction, in first-seen order. */
  seen(): readonly string[];
```

3. Change the signature and the top of the factory:

```ts
export function createHostFetch(
  deps: {
    fetch: typeof globalThis.fetch;
    /** How many requests to `hostname` may run at once. Asked on every enqueue; see `fetch/settings.ts`. */
    limitFor: (hostname: string) => number;
    /** How long one request to `hostname` may take. Asked when the request starts, not when it is enqueued. */
    timeoutFor: (hostname: string) => number;
    /** Called when a request is enqueued, starts or settles; `main.ts` wires the event hub. */
    onChange?: () => void;
  },
): QueuedFetch {
  const timeoutFor = deps.timeoutFor;
```

4. In `HostState`, remove the `limit` field. In `hostFor`, build with `createBoundedQueue(deps.limitFor(hostname))`. In `enqueue`:

```ts
  function enqueue<T>(hostname: string, task: () => Promise<T>): Promise<T> {
    const state = hostFor(hostname);
    // Re-read on every request so a saved change is in force for this
    // request's slot decision. `setLimit` with the same value is a no-op.
    state.queue.setLimit(deps.limitFor(hostname));
    return state.queue.run(task);
  }
```

5. In `fetched`, move `const timeoutMs = timeoutFor(hostname);` from before `enqueue` to the first line inside the queued task (before `state.waiting.delete(record)`), and update the docblock sentence that says the timeout is armed inside the task to add: "and its number is read there too, so a ceiling saved while a request waited is the one it runs under."
6. In `snapshot`, `limit: state.queue.limit()`.
7. Add before `snapshot`:

```ts
    seen(): readonly string[] {
      return [...hosts.keys()];
    },
```

Update the module docblock paragraph that describes `limits`/`timeouts` to describe the two resolvers and name `fetch/settings.ts` as where they come from.

- [ ] **Step 5: Run the file**

Run: `node --import tsx --conditions development --test packages/host/test/fetch/queue.test.ts 2>&1 | grep -E "^(✖|ℹ (pass|fail))"`
Expected: `fail 0`.

- [ ] **Step 6: Mutation check**

Move `const timeoutMs = timeoutFor(hostname);` back outside the task. Expected: the "read when a request starts" test fails (no timeout at 20 ms). Revert.

- [ ] **Step 7: Typecheck the host (main.ts and the harness still pass the old shape; that is Task 7)**

Run: `npm run typecheck -w @pickarr/host 2>&1 | grep -c "error TS"`
Expected: errors only in `src/main.ts` on `limits`/`timeouts`. Note the count; Task 7 clears them. Do not fix them here.

- [ ] **Step 8: Commit**

```bash
git add packages/host/src/fetch/queue.ts packages/host/test/fetch/queue.test.ts
git commit -m "createHostFetch asks limitFor and timeoutFor per request and reports seen hostnames"
```

---

### Task 6: The `/api/fetch-hosts` routes

**Files:**
- Modify: `packages/host/src/api/server.ts`, `packages/host/src/api/path-params.ts`, `packages/host/src/api/request-shapes.ts`, `packages/host/src/api/refusal-status.ts`
- Test: `packages/host/test/api/server.test.ts`, `packages/host/test/api/path-params.test.ts` (if present; otherwise put the `hostnameFrom` cases in `server.test.ts`)

**Interfaces:**
- Consumes: `FetchSettings` from Task 4; contract types from Task 3.
- Produces: `ReadServerDeps.fetchSettings: FetchSettings` and `ReadServerDeps.fetchSeen: () => readonly string[]`; `hostnameFrom(pathname): string | undefined`; `fetchHostPatchFrom(value): FetchHostPatch | undefined`; `statusForFetchRefusal(code): number`.

- [ ] **Step 1: Supply the two new deps in the test harness**

In `packages/host/test/api/server.test.ts`, import `createFetchSettings` from `../../src/fetch/settings.ts`, `fetchConfigSchema` and `FetchConfig` from `../../src/config/schemas.ts`, `ConfigHandle` from `../../src/config/instance.ts`, and add near `setup()`:

```ts
/** A `FetchSettings` over memory, so a route test needs no config file. */
function memoryFetchSettings(initial: unknown = {}) {
  let current: FetchConfig = fetchConfigSchema.parse(initial);
  const written: FetchConfig[] = [];
  const handle: ConfigHandle<FetchConfig> = {
    get current() { return current; },
    async update(next) { written.push(next); current = next; },
  };
  return {
    settings: createFetchSettings({ handle, lookupHostname: 'openmetadata.nexus', lookupFallback: { concurrency: 4, timeoutMs: 300_000 } }),
    written,
  };
}
```

In `start()`'s `createReadServer({...})` literal add `fetchSettings: memoryFetchSettings().settings, fetchSeen: () => [],` before `...overrides` (check that `overrides` is spread last; if it is applied another way, follow that).

- [ ] **Step 2: Write the failing route tests**

Append to `server.test.ts`:

```ts
test('GET /api/fetch-hosts answers the effective table, merging configured and seen hostnames', async () => {
  const { raw, db } = setup();
  const { settings } = memoryFetchSettings({ hosts: { 'cdn.example': { concurrency: 5 } } });
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, {
    fetchSettings: settings,
    fetchSeen: () => ['tracker.example', 'cdn.example'],
  });
  try {
    const response = await get(server, '/api/fetch-hosts', cookie);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      default: { concurrency: 1, timeoutMs: 30000 },
      hosts: [
        { hostname: 'cdn.example', concurrency: 5, timeoutMs: 30000, inherited: { concurrency: false, timeoutMs: true }, configured: true },
        { hostname: 'tracker.example', concurrency: 1, timeoutMs: 30000, inherited: { concurrency: true, timeoutMs: true }, configured: false },
      ],
    });
    assert.equal((await get(server, '/api/fetch-hosts', ANONYMOUS)).status, 401);
  } finally {
    await server.close();
  }
});

test('PUT /api/fetch-hosts/:hostname patches one field, keeps the other, and answers the row', async () => {
  const { raw, db } = setup();
  const { settings, written } = memoryFetchSettings({ hosts: { 'cdn.example': { timeoutMs: 60_000 } } });
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, { fetchSettings: settings });
  try {
    const answer = await send(server, 'PUT', '/api/fetch-hosts/cdn.example', cookie, { concurrency: 3 });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.text), {
      hostname: 'cdn.example', concurrency: 3, timeoutMs: 60000, inherited: { concurrency: false, timeoutMs: false }, configured: true,
    });
    assert.deepEqual(written, [{ default: { concurrency: 1, timeoutMs: 30000 }, hosts: { 'cdn.example': { concurrency: 3, timeoutMs: 60000 } } }]);

    const cleared = await send(server, 'PUT', '/api/fetch-hosts/cdn.example', cookie, { concurrency: null, timeoutMs: null });
    assert.equal(cleared.status, 200);
    assert.equal((JSON.parse(cleared.text) as { configured: boolean }).configured, false);
  } finally {
    await server.close();
  }
});

test('PUT /api/fetch-hosts/default writes the pair and refuses null', async () => {
  const { raw, db } = setup();
  const { settings } = memoryFetchSettings();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, { fetchSettings: settings });
  try {
    const ok = await send(server, 'PUT', '/api/fetch-hosts/default', cookie, { concurrency: 2, timeoutMs: 20000 });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { concurrency: 2, timeoutMs: 20000 });
    assert.equal(settings.limitFor('anything.example'), 2, 'the live value follows');

    const refused = await send(server, 'PUT', '/api/fetch-hosts/default', cookie, { concurrency: 2, timeoutMs: null });
    assert.equal(refused.status, 400);
    assert.deepEqual(JSON.parse(refused.text), { refusal: 'default-required' });
  } finally {
    await server.close();
  }
});

test('PUT /api/fetch-hosts refusals and statuses', async () => {
  const { raw, db } = setup();
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly);
  try {
    for (const [segment, status] of [['CDN.example', 404], ['a.b:80', 404], ['a%20b', 404]] as const) {
      const answer = await send(server, 'PUT', `/api/fetch-hosts/${segment}`, cookie, { concurrency: 2 });
      assert.equal(answer.status, status, segment);
    }
    const shape = await send(server, 'PUT', '/api/fetch-hosts/cdn.example', cookie, { concurrency: 'two' });
    assert.equal(shape.status, 400);
    assert.deepEqual(JSON.parse(shape.text), { refusal: 'invalid-shape' });
    const notObject = await send(server, 'PUT', '/api/fetch-hosts/cdn.example', cookie, 7);
    assert.deepEqual(JSON.parse(notObject.text), { refusal: 'invalid-shape' });
    const range = await send(server, 'PUT', '/api/fetch-hosts/cdn.example', cookie, { concurrency: 65 });
    assert.equal(range.status, 400);
    assert.deepEqual(JSON.parse(range.text), { refusal: 'invalid-concurrency' });
    const timeout = await send(server, 'PUT', '/api/fetch-hosts/cdn.example', cookie, { timeoutMs: 1 });
    assert.deepEqual(JSON.parse(timeout.text), { refusal: 'invalid-timeout' });
    assert.equal((await send(server, 'PUT', '/api/fetch-hosts/cdn.example', ANONYMOUS, { concurrency: 2 })).status, 401);
    assert.equal((await send(server, 'POST', '/api/fetch-hosts/cdn.example', cookie, { concurrency: 2 })).status, 405);
  } finally {
    await server.close();
  }
});

test('a config write that throws is a 500 and the live values are untouched', async () => {
  const { raw, db } = setup();
  const handle: ConfigHandle<FetchConfig> = {
    current: fetchConfigSchema.parse({ hosts: { 'cdn.example': { concurrency: 3 } } }),
    update: async () => { throw new Error('disk full'); },
  };
  const settings = createFetchSettings({ handle, lookupHostname: 'openmetadata.nexus', lookupFallback: { concurrency: 4, timeoutMs: 300_000 } });
  const { server, cookie } = await startSignedIn(raw, db, moviesOnly, { fetchSettings: settings });
  try {
    const answer = await send(server, 'PUT', '/api/fetch-hosts/cdn.example', cookie, { concurrency: 7 });
    assert.equal(answer.status, 500);
    assert.equal(settings.limitFor('cdn.example'), 3);
  } finally {
    await server.close();
  }
});
```

Check how the existing tests assert a 500 (search `500` in the file) and match that shape if the body is asserted too.

- [ ] **Step 3: Run the new tests to see them fail**

Run: `node --import tsx --conditions development --test packages/host/test/api/server.test.ts 2>&1 | grep -E "^✖.*fetch-hosts|^ℹ (pass|fail)"`
Expected: the five new tests fail (404 unknown route).

- [ ] **Step 4: Add `hostnameFrom`**

In `packages/host/src/api/path-params.ts`, add (importing `isHostname` from `../fetch/hostname.ts` and `FETCH_DEFAULT_HOST` from `@pickarr/contract`):

```ts
/**
 * The fourth segment of `/api/fetch-hosts/:hostname`: either the reserved
 * `default` or a bare hostname (`isHostname`). Anything else is
 * `undefined`, which the route turns into `UNKNOWN_ROUTE` on the same
 * reasoning `pluginIdFrom` gives -- a segment that could not be a hostname
 * is not a host that could exist. The segment is not percent-decoded: a
 * hostname has no character that needs encoding, so an encoded one is
 * refused by the class check rather than decoded into something else.
 */
export function hostnameFrom(pathname: string): string | undefined {
  const segments = pathname.split('/');
  if (segments.length !== 4) return undefined;
  const raw = segments[3];
  if (raw === undefined) return undefined;
  if (raw === FETCH_DEFAULT_HOST || isHostname(raw)) return raw;
  return undefined;
}
```

- [ ] **Step 5: Add `fetchHostPatchFrom`**

In `packages/host/src/api/request-shapes.ts`:

```ts
import type { FetchHostPatch } from '@pickarr/contract';

/** A number or `null` for a patch field; anything else is the wrong shape. Range is `fetch/settings.ts`'s rule. */
function isPatchField(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

/**
 * The body of `PUT /api/fetch-hosts/:hostname`. Each of the two fields may
 * be absent, `null`, or a number; an absent field is left out of the
 * result rather than set to `undefined`, which is what lets the settings
 * object tell "leave it" from "clear it".
 */
export function fetchHostPatchFrom(value: unknown): FetchHostPatch | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const concurrency = 'concurrency' in value ? value.concurrency : undefined;
  const timeoutMs = 'timeoutMs' in value ? value.timeoutMs : undefined;
  if (concurrency !== undefined && !isPatchField(concurrency)) return undefined;
  if (timeoutMs !== undefined && !isPatchField(timeoutMs)) return undefined;
  return {
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}
```

- [ ] **Step 6: Add the status map**

In `packages/host/src/api/refusal-status.ts`:

```ts
import type { FetchRefusalCode } from '@pickarr/contract';

/** `invalid-hostname` is the 404 a hostname that cannot exist gets; the rest are the caller's values. */
export function statusForFetchRefusal(refusal: FetchRefusalCode): number {
  switch (refusal) {
    case 'invalid-hostname':
      return 404;
    case 'invalid-shape':
    case 'invalid-concurrency':
    case 'invalid-timeout':
    case 'default-required':
      return 400;
  }
}
```

- [ ] **Step 7: Add the deps and routes**

In `packages/host/src/api/server.ts`, import `FetchSettings` (type) from `../fetch/settings.ts`, `FETCH_DEFAULT_HOST` from `@pickarr/contract`, `hostnameFrom` from `./path-params.ts`, `fetchHostPatchFrom` from `./request-shapes.ts`, `statusForFetchRefusal` from `./refusal-status.ts`. In `ReadServerDeps`, after `fetchSnapshot`:

```ts
  /** The live fetch settings `GET`/`PUT /api/fetch-hosts` read and write; `fetch/settings.ts`. */
  fetchSettings: FetchSettings;
  /** The fetch layer's `seen`, merged into the `GET` so a hostname with traffic is editable before it is configured. */
  fetchSeen: () => readonly string[];
```

In `ROUTES`, after the `/api/activity` entry:

```ts
  {
    path: '/api/fetch-hosts',
    methods: ['GET'],
    open: false,
    answer: ({ deps }) => json(200, deps.fetchSettings.read(deps.fetchSeen())),
  },
  {
    path: '/api/fetch-hosts/:hostname',
    // A `PUT` for the reason `/api/destinations/:pluginId` gives: a host
    // either has an entry or it does not, and the request names it in full.
    methods: ['PUT'],
    open: false,
    answer: async ({ deps, pathname, body }) => {
      const hostname = hostnameFrom(pathname);
      if (hostname === undefined) return UNKNOWN_ROUTE;
      const patch = fetchHostPatchFrom(body);
      if (patch === undefined) return json(400, { refusal: 'invalid-shape' });
      const result = hostname === FETCH_DEFAULT_HOST
        ? await deps.fetchSettings.saveDefault(patch)
        : await deps.fetchSettings.saveHost(hostname, patch);
      if ('refusal' in result) return json(statusForFetchRefusal(result.refusal), { refusal: result.refusal });
      return json(200, result);
    },
  },
```

If the file's route-count or open-route-count tests change, update their literal counts.

- [ ] **Step 8: Run the server tests**

Run: `node --import tsx --conditions development --test packages/host/test/api/server.test.ts 2>&1 | grep -E "^(✖|ℹ (pass|fail))"`
Expected: `fail 0`.

- [ ] **Step 9: Commit**

```bash
git add packages/host/src/api packages/host/test/api
git commit -m "GET and PUT /api/fetch-hosts: read the effective table, patch one host or the default pair"
```

---

### Task 7: Wire the host and the e2e harness

**Files:**
- Modify: `packages/host/src/main.ts`, `packages/e2e/src/harness-2.ts`
- Test: `packages/host/test/main.test.ts` (one assertion), the existing e2e suite as the check

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 6.
- Produces: `HostSettings.fetch: ConfigHandle<FetchConfig>`; a booted host and a booted harness whose fetch queue reads the settings object; the harness fixture gains `configPath: string`.

- [ ] **Step 1: `main.ts`**

In `resolveSettings`, add `const fetchHandle = config.register('fetch', fetchConfigSchema);` beside the other three and `fetch: fetchHandle,` to the returned object; add `fetch: ConfigHandle<FetchConfig>;` to `HostSettings` with the doc `/** The config file's \`fetch\` section, which \`fetch/settings.ts\` reads and writes. */`. Import `fetchConfigSchema`, `FetchConfig`, `ConfigHandle` as needed.

Delete `DEFAULT_HOST_CONCURRENCY` and `DEFAULT_FETCH_TIMEOUT_MS` and their docblock. Keep `LOOKUP_CONCURRENCY` and `LOOKUP_TIMEOUT_MS` exported; amend their docblocks' last sentence to say they are now the lookup hostname's fallback in `fetch/settings.ts` rather than entries in a map.

Replace the `createHostFetch({...})` call in `main`:

```ts
  const fetchSettings = createFetchSettings({
    handle: settings.fetch,
    lookupHostname,
    lookupFallback: { concurrency: LOOKUP_CONCURRENCY, timeoutMs: LOOKUP_TIMEOUT_MS },
  });
  const fetch = createHostFetch({
    fetch: globalThis.fetch,
    limitFor: (hostname) => fetchSettings.limitFor(hostname),
    timeoutFor: (hostname) => fetchSettings.timeoutFor(hostname),
    onChange: () => { events.notifyActivity(); },
  });
```

and in the API deps literal add `fetchSettings, fetchSeen: () => fetch.seen(),` beside `fetchSnapshot`. Import `createFetchSettings` from `./fetch/settings.ts`.

- [ ] **Step 2: A main test**

In `packages/host/test/main.test.ts`, find the test that exercises `resolveSettings` against a written config file (search `resolveSettings(`). Add one assertion in the test that uses an empty or default file:

```ts
  assert.deepEqual(settings.fetch.current, { default: { concurrency: 1, timeoutMs: 30000 }, hosts: {} });
```

If no such test exists, add:

```ts
test('resolveSettings registers the fetch section with its defaults', async () => {
  await withConfigFile({}, async (path) => {
    const settings = await resolveSettings({ PICKARR_CONFIG: path });
    assert.deepEqual(settings.fetch.current, { default: { concurrency: 1, timeoutMs: 30000 }, hosts: {} });
  });
});
```

using whatever helper the file already has for writing a temporary config file (search `mkdtemp` in it and reuse its pattern).

- [ ] **Step 3: The harness**

In `packages/e2e/src/harness-2.ts`'s `boot()`, after the database is opened:

```ts
  const configPath = join(dir, 'pickarr.config.json');
  const config = await openConfig({ path: configPath });
  const fetchSettings = createFetchSettings({
    handle: config.register('fetch', fetchConfigSchema),
    lookupHostname: 'openmetadata.nexus',
    lookupFallback: { concurrency: 4, timeoutMs: 300_000 },
  });
  const hostFetch = createHostFetch({
    fetch: globalThis.fetch,
    limitFor: (hostname) => fetchSettings.limitFor(hostname),
    timeoutFor: (hostname) => fetchSettings.timeoutFor(hostname),
    onChange: () => { events.notifyActivity(); },
  });
```

replacing the existing `createHostFetch` line (move it below `events` if `events` is built later; keep one call). Add `fetchSettings, fetchSeen: () => hostFetch.seen(),` to the `createReadServer` deps. Export `configPath` on the fixture object alongside `origin` (find the `Booted` interface or the object the fixture returns and add `configPath: string`). `openConfig`, `createFetchSettings`, `fetchConfigSchema` come from `@pickarr/host` only if exported there; check `packages/host/src/index.ts` and add exports for the three if missing, with a one-line doc each saying the e2e harness is the consumer.

- [ ] **Step 4: Typecheck and run the host tests**

Run: `npm run typecheck && npm run test:server 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: typecheck clean, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/main.ts packages/host/src/index.ts packages/host/test/main.test.ts packages/e2e/src/harness-2.ts
git commit -m "Boot reads the fetch config section through FetchSettings; the queue and the API share it"
```

---

### Task 8: The web `Fetching` section

**Files:**
- Create: `packages/web/src/settings/putFetchHost.ts`, `packages/web/src/settings/useFetchHosts.ts`, `packages/web/src/settings/Fetching.tsx`
- Modify: `packages/web/src/settings/Settings.tsx`, `packages/web/src/shell/Shell.tsx`, `packages/web/src/styles/settings.css`
- Test: `packages/web/test/settings/Fetching.test.tsx`, `packages/web/test/settings/putFetchHost.test.ts`, `packages/web/test/shell/Shell.test.tsx`

**Interfaces:**
- Consumes: contract types from Task 3; `sendJson`; `SESSION_EXPIRED_MESSAGE`.
- Produces: `FetchHostSubmit`, `FetchHostsLoader`, `Fetching` component; `SettingsProps.fetchHosts: FetchHostsLoader` and `SettingsProps.submitFetchHost: FetchHostSubmit`.

- [ ] **Step 1: The post helper and its test**

Create `packages/web/src/settings/putFetchHost.ts`:

```ts
import {
  FETCH_REFUSALS,
  type FetchHostPatch,
  type FetchHostRead,
  type FetchPair,
  type FetchRefusalCode,
} from '@pickarr/contract';
import { sendJson } from '../auth/sendJson.ts';
import { SESSION_EXPIRED_MESSAGE } from '../auth/sessionExpired.ts';

export type FetchRefusalOutcome = { refusal: FetchRefusalCode | 'offline' | 'expired' | 'unrecognised' };
export type FetchHostOutcome = FetchHostRead | FetchPair | FetchRefusalOutcome;
export type FetchHostSubmit = (hostname: string, patch: FetchHostPatch) => Promise<FetchHostOutcome>;

const REFUSAL_CODES: ReadonlySet<string> = new Set(FETCH_REFUSALS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRefusalCode(value: unknown): value is FetchRefusalCode {
  return typeof value === 'string' && REFUSAL_CODES.has(value);
}

function isPair(value: Record<string, unknown>): value is Record<string, unknown> & FetchPair {
  return typeof value.concurrency === 'number' && typeof value.timeoutMs === 'number';
}

export async function putFetchHost(hostname: string, patch: FetchHostPatch): Promise<FetchHostOutcome> {
  const result = await sendJson(`/api/fetch-hosts/${encodeURIComponent(hostname)}`, { method: 'PUT', body: patch });
  if (result.outcome !== 'answered') return { refusal: result.outcome };
  const { body } = result;
  if (!isRecord(body)) return { refusal: 'unrecognised' };
  if (isRefusalCode(body.refusal)) return { refusal: body.refusal };
  if (isPair(body)) {
    // A host row carries `hostname`; the default pair does not.
    if (typeof body.hostname === 'string' && isRecord(body.inherited) && typeof body.configured === 'boolean') {
      return body as unknown as FetchHostRead;
    }
    return { concurrency: body.concurrency, timeoutMs: body.timeoutMs };
  }
  return { refusal: 'unrecognised' };
}

export const fetchHostSubmit: FetchHostSubmit = putFetchHost;

export const FETCH_REFUSAL_MESSAGES: Record<FetchRefusalCode | 'offline' | 'expired' | 'unrecognised', string> = {
  'invalid-shape': 'Pickarr did not understand that value. Enter whole numbers only.',
  'invalid-hostname': 'Pickarr does not know that host. Reload the page to see the hosts it has fetched.',
  'invalid-concurrency': 'In flight must be a whole number from 1 to 64.',
  'invalid-timeout': 'Timeout must be a whole number of seconds from 1 to 3600.',
  'default-required': 'The default row needs both values; it has nothing to inherit from.',
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  expired: SESSION_EXPIRED_MESSAGE,
  unrecognised: 'Pickarr refused this change, but did not say why. The host may be a different version than this page expects — reload and try again.',
};
```

Create `packages/web/test/settings/putFetchHost.test.ts`:

```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { putFetchHost } from '../../src/settings/putFetchHost.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answering(status: number, body: unknown, seen: { url: string; init: RequestInit | undefined }[]) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
}

test('sends a PUT with the patch as given, null included, and answers the row', async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const row = { hostname: 'cdn.example', concurrency: 3, timeoutMs: 30000, inherited: { concurrency: false, timeoutMs: true }, configured: true };
  answering(200, row, seen);
  const outcome = await putFetchHost('cdn.example', { concurrency: 3, timeoutMs: null });
  assert.deepEqual(outcome, row);
  assert.equal(seen[0]?.url, '/api/fetch-hosts/cdn.example');
  assert.equal(seen[0]?.init?.method, 'PUT');
  assert.equal(seen[0]?.init?.body, '{"concurrency":3,"timeoutMs":null}');
});

test('the default row answers a bare pair, and a refusal code is passed through', async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  answering(200, { concurrency: 2, timeoutMs: 20000 }, seen);
  assert.deepEqual(await putFetchHost('default', { concurrency: 2, timeoutMs: 20000 }), { concurrency: 2, timeoutMs: 20000 });
  answering(400, { refusal: 'invalid-timeout' }, seen);
  assert.deepEqual(await putFetchHost('cdn.example', { timeoutMs: 1 }), { refusal: 'invalid-timeout' });
  answering(500, { error: 'boom' }, seen);
  assert.deepEqual(await putFetchHost('cdn.example', { timeoutMs: 1000 }), { refusal: 'unrecognised' });
});
```

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/settings/putFetchHost.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `fail 0` once the helper exists (write the test first, see it fail on the missing module, then create the helper).

- [ ] **Step 2: The loader hook**

Create `packages/web/src/settings/useFetchHosts.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { FetchHostsRead } from '@pickarr/contract';
import { sendJson, type SendJsonResult } from '../auth/sendJson.ts';
import { SESSION_EXPIRED_MESSAGE } from '../auth/sessionExpired.ts';

export type FetchHostsLoader = () => Promise<SendJsonResult>;

export function fetchFetchHosts(): Promise<SendJsonResult> {
  return sendJson('/api/fetch-hosts', { method: 'GET' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRead(value: unknown): value is FetchHostsRead {
  return isRecord(value) && isRecord(value.default) && Array.isArray(value.hosts);
}

export interface FetchHostsState {
  data: FetchHostsRead | undefined;
  error: string | null;
  reload: () => void;
}

/** Loads on mount and whenever `reload` is called. `sendJson` already notifies the shell on 401; the message here is the row's own. */
export function useFetchHosts(load: FetchHostsLoader): FetchHostsState {
  const [data, setData] = useState<FetchHostsRead | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => { setGeneration((g) => g + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((result) => {
      if (cancelled) return;
      if (result.outcome === 'expired') { setError(SESSION_EXPIRED_MESSAGE); return; }
      if (result.outcome === 'offline' || !isRead(result.body)) { setError('Could not load fetch hosts.'); return; }
      setError(null);
      setData(result.body);
    });
    return () => { cancelled = true; };
  }, [load, generation]);

  return { data, error, reload };
}
```

- [ ] **Step 3: Write the failing component tests**

Create `packages/web/test/settings/Fetching.test.tsx`:

```tsx
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import type { FetchHostPatch, FetchHostsRead } from '@pickarr/contract';
import type { SendJsonResult } from '../../src/auth/sendJson.ts';
import { Fetching } from '../../src/settings/Fetching.tsx';
import type { FetchHostOutcome } from '../../src/settings/putFetchHost.ts';

afterEach(cleanup);

const READ: FetchHostsRead = {
  default: { concurrency: 1, timeoutMs: 30000 },
  hosts: [
    { hostname: 'cdn.example', concurrency: 3, timeoutMs: 30000, inherited: { concurrency: false, timeoutMs: true }, configured: true },
    { hostname: 'tracker.example', concurrency: 1, timeoutMs: 30000, inherited: { concurrency: true, timeoutMs: true }, configured: false },
  ],
};

function loaderOf(reads: FetchHostsRead[]): { load: () => Promise<SendJsonResult>; calls: () => number } {
  let calls = 0;
  return {
    load: async () => {
      calls += 1;
      const body = reads[Math.min(calls, reads.length) - 1];
      return { outcome: 'answered', status: 200, body };
    },
    calls: () => calls,
  };
}

function submitRecording(outcome: FetchHostOutcome): { submit: (hostname: string, patch: FetchHostPatch) => Promise<FetchHostOutcome>; sent: { hostname: string; patch: FetchHostPatch }[] } {
  const sent: { hostname: string; patch: FetchHostPatch }[] = [];
  return {
    submit: async (hostname, patch) => { sent.push({ hostname, patch }); return outcome; },
    sent,
  };
}

function row(name: string): HTMLElement {
  return screen.getByRole('listitem', { name });
}

test('inherited values render as placeholders in empty inputs; pinned values render as values', async () => {
  const { load } = loaderOf([READ]);
  render(<Fetching load={load} submit={submitRecording(READ.hosts[0]!).submit} />);
  const cdn = await screen.findByRole('listitem', { name: 'cdn.example' });
  const inFlight = within(cdn).getByLabelText('In flight') as HTMLInputElement;
  const timeout = within(cdn).getByLabelText('Timeout (s)') as HTMLInputElement;
  assert.equal(inFlight.value, '3');
  assert.equal(timeout.value, '');
  assert.equal(timeout.placeholder, '30');

  const tracker = row('tracker.example');
  assert.equal((within(tracker).getByLabelText('In flight') as HTMLInputElement).value, '');
  assert.equal((within(tracker).getByLabelText('In flight') as HTMLInputElement).placeholder, '1');

  const def = row('Any other host');
  assert.equal((within(def).getByLabelText('In flight') as HTMLInputElement).value, '1');
  assert.equal((within(def).getByLabelText('Timeout (s)') as HTMLInputElement).value, '30');
});

test('Save is disabled until a field changes, sends seconds as milliseconds, and reloads', async () => {
  const after: FetchHostsRead = { ...READ, hosts: [{ ...READ.hosts[1]!, timeoutMs: 60000, inherited: { concurrency: true, timeoutMs: false }, configured: true }, READ.hosts[0]!] };
  const { load, calls } = loaderOf([READ, after]);
  const { submit, sent } = submitRecording(after.hosts[0]!);
  render(<Fetching load={load} submit={submit} />);
  const tracker = await screen.findByRole('listitem', { name: 'tracker.example' });
  const save = within(tracker).getByRole('button', { name: /^Save/ }) as HTMLButtonElement;
  assert.equal(save.disabled, true);

  fireEvent.change(within(tracker).getByLabelText('Timeout (s)'), { target: { value: '60' } });
  assert.equal(save.disabled, false);
  fireEvent.click(save);

  await waitFor(() => { assert.equal(sent.length, 1); });
  assert.deepEqual(sent[0], { hostname: 'tracker.example', patch: { timeoutMs: 60000 } });
  await waitFor(() => { assert.equal(calls(), 2, 'reloaded after the save'); });
});

test('clearing a pinned field sends null; Revert to default sends both as null and shows only on configured rows', async () => {
  const { load } = loaderOf([READ]);
  const { submit, sent } = submitRecording(READ.hosts[0]!);
  render(<Fetching load={load} submit={submit} />);
  const cdn = await screen.findByRole('listitem', { name: 'cdn.example' });
  fireEvent.change(within(cdn).getByLabelText('In flight'), { target: { value: '' } });
  fireEvent.click(within(cdn).getByRole('button', { name: /^Save/ }));
  await waitFor(() => { assert.equal(sent.length, 1); });
  assert.deepEqual(sent[0]?.patch, { concurrency: null });

  fireEvent.click(within(cdn).getByRole('button', { name: /^Revert to default/ }));
  await waitFor(() => { assert.equal(sent.length, 2); });
  assert.deepEqual(sent[1]?.patch, { concurrency: null, timeoutMs: null });

  assert.ok(!within(row('tracker.example')).queryByRole('button', { name: /^Revert to default/ }), 'an unconfigured row has nothing to revert');
  assert.ok(!within(row('Any other host')).queryByRole('button', { name: /^Revert to default/ }));
});

test('a refusal renders as an alert naming the field, and a fractional second never leaves the page', async () => {
  const { load } = loaderOf([READ]);
  const { submit, sent } = submitRecording({ refusal: 'invalid-concurrency' });
  render(<Fetching load={load} submit={submit} />);
  const cdn = await screen.findByRole('listitem', { name: 'cdn.example' });

  fireEvent.change(within(cdn).getByLabelText('Timeout (s)'), { target: { value: '1.5' } });
  fireEvent.click(within(cdn).getByRole('button', { name: /^Save/ }));
  assert.equal(within(cdn).getByRole('alert').textContent, 'Timeout must be a whole number of seconds from 1 to 3600.');
  assert.equal(sent.length, 0);

  fireEvent.change(within(cdn).getByLabelText('Timeout (s)'), { target: { value: '45' } });
  fireEvent.change(within(cdn).getByLabelText('In flight'), { target: { value: '99' } });
  fireEvent.click(within(cdn).getByRole('button', { name: /^Save/ }));
  await waitFor(() => {
    assert.equal(within(cdn).getByRole('alert').textContent, 'In flight must be a whole number from 1 to 64.');
  });
});

test('loading and empty states', async () => {
  const { load } = loaderOf([{ default: { concurrency: 1, timeoutMs: 30000 }, hosts: [] }]);
  render(<Fetching load={load} submit={submitRecording({ refusal: 'offline' }).submit} />);
  assert.ok(screen.getByText('Loading…'));
  await screen.findByText('No hosts fetched yet');
  assert.ok(screen.getByRole('listitem', { name: 'Any other host' }), 'the default row is always there');
});
```

Run the file; expected: module not found for `Fetching.tsx`.

- [ ] **Step 4: Implement `Fetching.tsx`**

```tsx
import { useState, type FormEvent, type ReactElement } from 'react';
import type { FetchHostPatch, FetchHostRead, FetchHostsRead } from '@pickarr/contract';
import { FETCH_DEFAULT_HOST } from '@pickarr/contract';
import { useFetchHosts, type FetchHostsLoader } from './useFetchHosts.ts';
import { FETCH_REFUSAL_MESSAGES, type FetchHostSubmit } from './putFetchHost.ts';

const DEFAULT_LABEL = 'Any other host';

function Refusal({ message }: { message: string }): ReactElement {
  return (
    <div role="alert">
      <p>{message}</p>
    </div>
  );
}

/** What one row shows: the pinned value as a string, or `''` with the effective value as placeholder. */
interface Shown {
  readonly concurrency: string;
  readonly timeoutS: string;
  readonly concurrencyPlaceholder: string;
  readonly timeoutPlaceholder: string;
}

function shownFor(row: FetchHostRead, isDefault: boolean): Shown {
  const seconds = String(Math.round(row.timeoutMs / 1000));
  return {
    concurrency: isDefault || !row.inherited.concurrency ? String(row.concurrency) : '',
    timeoutS: isDefault || !row.inherited.timeoutMs ? seconds : '',
    concurrencyPlaceholder: String(row.concurrency),
    timeoutPlaceholder: seconds,
  };
}

/** `''` clears; otherwise a whole number, or `undefined` for anything else. */
function wholeNumber(text: string): number | null | undefined {
  if (text === '') return null;
  if (!/^\d+$/.test(text)) return undefined;
  return Number(text);
}

interface RowProps {
  row: FetchHostRead;
  isDefault: boolean;
  submit: FetchHostSubmit;
  onSaved: () => void;
}

function HostRow({ row, isDefault, submit, onSaved }: RowProps): ReactElement {
  const initial = shownFor(row, isDefault);
  const [draft, setDraft] = useState<{ concurrency?: string; timeoutS?: string }>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = isDefault ? DEFAULT_LABEL : row.hostname;
  const idPrefix = `fetch-host-${isDefault ? FETCH_DEFAULT_HOST : row.hostname.replaceAll('.', '-')}`;
  const nameId = `${idPrefix}-name`;
  const concurrencyId = `${idPrefix}-concurrency`;
  const timeoutId = `${idPrefix}-timeout`;
  const saveId = `${idPrefix}-save`;
  const revertId = `${idPrefix}-revert`;

  const concurrency = draft.concurrency ?? initial.concurrency;
  const timeoutS = draft.timeoutS ?? initial.timeoutS;
  const changed = concurrency !== initial.concurrency || timeoutS !== initial.timeoutS;

  async function send(patch: FetchHostPatch): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const outcome = await submit(isDefault ? FETCH_DEFAULT_HOST : row.hostname, patch);
      if ('refusal' in outcome) {
        setError(FETCH_REFUSAL_MESSAGES[outcome.refusal]);
        return;
      }
      setDraft({});
      onSaved();
    } catch {
      setError(FETCH_REFUSAL_MESSAGES.offline);
    } finally {
      setPending(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const patch: { concurrency?: number | null; timeoutMs?: number | null } = {};
    if (draft.concurrency !== undefined) {
      const value = wholeNumber(draft.concurrency);
      if (value === undefined) { setError(FETCH_REFUSAL_MESSAGES['invalid-concurrency']); return; }
      patch.concurrency = value;
    }
    if (draft.timeoutS !== undefined) {
      const seconds = wholeNumber(draft.timeoutS);
      if (seconds === undefined) { setError(FETCH_REFUSAL_MESSAGES['invalid-timeout']); return; }
      patch.timeoutMs = seconds === null ? null : seconds * 1000;
    }
    if (isDefault && (patch.concurrency === null || patch.timeoutMs === null)) {
      setError(FETCH_REFUSAL_MESSAGES['default-required']);
      return;
    }
    void send(patch);
  }

  return (
    <li aria-labelledby={nameId}>
      <h3 id={nameId}>{label}</h3>
      <form onSubmit={save}>
        <div>
          <label htmlFor={concurrencyId}>In flight</label>
          <input
            id={concurrencyId}
            inputMode="numeric"
            value={concurrency}
            placeholder={initial.concurrencyPlaceholder}
            disabled={pending}
            onChange={(event) => { setDraft((d) => ({ ...d, concurrency: event.target.value })); }}
          />
        </div>
        <div>
          <label htmlFor={timeoutId}>Timeout (s)</label>
          <input
            id={timeoutId}
            inputMode="numeric"
            value={timeoutS}
            placeholder={initial.timeoutPlaceholder}
            disabled={pending}
            onChange={(event) => { setDraft((d) => ({ ...d, timeoutS: event.target.value })); }}
          />
        </div>
        <button type="submit" id={saveId} aria-labelledby={`${saveId} ${nameId}`} disabled={pending || !changed}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {!isDefault && row.configured ? (
          <button
            type="button"
            id={revertId}
            aria-labelledby={`${revertId} ${nameId}`}
            disabled={pending}
            onClick={() => { void send({ concurrency: null, timeoutMs: null }); }}
          >
            Revert to default
          </button>
        ) : null}
      </form>
      {error !== null && <Refusal message={error} />}
    </li>
  );
}

export interface FetchingProps {
  load: FetchHostsLoader;
  submit: FetchHostSubmit;
}

export function Fetching({ load, submit }: FetchingProps): ReactElement {
  const { data, error, reload } = useFetchHosts(load);
  return (
    <section aria-labelledby="fetching-heading">
      <h2 id="fetching-heading">Fetching</h2>
      <p>How many requests Pickarr makes to a host at once, and how long one may take. Blank fields inherit from Any other host.</p>
      {error !== null && <Refusal message={error} />}
      {data === undefined ? (
        <p>Loading…</p>
      ) : (
        <>
          <ul aria-label="Fetch hosts">
            <HostRow
              key={FETCH_DEFAULT_HOST}
              isDefault
              row={{ hostname: FETCH_DEFAULT_HOST, ...data.default, inherited: { concurrency: false, timeoutMs: false }, configured: true }}
              submit={submit}
              onSaved={reload}
            />
            {data.hosts.map((row) => (
              <HostRow key={`${row.hostname}:${String(row.concurrency)}:${String(row.timeoutMs)}:${String(row.configured)}`} row={row} isDefault={false} submit={submit} onSaved={reload} />
            ))}
          </ul>
          {data.hosts.length === 0 && <p>No hosts fetched yet</p>}
        </>
      )}
    </section>
  );
}
```

The composite `key` on host rows remounts a row when its server values change, which is what resets the draft after a reload; keep it.

- [ ] **Step 5: Run the component tests**

Run: `TSX_TSCONFIG_PATH=tsconfig.test-web.json node --import tsx --import ./packages/web/test/setup.ts --conditions development --test packages/web/test/settings/Fetching.test.tsx 2>&1 | grep -E "^(✖|ℹ (pass|fail))"`
Expected: `fail 0`. Note: a `<ul>` with `aria-label` and `<li aria-labelledby>` rows is used instead of the spec's `<table>` because a `<form>` cannot wrap a `<tr>`; the structure matches the Destinations section. Record this as a ruling in the ledger.

- [ ] **Step 6: Wire Settings and Shell**

In `Settings.tsx`, import `Fetching` and the two types, add to `SettingsProps`:

```ts
  fetchHosts: FetchHostsLoader;
  submitFetchHost: FetchHostSubmit;
```

destructure them and render `<Fetching load={fetchHosts} submit={submitFetchHost} />` after `<Destinations … />`. In `Shell.tsx`, import `fetchFetchHosts` from `../settings/useFetchHosts.ts` and `fetchHostSubmit` from `../settings/putFetchHost.ts`, and pass `fetchHosts={fetchFetchHosts} submitFetchHost={fetchHostSubmit}` to `<Settings>`. Find every other `<Settings` render in tests (`grep -rn "<Settings" packages/web/test`) and add the two props with a stub loader (`async () => ({ outcome: 'answered', status: 200, body: { default: { concurrency: 1, timeoutMs: 30000 }, hosts: [] } })`) and a stub submit.

In `packages/web/test/shell/Shell.test.tsx`, in the test that navigates to `/settings` (search `'/settings'`), add:

```ts
  assert.ok(await screen.findByRole('heading', { name: 'Fetching' }));
```

If the Shell test's fetch stub answers every URL with one body, add a branch for `/api/fetch-hosts` returning the empty read above.

- [ ] **Step 7: Styles**

Append to `packages/web/src/styles/settings.css`, following the file's rule of keying on structure:

```css
/* The Fetching section (2026-10-06): one row per host, two short numeric fields. */
ul[aria-label='Fetch hosts'] {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-3);
}

ul[aria-label='Fetch hosts'] > li form {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--space-3);
}

ul[aria-label='Fetch hosts'] > li form > div {
  display: grid;
  gap: var(--space-1);
}

ul[aria-label='Fetch hosts'] > li input {
  inline-size: 7ch;
}
```

Check `tokens.css` for the spacing token names and use the ones that exist (search `--space-`).

- [ ] **Step 8: Run the web suite and typecheck**

Run: `npm run typecheck && npm run test:web 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: clean, `fail 0`.

- [ ] **Step 9: Mutation check**

In `save`, change `seconds * 1000` to `seconds`. Expected: the Save test fails on `timeoutMs: 60000`. Revert.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/settings packages/web/src/shell/Shell.tsx packages/web/src/styles/settings.css packages/web/test/settings packages/web/test/shell/Shell.test.tsx
git commit -m "Settings gains a Fetching section: per-host concurrency and timeout, saved to the host's config file"
```

---

### Task 9: End-to-end proof and documentation

**Files:**
- Create: `packages/e2e/tests/settings-fetching.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: the harness fixture's `configPath` from Task 7.

- [ ] **Step 1: The spec**

```ts
import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { test } from '../src/harness-2.ts';

const PASSWORD = 'correct horse battery staple, not a real credential';

async function claimInstall(page: Page, email: string, claimToken: string): Promise<void> {
  await page.getByRole('button', { name: 'First time here? Claim this install' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Claim token').fill(claimToken);
  await page.getByRole('button', { name: 'Claim this install' }).click();
}

test('a fetch host limit saved on Settings is written to the config file and shown pinned after a reload', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await page.goto(`${harness.origin}/settings`);
  const section = page.getByRole('region', { name: 'Fetching' });
  await expect(section.getByRole('listitem', { name: 'Any other host' })).toBeVisible({ timeout: 10_000 });

  // The default row is always present; pin it to 2 and 45 s.
  const def = section.getByRole('listitem', { name: 'Any other host' });
  await def.getByLabel('In flight').fill('2');
  await def.getByLabel('Timeout (s)').fill('45');
  await def.getByRole('button', { name: 'Save Any other host' }).click();
  await expect(def.getByLabel('In flight')).toHaveValue('2', { timeout: 10_000 });

  const written = JSON.parse(await readFile(harness.configPath, 'utf8')) as { fetch: { default: { concurrency: number; timeoutMs: number } } };
  expect(written.fetch.default).toEqual({ concurrency: 2, timeoutMs: 45000 });

  await page.reload();
  const again = page.getByRole('region', { name: 'Fetching' }).getByRole('listitem', { name: 'Any other host' });
  await expect(again.getByLabel('Timeout (s)')).toHaveValue('45', { timeout: 10_000 });
});
```

The harness fixture must expose `configPath` (Task 7). If `section` does not have the `region` role because the `<section>` has no accessible name in Playwright's tree, query `page.getByRole('heading', { name: 'Fetching' })` and use `page.getByRole('list', { name: 'Fetch hosts' })` instead. Declared step timeouts sum to 30 s, under the 90 s budget.

Ruling to record: the spec's e2e asked to read `limit 3` in the Activities fetch queue; that list shows only hosts with requests waiting or in flight, which an e2e cannot hold open deterministically against a real fetch. The live application of a change is pinned by `queue.test.ts`; the e2e proves persistence and rendering.

- [ ] **Step 2: Run the e2e suite**

Run: `npm run e2e > /tmp/e2e.log 2>&1; echo "exit $?"; grep -E "passed|failed" /tmp/e2e.log | tail -3`
Expected: exit 0, all specs passed. Never pipe the run into `head` or `tail`.

- [ ] **Step 3: README**

In the config file table in `README.md`, add rows:

```
| `fetch.default.concurrency` | `1` | Requests Pickarr runs at once to any host without its own entry. 1 to 64. |
| `fetch.default.timeoutMs` | `30000` | How long one request to such a host may take. 1000 to 3600000. |
| `fetch.hosts.<hostname>.concurrency` | *(inherits)* | The same, for one exact hostname. Lowercase, no port. |
| `fetch.hosts.<hostname>.timeoutMs` | *(inherits)* | The same. The lookup service's hostname gets 4 and 300000 when it has no entry. |
```

and extend the JSON example with a `"fetch"` block matching spec §1.1. Below the table add one paragraph:

> The `fetch` section is also edited from the Settings page, whose changes apply to the next request and are written back to this file. A hand edit while the host runs is kept across the next Settings save, but is not in force until the next boot.

- [ ] **Step 4: Full gate**

Run: `npm run check > /tmp/check.log 2>&1; echo "exit $?"; grep -E "^ℹ (pass|fail)" /tmp/check.log`
Expected: exit 0, both suites `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e/tests/settings-fetching.spec.ts README.md
git commit -m "e2e: a fetch host limit saved on Settings lands in the config file; README documents the fetch section"
```
