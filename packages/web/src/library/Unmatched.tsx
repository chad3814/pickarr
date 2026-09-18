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
 * **What "reactive" means here, and its edge.** This screen's `source` is
 * `{ listByTable, subscribeInserts }`, not a full `Store`, so
 * `subscribeInserts('rss_item', ...)` is the only wake-up channel it has.
 * That fires only when a row becomes newly visible at a key that held
 * nothing before -- a fresh release arriving, or a tombstone revived
 * (`store/apply.ts`: "a revive is still new data appearing at that key") --
 * and it does **not** fire for a plain field update to a row this screen
 * already holds. That is exactly the shape a live lookup match takes on the
 * wire: `sync/tail.ts`'s `tailSince` never emits `create`, only `upsert` for
 * a row's *current* state, and `store/apply.ts` counts an `upsert` over a
 * row that already carried a value as "touched", never "inserted" -- the
 * same distinction `Changed`'s own doc draws. So a release that gets matched
 * while nothing else changes on `rss_item` stays visible here until some
 * *other* qualifying event on the table wakes this screen to re-read --
 * at which point the read is a fresh `listByTable` call straight from
 * IndexedDB, and reflects every row's true current state, matched one
 * included. The same honestly-scoped gap `useGatheredItem.ts` documents for
 * its own row, reached by a different route.
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { RssItemSyncRead } from '@pickarr/contract';
import type { Store } from '../store/index.ts';

/**
 * The two `Store` members this screen needs, and nothing else -- so a test
 * can hand it a bare database's `listByTable` and `subscribeInserts`
 * directly, the way `useCounts.test.tsx`'s `sourceFor` does. A real `Store`
 * satisfies this by structural assignment.
 */
export interface UnmatchedSource {
  listByTable: Store['listByTable'];
  subscribeInserts: Store['subscribeInserts'];
}

export interface UnmatchedProps {
  source: UnmatchedSource;
}

/**
 * The raw page size this screen reads `rss_item` in, before filtering.
 *
 * `useMediaItems.ts` (task 5, landing in parallel) exports its own
 * `PAGE_SIZE = 24` for the category screens' paging, and the two constants
 * are meant to be the same number -- reconcile them into one export once
 * both exist. Defined locally here rather than importing one that may not
 * exist yet in this worktree.
 */
const PAGE_SIZE = 24;

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

export function Unmatched({ source }: UnmatchedProps): ReactElement {
  // `undefined` means "still loading" -- distinct from an empty array, which
  // means "loaded, and there is nothing" (Global Constraint: zero is an
  // answer, and the two must not render the same way).
  const [rows, setRows] = useState<readonly UnmatchedRow[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    function safeRefresh(): void {
      readUnmatched(source)
        .then((next) => {
          if (!cancelled) setRows(next);
        })
        .catch((err: unknown) => {
          if (isStoreClosed(err)) return;
          throw err;
        });
    }

    safeRefresh();
    const unsubscribe = source.subscribeInserts('rss_item', safeRefresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source]);

  return (
    <section aria-labelledby="unmatched-heading">
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
