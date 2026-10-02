/**
 * Moves a release to a media item and cleans up behind it (design spec
 * 2026-10-02 §1.2). The one place `rss_item.media_item_id` changes from a
 * non-null value, and the one place a media item is dropped for having no
 * releases left.
 *
 * **One savepoint for the whole move.** The plugin's own rows go first,
 * because `tv_release`, `movie_detail` and `xxx_scene` reference the item
 * with `PRAGMA foreign_keys = ON` and no cascade; roles next for the same
 * reason; `dropMediaItem` last (its own nested savepoint writes the
 * tombstone and clears artwork rows). A throw anywhere -- a plugin hook
 * included -- rolls back to before the relink, so the release is never
 * left pointing somewhere while its old item is half-deleted.
 *
 * Both items' `updated_at` are set to now. That is what carries the move to
 * the browser: `useGatheredItem` re-gathers on a `media_item` row change,
 * and the sync log emits the rows because they changed.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MediaWriter } from '@pickarr/contract';

export interface ReassignDeps {
  raw: DatabaseSync;
  relink: MediaWriter['relinkRssItem'];
  drop: MediaWriter['dropMediaItem'];
  now: () => number;
  /** The owning plugin deletes its rows for the item; `host.ts` binds this to `MediaPlugin.onMediaItemDropped`. */
  dropRows: (pluginId: string, mediaItemId: number) => Promise<void>;
}

function previousLink(raw: DatabaseSync, rssItemId: number): number | null | undefined {
  const row = raw.prepare('SELECT media_item_id FROM rss_item WHERE id = ?').get(rssItemId);
  if (row === undefined) return undefined;
  const value = row['media_item_id'];
  return typeof value === 'number' ? value : null;
}

function pluginOf(raw: DatabaseSync, mediaItemId: number): string | undefined {
  const row = raw.prepare('SELECT plugin_id FROM media_item WHERE id = ?').get(mediaItemId);
  const value = row?.['plugin_id'];
  return typeof value === 'string' ? value : undefined;
}

function releasesPointingAt(raw: DatabaseSync, mediaItemId: number): number {
  const row = raw.prepare('SELECT count(*) AS n FROM rss_item WHERE media_item_id = ?').get(mediaItemId);
  const n = row?.['n'];
  return typeof n === 'number' ? n : 0;
}

export async function reassignRelease(deps: ReassignDeps, rssItemId: number, mediaItemId: number): Promise<void> {
  const { raw } = deps;
  const previous = previousLink(raw, rssItemId);
  if (previous === undefined) throw new Error(`reassignRelease: no rss item ${String(rssItemId)}`);
  const at = deps.now();
  raw.exec('SAVEPOINT reassign_release');
  try {
    await deps.relink(rssItemId, mediaItemId);
    raw.prepare("UPDATE rss_item SET lookup_state = 'resolved', lookup_state_detail = NULL, updated_at = ? WHERE id = ?").run(at, rssItemId);
    raw.prepare('UPDATE media_item SET updated_at = ? WHERE id = ?').run(at, mediaItemId);
    if (previous !== null && previous !== mediaItemId) {
      if (releasesPointingAt(raw, previous) === 0) {
        const pluginId = pluginOf(raw, previous);
        if (pluginId === undefined) throw new Error(`reassignRelease: media item ${String(previous)} vanished mid-move`);
        await deps.dropRows(pluginId, previous);
        raw.prepare('DELETE FROM role WHERE media_item_id = ?').run(previous);
        await deps.drop(previous);
      } else {
        raw.prepare('UPDATE media_item SET updated_at = ? WHERE id = ?').run(at, previous);
      }
    }
  } catch (err) {
    raw.exec('ROLLBACK TO reassign_release');
    raw.exec('RELEASE reassign_release');
    throw err;
  }
  raw.exec('RELEASE reassign_release');
}
