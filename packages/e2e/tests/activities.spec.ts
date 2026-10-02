/**
 * The Activities page, end to end: a real Chromium against the real built SPA
 * and the in-process host (`../src/harness-2.ts`).
 *
 * No credential is typed anywhere but the claim form, as in `shell.spec.ts`.
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../src/harness-2.ts';

const PASSWORD = 'correct horse battery staple, not a real credential';
const RELEASE_FILENAME = 'a.movie.2026.1080p.web-dl.h265-GRP.mkv';

/** Claims the install through the real form, as `shell.spec.ts` does. */
async function claimInstall(page: Page, email: string, claimToken: string): Promise<void> {
  await page.getByRole('button', { name: 'First time here? Claim this install' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Claim token').fill(claimToken);
  await page.getByRole('button', { name: 'Claim this install' }).click();
}

test('Activities shows a waiting or running reconcile job for a seeded client, and a download in progress', async ({
  page,
  harness,
}) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await harness.seedPickableRelease({
    pluginId: 'movie',
    title: 'A Movie',
    filename: RELEASE_FILENAME,
    lookupState: 'resolved',
    withDownloadClient: true,
  });

  // Pick through the real button, as the picks spec does.
  await page.getByRole('link', { name: 'Movies' }).click();
  const disclosure = page.getByRole('button', { name: 'A Movie' });
  await expect(disclosure).toBeVisible({ timeout: 15_000 });
  await disclosure.click();
  await page.getByRole('button', { name: `Pick ${RELEASE_FILENAME}` }).click();
  await expect(page.getByRole('listitem', { name: RELEASE_FILENAME })).toContainText('Status: submitted', {
    timeout: 15_000,
  });

  await page.getByRole('link', { name: 'Activities' }).click();
  await expect(page.getByRole('heading', { name: 'Activities' })).toBeVisible();

  // Adding a client schedules its reconcile; at a 10 s cadence it is nearly always waiting.
  await expect(page.getByText(/reconcile/).first()).toBeVisible({ timeout: 5_000 });

  const downloads = page.getByRole('list', { name: 'downloads in progress' });
  await expect(downloads).toContainText(RELEASE_FILENAME, { timeout: 5_000 });
});
