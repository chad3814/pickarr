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

test('removing a feed drops exactly that row', () => {
  let next = [...feeds(), { ...feeds()[0]!, id: 'feed2' }];
  render(
    <FeedFields feeds={next} pluginNames={['@pickarr/plugin-scenes']} onChange={(value) => { next = value; }} />,
  );
  fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0]!);
  assert.deepEqual(next.map((feed) => feed.id), ['feed2']);
});
