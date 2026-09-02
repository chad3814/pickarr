import { readFile } from 'node:fs/promises';
import { expect, test } from '../src/harness.ts';

/**
 * Three end-to-end checks for the Settings tab: that an edit made through the
 * form actually lands in `config.json`, that the nav visually separates
 * Settings from the library tabs, and that the backup button hands back a
 * real SQLite file rather than an empty or truncated stream.
 *
 * Restart is deliberately not exercised here: `POST /api/restart` firing
 * `requestRestart()` would tear down the very server this suite is driving.
 * That call happening exactly once is covered by a unit test instead — see
 * `packages/core/test/http/server.test.ts`.
 */

test('a config edit reaches the file on disk', async ({ page, harness }) => {
  await page.goto('/settings');
  const trash = page.getByLabel(/trash directory/i);
  await expect(trash).toBeVisible();

  await trash.fill('/data/trash-e2e');
  await page.getByRole('button', { name: /^save$/i }).click();

  await expect(page.getByText(/still running the settings it booted with/i)).toBeVisible();

  const written = JSON.parse(await readFile(harness.configPath, 'utf8')) as { trashDir: string };
  expect(written.trashDir).toBe('/data/trash-e2e');
});

test('the nav separates Settings from the library tabs', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation');

  // Was `toContainText('Failed—Settings')` while the divider was an em dash. A
  // rule contributes no text, so the property has to be stated as geometry
  // instead: the divider sits below the last library tab and above Settings in
  // a column that now stacks. That is a stronger claim than the text match ever
  // made, which would have passed with the divider anywhere the two labels
  // stayed adjacent. `Dismissed` is that last library tab now that Failed is
  // gone; the geometry under test is unchanged.
  const rule = nav.locator('hr.nav-separator');
  await expect(rule).toBeVisible();

  const dismissed = await nav.getByRole('link', { name: 'Dismissed' }).boundingBox();
  const settings = await nav.getByRole('link', { name: 'Settings' }).boundingBox();
  const divider = await rule.boundingBox();
  expect(dismissed).not.toBeNull();
  expect(settings).not.toBeNull();
  expect(divider).not.toBeNull();
  expect(divider!.y).toBeGreaterThan(dismissed!.y);
  expect(settings!.y).toBeGreaterThan(divider!.y);
});

test('the database downloads as a real SQLite file', async ({ page }) => {
  await page.goto('/settings');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /back up/i }).click();

  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/^pickarr-\d{4}-\d{2}-\d{2}\.db$/);
  const path = await saved.path();
  if (path === null) throw new Error('download produced no local path');

  const bytes = await readFile(path);
  // A truncated or empty download would fail this: the SQLite header is 16
  // bytes and the magic string alone is the first 15 of them, so there is no
  // way to pass this check without every one of those bytes present.
  expect(bytes.length).toBeGreaterThanOrEqual(16);
  expect(bytes.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
});
