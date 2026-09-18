/**
 * The 2.0 web shell, end to end: a real Chromium against the real built SPA
 * and a real in-process host (`../src/harness-2.ts`).
 *
 * This is the net task 3 removed and nothing replaced until now -- tasks 4
 * through 7 shipped IndexedDB storage, Web Locks leader election and both
 * sync cursors with no browser ever having run any of it, proven only by
 * `node --test` under happy-dom. The fourth spec below is the sharper half
 * of that: Node's own `navigator.locks` is per-*process*, so every existing
 * two-tab leader-election test only *models* a browser's per-*origin* one.
 * This file is the first thing that actually opens two tabs.
 *
 * **No spec here reads a session cookie's value.** Every credential this
 * suite ever holds -- the claim token, a password -- is typed into a form or
 * read off the database directly (`harness-2.ts`'s own doc); the cookie
 * itself lives entirely in the browser's jar, exactly as production leaves
 * it (Global Constraint).
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../src/harness-2.ts';

const PASSWORD = 'correct horse battery staple, not a real credential';

/** Claims the install through the real form: the toggle, the three fields, the submit. */
async function claimInstall(page: Page, email: string, claimToken: string): Promise<void> {
  await page.getByRole('button', { name: 'First time here? Claim this install' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Claim token').fill(claimToken);
  await page.getByRole('button', { name: 'Claim this install' }).click();
}

test('the app loads from the host, including a deep link that is not /', async ({ page, harness }) => {
  const response = await page.goto(`${harness.origin}/library/some/deep/link`);
  expect(response?.status()).toBe(200);

  const heading = page.getByRole('heading', { name: 'Sign in' });
  await expect(heading).toBeVisible();

  // `toBeVisible()` alone would still pass against an unstyled block of text
  // (`CLAUDE.md`'s own testing hazard on this exact gap). `base.css`'s `h1`
  // rule sets `font-weight: 600`, where the browser's own UA default for an
  // unstyled `h1` is bold (700) -- so this fails the moment the stylesheet
  // does not apply, which a malformed `Content-Type` on the CSS asset would
  // cause and which the plan's own self-review names as this suite's job to
  // catch (task 8's brief).
  const fontWeight = await heading.evaluate((el) => getComputedStyle(el).fontWeight);
  expect(fontWeight).toBe('600');
});

test('sign-up with the claim token creates the account, and a second is refused', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);

  // A real heading, not just an `aria-label` -- the same distinction
  // `CLAUDE.md` draws: the announced name and the visible one must be the
  // same string, sourced from the one thing on screen.
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

  // Sign out -- ending the session is the only door back to the sign-in
  // form once an account exists (`App.tsx`'s own doc) -- and try to claim a
  // second account. The install is claimed now, so any token is refused
  // (`packages/host/src/auth/instance.ts`'s `SIGN_UP_REFUSED`), in the exact
  // words a wrong token gets too.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await claimInstall(page, 'intruder@example.invalid', harness.claimToken);

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('heading')).toHaveText(
    'That claim token did not work. Check it and try again.',
  );
});

test('after sign-in the counts climb above zero', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  // Zero before anything is seeded: an empty replica, not a fetch this hook
  // is forbidden from making (Global Constraint; `useCounts.ts`'s own doc).
  const tvCount = page.getByTestId('count-tv');
  await expect(tvCount).toHaveText('0');
  await expect(page.getByTestId('count-movie')).toHaveText('0');
  await expect(page.getByTestId('count-xxx')).toHaveText('0');

  // Written straight into the host's database, not through a feed or a
  // plugin -- `harness-2.ts`'s own doc explains why `media_item` needs
  // neither. From here the row can only reach the screen through the real
  // path: the tail's next poll, a real `sync_log` trigger, a real
  // `/api/sync` response, a real IndexedDB write, and a real
  // `subscribeInserts` wake -- the whole chain the storage slice's
  // whole-branch review flagged as never having run in a browser.
  harness.seedMediaItem('tv', 'A Show');
  harness.seedMediaItem('movie', 'A Movie');
  harness.seedMediaItem('xxx', 'An Item');

  await expect(tvCount).toHaveText('1', { timeout: 15_000 });
  await expect(page.getByTestId('count-movie')).toHaveText('1', { timeout: 15_000 });
  await expect(page.getByTestId('count-xxx')).toHaveText('1', { timeout: 15_000 });
});

test('two tabs: exactly one fetches, and the follower still sees counts climb', async ({ page, context, harness }) => {
  // Node's own `navigator.locks` is per-process, so every test up to this
  // one that claims to cover leader election only modelled a browser's
  // per-origin lock manager. This is the first spec that actually opens two
  // tabs in one origin and lets a real browser arbitrate between them --
  // the property this whole slice exists to reach (task 8's brief).
  const leaderSyncPaths: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/sync')) leaderSyncPaths.push(pathname);
  });

  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();
  await expect(page.getByTestId('count-tv')).toHaveText('0');

  // This tab requested the lease first, and nothing in this test ever calls
  // `stop()` on it -- `leader.ts`'s lease is releasable since the fix round
  // (`stop()` calls it), but this leader simply never releases during the
  // test's life -- so waiting for its first sync request before the second
  // tab even opens is what makes it the leader deterministically, rather
  // than by which of two racing requests the browser happened to grant
  // first.
  await expect.poll(() => leaderSyncPaths.length).toBeGreaterThan(0);

  // The same browser context, not a second one: two contexts are two
  // storage partitions, and this test needs one origin's one lock manager
  // and one origin's one IndexedDB database, exactly as two tabs of one
  // real browser window share both.
  const follower = await context.newPage();
  const followerSyncPaths: string[] = [];
  follower.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/sync')) followerSyncPaths.push(pathname);
  });
  await follower.goto(harness.origin);
  // `App` starts optimistically authenticated (its own doc) and the session
  // cookie is already in this context's jar, so the follower reaches `Shell`
  // with no sign-in step of its own.
  await expect(follower.getByRole('heading', { name: 'Pickarr' })).toBeVisible();
  await expect(follower.getByTestId('count-tv')).toHaveText('0');

  harness.seedMediaItem('tv', 'A Show');

  await expect(page.getByTestId('count-tv')).toHaveText('1', { timeout: 15_000 });
  await expect(follower.getByTestId('count-tv')).toHaveText('1', { timeout: 15_000 });

  expect(leaderSyncPaths.length).toBeGreaterThan(0);
  // The follower's whole path to that same '1' was IndexedDB and a
  // `BroadcastChannel` message (`sync.ts`'s own doc on `onMessage`) -- if it
  // ever fetched at all, the lease it queued behind failed to do its one
  // job.
  expect(followerSyncPaths).toEqual([]);
});

test('a reload finds the replica already populated', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  harness.seedMediaItem('tv', 'A Show');
  await expect(page.getByTestId('count-tv')).toHaveText('1', { timeout: 15_000 });

  // Every `/api/*` call refused before reloading -- not merely "reload
  // quickly enough that a refetch has not landed yet". Counts come from the
  // replica only (Global Constraint; storage design spec §9): a count that
  // only looked right because it quietly refetched on reload would pass a
  // timing-based version of this test just as easily as the honest replica
  // does, and this is the one screen that must not hide the difference.
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    await route.abort();
  });
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();
  await expect(page.getByTestId('count-tv')).toHaveText('1');
});

test('a healthy tab does not poll the tail far faster than its 3-second rate', async ({ page, harness }) => {
  // The whole-branch review's Finding 1, pinned in a real browser rather
  // than only against `manualScheduler`'s stubbed clock (`adapters.test.ts`'s
  // own unit test covers that half). `sync.ts`'s `TAIL_INTERVAL_MS = 3000` is
  // documented as a fixed *rate*, not a fixed delay -- about two `/api/sync`
  // polls in six seconds -- and that only holds if `idleScheduler` treats its
  // `delayMs` as a floor. Measured before this fix: an idle Chromium tab
  // polled the tail **1015 times in 6 seconds**, because `delayMs` was handed
  // to `requestIdleCallback` as its own `timeout` (a "run by" cap, not a "run
  // no sooner than" floor), so an idle browser ran it almost immediately
  // every time.
  //
  // The window and the bound are both deliberately loose, and the window is
  // deliberately *short*. A re-review measured both versions over one second:
  // the floor honoured gives **1** poll, the floor removed gives **481**. So
  // two seconds is already twenty times the separation this needs, and the six
  // seconds this first used cost the whole e2e suite about five of them to
  // learn nothing more. A bound that loose also cannot flake on a slow CI
  // runner, while still failing hard the moment the floor stops holding.
  const tailRequestPathnames: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    // The tail's own url (`/api/sync?since=...`), not the one-shot
    // `/api/sync/bootstrap` or `/api/sync/backfill` -- both different
    // pathnames, so neither is counted here.
    if (pathname === '/api/sync') tailRequestPathnames.push(pathname);
  });

  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await page.waitForTimeout(2_000);

  expect(tailRequestPathnames.length).toBeLessThan(10);
});

/*
 * Task 8: `library.css`'s own pin. Nothing before this task asserted
 * anything about layout -- the deep-link spec's `font-weight` check above is
 * the only computed-style assertion this suite had, and it covers `base.css`
 * alone. Each spec below is a computed style a real browser resolves through
 * the cascade, one per screen `library.css` styles, chosen so that deleting
 * its stylesheet breaks it (task 8's own acceptance step, run and reported
 * separately from this diff): `getByRole` and `toBeVisible()` are satisfied
 * by an unstyled block of text just as well as a styled one (`CLAUDE.md`'s
 * own testing hazard on this exact gap), so none of these reach for either.
 */

test('the nav is pinned to the viewport, not just present', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  // `toBeVisible()` would still pass against a nav that never left normal
  // document flow. `base.css`'s bare `nav` rule sets `position: sticky`,
  // which the UA default never does.
  await expect(page.getByRole('navigation')).toHaveCSS('position', 'sticky');
});

test('a media item renders as a card, not a bare block of text', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  harness.seedMediaItem('tv', 'A Show');

  // `library.css`'s bare `article` rule gives the card a border radius the
  // UA default never applies to an `<article>`.
  const card = page.getByRole('article');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveCSS('border-radius', '10px');
});

test("a media item's release list is laid out as a list, not just present", async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  harness.seedMediaItem('tv', 'A Show');

  const disclosure = page.getByRole('button', { name: 'A Show' });
  await expect(disclosure).toBeVisible({ timeout: 15_000 });
  await disclosure.click();

  // `library.css`'s `ul[aria-label='releases']` rule sets `list-style-type:
  // none`, which the UA default (`disc`) never does.
  const releases = page.getByRole('list', { name: 'releases' });
  await expect(releases).toHaveCSS('list-style-type', 'none');
});

test('the empty state reads as an aside, not as content waiting to be filled in', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  // `/unmatched` has no nav link of its own (`Shell.tsx`'s nav only maps
  // over the three categories), so this is a direct navigation rather than a
  // click -- the same deep-link path the first spec in this file exercises,
  // now while already signed in.
  await page.goto(`${harness.origin}/unmatched`);

  // `library.css`'s `section > p` rule sets `font-style: italic`, which the
  // UA default never does.
  const empty = page.getByText('Everything has been matched.');
  await expect(empty).toBeVisible();
  await expect(empty).toHaveCSS('font-style', 'italic');
});
