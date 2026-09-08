/**
 * The only implementation of `MediaReader` -- what a plugin uses instead of
 * `ctx.db`, so it stops hand-writing SQL against tables it has never seen.
 * The test double did exactly that, and slice A's spec recorded why: until
 * this existed, every plugin improvised a reader.
 *
 * Four methods, each one call into `../api/reads.ts`. Deliberately no SQL of
 * its own: the HTTP layer and every plugin answer the same questions, and two
 * readers with their own queries would drift on precisely the questions that
 * matter -- what counts as deleted, what a null `client_ref` means, which
 * rows are terminal.
 *
 * **`pluginId` is closed over, never a parameter.** A plugin cannot name
 * another plugin's id because it never gets to name one at all, which is the
 * same shape `ctxFor` already gives `jobs.enqueue`. A media item belonging to
 * someone else reads `null`, exactly as one that does not exist does; see
 * `mediaItemById` for why those two are one answer.
 *
 * `rssItemsFor` and `downloadsFor` are **not** scoped: an rss item and a
 * download are reached from an id the caller already holds, and the shared
 * tables carry no plugin column to filter them by -- ownership lives on
 * `rss_feed`, a join away. That is the same reach `ctx.media.setResolution`
 * and `ctx.media.dropMediaItem` already have over any id, and it is recorded
 * here rather than implied: what keeps a plugin on its own side is
 * convention and explicit wiring, not enforcement.
 *
 * Every method is `async` over a synchronous query, because `node:sqlite` is
 * synchronous and `MediaReader` promises anyway -- see the interface for why.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadRead, MediaItemRead, MediaReader, RssItemRead } from '@pickarr/contract';
import {
  downloadsForRssItem,
  mediaItemById,
  mediaItemByProviderRef,
  rssItemsForMediaItem,
} from '../api/reads.ts';

export function createMediaReader(raw: DatabaseSync, pluginId: string): MediaReader {
  return {
    async mediaItem(id: number): Promise<MediaItemRead | null> {
      return mediaItemById(raw, pluginId, id);
    },

    async mediaItemByProviderRef(provider: string, ref: string): Promise<MediaItemRead | null> {
      return mediaItemByProviderRef(raw, pluginId, provider, ref);
    },

    async rssItemsFor(mediaItemId: number): Promise<RssItemRead[]> {
      return rssItemsForMediaItem(raw, mediaItemId);
    },

    async downloadsFor(rssItemId: number): Promise<DownloadRead[]> {
      return downloadsForRssItem(raw, rssItemId);
    },
  };
}
