import { DatabaseSync } from 'node:sqlite';
import { INSTALL_LABEL_TOKEN_KEY, setAppState } from './app-state.ts';
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

/**
 * The label salt every test database is pre-minted with, and the clock it is
 * minted against.
 *
 * A real installation's salt is eight random hex characters, which makes
 * every job name a test asserts on unwritable as a literal. Pinning it here
 * keeps `[pickarr-7e57ab1e-1]` a thing a test can type, and — because
 * `installLabelToken` only mints when the row is absent — the pre-mint is
 * not the overwrite the key forbids.
 *
 * It is hex, and eight characters, because `LABEL_MARKER_PATTERN` will not
 * read a marker whose salt is anything else. A memorable non-hex token was
 * tried first and every round-trip assertion answered `null`, which is the
 * pattern doing its job.
 *
 * `MINTED_AT` is 1 rather than 0 so that a row seeded at `created_at` 1 —
 * which is what most fixtures here use — is *not* legacy-eligible, since
 * `labelsFor`'s bound is strict. The ordinary fixture therefore exercises the
 * post-token behaviour, and a test that wants the compatibility path asks for
 * it explicitly by seeding a row older than this.
 */
export const TEST_LABEL_TOKEN = '7e57ab1e';
export const TEST_LABEL_TOKEN_MINTED_AT = 1;

export function openTestDatabase(): DatabaseSync {
  const db = openDatabase(':memory:');
  setAppState(db, INSTALL_LABEL_TOKEN_KEY, TEST_LABEL_TOKEN, TEST_LABEL_TOKEN_MINTED_AT);
  return db;
}
