import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FeedFields } from '../src/components/settings/FeedFields.tsx';
import type { FeedDraft } from '../src/components/settings/ConfigForm.tsx';

afterEach(cleanup);

function feeds(): FeedDraft[] {
  return [
    { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: '900' },
  ];
}

test('a feed picks its plugin from the configured ones, not free text', () => {
  render(
    <FeedFields feeds={feeds()} pluginNames={['@pickarr/plugin-scenes']} onChange={() => {}} />,
  );
  const select = screen.getByLabelText(/plugin/i);
  assert.equal(select.tagName, 'SELECT');
  assert.deepEqual(
    [...select.querySelectorAll('option')].map((option) => option.getAttribute('value')),
    ['@pickarr/plugin-scenes'],
  );
});

test('an added feed defaults its interval to the schema default', () => {
  let next = feeds();
  render(
    <FeedFields feeds={next} pluginNames={['@pickarr/plugin-scenes']} onChange={(value) => { next = value; }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /add feed/i }));
  assert.equal(next.length, 2);
  assert.equal(next[1]?.intervalSeconds, '900');
  assert.equal(next[1]?.plugin, '@pickarr/plugin-scenes');
});

// A feed's plugin can name a plugin that used to be configured but, in this
// same draft, no longer is — most commonly because it was renamed. Without a
// stand-in option, the <select> renders nothing selected while `feed.plugin`
// still holds the old name, so the form shows one thing and submits another.
test('a feed whose plugin was renamed away still shows its (now unlisted) plugin selected', () => {
  const stale = [
    { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-old-name', intervalSeconds: '900' },
  ];
  render(<FeedFields feeds={stale} pluginNames={['@pickarr/plugin-new-name']} onChange={() => {}} />);
  const select = screen.getByLabelText(/plugin/i) as HTMLSelectElement;
  assert.equal(select.value, '@pickarr/plugin-old-name');
  assert.deepEqual(
    [...select.querySelectorAll('option')].map((option) => option.getAttribute('value')),
    ['@pickarr/plugin-old-name', '@pickarr/plugin-new-name'],
  );
});

test('removing a feed drops exactly that row, leaving the others in order', () => {
  // Three rows so a bug that always drops the first or last row, regardless
  // of which button was clicked, cannot pass by accident: the middle row is
  // the one under test here.
  let next = [...feeds(), { ...feeds()[0]!, id: 'feed2' }, { ...feeds()[0]!, id: 'feed3' }];
  render(
    <FeedFields feeds={next} pluginNames={['@pickarr/plugin-scenes']} onChange={(value) => { next = value; }} />,
  );
  // Named by id: this query would fail to resolve to a single element -
  // failing the test - if the per-row aria-label were ever removed.
  fireEvent.click(screen.getByRole('button', { name: /remove feed feed2/i }));
  assert.deepEqual(next.map((feed) => feed.id), ['feed1', 'feed3']);
});
