import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients } from '@pickarr/contract';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createHost } from '../../src/host.ts';
import type { Host } from '../../src/host.ts';
import { mapClientPath } from '../../src/clients/paths.ts';
import { createSecrets } from '../../src/secrets/instance.ts';
import type { QueuedFetch } from '../../src/fetch/queue.ts';
import type { Timers } from '../../src/jobs/dispatcher.ts';

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

/** No test here attaches artwork, so this directory is never created or written to. Mirrors `clients/add.test.ts`'s own. */
const unusedArtworkDir = '/nonexistent/pickarr-test-artwork-unused';

/** No test here stores or resolves a credential; a mapping has none. Mirrors `clients/add.test.ts`'s own. */
const unusedSecretsDir = '/nonexistent/pickarr-test-secrets-unused';

/** A `Timers` whose calls are never fired -- no test here calls `host.start()`. Mirrors `clients/add.test.ts`'s own. */
function fakeTimers(): Timers {
  let nextHandle = 0;
  return {
    setTimeout: () => ++nextHandle,
    clearTimeout: () => {},
    setInterval: () => ++nextHandle,
    clearInterval: () => {},
  };
}

/**
 * The clock every write in this file is stamped from, as a value a test can
 * move.
 *
 * **A moving clock is what makes the `updated_at` assertions mean
 * anything.** With one fixed `now()`, an edit that failed to touch
 * `updated_at` would leave the value the insert wrote -- which equals the
 * value the edit should have written -- and the assertion would pass
 * against a writer that forgot. `CREATED_AT` and `EDITED_AT` are distinct,
 * and both are distinct from `0`, which is what a `DEFAULT 0` on the column
 * would have supplied to any write that omitted it. Migration 19 rebuilds
 * the table rather than leaving that default in place, so the omission now
 * raises instead -- but `0` stays named here because the *edit* path has no
 * such protection: an `UPDATE` may omit the column freely.
 */
const CREATED_AT = 1_700_000_000_000;
const EDITED_AT = 1_700_000_999_000;

interface Harness {
  host: Host;
  raw: DatabaseSync;
  /** Moves the clock every subsequent write is stamped from. */
  setNow: (at: number) => void;
}

/** A real host over a migrated in-memory database, with a clock a test can move. */
function setupHost(): Harness {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);

  let at = CREATED_AT;
  const host = createHost({
    raw,
    db,
    fetch: unusedFetch,
    downloads: () => unusedDownloads,
    secrets: createSecrets({ raw, baseDir: unusedSecretsDir, now: () => at }),
    now: () => at,
    artworkDir: unusedArtworkDir,
    timers: fakeTimers(),
  });

  return { host, raw, setNow: (next) => { at = next; } };
}

/**
 * Inserts one `download_client` row directly and returns its id.
 *
 * Through SQL rather than `Host.addDownloadClient`, deliberately: that path
 * stores a credential and schedules a reconcile, neither of which this file
 * is about, and a mapping needs nothing from a client but its id. The same
 * fixture `clients/paths.test.ts` uses, so the two files agree on what a
 * client a mapping can hang off looks like.
 */
function seedClient(raw: DatabaseSync, name = 'Client'): number {
  // `lastInsertRowid` off the `run` result rather than a `SELECT id` read
  // back through a cast -- `paths.test.ts`'s twin does the latter, and
  // `(inserted as { id: unknown }).id` is a cast this file does not need to
  // take on when the insert already answers the id.
  const result = raw.prepare(`
    INSERT INTO download_client (name, type, implementation, url, category, import_mode, created_at, updated_at)
    VALUES (?, 'torrent', 'qbittorrent', 'https://example.invalid', 'movies', 'copy', 1, 1)
  `).run(name);
  return Number(result.lastInsertRowid);
}

/**
 * The whole `filepath_mapping` row as a plain object.
 *
 * Spread because `node:sqlite` rows have a null prototype and `deepEqual`
 * compares prototypes -- the same normalisation `clients/add.test.ts` does.
 */
function mappingRow(raw: DatabaseSync, id: number): Record<string, unknown> {
  const row = raw.prepare('SELECT id, download_client_id, from_path, to_path, created_at, updated_at FROM filepath_mapping WHERE id = ?').get(id);
  assert.ok(row, `filepath_mapping ${String(id)} exists`);
  return { ...row };
}

/** The id out of an accepted result, failing with the refusal's own code when there is one. */
function acceptedId(result: { id: number } | { refusal: string }): number {
  assert.ok(
    !('refusal' in result),
    `expected an accepted mapping, got refusal ${'refusal' in result ? result.refusal : ''}`,
  );
  return result.id;
}

/** The code out of a refused result, failing with the id when the write was accepted instead. */
function refusalOf(result: { id: number } | { refusal: string }): string {
  assert.ok(
    'refusal' in result,
    `expected a refusal, got an accepted mapping with id ${'id' in result ? String(result.id) : ''}`,
  );
  return result.refusal;
}

test('an added mapping is on file, with both timestamps set from the clock', async () => {
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);

  const id = acceptedId(await host.addMapping({
    downloadClientId: clientId,
    fromPath: '/downloads',
    toPath: '/media',
  }));

  assert.deepEqual(mappingRow(raw, id), {
    id,
    download_client_id: clientId,
    from_path: '/downloads',
    to_path: '/media',
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
});

test('the insert stamps updated_at rather than leaving it to the schema', async () => {
  // **This used to be the only guard against a trap that no longer
  // exists, and it is kept because it is still a good test.** The trap:
  // SQLite will not add a `NOT NULL` column to a populated table without a
  // constant default, so the first version of migration 19 carried
  // `DEFAULT 0` -- and a default needed to *add* a column does not go away
  // once the backfill has run. An `INSERT` omitting the column stored `0`,
  // which sorts to the front of `listByTable`'s modification order and
  // renders as 1970, with nothing failing.
  //
  // Migration 19 now rebuilds the table so the column has no default at
  // all, and the same `INSERT` raises `NOT NULL constraint failed:
  // filepath_mapping.updated_at` -- pinned in `test/db/migrate.test.ts`.
  // A schema that refuses the omission is a stronger guard than a test
  // that pins one writer, but it does not make this test redundant: it
  // asserts the *value* is the clock the write was stamped from, not
  // merely that some value was supplied, so a writer binding a constant
  // would still red here.
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);

  const id = acceptedId(await host.addMapping({
    downloadClientId: clientId,
    fromPath: '/downloads',
    toPath: '/media',
  }));

  const stored = mappingRow(raw, id)['updated_at'];
  assert.notEqual(stored, 0, 'the value a DEFAULT 0 would have supplied, back when omitting the column was possible');
  assert.equal(stored, CREATED_AT, 'and the value is the clock the write was stamped from');
});

test('an edit moves updated_at forward and leaves created_at alone', async () => {
  // **The half the schema cannot protect.** `NOT NULL` refuses an `INSERT`
  // that omits the column; it does nothing about an `UPDATE` that omits it
  // from its `SET` list, which simply leaves the insert's value -- so a row
  // edited hours later still claims it was last modified when it was
  // created, and the replica orders it wrongly. A single fixed clock could
  // not see that, which is why this file's clock moves.
  const { host, raw, setNow } = setupHost();
  const clientId = seedClient(raw);
  const id = acceptedId(await host.addMapping({
    downloadClientId: clientId,
    fromPath: '/downloads',
    toPath: '/media',
  }));

  setNow(EDITED_AT);
  assert.equal(acceptedId(await host.editMapping(id, { fromPath: '/downloads', toPath: '/mnt/media' })), id);

  assert.deepEqual(mappingRow(raw, id), {
    id,
    download_client_id: clientId,
    from_path: '/downloads',
    to_path: '/mnt/media',
    created_at: CREATED_AT,
    updated_at: EDITED_AT,
  });
});

test('a windows-shaped from_path is stored exactly as it was submitted', async () => {
  // Design spec §7, and acceptance 3. These are *foreign* paths from a
  // machine that is not this one -- `clients/paths.ts` refuses `node:path`
  // for that reason -- so a writer that demanded a leading `/`, rejected a
  // backslash or normalised anything would refuse mappings the consumer
  // handles perfectly well. Asserted on the stored column, not on the
  // return value, because "accepted" and "stored unchanged" are two facts
  // and only the second one is the one that matters to `mapClientPath`.
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);

  const id = acceptedId(await host.addMapping({
    downloadClientId: clientId,
    fromPath: 'D:\\Downloads',
    toPath: '/mnt/seedbox',
  }));

  assert.equal(mappingRow(raw, id)['from_path'], 'D:\\Downloads');
});

test('a from_path with no leading slash, a trailing slash or a space is accepted', async () => {
  // The other half of "not stricter than the consumer": each of these is a
  // shape a rule written to catch `D:\Downloads` might also have caught.
  // `' '` in particular is a directory named with a space, which is why
  // `empty-path` is `=== ''` rather than a trim.
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);

  const shapes = ['downloads', '/downloads/', ' ', 'C:/Downloads', '\\\\nas\\share'];
  // `Promise.all` rather than a loop with an `await` in it, which is what
  // `no-await-in-loop` is pointing at: these writes share nothing and none
  // of them decides the next. The assertions are then a plain loop with no
  // await at all, so a failure still names the shape it came from.
  const ids = await Promise.all(shapes.map(async (fromPath, index) => acceptedId(await host.addMapping({
    downloadClientId: clientId,
    fromPath,
    toPath: `/media/${String(index)}`,
  }))));

  for (const [index, fromPath] of shapes.entries()) {
    assert.equal(mappingRow(raw, Number(ids[index]))['from_path'], fromPath);
  }
});

test('an add naming a client that does not exist is refused unknown-client', async () => {
  const { host, raw } = setupHost();
  seedClient(raw);

  const result = await host.addMapping({
    downloadClientId: 99_999,
    fromPath: '/downloads',
    toPath: '/media',
  });

  assert.equal(refusalOf(result), 'unknown-client');
  assert.equal(
    raw.prepare('SELECT count(*) AS n FROM filepath_mapping').get()?.['n'],
    0,
    'and nothing was written',
  );
});

test('a second mapping with the same from_path for one client is refused duplicate-from-path', async () => {
  // Acceptance 2. Caught from migration 19's unique index rather than
  // pre-checked -- `clients/paths.ts`'s doc explains why two identical
  // `from_path` values for one client must be impossible rather than merely
  // unlikely: they are the only pair that could reach its unresolved
  // equal-length tie.
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);
  await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '/media' });

  const result = await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '/elsewhere' });

  assert.equal(refusalOf(result), 'duplicate-from-path');
  assert.equal(
    raw.prepare('SELECT count(*) AS n FROM filepath_mapping').get()?.['n'],
    1,
    'and the second row never reached the table',
  );
});

test('two clients may each hold the same from_path, because the index is on the pair', async () => {
  const { host, raw } = setupHost();
  const first = seedClient(raw, 'Client A');
  const second = seedClient(raw, 'Client B');

  const firstId = acceptedId(await host.addMapping({ downloadClientId: first, fromPath: '/downloads', toPath: '/media' }));
  const secondId = acceptedId(await host.addMapping({ downloadClientId: second, fromPath: '/downloads', toPath: '/mnt/media' }));

  assert.notEqual(firstId, secondId);
  assert.equal(mapClientPath(raw, first, '/downloads/x.mkv'), '/media/x.mkv');
  assert.equal(mapClientPath(raw, second, '/downloads/x.mkv'), '/mnt/media/x.mkv');
});

test('an empty path is refused on either field, and only the empty string is', async () => {
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);

  assert.equal(
    refusalOf(await host.addMapping({ downloadClientId: clientId, fromPath: '', toPath: '/media' })),
    'empty-path',
    'an empty from_path matches every path the client reports',
  );
  assert.equal(
    refusalOf(await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '' })),
    'empty-path',
    'an empty to_path maps every file to a relative path',
  );
  assert.equal(
    refusalOf(await host.addMapping({ downloadClientId: clientId, fromPath: '', toPath: '' })),
    'empty-path',
  );
  assert.equal(
    raw.prepare('SELECT count(*) AS n FROM filepath_mapping').get()?.['n'],
    0,
    'and none of the three was written',
  );

  // And the nearest thing that is not empty is accepted, so the rule is
  // about `''` rather than about "short" or "blank".
  acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: ' ', toPath: ' ' }));
});

test('an edit is refused empty-path on either field, and writes nothing', async () => {
  const { host, raw, setNow } = setupHost();
  const clientId = seedClient(raw);
  const id = acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '/media' }));

  setNow(EDITED_AT);
  assert.equal(refusalOf(await host.editMapping(id, { fromPath: '', toPath: '/media' })), 'empty-path');
  assert.equal(refusalOf(await host.editMapping(id, { fromPath: '/downloads', toPath: '' })), 'empty-path');

  assert.deepEqual(mappingRow(raw, id), {
    id,
    download_client_id: clientId,
    from_path: '/downloads',
    to_path: '/media',
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  }, 'a refused edit leaves the row exactly as it was, updated_at included');
});

test('an edit to a from_path another mapping on the same client holds is refused', async () => {
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);
  const first = acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '/media' }));
  acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: '/incomplete', toPath: '/media/incomplete' }));

  const result = await host.editMapping(first, { fromPath: '/incomplete', toPath: '/media' });

  assert.equal(refusalOf(result), 'duplicate-from-path');
  assert.equal(mappingRow(raw, first)['from_path'], '/downloads', 'and the row it would have collided into is untouched');
});

test('an edit that keeps its own from_path and fixes only the to_path is accepted', async () => {
  // The no-op the unique index must not refuse, and the one a naive
  // pre-check ("is this from_path taken?") gets wrong: the row's own key is
  // the one it is asking about. It is also the single most likely real
  // edit -- the `from_path` was right and the `to_path` had a typo in it.
  const { host, raw, setNow } = setupHost();
  const clientId = seedClient(raw);
  const id = acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '/mdeia' }));

  setNow(EDITED_AT);
  const result = await host.editMapping(id, { fromPath: '/downloads', toPath: '/media' });

  assert.equal(acceptedId(result), id);
  assert.deepEqual(mappingRow(raw, id), {
    id,
    download_client_id: clientId,
    from_path: '/downloads',
    to_path: '/media',
    created_at: CREATED_AT,
    updated_at: EDITED_AT,
  });
});

test('an edit naming a mapping that does not exist is refused unknown-mapping', async () => {
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);
  acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '/media' }));

  const result = await host.editMapping(99_999, { fromPath: '/elsewhere', toPath: '/media' });

  assert.equal(refusalOf(result), 'unknown-mapping');
  assert.equal(
    raw.prepare('SELECT count(*) AS n FROM filepath_mapping').get()?.['n'],
    1,
    'and the edit created no row of its own',
  );
});

test('a removal takes the row off file', async () => {
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);
  const id = acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '/media' }));

  assert.equal(acceptedId(await host.removeMapping(id)), id);

  assert.equal(raw.prepare('SELECT count(*) AS n FROM filepath_mapping WHERE id = ?').get(id)?.['n'], 0);
});

test('a removal naming a mapping that does not exist is refused unknown-mapping, not reported as a success', async () => {
  // A `DELETE` whose `WHERE` matches nothing is a perfectly successful
  // statement, so "it did not throw" is not evidence the row was there.
  // Answering `{ id }` for it would tell a browser working from a stale
  // list that a row it can still see is gone.
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);
  const id = acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '/media' }));

  const result = await host.removeMapping(id + 1);

  assert.equal(refusalOf(result), 'unknown-mapping');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM filepath_mapping').get()?.['n'], 1, 'and the real row survived');
});

test('editing a mapping changes what the next mapClientPath resolves', async () => {
  // **Acceptance 4, pinned against the real consumer.** `deliver.ts` maps a
  // stored client path on every tick and never stores the result, precisely
  // so that an edit takes effect on the next tick (design spec §4) -- so
  // the property is about what `mapClientPath` answers, not about what a
  // column holds. Asserted anywhere else this would prove only that a row
  // changed, which is the weaker fact and the one the row assertions above
  // already make.
  const { host, raw, setNow } = setupHost();
  const clientId = seedClient(raw);
  const id = acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '/media' }));

  assert.equal(mapClientPath(raw, clientId, '/downloads/movie.mkv'), '/media/movie.mkv');

  setNow(EDITED_AT);
  acceptedId(await host.editMapping(id, { fromPath: '/downloads', toPath: '/mnt/media' }));

  assert.equal(
    mapClientPath(raw, clientId, '/downloads/movie.mkv'),
    '/mnt/media/movie.mkv',
    'the next resolution uses the edited mapping, with no restart and nothing to invalidate',
  );

  // And an edit of the `from_path` moves which paths match at all, rather
  // than only what they map to.
  acceptedId(await host.editMapping(id, { fromPath: '/seedbox', toPath: '/mnt/media' }));
  assert.equal(
    mapClientPath(raw, clientId, '/downloads/movie.mkv'),
    '/downloads/movie.mkv',
    'a path the edited mapping no longer covers comes back unchanged',
  );
  assert.equal(mapClientPath(raw, clientId, '/seedbox/movie.mkv'), '/mnt/media/movie.mkv');
});

test('a removed mapping stops being applied', async () => {
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);
  const id = acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: '/downloads', toPath: '/media' }));
  assert.equal(mapClientPath(raw, clientId, '/downloads/movie.mkv'), '/media/movie.mkv');

  acceptedId(await host.removeMapping(id));

  assert.equal(
    mapClientPath(raw, clientId, '/downloads/movie.mkv'),
    '/downloads/movie.mkv',
    'an unmapped path is returned unchanged rather than refused -- `mapClientPath`\'s own rule',
  );
});

test('a windows-shaped mapping resolves through the consumer, so accepting it was not a dead letter', async () => {
  // `matchesBoundary` requires the remainder after the prefix to be empty
  // or to begin with `/`, so a Windows path only resolves for a client that
  // reports forward slashes after the drive letter -- which is what
  // qBittorrent on Windows does. Pinned here so "accepted unchanged" is
  // backed by a case where the acceptance is worth something.
  const { host, raw } = setupHost();
  const clientId = seedClient(raw);
  acceptedId(await host.addMapping({ downloadClientId: clientId, fromPath: 'D:/Downloads', toPath: '/mnt/seedbox' }));

  assert.equal(mapClientPath(raw, clientId, 'D:/Downloads/movie.mkv'), '/mnt/seedbox/movie.mkv');
});
