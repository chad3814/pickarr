import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { NotifyOutcome } from '../../src/host.ts';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createFeedReader, MAX_CATCHUP_PER_POLL } from '../../src/feeds/reader.ts';

/** A log call captured for assertion, rather than a raw two-argument tuple, so a test can name the field it cares about. */
interface LoggedCall {
  message: string;
  detail: Readonly<Record<string, unknown>> | undefined;
}

function recordingLog(): { log: (message: string, detail?: Readonly<Record<string, unknown>>) => void; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  return { log: (message, detail) => { calls.push({ message, detail }); }, calls };
}

const noopLog = (): void => {};

/**
 * Records every batch of ids handed to `notify`, in call order, and answers
 * with a fixed `NotifyOutcome` (defaulting to "nobody unowned, nothing
 * failed") -- a test that cares about the outcome's shape overrides it.
 */
function recordingNotify(outcome: NotifyOutcome = { unowned: [], failures: [] }): {
  notify: (ids: readonly number[]) => Promise<NotifyOutcome>;
  received: number[][];
} {
  const received: number[][] = [];
  return {
    notify: async (ids) => {
      received.push([...ids]);
      return outcome;
    },
    received,
  };
}

function insertFeed(raw: DatabaseSync, url: string, downloadType = 'torrent'): number {
  const result = raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, download_type, created_at, updated_at)
    VALUES ('alpha', 'feed', ?, ?, 0, 0)
  `).run(url, downloadType);
  return Number(result.lastInsertRowid);
}

interface XmlItem {
  title: string;
  link: string;
  guid?: string;
}

/** A minimal well-formed RSS 2.0 document, built from the fields `parseRss` reads. */
function rssXml(items: readonly XmlItem[]): string {
  const itemsXml = items.map((item) => `
    <item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      ${item.guid !== undefined ? `<guid>${item.guid}</guid>` : ''}
    </item>
  `).join('');
  return `<?xml version="1.0"?><rss><channel>${itemsXml}</channel></rss>`;
}

/**
 * A `fetchText` that answers with each of `xmls` in turn, holding on the last
 * one once exhausted -- so a test that only cares about the first N polls
 * does not have to script a response for every call it makes.
 */
function scriptedFetchText(xmls: readonly string[]): (url: string) => Promise<string> {
  let calls = 0;
  return async () => {
    const index = Math.min(calls, xmls.length - 1);
    calls += 1;
    const xml = xmls[index];
    if (xml === undefined) throw new Error('scriptedFetchText: no xml configured');
    return xml;
  };
}

function setup() {
  const { raw } = openTestDatabase();
  migrateHost(raw);
  return { raw };
}

/**
 * Writes an `rss_item` row directly, undelivered, bypassing `pollFeed`
 * entirely -- the shape a real backlog has, whether left by a feed with no
 * registered plugin or accumulated before `delivered_at` existed at all.
 */
function insertRawItem(raw: DatabaseSync, feedId: number, guid: string): number {
  const result = raw.prepare(`
    INSERT INTO rss_item (feed_id, filename, link, guid, download_type, lookup_state, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'torrent', 'pending', 0, 0)
  `).run(feedId, `${guid}.mkv`, `https://feed.example/${guid}`, guid);
  return Number(result.lastInsertRowid);
}

function rowsFor(raw: DatabaseSync, feedId: number): { id: number; guid: string | null; downloadType: string }[] {
  return raw.prepare('SELECT id, guid, download_type FROM rss_item WHERE feed_id = ? ORDER BY id').all(feedId)
    .map((row) => ({
      id: Number((row as { id: unknown }).id),
      guid: (row as { guid: unknown }).guid === null ? null : String((row as { guid: unknown }).guid),
      downloadType: String((row as { download_type: unknown }).download_type),
    }));
}

test('a first poll inserts every entry and hands all of their ids over', async () => {
  const { raw } = setup();
  const feedId = insertFeed(raw, 'https://feed.example/rss');
  const xml = rssXml([
    { title: 'one.mkv', link: 'https://feed.example/one', guid: 'guid-1' },
    { title: 'two.mkv', link: 'https://feed.example/two', guid: 'guid-2' },
  ]);
  const fetchText = scriptedFetchText([xml]);
  const { notify, received } = recordingNotify();
  const reader = createFeedReader({ raw, fetchText, notify, now: () => 1000, log: noopLog });

  const result = await reader.pollFeed(feedId);

  assert.equal(result.inserted.length, 2, 'both entries are new and must be inserted');
  assert.equal(result.skipped, 0);
  const rows = rowsFor(raw, feedId);
  assert.equal(rows.length, 2, 'exactly the two entries were written');
  assert.deepEqual(
    [...result.inserted].toSorted((a, b) => a - b),
    rows.map((r) => r.id).toSorted((a, b) => a - b),
  );

  assert.equal(received.length, 1, 'notify was called exactly once');
  assert.deepEqual(
    [...(received[0] ?? [])].toSorted((a, b) => a - b),
    rows.map((r) => r.id).toSorted((a, b) => a - b),
  );
});

test('a second poll of an unchanged feed inserts nothing and notifies with an empty list', async () => {
  const { raw } = setup();
  const feedId = insertFeed(raw, 'https://feed.example/rss');
  const xml = rssXml([{ title: 'one.mkv', link: 'https://feed.example/one', guid: 'guid-1' }]);
  const fetchText = scriptedFetchText([xml, xml]);
  const { notify, received } = recordingNotify();
  const reader = createFeedReader({ raw, fetchText, notify, now: () => 1000, log: noopLog });

  await reader.pollFeed(feedId);
  const rowsAfterFirst = rowsFor(raw, feedId);
  assert.equal(rowsAfterFirst.length, 1);

  const second = await reader.pollFeed(feedId);

  // Both halves: no new row, AND the notify call this poll made received [].
  // Asserting only the row count would pass under an implementation that
  // re-notifies ids it did not insert -- the row count alone cannot tell
  // "notified with nothing new" apart from "notified with everything again".
  assert.equal(rowsFor(raw, feedId).length, 1, 'no new rss_item row was created');
  assert.equal(second.inserted.length, 0);
  assert.equal(received.length, 2, 'notify was called on both polls');
  assert.deepEqual(received[1], [], 'the second poll must notify with an empty list, not the whole feed');
});

test('a poll of a feed with one added entry hands over exactly that one id', async () => {
  const { raw } = setup();
  const feedId = insertFeed(raw, 'https://feed.example/rss');
  const firstXml = rssXml([{ title: 'one.mkv', link: 'https://feed.example/one', guid: 'guid-1' }]);
  const secondXml = rssXml([
    { title: 'one.mkv', link: 'https://feed.example/one', guid: 'guid-1' },
    { title: 'two.mkv', link: 'https://feed.example/two', guid: 'guid-2' },
  ]);
  const fetchText = scriptedFetchText([firstXml, secondXml]);
  const { notify, received } = recordingNotify();
  const reader = createFeedReader({ raw, fetchText, notify, now: () => 1000, log: noopLog });

  await reader.pollFeed(feedId);
  const second = await reader.pollFeed(feedId);

  const rows = rowsFor(raw, feedId);
  assert.equal(rows.length, 2, 'the pre-existing entry plus the one new entry');
  const newRow = rows.find((r) => r.guid === 'guid-2');
  assert.ok(newRow, 'the new entry was written');

  assert.equal(second.inserted.length, 1);
  assert.deepEqual([...second.inserted], [newRow.id]);
  assert.equal(second.skipped, 1, 'the unchanged entry was recognised, not re-inserted');

  assert.equal(received.length, 2);
  assert.deepEqual(received[1], [newRow.id], 'the second poll must notify with only the new row, not the whole feed');
});

test('an entry whose guid is absent is identified by its link', async () => {
  const { raw } = setup();
  const feedId = insertFeed(raw, 'https://feed.example/rss');
  const xml = rssXml([{ title: 'one.mkv', link: 'https://feed.example/one' }]);
  const fetchText = scriptedFetchText([xml, xml]);
  const { notify, received } = recordingNotify();
  const reader = createFeedReader({ raw, fetchText, notify, now: () => 1000, log: noopLog });

  const first = await reader.pollFeed(feedId);
  assert.equal(first.inserted.length, 1);

  const rows = rowsFor(raw, feedId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.guid, 'https://feed.example/one', 'the stored guid falls back to the link');

  const second = await reader.pollFeed(feedId);
  assert.equal(second.inserted.length, 0, 'the link-derived guid must be recognised as already present, not re-inserted');
  assert.equal(rowsFor(raw, feedId).length, 1);
  assert.deepEqual(received[1], []);
});

test('a row carries the feed download_type, since an entry does not name one', async () => {
  const { raw } = setup();
  const feedId = insertFeed(raw, 'https://feed.example/rss', 'nzb');
  const xml = rssXml([{ title: 'one.mkv', link: 'https://feed.example/one', guid: 'guid-1' }]);
  const fetchText = scriptedFetchText([xml]);
  const { notify } = recordingNotify();
  const reader = createFeedReader({ raw, fetchText, notify, now: () => 1000, log: noopLog });

  await reader.pollFeed(feedId);

  const rows = rowsFor(raw, feedId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.downloadType, 'nzb', "the row's download_type comes from the feed, not from the entry");
});

test('unowned ids are logged rather than dropped', async () => {
  const { raw } = setup();
  const feedId = insertFeed(raw, 'https://feed.example/rss');
  const xml = rssXml([{ title: 'one.mkv', link: 'https://feed.example/one', guid: 'guid-1' }]);
  const fetchText = scriptedFetchText([xml]);
  const { notify } = recordingNotify({ unowned: [999], failures: [] });
  const { log, calls } = recordingLog();
  const reader = createFeedReader({ raw, fetchText, notify, now: () => 1000, log });

  await reader.pollFeed(feedId);

  const unownedCall = calls.find((c) => c.message.includes('no registered plugin'));
  assert.ok(unownedCall, 'an unowned id must be logged, not silently dropped');
  assert.deepEqual(unownedCall.detail?.['ids'], [999]);
});

test('a plugin failure is logged rather than dropped', async () => {
  const { raw } = setup();
  const feedId = insertFeed(raw, 'https://feed.example/rss');
  const xml = rssXml([{ title: 'one.mkv', link: 'https://feed.example/one', guid: 'guid-1' }]);
  const fetchText = scriptedFetchText([xml]);
  const failure = { pluginId: 'alpha', error: new Error('plugin exploded') };
  const { notify } = recordingNotify({ unowned: [], failures: [failure] });
  const { log, calls } = recordingLog();
  const reader = createFeedReader({ raw, fetchText, notify, now: () => 1000, log });

  await reader.pollFeed(feedId);

  const failureCall = calls.find((c) => c.message.includes('plugin failed'));
  assert.ok(failureCall, 'a plugin failure must be logged, not silently dropped');
  assert.equal(failureCall.detail?.['pluginId'], 'alpha');
  assert.match(String(failureCall.detail?.['error']), /plugin exploded/);
});

test('an id reported unowned stays undelivered and is re-offered once it is no longer unowned', async () => {
  const { raw } = setup();
  const feedId = insertFeed(raw, 'https://feed.example/rss');
  const xml = rssXml([{ title: 'one.mkv', link: 'https://feed.example/one', guid: 'guid-1' }]);
  const fetchText = scriptedFetchText([xml, xml]);
  const received: number[][] = [];
  let calls = 0;
  // First poll: the feed's plugin does not exist yet, so notify reports the
  // whole batch unowned. Second poll: a plugin now owns it.
  const notify = async (ids: readonly number[]) => {
    received.push([...ids]);
    calls += 1;
    return calls === 1 ? { unowned: [...ids], failures: [] } : { unowned: [], failures: [] };
  };
  const reader = createFeedReader({ raw, fetchText, notify, now: () => 1000, log: noopLog });

  const first = await reader.pollFeed(feedId);
  assert.equal(first.inserted.length, 1);
  const itemId = first.inserted[0];
  assert.ok(itemId !== undefined);

  const second = await reader.pollFeed(feedId);

  assert.equal(second.inserted.length, 0, 'the feed has nothing new the second time');
  assert.deepEqual(
    received[1],
    [itemId],
    'an id left undelivered because it was unowned must be re-offered, not silently dropped forever',
  );
});

test('a plugin failure leaves its whole batch undelivered, so every id in it is re-offered next poll', async () => {
  const { raw } = setup();
  const feedId = insertFeed(raw, 'https://feed.example/rss');
  const xml = rssXml([{ title: 'one.mkv', link: 'https://feed.example/one', guid: 'guid-1' }]);
  const fetchText = scriptedFetchText([xml, xml]);
  const received: number[][] = [];
  let calls = 0;
  const notify = async (ids: readonly number[]) => {
    received.push([...ids]);
    calls += 1;
    return calls === 1
      ? { unowned: [], failures: [{ pluginId: 'alpha', error: new Error('boom') }] }
      : { unowned: [], failures: [] };
  };
  const reader = createFeedReader({ raw, fetchText, notify, now: () => 1000, log: noopLog });

  const first = await reader.pollFeed(feedId);
  const itemId = first.inserted[0];
  assert.ok(itemId !== undefined);

  const second = await reader.pollFeed(feedId);

  assert.equal(second.inserted.length, 0);
  assert.deepEqual(
    received[1],
    [itemId],
    'a batch the plugin threw on must not be marked delivered, so it is re-offered rather than lost',
  );
});

test('a large undelivered backlog is capped per poll, oldest ids first, without starving a newly-inserted item', async () => {
  const { raw } = setup();
  const feedId = insertFeed(raw, 'https://feed.example/rss');
  // A backlog bigger than the cap, written directly rather than through a
  // poll: the shape a feed with no owner for a long time actually
  // accumulates.
  const backlogIds: number[] = [];
  for (let i = 0; i < MAX_CATCHUP_PER_POLL + 10; i += 1) {
    backlogIds.push(insertRawItem(raw, feedId, `old-${i}`));
  }
  const xml = rssXml([{ title: 'new.mkv', link: 'https://feed.example/new', guid: 'guid-new' }]);
  const fetchText = scriptedFetchText([xml]);
  const { notify, received } = recordingNotify();
  const reader = createFeedReader({ raw, fetchText, notify, now: () => 1000, log: noopLog });

  const result = await reader.pollFeed(feedId);

  assert.equal(result.inserted.length, 1, 'the one new entry is always inserted');
  const newId = result.inserted[0];
  assert.ok(newId !== undefined);

  assert.equal(received.length, 1);
  const offered = received[0] ?? [];
  assert.equal(
    offered.length,
    MAX_CATCHUP_PER_POLL + 1,
    'the new id plus a catch-up batch capped at MAX_CATCHUP_PER_POLL, not the whole backlog',
  );
  assert.ok(offered.includes(newId), 'the newly-inserted id must always be included, never crowded out by the backlog');

  const offeredBacklog = offered.filter((id) => id !== newId).toSorted((a, b) => a - b);
  const expectedOldest = backlogIds.toSorted((a, b) => a - b).slice(0, MAX_CATCHUP_PER_POLL);
  assert.deepEqual(
    offeredBacklog,
    expectedOldest,
    'the oldest undelivered backlog ids are offered first, not an arbitrary or newest-first slice',
  );
});
