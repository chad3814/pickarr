import { expect, test } from '../src/harness.ts';

/**
 * The split view's layout, in a real browser rather than on paper.
 *
 * Nothing in the unit suite can answer any of the three things this test
 * covers: happy-dom lays nothing out, so `.app`'s width and a listbox row's
 * actual selected appearance are both unmeasurable there, and its keyboard
 * handling is the part phase 1.8 found a real focus bug in that only a real
 * browser saw (`GroupList.tsx`'s roving `tabIndex` relies on the browser's own
 * focus model, which happy-dom does not implement).
 *
 * Two groups, distinct enough that the master list's two rows and the two
 * `MediaCard` headings they drive never collide on a `getByRole` or `filter`
 * lookup — the same two-name shape `manual.spec.ts`'s merge test uses.
 */
const FIRST = 'Tushy.23.05.02.Emma.Stone.XXX.1080p.MP4-KTR';
const SECOND = 'Blacked.23.06.11.Jane.Doe.XXX.720p.MP4-KTR';

test('the split view lists groups beside a sticky detail pane, widens the shell, and survives a reload', async ({
  page,
  harness,
}) => {
  // One tick, so both groups land on the same page with nothing else on it.
  harness.ingest([FIRST, SECOND]);

  await page.goto('/');

  // The card list is what a fresh browser gets.
  await expect(page.locator('article.media-card')).toHaveCount(2);
  await expect(page.getByRole('listbox', { name: 'Groups' })).toHaveCount(0);

  // `.app`'s width in the view a fresh browser gets, to compare the split
  // view's width against below — the widening rule is keyed off
  // `data-browse-view`, not a viewport size, so this is a fact about the view
  // rather than about the window.
  const listViewApp = page.locator('.app');
  const listBox = await listViewApp.boundingBox();
  if (listBox === null) throw new Error('no .app box in list view');

  // Switching shows the list and an empty pane.
  await page.getByRole('radio', { name: 'Split' }).click();
  await expect(page.getByRole('listbox', { name: 'Groups' })).toBeVisible();
  await expect(page.locator('article.media-card')).toHaveCount(0);
  await expect(page.locator('.browse-detail-empty')).toBeVisible();

  // A row fills the pane, and the pane's heading matches the row.
  const options = page.getByRole('option');
  const firstOption = options.first();
  const secondOption = options.nth(1);
  const firstTitle = await firstOption.locator('.group-row-title').textContent();
  const secondTitle = await secondOption.locator('.group-row-title').textContent();
  if (firstTitle === null || secondTitle === null) throw new Error('a row rendered no title');

  await firstOption.click();
  await expect(page.locator('article.media-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(firstTitle);
  await expect(firstOption).toHaveClass(/group-row-selected/);
  await expect(firstOption).toHaveAttribute('aria-selected', 'true');

  // The separator between a row's studio and its release count is generated
  // content, drawn by `.group-row-meta > span + span::before` — the same
  // treatment `card.css`'s `.card-context` gets, and `textContent` cannot see
  // it either way. Both seeded groups parse a studio from their title (see
  // `FIRST`/`SECOND`), so every row's meta has two spans: one for the studio,
  // one for the release count. Deleting the rule left the whole unit suite and
  // every other assertion in this file green while the row read
  // "Tushy1 release" — this is the assertion that would have caught it.
  const metaSeparator = await firstOption.evaluate((row) => {
    const spans = [...row.querySelectorAll('.group-row-meta span')];
    if (spans.length !== 2) throw new Error(`expected 2 meta spans, found ${String(spans.length)}`);
    return {
      first: getComputedStyle(spans[0] as Element, '::before').content,
      second: getComputedStyle(spans[1] as Element, '::before').content,
    };
  });
  expect(metaSeparator.first).toBe('none');
  expect(metaSeparator.second).toBe('" · "');

  // The keyboard moves the selection — the part happy-dom is least trustworthy
  // for, and phase 1.8 found a real focus bug here that only a browser saw.
  await page.keyboard.press('ArrowDown');
  await expect(secondOption).toHaveClass(/group-row-selected/);
  await expect(secondOption).toHaveAttribute('aria-selected', 'true');
  await expect(firstOption).not.toHaveClass(/group-row-selected/);
  await expect(page.locator('article.media-card')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(secondTitle);

  // The choice survives a reload.
  await page.reload();
  await expect(page.getByRole('listbox', { name: 'Groups' })).toBeVisible();

  // The shell widened, and only in split view: `.app`'s cap rises from 60rem
  // to 90rem only under `[data-browse-view='split']`, so a box measured after
  // the view persisted across the reload above is a fact about the rule
  // itself, not about a stale style from before the switch.
  const splitBox = await listViewApp.boundingBox();
  if (splitBox === null) throw new Error('no .app box in split view');
  expect(splitBox.width).toBeGreaterThan(listBox.width + 100);
});
