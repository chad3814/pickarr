/**
 * `/unmatched`: releases a feed delivered that no lookup has attached to a
 * media item yet -- `rss_item` rows whose `mediaItemId` is `null` (design
 * spec §4, acceptance item 3). A category screen's own `pluginId`-keyed
 * index (`by_table_plugin_updated`) cannot show these, because `rss_item`
 * projects `feedId` and no `pluginId` at all and therefore never enters that
 * index -- task 1's own note on why it is self-filtering. This screen reads
 * `rss_item` in modification order through `Store['listByTable']` instead
 * (`by_table_updated`), the same index `useCounts.ts` and the category
 * screens page against, and does the "`mediaItemId` is null" filtering
 * itself, in memory, over each raw page that index hands back.
 *
 * **There is no index on "`mediaItemId` is null", and that is a deliberate
 * choice, not an oversight** (design spec §3.1 weighs the same three options
 * for the category screens; this is the fourth case the same reasoning
 * applies to). Adding one would be a third schema bump -- another full
 * client resync, `SCHEMA_VERSION`'s own cost -- to speed up a screen that
 * should normally hold *few* rows: most releases get matched quickly, so the
 * unmatched set is the short tail, not the common case. Filtering
 * client-side over `by_table_updated`'s existing keyset, `PAGE_SIZE` (24)
 * raw rows at a time, costs an occasional page read that turns up nothing
 * and buys back a migration nobody needs.
 *
 * **Two wake-up channels, for two different shapes of change.**
 * `subscribeInserts('rss_item', ...)` fires only when a row becomes newly
 * visible at a key that held nothing before -- a fresh release arriving, or
 * a tombstone revived (`store/apply.ts`: "a revive is still new data
 * appearing at that key") -- and it does **not** fire for a plain field
 * update to a row this screen already holds a value for. That is exactly
 * the shape a live lookup match takes on the wire: `sync/tail.ts`'s
 * `tailSince` never emits `create`, only `upsert` for a row's *current*
 * state, and `store/apply.ts` counts an `upsert` over a row that already
 * carried a value as "touched", never "inserted" -- the same distinction
 * `Changed`'s own doc draws. **This was a real gap in an earlier version of
 * this screen**, found and proven (both by tracing `apply.ts`/`notify.ts`
 * and by an empirical repro) during task 7's review: a matched release
 * could sit on this screen indefinitely with nothing to wake a re-read.
 *
 * The fix is `source.subscribe(table, id, cb)` -- `store/notify.ts`'s
 * per-row channel, which fires on *any* change to `['table', id]`, touched
 * or inserted alike -- subscribed to every id currently on screen, the same
 * mechanism `useGatheredItem.ts` uses for a single media item's own row,
 * applied here to a whole visible list rather than one item. Each time the
 * filtered result changes, the previous page's row subscriptions are torn
 * down and a fresh set is put up for the new page, so a row that drops off
 * (matched) or a row that was never watched (page not yet read) is never
 * silently missed or double-subscribed.
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { RssItemSyncRead } from '@pickarr/contract';
import type { Store } from '../store/index.ts';
import { PAGE_SIZE } from './useMediaItems.ts';

/**
 * The three `Store` members this screen needs, and nothing else -- so a
 * test can hand it a bare database's `listByTable`, `subscribeInserts` and
 * `subscribe` directly, the way `useCounts.test.tsx`'s `sourceFor` does. A
 * real `Store` satisfies this by structural assignment.
 */
export interface UnmatchedSource {
  listByTable: Store['listByTable'];
  subscribeInserts: Store['subscribeInserts'];
  subscribe: Store['subscribe'];
}

export interface UnmatchedProps {
  source: UnmatchedSource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether `value` is shaped enough like `RssItemSyncRead` for this screen to
 * read `filename` and `mediaItemId` off it. Checks exactly those two fields
 * -- the ones this module dereferences -- and no more (`store/gather.ts`'s
 * own predicates set this precedent: "each predicate checks the fields this
 * module itself dereferences, and no more"). `mediaItemId` is checked
 * against its own nullable type rather than narrowed to `number`, since
 * `null` is the value this whole screen exists to find.
 */
function isRssItem(value: unknown): value is RssItemSyncRead {
  return (
    isRecord(value) &&
    typeof value.filename === 'string' &&
    (value.mediaItemId === null || typeof value.mediaItemId === 'number')
  );
}

/**
 * The `updatedAt` `by_table_updated` sorted `row` by. Every row `listByTable`
 * can return necessarily has a numeric `value.updatedAt` -- that index's own
 * key path is `['table', 'value.updatedAt', 'id']`, and IndexedDB omits any
 * record whose key path does not resolve, so a row missing it could never
 * have been returned in the first place (`store/db.ts`'s doc on
 * `by_table_updated`). Thrown rather than defaulted if that invariant is
 * ever violated: a bad cursor would silently corrupt this screen's paging,
 * which is worse than failing loudly.
 */
function updatedAtOf(row: { value?: unknown }): number {
  if (isRecord(row.value) && typeof row.value.updatedAt === 'number') return row.value.updatedAt;
  throw new Error('a row from by_table_updated has no numeric value.updatedAt, which the index should not allow');
}

/** Whether `err` is IndexedDB's own complaint that the connection underneath a request is already closed -- the same `InvalidStateError` shape `shell/useCounts.ts`'s and `useGatheredItem.ts`'s own `isStoreClosed` check, and for the same reason: this screen can still be mounted and subscribed when the store it reads from stops (sign-out, a 401). Anything else is rethrown. */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

interface UnmatchedRow {
  readonly id: number;
  readonly filename: string;
}

/**
 * Walks `rss_item` newest-first through `source.listByTable`, keeping only
 * the rows whose `mediaItemId` is `null`, until either enough have been
 * collected for one screen or the table is exhausted. See this file's
 * docblock for why the filter lives here instead of in an index.
 */
async function readUnmatched(source: UnmatchedSource): Promise<readonly UnmatchedRow[]> {
  const collected: UnmatchedRow[] = [];
  let from: { updatedAt: number; id: number } | undefined;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous page's last row, so the walk is inherently sequential
    const page = await source.listByTable('rss_item', {
      ...(from !== undefined ? { from } : {}),
      direction: 'prev',
      limit: PAGE_SIZE,
    });

    for (const row of page) {
      if (isRssItem(row.value) && row.value.mediaItemId === null) {
        collected.push({ id: row.id, filename: row.value.filename });
      }
    }

    if (page.length < PAGE_SIZE) break; // the table's earliest row was reached
    if (collected.length >= PAGE_SIZE) break; // enough for one screen

    const last = page[page.length - 1];
    // `page.length === PAGE_SIZE` here (neither break fired), so `page` is
    // non-empty and `last` is defined.
    if (last === undefined) break;
    from = { updatedAt: updatedAtOf(last), id: last.id };
  }

  return collected;
}

/**
 * Builds a `safeRefresh` closure: re-reads `source` and applies the result
 * through `apply`, unless the effect that owns it has since been cancelled.
 * A store-closed rejection is swallowed (the same race `useCounts.ts`'s and
 * `useGatheredItem.ts`'s own `isStoreClosed` guards this screen can hit --
 * `Unmatched` can still be mounted and subscribed when the store it reads
 * from stops, sign-out or a 401); anything else is rethrown. Shared by both
 * of `Unmatched`'s effects below rather than written out twice, so the two
 * wake-up channels cannot drift into reading the replica two different ways.
 */
function makeSafeRefresh(
  source: UnmatchedSource,
  apply: (rows: readonly UnmatchedRow[]) => void,
  isCancelled: () => boolean,
): () => void {
  return () => {
    readUnmatched(source)
      .then((next) => {
        if (!isCancelled()) apply(next);
      })
      .catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      });
  };
}

export function Unmatched({ source }: UnmatchedProps): ReactElement {
  // `undefined` means "still loading" -- distinct from an empty array, which
  // means "loaded, and there is nothing" (Global Constraint: zero is an
  // answer, and the two must not render the same way).
  const [rows, setRows] = useState<readonly UnmatchedRow[] | undefined>(undefined);

  // Wakes on a fresh or revived `rss_item` row -- see this file's docblock
  // for exactly which changes this channel does and does not see. Runs for
  // the whole life of this component; `source` is fixed for that lifetime,
  // matching every other screen's own `[store]`-only effect.
  useEffect(() => {
    let cancelled = false;
    const safeRefresh = makeSafeRefresh(source, setRows, () => cancelled);

    safeRefresh();
    const unsubscribe = source.subscribeInserts('rss_item', safeRefresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);

  // Wakes on a plain update to any release *currently listed here* -- the
  // one shape `subscribeInserts` cannot see (this file's docblock). Torn
  // down and rebuilt whenever `rows` changes, so the subscribed set always
  // matches what is actually on screen: a row that just dropped off is not
  // still watched, and a row that just appeared is watched from the moment
  // it does.
  useEffect(() => {
    if (rows === undefined) return undefined;
    let cancelled = false;
    const safeRefresh = makeSafeRefresh(source, setRows, () => cancelled);

    const unsubscribes = rows.map((row) => source.subscribe('rss_item', row.id, safeRefresh));
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [source, rows]);

  return (
    <section aria-labelledby="unmatched-heading" data-testid="unmatched">
      <h1 id="unmatched-heading">Unmatched</h1>
      {rows !== undefined &&
        (rows.length === 0 ? (
          <p>Everything has been matched.</p>
        ) : (
          <ul aria-label="unmatched releases">
            {rows.map((row) => (
              <li key={row.id}>{row.filename}</li>
            ))}
          </ul>
        ))}
    </section>
  );
}
