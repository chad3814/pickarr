/**
 * Asking for a release to be identified again.
 *
 * The engine leaves a name it did not recognise `unresolved` and enqueues
 * nothing, because that is "the state a human might fix" -- so the whole
 * point of this path is that a human can now ask. These tests cover what
 * it refuses, what it dispatches, and the one thing it deliberately does
 * not decide for itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { retryLookup } from '../../src/media/retry.ts';
import type { NotifyOutcome } from '../../src/host.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  raw.prepare(`
    INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at)
    VALUES (1, 'tv', 'a feed', 'https://tracker.example/rss', 10, 10)
  `).run();
  return raw;
}

/** An unmatched release, which is the only kind this path acts on. */
function seedRelease(raw: DatabaseSync, id: number, mediaItemId: number | null = null): void {
  raw.prepare(`
    INSERT INTO rss_item (id, feed_id, filename, link, created_at, updated_at, download_type, lookup_state, media_item_id)
    VALUES (?, 1, 'a.mkv', 'https://tracker.example/a.torrent', 10, 10, 'torrent', 'unresolved', ?)
  `).run(id, mediaItemId);
}

function seedMediaItem(raw: DatabaseSync, id: number): void {
  raw.prepare(`
    INSERT INTO media_item (id, plugin_id, title, created_at, updated_at)
    VALUES (?, 'tv', 'A Show', 10, 10)
  `).run(id);
}

/** A `notify` that records what it was asked to identify and owns everything. */
function recordingNotify(): { calls: readonly number[][]; notify: (ids: readonly number[]) => Promise<NotifyOutcome> } {
  const calls: number[][] = [];
  return {
    calls,
    notify: (ids) => {
      calls.push([...ids]);
      return Promise.resolve({ unowned: [], failures: [] });
    },
  };
}

test('an unmatched release is dispatched for identification, by id', async () => {
  const raw = setup();
  seedRelease(raw, 7);
  const { calls, notify } = recordingNotify();

  const outcome = await retryLookup({ raw, notify }, 7);

  assert.deepEqual(outcome, { accepted: true });
  // Spelled literally rather than derived from the seed: the whole job of
  // this function is to hand exactly the asked-for release to the dispatch,
  // and an expectation computed from the same variable could not see it
  // pass the wrong one.
  assert.deepEqual(calls, [[7]], 'exactly that release, and nothing else');
  raw.close();
});

test('a release that does not exist is refused, and nothing is dispatched', async () => {
  const raw = setup();
  const { calls, notify } = recordingNotify();

  assert.deepEqual(await retryLookup({ raw, notify }, 404), { refusal: 'unknown-release' });
  assert.deepEqual(calls, [], 'the dispatch is never reached');
  raw.close();
});

test('a release that already has a media item is refused as already matched', async () => {
  // Not `unknown-release`, and the distinction is what the operator reads:
  // their page is stale, a lookup landed between the render and the click,
  // and the release is fine. Refusing it at all is what stops a retry
  // quietly re-identifying something that already has an answer.
  const raw = setup();
  seedMediaItem(raw, 3);
  seedRelease(raw, 7, 3);
  const { calls, notify } = recordingNotify();

  assert.deepEqual(await retryLookup({ raw, notify }, 7), { refusal: 'already-matched' });
  assert.deepEqual(calls, [], 'a matched release is never re-identified');
  raw.close();
});

test('a release whose feed names no registered plugin is refused, not silently dropped', async () => {
  // `notifyNewRssItems` reports this rather than throwing, and this module
  // does not ask the same question a second time -- it reads the answer.
  // Without this branch the retry would answer `accepted` for a release
  // nothing will ever look at.
  const raw = setup();
  seedRelease(raw, 7);
  const notify = (): Promise<NotifyOutcome> => Promise.resolve({ unowned: [7], failures: [] });

  assert.deepEqual(await retryLookup({ raw, notify }, 7), { refusal: 'plugin-not-registered' });
  raw.close();
});

test('a plugin that throws surfaces as a fault, not as a refusal', async () => {
  // The work did not happen and the cause is a broken plugin, not an
  // operator mistake. Rethrown so it becomes a 500 rather than a 4xx that
  // would tell the operator their request was refused when nothing was
  // decided -- `clients/pick.ts`'s own rule for an error it does not
  // recognise.
  const raw = setup();
  seedRelease(raw, 7);
  const boom = new Error('the plugin could not enqueue');
  const notify = (): Promise<NotifyOutcome> =>
    Promise.resolve({ unowned: [], failures: [{ pluginId: 'tv', error: boom }] });

  await assert.rejects(
    () => retryLookup({ raw, notify }, 7),
    (err: unknown) => err === boom,
    'the plugin’s own error reaches the caller untouched',
  );
  raw.close();
});

test('a release that is unowned and also failed is refused rather than thrown', async () => {
  // Both arms populated at once, which `notifyNewRssItems` reports
  // together on purpose. The refusal is the more specific answer and the
  // one the operator can act on, so it wins -- and this pins the order,
  // which is otherwise whichever `if` a later edit happens to put first.
  const raw = setup();
  seedRelease(raw, 7);
  const notify = (): Promise<NotifyOutcome> => Promise.resolve({
    unowned: [7],
    failures: [{ pluginId: 'tv', error: new Error('unreached') }],
  });

  assert.deepEqual(await retryLookup({ raw, notify }, 7), { refusal: 'plugin-not-registered' });
  raw.close();
});
