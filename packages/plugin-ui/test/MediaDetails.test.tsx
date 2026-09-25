import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MediaItemSyncRead, PersonSyncRead, RoleSyncRead } from '@pickarr/contract';
import { MediaDetails, topBilled } from '../src/MediaDetails.tsx';
import type { GatheredItemView, GatheredRoleView } from '../src/types.ts';

afterEach(cleanup);

function person(id: number, name: string): PersonSyncRead {
  return { id, name, providerRef: `tmdb:person:${String(id)}`, createdAt: 0, updatedAt: 0 };
}

function role(
  id: number,
  personId: number,
  billingOrder: number | null,
  who: PersonSyncRead | undefined,
): GatheredRoleView {
  const row: RoleSyncRead = {
    id, mediaItemId: 1, personId, role: 'actor', name: null, billingOrder, createdAt: 0,
  };
  return { id, row, person: who, imageUrl: `/api/artwork/person/${String(personId)}` };
}

function item(overrides: Partial<MediaItemSyncRead> = {}): MediaItemSyncRead {
  return {
    id: 1, pluginId: 'movie', createdAt: 0, updatedAt: 0,
    provider: 'tmdb', providerRef: 'tmdb:movie:335984',
    title: 'Blockers', releaseDate: '2018-04-06', description: 'Three parents.',
    ...overrides,
  };
}

function gathered(overrides: Partial<GatheredItemView> = {}): GatheredItemView {
  return {
    releases: [],
    roles: [],
    artwork: {
      poster: '/api/artwork/poster/1',
      background: '/api/artwork/background/1',
      logo: '/api/artwork/logo/1',
    },
    ...overrides,
  };
}

test('one person billed twice appears once', () => {
  // A person can hold several roles on one item -- actor and director, or
  // two characters. "Five people" is five distinct persons, not five rows.
  const alice = person(7, 'Alice');
  const picked = topBilled([role(1, 7, 0, alice), role(2, 7, 1, alice)], 5);

  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.row.personId, 7);
});

test('billing order decides, with nulls last and name breaking ties', () => {
  // Spelled as a literal expected order, not recomputed by sorting again.
  const picked = topBilled([
    role(1, 3, null, person(3, 'Unbilled')),
    role(2, 1, 2, person(1, 'Third')),
    role(3, 2, 0, person(2, 'First')),
    role(4, 4, 1, person(4, 'Second')),
  ], 5);

  assert.deepEqual(picked.map((r) => r.person?.name), ['First', 'Second', 'Third', 'Unbilled']);
});

test('the sixth person is left out', () => {
  const roles = [1, 2, 3, 4, 5, 6].map((n) => role(n, n, n, person(n, `P${String(n)}`)));
  assert.equal(topBilled(roles, 5).length, 5);
});

test('a role whose person has not replicated is skipped', () => {
  // Log order is not group order, so a role can land before its person.
  // A nameless face is worse than a shorter cast.
  const picked = topBilled([role(1, 9, 0, undefined), role(2, 7, 1, person(7, 'Alice'))], 5);

  assert.deepEqual(picked.map((r) => r.person?.name), ['Alice']);
});

test('an unclaimed item renders no provider icon and no attribution', () => {
  // Review Focus 1. `provider` and `providerRef` are null together until a
  // lookup claims the item. `data provided by null` is the failure.
  render(
    <MediaDetails item={item({ provider: null, providerRef: null })} gathered={gathered()} />,
  );

  assert.ok(!screen.queryByText('TMDb'), 'no provider badge');
  assert.ok(!screen.queryByText(/data provided by/), 'no attribution line');
});

test('a null release date and a null description render nothing rather than the word null', () => {
  // Review Focus 2.
  render(
    <MediaDetails item={item({ releaseDate: null, description: null })} gathered={gathered()} />,
  );

  assert.ok(!screen.queryByText(/Release Date/), 'no release-date line');
  assert.ok(!screen.queryByText(/null/), 'the word null appears nowhere');
});

test('the attribution names the provider in full', () => {
  render(<MediaDetails item={item()} gathered={gathered()} />);

  assert.ok(screen.getByText('data provided by The Movie Database'), 'the full name is shown');
  assert.ok(screen.getByText('Release Date: 2018-04-06'), 'the release date is shown');
});

test('a person whose picture fails keeps their name and gets the placeholder', () => {
  // Review Focus 3. Most people have no picture -- the person artwork
  // route 404s for all but a few -- so this is the common path, not an
  // edge case.
  const alice = person(7, 'Alice');
  render(
    <MediaDetails item={item()} gathered={gathered({ roles: [role(1, 7, 0, alice)] })} />,
  );

  fireEvent.error(screen.getByAltText('Alice'));

  assert.ok(screen.getByText('Alice'), 'the name survives');
  assert.ok(screen.getByRole('img', { name: 'No picture of Alice' }), 'the placeholder is shown');
});

test('a person’s name links to their page on the provider', () => {
  const alice = person(30614, 'Alice');
  render(<MediaDetails item={item()} gathered={gathered({ roles: [role(1, 30614, 0, alice)] })} />);

  const link = screen.getByRole('link', { name: 'Alice' });
  assert.equal(link.getAttribute('href'), 'https://www.themoviedb.org/person/30614');
  // A new tab, and never a tab that can reach back into this one.
  assert.equal(link.getAttribute('rel'), 'noreferrer noopener');
});

test('clicking the poster opens the gallery captioned with the title', () => {
  render(<MediaDetails item={item()} gathered={gathered()} />);

  fireEvent.click(screen.getByRole('button', { name: 'Blockers' }));

  assert.ok(screen.getByRole('dialog', { name: 'Blockers' }), 'the gallery opened');
});

test('clicking a person’s picture opens the gallery captioned with their name', () => {
  const alice = person(7, 'Alice');
  render(<MediaDetails item={item()} gathered={gathered({ roles: [role(1, 7, 0, alice)] })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Alice' }));

  assert.ok(screen.getByRole('dialog', { name: 'Alice' }), 'the gallery opened for the person');
});

test('one icon per distinct transport, not one per release', () => {
  // `download_type` is an `rss_item` column, so an item really can hold
  // both an nzb and a torrent; a single icon would have to lie about one.
  const release = (id: number, downloadType: string) => ({
    id,
    row: {
      id, feedId: 1, filename: `f${String(id)}.mkv`, createdAt: 0, updatedAt: 0,
      downloadType, mediaItemId: 1, rankingScore: null, resolution: '1080p',
      resolutionDetail: null, lookupJson: null, deliveredAt: null,
    },
    downloads: [],
  });
  render(
    <MediaDetails
      item={item()}
      gathered={gathered({ releases: [release(1, 'torrent'), release(2, 'torrent'), release(3, 'nzb')] })}
    />,
  );

  assert.ok(screen.getByRole('img', { name: 'torrent' }), 'torrent shown once');
  assert.ok(screen.getByRole('img', { name: 'nzb' }), 'nzb shown');
  assert.equal(screen.getAllByRole('img', { name: 'torrent' }).length, 1, 'not once per release');
});
