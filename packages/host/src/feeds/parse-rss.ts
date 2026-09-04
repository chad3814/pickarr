import { XMLParser } from 'fast-xml-parser';

export interface FeedEntry {
  /** The feed's own identity for this item. Falls back to `link` when absent. */
  guid: string;
  /** The release name. 1.x calls this `title`; a row stores it as `filename`. */
  filename: string;
  link: string;
}

type XmlValue = string | number | boolean | XmlNode | XmlNode[];
interface XmlNode {
  [key: string]: XmlValue | undefined;
}

/**
 * Same options 1.x settled on: attributes kept (so `<guid isPermaLink="...">`
 * carries its attribute alongside its text), tag values left as strings (a
 * numeric-looking guid must not silently become a number), values trimmed.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
});

/** fast-xml-parser collapses a single repeated element to a bare object. */
function asArray(value: XmlValue | undefined): readonly XmlNode[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return [value];
  return [];
}

/** A tag may be a bare string or an object carrying attributes plus #text. */
function textOf(value: XmlValue | undefined): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (value !== undefined && !Array.isArray(value) && typeof value === 'object') {
    const inner = value['#text'];
    if (typeof inner === 'string' && inner.length > 0) return inner;
  }
  return null;
}

function asNode(value: XmlValue | undefined): XmlNode | null {
  if (value !== undefined && !Array.isArray(value) && typeof value === 'object') return value;
  return null;
}

/** `fast-xml-parser`'s own types describe its result only as `any`; narrow the unknown result ourselves rather than trust that. */
function isXmlNode(value: unknown): value is XmlNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A pure function from feed text to entries: no fetching, no database, no
 * clock. Anything that is not a well-formed RSS 2.0 document -- including an
 * indexer's HTML error page served with a 200 status -- yields an empty
 * list rather than throwing, so a caller cannot mistake a parse failure for
 * a feed that genuinely has nothing new.
 */
export function parseRss(xml: string): readonly FeedEntry[] {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }

  if (!isXmlNode(parsed)) return [];

  const rss = asNode(parsed['rss']);
  if (rss === null) return [];

  const channel = asNode(rss['channel']);
  if (channel === null) return [];

  const entries: FeedEntry[] = [];
  for (const item of asArray(channel['item'])) {
    const filename = textOf(item['title']);
    const link = textOf(item['link']);
    if (filename === null || link === null) continue;

    const guid = textOf(item['guid']) ?? link;
    entries.push({ guid, filename, link });
  }

  return entries;
}
