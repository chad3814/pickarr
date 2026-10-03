/**
 * The expanded card's detail section and its gallery modal, in a real
 * browser -- task 8's brief. Every other test on this section runs in
 * jsdom, which has no layout engine at all: a query that resolves to an
 * element proves nothing about whether that element has any size, and
 * `CLAUDE.md`'s `IdentityChangeConfirm` entry is the scar from finding
 * that out the hard way -- `role="dialog"` and an `aria-label`, eight unit
 * tests and two Playwright specs green throughout, rendered as an unstyled
 * block of inline text nobody could use. This file measures geometry, not
 * the accessibility tree.
 *
 * **The second test exists because of a real regression the brief's own
 * spec would not have caught.** `library.css`'s long-standing `article
 * img { width: 6rem; aspect-ratio: 2 / 3 }` rule reaches every `<img>` the
 * detail section adds, because they all render inside the same `<article>`
 * `MediaItemCard.tsx` opens -- the gallery's lightbox image included. The
 * gallery's own rule set only `max-width`/`max-height`/`object-fit` and
 * left `width` unset, so `article img`'s `width: 6rem` fell through
 * uncontested and every lightbox image rendered at thumbnail size. It has
 * since been fixed (`.gallery img` now sets `width: auto; height: auto;
 * aspect-ratio: auto` explicitly, so it wins on specificity for those
 * properties too). Nothing automated caught the regression when it
 * shipped: `npm run check` parses no CSS, a bundle grep finds a rule that
 * is present and well-formed, and jsdom has no layout -- only a human
 * reading the cascade found it. The brief's own two tests measure the
 * poster box and the backdrop's width, never the gallery image, so they
 * would have stayed green throughout. The third assertion in the second
 * test below is the one that would not have.
 *
 * **Why the gallery image needs a real, large poster and not the seeded
 * 1x1 `POSTER_PNG` every other spec in this suite uses.** With `width:
 * auto; height: auto; aspect-ratio: auto`, the *used* size is the image's
 * intrinsic size, clamped only by `max-width: 80vw`/`max-height: 70vh`. A
 * 1x1 source has nothing for that clamp to act on -- it renders at 1x1
 * either way, which would make "greater than 200px" fail under the fixed
 * rule just as it would under the bug, and prove nothing about either.
 * `POSTER_FIXTURE` below is a real, decodable 1000x1500 PNG (2:3, the same
 * ratio the poster crop uses) built with ImageMagick and stripped of
 * metadata, intercepted onto `/api/artwork/poster/:posterId` (the poster row's id) with `page.route`
 * rather than added to `Harness.seedTvRelease` -- that method's own doc
 * says its row's `width`/`height` columns are read back nowhere, and the
 * bytes it seeds are the frame-vs-load distinction `shell.spec.ts`'s own
 * poster specs are pinning; a second, larger fixture belongs at the one
 * call site that needs it, not behind a flag every other seeded poster
 * would have to carry. `1000x1500` against the suite's 1280x720 default
 * viewport (`devices['Desktop Chrome']`) clamps on `max-height: 70vh`
 * (504px), computing a used width of `504 * (1000 / 1500)` = 336px under
 * the fixed rule -- comfortably above the 200px floor -- and exactly 96px
 * (`--size-poster`'s `6rem`) under the bug, because a fixed `width` does
 * not consult the intrinsic size at all. That 96px-vs-336px gap, not any
 * particular viewport arithmetic, is what the assertion is chosen to catch.
 *
 * The intercepted route also answers the browse-row thumbnail's and the
 * detail section's own poster `<img>` requests, since both share the same
 * url. That is harmless to both: `article img` and `.details .poster img`
 * each set an explicit `width` (`6rem` and `120px`), which -- unlike the
 * gallery's `auto` -- does not depend on the intrinsic size of what
 * loaded, so serving a bigger image does not move either box.
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

const DETAILS_ITEM_TITLE = 'A Cascade-Proof Broadcast';
const DETAILS_SERIES = 'The Layout Engine Hour';

test('the expanded card shows a styled detail section above the releases', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  harness.seedTvRelease({
    title: DETAILS_ITEM_TITLE,
    seriesTitle: DETAILS_SERIES,
    seasonNumber: 1,
    episodeNumber: 1,
    withPoster: true,
  });

  // The full round trip -- the same one every seeded-card spec in
  // `shell.spec.ts` waits on -- before there is anything to click.
  const card = page.getByRole('article');
  await expect(card).toHaveCount(1, { timeout: 15_000 });

  await card.getByRole('heading').getByRole('button').click();

  // The expand-time gather (`useGatheredItem`) is a second round trip,
  // separate from the one above, so it gets its own explicit wait.
  const details = page.locator('article section.details');
  await expect(details).toBeVisible({ timeout: 15_000 });

  // The section sits above the release list, which is the placement the
  // design asks for and the one a DOM-order assertion alone would not
  // prove: a `section.details` that rendered after `ul[aria-label
  // ='releases']` in source order but was floated or absolutely
  // positioned above it would still satisfy "comes first in the DOM".
  const detailsBox = await details.boundingBox();
  const releasesBox = await page.locator('article ul[aria-label="releases"]').first().boundingBox();
  expect(detailsBox).not.toBeNull();
  expect(releasesBox).not.toBeNull();
  expect(detailsBox!.y + detailsBox!.height).toBeLessThanOrEqual(releasesBox!.y + 1);

  // The poster slot has real size -- an unstyled `<button>` around a
  // failed image collapses to a few pixels, which every role-based query
  // would still pass.
  const poster = page.locator('article section.details .poster');
  const posterBox = await poster.boundingBox();
  expect(posterBox).not.toBeNull();
  expect(posterBox!.width).toBeGreaterThan(80);
  expect(posterBox!.height).toBeGreaterThan(120);
});

const GALLERY_ITEM_TITLE = 'A Thumbnail-Escaping Premiere';
const GALLERY_SERIES = 'The Uncropped Signal';

/**
 * A real, decodable 1000x1500 PNG (2:3), built with `magick -size 1000x1500
 * xc:'#4477aa' -strip` and stripped of metadata -- see this file's own
 * header for why the gallery-size assertion below needs a large source
 * image rather than the suite's usual 1x1 `POSTER_PNG`.
 */
const POSTER_FIXTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAA+gAAAXcAQMAAACLVjYmAAAAA1BMVEVEd6qGlL0BAAAAzklEQVR42u3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL4M4mY'
  + 'AAXtE60EAAAAASUVORK5CYII=',
  'base64',
);
const POSTER_FIXTURE_WIDTH = 1000;

test('the gallery opens as an overlay covering the viewport, and its image escapes the thumbnail crop', async ({ page, harness }) => {
  // Set up before navigating: the browse-row poster fires this same
  // request the moment the seeded card renders, well before the click
  // sequence below reaches the gallery.
  await page.route('**/api/artwork/poster/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: POSTER_FIXTURE });
  });

  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  harness.seedTvRelease({
    title: GALLERY_ITEM_TITLE,
    seriesTitle: GALLERY_SERIES,
    seasonNumber: 1,
    episodeNumber: 1,
    withPoster: true,
  });

  const card = page.getByRole('article');
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await card.getByRole('heading').getByRole('button').click();

  await page.locator('article section.details .poster').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  // A dialog that is merely in the accessibility tree renders inline as a
  // block of text. The backdrop covering the viewport is what distinguishes
  // an overlay from that, and `toBeVisible()` does not.
  const backdrop = page.locator('.gallery-backdrop');
  const backdropBox = await backdrop.boundingBox();
  const viewport = page.viewportSize();
  expect(backdropBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(backdropBox!.width).toBeGreaterThanOrEqual(viewport!.width - 1);

  // The regression this file exists to catch. `urls` is `[poster,
  // background, logo]` and only the poster resolves (the other two 404
  // against the harness's real route, and `Gallery` drops a failed url
  // from `showing`), so the first `<img>` in the open dialog is always the
  // poster -- `.first()` rather than a name, because `Gallery` gives every
  // image the same `alt` (the caption), not one per role.
  const galleryImage = dialog.locator('img').first();
  await expect(galleryImage, 'the intercepted fixture decoded, not a 404 or a stale cache').toHaveJSProperty(
    'naturalWidth',
    POSTER_FIXTURE_WIDTH,
  );

  // `library.css`'s `article img` rule fixes every image in this
  // `<article>` at `6rem` (96px) unless a more specific rule overrides
  // `width` explicitly -- which is exactly the cascade bug this task's
  // brief describes: the gallery's rule used to set only
  // `max-width`/`max-height`/`object-fit`, so `width` fell through
  // uncontested and every lightbox image rendered at thumbnail size. 200px
  // is well above that 96px floor and well below the 336px this fixture
  // computes to under the fixed rule (this file's own header has the
  // arithmetic), so it separates the two outcomes without depending on
  // exactly where the viewport clamp lands.
  const galleryImageBox = await galleryImage.boundingBox();
  expect(galleryImageBox).not.toBeNull();
  expect(
    galleryImageBox!.width,
    'the open gallery image is sized from its own bytes, not clamped to the 96px thumbnail crop',
  ).toBeGreaterThan(200);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
