import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { IdentifySubmit, PickSubmit } from '@pickarr/plugin-ui';
import { xxxBrowser, siteNameOf } from '../src/browser.tsx';

afterEach(cleanup);

const Card = xxxBrowser.Card;

/** A `MediaItemSyncRead` with everything but `title` defaulted. */
function mediaItem(over: Partial<MediaItemSyncRead> = {}): MediaItemSyncRead {
  return {
    id: 1,
    pluginId: 'xxx',
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

/** Likewise required, likewise never called: these tests click no Requery or Edit. */
const identify: IdentifySubmit = {
  identify: () => Promise.reject(new Error('not exercised by this test')),
  suggest: () => Promise.reject(new Error('not exercised by this test')),
};

/** One `xxx_scene` replica row, shaped as `XxxRead` reaches a client. */
function sceneRows(siteName: string | null): Record<string, readonly unknown[]> {
  return { xxx_scene: [{ mediaItemId: 1, siteName, siteRef: null }] };
}

test('a scene with no site row is titled by its title alone', () => {
  render(
    <Card
      item={mediaItem({ title: 'Scene Title' })}
      rows={{}}
      gathered={undefined}
      onExpandedChange={() => {}}
      submit={submit} identify={identify}
    />,
  );
  assert.ok(
    screen.getByRole('button', { name: 'Scene Title' }),
    'the title alone names the collapsed button, unchanged from the shared card',
  );
});

test('a scene’s site is shown, and is part of what the control announces', () => {
  // The composed name is the point, not an accident of putting the site
  // inside the button: it is visible text in a control, so a screen
  // reader must reach it too (`CardHeading`'s `trailing` doc). Pinned
  // literally, because this is a real change to what the button is
  // called and a future refactor that drops the site from the name would
  // leave it on screen and unannounced.
  render(
    <Card
      item={mediaItem({ title: 'Scene Title' })}
      rows={sceneRows('Example Studio')}
      gathered={undefined}
      onExpandedChange={() => {}}
      submit={submit} identify={identify}
    />,
  );
  assert.ok(screen.getByRole('button', { name: 'Scene Title Example Studio' }));
});

test('the site is set apart from the title, not appended to it', () => {
  // `getByRole(name)` above is satisfied by one flat string, so it cannot
  // tell `Scene Title Example Studio` rendered as a title from a title
  // with a separate trailing label. This asserts the element web's
  // stylesheet actually targets -- `article h2 button small` -- exists
  // and holds only the site. Without it, deleting the `<small>` wrapper
  // and appending the site to the headline would pass every other test
  // here while rendering full-size undimmed text.
  render(
    <Card
      item={mediaItem({ title: 'Scene Title' })}
      rows={sceneRows('Example Studio')}
      gathered={undefined}
      onExpandedChange={() => {}}
      submit={submit} identify={identify}
    />,
  );
  const small = screen.getByRole('button').querySelector('small');
  assert.ok(small !== null, 'the site renders in its own <small>, which is what the stylesheet selects');
  assert.equal(small.textContent, 'Example Studio', 'and holds the site alone, not the whole title line');
});

test('a scene whose site is unknown renders no trailing element at all', () => {
  // `xxx_scene.site_id` is nullable and the host's read is a LEFT JOIN,
  // so `siteName: null` is a row the replica really holds -- not a
  // hypothetical. An empty `<small>` here would be a flex item with no
  // content, moving the layout for nothing.
  render(
    <Card
      item={mediaItem({ title: 'Scene Title' })}
      rows={sceneRows(null)}
      gathered={undefined}
      onExpandedChange={() => {}}
      submit={submit} identify={identify}
    />,
  );
  assert.ok(
    screen.getByRole('button').querySelector('small') === null,
    'no site, no element',
  );
  assert.ok(screen.getByRole('button', { name: 'Scene Title' }), 'and the name is unchanged');
});

test('a row this build cannot read is declined rather than asserted through', () => {
  // A replica outlives the build that wrote it, so `PluginRows` is
  // `unknown[]` and `as XxxRead` would be a runtime read of a field that
  // may not be there. Each of these is a row shape that has to answer
  // "no site" rather than throw or render `undefined`.
  assert.equal(siteNameOf({}), undefined, 'table not fetched');
  assert.equal(siteNameOf({ xxx_scene: [] }), undefined, 'fetched, no rows');
  assert.equal(siteNameOf({ xxx_scene: [null] }), undefined, 'a null row');
  assert.equal(siteNameOf({ xxx_scene: ['not a row'] }), undefined, 'a row that is not an object');
  assert.equal(siteNameOf({ xxx_scene: [{}] }), undefined, 'an object with no siteName at all');
  assert.equal(siteNameOf({ xxx_scene: [{ siteName: 42 }] }), undefined, 'a siteName of the wrong type');
  assert.equal(siteNameOf({ xxx_scene: [{ siteName: '' }] }), undefined, 'the empty string is not a site name');
  assert.equal(siteNameOf({ xxx_scene: [{ siteName: 'Studio' }] }), 'Studio', 'and a good row still reads');
});

test('the card declares the table it reads, so web fetches it', () => {
  // The read and the declaration are two separate statements and nothing
  // else connects them: a card that reads `rows['xxx_scene']` without
  // declaring it gets an empty array forever, silently, and every test
  // above that passes `rows` by hand would still pass.
  assert.deepEqual(xxxBrowser.tables, ['xxx_scene']);
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
