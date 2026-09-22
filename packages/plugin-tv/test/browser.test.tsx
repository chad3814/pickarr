import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { PickSubmit, PluginRows } from '@pickarr/plugin-ui';
import { tvBrowser } from '../src/browser.tsx';

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
 * Never called: no test in this file renders `gathered`, so `Card` never
 * reaches `ReleaseList` and never calls this. Spelled out anyway rather
 * than defaulted, for the reason `ReleaseList.tsx`'s own docblock gives --
 * `submit` is a required prop precisely so a test cannot forget it.
 */
const submit: PickSubmit = () => Promise.reject(new Error('not exercised by this test'));

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
      submit={submit}
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
    <Card item={mediaItem({ title: 'Untagged Item' })} rows={rows} gathered={undefined} onExpandedChange={() => {}} submit={submit} />,
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
    <Card item={mediaItem({ title: 'Untagged Item' })} rows={rows} gathered={undefined} onExpandedChange={() => {}} submit={submit} />,
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
      submit={submit}
    />,
  );
  const button = screen.getByRole('button');
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.click(button);
  assert.deepEqual(reported, [true, false, true], 'open, close, open -- each reported once, in order');
});
