import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { App } from '../src/App.tsx';
import { Settings } from '../src/routes/Settings.tsx';
import type {
  ConfigResponse,
  EditableDownloadClient,
  EditableQbittorrentClient,
  SubmittedDownloadClient,
} from '../src/api/client.ts';
import { fetchStub, jsonResponse, type FetchHandler } from './fetchStub.ts';

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
        { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', downloadClient: 'sab', intervalSeconds: 900, backfill: null },
      ],
      siteLookup: null,
      metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: null },
    },
    portOverride: null,
    restartRequired: false,
    ...over,
  };
}

function stubFetch(handler: FetchHandler): void {
  globalThis.fetch = fetchStub(handler);
}

// Comparing a live DOM element against `null` via `assert.equal` is what
// `CLAUDE.md` warns builds an AssertionError message by deep-inspecting the
// element on failure, hanging the run; computing the
// boolean first and asserting that keeps a failure's message a plain
// `false`. Named for a label rather than arbitrary text, unlike `Browse.test
// .tsx`'s `gone`: a download client's "API key" text also lives, unremovable,
// inside the Authentication `<option>` this file's tests exercise, and only
// `getByLabelText` — which resolves through a real label association, not a
// select option's text content — tells "the field is not rendered" apart
// from "the option naming it still is".
function noField(text: string | RegExp): boolean {
  return screen.queryByLabelText(text) === null;
}

/** A single qBittorrent client, in the login-or-key shape a test asks for. */
function qbittorrentClient(over: Partial<EditableQbittorrentClient> = {}): EditableQbittorrentClient {
  return {
    id: 'qbt',
    type: 'qbittorrent',
    url: 'http://qbittorrent:8080',
    apiKey: null,
    username: null,
    password: null,
    category: 'pickarr',
    importMode: 'copy',
    pathMappings: [],
    ...over,
  };
}

/** `configResponse`, but with a single qBittorrent client in place of the SABnzbd one. */
function qbittorrentConfigResponse(client: EditableDownloadClient, over: Partial<ConfigResponse> = {}): ConfigResponse {
  const base = configResponse();
  return configResponse({
    config: {
      ...base.config,
      downloadClients: [client],
      feeds: base.config.feeds.map((feed) => ({
        id: feed.id,
        url: feed.url,
        plugin: feed.plugin,
        intervalSeconds: feed.intervalSeconds,
        downloadClient: client.id,
        backfill: feed.backfill,
      })),
    },
    ...over,
  });
}

test('the page loads the config and shows the config path fields', async () => {
  stubFetch(async () => jsonResponse(configResponse()));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByDisplayValue('/data/trash')));
});

test('a config that cannot be read is reported instead of rendering an empty form', async () => {
  stubFetch(async () => jsonResponse({ error: 'Config at /config/config.json is not valid JSON: bad' }, 500));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByText(/not valid JSON/)));
  assert.ok(!screen.queryByRole('button', { name: /^save$/i }), 'no save button');
});

test('the nav separates Settings from the library tabs with a rule', () => {
  // Settings is a view of the installation, not of the library, and the rule is
  // what says so. It was an em dash until the nav went vertical, where a dash
  // between two stacked links reads as a stray character rather than a divider.
  stubFetch(async () => jsonResponse({ groups: [], nextCursor: null }));
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
  // inferring it from text. `Dismissed` is the link immediately above the rule
  // now that Failed is gone; the property under test — the rule's position,
  // not which label sits beside it — is unchanged.
  const dismissed = screen.getByRole('link', { name: 'Dismissed' });
  const settings = screen.getByRole('link', { name: 'Settings' });
  const preceding = Node.DOCUMENT_POSITION_PRECEDING;
  const following = Node.DOCUMENT_POSITION_FOLLOWING;
  assert.ok(
    (rule.compareDocumentPosition(dismissed) & preceding) !== 0,
    'the rule comes after Dismissed',
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
  stubFetch(async () => jsonResponse(configResponse()));
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
      return jsonResponse({ savedAt: 1, restartRequired: true });
    }
    configCalls += 1;
    // The initial load precedes any save (nothing pending yet); the re-read
    // that follows a successful save reports the restart it just caused.
    return jsonResponse(configResponse({ restartRequired: configCalls > 1 }));
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
      return jsonResponse({ savedAt: 1, restartRequired: true });
    }
    configCalls += 1;
    // The initial load precedes any save (nothing pending yet); the re-read
    // that follows a successful save reports the restart it just caused.
    return jsonResponse(configResponse({ restartRequired: configCalls > 1 }));
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
    return jsonResponse(configResponse());
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
      ? jsonResponse({ error: 'Config at /config/config.json is invalid — trashDir: String must contain at least 1 character(s)' }, 400)
      : jsonResponse(configResponse()),
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
  stubFetch(async () => jsonResponse(configResponse({ restartRequired: true })));
  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /restart now/i })));
});

test('Restart now posts and says what it is doing', async () => {
  let restarts = 0;
  stubFetch(async (url, init) => {
    if (url.endsWith('/api/restart') && init?.method === 'POST') {
      restarts += 1;
      return jsonResponse({ restarting: true }, 202);
    }
    return jsonResponse(configResponse({ restartRequired: true }));
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
      ? jsonResponse({ error: 'Backup failed: ENOSPC' }, 500)
      : jsonResponse(configResponse()),
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
      : jsonResponse(configResponse()),
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
      : jsonResponse(configResponse()),
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
    if (init?.method === 'PUT') return jsonResponse({ savedAt: 1, restartRequired: true });
    if (url.endsWith('/api/restart') && init?.method === 'POST') {
      return jsonResponse({ error: 'restart refused: another restart is already in progress' }, 409);
    }
    configCalls += 1;
    // The re-read after the save is what reports the restart it caused.
    return jsonResponse(configResponse({ restartRequired: configCalls > 1 }));
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
  assert.ok(!screen.queryByText(/^Saved\./), 'no saved notice');
});

test('a save that lands but whose confirmation re-read fails still reports the save, not a failure', async () => {
  let configCalls = 0;
  stubFetch(async (_url, init) => {
    if (init?.method === 'PUT') return jsonResponse({ savedAt: 1, restartRequired: true });
    configCalls += 1;
    // First GET is the initial load; the second is save()'s post-write re-read.
    return configCalls === 1 ? jsonResponse(configResponse()) : jsonResponse({ error: 'ECONNRESET' }, 500);
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

// Before this fix, `EditableDownloadClient` was hardcoded to the SABnzbd
// shape (`config/editable.ts`'s union hadn't reached the web mirror yet), so
// a qBittorrent client's `username`/`password` had no field in the type at
// all and `DownloadClientFields` had exactly one branch: an `apiKey`
// `SecretField`, always rendered. Loading a login-based client would have
// shown an API key control (bound to `undefined`) and no username or
// password at all — the opposite of what this test asks for.
test('a qBittorrent client with a login renders username and password fields and no apiKey field', async () => {
  const client = qbittorrentClient({ username: 'admin', password: { kind: 'set' } });
  stubFetch(async () => jsonResponse(qbittorrentConfigResponse(client)));

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/^username$/i)));

  assert.equal((screen.getByLabelText(/^username$/i) as HTMLInputElement).value, 'admin');
  assert.ok(screen.getByRole('button', { name: /^replace password$/i }));
  // Not "no apiKey text" — the Authentication `<select>` always carries an
  // "API key" option — but no *field* for it: no label a real input answers
  // to, and no Replace/Keep existing button naming it.
  assert.ok(noField(/^api key$/i));
  assert.equal(screen.queryAllByRole('button', { name: /api key/i }).length, 0);
});

// The mirror image of the test above, and just as load-bearing: a version of
// the fix that rendered *both* credential groups whenever the client was
// qBittorrent (rather than switching on which of `apiKey`/`username` the
// client actually carries) would pass the login test above and fail only
// this one.
test('a qBittorrent client with a key renders the apiKey field and no username or password fields', async () => {
  const client = qbittorrentClient({ apiKey: { kind: 'set' } });
  stubFetch(async () => jsonResponse(qbittorrentConfigResponse(client)));

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /^replace api key$/i })));

  assert.ok(noField(/^username$/i));
  assert.equal(screen.queryAllByRole('button', { name: /password/i }).length, 0);
});

test('saving a qBittorrent client round-trips its login unchanged', async () => {
  const client = qbittorrentClient({ username: 'admin', password: { kind: 'set' } });
  const sent: string[] = [];
  stubFetch(async (_url, init) => {
    if (init?.method === 'PUT') {
      sent.push(String(init.body));
      return jsonResponse({ savedAt: 1, restartRequired: false });
    }
    return jsonResponse(qbittorrentConfigResponse(client));
  });

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByLabelText(/^username$/i)));
  // Untouched apart from a field elsewhere in the form, so Save is offered —
  // the client itself is exactly what was loaded.
  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '/data/bin' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() => assert.equal(sent.length, 1));
  const body = JSON.parse(sent[0] ?? '{}') as { downloadClients: SubmittedDownloadClient[] };
  assert.deepEqual(body.downloadClients, [
    {
      id: 'qbt',
      type: 'qbittorrent',
      url: 'http://qbittorrent:8080',
      apiKey: null,
      username: 'admin',
      // `{ kind: 'set' }` on disk starts the form at `keep`, and an untouched
      // field submits exactly that — never the password itself, which the
      // browser was never sent.
      password: { kind: 'keep' },
      category: 'pickarr',
      importMode: 'copy',
      pathMappings: [],
    },
  ]);
});

// The plausible wrong fix this guards against: deriving `type` for the
// submission by looking the client's *id* up in the loaded config, rather
// than reading it off the draft row itself. That lookup gives the right
// answer for every id that did not change in this edit — including an
// ordinary unchanged save — so it would pass every test above. Renaming the
// id in the same edit that saves is what tells the two apart: a lookup by
// the *old* id finds nothing for the new one and falls back to `'sabnzbd'`,
// silently rewriting a qBittorrent client in SABnzbd's shape — the exact
// failure the controller's ruling calls out.
test('renaming a qBittorrent client in the same save still submits its real type', async () => {
  const client = qbittorrentClient({ apiKey: { kind: 'set' } });
  const sent: string[] = [];
  stubFetch(async (_url, init) => {
    if (init?.method === 'PUT') {
      sent.push(String(init.body));
      return jsonResponse({ savedAt: 1, restartRequired: false });
    }
    return jsonResponse(qbittorrentConfigResponse(client));
  });

  render(<Settings />);
  await waitFor(() => assert.ok(screen.getByRole('button', { name: /^replace api key$/i })));

  const clientsGroup = screen.getByRole('group', { name: /download clients/i });
  fireEvent.change(within(clientsGroup).getByLabelText(/^id$/i), { target: { value: 'qbt-renamed' } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() => assert.equal(sent.length, 1));
  const body = JSON.parse(sent[0] ?? '{}') as { downloadClients: { id: string; type: string }[] };
  assert.equal(body.downloadClients[0]?.id, 'qbt-renamed');
  assert.equal(body.downloadClients[0]?.type, 'qbittorrent');
});
