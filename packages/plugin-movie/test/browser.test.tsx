import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { PickSubmit } from '@pickarr/plugin-ui';
import { movieBrowser, movieHeadline } from '../src/browser.tsx';

afterEach(cleanup);

const Card = movieBrowser.Card;

/** A `MediaItemSyncRead` with everything but `title` defaulted. */
function mediaItem(over: Partial<MediaItemSyncRead> = {}): MediaItemSyncRead {
  return {
    id: 1,
    pluginId: 'movie',
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
 * Never called: no test in this file renders `gathered`, so `Card` never
 * reaches `ReleaseList` and never calls this. Spelled out anyway rather
 * than defaulted, for the reason `ReleaseList.tsx`'s own docblock gives --
 * `submit` is a required prop precisely so a test cannot forget it.
 */
const submit: PickSubmit = () => Promise.reject(new Error('not exercised by this test'));

test('a film with a release date is titled with its year, in the film-library convention', () => {
  // Spelled literally rather than built from `mediaItem(...)`'s own
  // values: an expectation computed by the code under test cannot see
  // that code change (`CLAUDE.md`), and `Title (2024)` is the exact
  // string a film library names a folder by.
  render(
    <Card
      item={mediaItem({ title: 'The Room', releaseDate: '2003-06-27' })}
      rows={{}}
      gathered={undefined}
      onExpandedChange={() => {}}
      submit={submit}
    />,
  );
  assert.ok(screen.getByRole('button', { name: 'The Room (2003)' }));
});

test('a film with no release date is titled exactly as before, not with empty parentheses', () => {
  render(
    <Card
      item={mediaItem({ title: 'The Room' })}
      rows={{}}
      gathered={undefined}
      onExpandedChange={() => {}}
      submit={submit}
    />,
  );
  assert.ok(
    screen.getByRole('button', { name: 'The Room' }),
    'no date means no year, and no bracket either',
  );
});

test('the year is the first four characters, never a parsed Date', () => {
  // **The reason this is a unit test and not only a render test.**
  // `new Date('2003-01-01').getFullYear()` is 2002 anywhere west of UTC,
  // so a `Date`-based implementation is correct in the timezone whoever
  // wrote it runs in and wrong by a year for everyone else -- a bug no
  // render assertion above would catch on a CI runner pinned to UTC.
  // January the first is the only date that shows it.
  assert.equal(movieHeadline('Film', '2003-01-01'), 'Film (2003)');
  assert.equal(movieHeadline('Film', '2003-12-31'), 'Film (2003)');
  // Anything not shaped like four digits contributes no year at all,
  // rather than four characters of whatever it happens to be.
  assert.equal(movieHeadline('Film', ''), 'Film');
  assert.equal(movieHeadline('Film', 'unknown'), 'Film');
  assert.equal(movieHeadline('Film', '20xx-01-01'), 'Film');
  assert.equal(movieHeadline('Film', null), 'Film');
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
      submit={submit}
    />,
  );
  const button = screen.getByRole('button');
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.click(button);
  assert.deepEqual(reported, [true, false, true], 'open, close, open -- each reported once, in order');
});
