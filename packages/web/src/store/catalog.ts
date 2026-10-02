/**
 * The derived catalog's shape and its one read (design spec 2026-10-02 §1-2).
 *
 * Reads only. The records are written by `store/catalog-apply.ts` inside
 * `applyBatch`'s transaction, which is what makes a catalog record always
 * agree with the rows it was computed from. Nothing here opens a
 * `readwrite` transaction.
 *
 * A search term is tested with `String.prototype.includes` on `haystack`,
 * so `%`, `_`, `.` and `*` are literal. There is no text index; with a
 * term, the walk visits every record in the plugin's (and picked) range
 * until `limit` matches, which is the cost the design accepted for a
 * replica-sized library.
 */
export const CATALOG_STORE = 'catalog';

/** A record's haystack: each part trimmed, lowercased and whitespace-collapsed, newline-joined so a term cannot match across parts. */
export function buildHaystack(parts: readonly string[]): string {
  return parts.map(normalizeTerm).join('\n');
}

export interface CatalogRecord {
  id: number;
  pluginId: string;
  updatedAt: number;
  picked: 0 | 1;
  haystack: string;
}

export type PickedFilter = 'all' | 'picked' | 'unpicked';

export interface CatalogQuery {
  pluginId: string;
  filter: PickedFilter;
  /** Already through {@link normalizeTerm}; `''` means no term. */
  term: string;
}

export interface ListCatalogOptions {
  /** Exclusive: the record that ended the previous page. */
  from?: { updatedAt: number; id: number };
  limit: number;
}

export function normalizeTerm(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCatalogRecord(value: unknown): value is CatalogRecord {
  return isRecord(value)
    && typeof value.id === 'number'
    && typeof value.pluginId === 'string'
    && typeof value.updatedAt === 'number'
    && (value.picked === 0 || value.picked === 1)
    && typeof value.haystack === 'string';
}

/** The index and key range for a query: the picked index when the filter names a side, else the plugin-wide one. Bounds carry the index's full arity, as `rows.ts`'s `rangeFor` explains. */
function rangeFor(query: CatalogQuery, from: ListCatalogOptions['from']): { index: string; range: IDBKeyRange } {
  const prefix = query.filter === 'all' ? [query.pluginId] : [query.pluginId, query.filter === 'picked' ? 1 : 0];
  const low = [...prefix, -Infinity, -Infinity];
  const high = [...prefix, Infinity, Infinity];
  const index = query.filter === 'all' ? 'by_plugin_updated' : 'by_plugin_picked_updated';
  if (from === undefined) return { index, range: IDBKeyRange.bound(low, high) };
  // Walking `prev`: everything strictly below the named record.
  return { index, range: IDBKeyRange.bound(low, [...prefix, from.updatedAt, from.id], false, true) };
}

export function listCatalog(db: IDBDatabase, query: CatalogQuery, opts: ListCatalogOptions): Promise<readonly CatalogRecord[]> {
  const { index, range } = rangeFor(query, opts.from);
  const cursorRequest = db.transaction(CATALOG_STORE, 'readonly').objectStore(CATALOG_STORE).index(index).openCursor(range, 'prev');
  return new Promise((resolve, reject) => {
    const results: CatalogRecord[] = [];
    cursorRequest.addEventListener('success', () => {
      const cursor = cursorRequest.result;
      if (cursor === null || results.length >= opts.limit) {
        resolve(results);
        return;
      }
      const value: unknown = cursor.value;
      // A malformed record is skipped rather than thrown on: the walk is a
      // page for a screen, and one bad record should cost one row, not the page.
      if (isCatalogRecord(value) && (query.term === '' || value.haystack.includes(query.term))) results.push(value);
      cursor.continue();
    });
    cursorRequest.addEventListener('error', () => reject(cursorRequest.error ?? new Error('indexeddb cursor failed')), { once: true });
  });
}
