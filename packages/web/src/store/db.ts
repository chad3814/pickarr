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
 *
 * Version 2 added `by_table_plugin_updated`, the per-category index the
 * browse screens page and count against. No reader of it existed yet at the
 * moment this bumped -- tasks 2, 3 and 5 added them in the same branch, so
 * `rows.ts`'s `listByTablePlugin` and `countByPlugin`, `shell/useCounts.ts`
 * and `library/useMediaItems.ts` are those readers by the time anyone
 * reaches `pickarr-2`. Every client still paid a full resync for the bump,
 * which is acceptable here because 2.0 is greenfield (one operator, an
 * empty database, a tested backfill), and is not a precedent for doing this
 * once real usage exists.
 *
 * Version 3 adds the derived `catalog` store (design spec 2026-10-02 §1.1)
 * and the `by_person` index on `rows`. The bump costs every client a
 * resync, accepted because the catalog is derived from rows that resync
 * anyway.
 *
 * Version 4 adds `by_table_status_updated`, so the Activities page reads
 * live downloads by status instead of walking every download row ever
 * recorded (the host never deletes one). Same resync cost, same reasoning.
 */
export const SCHEMA_VERSION = 4;

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
      // Per-category paging and the shell's three counts. `pluginId`
      // partitions, `updatedAt` orders within a category, and `id` breaks
      // ties for the same measured reason `by_table_updated` carries one --
      // a key without it served [1,4,5] and never served 2 or 3.
      //
      // **This index is self-filtering, and that is load-bearing rather than
      // incidental.** IndexedDB omits any record missing a component of the
      // key path, so only rows projecting `pluginId` enter it: `media_item`
      // and, since it joined the synced set, `rss_feed` -- `rss_item`
      // carries `feedId` and no `pluginId`, so it stays out on its own.
      // `rss_feed`'s membership here follows from the key path and
      // `RssFeedSyncRead` carrying `pluginId`, not from a test that pages an
      // `rss_feed` row through this index and checks -- no such test exists
      // yet, unlike the tie-breaking claim above this comment, which
      // `store/rows.test.ts` does measure directly.
      // `store/rows.ts`'s `TABLES_WITH_PLUGIN_ID` is a separate, narrower
      // gate on top of this -- what the two per-category readers will
      // *query* for, not what this index holds -- and does not admit
      // `rss_feed` yet even though the index already does.
      // A tombstone nests its row under `value` and so has no
      // `value.pluginId` either, which is why a deleted row leaves the
      // counts without anything having to remember to remove it -- the same
      // mechanism every other `value.*` index here already relies on.
      rows.createIndex('by_table_plugin_updated', ['table', 'value.pluginId', 'value.updatedAt', 'id']);
      rows.createIndex('by_table', 'table');
      // Who appears where, for the catalog's person-rename path
      // (`store/catalog-apply.ts`): only `role` carries `value.personId`, so
      // this index is self-filtering the way `by_table_plugin_updated` is.
      rows.createIndex('by_person', 'value.personId');
      // Live downloads for the Activities page (`store/rows.ts`'s
      // `activeDownloads`): one range per `[table, status]`, so the read
      // costs what is live rather than what was ever downloaded. Only the two
      // download tables carry `value.status`, so this index is self-filtering
      // the way `by_table_plugin_updated` is; a tombstone has no `value` and
      // leaves it on its own.
      rows.createIndex('by_table_status_updated', ['table', 'value.status', 'value.updatedAt', 'id']);
      // The derived catalog (design spec 2026-10-02 §1): one record per media
      // item, maintained by `applyBatch`'s catalog phase, never written by a
      // reader. `picked` is 0 | 1 because IndexedDB cannot index a boolean.
      const catalog = db.createObjectStore('catalog', { keyPath: 'id' });
      catalog.createIndex('by_plugin_picked_updated', ['pluginId', 'picked', 'updatedAt', 'id']);
      catalog.createIndex('by_plugin_updated', ['pluginId', 'updatedAt', 'id']);
      db.createObjectStore('meta', { keyPath: 'key' });
    }, { once: true });

    req.addEventListener('success', () => {
      const db = req.result;
      // **What makes a version bump survivable in a second tab.** IndexedDB
      // fires `versionchange` on every *other* open connection when one tab
      // asks for a higher version; a connection that ignores it blocks the
      // upgrade, and the upgrading tab's own open fires `blocked` and
      // rejects with {@link OpenBlockedError} -- a tab left with no replica
      // at all, for as long as the old tab stays open. That is the ordinary
      // two-tab case across a deploy, and this codebase's 1->2 bump is the
      // first ever made, so nothing had exercised it (measured: without this
      // listener, a second `openStore(name, 2)` against a held v1 connection
      // rejects `OpenBlockedError`; with it, it resolves).
      //
      // Closing is the whole remedy and it is deliberately unconditional.
      // Reads in flight on this connection reject with `InvalidStateError`,
      // which every consumer of this store already treats as "the store I
      // was reading from went away" -- `useCounts.ts`, `useGatheredItem.ts`,
      // `useMediaItems.ts` and `Unmatched.tsx` each carry an `isStoreClosed`
      // guard for exactly that. The alternative -- holding the connection
      // and prompting -- would need UI this module has no business owning.
      //
      // **And then the page reloads.** Closing the connection is not enough
      // for the tab that was *leading* on the old bundle: it keeps its Web
      // Lock lease and never demotes, so after the bump a new tab is a
      // follower with nothing to follow until the old tab is closed. The old
      // bundle cannot speak the newer schema in any case, so reloading to load the
      // new bundle is the only useful thing it can do, and the old
      // document's lock releases with it.
      db.addEventListener('versionchange', () => {
        db.close();
        if (typeof location !== 'undefined') location.reload();
      });
      resolve(db);
    }, { once: true });
    req.addEventListener(
      'error',
      () => reject(req.error ?? new Error('indexeddb open failed')),
      { once: true },
    );
    req.addEventListener('blocked', () => reject(new OpenBlockedError(name)), { once: true });
  });
}
