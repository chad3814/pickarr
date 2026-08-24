import type { Page } from '@playwright/test';
import type { MetadataCandidate } from '@pickarr/plugin-api';
import { expect, test, type Harness } from '../src/harness.ts';

/**
 * The seam this suite exists to prove: `ImageModal`'s Escape handling, in a
 * real browser.
 *
 * happy-dom implements `<dialog>.showModal()` but not Escape-to-close: an
 * open dialog given a bubbling, cancelable `keydown` with `key: 'Escape'`
 * stays `open` and fires neither `cancel` nor `close`. A unit test asserting
 * the modal closes on Escape would fail against correct code, and one
 * asserting it stays open would pass against broken code — the question
 * cannot be asked honestly outside a real browser, which is what this file
 * is for. `ImageModal.test.tsx` covers everything else about the component
 * (the X, the backdrop, focus) with happy-dom, deliberately leaving Escape
 * out with a comment pointing here.
 */

/** A one-tick, on-site, in-window release: enough for `confirmMetadata` to settle. */
const RELEASE = 'Vixen.23.04.15.Alex.Coal.XXX.1080p.MP4-KTR';

/**
 * Bytes good enough for `cacheImage`'s own fetch: never decoded there, only
 * checked for a recognised content type and a byte length under its cap. A
 * `data:` URL gets both of those from Node's own `fetch` — confirmed directly
 * against this Node build before writing this file — without this suite
 * reaching an actual network, the way every other fake client in
 * `harness.ts` avoids one too.
 *
 * That is the whole story for a performer's face and image, which is what
 * this suite uses it for below: `cachePerformerArtwork` never classifies what
 * it fetches, so undecodable bytes are stored exactly the same as real ones.
 * It is not the whole story for a group's poster or background —
 * `classifyArtwork` has to measure the image before `cacheImage` files it
 * under either column, and bytes it cannot decode are filed under neither.
 * `TALL_PNG` below is what a test needs when a poster or background has to
 * actually be stored, not merely fetched.
 */
function dataUrl(bytes: string): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * A poster the browser can actually decode, and a deliberately extreme shape:
 * 8 x 2000, 1-bit greyscale, all black, 84 bytes on the wire. Portrait, on
 * purpose: `classifyArtwork` measures width against height and files a
 * portrait image as the poster, a landscape one as the background, so a
 * landscape fixture here would be filed as a background instead and no
 * poster button would ever render — the same failure this file exists to
 * avoid, for a different reason.
 *
 * `dataUrl('...')` bytes are enough for a performer's face and image (see
 * that function's own comment) but not for a group's poster or background:
 * `classifyArtwork` has to measure an image before `cacheImage` files it
 * under either column, and bytes it cannot decode are stored under neither
 * name — a plausible `image/jpeg` label is not enough on its own. That is why
 * `confirmedCandidateWithArtwork` below defaults its poster to this image
 * rather than to `dataUrl(...)`, and why any test added here that needs a
 * poster or background actually *stored* has to do the same.
 *
 * The extreme aspect ratio is what the scaling test below needs, and it is
 * also why undecodable bytes could never substitute for it even before
 * `classifyArtwork` existed: a browser handed undecodable bytes renders a
 * broken image with no intrinsic size, and an image with no intrinsic size
 * fits inside any window at all. Measuring the layout means the browser has
 * to have something real to lay out.
 *
 * Regenerate with the four PNG chunks by hand if it ever needs to change — a
 * signature, IHDR (width, height, bit depth 1, colour type 0), one deflated
 * IDAT of `height` zero-filled scanlines, IEND. There is no image library in
 * this repo's dependencies and this is not a reason to add one.
 */
const TALL_PNG =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAfQAQAAAADXviPqAAAAG0lEQVR42u3BMQEAAADCoPVPbQwf' +
  'oAAAAIC3AQ+gAAFUpTheAAAAAElFTkSuQmCC';

/**
 * A confirmed candidate carrying a poster and one performer with both a face
 * (for the avatar) and a full image (for the modal a click on it opens) —
 * the shape this suite needs to reach every button `ImageModal` can be
 * opened from. `performers[0].name` is `'Alice Maze'`, unrelated to the
 * release's own parsed title ('Alex Coal'): the two are independent fields,
 * and using a different name for each is what proves this suite is reading
 * the performer's own name rather than coincidentally matching the group's.
 */
function confirmedCandidateWithArtwork(posterUrl = TALL_PNG): MetadataCandidate {
  return {
    sourceUuid: 'e2e-scene-modal',
    title: 'Alex Coal',
    siteUuid: null,
    siteId: null,
    siteName: 'Vixen',
    date: '2023-04-15',
    performers: [
      {
        sourceUuid: 'e2e-performer-modal',
        slug: 'alice-maze',
        name: 'Alice Maze',
        kind: 'performer',
        faceUrl: dataUrl('e2e-face'),
        imageUrl: dataUrl('e2e-image'),
      },
    ],
    durationSeconds: null,
    synopsis: 'A modal test synopsis.',
    posterUrl,
    slug: null,
  };
}

/**
 * Confirms `confirmedCandidateWithArtwork` against a freshly-ingested
 * `RELEASE`, drains the queue with it, and only then loads the page.
 *
 * Enqueueing and draining happen through this suite's own request to the
 * server — never by navigating first and waiting on the SPA's own enqueue,
 * the way `metadata.spec.ts` does. That suite's fixture has no poster and no
 * performers, so its group goes straight from `pending` to fully `confirmed`
 * in one write. This one's does not: `runMetadataPass` writes the confirmed
 * answer first and caches the poster and performer artwork afterward, in the
 * same call, so there is a real (if brief) window where the row reads
 * `state: 'confirmed'` with `hasPoster`/`hasAvatar` still `false`. A page
 * already mounted and polling can land in that window — and since
 * `useGroupMetadata` treats any non-`'pending'` state as settled, it would
 * never ask about this id again, leaving the avatar and poster permanently
 * unrendered for the rest of the test. Confirming everything before the page
 * ever loads means the SPA's first read is already the finished answer, with
 * no window for it to land in.
 */
async function seedConfirmedGroup(page: Page, harness: Harness, posterUrl?: string): Promise<void> {
  harness.ingest([RELEASE]);
  harness.metadataClient.setCandidates([confirmedCandidateWithArtwork(posterUrl)]);

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
}

test('the poster modal closes on Escape, on a click outside, and on the X', async ({
  page,
  harness,
}) => {
  await seedConfirmedGroup(page, harness);

  const posterButton = page.getByRole('button', { name: /poster/i });
  const dialog = page.getByRole('dialog');
  await expect(posterButton).toBeVisible({ timeout: 10_000 });

  await posterButton.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  // The property no unit test in this repo can check: happy-dom implements
  // `showModal()` but not Escape-to-close, so this assertion only means
  // anything here.
  await expect(dialog).toBeHidden();

  // Not enough on its own: a native `<dialog>` closes on Escape whether or
  // not any React handler runs, so a spec that only checked the assertion
  // above could pass against a component whose `modal` state never actually
  // cleared — it would just happen to describe a `<dialog>` the DOM had
  // already closed on its own. Reopening tells the two apart: it only
  // succeeds if the state genuinely went back to `null`, since the button
  // that opens the modal sets it fresh on every click and the effect that
  // calls `showModal()` only runs on mount.
  //
  // Verified directly rather than assumed: with `ImageModal`'s `onCancel`
  // removed, this reopen still passes — `onClose` alone, wired to the native
  // `close` event React 19 now exposes on `<dialog>`, already fires when
  // Escape's default action closes it, so the two handlers are redundant for
  // this one path. Removing *both* `onCancel` and `onClose` is what actually
  // reproduces the desync this reopen check exists to catch, and it does:
  // the second `posterButton.click()` finds no dialog, because the state
  // `onClose` would have cleared never clears, and the already-mounted
  // (native-closed) `<dialog>` element never runs `showModal()` again.
  await posterButton.click();
  await expect(dialog).toBeVisible();

  // Top-left corner: outside the centred image, inside the backdrop.
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();

  await posterButton.click();
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: /close/i }).click();
  await expect(dialog).toBeHidden();
});

test('a tall poster is scaled to fit inside the window rather than scrolled', async ({
  page,
  harness,
}) => {
  // Spec bullet 1: "a modal with a full sized image, but scaled to fit within
  // the window". This is measured in a real browser rather than argued from
  // the stylesheet, and it has to be: the property depends on the UA
  // stylesheet for <dialog> (`padding: 1em`, a border, `overflow: auto`,
  // `max-height: calc(100% - 6px - 2em)`), which is not in this repo and which
  // happy-dom does not implement. The CSS could be read as correct and be
  // wrong; only the layout the browser actually computes settles it.
  //
  // 8 x 2000 is chosen to make the failure unmissable. At the 1280x720
  // viewport `devices['Desktop Chrome']` sets, an unconstrained image is 2000
  // CSS pixels tall in a 720-pixel window — nearly three viewports of
  // overflow, not a rounding error.
  await seedConfirmedGroup(page, harness, TALL_PNG);

  const posterButton = page.getByRole('button', { name: /poster/i });
  await expect(posterButton).toBeVisible({ timeout: 10_000 });
  await posterButton.click();

  const dialog = page.getByRole('dialog');
  const image = dialog.getByRole('img');
  await expect(image).toBeVisible();

  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('this spec needs a fixed viewport to measure against');
  const box = await image.boundingBox();
  if (box === null) throw new Error('the modal image has no layout box');

  // Every edge inside the window. The bottom edge is the one that actually
  // moved: a tall image overflowed downward while its top stayed put, so
  // asserting only the height would pass for an image scrolled halfway off
  // the bottom of the screen.
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

  // And "fits" must mean scaled, not collapsed: a 0-pixel image satisfies
  // every assertion above. A 2000-tall image scaled into a 720-tall window
  // should be using essentially all of it.
  expect(box.height).toBeGreaterThan(viewport.height * 0.9);

  // The dialog itself must not have absorbed the overflow by becoming a
  // scroll container, which is the specific failure here: `overflow: auto`
  // plus a UA `max-height` means a too-tall image produces a scrollbar
  // instead of a smaller image, and the image's own `max-height: 100vh` never
  // binds because the dialog's content box is not the window.
  const scroll = await dialog.evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight);
});

test('a performer avatar opens the full image', async ({ page, harness }) => {
  await seedConfirmedGroup(page, harness);

  const avatarButton = page.getByRole('button', { name: 'Alice Maze' });
  await expect(avatarButton).toBeVisible({ timeout: 10_000 });

  await avatarButton.click();
  // The full image, not the face crop: `MediaCard` opens the modal with
  // `/api/performers/:id/image`, never `/avatar`, from a performer's avatar
  // button.
  await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute(
    'src',
    /\/api\/performers\/\d+\/image$/,
  );
});
