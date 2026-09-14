import type {
  DisplayField,
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
 * The identity is `siteComparisonKey(pre-date text) : ISO date :
 * slug(post-date text minus an encode suffix)`. Two names collide only if all
 * three agree. The first two are exact — no vocabulary is consulted for the
 * site, and the date is self-verifying. So a collision requires two post-date
 * regions that differ *only* inside a suffix that (a) reaches the end of the
 * name, (b) consists entirely of closed-vocabulary encode tokens, and (c) is
 * introduced by the `XXX` marker or by a resolution/source anchor. "Differs
 * only in trailing encode tokens" is the definition of "two encodes of one
 * release" — so the rule collapses exactly the set it is supposed to collapse.
 * The residual risk is a scene whose genuine title *ends* in an
 * anchor-introduced run of encode words; the parser refuses whenever that run
 * is interrupted rather than guessing, which is why names like
 * `Site.23.04.15.The.1080p.Club.MP4-G` return `null`.
 *
 * Where the run is *not* interrupted the risk is real, and it is accepted
 * rather than reducible. Worked: `Site.23.01.01.Party.4K.MP4-G` is the scene
 * `Party` released in 4K, and `Site.23.01.01.Party.4K.1080p.MP4-G` is the
 * scene `Party 4K` released at 1080p. Rule 2 cuts both at `4K`, so both key
 * as `site:2023-01-01:party` — and the second also reports 2160, because
 * `extractQuality` reads the tail from the same cut and finds `4K` before it
 * finds `1080p`. Every token in either name is accounted for under either
 * reading, so the string does not carry the information needed to choose.
 * Cutting later would put `4K` into the title of every ordinary 4K release;
 * cutting earlier is precisely what rule 1 already does when a marker is
 * there to justify it, and `Site.23.01.01.Party.4K.XXX.1080p.MP4-G` duly keys
 * as `site:2023-01-01:party-4k` at 1080. So the fix is a marker in the name
 * or a scene id from upstream, neither of which is the parser's to supply.
 * The collision is pinned by name in `parse-corpus.test.ts` — it cannot be a
 * corpus row, because the no-over-collation invariant would fail on it — so a
 * future change to the anchor rule has to move it rather than move it
 * silently.
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
const RESOLUTION_TOKEN = /^(?:\d{3,4}[pi](?:\d{2,3})?|(?:4K|8K|UHD)(?:\d{2,3})?)$/i;
const SOURCE_TOKEN =
  /^(?:WEB[-_.]?DL|WEB[-_.]?Rip|SiteRip|Blu[-_.]?Ray|BD[-_.]?Rip|BR[-_.]?Rip|DVD[-_.]?Rip|HD[-_.]?TV)$/i;

/**
 * Tokens that routinely appear in an encode section but are too weak to
 * anchor a boundary by themselves — several of them (`Web`, `HD`, `MP4`) are
 * perfectly ordinary title words in this domain.
 *
 * `UPSCALED?` and `REMASTER(?:ED)?` are deliberately spelled differently. A
 * bare `?` binds to the letter in front of it, so `UPSCALED?` covers `UPSCALE`
 * and `UPSCALED` — both real spellings, both wanted — while `REMASTERED?`
 * would cover `REMASTERE` and `REMASTERED` and miss `REMASTER`. The group has
 * to take the whole `ED` for the second and only the `D` for the first.
 * Getting this wrong is not hypothetical: the entry has now been mis-spelled
 * three times, once as `REMASTER` refusing `REMASTERED` and once the other way
 * round, and each time an unknown token stopped the backward walk in
 * `findEncodeSuffixStart` and the whole name was refused.
 */
const ANCILLARY_TOKEN =
  /^(?:WEB|DL|HD|SD|FHD|QHD|HDR(?:10)?|DV|10bits?|8bits?|\d{2,3}fps|iNTERNAL|REPACK|PROPER|MULTi|DUAL|UPSCALED?|REMASTER(?:ED)?|(?:real[-_.\s]?)?esrgan|x26[45]|H[-_.]?26[45]|HEVC|AVC|AV1|XviD|DivX|VP9|AAC\d?|AC3|EAC3|DDP?\d?|MP3|FLAC|Opus|MP4|MKV|WMV|AVI|MOV|FLV|M4V|F4V|VERTICAL|VR|3D|SBS|TB|LR|OU|MONO|MKX200|MKX220|FISHEYE190|FISHEYE|OCULUS|GEARVR|PSVR|SMARTPHONE|\d)$/i;

/**
 * An upscale is a lower-resolution source stretched to a higher one, so it
 * carries the *number* of the better release without its detail. Recorded as
 * an extra because `scoreScene` has to rank it below a native encode at the
 * same resolution — left unrecorded the two tie, and a tie is enough for the
 * upgrade path to trash a genuine 2160p file and replace it with a stretched
 * 1080p one.
 *
 * The *tool's* name counts as saying so. A poster who ran a file through
 * Real-ESRGAN — a super-resolution model — stamps `realesrgan` rather than the
 * word `upscaled`, and the two claims are the same claim: the resolution in the
 * name was computed, not captured. It is also in `ANCILLARY_TOKEN`, because it
 * is encode information in the ordinary sense as well — it says how the file
 * was produced — and that is what keeps it out of the release group's *name*.
 *
 * `esrgan` alone is admitted because the family name is used interchangeably
 * with the full one. Neither spelling is an English word, so a title cannot
 * produce one by accident — which is what makes matching a tool name safe here
 * where a general vocabulary would not be.
 */
const UPSCALED_TOKEN = /\bUPSCALED?\b|\b(?:real[.\s_-]?)?esrgan\b/i;

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
  // The upscaler's own spelling is `Real-ESRGAN`, so the separated form is the
  // likelier one. Without this entry the `real[-_.\s]?esrgan` alternation in
  // `ANCILLARY_TOKEN` is unreachable: the tokenizer splits on every separator,
  // so no token can ever contain one and only the run-together spelling matched.
  // The joined token keeps whichever separator was written — including a space,
  // since this rejoins across any single one — which is why that class carries
  // `\s` and matches the class in `UPSCALED_TOKEN`.
  'REALESRGAN',
]);


/**
 * Language names and codes. Exported and split out of `NON_GROUP_TERMS`
 * because they answer a second question the other half cannot: a language is
 * not a title word either, so it may be dropped from the end of a title —
 * see `isTitleSuffixToken`.
 *
 * `DUTCH` and `JAPANESE` were absent before this split, which is why a release
 * ending in either had it detached as a release group, merging two language
 * cuts of one scene. Adding them fixes that and is the only membership change
 * the split makes.
 *
 * Measured: seven of these occur at the end of a parsed title in the corpus —
 * `GERMAN` 13, `DUTCH` 11, `SPANISH`, `FRENCH`, `ITALIAN`, `JAPANESE`, `JAP` —
 * and every occurrence is a tag rather than a title word. `ENGLISH` and
 * `RUSSIAN` never occur there and are the two that are also ordinary
 * adjectives; if a title is ever wrongly truncated, they are the first
 * entries to suspect.
 *
 * `POLISH` and `CZECH` were added after the same measurement was run over the
 * whole corpus: `POLISH` occurs 3 times and every one is title-final
 * (`XES.26.02.10.Krisa.POLISH.XXX...`), `CZECH` 3 times with 2 title-final and
 * the third — `ALSScan.17.12.09.Czech.2017.Casting...` — mid-title, where the
 * walk stops at `Casting` and never reaches it.
 *
 * Membership no longer decides on its own: a title-final language term is only
 * dropped when its casing (or the tag before it) says it is a tag — see
 * `isLanguageSuffixToken`. That is what makes `Britney Dutch` and `Tyler
 * French` survive while `DUTCH` and `iTALiAN` do not, and it is why the
 * `ENGLISH`/`RUSSIAN` suspicion above is now largely handled rather than merely
 * noted.
 *
 * `THAI` and `ARABIC` are deliberately **not** here, and the reason is the
 * same measurement finding the opposite answer: in this domain both are
 * performer names far more often than languages. `May Thai` is title-final in
 * `MorePOV.26.07.23.Alexa.Flexy.Geisha.Kyd.And.May.Thai.XXX...` and so is the
 * `Thai` of `ThaiSwinger.26.07.22.Tuk.Brilliant.Thai.XXX...`; both would be
 * truncated. `Sarah Arabic` appears in three corpus scenes, mid-title in all
 * of them today, which makes it a title word one re-ordering away from being
 * title-final. Being a language is not on its own a reason to be here.
 */
export const LANGUAGE_TERMS = new Set([
  'ENGLISH', 'FRENCH', 'GERMAN', 'SPANISH', 'ITALIAN', 'RUSSIAN', 'DUTCH', 'JAPANESE',
  'POLISH', 'CZECH',
  'ENG', 'FRA', 'GER', 'ESP', 'ITA', 'RUS', 'JAP', 'JPN',
]);

/**
 * The rest of `NON_GROUP_TERMS`: edit, cut and distribution notes.
 *
 * These are emphatically *not* droppable from a title, which is the whole
 * reason the split exists. The corpus ends real titles with three of them —
 * `Leona Mia Beauty In Full`, `Alaina Dawson Compilation`, `Jessica Jans Bonus
 * Scene` — so a rule that treated this half as suffix noise would render the
 * first as `Beauty In`. The union's own comment makes the same point from the
 * other direction: each names a different cut or different content, so
 * detaching one as a group would merge two things that are not the same scene.
 */
export const NON_GROUP_EDIT_TERMS = new Set([
  'SUB', 'SUBS', 'SUBBED', 'DUBBED', 'UNCUT', 'UNRATED', 'EXTENDED', 'DIRECTORS',
  'UNCENSORED', 'DIRECTORSCUT', 'COMPILATION', 'REMUX', 'PART', 'PT', 'CD', 'DISC',
  'SCENE', 'FULL', 'HQ', 'LQ',
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
export const NON_GROUP_TERMS = new Set([...LANGUAGE_TERMS, ...NON_GROUP_EDIT_TERMS]);

/**
 * Scene-type tags some sites append after the title. Not title words: the
 * service that knows the scene knows it by a name without them, so a title
 * carrying one cannot be matched.
 *
 * Measured: 219 corpus titles carry one, 210 of them in the trailing run.
 * The remaining 9 are mid-title and are left alone — `findTitleEnd` only ever
 * walks the end.
 */
const CONTENT_TYPE_TERMS = new Set(['HARDCORE', 'SOLO', 'LESBIAN']);

/**
 * Words after which a number belongs to the title.
 *
 * `Violet Voss Episode 466` is why: 466 is past the id threshold, and dropping
 * it does not merely shorten the title — it collides with episode 467 if a
 * site posts two on one day.
 *
 * A list of observed words, with the maintenance cost that implies: another
 * site's `chapter` or `ep` would truncate. `stripPosterSignature` carries the
 * same cost for the same reason — no structural rule was available.
 *
 * `PART` and `SCENE` are also in `NON_GROUP_EDIT_TERMS`. That is not the
 * duplication issue #13 warns about: these two sets answer different questions
 * — "may a number after this word be dropped" and "does this token have a
 * group's shape" — and their answers never conflict.
 */
const ORDINAL_WORDS = new Set(['EPISODE', 'PART', 'VOL', 'SCENE']);

/**
 * The smallest all-numeric token treated as a site's own id rather than part
 * of the title.
 *
 * Measured over 6,388 corpus titles: 312 end in a number. All 206 below 250
 * are sequel or part numbers (`Sarasota 4`, `Menu 2`), and 99 of the 106 at or
 * above it are ids of the `42xxx` shape. Nothing has 250 sequels.
 */
const NUMERIC_ID_MIN = 250;

/** Numbers in this range read as years, and a year can be a title word. */
const YEAR_MIN = 1900;
const YEAR_MAX = 2099;

function isContentTypeTerm(text: string): boolean {
  return CONTENT_TYPE_TERMS.has(text.toUpperCase());
}

function isLanguageTerm(text: string): boolean {
  return LANGUAGE_TERMS.has(text.toUpperCase());
}

/**
 * `previous` is the token before this one, which is still part of the title at
 * the moment the walk asks. It is what the `ORDINAL_WORDS` carve-out reads.
 */
function isNumericIdToken(text: string, previous: string | undefined): boolean {
  if (!/^\d+$/.test(text)) return false;
  const value = Number(text);
  if (value < NUMERIC_ID_MIN) return false;
  if (value >= YEAR_MIN && value <= YEAR_MAX) return false;
  if (previous !== undefined && ORDINAL_WORDS.has(previous.toUpperCase())) return false;
  return true;
}

export { isContentTypeTerm, isLanguageTerm, isNumericIdToken };

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
 * studio puts in its own name, so requiring one restores the distinction, and
 * a marked prefix is stripped unconditionally — no list is consulted here.
 *
 * A *bare* domain is now also stripped, but only where the release itself
 * settles the question; see `isTrackerStamp`. That is not the studio allowlist
 * this comment used to reject. An allowlist fails for every studio nobody
 * thought of, because a name missing from it reads as a tracker; the rule
 * below needs a confirmation on *both* sides and so falls silent — leaving
 * this arm's answer standing — for every name the list does not cover.
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
 * A bracketed *bare* domain. Safe to strip outright when the name is not a
 * delimited listing, because there a leading bracket is the studio field
 * itself (`[Vixen] ...`) and `[Bang.com] - Alex Coal - ...` means the studio,
 * not a tracker stamp. Inside a listing it needs the confirmation
 * `isTrackerStamp` supplies.
 */
const BRACKETED_BARE_DOMAIN = new RegExp(`^[[(]\\s*(${HOST})\\s*[\\])]\\s*[-–—]?\\s*`, 'i');

/**
 * An unbracketed *bare* domain at the head of a delimited listing.
 *
 * The delimiter is what scopes this to the listing form, and it is spelled the
 * way `SEGMENT_SPLIT` spells it — whitespace on both sides of the dash. The
 * looser `[\s._-]*[-–—]\s*` was tried and reaches too far: with no space
 * required it matches the hyphen that attaches a release group to a *dotted*
 * name, so `Site.23.04.15.Scene.XXX-Vixen` offers `Site.23.04.15.Scene` as the
 * domain's label and the group tag as the field behind it. The dotted form is
 * out of scope here — it carries no field boundaries for this rule to read.
 */
const BARE_DOMAIN_LEAD = new RegExp(`^(${HOST})\\s+[-–—]\\s+`, 'i');

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
 *
 * The word spellings need it just as much, and for a sharper reason: `\b4K\b`
 * cannot match inside `4K60` at all, because `K` and `6` are both word
 * characters so no boundary exists between them. Left off, `4K60` scored
 * resolution zero the same way. On a bare `4K` the group simply matches empty
 * and the trailing `\b` still holds before the separator, so `4K.100.Girls` is
 * read as 2160 exactly as before.
 */
const FPS = '(?:\\d{2,3})?';
const RESOLUTIONS: [RegExp, number][] = [
  [new RegExp(`\\b8K${FPS}\\b`, 'i'), 4320],
  [new RegExp(`\\b4K${FPS}\\b|\\b2160[pi]${FPS}\\b|\\bUHD${FPS}\\b`, 'i'), 2160],
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
export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function prettify(value: string): string {
  return value
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s-]+|[\s-]+$/g, '');
}

/**
 * What separates the components of a multi-part scene slug.
 *
 * Named rather than spelled inline because the value and the reasoning below
 * are one fact: anything that *reads* a scene slug back — deciding whether a
 * key has components at all, splitting it for a path — has to agree with what
 * wrote it, and a second literal `--` is a second place for that agreement to
 * break.
 */
export const SCENE_COMPONENT_BOUNDARY = '--';

/**
 * The scene slug for a title whose parts may appear in either order: each part
 * slugged, empties dropped, sorted, joined with `SCENE_COMPONENT_BOUNDARY`.
 *
 * Sorting is what makes the two orderings one identity, and the display title
 * keeps source order separately — trackers put performer and title on either
 * side of each other, so the same scene arrives spelled both ways.
 *
 * The join is `--`, and that is load-bearing rather than cosmetic. Sorting is
 * only safe if the join is injective on the multiset of parts, and joining
 * with a single `-` is not: `slug()` emits `-` too, so the part boundaries
 * dissolve and any re-split that happens to preserve alphabetical order
 * collides — `Kylie` + `Page Turner` and `Kylie Page` + `Turner` both render
 * `kylie-page-turner`, and those are different scenes. `slug()` collapses runs
 * of non-alphanumerics to a single `-` and strips the edges, so `--` cannot
 * occur inside a part; empty parts are filtered out here. The join is
 * therefore a delimiter that no part can contain, the split is unique, and
 * *now* the multiset determines the string and vice versa. `titleCaseSlug`
 * drops empty segments, so paths render unchanged.
 *
 * This lives here, exported, rather than at its one parser call site because
 * the manual-entry path has to produce the same boundary for the same title.
 * Two spellings of this expression are two identity models: a hand-corrected
 * release that joins on `-` lands in a different group, and on a different
 * library path, than the parsed siblings it was corrected to match — with
 * nothing failing to say so.
 */
export function sceneSlugFromParts(parts: readonly string[]): string {
  return parts
    .map(slug)
    .filter((part) => part.length > 0)
    .toSorted()
    .join(SCENE_COMPONENT_BOUNDARY);
}

/**
 * A calendar date as `YYYY-MM-DD`, or `null` if those numbers name no real
 * day. `Date.UTC` rolls `2023-02-30` forward into March rather than refusing
 * it, so the components have to be read back out to catch it.
 *
 * The year range is deliberately narrower than "valid": a release dated 9023
 * is a typo, and admitting it opens a group and a library directory that no
 * correctly-dated release can ever join.
 */
export function toIsoDate(year: number, month: number, day: number): string | null {
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

export interface Token {
  readonly text: string;
  readonly start: number;
}

export function isEncodeToken(text: string): boolean {
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

export function tokensOf(text: string): Token[] {
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

export interface Detached {
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

/**
 * Whether the token at `index` can be the *end* of an encode section — the
 * anchor `dottedGroupRun`'s multi-token run must sit directly behind.
 *
 * `isEncodeToken` is not that test, and using it as one refused three corpus
 * names outright. `ANCILLARY_TOKEN` admits a token that is nothing but digits so
 * the `1` the tokenizer splits off `DDP5.1` still reads as part of the run it
 * continues; behind title material the same token is a scene or sequel number.
 * `Minori.Kamiyama.Rispetto.1.JAP.XXX.1080p` therefore had `JAP.XXX.1080p`
 * detached as a dot-attached group anchored on the `1`,
 * `Hiyori.JAPANESE.2.XXX.1080p` had `XXX.1080p` detached on the `2` — which
 * names the `XXX` marker itself as a release group — and
 * `...Sexy.Slave.in.Fox.Ears.2.Cums.POV.2160p` lost `Cums.POV.2160p` the same
 * way. What was left of each carried no encode section at all, so
 * `findEncodeSuffixStart` returned `null` and all three were refused: the exact
 * failure mode detaching a dotted group exists to remove, reintroduced through
 * its own gate.
 *
 * A bare number's encode meaning is borrowed from the token in front of it, so
 * it anchors only while that loan holds. That is the shape
 * `isLanguageSuffixToken` already uses — a token that cannot vouch for itself
 * asks its predecessor — and one level is enough, because a real encode section
 * never ends in two bare numbers.
 *
 * Used only by the multi-token dotted run, which is where the refusals came
 * from. The hyphen run and the single-token dot form read `isEncodeToken`
 * directly still: substituting this there is measurably identical over the whole
 * 10,651-name corpus — 0 newly refused, 0 newly parsed, 0 identity keys and 0
 * release groups moved either way — so there is no evidence to change them on,
 * and both are reachable only by a name whose last token both looks like a group
 * and follows a bare number, which leaves no boundary anchor to parse with
 * anyway.
 */
function endsEncodeSection(tokens: Token[], index: number): boolean {
  const token = tokens[index];
  if (token === undefined || !isEncodeToken(token.text)) return false;
  if (!/^\d+$/.test(token.text)) return true;
  return isEncodeToken(tokens[index - 1]?.text ?? '');
}

/**
 * The tokens of a trailing run attached with the name's *own* separator, ending
 * where encode information begins. `undefined` when no encode token is reached,
 * when a foreign separator interrupts the run, or when the run grows past
 * `MAX_GROUP_TOKENS`.
 *
 * This is `hyphenGroupRun`'s counterpart for the dot-attached form, and it
 * exists because the two forms had asymmetric support: a multi-token group was
 * detachable only when a hyphen introduced it. A poster who attaches one with
 * the name's own separator — `...MP4.NBQ.realesrgan`, a group plus the upscaler
 * it was run through — produced a name no branch could read, and the failure
 * was a *refusal* rather than a bad parse: the undetached tail meant the
 * trailing encode run no longer reached the end of the name, so
 * `findEncodeSuffixStart` could not see the `XXX` marker, the `2160p` or the
 * `MP4` sitting in front of it. Everything needed to parse the name was present
 * and correctly classified, merely unreachable.
 *
 * The gate is the same one the hyphen form and the single-token dot form both
 * use — the run must sit directly behind encode information — so this widens
 * *which separator* the positional rule accepts, not the rule itself. That
 * matters for the collision argument: a run this detaches was previously
 * unreachable by definition, because a trailing run of non-encode tokens is
 * exactly what stopped the old walk. Any name it newly admits was refused
 * before, so no existing identity key can move underneath it.
 */
function dottedGroupRun(tokens: Token[], text: string): Token[] | undefined {
  for (let start = tokens.length - 1; start >= 1; start -= 1) {
    const previous = tokens[start - 1];
    const current = tokens[start];
    if (previous === undefined || current === undefined) return undefined;
    const separator = text.slice(previous.start + previous.text.length, current.start);
    if (!/^[._\s]$/.test(separator)) return undefined;
    if (endsEncodeSection(tokens, start - 1)) return tokens.slice(start);
    if (tokens.length - start >= MAX_GROUP_TOKENS) return undefined;
  }
  return undefined;
}

export function detachReleaseGroup(tokens: Token[], text: string): Detached {
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

  // Tried last, so it only ever sees names the single-token forms declined.
  //
  // The whole run leaves the identity, but only its leading, non-encode part is
  // the group's *name*: `MP4.NBQ.realesrgan` is the group `NBQ` with the model
  // it was run through stamped behind it, not a group called `NBQ.realesrgan`.
  // Naming it the latter would mint a second group for every file NBQ happened
  // to upscale, so one group's releases would stop reading as one group — and
  // the same argument applies to `.NBQ.UPSCALED` and `.NBQ.HEVC`. The stamp is
  // not lost by being left out of the name: the tail `extractQuality` reads is a
  // raw slice of the release name, so it still sees the token and still records
  // the `upscaled` extra that ranks this below a native encode.
  //
  // `run[0]` is always non-encode — the walk only continues past a token that
  // is not encode information — so the trim can never empty the name.
  const dotted = dottedGroupRun(tokens, text);
  const runStart = dotted?.[0];
  if (dotted !== undefined && dotted.length > 1 && runStart !== undefined) {
    const named = [...dotted];
    while (named.length > 1 && isEncodeToken(named.at(-1)?.text ?? '')) named.pop();
    const runEnd = named.at(-1);
    if (runEnd !== undefined && looksLikeGroupTag(named.map((token) => token.text).join(''), 2)) {
      return {
        tokens: tokens.slice(0, -dotted.length),
        group: text.slice(runStart.start, runEnd.start + runEnd.text.length),
      };
    }
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
 * A capital anywhere but the first character.
 *
 * "A capital after the first character" rather than "all caps" because the
 * corpus spells one tag `iTALiAN` (`Orgia Balorda iTALiAN`), and an all-caps
 * test would drop it back into the title.
 */
function hasInnerCapital(text: string): boolean {
  return /[A-Z]/.test(text.slice(1));
}

/**
 * Whether a `LANGUAGE_TERMS` member at the end of a title is a tag rather than
 * a word of the title.
 *
 * Membership is not enough, because a language name is also a surname and an
 * adjective. `Britney Dutch` is a performer on six sites and `Tyler French` is
 * another; `Perfect French Maid`, `Gorgeous Spanish Cutie` and `Fluent In
 * German` are real corpus titles. Ungated, this arm truncated
 * `EvilAngel.26.08.09.Britney.Dutch...` and
 * `TushyRaw.26.07.19.Britney.Dutch...` to `Britney`, and one of those two is an
 * imported file in the owner's library — a real rename of a real file, not a
 * hypothesis.
 *
 * Casing is the signal, because a release tag is conventionally shouted and a
 * title word is not. Measured over the whole corpus — 18 files, 10,909 unique
 * names; note `hidden/` and the extensionless `cd1-titles`/`part1-titles`, which
 * a root `*.txt` glob misses and which cost an earlier measurement 28% of its
 * input: 141 occurrences of a language term, 89 with an inner capital (`SPANISH`
 * 22, `JAPANESE` 16, `DUTCH` 14, `GERMAN` 13, `FRENCH` 8, `iTALiAN` 6, `POLISH`
 * 3, `CZECH` 3, `ENGLISH` 2, `JAP` 1, `ENG` 1) and every one a tag. Of the 52
 * without one, the walk reaches exactly the two `Britney.Dutch` releases above.
 *
 * **Known limitation, and the first place to look if a German rip ever files
 * wrongly.** Six of those 52 are genuine tags that this rule reads as title
 * words: `Fickferien.in.der.Toscana.German.2007.XXX.DVDRiP.XviD-WDE`, three
 * `Orgi.Poernchen.N.German.200X` releases and two `...2009.German_...cd1` rips.
 * Casing cannot see them — they are shouted nowhere. They are harmless *today*
 * for two reasons that are both accidents rather than guarantees: the parser
 * refuses all six outright, and a four-digit year sits between the tag and the
 * encode boundary, which halts the walk before it reaches them. Either accident
 * could stop holding — a site list that resolves `Videoram`, or a year rule that
 * lets the walk cross. The rule is right about every language tag the walk can
 * currently reach; it is not right about every language tag.
 *
 * Clause 2 — a tag run is still a tag run — keeps `Hardcore.Dutch` strippable
 * even though `Hardcore` is title case. It asks whether the previous token is
 * suffix vocabulary *on its own merits*, passing `undefined` for that token's
 * own predecessor, so a title-case language cannot lend authority it does not
 * have to the one behind it. Clause 2 alone is not enough: an earlier proposal
 * had only it and lost
 * `HollandschePassie.E34.No.Models.Assigned.DUTCH...` to `Assigned`, which is
 * not vocabulary.
 *
 * Deliberately **not** extended to `CONTENT_TYPE_TERMS`. `Hardcore`, `Solo` and
 * `Lesbian` are title case in exactly the releases this trimming exists to fix:
 * every one of the six imported files in the owner's library that this branch
 * renames is a `ClubSweethearts...Hardcore...` release, and
 * `ClubSweethearts.26.08.05.Remido.Solo...` is another. A casing rule there
 * would undo the feature.
 */
function isLanguageSuffixToken(text: string, previous: string | undefined): boolean {
  if (!isLanguageTerm(text)) return false;
  if (hasInnerCapital(text)) return true;
  return previous !== undefined && isTitleSuffixToken(previous, undefined);
}

/**
 * Whether a token immediately before the encode section is a tag rather than a
 * title word.
 *
 * Vocabulary only, and that is the point. An earlier shape of this walked from
 * the end of the name and needed clauses for encode tokens, the `XXX` marker
 * and a release-group tag, plus an exclusion so a bare sequel number survived.
 * Every one of those was fighting through a section `findEncodeSuffixStart`
 * already locates, and two of them broke: a bare digit inside `DDP5.1` halted
 * the walk mid-encode and refused the whole name, and `DD` being a Dolby
 * Digital token let a group-tag clause eat the title word after it. Both used
 * the previous token as a proxy for "inside the encode run", which title words
 * and audio tokens both defeat. Starting from the boundary instead removes the
 * need to guess.
 *
 * The language arm is the one clause that reads `previous` for anything other
 * than the `ORDINAL_WORDS` carve-out — see `isLanguageSuffixToken`.
 *
 * That arm passes `undefined` as the inner predecessor, which has a consequence
 * worth stating rather than leaving to be rediscovered: inside clause 2,
 * `isNumericIdToken` cannot see the `ORDINAL_WORDS` carve-out, so a number that
 * would be kept as an ordinal still reads as vocabulary when it is asked to
 * vouch for a language behind it. `Site.26.08.05.Name.Episode.466.Dutch.XXX...`
 * yields `Name Episode 466` — `Dutch` strips on the strength of `466`, while
 * `466` itself survives because the carve-out does apply when it is the token
 * being judged. No corpus name has that shape, and a title-final language after
 * a three-digit number is likelier a tag than a surname, so this is documented
 * rather than fixed: closing it means threading a third token through this
 * predicate, which buys nothing measurable.
 */
export function isTitleSuffixToken(text: string, previous: string | undefined): boolean {
  return (
    isContentTypeTerm(text) ||
    isLanguageSuffixToken(text, previous) ||
    isNumericIdToken(text, previous)
  );
}

/**
 * The index at which the title ends, walking back from `from` — which is where
 * the encode section begins.
 *
 * Only vocabulary tags are crossed. `minIndex` remains a hard floor, so the
 * title can never empty, and the walk stops at the first token that could be a
 * title word without looking past it: `Hiyori JAPANESE 2` keeps its tag because
 * the `2` blocks it. Skipping a kept token to reach something behind it is how
 * words go missing from the middle of a title.
 */
export function findTitleEnd(tokens: Token[], minIndex: number, from: number): number {
  let end = Math.min(from, tokens.length);
  while (end > minIndex) {
    const token = tokens[end - 1];
    if (token === undefined) break;
    if (!isTitleSuffixToken(token.text, tokens[end - 2]?.text)) break;
    end -= 1;
  }
  return end;
}

/**
 * Where the title stops and where the encode section starts. Two numbers
 * because they are no longer the same one: the tokens between them are the
 * suffix `findTitleEnd` removed, and they must reach neither the title nor
 * `extractQuality`.
 */
export interface TitleBoundary {
  readonly titleEnd: number;
  readonly encodeStart: number;
}

/**
 * Pairs the encode-boundary search with the title walk, encode first.
 *
 * `findEncodeSuffixStart` is unchanged and stays the only authority on where
 * the encode run begins; it now receives the caller's original `minIndex`
 * rather than a `titleEnd` computed from it, because the dependency runs the
 * other way. Its `null` means what it has always meant — no recognisable
 * encode section — so every caller's refusal path is unchanged.
 *
 * Tokens are passed whole rather than sliced. Callers cut the original name
 * string with `token.start`, and slicing the array would shift indices while
 * those offsets stayed absolute.
 */
export function findTitleBoundary(tokens: Token[], minIndex: number): TitleBoundary | null {
  const encodeStart = findEncodeSuffixStart(tokens, minIndex);
  if (encodeStart === null) return null;
  const titleEnd = findTitleEnd(tokens, minIndex, encodeStart);
  return { titleEnd, encodeStart };
}

/**
 * The offset in `text` at which the token at `index` begins, or the end of
 * `text` when `index` is past the last token — which happens whenever a name
 * carries no suffix at all.
 */
export function suffixOffset(tokens: Token[], index: number, text: string): number {
  return tokens[index]?.start ?? text.length;
}

/**
 * Where the title text ends, once the site has taken `siteTokens` of the tokens
 * in front of it — as an offset into `text`.
 *
 * The walk's own `minIndex` cannot answer this. It floors a *token index*, while
 * the title starts after the site, and how wide the site is is not known until
 * `matchSitePrefix` has run — which needs the token run this function bounds. So
 * the guard is applied here, on the second pass, with the site's width in hand.
 * A configured multi-token site otherwise reaches the walk's floor from the
 * other side and the trimmed title comes out empty.
 *
 * Emptying it is not worth taking. What survives in those cases is a bare site
 * id or a lone tag — `42466`, `solo`, `FRENCH` — and that is not a *wrong*
 * answer: nothing is invented, it is the site's own catalogue id, accurate and
 * merely low on information. The rule that a wrong answer beats no answer does
 * not reach a title like that, while refusing costs the user a release to repair
 * by hand. `42466` is a poor term to ask ThePornDB and a perfectly stable
 * identity, and the metadata path records a near-miss rather than confirming a
 * bad match, so a lookup that fails on it costs nothing beyond the lookup.
 *
 * **The whole remaining run is kept, not one token of it**, and that is the
 * measured half of this decision rather than the tidy one. Flooring the walk at
 * `siteTokens + 1` — keep one token, drop the rest — reads as the smaller change
 * and merges two scenes: `OF...Enokaeva_.128825778_456239169_720p` and
 * `..._456239173_480p` are different posts whose *first* id is shared, so
 * keeping only the first collapses them onto `ofepart1ekaterinaenokaeva::128825778`.
 * Two distinct scenes on one identity key is the one failure this parser must
 * never produce. That pair is the only corpus case with more than one token left
 * after its site, so the two formulations agree on the other eighteen; it decides
 * this anyway, because the merge is silent and permanent and the cost of avoiding
 * it is a longer title.
 *
 * When the walk leaves anything at all, its answer stands unchanged — including
 * for every unmatched site, where the fallback takes one token and `siteTokens`
 * is 1. `consumeSiteTld` cannot push the site to the end of the run either (it
 * declines when that would leave nothing), so a token to be the title always
 * exists.
 */
function titleEndOffsetAfterSite(
  tokens: Token[],
  text: string,
  boundary: TitleBoundary,
  siteTokens: number,
): number {
  const emptied = boundary.titleEnd <= siteTokens;
  return suffixOffset(tokens, emptied ? boundary.encodeStart : boundary.titleEnd, text);
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

export function extractQuality(tail: string, releaseGroup: string | undefined): QualityTokens {
  const haystack = normalizeSeparators(tail);

  const extras: Record<string, QualityExtra> = {};
  const container = firstMatch(CONTAINERS, haystack);
  if (container !== undefined) extras['container'] = container;
  if (VR_TOKEN.test(haystack)) extras['vr'] = true;
  if (UPSCALED_TOKEN.test(haystack)) extras['upscaled'] = true;
  if (INTERLACED_TOKEN.test(haystack)) extras['interlaced'] = true;
  // Every spelling that carries a frame rate — `4K60`, `1080p60`, `60fps` —
  // records it. Nothing scores on it (`scoreScene` reads only `upscaled` and
  // `interlaced`), but throwing the number away is what let `4K60` look like an
  // unknown word and refuse the whole name.
  const fps = /\b(?:\d{3,4}[pi]|4K|8K|UHD)(\d{2,3})\b|\b(\d{2,3})fps\b/i.exec(haystack);
  const fpsValue = fps?.[1] ?? fps?.[2];
  if (fpsValue !== undefined) extras['fps'] = Number(fpsValue);

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

/**
 * Is a leading bare domain the tracker's stamp rather than the studio's name?
 *
 * The question used to be unanswerable from the text, so the shape alone had
 * to decide it and decided it conservatively — see `MARKED_DOMAIN`. It is
 * answerable now, and from *both* ends at once, which is what makes the answer
 * safe. A studio named after its domain is a site, so its label is on the
 * confirmed list (`Bang.com` gives `Bang`); a tracker's domain is not. And the
 * field a stamp sits in front of is the studio, so it is on the list too.
 * Requiring both is what keeps `Bang.com - Alex Coal - Deep` intact even
 * before `Bang` has been learned: `Alex Coal` is not a site either, so the
 * second test fails as well and nothing is stripped.
 *
 * Membership is `siteComparisonKey`, not a slug, for the reason recorded under
 * "Site matching drops separators" — the separator-blind form is what makes
 * `Bang Bros` and `bangbros` one site, and matching on a slug here would let a
 * configured spelling fail to protect the studio it names.
 */
function isTrackerStamp(host: string, rest: string, sites: readonly string[]): boolean {
  const confirmed = new Set(sites.map(siteComparisonKey));
  const label = siteComparisonKey(host.slice(0, host.lastIndexOf('.')));
  if (label.length === 0 || confirmed.has(label)) return false;
  const next = siteComparisonKey(rest.split(SEGMENT_SPLIT)[0] ?? '');
  return next.length > 0 && confirmed.has(next);
}

function stripWebsitePrefix(name: string, sites: readonly string[]): string {
  for (const pattern of WEBSITE_PREFIXES) {
    const stripped = name.replace(pattern, '');
    if (stripped.length > 0 && stripped !== name) return stripped.trim();
  }
  // A bracketed bare domain is a tracker stamp when the name is not a
  // delimited listing — in a listing the leading bracket is normally the
  // studio field — or when the listing itself confirms it is one.
  const bracketed = BRACKETED_BARE_DOMAIN.exec(name);
  if (bracketed !== null) {
    const rest = name.slice(bracketed[0].length);
    const host = bracketed[1] ?? '';
    if (rest.length > 0 && (!SEGMENT_SPLIT.test(name) || isTrackerStamp(host, rest, sites))) {
      return rest.trim();
    }
  }
  // An unbracketed bare domain carries no marker at all, so nothing but the
  // release's own fields can say whether it is a stamp or the studio.
  const lead = BARE_DOMAIN_LEAD.exec(name);
  if (lead !== null) {
    const rest = name.slice(lead[0].length);
    if (rest.length > 0 && isTrackerStamp(lead[1] ?? '', rest, sites)) return rest.trim();
  }
  return name;
}

/**
 * Drops a poster's signature from the end of a name.
 *
 * Appended after a complete release name by whoever uploaded it, the same
 * class of noise as the runtime stamp below, and with the same effect: it
 * sits past the encode section so the trailing run no longer reaches the end.
 *
 * This one is a list of *observed posters* rather than a structural rule, and
 * that is a maintenance cost worth naming — a new poster with a new suffix
 * needs a new entry. A generic "trailing by <word>" rule was rejected because
 * ordinary titles end that way. Ten corpus titles.
 */
function stripPosterSignature(name: string): string {
  return name.replace(
    /[._-]+(?:iris2[._-]by[._-]\w+|(?:ai[._-]x2[._-]4k[._-])?suffo[._-]ed|by[._-]am)\s*$/i,
    '',
  );
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
 *
 * The site segment is spelled differently from the scene segment — it is
 * `siteComparisonKey`, alphanumerics only, where the scene is a `slug` that
 * keeps its word boundaries as `-`. The asymmetry is deliberate: the site's
 * *name* is mutable and the scene's is not. A site's name arrives from
 * whatever confirmed it — ThePornDB, or the user's config — and it can arrive
 * late, or change, or be edited; the same release that read `TouchMyWife`
 * before the site was learned reads `Touch My Wife` after. Its *identity* must
 * not move underneath the groups already keyed by it. So the key holds the one
 * form every spelling collapses to, which is exactly the form site matching
 * already compares. Two spellings that match as one site now key as one site.
 * The canonical spelling is not lost — it is `display.subtitle`, which is what
 * the user sees and what `path-template.ts` renders.
 */
export function buildRelease(
  site: string,
  anchor: AnchorSpan | null,
  sceneTitle: string,
  sceneSlug: string,
  quality: QualityTokens,
  extraFields: readonly DisplayField[] = [],
): ParsedRelease | null {
  const siteSlug = siteComparisonKey(site);
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

  // Between the anchor and the scene, so a caller adding a field never gets
  // between the two that every release has.
  fields.push(...extraFields);

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
export interface AnchorSpan {
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
export function findSceneDate(tokens: Token[]): AnchorSpan | null {
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
        // Some feeds restate the year in full right after the short date:
        // `ManyVids.26.08.02.2026.August.Heat.2`. Swallowed only when it
        // agrees with the date already read — a year that disagrees is title
        // material, as in `26.08.02.1999.Party.Classics`. Left in place it
        // became the first word of the identity, so the same scene posted
        // without the repeat keyed differently.
        const repeated = tokens[index + 3];
        const end =
          repeated !== undefined && repeated.text === String(expandYear(text))
            ? repeated.start + repeated.text.length
            : day.start + day.text.length;
        return { kind: 'date', key: iso, startOffset: token.start, endOffset: end };
      }
    }

    // Day first with a four-digit year, `19.04.2014`, which European sites
    // write. Tried after the year-first shapes so it can never capture a
    // position one of those already reads: those require a two-digit final
    // token and this requires a four-digit one, so the two cannot both match.
    //
    // `04.08.2026` is 4 August, not 8 April. The ambiguity is real and
    // unresolvable from the name, so it follows the same day-first convention
    // the delimited reader already uses rather than inventing a second one.
    const year = tokens[index + 2];
    if (
      month !== undefined &&
      year !== undefined &&
      /^\d{1,2}$/.test(text) &&
      /^\d{1,2}$/.test(month.text) &&
      /^(?:19|20)\d{2}$/.test(year.text)
    ) {
      const iso = toIsoDate(Number(year.text), Number(month.text), Number(text));
      if (iso !== null) {
        return {
          kind: 'date',
          key: iso,
          startOffset: token.start,
          endOffset: year.start + year.text.length,
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
 *
 * Exported because `buildRelease` spells the identity key's site segment with
 * it. Matching and keying have to be the same rule or a site can match as one
 * and key as two, which is exactly the bug that put this here: two expressions
 * for one rule drifted apart.
 */
export function siteComparisonKey(value: string): string {
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

export interface SiteMatch {
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

export function matchSitePrefix(before: Token[], sites: readonly string[]): SiteMatch | null {
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
 * list and falling back to the first token. Moving the split changes where a
 * scene files, never what it collates with: every token the *title bound*
 * keeps reaches the identity key whether it lands in the site half or the
 * scene half, so no split can make two different scenes collide.
 *
 * The suffix tokens past that bound are a separate matter. They reach neither
 * half, and two names differing only in them collate as one — an accepted
 * cost, unchanged by where the split falls.
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
interface DateAtEnd {
  /**
   * Site and title, with the encode section already removed — and with the
   * suffix tokens the walk dropped still present, because this is what
   * `matchSitePrefix` and `sceneSiteCandidates` read. A configured site can
   * span those tokens (`OF E Part1 Ekaterina Enokaeva` spans two numeric ids),
   * and cutting them off here does not shorten a title, it only starves site
   * matching: `matchSitePrefix` never consumes every token it is given, so a
   * two-token site in a two-token `before` cannot match at all and the site
   * silently degrades to its first word.
   */
  readonly before: Token[];
  /**
   * Where the *title text* ends, as an offset into the name, given how many of
   * `before`'s tokens the site turned out to take. A second answer because it is
   * a different question from where `before` stops, and a function of the site's
   * width because the two are not independent — see `titleEndOffsetAfterSite`.
   *
   * An offset rather than a token index, and named for it: `TitleBoundary`'s
   * `titleEnd` is an index into an array, and one word for two units is how the
   * wrong one gets passed.
   */
  readonly titleEndOffset: (siteTokens: number) => number;
  /** The encode text, for `extractQuality`. */
  readonly tail: string;
  readonly group: string | undefined;
}

function dateAtEndPrefixTokens(
  name: string,
  tokens: Token[],
  date: AnchorSpan,
): DateAtEnd | null {
  const before = tokens.filter((token) => token.start + token.text.length <= date.startOffset);
  const after = tokens.filter((token) => token.start >= date.endOffset);

  // The date is the very last thing in the name, so the encode section — if
  // there is one — sits ahead of it rather than behind:
  // `site_performer_title-2160p-18.12.18`. Structurally this is the same shape
  // read from the other side, and the encode boundary does the same job the
  // trailing run does in the ordinary case. `minIndex` is 2 so at least one
  // token can be the site and one the title.
  if (after.length === 0) {
    const beforeText = name.slice(0, date.startOffset).replace(/[.\s_-]+$/, '');
    const beforeTokens = tokensOf(beforeText);
    const boundary = findTitleBoundary(beforeTokens, 2);
    if (boundary === null) return null;
    const encodeToken = beforeTokens[boundary.encodeStart];
    if (encodeToken === undefined) return null;
    return {
      before: beforeTokens.slice(0, boundary.encodeStart),
      titleEndOffset: (siteTokens) =>
        titleEndOffsetAfterSite(beforeTokens, beforeText, boundary, siteTokens),
      tail: beforeText.slice(encodeToken.start),
      group: undefined,
    };
  }

  if (before.length <= after.length) return null;

  const tail = name.slice(date.endOffset).replace(/^[.\s_-]+/, '');
  const detached = detachReleaseGroup(tokensOf(tail), tail);
  if (detached.tokens.length === 0) return null;
  if (!detached.tokens.every((token) => isEncodeToken(token.text))) return null;

  // Here the date itself ends the title — the encode section is behind it, so
  // there is no run of suffix tokens between the two for a walk to cross and
  // `findTitleBoundary` is never called on this path. The bound is the last
  // pre-date token, not `date.startOffset`, so the separator in front of the
  // date is not part of the title, and it does not depend on the site's width:
  // with no walk there is nothing for a site to consume the title through, and
  // `matchSitePrefix` always leaves a token behind.
  //
  // **No walk means no suffix trimming on this path, and that is an asymmetry
  // rather than a decision.** `Bang.Bros.Solo.42466.18.12.18.1080p.MP4-WRB`
  // keeps `Solo 42466` in its title, while the same tokens either side of a
  // leading date — `Bang.Bros.18.12.18.Solo.42466.1080p...` — lose them. Where
  // the date sits decides it. Extending the walk here is not obviously right:
  // the suffix would have to be recognised without an encode run adjacent to it,
  // which is the adjacency-proxy guessing that caused the two defects the
  // inverted boundary search fixed (design §4). Left as it is, deliberately,
  // and measured as unchanged from the base commit — but it is the last place in
  // the dotted family where the two indices are still one number, so a future
  // reader looking for the next inconsistency should start here.
  const lastBefore = before.at(-1);
  if (lastBefore === undefined) return null;
  const beforeEnd = lastBefore.start + lastBefore.text.length;

  return {
    before,
    titleEndOffset: () => beforeEnd,
    tail,
    group: detached.group,
  };
}

function parseDateAtEndForm(
  name: string,
  tokens: Token[],
  date: AnchorSpan,
  options: SceneParseOptions,
): ParsedRelease | null {
  const shape = dateAtEndPrefixTokens(name, tokens, date);
  if (shape === null) return null;
  const before = shape.before;

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

  // The identity ends where the shape says the title does, which is neither
  // the date nor the last token `before` kept — three different places when the
  // date trails the name. Slicing to the date would leave `2160p` in the title
  // because the encode section sits between the two; slicing to the end of
  // `before` would leave the suffix tokens `before` deliberately keeps so that
  // a multi-token site can still be matched across them. The site's width goes
  // in because the title cannot end before the site does.
  const sceneText = prettify(name.slice(firstSceneToken.start, shape.titleEndOffset(siteTokens)));
  if (site.length === 0 || sceneText.length === 0) return null;
  if (sceneText.toUpperCase() === MARKER_TOKEN) return null;

  return buildRelease(
    site,
    date,
    sceneText,
    slug(sceneText),
    extractQuality(shape.tail, shape.group),
  );
}

/**
 * The same two-index split `DateAtEnd` carries, for the dateless shape: what
 * site matching may read, and where the title stops. They diverge whenever the
 * suffix walk drops anything, and `parseDatelessForm` needs both.
 */
interface DatelessPrefix {
  readonly before: Token[];
  /** An offset into the name, as in `DateAtEnd` — not a token index. */
  readonly titleEndOffset: (siteTokens: number) => number;
  readonly tail: string;
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
function datelessPrefixTokens(name: string): DatelessPrefix | null {
  const detached = detachReleaseGroup(tokensOf(name), name);
  const boundary = findTitleBoundary(detached.tokens, 2);
  if (boundary !== null) {
    const encodeToken = detached.tokens[boundary.encodeStart];
    if (encodeToken !== undefined) {
      // Both indices are carried because the two answers differ. `before`
      // reaches to the encode boundary so `matchSitePrefix` and
      // `sceneSiteCandidates` see every token a configured site might span,
      // including the ones the walk dropped; `titleEndOffset` is where the
      // title stops, which is short of that whenever the walk dropped
      // anything.
      return {
        before: detached.tokens.slice(0, boundary.encodeStart),
        titleEndOffset: (siteTokens) =>
          titleEndOffsetAfterSite(detached.tokens, name, boundary, siteTokens),
        tail: name.slice(encodeToken.start),
      };
    }
  }

  // No encode boundary either. That used to end it, but the boundary was only
  // ever needed to find where the title *stops* — and a confirmed site says
  // where the title *starts*, which is the same information from the other
  // end. `TripForFuck - Hiyori JAPANESE 2` has no date and no encode
  // vocabulary; once the site is known there is nothing left to guess.
  //
  // The whole run is offered, and the caller still requires a confirmed site
  // match against it. Nothing is admitted here that was not already gated on
  // that, so a name with no recognisable site is refused exactly as before.
  //
  // The title bound is the end of the name, and the vocabulary walk is
  // deliberately not run here. What licenses the walk elsewhere is the encode
  // boundary: the tokens it crosses sit between the title and a *recognised*
  // encode section, and that adjacency is the evidence they are metadata. On
  // this path there is no such section — that is what brought us here — so a
  // trailing `Solo` or a trailing number has nothing marking it as a tag, and
  // `TripForFuck - Hiyori JAPANESE 2` is the shape this path exists for. It is
  // the same argument `parseSceneForm` makes for a dated name whose remainder
  // carries no encode vocabulary at all: with no encode section, the whole
  // remainder is the title.
  const tokens = tokensOf(name);
  return tokens.length >= 2
    ? { before: tokens, titleEndOffset: () => name.length, tail: '' }
    : null;
}

/**
 * A name opening with a bare `4K` and then only words:
 * `4K.kleo.34ans.de.clapiers`.
 *
 * A resolution cannot be a site, so these carry no site anywhere in the text
 * and nothing can be looked up — 24 corpus titles, all distinct, none present
 * in ThePornDB. They are Jacquie et Michel TV's output, which also appears in
 * the same feeds under its own name, so they are filed there rather than
 * under a bucket of their own: `JacquieEtMichelTV.26.06.02.Lena.XXX.2160p`
 * and `4K.kleo.34ans.de.clapiers` belong in one directory.
 *
 * This is a named case rather than a structural rule. The site is not
 * detected from the text — it cannot be, there is nothing there — so another
 * poster opening names with a bare resolution would be filed here wrongly. No
 * other bare-resolution lead appears in the corpus. The `4K` is still read as
 * the resolution it is.
 *
 * The prefix alone is not enough to enter the branch; see `isBare4kPoster`.
 */
const BARE_4K_PREFIX = /^4K[.\-_ ]/i;

/**
 * The admission test that keeps the branch from being a first-token fallback
 * in disguise: a bare `4K`, then words, and nothing that is encode vocabulary
 * or the marker.
 *
 * The prefix on its own admitted any release at all that happened to open
 * with `4K`. `4K.Alex.Coal.XXX.1080p.MP4-WRB` was filed under a hardcoded
 * site on no evidence, with the marker and the whole encode section swallowed
 * into both the title and the identity key, and — worse than the misfiling —
 * `extractQuality('4K', …)` recorded 2160 for a 1080p release, so it outranked
 * the genuine 2160p encode of whatever it landed beside. A wrong score, not
 * merely a wrong path.
 *
 * It also re-opened the hole the rest of `parseDatelessForm` exists to close.
 * That function deliberately has no first-token fallback, because without a
 * date `Some.Random.Movie.2023.1080p.BluRay-GRP` has exactly the dateless
 * shape and a confirmed site is what replaces the date as evidence that the
 * name is a scene release at all. This branch needs no confirmation, so every
 * name it admits without one is that argument being ignored.
 *
 * The vocabulary test is `parseSceneForm`'s, used from the other end. There it
 * licenses reading a whole remainder as title — with no encode section there
 * is no run to mistake for title and no title to mistake for a run. Here the
 * same fact is what makes the name *look like* this poster's, so it is an
 * admission test rather than a parsing rule. `MARKER_TOKEN` is checked
 * alongside it because `XXX` is not encode vocabulary but ends a title
 * everywhere else, so a name carrying one has structure this branch cannot
 * read.
 *
 * A name that fails the test is not refused here. It falls through to the
 * ordinary `datelessPrefixTokens` / `matchSitePrefix` path and is judged by
 * the same rules as every other dateless name, which without a confirmed site
 * means a visible `parse_error` row rather than a silent group with a
 * resolution wrong by a factor of four. That is the documented preferred
 * direction, and it is what the residue rests on: `4K.Ultra.Collection.2023`
 * carries no encode vocabulary either, so it still lands here. A bare
 * resolution followed only by words is genuinely indistinguishable from this
 * poster, and this test does not pretend otherwise.
 */
function isBare4kPoster(name: string): boolean {
  if (!BARE_4K_PREFIX.test(name)) return false;
  return !tokensOf(name.replace(BARE_4K_PREFIX, '')).some(
    (token) => isEncodeToken(token.text) || token.text.toUpperCase() === MARKER_TOKEN,
  );
}

/**
 * Spelled as the site's own releases spell it, so the two agree on a slug
 * with no configuration at all. A configured or discovered spelling still
 * wins — see `canonicalSiteName` — because otherwise setting the site in
 * config would split it across two directories.
 */
const BARE_4K_SITE = 'JacquieEtMichelTV';

/**
 * The configured or discovered spelling of a site named literally in code.
 *
 * Without this the hardcoded name and the list's name are two sites whenever
 * they differ by a space, which is exactly the split `matchSitePrefix` exists
 * to prevent for names read out of a release.
 */
export function canonicalSiteName(name: string, sites: readonly string[]): string {
  const key = siteComparisonKey(name);
  for (const site of sites) {
    if (siteComparisonKey(site) === key) {
      const display = prettify(site);
      if (display.length > 0) return display;
    }
  }
  return name;
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
  if (isBare4kPoster(name)) {
    const title = prettify(name.replace(BARE_4K_PREFIX, ''));
    if (title.length === 0) return refuse('nothing follows the leading 4K');
    const site = canonicalSiteName(BARE_4K_SITE, options.sites ?? []);
    const release = buildRelease(site, null, title, slug(title), extractQuality('4K', undefined));
    // Every other shape reads its site out of the name. This one is told, and
    // a second bare-resolution poster would be told the same thing just as
    // confidently, so the card says where the site came from instead of
    // presenting an inference as something observed.
    release?.display.fields.push({ label: 'Site source', value: 'inferred from the leading 4K' });
    return release;
  }

  const prefix = datelessPrefixTokens(name);
  if (prefix === null) return refuse('no date and no trustworthy encode boundary');

  const match = matchSitePrefix(prefix.before, options.sites ?? []);
  if (match === null) return refuse('no date, and the site is not in the known list');

  const siteTokens = consumeSiteTld(prefix.before, match.tokenCount);
  const firstSceneToken = prefix.before[siteTokens];
  if (firstSceneToken === undefined) return refuse('no date, and the site name uses every token');

  // On the no-boundary path the whole run was offered, so nothing has removed
  // an encode section — there was no trustworthy place to cut one. If what
  // follows the site *starts* with encode vocabulary then the name is site
  // plus encode with no scene at all, as in `Brazzers.1080p.MP4-WRB`, and the
  // title would be the encode section verbatim.
  if (prefix.tail.length === 0 && isEncodeToken(firstSceneToken.text)) {
    return refuse('no date, and nothing between the site and the encode section');
  }

  // `titleEndOffset`, not `name.length - prefix.tail.length`. That subtraction
  // is the encode boundary, so it left every suffix token the walk dropped in
  // the title — `TripForFuck.Hiyori.Suzuki.Solo.42466.1080p.MP4-WRB` came back
  // as `Hiyori Suzuki Solo 42466`, which is this feature's own motivating
  // example going unfixed in this shape. The site's width goes in for the same
  // reason it does in the date-at-end shape: a matched site here can be most of
  // the run, and the title may not end before the site does.
  const sceneText = prettify(name.slice(firstSceneToken.start, prefix.titleEndOffset(siteTokens)));
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

  // Canonicalised like every other path's site. Without this a configured
  // spelling splits one site in two: the dated releases keep the release's
  // own `JacquieEtMichelTV` while the date-at-end and dateless ones take the
  // configured `Jacquie Et Michel TV`, and the same site files under two
  // directories. A test for the bare-4K poster is what surfaced it.
  const site = canonicalSiteName(prettify(name.slice(0, date.startOffset)), options.sites ?? []);
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
  const boundary = findTitleBoundary(detached.tokens, 1);
  if (boundary === null) return refuse('no trustworthy encode boundary after the date');
  const encodeToken = detached.tokens[boundary.encodeStart];
  if (encodeToken === undefined) return refuse('no trustworthy encode boundary after the date');

  const sceneText = prettify(rest.slice(0, suffixOffset(detached.tokens, boundary.titleEnd, rest)));
  if (sceneText.length === 0) return refuse('no title between the date and the encode section');
  // A "title" made only of the marker carries no discriminating content, so
  // two unrelated scenes on one site and day would collide on it.
  if (sceneText.toUpperCase() === MARKER_TOKEN) return refuse('title is only the XXX marker');

  const tail = rest.slice(encodeToken.start);
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
 * The listing form's part separator, removed from *inside* a part.
 *
 * `parseDelimitedForm` joins its parts with ` - ` to make `display.title`, and
 * that join is only reversible while no part contains the separator itself.
 * A part normally cannot: `SEGMENT_SPLIT` has already cut the name on every
 * ` - ` it contained. But `prettify` puts one back — it rewrites `.` and `_`
 * as spaces, so the single segment `Kylie.-.Page` becomes the part
 * `Kylie - Page`, and the two-part title `[Kylie - Page, Turner]` then renders
 * exactly like the three-part `[Kylie, Page, Turner]`.
 *
 * That is not a cosmetic clash. Those are two different scenes with two
 * different keys (`kylie-page--turner` and `kylie--page--turner`), and
 * `sceneToManualValues` hands the edit form `display.title` while
 * `sceneFromManualValues` recovers the parts by splitting it on ` - ` — so
 * opening Edit on the first and saving it unchanged re-keyed it as the second,
 * merging two scenes and deleting a group. The identity-key preview showed the
 * wrong key with equal confidence, because it is built from the same values.
 *
 * The fix belongs here rather than in the form because `display.title` is what
 * is lossy, and it is fixed by making the join injective again: collapse the
 * separator inside a part so ` - ` occurs only *between* parts. One pass is
 * enough — `prettify` has already collapsed whitespace runs and stripped the
 * edges, so the `-` this writes is never adjacent to a space and cannot form a
 * fresh separator.
 *
 * No identity key moves. `slug()` collapses any run of non-alphanumerics to a
 * single `-`, so `slug('Kylie - Page')` and `slug('Kylie-Page')` are both
 * `kylie-page`; only the displayed spelling changes, from `Kylie - Page` to
 * `Kylie-Page`. That is what makes this safe to apply to a populated database,
 * where a key change would silently relocate files already on disk.
 */
function collapsePartSeparator(part: string): string {
  return part.replaceAll(' - ', '-');
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

  // Deliberately `findEncodeSuffixStart` alone, not `findTitleBoundary` — the
  // walk is scoped out of *this code path*, which is not the same as scoping it
  // out of the listing shape. A part's title here has no fixed order
  // (`sceneSlugFromParts` sorts on exactly that basis), so a trailing
  // content-type tag or numeric id is not reliably *trailing* information the
  // way it is in the dotted form, and `findTitleBoundary` passing
  // `minIndex: 0` here let the walk consume an entire part down to nothing:
  // `[Site] Alex - Hardcore 42466 1080p - 2026-08-05` and the same with
  // `42467` both lost their whole distinguishing part and collapsed onto one
  // identity key. Two distinct scenes sharing a key is the one failure this
  // parser must never produce, so this path keeps the single, unsplit cut it
  // had before this change — see design doc §6, which named this shape as an
  // unmeasured judgement call and said the fix, if it ever misfired, is to
  // scope the rule out here rather than patch the walk.
  //
  // Only a four-digit year reaches here. Written `26.08.05`, the same listing
  // is a dotted name to `DOTTED_DATE_RUN` and goes to the date-at-end shape
  // instead, where the walk does run and the two parts above *do* collapse
  // onto `site:2026-08-05:alex`. That collision is inside the accepted class
  // — one site, one date, titles differing only in the tokens `findTitleEnd`
  // drops — so it is not a defect, but it is not excluded either,
  // and a comment claiming the shape is safe would be wrong. Both spellings
  // are pinned by tests in `parse-date-at-end.test.ts`.
  let tokens = tokensOf(text);

  // A hyphen-attached group inside a quality segment: `- 1080p-GRP -`. Nothing
  // else on this path finds one — the bracket loop above wants `[...]`/`{...}`,
  // and the cut below never fires, because the backward walk stops on the group
  // tag itself and there is nothing behind it to anchor on. So the whole
  // segment used to reach `titleParts`, putting a group in the identity key and
  // taking the resolution out of `extractQuality`'s reach entirely.
  //
  // The gate is the whole design. `detachReleaseGroup`'s hyphen branch is
  // deliberately permissive, because no shape rule separates `-Ghost` from
  // `-Bonus` — and in a listing a hyphen is
  // ordinary punctuation as well as a group separator, so detaching
  // unconditionally would read `Deep-Throat` as the scene "Deep" from a group
  // called "Throat". Requiring the cut on what remains to be exactly `0` means
  // the detach is accepted only when the remainder is encode information from
  // its *first* token — only when the segment contributed no title at all. That
  // is the dotted form's positional argument ("a tag reads as a group because of
  // where it sits, behind the encode section") applied to a segment rather than
  // a whole name, and it is self-validating: a wrong detach leaves title
  // material at index 0, the cut does not land there, and the detach is dropped.
  const detached = detachReleaseGroup(tokens, text);
  if (detached.group !== undefined && findEncodeSuffixStart(detached.tokens, 0) === 0) {
    // The bracketed form keeps precedence; this only fills a gap it left.
    if (group === undefined) group = detached.group;
    tokens = detached.tokens;
    const last = tokens.at(-1);
    if (last !== undefined) text = text.slice(0, last.start + last.text.length);
  }

  const cut = findEncodeSuffixStart(tokens, 0);
  const cutToken = cut === null ? undefined : tokens[cut];
  if (cutToken !== undefined) {
    quality.unshift(text.slice(cutToken.start));
    text = text.slice(0, cutToken.start);
  }

  return { title: collapsePartSeparator(prettify(text)), quality: quality.join(' '), group };
}

function parseDelimitedForm(name: string, options: SceneParseOptions): ParsedRelease | null {
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
  const otherDates: string[] = [];
  const residues: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    // Every segment is asked, not just the ones ahead of the anchor. Asking
    // only while `dateIso` was null meant a second date was never examined at
    // all: it fell through to `residues` untested, `splitSegment` found no
    // encode token in `2024-01-02` so it survived whole, and
    // `sceneSlugFromParts` sorted it into the scene slug ahead of the
    // performer — so the same scene listed without it never collated.
    const found = findSegmentDate(segment);
    if (dateIso === null) {
      if (found !== null) {
        dateIso = found.iso;
        // A leading segment that is *only* a date cannot also be the studio.
        if (index === 0 && site === null && found.before.length === 0) return null;
        const residue = [found.before, found.after].filter((part) => part.length > 0).join(' ');
        residues.push(residue);
        continue;
      }
    } else if (found !== null && found.before.length === 0 && found.after.length === 0) {
      // Nothing but a date, so it is not title material and leaves the
      // identity. `before`/`after` are what `splitAround` already computes, so
      // the test costs nothing. A segment holding a date *and* other text —
      // `- Party 2024-01-02 -` — stays a title part: text around a date is
      // evidence the date belongs to the title, and there is nothing here to
      // justify splitting the segment.
      otherDates.push(found.iso);
      continue;
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

  // This is the one parser shape whose parts have no fixed order — see
  // `sceneSlugFromParts` for why they are sorted and why the join is `--`.
  //
  // The `Second date` label describes the date's *position*, not its meaning.
  // The parser cannot tell a posting date from a scrape date from a re-release
  // date, and a label that claimed to would be a guess rendered into the UI.
  // It is a field and not `display.date` for the reason `buildRelease` gives
  // about the episode anchor: that field carries a real scene date or nothing.
  return buildRelease(
    canonicalSiteName(site, options.sites ?? []),
    { kind: 'date', key: dateIso, startOffset: 0, endOffset: 0 },
    titleParts.join(' - '),
    sceneSlugFromParts(titleParts),
    extractQuality(qualityParts.join(' '), group),
    otherDates.map((iso) => ({ label: 'Second date', value: iso })),
  );
}

export interface SceneParseOptions {
  /**
   * Known site names — configured plus discovered. Spelling is free: matching
   * is on `siteComparisonKey`, so case and separators do not have to agree
   * with the release.
   *
   * Two shapes need the list to find the site at all: the date-at-end one,
   * where nothing in the name separates site from title (unmatched, it falls
   * back to the first token), and the dateless one, which is refused without
   * it. `stripWebsitePrefix` reads it for a third purpose — deciding whether a
   * leading bare domain is a tracker's stamp or the studio's own name — and
   * that decision is *only* made when the list settles it, so an empty list
   * leaves every name reading exactly as it did before the list existed.
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

  const name = stripFileExtension(
    stripWebsitePrefix(stripPosterSignature(stripRuntimeStamp(trimmed)), options.sites ?? []),
  ).trim();
  if (name.length === 0) return null;
  // The delimited form has explicit boundaries, so it never needs a lookup.
  if (parseDelimitedForm(name, options) !== null) return null;

  const tokens = tokensOf(name);
  const date = findSceneDate(tokens);

  // A dateless name needs the same lookup, and needs it more: it has no
  // fallback, so an unconfirmed site means the name is refused entirely.
  // The bare-4K poster is handled locally and has no site to find.
  if (BARE_4K_PREFIX.test(name)) return null;

  const before =
    date === null
      ? (datelessPrefixTokens(name)?.before ?? null)
      : (dateAtEndPrefixTokens(name, tokens, date)?.before ?? null);
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

  const name = stripFileExtension(
    stripWebsitePrefix(stripPosterSignature(stripRuntimeStamp(trimmed)), options.sites ?? []),
  ).trim();
  if (name.length === 0) return refuse('nothing left after stripping prefix/extension');

  if (NOT_VIDEO_TOKEN.test(name)) return refuse('not a video release (image or photo set)');

  const result = parseDelimitedForm(name, options) ?? parseSceneForm(name, options);
  if (result !== null) lastRefusal = null;
  return result;
}
