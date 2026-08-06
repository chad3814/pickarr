import type { ParsedRelease, QualityExtra, QualityTokens } from '@pickarr/plugin-api';

/**
 * # The boundary rule
 *
 * A scene release name is three fields glued together with an arbitrary
 * separator: the site/studio, the release date, and the scene (title and/or
 * performers), followed by encode information. Deciding *where the fields
 * meet* is the whole job, because `identityKey` is built from the first three
 * and two different scenes sharing a key is the one failure this component
 * must never produce.
 *
 * Every field except one is drawn from an open or overlapping vocabulary. A
 * studio can be called `Tushy`; so can a title. Encode words come from a
 * closed vocabulary, but that vocabulary overlaps titles freely — `XXX`,
 * `MP4`, `4K` and `Web` are all real title words in this domain, and `XXX` is
 * also a real release-group name. Any rule that locates the boundary by
 * recognising a *word* therefore has as many candidate boundaries as that word
 * has occurrences, and no local test can tell the real one from an impostor:
 * whatever property the true marker has, an in-title occurrence can have too.
 * Three successive attempts to patch the `XXX`-marker rule failed for exactly
 * that reason.
 *
 * The date is different in kind. It is recognised by *arithmetic*, not by
 * lookup: a run of digits that forms a valid calendar date. No title word can
 * impersonate it, no vocabulary drift can invalidate it, and it is effectively
 * always present. So the date is the anchor:
 *
 *   - Everything before the date is the site. This needs no vocabulary
 *     judgement at all, which is what makes the site half of the identity
 *     exact.
 *   - Everything after the date is the scene plus its encode suffix.
 *
 * That reduces the problem to one boundary inside a bounded region, and it
 * confines the search: the encode scan can never run backwards past the date
 * into the site, so a studio named `4K Media` or `WebYoung` can no longer be
 * eaten by an encode rule, and a mistake in the encode boundary can no longer
 * relocate the site.
 *
 * # Inside the post-date region
 *
 * The encode section is structurally a *suffix*: every token after the
 * boundary is encode information. A suffix has exactly one start, so there is
 * no candidate to choose between — that is why the trailing-run walk is robust
 * where "first/last/best `XXX`" is not. Walking backwards from the end over
 * encode-vocabulary tokens gives the run; the cut is then placed either
 *
 *   1. at the `XXX` marker, when one sits immediately before the run. `XXX` is
 *      never an encode token, so the backward walk cannot pass through a
 *      marker; the one found there is necessarily the *last* marker in the
 *      name, and any in-title `XXX` is shielded by it. A group literally named
 *      `XXX` has already been detached as a group tag, so it cannot be
 *      mistaken for the marker either.
 *   2. otherwise at the earliest *boundary anchor* — a resolution or explicit
 *      source, tokens that are implausible as title words — inside the run.
 *      Cutting at the anchor rather than at the start of the run is what keeps
 *      `Girls Of Web` and `Episode 2 4K` intact: the weak encode words `Web`
 *      and `2` stay in the title because no anchor precedes them.
 *
 * If neither applies the name is ambiguous and the caller gets `null`, which
 * surfaces as a visible `parse_error` rather than a silent mis-collation.
 *
 * # Why this is correct in general
 *
 * The identity is `slug(pre-date text) : ISO date : slug(post-date text minus
 * an encode suffix)`. Two names collide only if all three agree. The first two
 * are exact — no vocabulary is consulted for the site, and the date is
 * self-verifying. So a collision requires two post-date regions that differ
 * *only* inside a suffix that (a) reaches the end of the name, (b) consists
 * entirely of closed-vocabulary encode tokens, and (c) is introduced by the
 * `XXX` marker or by a resolution/source anchor. "Differs only in trailing
 * encode tokens" is the definition of "two encodes of one release" — so the
 * rule collapses exactly the set it is supposed to collapse. The residual
 * risk is a scene whose genuine title *ends* in an anchor-introduced run of
 * encode words; the parser refuses whenever that run is interrupted rather
 * than guessing, which is why names like `Site.23.04.15.The.1080p.Club.MP4-G`
 * return `null`.
 */

/** The literal marker token that separates identity from encode information. */
const MARKER_TOKEN = 'XXX';

/**
 * Tokens that can only plausibly be encode information, never title words.
 * These are strong enough on their own to anchor a boundary.
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
  /^(?:WEB|DL|HD|SD|FHD|QHD|HDR(?:10)?|DV|10bit|8bit|\d{2,3}fps|iNTERNAL|REPACK|PROPER|MULTi|DUAL|x26[45]|H[-_.]?26[45]|HEVC|AVC|AV1|XviD|DivX|VP9|AAC\d?|AC3|EAC3|DDP?\d?|MP3|FLAC|Opus|MP4|MKV|WMV|AVI|MOV|FLV|M4V|VR|3D|SBS|TB|LR|OU|MONO|MKX200|MKX220|FISHEYE190|FISHEYE|OCULUS|GEARVR|PSVR|SMARTPHONE|\d)$/i;

/** Immersive/VR layout tags, recorded as a quality extra when present. */
const VR_TOKEN = /\b(?:VR|MKX200|MKX220|FISHEYE190|OCULUS|GEARVR|PSVR|SMARTPHONE)\b/i;

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

/**
 * Short uppercase words that are *not* release groups even though they have a
 * group's shape. Languages, edit tags and distribution notes all trail an
 * encode section the way a group does; treating one as a group would silently
 * merge two genuinely different cuts of a scene.
 */
const NON_GROUP_TERMS = new Set([
  'ENGLISH',
  'FRENCH',
  'GERMAN',
  'SPANISH',
  'ITALIAN',
  'RUSSIAN',
  'ENG',
  'FRA',
  'GER',
  'ESP',
  'ITA',
  'RUS',
  'JAP',
  'JPN',
  'SUB',
  'SUBS',
  'SUBBED',
  'DUBBED',
  'UNCUT',
  'UNRATED',
  'EXTENDED',
  'DIRECTORS',
  'REMASTERED',
  'REMUX',
  'PART',
  'PT',
  'CD',
  'DISC',
  'SCENE',
  'FULL',
  'HQ',
  'LQ',
]);

/** File extensions a downloader or indexer may have appended to a name. */
const MEDIA_EXTENSIONS = new Set([
  'mp4',
  'mkv',
  'avi',
  'wmv',
  'mov',
  'm4v',
  'mpg',
  'mpeg',
  'flv',
  'ts',
  'webm',
  'nfo',
]);

const TLD =
  '(?:com|net|org|xxx|tv|to|cc|me|io|co|se|ws|pw|biz|info|site|club|app|online|link|is|nl|de|fr|ru|us|uk|su)';
/**
 * The label repetition is *lazy* on purpose. `xxx` is a real TLD and also the
 * marker token, so a greedy domain will happily swallow
 * `www.Site.com.Brazzers.23.04.15.Alex.Coal.XXX.` and call it a prefix.
 * Preferring the shortest domain that still ends in a TLD stops the prefix at
 * the first plausible boundary, which is where a real one ends.
 */
const HOST = `[A-Za-z0-9][A-Za-z0-9-]*(?:\\.[A-Za-z0-9-]+)*?\\.${TLD}`;

/**
 * A domain carrying an explicit *prefix marker* — `www.` or a URL scheme.
 *
 * A bare domain is not enough, because a great many studios are named after
 * their domain: `Bang.com`, `Deeper.com`, `Nubiles.net`, `Private.com`. In the
 * delimited listing form those are indistinguishable from a website prefix —
 * both are "a domain, then ` - `" — and stripping one promotes the *performer*
 * to the site slot, which collapses every such studio onto one key and files
 * their scenes under the performer's name. `www.` and `http://` are markers no
 * studio puts in its own name, so requiring one restores the distinction. A
 * studio allowlist would not: it fails for every studio nobody thought of.
 */
const MARKED_DOMAIN = `(?:https?://(?:www\\.)?|www\\.)${HOST}(?:/\\S*)?`;

/**
 * Leading website prefixes. The label repetition inside `HOST` is *lazy* on
 * purpose: `xxx` is a real TLD and also the marker token, so a greedy domain
 * will happily swallow `www.Site.com.Brazzers.23.04.15.Alex.Coal.XXX.` and
 * call it a prefix. Preferring the shortest host that still ends in a TLD
 * stops the prefix where a real one ends.
 */
const WEBSITE_PREFIXES = [
  new RegExp(`^[[(]\\s*${MARKED_DOMAIN}\\s*[\\])]\\s*[-–—]?\\s*`, 'i'),
  new RegExp(`^${MARKED_DOMAIN}[\\s._-]+`, 'i'),
];

/**
 * A bracketed *bare* domain. Only safe to strip when the name is not a
 * delimited listing, because there a leading bracket is the studio field
 * itself (`[Vixen] ...`) and `[Bang.com] - Alex Coal - ...` means the studio,
 * not a tracker stamp.
 */
const BRACKETED_BARE_DOMAIN = new RegExp(`^[[(]\\s*${HOST}\\s*[\\])]\\s*[-–—]?\\s*`, 'i');

/** Splits the delimited listing form into its fields. */
const SEGMENT_SPLIT = /\s+[-–—]\s+/;

/**
 * A date written with the dotted form's own separators. Its presence means the
 * name is a dotted scene release even if a tracker stamp or a stray ` - ` also
 * makes it look delimited, so the delimited recogniser declines on it. Dates
 * delimited by ` - ` or `-` (`2023-07-22`, `19-07-2023`) deliberately do not
 * match: those are the listing form's own spelling.
 */
const DOTTED_DATE_RUN = /(?:^|[._])(?:(?:19|20)?\d{2}[._]\d{2}[._]\d{2}|\d{6}|\d{8})(?:[._]|$)/;

/**
 * The optional trailing digits absorb a frame-rate suffix: `2160p60` is a
 * 2160p encode, and without this it matched nothing and scored as resolution
 * zero — ranking below a 480p inside its own group, which is the same
 * upgrade-inversion the underscore bug caused.
 */
const FPS = '(?:\\d{2,3})?';
const RESOLUTIONS: [RegExp, number][] = [
  [/\b8K\b/i, 4320],
  [new RegExp(`\\b4K\\b|\\b2160p${FPS}\\b|\\bUHD\\b`, 'i'), 2160],
  [new RegExp(`\\b1440p${FPS}\\b`, 'i'), 1440],
  [new RegExp(`\\b1080p${FPS}\\b`, 'i'), 1080],
  [new RegExp(`\\b720p${FPS}\\b`, 'i'), 720],
  [new RegExp(`\\b540p${FPS}\\b`, 'i'), 540],
  [new RegExp(`\\b480p${FPS}\\b`, 'i'), 480],
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

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function firstMatch<T>(table: [RegExp, T][], haystack: string): T | undefined {
  for (const [pattern, value] of table) {
    if (pattern.test(haystack)) return value;
  }
  return undefined;
}

/**
 * Emits only `[a-z0-9-]`. Destinations are rendered back out of the slugs in
 * `identityKey`, and that round trip is only injective while the alphabet
 * stays this small — so this must not be widened. `planSceneImport` also
 * splits `identityKey` on `:`, which a slug can therefore never contain.
 */
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

function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1900 || year > 2199) return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Expands a bare two-digit year into the 2000s, as scene naming intends. */
function expandYear(raw: string): number {
  return raw.length === 2 ? 2000 + Number(raw) : Number(raw);
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

/** Splits on every separator, recording each token's offset in `text`. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[^.\s_-]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index });
  }
  return tokens;
}

/** Re-joins `WEB-DL`, `H.265`, `Blu-Ray` and friends into single tokens. */
function joinHyphenatedEncodeTokens(tokens: Token[], text: string): Token[] {
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
        text: text.slice(current.start, next.start + next.text.length),
        start: current.start,
      });
      index += 1;
      continue;
    }
    joined.push(current);
  }
  return joined;
}

function tokensOf(text: string): Token[] {
  return joinHyphenatedEncodeTokens(tokenize(text), text);
}

/**
 * A trailing token has a release group's *shape* when it is short, purely
 * alphanumeric, carries a letter, is written in caps (the universal scene
 * convention for a group tag), and is not a codec/source/container/language
 * or edit term.
 *
 * Both of the last two tests are load-bearing, and neither subsumes the other:
 * `NON_GROUP_TERMS` is what stops `-UNCUT` and `-Part2`, which are correctly
 * capitalised, and the caps test is what stops `-Bonus` and `-Directors`,
 * which are not in any list anyone can finish writing. Together they mean a
 * trailing edit or part tag is refused rather than swallowed as a group —
 * swallowing it merges two different cuts of a scene, which is exactly the
 * over-collation this component may not commit, and refusing is always the
 * cheaper mistake. The digits are stripped before the lookup so that `Part1`
 * and `Part2` are both recognised as `PART` while a numbered group like `GRP1`
 * still reduces to the unlisted `GRP`.
 *
 * `minLength` is 1 for a hyphen-attached tag, where the hyphen itself is
 * already strong evidence (single-letter groups like `-G` are common), and 2
 * for a dot-attached one, where the separator carries no information.
 */
function looksLikeGroupTag(text: string, minLength: number): boolean {
  if (text.length < minLength || text.length > 8) return false;
  if (!/^[A-Za-z0-9]+$/.test(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (text !== text.toUpperCase()) return false;
  const upper = text.toUpperCase();
  if (NON_GROUP_TERMS.has(upper) || NON_GROUP_TERMS.has(upper.replace(/\d+$/, ''))) return false;
  return !isEncodeToken(text);
}

interface Detached {
  readonly tokens: Token[];
  readonly group: string | undefined;
}

/**
 * Detaches a trailing release-group tag.
 *
 * A group is attached either with a hyphen — the only part of a scene name
 * introduced by a separator other than the name's own — or, in some trackers'
 * output, with the name's own separator. The dot-attached form additionally
 * requires the preceding token to be encode information, because a group can
 * only ever follow a complete encode section; a token following title material
 * is title material.
 *
 * *Both* forms go through `looksLikeGroupTag`. A hyphen is strong evidence but
 * it is not proof: `...MP4-Part1` and `...MP4-Part2` are two halves of one
 * scene, and detaching `Part1`/`Part2` as groups merges them under a single
 * key. The guards are what separate a group tag from an edit or part tag, and
 * they have to apply wherever a tag is detached, not only on the branch they
 * were first written for.
 */
function detachReleaseGroup(tokens: Token[], text: string): Detached {
  const last = tokens.at(-1);
  const previous = tokens.at(-2);
  if (last === undefined || previous === undefined) return { tokens, group: undefined };

  const separator = text.slice(previous.start + previous.text.length, last.start);
  if (separator === '-') {
    if (!looksLikeGroupTag(last.text, 1)) return { tokens, group: undefined };
    return { tokens: tokens.slice(0, -1), group: last.text };
  }
  if (
    /^[._\s]$/.test(separator) &&
    isEncodeToken(previous.text) &&
    looksLikeGroupTag(last.text, 2)
  ) {
    return { tokens: tokens.slice(0, -1), group: last.text };
  }
  return { tokens, group: undefined };
}

/**
 * Locates the start of the trailing encode suffix, or `null` when the tokens
 * carry no recognisable encode section. `minIndex` is the first index the cut
 * may fall on, so callers that must retain at least one identity token pass
 * `1` and callers happy to consume the whole run pass `0`.
 */
function findEncodeSuffixStart(tokens: Token[], minIndex: number): number | null {
  let runStart = tokens.length;
  while (runStart > minIndex && isEncodeToken(tokens[runStart - 1]?.text ?? '')) runStart -= 1;

  const marker = tokens[runStart - 1];
  if (runStart - 1 >= minIndex && marker !== undefined && marker.text.toUpperCase() === MARKER_TOKEN) {
    return runStart - 1;
  }

  for (let index = Math.max(runStart, minIndex); index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token !== undefined && isBoundaryAnchor(token.text)) return index;
  }

  return null;
}

/**
 * Rewrites underscores as dots before the quality tables read a haystack.
 *
 * Every table below delimits its tokens with `\b`, and `_` is a *word*
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
 * did not. The release group is no longer recovered by a regex over this
 * string at all; it is detached structurally from the token stream, which is
 * separator-blind by construction.
 */
function normalizeSeparators(text: string): string {
  return text.replace(/_/g, '.');
}

function extractQuality(tail: string, releaseGroup: string | undefined): QualityTokens {
  const haystack = normalizeSeparators(tail);

  const extras: Record<string, QualityExtra> = {};
  const container = firstMatch(CONTAINERS, haystack);
  if (container !== undefined) extras['container'] = container;
  if (VR_TOKEN.test(haystack)) extras['vr'] = true;

  const quality: QualityTokens = { extras };
  const resolution = firstMatch(RESOLUTIONS, haystack);
  if (resolution !== undefined) quality.resolution = resolution;
  const source = firstMatch(SOURCES, haystack);
  if (source !== undefined) quality.source = source;
  const videoCodec = firstMatch(VIDEO_CODECS, haystack);
  if (videoCodec !== undefined) quality.videoCodec = videoCodec;
  if (releaseGroup !== undefined) quality.releaseGroup = releaseGroup;

  return quality;
}

// --- Preprocessing ----------------------------------------------------------

function stripWebsitePrefix(name: string): string {
  for (const pattern of WEBSITE_PREFIXES) {
    const stripped = name.replace(pattern, '');
    if (stripped.length > 0 && stripped !== name) return stripped.trim();
  }
  // A bracketed bare domain is a tracker stamp only when the name is not a
  // delimited listing; in a listing the leading bracket is the studio field.
  if (!SEGMENT_SPLIT.test(name)) {
    const stripped = name.replace(BRACKETED_BARE_DOMAIN, '');
    if (stripped.length > 0 && stripped !== name) return stripped.trim();
  }
  return name;
}

/**
 * Drops a media file extension an indexer appended to the release name.
 *
 * An extension is by definition appended *after* a complete release name, so
 * what precedes it is that name's last element: the group tag or the encode
 * section. When the preceding token is neither — as in
 * `Site.23.04.15.Alex.Coal.XXX.WMV` — the trailing token is the container the
 * release name itself states, not an appended extension, and removing it
 * would throw away the only quality information present.
 */
function stripFileExtension(name: string): string {
  const match = /\.([A-Za-z0-9]{2,4})$/.exec(name);
  if (match?.[1] === undefined) return name;
  if (!MEDIA_EXTENSIONS.has(match[1].toLowerCase())) return name;

  const head = name.slice(0, match.index);
  const tokens = tokenize(head);
  const last = tokens.at(-1);
  const previous = tokens.at(-2);
  if (last === undefined) return name;

  const attachedGroup =
    previous !== undefined && head.slice(previous.start + previous.text.length, last.start) === '-';
  if (attachedGroup || isEncodeToken(last.text)) return head;
  return name;
}

// --- Result construction ----------------------------------------------------

function buildRelease(
  site: string,
  date: string,
  sceneTitle: string,
  sceneSlug: string,
  quality: QualityTokens,
): ParsedRelease | null {
  const siteSlug = slug(site);
  if (siteSlug.length === 0 || sceneSlug.length === 0) return null;

  return {
    identityKey: `${siteSlug}:${date}:${sceneSlug}`,
    display: {
      title: sceneTitle,
      subtitle: site,
      date,
      fields: [
        { label: 'Site', value: site },
        { label: 'Date', value: date },
        { label: 'Scene', value: sceneTitle },
      ],
    },
    quality,
  };
}

// --- Shape 1: the dotted scene form -----------------------------------------

interface DateSpan {
  readonly iso: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Finds the release date in a token stream, scanning left to right and taking
 * the first run of digits that forms a *valid* calendar date. Three shapes
 * occur: `YY.MM.DD`, `YYYY.MM.DD`, and the concatenated `YYMMDD` / `YYYYMMDD`.
 * Index 0 is skipped because a date there would leave no site.
 */
function findSceneDate(tokens: Token[]): DateSpan | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    const text = token.text;
    const end = token.start + text.length;

    if (/^\d{8}$/.test(text)) {
      const iso = toIsoDate(Number(text.slice(0, 4)), Number(text.slice(4, 6)), Number(text.slice(6, 8)));
      if (iso !== null) return { iso, startOffset: token.start, endOffset: end };
    }
    if (/^\d{6}$/.test(text)) {
      const iso = toIsoDate(
        expandYear(text.slice(0, 2)),
        Number(text.slice(2, 4)),
        Number(text.slice(4, 6)),
      );
      if (iso !== null) return { iso, startOffset: token.start, endOffset: end };
    }

    const month = tokens[index + 1];
    const day = tokens[index + 2];
    if (
      month !== undefined &&
      day !== undefined &&
      /^(?:19|20)?\d{2}$/.test(text) &&
      /^\d{2}$/.test(month.text) &&
      /^\d{2}$/.test(day.text)
    ) {
      const iso = toIsoDate(expandYear(text), Number(month.text), Number(day.text));
      if (iso !== null) {
        return { iso, startOffset: token.start, endOffset: day.start + day.text.length };
      }
    }
  }
  return null;
}

function parseSceneForm(name: string): ParsedRelease | null {
  const date = findSceneDate(tokensOf(name));
  if (date === null) return null;

  const site = prettify(name.slice(0, date.startOffset));
  const rest = name.slice(date.endOffset).replace(/^[.\s_-]+/, '');
  if (site.length === 0 || rest.length === 0) return null;

  const detached = detachReleaseGroup(tokensOf(rest), rest);
  const cut = findEncodeSuffixStart(detached.tokens, 1);
  if (cut === null) return null;

  const cutToken = detached.tokens[cut];
  if (cutToken === undefined) return null;

  const sceneText = prettify(rest.slice(0, cutToken.start));
  if (sceneText.length === 0) return null;
  // A "title" made only of the marker carries no discriminating content, so
  // two unrelated scenes on one site and day would collide on it.
  if (sceneText.toUpperCase() === MARKER_TOKEN) return null;

  const tail = rest.slice(cutToken.start);
  return buildRelease(site, date.iso, sceneText, slug(sceneText), extractQuality(tail, detached.group));
}

// --- Shape 2: the delimited metadata form -----------------------------------

const YMD_PATTERN = /\b((?:19|20)\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})\b/;
const DMY_PATTERN = /\b(\d{1,2})[.\-/](\d{1,2})[.\-/]((?:19|20)\d{2})\b/;
const WRITTEN_PATTERN = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b/g;

interface SegmentDate {
  readonly iso: string;
  readonly before: string;
  readonly after: string;
}

/**
 * Finds a fully-written date inside one delimited segment. ISO order is tried
 * first because it is unambiguous; the remaining numeric form is read
 * day-first, the convention these listings follow. A day/month transposition
 * can only ever *split* a group (the same scene filed under two dates), never
 * merge two scenes, so guessing here is on the safe side of the asymmetry.
 */
function findSegmentDate(segment: string): SegmentDate | null {
  const iso = YMD_PATTERN.exec(segment);
  if (iso?.[1] !== undefined && iso[2] !== undefined && iso[3] !== undefined) {
    const value = toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (value !== null) return splitAround(segment, iso.index, iso[0].length, value);
  }

  const dmy = DMY_PATTERN.exec(segment);
  if (dmy?.[1] !== undefined && dmy[2] !== undefined && dmy[3] !== undefined) {
    const value = toIsoDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
    if (value !== null) return splitAround(segment, dmy.index, dmy[0].length, value);
  }

  WRITTEN_PATTERN.lastIndex = 0;
  let written: RegExpExecArray | null;
  while ((written = WRITTEN_PATTERN.exec(segment)) !== null) {
    const monthName = written[1]?.toLowerCase();
    if (monthName === undefined || written[2] === undefined || written[3] === undefined) continue;
    const month = MONTH_NAMES[monthName];
    if (month === undefined) continue;
    const value = toIsoDate(Number(written[3]), month, Number(written[2]));
    if (value !== null) return splitAround(segment, written.index, written[0].length, value);
  }

  return null;
}

/** Removes the matched date and the brackets that were wrapping it. */
function splitAround(segment: string, index: number, length: number, iso: string): SegmentDate {
  const before = segment.slice(0, index).replace(/[([{]\s*$/, '');
  const after = segment.slice(index + length).replace(/^\s*[)\]}]/, '');
  return { iso, before: before.trim(), after: after.trim() };
}

interface SegmentSplit {
  readonly title: string;
  readonly quality: string;
  readonly group: string | undefined;
}

/**
 * Separates one segment's title text from the quality material trailing it,
 * using the same suffix rule as the dotted form plus the bracketed groups
 * these listings append (`[1080p HEVC x265]`, `{GROUP}`).
 */
function splitSegment(segment: string): SegmentSplit {
  let text = segment.trim();
  const quality: string[] = [];
  let group: string | undefined;

  for (;;) {
    const bracket = /\s*[[{]([^\]}]*)[\]}]\s*$/.exec(text);
    if (bracket?.[1] === undefined) break;
    const content = bracket[1].trim();
    if (group === undefined && looksLikeGroupTag(content, 2)) group = content;
    else quality.unshift(content);
    text = text.slice(0, bracket.index).trim();
  }

  const tokens = tokensOf(text);
  const cut = findEncodeSuffixStart(tokens, 0);
  const cutToken = cut === null ? undefined : tokens[cut];
  if (cutToken !== undefined) {
    quality.unshift(text.slice(cutToken.start));
    text = text.slice(0, cutToken.start);
  }

  return { title: prettify(text), quality: quality.join(' '), group };
}

function parseDelimitedForm(name: string): ParsedRelease | null {
  let rest = name;
  let site: string | null = null;

  const bracketed = /^\s*[[(]([^\])]+)[\])]\s*/.exec(rest);
  if (bracketed?.[1] !== undefined) {
    site = bracketed[1].trim();
    rest = rest.slice(bracketed[0].length);
  }

  // Positive shape test. A leading bracket or a stray " - " is not enough to
  // make a name a listing: `[Tracker] Brazzers.2023.04.15.Alex.Coal.XXX.1080p
  // .MP4-WRB` is a dotted release with a tracker stamp, and reading it as a
  // listing throws away its entire encode section — which flattens every
  // encode in the group to one score and kills upgrade detection. Declining on
  // a dotted date run is a test of *this* shape rather than a reordering of
  // the two recognisers: the listing form's own date spellings (`2023-07-22`,
  // `19-07-2023`, `19.07.2023`, `(June 24, 2025)`) do not match it, so
  // preferring the dotted parser outright would instead let it eat listings.
  if (DOTTED_DATE_RUN.test(rest)) return null;

  const segments = rest
    .split(SEGMENT_SPLIT)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  // Not this shape: no bracketed studio and nothing delimited by " - ".
  if (site === null && segments.length < 2) return null;
  if (segments.length === 0) return null;

  let dateIso: string | null = null;
  const residues: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    if (dateIso === null) {
      const found = findSegmentDate(segment);
      if (found !== null) {
        dateIso = found.iso;
        // A leading segment that is *only* a date cannot also be the studio.
        if (index === 0 && site === null && found.before.length === 0) return null;
        const residue = [found.before, found.after].filter((part) => part.length > 0).join(' ');
        residues.push(residue);
        continue;
      }
    }
    residues.push(segment);
  }
  if (dateIso === null) return null;

  let startIndex = 0;
  if (site === null) {
    const first = residues[0];
    if (first === undefined || first.length === 0) return null;
    site = first;
    startIndex = 1;
  }

  const titleParts: string[] = [];
  const qualityParts: string[] = [];
  let group: string | undefined;
  for (let index = startIndex; index < residues.length; index += 1) {
    const residue = residues[index];
    if (residue === undefined || residue.length === 0) continue;
    const split = splitSegment(residue);
    if (split.title.length > 0) titleParts.push(split.title);
    if (split.quality.length > 0) qualityParts.push(split.quality);
    if (group === undefined) group = split.group;
  }
  if (titleParts.length === 0) return null;

  // The identity slug is built from the *sorted* part slugs while the display
  // title keeps source order, because these listings put performers and title
  // on either side of each other depending on the tracker.
  //
  // The join is `--`, and that is load-bearing rather than cosmetic. Sorting
  // is only safe if the join is injective on the multiset of parts, and
  // joining with a single `-` is not: `slug()` emits `-` too, so the part
  // boundaries dissolve and any re-split that happens to preserve alphabetical
  // order collides — `Kylie` + `Page Turner` and `Kylie Page` + `Turner` both
  // render `kylie-page-turner`, and those are different scenes. `slug()`
  // collapses runs of non-alphanumerics to a single `-` and strips the edges,
  // so `--` cannot occur inside a part; empty parts are filtered out above.
  // The join is therefore a delimiter that no part can contain, the split is
  // unique, and *now* the multiset determines the string and vice versa.
  // `titleCaseSlug` drops empty segments, so paths render unchanged.
  const sceneSlug = titleParts
    .map(slug)
    .filter((part) => part.length > 0)
    .toSorted()
    .join('--');

  return buildRelease(
    site,
    dateIso,
    titleParts.join(' - '),
    sceneSlug,
    extractQuality(qualityParts.join(' '), group),
  );
}

export function parseSceneRelease(releaseName: string): ParsedRelease | null {
  const trimmed = releaseName.trim();
  if (trimmed.length === 0) return null;

  const name = stripFileExtension(stripWebsitePrefix(trimmed)).trim();
  if (name.length === 0) return null;

  return parseDelimitedForm(name) ?? parseSceneForm(name);
}
