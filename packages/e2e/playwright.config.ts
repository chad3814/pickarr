import { defineConfig, devices } from '@playwright/test';

/**
 * Chromium only, deliberately. The bugs this suite exists for are contract
 * bugs between the client and the server — a browser matrix would multiply the
 * runtime without touching the thing under test.
 *
 * There is no `webServer` here: each test gets its own server on its own
 * ephemeral port against its own database, started by the `harness` fixture in
 * `src/harness.ts`. A shared server would mean shared rows, and a suite whose
 * whole point is isolating a cause cannot have tests that fail each other.
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
    // No `baseURL` here: the harness fixture overrides it per test with the
    // port its own server was actually assigned.
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
