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
    plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes', sites: ['Vixen'], retries: 3 } },
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
    plugins: { '@pickarr/plugin-scenes': { libraryRoot: '/media/scenes', sites: ['Vixen'], retries: 3 } },
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
      { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', downloadClient: 'sab', intervalSeconds: 900, backfill: null },
    ],
    siteLookup: null,
    metadata: { enabled: true, intervalSeconds: 5, perTick: 5, artworkDir: null },
  };
  assert.deepEqual(submitted, expected);
});

test('a plugin list setting drops blank lines, and a number setting is parsed, only at submit', () => {
  // `PluginFields` holds both as raw text in the draft (see its
  // `PluginSettingDraftValue` doc comment) so that typing into either control
  // is not clobbered on every keystroke; this is where that raw text is
  // finally converted back to what `configSchema` expects.
  const original = config({
    plugins: { '@pickarr/plugin-scenes': { sites: ['Vixen'], retries: 3 } },
  });
  const draft = toDraft(original);
  draft.plugins[0]!.settings = [
    { key: 'sites', value: { list: 'Vixen\n\n  \nTushy' } },
    { key: 'retries', value: { number: '5' } },
  ];
  const submitted = toSubmission(draft, original);
  assert.ok(!('error' in submitted));
  assert.deepEqual(submitted.plugins['@pickarr/plugin-scenes'], { sites: ['Vixen', 'Tushy'], retries: 5 });
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

// `Number('')` is `0`, so clearing this field used to submit a `0` the user
// never typed — written into their config and indistinguishable from an
// intentional zero. Holding the raw text is what made the empty state
// reachable, so this is where it has to be refused.
test('a cleared plugin number is refused rather than submitted as zero', () => {
  const original = config();
  const draft = toDraft(original);
  const retries = draft.plugins[0]?.settings.find((entry) => entry.key === 'retries');
  assert.ok(retries !== undefined, 'fixture should carry a numeric plugin setting');
  retries.value = { number: '' };

  const submitted = toSubmission(draft, original);
  assert.ok('error' in submitted, 'an empty number must not reach the server');
  assert.match(submitted.error, /retries/);
  // The message has to say which plugin and which setting: a plugin block can
  // hold a dozen of them.
  assert.match(submitted.error, /@pickarr\/plugin-scenes/);
});

test('a non-numeric plugin number is refused too', () => {
  const original = config();
  const draft = toDraft(original);
  const retries = draft.plugins[0]?.settings.find((entry) => entry.key === 'retries');
  assert.ok(retries !== undefined);
  retries.value = { number: 'three' };

  const submitted = toSubmission(draft, original);
  assert.ok('error' in submitted);
  assert.match(submitted.error, /retries/);
});

// The distinction from `asCount`, which guards ports and intervals and demands
// a positive integer. `configSchema` types a plugin setting as a bare
// `z.number()`, so a plugin is entitled to zero and to a negative — refusing
// them here would reject configs the server accepts.
test('a plugin number may be zero or negative, unlike a port or an interval', () => {
  for (const raw of ['0', '-1', '1.5']) {
    const original = config();
    const draft = toDraft(original);
    const retries = draft.plugins[0]?.settings.find((entry) => entry.key === 'retries');
    assert.ok(retries !== undefined);
    retries.value = { number: raw };

    const submitted = toSubmission(draft, original);
    assert.ok(!('error' in submitted), `${raw} should be accepted`);
    assert.equal(submitted.plugins['@pickarr/plugin-scenes']?.['retries'], Number(raw));
  }
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

test('a chosen backfill style submits as a block, numbers and all', () => {
  const original = config();
  const draft = toDraft(original);
  draft.feeds[0]!.backfillStyle = 'newznab';
  draft.feeds[0]!.backfillPageSize = '50';
  draft.feeds[0]!.backfillPagesPerPass = '3';
  draft.feeds[0]!.backfillMaxPages = '20';

  const submitted = toSubmission(draft, original);

  assert.ok(!('error' in submitted), 'error' in submitted ? submitted.error : '');
  assert.deepEqual(submitted.feeds[0]?.backfill, {
    style: 'newznab',
    pageSize: 50,
    pagesPerPass: 3,
    maxPages: 20,
  });
});

test('backfill left off submits as null, whatever numbers the boxes still hold', () => {
  // The draft keeps the numbers so they survive a toggle; the submission must not
  // carry them, or turning backfill off would look like leaving it on.
  const original = config();
  const draft = toDraft(original);
  draft.feeds[0]!.backfillStyle = 'off';
  draft.feeds[0]!.backfillPageSize = '250';

  const submitted = toSubmission(draft, original);

  assert.ok(!('error' in submitted), 'error' in submitted ? submitted.error : '');
  assert.equal(submitted.feeds[0]?.backfill, null);
});

test('fewer than two pages per pass is refused here, and the message says why', () => {
  // The floor is not arbitrary: below two pages a pass there is no previous page
  // to compare against, so a walk cannot notice an indexer that ignores the
  // pagination parameter and would report the history read having read one page
  // repeatedly. `feedBackfillSchema` enforces it too, but a 400 saying only
  // "invalid" would leave someone guessing at a number that looks reasonable.
  const original = config();
  const draft = toDraft(original);
  draft.feeds[0]!.backfillStyle = 'page';
  draft.feeds[0]!.backfillPagesPerPass = '1';

  const submitted = toSubmission(draft, original);

  assert.ok('error' in submitted);
  assert.match(submitted.error, /pagesPerPass must be at least 2/);
  assert.match(submitted.error, /paginating at all/);
});

test('a non-numeric backfill page size is caught here rather than sent for a 400', () => {
  const original = config();
  const draft = toDraft(original);
  draft.feeds[0]!.backfillStyle = 'newznab';
  draft.feeds[0]!.backfillPageSize = 'lots';

  const submitted = toSubmission(draft, original);

  assert.ok('error' in submitted);
  assert.match(submitted.error, /backfill\.pageSize must be a whole number/);
});

test('a feed already backfilling round-trips unchanged', () => {
  const original = config();
  original.feeds[0]!.backfill = { style: 'page', pageSize: 100, pagesPerPass: 2, maxPages: 100 };

  const submitted = toSubmission(toDraft(original), original);

  assert.ok(!('error' in submitted), 'error' in submitted ? submitted.error : '');
  assert.deepEqual(submitted.feeds[0]?.backfill, original.feeds[0]?.backfill);
});
