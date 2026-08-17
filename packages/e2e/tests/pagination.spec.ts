import type { Page } from '@playwright/test';
import { expect, test } from '../src/harness.ts';

/**
 * The bug this exists for: **acting on a row after "Load more" threw away
 * every page loaded past the first.**
 *
 * `Browse`'s pick handler refetched page one (`loadPage(null, search, true)`)
 * instead of patching the one card the server had just answered about, so a
 * pick made on page one snapped a three-page list back to thirty cards. The
 * Failed tab's resolve and dismiss had the same shape and the same fix.
 *
 * Why the existing suite could not see it. It needs three things at once that
 * a stubbed `fetch` cannot supply together: a real `/api/browse` deciding where
 * page one ends, a cursor the server minted, and a second page fetched with it.
 * A component test can mock a "page two" response, but then the assertion is
 * about the fixture rather than about which rows the server would really have
 * returned when the list shifted under the cursor — and the shift is the whole
 * bug.
 *
 * The lists are seeded past the server's default page size rather than by
 * asking for a smaller page, because the SPA never sends `limit` — a spec that
 * did would be paginating differently from the app it is testing.
 *
 * Pages are now reached by scrolling rather than by clicking Load more, and the
 * button has its own test at the bottom for the one case it exists to serve. See
 * `scrollToEnd` for why the click could not simply be kept.
 */

/** The default `limit` in `browseQuerySchema` and `failedQuerySchema`. */
const PAGE_SIZE = 30;

/**
 * The nth element, or a failure naming which one was missing.
 *
 * Worth the four lines: `list[n] ?? ''` typechecks and then quietly becomes a
 * `hasText: ''` filter, which matches every row — a locator that can never fail
 * for the reason the test is about.
 */
function at(titles: readonly string[], index: number): string {
  const title = titles[index];
  if (title === undefined) throw new Error(`the seeded list has no entry ${String(index)}`);
  return title;
}

/**
 * Distinct scene names the real parser accepts, one group each, whose display
 * titles carry the site so two seeded batches never share a heading.
 *
 * Generated rather than listed so the count can follow `PAGE_SIZE`; every one
 * still goes through `parseSceneRelease`, so nothing here can be a shape the
 * parser would refuse in production.
 */
function sceneTitles(site: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      `${site}.23.07.${String(index + 1).padStart(2, '0')}.${site}.Scene.${String(index + 1)}.XXX.1080p.MP4-KTR`,
  );
}

/** Names the parser refuses, so each becomes a row on the Failed tab. */
function refusedTitles(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `${prefix}.${String(index + 1).padStart(3, '0')}.4k`,
  );
}

/**
 * Scroll to the end of the document, which is what asks for the next page.
 *
 * This replaced a click on Load more, which cannot work here any more and for a
 * reason worth writing down: Playwright scrolls a target into view before
 * clicking it, and scrolling the end of the list into view is now itself the
 * gesture that fetches the next page. On the final page that arrives, `done`
 * flips and the button unmounts underneath the pending click — "element was
 * detached from the DOM", every retry finding it gone. Nothing is broken; the
 * button is simply unreachable by a gesture that loads the page it was there to
 * ask for. It remains the fallback for a browser whose observer never fires, and
 * that is what the last test in this file covers.
 *
 * `window.scrollTo` rather than a wheel gesture so the scroll is one deterministic
 * jump to the bottom, not a number of ticks tuned to a row height.
 */
async function scrollToEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
  });
}

test('picking after scrolling to a later page keeps that page on screen', async ({ page, harness }) => {
  // Two ticks, oldest first. Both lists sort by their arrival stamp descending,
  // so the earlier tick's groups are the ones that land on page two — which
  // makes "page one" and "page two" facts about the seeding rather than about
  // how the ids happened to fall.
  const tail = sceneTitles('Tailend', 3);
  harness.ingest(tail);
  // One group with two encodes, so picking the lesser one leaves it listed with
  // an upgrade offered. That is the sharper case: the card is *patched* rather
  // than dropped, so page one refetched comes back exactly as long as it was
  // and only the later pages are missing.
  const better = 'Vixen.23.04.15.Alex.Coal.XXX.2160p.MP4-KTR';
  const worse = 'Vixen.23.04.15.Alex.Coal.XXX.1080p.MP4-KTR';
  harness.ingest([better, worse, ...sceneTitles('Padding', PAGE_SIZE - 1)]);

  await page.goto('/');
  const cards = page.locator('article.media-card');
  await expect(cards).toHaveCount(PAGE_SIZE);

  await scrollToEnd(page);
  await expect(cards).toHaveCount(PAGE_SIZE + tail.length);
  const lastTail = page.getByRole('heading', { name: 'Tailend Scene 3', exact: true });
  await expect(lastTail).toBeVisible();

  const card = cards.filter({ has: page.getByRole('heading', { name: 'Alex Coal' }) });
  await card
    .locator('li.release-row')
    .filter({ hasText: worse })
    .getByRole('button', { name: 'Pick' })
    .click();

  // The card the server answered about is patched in place...
  await expect(card.locator('.badge')).toHaveText('Upgrade available');
  // ...and page two is untouched. Both assertions are needed: the refetch bug
  // leaves the first of them true.
  await expect(lastTail).toBeVisible();
  await expect(cards).toHaveCount(PAGE_SIZE + tail.length);
});

test('resolving and dismissing after scrolling keep the later pages on screen', async ({
  page,
  harness,
}) => {
  const tail = refusedTitles('tailend', 4);
  harness.ingest(tail);
  const head = refusedTitles('agmx', PAGE_SIZE);
  const refused = harness.ingest(head);
  // Every seeded name has to have actually been refused, or the rows this test
  // pages through do not exist.
  expect(refused.parseErrors).toBe(PAGE_SIZE);

  await page.goto('/failed');
  const rows = page.locator('li.failed-row');
  await expect(rows).toHaveCount(PAGE_SIZE);

  await scrollToEnd(page);
  await expect(rows).toHaveCount(PAGE_SIZE + tail.length);

  // The *last* row of page two. Acting on a row shortens the list, so page one
  // refetched pulls the front of page two up into itself — only the rows past
  // that point disappear, and asserting on the first of them would pass.
  const lastTail = rows.filter({ hasText: at(tail, tail.length - 1) });
  await expect(lastTail).toBeVisible();

  const toResolve = rows.filter({ hasText: at(head, 5) });
  await toResolve.getByRole('button', { name: 'Fix' }).click();
  const form = toResolve.locator('form.manual-form');
  await form.getByLabel('Site', { exact: true }).fill('Padding');
  await form.getByLabel('Anchor', { exact: true }).selectOption('date');
  await form.getByLabel('Date', { exact: true }).fill('2023-12-01');
  await form.getByLabel('Scene', { exact: true }).fill('Resolved By Hand');
  await form.getByRole('button', { name: 'Save' }).click();

  await expect(toResolve).toHaveCount(0);
  await expect(rows).toHaveCount(PAGE_SIZE + tail.length - 1);
  await expect(lastTail).toBeVisible();

  const toDismiss = rows.filter({ hasText: at(head, 6) });
  await toDismiss.getByRole('button', { name: 'Dismiss' }).click();

  await expect(toDismiss).toHaveCount(0);
  await expect(rows).toHaveCount(PAGE_SIZE + tail.length - 2);
  await expect(lastTail).toBeVisible();
});

test('Load more still pages when the browser never reports the end coming into view', async ({
  page,
  harness,
}) => {
  // The fallback, reached the only way it is really reached: an observer that
  // never reports. A viewport too short to scroll, an odd zoom level, or a
  // browser without the API all land here, and without the button the reader has
  // no way to ask for the rest of the list.
  //
  // Replacing the constructor is what makes that testable at all. With a working
  // observer there is no gesture that reaches the button without having already
  // fetched the page the button would have asked for — which is exactly why
  // `scrollToEnd` had to replace the clicks above, and why the button needs a
  // test of its own rather than being covered incidentally by them.
  await page.addInitScript(() => {
    class SilentObserver {
      observe(): void {
        // Reports nothing, ever: the failure this test is about.
      }
      unobserve(): void {
        // Nothing was observed.
      }
      disconnect(): void {
        // Nothing to disconnect.
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    Object.defineProperty(window, 'IntersectionObserver', {
      writable: true,
      value: SilentObserver,
    });
  });

  const tail = sceneTitles('Tailend', 3);
  harness.ingest(tail);
  harness.ingest(sceneTitles('Padding', PAGE_SIZE));

  await page.goto('/');
  const cards = page.locator('article.media-card');
  await expect(cards).toHaveCount(PAGE_SIZE);

  // The premise: scrolling cannot page any more, so a list stuck at thirty is
  // what the reader is looking at. The wait is what gives a page that was going
  // to arrive the chance to — `toHaveCount` on its own passes instantly against
  // the count that is already there and would prove nothing.
  await scrollToEnd(page);
  await page.waitForTimeout(500);
  await expect(cards).toHaveCount(PAGE_SIZE);

  await page.getByRole('button', { name: 'Load more' }).click();

  await expect(cards).toHaveCount(PAGE_SIZE + tail.length);
  await expect(page.getByRole('heading', { name: 'Tailend Scene 3', exact: true })).toBeVisible();
});
