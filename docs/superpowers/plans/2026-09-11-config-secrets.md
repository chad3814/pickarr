# Configuration and secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the 2.0 host a config file whose top level is one namespace per subsystem, and a keyed secret resolver, so a credential is fetched one way by every caller and `download_client` stops holding credentials.

**Architecture:** A `secret` table plus a memoized `chain(fromEnv, fromFile, fromDatabase)` per name over `@chad3814/secret-provider`; a JSON config document whose namespaces are registered with a Zod schema and updated by read-modify-write behind a single-writer queue. `download_client` keeps a `randomUUID()` secret name where it used to keep the credential.

**Tech Stack:** TypeScript (nodenext, strict), `node:sqlite` (SQLite 3.53.4), `@chad3814/secret-provider@^1.2.0`, `zod@^3.24.0`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-11-config-secrets-design.md` — read it with this plan. Section numbers below cite it.

## Global Constraints

- Never the `any` type. Never a cast to silence a type error.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules` all on. Indexed access checked, never `!`-asserted. Type-only imports `import type`. No enums.
- Prefer async APIs over sync twins; inside an `async` function, `await` it. `node:sqlite` is synchronous — the documented exception, which is why `saveSecret` is sync. All filesystem work is `fs.promises`.
- **Log the discriminant alone, never the object.** No log line and **no HTTP response body** may carry a url, a path, a query string, a credential, a session token or a password hash. This includes a `ProviderError` message: §2.4 measured that `chain`'s own failure names `fromFile`'s path.
- **Only the modules named in `CREDENTIAL_ALLOW_LIST` may select a credential column.** After this slice the enforced columns are `auth_account.password`, `auth_session.token`, `host_state.value` and `secret.value`.
- **No SQL in an HTTP handler.** **No import cycles** — nothing under `src/api`, `src/clients`, `src/jobs`, `src/media`, `src/config` or `src/secrets` may import `host.ts`.
- `migrateHostWith`'s atomicity — each migration sharing a savepoint with its version record, with a matching `RELEASE` on both paths — **must not be touched**.
- Adapters and servers are tested against fakes and loopback only.
- Pickarr 1.x (`packages/core`, `plugin-api`, `plugin-scenes`, `web`, `e2e`) is deployed and **must not be modified**. `packages/core/src/config` is 1.x's own config system; this slice does not touch it and does not read its file.
- A comment false about the code beside it is a defect equal to a wrong line of code. When you change a thing, grep for its **name**, not just the line you edited — including in `docs/`.
- **No secret in any output.** Not in a log line, not in an assertion, not in a failure message, not in a test name. A test that needs a credential uses a fixed fake like `'test-value'` and asserts on lengths or booleans where it can.
- Baseline at the start: **1943** tests fail 0; lint exit 0 with exactly **124** warnings, **0** in `packages/contract` and `packages/host`; `npm run build` 0; `npm run test-hygiene` 0.
- Commit signed, `git add -- <paths>` first, explicit pathspec, never a bare `git commit`, never edit any git config. Note `git commit -- <pathspec>` commits the **working tree** for those paths, not the index, and does not stage an untracked file (`git add` it first).

## Verification method

This project's defect rate is held down by mutation testing, not by reading. Every task below names at least one mutation and the kill it must produce.

- **Apply the mutation, run the focused test, confirm it fails by name**, then restore.
- **If a mutation's plain form fails `typecheck`, it is measuring the compiler, not the test.** Build `x as unknown as T` instead.
- **Restore by copy-aside and `md5 -q`, never `git checkout --`.** With uncommitted work in the file, `git checkout` reverts to the committed state and destroys it, and the passing run afterwards looks exactly like success.
- **Check every kill landed on its own assertion**, not on a SQLite error, a binding-arity error, a socket error or a compile error.
- If a mutation cannot isolate the change, **say so** rather than inventing a kill. If a prediction in this plan does not hold, trace why and report the trace.

## File structure

| File | Responsibility |
|---|---|
| `packages/host/src/secrets/names.ts` | The name shape, the env-var name, `SecretNotFound`. No I/O. |
| `packages/host/src/secrets/store.ts` | The only module that selects `secret.value`. Two functions. |
| `packages/host/src/secrets/instance.ts` | `createSecrets` — the per-name memoized chain, `get`, `saveSecret`. |
| `packages/host/src/config/file.ts` | The JSON document on disk: read, parse, atomic write. No schemas. |
| `packages/host/src/config/instance.ts` | `openConfig`, `register`, the typed handles, the single-writer queue. |
| `packages/host/src/config/schemas.ts` | The host's own three namespace schemas. |
| `packages/host/src/origin.ts` | `assertOriginOnly`, shared by `PICKARR_PUBLIC_URL` and `server.publicUrl`. |
| `packages/host/src/db/migrate.ts` | `MIGRATION_13` (the `secret` table), `MIGRATION_14` (the column move). |
| `packages/host/src/db/schema.ts` | The Drizzle mirror for both. |
| `packages/host/src/clients/config.ts` | `readClientConfig`, now async, resolving names through `Secrets`. |
| `scripts/check-test-hygiene.ts` | `secret.value` joins the enforced columns; `store.ts` joins the allow-list. |
| `packages/host/src/main.ts` | Boot order, and env-over-file precedence. |

---

### Task 1: The `secret` table, its mirror, and its hygiene rule

**Files:**
- Modify: `packages/host/package.json` (dependencies)
- Modify: `packages/host/src/db/migrate.ts` (add `MIGRATION_13`, add to `HOST_MIGRATIONS`)
- Modify: `packages/host/src/db/schema.ts` (add the `secret` table)
- Modify: `scripts/check-test-hygiene.ts:214-218` (`CREDENTIAL_COLUMNS`)
- Test: `packages/host/test/db/migrate.test.ts`, `scripts/check-test-hygiene.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `secret` table (`name TEXT PRIMARY KEY`, `value TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`); the Drizzle export `secret`; `secret.value` enforced as a credential column.

- [ ] **Step 1: Add the two dependencies**

In `packages/host/package.json`, add to `dependencies`, keeping the existing keys in alphabetical order:

```json
"@chad3814/secret-provider": "^1.2.0",
"zod": "^3.24.0"
```

`^3.24.0` is the range `packages/core` already pins, so one copy is installed (spec §2.6a). Run `npm install` from the repo root; it must update `package-lock.json` and nothing else.

- [ ] **Step 2: Write the failing migration test**

Add to `packages/host/test/db/migrate.test.ts`:

```ts
test('migration 13 creates the secret table with name as its primary key', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const columns = raw.prepare('PRAGMA table_info(secret)').all()
    .map((row) => ({
      name: String((row as { name: unknown }).name),
      notNull: Number((row as { notnull: unknown }).notnull),
      pk: Number((row as { pk: unknown }).pk),
    }));
  assert.deepEqual(columns, [
    { name: 'name', notNull: 0, pk: 1 },
    { name: 'value', notNull: 1, pk: 0 },
    { name: 'created_at', notNull: 1, pk: 0 },
    { name: 'updated_at', notNull: 1, pk: 0 },
  ], 'secret must be keyed on name, with a non-null value');
});

test('a second row for one secret name is refused', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const insert = raw.prepare('INSERT INTO secret (name, value, created_at, updated_at) VALUES (?, ?, ?, ?)');
  insert.run('tvdb_key', 'test-value', 1, 1);
  try {
    insert.run('tvdb_key', 'other-value', 2, 2);
    assert.fail('a duplicate secret name must be refused');
  } catch (error) {
    // 1555 is SQLITE_CONSTRAINT_PRIMARYKEY. Asserted by code, not message.
    assert.equal((error as { errcode?: number }).errcode, 1555);
  }
});
```

`notNull: 0` on `name` is not an oversight: SQLite's `PRAGMA table_info` reports a `TEXT PRIMARY KEY` as nullable even though the primary key refuses a NULL. Asserting `1` there would fail against correct DDL.

- [ ] **Step 3: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/db/migrate.test.ts`
Expected: FAIL — `PRAGMA table_info(secret)` returns `[]`, so the `deepEqual` reports an empty array against four columns.

- [ ] **Step 4: Add `MIGRATION_13`**

In `packages/host/src/db/migrate.ts`, after `MIGRATION_12`'s template literal:

```ts
/**
 * A credential per row, addressed by name. `name` is the primary key rather
 * than a surrogate id with a unique index: a name *is* the identity, and
 * `INSERT ... ON CONFLICT (name) DO UPDATE` is the only write.
 *
 * `value` is a credential column, enforced at build time by
 * `scripts/check-test-hygiene.ts` — only `src/secrets/store.ts` may select
 * it. Migration 14 moves `download_client`'s credentials into here.
 */
const MIGRATION_13 = `
  CREATE TABLE secret (
    name       TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;
```

Then add to `HOST_MIGRATIONS`, after the version 12 entry:

```ts
  { version: 13, up: (db) => db.exec(MIGRATION_13) },
```

- [ ] **Step 5: Mirror it in `schema.ts`**

At the end of `packages/host/src/db/schema.ts`, beside `hostState`:

```ts
/**
 * One credential per row, addressed by name — a `randomUUID()` for a
 * credential the settings UI stored, or a name a human chose like `tvdb_key`
 * for one they may also supply from the environment.
 *
 * `value` is a credential column. Only `src/secrets/store.ts` may select it,
 * enforced at build time by `scripts/check-test-hygiene.ts` over
 * `packages/host/src`. It is deliberately *not* `host_state`: that table
 * holds this host's own facts, while every row here is a third party's
 * credential, and the two have different readers.
 */
export const secret = sqliteTable('secret', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
```

`packages/host/test/db/schema.test.ts` compares every mirrored table against the migrated database automatically — adding the export is what puts `secret` under that comparison. Do not edit that test.

- [ ] **Step 6: Enforce `secret.value`**

In `scripts/check-test-hygiene.ts`, add to `CREDENTIAL_COLUMNS` (currently lines 214-218):

```ts
  { table: 'secret', column: 'value' },
```

`CREDENTIAL_TABLES` is derived from that list, so it needs no edit. Now grep the file for the count of credential columns: the docblock above `CREDENTIAL_COLUMNS` and the failure message near line 848 both enumerate *three* columns by name. Update both to four, naming `secret.value` as a third party's credential. A message that lists three columns while the check enforces four is the defect class this plan's constraints call out.

- [ ] **Step 7: Run the full gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 1945 pass 0 fail (1943 + 2); lint 0 with exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 8: Mutation — prove the primary key is what refuses the duplicate**

Copy `migrate.ts` aside (`cp packages/host/src/db/migrate.ts /tmp/m13.bak`), change `name       TEXT PRIMARY KEY` to `name       TEXT NOT NULL`, and run the focused test.
Expected: `a second row for one secret name is refused` FAILS with `a duplicate secret name must be refused` — the insert succeeds. The first test also fails on `pk: 1`.
Restore with `cp /tmp/m13.bak packages/host/src/db/migrate.ts`, then `md5 -q` both paths and confirm they match. Re-run the focused test and confirm it passes again.

- [ ] **Step 9: Commit**

```bash
git add -- packages/host/package.json package-lock.json packages/host/src/db/migrate.ts packages/host/src/db/schema.ts scripts/check-test-hygiene.ts packages/host/test/db/migrate.test.ts
git commit -m "Add a table for a credential addressed by name, enforced as a credential column" -- packages/host/package.json package-lock.json packages/host/src/db/migrate.ts packages/host/src/db/schema.ts scripts/check-test-hygiene.ts packages/host/test/db/migrate.test.ts
```

---

### Task 2: Secret names, and the only module that reads `secret.value`

**Files:**
- Create: `packages/host/src/secrets/names.ts`
- Create: `packages/host/src/secrets/store.ts`
- Modify: `scripts/check-test-hygiene.ts:252-256` (`CREDENTIAL_ALLOW_LIST`)
- Test: `packages/host/test/secrets/names.test.ts`, `packages/host/test/secrets/store.test.ts`

**Interfaces:**
- Consumes: the `secret` table from Task 1.
- Produces:
  - `SECRET_NAME: RegExp`
  - `assertSecretName(name: string): void`
  - `envNameFor(name: string): string`
  - `class SecretNotFound extends Error { readonly secretName: string }`
  - `readSecretValue(raw: DatabaseSync, name: string): string | null`
  - `writeSecretValue(raw: DatabaseSync, name: string, value: string, at: number): void`

**Note on the error's property name:** it is `secretName`, not `name`. `Error.name` already exists and means the error's class name; shadowing it would make `error.name` report a secret's name where every tool expects `'SecretNotFound'`.

- [ ] **Step 1: Write the failing name tests**

Create `packages/host/test/secrets/names.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertSecretName, envNameFor, SecretNotFound } from '../../src/secrets/names.ts';

test('a generated uuid is a legal secret name', () => {
  for (let i = 0; i < 20; i += 1) {
    assert.doesNotThrow(() => { assertSecretName(randomUUID()); });
  }
});

test('a name a human would choose is legal', () => {
  for (const name of ['tvdb_key', 'a', 'sab1', 'a-b_c9']) {
    assert.doesNotThrow(() => { assertSecretName(name); }, `${name} must be legal`);
  }
});

test('anything that could escape the secrets directory is refused', () => {
  for (const name of ['..', 'a/b', 'a.b', '../../etc/passwd', '/abs', 'a\\b', '', 'A', '_leading', '-leading', 'a b']) {
    assert.throws(() => { assertSecretName(name); }, /secret name/, `${name} must be refused`);
  }
});

test('a name at the length limit is legal and one past it is not', () => {
  assert.doesNotThrow(() => { assertSecretName('a'.repeat(64)); });
  assert.throws(() => { assertSecretName('a'.repeat(65)); }, /secret name/);
});

test('the env var name is legal for every legal secret name', () => {
  const legalEnv = /^[A-Z_][A-Z0-9_]*$/;
  for (const name of ['tvdb_key', 'a-b', randomUUID()]) {
    assert.ok(legalEnv.test(envNameFor(name)), `${name} must map to a legal env var name`);
  }
});

test('SecretNotFound carries the name without a path, and does not shadow Error.name', () => {
  const error = new SecretNotFound('tvdb_key');
  assert.equal(error.secretName, 'tvdb_key');
  assert.equal(error.name, 'SecretNotFound');
  assert.ok(error.message.includes('tvdb_key'));
  assert.ok(!error.message.includes('/'), 'the message must carry no path');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/secrets/names.test.ts`
Expected: FAIL — `Cannot find module '../../src/secrets/names.ts'`.

- [ ] **Step 3: Write `names.ts`**

```ts
/**
 * The shape of a secret name, and the two things derived from one.
 *
 * A name is addressed three ways: as an environment variable, as a file under
 * the secrets directory, and as a row in `secret`. The file case is why the
 * shape is enforced rather than trusted -- the path is built by joining this
 * string, so a name containing `..` or a separator would read outside the
 * directory. Refusing `.` and `/` outright is what makes that impossible,
 * and it is checked before any path is built.
 *
 * A name is not a secret, so an error may name it. Its *value* never appears
 * in any message here.
 */
export const SECRET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Throws unless `name` matches {@link SECRET_NAME}. */
export function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new Error(
      `secret name ${JSON.stringify(name)} is not lowercase alphanumerics, ` +
      `underscores and hyphens, 1 to 64 characters, starting alphanumeric`,
    );
  }
}

/**
 * The environment variable that overrides a secret.
 *
 * Hyphens become underscores because a `randomUUID()` carries them and an
 * environment variable may not: without this, the env link could never
 * resolve for a credential the settings UI stored, and the rule would differ
 * between a generated name and a chosen one. Measured in the design spec
 * §2.5 -- the result is a legal variable name for every name this module
 * accepts.
 */
export function envNameFor(name: string): string {
  return name.toUpperCase().replaceAll('-', '_');
}

/**
 * No link in a secret's chain produced a value.
 *
 * This replaces the `ProviderError` the chain throws, which is not safe to
 * propagate: design spec §2.4 measured that its message joins every link's
 * failure, `fromFile`'s **full path** included, and no log line in this repo
 * may carry a path. The name alone is what survives.
 *
 * The property is `secretName`, not `name`: `Error.name` already means the
 * error's class, and shadowing it would report a secret's name everywhere a
 * tool expects `'SecretNotFound'`.
 */
export class SecretNotFound extends Error {
  readonly secretName: string;

  constructor(secretName: string) {
    super(`no value for secret ${JSON.stringify(secretName)}`);
    this.name = 'SecretNotFound';
    this.secretName = secretName;
  }
}
```

- [ ] **Step 4: Run the name tests**

Run: `node --import tsx --conditions development --test packages/host/test/secrets/names.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing store tests**

Create `packages/host/test/secrets/store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { readSecretValue, writeSecretValue } from '../../src/secrets/store.ts';

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
};

test('a written secret reads back', () => {
  const raw = open();
  writeSecretValue(raw, 'tvdb_key', 'test-value', 1000);
  assert.equal(readSecretValue(raw, 'tvdb_key'), 'test-value');
});

test('a name with no row reads null', () => {
  assert.equal(readSecretValue(open(), 'tvdb_key'), null);
});

test('writing twice updates rather than throwing, and moves updated_at only', () => {
  const raw = open();
  writeSecretValue(raw, 'tvdb_key', 'first-value', 1000);
  writeSecretValue(raw, 'tvdb_key', 'second-value', 2000);
  assert.equal(readSecretValue(raw, 'tvdb_key'), 'second-value');
  const row = raw.prepare('SELECT created_at, updated_at FROM secret WHERE name = ?').get('tvdb_key');
  assert.equal(Number((row as { created_at: unknown }).created_at), 1000, 'created_at must not move');
  assert.equal(Number((row as { updated_at: unknown }).updated_at), 2000, 'updated_at must move');
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM secret').get()?.c), 1, 'one row, not two');
});

test('an illegal name is refused by both halves of the store', () => {
  const raw = open();
  assert.throws(() => { writeSecretValue(raw, '../escape', 'test-value', 1); }, /secret name/);
  assert.throws(() => { readSecretValue(raw, '../escape'); }, /secret name/);
});
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/secrets/store.test.ts`
Expected: FAIL — `Cannot find module '../../src/secrets/store.ts'`.

- [ ] **Step 7: Write `store.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import { assertSecretName } from './names.ts';

/**
 * The `secret` table's two operations, and the only place in
 * `packages/host/src` that names `secret.value` in SQL.
 *
 * That exclusivity is enforced at build time: this file's path is the reason
 * it is on `CREDENTIAL_ALLOW_LIST` in `scripts/check-test-hygiene.ts`. A
 * second reader is a build failure, not a review note.
 *
 * Synchronous because `node:sqlite` is -- the repo's documented exception to
 * preferring an async API. Nothing here awaits, so nothing is gained by
 * wrapping it in a promise.
 *
 * Both functions validate the name. `readSecretValue` does not build a path,
 * so traversal is not its risk; it validates anyway so that an illegal name
 * fails the same way wherever it enters, rather than silently reading null
 * here and throwing three links later.
 */
export function readSecretValue(raw: DatabaseSync, name: string): string | null {
  assertSecretName(name);
  const row = raw.prepare('SELECT value FROM secret WHERE name = ?').get(name);
  if (!row) return null;
  return String((row as { value: unknown }).value);
}

/** Inserts, or updates the value and `updated_at` of an existing row. */
export function writeSecretValue(raw: DatabaseSync, name: string, value: string, at: number): void {
  assertSecretName(name);
  raw.prepare(`
    INSERT INTO secret (name, value, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(name, value, at, at);
}
```

- [ ] **Step 8: Allow-list this file**

In `scripts/check-test-hygiene.ts`, add to `CREDENTIAL_ALLOW_LIST`:

```ts
  // The `secret` table's only reader and writer, so it is the one module that
  // may name `secret.value`.
  join(HOST_SRC_DIR, 'secrets', 'store.ts'),
```

Wave A of the auth slice established that an allow-list entry exempting nothing is worse than no entry — it hides the rule's loss. Prove this one is load-bearing in the next step rather than assuming it.

- [ ] **Step 9: Run the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run test-hygiene`
Expected: typecheck 0; tests 1955 pass 0 fail (1945 + 10); lint 0 with exactly 124 warnings; hygiene 0.

- [ ] **Step 10: Mutation A — prove the allow-list entry is load-bearing**

Remove the `secrets/store.ts` line you just added from `CREDENTIAL_ALLOW_LIST` and run `npm run test-hygiene`.
Expected: hygiene **fails**, naming `packages/host/src/secrets/store.ts` for selecting `secret.value`. Restore the line and confirm hygiene is 0 again. If it does *not* fail, the entry exempts nothing — say so and report it, because that is a finding about the check, not about this file.

- [ ] **Step 11: Mutation B — prove the traversal guard is the thing refusing**

Copy `store.ts` aside, delete the `assertSecretName(name);` line from `readSecretValue`, run the focused store test.
Expected: `an illegal name is refused by both halves of the store` FAILS on the `readSecretValue` assertion — it returns `null` instead of throwing.
Restore by copy-aside, `md5 -q` both, re-run.

- [ ] **Step 12: Commit**

```bash
git add -- packages/host/src/secrets/names.ts packages/host/src/secrets/store.ts scripts/check-test-hygiene.ts packages/host/test/secrets/names.test.ts packages/host/test/secrets/store.test.ts
git commit -m "Fix a secret's name shape before it is ever joined into a path, and keep its value to one reader" -- packages/host/src/secrets/names.ts packages/host/src/secrets/store.ts scripts/check-test-hygiene.ts packages/host/test/secrets/names.test.ts packages/host/test/secrets/store.test.ts
```

---

### Task 3: `createSecrets` — the memoized chain

**Files:**
- Create: `packages/host/src/secrets/instance.ts`
- Test: `packages/host/test/secrets/instance.test.ts`

**Interfaces:**
- Consumes: `assertSecretName`, `envNameFor`, `SecretNotFound` from `secrets/names.ts`; `readSecretValue`, `writeSecretValue` from `secrets/store.ts`.
- Produces:
  - `interface Secrets { get(name: string): Promise<string>; saveSecret(name: string, value: string): void }`
  - `createSecrets(deps: { raw: DatabaseSync; baseDir: string; now?: () => number }): Secrets`

`now` is optional so a test can pin timestamps; it defaults to `Date.now`.

- [ ] **Step 1: Write the failing tests**

Create `packages/host/test/secrets/instance.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { writeSecretValue } from '../../src/secrets/store.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import { SecretNotFound } from '../../src/secrets/names.ts';

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-secrets-'));
  try { await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
};

test('a secret in the database resolves', async () => {
  await withDir(async (dir) => {
    const raw = open();
    writeSecretValue(raw, 'tvdb_key', 'from-db', 1);
    const secrets = createSecrets({ raw, baseDir: dir });
    assert.equal(await secrets.get('tvdb_key'), 'from-db');
  });
});

test('a file under the secrets directory beats the database, and its trailing newline is trimmed', async () => {
  await withDir(async (dir) => {
    const raw = open();
    writeSecretValue(raw, 'tvdb_key', 'from-db', 1);
    await writeFile(join(dir, 'tvdb_key'), 'from-file\n');
    const secrets = createSecrets({ raw, baseDir: dir });
    assert.equal(await secrets.get('tvdb_key'), 'from-file');
  });
});

test('the environment beats both', async (t) => {
  await withDir(async (dir) => {
    const raw = open();
    writeSecretValue(raw, 'tvdb_key', 'from-db', 1);
    await writeFile(join(dir, 'tvdb_key'), 'from-file');
    process.env['TVDB_KEY'] = 'from-env';
    t.after(() => { delete process.env['TVDB_KEY']; });
    const secrets = createSecrets({ raw, baseDir: dir });
    assert.equal(await secrets.get('tvdb_key'), 'from-env');
  });
});

test('a uuid name resolves from the database and is overridable by its env var', async (t) => {
  await withDir(async (dir) => {
    const raw = open();
    const name = '550e8400-e29b-41d4-a716-446655440000';
    writeSecretValue(raw, name, 'from-db', 1);
    assert.equal(await createSecrets({ raw, baseDir: dir }).get(name), 'from-db');
    process.env['550E8400_E29B_41D4_A716_446655440000'] = 'from-env';
    t.after(() => { delete process.env['550E8400_E29B_41D4_A716_446655440000']; });
    assert.equal(await createSecrets({ raw, baseDir: dir }).get(name), 'from-env');
  });
});

test('each link resolves on its own, with the others empty', async (t) => {
  await withDir(async (dir) => {
    // The database alone.
    const dbOnly = open();
    writeSecretValue(dbOnly, 'tvdb_key', 'from-db', 1);
    assert.equal(await createSecrets({ raw: dbOnly, baseDir: dir }).get('tvdb_key'), 'from-db');

    // The file alone -- no row, no variable.
    await writeFile(join(dir, 'tvdb_key'), 'from-file');
    assert.equal(await createSecrets({ raw: open(), baseDir: dir }).get('tvdb_key'), 'from-file');

    // The environment alone -- no row, and a directory with no such file.
    process.env['SOLO_KEY'] = 'from-env';
    t.after(() => { delete process.env['SOLO_KEY']; });
    assert.equal(await createSecrets({ raw: open(), baseDir: dir }).get('solo_key'), 'from-env');
  });
});

test('three concurrent gets for one name read the database once', async () => {
  await withDir(async (dir) => {
    const raw = open();
    writeSecretValue(raw, 'tvdb_key', 'from-db', 1);
    let reads = 0;
    const counting = new Proxy(raw, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            if (sql.includes('FROM secret')) reads += 1;
            return Reflect.get(target, property, receiver).call(target, sql);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const secrets = createSecrets({ raw: counting, baseDir: dir });
    const values = await Promise.all([secrets.get('tvdb_key'), secrets.get('tvdb_key'), secrets.get('tvdb_key')]);
    assert.deepEqual(values, ['from-db', 'from-db', 'from-db']);
    assert.equal(reads, 1, 'memoize must collapse three concurrent gets into one read');
  });
});

test('saveSecret then get returns the new value without a restart', async () => {
  await withDir(async (dir) => {
    const raw = open();
    const secrets = createSecrets({ raw, baseDir: dir });
    secrets.saveSecret('tvdb_key', 'first-value');
    assert.equal(await secrets.get('tvdb_key'), 'first-value');
    secrets.saveSecret('tvdb_key', 'second-value');
    assert.equal(await secrets.get('tvdb_key'), 'second-value', 'saveSecret must invalidate the memoized provider');
  });
});

test('a name nothing resolves throws SecretNotFound, naming the name and no path', async () => {
  await withDir(async (dir) => {
    const secrets = createSecrets({ raw: open(), baseDir: dir });
    await assert.rejects(
      () => secrets.get('tvdb_key'),
      (error: unknown) => {
        assert.ok(error instanceof SecretNotFound);
        assert.equal(error.secretName, 'tvdb_key');
        assert.ok(!error.message.includes(dir), 'the message must not carry the secrets directory');
        assert.ok(!error.message.includes('/'), 'the message must carry no path at all');
        return true;
      },
    );
  });
});

test('an illegal name is refused before any filesystem access', async () => {
  await withDir(async (dir) => {
    const secrets = createSecrets({ raw: open(), baseDir: dir });
    await assert.rejects(() => secrets.get('../../etc/passwd'), /secret name/);
    assert.throws(() => { secrets.saveSecret('../../etc/passwd', 'test-value'); }, /secret name/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/secrets/instance.test.ts`
Expected: FAIL — `Cannot find module '../../src/secrets/instance.ts'`.

- [ ] **Step 3: Write `instance.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { chain, fromEnv, fromFile, memoize, ProviderError } from '@chad3814/secret-provider';
import type { Provider } from '@chad3814/secret-provider';
import { assertSecretName, envNameFor, SecretNotFound } from './names.ts';
import { readSecretValue, writeSecretValue } from './store.ts';

export interface Secrets {
  /** The credential for `name`, from the environment, the secrets directory or the `secret` table, in that order. */
  get(name: string): Promise<string>;
  /** Stores a credential and drops any memoized value for that name. */
  saveSecret(name: string, value: string): void;
}

/**
 * One way to fetch a credential, for every caller.
 *
 * The chain's order is its whole contract: the environment beats a file,
 * which beats the database. That is what lets a container deployment override
 * a credential the settings UI stored, without the settings UI knowing.
 * Nothing logs which link answered -- the order *is* the answer, so a
 * misconfiguration is diagnosed by knowing it rather than by reading a log
 * line (design spec §8).
 *
 * A provider is built once per name and held, so `memoize` can do its job:
 * measured, three concurrent `get` calls for one name produce one underlying
 * read, and a rejection is not cached, so a secret that appears later
 * resolves without a restart.
 *
 * `saveSecret` drops the held provider in the same call that writes. Without
 * that, editing a credential would leave every resolved caller on the old
 * value until the process restarted -- a silent authentication failure
 * against a service whose password had just been fixed. There is deliberately
 * no public `invalidate`: the only way to change a secret is the call that
 * already invalidates it, so it cannot be forgotten.
 */
export function createSecrets(deps: {
  raw: DatabaseSync;
  baseDir: string;
  now?: () => number;
}): Secrets {
  const now = deps.now ?? Date.now;
  const held = new Map<string, Provider<string>>();

  const fromDatabase = (name: string): Provider<string> => async () => {
    const value = readSecretValue(deps.raw, name);
    if (value === null) {
      throw new ProviderError(`no secret row for ${JSON.stringify(name)}`);
    }
    return value;
  };

  const providerFor = (name: string): Provider<string> => {
    const existing = held.get(name);
    if (existing !== undefined) return existing;
    const built = memoize(chain(
      fromEnv(envNameFor(name)),
      fromFile(join(deps.baseDir, name)),
      fromDatabase(name),
    ));
    held.set(name, built);
    return built;
  };

  return {
    async get(name: string): Promise<string> {
      // Before the path is built, never after: `join` with a name containing
      // `..` would read outside `baseDir`.
      assertSecretName(name);
      try {
        return await providerFor(name)();
      } catch (error) {
        // Every failure becomes `SecretNotFound`, because the chain's own
        // error names `fromFile`'s path (design spec §2.4) and no log line
        // here may carry a path. A non-`ProviderError` is a bug rather than
        // a missing secret, so it propagates untouched.
        if (error instanceof ProviderError) throw new SecretNotFound(name);
        throw error;
      }
    },

    saveSecret(name: string, value: string): void {
      assertSecretName(name);
      writeSecretValue(deps.raw, name, value, now());
      held.delete(name);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --conditions development --test packages/host/test/secrets/instance.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 1964 pass 0 fail (1955 + 9); lint 0 with exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 6: Mutation A — prove `saveSecret` invalidates**

Copy `instance.ts` aside. Delete `held.delete(name);` from `saveSecret`, run the focused test.
Expected: `saveSecret then get returns the new value without a restart` FAILS on the second assertion — `'first-value'` where `'second-value'` was expected, with the message `saveSecret must invalidate the memoized provider`.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 7: Mutation B — prove the error is replaced rather than propagated**

Copy aside. Replace the `catch` body with `throw error;`, run the focused test.
Expected: `a name nothing resolves throws SecretNotFound, naming the name and no path` FAILS — `error instanceof SecretNotFound` is false, and the path assertions would also fail because the `ProviderError` message carries the temp directory. This is the mutation that proves §2.4's measured leak is actually closed.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 8: Mutation C — prove the provider is held, not rebuilt**

Copy aside. In `providerFor`, delete the `held.get`/`existing` early return so a fresh provider is built per call, run the focused test.
Expected: `three concurrent gets for one name read the database once` FAILS with `reads` of 3 against 1. If it does not fail, `memoize` is being credited for something the `Map` is doing — trace which and report it.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 9: Commit**

```bash
git add -- packages/host/src/secrets/instance.ts packages/host/test/secrets/instance.test.ts
git commit -m "Resolve a credential the same way everywhere, and make storing one the thing that invalidates it" -- packages/host/src/secrets/instance.ts packages/host/test/secrets/instance.test.ts
```

---

### Task 4: The config document on disk

**Files:**
- Create: `packages/host/src/config/file.ts`
- Test: `packages/host/test/config/file.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ConfigDocument = Readonly<Record<string, unknown>>`
  - `readConfigDocument(path: string): Promise<ConfigDocument>` — `{}` when the file is absent; throws when it is unparseable or is not a JSON object.
  - `writeConfigDocument(path: string, document: ConfigDocument): Promise<void>` — atomic.

- [ ] **Step 1: Write the failing tests**

Create `packages/host/test/config/file.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfigDocument, writeConfigDocument } from '../../src/config/file.ts';

const withDir = async (body: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-config-'));
  try { await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test('an absent file reads as an empty document', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readConfigDocument(join(dir, 'nope.json')), {});
  });
});

test('a document round-trips', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'pickarr.config.json');
    await writeConfigDocument(path, { server: { port: 9000 } });
    assert.deepEqual(await readConfigDocument(path), { server: { port: 9000 } });
  });
});

test('unparseable json throws rather than reading as empty', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'pickarr.config.json');
    await writeFile(path, '{ this is not json');
    await assert.rejects(() => readConfigDocument(path), /is not valid json/);
  });
});

test('a json value that is not an object throws', async () => {
  await withDir(async (dir) => {
    for (const contents of ['[]', '"a string"', '3', 'null']) {
      const path = join(dir, 'pickarr.config.json');
      await writeFile(path, contents);
      await assert.rejects(() => readConfigDocument(path), /must be a json object/, `${contents} must be refused`);
    }
  });
});

test('the write is atomic: no temp file is left behind, and the file is never partially written', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'pickarr.config.json');
    await writeConfigDocument(path, { server: { port: 9000 } });
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['pickarr.config.json'], 'only the target must remain');
    const text = await readFile(path, 'utf8');
    assert.equal(JSON.parse(text).server.port, 9000);
    assert.ok(text.endsWith('\n'), 'a config file a human edits ends with a newline');
  });
});

test('a rewrite replaces the whole document rather than merging', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'pickarr.config.json');
    await writeConfigDocument(path, { server: { port: 9000 }, plugin: { a: 1 } });
    await writeConfigDocument(path, { server: { port: 9001 } });
    assert.deepEqual(await readConfigDocument(path), { server: { port: 9001 } });
  });
});
```

The last test states the deliberate division of labour: `file.ts` does not merge. Preserving an unknown namespace is `instance.ts`'s job, in Task 5, and putting it in both would mean two places to get it wrong.

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/config/file.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/file.ts'`.

- [ ] **Step 3: Write `file.ts`**

```ts
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The config file as JSON, before any schema has seen it. Its keys are
 * namespaces; what is under each is that namespace's business.
 */
export type ConfigDocument = Readonly<Record<string, unknown>>;

/**
 * Reads the document, or `{}` when the file does not exist.
 *
 * Absent and empty are the same thing on a first boot, so an absent file is
 * not an error. **Unparseable is** -- reading a hand-edit with a trailing
 * comma as "no configuration" would silently run the host on defaults, and
 * the next write would overwrite the edit. See `writeConfigDocument`'s
 * counterpart guarantee.
 */
export async function readConfigDocument(path: string): Promise<ConfigDocument> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // The parser's own message carries an offset into the file, not a path,
    // but it is also not useful to an operator. The path is deliberately
    // absent: no message in this repo may carry one.
    throw new Error('the config file is not valid json');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the config file must be a json object whose keys are namespaces');
  }
  return parsed as ConfigDocument;
}

/**
 * Writes the document to a temp file in the same directory and renames it
 * over the target.
 *
 * `rename` within a directory is atomic, so a reader sees either the old file
 * or the new one and never a half-written one -- which matters because the
 * host reads this file at boot and a crash mid-write would otherwise leave an
 * unbootable install. The temp file is in the *same* directory because
 * `rename` across filesystems fails, and `/config` is a mounted volume.
 */
export async function writeConfigDocument(path: string, document: ConfigDocument): Promise<void> {
  const temp = join(dirname(path), `.${Date.now()}.${process.pid}.config.tmp`);
  await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --conditions development --test packages/host/test/config/file.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation A — prove unparseable is not read as empty**

Copy `file.ts` aside. Change the `JSON.parse` catch to `return {};`, run the focused test.
Expected: `unparseable json throws rather than reading as empty` FAILS — the promise resolves where a rejection was expected.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 6: Mutation B — prove the write is via rename, not in place**

Copy aside. Replace the body of `writeConfigDocument` with a direct `await writeFile(path, ...)`, run the focused test.
Expected: `the write is atomic` **passes** — a direct write leaves no temp file either, so the existing assertions cannot tell the two apart. That is the honest result: record it. Then add the assertion that can, and keep it:

```ts
test('the temp file is created in the target directory, so the rename cannot cross a filesystem', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'pickarr.config.json');
    const seen: string[] = [];
    const writing = writeConfigDocument(path, { server: { port: 9000 } });
    // Sampled while the write is in flight: the temp entry must be a sibling
    // of the target, never in os.tmpdir().
    seen.push(...await readdir(dir));
    await writing;
    assert.ok(
      seen.some((entry) => entry.endsWith('.config.tmp')) || seen.includes('pickarr.config.json'),
      'a temp sibling or the finished file must have been visible',
    );
  });
});
```

Re-apply Mutation B with that test present and report whether it now fails. If it still cannot isolate the rename, say so plainly — `rename`'s atomicity is a filesystem property this suite cannot observe from one process, and the reason it is used stands on the comment and the `dirname` join rather than on a test.

- [ ] **Step 7: Run the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run test-hygiene`
Expected: typecheck 0; tests 1971 pass 0 fail (1964 + 7); lint 0 with exactly 124 warnings; hygiene 0.

- [ ] **Step 8: Commit**

```bash
git add -- packages/host/src/config/file.ts packages/host/test/config/file.test.ts
git commit -m "Read the config file, refusing a bad hand-edit rather than treating it as no configuration" -- packages/host/src/config/file.ts packages/host/test/config/file.test.ts
```

---

### Task 5: `openConfig` and `register`

**Files:**
- Create: `packages/host/src/config/instance.ts`
- Test: `packages/host/test/config/instance.test.ts`

**Interfaces:**
- Consumes: `ConfigDocument`, `readConfigDocument`, `writeConfigDocument` from `config/file.ts`; `zod`.
- Produces:
  - `interface ConfigHandle<T> { readonly current: T; update(next: T): Promise<void> }`
  - `interface Config { register<T>(namespace: string, schema: ZodType<T>): ConfigHandle<T> }`
  - `openConfig(deps: { path: string }): Promise<Config>`

- [ ] **Step 1: Write the failing tests**

Create `packages/host/test/config/instance.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { openConfig } from '../../src/config/instance.ts';

const withPath = async (body: (path: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-config-'));
  try { await body(join(dir, 'pickarr.config.json')); } finally { await rm(dir, { recursive: true, force: true }); }
};

const portSchema = z.object({ port: z.number().int().default(8787) }).default({});

test('an absent section gets the schema defaults', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    assert.deepEqual(config.register('server', portSchema).current, { port: 8787 });
  });
});

test('a present section is parsed', async () => {
  await withPath(async (path) => {
    await writeFile(path, JSON.stringify({ server: { port: 9000 } }));
    const config = await openConfig({ path });
    assert.deepEqual(config.register('server', portSchema).current, { port: 9000 });
  });
});

test('a present but invalid section throws from register, naming the namespace', async () => {
  await withPath(async (path) => {
    await writeFile(path, JSON.stringify({ server: { port: 'not a number' } }));
    const config = await openConfig({ path });
    assert.throws(() => config.register('server', portSchema), /server/);
  });
});

test('a schema that does not accept undefined throws for an absent section', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    // Deliberate: design spec 2.6c. A namespace that wants to be optional
    // must carry its own defaults; this is the constraint, not a bug.
    assert.throws(() => config.register('server', z.object({ port: z.number() })), /server/);
  });
});

test('update writes the new value and moves current', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    const handle = config.register('server', portSchema);
    await handle.update({ port: 9001 });
    assert.deepEqual(handle.current, { port: 9001 });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).server, { port: 9001 });
  });
});

test('update leaves an unknown namespace byte-identical', async () => {
  await withPath(async (path) => {
    await writeFile(path, JSON.stringify({ plugin_scenes: { nested: { deep: [1, 2, 3] } } }, null, 2));
    const config = await openConfig({ path });
    await config.register('server', portSchema).update({ port: 9001 });
    const after = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(after.plugin_scenes, { nested: { deep: [1, 2, 3] } }, 'an unknown namespace must survive');
    assert.deepEqual(after.server, { port: 9001 });
  });
});

test('two concurrent updates on different namespaces both survive', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    const server = config.register('server', portSchema);
    const secrets = config.register('secrets', z.object({ baseDir: z.string().default('/run/secrets') }).default({}));
    await Promise.all([server.update({ port: 9002 }), secrets.update({ baseDir: '/tmp/s' })]);
    const after = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(after.server, { port: 9002 }, 'the server update must not be lost');
    assert.deepEqual(after.secrets, { baseDir: '/tmp/s' }, 'the secrets update must not be lost');
  });
});

test('an update refuses rather than overwriting a file that became unparseable', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    const handle = config.register('server', portSchema);
    await writeFile(path, '{ broken');
    await assert.rejects(() => handle.update({ port: 9003 }), /is not valid json/);
    assert.equal(await readFile(path, 'utf8'), '{ broken', 'the hand-edit must survive');
  });
});

test('a namespace registered twice throws', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    config.register('server', portSchema);
    assert.throws(() => config.register('server', portSchema), /already registered/);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/config/instance.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/instance.ts'`.

- [ ] **Step 3: Write `instance.ts`**

```ts
import type { ZodType } from 'zod';
import type { ConfigDocument } from './file.ts';
import { readConfigDocument, writeConfigDocument } from './file.ts';

export interface ConfigHandle<T> {
  /** The validated value for this namespace, as of the last read or update. */
  readonly current: T;
  /** Replaces this namespace's section, leaving every other namespace untouched. */
  update(next: T): Promise<void>;
}

export interface Config {
  /**
   * Claims a namespace and validates its section.
   *
   * The schema must accept `undefined`, because an absent section is parsed
   * as `undefined` -- so a namespace that wants to be optional carries its
   * own defaults (design spec §2.6c).
   */
  register<T>(namespace: string, schema: ZodType<T>): ConfigHandle<T>;
}

/**
 * The config file, as one namespace per subsystem.
 *
 * Two properties drive the shape:
 *
 * **An unknown namespace survives a write.** `update` re-reads the document
 * from disk and replaces only its own key, so a host that knows nothing about
 * a plugin's section cannot delete it. That is also why the document is not
 * cached for writing: the copy read at boot may be older than the file.
 *
 * **Writes are serialized.** Every `update` joins one promise chain, so two
 * concurrent calls cannot interleave their read-modify-write and lose one of
 * the two sections. Without it, the second read can happen before the first
 * write, and the first update vanishes with nothing to show it ever ran.
 */
export async function openConfig(deps: { path: string }): Promise<Config> {
  const atOpen: ConfigDocument = await readConfigDocument(deps.path);
  const claimed = new Set<string>();
  // The tail of the write chain. Each update awaits its predecessor, so the
  // read-modify-write pairs never interleave.
  let queue: Promise<void> = Promise.resolve();

  return {
    register<T>(namespace: string, schema: ZodType<T>): ConfigHandle<T> {
      if (claimed.has(namespace)) {
        throw new Error(`config namespace ${JSON.stringify(namespace)} is already registered`);
      }
      claimed.add(namespace);

      let current: T;
      try {
        current = schema.parse(atOpen[namespace]);
      } catch (error) {
        // The namespace is named because a schema error alone does not say
        // which section was wrong. The raw value is *not* included: a
        // namespace may hold anything, and this message is logged.
        throw new Error(
          `config namespace ${JSON.stringify(namespace)} is invalid: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return {
        get current(): T {
          return current;
        },
        async update(next: T): Promise<void> {
          const validated = schema.parse(next);
          const run = queue.then(async () => {
            const document = await readConfigDocument(deps.path);
            await writeConfigDocument(deps.path, { ...document, [namespace]: validated });
            current = validated;
          });
          // The chain must advance even when this update fails, or one
          // rejection would wedge every later write. The caller still sees
          // the rejection through `run`.
          queue = run.then(() => undefined, () => undefined);
          return run;
        },
      };
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --conditions development --test packages/host/test/config/instance.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 1980 pass 0 fail (1971 + 9); lint 0 with exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 6: Mutation A — prove the unknown namespace is preserved by the re-read**

Copy `instance.ts` aside. In `update`, replace the re-read with the boot-time copy: `const document = atOpen;`, run the focused test.
Expected: `update leaves an unknown namespace byte-identical` still passes (the boot copy has the namespace too), but `two concurrent updates on different namespaces both survive` FAILS — one of the two sections is missing, because both writes start from the same stale document. Report which section lost; it is whichever update ran second.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 7: Mutation B — prove the queue is what serializes**

Copy aside. Delete the `queue.then(...)` wrapper so each update does its read-modify-write immediately (`const run = (async () => { ... })();`), run the focused test.
Expected: `two concurrent updates on different namespaces both survive` FAILS. If it passes, the interleaving is not being provoked — the two updates are resolving in sequence by luck of the microtask order. In that case say so, and make the race explicit by awaiting nothing between the two `update` calls while forcing the first read to yield; do not report a kill you did not get.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 8: Mutation C — prove a failed update cannot wedge the chain**

Copy aside. Change `queue = run.then(() => undefined, () => undefined);` to `queue = run;`, and add this test:

```ts
test('a failed update does not wedge later writes', async () => {
  await withPath(async (path) => {
    const config = await openConfig({ path });
    const handle = config.register('server', portSchema);
    await writeFile(path, '{ broken');
    await assert.rejects(() => handle.update({ port: 9003 }), /is not valid json/);
    await writeFile(path, '{}');
    await handle.update({ port: 9004 });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).server, { port: 9004 });
  });
});
```

Expected: with the mutation, the new test FAILS — the second `update` never runs because the chain's tail is a rejected promise. Keep the test; restore the line.
Restore by copy-aside, `md5 -q`, re-run. Test count becomes 1981.

- [ ] **Step 9: Commit**

```bash
git add -- packages/host/src/config/instance.ts packages/host/test/config/instance.test.ts
git commit -m "Give each subsystem a namespace it owns, and re-read before writing so it cannot delete another's" -- packages/host/src/config/instance.ts packages/host/test/config/instance.test.ts
```

---

### Task 6: The host's namespaces, and one origin check for both callers

**Files:**
- Create: `packages/host/src/origin.ts`
- Create: `packages/host/src/config/schemas.ts`
- Modify: `packages/host/src/main.ts:289-308` (`resolvePublicUrl` delegates)
- Test: `packages/host/test/config/schemas.test.ts`, `packages/host/test/origin.test.ts`

**Interfaces:**
- Consumes: `zod`.
- Produces:
  - `assertOriginOnly(value: string, label: string): void`
  - `serverConfigSchema`, `databaseConfigSchema`, `secretsConfigSchema`
  - `DEFAULT_CONFIG_PATH = '/config/pickarr.config.json'`
  - Types `ServerConfig`, `DatabaseConfig`, `SecretsConfig` via `z.infer`.

**Why this task exists as its own gate:** slice F's B1 was a `PICKARR_PUBLIC_URL` carrying a path, accepted, which silently unmounted every auth route while `/api/health` still answered 200. The config file is a second way to supply that value. Copying the check would mean two places to fix it next time, so it moves to one function that both callers use.

- [ ] **Step 1: Write the failing origin tests**

Create `packages/host/test/origin.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOriginOnly } from '../src/origin.ts';

test('an origin is accepted, with or without a trailing slash', () => {
  for (const value of ['http://host', 'https://host', 'http://host:8787', 'https://host/', 'http://127.0.0.1:8787']) {
    assert.doesNotThrow(() => { assertOriginOnly(value, 'LABEL'); }, `${value} must be accepted`);
  }
});

test('everything that unmounts the auth routes is refused, and the label is in the message', () => {
  const cases: [string, RegExp][] = [
    ['http://host/pickarr', /no path/],
    ['http://host/a/b', /no path/],
    ['http://host?x=1', /query string/],
    ['http://host#f', /fragment/],
    ['ws://host', /http or https/],
    ['not a url', /not a url/],
  ];
  for (const [value, expected] of cases) {
    assert.throws(() => { assertOriginOnly(value, 'LABEL'); }, expected, `${value} must be refused`);
    assert.throws(() => { assertOriginOnly(value, 'LABEL'); }, /LABEL/, `${value}'s message must name the label`);
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/origin.test.ts`
Expected: FAIL — `Cannot find module '../src/origin.ts'`.

- [ ] **Step 3: Write `origin.ts`**

```ts
/**
 * Refuses anything that is not a bare origin, for every caller that supplies
 * one.
 *
 * There are two: `PICKARR_PUBLIC_URL` and the config file's
 * `server.publicUrl`. They share this function rather than a copy of it,
 * because of what the auth slice measured when only one of them checked: a
 * value carrying a path is accepted, becomes Better Auth's `baseURL`, and
 * every `/api/auth/*` route then answers 404 with an empty body -- nobody can
 * sign in, sign up or sign out, cookies issued earlier keep working, and
 * `/api/health` still answers 200, so a container health check reports the
 * host healthy. Nothing is logged. A query string and a fragment do the same
 * thing, which is why all three are refused.
 *
 * `label` names the source so the message says which of the two was wrong.
 * The value itself is never in the message: it is a url, and no log line in
 * this repo may carry one.
 */
export function assertOriginOnly(value: string, label: string): void {
  if (!URL.canParse(value)) {
    throw new Error(`${label} is not a url`);
  }
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} is not an http or https url`);
  }
  if (url.pathname !== '/') {
    throw new Error(`${label} must have no path: its pathname must be /`);
  }
  if (url.search !== '') {
    throw new Error(`${label} must have no query string`);
  }
  if (url.hash !== '') {
    throw new Error(`${label} must have no fragment`);
  }
}
```

- [ ] **Step 4: Point `resolvePublicUrl` at it**

Replace the body of `resolvePublicUrl` in `packages/host/src/main.ts` (lines 289-308) with:

```ts
export function resolvePublicUrl(configured: string | undefined): string | undefined {
  if (configured === undefined || configured === '') return undefined;
  assertOriginOnly(configured, 'PICKARR_PUBLIC_URL');
  return configured;
}
```

Add `import { assertOriginOnly } from './origin.ts';` to `main.ts`. Then **read the docblock above `resolvePublicUrl`**: it explains the checks that have just moved. Leave the part that is about `PICKARR_PUBLIC_URL` specifically, move or delete the part that describes the checks, and point at `origin.ts` for them. A docblock that still explains a body it no longer has is the defect class this plan's constraints name. `packages/host/test/main.test.ts`'s existing `PICKARR_PUBLIC_URL` tests must still pass unchanged — they are the proof this refactor changed no behaviour.

- [ ] **Step 5: Write the failing schema tests**

Create `packages/host/test/config/schemas.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfigSchema, secretsConfigSchema, serverConfigSchema } from '../../src/config/schemas.ts';

test('every host namespace parses an absent section into its defaults', () => {
  assert.deepEqual(serverConfigSchema.parse(undefined), { host: '0.0.0.0', port: 8787 });
  assert.deepEqual(databaseConfigSchema.parse(undefined), { path: '/config/pickarr.db' });
  assert.deepEqual(secretsConfigSchema.parse(undefined), { baseDir: '/run/secrets' });
});

test('the server defaults match what the auth slice chose', () => {
  const parsed = serverConfigSchema.parse(undefined);
  // 0.0.0.0 because a session is what protects the socket now, not the
  // interface it listens on.
  assert.equal(parsed.host, '0.0.0.0');
  assert.equal(parsed.port, 8787);
});

test('a publicUrl with a path is refused in the file, exactly as it is in the environment', () => {
  for (const publicUrl of ['http://host/pickarr', 'http://host?x=1', 'http://host#f', 'ws://host', 'nope']) {
    assert.throws(() => serverConfigSchema.parse({ publicUrl }), `${publicUrl} must be refused`);
  }
  assert.doesNotThrow(() => serverConfigSchema.parse({ publicUrl: 'https://host' }));
});

test('a port outside the legal range is refused', () => {
  for (const port of [0, -1, 65536, 1.5]) {
    assert.throws(() => serverConfigSchema.parse({ port }), `${port} must be refused`);
  }
  assert.doesNotThrow(() => serverConfigSchema.parse({ port: 1 }));
  assert.doesNotThrow(() => serverConfigSchema.parse({ port: 65535 }));
});

test('an unknown key inside a namespace is refused rather than silently dropped', () => {
  assert.throws(() => serverConfigSchema.parse({ prot: 8787 }), /unrecognized|unknown/i);
});
```

The last one matters: a typo like `prot` that parses to the default would be a configuration change that does nothing and says nothing.

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/config/schemas.test.ts`
Expected: FAIL — `Cannot find module '../../src/config/schemas.ts'`.

- [ ] **Step 7: Write `schemas.ts`**

```ts
import { z } from 'zod';
import { assertOriginOnly } from '../origin.ts';

/** Where the config file lives when `PICKARR_CONFIG` says nothing -- beside the database's own default. */
export const DEFAULT_CONFIG_PATH = '/config/pickarr.config.json';

/**
 * Every namespace is `.strict()` and `.default({})`.
 *
 * `.strict()` because a typo that parses to a default is a configuration
 * change that does nothing and reports nothing. `.default({})` because an
 * absent section reaches `parse` as `undefined`, and a schema without it
 * would make a first boot with no config file throw (design spec §2.6c).
 */
export const serverConfigSchema = z.object({
  // 0.0.0.0, not loopback: from the auth slice on, a session is what protects
  // this socket rather than the interface it listens on.
  host: z.string().min(1).default('0.0.0.0'),
  port: z.number().int().min(1).max(65535).default(8787),
  // Optional with no default: absent means "derive it from the bind address",
  // which is not a value this schema can compute.
  publicUrl: z.string()
    .superRefine((value, ctx) => {
      try {
        assertOriginOnly(value, 'server.publicUrl');
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof Error ? error.message : 'server.publicUrl is not an origin',
        });
      }
    })
    .optional(),
}).strict().default({});

export const databaseConfigSchema = z.object({
  path: z.string().min(1).default('/config/pickarr.db'),
}).strict().default({});

export const secretsConfigSchema = z.object({
  baseDir: z.string().min(1).default('/run/secrets'),
}).strict().default({});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;
```

- [ ] **Step 8: Run the tests and the gate**

Run: `node --import tsx --conditions development --test packages/host/test/config/schemas.test.ts packages/host/test/origin.test.ts packages/host/test/main.test.ts`
Expected: PASS. `main.test.ts` passing unchanged is what proves step 4 was a refactor.

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 1988 pass 0 fail (1981 + 7); lint 0 with exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 9: Mutation A — prove one check now serves both callers**

Copy `origin.ts` aside. Delete the `url.pathname !== '/'` block, run both suites.
Expected: **both** fail — `main.test.ts`'s `PICKARR_PUBLIC_URL` path case and `schemas.test.ts`'s `publicUrl` path case. Two failures from one deleted line is the whole point of this task; one failure means a caller is not going through `assertOriginOnly`.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 10: Mutation B — prove `.strict()` is what catches a typo**

Copy `schemas.ts` aside. Remove `.strict()` from `serverConfigSchema`, run the focused test.
Expected: `an unknown key inside a namespace is refused rather than silently dropped` FAILS — `{ prot: 8787 }` parses to the defaults.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 11: Commit**

```bash
git add -- packages/host/src/origin.ts packages/host/src/config/schemas.ts packages/host/src/main.ts packages/host/test/origin.test.ts packages/host/test/config/schemas.test.ts
git commit -m "Check an origin in one place, so the config file cannot reintroduce what the environment now refuses" -- packages/host/src/origin.ts packages/host/src/config/schemas.ts packages/host/src/main.ts packages/host/test/origin.test.ts packages/host/test/config/schemas.test.ts
```

---

### Task 7: Migration 14 — `download_client` stores a name, and `readClientConfig` resolves it

**Files:**
- Modify: `packages/host/src/db/migrate.ts` (add `MIGRATION_14` as a function, add to `HOST_MIGRATIONS`)
- Modify: `packages/host/src/db/schema.ts` (`downloadClient` columns)
- Modify: `packages/host/src/clients/config.ts` (`readClientConfig` async, `ClientRow`, `readRow`)
- Modify: `packages/host/src/clients/reconcile-job.ts:275`, `packages/host/src/clients/downloads.ts:221` (one `await` each)
- Test: `packages/host/test/db/migrate.test.ts`, `packages/host/test/clients/config.test.ts`

**Interfaces:**
- Consumes: `Secrets` from `secrets/instance.ts`; `writeSecretValue` from `secrets/store.ts`.
- Produces: `readClientConfig(raw: DatabaseSync, clientId: number, secrets: Secrets): Promise<ClientConfig>`. `ClientConfig`'s members are unchanged — `apiKey` and `password` still carry the **resolved credential**, so no adapter changes.

**The strategy decision does not need a resolved secret.** Which auth strategy a qBittorrent row uses is decided by whether `api_key_secret_name` is present, exactly as it used to be decided by `api_key`. Resolve *after* choosing, and resolve only the one the chosen strategy needs — one secret for sabnzbd and for bearer, one for login (the username stays plaintext).

- [ ] **Step 1: Write the failing migration test**

Add to `packages/host/test/db/migrate.test.ts`:

```ts
test('migration 14 moves a credential into secret and leaves a name behind', () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 13));
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'sab', 'nzb', 'http://sab', 'sab-api-key', null, null, 'movies', 'move', 1, 1, 'sabnzbd');
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 'qbt', 'torrent', 'http://qbt', null, 'admin', 'qbt-password', 'movies', 'move', 1, 1, 'qbittorrent');

  migrateHost(raw);

  const rows = raw.prepare('SELECT id, username, api_key_secret_name, password_secret_name FROM download_client ORDER BY id').all();
  const sab = rows[0] as Record<string, unknown>;
  const qbt = rows[1] as Record<string, unknown>;

  assert.match(String(sab['api_key_secret_name']), /^[0-9a-f-]{36}$/, 'the api key must be replaced by a uuid');
  assert.equal(sab['password_secret_name'], null);
  assert.equal(qbt['api_key_secret_name'], null);
  assert.match(String(qbt['password_secret_name']), /^[0-9a-f-]{36}$/, 'the password must be replaced by a uuid');
  assert.equal(qbt['username'], 'admin', 'a username is not a credential and must not move');

  // The credentials are now in `secret`, addressed by those names.
  const value = (name: unknown) => String(
    (raw.prepare('SELECT value FROM secret WHERE name = ?').get(String(name)) as { value: unknown }).value,
  );
  assert.equal(value(sab['api_key_secret_name']), 'sab-api-key');
  assert.equal(value(qbt['password_secret_name']), 'qbt-password');
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM secret').get()?.c), 2, 'one secret per moved credential');

  // The old columns are gone.
  const columns = raw.prepare('PRAGMA table_info(download_client)').all()
    .map((row) => String((row as { name: unknown }).name));
  assert.ok(!columns.includes('api_key'), 'api_key must be dropped');
  assert.ok(!columns.includes('password'), 'password must be dropped');
  assert.ok(columns.includes('username'), 'username must remain');
});

test('a row resolves to the same ClientConfig after migration 14 as before it', async () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 13));
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'sab', 'nzb', 'http://sab', 'sab-api-key', null, null, 'movies', 'move', 1, 1, 'sabnzbd');
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2, 'qbt', 'torrent', 'http://qbt', null, 'admin', 'qbt-password', 'movies', 'move', 1, 1, 'qbittorrent');

  // What the old, pre-migration code produced for these two rows, by hand --
  // this is the contract the indirection must not change.
  const before = [
    { kind: 'sabnzbd', id: 1, baseUrl: 'http://sab', apiKey: 'sab-api-key', category: 'movies' },
    { kind: 'qbittorrent-login', id: 2, baseUrl: 'http://qbt', username: 'admin', password: 'qbt-password', category: 'movies' },
  ];

  migrateHost(raw);
  const secrets = createSecrets({ raw, baseDir: '/nonexistent-secrets-dir' });
  const after = [await readClientConfig(raw, 1, secrets), await readClientConfig(raw, 2, secrets)];

  assert.deepEqual(after, before, 'the indirection must be invisible to every caller');
});

test('migration 14 leaves a row with no credential alone', () => {
  const { raw } = openTestDatabase();
  migrateHostWith(raw, HOST_MIGRATIONS.filter((m) => m.version <= 13));
  raw.prepare(`
    INSERT INTO download_client (id, name, type, url, api_key, username, password, category, import_mode, created_at, updated_at, implementation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(1, 'bare', 'torrent', 'http://qbt', null, null, null, 'movies', 'move', 1, 1, 'qbittorrent');
  migrateHost(raw);
  const row = raw.prepare('SELECT api_key_secret_name, password_secret_name FROM download_client WHERE id = 1').get();
  assert.equal((row as Record<string, unknown>)['api_key_secret_name'], null);
  assert.equal((row as Record<string, unknown>)['password_secret_name'], null);
  assert.equal(Number(raw.prepare('SELECT count(*) c FROM secret').get()?.c), 0, 'no secret row for a row with no credential');
});
```

`migrateHostWith` and `HOST_MIGRATIONS` must both be exported for this test to stage the database at version 13. Check whether they already are; export what is missing.

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/db/migrate.test.ts`
Expected: FAIL — `no such column: api_key_secret_name`.

- [ ] **Step 3: Add `MIGRATION_14`**

In `packages/host/src/db/migrate.ts`, add the import `import { randomUUID } from 'node:crypto';` and, after `MIGRATION_13`:

```ts
/**
 * Moves every `download_client` credential into `secret` and leaves a
 * `randomUUID()` naming it.
 *
 * A function rather than a SQL string because it generates a name per
 * credential. It runs inside the savepoint `migrateHostWith` opens, so a
 * throw part-way through leaves neither a half-moved credential nor a
 * recorded version -- which is the only reason it is safe to read, insert,
 * update and drop in sequence.
 *
 * `username` is untouched: it is not a credential. `api_key` and `password`
 * are dropped, so the credential exists in exactly one place afterwards.
 *
 * **No credential value appears in any log line or error here.** The `name`
 * of a client is safe to name; its `api_key` is not.
 */
function migration14(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE download_client ADD COLUMN api_key_secret_name  TEXT;
    ALTER TABLE download_client ADD COLUMN password_secret_name TEXT;
  `);

  const rows = db.prepare('SELECT id, api_key, password FROM download_client').all();
  const insertSecret = db.prepare(
    'INSERT INTO secret (name, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
  );
  const setApiKeyName = db.prepare('UPDATE download_client SET api_key_secret_name = ? WHERE id = ?');
  const setPasswordName = db.prepare('UPDATE download_client SET password_secret_name = ? WHERE id = ?');
  const at = Date.now();

  for (const row of rows) {
    const id = Number((row as { id: unknown }).id);
    const apiKey = (row as { api_key: unknown }).api_key;
    const password = (row as { password: unknown }).password;

    if (typeof apiKey === 'string' && apiKey !== '') {
      const name = randomUUID();
      insertSecret.run(name, apiKey, at, at);
      setApiKeyName.run(name, id);
    }
    if (typeof password === 'string' && password !== '') {
      const name = randomUUID();
      insertSecret.run(name, password, at, at);
      setPasswordName.run(name, id);
    }
  }

  db.exec(`
    ALTER TABLE download_client DROP COLUMN api_key;
    ALTER TABLE download_client DROP COLUMN password;
  `);
}
```

Then add to `HOST_MIGRATIONS`:

```ts
  { version: 14, up: (db) => migration14(db) },
```

SQLite is 3.53.4 behind `node:sqlite`, and `ADD COLUMN`/`DROP COLUMN` were measured to work on a table carrying an index on a different column (design spec §2.6b), so no table rebuild is needed. `download_client`'s only index is `download_client_name`, on `name`.

- [ ] **Step 4: Update the mirror**

In `packages/host/src/db/schema.ts`, in `downloadClient`, replace `apiKey: text('api_key'),` and `password: text('password'),` with:

```ts
  // The `secret` name for this client's api key, not the key -- a
  // `randomUUID()` resolved through `Secrets.get`. Nullable: a row
  // authenticating with a username and password has none. Migration 14
  // replaced the credential columns with these, so a credential lives in
  // `secret` and in nothing else.
  apiKeySecretName: text('api_key_secret_name'),
  // The `secret` name for this client's password. `username` beside it is
  // plaintext on purpose: a username is not a credential.
  passwordSecretName: text('password_secret_name'),
```

Keep `username: text('username'),` where it is. Then grep `schema.ts` and `clients/` for `api_key`, `apiKey` and `password` and fix every comment that describes those columns as holding a credential — including `reconcile-job.ts`'s module doc, which names `api_key`, `username` and `password` as the columns only `readClientConfig` may read.

- [ ] **Step 5: Write the failing `readClientConfig` tests**

In `packages/host/test/clients/config.test.ts`, every existing test needs the new shape. Add these, and convert the existing ones to `await`:

```ts
test('a sabnzbd row resolves its api key through the secrets subsystem', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const secrets = createSecrets({ raw, baseDir: '/nonexistent-secrets-dir' });
  secrets.saveSecret('a3f1b2c4-0000-4000-8000-000000000001', 'sab-api-key');
  insertClient(raw, { id: 1, implementation: 'sabnzbd', type: 'nzb', apiKeySecretName: 'a3f1b2c4-0000-4000-8000-000000000001' });

  const config = await readClientConfig(raw, 1, secrets);
  assert.equal(config.kind, 'sabnzbd');
  assert.equal(config.kind === 'sabnzbd' ? config.apiKey : null, 'sab-api-key', 'the resolved credential, not the name');
});

test('a qbittorrent row with an api key name uses bearer, and one with a password name uses login', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const secrets = createSecrets({ raw, baseDir: '/nonexistent-secrets-dir' });
  secrets.saveSecret('a3f1b2c4-0000-4000-8000-000000000002', 'qbt-api-key');
  secrets.saveSecret('a3f1b2c4-0000-4000-8000-000000000003', 'qbt-password');
  insertClient(raw, { id: 1, implementation: 'qbittorrent', type: 'torrent', apiKeySecretName: 'a3f1b2c4-0000-4000-8000-000000000002' });
  insertClient(raw, { id: 2, implementation: 'qbittorrent', type: 'torrent', username: 'admin', passwordSecretName: 'a3f1b2c4-0000-4000-8000-000000000003' });

  const bearer = await readClientConfig(raw, 1, secrets);
  assert.equal(bearer.kind, 'qbittorrent-bearer');
  const login = await readClientConfig(raw, 2, secrets);
  assert.equal(login.kind, 'qbittorrent-login');
  assert.equal(login.kind === 'qbittorrent-login' ? login.password : null, 'qbt-password');
  assert.equal(login.kind === 'qbittorrent-login' ? login.username : null, 'admin');
});

test('a row naming a secret that does not resolve fails with SecretNotFound, and the message carries no credential', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const secrets = createSecrets({ raw, baseDir: '/nonexistent-secrets-dir' });
  insertClient(raw, { id: 1, implementation: 'sabnzbd', type: 'nzb', apiKeySecretName: 'a3f1b2c4-0000-4000-8000-000000000004' });
  await assert.rejects(() => readClientConfig(raw, 1, secrets), SecretNotFound);
});

test('the strategy is chosen before any secret is resolved', async () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  const secrets = createSecrets({ raw, baseDir: '/nonexistent-secrets-dir' });
  // No secret rows at all. A qbittorrent row with neither name must fail on
  // its own missing configuration, not on a secret lookup.
  insertClient(raw, { id: 1, implementation: 'qbittorrent', type: 'torrent' });
  await assert.rejects(
    () => readClientConfig(raw, 1, secrets),
    /neither an api key nor a username and password/,
  );
});
```

`insertClient` is a helper this file already has or needs; it must take `apiKeySecretName`, `passwordSecretName` and `username` and write the new columns.

- [ ] **Step 6: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/clients/config.test.ts`
Expected: FAIL — `readClientConfig` takes two parameters, so the three-argument calls are a typecheck error under `tsx`.

- [ ] **Step 7: Rewrite `readClientConfig`**

In `packages/host/src/clients/config.ts`: change `ClientRow`'s `apiKey: string | null` and `password: string | null` to `apiKeySecretName: string | null` and `passwordSecretName: string | null`; change `readRow`'s `SELECT` to `id, name, type, implementation, url, api_key_secret_name, username, password_secret_name, category`; and make the function:

```ts
export async function readClientConfig(
  raw: DatabaseSync,
  clientId: number,
  secrets: Secrets,
): Promise<ClientConfig> {
```

Inside, keep every existing check and error message, replacing `row.apiKey !== null` with `row.apiKeySecretName !== null` and `row.password !== null` with `row.passwordSecretName !== null`, and resolving only the secret the chosen strategy needs:

```ts
    case 'sabnzbd': {
      // ... the existing type check, unchanged ...
      if (row.apiKeySecretName === null) {
        throw new Error(`download client ${row.id} (${row.name}) is sabnzbd but has no api key`);
      }
      return {
        kind: 'sabnzbd',
        id: row.id,
        baseUrl: row.baseUrl,
        apiKey: await secrets.get(row.apiKeySecretName),
        category: row.category,
      };
    }
```

and for qBittorrent, the same shape: decide on the *name*, then `await secrets.get(...)` for the one credential that strategy uses. Update the docblock that says the row's credentials must never be serialised — the row no longer holds any, and the reason that comment exists has changed. Say what is true now: the row holds names, which are safe to log, and the resolved credential is what must not be.

- [ ] **Step 8: Add the `await` at both call sites**

`packages/host/src/clients/reconcile-job.ts:275` becomes `const config = await readClientConfig(deps.raw, clientId, deps.secrets);` and `packages/host/src/clients/downloads.ts:221` becomes `const config = await readClientConfig(raw, submission.downloadClientId, secrets);`. Both enclosing functions are already `async`. Thread `secrets: Secrets` into `createReconcileHandler`'s and `createDownloadClients`' `deps`, and update every test that constructs them.

- [ ] **Step 9: Run the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests 1995 pass 0 fail (1988 + 7, plus any existing `config.test.ts` tests that were converted rather than added); lint 0 with exactly 124 warnings; build 0; hygiene 0.

- [ ] **Step 10: Mutation A — prove the migration moves the value rather than the name**

Copy `migrate.ts` aside. In `migration14`, change `insertSecret.run(name, apiKey, at, at)` to `insertSecret.run(name, name, at, at)`, run the focused migration test.
Expected: `migration 14 moves a credential into secret and leaves a name behind` FAILS on `value(sab['api_key_secret_name'])` — the uuid where `'sab-api-key'` was expected.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 11: Mutation B — prove `username` is treated as not-a-credential**

Copy aside. Add `username` to the columns `migration14` moves (move it into `secret` and null the column), run the focused test.
Expected: FAILS on `a username is not a credential and must not move`.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 12: Mutation C — prove the strategy is decided before resolution**

Copy `clients/config.ts` aside. In the qBittorrent branch, resolve both secrets up front — `const apiKey = row.apiKeySecretName === null ? null : await secrets.get(row.apiKeySecretName);` and the same for the password — before choosing the strategy. Run the focused test.
Expected: `the strategy is chosen before any secret is resolved` still passes (both names are null in that row), but a row with a *password* name and no api key name now resolves a secret it does not need. Add the assertion that catches it if none does, or report that this mutation has no isolating test and say why — resolving an unused secret is wasted work rather than wrong behaviour, and a test that pins it would have to count lookups.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 13: Commit**

```bash
git add -- packages/host/src/db/migrate.ts packages/host/src/db/schema.ts packages/host/src/clients/config.ts packages/host/src/clients/reconcile-job.ts packages/host/src/clients/downloads.ts packages/host/test/db/migrate.test.ts packages/host/test/clients/config.test.ts
git commit -m "Keep a download client's credential in one place, and a name for it in the row" -- packages/host/src/db/migrate.ts packages/host/src/db/schema.ts packages/host/src/clients/config.ts packages/host/src/clients/reconcile-job.ts packages/host/src/clients/downloads.ts packages/host/test/db/migrate.test.ts packages/host/test/clients/config.test.ts
```

Include every other test file the `deps` change in step 8 touched in both the `add` and the `commit` pathspec.

---

### Task 8: Wire it into `main`, with the environment still winning

**Files:**
- Modify: `packages/host/src/main.ts` (boot order, precedence, the resolvers' signatures)
- Test: `packages/host/test/main.test.ts`

**Interfaces:**
- Consumes: `openConfig`, the three schemas, `DEFAULT_CONFIG_PATH`, `createSecrets`.
- Produces: nothing new for later tasks — this is the last one.

**Precedence is env, then file, then the schema default** (spec §3.7). The schema default *is* the built-in default, so the resolvers stop carrying one: `resolveReadPort` and `resolveReadHost` become "validate this string the operator set", and are called only when the variable is set. Their "undefined means the default" branch becomes unreachable, so it goes, and its tests go with it — a default in two places is one that can disagree with itself.

- [ ] **Step 1: Write the failing precedence tests**

Add to `packages/host/test/main.test.ts`:

```ts
test('the config file supplies host, port and database path when no variable does', async () => {
  await withConfigFile({ server: { host: '127.0.0.1', port: 9100 }, database: { path: '/tmp/from-file.db' } }, async (settings) => {
    assert.equal(settings.readHost, '127.0.0.1');
    assert.equal(settings.port, 9100);
    assert.equal(settings.databasePath, '/tmp/from-file.db');
  });
});

test('an environment variable beats the file', async (t) => {
  process.env['PICKARR_READ_API_PORT'] = '9200';
  process.env['PICKARR_DATABASE'] = '/tmp/from-env.db';
  t.after(() => { delete process.env['PICKARR_READ_API_PORT']; delete process.env['PICKARR_DATABASE']; });
  await withConfigFile({ server: { port: 9100 }, database: { path: '/tmp/from-file.db' } }, async (settings) => {
    assert.equal(settings.port, 9200, 'the variable must win');
    assert.equal(settings.databasePath, '/tmp/from-env.db', 'the variable must win');
  });
});

test('with neither a variable nor a file, the schema defaults apply', async () => {
  await withConfigFile({}, async (settings) => {
    assert.equal(settings.readHost, '0.0.0.0');
    assert.equal(settings.port, 8787);
    assert.equal(settings.databasePath, '/config/pickarr.db');
  });
});

test('a config file with a publicUrl carrying a path refuses the boot', async () => {
  await assert.rejects(
    () => withConfigFile({ server: { publicUrl: 'http://host/pickarr' } }, async () => {}),
    /publicUrl/,
    'the file must not be able to reintroduce the auth slice B1 failure',
  );
});
```

`withConfigFile(document, body)` writes the document to a temp path, sets `PICKARR_CONFIG` to it, calls whatever `main.ts` exports for resolving settings, and cleans up. Export a `resolveSettings` from `main.ts` for it to call rather than booting the whole host — the existing `main.test.ts` tests each resolver in isolation, and this is the same shape one level up.

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --conditions development --test packages/host/test/main.test.ts`
Expected: FAIL — no `resolveSettings` export.

- [ ] **Step 3: Add `resolveSettings` and change the resolvers**

In `packages/host/src/main.ts`:

```ts
/** Every value the boot needs from the environment and the config file, with the environment winning. */
export interface HostSettings {
  readHost: string;
  port: number;
  publicUrl: string | undefined;
  databasePath: string;
  secretsBaseDir: string;
  config: Config;
}

/**
 * Environment, then config file, then the schema's default.
 *
 * The environment has to keep winning: every deployment that exists today
 * sets these variables and nothing else, so a file that overrode them would
 * change a running install on upgrade. The schema carries the default, and
 * the resolvers below only validate a string an operator actually set --
 * a default in both places is one that can disagree with itself.
 */
export async function resolveSettings(env: NodeJS.ProcessEnv): Promise<HostSettings> {
  const config = await openConfig({ path: env['PICKARR_CONFIG'] ?? DEFAULT_CONFIG_PATH });
  const server = config.register('server', serverConfigSchema);
  const database = config.register('database', databaseConfigSchema);
  const secrets = config.register('secrets', secretsConfigSchema);

  const portRaw = env['PICKARR_READ_API_PORT'];
  const hostRaw = env['PICKARR_READ_API_HOST'];
  const publicUrlRaw = env['PICKARR_PUBLIC_URL'];

  return {
    readHost: hostRaw === undefined ? server.current.host : resolveReadHost(hostRaw),
    port: portRaw === undefined ? server.current.port : resolveReadPort(portRaw),
    publicUrl: publicUrlRaw === undefined || publicUrlRaw === ''
      ? server.current.publicUrl
      : resolvePublicUrl(publicUrlRaw),
    databasePath: env['PICKARR_DATABASE'] ?? database.current.path,
    secretsBaseDir: secrets.current.baseDir,
    config,
  };
}
```

Change `resolveReadPort` and `resolveReadHost` to take `raw: string` and drop their default branches. Delete the tests that asserted "undefined yields the default" and say so in the commit message — that default now lives in `serverConfigSchema` and `schemas.test.ts` asserts it.

`server.current.publicUrl` is already validated by the schema, so it needs no second check — which is the point of Task 6.

- [ ] **Step 4: Use it in `main`**

Replace the boot block at `packages/host/src/main.ts:498-508` so it reads its settings once and builds `secrets` before `downloads`:

```ts
  const settings = await resolveSettings(process.env);
  const { raw, db } = openDatabase(settings.databasePath);
  migrateHost(raw);

  const secrets = createSecrets({ raw, baseDir: settings.secretsBaseDir });
  const artworkDir = resolveArtworkDir(settings.databasePath);
  const fetch = createHostFetch({ fetch: globalThis.fetch });
  const downloads = createDownloadClients({ raw, fetch, secrets, now: () => Date.now(), log });
```

Then replace the later uses of `port`, `readHost` and `publicUrl` with `settings.port`, `settings.readHost` and `settings.publicUrl`, and pass `secrets` wherever `createReconcileHandler` is constructed. **The database is opened from `settings.databasePath`, so the config file must be read before it** — that is the one-way boot order in spec §6.6, and reversing it would need the database path to come from the database.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm run test:server && npm run lint && npm run build && npm run test-hygiene`
Expected: typecheck 0; tests pass 0 fail; lint 0 with exactly 124 warnings; build 0; hygiene 0. Report the final count — it is the baseline for the next slice.

- [ ] **Step 6: Mutation A — prove the environment still wins**

Copy `main.ts` aside. In `resolveSettings`, swap the port precedence to `server.current.port` unconditionally, run the focused test.
Expected: `an environment variable beats the file` FAILS with 9100 where 9200 was expected.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 7: Mutation B — prove the file's `publicUrl` is validated**

Copy `schemas.ts` aside. Replace `serverConfigSchema`'s `publicUrl` with a bare `z.string().optional()`, run the focused `main.test.ts` test.
Expected: `a config file with a publicUrl carrying a path refuses the boot` FAILS — the boot resolves instead of rejecting. This is the mutation that proves the file cannot reintroduce slice F's B1.
Restore by copy-aside, `md5 -q`, re-run.

- [ ] **Step 8: Run the host once, for real**

Building and typechecking is not running. With a temp database and a temp config file, start the host and confirm it boots, then stop it:

```bash
D=$(mktemp -d)
printf '%s\n' '{"server":{"host":"127.0.0.1","port":8899},"database":{"path":"'"$D"'/pickarr.db"},"secrets":{"baseDir":"'"$D"'/secrets"}}' > "$D/pickarr.config.json"
mkdir -p "$D/secrets"
PICKARR_CONFIG="$D/pickarr.config.json" node --import tsx --conditions development packages/host/src/main.ts &
sleep 2
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8899/api/health
kill %1
```

Expected: `200`. The config file supplied the port and the database path, so a 200 here is the whole slice working end to end. If the health route answers from a different port than the file names, the precedence is wrong in a way no unit test caught. Report what you saw, and clean up `$D`.

- [ ] **Step 9: Commit**

```bash
git add -- packages/host/src/main.ts packages/host/test/main.test.ts
git commit -m "Read settings from the file, with every variable a deployment already sets still winning" -- packages/host/src/main.ts packages/host/test/main.test.ts
```

---

## After the last task

Update `docs/known-issues.md` and the auth spec's §6 configuration table if either now says something false — the auth slice's §6 lists four environment variables and does not know about `PICKARR_CONFIG`, and `README.md` describes 1.x only. Check, do not assume.
