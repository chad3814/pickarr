import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createHost } from '../../src/host.ts';
import type { Host, AddDownloadClientInput } from '../../src/host.ts';
import { readClientConfig } from '../../src/clients/config.ts';
import { normalizeClientCategory } from '../../src/clients/snapshot.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import type { Secrets } from '../../src/secrets/instance.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';
import type { Timers } from '../../src/jobs/dispatcher.ts';

/**
 * The two credential values every test here uses, and the one property the
 * whole file is about: **neither string may appear in a column, a log line
 * or anything else this file can reach.** Distinct from each other and from
 * every other literal here, so a test asserting one is absent cannot be
 * satisfied by the other's absence.
 */
const API_KEY = 'apikey-must-not-be-stored-1a2b3c';
const PASSWORD = 'password-must-not-be-stored-4d5e6f';

/** A `QueuedFetch` that fails loudly: no test here polls or reconciles against a real client. */
const unusedFetch: QueuedFetch = {
  json: async () => { throw new Error('fetch.json: not used by this test'); },
  bytes: async () => { throw new Error('fetch.bytes: not used by this test'); },
  text: async () => { throw new Error('fetch.text: not used by this test'); },
};

/** A `DownloadClients` that fails loudly: nothing here submits a download. */
const unusedDownloads: DownloadClients = {
  submit: async () => { throw new Error('downloads.submit: not used by this test'); },
};

/** No test here attaches artwork, so this directory is never created or written to. Mirrors `feeds/add.test.ts`'s own. */
const unusedArtworkDir = '/nonexistent/pickarr-test-artwork-unused';

/**
 * The secrets directory `createSecrets` is pointed at. It does not exist, on
 * purpose: `fromFile`'s absent-path case falls through the chain (see
 * `SecretsFileUnreadable`'s doc for the case that does *not*), so every
 * `get` here resolves from the `secret` table -- which is the link this file
 * needs to observe. A real directory would make the file link answer first
 * and the assertions would stop proving the row's name reaches the table.
 */
const unusedSecretsDir = '/nonexistent/pickarr-test-secrets-unused';

/** A `Timers` whose calls are never fired -- no test here calls `host.start()`. Mirrors `feeds/add.test.ts`'s own. */
function fakeTimers(): Timers {
  let nextHandle = 0;
  return {
    setTimeout: () => ++nextHandle,
    clearTimeout: () => {},
    setInterval: () => ++nextHandle,
    clearInterval: () => {},
  };
}

/** One `saveSecret` call, as `setupHost` records it. */
interface SavedSecret {
  name: string;
  value: string;
}

interface Harness {
  host: Host;
  raw: DatabaseSync;
  /** The real secrets instance, so a test can resolve a name the row holds back to its value. */
  secrets: Secrets;
  /** Every `saveSecret` call the host made, in order. */
  saved: SavedSecret[];
  /** Every client id `Host.scheduleReconcile` was asked for. */
  scheduled: number[];
}

/**
 * A real host over a migrated in-memory database.
 *
 * `secrets` is the **real** `createSecrets`, wrapped so every `saveSecret`
 * is recorded on its way through rather than replaced by a fake. Both halves
 * matter: the recording is how a test sees which name a value was stored
 * under, and the real write is what puts a row in `secret` so `get` can
 * resolve that name afterwards. A pure fake would let a host that stored the
 * name nowhere still pass every "was it called" assertion.
 *
 * `scheduleReconcile` is wrapped the same way `feeds/add.test.ts` wraps
 * `schedulePoll`, and for the same reason: `Host.addDownloadClient` calls
 * this host's own public method, so wrapping it observes exactly that call
 * with no reach into `host.ts`'s internals.
 */
function setupHost(): Harness {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);

  const saved: SavedSecret[] = [];
  const real = createSecrets({ raw, baseDir: unusedSecretsDir, now: () => 1000 });
  const secrets: Secrets = {
    get: (name) => real.get(name),
    saveSecret: (name, value) => {
      saved.push({ name, value });
      real.saveSecret(name, value);
    },
  };

  const host = createHost({
    raw,
    db,
    fetch: unusedFetch,
    downloads: () => unusedDownloads,
    secrets,
    now: () => 1000,
    artworkDir: unusedArtworkDir,
    timers: fakeTimers(),
  });

  const scheduled: number[] = [];
  const realScheduleReconcile = host.scheduleReconcile.bind(host);
  host.scheduleReconcile = async (clientId, runAt) => {
    scheduled.push(clientId);
    return realScheduleReconcile(clientId, runAt);
  };

  return { host, raw, secrets, saved, scheduled };
}

/** A valid qBittorrent-bearer `AddDownloadClientInput`, so each test overrides only the fields it means to change. */
function input(overrides?: Partial<AddDownloadClientInput>): AddDownloadClientInput {
  return {
    name: 'qBit',
    implementation: 'qbittorrent',
    url: 'http://qbit.example:8080',
    category: 'pickarr',
    apiKey: API_KEY,
    username: '',
    password: '',
    ...overrides,
  };
}

/**
 * The whole `download_client` row as a plain object.
 *
 * `SELECT *`, deliberately: the property under test is that **no** column
 * holds a credential, and a hand-written column list would stop covering a
 * column added after this test was written -- which is exactly the column a
 * later slice would be tempted to put a credential in. `download_client` is
 * not one of `check-test-hygiene.ts`'s credential tables (those are
 * `auth_account`, `auth_session`, `host_state` and `secret`), so the star is
 * allowed here and says something the enumeration could not.
 *
 * Spread into a plain object because `node:sqlite` rows have a null
 * prototype and `deepEqual` compares prototypes -- the same normalisation
 * `feeds/add.test.ts` does.
 */
function clientRow(raw: DatabaseSync, id: number): Record<string, unknown> {
  const row = raw.prepare('SELECT * FROM download_client WHERE id = ?').get(id);
  assert.ok(row, `download_client ${String(id)} exists`);
  return { ...row };
}

/** The id out of an accepted result, failing with the refusal's own code when there is one. */
function acceptedId(result: { id: number } | { refusal: string }): number {
  assert.ok(!('refusal' in result), `expected an accepted client, got refusal ${'refusal' in result ? result.refusal : ''}`);
  return result.id;
}

/**
 * Every argument of every `console` call `run` made, as one json string.
 *
 * `hostLog` (`host.ts`) writes straight to `console.log` with a message and
 * a detail object, so there is no injectable logger on this path to capture
 * -- replacing the four console methods for the duration is what observes
 * the real one. The detail objects are kept as values rather than
 * `String`-ed (which `main.test.ts`'s own `captureConsole` does, and which
 * would flatten every one of them to `[object Object]` and hide a credential
 * sitting in a field).
 *
 * Restored in a `finally`, so a throwing `run` does not leave the rest of
 * the suite writing into this array.
 */
async function captureConsole(run: () => Promise<void>): Promise<string> {
  const calls: unknown[][] = [];
  const record = (...args: unknown[]): void => { calls.push(args); };
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.error = record;
  try {
    await run();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  return JSON.stringify(calls);
}

test('a sabnzbd client stores its api key by name, never by value', async () => {
  const { host, raw, secrets, saved } = setupHost();

  const id = acceptedId(await host.addDownloadClient(input({
    name: 'Sab',
    implementation: 'sabnzbd',
    url: 'http://sab.example:8080',
    apiKey: API_KEY,
  })));

  const row = clientRow(raw, id);
  const secretName = row['api_key_secret_name'];
  assert.equal(typeof secretName, 'string', 'the row holds a secret name');
  assert.notEqual(secretName, API_KEY, 'and that name is not the api key itself');

  assert.deepEqual(saved, [{ name: secretName, value: API_KEY }], 'saveSecret was called once, with that name and the real key');
  assert.equal(await secrets.get(String(secretName)), API_KEY, 'and the name resolves to the key');
});

test('no column of the row holds either credential', async () => {
  // The whole point of the indirection migration 14 introduced, asserted
  // over every column there is rather than the two a credential would
  // plausibly land in -- `username` is the obvious third, and the next
  // column someone adds is the one nobody would think to list.
  const { host, raw } = setupHost();

  const bearerId = acceptedId(await host.addDownloadClient(input({ name: 'Bearer', apiKey: API_KEY })));
  const loginId = acceptedId(await host.addDownloadClient(input({
    name: 'Login',
    apiKey: '',
    username: 'operator',
    password: PASSWORD,
  })));

  for (const [label, id] of [['bearer', bearerId], ['login', loginId]] as const) {
    for (const [column, value] of Object.entries(clientRow(raw, id))) {
      // `String(null)` is `'null'` and `String(1000)` is `'1000'`; neither
      // contains either credential, so coercing every column is safe and
      // means a credential stored as anything but a string is still caught.
      assert.ok(
        !String(value).includes(API_KEY),
        `${label}: download_client.${column} must not hold the api key`,
      );
      assert.ok(
        !String(value).includes(PASSWORD),
        `${label}: download_client.${column} must not hold the password`,
      );
    }
  }
});

test('a qbittorrent login client keeps its username in the clear and its password by name', async () => {
  const { host, raw, secrets, saved } = setupHost();

  const id = acceptedId(await host.addDownloadClient(input({
    apiKey: '',
    username: 'operator',
    password: PASSWORD,
  })));

  const row = clientRow(raw, id);
  assert.equal(row['username'], 'operator', 'a username is not a credential, so it is stored plaintext');
  assert.equal(row['api_key_secret_name'], null, 'and the login strategy stores no api key name');

  const secretName = row['password_secret_name'];
  assert.equal(typeof secretName, 'string', 'the row holds a secret name for the password');
  assert.notEqual(secretName, PASSWORD, 'and that name is not the password itself');

  assert.deepEqual(saved, [{ name: secretName, value: PASSWORD }], 'saveSecret was called once, with that name and the real password');
  assert.equal(await secrets.get(String(secretName)), PASSWORD, 'and the name resolves to the password');
});

test('a qbittorrent client with an api key reads back as the bearer strategy', async () => {
  // Read back through `readClientConfig`, not by inspecting the row: which
  // of qBittorrent's two strategies a row means is that function's decision,
  // and a row this writer produced has to land on the branch it intended.
  const { host, raw, secrets } = setupHost();

  const id = acceptedId(await host.addDownloadClient(input({ apiKey: API_KEY })));
  const config = await readClientConfig(raw, id, secrets);

  assert.equal(config.kind, 'qbittorrent-bearer');
  assert.ok('apiKey' in config && config.apiKey === API_KEY, 'and the resolved credential is the one submitted');
});

test('a qbittorrent login client reads back as the login strategy', async () => {
  const { host, raw, secrets } = setupHost();

  const id = acceptedId(await host.addDownloadClient(input({
    apiKey: '',
    username: 'operator',
    password: PASSWORD,
  })));
  const config = await readClientConfig(raw, id, secrets);

  assert.equal(config.kind, 'qbittorrent-login');
  assert.ok('password' in config && config.password === PASSWORD, 'and the resolved credential is the one submitted');
});

test('a sabnzbd client reads back as the sabnzbd strategy', async () => {
  const { host, raw, secrets } = setupHost();

  const id = acceptedId(await host.addDownloadClient(input({
    name: 'Sab',
    implementation: 'sabnzbd',
    apiKey: API_KEY,
  })));
  const config = await readClientConfig(raw, id, secrets);

  assert.equal(config.kind, 'sabnzbd');
  assert.ok('apiKey' in config && config.apiKey === API_KEY, 'and the resolved credential is the one submitted');
});

test('type is derived from the implementation and never taken from the caller', async () => {
  // `readClientConfig` treats a type/implementation mismatch as fatal, so a
  // row whose two disagree cannot work at all. Spelled as literals here
  // rather than computed from the implementation: an expectation derived by
  // the same rule as the code cannot see that rule change.
  const { host, raw } = setupHost();

  const torrentId = acceptedId(await host.addDownloadClient(input({ name: 'qBit', implementation: 'qbittorrent' })));
  const nzbId = acceptedId(await host.addDownloadClient(input({ name: 'Sab', implementation: 'sabnzbd' })));

  assert.equal(clientRow(raw, torrentId)['type'], 'torrent');
  assert.equal(clientRow(raw, nzbId)['type'], 'nzb');
});

test('an unknown implementation is refused', async () => {
  const { host, saved } = setupHost();
  assert.deepEqual(
    await host.addDownloadClient(input({ implementation: 'transmission' })),
    { refusal: 'unknown-implementation' },
  );
  assert.deepEqual(saved, [], 'and nothing was written to the secret store on the way to refusing');
});

test('an auth shape no strategy can use is refused', async () => {
  // Each of the four shapes `readClientConfig` could not resolve, refused
  // here instead of at the far end of a submit call.
  const { host, saved } = setupHost();
  const badShape = { refusal: 'bad-auth-shape' };

  assert.deepEqual(
    await host.addDownloadClient(input({ implementation: 'sabnzbd', apiKey: '', username: 'operator', password: PASSWORD })),
    badShape,
    'sabnzbd has one strategy and it is an api key',
  );
  assert.deepEqual(
    await host.addDownloadClient(input({ apiKey: '', username: '', password: '' })),
    badShape,
    'qbittorrent with neither credential can authenticate no way at all',
  );
  assert.deepEqual(
    await host.addDownloadClient(input({ apiKey: API_KEY, username: 'operator', password: PASSWORD })),
    badShape,
    'qbittorrent with both leaves the strategy to be guessed',
  );
  assert.deepEqual(
    await host.addDownloadClient(input({ apiKey: '', username: 'operator', password: '' })),
    badShape,
    'a username with no password is not half of a usable pair',
  );

  assert.deepEqual(saved, [], 'and no refusal reached the secret store');
});

test('a sabnzbd client with an api key and a username is refused', async () => {
  // Separate from the four above because it is the one shape that *would*
  // have worked: `readClientConfig`'s sabnzbd branch reads the api key and
  // ignores `username` entirely, so accepting this would store a username
  // nothing will ever send. Refused so the row cannot claim a credential it
  // does not use.
  const { host } = setupHost();
  assert.deepEqual(
    await host.addDownloadClient(input({ implementation: 'sabnzbd', apiKey: API_KEY, username: 'operator', password: '' })),
    { refusal: 'bad-auth-shape' },
  );
});

test('a name already on file is refused, not thrown', async () => {
  // `download_client` carries a uniqueIndex on `name`, so the second insert
  // raises a real SQLite constraint violation. Driven through a real second
  // insert rather than a stubbed error: the uniqueness lives in the table,
  // and a pre-check would leave two concurrent creates free to both pass it.
  const { host, raw } = setupHost();

  const first = await host.addDownloadClient(input({ name: 'Shared' }));
  assert.ok('id' in first, 'the first insert succeeds');

  const second = await host.addDownloadClient(input({ name: 'Shared', url: 'http://other.example:8080' }));
  assert.deepEqual(second, { refusal: 'duplicate-name' });

  const count = raw.prepare('SELECT COUNT(*) AS n FROM download_client').get();
  assert.equal(Number((count as { n: unknown }).n), 1, 'and the second create left no row behind');
});

/** Every `secret` name on file, and every secret name a `download_client` row points at. */
function secretNames(raw: DatabaseSync): { stored: string[]; referenced: string[] } {
  // `name` only -- never `value`. `secrets/store.ts` is the one module
  // allowed to name `secret.value` in SQL (`check-test-hygiene.ts`'s
  // `CREDENTIAL_ALLOW_LIST`), and this test has no business reading one.
  const stored = raw.prepare('SELECT name FROM secret ORDER BY name').all()
    .map((row) => String((row as { name: unknown }).name));
  const referenced = raw.prepare(
    'SELECT api_key_secret_name AS n FROM download_client WHERE api_key_secret_name IS NOT NULL '
    + 'UNION SELECT password_secret_name AS n FROM download_client WHERE password_secret_name IS NOT NULL',
  ).all().map((row) => String((row as { n: unknown }).n));
  return { stored, referenced };
}

test('the credential is stored before the row, so a refused duplicate leaves an orphan and never a dangling name', async () => {
  // **This is the test for design spec §8.6's ordering decision**, which was
  // argued in `clients/add.ts`'s docblock and enforced by nothing: swapping
  // to insert-then-save left the whole file green, because on every path
  // that *succeeds* the two orderings are indistinguishable.
  //
  // The refused duplicate is what tells them apart, and it is observable as
  // a count. `saveSecret` first: the second create stores its credential,
  // then loses the race on `download_client_name`, and the secret it wrote
  // is left referenced by nobody -- two secrets, one row. Insert first: the
  // insert raises before `saveSecret` is ever reached, so there is one
  // secret and no orphan.
  //
  // An orphan is the outcome this module deliberately prefers, so this
  // asserts its presence rather than treating it as a leak. `clients/add.ts`
  // has why it is harmless: nothing enumerates `secret`, it is read by name
  // alone, and `sync/tables.ts` keeps it out of the replica.
  const { host, raw } = setupHost();

  const first = await host.addDownloadClient(input({ name: 'Shared', apiKey: API_KEY }));
  assert.ok('id' in first, 'the first create succeeds');

  const second = await host.addDownloadClient(input({ name: 'Shared', apiKey: PASSWORD }));
  assert.deepEqual(second, { refusal: 'duplicate-name' }, 'and the second loses the name race');

  const { stored, referenced } = secretNames(raw);
  assert.equal(stored.length, 2, 'both creates reached the secret store, the refused one included');
  assert.equal(referenced.length, 1, 'but only the accepted create left a row behind');

  const orphans = stored.filter((name) => !referenced.includes(name));
  assert.equal(orphans.length, 1, 'so exactly one stored secret is referenced by no row');
  // The other direction, which is the failure this ordering exists to make
  // impossible: no row may name a secret that was never stored.
  const dangling = referenced.filter((name) => !stored.includes(name));
  assert.deepEqual(dangling, [], 'and no row names a secret the store does not have');
});

test('a constraint violation that is not the duplicate name is raised, not reported as a duplicate', async () => {
  // The `errcode` half of `isUniqueConstraintViolation` was pinned by
  // nothing: dropping it left the file green, so **any** `ERR_SQLITE_ERROR`
  // out of the insert -- a genuine bug -- would have been answered
  // `duplicate-name` and looked to a client like an ordinary name clash.
  //
  // Injected with a `BEFORE INSERT` trigger raising `ABORT`, which fails the
  // statement and leaves the error to the caller exactly as a real
  // constraint failure does. Measured on node 24: `code`
  // `'ERR_SQLITE_ERROR'` -- the same code a unique violation carries, which
  // is the whole point -- and `errcode` 1811, not 2067. `ABORT` rather than
  // `ROLLBACK`: CLAUDE.md records that `RAISE(ROLLBACK)` unwinds first and
  // ends up testing SQLite instead of this code.
  const { host, raw } = setupHost();
  raw.exec(
    "CREATE TRIGGER block_client_insert BEFORE INSERT ON download_client "
    + "BEGIN SELECT RAISE(ABORT, 'injected non-unique constraint failure'); END;",
  );

  await assert.rejects(
    () => host.addDownloadClient(input()),
    (error: unknown) => {
      assert.ok(error instanceof Error, 'a real error propagated');
      assert.ok(
        'code' in error && error.code === 'ERR_SQLITE_ERROR',
        'and it is the same error code a unique violation carries',
      );
      assert.ok(
        'errcode' in error && error.errcode !== 2067,
        'but not the unique-constraint errcode, which is what tells the two apart',
      );
      return true;
    },
    'a constraint failure this module does not understand must reach the caller, not become a refusal',
  );
});

test('a url that is not an http address is refused', async () => {
  const { host, saved } = setupHost();
  const badUrl = { refusal: 'bad-url' };

  assert.deepEqual(await host.addDownloadClient(input({ url: '' })), badUrl, 'nothing at all');
  assert.deepEqual(await host.addDownloadClient(input({ url: 'not a url at all' })), badUrl, 'prose');
  assert.deepEqual(await host.addDownloadClient(input({ url: 'http://' })), badUrl, 'a scheme with no host');
  // The one that matters, and the one "does it parse?" alone would have let
  // through: omitting `http://` gives a url that parses as scheme
  // `qbit.example:` with the opaque path `8080` -- `hostname` empty,
  // `origin` the literal string `null`. Measured on node 24. A row built
  // from it names no host for an adapter to dial, and design spec §5's
  // projection would show the operator `null8080`.
  assert.deepEqual(await host.addDownloadClient(input({ url: 'qbit.example:8080' })), badUrl, 'a missing scheme');
  assert.deepEqual(await host.addDownloadClient(input({ url: 'file:///srv/qbit' })), badUrl, 'a scheme with no network host');

  assert.deepEqual(saved, [], 'and no refused url reached the secret store');
});

test('https is an address as much as http is', async () => {
  // The other side of the scheme check: it is a two-member allow-list, not
  // a test for `http:`, and a client behind TLS is the ordinary case.
  const { host, raw } = setupHost();
  const id = acceptedId(await host.addDownloadClient(input({ url: 'https://qbit.example/' })));
  assert.equal(clientRow(raw, id)['url'], 'https://qbit.example/');
});

test('an empty category is accepted and stored, because it means "no category"', async () => {
  // Not a missing value and not a refusal: `reconcile-job.ts:287` folds
  // `config.category` through `normalizeClientCategory`, which maps `''`
  // and the literal `'None'` to `null`, so a blank category reconciles
  // everything rather than asking for a category named "". qBittorrent's
  // send side folds it again; SABnzbd's deliberately does not.
  //
  // Pinned because it is currently one tidy-up away from someone adding a
  // spurious `bad-category` refusal for a value the rest of the system
  // already understands. `''`, not `null`: the column is `NOT NULL`, and
  // this is the one input field `nullIfBlank` does not touch.
  const { host, raw } = setupHost();

  const id = acceptedId(await host.addDownloadClient(input({ category: '' })));
  assert.equal(clientRow(raw, id)['category'], '', 'stored as the empty string the operator chose');

  // And the fold the reconcile path performs on it, asserted through the
  // real function rather than restated: a test that spelled `null` without
  // going through `normalizeClientCategory` would not notice that fold
  // being removed.
  assert.equal(normalizeClientCategory(String(clientRow(raw, id)['category'])), null,
    'which every consumer reads as "no category"');
});

test('import_mode is written as a constant, spelled here so changing it is a visible decision', async () => {
  // Nothing in 2.0 reads this column -- `clients/add.ts`'s own
  // `IMPORT_MODE` has the measurement -- so there is no behaviour to assert
  // and this pins the literal instead. That is the point: the column is
  // `NOT NULL` and the value is inert, which is exactly the combination
  // that lets it drift unnoticed. `copy` is what `scripts/seed-client.ts`
  // documents and the value 1.x refused for qBittorrent is `move`, so a
  // change here is worth one red test.
  const { host, raw } = setupHost();
  const qbit = acceptedId(await host.addDownloadClient(input({ name: 'qBit' })));
  const sab = acceptedId(await host.addDownloadClient(input({ name: 'Sab', implementation: 'sabnzbd' })));
  assert.equal(clientRow(raw, qbit)['import_mode'], 'copy');
  assert.equal(clientRow(raw, sab)['import_mode'], 'copy');
});

test('a url is stored exactly as submitted', async () => {
  // Nothing is normalised on the way in. Design spec §5 puts the
  // `origin + pathname` narrowing on the *projection* to the replica, not on
  // the row, because the row is what an adapter actually dials -- dropping a
  // query string here would silently change where a request goes.
  const { host, raw } = setupHost();
  const id = acceptedId(await host.addDownloadClient(input({ url: 'http://qbit.example:8080/base/' })));
  assert.equal(clientRow(raw, id)['url'], 'http://qbit.example:8080/base/');
});

test('creating a client schedules its first reconcile', async () => {
  const { host, scheduled, raw } = setupHost();
  const id = acceptedId(await host.addDownloadClient(input()));
  assert.deepEqual(scheduled, [id], 'the new client is reconciled at once, not after a restart');

  const job = raw.prepare(
    "SELECT payload_json FROM jobs WHERE kind = 'reconcile' AND state = 'ready'",
  ).get();
  assert.ok(job, 'and a real job row was enqueued for it');
  assert.deepEqual(
    JSON.parse(String((job as { payload_json: unknown }).payload_json)),
    { clientId: id },
    'naming the client that was just created',
  );
});

test('a refused client schedules nothing', async () => {
  const { host, scheduled } = setupHost();
  await host.addDownloadClient(input({ implementation: 'transmission' }));
  await host.addDownloadClient(input({ url: 'not a url at all' }));
  assert.deepEqual(scheduled, [], 'nothing was scheduled for a client that was never created');
});

test('neither credential appears in any log line', async () => {
  // Global constraint: a credential reaches `saveSecret` without touching a
  // log. Captured over the whole call -- the insert, `saveSecret`, and the
  // `scheduleReconcile` that follows it, which is the one step on this path
  // with a logger wired into it at all.
  const written = await captureConsole(async () => {
    const { host } = setupHost();
    const bearer = await host.addDownloadClient(input({ name: 'Bearer', apiKey: API_KEY }));
    assert.ok('id' in bearer);
    const login = await host.addDownloadClient(input({
      name: 'Login',
      apiKey: '',
      username: 'operator',
      password: PASSWORD,
    }));
    assert.ok('id' in login);
    // A refusal too: an error path is where a value gets echoed back into a
    // message by someone trying to be helpful.
    assert.deepEqual(
      await host.addDownloadClient(input({ implementation: 'transmission' })),
      { refusal: 'unknown-implementation' },
    );
  });

  assert.ok(!written.includes(API_KEY), 'the api key is written down nowhere');
  assert.ok(!written.includes(PASSWORD), 'and neither is the password');
});
