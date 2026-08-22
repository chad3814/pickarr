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
        { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', intervalSeconds: 900, backfill: null },
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

test('the nav separates Settings from the library tabs with a rule', () => {
  // Settings is a view of the installation, not of the library, and the rule is
  // what says so. It was an em dash until the nav went vertical, where a dash
  // between two stacked links reads as a stray character rather than a divider.
  stubFetch(async () => json({ groups: [], nextCursor: null }));
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  const nav = screen.getByRole('navigation');

  const rule = nav.querySelector('hr.nav-separator');
  assert.ok(rule !== null, 'the separator is an <hr>, not a glyph');

  // Position, not mere presence. The old test matched the concatenated text
  // `Failed—Settings`, which a rule cannot produce — and presence alone would
  // pass with the divider at the top of the nav, which is the one place it must
  // not be. `compareDocumentPosition` states the ordering directly rather than
  // inferring it from text.
  const failed = screen.getByRole('link', { name: 'Failed' });
  const settings = screen.getByRole('link', { name: 'Settings' });
  const preceding = Node.DOCUMENT_POSITION_PRECEDING;
  const following = Node.DOCUMENT_POSITION_FOLLOWING;
  assert.ok(
    (rule.compareDocumentPosition(failed) & preceding) !== 0,
    'the rule comes after Failed',
  );
  assert.ok(
    (rule.compareDocumentPosition(settings) & following) !== 0,
    'the rule comes before Settings',
  );

  // Deliberately *not* aria-hidden, unlike the em dash it replaces. That dash
  // was hidden because a screen reader announcing "em dash" is noise; an `<hr>`
  // has an implicit `role="separator"`, so it announces the grouping itself —
  // the very thing the dash could only ever convey visually.
  assert.equal(rule.getAttribute('aria-hidden'), null);
  assert.ok(nav.querySelector('[role="separator"], hr') !== null);
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
  let configCalls = 0;
  stubFetch(async (url, init) => {
    if (init?.method === 'PUT') {
      sent.push(String(init.body));
      return json({ savedAt: 1, restartRequired: true });
    }
    configCalls += 1;
    // The initial load precedes any save (nothing pending yet); the re-read
    // that follows a successful save reports the restart it just caused.
    return json(configResponse({ restartRequired: configCalls > 1 }));
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

test('clicking Save twice before the first request resolves issues only one PUT', async () => {
  let putRequests = 0;
  let configCalls = 0;
  let resolvePut: (() => void) | undefined;
  stubFetch(async (_url, init) => {
    if (init?.method === 'PUT') {
      putRequests += 1;
      // Held open so the second click lands while the first save is still in
      // flight — the only window this bug (a double-click sending two PUTs)
      // can occur in.
      await new Promise<void>((resolve) => {
        resolvePut = resolve;
      });
      return json({ savedAt: 1, restartRequired: true });
    }
    configCalls += 1;
    // The initial load precedes any save (nothing pending yet); the re-read
    // that follows a successful save reports the restart it just caused.
    return json(configResponse({ restartRequired: configCalls > 1 }));
  });

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/trash directory/i)));
  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '/data/bin' } });

  const save = screen.getByRole('button', { name: /^save$/i });
  fireEvent.click(save);
  assert.equal(save.hasAttribute('disabled'), true);
  fireEvent.click(save);

  resolvePut?.();
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /restart now/i })));
  assert.equal(putRequests, 1);
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
  const revoked: string[] = [];
  URL.createObjectURL = (() => {
    created.push('blob:stub');
    return 'blob:stub';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /back up/i })));
  fireEvent.click(screen.getByRole('button', { name: /back up/i }));
  await waitFor(() => assert.ok(screen.getByText(/pickarr-2026-08-13\.db/)));
  assert.equal(created.length, 1);
  // A backup that stopped revoking its object URL would leak one per download;
  // this is the only thing that would catch a regression there.
  assert.deepEqual(revoked, ['blob:stub']);
});

test('the download anchor is attached to the document during click, and its object URL is revoked only after the anchor is removed', async () => {
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

  // Ordering, not wall-clock timing: the old code never appended or removed
  // the anchor at all (so `'removed'` would never appear here) and revoked
  // the object URL synchronously right after `click()` — both classic
  // Firefox/Safari download-abort shapes. `waitFor` below uses real timers,
  // so it does not matter whether the fix defers the revoke by one
  // microtask or one macrotask; what matters is that removal precedes it.
  const events: string[] = [];
  URL.createObjectURL = (() => 'blob:stub') as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {
    events.push('revoked');
  }) as typeof URL.revokeObjectURL;

  let attachedDuringClick = false;
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    attachedDuringClick = document.body.contains(this);
    return originalClick.call(this);
  };
  const originalRemove = HTMLAnchorElement.prototype.remove;
  HTMLAnchorElement.prototype.remove = function (this: HTMLAnchorElement) {
    events.push('removed');
    return originalRemove.call(this);
  };

  try {
    render(<Settings />);
    await waitFor(() => assert.ok(screen.getByRole('button', { name: /back up/i })));
    fireEvent.click(screen.getByRole('button', { name: /back up/i }));
    await waitFor(() => assert.ok(screen.getByText(/pickarr-2026-08-13\.db/)));
    await waitFor(() => assert.deepEqual(events, ['removed', 'revoked']));

    assert.equal(attachedDuringClick, true);
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
    HTMLAnchorElement.prototype.remove = originalRemove;
  }
});

test('a failed restart clears the notice a successful save left behind', async () => {
  let configCalls = 0;
  stubFetch(async (url, init) => {
    if (init?.method === 'PUT') return json({ savedAt: 1, restartRequired: true });
    if (url.endsWith('/api/restart') && init?.method === 'POST') {
      return json({ error: 'restart refused: another restart is already in progress' }, 409);
    }
    configCalls += 1;
    // The re-read after the save is what reports the restart it caused.
    return json(configResponse({ restartRequired: configCalls > 1 }));
  });

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/trash directory/i)));
  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '/data/bin' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() => assert.ok(screen.getByText(/saved/i)));

  fireEvent.click(screen.getByRole('button', { name: /restart now/i }));
  await waitFor(() => assert.ok(screen.getByText(/restart refused/i)));
  // The stale green "Saved" notice must not linger next to the new error —
  // restart()'s catch clears it the same way save()'s and backUp()'s already do.
  assert.equal(screen.queryByText(/^Saved\./), null);
});

test('a save that lands but whose confirmation re-read fails still reports the save, not a failure', async () => {
  let configCalls = 0;
  stubFetch(async (_url, init) => {
    if (init?.method === 'PUT') return json({ savedAt: 1, restartRequired: true });
    configCalls += 1;
    // First GET is the initial load; the second is save()'s post-write re-read.
    return configCalls === 1 ? json(configResponse()) : json({ error: 'ECONNRESET' }, 500);
  });

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/trash directory/i)));
  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '/data/bin' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

  // The write succeeded — this must not read as a refused save (no "error"
  // paragraph), and a restart must still be offered since the write landed
  // even though the confirmation read did not.
  await waitFor(() => assert.ok(screen.getByText(/^Saved,/)));
  assert.ok(screen.getByText(/reload/i));
  assert.ok(screen.getByRole('button', { name: /restart now/i }));
});
