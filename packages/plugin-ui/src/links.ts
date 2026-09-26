/**
 * Where a media item and its people live on the provider that identified
 * them.
 *
 * **Every url here was verified by status code against the live site, not
 * inferred from another provider's shape.** One would have been wrong:
 * `https://thetvdb.com/series/184871` answers **404**, because TheTVDB's
 * pages are slug-based and `/dereferrer/<type>/<id>` is the route that
 * takes an id. `/dereferrer/season/{id}` also 404s, which costs nothing --
 * no media item is a season.
 *
 * **The reference parse is duplicated here, deliberately.** `tmdbId` and
 * `tvdbId` in `@pickarr/openmetadata`'s `src/artwork/` do the same job on
 * the server, but that package's root reaches `node:sqlite` and must never
 * be imported from browser code, so this cannot call them. The duplication
 * is one short function and the shapes it parses are pinned by
 * `test/links.test.ts` against references read off live lookup answers --
 * the same references those two modules' tests use. If openmetadata's
 * format changes, three places change.
 */

/** A link to a provider's own page, and the lettermark that labels it. */
export interface ExternalLink {
  readonly label: string;
  readonly href: string;
}

/** A tmdb id is digits; a tpdb id is a uuid. Neither contains a colon. */
const BARE_ID = /^[0-9]+$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The provider's own id inside an openmetadata reference.
 *
 * **openmetadata is not uniform across providers**, which is the whole
 * reason this is a function rather than the reference itself: TMDB sends
 * `tmdb:movie:335984` and `tmdb:tv:1399:1:1`, TheTVDB sends a bare
 * `184871`, ThePornDB sends a bare uuid. A TheTVDB *season* is
 * `184871:s14` and is refused rather than read as `184871`, which is the
 * series and not the season.
 */
export function providerRefId(providerRef: string): string | undefined {
  if (BARE_ID.test(providerRef)) return providerRef;
  const segments = providerRef.split(':');
  if (segments.length < 3) return undefined;
  const id = segments[2];
  return id !== undefined && /^[0-9]+$/.test(id) ? id : undefined;
}

/** `movie` or `tv` for a TMDB reference, from its own second segment. */
function tmdbType(providerRef: string): string | undefined {
  const type = providerRef.split(':')[1];
  return type === 'movie' || type === 'tv' ? type : undefined;
}

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  tmdb: 'The Movie Database',
  tvdb: 'TheTVDB',
  tpdb: 'ThePornDB',
};

/** The provider's full name, for the attribution line. `undefined` for one we have no name for. */
export function providerDisplayName(provider: string): string | undefined {
  return DISPLAY_NAMES[provider];
}

/**
 * The item's page on its provider, or `undefined` when there is none to
 * build -- an unclaimed item (`provider` and `providerRef` are null
 * together), a provider with no pattern, or a reference this build cannot
 * read. Never a url assembled from an unparsed reference.
 *
 * **No `tvdb` arm, deliberately.** A media reference is a *bare* id for
 * this provider (`184871`), and that shape is worn identically by a series
 * and by an episode -- an episode's own id, not its series' (verified live:
 * `dereferrer/series/10019744` is a 404, `dereferrer/episode/10019744`
 * redirects). Nothing in `provider`/`providerRef` alone says which one a
 * given bare id names, so this shared function cannot build a correct url
 * from them and must not guess `series` the way the first version of this
 * file did. Only the plugin that resolved the item knows: `plugin-tv`'s
 * `TvRead.kind` says series, season or episode, and `plugin-tv/src/browser.tsx`
 * supplies the right link through `MediaDetails`'s `extraLinks`, the same
 * seam `plugin-movie` already uses for IMDb. A `tvdb` movie therefore gets
 * no badge at all -- `plugin-movie` has no `kind` to disambiguate by either
 * -- which is accepted: no link beats a 404, and nothing had a badge before
 * this branch existed.
 */
export function mediaLink(provider: string | null, providerRef: string | null): ExternalLink | undefined {
  if (provider === null || providerRef === null) return undefined;
  const id = providerRefId(providerRef);
  if (id === undefined) return undefined;

  if (provider === 'tmdb') {
    const type = tmdbType(providerRef);
    return type === undefined
      ? undefined
      : { label: 'TMDb', href: `https://www.themoviedb.org/${type}/${id}` };
  }
  if (provider === 'tpdb') {
    return { label: 'TPDb', href: `https://theporndb.net/scenes/${id}` };
  }
  return undefined;
}

/** The person's page on the provider that named them, or `undefined`. */
export function personLink(provider: string | null, providerRef: string): string | undefined {
  const id = providerRefId(providerRef);
  if (provider === null || id === undefined) return undefined;
  if (provider === 'tmdb') return `https://www.themoviedb.org/person/${id}`;
  if (provider === 'tvdb') return `https://thetvdb.com/dereferrer/people/${id}`;
  if (provider === 'tpdb') return `https://theporndb.net/performers/${id}`;
  return undefined;
}
