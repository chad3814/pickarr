/**
 * TheTVDB's `ArtworkSource`: the third provider openmetadata resolves to.
 *
 * Every shape below was read from the live v4 API with a real key, and
 * from live `/api/v1/lookup` answers for the reference formats -- this
 * module exists because the TMDB source shipped on *assumed* reference
 * shapes and answered 404 for every item it ever fetched. Nothing here is
 * a guess; where a claim could not be checked it is not made.
 *
 * Three things about this provider differ from TMDB, and each is handled
 * at this boundary so neither vocabulary leaks past it:
 *
 * 1. **Its media references are bare ids, not composites.** openmetadata
 *    is not uniform across providers: a TMDB series is `tmdb:tv:1399`
 *    where a TVDB series is plain `184871`. See {@link tvdbId}.
 * 2. **Its language codes are three letters** (`eng`), where this seam and
 *    `bestImage`'s comparison are two (`en`). See {@link toSeamLanguage}.
 * 3. **Series and film artwork come from differently-shaped routes.**
 *    `/series/{id}/artworks` exists; `/movies/{id}/artworks` does **not**
 *    -- it answers `{"status":"error","message":"Bad Request"}` -- so a
 *    film's artwork is read out of `/movies/{id}/extended`. Verified
 *    against both, not assumed from the symmetry.
 */
import type { HostFetch } from '@pickarr/contract';
import type { SecretResolver } from '../types.ts';
import type { ArtworkAnswer, ArtworkParent, ArtworkSource, MediaImages, ProviderImage } from './source.ts';

/**
 * The logical secret name, lowercase-kebab like `TMDB_TOKEN_SECRET` and
 * this package's `API_KEY_SECRET` -- `assertSecretName` rejects uppercase
 * outright, so the operator-facing variable is
 * `PICKARR_SECRET_TVDB_API_KEY` while the name itself is this.
 *
 * This is TheTVDB's *API key*, not a bearer token: unlike TMDB, it is not
 * sent on requests at all. It buys a token from `/v4/login`, and that
 * token is what authorizes everything else.
 */
export const TVDB_API_KEY_SECRET = 'tvdb-api-key';

const API_BASE = 'https://api4.thetvdb.com/v4';

/** A TVDB id is decimal digits and nothing else. */
const DIGITS = /^[0-9]+$/;

/**
 * The numeric TVDB id inside an openmetadata reference.
 *
 * **openmetadata does not use one reference format across providers, and
 * assuming it did is what cost the TMDB source its first deployment.**
 * Read from live `/api/v1/lookup` answers, TVDB's four shapes are:
 *
 * - a series is `184871` -- bare
 * - an episode is `10019744` -- bare, and its *own* id, not its series'
 * - a season is `184871:s14` -- the series id, then the season ordinal
 * - a person is `tvdb:person:7892648` -- composite, like TMDB's
 *
 * So both a bare id and a three-segment composite are accepted, and they
 * are unambiguous: nothing that is all digits can also be a composite.
 *
 * `184871:s14` is deliberately refused rather than read as `184871`. It
 * has two segments, so neither rule matches -- and that is the wanted
 * answer, because `184871` is the *series*, not the season, and returning
 * it here would quietly answer a season with its series' id through a
 * route that never intended the substitution. {@link mediaTarget} reaches
 * the series by walking `parents`, where the substitution is explicit.
 *
 * Anything else answers `undefined`, so an unrecognised shape asks for
 * nothing instead of building a url that cannot work.
 */
export function tvdbId(providerRef: string): string | undefined {
  if (DIGITS.test(providerRef)) return providerRef;
  const segments = providerRef.split(':');
  if (segments.length !== 3) return undefined;
  const id = segments[2];
  return id !== undefined && DIGITS.test(id) ? id : undefined;
}

/**
 * TheTVDB reports `eng`; this seam, `bestImage` and `DEFAULT_LANGUAGE`
 * speak `en`. Without this every English image would lose tier 0 and sort
 * as a language the operator did not ask for -- the posters would still be
 * chosen, just by score among foreign ones, which is the kind of wrong
 * that looks like nothing at all.
 *
 * `Intl.Locale` rather than a hand-written table: it canonicalises through
 * CLDR's own alias data, so this is the platform's mapping rather than one
 * more list to maintain. All 185 codes `/v4/languages` publishes were run
 * through it -- 182 convert, `pt` and `yue` come back unchanged (correct:
 * `pt` is already two letters and `yue` has no ISO 639-1 form), and
 * `zhtw` is the single code that throws, being no kind of language tag.
 * That throw is why this is wrapped: an unparseable code degrades to
 * itself, which can never equal the configured language and so sorts as
 * "some other language" -- the honest answer.
 */
export function toSeamLanguage(code: string | null): string | null {
  if (code === null) return null;
  try {
    return new Intl.Locale(code).language;
  } catch {
    return code;
  }
}

/**
 * Which artwork `type` ids mean poster, background and logo.
 *
 * Read from `/v4/artwork/types`, which keys them by `recordType` -- the
 * ids are **not** shared between records, so a film's poster is 14 where a
 * series' is 2. Getting this wrong does not 404; it silently answers with
 * the wrong kind of picture, which is why these are a measured table
 * rather than a guess.
 *
 * Only these three of the record's types are taken. The rest exist and are
 * deliberately unused: series also publishes Banner (1), Icon (5),
 * Cinemagraph (20) and ClearArt (22), and a film's `extended` payload
 * mixes in `actor` Photos (13) -- 9 of the 44 on the sample read -- so
 * filtering by an explicit id is what keeps a cast headshot out of a
 * film's poster slot.
 */
interface ArtworkTypes {
  readonly poster: number;
  readonly background: number;
  readonly logo: number;
}

const SERIES_TYPES: ArtworkTypes = { poster: 2, background: 3, logo: 23 };
const MOVIE_TYPES: ArtworkTypes = { poster: 14, background: 15, logo: 25 };

/** Where a kind's artwork is read from, and which type ids to read. */
interface MediaTarget {
  readonly url: (id: string) => string;
  readonly types: ArtworkTypes;
}

/**
 * `kind` is openmetadata's vocabulary, and only these two are addressable.
 *
 * A `season` and an `episode` are absent on purpose: TheTVDB publishes
 * season art (types 6-10) and episode screencaps (11, 12), but neither can
 * fill this seam's three slots, and an episode's reference is its own id
 * rather than anything that reaches its series. Both fall back through
 * {@link mediaTarget} to the series, which is the picture a media library
 * shows for an episode anyway -- the same choice `./tmdb.ts` makes.
 */
const MEDIA_KIND_TARGET: Readonly<Record<string, MediaTarget>> = {
  series: { url: (id) => `${API_BASE}/series/${id}/artworks`, types: SERIES_TYPES },
  // Not `/movies/{id}/artworks`, which does not exist -- see this module's docblock.
  movie: { url: (id) => `${API_BASE}/movies/${id}/extended`, types: MOVIE_TYPES },
};

/**
 * The route and id to read this item's artwork from: its own if TheTVDB
 * has one for the kind, otherwise its nearest usable ancestor's.
 *
 * Each candidate's reference is parsed, not just its kind matched: a
 * reference this build cannot read is no more usable than a kind it cannot
 * address, so an unreadable one is skipped rather than returned as a
 * target that would 404.
 */
function mediaTarget(
  kind: string,
  providerRef: string,
  parents: readonly ArtworkParent[],
): { readonly target: MediaTarget; readonly id: string } | undefined {
  const own = MEDIA_KIND_TARGET[kind];
  const ownId = own === undefined ? undefined : tvdbId(providerRef);
  if (own !== undefined && ownId !== undefined) return { target: own, id: ownId };
  for (const parent of parents) {
    const target = MEDIA_KIND_TARGET[parent.kind];
    if (target === undefined) continue;
    const id = tvdbId(parent.providerRef);
    if (id !== undefined) return { target, id };
  }
  return undefined;
}

/**
 * One artwork entry. The endpoints carry more (`id`, `thumbnail`, `width`,
 * `height`, `includesText`, `updatedAt`, `status`, `tagOptions`); nothing
 * below reads them, so they are left off rather than typed and ignored.
 *
 * `score` is TheTVDB's own ordering signal and is nothing like TMDB's
 * ten-point average -- the observed values run past 100000. That is fine
 * unexamined: `bestImage` only ever compares two scores from the same
 * provider call (`./source.ts`'s `ProviderImage`).
 */
interface TvdbArtwork {
  readonly image: string;
  readonly language: string | null;
  readonly type: number;
  readonly score: number;
}

/**
 * Every v4 response is wrapped in `{status, message, data}`, and `data` is
 * `null` on an error rather than the key being absent -- typed as nullable
 * for that reason. `artworks` is likewise absent on a record that has none.
 */
interface TvdbEnvelope<T> {
  readonly data: T | null;
}

interface TvdbArtworksData {
  readonly artworks?: readonly TvdbArtwork[] | null;
}

interface TvdbLoginData {
  readonly token: string;
}

interface TvdbPersonData {
  readonly image: string | null;
  readonly score: number;
}

const EMPTY_MEDIA_IMAGES: MediaImages = { posters: [], backgrounds: [], logos: [] };

/** The entries of one type, as this seam's images, language normalised. */
function ofType(artworks: readonly TvdbArtwork[], type: number): readonly ProviderImage[] {
  return artworks
    .filter((artwork) => artwork.type === type)
    .map((artwork) => ({
      url: artwork.image,
      language: toSeamLanguage(artwork.language),
      score: artwork.score,
    }));
}

export function createTvdbSource(deps: { fetch: HostFetch; resolveSecret: SecretResolver }): ArtworkSource {
  /**
   * The bearer token once a login has *succeeded*, and the login currently
   * in flight so concurrent calls share one request.
   *
   * Two variables rather than one cached promise, for the reason
   * `./tmdb.ts` spells out at length on its configuration cache: caching
   * the promise caches a rejection, and this source outlives any single
   * job, so one transient failure would poison every later TVDB job until
   * the process restarted.
   */
  let token: string | undefined;
  let pendingLogin: Promise<string> | undefined;

  async function login(apiKey: string): Promise<string> {
    if (token !== undefined) return token;
    pendingLogin ??= (async () => {
      try {
        const body = await deps.fetch.json<TvdbEnvelope<TvdbLoginData>>(`${API_BASE}/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ apikey: apiKey }),
        });
        if (body.data === null) throw new Error('tvdb: login answered no token');
        token = body.data.token;
        return token;
      } finally {
        pendingLogin = undefined;
      }
    })();
    return pendingLogin;
  }

  /**
   * A v4 GET, with one retry after a fresh login on a 401.
   *
   * TheTVDB's tokens expire, and this source is held for the host's whole
   * lifetime (`./job.ts` keeps the registry in a `WeakMap` keyed on
   * `ctx.fetch`), so a long-running host *will* eventually present a stale
   * one. Without this, that host's artwork jobs would fail, retry and
   * dead-letter until someone restarted it -- the same class of
   * until-restart failure the two-variable cache above avoids.
   *
   * The retry is once, and only on 401: anything else is a real failure
   * and is left to the caller. `status` is duck-typed off the error rather
   * than caught by class, because this package does not import
   * `@pickarr/host` -- the same read `../engine.ts` does for its logging.
   */
  async function authorizedJson<T>(url: string, apiKey: string): Promise<T> {
    const body = await deps.fetch.json<TvdbEnvelope<T>>(url, {
      headers: { authorization: `Bearer ${await login(apiKey)}` },
    }).catch(async (error: unknown) => {
      const status = error instanceof Error && 'status' in error && typeof error.status === 'number'
        ? error.status
        : undefined;
      if (status !== 401) throw error;
      token = undefined;
      return deps.fetch.json<TvdbEnvelope<T>>(url, {
        headers: { authorization: `Bearer ${await login(apiKey)}` },
      });
    });
    if (body.data === null) throw new Error(`tvdb: ${url} answered no data`);
    return body.data;
  }

  /**
   * The credential, or `null` for "nobody configured one" -- by
   * `Error.name`, the signal `SecretNotFound` carries, since this package
   * cannot `instanceof` a host class. Any other rejection is a real
   * misconfiguration and propagates rather than reading as "artwork off".
   */
  async function resolveKey(): Promise<string | null> {
    try {
      return await deps.resolveSecret(TVDB_API_KEY_SECRET);
    } catch (error) {
      if (error instanceof Error && error.name === 'SecretNotFound') return null;
      throw error;
    }
  }

  async function mediaImages(
    kind: string,
    providerRef: string,
    parents: readonly ArtworkParent[],
    apiKey: string,
  ): Promise<MediaImages> {
    const found = mediaTarget(kind, providerRef, parents);
    if (found === undefined) return EMPTY_MEDIA_IMAGES;

    const data = await authorizedJson<TvdbArtworksData>(found.target.url(found.id), apiKey);
    const artworks = data.artworks ?? [];
    return {
      posters: ofType(artworks, found.target.types.poster),
      backgrounds: ofType(artworks, found.target.types.background),
      logos: ofType(artworks, found.target.types.logo),
    };
  }

  /**
   * A person's one picture, from `/v4/people/{id}`.
   *
   * `image` is a single url or `null` -- TheTVDB publishes no per-person
   * image *list* behind this reference, so there is nothing to choose
   * between and no language to choose by. It is reported as `language:
   * null`, which is true of it rather than convenient: it is one picture
   * of a face, carrying no text to translate.
   */
  async function personImages(providerRef: string, apiKey: string): Promise<readonly ProviderImage[]> {
    const id = tvdbId(providerRef);
    if (id === undefined) return [];
    const data = await authorizedJson<TvdbPersonData>(`${API_BASE}/people/${id}`, apiKey);
    if (data.image === null) return [];
    return [{ url: data.image, language: null, score: data.score }];
  }

  return {
    async imagesFor(kind, providerRef, personRefs, parents): Promise<ArtworkAnswer> {
      const apiKey = await resolveKey();
      // No key configured answers no images and never throws, and fetches
      // nothing at all -- not even the login. `noCredential` is what lets
      // `./job.ts` say so once per provider instead of leaving an operator
      // with blank cards and no diagnostic.
      if (apiKey === null) {
        return { media: EMPTY_MEDIA_IMAGES, people: new Map(), noCredential: true };
      }

      const [media, peopleFound] = await Promise.all([
        mediaImages(kind, providerRef, parents, apiKey),
        Promise.all(personRefs.map(async (ref) => [ref, await personImages(ref, apiKey)] as const)),
      ]);

      const people = new Map<string, readonly ProviderImage[]>();
      for (const [ref, images] of peopleFound) {
        // A person TheTVDB has nothing for is an omitted key, not an empty
        // array -- the seam's rule for "nothing this provider has".
        if (images.length > 0) people.set(ref, images);
      }

      return { media, people };
    },
  };
}
