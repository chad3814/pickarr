import { expect, test } from '../src/harness.ts';

/**
 * The bug this exists for: **the Retry button never worked, for the whole life
 * of the feature.**
 *
 * `api.retry` sent `content-type: application/json` on a POST with no body, so
 * Fastify's JSON parser answered `400 FST_ERR_CTP_EMPTY_JSON_BODY` before
 * `/api/downloads/:id/retry` ever ran, and the caller had no catch — a silent
 * 400 on every click.
 *
 * Why the existing suite could not see it. The route's server test called it
 * through `inject` with no content-type header, so it exercised a request no
 * browser makes. The web tests stub `globalThis.fetch`, so the headers the
 * client sets are handed to a mock that ignores them and answers with a
 * fixture. Each half passed against its own idea of the other. Only a real
 * browser issuing a real request at a real Fastify instance puts the header
 * and the parser in the same place, which is the only place the bug exists.
 *
 * Two independent fixes now close it — the client sets the header only when
 * there is a body, and the server registers a JSON parser that reads an empty
 * body as `{}`. This spec is above both of them: it clicks the button and
 * asks whether the row left `failed`, so it fails if either the header rule or
 * the parser is removed and the other is not there to cover for it.
 *
 * Both halves already have their own narrow unit pin, and reverting only one
 * of them leaves this spec green — the other half of the fix covers for it,
 * same as it covered for the original bug. That is expected, not a sign this
 * spec is redundant: it exists for the case where *both* halves regress
 * together, which a narrow pin aimed at one half cannot see. If you revert one
 * half and this spec stays green, check the pin for the half you didn't touch
 * before concluding it's worthless:
 *   - client half: `packages/web/test/Downloads.test.tsx` — "a bodyless
 *     request carries no json content-type"
 *   - server half: `packages/core/test/http/server.test.ts` — "retry takes no
 *     body, and is not refused for having none"
 */
test('Retry takes a failed download out of failed', async ({ page, harness }) => {
  harness.ingest(['Vixen.23.04.15.Alex.Coal.XXX.1080p.MP4-KTR']);

  // Picked through the UI rather than by calling the API directly: the request
  // the SPA builds is the thing under test, and a hand-built one would be a
  // different request that happens to hit the same route.
  await page.goto('/');
  const card = page
    .locator('article.media-card')
    .filter({ has: page.getByRole('heading', { name: 'Alex Coal' }) });
  await card.getByRole('button', { name: 'Pick' }).click();

  // The pick is only observable here once it has reached the download client,
  // which is what hands back the ref the failure has to be reported against.
  await expect.poll(() => harness.client.added.length).toBe(1);
  const added = harness.client.added[0];
  if (added === undefined) throw new Error('the pick never reached the download client');

  // Driven to `failed` through the real reconcile pipeline rather than by
  // writing the row: `failed` is a state the scheduler produces, and a
  // hand-written one could differ from it in exactly the column the UI reads.
  harness.client.setSnapshot({
    queue: [],
    history: [
      {
        ref: added.ref,
        name: added.name,
        outcome: 'failed',
        storagePath: null,
        failMessage: 'unpack failed at the client',
        category: null,
      },
    ],
    complete: true,
  });
  const reconciled = await harness.reconcile();
  expect(reconciled.failed).toBe(1);

  await page.getByRole('link', { name: 'Downloads' }).click();
  const row = page.locator('li.download-row').filter({ hasText: 'Alex Coal' });
  await expect(row.locator('.download-status')).toHaveText('failed');
  await expect(row.locator('.download-error')).toHaveText('unpack failed at the client');

  await row.getByRole('button', { name: 'Retry' }).click();

  // `queued` is what `resetForRetry` produces for a row with no storage path,
  // and nothing here reconciles again yet, so the row stays there. Asserting
  // the status rather than the button's absence is deliberate: the button
  // would also disappear if the row vanished entirely.
  await expect(row.locator('.download-status')).toHaveText('queued');
  await expect(row.locator('.download-error')).toHaveCount(0);
  // The 400 surfaced here, under the heading, and nowhere else. An empty error
  // slot is what says the request was accepted rather than swallowed.
  await expect(page.locator('p.error')).toHaveCount(0);

  // `queued` only proves `resetForRetry` ran; the button's actual job is the
  // re-submission that happens on the next `reconcileClient`, and a UI that
  // marks the row `queued` without ever sending it back to the client would
  // pass everything above. The client's snapshot is cleared first: it still
  // holds the `failed` history entry from the first pick, under the same
  // label this retry would be submitted with, and reconcile's double-submit
  // guard reads that as "already there" and recovers the ref rather than
  // calling `addUrl` again — so leaving it in place would hide a retry that
  // never re-sent anything.
  harness.client.setSnapshot({ queue: [], history: [], complete: true });
  await harness.reconcile();

  await expect.poll(() => harness.client.added.length).toBe(2);
  const resent = harness.client.added[1];
  if (resent === undefined) throw new Error('retry never resubmitted to the download client');
  expect(resent.url).toBe(added.url);
});
