import type { MetadataCandidate } from '@pickarr/plugin-api';
import { expect, test } from '../src/harness.ts';

/**
 * The seam this suite exists to prove: request → worker → poll → patch.
 *
 * `useGroupMetadata.test.tsx` proves the hook polls correctly against a
 * mocked `fetch`, and `metadata.test.ts` proves `runMetadataPass` writes the
 * right row against a real database. Neither can prove the two ever meet:
 * a component test's mock *is* the contract it is supposed to be checking,
 * and a pipeline test never opens a browser. Only a real page, open against
 * a real server, watching a real background pass land, tells you the card
 * the user is looking at actually changes — as opposed to changing only the
 * database row underneath it, or only what a fresh page load would show.
 *
 * The release name is `manual.spec.ts`'s own `Vixen...Alex.Coal...` title, so
 * the group's `display.subtitle` ("Vixen") and `display.date` ("2023-04-15")
 * are exactly what the scenes plugin's `sceneMetadataQuery` needs to build a
 * query at all — a group with no confirmed site is never queued in the first
 * place (see `sceneMetadataQuery`'s own doc comment), so this release was
 * chosen because it already has one.
 */
const RELEASE = 'Vixen.23.04.15.Alex.Coal.XXX.1080p.MP4-KTR';

/**
 * A scene on-site and within the query's date window, which is all
 * `confirmSceneMetadata` requires to confirm without any title comparison:
 * exactly one candidate inside the window settles it. `posterUrl: null`
 * keeps this test out of `cacheImage`'s file-writing path entirely — the
 * poster route is `MediaCard.test.tsx`'s and `metadata.test.ts`'s job, not
 * this one's.
 */
function confirmedCandidate(): MetadataCandidate {
  return {
    sourceUuid: 'e2e-scene-1',
    title: 'Alex Coal',
    siteUuid: null,
    siteId: null,
    siteName: 'Vixen',
    date: '2023-04-15',
    performers: [
      {
        sourceUuid: 'e2e-performer-1',
        slug: 'alex-coal',
        name: 'Alex Coal',
        kind: 'performer',
        faceUrl: null,
        imageUrl: null,
      },
    ],
    durationSeconds: null,
    synopsis: 'A confirmed test synopsis.',
    posterUrl: null,
    slug: null,
  };
}

test('a card gains its metadata panel without a reload once the worker confirms it', async ({
  page,
  harness,
}) => {
  harness.ingest([RELEASE]);
  harness.metadataClient.setCandidates([confirmedCandidate()]);

  // Registered before navigation: `useGroupMetadata` fires its enqueueing
  // `POST` from an effect that runs as soon as Browse mounts, and the request
  // must be caught wherever in that window it lands, not raced afterward.
  const enqueued = page.waitForResponse(
    (response) =>
      response.url().includes('/api/metadata/request') && response.request().method() === 'POST',
  );

  await page.goto('/');

  const card = page
    .locator('article.media-card')
    .filter({ has: page.getByRole('heading', { name: 'Alex Coal' }) });
  await expect(card).toHaveCount(1);

  // `section.metadata` is gone as of the artwork-leads-the-card phase — the
  // scene's synopsis and cast now render directly inside `.card-head-main`,
  // the identity column, rather than inside a panel below the releases.
  // `main` names it for what it actually is now: the identity column, which
  // *contains* the scene metadata among the title, context line, badge,
  // identity form, actions and field chips — it is not a metadata region of
  // its own, and no `role="region"` survives on the card at all now that the
  // labelled `<section>` is gone.
  const main = card.locator('.card-head-main');

  // The point of this test: nothing has answered the group yet, so browse's
  // own response carried `state: 'absent'` and the identity column renders
  // no synopsis yet — not an empty one. `.card-head-main` itself always
  // renders (it also holds the title and fields), so the synopsis is what
  // this has to check now.
  await expect(main.locator('.metadata-synopsis')).toHaveCount(0);

  // Wait for the SPA's own enqueue to actually land before draining the
  // queue — the row `runMetadataPass` needs has to exist first, and this is
  // the same enqueue a spec has no other way to observe from outside.
  await enqueued;

  // The worker in production runs on a timer nothing here starts; this is
  // the substitute `runMetadataPass` drains the queue with, directly, the
  // way `packages/e2e/src/harness.ts`'s `reconcile()` drives the reconcile
  // pipeline in place of the scheduler.
  const result = await harness.runMetadataPass();
  expect(result.confirmed).toBe(1);
  expect(harness.metadataClient.searched).toHaveLength(1);

  // Nothing reloads the page from here on. This assertion can only pass
  // because `useGroupMetadata`'s own poll picks up the confirmed answer and
  // React re-renders the mounted card — if the SPA only refreshed metadata
  // on the initial browse response (the bug this whole file exists to catch),
  // the synopsis would never appear and this would time out. Waiting on
  // `main` itself would prove nothing any more: `.card-head-main` is
  // already visible before the poll ever lands.
  await expect(main.locator('.metadata-synopsis')).toBeVisible({ timeout: 10_000 });
  await expect(main.locator('.metadata-synopsis')).toHaveText('A confirmed test synopsis.');
  // The whole stack round-trips a performer now: storage, the display view,
  // and the card all carry `MetadataPerformer`'s structured shape rather than
  // the bare names it replaced.
  await expect(main.locator('.metadata-performers li')).toHaveText(['Alex Coal']);
});
