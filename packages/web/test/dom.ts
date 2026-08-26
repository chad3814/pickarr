import { screen } from '@testing-library/react';

/**
 * Absence, as a boolean.
 *
 * The point is the boolean. `assert.equal(screen.queryByText(x), null)` is the
 * obvious spelling of this and it takes the whole file down: `node:assert`
 * formats both operands into the failure message, and formatting a live DOM
 * element means deep-inspecting it. Comparing a boolean hands it nothing to
 * inspect.
 *
 * Four costs measured in this suite, kept here because they are the evidence
 * and they were previously scattered across five copies of this helper:
 *
 * - Inside a `waitFor`, the first check normally fails while the node is still
 *   there, so the inspection runs again on every retry. In `Browse.test.tsx`
 *   that OOM-killed the process — a SIGKILL where a one-second timeout was
 *   expected, with no output naming the test that was running.
 * - In `usePagedList.test.tsx`, 40+ seconds before the run was killed.
 * - Outside a `waitFor` it still burns about 75 seconds and takes the file with
 *   it, naming no test.
 * - The live-node-identity shape — `assert.equal(document.activeElement, …)`,
 *   no `null` and no `queryBy*` anywhere — failed in 52 seconds printing
 *   `'test failed'` with no reason. As `assert.ok(a === b, '…')`: 0.7 seconds,
 *   one named test, reason included.
 *
 * `scripts/check-test-hygiene.ts` enforces this, so the rule no longer depends
 * on anyone remembering it (issue #40). This helper existed five times over in
 * this directory before that check did, in two different signatures — the
 * narrower `string` and the wider `string | RegExp` — which is what five copies
 * of a rule become. The wider one is kept here.
 *
 * For absence by anything other than text, and for comparing two elements,
 * there is no helper and none is wanted: write `assert.ok` directly with a
 * message saying what you meant.
 *
 *     assert.ok(!screen.queryByRole('dialog'), 'the dialog is closed');
 *     assert.ok(document.activeElement === button, 'the button has focus');
 */
export function gone(text: string | RegExp): boolean {
  return screen.queryByText(text) === null;
}
