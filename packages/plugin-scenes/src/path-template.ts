import type { ParsedRelease } from '@pickarr/plugin-api';

/**
 * Renders a library path from a template.
 *
 * Every value is derived from `identityKey`, never from the release's raw
 * display strings. Two releases the parser considers one scene can differ in
 * casing, spacing and punctuation — that is the point of normalising the key —
 * and letting that variation reach the path would split one scene's files
 * across two destinations. `plan-import.ts` has the long version of this
 * argument; the same rule binds here.
 *
 * Placeholders are `{name}`. An unknown name is left alone rather than
 * silently deleted, so a typo shows up in the path instead of quietly
 * shortening it.
 *
 * Casing of the placeholder mirrors the casing of the value:
 *
 *   site        bang bros                 the site, words separated
 *   Site        Bang Bros                 ...title-cased. The default.
 *   sitename    bangbros                  run together, as TPDB's short_name
 *   SiteName    BangBros                  ...PascalCase
 *   title       chloe upgrades her butt
 *   Title       Chloe Upgrades Her Butt   the default
 *   date        2026-08-03                empty when the release carries none
 *   year        2026                      empty when the release carries none
 *   episode     E1178                     empty unless the anchor is one
 *   resolution  2160p
 *   container   mp4
 *   group       WRB
 *
 * `date` and `episode` are never both set — a release is anchored by one or
 * the other, or neither — so a template can carry both and get whichever
 * exists. The default does exactly that.
 */
export const DEFAULT_PATH_TEMPLATE = '{Site}/{date}{episode} - {Title}';

/** Characters that are invalid or hazardous in a path segment. */
function sanitizeSegment(value: string): string {
  return value
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
}

/**
 * Splits a slug into its components and words.
 *
 * The `--` split is not cosmetic. The parser's listing form joins its sorted
 * components with `--` precisely because `slug()` can never emit that sequence
 * any other way, which is what keeps the identity injective on the component
 * multiset. Splitting on a single `-` here erased that boundary again one
 * layer down: `kylie--page-turner` and `kylie-page--turner` are two different
 * scenes with two different keys, and both rendered `Kylie Page Turner`.
 * Nothing is overwritten — the importer refuses an occupied destination — but
 * the second scene then failed on every attempt and could never be imported.
 *
 * Injectivity, precisely: `slug()` emits only `[a-z0-9]` runs separated by
 * single `-`, with no leading or trailing `-`. So a component contains no
 * `--`, and splitting it on `-` yields no empty words. A rendered word
 * therefore contains neither a space nor a hyphen, words are joined by ` `,
 * and components by ` - `; neither delimiter can occur inside a word, so the
 * rendering is uniquely decodable and distinct slugs render distinctly.
 *
 * `sitename` and `SiteName` run the words together and so are *not*
 * injective — `bang-bros` and `bangbros` both give `bangbros`. Those two
 * cannot be different sites, because site matching compares exactly that
 * separator-free form, so nothing is lost. A template using them still keys
 * one scene to one path.
 */
function slugWords(value: string): string[][] {
  return value
    .split('--')
    .map((component) => component.split('-').filter((word) => word.length > 0))
    .filter((component) => component.length > 0);
}

function lowerJoin(value: string): string {
  return slugWords(value)
    .map((component) => component.join(' '))
    .join(' - ');
}

function titleJoin(value: string): string {
  return slugWords(value)
    .map((component) =>
      component.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
    )
    .join(' - ');
}

function pascalJoin(value: string): string {
  return slugWords(value)
    .map((component) => component.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(''))
    .join('');
}

export function templateValues(media: ParsedRelease): Record<string, string> {
  const [siteSlug = '', anchor = '', sceneSlug = ''] = media.identityKey.split(':');
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(anchor);
  const resolution = media.quality.resolution;
  const container = media.quality.extras?.['container'];

  return {
    site: lowerJoin(siteSlug),
    Site: titleJoin(siteSlug),
    sitename: siteSlug.replaceAll('-', ''),
    SiteName: pascalJoin(siteSlug),
    title: lowerJoin(sceneSlug),
    Title: titleJoin(sceneSlug),
    date: isDate ? anchor : '',
    year: isDate ? anchor.slice(0, 4) : '',
    episode: !isDate && anchor.length > 0 ? anchor.toUpperCase() : '',
    resolution: typeof resolution === 'number' ? `${resolution}p` : '',
    container: typeof container === 'string' ? container : '',
    group: media.quality.releaseGroup ?? '',
  };
}

/**
 * Substitutes, then tidies each segment.
 *
 * A value can legitimately be empty — most releases have no episode, some have
 * no date — and the literal text around it then has nothing to separate. The
 * template `{date}{episode} - {Title}` must yield `Alex Coal` rather than
 * ` - Alex Coal` for a release carrying neither. Rather than invent a
 * conditional syntax, leftover separators are collapsed away afterwards, which
 * is the same thing with nothing to learn.
 *
 * An empty segment is dropped entirely, so a template beginning `{group}/` does
 * not produce a nameless top-level directory for every release without one.
 */
export function renderPath(template: string, media: ParsedRelease, extension: string): string {
  const values = templateValues(media);

  const segments = template
    .split('/')
    .map((segment) =>
      segment.replace(/\{(\w+)\}/g, (whole, name: string) =>
        Object.hasOwn(values, name) ? sanitizeSegment(values[name] ?? '') : whole,
      ),
    )
    .map((segment) =>
      segment
        .replace(/\s*-\s*(?=-|$)/g, '')
        .replace(/^\s*-\s*/, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');

  if (segments.length === 0) return `Unknown${extension}`;
  return `${segments.join('/')}${extension}`;
}
