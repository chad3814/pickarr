/**
 * Fails the build when a web test hands a live DOM element to `node:assert` as
 * a value it might have to print.
 *
 * The hazard, from `docs/known-issues.md` and issue #40: `node:assert`'s
 * equality helpers format *both* operands into the failure message, and
 * formatting a live element means deep-inspecting a DOM node. That is slow
 * enough to take the whole file down before it finishes, and it never gets far
 * enough to name the test that failed — it presents as a bare SIGKILL, or as
 * `'test failed'` with no reason, and costs an hour to trace.
 *
 * Enforced here rather than by the linter because `oxlint` (1.77) has no
 * `no-restricted-syntax` and no custom-plugin API: its plugins are a fixed set
 * of built-in rule collections. Issue #40 proposed an ESLint rule; that would
 * mean a second linter and a second config for one rule.
 *
 * Parsed rather than pattern-matched, and that is not fastidiousness. The web
 * suite *documents* this hazard by quoting the forbidden call: twenty-two
 * comment lines contain it verbatim, fourteen of them in one file. A
 * text-matching check reports every one of those as a violation. An AST walk
 * cannot see a comment at all.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';

/** Where the rule applies. Server tests have no DOM to hand anyone. */
const TEST_DIR = 'packages/web/test';

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
 */
function yieldsElement(node: ts.Expression): boolean {
  const expression = unwrap(node);

  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    const callee = expression.expression;
    const method = callee.name.text;
    if (ts.isIdentifier(callee.expression) && callee.expression.text === 'screen') {
      return SCREEN_QUERY.test(method);
    }
    return ELEMENT_RETURNING_METHODS.has(method);
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
async function testFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return testFiles(path);
      return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
    }),
  );
  return nested.flat().toSorted();
}

async function main(): Promise<void> {
  const files = await testFiles(TEST_DIR);
  const violations: Violation[] = [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- a few dozen files in a one-shot check; not a hot path
    violations.push(...findViolations(relative(process.cwd(), file), await readFile(file, 'utf8')));
  }

  if (violations.length === 0) {
    console.log(`test-hygiene: ${files.length} files, no live DOM handed to node:assert`);
    return;
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
  process.exitCode = 1;
}

// Only when run as a script; importing this for its `findViolations` must not
// walk the repo or set an exit code.
if (process.argv[1]?.endsWith('check-test-hygiene.ts') === true) await main();
