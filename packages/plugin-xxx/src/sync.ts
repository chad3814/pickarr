/**
 * What a client receives for a scene, and what it does not.
 *
 * `details_json` is projected away: it is the metadata provider's answer
 * verbatim, unbounded, and nothing in a view reads it (design spec §3.9).
 *
 * `xxx_scene` is listed first, `xxx_site` after it -- the order a plugin
 * declares its tables in is the order the backfill writes them for one group
 * (`sync/backfill.ts`), and a scene names the site it points at, so the
 * detail comes before the shared parent.
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { SyncedTable, XxxRead, XxxSiteRead } from '@pickarr/contract';

function asText(value: SQLOutputValue | undefined): string {
  return String(value);
}

function asTextOrNull(value: SQLOutputValue | undefined): string | null {
  return value === null ? null : String(value);
}

function asNumber(value: SQLOutputValue | undefined): number {
  return Number(value);
}

/** `?, ?, ...`, one per id -- never the ids themselves, which stay bound parameters. */
function holes(ids: readonly number[]): string {
  return ids.map(() => '?').join(', ');
}

/**
 * A scene's site name and reference, flattened by a join: `XxxRead` is what
 * one scene reads as, not what `xxx_scene` alone holds. The join is left,
 * not inner -- `xxx_scene.site_id` is nullable (`apply.ts`: "a scene whose
 * site is unknown is still a scene worth having"), so a scene with no known
 * site reads both fields `null` rather than being excluded.
 *
 * `mediaItemId` is `xxx_scene.media_item_id`, which the client groups by.
 * This row's own id is not here and must not be: the host puts it on the op
 * (`sync/tail.ts`'s `SyncOp`), so keying does not depend on each read shape
 * remembering a field.
 */
const scene: SyncedTable<XxxRead> = {
  table: 'xxx_scene',
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, XxxRead> {
    if (ids.length === 0) return {};
    const rows = raw.prepare(`
      SELECT sc.id, sc.media_item_id, st.name AS site_name, st.provider_ref AS site_ref
      FROM xxx_scene sc
      LEFT JOIN xxx_site st ON st.id = sc.site_id
      WHERE sc.id IN (${holes(ids)})
    `).all(...ids);
    const result: Record<number, XxxRead> = {};
    for (const row of rows) {
      result[asNumber(row.id)] = {
        mediaItemId: asNumber(row.media_item_id),
        siteName: asTextOrNull(row.site_name),
        siteRef: asTextOrNull(row.site_ref),
      };
    }
    return result;
  },
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[] {
    if (mediaItemIds.length === 0) return [];
    const rows = raw.prepare(
      `SELECT id FROM xxx_scene WHERE media_item_id IN (${holes(mediaItemIds)})`,
    ).all(...mediaItemIds);
    return rows.map((row) => asNumber(row.id));
  },
};

/**
 * A site's own row, reached only through the scenes that point at it --
 * `xxx_site` carries no `media_item_id` of its own, since many scenes share
 * one site.
 */
const site: SyncedTable<XxxSiteRead> = {
  table: 'xxx_site',
  read(raw: DatabaseSync, ids: readonly number[]): Record<number, XxxSiteRead> {
    if (ids.length === 0) return {};
    const rows = raw.prepare(
      `SELECT id, name, provider_ref FROM xxx_site WHERE id IN (${holes(ids)})`,
    ).all(...ids);
    const result: Record<number, XxxSiteRead> = {};
    for (const row of rows) {
      result[asNumber(row.id)] = { name: asText(row.name), providerRef: asText(row.provider_ref) };
    }
    return result;
  },
  rowsFor(raw: DatabaseSync, mediaItemIds: readonly number[]): readonly number[] {
    if (mediaItemIds.length === 0) return [];
    const rows = raw.prepare(`
      SELECT DISTINCT site_id AS id FROM xxx_scene
      WHERE media_item_id IN (${holes(mediaItemIds)}) AND site_id IS NOT NULL
    `).all(...mediaItemIds);
    return rows.map((row) => asNumber(row.id));
  },
};

export const XXX_SYNCED: readonly SyncedTable<unknown>[] = [scene, site];
