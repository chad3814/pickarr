import type { MetadataCandidate } from '@pickarr/plugin-api';
import { expect, test } from '../src/harness.ts';

/**
 * The card's own geometry, in a real browser.
 *
 * Nothing in the unit suite can answer this. happy-dom parses the CSS but
 * lays nothing out, so every box it reports is zero-sized — an overlap test
 * against it would pass whatever the stylesheet said. The question is only
 * askable where boxes have positions, which is here.
 */

const RELEASE = 'Vixen.23.04.15.Alex.Coal.XXX.1080p.MP4-KTR';

/**
 * 8 x 2000, 1-bit greyscale, 84 bytes — the same deliberately extreme shape
 * `metadata-modal.spec.ts` uses, and for the same reason: a browser handed
 * undecodable bytes renders a broken image with no intrinsic size, and an
 * image with no size cannot overlap anything. The tallest plausible poster is
 * also the one most likely to reach the rows below it, which is exactly the
 * case under test.
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

test('a tall poster grows the card head instead of covering the releases', async ({
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
  const poster = page.getByRole('button', { name: /poster for/i }).locator('img');
  await expect(poster).toBeVisible();

  const posterBox = await poster.boundingBox();
  const firstRelease = page.locator('.release-row').first();
  await expect(firstRelease).toBeVisible();
  const releaseBox = await firstRelease.boundingBox();
  if (posterBox === null || releaseBox === null) throw new Error('no layout boxes');

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
});
