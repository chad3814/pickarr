import { expect, test } from '../src/harness.ts';

/**
 * Task 1's only spec. It asserts nothing about a bug — it asserts that the
 * harness is real: a browser fetched the built SPA from a Fastify server that
 * this test started, and that server answered an API call over HTTP. Every
 * later spec is worthless if this one is lying.
 */
test('the built SPA loads and its API answers', async ({ page, request }) => {
  await page.goto('/');

  const nav = page.locator('nav');
  await expect(nav.getByRole('link', { name: 'Browse' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Picks' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Dismissed' })).toBeVisible();

  // Through the same origin the SPA is served from, so a route that only works
  // under Fastify's `inject` would fail here.
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok' });
});
