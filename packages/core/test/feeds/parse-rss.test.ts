import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRss } from '../../src/feeds/parse-rss.ts';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Test Feed</title>
  <item>
    <title>Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB</title>
    <guid isPermaLink="false">abc123</guid>
    <link>https://indexer.invalid/getnzb/abc123.nzb</link>
    <pubDate>Sat, 15 Apr 2023 12:00:00 +0000</pubDate>
  </item>
  <item>
    <title>Second.Release.XXX.2160p.MP4-GRP</title>
    <guid isPermaLink="false">def456</guid>
    <link>https://indexer.invalid/details/def456</link>
    <enclosure url="https://indexer.invalid/getnzb/def456.nzb" type="application/x-nzb" />
    <pubDate>Sun, 16 Apr 2023 12:00:00 +0000</pubDate>
  </item>
</channel></rss>`;

test('parses items into feed entries', () => {
  const entries = parseRss(FEED);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.guid, 'abc123');
  assert.equal(entries[0]?.title, 'Brazzers.23.04.15.Alex.Coal.XXX.1080p.MP4-WRB');
  assert.equal(entries[0]?.link, 'https://indexer.invalid/getnzb/abc123.nzb');
  assert.equal(entries[0]?.publishedAt, Date.parse('Sat, 15 Apr 2023 12:00:00 +0000'));
});

test('prefers the enclosure url over the link', () => {
  const entries = parseRss(FEED);
  assert.equal(entries[1]?.link, 'https://indexer.invalid/getnzb/def456.nzb');
});

test('falls back to the link when there is no guid', () => {
  const xml = `<rss version="2.0"><channel><item>
    <title>No Guid Here</title><link>https://indexer.invalid/x.nzb</link>
  </item></channel></rss>`;
  assert.equal(parseRss(xml)[0]?.guid, 'https://indexer.invalid/x.nzb');
});

test('a single item is not mistaken for a non-array', () => {
  const xml = `<rss version="2.0"><channel><item>
    <title>Only One</title><guid>solo</guid><link>https://indexer.invalid/1.nzb</link>
  </item></channel></rss>`;
  assert.equal(parseRss(xml).length, 1);
});

test('an empty channel yields no entries', () => {
  assert.deepEqual(parseRss('<rss version="2.0"><channel></channel></rss>'), []);
});

test('a channel containing bare text rather than elements throws', () => {
  assert.throws(
    () => parseRss('<rss version="2.0"><channel>garbage</channel></rss>'),
    /not an RSS/i,
  );
});

test('an unparseable pubDate becomes null rather than NaN', () => {
  const xml = `<rss version="2.0"><channel><item>
    <title>Bad Date</title><guid>g</guid><link>https://indexer.invalid/1.nzb</link>
    <pubDate>not a date</pubDate>
  </item></channel></rss>`;
  assert.equal(parseRss(xml)[0]?.publishedAt, null);
});

test('a non-rss document throws', () => {
  assert.throws(() => parseRss('<html><body>nope</body></html>'), /not an RSS/i);
});

test('items missing a title or link are skipped', () => {
  const xml = `<rss version="2.0"><channel>
    <item><guid>g1</guid><link>https://indexer.invalid/1.nzb</link></item>
    <item><title>Fine</title><guid>g2</guid><link>https://indexer.invalid/2.nzb</link></item>
  </channel></rss>`;
  const entries = parseRss(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.title, 'Fine');
});
