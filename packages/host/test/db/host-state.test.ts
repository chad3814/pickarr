import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import {
  AUTH_SECRET_KEY,
  SYNC_GENERATION_KEY,
  clearHostState,
  ensureAuthSecret,
  ensureSyncGeneration,
  readHostState,
  writeHostState,
} from '../../src/db/host-state.ts';

/**
 * Placeholder values below are obviously synthetic -- fixed strings that
 * cannot be mistaken for a real generated secret -- because
 * `ensureAuthSecret` itself produces the only values in this file that are
 * meant to look like credentials.
 *
 * **No assertion here formats a `host_state.value`, whatever the row happens
 * to hold.** `node:assert`'s equality helpers format *both* operands into the
 * failure message -- the mechanism `scripts/check-test-hygiene.ts`'s own
 * header documents for DOM nodes -- so `assert.equal(second, first)` over two
 * real `randomBytes(32)` signing secrets prints both of them on the one run
 * where it fails. It did: a mutation returning the generated candidate instead
 * of the stored row put five distinct 43-character base64url secrets into the
 * run's output, ten times over, and "the test never *interpolates* a secret"
 * was mistaken for "the test never prints one".
 *
 * So every assertion over a stored value is `assert.ok(a === b, '<message>')`,
 * which formats nothing, and the message names the property rather than the
 * values. What stays on `assert.equal` is row counts and timestamps: neither
 * is a credential, and a count that disagrees is worth printing. The rule is
 * mechanical on purpose -- it does not depend on arguing which test seeds a
 * real secret and which seeds a placeholder, because the next test added here
 * will not have read that argument.
 */

test('a secret generated once is returned again unchanged', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const first = ensureAuthSecret(raw, 1_000);
  const second = ensureAuthSecret(raw, 2_000);

  assert.ok(second === first, 'the second call minted a new secret instead of returning the first');
});

test('two ensureAuthSecret calls on one database yield one secret', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  // Stands in for the winner of a real race between two processes: a row
  // already committed under AUTH_SECRET_KEY before this call ever runs,
  // using the exact statement `ensureAuthSecret` itself issues so this is
  // "another caller's insert already landed", not just "some data exists".
  // A test that instead called `ensureAuthSecret` twice in this one
  // process could not tell the read-back implementation from a version
  // that returns the value it generated: the first call's own write would
  // make the second call's read-back correct either way. Pre-seeding the
  // row *before the first call this test makes* is what forces the
  // "loser" path through code that never itself won the insert.
  raw.prepare(`
    INSERT INTO host_state (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO NOTHING
  `).run(AUTH_SECRET_KEY, 'placeholder-preexisting-secret-value', 500, 500);

  const returned = ensureAuthSecret(raw, 1_000);

  assert.ok(
    returned === 'placeholder-preexisting-secret-value',
    'the call returned its own freshly generated secret rather than the row already on record',
  );
  const rows = raw.prepare('SELECT key FROM host_state WHERE key = ?').all(AUTH_SECRET_KEY);
  assert.equal(rows.length, 1);
});

test('a secret survives a fresh connection to the same file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-host-state-'));
  try {
    const path = join(dir, 'pickarr.db');

    const first = openDatabase(path);
    migrateHost(first.raw);
    const generated = ensureAuthSecret(first.raw, 1_000);
    first.raw.close();

    const second = openDatabase(path);
    const reread = ensureAuthSecret(second.raw, 2_000);
    second.raw.close();

    assert.ok(reread === generated, 'a fresh connection to the same file read back a different secret');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an absent key reads as null rather than throwing', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  assert.ok(readHostState(raw, 'auth.neverSet') === null, 'an absent key read back as something other than null');
});

test('writing an existing key moves updated_at and keeps one row', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  writeHostState(raw, 'auth.claimToken', 'placeholder-token-one', 1_000);
  writeHostState(raw, 'auth.claimToken', 'placeholder-token-two', 2_000);

  assert.ok(
    readHostState(raw, 'auth.claimToken') === 'placeholder-token-two',
    'the second write did not replace the value the first one stored',
  );
  const rows = raw.prepare(
    'SELECT created_at, updated_at FROM host_state WHERE key = ?',
  ).all('auth.claimToken') as { created_at: unknown; updated_at: unknown }[];
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0]?.created_at), 1_000);
  assert.equal(Number(rows[0]?.updated_at), 2_000);
});

test('clearing a key removes it', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  writeHostState(raw, 'auth.claimToken', 'placeholder-token', 1_000);
  clearHostState(raw, 'auth.claimToken');

  assert.ok(readHostState(raw, 'auth.claimToken') === null, 'the cleared key still reads back a value');
  const rows = raw.prepare('SELECT key FROM host_state WHERE key = ?').all('auth.claimToken');
  assert.equal(rows.length, 0);
});

test('a sync generation is minted once and returned unchanged', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const generation = ensureSyncGeneration(raw, 1_000);
  const generationAgain = ensureSyncGeneration(raw, 2_000);

  // `assert.equal` over two generations, where this file uses `assert.ok` for
  // two signing secrets: a generation is deliberately public -- it goes out
  // on the body of all three sync routes -- so printing one in a failure
  // message leaks nothing a session holder cannot already read, and the value
  // is worth seeing when it disagrees. See `SYNC_GENERATION_KEY`.
  assert.equal(generationAgain, generation,
    'the second call minted a new generation instead of returning the first');
  // `assert.ok` here all the same, and not for the value's sake: the *other*
  // operand is a `readHostState` call, which is what reads the signing
  // secret's row too, and `scripts/check-test-hygiene.ts`'s rule 3 tracks
  // that function by name rather than by which key it was handed.
  assert.ok(readHostState(raw, SYNC_GENERATION_KEY) === generation,
    'the generation is not persisted under its own key');
});

test('a rebuilt database mints a different sync generation', async () => {
  // The whole point of the value. 2.0 starts empty and rebuilds from feeds, so
  // `pickarr.db` being deleted is a routine operation rather than a disaster --
  // and without this a client holding `since = 5000` would ask for ops above
  // 5000 against a log whose max id is 80, receive nothing forever, and show a
  // stale library with no error at all. Two databases, so this is the real
  // deletion rather than a cleared row.
  const directory = await mkdtemp(join(tmpdir(), 'pickarr-generation-'));
  try {
    const original = openDatabase(join(directory, 'original.db'));
    migrateHost(original.raw);
    const originalGeneration = ensureSyncGeneration(original.raw, 1_000);
    original.raw.close();

    const replacement = openDatabase(join(directory, 'replacement.db'));
    migrateHost(replacement.raw);
    const rebuiltGeneration = ensureSyncGeneration(replacement.raw, 2_000);
    replacement.raw.close();

    assert.notEqual(rebuiltGeneration, originalGeneration,
      'a rebuilt database must not claim to be the one a client replicated');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a sync generation survives a fresh connection to the same file', async () => {
  // The other half: a restart is *not* a rebuild, and a host that minted a new
  // generation on every boot would make every client resync on every restart.
  const directory = await mkdtemp(join(tmpdir(), 'pickarr-generation-'));
  try {
    const path = join(directory, 'host.db');
    const booted = openDatabase(path);
    migrateHost(booted.raw);
    const minted = ensureSyncGeneration(booted.raw, 1_000);
    booted.raw.close();

    const rebooted = openDatabase(path);
    const afterRestart = ensureSyncGeneration(rebooted.raw, 2_000);
    rebooted.raw.close();

    assert.equal(afterRestart, minted, 'a restart against the same file must keep the generation');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the sync generation and the signing secret are separate keys', () => {
  // Same generator, same race behaviour, different facts -- and one of them is
  // public. A generation that read the signing secret's row would put that
  // secret on three unauthenticated-client-facing response bodies.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const published = ensureSyncGeneration(raw, 1_000);
  ensureAuthSecret(raw, 1_000);

  assert.notEqual(SYNC_GENERATION_KEY, AUTH_SECRET_KEY, 'two facts, two keys');
  // `assert.ok`, because the other operand is the signing secret: this file's
  // own doc says why nothing here formats one.
  assert.ok(published !== readHostState(raw, AUTH_SECRET_KEY),
    'the generation must not be the signing secret under another name');
});
