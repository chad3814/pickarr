import type {
  DisplayFields,
  ParsedRelease,
  QualityExtra,
  QualityTokens,
  SiteLookupCandidates,
} from '@pickarr/plugin-api';

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

/**
 * Why the most recent `parseSceneRelease` call returned `null`.
 *
 * Diagnostics only: written on the way out of a refusal, never read by the
 * parser itself, so it cannot change how anything parses. It exists because
 * `null` alone cannot rank what to fix next — against a real corpus the useful
 * question is *which* rule is refusing thousands of titles, and that needs a
 * reason attached to the refusal rather than inferred from the title later by
 * a second copy of the same tests.
 *
 * Single-threaded and valid only immediately after the call it describes.
 */
let lastRefusal: string | null = null;

/** The reason the last `parseSceneRelease` refused, or `null` if it succeeded. */
export function lastRefusalReason(): string | null {
  return lastRefusal;
}

function refuse(reason: string): null {
  lastRefusal = reason;
  return null;
}

/**
 * Marks a release that is not video, so there is nothing here to pick.
 *
 * These carry a date, a site and a title and would otherwise parse cleanly —
 * and then collate with the *video* release of the same scene, offering a zip
 * of photographs as one of its versions. `planSceneImport` would refuse the
 * download at import time, long after the user picked it. Refusing at parse
 * time says so up front.
 */
const NOT_VIDEO_TOKEN = /\b(?:IMAGESET|IMGSET|PHOTOSET|PICSET)\b/i;

/** The literal marker token that separates identity from encode information. */
const MARKER_TOKEN = 'XXX';

/**
 * Tokens that can only plausibly be encode information, never title words.
 * These are strong enough on their own to anchor a boundary.
 */
const RESOLUTION_TOKEN = /^(?:\d{3,4}[pi](?:\d{2,3})?|4K|8K|UHD)$/i;
const SOURCE_TOKEN =
  /^(?:WEB[-_.]?DL|WEB[-_.]?Rip|SiteRip|Blu[-_.]?Ray|BD[-_.]?Rip|BR[-_.]?Rip|DVD[-_.]?Rip|HD[-_.]?TV)$/i;

/**
 * Tokens that routinely appear in an encode section but are too weak to
 * anchor a boundary by themselves — several of them (`Web`, `HD`, `MP4`) are
 * perfectly ordinary title words in this domain.
 */
const ANCILLARY_TOKEN =
  /^(?:WEB|DL|HD|SD|FHD|QHD|HDR(?:10)?|DV|10bits?|8bits?|\d{2,3}fps|iNTERNAL|REPACK|PROPER|MULTi|DUAL|UPSCALED?|REMASTERED?|x26[45]|H[-_.]?26[45]|HEVC|AVC|AV1|XviD|DivX|VP9|AAC\d?|AC3|EAC3|DDP?\d?|MP3|FLAC|Opus|MP4|MKV|WMV|AVI|MOV|FLV|M4V|F4V|VERTICAL|VR|3D|SBS|TB|LR|OU|MONO|MKX200|MKX220|FISHEYE190|FISHEYE|OCULUS|GEARVR|PSVR|SMARTPHONE|\d)$/i;

/**
 * An upscale is a lower-resolution source stretched to a higher one, so it
 * carries the *number* of the better release without its detail. Recorded as
 * an extra because `scoreScene` has to rank it below a native encode at the
 * same resolution — left unrecorded the two tie, and a tie is enough for the
 * upgrade path to trash a genuine 2160p file and replace it with a stretched
 * 1080p one.
 */
const UPSCALED_TOKEN = /\bUPSCALED?\b/i;

/**
 * An interlaced encode carries half the vertical detail per field, so `1080i`
 * is worse than `1080p` while claiming the same number. Recorded for the same
 * reason `upscaled` is: unrecorded, the two tie, and a tie is enough for the
 * upgrade path to replace a progressive file with an interlaced one.
 */
const INTERLACED_TOKEN = /\b\d{3,4}i(?:\d{2,3})?\b/i;

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
 * Short words that are *not* release groups even though they have a group's
 * shape. Languages, edit tags and distribution notes all trail an encode
 * section the way a group does; treating one as a group would silently merge
 * two genuinely different cuts of a scene.
 *
 * Held uppercase and matched case-insensitively, so one entry covers `UNCUT`,
 * `Uncut` and `uncut`. This list is what catches the ones the word-shape test
 * cannot — a term shouted in caps looks nothing like a word.
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
  // 9-12 characters: refused by the length cap until it was raised to 12, so
  // these entries are what keeps them refused now. Each names a different cut
  // or different content, which is why detaching one as a group would merge
  // two things that are not the same scene.
  'UNCENSORED',
  'DIRECTORSCUT',
  'COMPILATION',
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
  [new RegExp(`\\b4K\\b|\\b2160[pi]${FPS}\\b|\\bUHD\\b`, 'i'), 2160],
  [new RegExp(`\\b1440[pi]${FPS}\\b`, 'i'), 1440],
  [new RegExp(`\\b1080[pi]${FPS}\\b`, 'i'), 1080],
  [new RegExp(`\\b720[pi]${FPS}\\b`, 'i'), 720],
  [new RegExp(`\\b540[pi]${FPS}\\b`, 'i'), 540],
  [new RegExp(`\\b480[pi]${FPS}\\b`, 'i'), 480],
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
  [/\bF4V\b/i, 'f4v'],
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
 * A trailing token has a release group's *shape* when it is purely
 * alphanumeric, carries a letter, and is not a codec/source/container/language
 * or edit term.
 *
 * Length is not consulted. A cap of 8 lived here, then 12, on the reasoning
 * that a group tag is short and a long run-together token is more likely a
 * title word. The position rule made it redundant: a tag is read as a group
 * because of *where* it sits — after the encode section, the one place title
 * material never reaches — and a name with no encode section detaches no group
 * at all. Removed after measuring, and the measurement is the point. Two
 * corpus titles gained (`-JustDifferent`, 13 characters, a real group) and
 * **no existing identity key changed**, which is the result that matters:
 * a swallowed title word would have shown up there, and collisions could not
 * have found it.
 *
 * Casing is not consulted, and neither is the word itself. Two stricter rules
 * were tried and both cost more than they bought: requiring all caps refused
 * the real groups `-FETiSH` and `-Zsex3i`, and refusing word-shaped tags
 * additionally refused `-Ghost`, `-Rarbg`, `-rartv` and `-xpost`, also real.
 * Nothing structural separates `Ghost` from `Bonus`, and `B0NUS` is itself a
 * real group — a group can be spelled to look like anything, so no list of
 * words can guard this position.
 *
 * What guards it instead is the *position*. The resolution is a second anchor:
 * extra content is named before it, and only format and a group tag follow it.
 * So `Site.23.04.15.Name.Bonus.XXX.1080p.MP4-WRB` keeps `Bonus` in the
 * identity — it is a different piece of content — while
 * `Site.23.04.15.Name.XXX.1080p.MP4-Bonus` reads `Bonus` as a group, because
 * nothing but format and a group can be there. The two cases that look alike
 * as strings are unambiguous as positions.
 *
 * `NON_GROUP_TERMS` remains as a narrow exception to that positional rule. Be
 * honest about how much it is doing: 2,310 real indexer titles containing
 * cd/part/disc markers were checked, and *none* placed one after a resolution
 * in this position. Removing the four split-marker entries changed nothing
 * measurable on that sample. Where those markers really occur — inside the
 * title, or before the resolution — they land in the identity on their own and
 * the two halves keep separate keys with no rule involved, which is the
 * positional rule working rather than the list.
 *
 * The entries stay because they cost nothing and the failure they prevent is
 * the expensive kind: `-Part1`/`-Part2`, `-CD1`/`-CD2`, `-DISC1`/`-DISC2`
 * merged onto one key means the user picks one half believing it is the whole.
 * But they are insurance against an unobserved shape, not a load-bearing
 * guard, and should not be described as one. Digits are stripped before the
 * lookup so `Part1` and `Part2` both reduce to `PART`, while a numbered group
 * like `GRP1` reduces to the unlisted `GRP`. Matching is case-insensitive.
 *
 * `minLength` is 1 for a hyphen-attached tag, where the hyphen itself is
 * already strong evidence (single-letter groups like `-G` are common), and 2
 * for a dot-attached one, where the separator carries no information.
 */
function looksLikeGroupTag(text: string, minLength: number): boolean {
  if (text.length < minLength) return false;
  if (!/^[A-Za-z0-9]+$/.test(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;
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
 *
 * A group's name may itself contain spaces — `...XviD-iPT Team`. Measured
 * against a 6,800-title corpus that one group accounted for 65% of every
 * refusal, because the tag was read as the single token `Team` and the run
 * `iPT Team` then had no encode boundary behind it. A multi-token group is
 * therefore detached too, under a stricter rule: it must sit directly behind
 * encode information, exactly as the dot-attached form must. That is what
 * stops a run of title words after a stray hyphen being swallowed, since
 * title material never follows the encode section.
 */
const MAX_GROUP_TOKENS = 3;

/**
 * The tokens of a hyphen-introduced trailing run: the last `-` in the name,
 * with only spaces between the tokens that follow it. `undefined` when the
 * final run is not introduced by a hyphen.
 */
function hyphenGroupRun(tokens: Token[], text: string): Token[] | undefined {
  const separatorBefore = (index: number): string => {
    const previous = tokens[index - 1];
    const current = tokens[index];
    if (previous === undefined || current === undefined) return '';
    return text.slice(previous.start + previous.text.length, current.start);
  };

  for (let start = tokens.length - 1; start >= 1; start -= 1) {
    const separator = separatorBefore(start);
    if (separator === '-') return tokens.slice(start);
    if (separator !== ' ') return undefined;
    if (tokens.length - start >= MAX_GROUP_TOKENS) return undefined;
  }
  return undefined;
}

function detachReleaseGroup(tokens: Token[], text: string): Detached {
  const last = tokens.at(-1);
  const previous = tokens.at(-2);
  if (last === undefined || previous === undefined) return { tokens, group: undefined };

  const run = hyphenGroupRun(tokens, text);
  if (run !== undefined && run.length > 1) {
    const before = tokens[tokens.length - run.length - 1];
    const joined = run.map((token) => token.text).join(' ');
    if (
      before !== undefined &&
      isEncodeToken(before.text) &&
      looksLikeGroupTag(joined.replaceAll(' ', ''), 2)
    ) {
      return { tokens: tokens.slice(0, -run.length), group: joined };
    }
    return { tokens, group: undefined };
  }

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
  if (UPSCALED_TOKEN.test(haystack)) extras['upscaled'] = true;
  if (INTERLACED_TOKEN.test(haystack)) extras['interlaced'] = true;

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
 * Drops an indexer's trailing runtime stamp, `... MP4-KTR [06:32:12]`.
 *
 * Added by the indexer after the complete release name, and specific enough
 * to strip safely: a bracketed `HH:MM:SS` at the very end is a duration, not
 * part of any release's name. Left alone it sits behind the group tag, so the
 * encode run no longer reaches the end and the whole name is refused.
 *
 * Deliberately narrow. Bracketed text is *not* junk in general — the delimited
 * form reads `[Vixen] Alex Coal - ...` and depends on it.
 */
function stripRuntimeStamp(name: string): string {
  return name.replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*$/, '');
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

/**
 * Builds the release. `date` is empty for names that carry none, which leaves
 * the key's middle segment empty — `brazzers::alex-coal`. The segment is kept
 * rather than dropped so the key always has three parts and consumers can go
 * on splitting on `:`; a slug can never be empty, so an empty middle is
 * unambiguous. The display omits the date entirely instead of showing a blank.
 */
function buildRelease(
  site: string,
  anchor: AnchorSpan | null,
  sceneTitle: string,
  sceneSlug: string,
  quality: QualityTokens,
): ParsedRelease | null {
  const siteSlug = slug(site);
  if (siteSlug.length === 0) return refuse('site slug is empty');
  if (sceneSlug.length === 0) return refuse('scene slug is empty');

  const fields = [{ label: 'Site', value: site }];
  const display: DisplayFields = { title: sceneTitle, subtitle: site, fields };

  if (anchor?.kind === 'date') {
    fields.push({ label: 'Date', value: anchor.key });
    // Only a real date populates `display.date`; an episode number is not one,
    // and a consumer sorting or filtering on that field must not be handed a
    // string that cannot be a date.
    display.date = anchor.key;
  } else if (anchor?.kind === 'episode') {
    fields.push({ label: 'Episode', value: anchor.key.toUpperCase() });
  }

  fields.push({ label: 'Scene', value: sceneTitle });

  return { identityKey: `${siteSlug}:${anchor?.key ?? ''}:${sceneSlug}`, display, quality };
}

// --- Shape 1: the dotted scene form -----------------------------------------

type AnchorKind = 'date' | 'episode';

/**
 * Where the site stops and the scene starts, and what that boundary is worth
 * as part of the identity.
 *
 * A date is the ideal anchor because it is recognised by arithmetic rather
 * than vocabulary. An episode number is recognised the same way — by shape,
 * `E` followed by two or more digits — and occupies exactly the same position,
 * so everything downstream treats the two identically. It is also just as
 * discriminating: `E1178` names one episode of a site as surely as a date
 * names one day of it.
 */
interface AnchorSpan {
  readonly kind: AnchorKind;
  /** What reaches the identity key's middle segment. */
  readonly key: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Finds the release date in a token stream, scanning left to right and taking
 * the first run of digits that forms a *valid* calendar date. Three shapes
 * occur: `YY.MM.DD`, `YYYY.MM.DD`, and the concatenated `YYMMDD` / `YYYYMMDD`.
 * Index 0 is skipped because a date there would leave no site.
 */
function findSceneDate(tokens: Token[]): AnchorSpan | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    const text = token.text;
    const end = token.start + text.length;

    if (/^\d{8}$/.test(text)) {
      const iso = toIsoDate(Number(text.slice(0, 4)), Number(text.slice(4, 6)), Number(text.slice(6, 8)));
      if (iso !== null) return { kind: 'date', key: iso, startOffset: token.start, endOffset: end };
    }
    if (/^\d{6}$/.test(text)) {
      const iso = toIsoDate(
        expandYear(text.slice(0, 2)),
        Number(text.slice(2, 4)),
        Number(text.slice(4, 6)),
      );
      if (iso !== null) return { kind: 'date', key: iso, startOffset: token.start, endOffset: end };
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
        return {
          kind: 'date',
          key: iso,
          startOffset: token.start,
          endOffset: day.start + day.text.length,
        };
      }
    }
  }
  return null;
}

/**
 * Finds how many leading tokens a configured site name claims, or `null` when
 * none matches.
 *
 * Matching is on slugs, so the configured spelling need not use the same
 * separators or case as the release. The longest match wins: with both
 * `Bangbros` and `Bangbros Ass Parade` configured, the sub-site is the more
 * specific answer and filing under the parent would leave its name repeated
 * in every title.
 *
 * A match may never consume every pre-date token — that would leave no scene
 * slug, and refusing the match yields a usable (if less tidy) split instead of
 * refusing the whole name.
 */
/**
 * Reduces a site name to a comparison key: lowercase, alphanumerics only.
 *
 * Separators are dropped rather than normalised because a site's own name and
 * the way releases write it disagree about word boundaries far more often than
 * they disagree about letters. `Bang Bros` is the site; most of its releases
 * say `BangBros` or `bangbros`, and a minority say `Bang.Bros`. A slug would
 * make those three different sites (`bang-bros` vs `bangbros`); this makes
 * them one.
 */
function siteComparisonKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * The most tokens a site name may claim.
 *
 * Generous, because site names in this space run long — `Giga de Rein
 * Mk-II/Delusion group` is seven tokens when a release splits it, and
 * `Giga de Rein no odor - the woman who appeared uncensored -` is ten.
 *
 * A low cap is not the safe choice here, which is the counterintuitive part.
 * Matching is exact equality against a name the metadata service returned, and
 * the longest match wins, so extra length only ever adds candidates that must
 * still exactly equal a real site. Truncating instead produces *wrong hits*:
 * capped at five, `Giga.de.Rein.Mk.II.Delusion.group` matched the separate,
 * genuine site `Gigade Rein Mk-II`, because the truncated run happened to
 * equal it. Raising the cap let the full name win on length.
 */
const MAX_SITE_TOKENS = 12;

/**
 * Bare TLDs that trail a site's name when a release stamps its domain rather
 * than its title — `BralessForever.com.Emma.G.and.Rocky.Beach.Days.2160p`.
 *
 * Only ever consumed *after* a site has been confirmed, which is what makes it
 * safe. `Bang.com - Alex Coal` is the case this must not touch, and it cannot:
 * nothing has confirmed `Bang` there, so the rule never runs. Once the leading
 * run is known to name a site, a `com` immediately behind it belongs to the
 * domain and not to the title.
 */
const SITE_TLDS = new Set(['com', 'net', 'org', 'tv', 'xxx', 'co', 'io', 'cc']);

interface SiteMatch {
  /** How many leading tokens the site name claims. */
  readonly tokenCount: number;
  /** The site's canonical spelling, which is what reaches the key. */
  readonly name: string;
}

/**
 * Extends a confirmed match over a trailing bare TLD, never over the last
 * token — something has to remain to be the title.
 */
function consumeSiteTld(before: Token[], tokenCount: number): number {
  const next = before[tokenCount];
  if (next === undefined || tokenCount + 1 >= before.length) return tokenCount;
  return SITE_TLDS.has(next.text.toLowerCase()) ? tokenCount + 1 : tokenCount;
}

function matchSitePrefix(before: Token[], sites: readonly string[]): SiteMatch | null {
  const wanted = new Map<string, string>();
  for (const site of sites) {
    const key = siteComparisonKey(site);
    const display = prettify(site);
    if (key.length > 0 && display.length > 0 && !wanted.has(key)) wanted.set(key, display);
  }
  if (wanted.size === 0) return null;

  for (let count = before.length - 1; count >= 1; count -= 1) {
    const key = siteComparisonKey(before.slice(0, count).map((token) => token.text).join(' '));
    const name = wanted.get(key);
    if (name !== undefined) return { tokenCount: count, name };
  }
  return null;
}

/**
 * Shape 1b: `Site.Title.And.Performers.YYYY.MM.DD.Encode`, with the date at
 * the end rather than between the site and the title.
 *
 * This shape is hostile to the rest of the parser because the date is the only
 * boundary the ordinary form has, and here it sits at the far end: *nothing*
 * separates the site from the title. Two conditions have to hold together
 * before a name is read this way, and each rejects cases the other admits:
 *
 *  - every token after the date is encode information. In the ordinary form
 *    the title follows the date, so a single title word after it rules this
 *    shape out. This is the positive shape test.
 *  - there is more before the date than after it. This is what stops an
 *    ordinary name whose title happens to be entirely encode-like words from
 *    being re-read as this shape.
 *
 * The site/title split is then a guess, resolved against the configured site
 * list and falling back to the first token. It is only ever a guess about the
 * library *path*: every pre-date token still reaches the identity key, whether
 * in the site half or the scene half, so no split can make two different
 * scenes collide. Moving the split changes where a scene files, never what it
 * collates with.
 */
/**
 * The pre-date tokens of a date-at-end name, or `null` for anything that is
 * not one.
 *
 * Both the parser and `sceneSiteCandidates` go through this, so the shape test
 * is stated once. A second copy would be free to drift, and a candidate list
 * generated for a name the parser does not read this way would send lookups
 * for prefixes that can never be used.
 */
function dateAtEndPrefixTokens(name: string, tokens: Token[], date: AnchorSpan): Token[] | null {
  const before = tokens.filter((token) => token.start + token.text.length <= date.startOffset);
  const after = tokens.filter((token) => token.start >= date.endOffset);
  if (after.length === 0 || before.length <= after.length) return null;

  const tail = name.slice(date.endOffset).replace(/^[.\s_-]+/, '');
  const detached = detachReleaseGroup(tokensOf(tail), tail);
  if (detached.tokens.length === 0) return null;
  if (!detached.tokens.every((token) => isEncodeToken(token.text))) return null;

  return before;
}

function parseDateAtEndForm(
  name: string,
  tokens: Token[],
  date: AnchorSpan,
  options: SceneParseOptions,
): ParsedRelease | null {
  const before = dateAtEndPrefixTokens(name, tokens, date);
  if (before === null) return null;

  const tail = name.slice(date.endOffset).replace(/^[.\s_-]+/, '');
  const detached = detachReleaseGroup(tokensOf(tail), tail);

  // A matched site contributes its *canonical* spelling, not the release's.
  // The same site arrives written several ways — `BangBros`, `bangbros`,
  // `Bang.Bros` — and keying on whichever one this release used would file
  // them as three sites. Unmatched names have no canonical form to use, so
  // they fall back to the release's own first token.
  const match = matchSitePrefix(before, options.sites ?? []);
  const siteTokens = match === null ? 1 : consumeSiteTld(before, match.tokenCount);
  const lastSiteToken = before[siteTokens - 1];
  const firstSceneToken = before[siteTokens];
  if (lastSiteToken === undefined || firstSceneToken === undefined) return null;

  const site =
    match?.name ?? prettify(name.slice(0, lastSiteToken.start + lastSiteToken.text.length));
  const sceneText = prettify(name.slice(firstSceneToken.start, date.startOffset));
  if (site.length === 0 || sceneText.length === 0) return null;
  if (sceneText.toUpperCase() === MARKER_TOKEN) return null;

  return buildRelease(site, date, sceneText, slug(sceneText), extractQuality(tail, detached.group));
}

/**
 * The pre-encode tokens of a name that carries no date, or `null` when the
 * name has no trustworthy encode boundary either.
 *
 * With no date there is only one anchor left — where the encode section
 * starts — and everything before it is site and title with nothing separating
 * them. `minIndex` is 2 so at least one token can be the site and one the
 * title.
 */
function datelessPrefixTokens(name: string): { before: Token[]; tail: string } | null {
  const detached = detachReleaseGroup(tokensOf(name), name);
  const cut = findEncodeSuffixStart(detached.tokens, 2);
  if (cut === null) return null;

  const cutToken = detached.tokens[cut];
  if (cutToken === undefined) return null;

  return { before: detached.tokens.slice(0, cut), tail: name.slice(cutToken.start) };
}

/**
 * Shape 3: no date anywhere — `Site.Title.And.Performers.Encode`.
 *
 * Releases like this exist, and until now they were refused outright because
 * the date was the only thing marking where the site stopped. A confirmed site
 * marks it just as well, so the refusal is lifted — but *only* for a confirmed
 * one. There is deliberately no first-token fallback here, unlike the
 * date-at-end shape: the date was also the evidence that a name was a scene
 * release at all, and without it `Some.Random.Movie.2023.1080p.BluRay-GRP` has
 * exactly this shape. Requiring the site to be real is what replaces that
 * evidence; guessing would turn every unrecognised release into a group filed
 * under its first word.
 *
 * The identity key has an empty date segment, so two releases of one scene
 * collate with each other but not with a *dated* release of the same scene.
 * The accepted cost is over-collation of a kind the parser otherwise refuses:
 * two different scenes from one site sharing a title become one group, and in
 * this domain a title is often just a performer name. Nothing in a dateless
 * name can separate them.
 */
function parseDatelessForm(name: string, options: SceneParseOptions): ParsedRelease | null {
  const prefix = datelessPrefixTokens(name);
  if (prefix === null) return refuse('no date and no trustworthy encode boundary');

  const match = matchSitePrefix(prefix.before, options.sites ?? []);
  if (match === null) return refuse('no date, and the site is not in the known list');

  const siteTokens = consumeSiteTld(prefix.before, match.tokenCount);
  const firstSceneToken = prefix.before[siteTokens];
  if (firstSceneToken === undefined) return refuse('no date, and the site name uses every token');

  const sceneText = prettify(name.slice(firstSceneToken.start, prefix.tail.length > 0 ? name.length - prefix.tail.length : name.length));
  if (sceneText.length === 0 || sceneText.toUpperCase() === MARKER_TOKEN) {
    return refuse('no date, and no title left after the site');
  }

  const detached = detachReleaseGroup(tokensOf(name), name);
  return buildRelease(
    match.name,
    null,
    sceneText,
    slug(sceneText),
    extractQuality(prefix.tail, detached.group),
  );
}

/**
 * `E` followed by two or more digits, standing where a date would.
 *
 * Sites that number their episodes rather than dating them put the number in
 * exactly the date's position, so it anchors the site/title boundary the same
 * way and — unlike a dateless name — needs no site lookup to do it. Against
 * the corpus these were the largest remaining block of refusals.
 *
 * Two digits minimum, because a bare `E1` is too easy for a title to produce.
 * Index 0 is skipped for the same reason it is for a date: an anchor there
 * leaves no site. `S01E05` tokenises whole and does not match, which keeps
 * episodic television numbering out of this.
 */
function findEpisodeAnchor(tokens: Token[]): AnchorSpan | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || !/^[Ee]\d{2,}$/.test(token.text)) continue;
    return {
      kind: 'episode',
      key: token.text.toLowerCase(),
      startOffset: token.start,
      endOffset: token.start + token.text.length,
    };
  }
  return null;
}

function parseSceneForm(name: string, options: SceneParseOptions): ParsedRelease | null {
  const tokens = tokensOf(name);
  const date = findSceneDate(tokens) ?? findEpisodeAnchor(tokens);
  if (date === null) return parseDatelessForm(name, options);

  const atEnd = parseDateAtEndForm(name, tokens, date, options);
  if (atEnd !== null) return atEnd;

  const site = prettify(name.slice(0, date.startOffset));
  const rest = name.slice(date.endOffset).replace(/^[.\s_-]+/, '');
  if (site.length === 0) return refuse('date is first, so there is no site');
  if (rest.length === 0) return refuse('nothing follows the date');

  // A run carrying no encode vocabulary at all is entirely the scene.
  //
  // The usual refusal here is about ambiguity: `Alex.Coal.MP4-G` might be the
  // scene "Alex Coal" with a container, or the scene "Alex Coal MP4", and
  // nothing in the name settles it. That doubt needs at least one encode-ish
  // token to exist. When none does there is no run to mistake for title and no
  // title to mistake for a run, so taking the whole remainder is not a guess —
  // and it lets `Site.23.04.15.Alex.Coal` collate with the same scene listed
  // with its encode information, which refusing could never do.
  //
  // No group is detached here either, and that is the same argument rather
  // than a separate concession. A trailing tag reads as a group because of
  // where it sits — after the encode section, the one place title material
  // never reaches. With no encode section there is no such place, so a hyphen
  // is just punctuation: `Amanda.Verhooks.Anal.Three-way` is a title, not the
  // scene "Amanda Verhooks Anal Three" released by a group called `way`.
  const restTokens = tokensOf(rest);
  if (!restTokens.some((token) => isEncodeToken(token.text))) {
    // The `XXX` marker still ends the title when it is there. `findEncodeSuffixStart`
    // only reports it when it sits against the encode run, which by definition
    // is empty here, so the marker is looked for directly — everything after
    // it is not title, whatever it turns out to be.
    const markerIndex = restTokens.findLastIndex(
      (token, index) => index >= 1 && token.text.toUpperCase() === MARKER_TOKEN,
    );
    const markerToken = markerIndex === -1 ? undefined : restTokens[markerIndex];
    const whole = prettify(markerToken === undefined ? rest : rest.slice(0, markerToken.start));
    if (whole.length === 0) return refuse('no title between the date and the encode section');
    if (whole.toUpperCase() === MARKER_TOKEN) return refuse('title is only the XXX marker');
    return buildRelease(site, date, whole, slug(whole), extractQuality('', undefined));
  }

  const detached = detachReleaseGroup(tokensOf(rest), rest);
  const cut = findEncodeSuffixStart(detached.tokens, 1);
  if (cut === null) return refuse('no trustworthy encode boundary after the date');

  const cutToken = detached.tokens[cut];
  if (cutToken === undefined) return refuse('no trustworthy encode boundary after the date');

  const sceneText = prettify(rest.slice(0, cutToken.start));
  if (sceneText.length === 0) return refuse('no title between the date and the encode section');
  // A "title" made only of the marker carries no discriminating content, so
  // two unrelated scenes on one site and day would collide on it.
  if (sceneText.toUpperCase() === MARKER_TOKEN) return refuse('title is only the XXX marker');

  const tail = rest.slice(cutToken.start);
  return buildRelease(site, date, sceneText, slug(sceneText), extractQuality(tail, detached.group));
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
    { kind: 'date', key: dateIso, startOffset: 0, endOffset: 0 },
    titleParts.join(' - '),
    sceneSlug,
    extractQuality(qualityParts.join(' '), group),
  );
}

export interface SceneParseOptions {
  /**
   * Known site names, used only by the date-at-end shape, where nothing in the
   * name separates the site from the title. Spelling is free: matching is on
   * slugs, so case and separators do not have to agree with the release.
   * Unmatched names fall back to treating the first token as the site.
   */
  readonly sites?: readonly string[];
}

/**
 * Site names worth confirming for a release name, most specific first, or an
 * empty array when the name needs no help.
 *
 * Only date-at-end names need it, and only when the configured list does not
 * already cover them — the ordinary form carries its own boundary. Two
 * candidates are offered, the first two tokens and then the first one, because
 * a search for a site's full name is precise while a search for its first word
 * alone is not: `bangbros ass` returns nothing and rules itself out, whereas
 * `anal` matches a great many sites that are not `Anal Only`. Trying the
 * longer one first is what makes the shorter one safe to fall back to.
 *
 * A candidate never consumes every pre-date token: something has to remain to
 * be the title.
 */
/**
 * True for a query with nothing to discriminate on.
 *
 * A single letter is worthless as a site search: the service matches it
 * anywhere in a name, so `a` reports 87,955 results (`Male Reality`, `Laundry`),
 * `b` 25,078 and `x` 13,168. None of that can confirm anything, and asking
 * costs a request and a wasted page.
 *
 * A single *digit* is a different case and is allowed. Digits lead real site
 * names — `2 Chicks Same Time` — and are cheap rather than pathological: `0`
 * through `4` return nothing at all and `8` returns one. The asymmetry is the
 * point; a blanket minimum length would throw the useful case away with the
 * useless one.
 *
 * The cost is that a site named with a single letter — there is one called
 * `X` — cannot be discovered, only configured.
 */
function isTooBroadToSearch(query: string): boolean {
  const key = query.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return key.length === 1 && /[a-z]/.test(key);
}

export function sceneSiteCandidates(
  releaseName: string,
  options: SceneParseOptions = {},
): SiteLookupCandidates | null {
  const trimmed = releaseName.trim();
  if (trimmed.length === 0) return null;

  const name = stripFileExtension(stripWebsitePrefix(stripRuntimeStamp(trimmed))).trim();
  if (name.length === 0) return null;
  // The delimited form has explicit boundaries, so it never needs a lookup.
  if (parseDelimitedForm(name) !== null) return null;

  const tokens = tokensOf(name);
  const date = findSceneDate(tokens);

  // A dateless name needs the same lookup, and needs it more: it has no
  // fallback, so an unconfirmed site means the name is refused entirely.
  const before =
    date === null
      ? (datelessPrefixTokens(name)?.before ?? null)
      : dateAtEndPrefixTokens(name, tokens, date);
  if (before === null) return null;
  if (matchSitePrefix(before, options.sites ?? []) !== null) return null;

  const run = (count: number): string =>
    before
      .slice(0, count)
      .map((token) => token.text)
      .join(' ');

  // Never every token: something has to remain to be the title.
  const longest = Math.min(before.length - 1, MAX_SITE_TOKENS);
  if (longest < 1) return null;

  const prefixes: string[] = [];
  for (let count = longest; count >= 1; count -= 1) {
    const text = run(count);
    if (text.length > 0) prefixes.push(text);
  }

  const queries: string[] = [];
  for (const count of [2, 1]) {
    if (count > longest) continue;
    const text = run(count);
    if (text.length === 0 || queries.includes(text)) continue;
    if (isTooBroadToSearch(text)) continue;
    queries.push(text);
  }
  if (queries.length === 0 || prefixes.length === 0) return null;

  return { queries, prefixes };
}

export function parseSceneRelease(
  releaseName: string,
  options: SceneParseOptions = {},
): ParsedRelease | null {
  lastRefusal = null;

  const trimmed = releaseName.trim();
  if (trimmed.length === 0) return refuse('empty name');

  const name = stripFileExtension(stripWebsitePrefix(stripRuntimeStamp(trimmed))).trim();
  if (name.length === 0) return refuse('nothing left after stripping prefix/extension');

  if (NOT_VIDEO_TOKEN.test(name)) return refuse('not a video release (image or photo set)');

  const result = parseDelimitedForm(name) ?? parseSceneForm(name, options);
  if (result !== null) lastRefusal = null;
  return result;
}
