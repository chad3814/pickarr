/**
 * TMDB's `ArtworkSource`: television and film. Every field this file reads
 * off TMDB's own responses was read from the live API with a real token
 * (see the task brief) -- nothing here is a guess at TMDB's shape, and
 * nothing is added to a response type beyond what was actually observed.
 *
 * `imagesFor` is the one call the seam demands (`../artwork/source.ts`):
 * this provider satisfies `personRefs` with its own `/3/person/{id}/images`
 * calls, which is the branch of that seam's docblock TMDB actually takes --
 * ThePornDB (a different task) takes the other one.
 *
 * **Person images are never gated by `kind`.** `MEDIA_KIND_PATH` below
 * decides only whether *this media item* has an images endpoint; a
 * person's own picture comes from a separate, unrelated TMDB endpoint, so
 * a `season` or `episode` ref (neither has a media endpoint here) still
 * gets its people's images answered. Coupling the two would be wrong, not
 * merely stricter -- a cast list does not stop existing because its
 * season has no poster of its own.
 */
import type { HostFetch } from '@pickarr/contract';
import type { SecretResolver } from '../types.ts';
import type { ArtworkAnswer, ArtworkSource, MediaImages, ProviderImage } from './source.ts';

/**
 * The logical secret name, lowercase-kebab like this package's own
 * `API_KEY_SECRET` (`../types.ts`, `'openmetadata-api-key'`) -- not the
 * uppercase `TMDB_READ_ACCESS_TOKEN` the design spec first wrote, which
 * `packages/host/src/secrets/names.ts`'s `assertSecretName` rejects
 * outright (`^[a-z0-9][a-z0-9_-]{0,63}$`, no uppercase): the real
 * `Secrets.get` would throw before its chain was ever consulted, which is
 * not "no key configured", it is every call failing.
 *
 * The name and the environment variable it resolves through are
 * deliberately different strings, and conflating them is exactly the bug
 * being fixed here: `envNameFor` (same file) uppercases this name and
 * turns `-` into `_`, so `tmdb-read-access-token` resolves through
 * `PICKARR_SECRET_TMDB_READ_ACCESS_TOKEN` -- verified by calling
 * `envNameFor` directly, not assumed. The operator-facing variable name is
 * therefore unchanged from the design spec's; only the secret's own
 * internal name (illegal there) moves to a legal spelling.
 */
export const TMDB_TOKEN_SECRET = 'tmdb-read-access-token';

const API_BASE = 'https://api.themoviedb.org/3';

/**
 * Sized variants, chosen at the source rather than asking for `original`.
 * `HostFetch.bytes` reads a whole `arrayBuffer()` with no size cap, so an
 * unbounded `original` from a CDN is an unbounded allocation in the host;
 * these bound the download at the point of asking instead of relying on a
 * guard downstream that someone has to remember. They are also simply
 * bigger than anything a card renders: it shows a 96px-wide poster.
 */
const POSTER_SIZE = 'w780';
const BACKDROP_SIZE = 'w1280';
const LOGO_SIZE = 'w300';
const PROFILE_SIZE = 'w185';

/**
 * `kind` is openmetadata's vocabulary (`MediaKind`), not a TMDB path
 * segment. Only `movie` and `series` are here, on purpose: TMDB's other
 * kinds (`season`, `episode`) belong to a different task's scope, and
 * `book`/`scene` are not TMDB media at all. Asking `/3/movie/{id}` for a
 * kind that is actually a series would silently answer a *different show*
 * rather than 404ing, which is exactly why this is a lookup table and not
 * a guess -- a kind absent from this map asks TMDB nothing.
 */
const MEDIA_KIND_PATH: Readonly<Record<string, string>> = {
  movie: 'movie',
  series: 'tv',
};

const EMPTY_MEDIA_IMAGES: MediaImages = { posters: [], backgrounds: [], logos: [] };

/**
 * The one shape `/3/configuration`, `/3/movie/{id}/images`,
 * `/3/tv/{id}/images` and `/3/person/{id}/images` all share for a single
 * image entry. Each of those endpoints carries more fields than this
 * (`width`, `height`, `aspect_ratio`, `iso_3166_1`, `vote_count`), but
 * nothing below reads them, so they are left off rather than typed and
 * ignored.
 */
interface TmdbImage {
  readonly file_path: string;
  readonly iso_639_1: string | null;
  readonly vote_average: number;
}

interface TmdbConfigurationResponse {
  readonly images: {
    readonly secure_base_url: string;
  };
}

interface TmdbMediaImagesResponse {
  readonly posters: readonly TmdbImage[];
  readonly backdrops: readonly TmdbImage[];
  readonly logos: readonly TmdbImage[];
}

interface TmdbPersonImagesResponse {
  readonly profiles: readonly TmdbImage[];
}

/** Turns TMDB's own image objects into this seam's `ProviderImage`s, at one size. */
function toProviderImages(
  images: readonly TmdbImage[],
  secureBaseUrl: string,
  size: string,
): readonly ProviderImage[] {
  return images.map((image) => ({
    url: `${secureBaseUrl}${size}${image.file_path}`,
    language: image.iso_639_1,
    score: image.vote_average,
  }));
}

export function createTmdbSource(deps: { fetch: HostFetch; resolveSecret: SecretResolver }): ArtworkSource {
  /**
   * Populated at most once per source instance and held for its whole
   * lifetime, so that a second (or hundredth) `imagesFor` call reuses the
   * first call's configuration instead of re-fetching it. Held as a
   * promise rather than the resolved value: two calls racing before the
   * first response lands must still share the one in-flight request, the
   * same reason `Secrets.get`'s own cache holds a `Provider`, not a value.
   */
  let configuration: Promise<TmdbConfigurationResponse> | undefined;

  function fetchConfiguration(key: string): Promise<TmdbConfigurationResponse> {
    if (configuration === undefined) {
      configuration = deps.fetch.json<TmdbConfigurationResponse>(`${API_BASE}/configuration`, {
        headers: { authorization: `Bearer ${key}` },
      });
    }
    return configuration;
  }

  function authorized(key: string): RequestInit {
    return { headers: { authorization: `Bearer ${key}` } };
  }

  /**
   * The credential, or `null` for "nobody configured one" -- distinguished
   * by `Error.name`, the same signal `packages/host/src/secrets/names.ts`
   * exports as `SecretNotFound.name`. This package does not import
   * `@pickarr/host` (see `client.ts`'s own docblock on `SecretResolver`),
   * so the check is by name rather than `instanceof`; any other rejection
   * (a secrets directory present and unreadable, say) is a real
   * misconfiguration and is left to propagate rather than read as "artwork
   * is simply turned off".
   */
  async function resolveKey(): Promise<string | null> {
    try {
      return await deps.resolveSecret(TMDB_TOKEN_SECRET);
    } catch (error) {
      if (error instanceof Error && error.name === 'SecretNotFound') return null;
      throw error;
    }
  }

  async function mediaImages(kind: string, providerRef: string, key: string): Promise<MediaImages> {
    const path = MEDIA_KIND_PATH[kind];
    if (path === undefined) return EMPTY_MEDIA_IMAGES;

    const [config, body] = await Promise.all([
      fetchConfiguration(key),
      deps.fetch.json<TmdbMediaImagesResponse>(
        `${API_BASE}/${path}/${encodeURIComponent(providerRef)}/images`,
        authorized(key),
      ),
    ]);
    const secureBaseUrl = config.images.secure_base_url;
    return {
      posters: toProviderImages(body.posters, secureBaseUrl, POSTER_SIZE),
      // The provider says `backdrops`; this codebase says `background` --
      // the table, the writer and the route all do (`artwork-route.ts`'s
      // `ArtworkKind`). The rename happens here, once, so that neither
      // name ever has to leak into the other's code.
      backgrounds: toProviderImages(body.backdrops, secureBaseUrl, BACKDROP_SIZE),
      logos: toProviderImages(body.logos, secureBaseUrl, LOGO_SIZE),
    };
  }

  async function personImages(providerRef: string, key: string): Promise<readonly ProviderImage[]> {
    const [config, body] = await Promise.all([
      fetchConfiguration(key),
      deps.fetch.json<TmdbPersonImagesResponse>(
        `${API_BASE}/person/${encodeURIComponent(providerRef)}/images`,
        authorized(key),
      ),
    ]);
    return toProviderImages(body.profiles, config.images.secure_base_url, PROFILE_SIZE);
  }

  return {
    async imagesFor(kind, providerRef, personRefs): Promise<ArtworkAnswer> {
      const key = await resolveKey();
      // No key configured answers no images, never throws: a host that has
      // not set one should not see errors, the same way a host with no
      // openmetadata key declines to look anything up rather than failing.
      // Nothing is fetched at all -- not even configuration -- because
      // there is nothing to build a url from without it.
      if (key === null) {
        return { media: EMPTY_MEDIA_IMAGES, people: new Map() };
      }

      const [media, peopleFound] = await Promise.all([
        mediaImages(kind, providerRef, key),
        Promise.all(personRefs.map(async (ref) => [ref, await personImages(ref, key)] as const)),
      ]);

      const people = new Map<string, readonly ProviderImage[]>();
      for (const [ref, images] of peopleFound) {
        // A person TMDB has nothing for simply has no entry, the same way
        // an item with no artwork of a given kind is ordinary rather than
        // an error (see the seam's own docblock on `ArtworkAnswer.people`).
        if (images.length > 0) people.set(ref, images);
      }

      return { media, people };
    },
  };
}
