import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { findCredentialSelections, findViolations } from './check-test-hygiene.ts';

/** Runs the detector over a snippet, returning just the offending source text. */
function flagged(source: string): string[] {
  return findViolations('sample.test.tsx', source).map((violation) => violation.text);
}

test('the shape issue #40 names is flagged', () => {
  assert.deepEqual(
    flagged(`assert.equal(screen.queryByText('Alpha'), null);`),
    [`screen.queryByText('Alpha')`],
  );
});

test('every equality assertion that formats its operands is covered, not just equal', () => {
  // node:assert formats both operands for all of these, so all of them can
  // hand a live element to the inspector.
  for (const method of [
    'equal',
    'strictEqual',
    'notEqual',
    'notStrictEqual',
    'deepEqual',
    'deepStrictEqual',
    'notDeepEqual',
    'notDeepStrictEqual',
  ]) {
    assert.deepEqual(
      flagged(`assert.${method}(screen.queryByRole('dialog'), null);`),
      [`screen.queryByRole('dialog')`],
      `assert.${method} formats its operands too`,
    );
  }
});

test('the node-identity shape is flagged, which is the one no #40 selector would have caught', () => {
  // Neither operand is null and neither is a queryBy*: this is the shape that
  // cost 52 seconds and an unnamed failure.
  assert.deepEqual(
    flagged(`assert.equal(document.activeElement, screen.getByRole('button', { name: /close/i }));`),
    ['document.activeElement', `screen.getByRole('button', { name: /close/i })`],
  );
});

test('a query awaited is still a query', () => {
  assert.deepEqual(
    flagged(`assert.equal(await screen.findByText('Alpha'), null);`),
    [`screen.findByText('Alpha')`],
  );
});

test('querySelector and closest are flagged, since they return elements too', () => {
  assert.deepEqual(
    flagged(`assert.equal(card.querySelector('.card-artwork'), null);`),
    [`card.querySelector('.card-artwork')`],
  );
  assert.deepEqual(
    flagged(`assert.equal(node.closest('article'), other);`),
    [`node.closest('article')`],
  );
});

test('a testing-library query is flagged no matter what it is called on, not just `screen`', () => {
  // `within(row)` returns something that answers to the same query methods as
  // `screen`, and gating the check on the receiver being the literal
  // identifier `screen` missed it entirely — this is the shape that actually
  // slipped through and cost a 30-second hang and a bare `'test failed'`.
  assert.deepEqual(
    flagged(`assert.equal(within(row).queryByText('x'), null);`),
    [`within(row).queryByText('x')`],
  );
  assert.deepEqual(
    flagged(`const q = within(row); assert.equal(q.queryByText('x'), null);`),
    [`q.queryByText('x')`],
  );
});

test('a property read off a query on any receiver is not flagged, matching the `screen` case', () => {
  // Same distinction as the `screen.getByRole('img').getAttribute('src')`
  // case below, but off a `within(...)` result: the outermost expression is
  // the string-returning `.getAttribute`, not the query.
  assert.deepEqual(
    flagged(`assert.equal(within(row).getByRole('img').getAttribute('src'), '/x');`),
    [],
  );
});

test('a property read off an element is not flagged, because a string formats cheaply', () => {
  // The outermost expression is what node:assert has to print. This is the
  // distinction the whole check turns on: there are many assertions of this
  // shape in the suite and every one of them is fine.
  assert.deepEqual(flagged(`assert.equal(screen.getByRole('img').getAttribute('src'), '/x');`), []);
  assert.deepEqual(flagged(`assert.equal(screen.queryAllByRole('button').length, 0);`), []);
  assert.deepEqual(flagged(`assert.equal(screen.getByRole('img').tagName, 'IMG');`), []);
});

test('the remedy is not flagged', () => {
  assert.deepEqual(flagged(`assert.ok(!screen.queryByText('Alpha'));`), []);
  assert.deepEqual(flagged(`assert.ok(document.activeElement === button, 'focused');`), []);
});

test('prose quoting the pattern is not flagged, which a regex could never manage', () => {
  // The suite documents this hazard by quoting it. Twenty-two comment lines in
  // the web tests contain the forbidden call verbatim; a text-matching check
  // would report every one of them as a violation.
  assert.deepEqual(
    flagged(`// never assert.equal(screen.queryByText(x), null) — it takes the file down\nconst a = 1;`),
    [],
  );
  assert.deepEqual(
    flagged(`/** assert.equal(screen.queryByRole(x), null) is forbidden. */\nconst b = 2;`),
    [],
  );
});

test('a message argument is not an operand, so it is not checked', () => {
  // Only the first two arguments are formatted into the failure. A third
  // argument is the message, and nothing formats it as a value.
  assert.deepEqual(flagged(`assert.ok(true, String(screen.queryByText('x')));`), []);
});

test('an assert imported under another name is still assert', () => {
  // The suite imports it as `assert`, but the check keys on the call shape
  // rather than trusting the import name to stay that way.
  assert.deepEqual(
    flagged(`expect.equal(screen.queryByText('Alpha'), null);`),
    [`screen.queryByText('Alpha')`],
  );
});

test('the violation carries a line number, so the report can name a place', () => {
  const violations = findViolations('sample.test.tsx', `const a = 1;\nassert.equal(screen.queryByText('x'), null);\n`);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.line, 2);
  assert.equal(violations[0]?.file, 'sample.test.tsx');
});

/**
 * The second rule: no file under `packages/host/src` may name a credential
 * column in a SQL string, outside an allow-list of paths.
 *
 * Every test from here down runs over a fixture written under a temp directory
 * rather than a real file in the tree — a test that edited tracked source to
 * prove a linter works is a test that can leave the tree broken.
 */

/** A temp directory holding `files`, removed when the test ends. */
async function fixtureDir(t: TestContext, files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-hygiene-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all(
    Object.entries(files).map(([name, source]) => writeFile(join(dir, name), source, 'utf8')),
  );
  return dir;
}

test('the credential-column check rejects a select outside the allow-list', async (t) => {
  // Fixture source under a temp dir, not a real file in the tree.
  const dir = await fixtureDir(t, {
    'guard.ts': `export const SESSION = 'SELECT user_id, token FROM auth_session WHERE token = ?';\n`,
    'adapter.ts': `export const SESSION = 'SELECT user_id, token FROM auth_session WHERE token = ?';\n`,
  });

  // The identical query in both files: only the allow-listed path is spared,
  // so what is being pinned is the path check and not the pattern.
  const violations = await findCredentialSelections(dir, [join(dir, 'adapter.ts')]);
  assert.deepEqual(
    violations.map((violation) => [relative(dir, violation.file), violation.line, violation.text]),
    [['guard.ts', 1, 'auth_session.token']],
  );
});

test('the credential-column check ignores a comment naming the same column', async (t) => {
  // The whole reason it is an AST walk. A grep fails this test: every one of
  // these lines names a forbidden column verbatim, because that is how the
  // rule gets explained to the next reader.
  const dir = await fixtureDir(t, {
    'notes.ts': [
      `// Only the auth adapter may run SELECT password FROM auth_account, or`,
      `// SELECT token FROM auth_session — see the auth design spec's §4.`,
      `/**`,
      ` * host_state.value holds the signing secret, so nothing here selects it.`,
      ` */`,
      `export const KEYS = ['auth.secret', 'auth.claim-token'];`,
      ``,
    ].join('\n'),
  });

  assert.deepEqual(await findCredentialSelections(dir, []), []);
});

test('an allow-list path naming a file that does not exist yet is not an error', async (t) => {
  // The allow-list is the one thing this rule writes forward: it names the
  // modules that read these columns before those modules are written. An
  // entry with no file behind it has to be inert, or the check could not be
  // landed ahead of them.
  const dir = await fixtureDir(t, {
    'guard.ts': `export const SECRET = 'SELECT value FROM host_state WHERE key = ?';\n`,
  });

  const violations = await findCredentialSelections(dir, [
    join(dir, 'not-written-yet.ts'),
    join(dir, 'guard.ts'),
  ]);
  assert.deepEqual(violations, []);
});

test('the DDL that declares a credential column is not a query over it', async (t) => {
  // What keeps `db/migrate.ts` off the allow-list. Migration 12's DDL has to
  // name all three columns -- it is where they come from -- and exempting that
  // whole file would exempt every query anyone later added to it. A `CREATE`
  // statement names its table after `TABLE`/`ON`; a query names it after
  // `FROM`, `JOIN`, `UPDATE` or `INTO`, and only the second is a read.
  const dir = await fixtureDir(t, {
    'ddl.ts': [
      'export const MIGRATION = `',
      'CREATE TABLE host_state (',
      '  key   TEXT PRIMARY KEY,',
      '  value TEXT NOT NULL',
      ');',
      'CREATE TABLE auth_session (',
      '  id    TEXT PRIMARY KEY,',
      '  token TEXT NOT NULL',
      ');',
      'CREATE UNIQUE INDEX auth_session_token ON auth_session (token);',
      '`;',
      '',
    ].join('\n'),
  });

  assert.deepEqual(await findCredentialSelections(dir, []), []);
});

/**
 * The bypasses the first version of this rule had, each closed and each
 * pinned.
 *
 * All six were measured against the rule as it shipped, and the first is the
 * one that matters most: it is not an adversarial spelling, it is how
 * `api/reads.ts` and `clients/rows.ts` are written. A rule that misses the
 * house style is a rule that fails silently the first time it matters.
 */

test('a column list reached through a constant is read, which is this repo own house style', async (t) => {
  // The shape that defeated the first version: substitutions were dropped, so
  // the statement read `SELECT ? FROM auth_session` and named no column at
  // all. `MEDIA_ITEM_COLUMNS` and `DOWNLOAD_COLUMNS` in `api/reads.ts` are
  // exactly this, so the bypass was one copy-paste from the file next door.
  const dir = await fixtureDir(t, {
    'guard.ts': [
      `const SESSION_COLUMNS = 'id, user_id, token, expires_at, created_at, updated_at';`,
      'export const SESSION_BY_ID = `SELECT ${SESSION_COLUMNS} FROM auth_session WHERE id = ?`;',
      '',
    ].join('\n'),
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [violation.line, violation.text]),
    [[2, 'auth_session.token']],
  );
});

test('a constant reached through another constant is read too, and a cycle terminates', async (t) => {
  // Resolution is recursive, because one hop is an arbitrary depth to stop at:
  // a column list built from a shared prefix is the obvious second version of
  // the shape above. `const a = ...b...; const b = ...a...` parses, so the
  // recursion carries the names it has already followed.
  const dir = await fixtureDir(t, {
    'hops.ts': [
      `const CORE = 'id, token';`,
      'const LIST = `${CORE}, expires_at`;',
      'export const Q = `SELECT ${LIST} FROM auth_session`;',
      '',
    ].join('\n'),
    'cycle.ts': [
      'const a = `${b}`;',
      'const b = `${a}`;',
      'export const Q = `SELECT id FROM media_item ${a}`;',
      '',
    ].join('\n'),
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [violation.line, violation.text]),
    [[3, 'auth_session.token']],
    'the two-hop list is read, and the cyclic pair neither hangs nor flags',
  );
});

test('a select over a credential table this check cannot read is a violation, not a pass', async (t) => {
  // **Fail closed.** Neither of these names a credential column and both may
  // well select one: `SELECT *` selects whichever columns the table has, and a
  // substitution that resolves to nothing could be any column list at all.
  // `SELECT *` is already the house style at two sites in `api/reads.ts`, so
  // treating it as "names no credential" was a rule that passed the easiest
  // possible bypass. What the report asks for is a human decision: name the
  // columns, or add the path to the allow-list in a diff.
  const dir = await fixtureDir(t, {
    'star.ts': `export const Q = 'SELECT * FROM auth_session WHERE id = ?';\n`,
    'alias-star.ts': `export const Q = 'SELECT s.* FROM auth_session s WHERE s.id = ?';\n`,
    'unresolvable.ts': 'export const Q = `SELECT ${columnsFor(table)} FROM auth_account`;\n',
    'twice-declared.ts': [
      // No scope analysis behind the resolution, so a name declared twice is
      // two candidate values; guessing either would be the one kind of wrong
      // answer that matters here.
      `const COLUMNS = 'id';`,
      `const COLUMNS = 'id, password';`,
      'export const Q = `SELECT ${COLUMNS} FROM auth_account`;',
      '',
    ].join('\n'),
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [
      relative(dir, violation.file),
      violation.text,
    ]),
    [
      ['alias-star.ts', 'auth_session.*'],
      ['star.ts', 'auth_session.*'],
      ['twice-declared.ts', 'auth_account.?'],
      ['unresolvable.ts', 'auth_account.?'],
    ],
  );
});

test('an unreadable select over a table holding no credential is still a pass', async (t) => {
  // The other half of failing closed: it fails closed *over a credential
  // table*, and nowhere else. `SELECT *` from a derived table is how
  // `DOWNLOADS_SINCE` is written and a substituted column list is how every
  // paged read in `api/reads.ts` is written, so a rule that flagged either one
  // anywhere would have to be switched off for the file it was written to
  // protect.
  const dir = await fixtureDir(t, {
    'reads.ts': [
      `const MEDIA_ITEM_COLUMNS = 'id, title, updated_at';`,
      'export const PAGE = `SELECT ${MEDIA_ITEM_COLUMNS} FROM media_item WHERE id > ?`;',
      'export const UNION = `SELECT * FROM (SELECT id FROM torrent_download LIMIT ?)`;',
      'export const CALLED = `SELECT ${qualify("d", MEDIA_ITEM_COLUMNS)} FROM media_item AS d`;',
      '',
    ].join('\n'),
    // `isClaimed`'s own statement, and the `COUNT(*)` it is measured against:
    // the `*` inside a call is not a select list, so neither is a star select.
    'claim.ts': [
      `export const CLAIMED = 'SELECT 1 FROM auth_user LIMIT 1';`,
      `export const COUNTED = 'SELECT count(*) FROM auth_session';`,
      '',
    ].join('\n'),
  });

  assert.deepEqual(await findCredentialSelections(dir, []), []);
});

test('a statement split across a concatenation is read as one statement', async (t) => {
  // Two seams, because either one alone would defeat a check that read each
  // string literal on its own: the column and the table can be separated, and
  // the table name itself can be cut in half. `DOWNLOAD_COLUMNS` in
  // `api/reads.ts` is a `+` of two literals, so this is house style too.
  const dir = await fixtureDir(t, {
    'split-clause.ts': `export const Q = 'SELECT token' + ' FROM auth_session';\n`,
    'split-table.ts': `export const Q = 'SELECT token FROM auth_' + 'session';\n`,
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [
      relative(dir, violation.file),
      violation.line,
      violation.text,
    ]),
    [
      ['split-clause.ts', 1, 'auth_session.token'],
      ['split-table.ts', 1, 'auth_session.token'],
    ],
  );
});

test('a quoted or schema-qualified table name is the same table', async (t) => {
  // All three spellings name one table to SQLite, and the rule matched only
  // the bare one. `main.` is the schema every SQLite database has, so
  // `FROM main.auth_session` is not even an unusual thing to write.
  const dir = await fixtureDir(t, {
    'quoted.ts': `export const Q = 'SELECT token FROM "auth_session"';\n`,
    'qualified.ts': `export const Q = 'SELECT token FROM main.auth_session';\n`,
    'both.ts': `export const Q = 'SELECT "token" FROM "main"."auth_session"';\n`,
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [relative(dir, violation.file), violation.text]),
    [
      ['both.ts', 'auth_session.token'],
      ['qualified.ts', 'auth_session.token'],
      ['quoted.ts', 'auth_session.token'],
    ],
  );
});

test('one statement is one violation, however many times its name is used', async (t) => {
  // Resolution follows identifiers, so the name on the left of a declaration
  // and every later use of it resolve to the statement as well. Reporting
  // those would turn one query into a violation count nobody could act on --
  // and would report the *use* rather than the line the SQL is written on.
  const dir = await fixtureDir(t, {
    'used-twice.ts': [
      `const SESSION = 'SELECT token FROM auth_session WHERE id = ?';`,
      'export function first(): string { return SESSION; }',
      'export function second(): string { return SESSION; }',
      '',
    ].join('\n'),
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [violation.line, violation.text]),
    [[1, 'auth_session.token']],
  );
});
