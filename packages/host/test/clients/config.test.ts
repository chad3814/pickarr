import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { readClientConfig } from '../../src/clients/config.ts';

/**
 * Inserts one `download_client` row and returns its id. Every column
 * `readClientConfig` might read is a parameter, defaulted to a shape that
 * would otherwise pass every check, so each test only names the columns its
 * scenario actually cares about.
 */
function seedClient(raw: DatabaseSync, overrides: {
  name?: string;
  type?: string;
  implementation?: string;
  url?: string;
  apiKey?: string | null;
  username?: string | null;
  password?: string | null;
  category?: string;
}): number {
  const row = {
    name: 'Client',
    type: 'torrent',
    implementation: 'qbittorrent',
    url: 'https://example.com',
    apiKey: null,
    username: null,
    password: null,
    category: 'movies',
    ...overrides,
  };
  raw.prepare(`
    INSERT INTO download_client
      (name, type, implementation, url, api_key, username, password, category, import_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'copy', 1, 1)
  `).run(row.name, row.type, row.implementation, row.url, row.apiKey, row.username, row.password, row.category);
  const inserted = raw.prepare('SELECT id FROM download_client WHERE name = ?').get(row.name);
  return Number((inserted as { id: unknown }).id);
}

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

test('a sabnzbd row reads as a sabnzbd config', () => {
  const raw = setup();
  const id = seedClient(raw, {
    name: 'Nzb Client', type: 'nzb', implementation: 'sabnzbd', apiKey: 'nzb-key-1', category: 'tv',
  });

  const config = readClientConfig(raw, id);

  assert.deepEqual(config, {
    kind: 'sabnzbd', id, baseUrl: 'https://example.com', apiKey: 'nzb-key-1', category: 'tv',
  });
});

test('a qbittorrent row with an api key reads as the bearer strategy', () => {
  const raw = setup();
  // A stale username and password ride along too: the point of this test is
  // that an api key wins the strategy outright, not merely that it works
  // when login fields happen to be absent.
  const id = seedClient(raw, {
    name: 'Bearer Client',
    type: 'torrent',
    implementation: 'qbittorrent',
    apiKey: 'bearer-key-1',
    username: 'stale-user',
    password: 'stale-pass',
    category: 'movies',
  });

  const config = readClientConfig(raw, id);

  assert.deepEqual(config, {
    kind: 'qbittorrent-bearer', id, baseUrl: 'https://example.com', apiKey: 'bearer-key-1', category: 'movies',
  });
});

test('a qbittorrent row with only a username and password reads as the login strategy', () => {
  const raw = setup();
  const id = seedClient(raw, {
    name: 'Login Client',
    type: 'torrent',
    implementation: 'qbittorrent',
    username: 'login-user-1',
    password: 'login-pass-1',
    category: 'movies',
  });

  const config = readClientConfig(raw, id);

  assert.deepEqual(config, {
    kind: 'qbittorrent-login',
    id,
    baseUrl: 'https://example.com',
    username: 'login-user-1',
    password: 'login-pass-1',
    category: 'movies',
  });
});

test('a qbittorrent row with neither an api key nor a username and password is refused, naming the client and the missing fields', () => {
  const raw = setup();
  const id = seedClient(raw, { name: 'Bare Client', type: 'torrent', implementation: 'qbittorrent' });

  assert.throws(
    () => readClientConfig(raw, id),
    (err: unknown) => err instanceof Error
      && err.message.includes(String(id))
      && err.message.includes('Bare Client')
      && err.message.includes('api key')
      && err.message.includes('username and password'),
  );
});

test('a torrent row implemented by sabnzbd is refused', () => {
  // The pairing is nonsense: refuse when the row is read, not at first submit.
  const raw = setup();
  const id = seedClient(raw, {
    name: 'Mismatched Client', type: 'torrent', implementation: 'sabnzbd', apiKey: 'some-key',
  });

  assert.throws(
    () => readClientConfig(raw, id),
    (err: unknown) => err instanceof Error
      && err.message.includes(String(id))
      && err.message.includes('torrent')
      && err.message.includes('sabnzbd'),
  );
});

test('an nzb row implemented by qbittorrent is refused', () => {
  const raw = setup();
  const id = seedClient(raw, {
    name: 'Mismatched Client', type: 'nzb', implementation: 'qbittorrent', apiKey: 'some-key',
  });

  assert.throws(
    () => readClientConfig(raw, id),
    (err: unknown) => err instanceof Error
      && err.message.includes(String(id))
      && err.message.includes('nzb')
      && err.message.includes('qbittorrent'),
  );
});

test('an unknown implementation is refused, naming only the value', () => {
  // The value, never the row. Serialising a client row prints an api key.
  const raw = setup();
  const id = seedClient(raw, { name: 'Plex Client', type: 'torrent', implementation: 'plex', apiKey: 'some-key' });

  assert.throws(
    () => readClientConfig(raw, id),
    (err: unknown) => err instanceof Error
      && err.message.includes(String(id))
      && err.message.includes('plex')
      && !err.message.includes('some-key'),
  );
});

test('a blank credential is refused exactly as a missing one is', () => {
  // `''` is what a blank form field saves as, and for a credential it means
  // the same as absent: neither authenticates anything. Without the fold,
  // this row reads as a valid bearer config and fails later against the real
  // client, with the client's own opaque 401 standing in for "you did not
  // configure an api key".
  const raw = setup();
  const blankKey = seedClient(raw, {
    name: 'Blank Key', type: 'torrent', implementation: 'qbittorrent', apiKey: '',
  });
  assert.throws(
    () => readClientConfig(raw, blankKey),
    (err: unknown) => err instanceof Error
      && err.message.includes('neither an api key')
      && err.message.includes(String(blankKey)),
  );

  // The same for the login strategy: a username with a blank password is not
  // a usable pair, so it must not read as `qbittorrent-login`.
  const blankPassword = seedClient(raw, {
    name: 'Blank Password', type: 'torrent', implementation: 'qbittorrent',
    username: 'login-user-1', password: '',
  });
  assert.throws(
    () => readClientConfig(raw, blankPassword),
    (err: unknown) => err instanceof Error && err.message.includes('neither an api key'),
  );

  // And for sabnzbd, whose only strategy is a key.
  const blankSabnzbd = seedClient(raw, {
    name: 'Blank Sabnzbd', type: 'nzb', implementation: 'sabnzbd', apiKey: '',
  });
  assert.throws(
    () => readClientConfig(raw, blankSabnzbd),
    (err: unknown) => err instanceof Error && err.message.includes('no api key'),
  );
});

test('a refusal message contains no credential', () => {
  // Build a row with a recognisable secret, trigger each refusal, and assert
  // the secret appears in none of the messages.
  const raw = setup();
  const SECRET_API_KEY = 'sk-recognisable-api-key-marker';
  const SECRET_USERNAME = 'recognisable-username-marker';
  const SECRET_PASSWORD = 'recognisable-password-marker';

  const unknownImplId = seedClient(raw, {
    name: 'Secret Client A',
    type: 'torrent',
    implementation: 'plex',
    apiKey: SECRET_API_KEY,
    username: SECRET_USERNAME,
    password: SECRET_PASSWORD,
  });
  const torrentAsSabnzbdId = seedClient(raw, {
    name: 'Secret Client B',
    type: 'torrent',
    implementation: 'sabnzbd',
    apiKey: SECRET_API_KEY,
    username: SECRET_USERNAME,
    password: SECRET_PASSWORD,
  });
  const nzbAsQbittorrentId = seedClient(raw, {
    name: 'Secret Client C',
    type: 'nzb',
    implementation: 'qbittorrent',
    apiKey: SECRET_API_KEY,
    username: SECRET_USERNAME,
    password: SECRET_PASSWORD,
  });

  const messages: string[] = [];
  for (const id of [unknownImplId, torrentAsSabnzbdId, nzbAsQbittorrentId]) {
    try {
      readClientConfig(raw, id);
      assert.fail(`expected download client ${id} to be refused`);
    } catch (err) {
      assert.ok(err instanceof Error);
      messages.push(err.message);
    }
  }

  assert.equal(messages.length, 3);
  for (const message of messages) {
    assert.equal(message.includes(SECRET_API_KEY), false, `leaked api key in: ${message}`);
    assert.equal(message.includes(SECRET_USERNAME), false, `leaked username in: ${message}`);
    assert.equal(message.includes(SECRET_PASSWORD), false, `leaked password in: ${message}`);
  }
});
