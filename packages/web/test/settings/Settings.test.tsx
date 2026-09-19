import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { freshDb } from '../store/harness.ts';
import { applyBatch } from '../../src/store/apply.ts';
import type { SyncOp } from '../../src/store/wire.ts';
import { listByTable } from '../../src/store/rows.ts';
import { subscribeInserts } from '../../src/store/notify.ts';
import type { StoredRow } from '../../src/store/db.ts';
import type { ListByTableOptions } from '../../src/store/rows.ts';
import { Settings, type SettingsSource } from '../../src/settings/Settings.tsx';
import type { AddFeedOutcome } from '../../src/settings/AddFeed.tsx';
import type { AddDownloadClientOutcome } from '../../src/settings/AddDownloadClient.tsx';

/**
 * `afterEach(cleanup)`, never a per-test `cleanup()` (`CLAUDE.md`): a test
 * that throws before its own call would leave both sections mounted, both
 * still subscribed through `notify.ts`'s module-level registry.
 */
afterEach(cleanup);

async function seed(db: IDBDatabase, ops: readonly SyncOp[]): Promise<void> {
  await applyBatch(db, ops, { since: 1, before: null });
}

function feedOp({ id, name }: { id: number; name: string }): SyncOp {
  return {
    op: 'upsert',
    table: 'rss_feed',
    id,
    value: {
      id,
      pluginId: 'tv',
      name,
      downloadType: 'torrent',
      pollIntervalS: 300,
      downloadClientId: null,
      createdAt: id,
      updatedAt: id,
      url: 'https://tracker.example/rss?apikey=***',
    },
  };
}

function clientOp({ id, name }: { id: number; name: string }): SyncOp {
  return {
    op: 'upsert',
    table: 'download_client',
    id,
    value: {
      id,
      name,
      type: 'torrent',
      implementation: 'qbittorrent',
      url: 'http://qbit.example:8080',
      username: null,
      category: '',
      createdAt: id,
      updatedAt: id,
    },
  };
}

function sourceFor(db: IDBDatabase): SettingsSource {
  return {
    listByTable: (table, opts) => listByTable(db, table, opts),
    subscribeInserts,
  };
}

/** Neither section's add form is exercised here; these two fail the test if a listing render reaches them. */
function neverSubmitFeed(): Promise<AddFeedOutcome> {
  assert.fail('a listing test must not call the feed submit');
}
function neverSubmitClient(): Promise<AddDownloadClientOutcome> {
  assert.fail('a listing test must not call the download client submit');
}

function renderSettings(source: SettingsSource): void {
  render(<Settings source={source} submitFeed={neverSubmitFeed} submitDownloadClient={neverSubmitClient} />);
}

test('the settings screen carries the route-mapping marker on its root element', async () => {
  // `Shell.test.tsx`'s mapping test finds whichever screen renders at
  // `/settings` by this marker alone. It sits here rather than on `Feeds`,
  // where it used to: once `/settings` holds two sections, the feeds
  // section is no longer the screen's root element and a marker on it
  // would name a part for the whole.
  const db = await freshDb();
  renderSettings(sourceFor(db));

  const root = screen.getByTestId('settings');
  assert.equal(root.tagName, 'SECTION', 'the marker sits on the root element');
  // `base.css`'s `#root > div > section { flex: 1; min-width: 0 }` is what
  // gives the routed screen its share of the shell's flex row. It matches
  // one element per route; two sibling sections rendered straight from the
  // route would both match it and share the row side by side. That the
  // marked root contains the two sections, rather than sitting beside
  // them, is what keeps that rule pointing at exactly one thing.
  const inner = Array.from(root.children).filter((child) => child.tagName === 'SECTION');
  assert.equal(inner.length, 2, 'both sections are inside the one root');
});

test('both sections list from the replica, each through its own hook', async () => {
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' }), clientOp({ id: 1, name: 'Seedbox' })]);
  renderSettings(sourceFor(db));

  await waitFor(() => {
    assert.equal(screen.getAllByRole('heading', { name: 'Movies HD' }).length, 1, 'the feed is listed');
  });
  await waitFor(() => {
    assert.equal(screen.getAllByRole('heading', { name: 'Seedbox' }).length, 1, 'the download client is listed');
  });
});

/**
 * Every heading `root` contains, in document order, as `"<level> <text>"`.
 *
 * Read off `tagName` rather than `getByRole('heading', { level })`: the
 * assertion below wants the *whole* set in order, and a per-level query
 * answers one level at a time with no way to see a heading that landed at
 * a level nobody asked about. Returns strings, never elements -- handing a
 * live node to `node:assert` is `CLAUDE.md`'s first testing hazard.
 */
function headingOutline(root: HTMLElement): readonly string[] {
  return Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(
    (heading) => `${heading.tagName.slice(1)} ${heading.textContent ?? ''}`,
  );
}

test('the /settings heading hierarchy is three tiers deep in the markup, not only in the stylesheet', async () => {
  // `settings.css`'s heading-hierarchy rule renders three tiers; for one
  // slice the markup announced two, because all four inner headings were
  // still `<h2>`. Visible and announced disagreeing is worse than the
  // uniform flatness it replaced, and nothing failed when it happened --
  // no test in this package asserted a heading *level*, so the whole page
  // could flatten back to `<h2>` and every `getByRole('heading', { name })`
  // in `Feeds.test.tsx`, `DownloadClients.test.tsx` and this file would
  // stay green. This is the assertion that reds instead.
  //
  // Spelled as a literal list rather than counted or derived: a count
  // ("six level-3 headings") is satisfied by six headings at the wrong
  // places, and anything computed from the components under test cannot
  // observe those components changing (`CLAUDE.md`).
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' }), clientOp({ id: 1, name: 'Seedbox' })]);
  renderSettings(sourceFor(db));

  await waitFor(() => {
    assert.equal(screen.getAllByRole('heading', { name: 'Seedbox' }).length, 1, 'the client rendered, so the list tier is present to be checked');
  });

  assert.deepEqual(headingOutline(screen.getByTestId('settings')), [
    '1 Settings',
    '2 Feeds',
    '3 Add a feed',
    '3 Movies HD',
    '2 Download clients',
    '3 Add a download client',
    '3 Seedbox',
  ], 'one page heading, a section heading each, and everything inside a section one level further down');
});

test('a download client list that never resolves leaves the feeds list rendered', async () => {
  // The two hooks are independent, and this is the assertion that says so
  // rather than the arrangement merely implying it. The source below
  // answers `rss_feed` and never answers `download_client`, which is the
  // shape of a read that is slow, stuck, or against a table this replica
  // has not filled yet -- the feeds section must not wait on it.
  const db = await freshDb();
  await seed(db, [feedOp({ id: 1, name: 'Movies HD' })]);
  const stalled: SettingsSource = {
    listByTable: (table: string, opts: ListByTableOptions): Promise<readonly StoredRow[]> =>
      table === 'download_client' ? new Promise<readonly StoredRow[]>(() => {}) : listByTable(db, table, opts),
    subscribeInserts,
  };
  render(<Settings source={stalled} submitFeed={neverSubmitFeed} submitDownloadClient={neverSubmitClient} />);

  await waitFor(() => {
    assert.equal(screen.getAllByRole('heading', { name: 'Movies HD' }).length, 1, 'the feed is listed anyway');
  });
  assert.ok(!screen.queryByText(/no download clients yet/i),
    'the stalled section is still loading, which is the state that would have blanked the other one');
});
