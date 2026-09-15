/**
 * The replica's schema: one object store for every synced row, keyed the way
 * the sync protocol keys rows, plus a `meta` store for cursors and generation.
 *
 * See `docs/superpowers/specs/2026-09-15-client-storage-design.md` §3 for why
 * there is one `rows` store rather than one per table.
 */

/** Bump this to force every client to rebuild its replica from scratch. */
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

/** Opens (and, on first use, creates) the replica database named `name`. */
export function openStore(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, SCHEMA_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      const rows = db.createObjectStore('rows', { keyPath: ['table', 'id'] });
      rows.createIndex('by_media_item', 'value.mediaItemId');
      rows.createIndex('by_rss_item', 'value.rssItemId');
      rows.createIndex('by_table_updated', ['table', 'value.updatedAt']);
      rows.createIndex('by_table', 'table');
      db.createObjectStore('meta', { keyPath: 'key' });
    };

    req.addEventListener('success', () => resolve(req.result), { once: true });
    req.addEventListener(
      'error',
      () => reject(req.error ?? new Error('indexeddb open failed')),
      { once: true },
    );
    req.addEventListener('blocked', () => reject(new OpenBlockedError(name)), { once: true });
  });
}
