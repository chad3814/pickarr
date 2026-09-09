/**
 * Two build-time rules, both parsed rather than pattern-matched, and both for
 * the same reason.
 *
 * 1. **No web test hands a live DOM element to `node:assert`** as a value it
 *    might have to print. See `findViolations`.
 * 2. **No file under `packages/host/src` names a credential column in a SQL
 *    string**, outside an allow-list of paths. See `findCredentialSelections`.
 *
 * **Parsed rather than pattern-matched, and that is not fastidiousness.** Each
 * rule is *documented* by quoting the thing it forbids. The web suite quotes
 * the forbidden assertion on twenty-two comment lines, fourteen of them in one
 * file; the auth design spec's §4 and the comments beside migration 12 name all
 * three credential columns verbatim. A text-matching check reports every one of
 * those as a violation. An AST walk cannot see a comment at all.
 *
 * Enforced here rather than by the linter because `oxlint` (1.77) has no
 * `no-restricted-syntax` and no custom-plugin API: its plugins are a fixed set
 * of built-in rule collections. Issue #40 proposed an ESLint rule; that would
 * mean a second linter and a second config for one rule.
 *
 * ---
 *
 * **Rule 1**, in full: a web test that hands a live DOM element to
 * `node:assert` as a value it might have to print.
 *
 * The hazard, from `docs/known-issues.md` and issue #40: `node:assert`'s
 * equality helpers format *both* operands into the failure message, and
 * formatting a live element means deep-inspecting a DOM node. That is slow
 * enough to take the whole file down before it finishes, and it never gets far
 * enough to name the test that failed — it presents as a bare SIGKILL, or as
 * `'test failed'` with no reason, and costs an hour to trace.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';

/** Where rule 1 applies. Server tests have no DOM to hand anyone. */
const TEST_DIR = 'packages/web/test';

/** Where rule 2 applies: the host's own source, which is what holds its queries. */
const HOST_SRC_DIR = 'packages/host/src';

/**
 * Every `node:assert` export that formats its operands into the failure.
 *
 * Keyed on the method name rather than on the callee's object being `assert`,
 * because the import name is not a guarantee — `import { strict as assert }`
 * and `import expect from 'node:assert/strict'` are both this same hazard, and
 * a check that trusted the name would miss them. In a test file, a two-operand
 * `.deepStrictEqual(…)` on a DOM node is not plausibly anything else.
 *
 * `assert.ok` is deliberately absent: it formats nothing, which is why it is
 * the remedy.
 */
const FORMATTING_ASSERTIONS = new Set([
  'equal',
  'strictEqual',
  'notEqual',
  'notStrictEqual',
  'deepEqual',
  'deepStrictEqual',
  'notDeepEqual',
  'notDeepStrictEqual',
]);

/** Testing-library's queries, all of which return elements or arrays of them. */
const SCREEN_QUERY = /^(query|get|find)(All)?By/;

/** DOM-returning methods reachable off any node, not just `screen`. */
const ELEMENT_RETURNING_METHODS = new Set(['querySelector', 'querySelectorAll', 'closest']);

export interface Violation {
  file: string;
  line: number;
  /** The offending operand, as written, so a report can quote it. */
  text: string;
}

/**
 * Strips the wrappers that do not change what `node:assert` ends up printing.
 *
 * `await screen.findByText(…)` prints the element the promise resolved to, and
 * a parenthesised expression prints whatever is inside it. Both have to be
 * seen through, or the two most natural spellings of the hazard slip past.
 */
function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isAwaitExpression(node)) return unwrap(node.expression);
  if (ts.isParenthesizedExpression(node)) return unwrap(node.expression);
  if (ts.isNonNullExpression(node)) return unwrap(node.expression);
  return node;
}

/**
 * Whether this operand's **outermost** expression yields a DOM element.
 *
 * Outermost is the whole distinction. `screen.getByRole('img')` is the hazard;
 * `screen.getByRole('img').getAttribute('src')` is a string and formats for
 * nothing, and the suite is full of the second kind. Testing whether a DOM call
 * appears *anywhere* in the operand would condemn all of them.
 *
 * The method name alone decides it, regardless of what the call is made on.
 * A testing-library query — anything matching `SCREEN_QUERY` — returns an
 * element or a list of them no matter what object it is called on:
 * `within(row).getByRole('img')` and `const q = within(row); q.getByRole(…)`
 * are exactly as hazardous as `screen.getByRole(…)`, because there is no case
 * in this library where `x.getByRole(…)` returns something that is not an
 * element. Gating that on the receiver being the literal identifier `screen`
 * missed both of those shapes.
 */
function yieldsElement(node: ts.Expression): boolean {
  const expression = unwrap(node);

  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    const method = expression.expression.name.text;
    return SCREEN_QUERY.test(method) || ELEMENT_RETURNING_METHODS.has(method);
  }

  // `document.activeElement` — a property read, not a call, and the operand
  // that cost 52 seconds.
  if (ts.isPropertyAccessExpression(expression)) {
    return (
      ts.isIdentifier(expression.expression) &&
      expression.expression.text === 'document' &&
      expression.name.text === 'activeElement'
    );
  }

  return false;
}

/** Every violation in one file's source, in source order. */
export function findViolations(file: string, source: string): Violation[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (FORMATTING_ASSERTIONS.has(node.expression.name.text)) {
        // Only the first two arguments are operands. A third is the message,
        // and nothing formats it as a value.
        for (const argument of node.arguments.slice(0, 2)) {
          if (!yieldsElement(argument)) continue;
          violations.push({
            file,
            line: parsed.getLineAndCharacterOfPosition(argument.getStart(parsed)).line + 1,
            text: unwrap(argument).getText(parsed),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return violations;
}

/**
 * **Rule 2**: a credential column, named in a SQL string, outside the modules
 * allowed to read it.
 *
 * Three columns, from the auth design spec's §4: `auth_account.password` is a
 * password hash, `auth_session.token` is a live session, and `host_state.value`
 * is the host's Better Auth signing secret. A query that selects any of them
 * puts a credential somewhere it can be logged, serialised into a response, or
 * compared in application code that has no business holding it — and none of
 * that shows up as a failing test, because the query works perfectly.
 *
 * It extends the slice-C rule that only `readClientConfig` may select
 * download-client credentials, and it is the same rule with a wider list.
 */
const CREDENTIAL_COLUMNS: readonly { table: string; column: string }[] = [
  { table: 'auth_account', column: 'password' },
  { table: 'auth_session', column: 'token' },
  { table: 'host_state', column: 'value' },
];

/**
 * The modules allowed to name them, **by path rather than by pattern**.
 *
 * A pattern (`**\/auth/*.ts`, say) would silently widen every time a file was
 * added beside one of these, which is the opposite of what an allow-list is
 * for: adding a path here should be a visible decision in a diff.
 *
 * Both entries name files that **do not exist yet** — task 2 writes
 * `db/host-state.ts` and task 3 writes `auth/instance.ts`. That is deliberate
 * and it is why nothing here checks the paths resolve: the allow-list is the
 * one part of this rule written forward, so the check can land before the code
 * it exempts. An entry with no file behind it simply never matches, and a stale
 * entry left behind after a file is deleted grants nothing.
 */
const CREDENTIAL_ALLOW_LIST: readonly string[] = [
  // Persists (and generates) the Better Auth signing secret and the first-boot
  // claim token, so it is the one module that reads `host_state.value`.
  join(HOST_SRC_DIR, 'db', 'host-state.ts'),
  // Constructs `betterAuth()` and hands the Drizzle schema to `drizzleAdapter`,
  // which is what issues every query over `auth_account` and `auth_session`.
  join(HOST_SRC_DIR, 'auth', 'instance.ts'),
];

/**
 * Whether `sql` reads rows *from* `table`, as opposed to declaring it.
 *
 * This is what keeps `migrate.ts` off the allow-list. Migration 12's DDL has
 * to name all three columns — `CREATE TABLE host_state (key …, value …)` is
 * where the column comes from — so a rule that flagged any SQL string
 * mentioning the table and the column would flag the schema that defines them,
 * and exempting `migrate.ts` wholesale would then exempt every query anyone
 * ever added to it. A `CREATE TABLE` or `CREATE INDEX` names the table after
 * `TABLE`/`ON`; a query names it after `FROM`, `JOIN`, `UPDATE` or `INTO`.
 */
function readsFrom(sql: string, table: string): boolean {
  return new RegExp(String.raw`\b(?:from|join|update|into)\s+${table}\b`, 'i').test(sql);
}

/**
 * Which credential columns one SQL string names, as `table.column`.
 *
 * Two spellings, because a violation can be written either way and only
 * catching one would be a check a real query walks straight past:
 *
 * - **Qualified** — `auth_session.token`, or the same through an alias's
 *   table name. Flagged wherever it appears in a string, with no `readsFrom`
 *   test, because no `CREATE` statement is ever written that way.
 * - **Bare, in a query over that table** — `SELECT token FROM auth_session`,
 *   which is how the column would actually be selected, and how
 *   `SELECT s.token FROM auth_session s` reads once the alias is discounted.
 */
function credentialColumnsIn(sql: string): string[] {
  return CREDENTIAL_COLUMNS.filter(({ table, column }) => {
    if (new RegExp(String.raw`\b${table}\s*\.\s*${column}\b`, 'i').test(sql)) return true;
    return (
      readsFrom(sql, table) && new RegExp(String.raw`\b${column}\b`, 'i').test(sql)
    );
  }).map(({ table, column }) => `${table}.${column}`);
}

/**
 * The text a string or template literal contributes to the SQL it becomes.
 *
 * A template's substitutions are dropped and their gaps closed with ` ? `, so
 * the literal chunks read as the statement rather than running together: a
 * `WHERE key = ${KEY}` neither invents a column name at the seam nor loses the
 * `WHERE`. Substituted values are not inspected at all — following one would
 * mean resolving an identifier, and the interesting case (Drizzle's `sql`
 * template, whose substitutions are column *objects*) is the adapter's own
 * code, which is allow-listed.
 */
function sqlTextOf(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ? ');
  }
  return null;
}

/** Every credential column named in a SQL string in one file's source, in source order. */
export function findCredentialViolations(file: string, source: string): Violation[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /* setParentNodes */ true);
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    const sql = sqlTextOf(node);
    if (sql !== null) {
      for (const name of credentialColumnsIn(sql)) {
        violations.push({
          file,
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          text: name,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return violations;
}

/**
 * Rule 2 over a whole directory tree, so the allow-list is applied once and in
 * one place.
 *
 * `dir` and `allowList` are parameters rather than the constants above so the
 * tests can point it at a fixture under a temp directory. A test that edited
 * tracked source to prove a linter works is a test that can leave the tree
 * broken.
 */
export async function findCredentialSelections(
  dir: string,
  allowList: readonly string[] = CREDENTIAL_ALLOW_LIST,
): Promise<Violation[]> {
  const allowed = new Set(allowList);
  const violations: Violation[] = [];
  for (const file of await sourceFiles(dir)) {
    if (allowed.has(file)) continue;
    // eslint-disable-next-line no-await-in-loop -- a few dozen files in a one-shot check; not a hot path
    violations.push(...findCredentialViolations(file, await readFile(file, 'utf8')));
  }
  return violations;
}

/**
 * Every `.ts`/`.tsx` file under `dir`, recursively, in a stable order.
 *
 * Subdirectories are walked concurrently rather than one at a time. There is
 * nothing sequential about reading a directory listing — no shared cursor, no
 * provider to be polite to — so awaiting each one in turn would only be slower.
 * Order does not come from the traversal: it comes from `toSorted` below, so
 * the report reads the same however the walk interleaves.
 *
 * `toSorted` rather than `sort` because `sort` would mutate the array it was
 * handed; here that array is a local and it would not matter, but the habit is
 * worth keeping where the cost is a method name.
 */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
    }),
  );
  return nested.flat().toSorted();
}

/** Rule 1 across `TEST_DIR`, reported. Resolves `true` when the tree is clean. */
async function checkDomAssertions(): Promise<boolean> {
  const files = await sourceFiles(TEST_DIR);
  const violations: Violation[] = [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- a few dozen files in a one-shot check; not a hot path
    violations.push(...findViolations(relative(process.cwd(), file), await readFile(file, 'utf8')));
  }

  if (violations.length === 0) {
    console.log(`test-hygiene: ${files.length} files, no live DOM handed to node:assert`);
    return true;
  }

  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.text} is a live DOM element`);
  }
  console.error(
    `\n${violations.length} assertion(s) hand a live DOM element to node:assert, which formats both\n` +
      "operands on failure. Deep-inspecting a DOM node takes the whole file down without naming the\n" +
      'test that failed. Use `assert.ok(<boolean>, "<message>")`, which formats nothing:\n\n' +
      "  absence:  assert.ok(!screen.queryByText('x'), 'x is gone')\n" +
      "            or the shared `gone()` helper in packages/web/test/dom.ts\n" +
      "  identity: assert.ok(document.activeElement === button, 'the button has focus')\n",
  );
  return false;
}

/** Rule 2 across `HOST_SRC_DIR`, reported. Resolves `true` when the tree is clean. */
async function checkCredentialColumns(): Promise<boolean> {
  const violations = await findCredentialSelections(HOST_SRC_DIR);
  if (violations.length === 0) {
    console.log(`test-hygiene: no credential column named in a SQL string under ${HOST_SRC_DIR}`);
    return true;
  }

  for (const violation of violations) {
    console.error(
      `${relative(process.cwd(), violation.file)}:${violation.line}: ` +
        `SQL naming ${violation.text}, which is a credential`,
    );
  }
  console.error(
    `\n${violations.length} SQL string(s) name a credential column. auth_account.password is a\n` +
      'password hash, auth_session.token is a live session, and host_state.value is this host\'s\n' +
      'Better Auth signing secret — a query that selects one puts it somewhere it can be logged or\n' +
      'serialised into a response, and nothing fails when that happens. Only Better Auth\'s own\n' +
      'adapter and the module that persists the secret may read them; if this file is genuinely\n' +
      'one of those, add its path to CREDENTIAL_ALLOW_LIST in this script.\n',
  );
  return false;
}

async function main(): Promise<void> {
  // Both run, and both report, before the exit code is set: a run that stopped
  // at the first failing rule would hide the second one's findings until the
  // first was fixed.
  const clean = await Promise.all([checkDomAssertions(), checkCredentialColumns()]);
  if (clean.includes(false)) process.exitCode = 1;
}

// Only when run as a script; importing this for its detectors must not walk the
// repo or set an exit code.
if (process.argv[1]?.endsWith('check-test-hygiene.ts') === true) await main();
