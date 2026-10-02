import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render, screen, cleanup, waitFor, act, within } from '@testing-library/react';
import type { ActivityRead } from '@pickarr/contract';
import { emitActivity, emitReset, subscribeActivity, subscribeReset, subscribeTable } from '../../src/store/notify.ts';
import { Activities, type ActivitiesSource } from '../../src/activity/Activities.tsx';
import type { ActivityFetch } from '../../src/activity/useActivity.ts';
import type { ActiveDownload } from '../../src/store/rows.ts';
import type { SendJsonResult } from '../../src/auth/sendJson.ts';

/** `afterEach(cleanup)` (`CLAUDE.md`): the page owns a real polling interval. */
afterEach(cleanup);

const LONG_ERROR = `boom ${'x'.repeat(2000)} end`;

const READ: ActivityRead = {
  jobs: {
    running: [
      { id: 1, pluginId: 'alpha', kind: 'noop', attempts: 1, maxAttempts: 3, runAt: 1, startedAt: 2, updatedAt: 3, lastError: null },
    ],
    waiting: [],
    dead: [
      { id: 2, pluginId: 'beta', kind: 'poll', attempts: 3, maxAttempts: 3, runAt: 1, startedAt: 2, updatedAt: 3, lastError: LONG_ERROR },
    ],
    recent: [],
  },
  fetches: [
    { hostname: 'h', limit: 1, inFlight: [], waiting: [{ method: 'GET', target: 'https://h/x' }] },
  ],
};

const DOWNLOAD: ActiveDownload = {
  table: 'torrent_download',
  id: 11,
  status: 'downloading',
  percentage: 42,
  filename: 'a.mkv',
  title: 'A Show',
  clientName: 'Seedbox',
  updatedAt: 9,
};

function answered(body: unknown): SendJsonResult {
  return { outcome: 'answered', status: 200, body };
}

function sourceWith(downloads: () => readonly ActiveDownload[]): ActivitiesSource {
  return {
    subscribeActivity,
    subscribeTable,
    subscribeReset,
    activeDownloads: () => Promise.resolve(downloads()),
  };
}

const noExpiry = (): void => {};

test('before the first answer the page says Loading…', () => {
  const never: ActivityFetch = () => new Promise<SendJsonResult>(() => {});
  render(<Activities source={sourceWith(() => [])} fetchActivity={never} onExpired={noExpiry} />);
  assert.ok(screen.getByText('Loading…'));
});

test('an answered read renders the six headings and the lines under them', async () => {
  render(
    <Activities source={sourceWith(() => [DOWNLOAD])} fetchActivity={() => Promise.resolve(answered(READ))} onExpired={noExpiry} />,
  );
  await screen.findByText('alpha noop');
  for (const name of ['Running', 'Waiting', 'Dead', 'Recently finished', 'Fetch queue', 'Downloads in progress']) {
    assert.ok(screen.getByRole('heading', { name }), `the ${name} heading`);
  }
  assert.ok(screen.getByText('attempt 1 of 3'), 'the running job\'s attempts');
  assert.ok(screen.getByText('Nothing waiting'));
  assert.ok(screen.getByText('Nothing finished recently'));
  assert.ok(screen.getByText('h · 0 in flight, 1 waiting, limit 1'));
  assert.ok(screen.getByText('GET https://h/x'));
  await waitFor(() => {
    assert.ok(screen.getByText('a.mkv'));
  });
  const downloads = screen.getByRole('list', { name: 'downloads in progress' });
  assert.deepEqual(
    within(downloads).getAllByRole('listitem').map((li) => li.textContent),
    ['a.mkvA ShowSeedboxdownloading42%'],
  );
});

test('every empty list says so in words', async () => {
  const empty: ActivityRead = { jobs: { running: [], waiting: [], dead: [], recent: [] }, fetches: [] };
  render(<Activities source={sourceWith(() => [])} fetchActivity={() => Promise.resolve(answered(empty))} onExpired={noExpiry} />);
  for (const sentence of [
    'Nothing running',
    'Nothing waiting',
    'No dead jobs',
    'Nothing finished recently',
    'No requests queued',
    'No downloads in progress',
  ]) {
    await screen.findByText(sentence);
  }
});

test('a dead job\'s 2 000-character error renders in full, in a pre that is not a label', async () => {
  render(<Activities source={sourceWith(() => [])} fetchActivity={() => Promise.resolve(answered(READ))} onExpired={noExpiry} />);
  const pre = await screen.findByText(LONG_ERROR);
  assert.equal(pre.tagName, 'PRE');
  assert.ok((pre.textContent ?? '').length >= 2000, 'nothing is truncated');
  assert.equal(pre.getAttribute('aria-label'), null, 'an attribute would be announced as a label');
  assert.equal(pre.closest('[aria-label]')?.getAttribute('aria-label'), 'dead jobs', 'it sits inside the dead list, not under its own label');
  const css = await readFile(join(import.meta.dirname, '..', '..', 'src', 'styles', 'activities.css'), 'utf8');
  const selector = "section[aria-labelledby='activities-heading'] pre";
  assert.ok(pre.matches(selector), 'it is the element activities.css reaches');
  assert.ok(css.includes(`${selector} {`), 'and activities.css has a rule for it');
  const rule = css.slice(css.indexOf(`${selector} {`));
  assert.ok(rule.includes('white-space: pre-wrap'), 'that rule wraps, so a long error is not a scrollbar');
});

test('index.css imports activities.css into the components layer', async () => {
  const css = await readFile(join(import.meta.dirname, '..', '..', 'src', 'styles', 'index.css'), 'utf8');
  assert.ok(css.includes("@import './activities.css' layer(components);"));
});

test('an offline answer after a read keeps it and says Couldn\'t reach Pickarr', async () => {
  let offline = false;
  const fetchActivity: ActivityFetch = () =>
    Promise.resolve(offline ? { outcome: 'offline' } : answered(READ));
  render(<Activities source={sourceWith(() => [])} fetchActivity={fetchActivity} onExpired={noExpiry} />);
  await screen.findByText('alpha noop');
  assert.ok(!screen.queryByText('Couldn\'t reach Pickarr'));
  offline = true;
  act(() => {
    emitActivity();
  });
  await screen.findByText('Couldn\'t reach Pickarr');
  assert.ok(screen.getByText('alpha noop'), 'the last read stays on screen');
});

test('the downloads list re-reads after a replica reset', async () => {
  let current: readonly ActiveDownload[] = [DOWNLOAD];
  render(<Activities source={sourceWith(() => current)} fetchActivity={() => Promise.resolve(answered(READ))} onExpired={noExpiry} />);
  await screen.findByText('a.mkv');
  current = [];
  act(() => {
    emitReset();
  });
  await screen.findByText('No downloads in progress');
  assert.ok(!screen.queryByText('a.mkv'), 'a stale list does not survive a reset');
});
