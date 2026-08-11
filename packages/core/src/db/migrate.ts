import type { DatabaseSync } from 'node:sqlite';
import { migrations, type Migration } from './migrations.ts';

/**
 * Refuses a list carrying the same version twice.
 *
 * The numbering was a naming convention with nothing enforcing it, and two
 * branches developed in parallel both took `version: 4` — one indexing
 * `downloads(release_id)`, one re-keying site segments. Neither `git merge` nor
 * any test said so: the merge conflict landed *inside* migration 4's `up()`
 * body, so it read as "pick one implementation" rather than "you have two
 * migration 4s".
 *
 * Left unenforced the two outcomes are both silent-ish and both bad. On a fresh
 * database the second insert raises `UNIQUE constraint failed:
 * schema_migrations.version` — `applied` is snapshotted once before the loop,
 * so the duplicate is not skipped — and the process cannot start, from a
 * message naming a table rather than the mistake. On a database already
 * carrying the other branch's 4, the second is skipped in silence and its
 * schema change never happens at all: an index quietly missing in production,
 * no error anywhere.
 *
 * So it fails here instead, before any statement runs, naming the version. A
 * pure function over the list rather than a check buried in the loop because
 * that is what lets a test hand it a colliding pair directly.
 */
export function assertUniqueVersions(list: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const migration of list) {
    if (seen.has(migration.version)) {
      throw new Error(
        `Duplicate migration version ${migration.version}: two migrations claim it. ` +
          'Renumber the newer one — versions are a total order, not labels.',
      );
    }
    seen.add(migration.version);
  }
}

/**
 * `list` defaults to the shipped migrations and is a parameter only so a test
 * can hand this a colliding pair and watch *this function* refuse it. Testing
 * `assertUniqueVersions` alone leaves the call site unpinned — removing the
 * call below is then a mutation no test notices, which is the same shape of
 * hole as an expectation computed by the code under test.
 */
export function migrate(db: DatabaseSync, list: readonly Migration[] = migrations): void {
  // Before the table exists, let alone before anything is applied: a duplicate
  // is a coding error in the list itself, true of every database and worth
  // refusing identically on all of them.
  assertUniqueVersions(list);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => Number(row['version'])),
  );

  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  for (const migration of list) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      record.run(migration.version, Date.now());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
