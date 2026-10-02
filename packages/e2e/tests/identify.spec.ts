/**
 * Requery and manual edit, end to end: a real Chromium against the real
 * built SPA and the in-process host (`../src/harness-2.ts`).
 *
 * Editing a release moves it to another title and the host drops the title
 * it left empty; a requery on a matched release is accepted with a 202 and
 * the row reads as looking.
 *
 * No credential is typed anywhere but the claim form, as in `shell.spec.ts`.
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../src/harness-2.ts';

const PASSWORD = 'correct horse battery staple, not a real credential';

/** Claims the install through the real form, as `shell.spec.ts` does. */
async function claimInstall(page: Page, email: string, claimToken: string): Promise<void> {
  await page.getByRole('button', { name: 'First time here? Claim this install' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Claim token').fill(claimToken);
  await page.getByRole('button', { name: 'Claim this install' }).click();
}

test('editing a release moves it to the chosen title and drops the title it left empty', async ({
  page,
  harness,
}) => {
  await harness.seedPickableRelease({
    pluginId: 'tv',
    title: 'A Show',
    filename: 'A.Show.S01E01.mkv',
    lookupState: 'resolved',
    withDownloadClient: false,
  });
  harness.seedMediaItem('tv', 'B Show');
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();
  await page.getByRole('button', { name: 'A Show' }).click();
  await page.getByRole('button', { name: /^Edit A\.Show/ }).click();
  const box = page.getByRole('combobox', { name: 'Title' });
  await box.fill('B Show');
  await page.getByRole('option', { name: 'B Show', exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  // The move reaches the open card live: B's row is touched, so B re-gathers.
  await page.getByRole('button', { name: 'B Show' }).click();
  await expect(page.getByText('A.Show.S01E01.mkv')).toBeVisible({ timeout: 15_000 });
  // The dropped title leaves the list on reload, not live: the category list
  // re-reads on inserts only, and a deletion is not an insert.
  await page.reload();
  await expect(page.getByRole('button', { name: 'B Show' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'A Show' })).toHaveCount(0);
});

test('requery on a matched release is accepted and the line says it is looking', async ({
  page,
  harness,
}) => {
  await harness.seedPickableRelease({
    pluginId: 'tv',
    title: 'A Show',
    filename: 'A.Show.S01E02.mkv',
    lookupState: 'resolved',
    withDownloadClient: false,
  });
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await page.getByRole('button', { name: 'A Show' }).click();
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/identify')),
    page.getByRole('button', { name: /^Requery A\.Show/ }).click(),
  ]);
  expect(response.status()).toBe(202);
  await expect(page.getByText('Looking up…')).toBeVisible({ timeout: 15_000 });
});
