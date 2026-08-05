import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../../src/pipeline/scheduler.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import type { UntrackedEntry } from '../../src/pipeline/reconcile.ts';

const UNTRACKED: UntrackedEntry[] = [
  { ref: 'foreign', name: 'Not Ours', state: 'downloading', percentage: 10 },
];

test('reconcileNow caches the untracked snapshot for later reads', async () => {
  const db = openTestDatabase();
  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => ({
      seen: 0,
      inserted: 0,
      parseErrors: 0,
      groupsCreated: 0,
      releasesAdded: 0,
      upgradesFlagged: 0,
    }),
    reconcile: async () => ({ untracked: UNTRACKED, advanced: 0, failed: 0, imported: 0 }),
    clientIds: ['sab'],
    log: () => {},
  });

  assert.deepEqual(scheduler.untrackedFor('sab'), []);
  await scheduler.reconcileNow();
  assert.deepEqual(scheduler.untrackedFor('sab'), UNTRACKED);
  db.close();
});

test('a reconcile failure is logged and does not throw out of the tick', async () => {
  const db = openTestDatabase();
  const logged: string[] = [];
  const scheduler = createScheduler({
    db,
    feeds: [],
    ingestFeed: async () => {
      throw new Error('unused');
    },
    reconcile: async () => {
      throw new Error('sab unreachable');
    },
    clientIds: ['sab'],
    log: (message) => logged.push(message),
  });

  await scheduler.reconcileNow();
  assert.ok(logged.some((line) => line.includes('sab unreachable')));
  db.close();
});

test('an ingest failure on one feed does not stop the others', async () => {
  const db = openTestDatabase();
  const ingested: string[] = [];
  const scheduler = createScheduler({
    db,
    feeds: [
      { id: 'a', url: 'https://a.invalid', plugin: 'p', intervalSeconds: 1 },
      { id: 'b', url: 'https://b.invalid', plugin: 'p', intervalSeconds: 1 },
    ],
    ingestFeed: async (feed) => {
      if (feed.id === 'a') throw new Error('feed a is down');
      ingested.push(feed.id);
      return {
        seen: 0,
        inserted: 0,
        parseErrors: 0,
        groupsCreated: 0,
        releasesAdded: 0,
        upgradesFlagged: 0,
      };
    },
    reconcile: async () => ({ untracked: [], advanced: 0, failed: 0, imported: 0 }),
    clientIds: [],
    log: () => {},
  });

  await scheduler.ingestAllNow();
  assert.deepEqual(ingested, ['b']);
  db.close();
});
