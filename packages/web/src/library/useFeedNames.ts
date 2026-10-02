/**
 * `feedId -> { name, pluginId }`, for any screen that holds `rss_item` rows and wants to
 * say which feed produced one -- `library/Unmatched.tsx`, to start.
 *
 * **`subscribeTable`, not `subscribeInserts`.** A rename is an update, and
 * an inserts-only subscription does not see one -- the same gap that left
 * a removed feed on the settings screen until a reload
 * (`store/notify.ts`'s `subscribeTable` doc, and `settings/useFeeds.ts`'s
 * own account of hitting it in a real browser).
 *
 * **One page, not a paged window**, matching `useFeeds`'s own choice and
 * for the same reason: a feed is something a person configures by hand,
 * not something a plugin produces in bulk (`settings/useFeeds.ts`'s own
 * doc has the fuller argument; {@link FEEDS_LIMIT} mirrors its constant of
 * the same name).
 *
 * **Lists come from the replica only. There is no remote fallback**
 * (Global Constraint). This hook never calls `fetch`; `listByTable` and
 * `subscribeTable` are the whole of what it is built on.
 */
import { useEffect, useState } from 'react';
import type { Store } from '../store/index.ts';
import type { StoredRow } from '../store/db.ts';

const TABLE = 'rss_feed';

/** Matches `settings/useFeeds.ts`'s own limit -- see that file for why one page is enough. */
const FEEDS_LIMIT = 500;

/**
 * The two `Store` members this hook needs, narrower than `Store` itself so
 * a test can hand it a bare database's `listByTable` and `subscribeTable`
 * directly -- the same shape `settings/useFeeds.ts`'s own `FeedsSource`
 * takes, and for the same reason.
 */
export interface FeedNamesSource {
  listByTable: Store['listByTable'];
  subscribeTable: Store['subscribeTable'];
}

/** What the replica knows of one feed that a screen showing its releases needs: the label, and which plugin the feed belongs to (the Edit form searches that plugin's titles). */
export interface FeedIdentity {
  name: string;
  pluginId: string;
}

/**
 * The three fields this hook reads off a feed row -- `id`, `name` and
 * `pluginId`, and no more -- narrowed with `in` and `typeof` rather than a cast (Global
 * Constraint: never `as` a replica row). A replica outlives the build that
 * wrote it, so a row here may predate this code and carry neither field in
 * the shape expected.
 */
function feedIdentity(value: unknown): ({ id: number } & FeedIdentity) | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('id' in value) || !('name' in value) || !('pluginId' in value)) return undefined;
  const { id, name, pluginId } = value;
  return typeof id === 'number' && typeof name === 'string' && typeof pluginId === 'string'
    ? { id, name, pluginId }
    : undefined;
}

function toNames(rows: readonly StoredRow[]): ReadonlyMap<number, FeedIdentity> {
  const names = new Map<number, FeedIdentity>();
  for (const row of rows) {
    const feed = feedIdentity(row.value);
    if (feed !== undefined) names.set(feed.id, { name: feed.name, pluginId: feed.pluginId });
  }
  return names;
}

/**
 * Whether `err` is IndexedDB's own complaint that the connection underneath
 * a request is already closed, matching `settings/useFeeds.ts`'s own
 * `isStoreClosed` guard and for the same reason: this hook can still be
 * mounted and subscribed when the store it reads from stops (sign-out, a
 * 401). Anything else is rethrown.
 */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/**
 * `feedId -> { name, pluginId }`, kept current by `subscribeTable`.
 *
 * An id no feed claims is simply absent from the map, never mapped to an
 * empty string (Global Constraint: zero is an answer, and the id space
 * includes zero) -- `Map.get` answering `undefined` for a missing key is
 * exactly what `CardHeading`'s optional `trailing` prop wants: no trailing
 * label at all, a different thing from a feed named `''`.
 */
export function useFeedNames(source: FeedNamesSource): ReadonlyMap<number, FeedIdentity> {
  const [names, setNames] = useState<ReadonlyMap<number, FeedIdentity>>(new Map());

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      const rows = await source.listByTable(TABLE, { direction: 'prev', limit: FEEDS_LIMIT });
      if (cancelled) return;
      setNames(toNames(rows));
    }

    function safeRefresh(): void {
      refresh().catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      });
    }

    safeRefresh();
    const unsubscribe = source.subscribeTable(TABLE, safeRefresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);

  return names;
}
