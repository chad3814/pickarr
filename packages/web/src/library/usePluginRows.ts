/**
 * A page's plugin rows, fetched once as a single batched read rather than
 * once per card (design spec §4, §5; acceptance 1).
 *
 * **Why this exists separately from `useGatheredItem`.** That hook -- and
 * `store/gather.ts`'s `gatherMediaItem` underneath it -- only runs while a
 * card is `enabled`, which `library/MediaItemCard.tsx` ties to whether the
 * plugin's card reports itself expanded. A collapsed card still needs its plugin's
 * rows (a TV row reads the series and episode even before anyone clicks
 * it), so a per-card fetch gated on expansion cannot serve it: an earlier
 * version of `gatherMediaItem` returned `pluginRows` for exactly this
 * reason and was reverted, because it could only ever answer for an
 * expanded card. This hook answers for every card on the page at once,
 * before any of them expand.
 *
 * **One transaction for the whole page, not one per card.**
 * `store/rows.ts`'s `pluginRowsByMediaItems` opens a single transaction and
 * issues one `getAll` per id on it, the same batching `getRows` already
 * does for one table across many ids -- see that function's own doc for
 * the measured transaction count.
 */
import { useEffect, useState } from 'react';
import type { PluginRows } from '@pickarr/plugin-ui';
import type { Store } from '../store/index.ts';

/** The one `Store` member this hook needs, narrower than `Store` itself so a test can bind it to a bare database directly. */
export interface PluginRowsSource {
  pluginRowsByMediaItems: Store['pluginRowsByMediaItems'];
}

/**
 * The answer for a plugin that declared no tables at all
 * (`BrowserPlugin.tables: []`), which two of the three shipped plugins do
 * -- so this is what two of the three browse screens hand every card on
 * every render.
 *
 * One shared frozen value, not a fresh `{}` each time: `{} !== {}`, and a
 * card is free to put `rows` in a dependency array. None of the three does
 * today, but `CardProps` is a public seam and `onExpandedChange` is
 * memoised for exactly that reason. A per-card-per-render literal would
 * defeat any memoisation a plugin applied, on the two screens where there
 * is provably nothing to fetch. Frozen because it is shared: a card that
 * wrote to it would be writing to every other card's rows.
 */
const NO_PLUGIN_ROWS: PluginRows = Object.freeze({});

/**
 * Every table `tables` names, each an empty array -- what a card reads for
 * an id the last batch has not answered for yet (still loading, or not on
 * the current page), and what it reads for an id the replica genuinely
 * holds no rows for. Both are the same answer, deliberately: `PluginRows`'
 * own doc says a caller never has to tell "no rows" from "not fetched"
 * apart, and this is the one place that promise is kept before the first
 * batch lands.
 *
 * **Returns {@link NO_PLUGIN_ROWS} for an empty `tables`, and a frozen
 * object otherwise.** Callers must still hold the result stable across
 * renders themselves -- `library/Category.tsx` memoises it on `tables` --
 * because this cannot cache a result keyed on an array it is handed.
 */
export function emptyPluginRows(tables: readonly string[]): PluginRows {
  if (tables.length === 0) return NO_PLUGIN_ROWS;
  const rows: Record<string, readonly unknown[]> = {};
  for (const table of tables) rows[table] = [];
  return Object.freeze(rows);
}

/**
 * Whether `err` is IndexedDB's own complaint that the connection underneath
 * a request is already closed -- the same `InvalidStateError` shape
 * `useGatheredItem.ts`, `useMediaItems.ts` and `shell/useCounts.ts` each
 * check, and for the same reason: a list can still be mounted and fetching
 * when the store it reads from stops (sign-out, a 401). Anything else is
 * rethrown.
 */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/**
 * `mediaItemIds`' plugin rows, re-fetched in one batched read whenever
 * `mediaItemIds` or `tables` changes. Answers `new Map()` -- read by a
 * caller through {@link emptyPluginRows}, never directly -- while
 * `mediaItemIds` or `tables` is empty, or before the first batch has
 * resolved.
 *
 * **Callers must pass stable `mediaItemIds` and `tables` references.**
 * Both sit in this effect's dependency array, so a fresh array literal on
 * either would refetch on every render for reasons that have nothing to do
 * with either changing -- `library/Category.tsx`'s own call site memoises
 * `mediaItemIds` off `items` for exactly this reason, and a plugin's
 * `tables` (`@pickarr/plugin-ui`'s `BrowserPlugin.tables`) is a stable
 * module-level value that `shell/Shell.tsx` passes straight through from
 * `plugins/registry.ts` rather than copying.
 */
export function usePluginRows(
  source: PluginRowsSource,
  mediaItemIds: readonly number[],
  tables: readonly string[],
): ReadonlyMap<number, PluginRows> {
  const [rows, setRows] = useState<ReadonlyMap<number, PluginRows>>(new Map());

  useEffect(() => {
    if (mediaItemIds.length === 0 || tables.length === 0) {
      setRows(new Map());
      return;
    }
    let cancelled = false;
    source
      .pluginRowsByMediaItems(mediaItemIds, tables)
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      });
    return () => {
      cancelled = true;
    };
  }, [source, mediaItemIds, tables]);

  return rows;
}
