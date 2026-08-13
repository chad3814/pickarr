import type { DatabaseSync } from 'node:sqlite';
import type { MetadataPerformer } from '@pickarr/plugin-api';
import { maybeStr, num, str, type SqlRow } from './row.ts';

export interface PerformerRow {
  id: number;
  sourceUuid: string;
  slug: string;
  name: string;
  kind: 'performer' | 'performer-site';
  faceUrl: string | null;
  facePath: string | null;
  imageUrl: string | null;
  imagePath: string | null;
}

const COLUMNS = `id, source_uuid, slug, name, kind, face_url, face_path, image_url, image_path`;

function toPerformer(row: SqlRow): PerformerRow {
  return {
    id: num(row, 'id'),
    sourceUuid: str(row, 'source_uuid'),
    slug: str(row, 'slug'),
    name: str(row, 'name'),
    kind: str(row, 'kind') === 'performer-site' ? 'performer-site' : 'performer',
    faceUrl: maybeStr(row, 'face_url'),
    facePath: maybeStr(row, 'face_path'),
    imageUrl: maybeStr(row, 'image_url'),
    imagePath: maybeStr(row, 'image_path'),
  };
}

/**
 * Inserts or refreshes each performer, answering their ids in the order given.
 *
 * The conflict target is `(source, source_uuid)` and the update deliberately
 * leaves `face_path` and `image_path` alone: those name files already on
 * disk, and the uuid is the identity, so a slug rename or a re-billing is an
 * update to a row that keeps its cached artwork. Overwriting the paths here
 * would orphan the files and re-download them on the next pass.
 *
 * The urls *are* updated: if the provider moved the image, the next artwork
 * pass should fetch the new one.
 */
export function upsertPerformers(
  db: DatabaseSync,
  source: string,
  performers: readonly MetadataPerformer[],
  now: number,
): number[] {
  const upsert = db.prepare(
    `INSERT INTO performers (source, source_uuid, slug, name, kind, face_url, image_url, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, source_uuid) DO UPDATE SET
       slug = excluded.slug, name = excluded.name, kind = excluded.kind,
       face_url = excluded.face_url, image_url = excluded.image_url,
       fetched_at = excluded.fetched_at
     RETURNING id`,
  );
  return performers.map((performer) => {
    const row = upsert.get(
      source, performer.sourceUuid, performer.slug, performer.name,
      performer.kind, performer.faceUrl, performer.imageUrl, now,
    );
    return num(row as SqlRow, 'id');
  });
}

/**
 * Replaces the group's cast wholesale. A refetch that corrected the cast must
 * not leave the previous one attached, and `position` is assigned here from
 * the array order rather than stored by the caller — the order is the
 * provider's billing order, and there is one place that knows it.
 */
export function setGroupPerformers(
  db: DatabaseSync,
  groupId: number,
  performerIds: readonly number[],
): void {
  db.prepare('DELETE FROM group_performers WHERE group_id = ?').run(groupId);
  const link = db.prepare(
    'INSERT INTO group_performers (group_id, performer_id, position) VALUES (?, ?, ?)',
  );
  performerIds.forEach((performerId, index) => link.run(groupId, performerId, index));
}

/**
 * One query for a whole page, for the reason `metadataForGroups` documents:
 * issue #31 records `/api/downloads` issuing a query per row and polling it
 * every three seconds, and browse must not reacquire that defect while
 * gaining this field.
 */
export function performersForGroups(
  db: DatabaseSync,
  groupIds: readonly number[],
): Map<number, PerformerRow[]> {
  const found = new Map<number, PerformerRow[]>();
  if (groupIds.length === 0) return found;
  const holes = groupIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT gp.group_id, ${COLUMNS} FROM group_performers gp
       JOIN performers ON performers.id = gp.performer_id
       WHERE gp.group_id IN (${holes})
       ORDER BY gp.group_id, gp.position`,
    )
    .all(...groupIds);
  for (const row of rows) {
    const groupId = num(row as SqlRow, 'group_id');
    const list = found.get(groupId) ?? [];
    list.push(toPerformer(row as SqlRow));
    found.set(groupId, list);
  }
  return found;
}

export function getPerformer(db: DatabaseSync, id: number): PerformerRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM performers WHERE id = ?`).get(id);
  return row === undefined ? null : toPerformer(row as SqlRow);
}

/** The artwork columns are written one at a time, as each fetch lands. */
export function setPerformerArtwork(
  db: DatabaseSync,
  id: number,
  kind: 'face' | 'image',
  path: string,
): void {
  // `column` is interpolated, not bound — SQLite cannot bind an identifier.
  // It is chosen from a two-value union, never from input.
  const column = kind === 'face' ? 'face_path' : 'image_path';
  db.prepare(`UPDATE performers SET ${column} = ? WHERE id = ?`).run(path, id);
}

/** Those of these performers with a url but no file yet, in one query. */
export function performersNeedingArtwork(
  db: DatabaseSync,
  ids: readonly number[],
): PerformerRow[] {
  if (ids.length === 0) return [];
  const holes = ids.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM performers
       WHERE id IN (${holes})
         AND ((face_url IS NOT NULL AND face_path IS NULL)
           OR (image_url IS NOT NULL AND image_path IS NULL))`,
    )
    .all(...ids)
    .map((row) => toPerformer(row as SqlRow));
}
