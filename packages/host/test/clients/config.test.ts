import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { readClientConfig } from '../../src/clients/config.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import type { Secrets } from '../../src/secrets/instance.ts';
import { SecretNotFound } from '../../src/secrets/names.ts';

/**
 * A secrets subsystem over this database and a directory that does not
 * exist, so the chain's file link finds nothing and every resolution comes
 * from the `secret` table a test seeded through `saveSecret`. The
 * environment link is not exercised here -- `test/secrets/` owns that.
 */
function makeSecrets(raw: DatabaseSync): Secrets {
  return createSecrets({ raw, baseDir: '/nonexistent-secrets-dir' });
}

/**
 * Inserts one `download_client` row and returns its id. Every column
 * `readClientConfig` might read is a parameter, defaulted to a shape that
 * would otherwise pass every check, so each test only names the columns its
 * scenario actually cares about.
 *
 * The two credential columns are `apiKeySecretName` and
 * `passwordSecretName`: since migration 14 the row holds the *name* of a
 * secret, never its value, so what a test seeds here is a name and the value
 * goes in through `Secrets.saveSecret`. `username` is a plain string
 * because a username is not a credential.
 *
 * `name` defaults from `id` when one is given, because `download_client_name`
 * is unique and two rows in one test would otherwise collide on the default.
 */
function insertClient(raw: DatabaseSync, overrides: {
  id?: number;
  name?: string;
  type?: string;
  implementation?: string;
  url?: string;
  apiKeySecretName?: string | null;
  username?: string | null;
  passwordSecretName?: string | null;
  category?: string;
}): number {
  const row = {
    name: overrides.id === undefined ? 'Client' : `Client ${overrides.id}`,
    type: 'torrent',
    implementation: 'qbittorrent',
    url: 'https://example.com',
    apiKeySecretName: null,
    username: null,
    passwordSecretName: null,
    category: 'movies',
    ...overrides,
  };
  if (row.id === undefined) {
    raw.prepare(`
      INSERT INTO download_client
        (name, type, implementation, url, api_key_secret_name, username, password_secret_name,
         category, import_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'copy', 1, 1)
    `).run(
      row.name, row.type, row.implementation, row.url,
      row.apiKeySecretName, row.username, row.passwordSecretName, row.category,
    );
  } else {
    raw.prepare(`
      INSERT INTO download_client
        (id, name, type, implementation, url, api_key_secret_name, username, password_secret_name,
         category, import_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'copy', 1, 1)
    `).run(
      row.id, row.name, row.type, row.implementation, row.url,
      row.apiKeySecretName, row.username, row.passwordSecretName, row.category,
    );
  }
  const inserted = raw.prepare('SELECT id FROM download_client WHERE name = ?').get(row.name);
  return Number((inserted as { id: unknown }).id);
}

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

test('a sabnzbd row reads as a sabnzbd config', async () => {
  const raw = setup();
  const secrets = makeSecrets(raw);
  secrets.saveSecret('a3f1b2c4-0000-4000-8000-000000000010', 'nzb-key-1');
  const id = insertClient(raw, {
    name: 'Nzb Client',
    type: 'nzb',
    implementation: 'sabnzbd',
    apiKeySecretName: 'a3f1b2c4-0000-4000-8000-000000000010',
    category: 'tv',
  });

  const config = await readClientConfig(raw, id, secrets);

  assert.deepEqual(config, {
    kind: 'sabnzbd', id, baseUrl: 'https://example.com', apiKey: 'nzb-key-1', category: 'tv',
  });
});

test('a sabnzbd row resolves its api key through the secrets subsystem', async () => {
  const raw = setup();
  const secrets = makeSecrets(raw);
  secrets.saveSecret('a3f1b2c4-0000-4000-8000-000000000001', 'sab-api-key');
  insertClient(raw, { id: 1, implementation: 'sabnzbd', type: 'nzb', apiKeySecretName: 'a3f1b2c4-0000-4000-8000-000000000001' });

  const config = await readClientConfig(raw, 1, secrets);
  assert.equal(config.kind, 'sabnzbd');
  assert.equal(config.kind === 'sabnzbd' ? config.apiKey : null, 'sab-api-key', 'the resolved credential, not the name');
});

test('a qbittorrent row with an api key name uses bearer, and one with a password name uses login', async () => {
  const raw = setup();
  const secrets = makeSecrets(raw);
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
  const raw = setup();
  const secrets = makeSecrets(raw);
  // A qbittorrent row rather than a sabnzbd one, so that a credential this
  // read could leak actually exists. The api key name has no `secret` row
  // behind it -- a rotated or hand-edited name -- and the password name
  // does. Bearer is decided on the api key name, so the read fails there;
  // the resolvable password is the row's other credential and must appear in
  // nothing. With no credential anywhere near the row, the second half of
  // this test's name would be a claim it could not check.
  const SECRET_PASSWORD = 'recognisable-password-marker';
  const MISSING_NAME = 'a3f1b2c4-0000-4000-8000-000000000004';
  secrets.saveSecret('a3f1b2c4-0000-4000-8000-000000000007', SECRET_PASSWORD);
  insertClient(raw, {
    id: 1,
    implementation: 'qbittorrent',
    type: 'torrent',
    apiKeySecretName: MISSING_NAME,
    username: 'admin',
    passwordSecretName: 'a3f1b2c4-0000-4000-8000-000000000007',
  });

  await assert.rejects(
    () => readClientConfig(raw, 1, secrets),
    (err: unknown) => err instanceof SecretNotFound
      // The name it could not resolve, which is the whole diagnostic and is
      // safe to carry: a name is not a secret.
      && err.secretName === MISSING_NAME
      && err.message.includes(MISSING_NAME)
      // And nothing else. `SecretNotFound` exists because the chain's own
      // `ProviderError` joins every link's failure, `fromFile`'s full path
      // included (design spec §2.4).
      && !err.message.includes(SECRET_PASSWORD)
      && !err.message.includes('admin')
      && !err.message.includes('nonexistent-secrets-dir'),
  );
});

test('the strategy is chosen before any secret is resolved', async () => {
  const raw = setup();
  const secrets = makeSecrets(raw);
  // No secret rows at all. A qbittorrent row with neither name must fail on
  // its own missing configuration, not on a secret lookup.
  insertClient(raw, { id: 1, implementation: 'qbittorrent', type: 'torrent' });
  await assert.rejects(
    () => readClientConfig(raw, 1, secrets),
    /neither an api key nor a username and password/,
  );
});

test('only the chosen strategy\'s secret is resolved, so a stale password name cannot break a bearer client', async () => {
  // The isolating case for "decide first, then resolve". This row carries a
  // resolvable api key name -- which decides `qbittorrent-bearer` outright --
  // beside a stale password name whose `secret` row no longer exists. The
  // login credential is not the one this strategy uses, so it is never looked
  // up and the read succeeds. A resolver that fetched both names before
  // choosing would raise `SecretNotFound` for a credential no request would
  // ever have sent.
  const raw = setup();
  const secrets = makeSecrets(raw);
  secrets.saveSecret('a3f1b2c4-0000-4000-8000-000000000005', 'qbt-api-key');
  const id = insertClient(raw, {
    id: 1,
    implementation: 'qbittorrent',
    type: 'torrent',
    apiKeySecretName: 'a3f1b2c4-0000-4000-8000-000000000005',
    username: 'admin',
    // Named, never saved: the name is present and resolves to nothing.
    passwordSecretName: 'a3f1b2c4-0000-4000-8000-000000000006',
  });

  const config = await readClientConfig(raw, id, secrets);
  assert.equal(config.kind, 'qbittorrent-bearer');
  assert.equal(config.kind === 'qbittorrent-bearer' ? config.apiKey : null, 'qbt-api-key');
});

test('a qbittorrent row with an api key reads as the bearer strategy', async () => {
  const raw = setup();
  const secrets = makeSecrets(raw);
  secrets.saveSecret('a3f1b2c4-0000-4000-8000-000000000020', 'bearer-key-1');
  secrets.saveSecret('a3f1b2c4-0000-4000-8000-000000000021', 'stale-pass');
  // A stale username and password name ride along too: the point of this test
  // is that an api key wins the strategy outright, not merely that it works
  // when login fields happen to be absent.
  const id = insertClient(raw, {
    name: 'Bearer Client',
    type: 'torrent',
    implementation: 'qbittorrent',
    apiKeySecretName: 'a3f1b2c4-0000-4000-8000-000000000020',
    username: 'stale-user',
    passwordSecretName: 'a3f1b2c4-0000-4000-8000-000000000021',
    category: 'movies',
  });

  const config = await readClientConfig(raw, id, secrets);

  assert.deepEqual(config, {
    kind: 'qbittorrent-bearer', id, baseUrl: 'https://example.com', apiKey: 'bearer-key-1', category: 'movies',
  });
});

test('a qbittorrent row with only a username and password reads as the login strategy', async () => {
  const raw = setup();
  const secrets = makeSecrets(raw);
  secrets.saveSecret('a3f1b2c4-0000-4000-8000-000000000022', 'login-pass-1');
  const id = insertClient(raw, {
    name: 'Login Client',
    type: 'torrent',
    implementation: 'qbittorrent',
    username: 'login-user-1',
    passwordSecretName: 'a3f1b2c4-0000-4000-8000-000000000022',
    category: 'movies',
  });

  const config = await readClientConfig(raw, id, secrets);

  assert.deepEqual(config, {
    kind: 'qbittorrent-login',
    id,
    baseUrl: 'https://example.com',
    username: 'login-user-1',
    password: 'login-pass-1',
    category: 'movies',
  });
});

test('a qbittorrent row with neither an api key nor a username and password is refused, naming the client and the missing fields', async () => {
  const raw = setup();
  const secrets = makeSecrets(raw);
  const id = insertClient(raw, { name: 'Bare Client', type: 'torrent', implementation: 'qbittorrent' });

  await assert.rejects(
    () => readClientConfig(raw, id, secrets),
    (err: unknown) => err instanceof Error
      && err.message.includes(String(id))
      && err.message.includes('Bare Client')
      && err.message.includes('api key')
      && err.message.includes('username and password'),
  );
});

test('a torrent row implemented by sabnzbd is refused', async () => {
  // The pairing is nonsense: refuse when the row is read, not at first submit.
  const raw = setup();
  const secrets = makeSecrets(raw);
  const id = insertClient(raw, {
    name: 'Mismatched Client',
    type: 'torrent',
    implementation: 'sabnzbd',
    apiKeySecretName: 'a3f1b2c4-0000-4000-8000-000000000030',
  });

  await assert.rejects(
    () => readClientConfig(raw, id, secrets),
    (err: unknown) => err instanceof Error
      && err.message.includes(String(id))
      && err.message.includes('torrent')
      && err.message.includes('sabnzbd'),
  );
});

test('an nzb row implemented by qbittorrent is refused', async () => {
  const raw = setup();
  const secrets = makeSecrets(raw);
  const id = insertClient(raw, {
    name: 'Mismatched Client',
    type: 'nzb',
    implementation: 'qbittorrent',
    apiKeySecretName: 'a3f1b2c4-0000-4000-8000-000000000030',
  });

  await assert.rejects(
    () => readClientConfig(raw, id, secrets),
    (err: unknown) => err instanceof Error
      && err.message.includes(String(id))
      && err.message.includes('nzb')
      && err.message.includes('qbittorrent'),
  );
});

test('an unknown implementation is refused, naming only the value', async () => {
  const raw = setup();
  const secrets = makeSecrets(raw);
  const id = insertClient(raw, {
    name: 'Plex Client',
    type: 'torrent',
    implementation: 'plex',
    apiKeySecretName: 'a3f1b2c4-0000-4000-8000-000000000030',
  });

  await assert.rejects(
    () => readClientConfig(raw, id, secrets),
    (err: unknown) => err instanceof Error
      && err.message.includes(String(id))
      && err.message.includes('plex'),
  );
});

test('a blank secret name is refused exactly as a missing one is', async () => {
  // `''` is what a blank form field saves as, and for a secret name it means
  // the same as absent: neither addresses a credential. Without the fold,
  // this row reads as a valid bearer config and then fails on a secret
  // lookup for the empty name -- an illegal name, refused three links away
  // from "you did not configure an api key", which is exactly the
  // failure-far-from-its-cause `readClientConfig` exists to prevent.
  const raw = setup();
  const secrets = makeSecrets(raw);
  const blankKey = insertClient(raw, {
    name: 'Blank Key', type: 'torrent', implementation: 'qbittorrent', apiKeySecretName: '',
  });
  await assert.rejects(
    () => readClientConfig(raw, blankKey, secrets),
    (err: unknown) => err instanceof Error
      && err.message.includes('neither an api key')
      && err.message.includes(String(blankKey)),
  );

  // The same for the login strategy: a username with a blank password name is
  // not a usable pair, so it must not read as `qbittorrent-login`.
  const blankPassword = insertClient(raw, {
    name: 'Blank Password', type: 'torrent', implementation: 'qbittorrent',
    username: 'login-user-1', passwordSecretName: '',
  });
  await assert.rejects(
    () => readClientConfig(raw, blankPassword, secrets),
    (err: unknown) => err instanceof Error && err.message.includes('neither an api key'),
  );

  // And for sabnzbd, whose only strategy is a key.
  const blankSabnzbd = insertClient(raw, {
    name: 'Blank Sabnzbd', type: 'nzb', implementation: 'sabnzbd', apiKeySecretName: '',
  });
  await assert.rejects(
    () => readClientConfig(raw, blankSabnzbd, secrets),
    (err: unknown) => err instanceof Error && err.message.includes('no api key'),
  );
});

test('a refusal message contains no credential', async () => {
  // Since migration 14 the row holds secret *names*, which are safe to name
  // in a message. What must never appear is a resolved credential, so each
  // row below addresses a real secret and every refusal message is checked
  // against the values behind those names -- and against the plaintext
  // username, which is not a credential but is still nobody's business in an
  // error.
  const raw = setup();
  const secrets = makeSecrets(raw);
  const API_KEY_NAME = 'a3f1b2c4-0000-4000-8000-000000000040';
  const PASSWORD_NAME = 'a3f1b2c4-0000-4000-8000-000000000041';
  const SECRET_API_KEY = 'sk-recognisable-api-key-marker';
  const SECRET_USERNAME = 'recognisable-username-marker';
  const SECRET_PASSWORD = 'recognisable-password-marker';
  secrets.saveSecret(API_KEY_NAME, SECRET_API_KEY);
  secrets.saveSecret(PASSWORD_NAME, SECRET_PASSWORD);

  const unknownImplId = insertClient(raw, {
    name: 'Secret Client A',
    type: 'torrent',
    implementation: 'plex',
    apiKeySecretName: API_KEY_NAME,
    username: SECRET_USERNAME,
    passwordSecretName: PASSWORD_NAME,
  });
  const torrentAsSabnzbdId = insertClient(raw, {
    name: 'Secret Client B',
    type: 'torrent',
    implementation: 'sabnzbd',
    apiKeySecretName: API_KEY_NAME,
    username: SECRET_USERNAME,
    passwordSecretName: PASSWORD_NAME,
  });
  const nzbAsQbittorrentId = insertClient(raw, {
    name: 'Secret Client C',
    type: 'nzb',
    implementation: 'qbittorrent',
    apiKeySecretName: API_KEY_NAME,
    username: SECRET_USERNAME,
    passwordSecretName: PASSWORD_NAME,
  });

  // `allSettled` rather than a loop of awaits: every one of these reads must
  // be refused, so none of them races the others and there is nothing to
  // order. `assert.rejects` is not used because what this test needs is the
  // message each refusal carried, not merely that it happened.
  const ids = [unknownImplId, torrentAsSabnzbdId, nzbAsQbittorrentId];
  const outcomes = await Promise.allSettled(
    ids.map(async (id) => readClientConfig(raw, id, secrets)),
  );
  const messages = outcomes.map((outcome, index) => {
    assert.equal(outcome.status, 'rejected', `expected download client ${ids[index]} to be refused`);
    const reason: unknown = outcome.status === 'rejected' ? outcome.reason : undefined;
    assert.ok(reason instanceof Error);
    return reason.message;
  });

  assert.equal(messages.length, 3);
  for (const message of messages) {
    assert.equal(message.includes(SECRET_API_KEY), false, `leaked api key in: ${message}`);
    assert.equal(message.includes(SECRET_USERNAME), false, `leaked username in: ${message}`);
    assert.equal(message.includes(SECRET_PASSWORD), false, `leaked password in: ${message}`);
  }
});
