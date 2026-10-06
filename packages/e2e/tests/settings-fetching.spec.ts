import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { test } from '../src/harness-2.ts';

const PASSWORD = 'correct horse battery staple, not a real credential';

async function claimInstall(page: Page, email: string, claimToken: string): Promise<void> {
  await page.getByRole('button', { name: 'First time here? Claim this install' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Claim token').fill(claimToken);
  await page.getByRole('button', { name: 'Claim this install', exact: true }).click();
}

test('a fetch host limit saved on Settings is written to the config file and shown pinned after a reload', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await page.goto(`${harness.origin}/settings`);
  const def = page.getByRole('region', { name: 'Fetching' }).getByRole('listitem', { name: 'Any other host' });
  await expect(def).toBeVisible({ timeout: 10_000 });

  // The default row is always present; pin it to 2 and 45 s.
  await def.getByLabel('In flight').fill('2');
  await def.getByLabel('Timeout (s)').fill('45');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/fetch-hosts/default') && r.request().method() === 'PUT', { timeout: 10_000 });
  await def.getByRole('button', { name: 'Save Any other host', exact: true }).click();
  expect((await saved).status()).toBe(200);

  const written = JSON.parse(await readFile(harness.configPath, 'utf8')) as { fetch: { default: { concurrency: number; timeoutMs: number } } };
  expect(written.fetch.default).toEqual({ concurrency: 2, timeoutMs: 45000 });

  await page.reload();
  await expect(def.getByLabel('Timeout (s)')).toHaveValue('45', { timeout: 10_000 });
});
