/**
 * The Activities page's host-side data: `GET /api/activity`, refetched on
 * mount, whenever the host's `activity` event reaches this tab
 * (`Store.subscribeActivity`), and every {@link ACTIVITY_POLL_MS} as a
 * safety net for an event this tab missed (a stream that is down, a tab
 * that was asleep).
 *
 * **A refetch, not a patch.** The event carries nothing, and the answer is
 * small, so a wake replaces the whole read.
 *
 * **At most one fetch is in flight, and a wake during one is remembered, not
 * dropped.** A burst of host events (each outbound request fires three, each
 * job run two) would otherwise send one request per event, and an older slow
 * response could land after a newer one and overwrite it. A wake that arrives
 * while a fetch is open sets a `dirty` flag; when that fetch settles, a set
 * flag is cleared and exactly one more fetch is issued, so any number of
 * wakes during one fetch cost one more, and responses apply in the order
 * they were asked for. A failed refetch (offline, a
 * non-200, or a body that is not an `ActivityRead`) after a good read keeps
 * that read and flags `unreachable` rather than blanking the page: an
 * operator watching a stalled queue should not lose it because one request
 * dropped. A failure before any read has nothing to keep and is the
 * `unreachable` phase instead, so the page says so rather than staying on
 * `loading`; the next good read moves either to `ready`.
 */
import { useEffect, useRef, useState } from 'react';
import type { ActivityHost, ActivityJob, ActivityRead, ActivityRequest } from '@pickarr/contract';
import type { Store } from '../store/index.ts';
import type { SendJsonResult } from '../auth/sendJson.ts';

export const ACTIVITY_POLL_MS = 30_000;

export type ActivityState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'unreachable' }
  | { readonly phase: 'ready'; readonly read: ActivityRead; readonly unreachable: boolean };

export interface ActivitySource {
  subscribeActivity: Store['subscribeActivity'];
}

export type ActivityFetch = () => Promise<SendJsonResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is readonly T[] {
  return Array.isArray(value) && value.every(guard);
}

function isJob(value: unknown): value is ActivityJob {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.pluginId === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.attempts === 'number' &&
    typeof value.maxAttempts === 'number' &&
    typeof value.runAt === 'number' &&
    isNumberOrNull(value.startedAt) &&
    typeof value.updatedAt === 'number' &&
    isStringOrNull(value.lastError)
  );
}

function isRequest(value: unknown): value is ActivityRequest {
  return isRecord(value) && typeof value.method === 'string' && typeof value.target === 'string';
}

function isHost(value: unknown): value is ActivityHost {
  return (
    isRecord(value) &&
    typeof value.hostname === 'string' &&
    typeof value.limit === 'number' &&
    isArrayOf(value.inFlight, isRequest) &&
    isArrayOf(value.waiting, isRequest)
  );
}

/** Checks every field the page reads, so a host of another version shows as unreachable rather than crashing a render. */
function isActivityRead(value: unknown): value is ActivityRead {
  if (!isRecord(value) || !isRecord(value.jobs)) return false;
  const { running, waiting, dead, recent } = value.jobs;
  return (
    isArrayOf(running, isJob) &&
    isArrayOf(waiting, isJob) &&
    isArrayOf(dead, isJob) &&
    isArrayOf(recent, isJob) &&
    isArrayOf(value.fetches, isHost)
  );
}

export function useActivity(
  source: ActivitySource,
  fetchActivity: ActivityFetch,
  onExpired: () => void,
  intervalMs?: number,
): ActivityState {
  const [state, setState] = useState<ActivityState>({ phase: 'loading' });
  // The latest callbacks, read at call time. A caller passes `onExpired` as an
  // inline arrow (`Shell.tsx`), a new function every render; listing it in the
  // effect's dependencies would tear down and rebuild the subscription and the
  // interval, and refetch, on every render.
  const latest = useRef({ fetchActivity, onExpired });
  useEffect(() => {
    latest.current = { fetchActivity, onExpired };
  });

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let dirty = false;

    async function refetch(): Promise<void> {
      const result = await latest.current.fetchActivity();
      if (cancelled) return;
      if (result.outcome === 'expired') {
        latest.current.onExpired();
        return;
      }
      if (result.outcome === 'answered' && result.status === 200 && isActivityRead(result.body)) {
        setState({ phase: 'ready', read: result.body, unreachable: false });
        return;
      }
      setState((prev) => (prev.phase === 'ready' ? { ...prev, unreachable: true } : { phase: 'unreachable' }));
    }

    async function drain(): Promise<void> {
      try {
        do {
          dirty = false;
          await refetch();
        } while (dirty && !cancelled);
      } finally {
        inFlight = false;
      }
    }

    function run(): void {
      if (inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      void drain();
    }

    run();
    const off = source.subscribeActivity(run);
    const handle = setInterval(run, intervalMs ?? ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      off();
      clearInterval(handle);
    };
  }, [source, intervalMs]);

  return state;
}
