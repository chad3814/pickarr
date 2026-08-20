import type { DatabaseSync } from 'node:sqlite';

/**
 * Why a feed's walk is where it is.
 *
 * Three terminal states rather than one "finished" flag, because they call for
 * different responses and a boolean would lose the difference: `done` needs
 * nothing, `exhausted` means raising `maxPages` would find more, and `broken`
 * means the configuration is wrong and no amount of waiting will help.
 */
export type BackfillState = 'running' | 'done' | 'exhausted' | 'broken';

export interface BackfillPosition {
  feedId: string;
  /** Zero-based page index to request next — see the table's own comment. */
  nextPage: number;
  pagesRead: number;
  state: BackfillState;
  /** Why it stopped, in words, for the states where that is not obvious. */
  detail: string | null;
}

interface PositionRow {
  next_page: number;
  pages_read: number;
  state: string;
  detail: string | null;
}

export function getBackfillPosition(db: DatabaseSync, feedId: string): BackfillPosition | null {
  const row = db
    .prepare('SELECT next_page, pages_read, state, detail FROM feed_backfill WHERE feed_id = ?')
    .get(feedId);
  if (row === undefined) return null;

  const position = row as unknown as PositionRow;
  return {
    feedId,
    nextPage: Number(position.next_page),
    pagesRead: Number(position.pages_read),
    // Read back as-is rather than validated against the union. The only writer is
    // `saveBackfillPosition` below, and a value this process did not write is a
    // corrupt database rather than a case to branch on.
    state: position.state as BackfillState,
    detail: position.detail === null ? null : String(position.detail),
  };
}

/**
 * Upsert, because the walk saves after every page and the second page would
 * otherwise collide with the first on the primary key.
 */
export function saveBackfillPosition(
  db: DatabaseSync,
  position: BackfillPosition,
  now: number,
): void {
  db.prepare(
    `INSERT INTO feed_backfill (feed_id, next_page, pages_read, state, detail, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (feed_id) DO UPDATE SET
         next_page = excluded.next_page,
         pages_read = excluded.pages_read,
         state = excluded.state,
         detail = excluded.detail,
         updated_at = excluded.updated_at`,
  ).run(
    position.feedId,
    position.nextPage,
    position.pagesRead,
    position.state,
    position.detail,
    now,
  );
}
