/**
 * A media item's gathered detail, fetched lazily and cached for the life of
 * the component that asked for it.
 *
 * **`gatherMediaItem` is 3+N transactions, and cannot be made atomic** --
 * `store/rows.ts` does not accept a caller's transaction, and that is a
 * finding parked from an earlier slice's review, not something to fix here.
 * The consequence is real: a card can expand and show a release a moment
 * before that release's download row has arrived, because the release came
 * from one transaction (`byMediaItem`) and its downloads from a later one
 * (`byRssItem`) that a concurrent write can land between. This hook does not
 * hide that -- it is a read-only screen, so the wrong answer is temporary
 * and self-correcting rather than actionable.
 *
 * **What "self-correcting" means here.** This hook subscribes to the
 * gathered media item's own row (`table: 'media_item'`) for as long as it is
 * `enabled`, and a notification on that row triggers a fresh gather that
 * replaces the cached one. It does *not* subscribe to every release or
 * download the first gather found, because it has no way to name a row that
 * gather never saw in the first place -- so a correction that depends on a
 * *new* download's own row notifying is only caught the next time something
 * touches the media item itself, or the next time this hook is asked to
 * gather this id again from cold. That is the honest scope of "corrects on
 * the next notification": this screen does not poll, and it does not
 * guarantee a bound on when a race resolves.
 */
import { useEffect, useRef, useState } from 'react';
import type { Store } from '../store/index.ts';
import type { GatheredItem } from '../store/gather.ts';

/**
 * The two `Store` members this hook needs, and nothing else -- so a test can
 * hand it a bare stub instead of a whole `Store` (see this file's test and
 * `MediaItemCard.test.tsx`). A real `Store` satisfies this by structural
 * assignment.
 */
export interface GatheredSource {
  gatherMediaItem: Store['gatherMediaItem'];
  subscribe: Store['subscribe'];
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
 * Gathers media item `mediaItemId` through `source` only while `enabled` is
 * `true`, and caches the result for as long as this hook is mounted: a
 * second `enabled` transition back to `true` for the same id reuses the
 * cached value rather than gathering again. A collapsed card (`enabled ===
 * false`) costs nothing -- no gather, no subscription -- and `undefined` is
 * what it reads while collapsed, while still loading, or when the replica
 * holds no such item.
 */
export function useGatheredItem(
  source: GatheredSource,
  mediaItemId: number,
  enabled: boolean,
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
        .gatherMediaItem(mediaItemId)
        .then(apply)
        .catch((err: unknown) => {
          if (isStoreClosed(err)) return;
          throw err;
        });
    }

    if (cache.current.has(mediaItemId)) {
      setItem(cache.current.get(mediaItemId));
    } else {
      safeGather();
    }

    // Re-gathers on a notification for this item's own row -- see this
    // file's docblock for exactly what that does and does not correct.
    const unsubscribe = source.subscribe('media_item', mediaItemId, safeGather);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source, mediaItemId, enabled]);

  return enabled ? item : undefined;
}
