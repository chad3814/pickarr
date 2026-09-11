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
    // A Proxy over `DatabaseSync` does not typecheck cleanly under this
    // repo's `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`
    // settings without a cast, and casts to silence a type error are
    // forbidden here. `prepare` has a single, simple signature
    // (`(sql: string) => StatementSync`), so replacing the real instance's
    // own `prepare` with a counting wrapper -- rather than building a new
    // object typed as `DatabaseSync` -- proves the same fact (three
    // concurrent `get`s for one name cause one call to `prepare` naming
    // `secret`) with no cast at all.
    const originalPrepare = raw.prepare.bind(raw);
    raw.prepare = (sql: string) => {
      if (sql.includes('FROM secret')) reads += 1;
      return originalPrepare(sql);
    };
    const secrets = createSecrets({ raw, baseDir: dir });
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
