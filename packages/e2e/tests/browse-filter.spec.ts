/**
 * Browse filter and search, end to end: a real Chromium against the real
 * built SPA and the in-process host (`../src/harness-2.ts`).
 *
 * Picking a release writes a download row; the Unpicked filter then has to
 * hide the item through the replica's catalog, and the search term has to
 * survive a reload through the URL.
 *
 * No credential is typed anywhere but the claim form, as in `shell.spec.ts`.
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../src/harness-2.ts';

const PASSWORD = 'correct horse battery staple, not a real credential';
const A_FILENAME = 'A.Show.S01E01.1080p.mkv';
const B_FILENAME = 'B.Show.S01E01.mkv';

/** Claims the install through the real form, as `shell.spec.ts` does. */
async function claimInstall(page: Page, email: string, claimToken: string): Promise<void> {
  await page.getByRole('button', { name: 'First time here? Claim this install' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Claim token').fill(claimToken);
  await page.getByRole('button', { name: 'Claim this install' }).click();
}

test('the Unpicked filter hides a picked item, search narrows by filename, and the term survives a reload', async ({
  page,
  harness,
}) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await harness.seedPickableRelease({
    pluginId: 'tv',
    title: 'A Show',
    filename: A_FILENAME,
    lookupState: 'resolved',
    withDownloadClient: true,
  });
  await harness.seedPickableRelease({
    pluginId: 'tv',
    title: 'B Show',
    filename: B_FILENAME,
    lookupState: 'resolved',
    withDownloadClient: false,
  });

  await page.getByRole('link', { name: 'TV' }).click();
  await expect(page.getByRole('button', { name: 'B Show' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'A Show' }).click();
  await page.getByRole('button', { name: `Pick ${A_FILENAME}` }).click();

  // Wait for the download row to reach the replica before filtering on it:
  // the status text only renders once it has.
  await expect(page.getByRole('listitem', { name: A_FILENAME })).toContainText('Status: submitted', {
    timeout: 15_000,
  });

  // `click` and not `check`: the radio is controlled and its state follows
  // the URL, so it flips a render after the click, and `check` reads it
  // back at once and reports that the click changed nothing.
  await page.getByRole('radio', { name: 'Unpicked' }).click();
  await expect(page.getByRole('radio', { name: 'Unpicked' })).toBeChecked();
  await expect(page).toHaveURL(/filter=unpicked/);
  await expect(page.getByRole('button', { name: 'B Show' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'A Show' })).toHaveCount(0, { timeout: 5_000 });

  await page.getByRole('radio', { name: 'All' }).click();
  await expect(page.getByRole('radio', { name: 'All' })).toBeChecked();
  await expect(page).not.toHaveURL(/filter=/);
  await page.getByRole('searchbox', { name: 'Search' }).fill('A.Show.S01E01');
  await expect(page).toHaveURL(/q=A\.Show\.S01E01/);
  await expect(page.getByRole('button', { name: 'A Show' })).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'B Show' })).toHaveCount(0, { timeout: 5_000 });

  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue('A.Show.S01E01');
  await expect(page.getByRole('button', { name: 'A Show' })).toBeVisible({ timeout: 15_000 });
});
