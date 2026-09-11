# Configuration and secrets

Two subsystems for the 2.0 host: a **config** subsystem that owns a JSON file
whose top level is one namespace per subsystem, and a **secrets** subsystem
that resolves a named credential through a memoized provider chain over
`@chad3814/secret-provider`.

Both exist because the host contacts several independent services, needs a
credential for each, and has more than one subsystem wanting the same
credential. Today it has neither: five environment variables are the whole
configuration surface, and credentials sit in `download_client` columns that
only one function may read.

## 1. What this builds

- `packages/host/src/config/` — read, validate and update
  `/config/pickarr.config.json`; one namespace per subsystem, registered with
  a Zod schema, returning a typed handle.
- `packages/host/src/secrets/` — `get(name)` and `saveSecret(name, value)`
  over `chain(fromEnv, fromFile, fromDatabase)`, memoized per name.
- Migration 13 — a `secret` table, and `download_client`'s credential columns
  replaced by `api_key_secret_name` / `password_secret_name` holding a UUID.
- `readClientConfig` resolves those names through the secrets subsystem and
  becomes `async`. Its two callers are already `async`.
- `scripts/check-test-hygiene.ts` — `secret.value` joins the enforced
  credential columns.

## 2. Facts, measured rather than assumed

Every claim here was measured against `@chad3814/secret-provider@1.2.0` on
2026-09-11, with the probes in `/tmp/sp-probe` and `/tmp/sp-ts`. The library's
own README is not the authority; these runs are.

**2.1 The package fits this repo.** Zero runtime dependencies,
`"type": "module"`, `engines.node >= 22.18.0`. Its types compile under this
repo's exact compiler options — `nodenext`, `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules` — at exit 0,
and stay clean with `skipLibCheck` turned **off**, so its `.d.ts` re-exports
from `./chain.ts` are not a problem. Eight named exports load under ESM:
`ProviderError`, `chain`, `fromEnv`, `fromFile`, `fromIni`, `fromPrompt`,
`fromStatic`, `memoize`.

The first version of that probe used `npm init -y`, which writes a CommonJS
package, and reported six `TS1295` errors that were the probe's own
misconfiguration. A spike that does not mirror the repo's settings measures
the spike. Slice F learned this the same way.

**2.2 `Provider<T>` is `() => Promise<T>`.** A provider is an async thunk and
nothing more, which is what lets a database read be a link.

**2.3 Chain and link semantics.**

| Measured | Result |
|---|---|
| `fromEnv` on an unset name | `ProviderError`, `tryNextLink: true` |
| `fromEnv` on a name that is illegal for an env var (`has-hyphens`) | `ProviderError`, `tryNextLink: true` — it does not throw differently |
| `fromFile` on a missing path | `ProviderError`, `tryNextLink: true` |
| `fromFile` on a file empty after trimming | `ProviderError`, `tryNextLink: true` |
| `fromFile` on `"abc\n"` | `"abc"` — trailing whitespace trimmed, which is what `/run/secrets` files need |
| `chain` when no link resolves | `ProviderError`, `tryNextLink: **false**` |
| `memoize` after a rejection | the rejection is **not** cached; the next call re-resolves |
| three concurrent calls through `memoize` | **one** underlying call |

**2.4 `chain`'s final error names every link's failure, `fromFile`'s path
included.** Measured: the message from
`chain(fromEnv('X'), fromFile('/run/secrets/tvdb_key'))` contains
`/run/secrets/tvdb_key`. This repo forbids a path in a log line, and slice F
spent a fix wave on that class, so §5.3 requires the wrapper to replace this
error rather than propagate it.

**2.5 `crypto.randomUUID()` fits the name shape; its env variable is another
matter.** 36 characters, lowercase hex and hyphens; it matches
`/^[a-z0-9][a-z0-9_-]{0,63}$/`, and the same regex refuses `..`, `a.b`, `a/b`
and `../../etc/passwd`.

`name.toUpperCase().replaceAll('-', '_')` yields a name containing only legal
characters, but **not one a shell can assign**: measured, 116 of 200 uuids begin
with a hex digit, and `sh`, `zsh` and `bash` each refuse `550E8400_...=v` as a
command rather than an assignment. `env(1)`, a Docker `environment:` entry and
a systemd `Environment=` all set it, and Node reads it. An earlier version of
this paragraph called the result "a legal environment-variable name", measured
on a single uuid that happened to begin with a letter — the generalisation was
wrong 58% of the time. §5.2's normalisation stands: the env link is a real
override for a name an operator types, and a theoretical one for a generated
name whose home is the database.

**2.6 What 1.x already does, which this replaces.** `packages/core/src/config`
has a `config.json`, a Zod schema, `SECRET_REFERENCE_PREFIX = 'file:'` so a
field may read `file:/run/secrets/sab_key`, and `resolveSecrets(config)` which
resolves those references **into the config object** it was given.
`editable.ts` projects secrets to the browser as
`{ kind: 'file'; path: string } | { kind: 'set' }` rather than a `'********'`
sentinel. The projection idea is good and is kept in spirit; mutating resolved
secrets into a serializable config object is the thing §6.4 forbids.

**2.6a `packages/host` resolves Zod **4**, not the root's 3.** Nothing under
`packages/host/src` imported `zod` before this slice, which is why this went
unnoticed. Measured with `require.resolve('zod', { paths: ['packages/host/src'] })`:
host code gets `packages/host/node_modules/zod` at **4.5.4**, nested there
because `better-auth@1.7.3` requires `zod@^4.5.4`. The root copy is **3.25.76**,
which is what `packages/core` (1.x) resolves and must keep.

An earlier version of this section said the host would take `^3.24.0` and share
one hoisted copy. That was false, and `npm ls zod --workspaces --all` says so
outright — it reports `zod@4.5.4 ... invalid: "^3.24.0" from packages/host`.
**The host therefore declares `zod@^4.5.4`**, matching what it actually loads
and what `better-auth` needs. Forcing 3 into the host was attempted with an
`overrides` entry and breaks `better-call`'s own peer on `zod@^4.0.0`, which
sits as a flat sibling rather than nested under `better-auth`.

**2.6c An absent section needs `.prefault()`, not `.default()`.** Measured
against **4.5.4, the copy `packages/host` actually loads** (see 2.6a):

| Schema on `parse(undefined)` | Zod 4.5.4 |
|---|---|
| `z.object({ port: z.number().int().default(8787) }).default({})` | `{}` — **the inner default is not applied** |
| the same with `.prefault({})` | `{ port: 8787 }` |
| `.strict().prefault({})` on an unknown key | rejected, `unrecognized_keys` |
| `.optional()` field absent | omitted, no error |

Zod 4 changed `.default()` to short-circuit parsing and stand as the output
value, so a nested default never runs. `.prefault()` substitutes the value and
*then* parses it, which is the behaviour every namespace schema here needs.

An earlier version of this section asserted the `.default({})` form worked,
measured from the repo root — which resolves **3.25.76**, not the 4.5.4 the
host loads. That is the same error §2.1 records about slice F's spike: a
measurement taken against a different resolution than the code gets measures
the probe, not the code. It cost this slice one blocked task.

**2.6b SQLite is 3.53.4 behind `node:sqlite`.** Measured: `ADD COLUMN` and
`DROP COLUMN` both succeed on a table carrying an index on a different column,
so §4's migration needs no table rebuild.

**2.7 `readClientConfig` is synchronous and has two callers**, at
`clients/reconcile-job.ts:275` and `clients/downloads.ts:221`. Both are
already inside `async` functions, so the change costs two `await`s.

**2.8 The enforced credential columns are three**, not five:
`auth_account.password`, `auth_session.token`, `host_state.value`
(`scripts/check-test-hygiene.ts:214-218`). `download_client`'s credential
columns appear nowhere in that script — their restriction is a comment and a
plan constraint, never a machine check.

## 3. Decisions

**3.1 The database is a link in the chain, not a separate mechanism.**
Every caller resolves a credential one way: `secrets.get(name)`. Env and file
sit above the database so a container deployment can override a value entered
through the UI.
*Rejected:* a secrets subsystem for new services only, leaving
`download_client` and `host_state` with their own read paths — two unrelated
ways to get a credential, and a caller forced to know which.
*Cost:* the subsystem needs the database handle, so it cannot be the lowest
layer.

**3.2 `download_client` stores a secret name, not a credential.**
`api_key_secret_name` and `password_secret_name` hold a `randomUUID()`; the
credential lives in `secret`. `username` stays plaintext — a username is not a
credential.
*Rejected:* leaving the credentials in place, on the argument that only the
download subsystem reads them. It is one indirection now against flexibility
later, and the migration is cheap while there is one install.
*Cost:* a data migration that moves credentials, and `readClientConfig`
becomes async.

**3.3 The column says it holds a name.** `api_key_secret_name`, not
`api_key`. A column named `api_key` holding a UUID is the schema-level form of
a comment that contradicts its code, which this project has spent three fix
waves correcting.
*Rejected:* `api_key_secret_id` (a self-chosen name like `tvdb_key` is not an
id) and `api_key_secret_key` ("secret key" names a credential in ordinary use,
which is the confusion the rename exists to remove).

**3.4 One word for the reference, everywhere.** The column is
`*_secret_name`, the API is `get(name)` and `saveSecret(name, value)`, and the
spec says *name*. The key space holds both generated UUIDs and names a human
chose, and "name" is true of both.

**3.5 `saveSecret` invalidates.** Writing a secret drops its memoized
provider in the same call, so there is no public `invalidate` and no way to
forget it.
*Rejected:* a TTL through `memoize`'s `isExpired`. That hook receives the
value, not its age, so a TTL needs a `{ value, fetchedAt }` wrapper —
more machinery than one call at the single write site, and it trades an exact
answer for a stale window that would have to be guessed.
*Consequence:* without this, editing a credential in the settings UI leaves
every resolved caller on the old value until restart — a silent auth failure
against a service whose password you just fixed.

**3.6 A new file, no migration from 1.x.** `/config/pickarr.config.json`,
beside the `PICKARR_DATABASE` default of `/config/pickarr.db`. 1.x's
`config.json` is untouched and nothing reads both.
*Rejected:* growing 1.x's file with 2.0 sections — two schemas over one file
with different validity rules, and 1.x's `resolveSecrets` and 2.0's resolver
both interpreting the same fields.
*Rejected:* config rows in SQLite — the database path cannot live in the
database, so bind, port and database path would stay env-only, which is the
gap that prompted this.

**3.7 Environment variables still win over the file.** Precedence is env,
then file, then a built-in default, for every value that has an env var
today: `PICKARR_DATABASE`, `PICKARR_READ_API_HOST`, `PICKARR_READ_API_PORT`,
`PICKARR_PUBLIC_URL`. Nothing about the current deployment changes.

**3.8 `publicUrl` in the file gets slice F's validation.** Slice F's B1 was a
`PICKARR_PUBLIC_URL` carrying a path, accepted, which silently unmounted every
auth route while `/api/health` still answered 200. The config schema reuses
the same check, so the file cannot reintroduce it.

**3.9 An invalid namespace refuses, it does not default.** `register` throws
when a present section fails its schema. An absent section gets the schema's
defaults. The host awaits its own registrations at boot, so a malformed host
section fails the boot rather than running on values nobody chose.

**3.11 A Zod schema, at the version the host actually loads.** `register`
takes `ZodType<T>`, and `packages/host` declares `zod@^4.5.4` — what
`better-auth` already nests under it (§2.6a). `packages/core` keeps 3.25.76 at
the root, untouched.
*Rejected:* a bare `(raw: unknown) => T` parse function, which would add no
dependency and match the host's hand-written validation idiom
(`resolvePublicUrl` is the precedent). A schema wins because validation is this
subsystem's entire job, and because the settings API that will edit this file
needs a schema to validate a `PUT` — 1.x's settings design already does
exactly that with `configSchema.safeParse`. Hand-rolling that per namespace is
the larger cost.
*Cost:* every future namespace is bound to Zod, and a schema must accept
`undefined` for its section to be optional (§2.6c).

**3.10 Not built.** Hot reload on file change — restart is fine for one
install. Config-file schema migration — there is one install. A declaration
registry so the settings tab can show which secrets resolve — its payoff is
an operator-facing feature, and there is one operator who can read the file.
Sign-in rate limiting and `MediaWriter` scoping stay deferred, unchanged by
this slice.

## 4. Schema, migration 13

```sql
CREATE TABLE secret (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE download_client ADD COLUMN api_key_secret_name  TEXT;
ALTER TABLE download_client ADD COLUMN password_secret_name TEXT;
-- then, per row holding a credential: insert into `secret` under a new
-- randomUUID(), write that name into the new column, and clear the old one.
ALTER TABLE download_client DROP COLUMN api_key;
ALTER TABLE download_client DROP COLUMN password;
```

`username` is untouched. The whole migration runs inside migration 13's own
savepoint, sharing it with the version record exactly as `migrateHost`
requires — that atomicity must not be altered. No credential value appears in
any log line the migration emits, and no test asserts on one.

`secret.name` is `TEXT PRIMARY KEY`, so a name is unique and
`INSERT ... ON CONFLICT (name) DO UPDATE` is the write.

## 5. The secrets subsystem

**5.1 Surface.**

```ts
createSecrets(deps: { raw: DatabaseSync; baseDir: string }): Secrets

interface Secrets {
  get(name: string): Promise<string>;
  saveSecret(name: string, value: string): void;
}
```

`saveSecret` is synchronous because `node:sqlite` is, which is this repo's
documented exception to preferring async APIs.

**5.2 The chain, built once per name and held in a `Map`.**

```ts
memoize(chain(
  fromEnv(name.toUpperCase().replaceAll('-', '_')),
  fromFile(join(baseDir, name)),
  fromDatabase(raw, name),
))
```

`baseDir` defaults to `/run/secrets` and comes from the config file's
`secrets` namespace. The env name is normalized so that one rule covers both
a self-chosen name and a UUID; without `replaceAll`, a UUID's uppercase form
is not a legal variable name and the env link could never resolve for a
client credential.

**5.3 Three guards.**

- **Name shape** is checked against `/^[a-z0-9][a-z0-9_-]{0,63}$/` in both
  `get` and `saveSecret`, before any path is built, so `get('../../etc/passwd')`
  is refused at the boundary. A name is not secret, so the error may name it.
- **The chain's error is replaced**, never propagated: a `SecretNotFound`
  carrying the name alone. §2.4 measured that the original message contains
  `fromFile`'s path.
- **`saveSecret` deletes the memoized entry** for that name in the same call.

**5.4 `fromDatabase`** reads `SELECT value FROM secret WHERE name = ?` and
rejects with a `ProviderError` when there is no row. It is the only reader of
`secret.value` outside the migration, and the only entry this slice adds to
the hygiene script's credential-column allow-list.

## 6. The config subsystem

**6.1 Surface.**

```ts
openConfig(deps: { path: string }): Promise<Config>

interface Config {
  /** The schema must accept `undefined`; see 2.6c and 3.11. */
  register<T>(namespace: string, schema: ZodType<T>): ConfigHandle<T>;
}

interface ConfigHandle<T> {
  readonly current: T;
  update(next: T): Promise<void>;
}
```

`register` runs `schema.parse` against the namespace's raw JSON value, or
against `undefined` when the section is absent. Because an absent section
parses `undefined`, every namespace schema must supply its own defaults — see
2.6c for the measurement and 3.11 for why that is the trade accepted.

**6.2 The file.** One JSON object whose top-level keys are namespaces. The
host registers `server` (`host`, `port`, `publicUrl`), `database` (`path`) and
`secrets` (`baseDir`). A subsystem added later registers its own key.

**6.3 Unknown namespaces are preserved.** `update` re-reads the document,
replaces only its own key, and writes the rest back untouched — so a host that
knows nothing about a plugin's namespace cannot delete that plugin's config.
An unparseable file refuses the update rather than overwriting it, which keeps
a bad hand-edit recoverable.

**6.4 No secret is ever written to the file.** Config holds non-secret values;
anything credential-shaped is a `secrets.get(name)` away. This is the one
place 1.x's design goes wrong: `resolveSecrets` mutates resolved secrets into
the object the API serializes.

**6.5 Writes are atomic and serialized.** A temp file in the same directory,
then `rename` over the target, all `fs.promises`, behind a single-writer
promise chain so two concurrent `update` calls cannot interleave a
read-modify-write.

**6.6 Boot order is one-way.** Config path from `PICKARR_CONFIG` (default
`/config/pickarr.config.json`) → config file → database path → database handle
→ secrets (`raw` plus `baseDir`). Config never depends on secrets, so there is
no cycle.

## 7. What the tests must prove

1. Three concurrent `get` calls for one name produce **one** underlying read.
2. `saveSecret` then `get` returns the new value without a restart — the
   property 3.5 exists for.
3. `get('../../etc/passwd')` is refused before any filesystem access, and the
   error names the key without a path.
4. A `SecretNotFound` message contains no path, asserted against §2.4's
   measured leak.
5. Env beats file beats database for the same name; each link alone resolves.
6. A UUID name resolves from the database, and `PICKARR_<uuid-with-underscores>`
   overrides it.
7. Migration 13 moves every credential, leaves `username` alone, and a row's
   resolved `ClientConfig` after migration equals what it was before.
8. `readClientConfig` returns the resolved credential, so no adapter changes.
9. `update` on one namespace leaves an unknown namespace byte-identical.
10. Two concurrent `update` calls on different namespaces both survive.
11. An unparseable config file refuses an update instead of overwriting it.
12. A `publicUrl` with a path is refused in the file exactly as slice F
    refuses it in the environment.
13. A present-but-invalid namespace throws from `register`; an absent one
    parses `undefined` and gets the schema's defaults. A namespace schema that
    does not accept `undefined` throws, and the test says so — that is 2.6c's
    constraint, not a bug.
14. `secret.value` is unreadable from any module but `fromDatabase` — the
    hygiene check fails when a second reader is added.
15. No test prints a secret, and `npm run test-hygiene` proves it.

## 8. Consequences

- The enforced credential set grows by one column, `secret.value`, and the
  `download_client` convention that lived only in comments is retired. That is
  a prose rule replaced by a machine-checked one.
- `readClientConfig` becomes async. Its two callers already are, so the blast
  radius is two `await`s and a signature.
- A credential can now be supplied three ways for the same name. The chain's
  order is the answer to "which won", and nothing logs it, so a
  misconfiguration is diagnosed by knowing the order rather than by reading a
  log line.
- `/run/secrets/<uuid>` is a legal override for a client credential. Nobody
  would write that by hand; it falls out of using one rule for every name.
- Two cold lookups per client credential miss env and file before reaching the
  database — one failed `readFile` per name per process, memoized after.
- The config file is not hot-reloaded, so a change needs a restart, and
  nothing in the running host says the file has diverged from memory.
