import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FeedFields } from '../src/components/settings/FeedFields.tsx';
import type { FeedDraft } from '../src/components/settings/ConfigForm.tsx';

afterEach(cleanup);

function feeds(): FeedDraft[] {
  return [
    { id: 'feed1', url: 'https://example.invalid/rss', plugin: '@pickarr/plugin-scenes', downloadClient: 'sab', intervalSeconds: '900', backfillStyle: 'off', backfillPageSize: '100', backfillPagesPerPass: '2', backfillMaxPages: '100' },
  ];
}

test('a feed picks its plugin from the configured ones, not free text', () => {
  render(
    <FeedFields feeds={feeds()} pluginNames={['@pickarr/plugin-scenes']} clientIds={['sab']} onChange={() => {}} />,
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
    <FeedFields feeds={next} pluginNames={['@pickarr/plugin-scenes']} clientIds={['sab']} onChange={(value) => { next = value; }} />,
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
  // Annotated so `backfillStyle` narrows to the union rather than widening to
  // `string`, which an unannotated literal does.
  const stale: FeedDraft[] = [
    {
      id: 'feed1',
      url: 'https://example.invalid/rss',
      plugin: '@pickarr/plugin-old-name',
      downloadClient: 'sab',
      intervalSeconds: '900',
      backfillStyle: 'off',
      backfillPageSize: '100',
      backfillPagesPerPass: '2',
      backfillMaxPages: '100',
    },
  ];
  render(<FeedFields feeds={stale} pluginNames={['@pickarr/plugin-new-name']} clientIds={['sab']} onChange={() => {}} />);
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
    <FeedFields feeds={next} pluginNames={['@pickarr/plugin-scenes']} clientIds={['sab']} onChange={(value) => { next = value; }} />,
  );
  // Named by id: this query would fail to resolve to a single element -
  // failing the test - if the per-row aria-label were ever removed.
  fireEvent.click(screen.getByRole('button', { name: /remove feed feed2/i }));
  assert.deepEqual(next.map((feed) => feed.id), ['feed1', 'feed3']);
});

test('a feed defaults to not backfilling, and its settings stay out of the way', () => {
  // Off is the schema's own default — `backfill` is optional — and showing three
  // disabled boxes beside an Off selector is noise on the common case.
  render(
    <FeedFields feeds={feeds()} pluginNames={['@pickarr/plugin-scenes']} clientIds={['sab']} onChange={() => {}} />,
  );

  const select = screen.getByLabelText(/backfill history/i) as HTMLSelectElement;
  assert.equal(select.value, 'off');
  assert.equal(screen.queryByLabelText(/items per page/i), null);
  assert.equal(screen.queryByLabelText(/pages per pass/i), null);
});

test('choosing a pagination style reveals the settings it needs', () => {
  const drafts = feeds();
  drafts[0]!.backfillStyle = 'newznab';
  render(
    <FeedFields feeds={drafts} pluginNames={['@pickarr/plugin-scenes']} clientIds={['sab']} onChange={() => {}} />,
  );

  assert.ok(screen.getByLabelText(/items per page/i));
  assert.ok(screen.getByLabelText(/pages per pass/i));
  assert.ok(screen.getByLabelText(/maximum pages/i));
});

test('the style offers no automatic option, because Pickarr cannot detect one', () => {
  // Deliberate, not an omission. Nothing in an RSS document says how the indexer
  // pages, and a wrong guess is the silent failure — an indexer that ignores the
  // parameter serves page one forever and every item on it is already known. The
  // options are named by what they send so they can be matched against an
  // indexer's own documentation.
  render(
    <FeedFields feeds={feeds()} pluginNames={['@pickarr/plugin-scenes']} clientIds={['sab']} onChange={() => {}} />,
  );

  const select = screen.getByLabelText(/backfill history/i) as HTMLSelectElement;
  const values = [...select.options].map((option) => option.value);
  assert.deepEqual(values, ['off', 'newznab', 'page']);
});

test('an added feed is not backfilling', () => {
  // Adding a feed must not quietly start walking someone's indexer.
  let added: FeedDraft[] = [];
  render(
    <FeedFields feeds={feeds()} pluginNames={['@pickarr/plugin-scenes']} clientIds={['sab']} onChange={(next) => (added = next)} />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));

  assert.equal(added[1]?.backfillStyle, 'off');
  // ...but carrying the schema's defaults, so switching it on presents the same
  // starting point as a block written by hand with only `style` set.
  assert.equal(added[1]?.backfillPageSize, '100');
  assert.equal(added[1]?.backfillPagesPerPass, '2');
});

test('switching backfill off keeps the numbers that were typed', () => {
  // They are hidden, not cleared: someone toggling off to compare against another
  // feed and back on again should not have to retype what they had.
  const drafts = feeds();
  drafts[0]!.backfillStyle = 'newznab';
  drafts[0]!.backfillPageSize = '250';
  let updated: FeedDraft[] = [];
  render(
    <FeedFields feeds={drafts} pluginNames={['@pickarr/plugin-scenes']} clientIds={['sab']} onChange={(next) => (updated = next)} />,
  );

  fireEvent.change(screen.getByLabelText(/backfill history/i), { target: { value: 'off' } });

  assert.equal(updated[0]?.backfillStyle, 'off');
  assert.equal(updated[0]?.backfillPageSize, '250');
});

// #34: a feed names the download client its picks go to. Chosen from the
// configured ids for the same reason the plugin is: `parseConfig` refuses a
// name `downloadClients` does not carry, so free text can only produce a 400.
test('a feed picks its download client from the configured ids, not free text', () => {
  render(
    <FeedFields
      feeds={feeds()}
      pluginNames={['@pickarr/plugin-scenes']}
      clientIds={['sab', 'sab-b']}
      onChange={() => {}}
    />,
  );
  const select = screen.getByLabelText(/download client/i) as HTMLSelectElement;
  assert.equal(select.tagName, 'SELECT');
  assert.equal(select.value, 'sab');
  assert.deepEqual([...select.options].map((option) => option.value), ['sab', 'sab-b']);
});

test('choosing a different download client is reported through onChange', () => {
  let next: FeedDraft[] = [];
  render(
    <FeedFields
      feeds={feeds()}
      pluginNames={['@pickarr/plugin-scenes']}
      clientIds={['sab', 'sab-b']}
      onChange={(value) => (next = value)}
    />,
  );

  fireEvent.change(screen.getByLabelText(/download client/i), { target: { value: 'sab-b' } });

  assert.equal(next[0]?.downloadClient, 'sab-b');
});

test('an added feed defaults to the first configured client', () => {
  // The same rule as `plugin`, and for the same reason: an empty value is
  // never valid against `feedSchema`, so offering one only produces a 400.
  let next: FeedDraft[] = [];
  render(
    <FeedFields
      feeds={feeds()}
      pluginNames={['@pickarr/plugin-scenes']}
      clientIds={['sab', 'sab-b']}
      onChange={(value) => (next = value)}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Add feed' }));

  assert.equal(next[1]?.downloadClient, 'sab');
});
