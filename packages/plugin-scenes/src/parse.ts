import type { ParsedRelease, QualityExtra, QualityTokens } from '@pickarr/plugin-api';

const DATE_PATTERN = /(?:^|[.\s_-])((?:19|20)?\d{2})[.\s_-](\d{2})[.\s_-](\d{2})(?:[.\s_-]|$)/;
const XXX_MARKER = /[.\s_-]XXX(?:[.\s_-]|$)/i;
const QUALITY_START = /[.\s_-](?:\d{3,4}p|4K|8K|XXX|WEB-?DL|WEBRip|BluRay|SiteRip|HDTV)(?:[.\s_-]|$)/i;

const RESOLUTIONS: [RegExp, number][] = [
  [/\b8K\b/i, 4320],
  [/\b4K\b|\b2160p\b|\bUHD\b/i, 2160],
  [/\b1440p\b/i, 1440],
  [/\b1080p\b/i, 1080],
  [/\b720p\b/i, 720],
  [/\b540p\b/i, 540],
  [/\b480p\b/i, 480],
];

const SOURCES: [RegExp, string][] = [
  [/\bWEB[.\s_-]?DL\b/i, 'web-dl'],
  [/\bWEBRip\b/i, 'webrip'],
  [/\bSiteRip\b/i, 'siterip'],
  [/\bBluRay\b|\bBDRip\b/i, 'bluray'],
  [/\bHDTV\b/i, 'hdtv'],
  [/\bWEB\b/i, 'web'],
];

const VIDEO_CODECS: [RegExp, string][] = [
  [/\bx265\b/i, 'x265'],
  [/\bH[.\s_-]?265\b|\bHEVC\b/i, 'h265'],
  [/\bx264\b/i, 'x264'],
  [/\bH[.\s_-]?264\b|\bAVC\b/i, 'h264'],
  [/\bAV1\b/i, 'av1'],
  [/\bXviD\b/i, 'xvid'],
];

const CONTAINERS: [RegExp, string][] = [
  [/\bMP4\b/i, 'mp4'],
  [/\bMKV\b/i, 'mkv'],
  [/\bWMV\b/i, 'wmv'],
  [/\bAVI\b/i, 'avi'],
];

function firstMatch<T>(table: [RegExp, T][], haystack: string): T | undefined {
  for (const [pattern, value] of table) {
    if (pattern.test(haystack)) return value;
  }
  return undefined;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function prettify(value: string): string {
  return value.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function toIsoDate(rawYear: string, rawMonth: string, rawDay: string): string | null {
  const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;

  return `${String(year).padStart(4, '0')}-${rawMonth}-${rawDay}`;
}

function extractQuality(tail: string): QualityTokens {
  const extras: Record<string, QualityExtra> = {};
  const container = firstMatch(CONTAINERS, tail);
  if (container !== undefined) extras['container'] = container;

  const groupMatch = /-([A-Za-z0-9]+)$/.exec(tail.trim());

  const quality: QualityTokens = { extras };
  const resolution = firstMatch(RESOLUTIONS, tail);
  if (resolution !== undefined) quality.resolution = resolution;
  const source = firstMatch(SOURCES, tail);
  if (source !== undefined) quality.source = source;
  const videoCodec = firstMatch(VIDEO_CODECS, tail);
  if (videoCodec !== undefined) quality.videoCodec = videoCodec;
  if (groupMatch?.[1] !== undefined) quality.releaseGroup = groupMatch[1];

  return quality;
}

/**
 * Splits a scene release name at the boundary between identity and encode.
 * Everything before the XXX marker is stable across re-releases of the same
 * scene; everything after varies. When there is no XXX marker, the first
 * quality token serves as the boundary.
 */
function splitAtQualityBoundary(name: string): { head: string; tail: string } | null {
  const xxx = XXX_MARKER.exec(name);
  if (xxx !== null && xxx.index > 0) {
    return { head: name.slice(0, xxx.index), tail: name.slice(xxx.index) };
  }

  const quality = QUALITY_START.exec(name);
  if (quality !== null && quality.index > 0) {
    return { head: name.slice(0, quality.index), tail: name.slice(quality.index) };
  }

  return null;
}

export function parseSceneRelease(releaseName: string): ParsedRelease | null {
  const name = releaseName.trim();
  if (name.length === 0) return null;

  const split = splitAtQualityBoundary(name);
  if (split === null) return null;

  const dateMatch = DATE_PATTERN.exec(split.head);
  if (dateMatch?.[1] === undefined || dateMatch[2] === undefined || dateMatch[3] === undefined) {
    return null;
  }

  const date = toIsoDate(dateMatch[1], dateMatch[2], dateMatch[3]);
  if (date === null) return null;

  const site = prettify(split.head.slice(0, dateMatch.index));
  if (site.length === 0) return null;

  const scene = prettify(split.head.slice(dateMatch.index + dateMatch[0].length));
  if (scene.length === 0) return null;

  return {
    identityKey: `${slug(site)}:${date}:${slug(scene)}`,
    display: {
      title: scene,
      subtitle: site,
      date,
      fields: [
        { label: 'Site', value: site },
        { label: 'Date', value: date },
        { label: 'Scene', value: scene },
      ],
    },
    quality: extractQuality(split.tail),
  };
}
