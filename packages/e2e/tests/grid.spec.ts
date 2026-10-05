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

/**
 * A local copy of `shell.spec.ts`'s `borderTopAgainstLineToken`, which is not
 * exported: the computed `border-top-color` of the first element matching
 * the selector, beside `--color-line` resolved through a throwaway element.
 * The token is resolved in the browser rather than spelled as an `rgb(...)`
 * literal because it has a different value in each of `tokens.css`'s two
 * palettes and nothing here pins which one a run is in.
 */
async function borderTopAgainstLineToken(page: Page, selector: string): Promise<{ borderTopColor: string; lineTokenColor: string }> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (element === null) throw new Error(`no element matched ${sel} to read a border colour from`);
    const probe = document.createElement('div');
    probe.style.color = 'var(--color-line)';
    document.body.appendChild(probe);
    const lineTokenColor = getComputedStyle(probe).color;
    probe.remove();
    return { borderTopColor: getComputedStyle(element).borderTopColor, lineTokenColor };
  }, selector);
}

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

  // A regex: the tile's caption is the plugin's, so a tv_release row on the
  // item would prepend the series and the episode number.
  const tile = grid.getByRole('button', { name: /A Show/ });
  const image = tile.locator('img');
  await expect(image).toHaveAttribute('src', `/api/artwork/background/${String(backgroundId)}`, { timeout: 15_000 });
  // Real bytes decoded, not merely a src attribute: the route served the file.
  await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);

  // The grid is laid out by `.tiles`, not by the UA's list defaults.
  await expect(grid).toHaveCSS('display', 'grid');
  // The browse controls stay in reach while the grid scrolls: `library.css`
  // makes the form sticky, which the UA default never does.
  await expect(page.getByRole('search', { name: 'Filter and search' })).toHaveCSS('position', 'sticky');
  // And the tile rules apply: `.tiles button` draws its border with the line
  // token, which a gutted stylesheet would not.
  const { borderTopColor, lineTokenColor } = await borderTopAgainstLineToken(page, '.tiles button');
  expect(borderTopColor).toBe(lineTokenColor);

  await tile.click();
  const dialog = page.getByRole('dialog', { name: /A Show/ });
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

test('an item arriving while the grid is scrolled is held behind "1 new", and the control brings it in at the top', async ({ page, harness }) => {
  // Forty items: more than one page, and tall enough to scroll.
  for (let index = 0; index < 40; index += 1) {
    harness.seedMediaItem('tv', `Show ${String(index + 1).padStart(2, '0')}`);
  }

  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await page.goto(`${harness.origin}/tv?view=grid`);
  const grid = page.getByTestId('category-tv').getByRole('list');
  const first = grid.getByRole('button').first();
  // The tile's `title` attribute is its caption, which for a bare item is the title.
  await expect(first).toHaveAttribute('title', 'Show 40', { timeout: 15_000 });

  await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  harness.seedMediaItem('tv', 'Show 41');
  const control = page.getByRole('button', { name: '1 new' });
  await expect(control).toBeVisible({ timeout: 15_000 });
  await expect(first).toHaveAttribute('title', 'Show 40');

  await control.click();
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 }).toBe(0);
  await expect(grid.getByRole('button').first()).toHaveAttribute('title', 'Show 41', { timeout: 15_000 });
  await expect(control).toBeHidden();
});
