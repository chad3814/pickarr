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

/**
 * Distinct scene names the real parser accepts, one group each — the same
 * generator `pagination.spec.ts` uses, needed here for the same reason: a
 * list long enough to actually scroll the page. Sixty rows comfortably
 * outruns any viewport this suite runs at (`playwright.config.ts` uses
 * `devices['Desktop Chrome']`'s default), so the list's own content height,
 * not the detail pane's, is what makes `.browse-split` — and therefore the
 * document — taller than the window.
 */
function sceneTitles(site: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      `${site}.23.07.${String(index + 1).padStart(2, '0')}.${site}.Scene.${String(index + 1)}.XXX.1080p.MP4-KTR`,
  );
}

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

test('the detail pane stays put while the list scrolls past it, and only because it is sticky', async ({
  page,
  harness,
}) => {
  // Sixty rows across two pages — `usePagedList`'s default page size is 30
  // (`pagination.spec.ts`) — so the list is tall regardless of how it loads,
  // and long past what one screen can show.
  harness.ingest(sceneTitles('Riverside', 60));

  await page.goto('/');
  await page.getByRole('radio', { name: 'Split' }).click();
  await page.getByRole('option').first().click();
  await expect(page.locator('article.media-card')).toHaveCount(1);

  const list = page.locator('.group-list');
  const pane = page.locator('.browse-detail');

  /**
   * `window.scrollTo` to `y` and wait for it to actually land there —
   * `window.scrollTo` rather than a wheel gesture, for the same determinism
   * `pagination.spec.ts`'s `scrollToEnd` wants: one clean jump rather than a
   * tuned number of wheel ticks.
   */
  async function scrollTo(y: number): Promise<void> {
    await page.evaluate((target) => window.scrollTo(0, target), y);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y - 5);
  }

  // Scrolled just past the point where the pane's own natural (unstuck)
  // position — `123px` down, below `<h1>` and the controls row — would rise
  // above its `top: var(--space-4)` (16px) offset. Comparing this box against
  // one further down is the actual test; comparing it against the unscrolled
  // page would just be measuring the one-time settle into "stuck", which
  // happens once regardless of whether `position: sticky` is even there —
  // an unstuck pane also starts 123px down and wanders as the page scrolls,
  // so that transition alone proves nothing.
  await scrollTo(150);
  const listAtA = await list.boundingBox();
  const paneAtA = await pane.boundingBox();
  if (listAtA === null || paneAtA === null) throw new Error('no box for the list or the pane at the first scroll');

  // Scrolled further still, comfortably inside `.browse-split` — the
  // sixty-row list, not the one selected card, is what makes this box far
  // taller than the distance scrolled between the two checkpoints.
  await scrollTo(400);
  const listAtB = await list.boundingBox();
  const paneAtB = await pane.boundingBox();
  if (listAtB === null || paneAtB === null) throw new Error('no box for the list or the pane at the second scroll');

  // The premise: the list actually moved a meaningful amount between the two
  // checkpoints. Without this, a pane that read the same at both would also
  // pass on a page that never scrolled between them at all.
  expect(listAtA.y - listAtB.y).toBeGreaterThan(200);

  // The point: once stuck, the pane does not move again as the list keeps
  // scrolling past it — `position: sticky` holding it at `top: var(--space-4)`
  // for as long as `.browse-split` is still on screen, which at this distance
  // it is.
  expect(Math.abs(paneAtB.y - paneAtA.y)).toBeLessThan(2);
});
