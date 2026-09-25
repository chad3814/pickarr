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
 * **Person images are never gated by `kind`.** `MEDIA_KIND_PATH` and
 * `mediaTarget` below decide only which images endpoint *this media item*
 * is answered from, and whether there is one at all; a person's own
 * picture comes from a separate, unrelated TMDB endpoint, so an item whose
 * kind is addressable by neither itself nor an ancestor still gets its
 * people's images answered. Coupling the two would be wrong, not merely
 * stricter -- a cast list does not stop existing because its season has no
 * poster of its own.
 */
import type { HostFetch } from '@pickarr/contract';
import type { SecretResolver } from '../types.ts';
import type { ArtworkAnswer, ArtworkParent, ArtworkSource, MediaImages, ProviderImage } from './source.ts';

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
 * segment. Two entries, and they are the two whose `/3/{path}/{id}/images`
 * responses were read live for this feature (see this module's own
 * docblock). No `/3/{path}/{id}/images` url is built here for a `season` or
 * an `episode`, because no such path has been verified for the standalone
 * `providerRef` openmetadata hands over for one -- and an unverified path
 * is exactly what this table exists to keep out. `book` and `scene` are not
 * TMDB media at all.
 *
 * Asking `/3/movie/{id}` for a kind that is actually a series would
 * silently answer a *different show* rather than 404ing, which is exactly
 * why this is a lookup table and not a guess.
 *
 * A kind absent from this map does **not** mean no artwork: see
 * {@link mediaTarget}, which falls back to the nearest ancestor that is in
 * the map, so an episode is answered with its series' poster.
 */
const MEDIA_KIND_PATH: Readonly<Record<string, string>> = {
  movie: 'movie',
  series: 'tv',
};

/**
 * The numeric TMDB id inside an openmetadata `providerRef`.
 *
 * **openmetadata does not hand over a bare id, and assuming it did cost
 * this feature its first deployment.** Read from the live service, a
 * reference is `<provider>:<type>:<id>` with optional trailing ordinals:
 *
 * - a film is `tmdb:movie:335984`
 * - a series is `tmdb:tv:1399`
 * - a season is `tmdb:tv:1399:1`
 * - an episode is `tmdb:tv:1399:1:1`
 * - a person is `tmdb:person:30614`
 *
 * The first build passed the whole string into the path, so every request
 * went to `/3/tv/tmdb%3Atv%3A1399/images` and answered 404. It failed for
 * **every** TMDB item -- 743 dead artwork jobs on the first real
 * deployment -- and no test caught it, because every fixture in this file
 * used a bare id that had been invented rather than observed.
 * That is why the tests beside this function now use references copied
 * from real `/api/v1/lookup` answers.
 *
 * The id is the third segment. Trailing ordinals are deliberately
 * discarded rather than used, because the endpoints they would address
 * cannot fill this seam's three slots. Asked of the live API for
 * `tv/1399`:
 *
 * - `/3/tv/1399/images` -> `posters`, `backdrops`, `logos`
 * - `/3/tv/1399/season/1/images` -> `posters` only
 * - `/3/tv/1399/season/1/episode/1/images` -> `stills` only
 *
 * So a season has no backdrop or logo to give and an episode has neither
 * plus no poster. {@link mediaTarget} sends both kinds to their series
 * instead, which is also the picture a media library shows for an episode.
 *
 * Answers `undefined` for anything that is not `<something>:<something>:<digits>`,
 * so an unrecognised shape asks nothing instead of building a url that
 * cannot work. A future provider-ref format change therefore degrades to
 * "no artwork" rather than to a storm of 404s.
 */
export function tmdbId(providerRef: string): string | undefined {
  // No length guard: under `noUncheckedIndexedAccess` a missing third segment
  // reads as `undefined`, which the same check that rejects a non-numeric one
  // already refuses. A guard was written here first and removed -- no mutation
  // of it could redden a test, because nothing reached it.
  const id = providerRef.split(':')[2];
  return id !== undefined && DIGITS.test(id) ? id : undefined;
}

/** A TMDB id is decimal digits and nothing else -- never `' 12'`, `'0x1'` or `''`. */
const DIGITS = /^[0-9]+$/;

/** Which TMDB images endpoint to ask, and with which id. */
interface MediaTarget {
  readonly path: string;
  readonly ref: string;
}

/**
 * The item's own images endpoint, or the nearest ancestor's, or nothing.
 *
 * **Without the fallback every episode and every season gets no artwork
 * at all.** A tv lookup resolves to `episode`, `season` or `series`
 * (`plugin-tv`'s `checkTv` refuses anything else), and only the last of
 * those is in `MEDIA_KIND_PATH` -- so each of the other two would 404 its
 * `<img>`, which is the symptom this whole feature exists to end.
 *
 * `parents` arrives nearest first (`ArtworkParent`), so a season is
 * preferred over a series where both could answer, and an episode whose
 * season TMDB cannot address still reaches the series behind it -- which is
 * the picture a media library shows for an episode anyway. `checkTv`
 * guarantees an episode or a season names a series in `parents`, so this is
 * the ordinary path for them rather than a rescue.
 *
 * `undefined` for an item that is neither mapped nor descended from
 * something mapped: nothing is asked of TMDB at all.
 */
function mediaTarget(
  kind: string,
  providerRef: string,
  parents: readonly ArtworkParent[],
): MediaTarget | undefined {
  // The id is parsed out of each candidate, not off the first one that
  // matches a kind: a reference this build cannot read is no more usable
  // than a kind it cannot address, so an unreadable candidate is skipped
  // rather than returned as a target that would 404.
  //
  // For an episode that skipping buys nothing today and is not claimed to:
  // its parents are `[season, series]`, only `series` is in the map, so an
  // unreadable series reference does cost the episode its poster. What the
  // per-candidate parse actually buys is that the failure is "no artwork"
  // instead of a request built from a string that cannot be an id.
  const own = MEDIA_KIND_PATH[kind];
  const ownId = own === undefined ? undefined : tmdbId(providerRef);
  if (own !== undefined && ownId !== undefined) return { path: own, ref: ownId };
  for (const parent of parents) {
    const path = MEDIA_KIND_PATH[parent.kind];
    if (path === undefined) continue;
    const id = tmdbId(parent.providerRef);
    if (id !== undefined) return { path, ref: id };
  }
  return undefined;
}

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
   * The configuration response once one has *succeeded*, held for this
   * source's whole lifetime so a second (or hundredth) `imagesFor` reuses
   * it instead of re-fetching, and the request currently in flight so two
   * calls racing before the first response lands share one request rather
   * than making two.
   *
   * **Two variables rather than one cached promise, and that is the whole
   * point.** Caching the promise caches a *rejection* too, and this source
   * outlives any single job -- `../engine.ts` builds the handler once and
   * `./job.ts` holds the registry in a `WeakMap` keyed on `ctx.fetch` -- so
   * one transient failure here would make every later TMDB artwork job
   * reject with that same stale error, retry and dead-letter, until the
   * process restarted.
   *
   * This is the shape `Secrets.get`'s cache actually has, read rather than
   * remembered: `packages/host/src/secrets/instance.ts` memoizes a
   * `Provider`, and `memoize` (`@chad3814/secret-provider`) keeps its
   * in-flight promise in a `pending` it clears in a `finally`, storing only
   * the resolved value -- "a rejection is not cached, so a secret that
   * appears later resolves without a restart", as that module's own
   * docblock puts it. The `finally` below is the same clear, for the same
   * reason.
   */
  let configuration: TmdbConfigurationResponse | undefined;
  let pendingConfiguration: Promise<TmdbConfigurationResponse> | undefined;

  async function fetchConfiguration(key: string): Promise<TmdbConfigurationResponse> {
    if (configuration !== undefined) return configuration;
    pendingConfiguration ??= (async () => {
      try {
        const body = await deps.fetch.json<TmdbConfigurationResponse>(`${API_BASE}/configuration`, {
          headers: { authorization: `Bearer ${key}` },
        });
        configuration = body;
        return body;
      } finally {
        pendingConfiguration = undefined;
      }
    })();
    return pendingConfiguration;
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

  async function mediaImages(
    kind: string,
    providerRef: string,
    parents: readonly ArtworkParent[],
    key: string,
  ): Promise<MediaImages> {
    const target = mediaTarget(kind, providerRef, parents);
    if (target === undefined) return EMPTY_MEDIA_IMAGES;

    const [config, body] = await Promise.all([
      fetchConfiguration(key),
      deps.fetch.json<TmdbMediaImagesResponse>(
        `${API_BASE}/${target.path}/${encodeURIComponent(target.ref)}/images`,
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
    // The same composite shape the media reference has -- a person is
    // `tmdb:person:41087`, not `41087` (see {@link tmdbId}). An
    // unreadable reference asks nothing rather than 404ing a url built
    // from it.
    const id = tmdbId(providerRef);
    if (id === undefined) return [];
    const [config, body] = await Promise.all([
      fetchConfiguration(key),
      deps.fetch.json<TmdbPersonImagesResponse>(
        `${API_BASE}/person/${encodeURIComponent(id)}/images`,
        authorized(key),
      ),
    ]);
    return toProviderImages(body.profiles, config.images.secure_base_url, PROFILE_SIZE);
  }

  return {
    async imagesFor(kind, providerRef, personRefs, parents): Promise<ArtworkAnswer> {
      const key = await resolveKey();
      // No key configured answers no images, never throws: a host that has
      // not set one should not see errors, the same way a host with no
      // openmetadata key declines to look anything up rather than failing.
      // Nothing is fetched at all -- not even configuration -- because
      // there is nothing to build a url from without it. `noCredential`
      // is what separates this from "TMDB has no pictures for this item",
      // so `./job.ts` can say so once per provider rather than leaving an
      // operator with blank cards and no diagnostic.
      if (key === null) {
        return { media: EMPTY_MEDIA_IMAGES, people: new Map(), noCredential: true };
      }

      const [media, peopleFound] = await Promise.all([
        mediaImages(kind, providerRef, parents, key),
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
