import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AddDownloadClientRefusalCode } from '@pickarr/contract';
import { isImplementation } from './config.ts';
import type { ClientType, Implementation } from './config.ts';

/**
 * What `Host.addDownloadClient` needs to create a download client.
 *
 * **Every field is a primitive, and none is a union or optional**, for the
 * reason `feeds/add.ts`'s `AddFeedInput` gives at length: these values
 * arrive unchecked out of a JSON request body, and this module is the
 * validator that narrows them, not a caller that has already done so.
 * `implementation` is `string` rather than `Implementation` for exactly
 * that reason -- typing it as the union would tell the compiler a check
 * this module performs at runtime is already guaranteed.
 *
 * **`type` is absent, deliberately**, and cannot be sent. It is derived
 * from `implementation` here (see {@link TYPE_FOR_IMPLEMENTATION}), because
 * `readClientConfig` treats a `type`/`implementation` mismatch as a fatal
 * misconfiguration -- so accepting both from a browser would be accepting
 * the ability to construct a row that can never work.
 *
 * **`apiKey`, `username` and `password` are `string`, not `string | null`**,
 * and an empty one means "not supplied". That is not a convenience: `''` is
 * what a blank form field sends, and `readClientConfig`'s `optionalText`
 * already folds a blank column to absent on the way back out, so a single
 * spelling of "absent" across the write and the read is one fewer place the
 * two can disagree. What this module writes to the row for a blank field is
 * `null`, not `''` -- see `nullIfBlank`.
 *
 * The two credential fields cross the wire here and nowhere else. Neither is
 * ever written to a column, a log line, an error message or a response body.
 */
export interface AddDownloadClientInput {
  name: string;
  implementation: string;
  url: string;
  category: string;
  apiKey: string;
  username: string;
  password: string;
}

/**
 * Why `Host.addDownloadClient` declined to create the row, returned as a
 * value rather than thrown -- a thrown error is indistinguishable from a bug
 * at the call site, and the route in front of this needs to map each refusal
 * to its own status code.
 *
 * The codes are `@pickarr/contract`'s `ADD_DOWNLOAD_CLIENT_REFUSALS`, not
 * this file's, because the browser client has to agree with them exactly to
 * pick the right sentence; that module's own doc has the measurement from
 * the feeds slice, where the two spellings were hand-copied. What stays here
 * is the *shape* -- a one-field object, so a refusal is a value this
 * function can return beside `{ id }` -- and the rules that decide which
 * code applies, below.
 *
 * **No refusal carries anything from the input.** Not the url, not the
 * name, and above all not a credential: a refusal says which rule was
 * broken and nothing about the value that broke it.
 */
export interface AddDownloadClientRefusal {
  refusal: AddDownloadClientRefusalCode;
}

/**
 * What goes in `download_client.import_mode`.
 *
 * **Nothing in 2.0 reads this column.** Measured on this tree by grepping
 * `import_mode`/`importMode` across `packages` and `scripts`: inside
 * `packages/host/src` the only occurrences are the initial schema in
 * `db/migrate.ts`, the Drizzle mirror of it in `db/schema.ts`, and this
 * module. Every other host-side hit is an `INSERT` column list in a test
 * fixture, plus `scripts/seed-client.ts`, which takes it as a required
 * flag. No *reader* exists -- not in the adapters, not in
 * `clients/config.ts`, not in `clients/deliver.ts`; `readClientConfig` does
 * not even `SELECT` it. (1.x's `packages/core` does read an `importMode`,
 * but that is its own config object on a schema 2.0 shares nothing with.)
 * This constant exists solely because the column is `NOT NULL`.
 *
 * It is therefore **not a form field** (design spec §8.4): a field whose
 * value nothing consumes is a question with no right answer.
 *
 * **`'copy'` rather than `'move'`, and the choice is not arbitrary even
 * though nothing reads it.** Two pieces of evidence, both measured on this
 * tree. `scripts/seed-client.ts` -- the only other writer of this column --
 * uses `--import-mode=copy` in all three of its documented examples, the
 * SABnzbd one included, so this writer and that one agree. And 1.x, which
 * does have a reader, **refuses** a qBittorrent client configured `move`:
 * `packages/core/src/config/load.ts` rejects it because moving the file out
 * from under a torrent stops it seeding. 1.x is frozen and shares no schema
 * with 2.0, so that rule does not bind this column -- but a constant every
 * qBittorrent row would carry is a poor thing to set to the one value the
 * previous implementation called an error. `copy` is wrong for nobody
 * today and latently wrong for nobody later.
 */
const IMPORT_MODE = 'copy';

/**
 * The transport each implementation moves picks over -- the whole of the
 * derivation design spec §4 and §8.3 describe.
 *
 * A `Record` keyed by `Implementation` rather than a `Map`, so adding a
 * third implementation to `clients/config.ts` fails to compile here until
 * its transport is decided, instead of silently refusing every client of
 * that kind as `unknown-implementation`.
 */
const TYPE_FOR_IMPLEMENTATION: Readonly<Record<Implementation, ClientType>> = {
  qbittorrent: 'torrent',
  sabnzbd: 'nzb',
};

/**
 * SQLite's own code for a UNIQUE constraint failure -- verified against
 * `node:sqlite`. The same constant `feeds/add.ts`, `media/writer.ts` and
 * `clients/downloads.ts` each declare, and kept here for the reason
 * `feeds/add.ts` records: none of the three exports it, and pulling one of
 * those modules in for a two-line SQLite check would be the wrong dependency
 * for this one to take on. That reasoning held at three copies and is
 * thinner at four: the honest fix is one exported `isUniqueConstraintViolation`
 * the four share, which is a refactor of three existing modules rather than
 * part of this slice.
 */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * `node:sqlite` throws a plain `Error` carrying `code: 'ERR_SQLITE_ERROR'`
 * and SQLite's own numeric `errcode`, neither part of `@types/node`'s
 * declared `Error` shape, so this is a runtime check rather than something
 * the compiler already knows. Checking `code` alone would not do: a generic
 * logic error surfaces with the same `code` and a different `errcode`, and
 * treating that as a lost race would misreport a real bug as a duplicate
 * name.
 *
 * `'code' in err` / `'errcode' in err`, not a cast: narrowing `unknown` this
 * way tells the compiler no more than the check itself proves. The twin in
 * `feeds/add.ts` has the longer version of this note.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && 'code' in err && err.code === 'ERR_SQLITE_ERROR'
    && 'errcode' in err && err.errcode === SQLITE_CONSTRAINT_UNIQUE;
}

/**
 * The schemes a download client can be reached over.
 *
 * Both adapters build a request target by **string concatenation** --
 * `` `${config.baseUrl}${TORRENTS_ADD_PATH}` `` in `qbittorrent.ts`,
 * `` `${config.baseUrl}/api?${query}` `` in `sabnzbd.ts`; neither resolves
 * the path through the WHATWG parser, so neither repairs a base url that is
 * not one. Whatever this column holds is therefore very nearly the literal
 * prefix of every request, and `fetch` is the only thing left to object.
 * Restricting the scheme here is what keeps that objection from being the
 * first sign of a misconfiguration.
 */
const CLIENT_URL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Whether `url` is an address a download client could actually be at.
 *
 * **"Parses" alone is not enough, and this was measured rather than
 * assumed.** `URL.parse('qbit.example:8080')` -- the shape someone produces
 * by omitting `http://`, which is the single most likely way to get this
 * field wrong -- does not fail. It parses, as scheme `qbit.example:` with
 * the opaque path `8080`, giving `hostname: ''` and `origin: 'null'`. A row
 * built from it would name no host at all: the adapter would have nothing
 * to connect to, and design spec §5's `origin + pathname` projection would
 * put the literal string `null8080` in front of the operator. So the check
 * is on the scheme, which is what makes a host mandatory -- `URL.parse`
 * already answers `null` for an `http:` url with no host (`'http://'`), so
 * the two together admit only a real address.
 *
 * `URL.parse` rather than `new URL` in a `try`: it answers `null` instead of
 * throwing, so there is no caught error here whose message -- which would
 * quote the url -- could escape into a log or a refusal.
 *
 * The parsed value is discarded and the row stores the url exactly as
 * submitted: the row is what an adapter dials, and normalising it here
 * would silently change where a request goes. Design spec §5 puts the
 * `origin + pathname` narrowing on the *projection* to the replica, which
 * is a different job with a different reason.
 */
function isClientAddress(url: string): boolean {
  const parsed = URL.parse(url);
  return parsed !== null && CLIENT_URL_PROTOCOLS.has(parsed.protocol);
}

/** `''` -- a blank form field -- written to a nullable column as the `null` it means. See {@link AddDownloadClientInput}. */
function nullIfBlank(value: string): string | null {
  return value === '' ? null : value;
}

/**
 * Which credential fields a row will carry, before any of them has a name.
 *
 * The two credential *values* are still here, and this is the last place
 * they are held together: {@link storeCredential} turns each into a
 * `randomUUID()` name plus a `secret` row and the values are dropped.
 * `username` passes through unchanged because it is not a credential.
 */
interface CredentialPlan {
  apiKey: string | null;
  username: string | null;
  password: string | null;
}

/**
 * The credential shape `implementation` can actually authenticate with, or
 * `undefined` for one no strategy in `readClientConfig` could resolve.
 *
 * Mirrors that function's decision rather than restating it loosely -- the
 * three shapes it produces are the three accepted here, and nothing else is:
 *
 * - `sabnzbd`: an api key, always, and no username or password beside it.
 *   The extra rule is deliberate. `readClientConfig`'s sabnzbd branch reads
 *   the api key and never looks at `username`, so a row carrying both would
 *   store a username nothing will ever send -- a row that claims a
 *   credential it does not use, which is the kind of thing an operator
 *   later debugs as "my password is not working".
 * - `qbittorrent` with an api key and nothing else: the bearer strategy.
 * - `qbittorrent` with a username and a password and no api key: the login
 *   strategy.
 *
 * **qBittorrent with both is refused, though `readClientConfig` would
 * accept it.** That function is reading rows this codebase did not
 * necessarily write, and it resolves the ambiguity in favour of bearer on
 * purpose. A *writer* has no such obligation: a form that submitted both
 * was filled in by someone who does not know which one will be used, and
 * silently discarding their password is worse than saying the shape is
 * wrong. This and the sabnzbd rule above are the two places this module is
 * stricter than the reader; in the other direction there are none -- every
 * shape accepted here is one `readClientConfig` resolves.
 */
function planCredential(
  implementation: Implementation,
  input: AddDownloadClientInput,
): CredentialPlan | undefined {
  const apiKey = nullIfBlank(input.apiKey);
  const username = nullIfBlank(input.username);
  const password = nullIfBlank(input.password);

  if (implementation === 'sabnzbd') {
    if (apiKey === null || username !== null || password !== null) return undefined;
    return { apiKey, username: null, password: null };
  }

  if (apiKey !== null) {
    if (username !== null || password !== null) return undefined;
    return { apiKey, username: null, password: null };
  }
  if (username !== null && password !== null) {
    return { apiKey: null, username, password };
  }
  return undefined;
}

/** The names a row holds in place of its credentials, plus the username, which is not one. */
interface CredentialNames {
  apiKeySecretName: string | null;
  username: string | null;
  passwordSecretName: string | null;
}

/**
 * Writes each credential in `plan` to the secret store under a fresh name
 * and hands back only the names.
 *
 * The name is a `randomUUID()`, matching what migration 14 generated for
 * every credential it moved out of `download_client` and what
 * `scripts/seed-client.ts` generates -- one shape of generated name across
 * every writer there is. A uuid also satisfies `assertSecretName`, which
 * `saveSecret` applies before building any path from the name.
 *
 * **This is where the credential values stop being needed.** Everything
 * downstream works from {@link CredentialNames}, which holds no value --
 * so the `INSERT` below reaches for `names.*` and never for `input.apiKey`
 * or `input.password`. That is a discipline rather than an impossibility:
 * `input` is still in scope there, which is exactly why the test suite
 * greps every column of the written row rather than trusting the shape of
 * this call.
 */
function storeCredential(
  saveSecret: (name: string, value: string) => void,
  plan: CredentialPlan,
): CredentialNames {
  let apiKeySecretName: string | null = null;
  if (plan.apiKey !== null) {
    apiKeySecretName = randomUUID();
    saveSecret(apiKeySecretName, plan.apiKey);
  }
  let passwordSecretName: string | null = null;
  if (plan.password !== null) {
    passwordSecretName = randomUUID();
    saveSecret(passwordSecretName, plan.password);
  }
  return { apiKeySecretName, username: plan.username, passwordSecretName };
}

/**
 * The invariants a new `download_client` row must satisfy, applied here
 * rather than in the route in front of it: this is testable with no HTTP at
 * all, the same way `feeds/add.ts` and every other host operation in this
 * package is.
 *
 * Takes `saveSecret` rather than the whole `Secrets` instance, the same way
 * `addFeed` takes `isRegistered` rather than the host's plugin map: `get` is
 * the half of that interface this module must never need, and not having it
 * in hand is a stronger statement than not calling it.
 *
 * **`saveSecret` runs before the `INSERT`, and the ordering is the
 * decision** (design spec §3 and §8.6). A failure between the two leaves an
 * orphaned `secret` row, which is harmless: `secrets/store.ts` is the only
 * reader of `secret.value` in the package and it reads **by name**, nothing
 * enumerates the table, and `sync/tables.ts` deliberately keeps `secret` out
 * of the replica -- so a row nothing references resolves for nobody and
 * reaches no client. The rejected ordering is insert-then-save, which fails
 * the other way: a `download_client` row naming a secret that was never
 * stored reads as perfectly configured and then fails on every request, at
 * `Secrets.get`, three links from its cause. Wrapping both in one
 * transaction would remove even the orphan and was considered; §8.6 chose
 * the ordering instead, and this module follows the spec rather than
 * quietly improving on it.
 *
 * Synchronous, like `addFeed`: `saveSecret` is `void` (`node:sqlite` is
 * synchronous, this repo's documented exception to preferring an async API)
 * and the insert is one local statement, so there is nothing here to await.
 * `Host.addDownloadClient` is `async` because it schedules a reconcile
 * afterwards, which genuinely is.
 */
export function addDownloadClient(
  deps: {
    raw: DatabaseSync;
    now: () => number;
    saveSecret: (name: string, value: string) => void;
  },
  input: AddDownloadClientInput,
): { id: number } | AddDownloadClientRefusal {
  if (!isImplementation(input.implementation)) {
    return { refusal: 'unknown-implementation' };
  }
  const plan = planCredential(input.implementation, input);
  if (plan === undefined) {
    return { refusal: 'bad-auth-shape' };
  }
  if (!isClientAddress(input.url)) {
    return { refusal: 'bad-url' };
  }

  // Before the insert -- see this function's doc for why this ordering and
  // not the other. Every refusal above returns before reaching here, so a
  // request that was going to be refused stores nothing.
  const names = storeCredential(deps.saveSecret, plan);

  const at = deps.now();
  try {
    const result = deps.raw.prepare(`
      INSERT INTO download_client
        (name, type, implementation, url, api_key_secret_name, username, password_secret_name,
         category, import_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      TYPE_FOR_IMPLEMENTATION[input.implementation],
      input.implementation,
      input.url,
      names.apiKeySecretName,
      names.username,
      names.passwordSecretName,
      input.category,
      IMPORT_MODE,
      at,
      at,
    );
    return { id: Number(result.lastInsertRowid) };
  } catch (err) {
    // `download_client` carries a `uniqueIndex` on `name` (`db/schema.ts`),
    // and a feed names a client by that name, so a second client answering
    // to one already on file would make that reference ambiguous. Caught
    // here rather than pre-checked with a SELECT: a check-then-insert leaves
    // a window for two concurrent calls to both pass the check and race the
    // same constraint anyway. Whatever SQLite's message says, it is not
    // repeated -- the refusal carries neither the name nor SQLite's own
    // message, only the fact of the collision.
    if (isUniqueConstraintViolation(err)) {
      return { refusal: 'duplicate-name' };
    }
    throw err;
  }
}
