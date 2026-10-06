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

test('Retry all counts the unresolved releases, skips the refused one, and reports how many were requeued', async ({ page, harness }) => {
  for (const filename of ['Brazzers.26.10.09.Not.Yet.Out.XXX.1080p-GRP.mkv', 'Some.Show.2026.10.08.Guest.1080p.WEB-GRP.mkv']) {
    await harness.seedUnmatchedRelease({
      filename,
      feedName: 'Nightly indexer',
      lookupState: 'unresolved',
      detail: `the lookup service did not recognise "${filename}"`,
      lookupJson: null,
    });
  }
  await harness.seedUnmatchedRelease({
    filename: 'readme.nfo',
    feedName: 'Nightly indexer',
    lookupState: 'refused',
    detail: 'a sidecar, not a media file',
    lookupJson: null,
  });

  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await page.getByRole('link', { name: 'Unmatched' }).click();

  const button = page.getByRole('button', { name: 'Retry all unresolved (2)' });
  await expect(button).toBeEnabled({ timeout: 15_000 });

  const accepted = page.waitForResponse((r) => r.url().endsWith('/api/unmatched/retry-all') && r.request().method() === 'POST');
  await button.click();
  expect((await accepted).status()).toBe(202);
  await expect(page.getByRole('status', { name: 'Retry all outcome' })).toHaveText('Requeued 2 releases', { timeout: 10_000 });
});
