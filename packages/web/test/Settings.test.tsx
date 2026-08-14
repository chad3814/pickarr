import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/App.tsx';
import { Settings } from '../src/routes/Settings.tsx';
import type { ConfigResponse } from '../src/api/client.ts';

// happy-dom has no download plumbing; a test that stubs these restores them
// so a later test never inherits a stub it did not ask for.
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  cleanup();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

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

test('Save is offered only once the draft differs from what was loaded', async () => {
  stubFetch(async () => json(configResponse()));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/trash directory/i)));

  const save = screen.getByRole('button', { name: /^save$/i });
  assert.equal(save.hasAttribute('disabled'), true);

  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '/data/bin' } });
  assert.equal(screen.getByRole('button', { name: /^save$/i }).hasAttribute('disabled'), false);
});

test('saving sends keep for an untouched secret and reports the pending restart', async () => {
  const sent: string[] = [];
  stubFetch(async (url, init) => {
    if (init?.method === 'PUT') {
      sent.push(String(init.body));
      return json({ savedAt: 1, restartRequired: true });
    }
    return json(configResponse());
  });

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/trash directory/i)));
  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '/data/bin' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() => assert.ok(screen.getByText(/restart/i)));
  const body = JSON.parse(sent[0] ?? '{}') as { trashDir: string; downloadClients: { apiKey: unknown }[] };
  assert.equal(body.trashDir, '/data/bin');
  assert.deepEqual(body.downloadClients[0]?.apiKey, { kind: 'keep' });
});

test('a non-numeric port is reported without ever reaching the server', async () => {
  let putRequests = 0;
  stubFetch(async (_url, init) => {
    if (init?.method === 'PUT') putRequests += 1;
    return json(configResponse());
  });

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/^port$/i)));
  fireEvent.change(screen.getByLabelText(/^port$/i), { target: { value: 'eighty eighty' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() => assert.ok(screen.getByText(/must be a whole number/i)));
  // toSubmission's rejection is what the server would also refuse; sending it
  // anyway would round-trip a value already known to be invalid.
  assert.equal(putRequests, 0);
});

test('a refused save shows the reason and keeps the edit on screen', async () => {
  stubFetch(async (_url, init) =>
    init?.method === 'PUT'
      ? json({ error: 'Config at /config/config.json is invalid — trashDir: String must contain at least 1 character(s)' }, 400)
      : json(configResponse()),
  );

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/trash directory/i)));
  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() => assert.ok(screen.getByText(/trashDir/)));
  // The edit is still there to correct — a rejected save must not discard it.
  assert.equal((screen.getByLabelText(/trash directory/i) as HTMLInputElement).value, '');
});

// The notice has to survive a reload, or a saved-but-unapplied config sits
// there with nothing on screen saying so.
test('a restart pending from an earlier save is reported on load', async () => {
  stubFetch(async () => json(configResponse({ restartRequired: true })));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /restart now/i })));
});

test('Restart now posts and says what it is doing', async () => {
  let restarts = 0;
  stubFetch(async (url, init) => {
    if (url.endsWith('/api/restart') && init?.method === 'POST') {
      restarts += 1;
      return json({ restarting: true }, 202);
    }
    return json(configResponse({ restartRequired: true }));
  });

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /restart now/i })));
  fireEvent.click(screen.getByRole('button', { name: /restart now/i }));
  await waitFor(() => assert.equal(restarts, 1));
  await waitFor(() => assert.ok(screen.getByText(/restarting/i)));
});

test('a failed backup is reported rather than failing silently', async () => {
  stubFetch(async (url) =>
    url.endsWith('/api/database/backup')
      ? json({ error: 'Backup failed: ENOSPC' }, 500)
      : json(configResponse()),
  );

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /back up/i })));
  fireEvent.click(screen.getByRole('button', { name: /back up/i }));
  await waitFor(() => assert.ok(screen.getByText(/ENOSPC/)));
});

test('a successful backup names the file it saved', async () => {
  stubFetch(async (url) =>
    url.endsWith('/api/database/backup')
      ? new Response('SQLite format 3\n', {
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="pickarr-2026-08-13.db"',
          },
        })
      : json(configResponse()),
  );

  // happy-dom has no download plumbing; these two are what the click uses.
  const created: string[] = [];
  URL.createObjectURL = (() => {
    created.push('blob:stub');
    return 'blob:stub';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /back up/i })));
  fireEvent.click(screen.getByRole('button', { name: /back up/i }));
  await waitFor(() => assert.ok(screen.getByText(/pickarr-2026-08-13\.db/)));
  assert.equal(created.length, 1);
});
