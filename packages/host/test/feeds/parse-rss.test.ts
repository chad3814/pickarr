import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRss } from '../../src/feeds/parse-rss.ts';

test('an item yields its guid, filename and link', () => {
  const xml = `
    <rss><channel>
      <item>
        <guid>release-123</guid>
        <title>Show.Name.S01E01.1080p</title>
        <link>http://example.test/download/123</link>
      </item>
    </channel></rss>
  `;

  assert.deepEqual(parseRss(xml), [
    { guid: 'release-123', filename: 'Show.Name.S01E01.1080p', link: 'http://example.test/download/123' },
  ]);
});

test('an item with no guid falls back to its link, because RSS does not require one', () => {
  // Identity must exist for every entry or the dedup index cannot hold.
  const xml = `
    <rss><channel>
      <item>
        <title>Show.Name.S01E02.1080p</title>
        <link>http://example.test/download/124</link>
      </item>
    </channel></rss>
  `;

  const [entry] = parseRss(xml);
  assert.equal(entry?.guid, 'http://example.test/download/124');
  assert.equal(entry?.link, 'http://example.test/download/124');
});

test('a single-item feed parses as one entry, not as a bare object', () => {
  // fast-xml-parser collapses a one-element list into an object unless told
  // otherwise. Left unhandled, a feed with exactly one new item parses as
  // nothing -- and a feed's quiet day is precisely when that happens.
  const xml = `
    <rss><channel>
      <item>
        <guid>solo-1</guid>
        <title>Show.Name.S01E03.1080p</title>
        <link>http://example.test/download/125</link>
      </item>
    </channel></rss>
  `;

  const entries = parseRss(xml);
  assert.equal(Array.isArray(entries), true);
  assert.equal(entries.length, 1);
});

test('CDATA around a title is unwrapped', () => {
  const xml = `
    <rss><channel>
      <item>
        <guid>cdata-1</guid>
        <title><![CDATA[Show.Name.S01E04.CDATA.1080p]]></title>
        <link>http://example.test/download/126</link>
      </item>
    </channel></rss>
  `;

  const [entry] = parseRss(xml);
  assert.equal(entry?.filename, 'Show.Name.S01E04.CDATA.1080p');
});

test('an item missing a link is skipped rather than stored without one', () => {
  // `rss_item.link` is NOT NULL, so an entry with nothing to download is not
  // a row -- and inventing an empty string would make it one.
  const xml = `
    <rss><channel>
      <item>
        <guid>no-link</guid>
        <title>Show.Name.S01E05.1080p</title>
      </item>
      <item>
        <guid>has-link</guid>
        <title>Show.Name.S01E06.1080p</title>
        <link>http://example.test/download/127</link>
      </item>
    </channel></rss>
  `;

  const entries = parseRss(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.guid, 'has-link');
});

test('a feed with no items yields an empty list rather than throwing', () => {
  const xml = `
    <rss><channel>
      <title>Empty Feed</title>
    </channel></rss>
  `;

  assert.doesNotThrow(() => parseRss(xml));
  assert.deepEqual(parseRss(xml), []);
});

test('xml that is not a feed at all yields an empty list', () => {
  // An indexer serving an html error page with status 200 must not look like
  // a feed that went empty.
  const xml = `<html><body><h1>404 Not Found</h1></body></html>`;

  assert.deepEqual(parseRss(xml), []);
});

test('a guid carrying an attribute still yields its text, not the wrapping object', () => {
  // `<guid isPermaLink="false">` is ordinary RSS, and with attributes kept
  // fast-xml-parser renders the tag as `{ '@_isPermaLink': 'false', '#text':
  // 'abc-123' }` rather than a bare string. Read only the attributes and the
  // identity becomes the object -- or, once stringified, the same value for
  // every item in the feed, which would collapse a whole poll to one row.
  const xml = `
    <rss><channel>
      <item>
        <title>Some.Release.2024</title>
        <link>https://example.com/a</link>
        <guid isPermaLink="false">abc-123</guid>
      </item>
    </channel></rss>
  `;

  assert.deepEqual(parseRss(xml), [
    { guid: 'abc-123', filename: 'Some.Release.2024', link: 'https://example.com/a' },
  ]);
});

test('a numeric-looking guid stays a string, so an identity cannot change type', () => {
  // `parseTagValue: false` exists for this. The reader inserts on
  // `(feed_id, guid)`, so a guid arriving as the number 123 one poll and the
  // string '123' the next could insert a second row for an item we already
  // had -- the exact duplicate the unique index is there to prevent.
  const xml = `
    <rss><channel>
      <item>
        <title>Numeric.Guid.Release</title>
        <link>https://example.com/b</link>
        <guid>123</guid>
      </item>
    </channel></rss>
  `;

  const entries = parseRss(xml);
  const first = entries[0];
  assert.ok(first !== undefined, 'expected one entry');
  // `strictEqual`, never `equal`: loose equality holds between 123 and '123',
  // so `assert.equal` here would pass against the very coercion this test
  // exists to forbid.
  assert.strictEqual(first.guid, '123');
});
