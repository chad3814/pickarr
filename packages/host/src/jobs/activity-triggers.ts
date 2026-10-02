/**
 * Three triggers on `jobs` that tell the host, in-process, that a job
 * changed -- the Activities page's wake signal (design spec 2026-10-02 §3).
 *
 * They write nothing: each body is one call to `pickarr_activity_changed()`,
 * which `db/open.ts` registers on every connection. Installed at boot like
 * the sync triggers (`sync/log.ts`), dropped and recreated each time, so
 * this is not a migration and changing a body here freezes nothing.
 * `jobs` is not a synced table and never will be (`sync/tables.ts`); these
 * are the only triggers it carries.
 */
import type { DatabaseSync } from 'node:sqlite';

export const ACTIVITY_TRIGGER_NAMES = ['jobs_activity_ins', 'jobs_activity_upd', 'jobs_activity_del'] as const;

export function installActivityTriggers(raw: DatabaseSync): void {
  const [ins, upd, del] = ACTIVITY_TRIGGER_NAMES;
  raw.exec(`
    DROP TRIGGER IF EXISTS ${ins};
    CREATE TRIGGER ${ins} AFTER INSERT ON jobs BEGIN SELECT pickarr_activity_changed(); END;
    DROP TRIGGER IF EXISTS ${upd};
    CREATE TRIGGER ${upd} AFTER UPDATE ON jobs BEGIN SELECT pickarr_activity_changed(); END;
    DROP TRIGGER IF EXISTS ${del};
    CREATE TRIGGER ${del} AFTER DELETE ON jobs BEGIN SELECT pickarr_activity_changed(); END;
  `);
}
