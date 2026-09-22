/**
 * Which entries of a download this plugin has already put in its library
 * (design spec 2026-09-22 §7), so a retried pack resumes instead of meeting
 * its own earlier copies as `destination-exists`.
 *
 * **A generator, listed by each plugin as its own migration**, not prepended
 * by the engine the way `lookupTableMigration` is: the engine owns version 1
 * and each plugin's own migrations begin at 2, so an engine-appended version
 * would collide with the next migration a plugin writes.
 *
 * Written after the copy. A crash between the rename and the insert leaves
 * one file placed and unrecorded, and the retry answers `destination-exists`
 * for it; the spec names this window and leaves it open.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '@pickarr/contract';

export function placementTableName(pluginId: string): string {
  return `${pluginId}_placement`;
}

export function placementTableMigration(pluginId: string, version: number): Migration {
  const table = placementTableName(pluginId);
  return {
    version,
    up: (db) => db.exec(`
CREATE TABLE ${table} (
  id            INTEGER PRIMARY KEY,
  rss_item_id   INTEGER NOT NULL REFERENCES rss_item (id),
  relative_path TEXT NOT NULL,
  placed_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX ${table}_entry ON ${table} (rss_item_id, relative_path);
`),
  };
}

export function isPlaced(raw: DatabaseSync, pluginId: string, rssItemId: number, relativePath: string): boolean {
  const row = raw
    .prepare(`SELECT 1 AS found FROM ${placementTableName(pluginId)} WHERE rss_item_id = ? AND relative_path = ?`)
    .get(rssItemId, relativePath);
  return row !== undefined;
}

export function recordPlacement(
  raw: DatabaseSync,
  pluginId: string,
  rssItemId: number,
  relativePath: string,
  at: number,
): void {
  raw
    .prepare(`INSERT INTO ${placementTableName(pluginId)} (rss_item_id, relative_path, placed_at)
      VALUES (?, ?, ?) ON CONFLICT (rss_item_id, relative_path) DO NOTHING`)
    .run(rssItemId, relativePath, at);
}
