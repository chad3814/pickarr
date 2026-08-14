import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ConfigForm, toDraft, toSubmission } from '../src/components/settings/ConfigForm.tsx';
import type { EditableConfig, SubmittedConfig } from '../src/api/client.ts';

afterEach(cleanup);

function config(over: Partial<EditableConfig> = {}): EditableConfig {
  return {
    server: { port: 8080 },
    database: { path: '/config/pickarr.db' },
    trashDir: '/data/trash',
    plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes', sites: ['Vixen'] } },
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
    ...over,
  };
}

test('a round trip with no edits submits the config unchanged, keeping secrets', () => {
  const original = config();
  const submitted = toSubmission(toDraft(original), original);
  const expected: SubmittedConfig = {
    server: { port: 8080 },
    database: { path: '/config/pickarr.db' },
    trashDir: '/data/trash',
    plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes', sites: ['Vixen'] } },
    downloadClients: [
      {
        id: 'sab',
        type: 'sabnzbd',
        url: 'http://sabnzbd:8080',
        apiKey: { kind: 'keep' },
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
  };
  assert.deepEqual(submitted, expected);
});

test('an empty artwork directory submits as absent, not as an empty string', () => {
  const original = config({
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: '/old/art' },
  });
  const draft = toDraft(original);
  draft.metadata.artworkDir = '';
  const submitted = toSubmission(draft, original);
  assert.ok(!('error' in submitted));
  assert.equal(submitted.metadata.artworkDir, null);
});

test('a non-numeric port is caught here rather than sent for a 400', () => {
  const original = config();
  const draft = toDraft(original);
  draft.port = 'eighty eighty';
  const submitted = toSubmission(draft, original);
  assert.ok('error' in submitted);
  assert.match(submitted.error, /port/i);
});

test('editing the trash directory updates the draft', () => {
  const original = config();
  let draft = toDraft(original);
  render(
    <ConfigForm
      config={original}
      draft={draft}
      portOverride={null}
      onChange={(next) => {
        draft = next;
      }}
    />,
  );
  fireEvent.change(screen.getByLabelText(/trash directory/i), { target: { value: '/data/bin' } });
  assert.equal(draft.trashDir, '/data/bin');
});

test('a runtime port override is stated instead of being silently contradicted', () => {
  const original = config();
  render(
    <ConfigForm config={original} draft={toDraft(original)} portOverride={9999} onChange={() => {}} />,
  );
  assert.ok(screen.getByText(/9999/));
  assert.ok(screen.getByText(/PICKARR_PORT/));
});

test('adding a site lookup starts with an empty literal key, not a keep', () => {
  const original = config();
  const draft = toDraft(original);
  draft.siteLookup = { present: true, apiKey: { kind: 'literal', value: '' }, baseUrl: 'https://api.theporndb.net' };
  const submitted = toSubmission(draft, original);
  assert.ok(!('error' in submitted));
  assert.deepEqual(submitted.siteLookup?.apiKey, { kind: 'literal', value: '' });
});
