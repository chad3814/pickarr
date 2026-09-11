# Pickarr 2.0 Slice F — Authentication

The sixth slice of the 2.0 backend. Slice E put six read routes on a socket and
accepted, in its §8, that loopback binding was the whole of the protection —
*"a real gap until then, not a theoretical one"*. It is worse than that section
originally implied: `RssItemRead.link` is a private-indexer URL carrying its
passkey, so an unauthenticated reader obtains credentials, not only metadata.

This slice adds sessions, closes every route but one behind them, and — at the
user's direction — moves the default bind from loopback to `0.0.0.0`.

## 1. What this slice delivers

- **Better Auth** (`better-auth`, 1.7.3) over the host's existing Drizzle
  instance, via `drizzleAdapter` with `provider: 'sqlite'`.
- **Four auth tables**, `auth_`-prefixed, hand-written as **migration 12** and
  mirrored in `schema.ts` like every other table.
- **`/api/auth/*`** mounted on the existing read server via `toNodeHandler`.
- **Every read route requires a valid session**, except `/api/health`.
- **First user claims the install**, gated by a claim token printed to the host
  log on first boot.
- **Default bind `0.0.0.0`**, overridable by environment now and by a config
  file later.
- **A generated, persisted signing secret**, so the host boots configured.

### 1.1 Not in this slice, deliberately

- **No social providers, no email verification, no password reset.** Each needs
  an outbound mail path or a provider registration this host does not have.
- **No config file.** The user asked for one *later*; this slice reads
  environment variables and leaves the file to whatever introduces config.
- **No roles and no multi-user model.** One account claims the install; a
  second is a deliberate re-open, not a permission tier.
- **No mutations to the read API.** Still read-only; auth is the only new
  write surface, and it is Better Auth's own.
- **No client.** Slice G's.

## 2. What the spike established, before any of this was designed

Every claim below was measured on this machine against `better-auth@1.7.3`,
Drizzle `1.0.0-rc.4` and Node 26, not taken from documentation. The probe was
thrown away; nothing entered the repo.

- **The Drizzle adapter runs on `node:sqlite`.** Better Auth's SQLite
  documentation names `better-sqlite3`, and this host has always used the
  built-in `node:sqlite`. Through `drizzleAdapter` the driver is Drizzle's
  concern, not Better Auth's: `signUpEmail` returned 200, wrote a `user` row and
  a `session` row, and `getSession` round-tripped the cookie back to the user.
  This was the risk that could have ended the slice.
- **`drizzle-orm@1.0.0-rc.4` is explicitly in range.** Better Auth 1.7.3 declares
  `"drizzle-orm": "^0.45.2 || >=1.0.0-rc.1 <2.0.0"`. A release candidate being
  in a peer range is not something to assume.
- **snake_case columns and prefixed table names both work.** The adapter maps by
  the *schema object's property key*, so `emailVerified` reaches a column named
  `email_verified` and the `user` model reaches a table named `auth_user`. The
  repo's naming convention survives intact — it did not have to be traded away.
- **The schema goes to the adapter only, so `db/open.ts` is untouched.** This
  matters more than it sounds: `drizzle-orm@1.0.0-rc.4` types SQLite's config as
  `Omit<DrizzleConfig, 'schema'>`, so this repo builds its handle with
  `relations` and *cannot* pass `schema` at all. The first probe passed the
  schema to both the Drizzle instance and the adapter, which would have led this
  spec to demand a second Drizzle instance that does not typecheck here. A
  handle built with `relations: defineRelations({})` and the schema given only
  to `drizzleAdapter` signs a user up and writes the row.
- **The Drizzle mirror's auth columns need explicit modes, or sign-up fails.**
  Found by Task 3, not by the spike, because the spike wrote its own schema
  objects rather than reusing the repo's mirror. A mode-less `integer()` column
  rejects what the adapter hands Drizzle — a JS `boolean` for `email_verified`
  and a `Date` for every `*_at` — with
  `Provided value cannot be bound to SQLite parameter 4` and a 422
  `FAILED_TO_CREATE_USER`. `{ mode: 'boolean' }` and `{ mode: 'timestamp_ms' }`
  fix it; the SQL type stays `INTEGER`, so migration 12 is untouched and there
  is still one schema mirrored against the DDL rather than a second copy under
  `auth/`. One consequence: `schema.test.ts` compares defaults through
  `column.mapToDriverValue(...)`, because Drizzle now says `false` where the DDL
  says `0`.
- **`trustedOrigins` is called with no request at all** when Better Auth builds
  the static half of its list, so a function reading `request` must tolerate its
  absence.
- **`toNodeHandler` mounts on a bare `node:http` server.** No framework needed.
- **A state-changing request whose `Origin` cannot be checked is refused —
  but only once something makes the check run.** Re-measured against 1.7.3
  for this correction: a sign-up carrying no `Origin`, no `Referer`, no
  `Cookie` and no `Sec-Fetch-*` header answers **200**. Add a cookie, or any
  `Sec-Fetch-*` header at all (`sec-fetch-site: none` and `sec-fetch-mode:
  cors` both do it), and the identical request is
  `403 MISSING_OR_NULL_ORIGIN`; `sec-fetch-site: cross-site` with
  `sec-fetch-mode: navigate` is `403 CROSS_SITE_NAVIGATION_LOGIN_BLOCKED`.
  The condition is in the library's own `validateFormCsrf`: with no cookie
  and no fetch metadata there is nothing it can validate against, and it
  returns without validating.

  This is still CSRF protection and it still shapes §5, because a *browser*
  always sends a cookie or fetch metadata or both. What is **not** true, and
  what an earlier version of this bullet asserted, is that "anything
  server-side must set it deliberately": a bare `curl -X POST` sets none of
  those four and is not refused. In that configuration the first sign-up is
  gated by the claim token alone and every later one by `isClaimed`, which is
  what those two have to carry.
- **`baseURL` must match the request's origin** — every POST that carries one
  the library will check, and that `baseURL` and `trustedOrigins` between them
  do not name, is 403 (the bullet above is what "will check" means). The first
  probe failed exactly this way against a placeholder URL. It means the server's
  reachable address must be known *before* `betterAuth()` is constructed — which
  collides with binding port 0, and §7 says what the tests do instead.
- **An unauthenticated session check answers `200` with a body of `null`**, not
  401. So a route guard must test for a session, never for a status code.

## 3. The forks, and how each was decided

**Tables are `auth_`-prefixed.** Better Auth's defaults are `user`, `session`,
`account` and `verification` — four of the most collidable names available, in a
schema where the host owns the unprefixed namespace and plugins are required to
prefix. A future plugin wanting a `session` table would be blocked for no reason
anyone could see. The prefix costs one `schema` object the adapter already
supports.

**The schema is hand-written, not generated.** Better Auth ships a CLI that
generates schema or migrations. This repo's schema is eleven hand-written
migrations plus a Drizzle mirror, with `schema.test.ts` comparing name, type,
nullability, default and every index between the two — because *"two sources of
truth are only safe while something checks they agree"*. A generator would make
a third. Migration 12 is written by hand and the mirror test covers it like
everything else.

**The signing secret is generated once and persisted, not required as
configuration.** Better Auth falls back to `BETTER_AUTH_SECRET`, then to a
**hard-coded default string** — and a known signing secret means forgeable
sessions. Requiring an environment variable would mean a host that will not boot
until someone reads the docs; generating one at first boot into a `host_state`
row means it boots configured and stays stable across restarts. An explicit
`BETTER_AUTH_SECRET` still wins if set. The database already holds download
client credentials, so this stores nothing of a new kind.

**Sign-up is closed by a hook, not by configuration.** `emailAndPassword.disableSignUp`
is read once at construction, so a host started with zero users would keep
sign-up open until it restarted — the window this slice exists to close. A
`before` hook on the sign-up route refuses when `auth_user` is non-empty, which
is evaluated per request.

**The first account needs a claim token.** This is the one place the design
disagrees with a literal reading of the instruction, and the reason is the
`0.0.0.0` default: between first boot and the owner creating an account, "first
user claims the install" means *anyone on the network* can claim it. A token
printed to the host log on first boot, required as a field on that first sign-up
and only that one, closes the window without adding a configuration step — the
owner reads it from the console they just started the process in. It is stored
in `host_state`, cleared once claimed, and re-printed on every boot while the
install is still unclaimed.

**Spending the token is what admits the sign-up, and that is an atomicity
requirement rather than an implementation detail.** `isClaimed` and the
constant-time token match are both *reads*, and two requests carrying the
same valid token both pass a read before either has written: measured,
`Promise.all` of two sign-ups with one token answered 200/200 and left **two**
accounts on an install this section says one account claims. So the token is
spent by `spendClaimToken`, a single conditional
`DELETE FROM host_state WHERE key = ? AND value = ?` whose row count decides
the winner, issued from `databaseHooks.user.create.before` — the last hook
before the `INSERT`, past every validation that could still refuse the
request. Of two callers offering one token exactly one sees a change, and the
other is refused in the same words as everybody else. The request `before`
hook keeps the `isClaimed` test and the constant-time match, so a wrong token
is refused early and never reaches that statement. What remains is stated in
`spendClaimToken`: an `INSERT` that fails after the spend leaves the token
gone with no account, and the install claimable again after a restart.

**Trusted origins are computed per request, from the address family.** With
`0.0.0.0` the server has no single knowable origin: the user may reach it at
`localhost`, a LAN address, a container name, or a reverse-proxied hostname.
`trustedOrigins` accepts `async (request) => string[]`, so the host trusts an
origin whose host is a loopback or private-range address, plus
`PICKARR_PUBLIC_URL` when set.

Echoing back whatever `Origin` arrives would be the easy version and would
disable CSRF protection entirely — an attacker's page would be trusted because
it said so. Restricting to private ranges keeps the protection meaningful: a
browser on the owner's LAN sends a private-range origin and is trusted, while a
page served from the public internet sends its own public origin and is not.
Anyone terminating TLS in front of this must set `PICKARR_PUBLIC_URL`, and the
host logs once, at boot, that it is unset.

**The bind defaults to `0.0.0.0`, at the user's explicit direction**, overridable
by `PICKARR_READ_API_HOST`. Slice E bound loopback and this reverses that. The
consequence is stated plainly in §8 rather than softened: auth becomes the only
boundary, and it is now load-bearing rather than defence in depth.

## 4. Schema, migration 12

```sql
CREATE TABLE host_state (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_user (
  id             TEXT    PRIMARY KEY,
  name           TEXT,
  email          TEXT    NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX auth_user_email ON auth_user (email);

CREATE TABLE auth_session (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES auth_user (id),
  token      TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX auth_session_token ON auth_session (token);
CREATE INDEX auth_session_user ON auth_session (user_id);

CREATE TABLE auth_account (
  id                       TEXT    PRIMARY KEY,
  user_id                  TEXT    NOT NULL REFERENCES auth_user (id),
  provider_id              TEXT    NOT NULL,
  account_id               TEXT    NOT NULL,
  access_token             TEXT,
  refresh_token            TEXT,
  id_token                 TEXT,
  access_token_expires_at  INTEGER,
  refresh_token_expires_at INTEGER,
  scope                    TEXT,
  password                 TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX auth_account_user ON auth_account (user_id);

CREATE TABLE auth_verification (
  id         TEXT    PRIMARY KEY,
  identifier TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);
CREATE INDEX auth_verification_identifier ON auth_verification (identifier);
```

`id` is `TEXT`: Better Auth's default generator is a random base62 string, and
adopting it avoids configuring `advanced.database.generateId` to something the
library then has to be told about. These four are the only tables in the schema
with a **text `id`** — which is not the same claim as "the only text-keyed
tables", the sentence this paragraph used to carry and which
`host_state (key TEXT PRIMARY KEY)` — the first statement in the block above —
falsifies. Every other table that has an `id` declares it
`INTEGER PRIMARY KEY`, i.e. the rowid; three have no `id` at all
(`host_state`, keyed by a text `key`; `deleted_media_item`, keyed by
`media_item_id`; and the migration runner's own bookkeeping). A caller-chosen
key and a borrowed foreign key are not generated ids, so neither is the
asymmetry being recorded here — that one is the library's, written down so it
does not read as an accident.

`auth_verification` is created despite nothing in §1.1's exclusions using it: the
adapter expects the model to exist, and a table Better Auth may write to is
cheaper than discovering at runtime which code path needs it.

`host_state` is deliberately general — a key/value row per fact — because it
holds two unrelated things already (the signing secret and the claim token) and
inventing a column per fact would mean a migration per fact.

**Every credential column here is one no query outside Better Auth's own adapter
may select.** `auth_account.password` is a password hash and
`auth_session.token` is a live session. The slice-C rule extends: only
`readClientConfig` may select download-client credentials, and **only the auth
adapter may select `auth_account.password`, `auth_session.token`, or
`host_state.value`**.

Enforced by an **AST walk**, not a grep — and the reason is written into
`scripts/check-test-hygiene.ts`, which chose parsing over pattern-matching
because the suite it guards *documents* its forbidden call by quoting it, so a
text match reported twenty-two comments as violations. This rule has the same
shape: the comments explaining it, and §4 of this document, both name the columns
they forbid. Extend that script rather than adding a second mechanism with the
same flaw it already avoided.

**What that walk reads is more than a column name sitting beside a table
name**, because the first version of the rule was defeated by this repo's own
dominant SQL idiom. It resolves a substituted identifier to the string it is
bound to in the same file — recursively, cycle-guarded, through `+`
concatenations — so the house style for a multi-column select
(`SELECT ${SESSION_COLUMNS} FROM auth_session`) is read as the statement it
becomes rather than as `SELECT ? FROM …`, which is how a credential select was
invisible. It normalizes a quoted or schema-qualified table name
(`"auth_session"`, `main.auth_session`). And over a credential table it
**fails closed**: a `SELECT *`, or a substitution it could not resolve, is a
violation reported as `auth_session.*` or `auth_session.?` — answerable by
naming the columns, or by adding a path to the allow-list where it shows up in
a diff, and never by the check guessing that what it cannot read is harmless.

Three things it still cannot see, each stated in the script rather than
implied: SQL that is never a string in the file (a Drizzle query-builder chain
names neither table nor column, which is how the allow-listed adapter is
written, so a *new* module written that way would pass); a statement assembled
across files, since resolution is syntactic and file-local; and anything
outside `packages/host/src`, so a plugin holding `PluginContext.db` keeps the
reach `migratePlugin`'s docblock already records.

The same script carries a **sibling rule over `packages/host/test`**: no test
may hand a credential to `node:assert` as an operand, because `node:assert`
formats *both* operands into a failure message. It follows an identifier to
what it was bound to, which is the whole point — `assert.equal(second, first)`
names no producer, and that spelling is the one this slice's earliest test file
used, which is how it came to print live signing secrets whenever it failed.

## 5. The guard

Every route on the read server requires a valid session except `/api/health`,
which stays open so a container health check needs no credential.

The guard calls `auth.api.getSession({ headers })` and refuses when it resolves
to `null` — **never on a status code**, because §2 established that an
unauthenticated check answers `200 null`. A refusal is `401` with a fixed body
carrying no url, path or query string, exactly as slice E's 500 handler does.

`/api/auth/*` is handled by `toNodeHandler` *before* the guard, or nobody could
ever sign in.

**Artwork is guarded too.** Slice E's review recorded that
`/api/artwork/:kind/:mediaItemId` is not plugin-scoped and grants an existence
oracle across media types. That was acceptable when every route was equally
open; behind a session it stops being reachable at all by an unauthenticated
caller, which is the whole point.

## 6. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PICKARR_READ_API_HOST` | `0.0.0.0` | Interface to bind. |
| `PICKARR_READ_API_PORT` | `8787` | Port. Deliberately not `PICKARR_PORT`, which 1.x reads. |
| `PICKARR_PUBLIC_URL` | unset | The externally reachable origin, when behind a proxy. |
| `BETTER_AUTH_SECRET` | generated | Overrides the persisted secret. |

A config file replaces the first three later; nothing here should make that
harder, which is why each is read in exactly one place.

## 7. Testing

The properties worth pinning, each because it fails silently:

1. **An unauthenticated request to every guarded route is 401** — enumerated from
   the route table, not listed by hand, so a route added later is guarded or the
   test fails.
2. **`/api/health` needs no session**, and is the only such route.
3. **A valid session reaches the data**, proving the guard is not simply refusing
   everything.
4. **A session check that resolves `null` refuses** — the `200 null` trap. Mutate
   the guard to test a status code and this must fail.
5. **Sign-up is refused once a user exists**, evaluated per request rather than at
   construction: create a user, then attempt a second sign-up **without
   restarting the server**.
6. **The first sign-up requires the claim token, and spends it only on
   success.** Single-use, not single-*attempt* — this sentence originally said
   the token is spent "even if the first was rolled back", which the
   implementation faithfully delivered and which is a defect: the hook that
   verified the token ran ahead of Better Auth's own password-length check, so
   a correct token with a mistyped password returned 400 with the token
   already gone.

   **What that cost was a restart**, and two later versions of this paragraph
   said otherwise. `main.ts` prints the token on every boot while `auth_user`
   is empty — its own log line says so — and with the `host_state` row spent
   `ensureGeneratedValue` mints a fresh one, so the next boot offers a
   different token (measured, twice: once by a reviewer and once for this
   correction). "Permanently unclaimable, recoverable only by hand-editing the
   database" was an escalation of what task 4's report had framed correctly,
   and it was written into this spec by the commit whose stated purpose was to
   stop this spec asserting something false. The fix is still worth having
   made: a token printed to the console that silently stops working after any
   refused attempt is one an owner has no reason to doubt and no way to
   diagnose, and a restart is a real cost on a host that is meant to be left
   running.

   Verification lives in the request `before` hook; **spending the token is
   `databaseHooks.user.create.before`'s, and spending it is what admits the
   sign-up** — §3 says why that placement rather than an `after` hook, which
   is what an earlier version of this paragraph described. A second sign-up
   with a spent token still fails.
7. **A public-internet origin is refused and a private-range origin accepted**,
   with `PICKARR_PUBLIC_URL` unset.
8. **The generated secret is stable across restarts** — two hosts over one
   database issue cookies the other accepts.
9. **No query outside the auth adapter selects a credential column**, over
   `packages/host/src`, by the AST walk §4 describes — never by grep, for the
   reason given there. A query the walk cannot read over a credential table
   fails the build rather than passing it.

Tests bind port 0 and must therefore compute `baseURL` after the port is known —
see §2. That ordering is a real constraint, not a test artifact: production has
the same problem and solves it the same way.

## 8. Consequences

- **Auth is now the only boundary, and the bind default is `0.0.0.0`.** Slice E
  bound loopback; this does not. A misconfiguration, a session-handling bug, or a
  weak password is now directly exposed to whatever network the host sits on.
  This was chosen deliberately over loopback-plus-opt-in, and it is the single
  largest risk this slice introduces.
- **That default reaches no published artefact yet**, which is worth knowing
  alongside the bullet above rather than instead of it. Verified in this tree:
  the `Dockerfile`'s runtime stage runs `packages/core/dist/main.js` — 1.x —
  with `EXPOSE 8080`, `packages/host` appears in that file nowhere at all, and
  the one compose file publishes `8080:8080`. No Dockerfile, compose file or
  manifest anywhere in the repo mentions 8787. So the exposure begins the day
  the 2.0 host is containerised, not today. That is also the day Better Auth's
  own rate limiter switches itself on, since the runtime stage sets
  `NODE_ENV=production` — see below, and note that the limiter arriving is not
  the same thing as the limiter being useful.
- **Anything that was already reachable is still reachable to a session
  holder**, including every private-indexer URL with its passkey. Auth changes
  who can read it, not what is served. Redacting `link` is a different slice and
  would break the client that needs it.
- **There is no password policy, and no rate limit on sign-in that is switched
  on.** "Better Auth's defaults apply" is true and says nothing, so here is
  what they are, read out of 1.7.3 and then measured. `rateLimit.enabled`
  defaults to `isProduction` — `NODE_ENV === 'production'` — and nothing in
  this repo sets `NODE_ENV` for the host: `npm start` and the test runner both
  leave it unset. Measured: twelve consecutive wrong-password sign-ins against
  one account all answer 401. The same twelve under `NODE_ENV=production`
  answer `401, 401, 401` and then nine `429`s, because the library's default
  special rule for `/sign-in`, `/sign-up`, `/change-password` and
  `/change-email` is **3 requests per 10 seconds** (everything else is 100 per
  10 seconds, counted in an in-process `Map` that a restart clears).

  Two consequences a reader should not have to re-measure. **Turning it on is
  not the whole fix**: `getIP` reads forwarded-IP *headers* and never the
  socket, so with no proxy in front and no
  `advanced.ipAddress.ipAddressHeaders` configured the rate-limit key collapses
  to one shared bucket per path — the library logs exactly that, measured — and
  three wrong guesses from anywhere then lock the owner out of their own
  sign-in for ten seconds. **And the read routes have no limiter at all**: the
  limiter is Better Auth's middleware over `/api/auth/*`, while the five
  guarded routes go through `api/server.ts`'s `handle`, which has nothing of
  the kind. A reachable `0.0.0.0` bind makes all of that more consequential
  than it was.
- **One account, no recovery.** No email path exists, so a forgotten password
  means editing the database. A `seed-user` script or a reset path is the obvious
  next thing and is not here.
- **The claim token is printed to the log.** Anything reading the host's stdout
  during the unclaimed window can claim the install. That is a smaller surface
  than the network, which is the trade.
- **The two sign-up refusals are told apart by timing and by nothing else.**
  "Claimed" and "unclaimed, wrong token" answer the same 403, the same single
  header, the same 31-byte body and no cookie — deliberately, so a garbage
  token cannot be used to ask whether the install is still worth attacking.
  The unclaimed path does one extra `host_state` read and a buffer compare,
  which is a measured and reproducible ~5 µs on a ~138 µs request. Accepted
  rather than equalised; the measurement and the reason are in
  `auth/instance.ts` beside the refusal message.
- **`auth_verification` has no writer in this slice**, like `external_reference`
  before it. Recorded so the next reader does not hunt for one.
