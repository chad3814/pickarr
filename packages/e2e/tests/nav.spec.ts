import { expect, test } from '../src/harness.ts';

/**
 * The two properties of the vertical nav that only a real browser can check.
 *
 * happy-dom, which every unit test in `packages/web` runs on, has no layout
 * engine: `position: sticky` resolves to nothing there and `scrollHeight` is
 * always zero, so "stays put while the page scrolls" and "scrolls internally
 * when taller than the window" cannot be asserted at all in that suite. They are
 * the whole point of the change, so they are pinned here instead.
 */

/**
 * Feed titles the real scenes parser accepts, so the page fills with real cards
 * through the real ingest path. Same shape as `pagination.spec.ts`'s helper of
 * the same name — this spec needs a tall page, not a particular scene.
 */
function sceneTitles(site: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      `${site}.23.07.${String(index + 1).padStart(2, '0')}.${site}.Scene.${String(index + 1)}.XXX.1080p.MP4-KTR`,
  );
}

test('the nav stays put while the page scrolls', async ({ page, harness }) => {
  // The requirement in its own words: the tabs must not scroll out of view. A
  // static nav passes every other test in this file and fails only this one.
  harness.ingest(sceneTitles('Tallpage', 40));
  await page.goto('/');

  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Browse' })).toBeVisible();
  const before = await nav.boundingBox();
  expect(before).not.toBeNull();

  await page.evaluate(() => window.scrollBy(0, 1200));
  // The scroll has to have actually happened, or this test proves nothing.
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  const after = await nav.boundingBox();
  expect(after).not.toBeNull();
  // Viewport coordinates: a nav that scrolled away would have moved up by the
  // full scroll distance. Sticky holds it within a pixel of where it started.
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeInViewport();
});

test('a nav taller than the window scrolls to reach its last tab', async ({ page }) => {
  // Five tabs do not overflow any ordinary window, so the case is reached by
  // shrinking the window rather than by inventing tabs the app does not have —
  // the overflow rule is what must work, not a particular tab count.
  //
  // 120px because the nav's natural height is 139px and its budget is
  // `calc(100vh - 2rem)`: it starts overflowing just under a 160px viewport, so
  // 120 leaves real margin rather than sitting on the boundary. Adding a tab
  // makes the nav taller and keeps this true; removing enough of them to fit in
  // 88px would fail here, which is the right place to notice that.
  await page.setViewportSize({ width: 900, height: 120 });
  await page.goto('/');

  const nav = page.getByRole('navigation');
  const overflowing = await nav.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(overflowing, 'the short viewport must actually overflow the nav').toBe(true);

  // Reachable, which is the requirement — not merely present in the DOM.
  const settings = nav.getByRole('link', { name: 'Settings' });
  await settings.scrollIntoViewIfNeeded();
  await expect(settings).toBeInViewport();
  await settings.click();
  await expect(page).toHaveURL(/\/settings$/);
});
