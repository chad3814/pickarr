import type { MetadataCandidate } from '@pickarr/plugin-api';
import { expect, test } from '../src/harness.ts';

/**
 * The card's own geometry, plus the one thing about the slot that geometry
 * cannot answer — whether it crops or letterboxes — in a real browser.
 *
 * Nothing in the unit suite can answer either. happy-dom parses the CSS but
 * lays nothing out, so every box it reports is zero-sized — an overlap test
 * against it would pass whatever the stylesheet said — and it paints nothing
 * at all. Both questions are only askable where boxes have positions and
 * pixels have colours, which is here.
 */

const RELEASE = 'Vixen.23.04.15.Alex.Coal.XXX.1080p.MP4-KTR';

/**
 * 8 x 2000, 1-bit greyscale, all black, 84 bytes — the same fixture
 * `metadata-modal.spec.ts` uses. It arrived here from before the slot had a
 * fixed frame, when an image's rendered size came from its own dimensions and
 * this extreme shape was the one most likely to reach the rows below it.
 *
 * Still load-bearing, for a different reason now. `.card-artwork` (`card.css`)
 * gives the slot a fixed `width: 6rem; aspect-ratio: 2 / 3` frame, so the
 * *box* is the same whatever the source shape — but the crop assertion below
 * reads the pixels inside that box, and only a source far off 2:3 leaves a
 * visible gap when it is fitted instead of cropped. A square source contained
 * in this frame still fills it across the middle, so the same assertion would
 * pass against `object-fit: contain` and prove nothing.
 *
 * Two properties are needed and both are this fixture's: the shape, and that
 * the bytes decode at all — a browser handed undecodable bytes renders a
 * broken image with no intrinsic size and nothing here has a box to measure.
 * The colour matters too: all black against a card that is not.
 */
const TALL_PNG =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAfQAQAAAADXviPqAAAAG0lEQVR42u3BMQEAAADCoPVPbQwf' +
  'oAAAAIC3AQ+gAAFUpTheAAAAAElFTkSuQmCC';

function candidateWithPoster(): MetadataCandidate {
  return {
    sourceUuid: 'e2e-scene-layout',
    title: 'Alex Coal',
    siteUuid: null,
    siteId: null,
    siteName: 'Vixen',
    date: '2023-04-15',
    performers: [],
    durationSeconds: null,
    synopsis: null,
    posterUrl: TALL_PNG,
    slug: null,
  };
}

test("the slot's artwork flows beside the identity block, spanning it, without covering the releases", async ({
  page,
  harness,
}) => {
  // The reported bug: the poster was `position: absolute` against the card,
  // so it reserved no height. A header shorter than the image — a title, a
  // subtitle and a date, which is most cards — left the poster hanging over
  // the release rows and covering their Pick buttons.
  harness.ingest([RELEASE]);
  harness.metadataClient.setCandidates([candidateWithPoster()]);

  const group = harness.db
    .prepare('SELECT id FROM media_groups ORDER BY id DESC LIMIT 1')
    .get() as { id: number } | undefined;
  if (group === undefined) throw new Error('ingest did not create a group');

  // Confirm before the page loads, never after: `runMetadataPass` writes the
  // answer and caches the poster afterwards in the same call, so a page
  // already polling can settle on `confirmed` with `hasPoster` still false
  // and never ask again. `metadata-modal.spec.ts` documents this window at
  // length; the short version is that the first read has to be the finished
  // one.
  const requested = await fetch(`${harness.baseURL}/api/metadata/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupIds: [group.id] }),
  });
  if (!requested.ok) throw new Error(`enqueue failed: HTTP ${String(requested.status)}`);
  await harness.runMetadataPass();

  await page.goto('/');

  // The *image*, not the button that wraps it. Measuring the button is how
  // the first version of this test passed against a card that still had the
  // bug: the button's box honoured its `max-height` while the image inside
  // ignored a percentage max-height against an auto-height parent and
  // rendered at full size, overflowing a container whose measurements looked
  // perfectly correct. What overlaps the releases is the thing you can see.
  const poster = page.getByRole('button', { name: /browse images for/i }).locator('img');
  await expect(poster).toBeVisible();

  const posterBox = await poster.boundingBox();
  const firstRelease = page.locator('.release-row').first();
  await expect(firstRelease).toBeVisible();
  const releaseBox = await firstRelease.boundingBox();
  if (posterBox === null || releaseBox === null) throw new Error('no layout boxes');

  // Spec §9: "Tests can pin that the slot crops rather than letterboxes."
  // Until the two checks below were written nothing in this repo did, and
  // every assertion in this test was satisfied by the splinter of a box an
  // 8 x 2000 image renders when it is fitted rather than cropped.
  //
  // The frame first. `.card-artwork img` is `width: 6rem; aspect-ratio: 2 / 3`
  // inside a 1px border, and the root font size is the browser's 16px default
  // (`tokens.css` sets no other), so the frame measures 98 x 146 CSS px
  // whatever shape the source is. Put this fixture back inside the
  // `max-width: 6rem; max-height: 8rem` bound the branch replaced and the same
  // box measures 2.5 x 130 — measured, not computed. A width near 6rem and a
  // 2:3 box are two facts that hold only while the fixed frame does, and the
  // gap between 98 and 2.5 is not a rounding call.
  expect(posterBox.width).toBeGreaterThan(80);
  expect(posterBox.height / posterBox.width).toBeCloseTo(1.5, 1);

  // Then the paint, which the geometry above cannot see, and which is the half
  // of this that needs a second measurement rather than a second reading of
  // the same numbers. Verified by mutation: with `object-fit: contain` and the
  // frame left alone, both assertions above still pass, because `aspect-ratio`
  // fixes the box whatever is done with the image inside it. Losing the frame
  // and losing the fit are two independent ways to lose the crop and neither
  // check catches the other's failure.
  //
  // `TALL_PNG` is all black and the card behind it is not. Cropped, the source
  // scales by 12 and fills the frame edge to edge, so every pixel in the frame
  // is image and this sample reads 0,0,0. Fitted, it scales by 0.072 into a
  // half-pixel-wide column down the middle of the frame and the rest is card
  // surface, which is what the sample then reads — measured at 255,255,255,
  // Playwright's default light `prefers-color-scheme` resolving
  // `--color-surface` to #ffffff. The dark palette's #1b1a18 would clear this
  // threshold too, so the assertion does not depend on which theme the run
  // lands in.
  //
  // Decoded a fifth of the way across and halfway down: far from the column a
  // fitted image leaves, and far enough inside the border that
  // `border-radius` cannot reach it.
  //
  // The screenshot goes back into the page to be read: there is no image
  // library in this repo's dependencies and this is not a reason to add one —
  // the same call `metadata-modal.spec.ts` makes about generating the fixture
  // by hand.
  const encoded = (await poster.screenshot()).toString('base64');
  const sample = await page.evaluate(async (png) => {
    const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    if (context === null) throw new Error('no 2d context to sample the slot from');
    context.drawImage(bitmap, 0, 0);
    const pixel = context.getImageData(
      Math.round(bitmap.width * 0.2),
      Math.round(bitmap.height * 0.5),
      1,
      1,
    );
    return Array.from(pixel.data.slice(0, 3));
  }, encoded);
  expect(Math.max(...sample)).toBeLessThan(16);

  // The whole assertion. Absolutely positioned, the poster's bottom ran well
  // past the first release row's top; in flow, the row it shares with the
  // header pushes the releases below it.
  expect(posterBox.y + posterBox.height).toBeLessThanOrEqual(releaseBox.y);

  // And it is still on the right-hand side, not stacked above the title —
  // `flex-direction` reverting to the default `row` is the way this fix
  // regresses into "no overlap, because everything is vertical now".
  const heading = page.getByRole('heading', { level: 2 }).first();
  const headingBox = await heading.boundingBox();
  if (headingBox === null) throw new Error('no heading box');
  expect(posterBox.x).toBeGreaterThan(headingBox.x + headingBox.width - 1);
  expect(posterBox.y).toBeLessThan(headingBox.y + headingBox.height);

  // The poster is beside the *whole* identity block, not just the title. The
  // fields row is the last thing in that column, so a poster whose span still
  // reaches it is one sharing a row with everything above it too — which is
  // what keeps the column tall enough to avoid a band of empty space beneath
  // it. Moving the Edit control or the fields back out of the column, below
  // the row, would leave the poster's span ending above them and fail here
  // while every no-overlap assertion above still passed.
  const fields = page.locator('.fields').first();
  const fieldsBox = await fields.boundingBox();
  if (fieldsBox === null) throw new Error('no fields box');
  expect(fieldsBox.x).toBeLessThan(posterBox.x);
  expect(posterBox.y + posterBox.height).toBeGreaterThan(fieldsBox.y);
});
