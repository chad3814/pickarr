import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';

export type HostDb = ReturnType<typeof drizzle>;

/**
 * `{ client: raw }`, not `drizzle(raw)`. Passing the handle positionally is not
 * a supported form: it falls through to opening a *new* database, which with
 * `:memory:` gives two databases and a baffling "no such table".
 */
function wrap(raw: DatabaseSync): { raw: DatabaseSync; db: HostDb } {
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA journal_mode = WAL');
  return { raw, db: drizzle({ client: raw }) };
}

export function openDatabase(path: string): { raw: DatabaseSync; db: HostDb } {
  return wrap(new DatabaseSync(path));
}

export function openTestDatabase(): { raw: DatabaseSync; db: HostDb } {
  return wrap(new DatabaseSync(':memory:'));
}
