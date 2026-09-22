/**
 * What a finished television download should hold (design spec 2026-09-22
 * §6): one file for an episode, a pack of episodes for a season or a series.
 *
 * A season pack carries its own season number so `select` can refuse a file
 * from another season; a series pack, and a season whose number the service
 * never gave, carry `null` and accept any.
 */
import { DatabaseSync } from 'node:sqlite';
import type { DownloadedFile, PluginContext } from '@pickarr/contract';
import type { Expectation } from '@pickarr/openmetadata';

function connection(ctx: PluginContext): DatabaseSync {
  if (!(ctx.db instanceof DatabaseSync)) throw new TypeError('plugin-tv: ctx.db is not a node:sqlite DatabaseSync');
  return ctx.db;
}

export async function expectsTv(file: DownloadedFile, ctx: PluginContext): Promise<Expectation> {
  if (file.mediaItemId === null) throw new Error('plugin-tv: expects asked about an unmatched release');
  const row = connection(ctx).prepare(`
    SELECT r.kind AS kind, n.season_number AS season
      FROM tv_release r LEFT JOIN tv_season n ON n.id = r.season_id
     WHERE r.media_item_id = ?
  `).get(file.mediaItemId);
  // Thrown, not defaulted: a matched tv media item with no release row is a
  // broken invariant, and guessing `single` would refuse a real pack forever.
  if (row === undefined) throw new Error(`plugin-tv: no tv_release for media item ${file.mediaItemId}`);
  const kind = row['kind'];
  const season = row['season'];
  if (kind === 'episode') return { kind: 'single' };
  if (kind === 'series') return { kind: 'episodes', season: null };
  if (kind === 'season') return { kind: 'episodes', season: typeof season === 'number' ? season : null };
  throw new Error(`plugin-tv: tv_release.kind is ${String(kind)}`);
}
