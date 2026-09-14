import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CREDENTIAL_ALLOW_LIST,
  findCredentialAssertions,
  findCredentialOperands,
  findCredentialSelections,
  findViolations,
} from './check-test-hygiene.ts';

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
    // A quantifier stands between the head of the list and the star. Keying the
    // star rule on `^` alone let all three of these through -- found by
    // measuring the rule after it was narrowed to stop reading `x * 1000` as a
    // star, which is the same regex and the opposite error.
    'distinct-star.ts': `export const Q = 'SELECT DISTINCT * FROM secret';\n`,
    'distinct-alias-star.ts': `export const Q = 'SELECT DISTINCT s.* FROM secret s';\n`,
    'all-star.ts': `export const Q = 'SELECT ALL * FROM host_state';\n`,
    // The quantifier is consumed and the star still has an operand in front of
    // it, so this is multiplication and stays unreported.
    'distinct-product.ts': `export const Q = 'SELECT DISTINCT a * b FROM secret';\n`,
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
      ['all-star.ts', 'host_state.*'],
      ['distinct-alias-star.ts', 'secret.*'],
      ['distinct-star.ts', 'secret.*'],
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

test('a SQL comment between FROM and the table does not hide the table', async (t) => {
  // **A bypass, not a curiosity.** `readsFrom` matches the table right after
  // the keyword, so a comment in between defeated it and
  // `SELECT token FROM /* the sessions */ auth_session` was reported as
  // nothing at all -- while a newline, or a comment before the column list,
  // flagged normally. A comment is a token separator to SQLite, so each one
  // becomes a single space: `FROM/*x*/auth_session` has to read as a read of
  // that table, and `auth_/*x*/session` must **not**, because to SQLite that
  // is two tokens and a syntax error rather than a table name.
  const dir = await fixtureDir(t, {
    'between.ts': `export const Q = 'SELECT token FROM /* the sessions */ auth_session';\n`,
    'no-space.ts': `export const Q = 'SELECT token FROM/* s */auth_session';\n`,
    'line-comment.ts': [
      'export const Q = `',
      'SELECT token -- the credential the cookie carries',
      'FROM auth_session`;',
      '',
    ].join('\n'),
    // The other direction: a comment inside the identifier does not join its
    // halves into a table name, and the statement reads no credential table.
    'split-identifier.ts': `export const Q = 'SELECT token FROM auth_/* x */session';\n`,
    // And a column named only in a SQL comment, over a table that is not a
    // credential table, is still nothing.
    'harmless.ts': `export const Q = 'SELECT id FROM media_item -- not token';\n`,
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [relative(dir, violation.file), violation.text]),
    [
      ['between.ts', 'auth_session.token'],
      ['line-comment.ts', 'auth_session.token'],
      ['no-space.ts', 'auth_session.token'],
    ],
  );
});

test('a table name this check cannot resolve is a violation, because it may be a credential table', async (t) => {
  // The half of failing closed that the docblock claimed and did not do. The
  // branch was keyed on `readsFrom(sql, table)` for a *known* credential
  // table, so a statement whose table is a parameter was not "a query over a
  // credential table" and never reached it: `SELECT token FROM ${t}` reported
  // nothing, while the same query with the *column* substituted reported
  // `auth_session.?`.
  //
  // Reported as `?.?` -- a table it could not read, selecting columns it
  // therefore cannot clear -- and answerable the same way as any other
  // fail-closed finding: name the table, or say in a diff why this module may
  // read a credential.
  //
  // **Narrower than "any unresolved table", which is what it was first.** See
  // `unknownTableMark`: the question the rule asks is whether a credential
  // column is selected, and a statement whose column list is fully spelled out
  // answers it whatever the table turns out to be. The test below this one is
  // the admitted case; everything here is still a violation.
  const dir = await fixtureDir(t, {
    'from-parameter.ts': 'export function q(t: string): string { return `SELECT token FROM ${t}`; }\n',
    'star-from-parameter.ts': 'export function q(t: string): string { return `SELECT * FROM ${t}`; }\n',
    // A credential column written into an unknown table is the `INTO` half of
    // the same question, and `password` is what makes it one.
    'insert-into-parameter.ts':
      'export function q(t: string): string { return `INSERT INTO ${t} (password) VALUES (?)`; }\n',
    // Both halves unknown: the column list could be any column and the table
    // could be any table, which is the case failing closed exists for.
    'columns-and-table.ts':
      'export function q(c: string, t: string): string { return `SELECT ${c} FROM ${t}`; }\n',
    // A table that *does* resolve is read as itself, and this one holds no
    // credential -- so resolving it is what makes the difference, not the
    // presence of a substitution.
    'from-constant.ts': [
      `const T = 'media_item';`,
      'export const Q = `SELECT id FROM ${T} WHERE id > ?`;',
      '',
    ].join('\n'),
    // A bound parameter that is not in the table position stays a bound
    // parameter: the shape is `FROM`/`JOIN`/`UPDATE`/`INTO` immediately
    // followed by something unreadable, not a `?` anywhere in the statement.
    'parameter-in-where.ts': `export const Q = 'SELECT id FROM media_item WHERE id = ?';\n`,
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [relative(dir, violation.file), violation.text]),
    [
      ['columns-and-table.ts', '?.?'],
      ['from-parameter.ts', '?.?'],
      ['insert-into-parameter.ts', '?.?'],
      ['star-from-parameter.ts', '?.*'],
    ],
  );
});

test('a fully spelled column list over a table this check cannot resolve is a pass', async (t) => {
  // The one shape the rule above admits, and the reason it was narrowed:
  // `sync/log.ts` seeds `sync_log` with one entry per live row of a table
  // named at runtime, and there is no other way to write it -- SQLite binds no
  // identifiers, so a table's rows cannot be enumerated without naming it
  // after `FROM`. Its column list is `?`, `id`, a literal and a timestamp
  // expression: `id` is a credential in no table of this schema, so whichever
  // table this turns out to read, the statement is not selecting a credential
  // out of it.
  //
  // The multiplication in the timestamp is the second half of what was
  // measured here: the star matcher allowed any whitespace in front of a `*`,
  // so `unixepoch('subsec') * 1000` in a select list was read as
  // `SELECT *` and reported this statement as `?.*`.
  const dir = await fixtureDir(t, {
    'seed.ts': [
      'export function seed(table: string): string {',
      "  return `INSERT INTO sync_log (table_name, row_id, op, at)",
      "     SELECT ?, id, 'upsert', CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM ${table}`;",
      '}',
      '',
    ].join('\n'),
    // The same admission for a write, and for the same reason: column `a` is a
    // credential nowhere, so this cannot be writing one by name.
    'insert.ts': 'export function q(t: string): string { return `INSERT INTO ${t} (a) VALUES (?)`; }\n',
    // And a plain arithmetic select list over a *known* non-credential table,
    // so the star fix is pinned independently of the unknown-table branch.
    'arithmetic.ts': `export const Q = 'SELECT updated_at * 1000 FROM media_item';\n`,
  });

  assert.deepEqual(await findCredentialSelections(dir, []), []);
});

test('the star matcher still sees every spelling of a real star select', async (t) => {
  // The counterweight to the narrowing above: a `*` where a column could
  // stand is a star select, at the head of the list or after a comma, bare or
  // alias-qualified. Narrowing it to exclude the multiplication operator must
  // not have excluded any of these.
  const dir = await fixtureDir(t, {
    'head.ts': `export const Q = 'SELECT * FROM auth_session';\n`,
    'alias.ts': `export const Q = 'SELECT s.* FROM auth_session s';\n`,
    'after-comma.ts': `export const Q = 'SELECT id, * FROM auth_session';\n`,
    'newline.ts': ['export const Q = `SELECT', '  *', 'FROM auth_session`;', ''].join('\n'),
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [relative(dir, violation.file), violation.text]),
    [
      ['after-comma.ts', 'auth_session.*'],
      ['alias.ts', 'auth_session.*'],
      ['head.ts', 'auth_session.*'],
      ['newline.ts', 'auth_session.*'],
    ],
  );
});

test('a star select in any select list of the statement is a star select, not only the first', async (t) => {
  // The narrowing read only the text between the *first* `SELECT` and the
  // *first* `FROM`, so a star anywhere else passed -- measured, each of the
  // three below was reported at `3d8cb49` and passed at HEAD before this. If
  // the runtime table is `secret` or `auth_session`, each reads the
  // credential column.
  //
  // The fourth needs no substitution at all: a literal credential table
  // behind a subquery, which passed at both revisions.
  const dir = await fixtureDir(t, {
    'subquery.ts':
      'export function q(t: string): string { return `SELECT id FROM media_item WHERE id IN (SELECT * FROM ${t})`; }\n',
    'union.ts':
      'export function q(t: string): string { return `SELECT id FROM media_item UNION ALL SELECT * FROM ${t}`; }\n',
    'except.ts':
      'export function q(t: string): string { return `SELECT id FROM media_item EXCEPT SELECT * FROM ${t}`; }\n',
    'literal-table.ts': `export const Q = 'SELECT id FROM media_item WHERE id IN (SELECT * FROM secret)';\n`,
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [relative(dir, violation.file), violation.text]),
    [
      ['except.ts', '?.*'],
      ['literal-table.ts', 'secret.*'],
      ['subquery.ts', '?.*'],
      ['union.ts', '?.*'],
    ],
  );
});

test('a quantifier needs no space after it, because SQLite needs none', async (t) => {
  // The follow-up commit named `DISTINCT` and `ALL` and then required
  // whitespace after them. SQLite does not: verified through `node:sqlite`,
  // `SELECT all*FROM secret` and `SELECT distinct*FROM secret` both parse and
  // both return the row. Both passed this check.
  const dir = await fixtureDir(t, {
    'all.ts': 'export function q(t: string): string { return `SELECT all*FROM ${t}`; }\n',
    'distinct.ts': 'export function q(t: string): string { return `SELECT distinct*FROM ${t}`; }\n',
    'all-known.ts': `export const Q = 'SELECT all*FROM auth_session';\n`,
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [relative(dir, violation.file), violation.text]),
    [
      ['all-known.ts', 'auth_session.*'],
      ['all.ts', '?.*'],
      ['distinct.ts', '?.*'],
    ],
  );
});

test('a word that merely starts with a quantifier is not one, so its multiplication stays unreported', async (t) => {
  // The counterweight to dropping the required whitespace. `\b` after the
  // quantifier is what keeps these three out: an identifier the quantifier is
  // a prefix of, and the quantifier used properly in front of an expression
  // rather than a star.
  const dir = await fixtureDir(t, {
    'alldata.ts': `export const Q = 'SELECT alldata * 2 FROM auth_session';\n`,
    'distinctive.ts': `export const Q = 'SELECT distinctive * 3 FROM auth_session';\n`,
    'distinct-expr.ts': `export const Q = 'SELECT DISTINCT a * b FROM auth_session';\n`,
  });

  assert.deepEqual(await findCredentialSelections(dir, []), []);
});

test('a schema qualifier does not hide a table this check could not resolve', async (t) => {
  // Pre-existing, and wider than a naming asymmetry: `readsFromUnknownTable`
  // matched the substitution only immediately after the keyword, so a
  // `main.` in between gated the *whole* unknown-table branch and nothing
  // inside `unknownTableMark` could fire behind it. All three below passed,
  // including the one `unknownTableMark`'s own docblock says is refused.
  const dir = await fixtureDir(t, {
    'qualified-column.ts': 'export function q(t: string): string { return `SELECT token FROM main.${t}`; }\n',
    'qualified-star.ts': 'export function q(t: string): string { return `SELECT * FROM main.${t}`; }\n',
    'qualified-columns.ts':
      'export function q(c: string, t: string): string { return `SELECT ${c} FROM main.${t}`; }\n',
    // The admitted shape is admitted behind a qualifier too, or the branch
    // would be reporting more than the unqualified one does rather than the
    // same.
    'qualified-seed.ts': [
      'export function seed(table: string): string {',
      "  return `INSERT INTO sync_log (table_name, row_id, op, at)",
      "     SELECT ?, id, 'upsert', CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM main.${table}",
      "      WHERE id NOT IN (SELECT row_id FROM sync_log WHERE table_name = ?)`;",
      '}',
      '',
    ].join('\n'),
  });

  assert.deepEqual(
    (await findCredentialSelections(dir, [])).map((violation) => [relative(dir, violation.file), violation.text]),
    [
      ['qualified-column.ts', '?.?'],
      ['qualified-columns.ts', '?.?'],
      ['qualified-star.ts', '?.*'],
    ],
  );
});

test('the shipped seed and relog statements pass, which is what the narrowing is for', async (t) => {
  // `sync/log.ts`'s two runtime-table statements, verbatim, as the standing
  // measurement that widening the star matcher to every select list did not
  // start reporting them. The seed's second select list is `row_id`, which is
  // a credential column in no table of this schema; the relog's `DELETE`
  // resolves fully and names no table this check cannot read.
  const dir = await fixtureDir(t, {
    'seed.ts': [
      'export function seed(table: string): string {',
      "  return `INSERT INTO sync_log (table_name, row_id, op, at)",
      "     SELECT ?, id, 'upsert', CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM ${table}",
      "      WHERE id NOT IN (SELECT row_id FROM sync_log WHERE table_name = ?)`;",
      '}',
      '',
    ].join('\n'),
    'relog.ts': [
      'export function relog(table: string): string[] {',
      '  return [',
      `    "DELETE FROM sync_log WHERE table_name = ? AND op != 'delete'",`,
      '    `INSERT INTO sync_log (table_name, row_id, op, at)',
      "       SELECT ?, id, 'upsert', CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM ${table}`,",
      '  ];',
      '}',
      '',
    ].join('\n'),
  });

  assert.deepEqual(await findCredentialSelections(dir, []), []);
});

/**
 * Where rule 2 applies, as the script itself spells it -- **repo-relative,
 * deliberately**. The allow-list holds repo-relative paths, so the entry can
 * only match a file walked from the same relative root; the test below is
 * therefore the one in this file that depends on the working directory, which
 * is the repo root under `npm run test:server` and under CI's `npm run check`.
 * Every other test here writes a fixture under a temp dir instead.
 */
const HOST_SRC = 'packages/host/src';

test('the credential allow-list has two entries, and the real tree needs no other', async () => {
  // **An inert entry is how this rule gets lost quietly.**
  // `auth/instance.ts` was allow-listed too, on the reasoning that it
  // constructs `betterAuth()`. It reaches every credential column through the
  // Drizzle adapter and names none of them in any string, so it produced no
  // violations -- and the entry exempted a 442-line file from a rule it did
  // not need, where a query added to it later would be a query nothing
  // reports. Both halves are asserted over the real tree rather than a
  // fixture, because the claim is about this repo: with the allow-list
  // emptied, the only credential-column SQL on the branch is
  // `db/host-state.ts`'s four statements and `secrets/store.ts`'s two, and
  // the shipped list is exactly what makes the tree clean.
  assert.deepEqual(
    (await findCredentialSelections(HOST_SRC, [])).map((violation) => [
      relative(HOST_SRC, violation.file),
      violation.text,
    ]),
    [
      [join('db', 'host-state.ts'), 'host_state.value'],
      [join('db', 'host-state.ts'), 'host_state.value'],
      [join('db', 'host-state.ts'), 'host_state.value'],
      [join('db', 'host-state.ts'), 'host_state.value'],
      [join('secrets', 'store.ts'), 'secret.value'],
      [join('secrets', 'store.ts'), 'secret.value'],
    ],
    'rule 2 with no allow-list must report host-state.ts and store.ts and nothing else -- an auth file appearing here means the adapter is being bypassed',
  );
  assert.deepEqual(
    await findCredentialSelections(HOST_SRC),
    [],
    'and the shipped allow-list, two entries, is enough to make the tree clean',
  );
});

test('every allow-list entry is one the tree actually needs', async () => {
  // **The only thing that can notice an inert entry.** Re-adding
  // `auth/instance.ts` to the list changes no report -- that is what "inert"
  // means -- so no assertion about violations can see it. What can be asserted
  // is the property the list is supposed to have: each entry exempts something
  // real, so dropping it produces a violation *in that file*. An entry with
  // nothing behind it fails here, which is what keeps a blanket exemption from
  // being added back for a file that does not need one.
  //
  // A path with no file behind it is still allowed on purpose -- the list is
  // written forward, and `an allow-list path naming a file that does not exist
  // yet is not an error` pins that -- so this checks the entries that name a
  // file in the tree today, which is the whole list.
  assert.ok(CREDENTIAL_ALLOW_LIST.length > 0, 'an empty allow-list would make this test vacuous');
  for (const entry of CREDENTIAL_ALLOW_LIST) {
    const without = CREDENTIAL_ALLOW_LIST.filter((path) => path !== entry);
    // eslint-disable-next-line no-await-in-loop -- two entries today; a directory walk per entry is not a hot path
    const violations = await findCredentialSelections(HOST_SRC, without);
    assert.ok(
      violations.length > 0 && violations.every((violation) => violation.file === entry),
      `${entry} exempts nothing: it is an inert allow-list entry, exempting a whole file from a rule it does not need`,
    );
  }
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

/**
 * The third rule: no host test hands a credential to `node:assert` as an
 * operand.
 *
 * The defect it generalises was in the earliest test file of the auth slice
 * and printed five distinct 43-character signing secrets, twice each, on the
 * run where a mutation broke it. The report said that file "never interpolates
 * one into text", which is true and is not the hazard: `node:assert` formats
 * both operands whether or not anyone interpolated anything.
 */

/** Runs the credential-operand detector over a snippet, returning the offending text. */
function credentials(source: string): string[] {
  return findCredentialOperands('sample.test.ts', source).map((violation) => violation.text);
}

test('two generated secrets compared by assert.equal are both flagged', () => {
  // The shape that actually printed secrets. Neither operand names a producer:
  // a rule reading only calls would have seen `assert.equal(second, first)` and
  // found nothing, which is why an identifier is followed to what it was bound
  // to.
  assert.deepEqual(
    credentials([
      'const first = ensureAuthSecret(raw, 1_000);',
      'const second = ensureAuthSecret(raw, 2_000);',
      'assert.equal(second, first);',
    ].join('\n')),
    ['second', 'first'],
  );
});

test('a name declared twice is a credential if any of its declarations is one', () => {
  // `first` in `packages/host/test/db/host-state.test.ts` is a generated
  // secret in one test and an open database in another. There is no scope
  // analysis here, so resolving it to one declaration is a guess -- and the
  // guess that skips the secret is the one that lets the leak through. Rule 2
  // resolves the opposite way for the same reason; see `Bindings`.
  assert.deepEqual(
    credentials([
      'const first = openDatabase(path);',
      'const first = ensureAuthSecret(raw, 1_000);',
      'assert.equal(first, other);',
    ].join('\n')),
    ['first'],
  );
});

test('every producer is flagged called directly, and every formatting assertion is covered', () => {
  for (const producer of [
    `ensureAuthSecret(raw, 1_000)`,
    `ensureGeneratedValue(raw, 'auth.secret', 1_000)`,
    `ensureClaimToken(raw, 1_000)`,
    `readHostState(raw, 'auth.secret')`,
    `resolveAuthSecret(undefined, raw, 1_000)`,
    `randomBytes(32).toString('base64url')`,
    `response.headers.getSetCookie()`,
    `cookieHeader(response)`,
  ]) {
    assert.deepEqual(
      credentials(`assert.equal(${producer}, null);`),
      [producer],
      `${producer} is a credential wherever it appears as an operand`,
    );
  }
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
      credentials(`assert.${method}(ensureClaimToken(raw, 1_000), null);`),
      [`ensureClaimToken(raw, 1_000)`],
      `assert.${method} formats its operands too`,
    );
  }
});

test('an awaited credential is still a credential', () => {
  assert.deepEqual(
    credentials(`assert.equal(await cookieHeader(response), null);`),
    ['cookieHeader(response)'],
  );
});

test('the remedy is not flagged, and neither is a number read off a credential', () => {
  // `assert.ok` formats nothing, which is why it is the fix and not the
  // hazard. And the outermost expression is what gets printed: the
  // `getSetCookie().length` in `api/server.test.ts` is a count, and a rule
  // that read the whole operand would have condemned it -- measured, it is
  // the only such site in the host suite.
  assert.deepEqual(
    credentials([
      'const first = ensureAuthSecret(raw, 1_000);',
      'const second = ensureAuthSecret(raw, 2_000);',
      "assert.ok(second === first, 'the second call minted a new secret');",
    ].join('\n')),
    [],
  );
  assert.deepEqual(credentials(`assert.equal(signedIn.headers.getSetCookie().length, 1);`), []);
  assert.deepEqual(credentials(`assert.equal(tokenIsOnRecord(raw), true);`), []);
});

test('a message argument is not an operand, and prose is not code', () => {
  assert.deepEqual(credentials(`assert.ok(true, String(ensureClaimToken(raw, 1_000)));`), []);
  assert.deepEqual(
    credentials('// never assert.equal(second, first) over two ensureAuthSecret values\nconst a = 1;'),
    [],
  );
});

test('rule 3 walks a directory and names the file and line', async (t) => {
  // Over a fixture under a temp dir, like rule 2's tests: a test that edited
  // tracked source to prove a linter works is a test that can leave the tree
  // broken.
  const dir = await fixtureDir(t, {
    'leaks.test.ts': [
      'const generated = ensureAuthSecret(raw, 1_000);',
      'assert.equal(generated, stored);',
      '',
    ].join('\n'),
    'clean.test.ts': [
      'const generated = ensureAuthSecret(raw, 1_000);',
      "assert.ok(generated === stored, 'the secret changed');",
      '',
    ].join('\n'),
  });

  assert.deepEqual(
    (await findCredentialAssertions(dir)).map((violation) => [
      relative(dir, violation.file),
      violation.line,
      violation.text,
    ]),
    [['leaks.test.ts', 2, 'generated']],
  );
});
