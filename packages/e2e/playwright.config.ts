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
  retries: 0,
  reporter: process.env['CI'] !== undefined ? 'line' : 'list',
  use: {
    // No `baseURL` here: the harness fixture overrides it per test with the
    // port its own server was actually assigned.
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
});
