/**
 * **Several images per kind, end to end.** A media item with two `poster`
 * rows shows the rank-0 one in its detail section, and the gallery steps to
 * the rank-1 one. The browser addresses each by its row id,
 * `/api/artwork/poster/<posterId>`, so the `src` assertions below are what
 * prove the replica carried the ids and ranks (and no `url`) and that
 * `gather` ordered by rank.
 *
 * Both rows point at the same file (`Harness.seedPoster`), so serving is
 * the same for either; the distinction under test is the address.
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../src/harness-2.ts';

const PASSWORD = 'correct horse battery staple, not a real credential';

/** Claims the install through the real form, the same way `shell.spec.ts`'s own helper does. */
async function claimInstall(page: Page, email: string, claimToken: string): Promise<void> {
  await page.getByRole('button', { name: 'First time here? Claim this install' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Claim token').fill(claimToken);
  await page.getByRole('button', { name: 'Claim this install' }).click();
}

test('a card shows its top-ranked poster and the gallery steps to the second one', async ({ page, harness }) => {
  const { mediaItemId, posterId } = harness.seedTvRelease({
    title: 'A Show',
    seriesTitle: 'A Show',
    seasonNumber: 1,
    episodeNumber: 1,
    withPoster: true,
  });
  if (posterId === undefined) throw new Error('withPoster: true returned no poster id');
  const second = harness.seedPoster(mediaItemId, 1);

  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await page.getByRole('button', { name: /A Show/ }).click();

  const poster = page.locator('.details .poster img');
  await expect(poster).toHaveAttribute('src', `/api/artwork/poster/${String(posterId)}`, { timeout: 15_000 });

  await page.locator('.details .poster').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('img')).toHaveAttribute('src', `/api/artwork/poster/${String(posterId)}`);
  await dialog.getByRole('button', { name: 'Next image' }).click();
  await expect(dialog.locator('img')).toHaveAttribute('src', `/api/artwork/poster/${String(second)}`);
  await expect(dialog.getByText(/2 of \d+/)).toBeVisible();
});
