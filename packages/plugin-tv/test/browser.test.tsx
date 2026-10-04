import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MediaItemSyncRead, TvRead } from '@pickarr/contract';
import type { GatheredItemView, IdentifySubmit, PickSubmit, PluginRows } from '@pickarr/plugin-ui';
import { tvBrowser, tvCaption } from '../src/browser.tsx';

afterEach(cleanup);

const Card = tvBrowser.Card;

/** A `MediaItemSyncRead` with everything but `title` defaulted. */
function mediaItem(over: Partial<MediaItemSyncRead> = {}): MediaItemSyncRead {
  return {
    id: 1,
    pluginId: 'tv',
    createdAt: 0,
    updatedAt: 0,
    provider: null,
    providerRef: null,
    title: 'the item’s own title',
    releaseDate: null,
    description: null,
    ...over,
  };
}

/**
 * Not called by any test that never expands the card: `Card` reaches
 * `ReleaseList` only once expanded and `gathered` is defined
 * (`TvCard`'s own body). Spelled out anyway rather than defaulted, for the
 * reason `ReleaseList.tsx`'s own docblock gives -- `submit` is a required
 * prop precisely so a test cannot forget it. The finding-1 tests below do
 * expand the card, but none of them clicks a Pick button, so this stays
 * unreached even there.
 */
const submit: PickSubmit = () => Promise.reject(new Error('not exercised by this test'));

/** Likewise required, likewise never called: these tests click no Requery or Edit. */
const identify: IdentifySubmit = {
  identify: () => Promise.reject(new Error('not exercised by this test')),
  suggest: () => Promise.reject(new Error('not exercised by this test')),
};

/** A `GatheredItemView` with no releases and placeholder artwork urls -- enough to expand the card. */
function gathered(): GatheredItemView {
  return {
    releases: [],
    roles: [],
    artwork: {
      posters: [{ id: 1, url: '/api/artwork/poster/1', width: 10, height: 15, language: null, rank: 0 }],
      backgrounds: [{ id: 1, url: '/api/artwork/background/1', width: 15, height: 10, language: null, rank: 0 }],
      logos: [],
    },
  };
}

/** A `TvRead` with everything but `kind` and `seriesRef` defaulted. */
function tvRelease(over: Partial<TvRead> = {}): TvRead {
  return {
    mediaItemId: 1,
    kind: 'episode',
    seriesTitle: 'Jo Jo’s Bizarre Adventure',
    seriesRef: '184871',
    seasonNumber: null,
    episodeNumber: null,
    ...over,
  };
}

/**
 * Renders the tv card already expanded, with the given item and (optional)
 * `tv_release` row. Expansion is real, not assumed: the card starts
 * collapsed (`useExpansion`'s own default), so this clicks the heading's
 * own button rather than rendering `MediaDetails` directly -- the same path
 * a user takes, and the same pattern `plugin-movie/test/browser.test.tsx`
 * uses for its own IMDb-link tests.
 */
function renderTvCardExpanded(item: Partial<MediaItemSyncRead>, release: TvRead | undefined): void {
  const rows: PluginRows = { tv_release: release === undefined ? [] : [release] };
  render(
    <Card
      item={mediaItem(item)}
      rows={rows}
      gathered={gathered()}
      onExpandedChange={() => {}}
      submit={submit} identify={identify}
    />,
  );
  fireEvent.click(screen.getByRole('button'));
}

test('the headline renders in the expander button’s accessible name, before anything is expanded', () => {
  const rows: PluginRows = {
    tv_release: [
      {
        mediaItemId: 1,
        kind: 'episode',
        seriesTitle: 'Jo Jo’s Bizarre Adventure',
        seriesRef: 'r',
        seasonNumber: 2,
        episodeNumber: 47,
      },
    ],
  };
  render(
    <Card
      item={mediaItem({ title: "Dio's World(3)" })}
      rows={rows}
      gathered={undefined}
      onExpandedChange={() => {}}
      submit={submit} identify={identify}
    />,
  );
  assert.ok(
    screen.getByRole('button', { name: "Jo Jo’s Bizarre Adventure S02E47 Dio's World(3)" }),
    'the headline, built from rows alone, names the collapsed button',
  );
});

test('a card with no tv_release row falls back to the item’s own title', () => {
  const rows: PluginRows = { tv_release: [] };
  render(
    <Card item={mediaItem({ title: 'Untagged Item' })} rows={rows} gathered={undefined} onExpandedChange={() => {}} submit={submit} identify={identify} />,
  );
  assert.ok(
    screen.getByRole('button', { name: 'Untagged Item' }),
    'nothing to build a headline out of, so the title alone',
  );
});

test('a malformed tv_release row (missing seriesTitle) falls back rather than throwing', () => {
  const rows: PluginRows = {
    // Same as a well-formed row but for `seriesTitle` -- the field
    // `tvHeadline` dereferences first. A cast would let this reach
    // `tvHeadline` and throw; the `in` guard declines it instead.
    tv_release: [{ mediaItemId: 1, kind: 'episode', seasonNumber: 2, episodeNumber: 47 }],
  };
  render(
    <Card item={mediaItem({ title: 'Untagged Item' })} rows={rows} gathered={undefined} onExpandedChange={() => {}} submit={submit} identify={identify} />,
  );
  assert.ok(
    screen.getByRole('button', { name: 'Untagged Item' }),
    'a row that does not match TvRead is declined, not asserted, and rendering does not throw',
  );
});

test('every expand and every collapse is reported, with the state the card moved to', () => {
  // **The close is asserted, not only the open.** This card is one of three
  // implementations of the same seam, and the regression fix round 1 found
  // is exactly what a card reporting only its opening produces: web cannot
  // tear the gather's subscriptions down, so the fan-out becomes "cards
  // ever opened" rather than "cards currently open" -- measured at 72 live
  // subscriptions for 24 cards nobody had left open. A single callback
  // carrying the new value is what makes that impossible to half-implement
  // (`@pickarr/plugin-ui`'s `onExpandedChange` doc), and asserting the
  // sequence here is what holds this card to it.
  const reported: boolean[] = [];
  render(
    <Card
      item={mediaItem()}
      rows={{}}
      gathered={undefined}
      onExpandedChange={(expanded) => {
        reported.push(expanded);
      }}
      submit={submit} identify={identify}
    />,
  );
  const button = screen.getByRole('button');
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.click(button);
  assert.deepEqual(reported, [true, false, true], 'open, close, open -- each reported once, in order');
});

// Whole-branch review finding 1. `@pickarr/plugin-ui`'s `mediaLink` refuses
// every `tvdb` reference -- a bare id cannot be typed as series or episode
// from its shape alone -- so this plugin supplies the badge itself, via
// `extraLinks`, using `TvRead.kind` to pick the right dereferrer route.

test('a tvdb episode links to its own dereferrer/episode route, not /series/', () => {
  // The defect this finding fixed: every episode used to get
  // `/dereferrer/series/{episode id}`, a verified 404.
  renderTvCardExpanded(
    { provider: 'tvdb', providerRef: '10019744' },
    tvRelease({ kind: 'episode', seriesRef: '184871', seasonNumber: 2, episodeNumber: 47 }),
  );
  const link = screen.getByRole('link', { name: 'TVDb' });
  assert.equal(link.getAttribute('href'), 'https://thetvdb.com/dereferrer/episode/10019744');
});

test('a tvdb series links to its own dereferrer/series route', () => {
  renderTvCardExpanded(
    { provider: 'tvdb', providerRef: '184871' },
    tvRelease({ kind: 'series', seriesRef: '184871' }),
  );
  const link = screen.getByRole('link', { name: 'TVDb' });
  assert.equal(link.getAttribute('href'), 'https://thetvdb.com/dereferrer/series/184871');
});

test('a tvdb season links to its series via seriesRef, not its own composite ref', () => {
  // `item.providerRef` for a season is `184871:s14` -- the season's own
  // ref -- and no dereferrer route takes that shape (`dereferrer/season/1`
  // is also a verified 404). `seriesRef` is the series' own bare id and is
  // what must be used instead.
  renderTvCardExpanded(
    { provider: 'tvdb', providerRef: '184871:s14' },
    tvRelease({ kind: 'season', seriesRef: '184871', seasonNumber: 14, episodeNumber: null }),
  );
  const link = screen.getByRole('link', { name: 'TVDb' });
  assert.equal(link.getAttribute('href'), 'https://thetvdb.com/dereferrer/series/184871');
});

test('a tmdb-provided tv item still gets exactly one badge, from the shared mediaLink path', () => {
  // `item.provider === 'tmdb'` here, not `'tvdb'` -- `tvdbExtraLinks` must
  // contribute nothing, or this item would carry two badges.
  renderTvCardExpanded(
    { provider: 'tmdb', providerRef: 'tmdb:tv:1399:1:1' },
    tvRelease({ kind: 'episode', seriesRef: '184871' }),
  );
  assert.equal(screen.getAllByRole('link', { name: 'TMDb' }).length, 1, 'exactly one badge');
  assert.ok(!screen.queryByText('TVDb'), 'no second badge from this plugin');
});

test('a malformed tvdb providerRef yields no badge at all', () => {
  renderTvCardExpanded(
    { provider: 'tvdb', providerRef: 'not-an-id' },
    tvRelease({ kind: 'series', seriesRef: '184871' }),
  );
  assert.ok(!screen.queryByText('TVDb'), 'no url built from a reference this function could not parse');
});

test('the grid caption leads with the series and the episode number, and falls back to the title without a release row', () => {
  const rows: PluginRows = { tv_release: [tvRelease({ seasonNumber: 1, episodeNumber: 2 })] };
  assert.equal(tvCaption(mediaItem({ title: 'Pilot' }), rows), 'Jo Jo’s Bizarre Adventure S01E02 Pilot');
  assert.equal(tvCaption(mediaItem({ title: 'Pilot' }), {}), 'Pilot', 'no tv_release row yet: the title alone');
  assert.equal(tvBrowser.caption, tvCaption, 'the registry entry hands web the same function');
});
