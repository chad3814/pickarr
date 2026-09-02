import { expect, test } from '../src/harness.ts';

/**
 * The bug this exists for: **a merge's response shape has to be read correctly
 * or the list keeps a card for a group that no longer exists.**
 *
 * `PATCH /api/groups/:id` answers with the *surviving* group plus `mergedInto`.
 * On a merge the surviving group is the target, not the one the request named —
 * so a handler that ignores `mergedInto` and patches "the group that came back"
 * by its own id leaves the source card standing beside a target that has just
 * absorbed its releases. Two cards, one set of releases, and — once the target
 * is on a page that has been loaded twice over — duplicate React keys.
 *
 * Why the existing suite could not see it. Which group survives is decided by
 * `editGroup` in the database: it depends on whether an identity key the plugin
 * built from typed values happens to match a row that already exists. A stubbed
 * `fetch` has to be *told* which of the two ids came back, so the fixture
 * encodes the very answer the bug gets wrong, and the component test then agrees
 * with itself. Only a real save against a real database decides it.
 *
 * The first test covers the other half of the manual path: a name the parser
 * refused, described by hand, has to land in the group its identity names —
 * which is the same server-side decision (`findGroup` on a rebuilt key) read
 * from the other end.
 */

/** The one name in here the parser genuinely refuses; the refusal is the point. */
const REFUSED = 'agmx.084.4k';

test('a refused name described by hand joins the group its identity names', async ({
  page,
  harness,
}) => {
  const parsed = 'Vixen.23.04.15.Alex.Coal.XXX.1080p.MP4-KTR';
  harness.ingest([parsed]);
  const refused = harness.ingest([REFUSED]);
  // If the parser ever learns to read this name the test still has to fail
  // loudly, rather than quietly passing with no failed card on Browse.
  expect(refused.parseErrors).toBe(1);

  await page.goto('/');
  const row = page.locator('article.failed-card').filter({ hasText: REFUSED });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Fix' }).click();
  const form = row.locator('form.manual-form');
  // The identity of the release that already parsed, typed by hand. Nothing in
  // the values says "join group N" — the server rebuilds the key and finds it.
  await form.getByLabel('Site', { exact: true }).fill('Vixen');
  await form.getByLabel('Anchor', { exact: true }).selectOption('date');
  await form.getByLabel('Date', { exact: true }).fill('2023-04-15');
  await form.getByLabel('Scene', { exact: true }).fill('Alex Coal');
  await form.getByRole('button', { name: 'Save' }).click();

  // Browse's list is not only failures, so it has no "Nothing failed to
  // parse" equivalent to assert on; the card leaving is the fact that matters.
  await expect(row).toHaveCount(0);
  await expect(page.locator('p.notice')).toHaveText('Alex Coal joined an existing group');

  // The merge is not patched into the loaded card — Browse only drops the
  // fixed name, the same "the resolved group does not appear until the next
  // load" rule `Browse.test.tsx` pins — so a fresh load is what shows the
  // release having actually landed under Alex Coal's group.
  await page.reload();
  const card = page
    .locator('article.media-card')
    .filter({ has: page.getByRole('heading', { name: 'Alex Coal' }) });
  const releases = card.locator('li.release-row');
  await expect(releases).toHaveCount(2);
  await expect(releases.filter({ hasText: REFUSED })).toHaveCount(1);
  await expect(releases.filter({ hasText: parsed })).toHaveCount(1);
});

test('editing a group into another merges it and leaves no card behind', async ({
  page,
  harness,
}) => {
  const target = 'Tushy.23.05.02.Emma.Stone.XXX.1080p.MP4-KTR';
  const source = 'Blacked.23.06.11.Jane.Doe.XXX.720p.MP4-KTR';
  // One tick, so both groups sit on the same page with nothing else on it.
  harness.ingest([target, source]);

  await page.goto('/');
  const cards = page.locator('article.media-card');
  await expect(cards).toHaveCount(2);

  const sourceCard = cards.filter({ has: page.getByRole('heading', { name: 'Jane Doe' }) });
  // Exact, because every release row carries an "Edit quality" button whose
  // accessible name contains this one.
  await sourceCard.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = sourceCard.locator('form.manual-form');
  // Retyped into the other group's identity. `anchorKind` is already `date` from
  // the prefill, so only the three fields that differ are touched — which is
  // what a user correcting a mis-parsed studio actually does.
  await form.getByLabel('Site', { exact: true }).fill('Tushy');
  await form.getByLabel('Date', { exact: true }).fill('2023-05-02');
  await form.getByLabel('Scene', { exact: true }).fill('Emma Stone');
  await form.getByRole('button', { name: 'Save' }).click();

  // A merge always needs confirming now (2026-08-16's identity-change work),
  // regardless of whether either side is picked — `needsConfirmation` gates on
  // `plan.kind === 'merge'` alone. Nothing here moves a file (neither release
  // is downloaded), so the dialog names only the merge target, not a rename.
  await expect(page.getByRole('dialog', { name: 'Confirm identity change' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();

  // The source card is gone — this is the assertion the `mergedInto` bug fails.
  await expect(page.getByRole('heading', { name: 'Jane Doe' })).toHaveCount(0);
  // One card, not two and not two copies of one: the count is what catches a
  // duplicate as well as a survivor.
  await expect(cards).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Emma Stone' })).toHaveCount(1);
  await expect(page.locator('p.notice')).toHaveText('Releases moved into Emma Stone');

  // The target was patched with what the server returned, not left as it was:
  // it now holds both releases.
  const releases = cards.locator('li.release-row');
  await expect(releases).toHaveCount(2);
  await expect(releases.filter({ hasText: target })).toHaveCount(1);
  await expect(releases.filter({ hasText: source })).toHaveCount(1);
});
