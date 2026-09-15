/**
 * The replica's schema: one object store for every synced row, keyed the way
 * the sync protocol keys rows, plus a `meta` store for cursors and generation.
 *
 * See `docs/superpowers/specs/2026-09-15-client-storage-design.md` §3 for why
 * there is one `rows` store rather than one per table.
 */

/**
 * Bump this to force every client to rebuild its replica from scratch.
 *
 * "From scratch" is literal, and it is why `openStore`'s upgrade handler
 * deletes every existing store before creating them: a replica is disposable
 * by construction -- every row in it can be fetched again -- so a schema
 * change discards it rather than migrating it. The server-side rule is the
 * opposite (`docs/database-migrations.md`: an applied migration is frozen),
 * and the difference is ownership. The host's database is the only copy of
 * its data; this one is a copy of the host's.
 *
 * Dropping `meta` with the rest is what makes the rebuild happen: the cursors
 * go with it, so the next start finds none and bootstraps (spec §5). A bump
 * therefore costs one full re-sync per client and needs no migration code,
 * which is the trade this constant exists to make.
 */
export const SCHEMA_VERSION = 1;

/**
 * A row of the replica, keyed by `['table', 'id']`.
 *
 * `value` is absent on a tombstone (design spec §2.5), and it is nested
 * rather than spread onto the record for exactly that reason: IndexedDB
 * skips a record from an index whose key path resolves to nothing, so a
 * tombstone — having no `value` — drops out of `by_media_item`,
 * `by_rss_item` and `by_table_updated` automatically, while remaining
 * retrievable at its primary key, `['table', id]`. Spreading the row's
 * fields onto `StoredRow` directly would give every index its own key path
 * per table and lose that property. Measured against `fake-indexeddb` in
 * spec §2.8 before this shape was chosen.
 */
export interface StoredRow {
  table: string;
  id: number;
  value?: unknown;
}

/**
 * Thrown when opening the database stalls because another tab holds an
 * older version open. IndexedDB delivers this as `onblocked` rather than
 * `onerror`, and a request that never fires either callback hangs forever —
 * the worst failure this function could have, since nothing would ever
 * report it.
 */
export class OpenBlockedError extends Error {
  constructor(name: string) {
    super(`opening indexeddb database "${name}" is blocked by another open connection`);
    this.name = 'OpenBlockedError';
  }
}

/**
 * Opens (and, on first use, creates) the replica database named `name`.
 *
 * `version` defaults to {@link SCHEMA_VERSION} and exists as a parameter so a
 * test can drive the two paths a fixed constant cannot reach: an upgrade over
 * an existing database, and the `blocked` event that an upgrade raises while
 * another connection is still open.
 */
export function openStore(name: string, version: number = SCHEMA_VERSION): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);

    req.addEventListener('upgradeneeded', () => {
      const db = req.result;
      // Delete before create, which is what makes SCHEMA_VERSION's promise
      // true rather than aspirational: against an existing database the bare
      // `createObjectStore` below throws ConstraintError, so a bump broke
      // every client that already had a replica instead of rebuilding it.
      //
      // Snapshotted first because `objectStoreNames` is a *live* list and the
      // loop mutates it. Measured under `fake-indexeddb`, iterating it live
      // skips nothing -- but that is the implementation the tests run against,
      // not the one that ships, and a snapshot costs one array.
      const existing = Array.from(db.objectStoreNames);
      for (const store of existing) db.deleteObjectStore(store);
      const rows = db.createObjectStore('rows', { keyPath: ['table', 'id'] });
      rows.createIndex('by_media_item', 'value.mediaItemId');
      rows.createIndex('by_rss_item', 'value.rssItemId');
      // `id` is the third component and not decoration: `updatedAt` is not
      // unique, so a two-part key cannot resume a walk that stops in the
      // middle of a tie. Measured before this was widened -- paging five
      // people backwards two at a time, where three shared one `updatedAt`,
      // served ids [1,4,5] and **never served 2 or 3 from any page**. The
      // server's own read API keysets on `(updated_at, id)` for exactly this
      // reason (read-api design §5).
      rows.createIndex('by_table_updated', ['table', 'value.updatedAt', 'id']);
      rows.createIndex('by_table', 'table');
      db.createObjectStore('meta', { keyPath: 'key' });
    }, { once: true });

    req.addEventListener('success', () => resolve(req.result), { once: true });
    req.addEventListener(
      'error',
      () => reject(req.error ?? new Error('indexeddb open failed')),
      { once: true },
    );
    req.addEventListener('blocked', () => reject(new OpenBlockedError(name)), { once: true });
  });
}
