/**
 * There is no real Playwright config here on purpose.
 *
 * Running `npx playwright test` from the repo root finds this file and would
 * otherwise use it as a default config with no `globalSetup`. That means
 * `packages/e2e/src/global-setup.ts` never runs, the SPA in
 * `packages/web/dist` is never rebuilt, and the suite serves whatever stale
 * bundle happens to be sitting on disk — so a change to markup or CSS that was
 * never rebuilt can still show a green run. That happened twice during the
 * review that added this file: a CSS mutation looked like it had been caught,
 * when the browser had never actually loaded it.
 *
 * The fix is to refuse outright, rather than run something misleading.
 * The real suite lives in `packages/e2e`, with its own config and its own
 * `globalSetup`. Run it with:
 *
 *   npm run e2e
 *
 * which delegates to `npm run e2e -w @pickarr/e2e` and picks up
 * `packages/e2e/playwright.config.ts`.
 */
throw new Error(
  'Do not run Playwright from the repo root: this picks up a default config ' +
    'with no globalSetup, so packages/web/dist is never rebuilt and the suite ' +
    'runs against a stale bundle — tests can pass while the browser never sees ' +
    'your change. Run `npm run e2e` instead (delegates to ' +
    '`npm run e2e -w @pickarr/e2e`, which uses packages/e2e/playwright.config.ts).',
);
