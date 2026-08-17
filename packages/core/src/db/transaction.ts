import type { DatabaseSync } from 'node:sqlite';

/**
 * Every operation writes several rows that only make sense together — a
 * release and the parse error it clears, a merge and the group it deletes — so
 * each runs in one transaction, as `ingestEntries` does. A refusal commits an
 * empty transaction rather than opening one late, which keeps the precondition
 * checks and the writes reading the same snapshot.
 */
export function inTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN');
  try {
    const result = body();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
