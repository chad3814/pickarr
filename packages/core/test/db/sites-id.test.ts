import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDatabase } from '../../src/db/open.ts';
import { recordDiscoveredSite, rememberSiteId, siteIdForName } from '../../src/db/sites.ts';

test('a discovered site remembers its integer id and answers by name', () => {
  const db = openTestDatabase();
  recordDiscoveredSite(
    db,
    'naughty office',
    { site: 'Naughty Office', sourceUuid: 'site-uuid', sourceId: 1 },
    'theporndb',
    1_000,
  );
  assert.equal(siteIdForName(db, 'Naughty Office'), 1);
  assert.equal(siteIdForName(db, 'Nobody'), null);
});

test('a site discovered before the column existed learns its id later', () => {
  const db = openTestDatabase();
  recordDiscoveredSite(db, 'bang bros', { site: 'Bang Bros', sourceUuid: 'u' }, 'theporndb', 1_000);
  assert.equal(siteIdForName(db, 'Bang Bros'), null);

  rememberSiteId(db, 'Bang Bros', 42);
  assert.equal(siteIdForName(db, 'Bang Bros'), 42);
});

test('rememberSiteId does not invent a row for a site nobody discovered', () => {
  const db = openTestDatabase();
  rememberSiteId(db, 'Configured Only', 7);
  assert.equal(siteIdForName(db, 'Configured Only'), null);
});

test('a prefix that lands on the same site by a different route shares its id', () => {
  // "bangbros ass" and "bangbros" can both confirm "Bang Bros"; siteIdForName
  // is keyed on the site name, not the prefix, so either row answers it.
  const db = openTestDatabase();
  recordDiscoveredSite(
    db,
    'bangbros ass',
    { site: 'Bang Bros', sourceUuid: 'u1', sourceId: 42 },
    'theporndb',
    1_000,
  );
  recordDiscoveredSite(db, 'bangbros', { site: 'Bang Bros', sourceUuid: 'u2' }, 'theporndb', 1_000);
  assert.equal(siteIdForName(db, 'Bang Bros'), 42);
});
