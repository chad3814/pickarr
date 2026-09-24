/**
 * The artwork seam: what a provider looks like to the rest of this tree, and
 * the one pure decision every provider's images are put through.
 *
 * The lookup service (openmetadata) identifies a release but exposes no
 * artwork at all -- checked against its live OpenAPI document, not assumed.
 * What it gives instead is `provider` and `providerRef`, so artwork is
 * fetched straight from whichever provider matched, through the interface
 * below. Nothing in this file calls a provider's API; later tasks implement
 * `ArtworkSource` for each provider and register it in `createArtworkSources`,
 * and are the first callers of `bestImage`.
 */
import type { HostFetch } from '@pickarr/contract';
import type { SecretResolver } from '../types.ts';

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
 * Empty for now, **on purpose**. This task owns only the seam and the map's
 * shape; a later task registers each provider's real `ArtworkSource` here
 * once it is implemented. Nothing is excluded by design -- an empty map is
 * simply the honest answer for "which providers have a registered source"
 * before any provider task has landed. Do not pre-populate an entry for a
 * provider whose implementation this task did not write: a guessed
 * `ArtworkSource` is a wrong one that compiles.
 */
export function createArtworkSources(
  deps: ArtworkSourceDeps,
): ReadonlyMap<string, ArtworkSource> {
  // `deps` is threaded through unused until the first provider is
  // registered. Naming it (rather than `_deps`) keeps the signature honest
  // about what a real provider will need -- a fetch queue and a secret
  // resolver -- without erasable-syntax-only stripping the parameter name.
  void deps;
  return new Map();
}
