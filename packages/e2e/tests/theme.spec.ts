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
