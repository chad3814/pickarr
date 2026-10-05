/**
 * Picking an unmatched release: the Pick button on an unmatched card
 * submits through the feed's plugin exactly as a matched release does, and
 * the download row that comes back replaces the button with its status.
 * Where the file lands afterwards -- the plugin's `_unmatched` directory --
 * is the importer's `unmatchedDestination`, pinned by
 * `packages/host/test/media/import.test.ts`; this spec stops at the status.
 *
 * Credentials typed here are the repo literals every other spec types
 * (`scripts/check-test-hygiene.ts`, rule 4).
 */
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

test('an unmatched release can be picked from its card, and its status takes the button\'s place', async ({ page, harness }) => {
  // A torrent client of the feed's type, created the way the pick spec
  // creates it; the matched release it seeds alongside is not used here.
  await harness.seedPickableRelease({
    pluginId: 'tv',
    title: 'A Show',
    filename: 'a.show.s01e01.1080p.web-dl.h265-GRP.mkv',
    lookupState: 'resolved',
    withDownloadClient: true,
  });
  const filename = 'Never.Recognised.2024.1080p-GROUP.mkv';
  await harness.seedUnmatchedRelease({
    filename,
    feedName: 'Nightly indexer',
    lookupState: 'unresolved',
    detail: `the lookup service did not recognise "${filename}"`,
    lookupJson: null,
  });

  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await page.goto(`${harness.origin}/unmatched`);
  const card = page.getByRole('article');
  await expect(card).toHaveCount(1, { timeout: 15_000 });

  // Named from two strings on screen: its own label and the heading's filename.
  const pick = card.getByRole('button', { name: `Pick ${filename}` });
  await expect(pick).toBeVisible();
  await pick.click();
  await expect(card.getByRole('button', { name: /^Picking…/ })).toBeDisabled();

  await expect(card).toContainText('Status: submitted', { timeout: 15_000 });
  await expect(card.getByRole('button', { name: /^Pick/ })).toHaveCount(0);
});
