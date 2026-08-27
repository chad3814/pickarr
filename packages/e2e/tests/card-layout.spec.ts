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
  // The one thing in this repo that depends on the bytes having actually
  // landed, and nothing above waits for them. `toBeVisible()` is satisfied by
  // the 98 x 146 frame the moment it is laid out — the frame's size comes from
  // the stylesheet, not from the image — and Playwright's element screenshot
  // waits for visibility and a stable box, both of which an empty frame
  // already has. Without this the sample could read card surface simply
  // because the decode had not finished, and `playwright.config.ts` sets
  // `retries: 0`, so that is a red build rather than a flake anyone gets to
  // ignore. `complete` is also true for an image that failed to decode, which
  // is fine here: this fixture decodes, and one that did not would fail the
  // sample below rather than pass it.
  await expect(poster).toHaveJSProperty('complete', true);

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

  // And it is still on the left-hand side, leading the card rather than
  // stacked above the title. The stacking regression is what the first
  // assertion below actually catches now that the artwork is first in the
  // DOM: stacked, the poster's right edge would land at or past the
  // heading's left edge rather than short of it. The y comparison alone no
  // longer proves anything about stacking — stacked, the poster still sits
  // above the heading, so `posterBox.y` is trivially less than the
  // heading's bottom either way. What actually closes that gap is the
  // poster-versus-fields comparison further down, which fails once the
  // poster sits entirely above the whole column rather than beside it.
  const heading = page.getByRole('heading', { level: 2 }).first();
  const headingBox = await heading.boundingBox();
  if (headingBox === null) throw new Error('no heading box');
  expect(posterBox.x + posterBox.width).toBeLessThan(headingBox.x + 1);
  expect(posterBox.y).toBeLessThan(headingBox.y + headingBox.height);

  // The poster is beside the *whole* identity block, not just the title.
  // The fields row is the last thing actually rendered in *this fixture's*
  // column — `candidateWithPoster` leaves `synopsis` null and `performers`
  // empty, so nothing follows the chips — which is what lets this stand in
  // for "spans the whole column" here. It is not true of the column in
  // general any more: the synopsis and the cast can both render after the
  // fields now for a confirmed group with data (`MediaCard.tsx`), so a
  // fixture that populated either would need its own boundary, not this
  // one. A poster whose span still reaches the fields is one sharing a row
  // with everything above them too — which is what keeps the column tall
  // enough to avoid a band of empty space beneath it. Moving the Edit
  // control or the fields back out of the column, below the row, would
  // leave the poster's span ending above them and fail here while every
  // no-overlap assertion above still passed. The identity column now sits
  // to the *right* of the poster rather than the left — the artwork leads
  // the card — so it is the fields that are greater on x now, not less.
  const fields = page.locator('.fields').first();
  const fieldsBox = await fields.boundingBox();
  if (fieldsBox === null) throw new Error('no fields box');
  expect(fieldsBox.x).toBeGreaterThan(posterBox.x);
  expect(posterBox.y + posterBox.height).toBeGreaterThan(fieldsBox.y);
});

/**
 * The same scene, answered fully: a site, a provider date, a running time and
 * a synopsis. `candidateWithPoster` deliberately leaves the last two null —
 * the test above needs the fields chips to be the bottom of the identity
 * column — so the two stylesheet properties measured below need a fixture of
 * their own rather than a fourth null filled in up there.
 */
function candidateWithContext(): MetadataCandidate {
  return {
    sourceUuid: 'e2e-scene-context',
    title: 'Alex Coal',
    siteUuid: null,
    siteId: null,
    siteName: 'Vixen',
    date: '2023-04-15',
    performers: [],
    durationSeconds: 1800,
    // Long enough to wrap several times at any width this card is drawn at, so
    // the measure below is the stylesheet's and not this string running out.
    synopsis: 'A scene the provider had plenty to say about. '.repeat(12),
    posterUrl: null,
    slug: null,
  };
}

test('the context separator is generated content, and the synopsis keeps its measure', async ({
  page,
  harness,
}) => {
  // Two things `MediaCard.test.tsx` cannot see, for the same reason: happy-dom
  // lays nothing out and generates no content, so `textContent` there reads
  // `Vixen2023-04-1530m` whether `card.css` draws a separator or not, and every
  // box it reports is zero-sized. Deleting
  // `.card-context > span + span::before` left the whole unit suite green and
  // shipped a card reading `Brazzers2023-04-1530m`; that is the mutation this
  // test exists for.
  harness.ingest([RELEASE]);
  harness.metadataClient.setCandidates([candidateWithContext()]);

  const group = harness.db
    .prepare('SELECT id FROM media_groups ORDER BY id DESC LIMIT 1')
    .get() as { id: number } | undefined;
  if (group === undefined) throw new Error('ingest did not create a group');

  const requested = await fetch(`${harness.baseURL}/api/metadata/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupIds: [group.id] }),
  });
  if (!requested.ok) throw new Error(`enqueue failed: HTTP ${String(requested.status)}`);
  await harness.runMetadataPass();

  await page.goto('/');
  // The answer is what puts the date, the running time and the synopsis on the
  // card, so nothing below can be measured until the synopsis is on screen.
  const synopsis = page.locator('p.metadata-synopsis');
  await expect(synopsis).toBeVisible();

  // `68ch` is the advance of `0` in the face that actually loaded, and
  // `fonts.css` ships `font-display: swap` — so until the woff2 lands the
  // measure below is a fallback's. Helvetica-class metrics resolve it to about
  // 453.8px, which fails the floor asserted at the end of this test, and
  // DejaVu's about 519.1px, which squeaks under the ceiling. Both are the
  // wrong direction to leave to a race.
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const measured = await page.evaluate(() => {
    const line = document.querySelector('p.card-context');
    if (line === null) throw new Error('no context line');
    const spans = [...line.querySelectorAll('span')];
    const before = (span: Element): { content: string; color: string } => {
      const style = getComputedStyle(span, '::before');
      return { content: style.content, color: style.color };
    };
    const paragraph = document.querySelector('p.metadata-synopsis');
    const column = document.querySelector('.card-head-main');
    if (paragraph === null || column === null) throw new Error('no synopsis, or no column round it');
    return {
      parts: spans.length,
      lineColor: getComputedStyle(line).color,
      separators: spans.map(before),
      // `max-width: 68ch` resolved by the browser, in px. Read back rather
      // than recomputed here: `ch` is the advance of `0` in whatever face
      // actually loaded, which is the one number this test cannot derive.
      measure: parseFloat(getComputedStyle(paragraph).maxWidth),
      synopsisWidth: paragraph.getBoundingClientRect().width,
      columnWidth: column.getBoundingClientRect().width,
      viewport: window.innerWidth,
    };
  });

  // Three parts, so there are two adjacencies to draw a separator into and one
  // span that must not get one.
  expect(measured.parts).toBe(3);
  // `'none'`, not `'" · "'`: the sibling selector skips the first span, which
  // is what keeps a card whose only part is a running time from opening with a
  // stray dot. `textContent` cannot tell these two cases apart at all.
  expect(measured.separators[0]?.content).toBe('none');
  expect(measured.separators[1]?.content).toBe('" · "');
  expect(measured.separators[2]?.content).toBe('" · "');
  // And the reason the separator is CSS rather than a `' · '` in a JS join,
  // which is the only thing a join genuinely could not do: the dots are a
  // tone lighter than the words either side of them (`--color-text-faint`
  // against `--color-text-dim`, measured as rgb(143,136,124) against
  // rgb(107,100,89)). Asserted as a difference rather than as two literals so
  // it survives a palette change and still fails if the rule's `color` goes.
  expect(measured.separators[1]?.color).not.toBe(measured.lineColor);

  // The synopsis's measure. `card.css` caps it at `68ch`, which at
  // `--text-meta` (0.75rem = 12px) in self-hosted IBM Plex Sans resolves to
  // 489.6px — measured here, not computed, and only trustworthy because the
  // face is loaded by the time this runs. The band is wide enough to survive
  // a font revision and narrow enough that changing 68ch to anything a
  // typographer would argue about fails it; deleting the cap makes
  // `max-width` compute to `none`, `parseFloat` return `NaN`, and both
  // assertions below fail.
  expect(measured.measure).toBeGreaterThan(460);
  expect(measured.measure).toBeLessThan(520);
  expect(measured.synopsisWidth).toBeLessThanOrEqual(measured.measure + 0.5);

  // And that the cap is what is actually holding the line length, rather than
  // a dead letter the column already satisfies — the claim `card.css` makes in
  // prose beside the rule, unguarded until now and due to be invalidated by
  // phase 3's master/detail Browse, the next thing to change this column.
  //
  // This fixture leaves `posterUrl` null and `performers` empty, so it draws no
  // slot and its identity column is the card's full inner width: 777.3px
  // against the cap's 489.6, at this project's 1280px viewport. `.app` is
  // `max-width: 60rem` plus `var(--space-4)` of padding a side and nothing in
  // `src/styles` resets `box-sizing`, so its border box measures 992px and the
  // layout stops changing at a 992px viewport, not at 960 — measured. Below
  // that the column tracks the window and the cap stops binding near 705px
  // (750px → 535px column, 700px → 485px).
  //
  // With a slot — 71% of the library, per spec §6 — the column loses the 98px
  // frame and a 16px gap and runs 663.3px, so the cap binds there too but
  // stops nearer an 818px viewport (820px → 491.3px column, still capped;
  // 818px → 489.3px, no longer). Both shapes clear it on any desktop window;
  // it is the figures that do not generalise, not the conclusion.
  expect(measured.viewport).toBeGreaterThanOrEqual(992);
  expect(measured.columnWidth).toBeGreaterThan(measured.measure);
});
