import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type DownloadView, type ReleaseDownloadView, type ReleaseDownloadsResponse } from './client.ts';

/**
 * How often to re-ask about every watched group's downloads.
 *
 * Not `useGroupMetadata`'s escalating ladder. That ladder exists because
 * `nextAttemptAt` tells the client when the metadata worker itself has
 * promised to look again, and backs off when the server gives no such
 * promise to trust. A download's `status` advances only on the reconcile
 * loop's own tick, and that loop reports no schedule for a client to read —
 * there is no `next_at` here for a ladder to be built from, so this hook
 * asks on a flat interval instead. 3000ms is what `Downloads.tsx` (the
 * screen this feature removes) polled this same data at.
 */
export const POLL_MS = 3000;

/**
 * `/api/downloads/for-groups` caps at this many ids per call, mirroring
 * `MAX_PAGE_LIMIT` in `packages/core/src/http/server.ts` the same way
 * `useGroupMetadata`'s own `BATCH_LIMIT` does. Repeated here rather than
 * imported because the web package does not import core.
 */
const BATCH_LIMIT = 100;

function chunk(ids: readonly number[], size: number): number[][] {
  const batches: number[][] = [];
  for (let start = 0; start < ids.length; start += size) batches.push(ids.slice(start, start + size));
  return batches;
}

/** What `useGroupDownloads` hands back: the live answers, and a way to write one in early. */
export interface GroupDownloadsHandle {
  /** Group id → (release id → download). Empty until the first poll lands. */
  downloads: Map<number, Map<number, ReleaseDownloadView>>;
  /** Write a retry's response in immediately, without waiting for a poll. */
  patch(download: DownloadView): void;
}

/**
 * Nests one `/api/downloads/for-groups` answer's group keys and release keys
 * into the `Map<number, Map<number, ReleaseDownloadView>>` shape this hook
 * hands back — both key levels arrive as JSON object keys, i.e. strings, so
 * both are converted with `Number(...)` the same way `useGroupMetadata`
 * converts its one level.
 *
 * A group present in the answer with an empty object becomes a present,
 * empty inner `Map` rather than being dropped — preserving "asked, nothing
 * downloading" as distinct from "never asked", which is the guarantee
 * `/api/downloads/for-groups` itself makes and the whole reason a caller can
 * trust this map to decide what to keep watching.
 */
function nest(answer: ReleaseDownloadsResponse): Map<number, Map<number, ReleaseDownloadView>> {
  const found = new Map<number, Map<number, ReleaseDownloadView>>();
  for (const [groupText, releases] of Object.entries(answer)) {
    const releaseMap = new Map<number, ReleaseDownloadView>();
    for (const [releaseText, view] of Object.entries(releases)) releaseMap.set(Number(releaseText), view);
    found.set(Number(groupText), releaseMap);
  }
  return found;
}

/**
 * The provider's answer for every group id currently watched, kept live by
 * polling on a flat `POLL_MS` interval for as long as `watched` is non-empty.
 *
 * `watched` is the caller's bounded list — deciding which groups still hold a
 * non-terminal download is the caller's job (see `GroupDownloadsHandle`'s own
 * doc), not this hook's. This hook only ever asks about exactly that list, in
 * batches of `BATCH_LIMIT`, and replaces its whole map with what comes back:
 * a group the caller has stopped watching is one this hook stops answering
 * for too, on the next successful poll.
 *
 * Unlike `useGroupMetadata`, there is no `requestedRef` and no give-up
 * deadline. Both exist there because an answer to a metadata request may
 * never arrive (the provider has nothing, or the worker has not reached the
 * row yet) — but every watched group here already has a download row, and
 * the poll is simply re-reading a column on it that changes over time. There
 * is nothing to give up waiting for.
 */
export function useGroupDownloads(watched: readonly number[]): GroupDownloadsHandle {
  // `downloadsRef` mirrors `downloads` so `patch` can read and rebuild from
  // the latest known map without depending on `downloads` itself — the same
  // reasoning `useGroupMetadata`'s `metadataRef` documents.
  const downloadsRef = useRef<Map<number, Map<number, ReleaseDownloadView>>>(new Map());
  const [downloads, setDownloads] = useState<Map<number, Map<number, ReleaseDownloadView>>>(
    downloadsRef.current,
  );

  const key = watched.join(',');

  useEffect(() => {
    if (watched.length === 0) return;

    let cancelled = false;
    const controller = new AbortController();

    async function poll(): Promise<void> {
      let found: Map<number, Map<number, ReleaseDownloadView>>;
      try {
        // One request per chunk, run concurrently rather than awaited one at a
        // time in a loop: the chunks are independent, and nothing about the
        // order they land in matters, since `found` is assembled from all of
        // them before anything is committed.
        const answers = await Promise.all(
          chunk(watched, BATCH_LIMIT).map((batch) => api.releaseDownloads(batch, controller.signal)),
        );
        found = new Map<number, Map<number, ReleaseDownloadView>>();
        for (const answer of answers) for (const [id, releases] of nest(answer)) found.set(id, releases);
      } catch {
        // Aborted on unmount, or a genuine network failure: either way there
        // is no channel for this hook to report through (its whole interface
        // is the map), so the last-known map is left standing rather than
        // blanked.
        return;
      }
      if (cancelled) return;
      downloadsRef.current = found;
      setDownloads(found);
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
    // `key` stands in for `watched`'s content, the same way `useGroupMetadata`
    // keys its own effect off `groupIds.join(',')` rather than the array's
    // identity — a caller that rebuilds `watched` every render must not
    // restart this poll on a render that changed nothing about which groups
    // are being watched. `watched` itself is read from this closure, not
    // listed as a dependency, for the same reason.
  }, [key]);

  const patch = useCallback((download: DownloadView): void => {
    const next = new Map(downloadsRef.current);
    const releases = new Map(next.get(download.groupId) ?? new Map<number, ReleaseDownloadView>());
    releases.set(download.releaseId, {
      downloadId: download.id,
      status: download.status,
      error: download.error,
      absentSince: download.absentSince,
    });
    next.set(download.groupId, releases);
    downloadsRef.current = next;
    setDownloads(next);
  }, []);

  return { downloads, patch };
}
