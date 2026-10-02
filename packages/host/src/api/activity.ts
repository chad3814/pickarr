/**
 * `GET /api/activity`'s answer: the host's jobs, in four lists, and the
 * fetch queue's snapshot (design spec 2026-10-02 §1).
 *
 * **The `SELECT` names its columns and never `payload_json`.** That is the
 * whole of how "no payload travels" is enforced; `activity.test.ts` pins it
 * by seeding a payload and asserting its text is absent from the answer.
 *
 * A row whose `state` is none of the four this build knows is in no list.
 * The dispatcher's vocabulary may grow; this reader must not fail the page
 * when it does.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ACTIVITY_RECENT_LIMIT, type ActivityHost, type ActivityJob, type ActivityRead } from '@pickarr/contract';

const COLUMNS = 'id, plugin_id, kind, attempts, max_attempts, run_at, state, last_error, updated_at, started_at';

function toJob(row: Record<string, unknown>): ActivityJob {
  const num = (key: string): number => { const v = row[key]; return typeof v === 'number' ? v : 0; };
  const text = (key: string): string => String(row[key] ?? '');
  const lastError = row['last_error'];
  const startedAt = row['started_at'];
  return {
    id: num('id'), pluginId: text('plugin_id'), kind: text('kind'),
    attempts: num('attempts'), maxAttempts: num('max_attempts'), runAt: num('run_at'), updatedAt: num('updated_at'),
    startedAt: typeof startedAt === 'number' ? startedAt : null,
    lastError: typeof lastError === 'string' ? lastError : null,
  };
}

function list(raw: DatabaseSync, state: string, order: string, limit?: number): readonly ActivityJob[] {
  const sql = `SELECT ${COLUMNS} FROM jobs WHERE state = ? ORDER BY ${order}${limit === undefined ? '' : ` LIMIT ${String(limit)}`}`;
  return raw.prepare(sql).all(state).map(toJob);
}

export function readActivity(raw: DatabaseSync, snapshot: () => readonly ActivityHost[]): ActivityRead {
  return {
    jobs: {
      running: list(raw, 'running', 'started_at, id'),
      waiting: list(raw, 'ready', 'run_at, id'),
      dead: list(raw, 'dead', 'updated_at DESC, id DESC'),
      recent: list(raw, 'done', 'updated_at DESC, id DESC', ACTIVITY_RECENT_LIMIT),
    },
    fetches: snapshot(),
  };
}
