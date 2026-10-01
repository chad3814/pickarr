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
 * The listener each connection's `pickarr_sync_changed()` calls, if any.
 * Keyed by connection: `wrap` registers the SQLite function once, with a
 * body that looks the listener up here, so installing or removing a
 * listener never re-registers anything.
 */
const listeners = new WeakMap<DatabaseSync, () => void>();

/**
 * Installs (or, with `undefined`, removes) the function the sync triggers
 * call on every logged row. One per connection; `main.ts` wires the
 * event hub's `notify`.
 *
 * Fires **inside** the writing statement, before commit (measured on
 * `node:sqlite`, Node 24), so a listener must do nothing but take note --
 * `sync/events.ts` defers its publish to the next event-loop turn.
 */
export function setSyncChangedListener(raw: DatabaseSync, listener: (() => void) | undefined): void {
  if (listener === undefined) listeners.delete(raw);
  else listeners.set(raw, listener);
}

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
  // Without this, an `INSERT OR REPLACE` that displaces a different row
  // through a unique-index conflict fires the insert trigger and not the
  // delete one -- so the displaced row's deletion never reaches `sync_log`
  // and every client keeps it forever, with nothing failing. Measured in the
  // design spec §2.9. It costs nothing on the common path: an
  // `ON CONFLICT DO UPDATE` logs identically with it on or off.
  raw.exec('PRAGMA recursive_triggers = ON');
  // Every connection, test ones included: a sync trigger on a connection
  // without this function fails the write itself with `no such function`
  // (measured), so registration is not a wiring step a caller may skip.
  // Not `directOnly` -- that flag forbids a function inside a trigger,
  // which is the one place this is ever called from.
  raw.function('pickarr_sync_changed', () => {
    listeners.get(raw)?.();
    return null;
  });
  return { raw, db: drizzle({ client: raw, relations }) };
}

export type HostDb = ReturnType<typeof wrap>['db'];

export function openDatabase(path: string): { raw: DatabaseSync; db: HostDb } {
  return wrap(new DatabaseSync(path));
}

export function openTestDatabase(): { raw: DatabaseSync; db: HostDb } {
  return wrap(new DatabaseSync(':memory:'));
}
