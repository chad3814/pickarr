/**
 * The artwork seam: what a provider looks like to the rest of this tree, and
 * the one pure decision every provider's images are put through.
 *
 * The lookup service (openmetadata) identifies a release but exposes no
 * artwork at all -- checked against its live OpenAPI document, not assumed.
 * What it gives instead is `provider` and `providerRef`, so artwork is
 * fetched straight from whichever provider matched, through the interface
 * below. Nothing in this file calls a provider's API -- it names the seam,
 * the one pure choice (`bestImage`), and which providers have an
 * implementation (`createArtworkSources`); `./tmdb.ts` and `./tpdb.ts` are
 * where a request is actually made, and `./job.ts` is what calls all of it.
 */
import type { HostFetch } from '@pickarr/contract';
import type { SecretResolver } from '../types.ts';
import { createTmdbSource } from './tmdb.ts';
import { createTpdbSource } from './tpdb.ts';

/**
 * One image as a provider reports it, before any decision is made about
 * whether to use it. `language` is the provider's own two-letter code, or
 * `null` for an image the provider itself marks as textless/neutral --
 * TMDB's `iso_639_1: null`. `score` is whatever ordering signal the provider
 * publishes (TMDB's `vote_average`); it is only ever compared to another
 * score from the *same* provider call, never across providers.
 */
export interface ProviderImage {
  readonly url: string;
  readonly language: string | null;
  readonly score: number;
}

/**
 * A media item's artwork, grouped by the three kinds this tree ever shows.
 * Kept as three separate lists rather than one tagged union because a
 * caller almost always wants exactly one kind, and this shape lets it read
 * that list directly instead of filtering.
 */
export interface MediaImages {
  readonly posters: readonly ProviderImage[];
  readonly backgrounds: readonly ProviderImage[];
  readonly logos: readonly ProviderImage[];
}

/**
 * One call's whole answer: the media item's own images, plus whatever
 * people the source could find pictures for.
 *
 * `people` is keyed by the exact `providerRef` string openmetadata gave for
 * that person -- not by a canonical performer id, because at least one
 * provider (ThePornDB, verified live) has no canonical-performer fetch
 * behind that ref at all; see `ArtworkSource`'s docblock. A source that
 * found nothing for a person simply omits that key, the same way
 * `bestImage` treats "nothing this provider has" as ordinary rather than
 * an error.
 */
export interface ArtworkAnswer {
  readonly media: MediaImages;
  readonly people: ReadonlyMap<string, readonly ProviderImage[]>;
  /**
   * Present, and `true`, only when this source answered nothing *because
   * nobody configured its credential* -- never for a provider that simply
   * has no pictures for this item.
   *
   * The distinction exists because it is the one the operator needs and the
   * only one the images themselves cannot carry: an empty answer looks
   * identical either way, and the design this implements requires a host
   * with no key to "log once and fetch no artwork for it". `./job.ts` is
   * what logs it, once per provider, because the sources have no logger --
   * they are handed a `HostFetch` and a `SecretResolver` and nothing else
   * (`ArtworkSourceDeps`).
   *
   * Optional rather than a required `boolean` so the ordinary answer stays
   * the two fields above; with `exactOptionalPropertyTypes` on, the only
   * values this can hold are `true` and absent.
   */
  readonly noCredential?: true;
}

/**
 * One ancestor of the media item being asked about, in the provider's own
 * vocabulary: openmetadata's `MediaParent` narrowed to the two fields a
 * source can act on.
 *
 * Nearest first, the order openmetadata publishes (`types.ts`'s `Media.
 * parents`: "an episode's are its season, then its series"), and a source
 * that walks this list to find a fallback depends on that order -- the
 * nearest usable ancestor is the most specific picture available.
 */
export interface ArtworkParent {
  readonly kind: string;
  readonly providerRef: string;
}

/**
 * What a provider must answer to supply artwork -- one call, not two.
 *
 * `kind` is the media kind string the lookup service already gave the
 * caller (`MediaKind`, e.g. `'movie'` or `'series'`) -- passed through as a
 * plain `string` here rather than importing that type, so this seam does
 * not need to know the lookup service's vocabulary, only that the provider
 * does. `providerRef` is the id the lookup service returned for the media
 * item; `personRefs` are the refs it returned for that item's people, the
 * ones the caller wants an answer for.
 *
 * `parents` is that item's ancestors, nearest first, and it is a required
 * argument rather than an optional one on purpose: a provider whose image
 * endpoints do not cover every kind it is asked about needs somewhere to
 * fall back to, and an optional argument is one a caller can quietly stop
 * passing with nothing to show for it. TMDB is exactly that provider --
 * a television lookup resolves to `episode`, `season` or `series`
 * (`plugin-tv`'s `checkTv`) and TMDB publishes an images endpoint for the
 * last of those only -- so an episode takes its series' poster, which is
 * what a media library shows for one anyway. A source with an endpoint for
 * every kind it handles ignores the argument; ThePornDB does.
 *
 * A single `imagesFor` rather than a `mediaImages` plus a `personImages` --
 * that was this module's first shape, and it does not fit every provider.
 * Verified live against both providers now in scope: openmetadata resolves
 * an adult release to `provider: 'tpdb'` with a scene-specific performer ref
 * in `people[].providerRef`, and `GET /performers/{that ref}` answers 404 --
 * there is no canonical-performer endpoint behind that id at all. What does
 * carry the picture is the *scene* payload TPDB answers for the media
 * fetch: each performer is embedded there, keyed by exactly that ref, with
 * `image`, `thumbnail` and `face` populated (on one provider's records that
 * embed hangs off a `parent` object instead, which was `null` on the sample
 * read -- a reader has to tolerate either). A source shaped like that has
 * no standalone person lookup to expose; a seam that demanded one would
 * force every provider into the shape of the one provider that happens to
 * have a separate person endpoint (TMDB does). One call, answering both,
 * lets each provider satisfy `people` however it actually can -- from the
 * same request it is already making, or, for a provider that can, a second
 * call this function makes internally.
 */
export interface ArtworkSource {
  imagesFor(
    kind: string,
    providerRef: string,
    personRefs: readonly string[],
    parents: readonly ArtworkParent[],
  ): Promise<ArtworkAnswer>;
}

/**
 * Picks the one image a caller should use, out of everything a provider
 * returned for a single kind. The order is a strict three-tier preference,
 * decided **before** score is ever consulted:
 *
 *   0. `language` equals the caller's configured language -- the operator
 *      can read it.
 *   1. `language` is `null` -- textless/neutral. Usually the best poster a
 *      provider has, which is why this outranks tier 2 rather than losing to
 *      every scored foreign image: a neutral image was deliberately made to
 *      need no translation, where a foreign one merely happens to have one.
 *   2. anything else -- a language the operator did not ask for.
 *
 * Only once two images land in the same tier does `score` decide, and only
 * once score also ties does `url` decide (ascending, plain string
 * comparison) -- a deterministic last word so the answer cannot depend on
 * whichever sort stability a runtime happens to implement, or on the order
 * the provider happened to list two equally-good images in.
 *
 * Answers `undefined` for an empty list: a provider having nothing for this
 * item is ordinary, not a failure this function should throw over.
 */
export function bestImage(
  images: readonly ProviderImage[],
  language: string,
): ProviderImage | undefined {
  if (images.length === 0) return undefined;

  function tier(image: ProviderImage): 0 | 1 | 2 {
    if (image.language === language) return 0;
    if (image.language === null) return 1;
    return 2;
  }

  return images.toSorted((a, b) => {
    const tierDelta = tier(a) - tier(b);
    if (tierDelta !== 0) return tierDelta;
    if (a.score !== b.score) return b.score - a.score;
    if (a.url === b.url) return 0;
    return a.url < b.url ? -1 : 1;
  })[0];
}

/** What a provider needs in order to build its `ArtworkSource`. */
export interface ArtworkSourceDeps {
  fetch: HostFetch;
  resolveSecret: SecretResolver;
}

/**
 * The provider registry: the single readable answer to "which providers
 * have artwork", keyed by the same `provider` string the lookup service
 * puts on a `Media` record.
 *
 * Two keys: `tmdb` for television and film, `tpdb` for adult. Those are the
 * only two provider values this slice saw openmetadata emit -- a real
 * release of each was run through it end to end while the design was
 * written -- and each spelling is the lowercase string it answered with
 * rather than a display name. Both providers' APIs were then read live with
 * real credentials; see each module's docblock for what was checked there.
 *
 * A provider with no entry here is not an error anywhere: `./job.ts` looks
 * a source up, finds nothing, and logs that fact **once** rather than once
 * per item. So adding a provider is adding a line here, and a host that
 * meets an unknown one degrades to no artwork rather than to failures.
 *
 * Built per call rather than memoised: each source closes over `deps`, and
 * TMDB's caches `/3/configuration` for the lifetime of the instance it
 * returns. Whoever wants that cache to survive more than one media item has
 * to hold the map they were given -- which `createArtworkJob` does, keyed
 * on the `HostFetch` it built them with.
 */
export function createArtworkSources(
  deps: ArtworkSourceDeps,
): ReadonlyMap<string, ArtworkSource> {
  return new Map<string, ArtworkSource>([
    ['tmdb', createTmdbSource(deps)],
    ['tpdb', createTpdbSource(deps)],
  ]);
}
