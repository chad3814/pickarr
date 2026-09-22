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
 * suite ever holds -- the claim token, a password, a download client's api
 * key since the download clients slice, and the fake qBittorrent's own api
 * key since the picks slice -- is typed into a form, read off the database
 * directly, or never leaves Node at all (`harness-2.ts`'s own doc); the
 * cookie itself lives entirely in the browser's jar, exactly as production
 * leaves it (Global Constraint). None of the four is ever asserted on,
 * echoed into a test name, or read back out of the page.
 *
 * **Anything typed into a form here is recorded in cleartext in the
 * Playwright trace, and that trace leaves the runner.** This is the third
 * channel, and it is the one the product's own credential accounting
 * cannot see: `clients/add.ts` and the design spec both enumerate where a
 * credential goes *inside Pickarr* -- a column, a log line, a message, a
 * response body -- and a test artifact is none of those. Measured on this
 * suite's own api key by unzipping `trace.zip` from a real run, ten
 * occurrences across four files:
 *
 * - `0-trace.trace` x6 -- the `fill` action's `params.value`; the action
 *   log line `fill("...")`; and **two DOM snapshots, each serialising the
 *   masked input twice**, as `value` and as `__playwright_value_`.
 *   Playwright does not redact `type="password"` in snapshots.
 * - `test.trace` x2 -- the step title and the step's own `params.value`.
 * - `resources/<sha>.json` x1 -- the `POST /api/download-clients` request
 *   body. This one is the product's own single crossing, captured.
 * - `resources/src@<sha>.txt` x1 -- this file, which is in git anyway.
 *
 * `playwright.config.ts` keeps the trace on failure and `ci.yml:96-103`
 * uploads `test-results/` for 7 days, so a red build publishes all ten.
 * That config's `trace` comment carries the decision and why it was not
 * changed.
 *
 * **The standing constraint that makes this safe is on the values, not on
 * the tooling: every credential this suite types must be a literal
 * committed to this repo.** All three are, today. A spec that reads one
 * from `process.env`, or points at a staging instance, publishes a real
 * credential to a 7-day artifact with nothing here to stop it -- this
 * paragraph is the only thing standing in the way, which is worth knowing
 * about it.
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

/** What {@link borderTopAgainstLineToken} reads back, both sides in the browser's own canonical colour form. */
interface BorderTopProbe {
  /** The computed `border-top-color` of the first element matching the selector. */
  borderTopColor: string;
  /** `--color-line`'s own resolved value, in whichever palette this run is in. */
  lineTokenColor: string;
}

/**
 * Reads an element's computed `border-top-color` alongside the resolved
 * value of `--color-line`, so a spec can assert the two are the same colour.
 *
 * **The expectation is resolved in the browser rather than spelled as an
 * `rgb(...)` literal**, which is the opposite of what `CLAUDE.md`'s hazard
 * on computed expectations usually asks for, and deliberately so here:
 * `--color-line` has a different value in each of `tokens.css`'s two
 * palettes and nothing in this suite pins which one a given run resolves to,
 * so a literal would be a literal for one palette and wrong in the other.
 * The probe is a throwaway element carrying the same `var(--color-line)`, so
 * what comes back is the token as this run resolved it -- not anything read
 * off the rule under test, which is what would make the assertion circular.
 *
 * Shared by the two settings specs below rather than written twice: they
 * pin the same property of two different lists, and a second copy is a
 * second thing to keep in step.
 */
async function borderTopAgainstLineToken(page: Page, selector: string): Promise<BorderTopProbe> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (element === null) throw new Error(`no element matched ${sel} to read a border colour from`);
    const probe = document.createElement('div');
    probe.style.color = 'var(--color-line)';
    document.body.appendChild(probe);
    const lineTokenColor = getComputedStyle(probe).color;
    probe.remove();
    return { borderTopColor: getComputedStyle(element).borderTopColor, lineTokenColor };
  }, selector);
}

/** What {@link colorAgainstToken} reads back, both sides in the browser's own canonical colour form. */
interface TextColorProbe {
  /** The computed `color` of the first element matching the selector. */
  color: string;
  /** The named token's own resolved value, in whichever palette this run is in. */
  tokenColor: string;
}

/**
 * {@link borderTopAgainstLineToken}'s sibling for text colour, and the same
 * technique for the same reason: a colour token has a different value in
 * each of `tokens.css`'s two palettes and nothing in this suite pins which
 * one a given run resolves to, so a literal `rgb(...)` would be right in
 * one palette and wrong in the other.
 *
 * **It takes the token name, where its first version hard-coded
 * `--color-error`.** That version's own comment declined to parameterise,
 * on the ground that folding the two probes together would mean "a helper
 * whose signature carries two strings that have to agree with each other
 * -- neither of which is a better trade than the duplication, at two
 * callers". The count is what changed: the pick spec now also asserts
 * `Picking…` against `--color-text-dim`, so the alternative is three
 * near-identical functions. Only the *token* is parameterised, not the
 * property -- the border probe stays separate, which is the half of that
 * argument that still holds.
 */
async function colorAgainstToken(page: Page, selector: string, token: string): Promise<TextColorProbe> {
  return page.evaluate(([sel, tokenName]) => {
    if (sel === undefined || tokenName === undefined) throw new Error('a selector and a token name are required');
    const element = document.querySelector(sel);
    if (element === null) throw new Error(`no element matched ${sel} to read a text colour from`);
    const probe = document.createElement('div');
    probe.style.color = `var(${tokenName})`;
    document.body.appendChild(probe);
    const tokenColor = getComputedStyle(probe).color;
    probe.remove();
    return { color: getComputedStyle(element).color, tokenColor };
  }, [selector, token]);
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

/*
 * Acceptance 1's own three strings, spelled out rather than composed.
 *
 * `TV_HEADLINE` is **not** built from the other two plus `S02E47`, and that
 * is deliberate: `CLAUDE.md`'s `groupAnchor` hazard is a test whose expected
 * value was computed by the code under test, and `plugin-tv`'s `tvHeadline`
 * is exactly such a producer -- it decides the separator, the order, the
 * `SxxEyy` form, the two-digit padding, and whether the item's own title is
 * appended at all. A template built from the seeded parts would move with
 * every one of those. The literal is the only end of this that the plugin
 * cannot change under the test.
 *
 * The values themselves are the plan's, and each is carrying its weight:
 * season 2 and episode 47 both pad (`S02`, and `E47` proving the pad does
 * not truncate), and the item title differs from the series title, which is
 * the branch `tvHeadline` drops the title on.
 */
const TV_SERIES = "Jo Jo's Bizarre Adventure";
const TV_ITEM_TITLE = "Dio's World(3)";
const TV_HEADLINE = "Jo Jo's Bizarre Adventure S02E47 Dio's World(3)";

/*
 * **The one spec that proves a plugin owns its card body, in a browser.**
 * Acceptance 1 of the plugin-cards design says a TV row reads its series and
 * episode *before being expanded*, and for six tasks the only evidence was
 * jsdom: this harness declared `synced: []` for every plugin, so there was
 * no `tv_release` table to seed, `TvCard` fell back to `item.title`, and the
 * rendered text was byte-identical to the shared card the plugin cards
 * replaced. `harness.seedTvRelease` is the capability that closes that
 * (`../src/harness-2.ts`'s own doc on what it had to change to get there).
 *
 * Four things, none of which the other browse specs above can see:
 *
 * 1. The headline is `plugin-tv`'s, on **rendered text** -- `toHaveText`
 *    reads `textContent`, not an accessible name, which is the distinction
 *    `CLAUDE.md`'s longest hazard is about.
 * 2. It is there while the row is **collapsed**: `aria-expanded="false"`,
 *    and no release list in the DOM at all.
 * 3. `library.css`'s `article h2 button` rule reaches markup that now lives
 *    in `@pickarr/plugin-tv`. `text-align: left` is the pin, and it has
 *    exactly one producer -- `grep -rn '^ *text-align:'
 *    packages/web/src/styles/` answers one line, that rule's -- while the
 *    UA default for a `<button>` is `center`. So both mutations red it: the
 *    rule deleted, and the stylesheet emptied. The task report has the
 *    observed output of each.
 * 4. `article img` still reaches the poster, which is the whole reason the
 *    `<article>` stayed in `packages/web/src` when the card body left
 *    (`MediaItemCard.tsx`'s own doc, task 6's report §2). Nothing pinned
 *    that, so the decision could have been reversed without a red test.
 *    This is the suite's only spec whose poster actually loads -- every
 *    other one 404s its artwork, and `MediaItemCard`'s `onError` then takes
 *    the `<img>` out of the DOM for good, leaving nothing to measure.
 */
test('a TV card reads its series and episode before anyone expands it, under a cropped poster', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  // One call, on purpose. The `poster` row must share a batch with its
  // `media_item` or `MediaItemCard`'s `posterFailed` latches on a 404 and
  // there is no `<img>` left to measure; the `tv_release` shares it so that
  // what this spec asserts is the headline on a row nobody has expanded and
  // nothing has woken, rather than the late-arrival recovery path
  // `usePluginRows` grew in fix round 1. `Harness.seedTvRelease`'s own doc
  // has both, and says which of the two is mandatory.
  harness.seedTvRelease({
    title: TV_ITEM_TITLE,
    seriesTitle: TV_SERIES,
    seasonNumber: 2,
    episodeNumber: 47,
    withPoster: true,
  });

  const card = page.getByRole('article');
  const headline = card.getByRole('heading').getByRole('button');

  // The full round trip: three direct inserts, `media_item`'s and
  // `tv_release`'s own `AFTER INSERT` triggers into `sync_log`, this tab's
  // `/api/sync` tail, the replica, `usePluginRows`' batched read, and
  // `TvCard` composing the line out of `rows.tv_release`.
  await expect(headline).toHaveText(TV_HEADLINE, { timeout: 15_000 });

  // Collapsed, which is the whole claim. `TvCard` renders its `ReleaseList`
  // only while expanded, so a zero count here is stronger than the
  // attribute alone: it rules out a card that reported itself closed while
  // showing its contents.
  await expect(headline).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('list', { name: 'releases' })).toHaveCount(0);

  // `library.css`'s `article h2 button`, reaching an element rendered by
  // another package -- see this spec's own comment, point 3.
  await expect(headline).toHaveCSS('text-align', 'left');

  // `library.css`'s `article img`, reaching the poster web kept. All three
  // declarations, because all three are what "a 96px frame at 2:3, cropped"
  // means and any one of them alone leaves the other two free to drift.
  // `96px` is `--size-poster`'s `6rem` against an unchanged root font size;
  // the seeded bytes are 1x1, so every number here comes from the rule and
  // none from the image.
  const poster = card.getByRole('img', { name: TV_ITEM_TITLE });
  await expect(poster).toHaveCSS('width', '96px');
  await expect(poster).toHaveCSS('aspect-ratio', '2 / 3');
  await expect(poster).toHaveCSS('object-fit', 'cover');

  // And the card is poster-led: the plugin's body starts below the poster
  // rather than beside or behind it. `boxOf` rather than `boundingBox()` --
  // see that helper's own doc; this page scrolls and viewport coordinates
  // are not a property to depend on.
  const posterBox = await boxOf(poster, 'the poster');
  const headlineBox = await boxOf(headline, 'the card headline');
  expect(headlineBox.y).toBeGreaterThanOrEqual(posterBox.y + posterBox.height);
});

test('the empty state reads as an aside, not as content waiting to be filled in', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  // A direct navigation rather than a click, deliberately: this is the
  // deep-link path the first spec in this file exercises, now while already
  // signed in. `/unmatched` does have a nav link as of the feed-settings
  // slice (spec 4's sentence presumed one, and task 5's review found it
  // missing), so a click would reach the same screen -- it would just stop
  // covering deep-linking, which is the only thing this spec is here for.
  await page.goto(`${harness.origin}/unmatched`);

  // `library.css`'s `section > p` rule sets `font-style: italic`, which the
  // UA default never does.
  const empty = page.getByText('Everything has been matched.');
  await expect(empty).toBeVisible();
  await expect(empty).toHaveCSS('font-style', 'italic');
});

/*
 * The feed-settings slice's own browser proof (task 6's brief). What this
 * spec actually measures, stated precisely rather than as "the whole
 * slice", which overclaims: the write route answers and the row lands in
 * `rss_feed`; the sync round trip carries it to this tab's replica through
 * `rss_feed`'s own `AFTER INSERT` trigger into `sync_log` and this tab's
 * `/api/sync` tail, with no dependency on anything actually polling the
 * feed; and the list re-renders from that replica, not from the POST's own
 * `{ id }` body. Plus `settings.css`'s own computed-style pin, proved
 * against deletion the same way the browse pins above were (task 6's own
 * acceptance step: delete the import, confirm this fails, restore by
 * checksum-verified copy -- run and reported separately from this diff).
 *
 * **What this spec does not cover.** `feeds/add.ts`'s four refusal
 * invariants (`unknown-plugin`, `duplicate-url`, `bad-download-type`,
 * `bad-poll-interval`) are exercised at the unit level, not here. Nor does
 * anything here exercise `Host.addFeed`'s own `schedulePoll` actually
 * dispatching -- `harness-2.ts`'s own module doc explains why this
 * harness's `Host` never reaches that path at all.
 */

test('an operator can add a feed and see it listed', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await page.goto(`${harness.origin}/settings`);
  // `exact: true`: Playwright's `getByLabel` matches a substring by
  // default, and `/settings` grew a second form with a "Client name" field
  // when the download clients section landed -- which this locator then
  // resolved to alongside the feed's own "Name", failing in strict mode.
  // The label text this spec means has not changed; only the page around it
  // has.
  await page.getByLabel('Name', { exact: true }).fill('Movies HD');
  await page.getByLabel('Feed url').fill(`${harness.origin}/fixtures/movies.xml`);
  await page.getByRole('button', { name: 'Add feed' }).click();

  // `Feeds.tsx` never learns this feed's name from the POST's own response
  // body -- that answers only `{ id }` (`AddFeed.tsx`'s own doc on
  // `postFeed`). This heading appearing is the real path instead: the
  // host's insert committing, `rss_feed`'s own sync trigger logging it,
  // this tab's `/api/sync` tail noticing on its next poll, and
  // `useFeeds`'s `subscribeInserts` re-reading the replica from there --
  // the round trip `harness-2.ts`'s own doc on `addFeed` names as the
  // reason this can be slow to appear, not a bug to route around with a
  // refetch (Global Constraint: lists come from the replica only).
  const feed = page.getByRole('heading', { name: 'Movies HD' });
  await expect(feed).toBeVisible({ timeout: 15_000 });

  // `settings.css`'s own pin: `toBeVisible()` above would pass against an
  // unstyled bulleted list exactly as well as against one styled with
  // `list-style: none` (`CLAUDE.md`'s own testing hazard on this gap) --
  // the same distinction the browse screens' own computed-style specs draw
  // for `library.css`, drawn here for the stylesheet this task adds.
  const list = page.getByRole('list', { name: 'feeds' });
  await expect(list).toHaveCSS('list-style-type', 'none');

  // A second, independent rule -- not the one just checked. `list-style:
  // none` alone pins only `ul[aria-label='feeds']`'s own reset; deleting
  // every other rule in `settings.css` (the border, the spacing, the form
  // rules) leaves that one assertion green, which proves the stylesheet
  // exists but not that its meaningful rules survive. `ul[aria-label='feeds']
  // li`'s `border-top: 1px solid var(--color-line)` is a separate rule
  // block this task also added, so pinning it closes that gap.
  //
  // Compared against the token's own resolved colour rather than a literal
  // `rgb(...)` -- see `borderTopAgainstLineToken`'s own doc for why that is
  // the right way round here.
  const item = list.locator('li').first();
  await expect(item).toBeVisible();
  const feedBorder = await borderTopAgainstLineToken(page, "ul[aria-label='feeds'] li");
  expect(feedBorder.borderTopColor).toBe(feedBorder.lineTokenColor);
});

/*
 * The download clients slice's own browser proof (task 4's brief), and the
 * only place any of that slice's screen has run in a real browser.
 *
 * **What this spec measures.** `POST /api/download-clients` answers and a
 * `download_client` row lands; that row reaches this tab's replica through
 * `download_client`'s own `AFTER INSERT` trigger into `sync_log`
 * (`sync/log.ts`'s `installSyncTriggers`, committed synchronously with the
 * insert) and this tab's `/api/sync` tail; the list re-renders from the
 * replica rather than from the POST's own `{ id }` body, which carries no
 * name and no implementation; and `settings.css`'s rules for the new
 * section actually resolve through a real cascade.
 *
 * **What this spec does not measure, stated exactly rather than as "the
 * whole slice".** The reconcile `Host.addDownloadClient` schedules on
 * create (design spec §7, acceptance item 5) does **not** dispatch here,
 * and nothing below is evidence about it. `harness-2.ts` builds a real
 * `Host` and never calls `host.start()`, so `started` stays `false`, the
 * `if (started) dispatcher.rearm()` guard on the enqueue path
 * (`host.ts`'s `ctxFor`, which `scheduleReconcile` goes through) arms
 * nothing, and `dispatcher.start()` has never run to pick the row up
 * anyway: the `reconcile` job exists in `jobs` and is never executed. The
 * replica path above does not need it to -- the trigger fires on the
 * insert's own commit, and nothing here talks to the client's address --
 * so "the client is listed" is evidence about the write, the trigger and
 * the sync tail, and about nothing else. Acceptance item 5 is pinned at
 * the unit level, as are the four refusals (`unknown-implementation`,
 * `bad-auth-shape`, `duplicate-name`, `bad-url`) and every credential
 * invariant: this spec types an api key into the form and then has nothing
 * further to do with it.
 */

/**
 * Obviously synthetic, the same way `PASSWORD` above is, and never
 * asserted on, never read back, never put in a test name. It is typed into
 * a `type="password"` field (`AddDownloadClient.tsx`) and from there it
 * crosses the wire once into the harness's in-memory `Secrets`; nothing in
 * this file, and nothing in the host's `log: dropLine`, ever renders it.
 *
 * Those are two channels and there is a third: the Playwright trace
 * records this value ten times, including two DOM snapshots of the masked
 * input. See this file's own module docblock, which measures it and states
 * the constraint that keeps it harmless -- this constant being a literal
 * in git is that constraint, not an incidental convenience.
 */
const API_KEY = 'placeholder-not-a-real-download-client-api-key';

test('an operator can add a download client and see it listed', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await page.goto(`${harness.origin}/settings`);

  // Precise locators, not loosened assertions: `/settings` is two forms
  // now and `getByLabel` matches a substring by default, so every field
  // named here is named by the string that belongs to exactly one of them.
  // "Client name" is this form's, where the feed form's is "Name" -- which
  // is why the feed spec above needs `exact: true` and this one does not.
  await page.getByLabel('Client name').fill('Seedbox');
  // Neither select is touched: `AddDownloadClient.tsx` defaults
  // `implementation` to qBittorrent and the sign-in method to the api key,
  // so the form as rendered already asks for exactly the one credential
  // filled in below. The other three implementation/strategy combinations
  // are unit-level (`AddDownloadClient.test.tsx`); what this spec is here
  // for is the write reaching the replica.
  await page.getByLabel('Api key').fill(API_KEY);
  await page.getByLabel('Address').fill(`${harness.origin}/qbittorrent`);
  await page.getByRole('button', { name: 'Add download client' }).click();

  // `DownloadClients.tsx` never learns this client's name or its
  // implementation from the POST's response body -- that answers only
  // `{ id }` (`AddDownloadClient.tsx`'s doc on `postDownloadClient`). Both
  // appearing is the real round trip instead: the host's insert
  // committing, `download_client`'s own sync trigger logging it, this
  // tab's `/api/sync` tail noticing on its next poll, and
  // `useDownloadClients`'s `subscribeInserts` re-reading the replica from
  // there (Global Constraint: lists come from the replica only).
  const list = page.getByRole('list', { name: 'download clients' });
  const client = list.locator('li').filter({ hasText: 'Seedbox' });
  await expect(client.getByRole('heading', { name: 'Seedbox' })).toBeVisible({ timeout: 15_000 });
  // `implementationLabel`'s own spelling of the wire's `qbittorrent`,
  // scoped to the row rather than the page: the form's own `<option>`
  // carries the identical string.
  await expect(client).toContainText('qBittorrent');

  // `settings.css`'s pin for this section, and the one the task's
  // two-sided check is run against. A token-derived colour is produced by
  // the rule or by nothing -- with `settings.css` gone or emptied,
  // `border-top-style` is `none` and the computed `border-top-color` falls
  // back to `currentcolor`, which is `--color-text`, not `--color-line`.
  //
  // Not `list-style-type: none`, and **not for the reason this comment
  // first gave.** It said "a UA reset satisfies that just as well as a
  // real rule does", which is false: no UA resets a `ul` to `none`, and
  // `base.css`'s only `list-style` reset is scoped to `nav ul`
  // (`grep -rn list-style packages/web/src/styles/` -> `base.css` `nav ul`,
  // `library.css` x2, `settings.css` x1). Delete `settings.css` outright
  // and the feeds spec's assertion reds with `disc`, which is exactly what
  // the import-removed half of the two-sided check measured.
  //
  // What actually makes that assertion weak is narrower, and is a property
  // of the *gutted* half alone: `list-style: none` is one declaration near
  // the top of the file, so a stylesheet emptied of everything else still
  // satisfies it. It pins that the file exists, not that its meaningful
  // rules do. The border pin has no such second life -- there is nothing
  // left to satisfy it once the rule block is gone.
  //
  // The feeds spec above pins the same property of the other list, and
  // that is not the same assertion: the rule naming both lists
  // (`settings.css`) would still satisfy the feeds one if the download
  // clients half of its selector were dropped. This is the half that
  // notices.
  await expect(client).toBeVisible();
  const clientBorder = await borderTopAgainstLineToken(page, "ul[aria-label='download clients'] li");
  expect(clientBorder.borderTopColor).toBe(clientBorder.lineTokenColor);

  // The heading-hierarchy rule `settings.css` adds for this screen, which
  // nothing else pins. A listed client's name is an `<h3>` and nothing in
  // `styles/` sets a bare `h3`, so without that block the UA's own
  // `h3 { font-size: 1.17em }` applies against the 16px these headings
  // inherit (`base.css` sets no `font-size` on `body`). 13px is
  // `--text-body`, which only the settings stylesheet's rule produces.
  // Measured under that mutant rather than reasoned: deleting the rule
  // block reds this line with `18.72px` against `13px`, restored by
  // checksum-verified copy.
  //
  // This sentence used to say the heading was an `<h2>` taking
  // `--text-title` (16px) from `base.css`. That was true of the markup
  // this spec was written against and stopped being true when the
  // accessibility-tree repair made the four inner headings `<h3>`; the
  // assertion's value did not move, because the settings rule produces
  // 13px either way, which is exactly how a comment like this goes stale
  // without anything failing.
  //
  // Spelled literally rather than resolved from the token: this one has a
  // single answer in both palettes, so `CLAUDE.md`'s preference for a
  // literal applies with nothing to trade against it.
  await expect(client.getByRole('heading', { name: 'Seedbox' })).toHaveCSS('font-size', '13px');
});

/*
 * The picks slice's own browser proof (task 5's brief), and the only place
 * any part of that slice has run in a real browser.
 *
 * **What the first spec below measures, and it is more of the server than
 * either spec above can claim.** A pick schedules no job. `addFeed` and
 * `addDownloadClient` each finish their visible work in the request and
 * leave a poll or a reconcile to a dispatcher this harness never starts, so
 * each of those specs is evidence about a write, a trigger and a sync tail
 * and about nothing further. `Host.requestDownload` has no such tail: the
 * whole of it runs inside `POST /api/picks` -- the registered plugin's
 * `onDownloadRequest`, `ctx.downloads.submit`, `selectClientForFeed`
 * resolving a feed that names no client to the one torrent client on file
 * (picks design §5's own failing case), the `submitting` insert, a real
 * HTTP request from `clients/qbittorrent.ts`'s adapter to the fake client
 * `harness-2.ts` listens with, and the update to `submitted`. Pressing the
 * button in a browser therefore exercises every one of those, plus
 * `torrent_download`'s own sync triggers and this tab's `/api/sync` tail.
 *
 * **And it is evidence for picks design §7's subscription specifically, by
 * elimination.** `useGatheredItem` re-gathers when something it subscribes
 * to changes. A pick touches no `media_item` row and no `rss_item` row --
 * `clients/downloads.ts` inserts into `torrent_download` and updates that
 * same row, and nothing else -- so the media item this card is built from
 * is byte-for-byte what it was before the click. The status appearing
 * without a reload therefore has exactly one available cause: the
 * subscription to inserts on the two download tables that task 3 added.
 * What this spec does **not** do is count requests, so it is not itself
 * evidence that nothing refetched; the two specs above that do count are.
 *
 * **What neither spec measures.** The `reconcile` job that would carry a row
 * from `submitted` through `downloading` to `completed` never dispatches
 * here, for the reason `harness-2.ts`'s module doc gives, so `submitted` is
 * the last status this suite will ever see on a row it created. Nor is
 * there a draw: one client of one type means `selectClientForFeed` has one
 * candidate, so acceptance item 3 (repeated picks reach more than one of
 * several clients) is pinned at the unit level and nothing here is evidence
 * about it. Four of the five refusals are unit-level too -- the second spec
 * drives `no-client-of-type` because it is the only one reachable without a
 * second feed, a second client or a second pick.
 *
 * **Acceptance item 6 was not met when this spec was written, and this is
 * where that was found.** Picks design §3 and acceptance 6 say `Picking…`
 * lasts until the download row arrives. It did not: `ReleaseRow`'s
 * `finally { setPending(false) }` cleared the flag when `POST /api/picks`
 * answered. Measured on this spec's own path, on a warm local run: the
 * button was enabled and reading `Pick` again **33ms** after the click and
 * the status replaced it **2934ms** after -- a ~2.9 second window in which
 * the server already held a `submitted` row for that release and the
 * browser still offered a button that would submit another, answering
 * `already-submitted` -- and, on the tree that measurement was taken on,
 * leaving a `failed` row behind. The row half is no longer true: the
 * host's release-level unique index refuses the second pick before it
 * writes anything. The window is what this spec is about, and it was
 * real.
 *
 * It is fixed, and this spec is now where it is *pinned* rather than only
 * where it was visible. `ReleaseRow` clears `pending` for every outcome
 * except a 202 and holds it for that one, and the first spec below asserts
 * the held state between the click and the row. The assertion depends on
 * that window being wide, which is the same 2934ms measured above -- before
 * the fix it would have had 33ms and been a flake; after it, it has the
 * whole of the round trip. There is deliberately no timeout behind the
 * hold: a plugin that accepts and writes no row leaves that one button
 * pending until the card is reopened, which `ReleaseRow`'s docblock records
 * as an accepted consequence rather than guarding.
 *
 * **No credential is typed anywhere in either spec.** Unlike the download
 * clients spec above, the qBittorrent api key the adapter sends with these
 * picks never enters the browser at all -- `harness-2.ts` hands it to
 * `Host.addDownloadClient` in process -- so it reaches no `fill` action, no
 * DOM snapshot and no trace resource. The only credential either spec types
 * is `PASSWORD`, through `claimInstall`.
 */

/**
 * One release's name, shaped like the ones this screen exists to compare.
 *
 * It does **not** overflow the filename column at this viewport: the span's
 * `scrollWidth` equals its `clientWidth` (measured, 687px against a 686.63px
 * box), which is what "nothing is clipped" looks like. So nothing below is
 * evidence about the ellipsis half of that rule. It is a filename and not a
 * path -- nothing here names a directory (Global Constraint).
 */
const RELEASE_FILENAME = 'a.movie.2026.1080p.web-dl.h265-GRP.mkv';

test('an operator can pick a release and watch its status take the button’s place', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await harness.seedPickableRelease({
    pluginId: 'movie',
    title: 'A Movie',
    filename: RELEASE_FILENAME,
    resolution: '1080p',
    withDownloadClient: true,
  });

  // A nav click rather than `page.goto`, and `movie` rather than `tv`: `/`
  // redirects to `/tv` (`Shell.tsx`'s index route), so the default screen
  // would have been reached without opening anything. This is the
  // category-opening click the brief asks for.
  await page.getByRole('link', { name: 'Movies' }).click();

  const disclosure = page.getByRole('button', { name: 'A Movie' });
  await expect(disclosure).toBeVisible({ timeout: 15_000 });
  await disclosure.click();

  // The button's accessible name is composed from two spans of visible text
  // -- its own label and the filename (`ReleaseList.tsx`) -- so naming it
  // this way asserts that composition as well as finding the button.
  const pick = page.getByRole('button', { name: `Pick ${RELEASE_FILENAME}` });
  await expect(pick).toBeVisible();

  // `library.css`'s own pin for this slice, in two properties, and neither
  // is `list-style-type: none` -- see the download clients spec above for
  // why that one pins only that a stylesheet exists.
  //
  // **`font-size` covers the rule that was already here** -- the pick
  // button block, which arrived with the button itself and had no browser
  // pin of its own. 12px has one producer: `base.css`'s `button` rule sets
  // `--text-body`, and this reads **13px** with `library.css` removed and
  // 13px again with it emptied down to its list resets (both measured).
  //
  // **`min-width` covers the rule the styling task added.** `styles/` has
  // two other `min-width` declarations -- `base.css`'s `#root > div >
  // section` and this file's own filename span -- and both are `0`, and
  // neither reaches this button; the UA computes `auto` for a button. So
  // 72px is `--size-pick-button` through this rule or it is nothing, and
  // gutting the stylesheet reads **0px** (measured). It is also the one
  // assertion here about behaviour rather than appearance: without it the
  // button widens by 25.94px when its label becomes `Picking…` and takes
  // that width off everything to its left (`tokens.css`'s own measurement).
  await expect(pick).toHaveCSS('font-size', '12px');
  await expect(pick).toHaveCSS('min-width', '72px');

  await pick.click();

  // Scoped to the row rather than reused from `pick` above, and that is not
  // tidiness: the button's accessible name is composed from its own label
  // and the filename, so pressing it changes that name from
  // `Pick <filename>` to `Picking… <filename>` and the `pick` locator stops
  // matching. The row holds exactly one button while it has no download.
  const row = page.getByRole('listitem', { name: RELEASE_FILENAME });
  const rowButton = row.getByRole('button');

  // **Acceptance 6, in a browser.** The pick has been accepted by the host
  // and the `torrent_download` row has not reached this tab yet, so the
  // button must still be pending -- see the block above for the 33ms/2934ms
  // measurement that says how wide this window is and why it used not to
  // be.
  await expect(rowButton).toHaveText('Picking…');
  await expect(rowButton).toBeDisabled();

  // And it has to be readable while it is up, which is the half that only
  // matters now it lasts seconds instead of 33ms. `base.css`'s
  // `button:disabled` paints `--color-text-faint` -- 3.50:1 in dark and
  // 3.51:1 in light against `--color-surface`, under the 4.5:1 floor for
  // essential text, the same objection `base.css`'s own `nav a` rule
  // records against that token. `library.css`'s `:disabled` block overrides
  // it with `--color-text-dim` (6.23:1 / 5.85:1). Resolved in the browser
  // rather than spelled `rgb(...)`, for the reason the helper gives.
  const pendingLabel = await colorAgainstToken(
    page,
    "ul[aria-label='releases'] li > button:disabled",
    '--color-text-dim',
  );
  expect(pendingLabel.color).toBe(pendingLabel.tokenColor);

  // `submitted` is where the row settles: the fake client answers inside
  // the request, so `clients/downloads.ts` marks the row before
  // `POST /api/picks` returns, and no reconcile ever runs to move it on
  // (the block above). A tail poll landing between the insert and the
  // update could show `submitting` first, which is why this waits for the
  // settled value rather than asserting the first status to appear.
  await expect(row).toContainText('Status: submitted', { timeout: 15_000 });

  // The button is gone rather than merely disabled: `ReleaseList` renders
  // one only for a release with no download, so its absence is the same
  // fact as the status's presence read from the other side (picks design
  // §2, acceptance item 5).
  await expect(row.getByRole('button')).toHaveCount(0);
});

test('a pick with no download client set up says so, in words that are styled as the alarm they are', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await harness.seedPickableRelease({
    pluginId: 'movie',
    title: 'A Movie',
    filename: RELEASE_FILENAME,
    resolution: '1080p',
    withDownloadClient: false,
  });

  await page.getByRole('link', { name: 'Movies' }).click();
  const disclosure = page.getByRole('button', { name: 'A Movie' });
  await expect(disclosure).toBeVisible({ timeout: 15_000 });
  await disclosure.click();

  await page.getByRole('button', { name: `Pick ${RELEASE_FILENAME}` }).click();

  // `getByText`, not `getByRole('alert')`: the role is satisfied by an
  // element with an `aria-label` and no visible content, which is
  // `CLAUDE.md`'s longest hazard and the exact shape `IdentityChangeConfirm`
  // shipped. This is the rendered sentence, and it is this client's own
  // wording (`postPick.ts`'s `PICK_REFUSAL_MESSAGES`) -- the host's message
  // for the same condition names a feed and is never sent to a browser.
  const refusal = page.getByText(
    'No download client that can take this kind of release is set up. Add one under Settings.',
  );
  await expect(refusal).toBeVisible();

  // The other half of that hazard, and the pin for the other rule
  // `library.css` already had for this slice -- the one whose own comment
  // says "this rule existing is load-bearing". `toBeVisible()` passes
  // against an unstyled block of text just as well as against a styled one,
  // so this asserts the colour: with `library.css` gone or emptied, the
  // `[role='alert']` block goes with it and the sentence inherits
  // `--color-text` instead.
  //
  // Resolved in the browser rather than spelled `rgb(...)`, for the reason
  // `borderTopAgainstLineToken` above gives: `--color-error` differs between
  // the two palettes and nothing here pins which one a run resolves to.
  const alarm = await colorAgainstToken(page, "ul[aria-label='releases'] li > [role='alert']", '--color-error');
  expect(alarm.color).toBe(alarm.tokenColor);

  // And the button came back, so a refused pick is retryable rather than a
  // dead row (acceptance item 4: no outcome leaves the button pending).
  await expect(page.getByRole('button', { name: `Pick ${RELEASE_FILENAME}` })).toBeEnabled();
});

/*
 * The path-mappings slice's own browser proof (task 4's brief), and the
 * only place any of that slice's screen has run in a real browser.
 *
 * **What this spec measures.** All three of the slice's routes answer, in
 * a browser, over a real socket, with a real session cookie: `POST
 * /api/mappings` creates a row, `PATCH /api/mappings/:id` replaces both of
 * its paths and separately answers an `empty-path` refusal, and `DELETE
 * /api/mappings/:id` removes it. Each of those three rows, edits and
 * tombstones reaches this tab's replica through `filepath_mapping`'s own
 * `AFTER INSERT`/`AFTER UPDATE`/`AFTER DELETE` triggers into `sync_log`
 * (`sync/log.ts`'s `installSyncTriggers`, committed synchronously with the
 * statement) and this tab's `/api/sync` tail -- nothing below reads a
 * response body for a path, because none of the three routes answers one:
 * `POST` and `PATCH` answer `{ id }` and `DELETE` answers no body at all.
 * The list on screen is the replica's, or it is nothing (Global
 * Constraint). And `settings.css`'s rules for this section resolve through
 * a real cascade, which is what the three computed-style assertions below
 * are for.
 *
 * **`PATCH` and `DELETE` are new verbs for this API and this is the first
 * time either has crossed a real network stack.** Everything before this
 * slice was `GET` and `POST`. A unit test calls a route handler; here the
 * browser's own `fetch` sets the method, Node's HTTP parser reads it, and
 * `api/server.ts`'s per-route `methods` table dispatches on it.
 *
 * **What this spec does not measure, stated exactly rather than as "the
 * whole slice".**
 *
 * - **Acceptance item 4 -- that an edit changes what the next delivery
 *   tick resolves -- is not exercised here at all, and could not be.**
 *   `mapClientPath` is read by `clients/deliver.ts`, which runs from the
 *   job dispatcher, and `harness-2.ts` builds a real `Host` and never
 *   calls `host.start()`. No tick ever runs in this suite. Unlike the
 *   download clients spec above, though, that costs the *writes* nothing:
 *   `Host.addMapping`, `editMapping` and `removeMapping` are each one
 *   synchronous SQLite statement and schedule no job, so there is no
 *   follow-up work left undispatched behind any of the three. The gap is
 *   entirely on the reading side. Acceptance item 4 is pinned against
 *   `mapClientPath` at the unit level, which is where the design spec puts
 *   it ("pinned against `mapClientPath`, not asserted").
 * - **Three of the four refusals.** Only `empty-path` is driven below.
 *   `duplicate-from-path` (acceptance item 2, caught from the unique
 *   index), `unknown-client` and `unknown-mapping` are host-level and
 *   pinned in `packages/host/test/clients/mappings.test.ts`;
 *   `postMapping.ts`'s own two -- `offline` and `unrecognised` -- are
 *   pinned in `packages/web/test/settings/postMapping.test.tsx`. Nothing
 *   below is evidence about any of the five.
 * - **Acceptance item 7 -- that `PATCH` and `DELETE` are refused without a
 *   session.** Every request this spec makes carries one. The guard and
 *   its ordering are pinned in the host's own route tests.
 * - **A `from_path` of `D:\Downloads` (acceptance item 3).** The paths
 *   typed below are POSIX-shaped. The Windows case is pinned at the host
 *   and at `postMapping.ts`; what this spec shows is that a path crosses
 *   the wire and comes back off the replica unchanged, which is the same
 *   property for one shape of value.
 *
 * **No credential is typed here that this file did not already type.** The
 * two values this spec puts in a form that the ones above do not are
 * filesystem paths, and they are obviously synthetic literals in git. They
 * are not credentials -- but they are recorded in `trace.zip` exactly as a
 * credential would be, per this file's module docblock, so it is worth
 * saying that they stay paths: nothing below reads a path from
 * `process.env`, from the database, or from anywhere but the two constants
 * under this comment. The download client this spec has to create first
 * reuses `API_KEY` above rather than introducing a second secret-shaped
 * literal.
 */

/** The prefix the download client would report. A literal in git, and a path rather than anything credential-shaped -- see the comment above. */
const CLIENT_PATH = '/downloads/complete';
/** What that prefix becomes for the host, as first typed. */
const HOST_PATH = '/media/downloads';
/** And after the edit. Different from {@link HOST_PATH} at the first character, so a row still showing the old value cannot satisfy the assertion by prefix. */
const HOST_PATH_CORRECTED = '/mnt/library/downloads';

/**
 * A locator's box in **document** coordinates, or a failure naming the
 * locator rather than a `null` dereference. `boundingBox()` answers `null`
 * for an element that is not rendered, and an assertion comparing two
 * `null`s would pass.
 *
 * **The scroll offset is added, and that is the point of this helper.**
 * `boundingBox()` is relative to the viewport, so two readings of a
 * motionless element disagree the moment anything scrolls the page between
 * them -- and Playwright scrolls on its own, to bring the element it is
 * about to click into view. The mapping caller below compares a box taken
 * before an editor opens against one taken after, to assert the row did
 * not move; when the `/settings` screen grew its destinations section the
 * document became 2860px against a 720px viewport, the click on Edit
 * scrolled it 10px, and the comparison failed on a row that had not moved
 * at all -- `window.scrollY` went 676 -> 686 while the element's
 * document-relative top stayed at 1378px exactly. Viewport coordinates
 * were only ever stable here by the accident of a page short enough not to
 * scroll, which is not a property this suite should depend on.
 *
 * The TV headline spec above is the second caller. It compares two
 * different elements in one reading rather than one element across an
 * interaction, so the scroll offset cancels either way -- it reaches for
 * this anyway rather than `boundingBox()` twice, because reaching for
 * viewport coordinates in this file is what went wrong once already, and
 * because `boundingBox()` answers `null` for an element that is not
 * rendered where this throws naming it.
 */
async function boxOf(locator: ReturnType<Page['locator']>, what: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error(`${what} has no bounding box, so it is not rendered`);
  const scroll = await locator.page().evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  return { x: box.x + scroll.x, y: box.y + scroll.y, width: box.width, height: box.height };
}

test('an operator can add, edit and remove a path mapping on a download client', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await page.goto(`${harness.origin}/settings`);

  // A mapping belongs to a download client by foreign key (design spec
  // §8), so there has to be one first. Created through the same form the
  // spec above drives, for the same reason that one does: this suite has
  // no harness writer for a client, and `addDownloadClient` is the only
  // thing that knows the credential-name scheme.
  await page.getByLabel('Client name').fill('Seedbox');
  await page.getByLabel('Api key').fill(API_KEY);
  await page.getByLabel('Address').fill(`${harness.origin}/qbittorrent`);
  await page.getByRole('button', { name: 'Add download client' }).click();
  await expect(page.getByRole('heading', { name: 'Seedbox' })).toBeVisible({ timeout: 15_000 });

  // The expander's accessible name is composed from two spans of visible
  // text -- its own label and the client's heading (`ClientMappings.tsx`)
  // -- so naming it this way is also a check that the composition holds.
  const expander = page.getByRole('button', { name: 'Path mappings Seedbox' });
  await expect(expander).toHaveAttribute('aria-expanded', 'false');
  await expander.click();
  await expect(expander).toHaveAttribute('aria-expanded', 'true');

  // Zero is an answer and renders as a sentence, not as an empty list
  // (Global Constraint). The italic is `settings.css`'s empty-state rule
  // and nothing else on this screen produces it: `base.css`'s only italic
  // is on `.loading`, and no component in `packages/web/src` sets a class
  // at all, so an unstyled or emptied stylesheet computes `normal` here.
  const emptyState = page.getByText('No path mappings for this download client.');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toHaveCSS('font-style', 'italic');

  const addForm = page.getByRole('form', { name: 'Add a path mapping' });
  await addForm.getByLabel('Client path').fill(CLIENT_PATH);
  await addForm.getByLabel('Host path').fill(HOST_PATH);
  await addForm.getByRole('button', { name: 'Add path mapping' }).click();

  // `POST /api/mappings` answers `{ id }` and nothing else -- no path
  // comes back in that body (`postMapping.ts`). So a row carrying both
  // paths is the round trip: the host's insert committing,
  // `filepath_mapping`'s `AFTER INSERT` trigger logging it, this tab's
  // `/api/sync` tail noticing on its next poll, and
  // `useClientMappings`'s `subscribeInserts` re-reading the replica.
  //
  // The row's accessible name is its own client path, which is how it is
  // addressed from here on (`MappingRow`: an unlabelled `<li>` reads with
  // an empty name even when full of visible text).
  const row = page.getByRole('listitem', { name: CLIENT_PATH });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText(HOST_PATH);
  await expect(emptyState).toHaveCount(0);

  // `settings.css`'s row layout, and a rule this task added. A `<li>`
  // computes `display: list-item` from the UA stylesheet, so `flex` here
  // has exactly one producer: with the stylesheet removed or emptied of
  // its rule bodies this reads `list-item`. Without it the two buttons sit
  // flush against the host path and against each other -- measured, three
  // edges at one x -- which that rule's own comment records.
  await expect(row).toHaveCSS('display', 'flex');

  // **The row does not move when the editor opens.** This is the pin
  // `tokens.css`'s `--size-mapping-row` names: `MappingRow` removes Edit
  // and Remove from the DOM while the row is being edited, so without a
  // height of its own the first line shrinks to the text and the paths
  // ride up under the pointer. Measured with only that one declaration
  // removed, the client path's top edge rose by 3.5px (693.5 -> 690 in the
  // viewport coordinates `boxOf` reported at the time; it reports document
  // coordinates now, which moves both absolute numbers by the scroll
  // offset and leaves the 3.5px shift this pin catches unchanged).
  //
  // The whole box rather than `y` alone: nothing about opening an editor
  // should move the path horizontally or resize it either, and all four
  // numbers were identical in the run this was written against.
  const clientPathSpan = row.locator('span').first();
  const beforeEditing = await boxOf(clientPathSpan, 'the client path before the editor opens');

  await row.getByRole('button', { name: `Edit ${CLIENT_PATH}` }).click();
  const editorHostPath = row.getByLabel('Host path');
  await expect(editorHostPath).toBeVisible();
  expect(await boxOf(clientPathSpan, 'the client path with the editor open')).toEqual(beforeEditing);

  // **The editor's fields are laid out, which is the other half of the
  // selector this task widened.** `settings.css` used to name
  // `li > div > form > div`, which reaches the *add* form only -- a row's
  // editor is two levels further down, at `li > div > ul > li > form` -- so
  // each of its field `<div>`s computed `display: block` and put its label
  // and its input on one line. Reverting that selector and re-running this
  // suite left 15/15 green before this assertion existed; with it, the
  // revert is red here. (Its sibling widening, `li [role='alert'] p`, was
  // already pinned by the two refusal assertions below. One of the pair was
  // covered and one was not.)
  //
  // Exactly one producer, so this survives a gutted stylesheet as well as a
  // missing one: a `<div>` computes `display: block` from the UA sheet, and
  // no component in `packages/web/src` sets a class for anything else to
  // key on. The parent of the input rather than an nth-child, because that
  // `<div>` is precisely what the rule selects.
  const editorField = editorHostPath.locator('xpath=..');
  await expect(editorField).toHaveCSS('display', 'flex');
  await expect(editorField).toHaveCSS('flex-direction', 'column');

  // A refused `PATCH`, driven through the one path-content rule the host
  // has (design spec §7: `empty-path` refuses the empty string and nothing
  // else -- no leading `/` is required, no backslash rejected). The fields
  // are deliberately not `required` in the markup for exactly this reason,
  // so the browser submits it and the host answers.
  await row.getByLabel('Client path').fill('');
  await row.getByRole('button', { name: `Save ${CLIENT_PATH}` }).click();

  const refusal = row.getByRole('alert');
  await expect(refusal).toHaveText(
    'Fill in both paths. Neither the client path nor the host path may be left blank.',
  );

  // **The two-sided pin.** `settings.css`'s refusal rule is the reason
  // that block exists at all: without it the detail-line rule above it
  // reaches this sentence -- a refusal `<p>` is a `<p>` inside a client
  // `<li>` -- and an error message renders dimmed at the meta scale,
  // indistinguishable from the line naming the client's category. That is
  // `CLAUDE.md`'s longest hazard with a stylesheet as the cause.
  //
  // A token-derived colour has exactly one producer here, which is what
  // makes this red under a *gutted* stylesheet and not only a missing one.
  // `base.css`'s `--color-error` is on the `.error` utility, and no
  // component in `packages/web/src` sets a class; delete this file's rule
  // bodies and the sentence computes `--color-text-dim` from the
  // detail-line rule, or `--color-text` if that is gone too. Neither is
  // `--color-error`. This is deliberately *not* `list-style-type: none`
  // (#90): a value a reset also produces survives gutting.
  //
  // Resolved in the browser rather than spelled `rgb(...)`, for the reason
  // `colorAgainstToken` above gives -- `--color-error` differs between the
  // two palettes and nothing here pins which one a run resolves to.
  const refused = await colorAgainstToken(
    page,
    "ul[aria-label='download clients'] li > div > ul > li > [role='alert'] p",
    '--color-error',
  );
  expect(refused.color).toBe(refused.tokenColor);

  // And the other half of the same rule, which is the half a reviewer of
  // task 3 found unproven: the empty-state rule's `font-style: italic`
  // reaches this sentence too, because a mapping row is an `<li>` whose
  // refusal banner is a `<div>` with a `<p>` in it. Measured by deleting
  // the one declaration: this sentence computed `italic`. An alert is not
  // an aside, and `font-style: normal` is what keeps it from reading as
  // one -- while the empty-state sentence above still reads as one.
  await expect(refusal.locator('p')).toHaveCSS('font-style', 'normal');

  // No outcome leaves a control pending (acceptance item 6): the refused
  // save re-enabled its own button rather than wedging the row.
  await expect(row.getByRole('button', { name: `Save ${CLIENT_PATH}` })).toBeEnabled();

  // Now an accepted edit. Only the host path changes, so the row keeps its
  // accessible name and `row` keeps resolving.
  await row.getByLabel('Client path').fill(CLIENT_PATH);
  await editorHostPath.fill(HOST_PATH_CORRECTED);
  await row.getByRole('button', { name: `Save ${CLIENT_PATH}` }).click();

  // `PATCH` answers `{ id }` -- no path in the body either -- so the new
  // value on screen came from the replica, through `filepath_mapping`'s
  // `AFTER UPDATE` trigger and the sync tail. `store/apply.ts` counts an
  // upsert over an existing row as `touched` and never `inserted`, so the
  // insert channel does not fire for this at all: it is
  // `useClientMappings`'s per-row `subscribe` that notices, which is the
  // subscription this slice added and which no other settings list has.
  await expect(row).toContainText(HOST_PATH_CORRECTED, { timeout: 15_000 });
  await expect(row).not.toContainText(HOST_PATH);

  // **The removal, and it has to be checked by absence.** `DELETE`
  // answers `204` with no body -- the first bodiless success this API has
  // -- so `deleteMapping` reads the status rather than a field, and a
  // `{ removed: true }` in hand is not evidence the row is gone.
  //
  // Both assertions below fail if it is not. The first is the row itself:
  // `useClientMappings` re-reads the replica and the row leaves when the
  // `AFTER DELETE` tombstone arrives, not when the request resolves. The
  // second is stronger than a restatement of it -- the sentence renders
  // only on `mappings.length === 0`, so a row that had merely stopped
  // matching the `listitem` role would satisfy the first and not this.
  // Had the host answered `unknown-mapping` instead, `MappingRow` would
  // have rendered a refusal and kept the row.
  await row.getByRole('button', { name: `Remove ${CLIENT_PATH}` }).click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByText('No path mappings for this download client.')).toBeVisible();
});

/*
 * The importer slice's own browser proof (task 5's brief), and the only
 * place `Destinations.tsx` has run in a real browser.
 *
 * **What this spec measures.** `PUT /api/destinations/movie` answers `{ id
 * }` and nothing else (`postDestination.ts`'s own doc on
 * `SaveDestinationOutcome` -- no root, no shape and no unmatched folder in
 * the body), so the row showing the values typed below, after the save,
 * came off the replica -- through `plugin_destination`'s own `AFTER
 * INSERT` trigger into `sync_log` (`sync/log.ts`'s `installSyncTriggers`,
 * committed synchronously with the insert; `plugin_destination` is
 * `HOST_SYNCED_TABLES`'s tenth member) and this tab's `/api/sync` tail --
 * not from the draft `Destinations.tsx` keeps while the request is in
 * flight (it clears that draft on an accepted save and falls back to
 * whatever the replica holds, `DestinationRow`'s own doc). `settings.css`'s
 * rules for this section resolving through a real cascade is the other
 * half, which the computed-style assertion below is for.
 *
 * **The shape typed below names no `{token}`, and that is a property of
 * this harness, not of the feature.** `harness-2.ts`'s `stubPlugin`
 * declares `tokens: {}` for all three plugins -- "No library path shape is
 * configured in an end-to-end run, so there is nothing here for a token to
 * appear in" -- so a shape naming one here would be refused `unknown-token`
 * against this harness specifically, for a reason that has nothing to do
 * with `media/shape.ts`'s real rule against a real plugin. The token
 * vocabulary itself -- that a tv row offers `{season}` and a movie row
 * does not, and that saving a shape naming a token the plugin never
 * declared is refused -- is proven at the unit level instead, against the
 * real plugins' own declarations: `Destinations.test.tsx`'s `the tv row
 * lists {season} and the movie row does not`, and
 * `packages/host/test/media/destinations.test.ts`'s own `unknown-token`
 * cases.
 *
 * **What this spec does not measure, stated exactly rather than as "the
 * whole slice", and the answer to what `host.start()` not being called
 * means for an *import* specifically.** Nothing below exercises an actual
 * import: not the copy `media/import.ts`'s `createLibraryImporter`
 * performs, not `media/shape.ts`'s `resolveShape` run against real
 * resolved values rather than a save-time probe, and none of the three
 * refusals that survive a shape accepted on save
 * (`separator-in-value`, `escapes-root`, `empty-filename` --
 * `media/destinations.ts`'s own doc on exactly why those three remain
 * reachable at import against a shape this module already accepted). All
 * of that runs from `deliverCompleted`, which only the job dispatcher
 * calls, and -- exactly as the download-clients spec above records for its
 * own reconcile job -- `harness-2.ts` builds a real `Host` and never calls
 * `host.start()`, so no tick of any kind ever runs in this suite.
 * `Host.saveDestination` itself schedules nothing in the first place
 * (`media/destinations.ts`'s own doc: "nothing is scheduled afterwards ...
 * the importer reads this table at the moment it imports"), so unlike the
 * download-clients spec this costs the *write* nothing at all -- the gap is
 * entirely on the reading side, and here it is total: nothing in this
 * suite, or in any other harness in this repository, ever points a running
 * `Host` at a real filesystem. Proving the destination this spec saves is
 * ever actually used to copy a file is `media/import.ts`'s own unit tests'
 * job, not this one's, and this spec is not evidence about it either way.
 */
test('an operator can set a plugin\'s library destination and see it listed', async ({ page, harness }) => {
  await page.goto(harness.origin);
  await claimInstall(page, 'owner@example.invalid', harness.claimToken);
  await expect(page.getByRole('heading', { name: 'Pickarr' })).toBeVisible();

  await page.goto(`${harness.origin}/settings`);

  // `exact: true`: the shell's own nav names this same plugin with the same
  // word (both read `BrowserPlugin.label` through
  // `web/src/plugins/registry.ts`; the ruling that joined them predates
  // that file and was first implemented in a `pluginLabels.ts` the registry
  // replaced), so a loose `name: 'Movies'` would also match the nav
  // link's own `<li>` were its accessible name not "Movies 0" -- the link
  // text plus its count span, which `exact` tells apart from this row's
  // heading, exactly "Movies" and nothing else.
  const row = page.getByRole('listitem', { name: 'Movies', exact: true });
  await row.getByLabel('Library folder').fill('/media/movies');
  await row.getByLabel('Path shape').fill('movie.mkv');
  await row.getByRole('button', { name: 'Save Movies' }).click();

  // The round trip described above. `waitFor`'s default timeout is not
  // enough for a real sync tail; `Feeds.tsx`'s own spec above needs the
  // same allowance for the same reason.
  await expect(row.getByLabel('Library folder')).toHaveValue('/media/movies', { timeout: 15_000 });
  await expect(row.getByLabel('Path shape')).toHaveValue('movie.mkv');

  // **The two-sided pin, `settings.css`'s own rule for this section's row
  // list.** `borderTopAgainstLineToken`'s own doc, above, is the reasoning
  // for resolving `--color-line` in the browser rather than a literal
  // `rgb(...)`. A `<li>` computes `border-top-style: none` from the UA
  // stylesheet, so a rule setting `border-top: 1px solid var(--color-line)`
  // is the only plausible producer of a `border-top-color` that resolves to
  // that token: with the rule missing, the computed colour falls back to
  // `currentcolor`, i.e. `--color-text` -- a different token in both of
  // `tokens.css`'s palettes -- which is what makes this survive the
  // stylesheet being gutted as well as the `@import` being removed
  // outright (both mutations run and observed, task 5's own report).
  const destinationBorder = await borderTopAgainstLineToken(
    page,
    "ul[aria-labelledby='destinations-heading'] > li",
  );
  expect(destinationBorder.borderTopColor).toBe(destinationBorder.lineTokenColor);
});
