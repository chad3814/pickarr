/**
 * `schema.ts` and `migrate.ts`'s `INITIAL_SCHEMA` declare the same 13 tables
 * twice — once as Drizzle objects, once as DDL — and nothing generates either
 * from the other. There is no drizzle config in this repo and no script runs
 * `drizzle-kit`, so these tests are the whole of what keeps the two in step.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import * as schema from '../../src/db/schema.ts';
import { mediaItem } from '../../src/db/schema.ts';

/** One `PRAGMA table_info` row, narrowed the way this package narrows every row. */
interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
}

function ddlColumns(raw: ReturnType<typeof openTestDatabase>['raw'], table: string): ColumnInfo[] {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((r) => {
    const row = r as { name: unknown; type: unknown; notnull: unknown };
    return { name: String(row.name), type: String(row.type), notNull: Number(row.notnull) === 1 };
  });
}

/** Every `sqliteTable` exported by `schema.ts`, by its SQL name. */
function declaredTables(): Map<string, SQLiteTable> {
  const tables = new Map<string, SQLiteTable>();
  for (const value of Object.values(schema)) {
    if (is(value, SQLiteTable)) tables.set(getTableName(value), value);
  }
  return tables;
}

test('the schema declares exactly the tables the migration creates', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const created = raw.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_migrations'
     ORDER BY name
  `).all().map((r) => String((r as { name: unknown }).name));

  // `host_migrations` and `plugin_migrations` are excluded above: they are the
  // migration runner's own bookkeeping, created by `migrateHost`/
  // `migratePlugin` outside the versioned DDL, and deliberately not declared
  // to Drizzle.
  assert.deepEqual([...declaredTables().keys()].toSorted(), created);
});

test('every schema column matches the migration DDL by name, type and nullability', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const disagreements: string[] = [];
  for (const [name, table] of declaredTables()) {
    const ddl = new Map(ddlColumns(raw, name).map((column) => [column.name, column]));
    const declared = Object.values(getTableColumns(table));

    for (const column of declared) {
      const actual = ddl.get(column.name);
      if (!actual) {
        disagreements.push(`${name}.${column.name} is declared in schema.ts and absent from the DDL`);
        continue;
      }
      if (actual.type.toUpperCase() !== column.getSQLType().toUpperCase()) {
        disagreements.push(`${name}.${column.name}: DDL says ${actual.type}, schema.ts says ${column.getSQLType()}`);
      }
      // `id` is skipped: SQLite makes an `INTEGER PRIMARY KEY` the rowid
      // alias, which `table_info` reports as nullable however it was
      // declared, so a disagreement here would be SQLite's and not ours.
      if (!column.primary && actual.notNull !== column.notNull) {
        disagreements.push(`${name}.${column.name}: DDL notNull=${actual.notNull}, schema.ts notNull=${column.notNull}`);
      }
    }

    for (const column of ddl.values()) {
      if (!declared.some((declaredColumn) => declaredColumn.name === column.name)) {
        disagreements.push(`${name}.${column.name} is in the DDL and absent from schema.ts`);
      }
    }
  }

  assert.deepEqual(disagreements, []);
});

test('the schema is wired into the handle, so a query reads mapped columns rather than raw rows', async () => {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  raw.prepare(`
    INSERT INTO media_item (plugin_id, title, release_date, provider, provider_ref, created_at, updated_at)
    VALUES ('alpha', 'The Grid', '2019-04-02', 'tmdb', 'movie:512', 10, 20)
  `).run();

  // `db.query.<table>` exists only because `open.ts` passes the schema, and
  // it answers in the schema's own property names -- which is the whole
  // reason to declare the tables twice rather than delete the declarations.
  const rows = await db.query.mediaItem.findMany();
  assert.deepEqual(rows, [{
    id: 1,
    pluginId: 'alpha',
    createdAt: 10,
    updatedAt: 20,
    provider: 'tmdb',
    providerRef: 'movie:512',
    title: 'The Grid',
    releaseDate: '2019-04-02',
    description: null,
  }]);

  // And the query builder over the same declaration reaches the same row, so
  // the objects are usable for the read slice's keyset pagination and not
  // only for `db.query`.
  const selected = await db.select({ title: mediaItem.title }).from(mediaItem);
  assert.deepEqual(selected, [{ title: 'The Grid' }]);
});
