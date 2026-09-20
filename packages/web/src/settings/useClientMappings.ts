/**
 * One download client's path mappings, kept current from the replica --
 * `useDownloadClients.ts`'s sibling, and built on the same two store
 * operations plus one more that neither settings hook has needed before
 * (design spec §5, §8).
 *
 * **Three subscriptions, not one, and the third is what this slice
 * forced.** The two settings lists before this one only ever gained rows,
 * so `subscribeInserts` was the whole of their relationship with change.
 * This is the first list with an **edit** and a **delete** in it
 * (design spec §3), and `store/apply.ts` counts an upsert over a row that
 * already carried a value as `touched`, never `inserted` (`Changed`'s own
 * doc) -- so neither an edit nor a removal wakes the insert channel at
 * all. Both do wake `subscribe(table, id)`, which fires on every change to
 * one key, a delete included. So this hook watches the table for arrivals
 * and each listed row for whatever happens to it.
 *
 * **Which means the subscription set depends on the answer, and the effect
 * re-runs when it changes.** {@link watchKeyOf} turns the listed ids into
 * a string so React compares the dependency by value rather than by array
 * identity; the effect parses it back, so the rows subscribed to are
 * exactly the rows the dependency was computed from and the two cannot
 * drift. A read whose ids are unchanged leaves the key unchanged and the
 * effect alone, so this settles after one extra read per change to the
 * *set* of mappings and none at all per change to their contents.
 *
 * **Not gated on the row being expanded, where `library/MediaItemCard.tsx`
 * gates its gather.** That gate exists because `gatherMediaItem` is 3+N
 * transactions per card across a paged list of media items, and its own
 * file documents at length the staleness the gate then cost: a collapsed
 * card notices nothing, so re-expanding could show a release whose
 * download had already arrived. This read is one cursor walk of a settings
 * table with a handful of rows in it, once per configured download client,
 * so the saving is not worth buying the same staleness class back.
 *
 * **What that costs, written down rather than left to be rediscovered: N
 * mounted clients means N whole-table walks per change.** Every hook reads
 * the *whole* `filepath_mapping` table and filters to its own client in
 * {@link toMappings} -- there is no per-client index, and `by_table_updated`
 * has no `download_client_id` component to give one. `subscribeInserts` is
 * table-wide, so one mapping added anywhere wakes every mounted hook, and
 * each of them re-walks every row. `DownloadClients` renders one
 * `ClientMappings` per configured client and each calls this hook
 * unconditionally -- the expander gates what is *rendered*, not the read --
 * so the work is quadratic in the install: C clients holding M
 * mappings between them costs C × M rows read per write. It is accepted at
 * the scale design spec §8 argues for -- an operator writes one mapping per
 * mount point they have, so both C and M are single digits and the walk is
 * a handful of rows out of an IndexedDB index. Anything that made either
 * number large (a sync that rewrote the table row by row, say) would want a
 * per-client index in `store/db.ts` rather than a change here.
 *
 * **Lists come from the replica only. There is no remote fallback**
 * (Global Constraint). This hook never calls `fetch`; `listByTable`,
 * `subscribe` and `subscribeInserts` are the whole of what it is built on,
 * and a write through `postMapping.ts` is not told about it. `listByTable`
 * can answer for `filepath_mapping` at all because `store/rows.ts`'s
 * `TABLES_WITH_UPDATED_AT` admits it -- that set's own doc has the
 * measurement, and this hook is the caller it was admitted for.
 */
import { useEffect, useState } from 'react';
import type { FilepathMappingSyncRead } from '@pickarr/contract';
import type { Store } from '../store/index.ts';
import type { StoredRow } from '../store/db.ts';

const TABLE = 'filepath_mapping';

/**
 * A single-page limit far past any plausible install, on
 * `useDownloadClients.ts`'s reasoning: this is every mapping across every
 * download client, and an operator writes one per mount point they have.
 */
const MAPPINGS_LIMIT = 500;

/**
 * The three `Store` members this hook needs, and nothing else -- narrower
 * than `Store` itself so a test can hand it a bare database's operations
 * directly, exactly as `DownloadClientsSource` does. A real `Store`
 * satisfies this by structural assignment.
 */
export interface ClientMappingsSource {
  listByTable: Store['listByTable'];
  subscribe: Store['subscribe'];
  subscribeInserts: Store['subscribeInserts'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The four fields this screen dereferences -- `id` (the React key and the
 * edit and remove target), `downloadClientId` (the filter), `fromPath` and
 * `toPath` -- and no more, matching `store/gather.ts`'s predicates' rule of
 * checking exactly what a module reads off a row. `createdAt` and
 * `updatedAt` are on the wire shape and are not checked here, because
 * nothing on this screen reads them: verifying a field no renderer touches
 * would only reject rows over something nobody would have noticed.
 *
 * A check rather than a cast, for the reason `store/gather.ts`'s own
 * docblock records at length: a replica persists across client builds, and
 * neither `SCHEMA_VERSION` nor the generation token fires when a *wire
 * shape* changes. A cast makes that a blank line on screen or a crash
 * downstream; a check makes it a row this list declines.
 *
 * **Neither path is inspected beyond being a string.** Design spec §7: a
 * `from_path` may be `D:\Downloads`, so there is nothing here that could
 * be validated without being stricter than `clients/paths.ts`, which
 * refuses `node:path` for exactly that reason. The empty string is not
 * rejected either -- the host refuses one at the write, and a row already
 * in the replica is a row that got past that.
 */
function isMapping(value: unknown): value is FilepathMappingSyncRead {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.downloadClientId === 'number' &&
    typeof value.fromPath === 'string' &&
    typeof value.toPath === 'string'
  );
}

/**
 * This client's mappings, ordered by `id` -- which is the order they were
 * added in, and **not** the order `by_table_updated` walked them in.
 *
 * The index is keyed on `updatedAt`, so editing a mapping moves it to one
 * end of that walk: the row an operator just corrected jumps away from
 * where they were looking, on a screen whose whole job is to let them fix
 * a typo. Nothing depends on the order otherwise -- `mapClientPath`
 * resolves by longest prefix, so display order is not something an
 * operator controls or should (design spec §10) -- which is exactly why it
 * may as well be the one that holds still.
 *
 * **This sort is pinned, and for a while it was not.** A whole-branch
 * review measured the gap: with the list's only order test being a
 * single-row one, deleting this `.toSorted` left **214/214 web tests
 * green** and reversing it left **214/214 green** too, so the argued
 * behaviour above had no guard of any kind and the hook's own exported
 * docblock described the opposite of it. `test/settings/useClientMappings.test.tsx`'s
 * `editing a mapping does not move it: the list is ordered by id, not by
 * the index walk` seeds two rows whose `updatedAt` order is the reverse of
 * their `id` order, then edits the one at the top of the list and asserts
 * it is still there. Both mutants were re-run against it: deleting
 * `.toSorted` is **1 red of 215**, reversing it is **1 red of 215**, and
 * in both cases the red one is that test.
 */
function toMappings(rows: readonly StoredRow[], downloadClientId: number): readonly FilepathMappingSyncRead[] {
  const result: FilepathMappingSyncRead[] = [];
  for (const row of rows) {
    if (isMapping(row.value) && row.value.downloadClientId === downloadClientId) result.push(row.value);
  }
  return result.toSorted((left, right) => left.id - right.id);
}

/**
 * The listed ids as one dependency value. A space-joined string of
 * integers: `useEffect` compares dependencies with `Object.is`, so a fresh
 * array of the same ids would re-run the effect on every read and tear
 * down every subscription with it.
 */
function watchKeyOf(mappings: readonly FilepathMappingSyncRead[] | undefined): string {
  return (mappings ?? []).map((mapping) => mapping.id).join(' ');
}

/** {@link watchKeyOf} read back. `''` is no ids rather than one empty one, which is why the empty case is separate. */
function watchedIds(watchKey: string): readonly number[] {
  return watchKey === '' ? [] : watchKey.split(' ').map(Number);
}

/**
 * Whether `err` is IndexedDB's own complaint that the connection underneath
 * a request is already closed -- the same `InvalidStateError` shape
 * `useDownloadClients.ts`, `useFeeds.ts`, `shell/useCounts.ts` and
 * `library/useMediaItems.ts` each guard, and for the same reason: this
 * screen can still be mounted and subscribed when the store it reads from
 * stops (sign-out, a 401). Anything else is rethrown.
 */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/**
 * Every mapping belonging to `downloadClientId`, ordered by `id` --
 * {@link toMappings} owns that order and argues it -- re-read whenever one
 * is added, edited or removed. `undefined` until the first read resolves -- distinct from an
 * empty array, which means "loaded, and this client has none" (Global
 * Constraint: zero is an answer, and the two must not render the same
 * way).
 */
export function useClientMappings(
  source: ClientMappingsSource,
  downloadClientId: number,
): readonly FilepathMappingSyncRead[] | undefined {
  const [mappings, setMappings] = useState<readonly FilepathMappingSyncRead[] | undefined>(undefined);
  const watchKey = watchKeyOf(mappings);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      const rows = await source.listByTable(TABLE, { direction: 'next', limit: MAPPINGS_LIMIT });
      if (cancelled) return;
      setMappings(toMappings(rows, downloadClientId));
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
  }, [source, downloadClientId, watchKey]);

  return mappings;
}
