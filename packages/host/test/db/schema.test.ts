/**
 * `schema.ts` and `migrate.ts`'s `INITIAL_SCHEMA` declare the same 13 tables
 * and 13 indexes twice — once as Drizzle objects, once as DDL — and nothing
 * generates either from the other. There is no drizzle config in this repo
 * and no script runs `drizzle-kit`, so these tests are what keeps the two in
 * step: the table set; every column's name, SQL type and nullability; and
 * every index's table, column list (in order) and uniqueness; and every
 * column's default. They do not compare foreign-key targets or a partial
 * index's `WHERE` condition, so those two could still drift unnoticed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteColumn, SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import * as schema from '../../src/db/schema.ts';
import { mediaItem } from '../../src/db/schema.ts';

/** One `PRAGMA table_info` row, narrowed the way this package narrows every row. */
interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  /** `dflt_value` as SQL literal text, or `null` for a column with no default. */
  defaultSql: string | null;
}

function ddlColumns(raw: ReturnType<typeof openTestDatabase>['raw'], table: string): ColumnInfo[] {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((r) => {
    const row = r as { name: unknown; type: unknown; notnull: unknown; dflt_value: unknown };
    return {
      name: String(row.name),
      type: String(row.type),
      notNull: Number(row.notnull) === 1,
      defaultSql: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
    };
  });
}

/**
 * The two sides spell a default differently, so neither can be compared raw:
 * `PRAGMA table_info` hands back the *SQL literal text*, quotes included
 * (`'torrent'`, `0`), while Drizzle's `.default` is the bare JS value
 * (`'torrent'`, `0`). Stripping one surrounding quote pair and comparing as
 * strings is enough for every default this schema actually uses -- all of
 * them string or integer literals. A default that were an expression
 * (`CURRENT_TIMESTAMP`, or anything built as raw sql) would need more than
 * this, and there are none; adding one means extending this function rather
 * than trusting it.
 */
function normalizeDefault(literal: string): string {
  return literal.length >= 2 && literal.startsWith("'") && literal.endsWith("'")
    ? literal.slice(1, -1)
    : literal;
}

/** An index by name: the table it is on, its columns in order, and whether it is unique. */
interface IndexInfo {
  table: string;
  columns: string[];
  unique: boolean;
}

function ddlIndexes(raw: ReturnType<typeof openTestDatabase>['raw'], tables: readonly string[]): Map<string, IndexInfo> {
  const indexes = new Map<string, IndexInfo>();
  for (const table of tables) {
    const list = raw.prepare(`PRAGMA index_list(${table})`).all().map((r) => {
      const row = r as { name: unknown; unique: unknown; origin: unknown };
      return { name: String(row.name), unique: Number(row.unique) === 1, origin: String(row.origin) };
    });
    for (const entry of list) {
      // `origin`: 'c' is an explicit `CREATE INDEX`, 'u'/'pk' are indexes
      // SQLite makes up for an inline `UNIQUE`/primary-key constraint —
      // `schema.ts` declares none of those, so only 'c' has a Drizzle
      // counterpart to compare against.
      if (entry.origin !== 'c') continue;
      const columns = raw.prepare(`PRAGMA index_info(${entry.name})`).all()
        .map((r) => {
          const row = r as { seqno: unknown; name: unknown };
          return { seqno: Number(row.seqno), name: String(row.name) };
        })
        .toSorted((a, b) => a.seqno - b.seqno)
        .map((r) => r.name);
      indexes.set(entry.name, { table, columns, unique: entry.unique });
    }
  }
  return indexes;
}

/** Every index Drizzle declares on `schema.ts`'s tables, by name. */
function declaredIndexes(): Map<string, IndexInfo> {
  const indexes = new Map<string, IndexInfo>();
  for (const [tableName, table] of declaredTables()) {
    for (const index of getTableConfig(table).indexes) {
      const columns = index.config.columns.map((column) => {
        if (!is(column, SQLiteColumn)) {
          throw new Error(`index ${index.config.name} indexes a SQL expression, which this comparison cannot name`);
        }
        return column.name;
      });
      indexes.set(index.config.name, { table: tableName, columns, unique: index.config.unique });
    }
  }
  return indexes;
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

test('every schema column matches the migration DDL by name, type, nullability and default', () => {
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
      // `primary` is skipped here for the same reason as above but a
      // different mechanism: Drizzle reports `hasDefault === true` for every
      // `INTEGER PRIMARY KEY` (the rowid alias supplies one) with no value
      // to go with it, while the DDL declares none -- a disagreement that
      // exists in neither file.
      if (!column.primary) {
        const declaredDefault = column.hasDefault && column.default !== undefined
          ? String(column.default)
          : null;
        const ddlDefault = actual.defaultSql === null ? null : normalizeDefault(actual.defaultSql);
        if (declaredDefault !== ddlDefault) {
          disagreements.push(
            `${name}.${column.name}: DDL default=${JSON.stringify(ddlDefault)}, `
            + `schema.ts default=${JSON.stringify(declaredDefault)}`,
          );
        }
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

test('every schema index matches the migration DDL by table, columns and uniqueness', () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);

  const declared = declaredIndexes();
  const actual = ddlIndexes(raw, [...declaredTables().keys()]);

  const disagreements: string[] = [];
  for (const [name, index] of declared) {
    const ddl = actual.get(name);
    if (!ddl) {
      disagreements.push(`${name} is declared in schema.ts and absent from the DDL`);
      continue;
    }
    if (ddl.table !== index.table) {
      disagreements.push(`${name}: DDL is on ${ddl.table}, schema.ts is on ${index.table}`);
    }
    if (ddl.columns.join(',') !== index.columns.join(',')) {
      disagreements.push(`${name}: DDL columns are (${ddl.columns.join(', ')}), schema.ts columns are (${index.columns.join(', ')})`);
    }
    if (ddl.unique !== index.unique) {
      disagreements.push(`${name}: DDL unique=${ddl.unique}, schema.ts unique=${index.unique}`);
    }
  }
  for (const name of actual.keys()) {
    if (!declared.has(name)) disagreements.push(`${name} is in the DDL and absent from schema.ts`);
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
