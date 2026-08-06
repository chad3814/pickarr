import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MediaTypePlugin } from '@pickarr/plugin-api';
import createScenesPlugin from '@pickarr/plugin-scenes';
import { openTestDatabase } from '../../src/db/open.ts';
import { getDiscoveredSite, knownSiteNames } from '../../src/db/sites.ts';
import { pickSite, resolveSitesForBatch } from '../../src/pipeline/resolve-sites.ts';
import type { SiteLookupClient } from '../../src/clients/theporndb.ts';

const ANAL_ONLY = 'Anal.Only.Getting.In.Savannahs.Booty.Savannah.Bond.2022.09.29.2160p';
const BANGBROS = 'Bangbros.Ass.Parade.Chloe.Upgrades.her.Butt.2026.08.03.2160p';
const ORDINARY = 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB';

const solid = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * A search that behaves like the real one: a substring match over site names,
 * returning whatever contains the query rather than only exact hits.
 */
function fakeLookup(known: string[]): SiteLookupClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    source: 'fake',
    asked,
    searchSites(query: string) {
      asked.push(query);
      const needle = solid(query);
      return Promise.resolve(
        known
          .filter((site) => solid(site).includes(needle))
          .map((site) => ({ name: site, shortName: solid(site) })),
      );
    },
  };
}

function scenes(sites: string[] = []): MediaTypePlugin {
  return createScenesPlugin({ libraryRoot: '/m', sites });
}

function deps(plugin: MediaTypePlugin, client: SiteLookupClient | undefined, logs: string[] = []) {
  return {
    db: openTestDatabase(),
    plugin,
    client,
    now: () => 1000,
    log: (message: string) => logs.push(message),
  };
}

// --- Which result is the site ------------------------------------------------
//
// Every case below is drawn from live API responses.

test('a site longer than the query is found, because prefixes are what match', () => {
  // q="2 Chicks" returns both of these; nothing is named "2 Chicks".
  const results = [
    { name: '2 Chicks Same Time', shortName: '2chickssametime' },
    { name: '2 Chicks 1 Dick', shortName: '2chicks1dick' },
  ];
  const prefixes = ['2 Chicks Same Time Scene', '2 Chicks Same Time', '2 Chicks Same', '2 Chicks', '2'];
  assert.equal(pickSite(results, prefixes), '2 Chicks Same Time');
});

test('a site spelled solid is found from a spaced query', () => {
  // q="Free Use" returns "Freeuse Fantasy" among six others.
  const results = [
    { name: 'Freeuse Twink', shortName: 'freeusetwink' },
    { name: 'Freeuse Fantasy', shortName: 'freeusefantasy' },
    { name: 'Free Use MILF', shortName: 'freeusemilf' },
  ];
  assert.equal(
    pickSite(results, ['Free Use Fantasy Scene', 'Free Use Fantasy', 'Free Use', 'Free']),
    'Freeuse Fantasy',
  );
});

test('the longest prefix wins over a shorter one that also matches', () => {
  const results = [
    { name: 'Free', shortName: 'free' },
    { name: 'Freeuse Fantasy', shortName: 'freeusefantasy' },
  ];
  assert.equal(pickSite(results, ['Free Use Fantasy', 'Free Use', 'Free']), 'Freeuse Fantasy');
});

test('a real but wrong site is not confirmed when it is not the longest match', () => {
  // There is a site literally named "Free". Judging results by the query
  // rather than by the release's own prefixes confirmed it for
  // Free.Use.Fantasy..., filing the scene under Free/ with title "Use
  // Fantasy". Only the prefixes rule out that answer.
  const results = [{ name: 'Free', shortName: 'free' }];
  assert.equal(pickSite(results, ['Free Use Fantasy', 'Free Use']), null);
  // ...but a release that really is from "Free" still resolves.
  assert.equal(pickSite(results, ['Free Some Scene', 'Free Some', 'Free']), 'Free');
});

test('results that merely contain a prefix do not match it', () => {
  const results = [
    { name: 'Getting In Deep', shortName: 'gettingindeep' },
    { name: 'Getting Into It', shortName: 'gettingintoit' },
  ];
  assert.equal(pickSite(results, ['Getting In Savannahs', 'Getting In', 'Getting']), null);
});

test('short_name alone can carry the match, and the display name is preferred', () => {
  const results = [{ name: 'Bang Bros', shortName: 'bangbros' }];
  assert.equal(pickSite(results, ['Bangbros']), 'Bang Bros');
});

test('no results is no match', () => {
  assert.equal(pickSite([], ['Anything']), null);
});

// --- Resolution over a batch -------------------------------------------------

test('a confirmed two-word site is learned and used by the next parse', async () => {
  const plugin = scenes();
  const context = deps(plugin, fakeLookup(['Anal Only']));

  assert.equal(
    plugin.parse(ANAL_ONLY)?.identityKey,
    'anal:2022-09-29:only-getting-in-savannahs-booty-savannah-bond',
  );

  const result = await resolveSitesForBatch(context, [ANAL_ONLY]);
  assert.deepEqual(result.confirmed, ['Anal Only']);
  assert.equal(
    plugin.parse(ANAL_ONLY)?.identityKey,
    'anal-only:2022-09-29:getting-in-savannahs-booty-savannah-bond',
  );
});

test('the two-word candidate is tried first and the one-word one is never asked', async () => {
  const client = fakeLookup(['Anal Only']);
  await resolveSitesForBatch(deps(scenes(), client), [ANAL_ONLY]);
  assert.deepEqual(client.asked, ['Anal Only']);
});

test('a two-word miss falls back to the one-word query', async () => {
  const client = fakeLookup(['Bangbros']);
  const result = await resolveSitesForBatch(deps(scenes(), client), [BANGBROS]);
  assert.deepEqual(client.asked, ['Bangbros Ass', 'Bangbros']);
  assert.deepEqual(result.confirmed, ['Bangbros']);
});

test('both answers are cached, negatives included', async () => {
  const client = fakeLookup(['Bangbros']);
  const context = deps(scenes(), client);
  await resolveSitesForBatch(context, [BANGBROS]);

  assert.equal(getDiscoveredSite(context.db, 'Bangbros Ass')?.site, null);
  assert.equal(getDiscoveredSite(context.db, 'bangbros')?.site, 'Bangbros');
  assert.deepEqual(knownSiteNames(context.db), ['Bangbros']);
});

test('a cached negative is not asked about again', async () => {
  const client = fakeLookup(['Bangbros']);
  const context = deps(scenes(), client);
  await resolveSitesForBatch(context, [BANGBROS]);
  client.asked.length = 0;

  const second = await resolveSitesForBatch({ ...context, plugin: scenes() }, [BANGBROS]);
  assert.deepEqual(client.asked, [], 'no query should be re-sent');
  assert.equal(second.queried, 0);
  // Two cache hits, not one: the negative for "Bangbros Ass" is consulted and
  // skipped before the positive for "Bangbros" settles it. Caching the miss is
  // the point — without it that first query goes out on every tick forever.
  assert.equal(second.cached, 2);
  assert.deepEqual(second.confirmed, ['Bangbros']);
});

test('one site shared by many titles in a batch is looked up once', async () => {
  const client = fakeLookup(['Anal Only']);
  const batch = [
    ANAL_ONLY,
    'Anal.Only.Another.Scene.Here.2022.10.01.2160p',
    'Anal.Only.A.Third.One.2022.10.02.1080p',
  ];
  const result = await resolveSitesForBatch(deps(scenes(), client), batch);
  assert.deepEqual(client.asked, ['Anal Only']);
  assert.equal(result.queried, 1);
});

test('names that need no help produce no lookups', async () => {
  const client = fakeLookup(['Brazzers']);
  const result = await resolveSitesForBatch(deps(scenes(), client), [ORDINARY]);
  assert.deepEqual(client.asked, []);
  assert.deepEqual(result.confirmed, []);
});

test('a site already in the configured list is not looked up', async () => {
  const client = fakeLookup(['Anal Only']);
  await resolveSitesForBatch(deps(scenes(['Anal Only']), client), [ANAL_ONLY]);
  assert.deepEqual(client.asked, []);
});

// --- Failure is never cached -------------------------------------------------

test('a failed lookup is not recorded as a negative and is retried next pass', async () => {
  let failing = true;
  const client: SiteLookupClient = {
    source: 'fake',
    searchSites(query) {
      if (failing) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(
        query === 'Anal Only' ? [{ name: 'Anal Only', shortName: 'analonly' }] : [],
      );
    },
  };
  const context = deps(scenes(), client);

  const first = await resolveSitesForBatch(context, [ANAL_ONLY]);
  assert.deepEqual(first.confirmed, []);
  assert.deepEqual(first.unresolved, [ANAL_ONLY]);
  assert.equal(getDiscoveredSite(context.db, 'Anal Only'), undefined, 'nothing may be cached');

  failing = false;
  const second = await resolveSitesForBatch({ ...context, plugin: scenes() }, [ANAL_ONLY]);
  assert.deepEqual(second.confirmed, ['Anal Only']);
});

test('a failed lookup reports the title so the durable fallback key is visible', async () => {
  const logs: string[] = [];
  const client: SiteLookupClient = {
    source: 'fake',
    searchSites: () => Promise.reject(new Error('rate limited')),
  };
  const result = await resolveSitesForBatch(deps(scenes(), client, logs), [ANAL_ONLY]);
  assert.deepEqual(result.unresolved, [ANAL_ONLY]);
  assert.ok(logs.some((line) => line.includes('rate limited')), logs.join('\n'));
});

test('with no client configured the batch resolves to nothing and reports it', async () => {
  const result = await resolveSitesForBatch(deps(scenes(), undefined), [ANAL_ONLY]);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.unresolved, [ANAL_ONLY]);
  assert.equal(result.queried, 0);
});

test('a plugin with no site hooks is left alone', async () => {
  const bare: MediaTypePlugin = {
    id: 'bare',
    displayName: 'Bare',
    parse: () => null,
    score: () => 0,
    planImport: () => null,
  };
  const client = fakeLookup(['Anal Only']);
  const result = await resolveSitesForBatch(deps(bare, client), [ANAL_ONLY]);
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(client.asked, []);
});

test('a plugin whose siteCandidates throws does not abort the batch', async () => {
  const plugin = scenes();
  const logs: string[] = [];
  let calls = 0;
  plugin.siteCandidates = () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return { queries: ['Anal Only'], prefixes: ['Anal Only'] };
  };
  const client = fakeLookup(['Anal Only']);
  const result = await resolveSitesForBatch(deps(plugin, client, logs), [BANGBROS, ANAL_ONLY]);
  assert.deepEqual(result.confirmed, ['Anal Only']);
  assert.ok(logs.some((line) => line.includes('boom')));
});

// --- Learned sites persist ---------------------------------------------------

test('a site learned in one pass survives into a fresh plugin via the database', async () => {
  const context = deps(scenes(), fakeLookup(['Anal Only']));
  await resolveSitesForBatch(context, [ANAL_ONLY]);

  // What main.ts does at boot.
  const restarted = scenes();
  restarted.learnSites?.(knownSiteNames(context.db));
  assert.equal(
    restarted.parse(ANAL_ONLY)?.identityKey,
    'anal-only:2022-09-29:getting-in-savannahs-booty-savannah-bond',
  );
});

test('learnSites is additive and ignores duplicates', async () => {
  const plugin = scenes(['Vixen']);
  plugin.learnSites?.(['Anal Only']);
  plugin.learnSites?.(['Anal Only', 'Bangbros']);
  assert.equal(plugin.parse(ANAL_ONLY)?.display.subtitle, 'Anal Only');
  assert.equal(plugin.parse(BANGBROS)?.display.subtitle, 'Bangbros');
  assert.equal(
    plugin.parse('Vixen.Kylie.Rocket.Page.Turner.2023.07.19.1080p')?.display.subtitle,
    'Vixen',
  );
});
