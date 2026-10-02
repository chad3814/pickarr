/**
 * The shell's whole relationship with the replica: one count per category,
 * read through `countByPlugin` and kept current by `subscribeTouched`
 * (design spec §6). `countByPlugin` counts the `by_table_plugin_updated`
 * index -- `IDBIndex.count()` over a key range scoped to one `pluginId` --
 * so this hook never reads a row to produce a number, only one index
 * count per registered plugin.
 *
 * **Counts come from the replica only. There is no remote fallback**
 * (Global Constraint; storage design spec §9). A media item table with
 * nothing synced yet reads as zero, and this hook never reaches for `fetch`
 * to find out otherwise -- the one screen that proves offline capability must
 * not be the screen that quietly hides its own absence.
 *
 * A category is `media_item.pluginId`, not a table of its own:
 * `by_table_plugin_updated` has one entry per *row*, keyed
 * `[table, pluginId, updatedAt, id]`, so `(table, pluginId)` is a key prefix
 * naming a contiguous range rather than a single entry. The counts are
 * therefore one range count against that index per `pluginId` -- rather than
 * one read of `media_item` split in memory by its own `pluginId` field.
 */
import { useEffect, useState } from 'react';
import type { Store } from '../store/index.ts';
import { BROWSER_PLUGINS } from '../plugins/registry.ts';

/**
 * One tab per registered plugin (design spec §6). Order is display order,
 * which is `BROWSER_PLUGINS`' order.
 *
 * **Derived, not written down.** This was a literal list of three ids until
 * the registry existed; a fourth plugin then meant editing this line, the
 * nav, the route table and the label map, and forgetting any one of them
 * was silent. `plugins/registry.ts` is now the only place a plugin is
 * named, and `test/plugins/registry.test.ts` fails if an id reappears
 * anywhere else under `src/`.
 *
 * A module-level constant, not a value recomputed per render:
 * `settings/AddFeed.tsx` puts it in a `<select>`'s option list and this
 * hook's effect walks it on every wake.
 */
export const CATEGORIES: readonly string[] = BROWSER_PLUGINS.map((plugin) => plugin.id);

/** One count per {@link CATEGORIES} entry, keyed by plugin id. */
export type Counts = Readonly<Record<string, number>>;

/**
 * Zero for every registered category, reduced from {@link CATEGORIES}
 * rather than written out: a literal here would be a second list of plugin
 * ids, which is the thing the registry exists to stop.
 */
const ZERO_COUNTS: Counts = CATEGORIES.reduce<Record<string, number>>((counts, category) => {
  counts[category] = 0;
  return counts;
}, {});

/**
 * The two operations this hook needs, and nothing else `Store` offers.
 * Narrower than `Store` itself so a test can hand it a bare database's
 * `countByPlugin` and `subscribeTouched` directly, without assembling a
 * whole `Store` around them (see `useCounts.test.tsx`). A real `Store`
 * satisfies this by structural assignment, so `Shell` passes one through
 * unchanged.
 */
export interface CountsSource {
  countByPlugin: Store['countByPlugin'];
  subscribeTouched: Store['subscribeTouched'];
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
 * without a cast, the same way a narrowing guard would check any other
 * `unknown` value.
 */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/**
 * One index count per category, kept current by re-counting on
 * every `subscribeTouched('media_item', …)` wake -- an insert, an update or a
 * delete -- rather than adjusting the
 * previous counts incrementally. `countByPlugin` is an `IDBIndex.count()`
 * over a key range -- it reads no rows -- so a full re-count on each wake
 * costs nothing worth optimising away. A re-count runs on every touch,
 * including a delete: a tombstone is reported under `touched` and never
 * under `inserted`, so an insert-only subscription would leave the count of
 * a dropped item standing until reload. The index itself excludes the
 * tombstone (per `rows.ts`), so the re-count lowers the number.
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
      const counted = await Promise.all(
        CATEGORIES.map(async (category) => [category, await source.countByPlugin('media_item', category)] as const),
      );
      if (cancelled) return;
      const next = { ...ZERO_COUNTS };
      for (const [category, count] of counted) next[category] = count;
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
    const unsubscribe = source.subscribeTouched('media_item', safeRefresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [store]);

  return counts;
}
