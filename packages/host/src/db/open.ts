import { DatabaseSync } from 'node:sqlite';
import { defineRelations } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import * as schema from './schema.ts';

/**
 * The schema, wired into every handle this module hands out, so `schema.ts`
 * is a module the host loads rather than 197 lines nothing imports.
 *
 * `relations`, not `schema`: drizzle-orm 1.0.0-rc.4 types SQLite's config as
 * `Omit<DrizzleConfig, 'schema'>`, so `drizzle({ client, schema })` does not
 * compile there — v1 replaced the `schema` key with relations built from the
 * same table objects. `defineRelations(schema)` with no second argument
 * declares no relation between tables, which is all this needs: it is what
 * makes the tables known to the handle.
 */
const relations = defineRelations(schema);

/**
 * `{ client: raw }`, not `drizzle(raw)`. Passing the handle positionally is not
 * a supported form: it falls through to opening a *new* database, which with
 * `:memory:` gives two databases and a baffling "no such table".
 *
 * Passing the schema costs the raw-SQL callers nothing — `db.$client` is the
 * same connection either way — and gains `db.query.<table>`, typed by the
 * declarations rather than by a hand-written row narrowing at each call.
 */
function wrap(raw: DatabaseSync) {
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA journal_mode = WAL');
  return { raw, db: drizzle({ client: raw, relations }) };
}

export type HostDb = ReturnType<typeof wrap>['db'];

export function openDatabase(path: string): { raw: DatabaseSync; db: HostDb } {
  return wrap(new DatabaseSync(path));
}

export function openTestDatabase(): { raw: DatabaseSync; db: HostDb } {
  return wrap(new DatabaseSync(':memory:'));
}
