import { XMLParser } from 'fast-xml-parser';

export interface FeedEntry {
  guid: string;
  title: string;
  link: string;
  publishedAt: number | null;
}

type XmlValue = string | number | boolean | XmlNode | XmlNode[];
interface XmlNode {
  [key: string]: XmlValue | undefined;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
});

/** fast-xml-parser collapses a single repeated element to a bare object. */
function asArray(value: XmlValue | undefined): XmlNode[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return [value];
  return [];
}

/** A tag may be a bare string or an object carrying attributes plus #text. */
function textOf(value: XmlValue | undefined): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value !== undefined && !Array.isArray(value) && typeof value === 'object') {
    const inner = value['#text'];
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return null;
}

/** An element with no children (e.g. an empty <channel></channel>) parses to "". */
function asNode(value: XmlValue | undefined): XmlNode {
  if (value !== undefined && !Array.isArray(value) && typeof value === 'object') return value;
  return {};
}

function enclosureUrl(item: XmlNode): string | null {
  const enclosures = asArray(item['enclosure']);
  for (const enclosure of enclosures) {
    const url = enclosure['@_url'];
    if (typeof url === 'string' && url.length > 0) return url;
  }
  return null;
}

export function parseRss(xml: string): FeedEntry[] {
  const document = parser.parse(xml) as XmlNode;
  const rss = document['rss'];
  if (rss === undefined || typeof rss !== 'object' || Array.isArray(rss)) {
    throw new Error('Document is not an RSS 2.0 feed: no <rss> root element');
  }

  const rawChannel = rss['channel'];
  if (rawChannel === undefined) {
    throw new Error('Document is not an RSS 2.0 feed: no <channel> element');
  }
  const channel = asNode(rawChannel);

  const entries: FeedEntry[] = [];
  for (const item of asArray(channel['item'])) {
    const title = textOf(item['title']);
    const link = enclosureUrl(item) ?? textOf(item['link']);
    if (title === null || link === null) continue;

    const guid = textOf(item['guid']) ?? link;
    const pubDate = textOf(item['pubDate']);
    const parsedDate = pubDate === null ? Number.NaN : Date.parse(pubDate);

    entries.push({
      guid,
      title,
      link,
      publishedAt: Number.isNaN(parsedDate) ? null : parsedDate,
    });
  }

  return entries;
}
