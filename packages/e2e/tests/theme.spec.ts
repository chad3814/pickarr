import type { Page } from '@playwright/test';
import { expect, test } from '../src/harness.ts';

/**
 * The identity-change confirmation dialog (`.confirm`) used to be painted
 * with the CSS system colours `Canvas`/`CanvasText`. Those tracked the app
 * back when `tokens.css` declared `color-scheme: light dark` on `:root`; once
 * `color-scheme` moved into the per-theme blocks and the app grew its own
 * theme control, the same keywords kept tracking the operating system
 * instead. A user running the app in dark mode on a light-mode OS got a light
 * dialog on a dark page. The fix moved `.confirm` onto `--color-surface` /
 * `--color-text` (see `dialog.css`).
 *
 * No unit test can catch a regression of this: happy-dom never opens a
 * browser, so it cannot observe a CSS keyword resolve against an OS colour
 * scheme preference at all. Only a real page under a real browser, with the
 * OS scheme emulated to *disagree* with the app's stored theme, can prove the
 * dialog follows the app rather than the OS.
 */

/**
 * `SomeSite` is not arbitrary. `harness.ts` seeds it into the scenes plugin's
 * `KNOWN_SITES`, and `parseSceneRelease`'s dateless form refuses to parse any
 * release whose leading token is not a known site (see
 * `packages/plugin-scenes/src/parse.ts`). Mirrors `identity-change.spec.ts`.
 */
const DATELESS = 'SomeSite.Title.Of.Scene.1080p.MP4-WRB';
const DATED = 'SomeSite.26.08.14.Title.Of.Scene.2160p.MP4-WRB';

/** Sets the stored preference and reloads, exercising the pre-paint script. */
async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('pickarr.theme', t), theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test('the confirmation dialog follows the app theme, not the OS scheme', async ({ page, harness }) => {
  // Seed the merge scenario the dialog needs: a dateless release, picked,
  // then a dated re-encode of the same scene, so naming the date on the
  // picked group's Edit form plans a merge worth confirming.
  harness.ingest([DATELESS]);
  await page.goto('/');
  await page
    .locator('article.media-card')
    .getByRole('button', { name: 'Pick', exact: true })
    .click();
  harness.ingest([DATED]);

  async function openMergeDialog(): Promise<void> {
    await page.goto('/picks');
    const card = page.locator('article.media-card').first();
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = card.locator('form.manual-form');
    await form.getByLabel('Anchor', { exact: true }).selectOption('date');
    await form.getByLabel('Date', { exact: true }).fill('2026-08-14');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog', { name: 'Confirm identity change' })).toBeVisible();
  }

  // OS and app scheme opposed, both directions. Before the repair, `.confirm`
  // was painted in Canvas/CanvasText, which follow the OS — so a dark app on
  // a light OS raised a light dialog on a dark page, and vice versa.
  for (const [os, app] of [
    ['light', 'dark'],
    ['dark', 'light'],
  ] as const) {
    await page.emulateMedia({ colorScheme: os });
    await setTheme(page, app);
    await openMergeDialog();

    const readings = await page.locator('.confirm').evaluate((node) => {
      const root = document.documentElement;
      const resolve = (token: string): string => {
        const probe = document.createElement('span');
        probe.style.color = `var(${token})`;
        root.appendChild(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      };
      return {
        dialogBg: getComputedStyle(node).backgroundColor,
        dialogFg: getComputedStyle(node).color,
        surface: resolve('--color-surface'),
        text: resolve('--color-text'),
        dataTheme: root.getAttribute('data-theme'),
      };
    });

    // The assertion that proves the repair: the dialog is painted from the
    // app's own tokens, not from the OS's idea of Canvas/CanvasText.
    expect(readings.dialogBg).toBe(readings.surface);
    expect(readings.dialogFg).toBe(readings.text);
    expect(readings.dataTheme).toBe(app);

    await page
      .getByRole('dialog', { name: 'Confirm identity change' })
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
  }
});

/**
 * The regression this pins: `Downloads.tsx`'s "Not managed by Pickarr" `<h2>`
 * matched no CSS rule at all, so it rendered at the UA's 1.5em/700 while `h1`
 * was `--text-page`/600. Both resolve to 24px against a 16px root, so the
 * two headings were *tied* on `font-size` and told apart only by weight — a
 * subsection heading reading louder than the page title above it despite
 * computing no larger. That is why this asserts `h1` is strictly the
 * biggest heading rather than merely "no heading exceeds it": a `<=`
 * comparison would have let the actual regression through unnoticed.
 * `base.css` now gives every bare `h2` a size beneath `h1`'s, but nothing
 * before this test would notice the same mistake on a different heading:
 * happy-dom has no layout or cascade engine, so `getComputedStyle` there
 * only ever echoes an inline style, never a value resolved through
 * `styles/`. Only a real browser actually computes what a heading's
 * `font-size` resolves to.
 *
 * The check is scoped to headings, not every element: the image modal's
 * close button is deliberately sized to match `h1` (see `dialog.css`), and a
 * rule that swept in every element would flag that as a false positive.
 *
 * Browse and Picks each get a `.media-card h2` from one picked release;
 * Failed gets a `.failed-row h2` from one name the parser refuses (per
 * `manual.spec.ts`). The "Not managed by Pickarr" `<h2>` moved onto Picks
 * itself once Downloads was deleted, and it still only renders once the
 * client reports a job Pickarr's database has no row for, so one is seeded
 * through the same `setSnapshot` + `reconcile()` path `retry.spec.ts` and
 * `identity-change.spec.ts` use — the state the regression actually lived
 * in, not a substitute for it. Settings renders no heading below `h1` at
 * all; the loop below still runs on it; it simply has one heading to compare
 * against itself.
 */
test("h1 is strictly the largest heading on every route", async ({
  page,
  harness,
}) => {
  harness.ingest(['Vixen.23.04.15.Alex.Coal.XXX.1080p.MP4-KTR']);
  // The one name in `manual.spec.ts` the parser genuinely refuses, so Failed
  // has a `.failed-row h2` to check.
  harness.ingest(['agmx.084.4k']);

  await page.goto('/');
  await page
    .locator('article.media-card')
    .filter({ has: page.getByRole('heading', { name: 'Alex Coal' }) })
    .getByRole('button', { name: 'Pick' })
    .click();
  await expect.poll(() => harness.client.added.length).toBe(1);
  const added = harness.client.added[0];
  if (added === undefined) throw new Error('the pick never reached the download client');

  harness.client.setSnapshot({
    queue: [],
    history: [
      {
        ref: added.ref,
        name: added.name,
        outcome: 'in-progress',
        storagePath: null,
        failMessage: null,
        category: null,
      },
      // A job the client reports under Pickarr's own category, on a ref
      // Pickarr never issued via `addUrl` and a name carrying none of its
      // labels — the shape `reconcile()` reports back as untracked, which is
      // the only way Picks' "Not managed by Pickarr" heading renders.
      {
        ref: 'external-job-1',
        name: 'Something Pickarr Never Added',
        outcome: 'in-progress',
        storagePath: null,
        failMessage: null,
        category: 'pickarr-e2e',
      },
    ],
    complete: true,
  });
  await harness.reconcile();

  for (const route of ['/', '/picks', '/failed', '/settings']) {
    await page.goto(route);
    const headings = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((nodes) =>
      nodes.map((node) => ({
        tag: node.tagName,
        text: node.textContent ?? '',
        fontSize: parseFloat(getComputedStyle(node).fontSize),
      })),
    );

    const h1 = headings.find((heading) => heading.tag === 'H1');
    if (h1 === undefined) throw new Error(`${route} rendered no h1`);

    // Strictly smaller, not merely no-larger: the regression this pins had a
    // bare `h2` land at the *same* 24px as `h1` (1.5em of a 16px root versus
    // `h1`'s own `--text-page`), told apart only by weight, and a `<=` check
    // would wave that through. `h1` has to be the one heading that is
    // unambiguously biggest.
    for (const heading of headings) {
      if (heading === h1) continue;
      expect(
        heading.fontSize,
        `${route}: <${heading.tag.toLowerCase()}> "${heading.text}" is ${String(heading.fontSize)}px, not smaller than h1's ${String(h1.fontSize)}px`,
      ).toBeLessThan(h1.fontSize);
    }
  }
});
