import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findViolations } from './check-test-hygiene.ts';

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
