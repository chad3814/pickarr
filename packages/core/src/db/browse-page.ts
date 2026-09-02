import type { DatabaseSync } from 'node:sqlite';
import { BROWSABLE } from './groups.ts';
import { num, str, type SqlRow } from './row.ts';

export type BrowseKind = 'failed' | 'group';

/**
 * One page boundary in the merged list.
 *
 * `kind` is what makes the order total. `media_groups.id` and `feed_items.id`
 * are unrelated namespaces, so `(sortKey, id)` cannot separate two rows that
 * share a stamp — and a tiebreak that is not total is how a row gets served
 * twice or skipped, which is issue #33's failure with a new cause.
 */
export interface BrowseCursor {
  sortKey: number;
  kind: BrowseKind;
  id: number;
}

export interface BrowsePageRow {
  kind: BrowseKind;
  id: number;
  sortKey: number;
}

/**
 * One page of the merged browse list: browsable groups and undismissed parse
 * failures, newest first, ordered `(sort_key DESC, kind ASC, id ASC)`.
 *
 * Each branch is bounded and limited *before* the union, so the outer sort sees
 * at most `2 × limit` rows rather than both tables. Both branches have an index
 * that serves their own ORDER BY — `media_groups_browse (list_rank_at DESC)`
 * and the partial `feed_items_failed (first_seen_at DESC, id) WHERE parse_error
 * IS NOT NULL` — so each is an index scan that stops at `limit`.
 *
 * Rows come back as identity plus sort key only. Hydrating them is the caller's
 * job because the two kinds need different queries, and doing it here would
 * mean this module knowing about views.
 *
 * `kind` is compared as the literal strings, so `'failed' < 'group'`. That is
 * the same expression the cursor comparison below uses, deliberately: one rule
 * written once, rather than an ORDER BY and a WHERE that can drift apart.
 */
export function pageOfBrowseItems(
  db: DatabaseSync,
  query: { cursor: BrowseCursor | null; limit: number; search: string | null },
): BrowsePageRow[] {
  const groupConditions = [BROWSABLE];
  const groupParams: (number | string)[] = [];
  const failedConditions = ['parse_error IS NOT NULL', 'dismissed_at IS NULL'];
  const failedParams: (number | string)[] = [];

  if (query.search !== null) {
    // `instr`, not `LIKE`, for the reason `browseGroups` gives: a term wrapped
    // in `%…%` treats its own `%` and `_` as wildcards. `search_text` is stored
    // already lowercased by `searchTextFor`; `raw_title` is not, so the failed
    // branch folds case in SQL while the group branch folds it in JS.
    groupConditions.push('instr(search_text, ?) > 0');
    groupParams.push(query.search.toLowerCase());
    failedConditions.push('instr(lower(raw_title), ?) > 0');
    failedParams.push(query.search.toLowerCase());
  }

  const cursor = query.cursor;
  if (cursor !== null) {
    // Four cases, derived from `(sortKey DESC, kind ASC, id ASC)`. Where the
    // cursor's kind differs from the branch's, the kind comparison alone
    // settles every tying row and no id term is needed.
    if (cursor.kind === 'group') {
      groupConditions.push('(list_rank_at < ? OR (list_rank_at = ? AND id > ?))');
      groupParams.push(cursor.sortKey, cursor.sortKey, cursor.id);
      // `'failed' < 'group'`: a failed row at the tying stamp sorts *before*
      // this cursor, so only strictly older ones come after it.
      failedConditions.push('first_seen_at < ?');
      failedParams.push(cursor.sortKey);
    } else {
      failedConditions.push('(first_seen_at < ? OR (first_seen_at = ? AND id > ?))');
      failedParams.push(cursor.sortKey, cursor.sortKey, cursor.id);
      // Every group at the tying stamp sorts after a failed row, so the tie is
      // included whole.
      groupConditions.push('list_rank_at <= ?');
      groupParams.push(cursor.sortKey);
    }
  }

  // Each branch is wrapped in its own subquery. SQLite rejects a bare `ORDER
  // BY` on a compound operand — "ORDER BY clause should come after UNION ALL
  // not before" — and the per-branch `LIMIT` is what bounds the outer sort, so
  // the wrapping is how both can coexist. This exact form is verified working.
  const sql = `
    SELECT kind, id, sort_key FROM (
      SELECT 'group' AS kind, id, list_rank_at AS sort_key
        FROM media_groups WHERE ${groupConditions.join(' AND ')}
       ORDER BY list_rank_at DESC, id ASC LIMIT ?
    )
    UNION ALL
    SELECT kind, id, sort_key FROM (
      SELECT 'failed' AS kind, id, first_seen_at AS sort_key
        FROM feed_items WHERE ${failedConditions.join(' AND ')}
       ORDER BY first_seen_at DESC, id ASC LIMIT ?
    )
    ORDER BY sort_key DESC, kind ASC, id ASC LIMIT ?`;

  return db
    .prepare(sql)
    .all(...groupParams, query.limit, ...failedParams, query.limit, query.limit)
    .map((raw) => {
      const row = raw as SqlRow;
      return {
        kind: str(row, 'kind') === 'failed' ? ('failed' as const) : ('group' as const),
        id: num(row, 'id'),
        sortKey: num(row, 'sort_key'),
      };
    });
}
