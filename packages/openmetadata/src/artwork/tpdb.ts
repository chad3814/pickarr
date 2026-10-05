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
 *   us **answers 200**, and an earlier revision of this docblock claimed a
 *   404. That 404 came from asking with a scene-specific `performers[].id`,
 *   which openmetadata never sends; the ref it does send is the canonical
 *   performer and the endpoint serves it. Reading the cast out of the scene
 *   payload is still right -- it costs no extra request where a per-person
 *   fetch would cost one each -- but the reason is economy, not a 404. The
 *   mis-attributed 404 is what hid the matching bug below for a whole
 *   release: it made `performers[].id` look like the only usable key.
 * - **A scene's `performers[].id` is not the ref openmetadata sends.** It
 *   is a scene-specific record; the ref arrives as `performers[].parent.id`.
 *   Measured on one real scene: openmetadata's ref for its lead performer
 *   is `7a7a5268-…`, and the embedded `performers[].id` is `bb98a9ae-…`.
 *   Both are populated with `image`, `thumbnail` and `face`, which is why
 *   one request still answers the whole cast -- but only if the match is
 *   made on the parent. See the loop in `imagesFor`.
 * - The `parent` also carries `posters`, the canonical performer's gallery
 *   as `{id, order, size, url}[]`, capped at five in the scene payload
 *   (measured 2026-10-05: five embedded against sixteen on
 *   `/performers/{id}`). Five is `ARTWORK_KEEP`, so the scene call still
 *   answers everything the job would store and no per-person request is
 *   made. See `TpdbPersonImages`.
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

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) fail(field, 'is not a number');
  return value;
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

/**
 * One entry of a performer's `posters` list. Only `order` and `url` are
 * read; the live entry also carries `id` and `size`, which nothing here
 * needs.
 */
interface TpdbPoster {
  readonly order: number;
  readonly url: string;
}

function readPoster(value: unknown, field: string): TpdbPoster {
  const raw = object(value, field);
  return {
    order: number(raw['order'], `${field}.order`),
    url: string(raw['url'], `${field}.url`),
  };
}

/**
 * The image fields shared by an embedded performer and its `parent`.
 *
 * `posters` is the list the single fields are the head of. Measured live
 * (2026-10-05): a scene's `performers[].parent` carries `posters` as
 * `{id, order, size, url}[]`, at most five entries, with `posters[0].url`
 * equal to the outer `image`; the same performer's `/performers/{id}`
 * record carried sixteen. The embedded `performers[]` record itself had no
 * `posters` key on any of the twenty sampled, so an absent key is read as
 * an empty list rather than an error -- and the key is still read on the
 * own record, because nothing observed rules it out.
 */
interface TpdbPersonImages {
  readonly image: string | null;
  readonly thumbnail: string | null;
  readonly face: string | null;
  readonly posters: readonly TpdbPoster[];
}

function readPersonImages(raw: Readonly<Record<string, unknown>>, field: string): TpdbPersonImages {
  const posters = raw['posters'];
  return {
    image: nullableString(raw['image'], `${field}.image`),
    thumbnail: nullableString(raw['thumbnail'], `${field}.thumbnail`),
    face: nullableString(raw['face'], `${field}.face`),
    posters: posters === null || posters === undefined
      ? []
      : array(posters, `${field}.posters`).map((entry, index) => readPoster(entry, `${field}.posters[${index}]`)),
  };
}

/**
 * `image` first, and this order was reversed.
 *
 * It used to prefer `face`, on the reasoning that a 500x500 crop is "the
 * bounded choice, for the same reason a sized scene image beats
 * `original`". Measured on one real performer, that reasoning does not
 * survive the numbers:
 *
 * - `image`     633x950, 74 KB -- the full portrait
 * - `thumbnail` 200x300, 21 KB
 * - `face`      500x500, 46 KB -- url literally `/500x500/smart/`
 *
 * So `face` was buying 28 KB against the full image while cropping the
 * subject's body out of the frame, and a gallery showed a square head
 * where the provider shows a portrait. It is not a bound worth having:
 * `./job.ts` caps every download at 8 MiB regardless, which is what
 * actually protects the host, and 74 KB is nowhere near it.
 *
 * `thumbnail` is the middle choice at 200x300 -- small, but the right
 * shape -- and `face` stays last rather than being dropped, because a
 * cropped picture of the right person still beats no picture.
 */
function pickPersonUrl(images: TpdbPersonImages): string | null {
  return images.image ?? images.thumbnail ?? images.face;
}

/**
 * Every picture one record offers for a person: the `posters` list when it
 * has entries, otherwise the one url `pickPersonUrl` settles on.
 *
 * The outer `image` is `posters[0].url` on every record measured, so
 * returning the list alone adds nothing twice and drops nothing. An empty
 * list was also observed live -- `posters: []` beside a populated `image`
 * -- and must not read as "no picture", hence the fallback.
 *
 * Each poster's `score` is `-order`. `rankImages` (`./source.ts`) sorts
 * equal scores by url string, and these are hashed CDN paths whose hashes
 * have nothing to do with `order`: on the sampled record the url sort put
 * order 5 first and order 2 before order 1. A score that falls as `order`
 * rises is what carries the provider's ranking through that sort; the
 * `providerImage` docblock's `score: 0` is for the scene's own images,
 * which have no order to carry.
 */
function pickPersonImages(images: TpdbPersonImages): readonly ProviderImage[] {
  if (images.posters.length > 0) {
    return images.posters.map((poster) => ({ url: poster.url, language: null, score: -poster.order }));
  }
  const url = pickPersonUrl(images);
  return url === null ? [] : [providerImage(url)];
}

interface TpdbPerformer {
  /** The scene-specific performer record's id. **Not** the ref openmetadata sends. */
  readonly id: string;
  /**
   * The canonical performer's id, which **is** the ref openmetadata sends.
   *
   * Nullable because a parent object need not carry one, and because a
   * performer may have no parent at all.
   */
  readonly parentId: string | null;
  readonly own: TpdbPersonImages;
  readonly parent: TpdbPersonImages | null;
}

function readPerformer(value: unknown, field: string): TpdbPerformer {
  const raw = object(value, field);
  const parentValue = raw['parent'];
  const parent = parentValue === null || parentValue === undefined
    ? null
    : object(parentValue, `${field}.parent`);
  return {
    id: string(raw['id'], `${field}.id`),
    parentId: parent === null ? null : nullableString(parent['id'], `${field}.parent.id`),
    own: readPersonImages(raw, field),
    parent: parent === null ? null : readPersonImages(parent, `${field}.parent`),
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
 * default *from*. With every score equal, `rankImages`'s final tie-break is
 * the url string, so among several zero-scored images the order is
 * alphabetical by url, **not** the order this source returned them in.
 * That is harmless here because this wrapper is only used where there is
 * one image (a scene's poster, its background, a performer's lone url); a
 * performer's `posters` list carries an `order` and is scored by it in
 * `pickPersonImages` instead.
 */
function providerImage(url: string): ProviderImage {
  return { url, language: null, score: 0 };
}

/** Builds ThePornDB's `ArtworkSource`. */
export function createTpdbSource(deps: ArtworkSourceDeps): ArtworkSource {
  return {
    // The seam's fourth argument, `parents`, is deliberately not taken:
    // it exists for a provider whose endpoints do not cover every kind it
    // is asked about, and this one has exactly one endpoint for exactly
    // one kind. A `scene` is answered by `/scenes/{uuid}` directly, and
    // for anything else there is no url to build from an ancestor either.
    async imagesFor(kind, providerRef, personRefs) {
      // This provider has one endpoint, for one kind. A kind it cannot
      // answer for (movie, series, ...) asks nothing at all -- checked
      // before a secret is even resolved, so an unsupported kind costs
      // nothing, not even a resolver call.
      if (kind !== SUPPORTED_KIND) return emptyAnswer();

      let key: string;
      try {
        key = await deps.resolveSecret(API_KEY_SECRET);
      } catch (error) {
        // No key configured: an operator who has not set up ThePornDB sees
        // no error and gets no artwork from it, the same way a host with no
        // openmetadata key declines to look anything up rather than
        // failing. `noCredential` marks that case so `./job.ts` can say it
        // once per provider instead of leaving blank cards unexplained.
        //
        // Narrowed on `Error.name` rather than swallowing everything --
        // the same test `./tmdb.ts` makes, for the same reason and by the
        // same means. This package does not import `@pickarr/host`, so
        // `instanceof SecretNotFound` is unavailable; the *name* is not,
        // and it is what `packages/host/src/secrets/names.ts` exports as
        // `SecretNotFound.name`. Anything else -- `SecretsFileUnreadable`
        // above all, which `README.md` records as a live Docker failure
        // where `/run/secrets` is root-owned -- is a real misconfiguration
        // and must surface as one, not read as "artwork is turned off".
        if (error instanceof Error && error.name === 'SecretNotFound') {
          return { ...emptyAnswer(), noCredential: true };
        }
        throw error;
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
        // **`parentId` first, and that ordering is the whole fix.** See
        // `TpdbPerformer`: the ref openmetadata sends is the canonical
        // performer's id, which lives at `performers[].parent.id`, while
        // `performers[].id` is a scene-specific record. Matching only the
        // latter matched nothing, so no adult release ever stored a cast
        // picture. `id` is still accepted, for a performer with no parent.
        const performer = scene.performers.find(
          (entry) => entry.parentId === ref || entry.id === ref,
        );
        if (performer === undefined) continue;
        // The parent first when it has a `posters` list: that is the
        // canonical performer's gallery, and the scene-specific record was
        // never seen to carry one. Otherwise the own record, then the
        // parent's single fields -- the own-then-parent order this source
        // always had for records without a list.
        const { own, parent } = performer;
        const records = parent === null
          ? [own]
          : parent.posters.length > 0 ? [parent, own] : [own, parent];
        const personImages = records.map(pickPersonImages).find((images) => images.length > 0) ?? [];
        // A performer present but with every image field null omits the key,
        // the same way a source with nothing for a person always does.
        if (personImages.length > 0) people.set(ref, personImages);
      }

      return { media, people };
    },
  };
}
