/**
 * The catalog's maintenance: which media items a batch of ops affects, and
 * a fresh record for each (design spec 2026-10-02 §1.3). Runs inside
 * `applyBatch`'s transaction, after its writes, so every read here sees the
 * batch's own rows and the result commits or aborts with them.
 *
 * **A recompute, never a patch.** Each affected item is rebuilt from `rows`
 * in full, which is what makes op order inside a batch irrelevant: a
 * download before its release, a role before its person, a release before
 * its item -- all read the same final state. The haystack costs two reads
 * per affected item plus one per role with a person id (an absent item
 * costs two in all), and the two image ids come from the `by_media_item`
 * read, so they add none.
 *
 * **Except `picked`, which is one bit and used to cost one read per
 * release (#108).** "Any download row exists for any release of this item"
 * needs a `by_rss_item` read per release to answer from scratch, and every
 * batch that touched the item -- each sync page of a long-running show's
 * releases, each tail tick's download progress -- paid all of them again:
 * quadratic over bootstrap, a few hundred reads per tick after. The bit can
 * only change in ways the batch itself shows, so `affectedMediaItems` now
 * says, per item, what the batch did to its downloads ({@link PickedHint}),
 * and `recomputeOne` reads accordingly: the previous record's bit when the
 * batch could not have changed it, `1` with no reads when it added a
 * download, one read for a release newly linked to the item (its downloads
 * may have replicated before it did), and the full per-release scan only
 * when something could have *removed* a download -- a download tombstone,
 * a release deleted or rematched away -- or when there is no previous
 * record to carry. The answer is the one a full recompute gives in every
 * case, and it still does not depend on op order, because the hint is
 * built from the set of ops and their pre-images, not their sequence.
 * `catalog-apply.test.ts` counts the reads.
 *
 * Only eight tables matter here (`media_item`, `rss_item`, `role`, `person`,
 * `torrent_download`, `nzb_download`, `poster`, `background`). A plugin-owned row that carries
 * `mediaItemId` (a `tv_release`) comes back from `by_media_item` too and is
 * filtered out by `table`, not by shape.
 */
import type { SyncOp } from './wire.ts';
import type { StoredRow } from './db.ts';
import { request } from './idb.ts';
import { buildHaystack, CATALOG_STORE, type CatalogRecord } from './catalog.ts';

export interface HeldOp { op: SyncOp; existing: StoredRow | undefined; }

const DOWNLOAD_TABLES: ReadonlySet<string> = new Set(['torrent_download', 'nzb_download']);

function isDownloadKey(key: IDBValidKey): boolean {
  return Array.isArray(key) && typeof key[0] === 'string' && DOWNLOAD_TABLES.has(key[0]);
}
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

/**
 * What one batch did to one media item's downloads, as far as `picked` is
 * concerned (module doc, #108). Built by {@link affectedMediaItems}, read
 * by `recomputeOne`.
 */
export interface PickedHint {
  /** Something could have removed a download: a download tombstone, or a release deleted or rematched away. Read every release. */
  full: boolean;
  /** A download row was written for one of this item's releases. `picked` is 1 without a read. */
  added: boolean;
  /** Releases newly linked to this item by this batch, whose downloads may already be in the replica. One read each. */
  check: Set<number>;
}

/**
 * The media items a batch affects, each with its {@link PickedHint}.
 *
 * An op `applyBatch` did not apply -- a `create` over a key already held,
 * tombstone included -- changed nothing and is skipped here too, for the
 * same reason and one more: its hint would describe a write that did not
 * happen, and a `create` of a download over its own tombstone would
 * otherwise mark the item picked for a row that does not exist.
 */
export async function affectedMediaItems(tx: IDBTransaction, held: readonly HeldOp[]): Promise<ReadonlyMap<number, PickedHint>> {
  const rows = tx.objectStore('rows');
  const hints = new Map<number, PickedHint>();
  const hint = (id: number): PickedHint => {
    const known = hints.get(id);
    if (known !== undefined) return known;
    const fresh: PickedHint = { full: false, added: false, check: new Set() };
    hints.set(id, fresh);
    return fresh;
  };
  const pending: Promise<void>[] = [];
  for (const { op, existing } of held) {
    if (op.op === 'create' && existing !== undefined) continue;
    const next: unknown = op.op === 'delete' ? undefined : op.value;
    const previous: unknown = existing?.value;
    switch (op.table) {
      case 'media_item':
        hint(op.id);
        break;
      case 'rss_item': {
        const before = numberField(previous, 'mediaItemId');
        const after = numberField(next, 'mediaItemId');
        // A release that left an item may have taken downloads with it; one
        // that joined may have brought some. One that stayed changed neither.
        if (before !== undefined && before !== after) hint(before).full = true;
        if (after !== undefined) {
          const joined = hint(after);
          if (before !== after) joined.check.add(op.id);
        }
        break;
      }
      case 'role':
        for (const v of [next, previous]) { const m = numberField(v, 'mediaItemId'); if (m !== undefined) hint(m); }
        break;
      case 'poster':
      case 'background':
        // An image arriving, re-ranking or leaving changes which row the
        // tile shows and nothing else: no download moved, so the hint
        // stays empty and the recompute carries `picked`.
        for (const v of [next, previous]) { const m = numberField(v, 'mediaItemId'); if (m !== undefined) hint(m); }
        break;
      case 'torrent_download':
      case 'nzb_download':
        for (const [v, removed] of [[next, false], [previous, op.op === 'delete']] as const) {
          const rssItemId = numberField(v, 'rssItemId');
          if (rssItemId === undefined) continue;
          pending.push(request<StoredRow | undefined>(rows.get(['rss_item', rssItemId])).then((row) => {
            const m = numberField(row?.value, 'mediaItemId');
            if (m === undefined) return;
            if (removed) hint(m).full = true;
            else hint(m).added = true;
          }));
        }
        break;
      case 'person':
        pending.push(request<StoredRow[]>(rows.index('by_person').getAll(op.id)).then((roles) => {
          for (const r of roles) { const m = numberField(r.value, 'mediaItemId'); if (m !== undefined) hint(m); }
        }));
        break;
      default:
        break;
    }
  }
  await Promise.all(pending);
  return hints;
}

/**
 * Whether any download row exists for any of `releaseIds`: one `by_rss_item`
 * key read per release. `by_rss_item` holds live rows only (a tombstone has
 * no `value`, so it is not indexed), so any download-table key here is a
 * live download. Keys, not rows: only the table half of `[table, id]` is
 * needed.
 */
async function anyDownloadFor(rows: IDBObjectStore, releaseIds: readonly number[]): Promise<boolean> {
  const keySets = await Promise.all(
    releaseIds.map((id) => request<IDBValidKey[]>(rows.index('by_rss_item').getAllKeys(id))),
  );
  return keySets.some((keys) => keys.some(isDownloadKey));
}

/** Whether a record was written or deleted: an absent item with no record to delete is no change. */
async function recomputeOne(tx: IDBTransaction, id: number, hint: PickedHint): Promise<boolean> {
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
  // The previous record is read only when its `picked` can be carried: a
  // full scan answers without it, and a batch that could have removed a
  // download must not trust it (module doc, #108).
  const [linked, previous] = await Promise.all([
    request<StoredRow[]>(rows.index('by_media_item').getAll(id)),
    hint.full ? Promise.resolve(undefined) : request<CatalogRecord | undefined>(catalog.get(id)),
  ]);
  const releases = linked.filter((r) => r.table === 'rss_item').sort((a, b) => a.id - b.id);
  const roles = linked.filter((r) => r.table === 'role').sort((a, b) => a.id - b.id);
  const bestOf = (table: 'poster' | 'background'): number | null => {
    const best = linked
      .filter((r) => r.table === table)
      .map((r) => ({ id: r.id, rank: numberField(r.value, 'rank') }))
      .filter((r): r is { id: number; rank: number } => r.rank !== undefined)
      .sort((a, b) => a.rank - b.rank || a.id - b.id)[0];
    return best === undefined ? null : best.id;
  };
  const [anyDownload, people] = await Promise.all([
    hint.full || previous === undefined
      ? anyDownloadFor(rows, releases.map((r) => r.id))
      : previous.picked === 1 || hint.added || anyDownloadFor(rows, [...hint.check]),
    Promise.all(roles.map((r) => {
      const personId = numberField(r.value, 'personId');
      return personId === undefined ? Promise.resolve(undefined) : request<StoredRow | undefined>(rows.get(['person', personId]));
    })),
  ]);
  const picked: 0 | 1 = anyDownload ? 1 : 0;
  const parts: string[] = [stringField(item.value, 'title') ?? ''];
  const releaseDate = stringField(item.value, 'releaseDate');
  if (releaseDate !== undefined && releaseDate.length >= 4) parts.push(releaseDate.slice(0, 4));
  for (const r of releases) { const f = stringField(r.value, 'filename'); if (f !== undefined) parts.push(f); }
  for (const p of people) { const n = stringField(p?.value, 'name'); if (n !== undefined) parts.push(n); }
  const record: CatalogRecord = {
    id, pluginId, updatedAt, picked, haystack: buildHaystack(parts),
    poster: bestOf('poster'), background: bestOf('background'),
  };
  catalog.put(record);
  return true;
}

/** Rebuilds every id's record (or deletes it) and returns the ids actually written or deleted, ascending, for `Changed.catalog`. */
export async function recomputeCatalog(tx: IDBTransaction, hints: ReadonlyMap<number, PickedHint>): Promise<number[]> {
  const sorted = Array.from(hints.keys()).sort((a, b) => a - b);
  const changed = await Promise.all(sorted.map((id) => {
    const hint = hints.get(id);
    return recomputeOne(tx, id, hint ?? { full: true, added: false, check: new Set() });
  }));
  return sorted.filter((_, i) => changed[i] === true);
}
