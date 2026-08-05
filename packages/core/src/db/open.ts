import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.ts';

/**
 * node:sqlite is synchronous and has no async counterpart. This is the single
 * documented exception to the async-over-sync rule: queries here are point
 * lookups against indexed columns at single-user scale.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function openTestDatabase(): DatabaseSync {
  return openDatabase(':memory:');
}
