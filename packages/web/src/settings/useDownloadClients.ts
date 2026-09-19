/**
 * The download clients section's whole relationship with the replica: every
 * configured client, kept current by `subscribeInserts` -- `useFeeds.ts`'s
 * sibling, built the same way and on the same two store operations (design
 * spec §6).
 *
 * **A separate hook from `useFeeds`, not a parameter on it.** The two read
 * different tables into different shapes and neither needs to know the
 * other ran; keeping them apart is what lets `settings/Settings.tsx` render
 * one section from a table this replica has already filled while the other
 * is still reading (`Settings.test.tsx` drives exactly that). A shared hook
 * would make one list's first read a precondition for the other's.
 *
 * **One page, not a paged window** -- `useFeeds.ts`'s own reasoning, and it
 * applies harder here: a download client is something an operator
 * configures once per machine, so {@link DOWNLOAD_CLIENTS_LIMIT} is far
 * past any plausible install. If that ever stops holding, this is the one
 * place to grow, following `library/Unmatched.tsx`'s multi-page walk.
 *
 * **Lists come from the replica only. There is no remote fallback**
 * (Global Constraint). This hook never calls `fetch`; `listByTable` and
 * `subscribeInserts` are the whole of what it is built on. `listByTable`
 * can answer for `download_client` at all because `store/rows.ts`'s
 * `TABLES_WITH_UPDATED_AT` admits it -- that set's own doc has the
 * measurement.
 */
import { useEffect, useState } from 'react';
import type { DownloadClientSyncRead } from '@pickarr/contract';
import type { Store } from '../store/index.ts';
import type { StoredRow } from '../store/db.ts';

const TABLE = 'download_client';

/** A single-page limit far past any plausible install -- see this file's docblock on why one page is enough. */
const DOWNLOAD_CLIENTS_LIMIT = 500;

/**
 * The two `Store` members this hook needs, and nothing else -- narrower
 * than `Store` itself so a test can hand it a bare database's `listByTable`
 * and `subscribeInserts` directly, exactly as `FeedsSource` does.  A real
 * `Store` satisfies this by structural assignment.
 */
export interface DownloadClientsSource {
  listByTable: Store['listByTable'];
  subscribeInserts: Store['subscribeInserts'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The six fields this section dereferences -- `id` (the React key), `name`,
 * `implementation`, `url`, `username` and `category` -- and no more,
 * matching `store/gather.ts`'s predicates' rule of checking exactly what a
 * module reads off a row. `type`, `createdAt` and `updatedAt` are on the
 * wire shape and are not checked here, because nothing on this screen reads
 * them: verifying a field no renderer touches would only reject rows over
 * something nobody would have noticed.
 *
 * A check rather than a cast, for the reason `store/gather.ts`'s own
 * docblock records at length: a replica persists across client builds, and
 * neither `SCHEMA_VERSION` nor the generation token fires when a *wire
 * shape* changes. A cast makes that a blank line on screen or a crash
 * downstream; a check makes it a row this list declines.
 *
 * `username` is `string | null` on the wire and both are accepted here --
 * `null` is the answer for a client that authenticates with an api key, not
 * a missing value.
 */
function isDownloadClient(value: unknown): value is DownloadClientSyncRead {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.name === 'string' &&
    typeof value.implementation === 'string' &&
    typeof value.url === 'string' &&
    typeof value.category === 'string' &&
    (typeof value.username === 'string' || value.username === null)
  );
}

function toClients(rows: readonly StoredRow[]): readonly DownloadClientSyncRead[] {
  const result: DownloadClientSyncRead[] = [];
  for (const row of rows) {
    if (isDownloadClient(row.value)) result.push(row.value);
  }
  return result;
}

/**
 * Whether `err` is IndexedDB's own complaint that the connection underneath
 * a request is already closed -- the same `InvalidStateError` shape
 * `useFeeds.ts`, `shell/useCounts.ts` and `library/useMediaItems.ts` each
 * guard, and for the same reason: this screen can still be mounted and
 * subscribed when the store it reads from stops (sign-out, a 401). Anything
 * else is rethrown.
 */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/**
 * Every configured download client, newest first, re-read whenever one is
 * added or revived. `undefined` until the first read resolves -- distinct
 * from an empty array, which means "loaded, and there are none" (Global
 * Constraint: zero is an answer, and the two must not render the same way).
 */
export function useDownloadClients(source: DownloadClientsSource): readonly DownloadClientSyncRead[] | undefined {
  const [clients, setClients] = useState<readonly DownloadClientSyncRead[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      const rows = await source.listByTable(TABLE, { direction: 'prev', limit: DOWNLOAD_CLIENTS_LIMIT });
      if (cancelled) return;
      setClients(toClients(rows));
    }

    function safeRefresh(): void {
      refresh().catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      });
    }

    safeRefresh();
    const unsubscribe = source.subscribeInserts(TABLE, safeRefresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);

  return clients;
}
