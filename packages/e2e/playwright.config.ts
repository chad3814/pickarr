import { defineConfig, devices } from '@playwright/test';

/**
 * Chromium only, deliberately. The bugs this suite exists for are contract
 * bugs between the client and the server — a browser matrix would multiply the
 * runtime without touching the thing under test.
 *
 * There is no `webServer` here, and that is not a leftover from an empty
 * suite: `packages/e2e/tests/shell.spec.ts`'s five specs are live and run on
 * every `npm run e2e`. Each one boots its own in-process host on its own
 * ephemeral port (`../src/harness-2.ts`'s `harness` fixture), so there is no
 * one static server this config could start and hand a fixed port to — a
 * `webServer` entry names one address for the whole run, and this suite
 * needs a fresh one per test.
 */
export default defineConfig({
  testDir: './tests',
  // Builds the SPA once for the whole run. Per test it would dominate; the
  // built bundle is immutable for the duration of a run, so once is enough.
  globalSetup: './src/global-setup.ts',
  fullyParallel: true,
  forbidOnly: process.env['CI'] !== undefined,
  // Retries stay at zero: a retry that turns red into green hides a flake
  // instead of reporting it, and this suite was measured stable across 104
  // executions including deliberate CPU contention.
  retries: 0,
  // In CI, `line` keeps the log readable while `html` writes the report that
  // the workflow uploads on failure — without it there is nothing to upload
  // and the trace below can only be read by unzipping it by hand.
  reporter:
    process.env['CI'] !== undefined
      ? [['line'], ['html', { open: 'never' }]]
      : 'list',
  use: {
    // No `baseURL` here, for the same reason there is no `webServer` above:
    // each test's origin is a different ephemeral port, minted by that
    // test's own `harness` fixture, not one address the whole run shares.
    // Specs navigate via `harness.origin` instead.
    //
    // `retain-on-failure`, not `on-first-retry`: with `retries: 0` there is
    // never a first retry, so `on-first-retry` captured nothing, ever. A
    // failure in CI happens on a machine nobody can log into, so the trace and
    // the screenshot are the only evidence that survives it.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
});
