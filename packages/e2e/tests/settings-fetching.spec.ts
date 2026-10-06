import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { test } from '../src/harness-2.ts';

const PASSWORD = 'correct horse battery staple, not a real credential';

async function claimInstall(page: Page, email: string, claimToken: string): Promise<void> {
  await page.getByRole('button', { name: 'First time here? Claim this install' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Claim token').fill(claimToken);
  await page.getByRole('button', { name: 'Claim this install' }).click();
}

test('a fetch host limit saved on Settings is written to the config file and shown pinned after a reload', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await page.goto(`${harness.origin}/settings`);
  const section = page.getByRole('region', { name: 'Fetching' });
  await expect(section.getByRole('listitem', { name: 'Any other host' })).toBeVisible({ timeout: 10_000 });

  // The default row is always present; pin it to 2 and 45 s.
  const def = section.getByRole('listitem', { name: 'Any other host' });
  await def.getByLabel('In flight').fill('2');
  await def.getByLabel('Timeout (s)').fill('45');
  await def.getByRole('button', { name: 'Save Any other host' }).click();
  await expect(def.getByLabel('In flight')).toHaveValue('2', { timeout: 10_000 });

  const written = JSON.parse(await readFile(harness.configPath, 'utf8')) as { fetch: { default: { concurrency: number; timeoutMs: number } } };
  expect(written.fetch.default).toEqual({ concurrency: 2, timeoutMs: 45000 });

  await page.reload();
  const again = page.getByRole('region', { name: 'Fetching' }).getByRole('listitem', { name: 'Any other host' });
  await expect(again.getByLabel('Timeout (s)')).toHaveValue('45', { timeout: 10_000 });
});
