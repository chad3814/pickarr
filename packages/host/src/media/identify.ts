/**
 * `POST /api/releases/:id/identify`'s rule (design spec 2026-10-02 §1.3):
 * validate the release and, for `media-item`, the target; then either move
 * the release (synchronously, through `reassignRelease`) or ask its plugin
 * to look it up again (asynchronously, through `onLookupRequest`). The
 * route turns the outcome into a status; this file never sees HTTP.
 *
 * A plugin that throws is not a refusal: the work did not happen and the
 * cause is a fault, so the error propagates to the API's outermost handler
 * as a 500, on the reasoning `retry.ts` gives.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { IdentifyReleaseOutcome, IdentifyRequest, MediaPlugin, MediaWriter, PluginContext } from '@pickarr/contract';

export interface IdentifyDeps {
  readonly raw: DatabaseSync;
  readonly pluginFor: (pluginId: string) => MediaPlugin | undefined;
  readonly ctxFor: (pluginId: string) => PluginContext;
  readonly reassign: MediaWriter['reassignRelease'];
}

export async function identifyRelease(
  deps: IdentifyDeps,
  rssItemId: number,
  request: IdentifyRequest,
): Promise<IdentifyReleaseOutcome> {
  const release = deps.raw
    .prepare('SELECT r.media_item_id AS mediaItemId, f.plugin_id AS pluginId FROM rss_item r JOIN rss_feed f ON f.id = r.feed_id WHERE r.id = ?')
    .get(rssItemId);
  if (release === undefined) return { refusal: 'unknown-release' };
  const pluginId = release['pluginId'];
  if (typeof pluginId !== 'string') return { refusal: 'unknown-release' };
  const plugin = deps.pluginFor(pluginId);
  if (plugin === undefined) return { refusal: 'plugin-not-registered' };

  if (request.mode === 'media-item') {
    const target = deps.raw.prepare('SELECT plugin_id FROM media_item WHERE id = ?').get(request.mediaItemId);
    if (target === undefined) return { refusal: 'unknown-media-item' };
    if (target['plugin_id'] !== pluginId) return { refusal: 'wrong-plugin' };
    if (release['mediaItemId'] === request.mediaItemId) return { refusal: 'already-linked' };
    await deps.reassign(rssItemId, request.mediaItemId);
    return { outcome: 'linked', mediaItemId: request.mediaItemId };
  }

  await plugin.onLookupRequest(rssItemId, request.mode === 'name' ? { name: request.name } : undefined, deps.ctxFor(pluginId));
  return { accepted: true };
}
