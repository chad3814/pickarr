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
 *
 * **It subscribes to inserts on each declared table, because replication
 * does not promise to deliver a plugin row in the same batch as its media
 * item.** The host writes both atomically -- each lookup plugin's own
 * `apply.ts` does -- and that is not the guarantee that matters:
 * `/api/sync` is a
 * `sync_log` walk applied to the replica in batches, and
 * `@pickarr/contract`'s `TvSeasonRead` doc states outright that ordering is
 * not preserved across it -- a client can hold a season whose `seriesId`
 * names a series it has not received yet, with the referent arriving
 * "elsewhere in the same walk". So a `tv_release` can reach the replica in
 * a later batch than its own `media_item`.
 *
 * Until this hook subscribed, that case was **permanent**: the effect below
 * is keyed on `[source, mediaItemIds, tables]`, a plugin row arriving for an
 * id already on screen changes none of the three, and this screen does not
 * poll -- so the card rendered `item.title` and nothing ever woke it. The
 * headline appeared on the next remount or reload and not before. The state
 * where it is most likely is mid-backfill, which for 2.0 is the *normal
 * first-run condition* (greenfield database, rebuilt from feeds), so the
 * most likely time to meet a plugin's card was the one time it silently did
 * not work.
 *
 * **Inserts are the right channel.** `store/apply.ts`'s `Changed` doc:
 * `inserted` means "became visible to a reader", so it covers a row
 * arriving for the first time *and* an upsert reviving a tombstone, and
 * excludes an upsert over a row that already carried a value (that is
 * `touched`). A plugin row landing late is the first case.
 *
 * **Filtered to this page, because an insert subscription is table-wide.**
 * A `subscribeInserts('tv_release', …)` wake carries ids and nothing else,
 * so this hook reads the inserted rows and refetches only when one names a
 * media item in `mediaItemIds`. Without the filter, one insert anywhere
 * would refetch the page for every mounted browse screen. `getRows` is the
 * batched member, so the filter costs **one** transaction per wake however
 * many ids the batch carried -- the identical trade `useGatheredItem`'s own
 * `regatherIfOurs` measured at 4 transactions before and 1 after, and the
 * reason a per-id `getRow` must not come back here.
 *
 * **What the subscription costs: one listener per declared table per
 * mounted screen.** Not per card -- this hook runs once in
 * `library/Category.tsx`, above the list, which is the same reason the
 * *read* is one batched query rather than one per card. Two of the three
 * shipped plugins declare no tables at all, which costs zero listeners --
 * the effect returns before it subscribes -- and the third declares one, so
 * a browse screen holds at most one. `useGatheredItem`'s channel is the one
 * that scales with cards, and task 6's fix round is where that was
 * measured.
 *
 * **What it still does not wake for.** An *update* to a plugin row already
 * on screen -- a corrected episode number, say -- is `touched` rather than
 * `inserted` and is not noticed; nor is a row in a table whose read shape
 * carries no `mediaItemId` at all, since the filter has nothing to match
 * and `pluginRowsByMediaItems` reads through `by_media_item` and would not
 * return it either. Neither has a caller today: all three shipped plugins
 * declare either no tables or `tv_release` alone, whose rows are written
 * once per media item and carry `mediaItemId`. Both are stated rather than
 * guarded so a plugin declaring something else knows what it is getting.
 */
import { useEffect, useState } from 'react';
import type { PluginRows } from '@pickarr/plugin-ui';
import type { Store } from '../store/index.ts';

/**
 * The three `Store` members this hook needs, narrower than `Store` itself so
 * a test can bind it to a bare database directly.
 *
 * It was one until the insert subscription landed, and the two it gained are
 * not obviously implied by the first: `subscribeInserts`' callback is handed
 * ids and no parent information, and a plugin row's `id` is its own,
 * unrelated to the `mediaItemId` it belongs to. Reading the rows is what
 * answers whether a wake is this page's. Exactly the pair -- and exactly the
 * reasoning -- `useGatheredItem.ts`'s `GatheredSource` states for the same
 * channel.
 */
export interface PluginRowsSource {
  pluginRowsByMediaItems: Store['pluginRowsByMediaItems'];
  subscribeInserts: Store['subscribeInserts'];
  getRows: Store['getRows'];
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
 * The media item a replica plugin row belongs to, or `undefined` when the
 * stored value does not name one.
 *
 * A check rather than a cast, the same restraint `store/gather.ts`'s
 * predicates and `useGatheredItem.ts`'s `releaseOf` take: a replica persists
 * across client builds, so a row written by one build is read against
 * whatever the contract means by the next. `mediaItemId` is the only field
 * this hook dereferences on a plugin row -- every other field belongs to the
 * plugin's own card -- so it is the only one verified here. A row this
 * cannot read is one the filter declines, not a crash downstream.
 */
function mediaItemOf(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || !('mediaItemId' in value)) return undefined;
  const mediaItemId: unknown = value.mediaItemId;
  return typeof mediaItemId === 'number' ? mediaItemId : undefined;
}

/**
 * `mediaItemIds`' plugin rows, re-fetched in one batched read whenever
 * `mediaItemIds` or `tables` changes, **and whenever a row is inserted into
 * one of `tables` under an id this page holds** (see this module's doc for
 * why that second trigger exists and what it costs). Answers `new Map()` --
 * read by a caller through {@link emptyPluginRows}, never directly -- while
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
    // Built once per effect run rather than per wake: `mediaItemIds` is this
    // effect's own dependency, so it cannot change underneath a subscription
    // this effect installed.
    const ours = new Set(mediaItemIds);

    function safeFetch(): void {
      source
        .pluginRowsByMediaItems(mediaItemIds, tables)
        .then((result) => {
          if (!cancelled) setRows(result);
        })
        .catch((err: unknown) => {
          if (isStoreClosed(err)) return;
          throw err;
        });
    }

    safeFetch();

    /** Refetches the page if any of `ids` is a row under one of this page's media items. */
    async function refetchIfOurs(table: string, ids: readonly number[]): Promise<void> {
      const values = await source.getRows(table, ids);
      if (cancelled) return;
      const mine = [...values.values()].some((value) => {
        const mediaItemId = mediaItemOf(value);
        return mediaItemId !== undefined && ours.has(mediaItemId);
      });
      if (mine) safeFetch();
    }

    function safeRefetchIfOurs(table: string): (ids: readonly number[]) => void {
      return (ids) => {
        refetchIfOurs(table, ids).catch((err: unknown) => {
          if (isStoreClosed(err)) return;
          throw err;
        });
      };
    }

    const unsubscribes = tables.map((table) => source.subscribeInserts(table, safeRefetchIfOurs(table)));
    return () => {
      cancelled = true;
      // Every one of them, on unmount and on any dependency change. Task 6's
      // fix round removed a latch that leaked three subscriptions per opened
      // card; closing a staleness by adding a subscription is how that comes
      // back, so `usePluginRows.test.tsx` counts these down to zero directly
      // rather than inferring it from a refetch that stopped happening.
      for (const off of unsubscribes) off();
    };
  }, [source, mediaItemIds, tables]);

  return rows;
}
