import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { writeSecretValue } from '../../src/secrets/store.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import { SecretNotFound, SecretsFileUnreadable } from '../../src/secrets/names.ts';

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
    process.env['PICKARR_SECRET_TVDB_KEY'] = 'from-env';
    t.after(() => { delete process.env['PICKARR_SECRET_TVDB_KEY']; });
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
    process.env['PICKARR_SECRET_550E8400_E29B_41D4_A716_446655440000'] = 'from-env';
    t.after(() => { delete process.env['PICKARR_SECRET_550E8400_E29B_41D4_A716_446655440000']; });
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
    process.env['PICKARR_SECRET_SOLO_KEY'] = 'from-env';
    t.after(() => { delete process.env['PICKARR_SECRET_SOLO_KEY']; });
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

test('a secret whose name matches an ambient variable still resolves from storage', async () => {
  await withDir(async (dir) => {
    // `path` is a legal secret name and `PATH` is set in every process this
    // will ever run in. Unprefixed, `fromEnv` won the chain with the
    // container's own `PATH` and the stored credential was never read --
    // measured before the prefix, and the value would then have gone to a
    // download client as its api key.
    //
    // Asserted with `ok` rather than `equal` on purpose: a failure of
    // `equal` prints the actual value, and here the actual value would be
    // `PATH`, which no assertion or failure message in this repo may carry.
    const raw = open();
    const secrets = createSecrets({ raw, baseDir: dir });
    secrets.saveSecret('path', 'test-value');
    const resolved = await secrets.get('path');
    assert.ok(resolved === 'test-value', 'a secret named `path` must resolve from storage');
    assert.ok(resolved !== process.env['PATH'], 'and must never be the ambient variable of that name');
  });
});

test('a secrets directory present but unreadable halts the chain, and says so rather than reporting a missing secret', async () => {
  await withDir(async (dir) => {
    // The database *has* the credential, and must not answer: `fromFile`
    // marks "present but broken" as a chain-halting failure, deliberately,
    // so a secrets mount the process cannot read is loud rather than
    // silently bypassed. Measured, with the row below present: a `baseDir`
    // that does not exist resolves `from-db`, and a `baseDir` that is a
    // plain file resolves nothing -- which is why the error has to say
    // which of the two happened.
    const notADirectory = join(dir, 'plain-file');
    await writeFile(notADirectory, 'this is not a directory');
    const raw = open();
    writeSecretValue(raw, 'tvdb_key', 'from-db', 1);

    await assert.rejects(
      () => createSecrets({ raw, baseDir: notADirectory }).get('tvdb_key'),
      (error: unknown) => {
        assert.ok(error instanceof SecretsFileUnreadable, 'the failure must be distinguishable from SecretNotFound');
        assert.ok(!(error instanceof SecretNotFound), 'and must not read as "this credential was never configured"');
        assert.equal(error.secretName, 'tvdb_key');
        assert.ok(!error.message.includes(dir), 'the message must not carry the secrets directory');
        assert.ok(!error.message.includes('/'), 'the message must carry no path at all');
        return true;
      },
    );

    // The contrast, in the same test so the two cannot drift: absent is not
    // broken, and absent still falls through to the database.
    assert.equal(
      await createSecrets({ raw, baseDir: join(dir, 'no-such-directory') }).get('tvdb_key'),
      'from-db',
      'a secrets directory that simply does not exist must still fall through',
    );

    // The `EACCES` half of the same property. Guarded because mode bits do
    // not apply to uid 0: a suite running as root reads the directory
    // regardless and would see the database value, which is a property of
    // the uid rather than of this code.
    if (process.getuid?.() !== 0) {
      const locked = join(dir, 'locked');
      await mkdir(locked);
      await chmod(locked, 0o000);
      try {
        await assert.rejects(
          () => createSecrets({ raw, baseDir: locked }).get('tvdb_key'),
          (error: unknown) => error instanceof SecretsFileUnreadable,
          'a root-owned /run/secrets is the live Docker case, and it must not read as a missing secret',
        );
      } finally {
        await chmod(locked, 0o755);
      }
    }
  });
});

test('an illegal name is refused before any filesystem access', async () => {
  await withDir(async (dir) => {
    const secrets = createSecrets({ raw: open(), baseDir: dir });
    await assert.rejects(() => secrets.get('../../etc/passwd'), /secret name/);
    assert.throws(() => { secrets.saveSecret('../../etc/passwd', 'test-value'); }, /secret name/);
  });
});
