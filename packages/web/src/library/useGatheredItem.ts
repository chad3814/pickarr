/**
 * A media item's gathered detail, fetched lazily, and cached only as what
 * to render while the next gather runs.
 *
 * **The cache is a placeholder, not an answer, and it used to be both.**
 * While `enabled` is `false` this hook tears down both subscriptions, so a
 * download row that replicates in while a card is collapsed is not
 * noticed. Serving the cached gather on re-expand and stopping there meant
 * the card then rendered a live `Pick` button for a release that already
 * had a download -- indefinitely, until something touched the `media_item`
 * row or the component unmounted. The whole-branch review measured it: 0
 * listeners while collapsed, 1 gather after re-expanding. A test pinned
 * that as desirable ("reopening reused the cache instead of gathering
 * again") and no review had questioned the pin, which is why nothing
 * reddened.
 *
 * **The pin was wrong and the cache was right**, so only the pin changed
 * shape. Dropping the cache entry on disable would also have closed the
 * staleness, at the cost of a card that flashes empty every time it
 * reopens; re-gathering *behind* the cached value costs the same one
 * gather and shows the last known detail while it runs. A collapsed card
 * still costs nothing -- no gather, no subscription -- which is the
 * property the cache was added for. What it no longer does is answer for a
 * window it was not watching.
 *
 * The 3+N race below is unchanged and is a different thing: that one
 * resolves on the next wake, this one had no wake to resolve on.
 *
 * **`gatherMediaItem` is 3+N transactions, and cannot be made atomic** --
 * `store/rows.ts` does not accept a caller's transaction, and that is a
 * finding parked from an earlier slice's review, not something to fix here.
 * The consequence is real: a card can expand and show a release a moment
 * before that release's download row has arrived, because the release came
 * from one transaction (`byMediaItem`) and its downloads from a later one
 * (`byRssItem`) that a concurrent write can land between. This hook does not
 * hide that; the wrong answer is temporary and corrects itself on the next
 * wake. **The justification here used to be "it is a read-only screen, so
 * the wrong answer is not actionable", and this slice is what ended that
 * premise.** It has ended: `ReleaseList` has its per-release Pick button
 * (picks design §2), so a release whose download row has not been read yet
 * renders exactly like one nobody has picked, and is therefore pickable.
 * The two sentences that followed -- "it has not ended yet", and that the
 * refusal "does not exist in this tree either" -- were written a task
 * before both did, and stayed here after the button and `POST /api/picks`
 * landed. What happens to a second submission is still the host's answer
 * to give and not this hook's to claim: the refusal is
 * `already-submitted`, and the host now refuses it from a unique index on
 * the release rather than on the client a draw returned, so the window
 * this paragraph describes costs a refused click and never a duplicate
 * download.
 *
 * **What "self-correcting" means here.** This hook subscribes to the
 * gathered media item's own row (`table: 'media_item'`) for as long as it is
 * `enabled`, and a notification on that row triggers a fresh gather that
 * replaces the cached one. It does *not* subscribe to every release or
 * download the first gather found, because it has no way to name a row that
 * gather never saw in the first place.
 *
 * **The `new download` half of that is now covered, by the channel built for
 * rows with no id yet.** This paragraph used to end by saying a correction
 * depending on a new download's own row notifying "is only caught the next
 * time something touches the media item itself", and while that hook was
 * read-only it was merely a slow correction. It stopped being tolerable when
 * a pick became possible: `ReleaseList`'s button reads `Picking…` until the
 * `torrent_download` or `nzb_download` row arrives, and a wake that waits on
 * something else touching the media item is a button that wedges (picks
 * design §3, §7). So this hook also subscribes to **inserts** on those two
 * tables -- `store/notify.ts`'s `subscribeInserts`, which fires with the ids
 * a batch made newly visible, which is exactly what a row nobody could name
 * in advance needs.
 *
 * **Filtered to this item, because an insert subscription is table-wide.**
 * A `subscribeInserts('torrent_download', …)` wake carries ids and nothing
 * else, so this hook reads each inserted row and re-gathers only when its
 * `rssItemId` is one of the releases the cached gather holds. Without that,
 * one pick anywhere would re-gather on every mounted card on all three
 * browse screens.
 *
 * **The read is `getRows`, and the batched member is the whole point.** One
 * wake costs **one** IndexedDB transaction regardless of how many ids the
 * batch carried: `store/rows.ts`'s `getRows` opens `rowsStore(db)` once and
 * issues a keyed `get` per id on that one transaction, exactly as
 * `store/gather.ts` reads a cast's people. The first version of this hook
 * used `getRow` per id instead, which opens a transaction *per call*.
 * Measured through this hook against a real replica, with a four-id batch
 * naming a release this item does not hold -- so the filter read is the
 * only thing that runs: **4 transactions before, 1 after**. That cost is
 * paid per wake per expanded card, on a table-wide channel every open card
 * is subscribed to. Where the batch *does* match, the re-gather it triggers
 * costs 4 more either way (8 before, 5 after, same measurement), so the
 * saving is on the filter and not on the gather.
 *
 * The comment this replaces described the old cost as "a keyed lookup each,
 * against a gather that is 3+N transactions". True of the lookups, and
 * quietly wrong about what they cost: it compared them against the gather
 * rather than against the batched sibling `store/rows.ts` declares
 * immediately after `getRow` -- which is the comparison that would have
 * changed the code.
 *
 * **What it still does not subscribe to, and what that costs.** An
 * *update* to a row already gathered wakes nothing here: `store/apply.ts`
 * counts an upsert over a row that already carried a value as `touched`,
 * never `inserted` (`Changed`'s own doc), so a download's status and
 * percentage advancing from `queued` to `downloading` to done is not
 * something this hook notices -- the first pick is, the progress after it is
 * not. Nor is a new `rss_item`: a release arriving for an item already on
 * screen is still only caught the next time something touches the media item
 * itself, or the next time this hook gathers this id from cold. Neither is
 * the filter's doing; both are rows this hook does not watch at all. The
 * filter has one cost of its own: a download insert that lands before the
 * first gather resolves has no release set to be matched against and is
 * dropped, which is sound for the pick path -- a release must have been
 * gathered and rendered for anyone to press its button -- and is not a claim
 * about any other writer. That is the honest scope of "corrects on the next
 * notification": this screen does not poll, and outside the pick path it
 * does not guarantee a bound on when a race resolves.
 */
import { useEffect, useRef, useState } from 'react';
import type { Store } from '../store/index.ts';
import type { GatheredItem } from '../store/gather.ts';

/**
 * The four `Store` members this hook needs, and nothing else -- so a test
 * can hand it a bare stub instead of a whole `Store` (see this file's test
 * and `MediaItemCard.test.tsx`). A real `Store` satisfies this by structural
 * assignment.
 *
 * It was two until the download-insert subscription landed. `getRows` is the
 * second of the two it gained and is not obviously implied by the first:
 * `subscribeInserts`'s callback is handed ids and no table-parent
 * information, and a download row's `id` is its own, unrelated to the
 * `rssItemId` it belongs to (`TorrentDownloadSyncRead` carries both), so
 * nothing in the wake itself can say whether the row is this item's. Reading
 * the rows is what answers that.
 */
export interface GatheredSource {
  gatherMediaItem: Store['gatherMediaItem'];
  subscribe: Store['subscribe'];
  subscribeInserts: Store['subscribeInserts'];
  getRows: Store['getRows'];
}

/**
 * Whether `err` is IndexedDB's own complaint that the connection underneath
 * a request is already closed -- the same `InvalidStateError` shape
 * `shell/useCounts.ts`'s `isStoreClosed` checks, and for the same reason: a
 * card can still be mounted and subscribed when the store it reads from
 * stops (sign-out, a 401), and that race must not surface as an unhandled
 * rejection blamed on whichever test or request happens to be running then.
 * Anything else is rethrown.
 */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/**
 * The two tables a pick lands in -- the same two `store/gather.ts` reads a
 * release's downloads from, and the only two `ctx.downloads.submit` can
 * produce a row in.
 */
const DOWNLOAD_TABLES = ['torrent_download', 'nzb_download'] as const;

/**
 * The release a replica download row belongs to, or `undefined` when the
 * stored value does not carry one.
 *
 * A check rather than a cast, for the reason `store/gather.ts`'s predicates
 * give at length: a replica persists across client builds, so a row written
 * by one build is read against whatever the contract means by the next.
 * `rssItemId` is the only field this hook dereferences on a download row, so
 * it is the only one verified here -- an unreadable row is one this hook
 * declines to re-gather for, not a crash somewhere downstream.
 */
function releaseOf(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('rssItemId' in value)) return undefined;
  const rssItemId: unknown = value.rssItemId;
  return typeof rssItemId === 'number' ? rssItemId : undefined;
}

/**
 * Gathers media item `mediaItemId` through `source` only while `enabled` is
 * `true`, and caches the result for as long as this hook is mounted: a
 * second `enabled` transition back to `true` for the same id renders the
 * cached value immediately *and* gathers again behind it, so nothing that
 * landed while the card was collapsed stays unseen. A collapsed card
 * (`enabled === false`) costs nothing -- no gather, no subscription -- and
 * `undefined` is what it reads while collapsed, while still loading, or
 * when the replica holds no such item.
 *
 * **`tables` is a plugin's declared replica tables, threaded straight
 * through to `gatherMediaItem`** (`store/gather.ts`'s own doc on why that
 * costs no second query). The cache above stays keyed by `mediaItemId`
 * alone: a card's table list is fixed by its plugin and cannot vary for
 * one id, so it is not part of what makes a cache entry distinct.
 *
 * **Callers must pass a stable `tables` reference.** It sits in this
 * effect's dependency array below, so a fresh array literal built on every
 * render would be a new dependency every render, tearing down and
 * rebuilding both subscriptions each time. `BrowserPlugin.tables`
 * (`@pickarr/plugin-ui`) is a stable module-level value, so a real plugin
 * card already has one to pass; this hook does not memoise it itself, the
 * same way it does not memoise `source`.
 */
export function useGatheredItem(
  source: GatheredSource,
  mediaItemId: number,
  enabled: boolean,
  tables: readonly string[],
): GatheredItem | undefined {
  const [item, setItem] = useState<GatheredItem | undefined>(undefined);
  // A ref, not state: this cache must survive the `enabled` toggle that
  // remounts nothing, and reading it must never itself trigger a render.
  const cache = useRef(new Map<number, GatheredItem | undefined>());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    function apply(result: GatheredItem | undefined): void {
      cache.current.set(mediaItemId, result);
      if (!cancelled) setItem(result);
    }

    function safeGather(): void {
      source
        .gatherMediaItem(mediaItemId, tables)
        .then(apply)
        .catch((err: unknown) => {
          if (isStoreClosed(err)) return;
          throw err;
        });
    }

    // The cached value is shown at once *and* a fresh gather is started.
    // See this file's docblock: the cache is what this renders while the
    // gather runs, not the answer it settles for.
    if (cache.current.has(mediaItemId)) {
      setItem(cache.current.get(mediaItemId));
    }
    safeGather();

    /**
     * Re-gathers if any of `ids` is a download under one of this item's
     * releases. The release set is read off `cache` rather than off `item`
     * so this closure does not have to be rebuilt -- and the subscriptions
     * with it -- every time a gather lands.
     */
    async function regatherIfOurs(table: string, ids: readonly number[]): Promise<void> {
      const releases = cache.current.get(mediaItemId)?.releases ?? [];
      if (releases.length === 0) return;
      const ours = new Set(releases.map((release) => release.id));
      const values = await source.getRows(table, ids);
      if (cancelled) return;
      const mine = [...values.values()].some((value) => {
        const rssItemId = releaseOf(value);
        return rssItemId !== undefined && ours.has(rssItemId);
      });
      if (mine) safeGather();
    }

    function safeRegatherIfOurs(table: string): (ids: readonly number[]) => void {
      return (ids) => {
        regatherIfOurs(table, ids).catch((err: unknown) => {
          if (isStoreClosed(err)) return;
          throw err;
        });
      };
    }

    // Re-gathers on a notification for this item's own row, and on a
    // download inserted under one of its releases -- see this file's
    // docblock for exactly what those do and do not correct.
    const unsubscribe = source.subscribe('media_item', mediaItemId, safeGather);
    const unsubscribeInserts = DOWNLOAD_TABLES.map((table) =>
      source.subscribeInserts(table, safeRegatherIfOurs(table)),
    );
    return () => {
      cancelled = true;
      unsubscribe();
      for (const off of unsubscribeInserts) off();
    };
    // `tables` is in this list, not left out: see the docblock above for
    // why a caller must hand this hook a stable reference rather than a
    // fresh array literal.
  }, [source, mediaItemId, enabled, tables]);

  return enabled ? item : undefined;
}
