import { useEffect, useRef, useState } from 'react';
import { api, type MetadataView } from './client.ts';

/**
 * How long to wait before the first poll, and the ceiling backoff grows
 * toward. Metadata is a background enhancement, not something the user is
 * staring at a spinner for, so this favours fewer requests over a snappy
 * first paint — unlike `useIdentityPreview`'s 200ms, which is answering a
 * keystroke.
 */
const START_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

/**
 * Both `/api/metadata/request` and `/api/metadata` cap at this many ids per
 * call (`MAX_PAGE_LIMIT` in `packages/core/src/http/server.ts`, mirrored here
 * because the web package does not import core). A page can outgrow it once
 * "Load more" has run a few times, so every call below chunks rather than
 * assuming the ids handed in fit in one request.
 */
const BATCH_LIMIT = 100;

function chunk(ids: readonly number[], size: number): number[][] {
  const batches: number[][] = [];
  for (let start = 0; start < ids.length; start += size) batches.push(ids.slice(start, start + size));
  return batches;
}

/**
 * The provider's answer for every id the caller is currently asking about,
 * kept live by polling while any of them is still `pending`.
 *
 * One request per render of the id list, not one per card: the caller (Browse,
 * for one page at a time) collects the ids it actually rendered and hands them
 * here as a single array, and this hook is the only thing that ever calls
 * `POST /api/metadata/request` — never a per-card effect, which is the
 * side-effecting-GET shape this feature was built to avoid.
 *
 * The dependency below is the ids' content (`key`), not the array's identity:
 * a caller that rebuilds the array every render (Browse does) would otherwise
 * re-ask on every render that changed nothing about which groups are on
 * screen — the same reasoning `useIdentityPreview` gives for keying off
 * `JSON.stringify(values)` instead of `values` itself.
 */
export function useGroupMetadata(groupIds: readonly number[]): Map<number, MetadataView> {
  // `metadataRef` mirrors `metadata` so the effect below can read the latest
  // known state without depending on it — depending on state that the effect
  // itself sets would either loop or need `key` alone to guard it, and the
  // ref is the simpler of the two.
  const metadataRef = useRef<Map<number, MetadataView>>(new Map());
  const [metadata, setMetadata] = useState<Map<number, MetadataView>>(metadataRef.current);
  // Ids already sent to `/api/metadata/request` in this hook's lifetime, so a
  // page that keeps some ids across renders while dropping or adding others
  // never re-asks the server to enqueue work it already asked for. The
  // enqueue is idempotent server-side regardless, so this is an optimization,
  // not a correctness requirement.
  const requestedRef = useRef<Set<number>>(new Set());

  const key = groupIds.join(',');

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    function commit(found: ReadonlyMap<number, MetadataView>): void {
      const next = new Map(metadataRef.current);
      for (const [id, view] of found) next.set(id, view);
      metadataRef.current = next;
      setMetadata(next);
    }

    async function fetchStates(ids: number[]): Promise<Map<number, MetadataView>> {
      const found = new Map<number, MetadataView>();
      for (const batch of chunk(ids, BATCH_LIMIT)) {
        const answer = await api.metadata(batch, controller.signal);
        for (const [idText, view] of Object.entries(answer)) found.set(Number(idText), view);
      }
      return found;
    }

    async function ensureRequested(ids: readonly number[]): Promise<void> {
      const unseen = ids.filter((id) => !requestedRef.current.has(id));
      for (const batch of chunk(unseen, BATCH_LIMIT)) {
        await api.requestMetadata(batch, controller.signal);
        for (const id of batch) requestedRef.current.add(id);
      }
    }

    async function poll(ids: number[], delay: number): Promise<void> {
      if (cancelled || ids.length === 0) return;
      let found: Map<number, MetadataView>;
      try {
        found = await fetchStates(ids);
      } catch {
        // Aborted on unmount, or a genuine network failure: either way there
        // is no channel for this hook to report through (its whole interface
        // is the map), and hammering a failing endpoint on a fixed backoff
        // would be worse than leaving the panel as "not shown yet".
        return;
      }
      if (cancelled) return;
      commit(found);
      const stillPending = ids.filter((id) => found.get(id)?.state === 'pending');
      if (stillPending.length === 0) return;
      const nextDelay = Math.min(delay * 2, MAX_DELAY_MS);
      timer = setTimeout(() => void poll(stillPending, nextDelay), delay);
    }

    async function run(): Promise<void> {
      // Only ids this hook has never resolved to a settled answer are worth
      // asking about again. An id already `confirmed` or `none` cannot
      // change, and re-fetching it on every unrelated change to the id list
      // (a new page landing, a picked card leaving) would turn "one request
      // per page" back into "one request per render".
      const unresolved = groupIds.filter((id) => {
        const known = metadataRef.current.get(id);
        return known === undefined || known.state === 'pending';
      });
      if (unresolved.length === 0) return;
      try {
        await ensureRequested(unresolved);
      } catch {
        return;
      }
      if (cancelled) return;
      await poll(unresolved, START_DELAY_MS);
    }

    void run();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // `key` stands in for `groupIds`; see the doc comment above.
  }, [key]);

  return metadata;
}
