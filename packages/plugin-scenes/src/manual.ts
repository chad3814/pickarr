import type {
  ManualField,
  ParsedRelease,
  QualityExtra,
  QualityTokens,
} from '@pickarr/plugin-api';
import {
  buildRelease,
  canonicalSiteName,
  extractQuality,
  findSceneDate,
  lastRefusalReason,
  matchSitePrefix,
  SCENE_COMPONENT_BOUNDARY,
  sceneSlugFromParts,
  slug,
  toIsoDate,
  tokensOf,
  type AnchorSpan,
  type SceneParseOptions,
} from './parse.ts';

/**
 * The form a human fills in to describe a scene release by hand.
 *
 * Nothing here is stored: only the `ParsedRelease` these values build is, and
 * `sceneToManualValues` reconstructs the form from that on demand. So a field
 * renamed later orphans no data — but a field *missing* here does lose data,
 * because a quality token the form cannot represent is dropped the first time
 * a human edits the release that carries it.
 */
const FIELDS: readonly ManualField[] = Object.freeze([
  { name: 'site', label: 'Site', type: 'text', scope: 'identity', required: true },
  {
    name: 'anchorKind',
    label: 'Anchor',
    type: 'select',
    scope: 'identity',
    required: true,
    options: ['date', 'episode', 'none'],
    help: 'What separates this scene from the rest of the site',
  },
  { name: 'date', label: 'Date', type: 'text', scope: 'identity', placeholder: 'YYYY-MM-DD' },
  { name: 'episode', label: 'Episode', type: 'text', scope: 'identity', placeholder: 'E1178' },
  { name: 'title', label: 'Scene', type: 'text', scope: 'identity', required: true },
  {
    name: 'titleOrder',
    label: 'Title order',
    type: 'select',
    scope: 'identity',
    options: ['fixed', 'any'],
    help: "Choose 'any' when the parts either side of ` - ` may appear in either order",
  },
  {
    name: 'resolution',
    label: 'Resolution',
    type: 'select',
    scope: 'quality',
    // The display spellings, because the form renders options verbatim. The
    // trailing `p` is stripped on the way into `quality.resolution`, which is
    // a number.
    options: ['', '4320p', '2160p', '1440p', '1080p', '720p', '540p', '480p'],
  },
  { name: 'source', label: 'Source', type: 'text', scope: 'quality' },
  { name: 'videoCodec', label: 'Video codec', type: 'text', scope: 'quality' },
  { name: 'audioCodec', label: 'Audio codec', type: 'text', scope: 'quality' },
  { name: 'releaseGroup', label: 'Release group', type: 'text', scope: 'quality' },
  { name: 'container', label: 'Container', type: 'text', scope: 'quality' },
  { name: 'vr', label: 'VR', type: 'select', scope: 'quality', options: ['', 'yes'] },
  { name: 'upscaled', label: 'Upscaled', type: 'select', scope: 'quality', options: ['', 'yes'] },
  {
    name: 'interlaced',
    label: 'Interlaced',
    type: 'select',
    scope: 'quality',
    options: ['', 'yes'],
  },
]);

export function sceneManualFields(): readonly ManualField[] {
  // Frozen rather than copied per call: `readonly` is erased at runtime, so a
  // caller that pushes onto what it is handed would otherwise edit the schema
  // every later caller reads.
  return FIELDS;
}

/** The permitted values of a `select` field, or `null` for the other types. */
function optionsFor(name: string): readonly string[] | null {
  const field = FIELDS.find((candidate) => candidate.name === name);
  if (field === undefined || field.type !== 'select') return null;
  return field.options ?? null;
}

/**
 * The scene slug, built the way whichever parser shape produced this release
 * built it.
 *
 * `slug(title)` alone is wrong and so is always splitting on ` - `. The
 * bracketed-listing shape sorts its title parts and joins them; every other
 * shape slugs the title whole. Punctuation cannot tell the two apart, because
 * a dotted name containing `.-.` yields a display title with ` - ` in it and a
 * scene slug with no component boundary — so the caller states which rule
 * applies rather than this function guessing, and an edit can no longer
 * silently re-key `alex-coal` to `coal--alex`.
 *
 * The `any` branch is the parser's own `sceneSlugFromParts` and not a copy of
 * it: the sort and the boundary are the identity model, and a second spelling
 * of them here is a second identity model.
 */
function sceneSlugFor(title: string, order: string): string {
  if (order !== 'any') return slug(title);
  return sceneSlugFromParts(title.split(' - '));
}

/**
 * The title to prefill: the stored display title when it actually rebuilds the
 * key it sits beside, and a spelling derived from that key when it does not.
 *
 * Why this is checked rather than trusted. `sceneToManualValues` reads every
 * other structural fact off the identity key because the display is lossy
 * about how it was made; the title was the one field still taken on faith, and
 * a stored display can describe a *different* multiset of parts than its own
 * key. `media_groups.display` is written once, by the first ingest, and never
 * rewritten — so a row parsed before `collapsePartSeparator` existed still
 * carries the title `Kylie - Page - Turner` next to the key
 * `vixen:2023-07-19:kylie-page--turner`, and no amount of fixing the parser
 * reaches it. Prefilling that title and saving it back untouched splits it on
 * ` - ` into three parts and keys the group as `kylie--page--turner`: a merge
 * into a different scene where one exists, and where none does, a silent
 * re-key that moves a library directory of files already on disk. Verifying
 * costs one slug rebuild and closes that for stored rows and future ones
 * alike, with no backfill and no dependence on the parse-side collapse.
 *
 * What the fallback gives up. The key holds slugs, so splitting it recovers
 * the parts but not their casing or word spacing: `kylie-page - turner` rather
 * than `Kylie-Page - Turner`. That is a real cost and it is the right trade —
 * the title is on screen in front of a human who can correct it, whereas a
 * prefill that rebuilds the wrong key is acted on silently. What the fallback
 * must *not* give up is the round trip, and it does not: `slug` is idempotent
 * on its own output, the key's parts are already sorted, and empty parts
 * cannot occur in a key — so feeding these values back through
 * `sceneFromManualValues` reproduces `sceneSlug` byte for byte. The same holds
 * for the `fixed` branch, where the fallback is the scene slug itself.
 */
function titleForSceneSlug(displayTitle: string, sceneSlug: string, order: string): string {
  if (sceneSlugFor(displayTitle, order) === sceneSlug) return displayTitle;
  return order === 'any' ? sceneSlug.split(SCENE_COMPONENT_BOUNDARY).join(' - ') : sceneSlug;
}

/**
 * The site to prefill: the stored subtitle when it actually rebuilds the key
 * segment it sits beside, the segment's own spelling when that rebuilds it
 * instead, and the subtitle again when *nothing* can — see the proof below for
 * why those three branches are the whole space.
 *
 * Why this is checked rather than trusted, and why the site needs its own
 * check even though the title already has one. `sceneToManualValues` reads
 * every structural fact off the key; the site was the last field still copied
 * from `media.display.subtitle`, and the rebuild does not use it raw — it runs
 * it through `canonicalSiteName` first. That function matches on
 * `siteComparisonKey`, which deletes separators, while the key is built with
 * `slug`, which keeps them as `-`. So `Bangbros` and `Bang Bros` compare as one
 * site and key as two (`bangbros` vs `bang-bros`). `learnSites` grows the site
 * list from the metadata service on every feed batch, so the list at Edit time
 * is routinely not the list at ingest time, and a spelling learned in between
 * turns a prefill into a re-key.
 *
 * Why the record's own key wins over the newly-learned spelling. There is a
 * real argument the other way: the parser now keys that site `bang-bros`, so
 * that is where the group's future siblings land, and converging on it is where
 * the data wants to go. But it must not happen on a save the user believes
 * changed nothing. A no-op save is a no-op. A user who wants the new spelling
 * can retype the site and watch the identity preview show the new key before
 * committing to it — that is a decision, whereas a prefill that quietly rebuilds
 * a different key moves a group, and the library directory under it, with
 * nothing on screen to say so.
 *
 * What the fallback gives up, and why that is the right trade. The key holds a
 * slug, so the second branch loses the display casing: `Bang Bros` comes back
 * as `bang-bros`, `Bangbros` as `bangbros`. Exactly the cost `titleForSceneSlug`
 * pays, for exactly the same reason — the value is on screen in front of a
 * human who can correct it, whereas a prefill that rebuilds the wrong key is
 * acted on silently.
 *
 * Why two probes exhaust the possibilities. Write `C(v)` for
 * `slug(canonicalSiteName(v, sites))` and `s` for the key's site segment. Note
 * first that `siteComparisonKey(v)` is exactly `slug(v)` with its `-` removed —
 * both erase the same character class — so any `v` with `slug(v) === s` has the
 * same comparison key as `s` and therefore lands in the same match class.
 * `canonicalSiteName` maps a whole class to one string, so `C` is constant on
 * the class: either some configured site matches, in which case every member
 * yields that site's prettified spelling, or none does, in which case `C(v)` is
 * `slug(v)`. Either way, if any value `v` satisfies `C(v) === s` then `s`
 * itself does. Probing the subtitle and then `s` therefore finds a
 * key-preserving prefill whenever one exists, and the third branch is not a
 * missed case but a proof that the key cannot be expressed at all: a site
 * spelling has been learned that collapses this key's class onto a different
 * slug. Restoring the key there is not something a prefill can do — it needs
 * either an identity model whose site segment is separator-insensitive (i.e.
 * `siteComparisonKey`, which is already what "same site" means everywhere else)
 * or an edit path that hands the plugin the key it is editing. Both are larger
 * changes than a prefill; until one lands, that case behaves exactly as it did
 * before this check existed, which is why the third branch returns the subtitle
 * rather than a slug the rebuild would discard anyway.
 */
function siteForKeySegment(
  subtitle: string,
  siteSlug: string,
  sites: readonly string[],
): string {
  const rebuilds = (value: string): boolean => slug(canonicalSiteName(value, sites)) === siteSlug;
  if (rebuilds(subtitle)) return subtitle;
  if (rebuilds(siteSlug)) return siteSlug;
  return subtitle;
}

/**
 * Whether `value` is a date the parser would also have accepted.
 *
 * Defers to `toIsoDate` rather than re-checking with `Date.UTC` here, because
 * "real date" is not the whole rule: `toIsoDate` also refuses years outside
 * 1900-2199, and a typo like `9023-04-15` that this admitted would open a
 * group and a library directory no parsed release can ever join.
 */
function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return false;
  return toIsoDate(Number(match[1]), Number(match[2]), Number(match[3])) === value;
}

function resolutionNumber(value: string): number | undefined {
  const match = /^(\d+)p$/.exec(value);
  if (match?.[1] === undefined) return undefined;
  return Number(match[1]);
}

export function sceneFromManualValues(
  values: Readonly<Record<string, string>>,
  options: SceneParseOptions,
): { media: ParsedRelease } | { error: string } {
  const read = (name: string): string => (values[name] ?? '').trim();

  // Slug-emptiness rather than string-emptiness is the test, because a value
  // of `...` survives a trim and then keys on nothing.
  const site = read('site');
  if (slug(site).length === 0) return { error: 'The site is required.' };

  const title = read('title');
  if (slug(title).length === 0) return { error: 'The scene title is required.' };

  // Every `select` is checked against its own option list before anything
  // reads it. An unchecked read does not fail on `vr: 'true'` or
  // `resolution: '1080'` — it quietly builds a release missing exactly the
  // token the human just supplied, which is the one outcome a form must not
  // have. Blank is always allowed: it is how an optional select says "unset",
  // and the required ones fall back to their default below.
  for (const field of FIELDS) {
    const permitted = optionsFor(field.name);
    const value = read(field.name);
    if (permitted === null || value === '') continue;
    if (!permitted.includes(value)) {
      const listed = permitted.filter((option) => option.length > 0).join(', ');
      return { error: `${field.label} must be one of ${listed} — '${value}' is not.` };
    }
  }

  // Narrowed to `date | episode | none` by the loop above, so there is no
  // unrecognised-kind branch here.
  const anchorKind = read('anchorKind') || 'none';
  let anchor: AnchorSpan | null = null;
  if (anchorKind === 'date') {
    const date = read('date');
    if (!isRealIsoDate(date)) {
      return { error: 'The date must be a real calendar date written as YYYY-MM-DD.' };
    }
    // The offsets describe a span in a release name, and there is no release
    // name here. Nothing downstream of `buildRelease` reads them.
    anchor = { kind: 'date', key: date, startOffset: 0, endOffset: 0 };
  } else if (anchorKind === 'episode') {
    const episode = read('episode');
    if (!/^[Ee]\d+$/.test(episode)) {
      return { error: 'The episode must be the letter E followed by digits, such as E1178.' };
    }
    // Lowercased into the key and upper-cased back for display, exactly as the
    // parser does — the key is what has to agree between the two.
    anchor = { kind: 'episode', key: episode.toLowerCase(), startOffset: 0, endOffset: 0 };
  }

  const container = read('container');
  const extras: Record<string, QualityExtra> = {
    ...(container.length > 0 ? { container } : {}),
    ...(read('vr') === 'yes' ? { vr: true } : {}),
    ...(read('upscaled') === 'yes' ? { upscaled: true } : {}),
    ...(read('interlaced') === 'yes' ? { interlaced: true } : {}),
  };

  const resolution = resolutionNumber(read('resolution'));
  const source = read('source');
  const videoCodec = read('videoCodec');
  const audioCodec = read('audioCodec');
  const releaseGroup = read('releaseGroup');
  // `extras` is present even when empty because `extractQuality` always emits
  // it; a manual release whose quality object differs from a parsed one by a
  // missing key is not the same record, and scoring reads through it.
  const quality: QualityTokens = {
    extras,
    ...(resolution !== undefined ? { resolution } : {}),
    ...(source.length > 0 ? { source } : {}),
    ...(videoCodec.length > 0 ? { videoCodec } : {}),
    ...(audioCodec.length > 0 ? { audioCodec } : {}),
    ...(releaseGroup.length > 0 ? { releaseGroup } : {}),
  };

  const media = buildRelease(
    // A configured spelling wins over what was typed, for the same reason it
    // wins over what a release name says: the canonical name picks the library
    // directory, and typing `bangbros` must not open a second one.
    canonicalSiteName(site, options.sites ?? []),
    anchor,
    title,
    sceneSlugFor(title, read('titleOrder') || 'fixed'),
    quality,
  );
  if (media === null) return { error: lastRefusalReason() ?? 'could not build a release' };
  return { media };
}

/**
 * The inverse: form values that rebuild `media` byte for byte.
 *
 * One property here is a safety guarantee rather than a convenience: these
 * values must never be ones `sceneFromManualValues` would turn into an
 * identity key other than `media.identityKey`. Everything else the prefill
 * offers is there to save typing, and being wrong about it costs the human a
 * correction; being wrong about the key moves a group and the library
 * directory under it with nothing on screen to say so. That is why every
 * identity field below is verified against the key rather than copied from the
 * display: the anchor and the title order are read straight out of it, and the
 * title and the site are each rebuilt and compared before they are offered.
 *
 * The guarantee holds unconditionally for the anchor, the title order and the
 * title. For the site it holds whenever *any* set of values could hold it, and
 * `siteForKeySegment` proves that is the strongest statement available to a
 * prefill: once `learnSites` has added a spelling that shares this key's site
 * class but slugs differently, `canonicalSiteName` collapses every value the
 * field could carry onto that spelling, and the rebuild re-keys whatever is
 * typed. Closing that needs a change to the identity model or to the edit path,
 * not to this function — see `siteForKeySegment` for both. The narrow wording
 * is deliberate: a comment claiming a property the code does not have is worse
 * than no comment.
 *
 * `options` is taken rather than closed over because `learnSites` reassigns the
 * plugin's options object, and the whole point of the check is to compare
 * against the site list as it stands *now*.
 *
 * Note what has no field and is therefore dropped by any edit round trip:
 * `quality.bitrateKbps` and `quality.sizeBytes`. Nothing in this plugin emits
 * them today, so there is nothing to lose yet — but whoever makes the parser
 * emit them has to add the fields in the same change, or editing a release
 * will silently discard them.
 */
export function sceneToManualValues(
  media: ParsedRelease,
  options: SceneParseOptions,
): Record<string, string> {
  // Every structural fact is read off the key rather than off the display,
  // because the key is what the rebuild has to reproduce and the display is
  // lossy about how it was made.
  const segments = media.identityKey.split(':');
  const siteSlug = segments[0] ?? '';
  const anchorKey = segments[1] ?? '';
  const sceneSlug = segments[2] ?? '';

  const anchorKind = /^\d{4}-\d{2}-\d{2}$/.test(anchorKey)
    ? 'date'
    : anchorKey.length > 0
      ? 'episode'
      : 'none';

  const titleOrder = sceneSlug.includes(SCENE_COMPONENT_BOUNDARY) ? 'any' : 'fixed';

  const extras = media.quality.extras ?? {};
  const containerValue = extras['container'];
  const flag = (name: string): string => (extras[name] === true ? 'yes' : '');

  return {
    site: siteForKeySegment(media.display.subtitle ?? '', siteSlug, options.sites ?? []),
    anchorKind,
    date: anchorKind === 'date' ? anchorKey : '',
    episode: anchorKind === 'episode' ? anchorKey.toUpperCase() : '',
    title: titleForSceneSlug(media.display.title, sceneSlug, titleOrder),
    titleOrder,
    resolution: media.quality.resolution === undefined ? '' : `${media.quality.resolution}p`,
    source: media.quality.source ?? '',
    videoCodec: media.quality.videoCodec ?? '',
    audioCodec: media.quality.audioCodec ?? '',
    releaseGroup: media.quality.releaseGroup ?? '',
    container: typeof containerValue === 'string' ? containerValue : '',
    vr: flag('vr'),
    upscaled: flag('upscaled'),
    interlaced: flag('interlaced'),
  };
}

/**
 * A best-effort prefill for a name the parser has already refused.
 *
 * Only facts the parser's own recognisers can establish on their own are
 * offered — the quality tables, a known site prefix, a valid calendar date.
 * There is deliberately no title guess: the parser refused this name because
 * it could not find the boundary between site, anchor and title, so any title
 * this could produce is the same guess that already failed, presented to the
 * human as if it were evidence.
 */
export function sceneSuggestManualValues(
  releaseName: string,
  options: SceneParseOptions,
): Record<string, string> {
  try {
    const tokens = tokensOf(releaseName);
    const quality = extractQuality(releaseName, undefined);
    const site = matchSitePrefix(tokens, options.sites ?? []);
    const date = findSceneDate(tokens);
    const container = quality.extras?.['container'];

    return {
      ...(site !== null ? { site: site.name } : {}),
      ...(date?.kind === 'date' ? { anchorKind: 'date', date: date.key } : {}),
      ...(quality.resolution !== undefined ? { resolution: `${quality.resolution}p` } : {}),
      ...(quality.source !== undefined ? { source: quality.source } : {}),
      ...(quality.videoCodec !== undefined ? { videoCodec: quality.videoCodec } : {}),
      ...(typeof container === 'string' ? { container } : {}),
    };
  } catch {
    // A suggestion is a convenience, not a contract: a name that breaks a
    // recogniser still has to reach the form the human will fill in by hand.
    return {};
  }
}
