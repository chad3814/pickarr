/**
 * No browser spec may declare more step timeout than its whole-test
 * timeout allows.
 *
 * **This exists because the suite shipped three specs that could not
 * honour their own numbers.** Playwright has two independent clocks: a
 * per-assertion `{ timeout }`, and a whole-test timeout which defaults to
 * 30s. A spec that waits on real replication more than once -- seed rows,
 * wait for a count, navigate, wait for cards, act, wait again -- naturally
 * spells 15s or 20s at each wait, and three of ours summed to 50s and 60s.
 * Under a 30s test timeout not one of those bounds was reachable.
 *
 * **It failed in the way that costs the most time to read.** Locally every
 * step takes a second or two, so all three passed, repeatedly. The first
 * CI run after the suite grew killed one mid-click and reported
 * `locator.click: Target page, context or browser has been closed` -- which
 * reads as a browser crash, not as a clock, and points at the step that
 * happened to be running rather than at the spec's budget.
 *
 * So this is a build error rather than something to remember. It compares
 * the numbers in the specs against the number in the config, which is the
 * one comparison neither file can make about itself.
 *
 * **The sum is the right bound, not a pessimistic one.** Every timeout in
 * these specs is on a sequential `await`; none is an alternative to
 * another. A spec whose waits really are exclusive can say so by lowering
 * the individual numbers, which is also the honest thing to do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const E2E_DIR = 'packages/e2e';
const CONFIG = join(E2E_DIR, 'playwright.config.ts');
const SPEC_DIR = join(E2E_DIR, 'tests');

/** `timeout: 90_000` and `timeout: 90000` alike -- the repo writes the first, and a reader may write either. */
const TIMEOUT = /\btimeout:\s*([\d_]+)/g;

function numbersIn(source: string): number[] {
  return [...source.matchAll(TIMEOUT)].map((match) => Number(match[1]?.replaceAll('_', '') ?? '0'));
}

/**
 * The whole-test timeout the config sets.
 *
 * Read rather than hardcoded: a guard that carried its own copy of the
 * number would pass after someone lowered the config and would be exactly
 * the drift it exists to prevent.
 */
async function configuredTestTimeout(): Promise<number> {
  const source = await readFile(CONFIG, 'utf8');
  // The config's *top level* is the only place a whole-test timeout can be
  // set; `use: { ... }` below it holds per-action timeouts that are a
  // different clock. Nothing in this repo's config sets one there, and the
  // assertion below is what notices if that changes.
  const found = numbersIn(source);
  assert.equal(found.length, 1, 'the config sets exactly one timeout; this guard reads that one');
  const [timeout] = found;
  assert.ok(timeout !== undefined && timeout > 0, 'and it is a positive number of milliseconds');
  return timeout;
}

/**
 * Every `test(...)` block in a spec file, as `[title, body]`.
 *
 * Split on a `test(` at the start of a line, which is how every spec in
 * this suite is written. A `test.describe` or an indented `test(` would
 * not be found -- and the count assertion in the test below is what makes
 * that visible rather than silently reducing coverage to zero.
 */
function testBlocks(source: string): { title: string; body: string }[] {
  const blocks: { title: string; body: string }[] = [];
  const starts = [...source.matchAll(/^test\((['"`])(.*?)\1/gm)];
  for (const [index, match] of starts.entries()) {
    const from = match.index;
    const to = starts[index + 1]?.index ?? source.length;
    blocks.push({ title: match[2] ?? '(unnamed)', body: source.slice(from, to) });
  }
  return blocks;
}

test('no browser spec budgets more step timeout than the test timeout allows', async () => {
  const allowed = await configuredTestTimeout();
  const files = (await readdir(SPEC_DIR)).filter((name) => name.endsWith('.spec.ts'));
  assert.ok(files.length > 0, 'the spec directory was found');

  const offenders: string[] = [];
  let scanned = 0;

  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- a handful of files, read in order so a failure names them predictably
    const source = await readFile(join(SPEC_DIR, file), 'utf8');
    const blocks = testBlocks(source);
    scanned += blocks.length;
    for (const { title, body } of blocks) {
      const budget = numbersIn(body).reduce((sum, value) => sum + value, 0);
      if (budget > allowed) {
        offenders.push(`${file}: "${title}" budgets ${String(budget)}ms of ${String(allowed)}ms`);
      }
    }
  }

  // A guard that found no tests would pass forever. The floor is
  // deliberately well below the real count so it does not need editing
  // with every new spec, but high enough that a broken split reddens.
  assert.ok(scanned > 15, `the scan found ${String(scanned)} specs, which is too few to have worked`);
  assert.deepEqual(offenders, [], 'lower the step timeouts, or raise `timeout` in playwright.config.ts');
});
