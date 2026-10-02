/**
 * The catalog's maintenance: which media items a batch of ops affects, and
 * a fresh record for each (design spec 2026-10-02 §1.3). Runs inside
 * `applyBatch`'s transaction, after its writes, so every read here sees the
 * batch's own rows and the result commits or aborts with them.
 *
 * **A recompute, never a patch.** Each affected item is rebuilt from `rows`
 * in full, which is what makes op order inside a batch irrelevant: a
 * download before its release, a role before its person, a release before
 * its item -- all read the same final state. The price is three to six
 * reads per affected item; `catalog-apply.test.ts` keeps a tripwire on it.
 *
 * Only five tables matter here. A plugin-owned row that carries
 * `mediaItemId` (a `tv_release`) comes back from `by_media_item` too and is
 * filtered out by `table`, not by shape.
 */
import type { SyncOp } from './wire.ts';
import type { StoredRow } from './db.ts';
import { request } from './idb.ts';
import { CATALOG_STORE, type CatalogRecord } from './catalog.ts';

export interface HeldOp { op: SyncOp; existing: StoredRow | undefined; }

const DOWNLOAD_TABLES: ReadonlySet<string> = new Set(['torrent_download', 'nzb_download']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}
function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'string' ? field : undefined;
}

export async function affectedMediaItems(tx: IDBTransaction, held: readonly HeldOp[]): Promise<ReadonlySet<number>> {
  const rows = tx.objectStore('rows');
  const ids = new Set<number>();
  const pending: Promise<void>[] = [];
  for (const { op, existing } of held) {
    const versions: unknown[] = [op.op === 'delete' ? undefined : op.value, existing?.value];
    switch (op.table) {
      case 'media_item':
        ids.add(op.id);
        break;
      case 'rss_item':
      case 'role':
        for (const v of versions) { const m = numberField(v, 'mediaItemId'); if (m !== undefined) ids.add(m); }
        break;
      case 'torrent_download':
      case 'nzb_download':
        for (const v of versions) {
          const rssItemId = numberField(v, 'rssItemId');
          if (rssItemId === undefined) continue;
          pending.push(request<StoredRow | undefined>(rows.get(['rss_item', rssItemId])).then((row) => {
            const m = numberField(row?.value, 'mediaItemId');
            if (m !== undefined) ids.add(m);
          }));
        }
        break;
      case 'person':
        pending.push(request<StoredRow[]>(rows.index('by_person').getAll(op.id)).then((roles) => {
          for (const r of roles) { const m = numberField(r.value, 'mediaItemId'); if (m !== undefined) ids.add(m); }
        }));
        break;
      default:
        break;
    }
  }
  await Promise.all(pending);
  return ids;
}

export function buildHaystack(parts: readonly string[]): string {
  return parts.map((p) => p.trim().toLowerCase().replace(/\s+/g, ' ')).join('\n');
}

/** Whether a record was written or deleted: an absent item with no record to delete is no change. */
async function recomputeOne(tx: IDBTransaction, id: number): Promise<boolean> {
  const rows = tx.objectStore('rows');
  const catalog = tx.objectStore(CATALOG_STORE);
  const item = await request<StoredRow | undefined>(rows.get(['media_item', id]));
  const pluginId = stringField(item?.value, 'pluginId');
  const updatedAt = numberField(item?.value, 'updatedAt');
  if (item === undefined || pluginId === undefined || updatedAt === undefined) {
    // Absent or a tombstone: no record. A release can arrive before its
    // item, so there may be no record to delete either, and nothing changed.
    if ((await request<IDBValidKey | undefined>(catalog.getKey(id))) === undefined) return false;
    catalog.delete(id);
    return true;
  }
  const linked = await request<StoredRow[]>(rows.index('by_media_item').getAll(id));
  const releases = linked.filter((r) => r.table === 'rss_item').sort((a, b) => a.id - b.id);
  const roles = linked.filter((r) => r.table === 'role').sort((a, b) => a.id - b.id);
  const [downloadSets, people] = await Promise.all([
    Promise.all(releases.map((r) => request<StoredRow[]>(rows.index('by_rss_item').getAll(r.id)))),
    Promise.all(roles.map((r) => {
      const personId = numberField(r.value, 'personId');
      return personId === undefined ? Promise.resolve(undefined) : request<StoredRow | undefined>(rows.get(['person', personId]));
    })),
  ]);
  const picked: 0 | 1 = downloadSets.some((set) => set.some((d) => DOWNLOAD_TABLES.has(d.table) && d.value !== undefined)) ? 1 : 0;
  const parts: string[] = [stringField(item.value, 'title') ?? ''];
  const releaseDate = stringField(item.value, 'releaseDate');
  if (releaseDate !== undefined && releaseDate.length >= 4) parts.push(releaseDate.slice(0, 4));
  for (const r of releases) { const f = stringField(r.value, 'filename'); if (f !== undefined) parts.push(f); }
  for (const p of people) { const n = stringField(p?.value, 'name'); if (n !== undefined) parts.push(n); }
  const record: CatalogRecord = { id, pluginId, updatedAt, picked, haystack: buildHaystack(parts) };
  catalog.put(record);
  return true;
}

/** Rebuilds every id's record (or deletes it) and returns the ids actually written or deleted, ascending, for `Changed.catalog`. */
export async function recomputeCatalog(tx: IDBTransaction, ids: ReadonlySet<number>): Promise<number[]> {
  const sorted = Array.from(ids).sort((a, b) => a - b);
  const changed = await Promise.all(sorted.map((id) => recomputeOne(tx, id)));
  return sorted.filter((_, i) => changed[i] === true);
}
