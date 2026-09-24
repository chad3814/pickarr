/**
 * ThePornDB's `ArtworkSource`: one call, answering both the scene's own
 * artwork and every person's, because that is the only shape this provider
 * has to offer.
 *
 * Verified against the live API with a real token (2026-09-24), not
 * remembered from any earlier draft:
 *
 * - `GET https://api.theporndb.net/scenes/{uuid}`, with `Authorization:
 *   Bearer <token>` and `Accept: application/json`, answers `{ data: {…} }`
 *   -- the scene sits under `data`, not at the response's top level.
 * - The uuid is openmetadata's `media.providerRef`; a real release resolved
 *   to `provider: 'tpdb'` and that ref answered 200 at this path.
 * - The scene carries `posters` and `background`, each `{full, large,
 *   medium, small}`, and a `performers` array. There is no logo anywhere in
 *   the payload and no endpoint that would answer one.
 * - `GET /performers/{ref}` for a `people[].providerRef` openmetadata gave
 *   us answers 404 -- that ref is a scene-specific performer record, not a
 *   canonical one, and has no standalone fetch behind it at all. But the
 *   scene's own `performers[]` embeds that exact ref as `id`, with `image`,
 *   `thumbnail` and `face` populated, which is the whole reason this source
 *   needs only the one request.
 *
 * One shape is tolerated on the strength of a recorded observation rather
 * than a live check: 1.x's design doc records records where the outer
 * `image`/`thumbnail`/`face` are all null and the real picture and identity
 * hang off `performers[].parent` instead. The record sampled for *this*
 * task had the opposite -- outer fields populated, `parent` null -- so both
 * shapes are read, own fields preferred, `parent` as the fallback.
 */
import type { ArtworkAnswer, ArtworkSource, ArtworkSourceDeps, MediaImages, ProviderImage } from './source.ts';

/**
 * The logical secret name, resolved through the same chain the lookup key
 * uses. Lowercase and hyphenated because `assertSecretName`
 * (`packages/host/src/secrets/names.ts`) requires it -- an earlier draft of
 * the design this implements named it in upper case, which `assertSecretName`
 * would have rejected outright. `envNameFor`, in that same file, maps this
 * exact string to the environment variable an operator actually sets:
 * `tpdb-api-key` -> uppercase, hyphens to underscores, `PICKARR_SECRET_`
 * prefixed -> `PICKARR_SECRET_TPDB_API_KEY`.
 */
const API_KEY_SECRET = 'tpdb-api-key';

const BASE_URL = 'https://api.theporndb.net';

/** The only `kind` this provider has an endpoint for. */
const SUPPORTED_KIND = 'scene';

function emptyAnswer(): ArtworkAnswer {
  return { media: { posters: [], backgrounds: [], logos: [] }, people: new Map() };
}

function fail(field: string, why: string): never {
  throw new TypeError(`tpdb: ${field} ${why}`);
}

function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(field, 'is not an object');
  }
  // Checked above: a non-null, non-array `object`. TS has no narrower builtin
  // type for "plain object with unknown keys", so this cast documents that
  // check rather than working around it -- the same shape `validate.ts`'s
  // own `object()` uses for the same reason.
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(field, 'is not a string');
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return string(value, field);
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(field, 'is not an array');
  return value;
}

/** `posters` or `background`: the four sized variants a scene carries for one image. */
interface TpdbSizes {
  readonly full: string | null;
  readonly large: string | null;
  readonly medium: string | null;
  readonly small: string | null;
}

/** Absent entirely is tolerated the same as present-but-all-null: both mean "nothing here". */
function readSizes(value: unknown, field: string): TpdbSizes | null {
  if (value === null || value === undefined) return null;
  const raw = object(value, field);
  return {
    full: nullableString(raw['full'], `${field}.full`),
    large: nullableString(raw['large'], `${field}.large`),
    medium: nullableString(raw['medium'], `${field}.medium`),
    small: nullableString(raw['small'], `${field}.small`),
  };
}

/**
 * Prefers a sized variant over `full`: `HostFetch.bytes` reads a whole
 * `arrayBuffer()` with no size cap, so an unbounded image from this CDN is
 * an unbounded allocation in the host. `large` first, `medium` next, and
 * `full` only when neither of the smaller two exists.
 */
function pickSizedUrl(sizes: TpdbSizes | null): string | null {
  if (sizes === null) return null;
  return sizes.large ?? sizes.medium ?? sizes.full;
}

/** The three image fields shared by a performer and, on the shape this task tolerates but did not see live, its `parent`. */
interface TpdbPersonImages {
  readonly image: string | null;
  readonly thumbnail: string | null;
  readonly face: string | null;
}

function readPersonImages(raw: Readonly<Record<string, unknown>>, field: string): TpdbPersonImages {
  return {
    image: nullableString(raw['image'], `${field}.image`),
    thumbnail: nullableString(raw['thumbnail'], `${field}.thumbnail`),
    face: nullableString(raw['face'], `${field}.face`),
  };
}

/**
 * `face` is a 500x500 crop -- the bounded choice, for the same reason a
 * sized scene image beats `original`. `thumbnail`, then `image`, in that
 * order, only when the smaller ones this provider bothered to crop are
 * missing.
 */
function pickPersonUrl(images: TpdbPersonImages): string | null {
  return images.face ?? images.thumbnail ?? images.image;
}

interface TpdbPerformer {
  readonly id: string;
  readonly own: TpdbPersonImages;
  /** `null` on the sample this task read live; populated on the shape 1.x recorded and this reads defensively. */
  readonly parent: TpdbPersonImages | null;
}

function readPerformer(value: unknown, field: string): TpdbPerformer {
  const raw = object(value, field);
  const parentValue = raw['parent'];
  return {
    id: string(raw['id'], `${field}.id`),
    own: readPersonImages(raw, field),
    parent: parentValue === null || parentValue === undefined
      ? null
      : readPersonImages(object(parentValue, `${field}.parent`), `${field}.parent`),
  };
}

interface TpdbScene {
  readonly posters: TpdbSizes | null;
  readonly background: TpdbSizes | null;
  readonly performers: readonly TpdbPerformer[];
}

/** Unwraps the `{ data: {…} }` envelope and reads only the fields this source uses. */
function readScene(value: unknown): TpdbScene {
  const envelope = object(value, 'response');
  const raw = object(envelope['data'], 'data');
  return {
    posters: readSizes(raw['posters'], 'data.posters'),
    background: readSizes(raw['background'], 'data.background'),
    performers: array(raw['performers'], 'data.performers')
      .map((entry, index) => readPerformer(entry, `data.performers[${index}]`)),
  };
}

/**
 * Wraps a bare url as a `ProviderImage`. `score: 0` and `language: null` are
 * not stand-ins for a missing value -- ThePornDB's scene payload carries no
 * vote and no language for any image it returns, so there is nothing to
 * default *from*. `bestImage`'s language/score tiers therefore have nothing
 * to discriminate on for this provider, and degrade to "the first image
 * this source returned" by construction, not by a tie-break coincidence.
 */
function providerImage(url: string): ProviderImage {
  return { url, language: null, score: 0 };
}

/** Builds ThePornDB's `ArtworkSource`. */
export function createTpdbSource(deps: ArtworkSourceDeps): ArtworkSource {
  return {
    async imagesFor(kind, providerRef, personRefs) {
      // This provider has one endpoint, for one kind. A kind it cannot
      // answer for (movie, series, ...) asks nothing at all -- checked
      // before a secret is even resolved, so an unsupported kind costs
      // nothing, not even a resolver call.
      if (kind !== SUPPORTED_KIND) return emptyAnswer();

      let key: string;
      try {
        key = await deps.resolveSecret(API_KEY_SECRET);
      } catch {
        // No key configured: an operator who has not set up ThePornDB sees
        // no error and gets no artwork from it, the same way a host with no
        // openmetadata key declines to look anything up rather than
        // failing. Whatever `resolveSecret` throws (`SecretNotFound` today,
        // structurally -- this package cannot import the host's class to
        // narrow it) is treated as "no key", not inspected further.
        return emptyAnswer();
      }

      const url = `${BASE_URL}/scenes/${encodeURIComponent(providerRef)}`;
      const body = await deps.fetch.json<unknown>(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      });
      const scene = readScene(body);

      const posterUrl = pickSizedUrl(scene.posters);
      const backgroundUrl = pickSizedUrl(scene.background);
      const media: MediaImages = {
        posters: posterUrl === null ? [] : [providerImage(posterUrl)],
        backgrounds: backgroundUrl === null ? [] : [providerImage(backgroundUrl)],
        // Verified against the live payload, not assumed: a scene carries
        // nothing shaped like a logo, and there is no endpoint that would
        // answer one.
        logos: [],
      };

      // One scene call answers every person's picture too: each requested
      // ref is matched against `performers[].id`, which is the exact ref
      // openmetadata handed the caller -- no per-person request is made,
      // because there is nothing to request against.
      const people = new Map<string, readonly ProviderImage[]>();
      for (const ref of personRefs) {
        const performer = scene.performers.find((entry) => entry.id === ref);
        if (performer === undefined) continue;
        const personUrl = pickPersonUrl(performer.own)
          ?? (performer.parent === null ? null : pickPersonUrl(performer.parent));
        // A performer present but with every image field null omits the key,
        // the same way a source with nothing for a person always does.
        if (personUrl !== null) people.set(ref, [providerImage(personUrl)]);
      }

      return { media, people };
    },
  };
}
