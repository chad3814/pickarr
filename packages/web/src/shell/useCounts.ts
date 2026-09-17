/**
 * The shell's whole relationship with the replica: one count per category,
 * read through `listByTable` and kept current by `subscribeInserts` (design
 * spec §6). This is `by_table_updated`'s first reader -- the storage slice's
 * whole-branch review flagged that index as having none, and this hook is the
 * answer rather than a coincidence.
 *
 * **Counts come from the replica only. There is no remote fallback**
 * (Global Constraint; storage design spec §9). A media item table with
 * nothing synced yet reads as zero, and this hook never reaches for `fetch`
 * to find out otherwise -- the one screen that proves offline capability must
 * not be the screen that quietly hides its own absence.
 *
 * A category is `media_item.pluginId` (`'tv' | 'movie' | 'xxx'`), not a
 * table of its own: `by_table_updated` has one entry per table, not per
 * plugin, so three counts come from one read of `media_item` split by its own
 * `pluginId` field, rather than three separate table reads.
 */
import { useEffect, useState } from 'react';
import type { Store } from '../store/index.ts';

export type Category = 'tv' | 'movie' | 'xxx';

/** The three tabs the shell has (design spec §6). Order is display order. */
export const CATEGORIES: readonly Category[] = ['tv', 'movie', 'xxx'];

export type Counts = Readonly<Record<Category, number>>;

const ZERO_COUNTS: Counts = { tv: 0, movie: 0, xxx: 0 };

/**
 * The two reads this hook needs, and nothing else `Store` offers. Narrower
 * than `Store` itself so a test can hand it a bare database's `listByTable`
 * and `subscribeInserts` directly, without assembling a whole `Store` around
 * them (see `useCounts.test.tsx`). A real `Store` satisfies this by
 * structural assignment, so `Shell` passes one through unchanged.
 */
export interface CountsSource {
  listByTable: Store['listByTable'];
  subscribeInserts: Store['subscribeInserts'];
}

/**
 * `value.pluginId` if it names one of the three categories, else `undefined`
 * -- a media item belonging to a plugin the shell has no tab for (or a value
 * that is not even an object, which a malformed row cannot be per
 * `applyBatch`'s own guards, but this hook does not get to assume that of
 * every row it is ever handed) is silently left out of every count rather
 * than crashing the shell over it.
 */
function categoryOf(value: unknown): Category | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('pluginId' in value)) return undefined;
  const { pluginId } = value;
  return pluginId === 'tv' || pluginId === 'movie' || pluginId === 'xxx' ? pluginId : undefined;
}

/**
 * Whether `err` is IndexedDB's own complaint that the connection underneath
 * a request is already closed -- `DOMException`'s `name`, `'InvalidStateError'`
 * (measured directly: `store/index.ts`'s `stop()` closing `db` mid-read
 * produces exactly this). Narrow on purpose (task 6's fix round,
 * review-found): an earlier version of `safeRefresh` below caught *any*
 * rejection, which is what let a stray `fetch()` call inside `refresh`
 * (this hook's own "no network fallback" Global Constraint, violated) pass
 * silently -- the catch could not tell "the store I was reading from closed
 * out from under me" from "something else entirely went wrong". Checked
 * without a cast, the same way `categoryOf` above checks `value`.
 */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/**
 * Large enough to cover every media item a real install will ever hold, and a
 * literal rather than `Infinity`: `listByTable`'s cursor walk stops once
 * `results.length >= limit`, and `Infinity >= Infinity` is `false` in
 * JavaScript, so `Infinity` here would never stop the walk at all.
 */
const ALL_ROWS = Number.MAX_SAFE_INTEGER;

/**
 * Reads every `media_item` the replica holds and tallies it into three
 * buckets by `pluginId`. Re-reads the whole table on every
 * `subscribeInserts('media_item', …)` wake, rather than adjusting the
 * previous count incrementally -- `listByTable` is the only surface this hook
 * is built on, and a whole re-read is what keeps a tombstone's exclusion
 * (already enforced by the index itself, per `rows.ts`) automatic rather than
 * something this hook has to reason about a second time.
 *
 * `undefined` means "no store yet" -- `Shell` has none until `createStore`
 * resolves -- and reads as {@link ZERO_COUNTS}, the same reading an empty
 * replica gets. Zero is the honest answer to both.
 */
export function useCounts(store: CountsSource | undefined): Counts {
  const [counts, setCounts] = useState<Counts>(ZERO_COUNTS);

  useEffect(() => {
    if (store === undefined) {
      setCounts(ZERO_COUNTS);
      return;
    }
    // Captured in a `const` so the closures below keep the narrowing:
    // TypeScript does not carry a parameter's narrowed type into a nested
    // function, since that function could in principle run after the
    // parameter's binding changed -- even though this one, an effect
    // parameter, never does.
    const source = store;
    let cancelled = false;

    async function refresh(): Promise<void> {
      const rows = await source.listByTable('media_item', { direction: 'next', limit: ALL_ROWS });
      if (cancelled) return;
      const next = { tv: 0, movie: 0, xxx: 0 };
      for (const row of rows) {
        const category = categoryOf(row.value);
        if (category !== undefined) next[category] += 1;
      }
      setCounts(next);
    }

    /**
     * A store-closed rejection is caught rather than left to reject into
     * nothing. `Shell` owns this store's lifetime and can close it
     * (sign-out, or a 401) while this effect is still mounted --
     * `store/index.ts`'s own `stop()` doc says a read afterwards is refused
     * because the connection is gone, and that is exactly the shape a
     * still-mounted subscriber can race. An uncaught rejection here would
     * not merely warn: under `node --test` it is attributed to whichever
     * test happens to be running, corrupting an unrelated result -- the same
     * failure mode `store/notify.ts`'s own subscriber-error handling exists
     * to avoid.
     *
     * **Anything else is rethrown, deliberately.** Swallowing every
     * rejection here -- the previous version of this function -- hid a
     * genuine failure exactly as well as it hid a benign one, and "genuine
     * failure" includes the one this hook's whole existence is built to
     * refuse: a network call. Letting an unrecognised error surface is what
     * keeps that refusal honest.
     */
    function safeRefresh(): void {
      refresh().catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      });
    }

    safeRefresh();
    const unsubscribe = source.subscribeInserts('media_item', safeRefresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store]);

  return counts;
}
