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
 * **All four methods are scoped, `rssItemsFor` and `downloadsFor` included.**
 * An rss item and a download are reached from an id the caller already
 * holds -- a media item id, an rss item id -- rather than from `pluginId`
 * directly, but ownership is still reachable: an rss item belongs to a feed
 * and a feed names its plugin, and a download belongs to an rss item, so
 * `rssItemsForMediaItem`/`downloadsForRssItem` join through `rss_feed` to
 * the same `plugin_id` check `mediaItem` makes directly. An id belonging to
 * another plugin's feed reads `[]`, the same "not yours" answer `mediaItem`
 * gives as `null` for the same reason: there is no id a plugin holds, gotten
 * honestly from one of its own scoped reads, that this closes off. It is
 * only the id an id-guessing caller invents that now finds nothing.
 *
 * **`MediaWriter` remains unscoped.** `ctx.media.setResolution` and
 * `ctx.media.dropMediaItem` still take any id and act on it regardless of
 * who wrote the row underneath -- that asymmetry between what a plugin can
 * read and what it can change is real and outlives this file. Scoping the
 * writer the same way is a later slice's change, not this one's: a read
 * side honest about ownership is worth having on its own, and closing the
 * gap from the read direction first does not make the write side worse.
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
      return rssItemsForMediaItem(raw, mediaItemId, pluginId);
    },

    async downloadsFor(rssItemId: number): Promise<DownloadRead[]> {
      return downloadsForRssItem(raw, rssItemId, pluginId);
    },
  };
}
