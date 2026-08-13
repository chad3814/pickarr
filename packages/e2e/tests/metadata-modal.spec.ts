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
 * Bytes good enough for `cacheImage`: never decoded, only checked for a
 * recognised content type and a byte length under its cap. A `data:` URL
 * gets both of those from Node's own `fetch` — confirmed directly against
 * this Node build before writing this file — without this suite reaching an
 * actual network, the way every other fake client in `harness.ts` avoids one
 * too.
 */
function dataUrl(bytes: string): string {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
}

/**
 * A confirmed candidate carrying a poster and one performer with both a face
 * (for the avatar) and a full image (for the modal a click on it opens) —
 * the shape this suite needs to reach every button `ImageModal` can be
 * opened from. `performers[0].name` is `'Alice Maze'`, unrelated to the
 * release's own parsed title ('Alex Coal'): the two are independent fields,
 * and using a different name for each is what proves this suite is reading
 * the performer's own name rather than coincidentally matching the group's.
 */
function confirmedCandidateWithArtwork(): MetadataCandidate {
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
    posterUrl: dataUrl('e2e-poster'),
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
async function seedConfirmedGroup(page: Page, harness: Harness): Promise<void> {
  harness.ingest([RELEASE]);
  harness.metadataClient.setCandidates([confirmedCandidateWithArtwork()]);

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
