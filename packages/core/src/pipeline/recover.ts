import type { DatabaseSync } from 'node:sqlite';
import { num, type SqlRow } from '../db/row.ts';

export interface RecoveryResult {
  importsReset: number;
  pendingAddUrl: number;
}

/**
 * The payoff for keeping the state machine in the database: recovery after a
 * crash is two statements, and everything else resumes on the next tick.
 */
export function recoverInterruptedWork(db: DatabaseSync, now: number): RecoveryResult {
  const reset = db
    .prepare("UPDATE downloads SET status = 'completed', updated_at = ? WHERE status = 'importing'")
    .run(now);

  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM downloads WHERE status = 'queued' AND client_ref IS NULL")
    .get();

  return {
    importsReset: Number(reset.changes),
    pendingAddUrl: pending === undefined ? 0 : num(pending as SqlRow, 'n'),
  };
}
