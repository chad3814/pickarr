import type { DatabaseSync } from 'node:sqlite';

/**
 * How many of the newest media items the pivot aims to leave above itself,
 * shared out across the categories a library actually holds.
 *
 * A target, not a bound: `bootstrapCursors` below only has to get the floor
 * roughly right, because the pivot is a *pivot* and not a horizon. Nothing is
 * cut off on either side of it.
 *
 * 40 because a media item's group weighs four to six rows -- the item, its
 * releases, what was submitted for them -- so 40 items is roughly one
 * `PAGE_SIZE` tail page (`api/cursor.ts`, 200). That makes the client's first
 * tail response cover about the set the pivot was chosen to put above it,
 * while its first backfill response is already walking below. Both cursors do
 * useful work from their first request, which is the reason to choose a floor
 * part-way down the log rather than the top of it.
 *
 * **"Roughly" is doing real work in that sentence, in two directions.** The
 * offset is `targetItems / categories`, and the pivot is the *oldest*
 * candidate, so the set above it is about `offset` items of the category that
 * produced the floor plus everything newer in the others -- somewhere between
 * `offset` and `targetItems` items, not `targetItems` exactly. And a category
 * that does not reach the offset contributes no candidate at all
 * (`pivotFor`'s ruling), so on a library where only one of two categories
 * qualifies the set above the pivot is nearer 20 items than 40. Measured on
 * the asymmetric library in `test/sync/bootstrap.test.ts`, scaled to the
 * shipped 40: 5 old movies beside 1000 newer tv items gives 21 rows to the
 * first tail response and 984 to the walk.
 *
 * What it must not be is *wildly* out, and it was: with the old step-1
 * fallback the same library gave `{since: 0, before: 1}` -- 1005 rows to the
 * tail and none to the walk, 25x this number and the design's degenerate
 * case. `pivotFor` has that measurement and the ruling that closed it.
 */
export const BOOTSTRAP_ITEMS = 40;

/**
 * The cursor pair an empty client starts with: one `sync_log.id` each way.
 *
 * **The value between them is a pivot.** The tail walks up from it
 * (`id > since`) and the walk walks down from it (`id < before`), so rows
 * immediately on either side arrive in the first response from each, and
 * every row in the log is on exactly one side. That is also why the floor
 * only has to be approximately right: choosing it a few entries out moves
 * rows between the two cursors and loses none.
 *
 * **`since` is `W - 1`, rather than making the tail `>=` at bootstrap.**
 * `since` means "I have through here" on every other call a client makes, and
 * one parameter with two meanings is what a client mis-handles later. So the
 * pivot `W` is `before` unchanged, and `since` is one below it -- which makes
 * the entry at `W` the tail's, not nobody's.
 */
export interface BootstrapCursors {
  /** For `GET /api/sync?since=`: the tail serves entries above this. */
  since: number;
  /** For `GET /api/sync/backfill?before=`: the walk serves entries below this. */
  before: number;
}

export function bootstrapCursors(raw: DatabaseSync, targetItems: number): BootstrapCursors {
  const pivot = pivotFor(raw, targetItems);
  return { since: pivot - 1, before: pivot };
}

/**
 * The log position roughly `targetItems` media items down from the newest.
 *
 * Five steps, and two rejected shapes worth more than the code that replaced
 * them.
 *
 * 1. **One candidate per category, one query each.** For each distinct
 *    `media_item.plugin_id`, the item `targetItems / categories` places down
 *    from that category's newest. Measured:
 *    `SEARCH media_item USING COVERING INDEX media_item_sync (plugin_id=?)`
 *    -- a seek, because `media_item_sync` is `(plugin_id, updated_at, id)`
 *    and that is exactly the filter and the ordering. **A category with fewer
 *    items than the offset answers no row and contributes nothing.** See the
 *    ruling below; it used to fall back to its oldest item, and that is what
 *    collapsed the pivot.
 *
 *    **Not one `ROW_NUMBER() OVER (PARTITION BY plugin_id ...)` query.**
 *    Measured: `SCAN media_item USING COVERING INDEX media_item_sync` plus
 *    `USE TEMP B-TREE`, a full scan and a sort where the per-category form
 *    seeks. One query reads better and costs the whole table.
 *
 *    **Not `GROUP BY plugin_id` either.** Measured: it collapses to one row
 *    per category, so an `OFFSET` over it indexes *categories* rather than
 *    items, and `max(id)` is the highest rowid rather than the newest by
 *    `updated_at` -- two wrong answers wearing the shape of the right one.
 *
 * 2. **The oldest candidate wins**, by `(updated_at, id)`. It is the floor:
 *    every candidate above it, and everything newer than any of them, ends up
 *    on the tail's side.
 *
 * 3. **That item's latest release**, `max(rss_item.id)` for it. `max` of the
 *    row id rather than of `updated_at`: this is asking which release row is
 *    newest, and `rss_item` ids are allocated in insertion order within one
 *    group. Null for an item with no releases, which step 4 handles without a
 *    branch.
 *
 * 4. **The lower of those two rows' log entries.** Both, rather than the
 *    media item's alone, because the two can sit either way round. Measured
 *    on production's own write order -- `rss_item` inserted, then
 *    `createMediaItem`, then `relinkRssItem` *updating* the rss_item --
 *    `3:media_item/1 4:rss_item/1 5:rss_item/2`, so the media item is
 *    normally the group's floor. But a later `media_item` update inverts it:
 *    `4:rss_item/1 5:rss_item/2 6:media_item/1`. And step 1 orders by
 *    `updated_at DESC`, so it selects exactly the recently-written rows where
 *    that inversion lives. Taking the `MIN` pins the card's newest release to
 *    the tail side whichever way round they sit.
 *
 *    A null `row_id` in the `rss_item` arm makes that arm never true, so an
 *    item with no releases falls through to the `media_item` clause on its
 *    own. Measured to seek both arms: `MULTI-INDEX OR` over
 *    `sync_log_row (table_name=? AND row_id=?)`.
 *
 * 5. **`W` is that entry.** `bootstrapCursors` turns it into the pair.
 *
 * **Ruling: a bounded first payload beats every category being represented
 * above the pivot, and a category smaller than the offset is served by the
 * walk.** The two goals are in tension and the code used to choose silently.
 * "Every category represented above the pivot" and "a bounded first payload"
 * cannot both hold when a category's items are all *old*: putting them above
 * the pivot means pulling everything newer than them above it too, which is
 * the whole library. Measured at the shipped `BOOTSTRAP_ITEMS = 40`, with the
 * step-1 fallback in place:
 *
 * | Library | `bootstrapCursors` | tail ops | walk ops |
 * |---|---|---|---|
 * | movie: 5 old items, tv: 1000 newer | `{since: 0, before: 1}` | 1005 | 0 |
 * | tv: 1000 old items, movie: 5 newer | `{since: 984, before: 985}` | 21 | 984 |
 *
 * The first row is the degenerate case, not a rounding error: the walk is
 * retired on its first request and the client replicates the whole library
 * through the tail alone, which is the serial behaviour design spec §8 says
 * "defeats the design". A large TV library beside a handful of movies, or a
 * category added late, is the common shape rather than a corner.
 *
 * **What the ruling costs.** A category smaller than the offset contributes
 * nothing to the pivot, so none of its items is guaranteed to be above it and
 * a client's first tail page may show nothing of that category at all. Those
 * items are not lost -- the walk starts immediately below the pivot and
 * reaches them -- but on a large library they arrive some pages in rather
 * than at once. That is the price of the payload being bounded, and it is
 * paid by the category that has least to send.
 *
 * **Three ways there is no candidate, and all three answer above the log.** A
 * library with no media items at all; a library where no category reaches the
 * offset, which is now a real case rather than a defensive one -- any library
 * smaller than `targetItems` is in it; and a floor whose rows have no log
 * entry, which `seedSyncLog` (`sync/log.ts`) rules out and which would
 * otherwise be a pivot with nothing behind it. Above the log means the tail
 * starts empty and the walk owns every entry there is -- complete, just
 * slower to first render, and on a library that small the walk finishes in
 * one page anyway.
 */
function pivotFor(raw: DatabaseSync, targetItems: number): number {
  const categories = raw.prepare('SELECT DISTINCT plugin_id FROM media_item').all()
    .map((row) => String((row as { plugin_id: unknown }).plugin_id));
  if (categories.length === 0) return aboveTheLog(raw);

  const offset = Math.floor(targetItems / categories.length);
  const candidates = categories.flatMap((pluginId) => candidateIn(raw, pluginId, offset) ?? []);
  const floor = oldestOf(candidates);
  if (floor === undefined) return aboveTheLog(raw);

  const entry = lowestEntryOf(raw, floor.id, latestReleaseOf(raw, floor.id));
  return entry ?? aboveTheLog(raw);
}

/** One media item, as the candidate queries read it. */
interface Candidate {
  readonly id: number;
  readonly updatedAt: number;
}

function toCandidate(row: unknown): Candidate {
  const item = row as { id: unknown; updatedAt: unknown };
  return { id: Number(item.id), updatedAt: Number(item.updatedAt) };
}

/**
 * This category's item `offset` places down from its newest, or `undefined`
 * for a category that does not have that many.
 *
 * **The empty result is the answer, not a case to recover from.** A second
 * statement here used to return the category's *oldest* item instead, so a
 * short category contributed a candidate rather than dropping out -- and
 * because step 2 takes the oldest candidate, one small old category put the
 * pivot at the bottom of the whole log. `pivotFor`'s ruling has the
 * measurement. Nothing replaced that query: a clamped offset would need the
 * category's count, which is another read to answer a question this statement
 * already answers by returning nothing.
 */
function candidateIn(raw: DatabaseSync, pluginId: string, offset: number): Candidate | undefined {
  const row = raw.prepare(
    'SELECT id, updated_at AS updatedAt FROM media_item WHERE plugin_id = ?'
    + ' ORDER BY updated_at DESC, id DESC LIMIT 1 OFFSET ?',
  ).get(pluginId, offset);
  return row === undefined ? undefined : toCandidate(row);
}

/** The oldest of the candidates by `(updated_at, id)`, matching the ordering they were selected on. */
function oldestOf(candidates: readonly Candidate[]): Candidate | undefined {
  return candidates.reduce<Candidate | undefined>((oldest, candidate) => {
    if (oldest === undefined) return candidate;
    if (candidate.updatedAt !== oldest.updatedAt) return candidate.updatedAt < oldest.updatedAt ? candidate : oldest;
    return candidate.id < oldest.id ? candidate : oldest;
  }, undefined);
}

/** The highest `rss_item.id` under this media item, or `null` for one with no releases. */
function latestReleaseOf(raw: DatabaseSync, mediaItemId: number): number | null {
  const row = raw.prepare('SELECT max(id) AS latest FROM rss_item WHERE media_item_id = ?').get(mediaItemId) as
    { latest: unknown } | undefined;
  return row?.latest === null || row?.latest === undefined ? null : Number(row.latest);
}

/** The lower of these two rows' log entries, or `null` when neither has one. */
function lowestEntryOf(raw: DatabaseSync, mediaItemId: number, releaseId: number | null): number | null {
  const row = raw.prepare(
    "SELECT min(id) AS entry FROM sync_log WHERE (table_name = 'media_item' AND row_id = ?)"
    + " OR (table_name = 'rss_item' AND row_id = ?)",
  ).get(mediaItemId, releaseId) as { entry: unknown } | undefined;
  return row?.entry === null || row?.entry === undefined ? null : Number(row.entry);
}

/**
 * One above every entry the log holds, so the tail starts empty and the walk
 * owns everything. `1` for an empty log, which makes `since` 0 -- the same
 * cursor a client with nothing would send anyway.
 */
function aboveTheLog(raw: DatabaseSync): number {
  const row = raw.prepare('SELECT coalesce(max(id), 0) AS top FROM sync_log').get() as { top: unknown } | undefined;
  return Number(row?.top ?? 0) + 1;
}
