import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { mediaItem } from '../../src/db/schema.ts';
import { createSyncRegistry } from '../../src/sync/registry.ts';
import { tailSince } from '../../src/sync/tail.ts';

const open = () => {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return { raw, registry: createSyncRegistry(raw, []) };
};
const addItem = (raw: ReturnType<typeof open>['raw'], id: number, title: string) =>
  raw.prepare(
    'INSERT INTO media_item (id, plugin_id, created_at, updated_at, title) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'tv', id, id, title);

test('a client at zero receives one op per row that exists', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 'a'); addItem(raw, 2, 'b');
  const page = tailSince(raw, registry, 0, 100);
  assert.deepEqual(page.ops.map((o) => o.op), ['upsert', 'upsert']);
  assert.ok(page.cursor > 0);
});

test('a client at the head receives nothing and keeps its cursor', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 'a');
  const first = tailSince(raw, registry, 0, 100);
  const second = tailSince(raw, registry, first.cursor, 100);
  assert.deepEqual(second.ops, []);
  assert.equal(second.cursor, first.cursor, 'an empty page must not move the cursor backwards');
});

test('a row changed after a cursor is delivered to a client holding it', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 'a');
  const first = tailSince(raw, registry, 0, 100);
  raw.prepare('UPDATE media_item SET title = ? WHERE id = 1').run('b');
  const second = tailSince(raw, registry, first.cursor, 100);
  assert.equal(second.ops.length, 1);
  assert.equal((second.ops[0]?.value as { title: string } | undefined)?.title, 'b');
});

test('a deleted row arrives as a delete carrying only its id', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 'a');
  const first = tailSince(raw, registry, 0, 100);
  raw.prepare('DELETE FROM media_item WHERE id = 1').run();
  const page = tailSince(raw, registry, first.cursor, 100);
  assert.deepEqual(page.ops.map((o) => o.op), ['delete']);
  assert.equal(page.ops[0]?.id, 1);
  assert.equal(page.ops[0]?.value, undefined, 'a delete carries no row');
});

test('a row changed many times is delivered once', () => {
  const { raw, registry } = open();
  addItem(raw, 1, 'a');
  for (let i = 0; i < 10; i += 1) raw.prepare('UPDATE media_item SET title = ? WHERE id = 1').run(`v${i}`);
  const page = tailSince(raw, registry, 0, 100);
  assert.equal(page.ops.length, 1, 'the log collapses on write, so the tail needs no GROUP BY');
});

test('the tail pages, and the cursor resumes exactly where it stopped', () => {
  const { raw, registry } = open();
  for (let id = 1; id <= 5; id += 1) addItem(raw, id, `t${id}`);
  const first = tailSince(raw, registry, 0, 2);
  assert.equal(first.ops.length, 2);
  const second = tailSince(raw, registry, first.cursor, 2);
  assert.equal(second.ops.length, 2);
  const ids = [...first.ops, ...second.ops].map((o) => (o.value as { id: number }).id);
  assert.deepEqual(ids, [1, 2, 3, 4], 'no row repeated, none skipped');
});

test('the same cursor twice yields the same ops', () => {
  // Spec 7.3. The client's idempotence rests on this: a page re-fetched after
  // a dropped connection must not differ, or a retry would diverge a replica.
  const { raw, registry } = open();
  addItem(raw, 1, 'a'); addItem(raw, 2, 'b');
  assert.deepEqual(tailSince(raw, registry, 0, 100), tailSince(raw, registry, 0, 100));
});

test('a write through the Drizzle handle logs an op, as a raw write does', () => {
  // Spec 7.12. The host writes both ways; a trigger is SQLite's, so both must
  // reach it -- but asserting it stops a future bulk path being added that
  // does not.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const registry = createSyncRegistry(raw, []);
  db.insert(mediaItem).values({
    id: 1, pluginId: 'tv', createdAt: 1, updatedAt: 1, title: 'a',
  }).run();
  assert.equal(tailSince(raw, registry, 0, 100).ops.length, 1);
});

test('no op carries a table the registry does not know', () => {
  const { raw, registry } = open();
  raw.prepare('INSERT INTO sync_log (table_name, row_id, op, at) VALUES (?, ?, ?, ?)')
    .run('secret', 7, 'upsert', 1);
  addItem(raw, 1, 'a');
  const page = tailSince(raw, registry, 0, 100);
  assert.deepEqual(page.ops.map((o) => o.table), ['media_item'], 'an unknown table must be skipped, not served');
  assert.ok(page.cursor > 0, 'and the cursor must still advance past it');
});

test('the cursor advances past an unknown entry even when it is the newest', () => {
  // A variant of the test above with the unknown entry last, so a mutant
  // that returns the last *served op's* entry id -- rather than the last
  // entry id -- fails here: with the unknown entry newest, no served op
  // exists to supply a cursor greater than `since`, and the client would be
  // handed the same skipped entry forever.
  const { raw, registry } = open();
  addItem(raw, 1, 'a');
  const first = tailSince(raw, registry, 0, 100);
  raw.prepare('INSERT INTO sync_log (table_name, row_id, op, at) VALUES (?, ?, ?, ?)')
    .run('secret', 7, 'upsert', 1);
  const page = tailSince(raw, registry, first.cursor, 100);
  assert.deepEqual(page.ops, [], 'the only new entry is for an unknown table, so nothing is served');
  assert.ok(page.cursor > first.cursor, 'the cursor must still move past the skipped entry');
});
