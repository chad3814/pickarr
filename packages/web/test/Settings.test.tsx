import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/App.tsx';
import { Settings } from '../src/routes/Settings.tsx';
import type { ConfigResponse } from '../src/api/client.ts';

afterEach(cleanup);

function configResponse(over: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    config: {
      server: { port: 8080 },
      database: { path: '/config/pickarr.db' },
      trashDir: '/data/trash',
      plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes' } },
      downloadClients: [
        {
          id: 'sab',
          type: 'sabnzbd',
          url: 'http://sabnzbd:8080',
          apiKey: { kind: 'set' },
          category: 'pickarr',
          importMode: 'move',
          pathMappings: [],
        },
      ],
      feeds: [
        { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900 },
      ],
      siteLookup: null,
      metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: null },
    },
    portOverride: null,
    restartRequired: false,
    ...over,
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = ((input: string, init?: RequestInit) =>
    handler(String(input), init)) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('the page loads the config and shows the config path fields', async () => {
  stubFetch(async () => json(configResponse()));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByDisplayValue('/data/trash')));
});

test('a config that cannot be read is reported instead of rendering an empty form', async () => {
  stubFetch(async () => json({ error: 'Config at /config/config.json is not valid JSON: bad' }, 500));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByText(/not valid JSON/)));
  assert.equal(screen.queryByRole('button', { name: /^save$/i }), null);
});

test('the nav separates Settings from the library tabs with an em dash', () => {
  stubFetch(async () => json({ groups: [], nextCursor: null }));
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  const nav = screen.getByRole('navigation');
  assert.match(nav.textContent ?? '', /Failed—Settings/);
  // Decorative: a screen reader should announce five tabs, not an em dash
  // between them.
  assert.equal(nav.querySelector('.nav-separator')?.getAttribute('aria-hidden'), 'true');
});
