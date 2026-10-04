/**
 * The grid view (design spec 2026-10-04): a television item browsed by its
 * background, the tile opening the item's card in a dialog, and a pick made
 * from inside that dialog -- the one path a unit test cannot drive, because
 * the pick's status comes back through the host and the replica.
 *
 * Credentials typed here are the repo literals every other spec types
 * (`scripts/check-test-hygiene.ts`, rule 4).
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../src/harness-2.ts';

const PASSWORD = 'correct horse battery staple, not a real credential';
const FILENAME = 'a.show.s01e01.1080p.web-dl.h265-GRP.mkv';

async function claimInstall(page: Page, email: string, claimToken: string): Promise<void> {
  await page.getByRole('button', { name: 'First time here? Claim this install' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Claim token').fill(claimToken);
  await page.getByRole('button', { name: 'Claim this install' }).click();
}

test('a television tile shows the background, opens the card in a dialog, takes a pick, and gives focus back on Escape', async ({ page, harness }) => {
  const { mediaItemId } = await harness.seedPickableRelease({
    pluginId: 'tv',
    title: 'A Show',
    filename: FILENAME,
    lookupState: 'resolved',
    withDownloadClient: true,
  });
  const backgroundId = harness.seedArtwork('background', mediaItemId, 0);

  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  // A deep link with the view in it, the way a bookmark would arrive.
  await page.goto(`${harness.origin}/tv?view=grid`);
  // Scoped to the category: the nav is a list too.
  const grid = page.getByTestId('category-tv').getByRole('list');
  await expect(grid).toHaveAttribute('data-tile', 'background', { timeout: 15_000 });

  const tile = grid.getByRole('button', { name: 'A Show' });
  const image = tile.locator('img');
  await expect(image).toHaveAttribute('src', `/api/artwork/background/${String(backgroundId)}`, { timeout: 15_000 });
  // Real bytes decoded, not merely a src attribute: the route served the file.
  await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);

  // The grid is laid out by `.tiles`, not by the UA's list defaults.
  await expect(grid).toHaveCSS('display', 'grid');

  await tile.click();
  const dialog = page.getByRole('dialog', { name: 'A Show' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /A Show/ })).toBeVisible();

  const pick = dialog.getByRole('button', { name: `Pick ${FILENAME}` });
  await expect(pick).toBeVisible({ timeout: 15_000 });
  await pick.click();

  // Mirrors shell.spec.ts's pick spec: the button's own name changes while
  // the pick is pending, so the settled state is read from the row, which
  // shows the status and no longer offers a Pick button.
  const row = dialog.getByRole('listitem', { name: FILENAME });
  await expect(row).toContainText('Status: submitted', { timeout: 15_000 });
  await expect(row.getByRole('button', { name: /^Pick/ })).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(tile).toBeFocused();
});
