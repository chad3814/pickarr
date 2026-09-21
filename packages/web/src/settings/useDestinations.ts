/**
 * Every plugin destination the replica holds, kept current --
 * `useClientMappings.ts`'s sibling, built on the same three store
 * operations and for the same reason (design spec §3).
 *
 * **Three subscriptions, not one, and the third is not optional here.**
 * `PUT /api/destinations/:pluginId` is an **upsert**: a plugin either has a
 * destination or it does not, so the second and every later save over one
 * plugin writes a row that already exists. `store/apply.ts` counts an
 * upsert over a row that already carried a value as `touched`, never
 * `inserted` (`Changed`'s own doc), so the insert channel wakes for the
 * *first* save of each plugin and never again. `subscribe(table, id)` fires
 * on every change to one key, which is what makes an edited root appear.
 *
 * **Which means the subscription set depends on the answer, and the effect
 * re-runs when it changes.** {@link watchKeyOf} turns the listed ids into a
 * string so React compares the dependency by value rather than by array
 * identity; the effect parses it back, so the rows subscribed to are
 * exactly the rows the dependency was computed from and the two cannot
 * drift. This is `useClientMappings.ts`'s arrangement unchanged, and its
 * docblock has the reasoning at length.
 *
 * **No per-plugin filter, where `useClientMappings` has a per-client one.**
 * A destination table holds at most one row per registered plugin -- three
 * of them on this install -- so there is nothing to page and nothing to
 * narrow. `Destinations.tsx` indexes the answer by `pluginId` and renders a
 * row for every plugin it was told about, including the ones with no row
 * here yet, which is the state a fresh install is in: migration 20 creates
 * the table empty and nothing seeds it.
 *
 * **Lists come from the replica only. There is no remote fallback**
 * (Global Constraint). This hook never calls `fetch`, and a write through
 * `postDestination.ts` is not told about it -- a saved row appears here
 * when the replica says so, not when the `PUT` resolves. `listByTable` can
 * answer for `plugin_destination` because `store/rows.ts`'s
 * `TABLES_WITH_UPDATED_AT` admits it; this hook is the caller it was
 * admitted for.
 */
import { useEffect, useState } from 'react';
import type { PluginDestinationSyncRead } from '@pickarr/contract';
import type { Store } from '../store/index.ts';
import type { StoredRow } from '../store/db.ts';

const TABLE = 'plugin_destination';

/**
 * A single-page limit far past any plausible install: the table's grain is
 * one row per registered plugin, and this host registers three.
 * `useClientMappings.ts` uses the same figure for a table that can hold
 * genuinely many more.
 */
const DESTINATIONS_LIMIT = 500;

/**
 * The three `Store` members this hook needs, and nothing else -- narrower
 * than `Store` itself so a test can hand it a bare database's operations
 * directly, exactly as `ClientMappingsSource` does. A real `Store`
 * satisfies this by structural assignment.
 */
export interface DestinationsSource {
  listByTable: Store['listByTable'];
  subscribe: Store['subscribe'];
  subscribeInserts: Store['subscribeInserts'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The five fields this screen dereferences -- `id` (the React key and the
 * sort), `pluginId` (what the row is matched to its plugin by), and the
 * three values the form edits -- and no more, matching `store/gather.ts`'s
 * predicates' rule of checking exactly what a module reads off a row.
 * `createdAt` and `updatedAt` are on the wire shape and are not checked
 * here, because nothing on this screen reads them.
 *
 * A check rather than a cast, for the reason `store/gather.ts`'s own
 * docblock records at length: a replica persists across client builds, and
 * neither `SCHEMA_VERSION` nor the generation token fires when a *wire
 * shape* changes. A cast makes that a blank field on screen or a crash
 * downstream; a check makes it a row this list declines.
 *
 * **Nothing here is inspected beyond being a string.** The host checked all
 * three on save -- absolute root, declared tokens, a non-escaping unmatched
 * directory -- and a row already in the replica is a row that got past
 * that. A second, weaker copy of those rules here could only disagree with
 * the one that matters.
 */
function isDestination(value: unknown): value is PluginDestinationSyncRead {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.pluginId === 'string' &&
    typeof value.root === 'string' &&
    typeof value.shape === 'string' &&
    typeof value.unmatchedDir === 'string'
  );
}

/**
 * The destinations, ordered by `id` -- which is the order they were first
 * saved in, and **not** the order `by_table_updated` walked them in.
 *
 * The index is keyed on `updatedAt`, so saving one plugin's destination
 * would move its row to one end of that walk. Nothing on this screen reads
 * the order -- `Destinations.tsx` looks each row up by `pluginId` and takes
 * its display order from the plugin list it was handed -- but an order that
 * holds still is the one worth answering, because a hook whose output
 * reshuffles on every write is a trap for the next caller rather than for
 * this one. Pinned by `useDestinations.test.tsx`'s `destinations are listed
 * by id, not in the order the updated-at index walked them`.
 */
function toDestinations(rows: readonly StoredRow[]): readonly PluginDestinationSyncRead[] {
  const result: PluginDestinationSyncRead[] = [];
  for (const row of rows) {
    if (isDestination(row.value)) result.push(row.value);
  }
  return result.toSorted((left, right) => left.id - right.id);
}

/**
 * The listed ids as one dependency value. A space-joined string of
 * integers: `useEffect` compares dependencies with `Object.is`, so a fresh
 * array of the same ids would re-run the effect on every read and tear down
 * every subscription with it.
 */
function watchKeyOf(destinations: readonly PluginDestinationSyncRead[] | undefined): string {
  return (destinations ?? []).map((destination) => destination.id).join(' ');
}

/** {@link watchKeyOf} read back. `''` is no ids rather than one empty one, which is why the empty case is separate. */
function watchedIds(watchKey: string): readonly number[] {
  return watchKey === '' ? [] : watchKey.split(' ').map(Number);
}

/**
 * Whether `err` is IndexedDB's own complaint that the connection underneath
 * a request is already closed -- the same `InvalidStateError` shape
 * `useClientMappings.ts`, `useDownloadClients.ts`, `useFeeds.ts`,
 * `shell/useCounts.ts` and `library/useMediaItems.ts` each guard, and for
 * the same reason: this screen can still be mounted and subscribed when the
 * store it reads from stops (sign-out, a 401). Anything else is rethrown.
 */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/**
 * Every plugin destination in the replica, ordered by `id`, re-read
 * whenever one is saved. `undefined` until the first read resolves --
 * distinct from an empty array, which means "loaded, and no plugin has a
 * destination yet" and is what a fresh install answers (Global Constraint:
 * zero is an answer, and the two must not render the same way).
 */
export function useDestinations(
  source: DestinationsSource,
): readonly PluginDestinationSyncRead[] | undefined {
  const [destinations, setDestinations] = useState<readonly PluginDestinationSyncRead[] | undefined>(undefined);
  const watchKey = watchKeyOf(destinations);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      const rows = await source.listByTable(TABLE, { direction: 'next', limit: DESTINATIONS_LIMIT });
      if (cancelled) return;
      setDestinations(toDestinations(rows));
    }

    function safeRefresh(): void {
      refresh().catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      });
    }

    safeRefresh();
    const unsubscribes = [
      source.subscribeInserts(TABLE, safeRefresh),
      ...watchedIds(watchKey).map((id) => source.subscribe(TABLE, id, safeRefresh)),
    ];
    return () => {
      cancelled = true;
      for (const off of unsubscribes) off();
    };
  }, [source, watchKey]);

  return destinations;
}
