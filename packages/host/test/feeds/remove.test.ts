/**
 * Removing a feed: delete it when it produced nothing, disable it when it
 * did.
 *
 * **Why not simply delete.** `PRAGMA foreign_keys` is ON and
 * `rss_item.feed_id` is `NOT NULL REFERENCES rss_feed (id)`, so a feed that
 * has ever polled cannot be deleted without deleting its items -- and those
 * items own `torrent_download` / `nzb_download` rows, which are the record
 * of files that may be on disk. A feed that produced nothing has none of
 * that, and is the mistyped-URL case worth removing cleanly.
 *
 * So the rule is the one the repo owner chose: **delete if there are no
 * `rss_item`s, disable otherwise.** The caller is told which happened,
 * because "removed" and "stopped polling, history kept" are different
 * things to report to an operator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { disableFeed, enableFeed, removeFeed, type RemoveFeedOutcome } from '../../src/feeds/remove.ts';

function setup(): DatabaseSync {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return raw;
}

function seedFeed(raw: DatabaseSync, id: number, url = `https://tracker.example/${String(id)}`): void {
  raw.prepare(`
    INSERT INTO rss_feed (id, plugin_id, name, url, created_at, updated_at)
    VALUES (?, 'tv', 'a feed', ?, 10, 10)
  `).run(id, url);
}

function seedItem(raw: DatabaseSync, id: number, feedId: number): void {
  raw.prepare(`
    INSERT INTO rss_item (id, feed_id, filename, link, created_at, updated_at, download_type, resolution)
    VALUES (?, ?, 'a.mkv', 'https://tracker.example/a.torrent', 10, 10, 'torrent', 'pending')
  `).run(id, feedId);
}

function feedRow(raw: DatabaseSync, id: number): { disabled_at: unknown } | undefined {
  const row = raw.prepare('SELECT disabled_at FROM rss_feed WHERE id = ?').get(id);
  return row === undefined ? undefined : (row as { disabled_at: unknown });
}

test('a feed that produced nothing is deleted outright', () => {
  const raw = setup();
  seedFeed(raw, 1);

  const outcome: RemoveFeedOutcome = removeFeed({ raw, now: () => 500 }, 1);

  assert.deepEqual(outcome, { outcome: 'deleted' });
  assert.equal(feedRow(raw, 1), undefined, 'the row is gone, not merely marked');
  raw.close();
});

test('a feed that produced releases is disabled, and says how many held it back', () => {
  // The count is in the outcome because an operator who asked to remove
  // something and got "disabled" instead needs to know why, and "3 releases"
  // is the why.
  const raw = setup();
  seedFeed(raw, 1);
  seedItem(raw, 10, 1);
  seedItem(raw, 11, 1);
  seedItem(raw, 12, 1);

  const outcome = removeFeed({ raw, now: () => 500 }, 1);

  assert.deepEqual(outcome, { outcome: 'disabled', items: 3 });
  assert.equal(feedRow(raw, 1)?.disabled_at, 500, 'disabled at the clock the caller passed');
  raw.close();
});

test('only the named feed is touched, counted or disabled', () => {
  // Without this, a `SELECT count(*) FROM rss_item` with no `WHERE` would
  // pass the test above whenever any feed anywhere had items -- and an
  // `UPDATE rss_feed SET disabled_at` with no `WHERE` would pass it too.
  const raw = setup();
  seedFeed(raw, 1);
  seedFeed(raw, 2, 'https://tracker.example/other');
  seedItem(raw, 10, 2);

  assert.deepEqual(removeFeed({ raw, now: () => 500 }, 1), { outcome: 'deleted' },
    'feed 1 has no items of its own, whatever feed 2 has');
  assert.equal(feedRow(raw, 2)?.disabled_at, null, 'and feed 2 is untouched');
  raw.close();
});

test('a feed that is already disabled can be disabled again without changing when', () => {
  // Idempotent on purpose: two clicks, or a retried request, must not make
  // the record say the feed was disabled later than it was.
  const raw = setup();
  seedFeed(raw, 1);
  seedItem(raw, 10, 1);

  removeFeed({ raw, now: () => 500 }, 1);
  const second = removeFeed({ raw, now: () => 900 }, 1);

  assert.deepEqual(second, { outcome: 'disabled', items: 1 });
  assert.equal(feedRow(raw, 1)?.disabled_at, 500, 'the first disabling is when it happened');
  raw.close();
});

test('a feed that does not exist is refused rather than silently succeeding', () => {
  const raw = setup();
  assert.deepEqual(removeFeed({ raw, now: () => 500 }, 404), { refusal: 'unknown-feed' });
  raw.close();
});

test('enabling a disabled feed clears the mark', () => {
  // Disable with no way back would be delete wearing a kinder word, and
  // would leave an operator with a list that only grows.
  const raw = setup();
  seedFeed(raw, 1);
  seedItem(raw, 10, 1);
  removeFeed({ raw, now: () => 500 }, 1);

  assert.deepEqual(enableFeed({ raw, now: () => 900 }, 1), { outcome: 'enabled' });
  assert.equal(feedRow(raw, 1)?.disabled_at, null);
  // `updated_at` moves too, which is not cosmetic: a client learns about
  // this row through the sync log, and the log is driven by the update
  // trigger. Asserted because the docblock claims it.
  const touched = raw.prepare('SELECT updated_at FROM rss_feed WHERE id = ?').get(1);
  assert.ok(touched !== undefined && 'updated_at' in touched && touched.updated_at === 900);
  raw.close();
});

test('enabling a feed that does not exist is refused', () => {
  const raw = setup();
  assert.deepEqual(enableFeed({ raw, now: () => 900 }, 404), { refusal: 'unknown-feed' });
  raw.close();
});

test('a feed with no releases can still be paused rather than removed', () => {
  // `removeFeed` would delete this one, because it has produced nothing.
  // `disableFeed` is the other intention -- "pause it", not "get rid of
  // it" -- and it is the only way to quiet a brand new feed without losing
  // the url that was typed.
  const raw = setup();
  seedFeed(raw, 1);

  assert.deepEqual(disableFeed({ raw, now: () => 500 }, 1), { outcome: 'disabled' });
  assert.equal(feedRow(raw, 1)?.disabled_at, 500, 'still there, just quiet');
  raw.close();
});

test('pausing twice does not move when it was paused', () => {
  const raw = setup();
  seedFeed(raw, 1);
  disableFeed({ raw, now: () => 500 }, 1);
  disableFeed({ raw, now: () => 900 }, 1);
  assert.equal(feedRow(raw, 1)?.disabled_at, 500);
  raw.close();
});
