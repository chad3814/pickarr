import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup } from '@testing-library/react';
import { DownloadTypeIcon, ImagePlaceholder, ProviderBadge } from '../src/icons.tsx';

afterEach(cleanup);

test('a download-type icon names the type it stands for', () => {
  // The name is the whole accessibility of a glyph: without it a screen
  // reader announces nothing at all where a sighted user sees "torrent".
  const { container } = render(<DownloadTypeIcon type="torrent" />);
  assert.ok(screen.getByRole('img', { name: 'torrent' }), 'the torrent icon is named');
  assert.ok(container.querySelector('.icon'), 'the icon has the icon class');
});

test('an unknown download type still renders something named', () => {
  // `rss_item.download_type` is replica data of open range. A glyph this
  // build has no drawing for must not render an empty box with no name.
  const { container } = render(<DownloadTypeIcon type="carrier-pigeon" />);
  assert.ok(screen.getByRole('img', { name: 'carrier-pigeon' }), 'the unknown type is still named');
  assert.ok(container.querySelector('.icon'), 'the icon has the icon class');
});

test('a provider badge shows its lettermark as text', () => {
  // Text, not a path: `getByText` proves a sighted user sees the letters,
  // where an `aria-label` alone would pass while rendering nothing.
  const { container } = render(<ProviderBadge label="TMDb" />);
  assert.ok(screen.getByText('TMDb'), 'the lettermark is rendered text');
  assert.ok(container.querySelector('.badge'), 'the badge has the badge class');
});

test('the placeholder is named for what is missing', () => {
  const { container } = render(<ImagePlaceholder label="No poster for Blockers" />);
  assert.ok(screen.getByRole('img', { name: 'No poster for Blockers' }), 'the placeholder is named');
  assert.ok(container.querySelector('.placeholder'), 'the placeholder has the placeholder class');
});
