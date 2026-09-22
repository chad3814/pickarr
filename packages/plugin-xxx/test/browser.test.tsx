import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { MediaItemSyncRead } from '@pickarr/contract';
import type { PickSubmit } from '@pickarr/plugin-ui';
import { xxxBrowser } from '../src/browser.tsx';

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

test('the item’s title renders in the expander button’s accessible name', () => {
  render(
    <Card
      item={mediaItem({ title: 'Scene Title' })}
      rows={{}}
      gathered={undefined}
      onExpand={() => {}}
      submit={submit}
    />,
  );
  assert.ok(
    screen.getByRole('button', { name: 'Scene Title' }),
    'the title alone names the collapsed button, unchanged from the shared card',
  );
});

test('clicking the expander button fires onExpand', () => {
  let calls = 0;
  render(
    <Card
      item={mediaItem()}
      rows={{}}
      gathered={undefined}
      onExpand={() => {
        calls += 1;
      }}
      submit={submit}
    />,
  );
  fireEvent.click(screen.getByRole('button'));
  assert.equal(calls, 1, 'the click, from collapsed, tells web to start gathering');
});
