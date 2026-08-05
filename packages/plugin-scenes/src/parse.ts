import type { ParsedRelease, QualityExtra, QualityTokens } from '@pickarr/plugin-api';

const DATE_PATTERN = /(?:^|[.\s_-])((?:19|20)?\d{2})[.\s_-](\d{2})[.\s_-](\d{2})(?:[.\s_-]|$)/;

/** The literal marker token that separates identity from encode information. */
const MARKER_TOKEN = 'XXX';

/**
 * Tokens that can only plausibly be encode information, never title words.
 * These are strong enough on their own to anchor a boundary when no marker
 * token is present.
 */
const RESOLUTION_TOKEN = /^(?:\d{3,4}p(?:\d{2,3})?|4K|8K|UHD)$/i;
const SOURCE_TOKEN =
  /^(?:WEB[-_.]?DL|WEB[-_.]?Rip|SiteRip|Blu[-_.]?Ray|BD[-_.]?Rip|BR[-_.]?Rip|DVD[-_.]?Rip|HD[-_.]?TV)$/i;

/**
 * Tokens that routinely appear in an encode section but are too weak to
 * anchor a boundary by themselves — several of them (`Web`, `HD`, `MP4`) are
 * perfectly ordinary title words in this domain.
 */
const ANCILLARY_TOKEN =
  /^(?:WEB|DL|HD|SD|FHD|QHD|HDR(?:10)?|DV|10bit|8bit|\d{2,3}fps|iNTERNAL|REPACK|PROPER|MULTi|DUAL|x26[45]|H[-_.]?26[45]|HEVC|AVC|AV1|XviD|DivX|VP9|AAC\d?|AC3|EAC3|DDP?\d?|MP3|FLAC|Opus|MP4|MKV|WMV|AVI|MOV|FLV|M4V|\d)$/i;

/**
 * Encode tokens that are conventionally written with an internal separator.
 * The tokenizer splits on every separator, so these are re-joined afterwards;
 * the set is keyed on the separator-free uppercase form.
 */
const HYPHENATED_ENCODE_TOKENS = new Set([
  'WEBDL',
  'WEBRIP',
  'BLURAY',
  'BDRIP',
  'BRRIP',
  'DVDRIP',
  'HDTV',
  'H264',
  'H265',
  'X264',
  'X265',
]);

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
  return value
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s-]+|[\s-]+$/g, '');
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

/**
 * Rewrites a tail's underscores as dots before the quality tables read it.
 *
 * Every table above delimits its tokens with `\b`, and `_` is a *word*
 * character to a JavaScript regex — so there is no word boundary between `_`
 * and an alphanumeric, and `\b1080p\b` simply does not match inside
 * `..._XXX_1080p_MP4-KTR`. The effect was total rather than partial: an
 * underscore-separated name lost its resolution, source, codec and container
 * all at once, scoring as if it carried no quality information, while its
 * dotted twin scored normally. Both spellings collate into the same group by
 * design, so that gap put two wildly different scores on one shelf: a 480p
 * dotted release outranked an underscore 1080p and flagged as an upgrade over
 * it (taking which trashes the better file), and a genuinely better underscore
 * release never flagged at all.
 *
 * Normalizing the haystack once, here, fixes all four tables together —
 * including `SOURCES` and `VIDEO_CODECS`, whose internal `[.\s_-]?` classes
 * already tolerated `WEB_DL` and `H_265` but whose surrounding `\b` anchors
 * did not. The alternative, replacing every `\b` with explicit
 * `(?<![A-Za-z0-9])` / `(?![A-Za-z0-9])` guards, is the same fix written
 * twenty times, and an earlier attempt at this bug fixed the tokenizer alone
 * and left `extractQuality` broken precisely because the change had to be
 * repeated in more than one place to be complete.
 *
 * Only `_` is rewritten: spaces and hyphens are already non-word characters,
 * so `\b` behaves correctly around them, and the release-group tag is matched
 * against the untouched tail below so its introducing `-` is unambiguous.
 */
function normalizeSeparators(tail: string): string {
  return tail.replace(/_/g, '.');
}

function extractQuality(tail: string): QualityTokens {
  const haystack = normalizeSeparators(tail);

  const extras: Record<string, QualityExtra> = {};
  const container = firstMatch(CONTAINERS, haystack);
  if (container !== undefined) extras['container'] = container;

  const groupMatch = /-([A-Za-z0-9]+)$/.exec(tail.trim());

  const quality: QualityTokens = { extras };
  const resolution = firstMatch(RESOLUTIONS, haystack);
  if (resolution !== undefined) quality.resolution = resolution;
  const source = firstMatch(SOURCES, haystack);
  if (source !== undefined) quality.source = source;
  const videoCodec = firstMatch(VIDEO_CODECS, haystack);
  if (videoCodec !== undefined) quality.videoCodec = videoCodec;
  if (groupMatch?.[1] !== undefined) quality.releaseGroup = groupMatch[1];

  return quality;
}

interface Token {
  readonly text: string;
  readonly start: number;
}

function isEncodeToken(text: string): boolean {
  return RESOLUTION_TOKEN.test(text) || SOURCE_TOKEN.test(text) || ANCILLARY_TOKEN.test(text);
}

/** Encode tokens strong enough to mark a boundary without a marker token. */
function isBoundaryAnchor(text: string): boolean {
  return RESOLUTION_TOKEN.test(text) || SOURCE_TOKEN.test(text);
}

/** Splits on every separator, recording each token's offset in `name`. */
function tokenize(name: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[^.\s_-]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(name)) !== null) {
    tokens.push({ text: match[0], start: match.index });
  }
  return tokens;
}

/** Re-joins `WEB-DL`, `H.265`, `Blu-Ray` and friends into single tokens. */
function joinHyphenatedEncodeTokens(tokens: Token[], name: string): Token[] {
  const joined: Token[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    if (current === undefined) continue;
    if (
      next !== undefined &&
      next.start - (current.start + current.text.length) === 1 &&
      HYPHENATED_ENCODE_TOKENS.has((current.text + next.text).toUpperCase())
    ) {
      joined.push({
        text: name.slice(current.start, next.start + next.text.length),
        start: current.start,
      });
      index += 1;
      continue;
    }
    joined.push(current);
  }
  return joined;
}

/**
 * Drops a trailing `-GROUP` tag. The release group is the only part of a
 * scene name attached with a hyphen rather than the name's own separator, so
 * a final token introduced by a lone `-` that is not itself encode
 * information is a group tag — including one literally named `XXX`.
 */
function dropReleaseGroup(tokens: Token[], name: string): Token[] {
  const last = tokens.at(-1);
  const previous = tokens.at(-2);
  if (last === undefined || previous === undefined) return tokens;
  const separator = name.slice(previous.start + previous.text.length, last.start);
  if (separator !== '-' || isEncodeToken(last.text)) return tokens;
  return tokens.slice(0, -1);
}

/**
 * Splits a scene release name at the boundary between identity and encode.
 *
 * The encode section is, structurally, the *trailing run* of the name: every
 * token after the boundary is encode information, and the run ends where the
 * first non-encode token appears reading backwards from the end. That run is
 * unique — there is no candidate to choose between — which is what makes this
 * robust where "first XXX", "last XXX", and "the XXX whose tail looks like an
 * encode" are not. Those rules test a local property of one marker, and an
 * in-title `XXX` can satisfy any local test that the real marker satisfies.
 *
 * From the run, two cases:
 *
 * 1. The token immediately preceding the run is `XXX`. Because `XXX` is never
 *    an encode token, the backward walk cannot pass through a marker, so the
 *    token found there is necessarily the *last* marker in the name — and any
 *    earlier, in-title `XXX` is protected from being chosen by the real marker
 *    standing between it and the run. Equally, a release group named `XXX` has
 *    already been removed as a group tag, so it cannot be mistaken for the
 *    marker. The boundary is exact.
 * 2. No marker sits there (the name omits it, or an unrecognised token
 *    interrupts the encode section). Then fall back to the earliest
 *    *boundary anchor* — a resolution or an explicit source, tokens that are
 *    implausible as title words — that begins an all-encode suffix. Requiring
 *    both properties means a title ending in a weak encode word ("...Of.Web")
 *    is not silently eaten: it stays in the identity if an anchor follows it,
 *    and yields `null` if no anchor exists at all.
 *
 * When neither case applies the name is ambiguous and the caller gets `null`,
 * which surfaces as a parse error rather than a wrong collation.
 */
function splitAtQualityBoundary(name: string): { head: string; tail: string } | null {
  const tokens = dropReleaseGroup(joinHyphenatedEncodeTokens(tokenize(name), name), name);

  let runStart = tokens.length;
  while (runStart > 0 && isEncodeToken(tokens[runStart - 1]?.text ?? '')) runStart -= 1;

  const marker = tokens[runStart - 1];
  if (runStart >= 2 && marker !== undefined && marker.text.toUpperCase() === MARKER_TOKEN) {
    return { head: name.slice(0, marker.start), tail: name.slice(marker.start) };
  }

  for (let index = Math.max(runStart, 1); index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== undefined && isBoundaryAnchor(token.text)) {
      return { head: name.slice(0, token.start), tail: name.slice(token.start) };
    }
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
