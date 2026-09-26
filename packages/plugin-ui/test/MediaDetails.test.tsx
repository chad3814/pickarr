import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
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

test('one person billed twice keeps the better-billed row', () => {
  // A person can hold several roles on one item -- actor and director, or
  // two characters. "Five people" is five distinct persons, not five rows.
  // Asserting the survivor's identity, not just the person id, catches an
  // unconditional last-row-wins de-dup that a length/personId check alone
  // would miss.
  const alice = person(7, 'Alice');
  const picked = topBilled([role(1, 7, 0, alice), role(2, 7, 1, alice)], 5);

  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.id, 1, 'the better-billed row (billingOrder 0) survives');
  assert.equal(picked[0]?.row.billingOrder, 0);
});

test('the better-billed row survives even when it arrives second', () => {
  // Neither "first wins" nor "last wins" may pass this: only rank may.
  const alice = person(7, 'Alice');
  const picked = topBilled([role(1, 7, 1, alice), role(2, 7, 0, alice)], 5);

  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.id, 2, 'the better-billed row (billingOrder 0) survives, though it came second');
  assert.equal(picked[0]?.row.billingOrder, 0);
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
  assert.ok(
    !screen.queryByRole('button', { name: 'No picture of Alice' }),
    'no button once the picture failed -- Finding 2, below',
  );
});

test('a cast member whose image failed opens no dialog, because it has no button to click', () => {
  // Whole-branch review finding 2. A person's gallery holds exactly one
  // url; once it has 404'd there is nothing left to show, so `Gallery`'s
  // own effect would close it the instant it opened -- a modal that opens
  // and shuts in one frame, stealing and returning focus for nothing. Most
  // people have no picture at all, so this is the common path a card
  // renders, not an edge case.
  const alice = person(7, 'Alice');
  render(
    <MediaDetails item={item()} gathered={gathered({ roles: [role(1, 7, 0, alice)] })} />,
  );

  fireEvent.error(screen.getByAltText('Alice'));

  assert.ok(!screen.queryByRole('button', { name: 'No picture of Alice' }), 'no control that would do nothing');
  assert.ok(!screen.queryByRole('dialog'), 'no gallery flash-opened for a 404 that was never shown');
});

test('a poster that fails to load keeps its button working for the item', () => {
  render(<MediaDetails item={item()} gathered={gathered()} />);

  fireEvent.error(screen.getByAltText('Blockers'));
  assert.ok(screen.getByRole('img', { name: 'No poster for Blockers' }), 'the placeholder is shown');

  fireEvent.click(screen.getByRole('button', { name: 'No poster for Blockers' }));
  assert.ok(screen.getByRole('dialog', { name: 'Blockers' }), 'the gallery opens for the item, not the placeholder');
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

test('re-opening the gallery at another image starts it fresh, not with the last failures', () => {
  // The card's images are now one set, walked with arrows, so "switching
  // subjects" means opening the same set at a different image. `Gallery`
  // is keyed on that starting url, which is what makes each open a fresh
  // mount rather than one long-lived instance accumulating failures.
  //
  // `fireEvent.click` dispatches straight to its target with no
  // hit-testing, and nothing disables background content while a gallery
  // is open, so a cast button really is reachable from here.
  const alice = person(7, 'Alice');
  render(<MediaDetails item={item()} gathered={gathered({ roles: [role(1, 7, 0, alice)] })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Blockers' }));
  const poster = within(screen.getByRole('dialog')).getByAltText('Blockers');
  fireEvent.error(poster);

  // Open again at the person. A carried-over failure list would still be
  // suppressing the poster, so the set would be one short.
  fireEvent.click(screen.getByRole('button', { name: 'Alice' }));

  const dialog = screen.getByRole('dialog');
  assert.ok(within(dialog).getByAltText('Alice'), 'it opened on the person');
  assert.ok(
    screen.getByText('3 of 3'),
    'and all three images are back in the set, so the previous failure did not carry over',
  );
});

test('a person\'s picture is in the card\'s gallery, reachable from the poster', () => {
  // The gallery is one set per card -- three media slots then each cast
  // member -- so walking forward from the poster arrives at the cast
  // rather than running out after the media images.
  const alice = person(7, 'Alice');
  const bob = person(8, 'Bob');
  render(
    <MediaDetails
      item={item()}
      gathered={gathered({ roles: [role(1, 7, 0, alice), role(2, 8, 1, bob)] })}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Blockers' }));

  // Two media slots, not three: the logo is fetched and stored but kept
  // out of the carousel -- a wordmark is not a picture anyone opens a
  // lightbox for.
  assert.ok(screen.getByText('1 of 4'), 'poster and background plus two people');
  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  assert.ok(screen.getByRole('heading', { name: 'Alice' }), 'the third image is the first cast member');
  fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
  assert.ok(screen.getByRole('heading', { name: 'Bob' }), 'and the fourth is the second');
});
