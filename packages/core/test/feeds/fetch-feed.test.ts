import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFeed } from '../../src/feeds/fetch-feed.ts';
import type { FeedConfig } from '../../src/config/schema.ts';

/**
 * The indexer's own query is already on the URL — an api key and a category, as
 * `config.example.json` shows — so every test here uses a feed whose URL carries
 * parameters. Composing pagination onto a bare URL is the easy case and not the
 * one that breaks.
 */
const FEED: FeedConfig = {
  id: 'indexer',
  url: 'https://indexer.example/rss?t=6000&apikey=secret',
  plugin: '@pickarr/plugin-scenes',
  intervalSeconds: 900,
};

const RSS = `<?xml version="1.0"?>
<rss><channel>
  <item><title>Something.XXX.1080p</title><link>http://x.invalid/1</link><guid>g1</guid></item>
</channel></rss>`;

/** Records every URL asked for, and answers all of them with the same page. */
function recordingFetch(): { urls: string[]; impl: (url: string) => Promise<Response> } {
  const urls: string[] = [];
  return {
    urls,
    impl: async (url: string) => {
      urls.push(url);
      return new Response(RSS, { headers: { 'content-type': 'application/xml' } });
    },
  };
}

function only(urls: readonly string[]): URL {
  assert.equal(urls.length, 1, `expected exactly one request, saw ${String(urls.length)}`);
  return new URL(urls[0] ?? '');
}

test('the live poll asks for the feed URL exactly as configured', async () => {
  // The whole feature has to be invisible to the existing poll. Page zero means
  // "the page the feed serves by default", so it must compose nothing at all —
  // not `offset=0`, which a strict indexer is entitled to treat differently from
  // an absent parameter.
  const spy = recordingFetch();

  await fetchFeed(FEED, { fetchImpl: spy.impl });

  assert.deepEqual(spy.urls, ['https://indexer.example/rss?t=6000&apikey=secret']);
});

test('an explicit page zero is also the URL as configured', async () => {
  const spy = recordingFetch();

  await fetchFeed(FEED, { page: 0, fetchImpl: spy.impl });

  assert.deepEqual(spy.urls, ['https://indexer.example/rss?t=6000&apikey=secret']);
});

test('newznab style pages by offset, keeping the indexer own parameters', async () => {
  const spy = recordingFetch();

  await fetchFeed(FEED, {
    page: 3,
    pagination: { style: 'newznab', pageSize: 50 },
    fetchImpl: spy.impl,
  });

  const url = only(spy.urls);
  // The offset is the page index times the page size, so page 3 of 50 starts at
  // 150 — and `limit` is sent with it, because an indexer whose own default page
  // size differs from `pageSize` would otherwise make the offsets wrong.
  assert.equal(url.searchParams.get('offset'), '150');
  assert.equal(url.searchParams.get('limit'), '50');
  // Composed onto the existing query rather than replacing it. Concatenating a
  // second `?` is how an api key stops being sent.
  assert.equal(url.searchParams.get('t'), '6000');
  assert.equal(url.searchParams.get('apikey'), 'secret');
});

test('page style is one-based, because a page parameter of zero is not page one', async () => {
  // The stored position is a zero-based index for both styles (one column, one
  // meaning), so this conversion is the only place the difference lives.
  const spy = recordingFetch();

  await fetchFeed(FEED, {
    page: 1,
    pagination: { style: 'page', pageSize: 100 },
    fetchImpl: spy.impl,
  });

  const url = only(spy.urls);
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('offset'), null);
  assert.equal(url.searchParams.get('apikey'), 'secret');
});

test('a page parameter already on the feed URL is overwritten, not duplicated', async () => {
  // A user who pinned `?page=1` by hand and then turned backfill on would
  // otherwise send two, and which one an indexer honours is anyone's guess.
  const spy = recordingFetch();

  await fetchFeed(
    { ...FEED, url: 'https://indexer.example/rss?page=1&apikey=secret' },
    { page: 4, pagination: { style: 'page', pageSize: 100 }, fetchImpl: spy.impl },
  );

  const url = only(spy.urls);
  assert.deepEqual(url.searchParams.getAll('page'), ['5']);
});

test('a non-2xx page names the feed and the status', async () => {
  const failing = async () => new Response('nope', { status: 503 });

  await assert.rejects(() => fetchFeed(FEED, { fetchImpl: failing }), /indexer.*503/);
});

test('the parsed entries are what comes back', async () => {
  const spy = recordingFetch();

  const entries = await fetchFeed(FEED, { fetchImpl: spy.impl });

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.guid, 'g1');
});
