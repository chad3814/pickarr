/**
 * Two build-time rules, both parsed rather than pattern-matched, and both for
 * the same reason.
 *
 * 1. **No web test hands a live DOM element to `node:assert`** as a value it
 *    might have to print. See `findViolations`.
 * 2. **No file in a 2.0 source tree names a credential column in a SQL
 *    string, and none reads a credential table through a statement this check
 *    cannot read**, outside an allow-list of paths. The trees are
 *    `CREDENTIAL_SRC_DIRS`, which is the host plus the contract and every
 *    shipped plugin -- a plugin's projections reach a client replica, and a
 *    plugin holds the raw connection. See `findCredentialSelections`.
 * 3. **No host test hands a credential to `node:assert`** as a value it might
 *    have to print. See `findCredentialAssertions`.
 * 4. **No browser spec types anything but a literal committed to this repo
 *    into a credential-shaped field, and nothing from `process.env` into
 *    any field.** Playwright's trace records every typed value in cleartext
 *    and CI uploads it (#92). See `findCredentialFills`.
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
 * The hazard, recorded in `CLAUDE.md` and issue #40: `node:assert`'s
 * equality helpers format *both* operands into the failure message, and
 * formatting a live element means deep-inspecting a DOM node. That is slow
 * enough to take the whole file down before it finishes, and it never gets far
 * enough to name the test that failed — it presents as a bare SIGKILL, or as
 * `'test failed'` with no reason, and costs an hour to trace.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Where rule 1 looks for a package's tests: every workspace package,
 * discovered rather than named one at a time.
 *
 * This used to be the single constant `TEST_DIR = 'packages/web/test'`, and
 * that hardcoding is exactly what let `packages/plugin-ui/test/ReleaseList.test.tsx`
 * go unscanned once the plugin-cards work moved it out of `packages/web/test`
 * -- `npm run test-hygiene` stayed green over a file it never looked at.
 * `test:web`'s own glob widened to `packages/*` for the same move
 * (`package.json`); rule 1 now reaches the same set by walking `packages/`
 * itself, so the two cannot drift apart again. A server-only package's test
 * directory costs one extra directory walk and flags nothing -- there is no
 * DOM in it to hand `node:assert` -- which is cheaper than a second constant
 * someone has to remember to extend.
 */
const PACKAGES_DIR = 'packages';

/** Where rule 2's allow-list paths are rooted, and one of the roots it scans. */
const HOST_SRC_DIR = 'packages/host/src';

/**
 * Every 2.0 source tree rule 2 scans.
 *
 * It began as `packages/host/src` alone, on the reasoning that the host is
 * what holds the queries. That stopped being true when plugins gained
 * `synced` tables: three plugin projections now reach a client replica, and a
 * plugin holds `PluginContext.db` -- the raw connection -- so it can name any
 * column the host can. A rule scanning only the host was a rule with a hole
 * the size of every plugin.
 *
 * **1.x is deliberately out**, and it is the one judgement call here.
 * Measured over every package's `src`: widening to all of them reports
 * exactly two violations, `packages/core/src/config/load.ts` and
 * `packages/web/src/routes/Browse.tsx`, and **neither is SQL** -- both are
 * template literals (`` `Could not read secret for ${field} from ${path}` ``
 * and `` `Releases moved into ${group.display.title}` ``) that rule 2's
 * fail-closed arm cannot resolve and so reports rather than assumes harmless.
 * Admitting them would mean two `CREDENTIAL_ALLOW_LIST` entries exempting
 * files that name no credential column at all, which is exactly the inert
 * entry that list's own doc warns about: it would make the allow-list lie
 * about what it exempts, in frozen code that is going to be deleted.
 *
 * Every tree below reports **zero** violations today, the three plugins
 * included, so this is a tripwire on what gets added rather than a backlog.
 */
const CREDENTIAL_SRC_DIRS: readonly string[] = [
  HOST_SRC_DIR,
  'packages/contract/src',
  'packages/openmetadata/src',
  'packages/plugin-tv/src',
  'packages/plugin-movie/src',
  'packages/plugin-xxx/src',
];

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
 * Four columns, from the auth design spec's §4: `auth_account.password` is a
 * password hash, `auth_session.token` is a live session, `host_state.value`
 * is the host's Better Auth signing secret, and `secret.value` is a third
 * party's credential. A query that selects any of them puts a credential
 * somewhere it can be logged, serialised into a response, or compared in
 * application code that has no business holding it — and none of that shows
 * up as a failing test, because the query works perfectly.
 *
 * It extends the slice-C rule that only `readClientConfig` may select
 * download-client credentials, and it is the same rule with a wider list.
 *
 * **What it reads, and what it cannot.** It resolves a substituted identifier
 * to the string it is bound to in the same file, joins a `+` concatenation,
 * and normalizes a quoted or schema-qualified table name — so the house style
 * for a multi-column select (`SELECT ${COLUMNS} FROM …`) is read as the
 * statement it becomes rather than as `SELECT ? FROM …`, which is how a
 * credential select used to be invisible here. It reads SQL comments as the
 * token separators SQLite treats them as, so a comment between `FROM` and the
 * table does not hide the table. Over a credential table -- **or over a table
 * it could not resolve**, since that may be one -- it then **fails closed**: a
 * `SELECT *`, or a substitution it could not resolve, is a violation demanding
 * a human decision rather than a pass. That second half was the claim this
 * docblock made before it was true: the branch was keyed on the table already
 * resolving, so `` `SELECT token FROM ${aParameter}` `` was reported as
 * nothing at all.
 *
 * Three things it still does not see, all of them stated rather than implied:
 *
 * - **SQL that is never a string in this file.** A Drizzle query-builder
 *   chain (`db.select({ token: authSession.token }).from(authSession)`) names
 *   neither table nor column in any literal, so nothing here can flag it. That
 *   is how Better Auth's adapter reaches these columns from `auth/instance.ts`
 *   -- which is why that file needs no allow-list entry and no longer has one
 *   -- and a new module written that way would pass.
 * - **A statement assembled across files.** Resolution is syntactic and
 *   file-local: an imported constant, a function's return and a parameter are
 *   all unresolvable, which is a violation over a credential table and
 *   silently dropped everywhere else.
 * - **Anything outside `CREDENTIAL_SRC_DIRS`.** That list now covers the host,
 *   the contract and all three shipped plugins, so a plugin holding
 *   `PluginContext.db` is no longer unscanned — but a plugin shipped from
 *   outside this repo is, and that reach is the one `migratePlugin`'s docblock
 *   already records. 1.x is out on purpose; see `CREDENTIAL_SRC_DIRS`.
 */
const CREDENTIAL_COLUMNS: readonly { table: string; column: string }[] = [
  { table: 'auth_account', column: 'password' },
  { table: 'auth_session', column: 'token' },
  { table: 'host_state', column: 'value' },
  { table: 'secret', column: 'value' },
];

/**
 * The modules allowed to name them, **by path rather than by pattern**.
 *
 * A pattern (`**\/auth/*.ts`, say) would silently widen every time a file was
 * added beside one of these, which is the opposite of what an allow-list is
 * for: adding a path here should be a visible decision in a diff.
 *
 * The one entry below named a file that **did not exist when this rule
 * landed** — task 2 wrote `db/host-state.ts` afterwards. That is deliberate and
 * it is why nothing here checks the paths resolve: the allow-list is the one
 * part of this rule written forward, so the check could land before the code it
 * exempts. An entry with no file behind it simply never matches, and a stale
 * entry left behind after a file is deleted grants nothing.
 *
 * **There are now two entries, and both do real work.** `auth/instance.ts` was
 * listed too, on the reasoning that it constructs `betterAuth()` and hands the
 * schema to `drizzleAdapter`. Measured, when `db/host-state.ts` was the only
 * credential reader: with the allow-list emptied, rule 2 over
 * `packages/host/src` reported **4** violations and all four were
 * `db/host-state.ts`; `auth/instance.ts` produced **zero**, because it reaches
 * those columns through the Drizzle adapter and names none of them in any
 * string. So "only the adapter may select these columns" held over every file
 * on the branch on its own merits, and that entry was granting a 442-line file
 * a blanket exemption it never needed — which is the one way this rule can be
 * lost quietly, since a query added to an exempt file is a query nothing
 * reports. Removed. If the adapter is ever bypassed there deliberately, the
 * entry comes back in a diff, which is what this list is for.
 *
 * Task 2 added the second entry, `secrets/store.ts`, the only reader and
 * writer of `secret.value`. With the allow-list emptied today, rule 2 over
 * `packages/host/src` reports **6** violations: the same 4 `host_state.value`
 * plus 2 `secret.value`, one for `store.ts`'s reader and one for its writer.
 *
 * Exported for the test that keeps it honest: dropping any one entry has to
 * produce a violation in that entry's own file, so an inert entry cannot be
 * added back without a test failing. Nothing else in the rule can notice one
 * -- an entry that exempts no violation has no effect to observe.
 */
export const CREDENTIAL_ALLOW_LIST: readonly string[] = [
  // Persists (and generates) the Better Auth signing secret and the first-boot
  // claim token, so it is the one module that reads `host_state.value`.
  join(HOST_SRC_DIR, 'db', 'host-state.ts'),
  // The `secret` table's only reader and writer, so it is the one module that
  // may name `secret.value`.
  join(HOST_SRC_DIR, 'secrets', 'store.ts'),
];

/**
 * The tables holding a credential column, each once — what the fail-closed
 * half of the rule below is keyed on. Derived rather than listed, so a fourth
 * credential column cannot arrive with its table left out of the star and
 * unresolvable cases.
 */
const CREDENTIAL_TABLES: readonly string[] = [
  ...new Set(CREDENTIAL_COLUMNS.map(({ table }) => table)),
];

/**
 * One SQL string as this check reads it.
 *
 * `unresolved` is the half that matters: a statement assembled from something
 * this file cannot follow — a function call, a parameter, a name imported from
 * elsewhere — is *not* a statement that reads no credential, it is a statement
 * whose reading is unknown. Carrying that as a flag rather than silently
 * closing the gap with ` ? ` is what lets the rule fail closed over a
 * credential table instead of passing.
 *
 * **A count rather than a flag, because one unreadable piece is not the same
 * as two.** `unknownTableMark` below distinguishes a statement whose *table*
 * is all this check could not read -- `SELECT id FROM ${table}`, whose column
 * list is right there -- from one where the column list is unreadable too:
 * `SELECT ${columns} FROM ${table}` could be selecting anything from
 * anything, and stays a violation. Every other reader wants the flag, and
 * spells it `> 0`.
 */
interface SqlText {
  /** The statement, with every substitution this check could resolve spliced in. */
  text: string;
  /** How many substitutions could not be resolved, so `text` is an incomplete reading. */
  unresolved: number;
}

/**
 * Every declaration of every `const`-bound name in one file, so an identifier
 * can be followed to what it stands for.
 *
 * **A name is mapped to *every* initializer it is given, not to one.** There is
 * no scope analysis behind this -- it is a syntactic map -- so a name declared
 * in two tests has two candidate values, and the two rules that read this map
 * resolve that differently *because failing closed means opposite things for
 * them*. Rule 2 resolves only a name with exactly one declaration, since a
 * guess that happened to read no credential would let a query pass; rule 3
 * asks whether *any* declaration produces a credential, since a guess that
 * happened to miss would let an assertion print one. Both answers are the
 * cautious one for their own rule, and `first` in
 * `packages/host/test/db/host-state.test.ts` -- a generated signing secret in
 * one test and an open database in another -- is why rule 3 cannot be the
 * first policy: that is the exact operand that printed a secret.
 */
type Bindings = Map<string, ts.Expression[]>;

function collectBindings(parsed: ts.SourceFile): Bindings {
  const bindings: Bindings = new Map();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const declared = bindings.get(node.name.text);
      if (declared === undefined) bindings.set(node.name.text, [node.initializer]);
      else declared.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return bindings;
}

/**
 * The text a node contributes to the SQL it becomes, or `null` for a node that
 * is not a string at all.
 *
 * **Four shapes, and three of them were bypasses.** A credential select
 * written in this repo's own dominant idiom — a column-list constant
 * interpolated into the statement — was invisible to the first version of this
 * rule, which dropped every substitution:
 *
 * ```ts
 * const SESSION_COLUMNS = 'id, user_id, token, expires_at';
 * const SESSION_BY_ID = `SELECT ${SESSION_COLUMNS} FROM auth_session WHERE id = ?`;
 * ```
 *
 * That is how `api/reads.ts` and `clients/rows.ts` are written, so the rule
 * failed silently in the file next door. So:
 *
 * - **A string or a no-substitution template** is its own text.
 * - **A template** splices in each substitution it can resolve, *without*
 *   padding: `SELECT ${COLUMNS} FROM` has to read as one statement, and
 *   `'…auth_' + 'session'` has to read as one table name, or the two ways of
 *   splitting an identifier across a seam both walk past. A substitution that
 *   resolves to nothing becomes ` ? ` — a bound parameter, which is what most
 *   of them are — and sets `unresolved`.
 * - **A `+` concatenation** is both sides joined, provided at least one side
 *   is a string: `a + b` over two numbers is not SQL and must not be read as
 *   an empty statement.
 * - **An identifier** is followed to its `const`, recursively, with `seen`
 *   guarding against a cycle (`const a = b; const b = a` parses).
 *
 * A parenthesised expression and an `as const` are seen through, since
 * neither changes the string.
 */
function sqlTextOf(node: ts.Node, bindings: Bindings, seen: ReadonlySet<string> = new Set()): SqlText | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, unresolved: 0 };
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return sqlTextOf(node.expression, bindings, seen);
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    let unresolved = 0;
    for (const span of node.templateSpans) {
      const substituted = sqlTextOf(span.expression, bindings, seen);
      if (substituted === null) {
        text += ' ? ';
        unresolved += 1;
      } else {
        text += substituted.text;
        unresolved += substituted.unresolved;
      }
      text += span.literal.text;
    }
    return { text, unresolved };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = sqlTextOf(node.left, bindings, seen);
    const right = sqlTextOf(node.right, bindings, seen);
    if (left === null && right === null) return null;
    return {
      text: (left?.text ?? ' ? ') + (right?.text ?? ' ? '),
      unresolved: (left === null ? 1 : left.unresolved) + (right === null ? 1 : right.unresolved),
    };
  }
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return null;
    // Exactly one declaration, or nothing: see `Bindings` for why this rule
    // refuses to pick between two and rule 3 refuses to ignore either.
    const [only, ...rest] = bindings.get(node.text) ?? [];
    if (only === undefined || rest.length > 0) return null;
    return sqlTextOf(only, bindings, new Set([...seen, node.text]));
  }
  return null;
}

/**
 * The same statement with the ways of spelling an identifier that are not the
 * identifier taken off: `"auth_session"`, `` `auth_session` `` and
 * `[auth_session]` are all the same table to SQLite, and a rule that matched
 * only the bare spelling is a rule a quoted table name walks past. The
 * schema qualifier (`main.auth_session`) is handled where the table is
 * matched, since dropping the dot would also drop the qualified *column*
 * form this rule turns on.
 */
function unquoted(sql: string): string {
  return sql.replaceAll(/["`[\]]/g, '');
}

/**
 * The same statement with SQL comments taken out, each replaced by **one
 * space**.
 *
 * `SELECT token FROM /* the sessions *\/ auth_session` read as 0 violations
 * before this existed: `readsFrom` matches the table right after the keyword,
 * and a comment between the two defeated it -- while a newline or a comment
 * before the column list did not, so the shape was unusual *and* silently
 * defeated a build-time rule. SQLite treats a comment as a token separator,
 * which is why it becomes a space rather than nothing: `FROM/*x*\/table`
 * has to read as `FROM table`, and `auth_/*x*\/session` must **not** read as
 * `auth_session`, because to SQLite that is two tokens and a syntax error
 * rather than a table name.
 *
 * `--` runs to the end of its line and the newline is kept, so a statement
 * commented line by line does not collapse into one line.
 *
 * What it does not do: tell a comment from those two character sequences
 * inside a quoted SQL *string literal* (`'a--b'`). Nothing under
 * `packages/host/src` writes one, and getting it wrong in that direction
 * widens what the rule reads rather than narrowing it, which is the safe
 * direction for this rule.
 */
function withoutSqlComments(sql: string): string {
  return sql.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/--[^\n]*/g, ' ');
}

/**
 * A statement as this rule's matchers should read it: comments gone, quoting
 * gone. Every regex below that looks for a table or a select list goes through
 * this rather than through `unquoted` alone.
 */
function normalized(sql: string): string {
  return unquoted(withoutSqlComments(sql));
}

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
 *
 * An optional `schema.` in front of the table is matched too, because
 * `FROM main.auth_session` is the same read as `FROM auth_session` and the
 * first spelling used to pass.
 */
function readsFrom(sql: string, table: string): boolean {
  return new RegExp(
    String.raw`\b(?:from|join|update|into)\s+(?:\w+\s*\.\s*)?${table}\b`,
    'i',
  ).test(normalized(sql));
}

/**
 * Whether the *table* a statement reads from is a substitution this check
 * could not follow -- `` `SELECT token FROM ${t}` `` with `t` a parameter,
 * which `sqlTextOf` renders as `SELECT token FROM  ? `.
 *
 * This is the other half of failing closed, and it was missing: the
 * fail-closed branch is keyed on `readsFrom(sql, table)` for a *known*
 * credential table, so a statement whose table is unknown was not "a query
 * over a credential table" and never reached it -- 0 violations for a query
 * that may well be selecting `auth_session.token`.
 *
 * Keyed on `unresolved` as well as on the shape, so a literal `?` that got
 * there some other way cannot trip it (`FROM ?` is not valid SQLite anyway).
 *
 * **An optional `schema.` in front, for the same reason `readsFrom` has one,
 * and it mattered more here.** `readsFrom` accepted a qualifier and this did
 * not, so `FROM main.${table}` matched neither branch -- and because this
 * predicate gates the *whole* unknown-table arm in `credentialColumnsIn`,
 * nothing inside `unknownTableMark` could fire behind it. Measured, at HEAD
 * and at `3d8cb49` alike: `` `SELECT token FROM main.${table}` `` and
 * `` `SELECT ${columns} FROM main.${table}` `` both passed, the second being
 * the shape `unknownTableMark`'s docblock says is refused.
 *
 * **One hole is left open here deliberately: a table name only *partly*
 * substituted.** `` `SELECT token FROM auth_${kind}` `` renders as
 * `FROM auth_ ? `, and the substitution is not immediately after the keyword,
 * so this returns false and nothing reports it -- even though `${kind}` could
 * be `session` at runtime. Measured, and measured again with the obvious fix:
 * allowing `\w*\s*` in front of the `?` does close it, and it also reports
 * `sync/log.ts`'s `syncTriggerSql` as `?.?`, because
 * `CREATE TRIGGER x AFTER UPDATE ON ${table}` renders as `UPDATE ON  ? ` and
 * `update` is one of the four keywords above. That is a correct, shipped,
 * credential-free DDL string being reported as a possible credential read,
 * and the cost of a rule that reports those is that someone turns the rule
 * off. Named here instead. Closing it properly means telling the DML
 * `UPDATE t SET` from the DDL `AFTER UPDATE ON t`, which this file's regexes
 * cannot do and a SQL parser could.
 */
function readsFromUnknownTable(sql: SqlText): boolean {
  return sql.unresolved > 0
    && /\b(?:from|join|update|into)\s+(?:\w+\s*\.\s*)?\?/i.test(normalized(sql.text));
}

/**
 * Whether the statement has a select list that is `*` — every column,
 * including whichever of them is the credential.
 *
 * A `*` directly after `(` is not a select list: `SELECT count(*) FROM
 * auth_session` reads no column at all, and flagging it would flag
 * `auth/claim.ts`'s own measured-not-to-be-used counterexample. An alias's
 * `s.*` is the same star as a bare one.
 *
 * **Every `SELECT … FROM` pair in the statement, not just the first.** The
 * earlier form read only the text between the first `SELECT` and the first
 * `FROM`, so a star anywhere else walked past. Measured against the
 * unconditional rule at `3d8cb49`, which reported all three:
 *
 * ```
 * `SELECT id FROM media_item WHERE id IN (SELECT * FROM ${t})`
 * `SELECT id FROM media_item UNION ALL SELECT * FROM ${t}`
 * `SELECT id FROM media_item EXCEPT SELECT * FROM ${t}`
 * ```
 *
 * Each reads the credential column if `${t}` is `secret` or `auth_session` at
 * runtime. A literal one -- `SELECT id FROM media_item WHERE id IN (SELECT *
 * FROM secret)` -- passed at *both* revisions, so this closes a pre-existing
 * hole as well as the narrowing's own.
 *
 * **Every `select` keyword is a starting point, rather than every
 * non-overlapping `SELECT … FROM` pair.** A single global `SELECT(.*?)FROM`
 * would consume a nested `SELECT` inside the *outer* statement's list and
 * then resume past it, so the inner one is never read on its own:
 * `` `SELECT (SELECT * FROM ${t}) AS c FROM media_item` `` passed that way,
 * measured, because the outer list reads `(SELECT *` and the star has a `(`
 * in front of it. Scanning from each keyword to the nearest following `from`
 * reads the inner list too.
 *
 * A select list with no `FROM` after it is not examined, and reads no table,
 * so there is nothing there to be a credential.
 *
 * **A star is a select list only where a *column* could stand: at the head of
 * the list, or straight after a comma, optionally qualified by an alias.** It
 * is not the multiplication operator, which an earlier form read as a star
 * because it allowed any whitespace in front -- so
 * `SELECT unixepoch('subsec') * 1000 FROM t` was reported as selecting every
 * column of `t`. Measured on `sync/log.ts`'s seed statement, which is exactly
 * that shape. An operator always has a left operand, and no operand ends in
 * `^` or `,`, which is what the narrower form keys on.
 *
 * **`DISTINCT` and `ALL` stand between the head of the list and the star**, and
 * they are the reason this is not just `(?:^|,)\s*`. Keying on `^` alone made
 * `SELECT DISTINCT * FROM secret` unreported -- measured, along with
 * `SELECT DISTINCT t.*` and `SELECT ALL *`. They are the only two quantifiers
 * SQLite accepts there.
 *
 * **`\b\s*` after the quantifier, not `\s+`: SQLite requires no whitespace
 * and neither may this.** Verified through `node:sqlite` --
 * `SELECT all*FROM secret` and `SELECT distinct*FROM secret` both parse and
 * both return the row, and both passed while the space was required. The
 * `\b` is what still refuses an identifier the quantifier is a prefix of:
 * `SELECT alldata * 2` and `SELECT distinctive * 3` stay unreported, because
 * `all`/`distinct` there is followed by a word character. `SELECT DISTINCT a
 * * b` stays unreported too -- the quantifier is consumed and the star still
 * has an operand in front of it.
 */
function selectsEveryColumn(sql: string): boolean {
  const text = normalized(sql);
  return [...text.matchAll(/\bselect\b/gi)].some((keyword) => {
    const list = /^([\s\S]*?)\bfrom\b/i.exec(text.slice(keyword.index + keyword[0].length))?.[1];
    return list !== undefined && /(?:^|,)\s*(?:(?:distinct|all)\b\s*)?(?:\w+\s*\.\s*)?\*/i.test(list);
  });
}

/**
 * Whether the statement names a credential column by its bare name, whichever
 * table it turns out to read.
 *
 * The keyed-on-table check (`credentialColumnsIn`'s first branch) cannot ask
 * this question of a table it could not resolve, and this is the part of the
 * question that does not need the table: a statement that never writes the
 * word `token`, `password` or `value` is not selecting one of those columns
 * out of *any* table. A column reached through an expression
 * (`substr(token, 1, 4)`) still names it and is still caught.
 */
function namesCredentialColumn(sql: string): boolean {
  const text = normalized(sql);
  return CREDENTIAL_COLUMNS.some(
    ({ column }) => new RegExp(String.raw`\b${column}\b`, 'i').test(text),
  );
}

/**
 * How a statement whose *table* this check could not resolve is unreadable, or
 * `null` when nothing about it could be selecting a credential.
 *
 * **Failing closed on the table alone was too coarse, and this is the
 * narrowing.** The rule's question is whether a credential column is
 * selected. Three answers keep a statement over an unresolved table a
 * violation, and each is a case where that question genuinely cannot be
 * answered:
 *
 * - **A star select.** `SELECT * FROM ${table}` selects whatever columns that
 *   table has, so if it is a credential table it selects the credential.
 * - **A credential column named.** `SELECT token FROM ${table}` selects
 *   `token` from *something*, and the rule does not need to know what.
 * - **More than one unreadable piece.** `SELECT ${columns} FROM ${table}`
 *   leaves both halves unknown, which is the case the coarse rule existed
 *   for. One unreadable piece means the table is the only thing this check
 *   could not read, and the column list beside it is right there in the
 *   source.
 *
 * What that admits, stated rather than left to be discovered: a statement
 * naming a runtime table and selecting only columns that are a credential in
 * no table of this schema. `sync/log.ts`'s log seed is the case it was
 * narrowed for -- `SELECT ?, id, 'upsert', <now> FROM ${table}`, whose one
 * column is `id` -- and there is no way to write it otherwise, because SQLite
 * binds no identifiers and a table's rows cannot be enumerated without naming
 * it after `FROM`. An `INSERT INTO ${table} (a) VALUES (?)` is admitted for
 * the same reason and by the same test: it names column `a`, which is a
 * credential nowhere, so it cannot be writing one by name.
 */
function unknownTableMark(sql: SqlText): string | null {
  if (selectsEveryColumn(sql.text)) return '*';
  if (namesCredentialColumn(sql.text)) return '?';
  return sql.unresolved > 1 ? '?' : null;
}

/**
 * How a statement over a credential table is unreadable, or `null` when it is
 * not: `'*'` for a star select, `'?'` for a substitution this check could not
 * follow. The star is reported in preference to the substitution when a
 * statement manages both, because it is the more specific thing to say.
 */
function unreadableSelectMark(sql: SqlText): string | null {
  if (selectsEveryColumn(sql.text)) return '*';
  if (sql.unresolved > 0) return '?';
  return null;
}

/**
 * Which credential columns one SQL string names, as `table.column` — plus,
 * for a statement this check cannot read, which credential *table* it reads
 * from.
 *
 * Three ways a violation is reported, and the third is the one that makes the
 * rule fail closed:
 *
 * - **Qualified** — `auth_session.token`, or the same through an alias's
 *   table name. Flagged wherever it appears in a string, with no `readsFrom`
 *   test, because no `CREATE` statement is ever written that way.
 * - **Bare, in a query over that table** — `SELECT token FROM auth_session`,
 *   which is how the column would actually be selected, and how
 *   `SELECT s.token FROM auth_session s` reads once the alias is discounted.
 * - **Unreadable, in a query over that table** — `SELECT *`, or a
 *   substitution that could not be resolved. Neither names a credential
 *   column and both may well select one, so each is reported as
 *   `table.*`/`table.?` and has to be answered by a human: either the query
 *   is rewritten to name its columns, or the file is added to
 *   `CREDENTIAL_ALLOW_LIST` deliberately and in a diff. A rule that passed
 *   these would be a rule that passes `SELECT *`, which is already the house
 *   style at two sites in `api/reads.ts`.
 * - **Over a table this check could not resolve at all** — reported as
 *   `?.*`/`?.?`, and narrower than the three above because the table is
 *   unknown rather than known-credential. `unknownTableMark` states which
 *   statements of that shape are still violations and which one it admits.
 *
 * A table that already contributed a named column is not reported a second
 * time for its star, so `SELECT *, token FROM auth_session` reads as one
 * violation and names the column.
 */
function credentialColumnsIn(sql: SqlText): string[] {
  const named = CREDENTIAL_COLUMNS.filter(({ table, column }) => {
    if (new RegExp(String.raw`\b${table}\s*\.\s*${column}\b`, 'i').test(normalized(sql.text))) return true;
    return readsFrom(sql.text, table) && new RegExp(String.raw`\b${column}\b`, 'i').test(sql.text);
  });
  const readable = named.map(({ table, column }) => `${table}.${column}`);
  const unreadable = unreadableSelectMark(sql);
  const unread = unreadable === null ? [] : CREDENTIAL_TABLES
    .filter((table) => readsFrom(sql.text, table) && !named.some((column) => column.table === table))
    .map((table) => `${table}.${unreadable}`);
  // A table this check could not resolve is reported as `?.*` or `?.?`: it may
  // be a credential table, and nothing above can have matched it by name. Only
  // when no credential table was matched either, so a statement that reads a
  // known credential table *and* an unknown one is reported once for the one
  // that can be named -- and only for the statements `unknownTableMark` marks,
  // which is a narrower set than `unreadableSelectMark`'s above precisely
  // because the table is unknown rather than known to hold a credential.
  const unknownMark = readsFromUnknownTable(sql) ? unknownTableMark(sql) : null;
  const unknown = unread.length === 0 && readable.length === 0 && unknownMark !== null
    ? [`?.${unknownMark}`]
    : [];
  return [...readable, ...unread, ...unknown];
}

/**
 * Whether this node is a place a statement is *written*, as opposed to a place
 * one is referred to or a part of one already read.
 *
 * Two ways a node is neither, and both of them reported every violation twice
 * before they were here:
 *
 * - **An identifier is a reference.** `sqlTextOf` follows one to its `const`
 *   so a substituted column list can be spliced in, which means the name on
 *   the left of its own declaration resolves to the statement too. Reporting
 *   there would name the declaration twice and, worse, would report every
 *   later *use* of a constant as a fresh violation.
 * - **A part its parent already composed.** The walk visits every node, and
 *   `sqlTextOf` reads a template and a concatenation through to their pieces —
 *   so the pieces are visited on their own afterwards. A string inside a
 *   *call* is not skipped, because its parent could not resolve it and so
 *   nothing has read it yet.
 */
function writesSqlHere(node: ts.Node): boolean {
  // The source file is the one node with no parent at all -- `parent` is typed
  // as a `Node` but is undefined there, so this is a check and not a formality.
  if (ts.isSourceFile(node)) return false;
  if (ts.isIdentifier(node)) return false;
  const { parent } = node;
  if (ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent)) return false;
  if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) {
    return false;
  }
  return !(ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken);
}

/** Every credential column named in a SQL string in one file's source, in source order. */
export function findCredentialViolations(file: string, source: string): Violation[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /* setParentNodes */ true);
  const bindings = collectBindings(parsed);
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    const sql = writesSqlHere(node) ? sqlTextOf(node, bindings) : null;
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
 * **Rule 3**: a credential handed to `node:assert` as an operand, in a host
 * test.
 *
 * The same mechanism as rule 1 and a different payload. `node:assert`'s
 * equality helpers format *both* operands into the failure message, so
 * `assert.equal(second, first)` over two generated signing secrets prints both
 * of them -- and only on the run where something is already broken, which is
 * the run whose output somebody pastes into an issue or a CI log.
 *
 * **This is the fourth place that shape appeared in one slice**, each time
 * somewhere new: a session token in a mutation's assertion diff, a token in a
 * refusal message, production logging landing in test stdout, and finally the
 * earliest test file in the slice comparing two live secrets. Each was fixed
 * where it was found. A rule is here because "no credential in output" kept
 * needing a new venue, and because the remedy is mechanical:
 * `assert.ok(a === b, '<message>')` formats nothing.
 *
 * What it catches is narrow on purpose: an operand that **is** a call to one
 * of the functions below, or a name bound to one. What it therefore does not
 * catch, stated rather than implied:
 *
 * - a credential reached some other way -- a new helper, a field read off a
 *   response body, a row selected in the test itself. The producer list is a
 *   list, and a name not on it is not seen.
 * - a credential interpolated into a *message*. That is deliberate rather than
 *   accidental, and nothing here formats a message as a value.
 * - `console.log`, which is how slice F's other leak happened. The remedy
 *   there was capturing the console inside the test helper, not a rule.
 */
const CREDENTIAL_PRODUCERS = new Set([
  // `db/host-state.ts`: the signing secret and the claim token, generated or
  // read straight out of `host_state.value`.
  //
  // **`ensureSyncGeneration` is deliberately absent**, though it is that
  // module's third generated value and calls `ensureGeneratedValue` itself.
  // It is not a credential: it is an opaque per-database token served on the
  // body of all three sync routes, so a test printing one leaks nothing a
  // session holder cannot already read. Listing it would force every
  // assertion about a sync response's generation onto `assert.ok`, which
  // formats nothing -- and a rule that hides the value you are debugging, for
  // a value that is published, is the kind of consistency that gets a rule
  // switched off. `SYNC_GENERATION_KEY`'s own doc is where the public/credential
  // split is argued.
  'ensureAuthSecret',
  'ensureGeneratedValue',
  'ensureClaimToken',
  'readHostState',
  // `main.ts`: the signing secret this host will actually sign with, which is
  // `BETTER_AUTH_SECRET` when the operator set it and `ensureAuthSecret`'s row
  // otherwise. A wrapper is not seen through -- only `.toString(...)` is -- so
  // the function that answers "the secret" has to be named here in its own
  // right or the value would stop being tracked the moment a test called the
  // one production code calls.
  'resolveAuthSecret',
  // The primitive under all of them; a test that generates its own is the
  // same hazard as one that asks the host for the host's.
  'randomBytes',
  // A live session, in both spellings these tests use to get one: the
  // `Set-Cookie` off a sign-up response, and the helper that joins them into
  // a `Cookie` header.
  'getSetCookie',
  'cookieHeader',
]);

/** Where rule 3 applies: the only tests that handle one of these values. */
const HOST_TEST_DIR = 'packages/host/test';

/**
 * Whether this operand's **outermost** expression is a credential.
 *
 * Outermost, exactly as in rule 1 and for the same reason: a
 * `getSetCookie().length` is a number and formats for nothing, and there is
 * one of those in `api/server.test.ts` that a rule reading the whole operand
 * would have condemned. An `await`, a parenthesis, an `as`, a `!` and a
 * `.toString(...)` are seen through, since none of those changes the value
 * printed.
 *
 * An identifier is followed to what it was bound to, because that is where the
 * defect actually lived: `assert.equal(second, first)` names no producer at
 * all, and a rule that only read calls would have missed every instance of
 * this in the slice.
 */
function yieldsCredential(node: ts.Expression, bindings: Bindings, seen: ReadonlySet<string> = new Set()): boolean {
  const expression = unwrap(node);
  if (ts.isAsExpression(expression)) return yieldsCredential(expression.expression, bindings, seen);
  if (ts.isCallExpression(expression)) {
    const { expression: callee } = expression;
    // `.toString(...)` is seen through, and it is the one transformation that
    // has to be: `randomBytes(32).toString('base64url')` *is* the secret, and
    // its outermost expression names no producer. Nothing else is followed --
    // a credential put through any other call is not tracked, and a
    // `.length` must stay untracked or the count in `api/server.test.ts`
    // becomes a violation.
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'toString') {
      return yieldsCredential(callee.expression, bindings, seen);
    }
    if (ts.isIdentifier(callee)) return CREDENTIAL_PRODUCERS.has(callee.text);
    return ts.isPropertyAccessExpression(callee) && CREDENTIAL_PRODUCERS.has(callee.name.text);
  }
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return false;
    const declared = bindings.get(expression.text) ?? [];
    const followed = new Set([...seen, expression.text]);
    // *Any* declaration of the name, not the only one: see `Bindings`.
    return declared.some((initializer) => yieldsCredential(initializer, bindings, followed));
  }
  return false;
}

/** Every credential handed to a formatting assertion in one file, in source order. */
export function findCredentialOperands(file: string, source: string): Violation[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, /* setParentNodes */ true);
  const bindings = collectBindings(parsed);
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && FORMATTING_ASSERTIONS.has(node.expression.name.text)) {
      // The first two arguments are the operands; a third is the message.
      for (const argument of node.arguments.slice(0, 2)) {
        if (!yieldsCredential(argument, bindings)) continue;
        violations.push({
          file,
          line: parsed.getLineAndCharacterOfPosition(argument.getStart(parsed)).line + 1,
          text: unwrap(argument).getText(parsed),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return violations;
}

/**
 * Rule 3 over a whole directory tree.
 *
 * `dir` is a parameter rather than the constant above for the reason
 * `findCredentialSelections` gives: the tests point it at a fixture under a
 * temp directory instead of editing tracked source.
 */
export async function findCredentialAssertions(dir: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of await sourceFiles(dir)) {
    // eslint-disable-next-line no-await-in-loop -- a few dozen files in a one-shot check; not a hot path
    violations.push(...findCredentialOperands(file, await readFile(file, 'utf8')));
  }
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

/**
 * Every immediate subdirectory of `root` that has its own `test` directory,
 * sorted.
 *
 * `root` is a parameter, not baked in as `PACKAGES_DIR` directly, for the
 * same reason `findCredentialSelections`'s `dir` is: a test can point this
 * at a fixture under a temp directory rather than at tracked source. A
 * package with no `test` directory yet contributes nothing -- the same
 * treatment `checkCredentialColumns` gives an absent tree in
 * `CREDENTIAL_SRC_DIRS` -- so a package added to the workspace before it has
 * tests does not fail the build over a missing path.
 */
export async function packageTestDirs(root: string = PACKAGES_DIR): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<string | undefined> => {
        const dir = join(root, entry.name, 'test');
        const exists = await stat(dir).then(() => true, () => false);
        return exists ? dir : undefined;
      }),
  );
  return dirs.filter((dir): dir is string => dir !== undefined).toSorted();
}

/** Rule 1 across every package's `test` directory (`packageTestDirs`), reported. Resolves `true` when the tree is clean. */
async function checkDomAssertions(): Promise<boolean> {
  const dirs = await packageTestDirs();
  const files = (await Promise.all(dirs.map((dir) => sourceFiles(dir)))).flat().toSorted();
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

/**
 * Rule 2 across every tree in `CREDENTIAL_SRC_DIRS`, reported. Resolves
 * `true` when all of them are clean.
 *
 * A missing tree is not an error: `findCredentialSelections` walks a
 * directory, and a package added to the list before its `src` exists -- or
 * one deleted afterwards -- should not fail the build over a path. An absent
 * tree simply contributes nothing, the same way a stale
 * `CREDENTIAL_ALLOW_LIST` entry grants nothing.
 */
async function checkCredentialColumns(): Promise<boolean> {
  const perDir = await Promise.all(
    CREDENTIAL_SRC_DIRS.map(async (dir) => {
      try {
        return await findCredentialSelections(dir);
      } catch {
        return [];
      }
    }),
  );
  const violations = perDir.flat();
  if (violations.length === 0) {
    console.log(
      `test-hygiene: no credential column named in a SQL string under ` +
        `${CREDENTIAL_SRC_DIRS.length} source trees`,
    );
    return true;
  }

  for (const violation of violations) {
    console.error(
      `${relative(process.cwd(), violation.file)}:${violation.line}: ` +
        `SQL naming ${violation.text}, which is a credential`,
    );
  }
  console.error(
    `\n${violations.length} SQL string(s) read a credential column, or read a credential table in a\n` +
      'statement this check cannot read. auth_account.password is a password hash,\n' +
      'auth_session.token is a live session, host_state.value is this host\'s Better Auth\n' +
      'signing secret, and secret.value is a third party\'s credential — a query that selects one\n' +
      'puts it somewhere it can be logged or serialised into a response, and nothing fails when\n' +
      'that happens. A `table.*` above is a star select and a `table.?` is a substitution this\n' +
      'check could not resolve; a `?.` names a table it could not resolve either, which may be a\n' +
      'credential table. None of those names a credential and each may select one, so each is\n' +
      'reported rather than assumed harmless. Name the columns the query actually needs; or, if\n' +
      'this module is genuinely the one that may read a credential, add its path to\n' +
      'CREDENTIAL_ALLOW_LIST in this script.\n',
  );
  return false;
}

/** Rule 3 across `HOST_TEST_DIR`, reported. Resolves `true` when the tree is clean. */
async function checkCredentialAssertions(): Promise<boolean> {
  const violations = await findCredentialAssertions(HOST_TEST_DIR);
  if (violations.length === 0) {
    console.log(`test-hygiene: no credential handed to node:assert under ${HOST_TEST_DIR}`);
    return true;
  }

  for (const violation of violations) {
    console.error(
      `${relative(process.cwd(), violation.file)}:${violation.line}: ` +
        `${violation.text} is a credential`,
    );
  }
  console.error(
    `\n${violations.length} assertion(s) hand a credential to node:assert, which formats both\n` +
      'operands into the failure message — so the run where this breaks is the run that prints a\n' +
      'signing secret, a claim token or a live session cookie into whatever captures the output.\n' +
      'Use `assert.ok(<boolean>, "<message>")`, which formats nothing, and let the message name\n' +
      'the property instead of the values:\n\n' +
      "  assert.ok(second === first, 'the second call minted a new secret')\n",
  );
  return false;
}


/**
 * **Rule 4**: where the browser specs live. Only this tree types into forms
 * a trace records; the harness under `packages/e2e/src` seeds the database
 * directly and never drives a page.
 */
const E2E_TEST_DIR = 'packages/e2e/tests';

/**
 * A form field whose label says it takes a credential. Matched against the
 * accessible name a locator was built from -- `getByLabel`, `getByPlaceholder`
 * or `getByRole`'s `name` -- case-insensitively, so `Api key` and `API Key`
 * are the same field.
 */
const CREDENTIAL_LABEL = /password|passphrase|token|secret|api[ -]?key/i;

/**
 * Credential-shaped labels a spec may fill from something other than a
 * literal, each with the reason it is not a credential anyone holds.
 *
 * Exported for the test that keeps it honest: dropping an entry has to
 * produce a violation in the real tree, so an entry nothing needs cannot
 * stay.
 */
export const CREDENTIAL_FIELD_ALLOW_LIST: readonly string[] = [
  // Minted per run by the harness for a throwaway in-process install and
  // dead with it, so the trace that records it records nothing reusable.
  // Every spec types it through a `claimInstall` helper's parameter, which
  // is the one non-literal shape this rule has to let through.
  'Claim token',
];

/**
 * Whether `node` reads `process.env`, anywhere inside it. `process.env.X`,
 * `process.env['X']` and `process.env['X'] ?? ''` all count; so does a
 * `const` the expression reaches, one level down, since `const key =
 * process.env['K']; fill(key)` is the same leak with a name in between.
 */
function readsEnv(node: ts.Node, bindings: Bindings, seen: ReadonlySet<string> = new Set()): boolean {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  ) {
    return true;
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    const declared = bindings.get(node.text) ?? [];
    const next = new Set([...seen, node.text]);
    if (declared.some((initializer) => readsEnv(initializer, bindings, next))) return true;
  }
  return ts.forEachChild(node, (child) => (readsEnv(child, bindings, seen) ? true : undefined)) === true;
}

/**
 * Whether what a spec types is a string literal committed to this repo: the
 * literal itself, or an identifier every one of whose declarations is a
 * `const` initialised to one. A parameter has no declaration this map can
 * see, a `let` can be reassigned, and a template with a substitution or a
 * property read is built at run time -- none of those is a literal in git.
 */
function isRepoLiteral(node: ts.Expression, bindings: Bindings, seen: ReadonlySet<string> = new Set()): boolean {
  const expression = unwrap(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return true;
  if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
    const declared = bindings.get(expression.text);
    if (declared === undefined) return false;
    const next = new Set([...seen, expression.text]);
    return declared.every(
      (initializer) =>
        ts.isVariableDeclaration(initializer.parent) &&
        (initializer.parent.parent.flags & ts.NodeFlags.Const) !== 0 &&
        isRepoLiteral(initializer, bindings, next),
    );
  }
  return false;
}

/**
 * Every accessible name a locator chain was built from, outermost call
 * first. `page.getByLabel('Api key')` yields one; a `const row = …` the
 * chain starts from is followed to its declarations, and each of them
 * contributes, so a name declared twice is checked against both -- the
 * fail-closed reading, since a guess that happened to be the harmless
 * declaration would let a credential through.
 */
function labelsOf(node: ts.Expression, bindings: Bindings, seen: ReadonlySet<string> = new Set()): string[] {
  const expression = unwrap(node);
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    const method = expression.expression.name.text;
    const [first, second] = expression.arguments;
    const here: string[] = [];
    if ((method === 'getByLabel' || method === 'getByPlaceholder') && first !== undefined) {
      const text = sqlTextOf(first, bindings);
      if (text !== null && text.unresolved === 0) here.push(text.text);
    }
    if (method === 'getByRole' && second !== undefined && ts.isObjectLiteralExpression(second)) {
      for (const property of second.properties) {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'name') {
          const text = sqlTextOf(property.initializer, bindings);
          if (text !== null && text.unresolved === 0) here.push(text.text);
        }
      }
    }
    return [...here, ...labelsOf(expression.expression.expression, bindings, seen)];
  }
  if (ts.isPropertyAccessExpression(expression)) return labelsOf(expression.expression, bindings, seen);
  if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
    const next = new Set([...seen, expression.text]);
    return (bindings.get(expression.text) ?? []).flatMap((initializer) => labelsOf(initializer, bindings, next));
  }
  return [];
}

/**
 * Rule 4 over one file: every `.fill(value)` that types a non-literal into a
 * credential-shaped field, and every `.fill(value)` that types anything
 * from `process.env` into any field.
 *
 * **Why a mechanism and not the paragraph it replaces.** `shell.spec.ts`'s
 * module docblock measured the download client api key thirteen times in
 * one `trace.zip` -- the `fill` action's parameters, the log line, two DOM
 * snapshots with the password input's `value`, the step title and the POST
 * body -- and `ci.yml` uploads that archive for 7 days. The value is a
 * literal in git, so nothing real escaped. The protection was a sentence:
 * "every credential this suite types must be a repo literal." A spec that
 * reads one from `process.env`, which is the obvious thing to write against
 * a real service, would have published it for a week with nothing to object
 * (#92). Now this objects.
 *
 * **Two shapes, because the label match is not enough on its own.** A field
 * labelled `Address` or `Feed url` is not credential-shaped, and a spec
 * that typed `process.env['STAGING_URL']` into it would be pointing the
 * suite at a real instance -- the second half of the hazard the docblock
 * names. So an env read fails on any field, and a non-literal fails on a
 * credential-shaped one.
 *
 * The violation's `text` is the typed expression and the field it went
 * into, so the report can name both without printing a value: the
 * expression is source text, never what it evaluated to.
 */
export function findCredentialFills(file: string, source: string): Violation[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = collectBindings(parsed);
  const allowed = new Set(CREDENTIAL_FIELD_ALLOW_LIST);
  const violations: Violation[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'fill' &&
      node.arguments.length > 0
    ) {
      const [value] = node.arguments;
      if (value === undefined) return;
      const labels = labelsOf(node.expression.expression, bindings);
      const credentialField = labels.find((label) => CREDENTIAL_LABEL.test(label) && !allowed.has(label));
      const line = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
      if (readsEnv(value, bindings)) {
        violations.push({ file, line, text: `${value.getText(parsed)} (from process.env) into ${labels[0] ?? 'a field'}` });
      } else if (credentialField !== undefined && !isRepoLiteral(value, bindings)) {
        violations.push({ file, line, text: `${value.getText(parsed)} into ${credentialField}` });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return violations;
}

/**
 * Rule 4 over a whole directory tree. `dir` is a parameter for the reason
 * `findCredentialSelections` gives: the tests point it at a fixture.
 */
export async function findCredentialFillsIn(dir: string): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of await sourceFiles(dir)) {
    // eslint-disable-next-line no-await-in-loop -- a handful of spec files in a one-shot check; not a hot path
    violations.push(...findCredentialFills(file, await readFile(file, 'utf8')));
  }
  return violations;
}

/** Rule 4 across `E2E_TEST_DIR`, reported. Resolves `true` when the tree is clean. */
async function checkCredentialFills(): Promise<boolean> {
  const violations = await findCredentialFillsIn(E2E_TEST_DIR);
  if (violations.length === 0) {
    console.log(`test-hygiene: every credential typed under ${E2E_TEST_DIR} is a literal in this repo`);
    return true;
  }

  for (const violation of violations) {
    console.error(`${relative(process.cwd(), violation.file)}:${violation.line}: types ${violation.text}`);
  }
  console.error(
    `\n${violations.length} browser spec fill(s) type a value that is not a literal committed to this repo\n` +
      'into a credential-shaped field, or type something read from process.env into any field.\n' +
      "Playwright's trace records every typed value in cleartext -- the action's parameters, the\n" +
      "DOM snapshot's password `value`, the request body -- and CI uploads test-results/ for 7\n" +
      'days, so a real credential typed here is published on the first red build. Type a string\n' +
      'literal, or a `const` bound to one, and let the harness fake the service behind it. A\n' +
      'field that genuinely takes a per-run throwaway value goes in CREDENTIAL_FIELD_ALLOW_LIST\n' +
      'in this script, with the reason.\n',
  );
  return false;
}

async function main(): Promise<void> {
  // All four run, and all four report, before the exit code is set: a run
  // that stopped at the first failing rule would hide the others' findings
  // until the first was fixed.
  const clean = await Promise.all([
    checkDomAssertions(),
    checkCredentialColumns(),
    checkCredentialAssertions(),
    checkCredentialFills(),
  ]);
  if (clean.includes(false)) process.exitCode = 1;
}

// Only when run as a script; importing this for its detectors must not walk the
// repo or set an exit code.
if (process.argv[1]?.endsWith('check-test-hygiene.ts') === true) await main();
