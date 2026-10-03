/**
 * The artwork job: one resolved media item in, cached poster, background,
 * logo and cast pictures out.
 *
 * **A job of its own, never part of the resolved branch.** `applyResolved`
 * (`../engine.ts`) relinks the release, writes the plugin's rows and records
 * the resolution, and anything that throws between those strands state.
 * Artwork is the worst thing to put there: one provider call and then a
 * binary download per image kept -- three for the item plus one per cast
 * member -- from a CDN this host does not control. A slow image server
 * would make the lookup's duration depend on it, and a failing one would
 * fail the identification and re-run the whole thing on retry. Here, the
 * release stays identified whatever its pictures do.
 *
 * **Which provider is asked is the payload's business, not this file's.**
 * The registry in `./source.ts` keys an `ArtworkSource` by the same
 * `provider` string the lookup service puts on a `Media` record; this
 * handler looks one up and calls the seam's single `imagesFor`. It never
 * learns whether that source answered `people` from the media payload it
 * had already fetched (ThePornDB) or from its own per-person calls (TMDB) --
 * that is exactly what the one-call seam exists to hide.
 */
import type { HostFetch, ImageInit, JobHandler, PluginContext } from '@pickarr/contract';
import type { SecretResolver } from '../types.ts';
import type { ArtworkParent, ArtworkSource, ArtworkSourceDeps, ProviderImage } from './source.ts';
import { createArtworkSources, rankImages } from './source.ts';

/**
 * How many images the job keeps of each kind, per media item and per person.
 * The five best by {@link rankImages}; a row's `rank` is its index in that
 * order, 0 best.
 */
export const ARTWORK_KEEP = 5;

/** The job kind. `../engine.ts` registers the handler under it and enqueues it. */
export const ARTWORK_JOB = 'artwork';

/**
 * The post-download ceiling, and **the second line of defence rather than
 * the first**. A reader who sees only this number will misjudge where the
 * real bound is.
 *
 * The first line is at the provider: both sources ask for a *sized variant*
 * rather than the original -- `./tmdb.ts` builds its urls from `w780`,
 * `w1280`, `w300` and `w185`, and `./tpdb.ts` prefers `large`/`medium` over
 * `full` and a performer's cropped `face` over the full `image`. That is
 * what actually bounds a download, because it bounds what the CDN is asked
 * to send.
 *
 * This exists because "sized" is the provider's promise, not ours, and
 * `HostFetch.bytes` reads a whole `arrayBuffer()` with **no cap** --
 * `packages/host/src/fetch/queue.ts` does
 * `new Uint8Array(await res.arrayBuffer())` and nothing else, read rather
 * than assumed. Note precisely what that buys: by the time this check runs
 * the bytes are already resident, so it does **not** protect the host's
 * memory. It protects the row and the disk -- a provider that ignores a
 * sized request cannot make this host cache an arbitrarily large file for a
 * card whose poster frame is `--size-poster: 6rem`.
 *
 * 8 MiB is far above any sized variant either provider publishes and far
 * below a figure that would hurt a host with a few thousand items.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * The language `rankImages` prefers.
 *
 * A constant because there is no host-level language setting to read:
 * nothing in `packages/host/src/config/` names one, and every `language`
 * in `packages/host/src` is the artwork tables' own column -- the *image's*
 * language rather than the operator's. Overridable through
 * `ArtworkJobDeps.language` so that whoever adds that setting has one place
 * to thread it through, rather than a literal buried in a comparison.
 */
const DEFAULT_LANGUAGE = 'en';

/** One person, as the enqueuing side already knows them. */
export interface ArtworkJobPerson {
  /** The `person` row `MediaWriter.upsertPerson` returned. */
  readonly personId: number;
  /** The provider's own person id -- the key `ArtworkAnswer.people` is keyed by. */
  readonly providerRef: string;
}

/**
 * What the job is enqueued with.
 *
 * Self-contained on purpose: every field here is known at the moment
 * `applyResolved` finishes, and carrying them means this handler reads no
 * host table at all. The alternative -- a bare `mediaItemId` and a join back
 * through `role` to `person` -- would need hand-written SQL against tables
 * this package does not own, and would still not recover `kind`, which
 * `media_item` has no column for (checked against the host's DDL).
 *
 * `personId` travels beside `providerRef` because the two halves live on
 * different sides of the seam: `imagesFor` is asked in the provider's
 * vocabulary (`providerRef`) and `attachPersonImage` is told in the
 * database's (`personId`), and nothing downstream can convert between them.
 */
export interface ArtworkJobPayload {
  readonly mediaItemId: number;
  /** openmetadata's `MediaKind`, passed through to the source unchanged. */
  readonly kind: string;
  readonly provider: string;
  readonly providerRef: string;
  readonly people: readonly ArtworkJobPerson[];
  /**
   * The item's ancestors, nearest first, passed through to the source
   * unchanged -- what lets a provider answer a kind it has no endpoint of
   * its own for (TMDB and every episode, see `ArtworkSource`).
   *
   * Carried in the payload for the same reason every other field here is:
   * `../engine.ts` has them on the `Media` record at the moment it
   * enqueues, and this handler reads no host table at all.
   */
  readonly parents: readonly ArtworkParent[];
}

function readPerson(value: unknown, index: number): ArtworkJobPerson {
  if (typeof value !== 'object' || value === null
    || !('personId' in value) || !('providerRef' in value)) {
    throw new TypeError(`openmetadata: artwork payload people[${index}] must carry personId and providerRef`);
  }
  const { personId, providerRef } = value;
  if (typeof personId !== 'number' || typeof providerRef !== 'string') {
    throw new TypeError(`openmetadata: artwork payload people[${index}] must carry personId and providerRef`);
  }
  return { personId, providerRef };
}

function readParent(value: unknown, index: number): ArtworkParent {
  if (typeof value !== 'object' || value === null
    || !('kind' in value) || !('providerRef' in value)) {
    throw new TypeError(`openmetadata: artwork payload parents[${index}] must carry kind and providerRef`);
  }
  const { kind, providerRef } = value;
  if (typeof kind !== 'string' || typeof providerRef !== 'string') {
    throw new TypeError(`openmetadata: artwork payload parents[${index}] must carry kind and providerRef`);
  }
  return { kind, providerRef };
}

/**
 * A payload off the jobs table is `unknown` -- it was JSON a moment ago --
 * so it is read rather than asserted, the same shape `readPollPayload` uses
 * in `../engine.ts`. A malformed payload throws, which fails this job and
 * nothing else.
 *
 * Private, like `readPollPayload`: what a caller needs from this module is
 * the payload *type* to build one, not the reader that checks it, and the
 * handler is what drives every branch below.
 */
function readArtworkPayload(payload: unknown): ArtworkJobPayload {
  if (typeof payload !== 'object' || payload === null
    || !('mediaItemId' in payload) || !('kind' in payload)
    || !('provider' in payload) || !('providerRef' in payload) || !('people' in payload)
    || !('parents' in payload)) {
    throw new TypeError(
      'openmetadata: an artwork payload must carry mediaItemId, kind, provider, providerRef, people and parents',
    );
  }
  const { mediaItemId, kind, provider, providerRef, people, parents } = payload;
  if (typeof mediaItemId !== 'number' || typeof kind !== 'string'
    || typeof provider !== 'string' || typeof providerRef !== 'string') {
    throw new TypeError(
      'openmetadata: an artwork payload must carry mediaItemId, kind, provider, providerRef, people and parents',
    );
  }
  if (!Array.isArray(people)) throw new TypeError('openmetadata: artwork payload people is not an array');
  if (!Array.isArray(parents)) throw new TypeError('openmetadata: artwork payload parents is not an array');
  return {
    mediaItemId,
    kind,
    provider,
    providerRef,
    people: people.map(readPerson),
    parents: parents.map(readParent),
  };
}

/**
 * One image this job intends to store: where to get it, and what to do with
 * the bytes once it has them.
 *
 * A closure rather than a tagged kind, because the four destinations are
 * four different `MediaWriter` methods with two different id types between
 * them -- `attachPersonImage` takes a `personId`, the other three a
 * `mediaItemId`, and `ArtworkStore` hashes those into deliberately disjoint
 * namespaces. Deciding which method to call where the id is still in scope
 * is what keeps a person's id from ever reaching a media item's writer.
 */
interface Slot {
  /** What a log line calls this image. */
  readonly what: string;
  readonly image: ProviderImage;
  attach(bytes: Uint8Array): Promise<void>;
}

/**
 * `title` is `null` because neither provider publishes one for an image:
 * TMDB's entries carry `file_path`, `iso_639_1` and `vote_average` and
 * ThePornDB's are bare urls (see both sources' response types). `width` and
 * `height` are absent from `ImageInit` by design -- the writer measures the
 * bytes, so a caller cannot supply a dimension that disagrees with the file.
 */
function imageInit(image: ProviderImage, bytes: Uint8Array, rank: number): ImageInit {
  // `rank` is the image's index in `rankImages`' order, 0 best.
  return { url: image.url, title: null, language: image.language, bytes, rank };
}

/**
 * One url reduced to origin and path -- no query, and no `user:pass@`
 * either, since `URL.origin` carries neither.
 *
 * Neither provider in the registry puts a credential in an image url --
 * TMDB builds `secure_base_url + size + file_path` and both send their
 * token in an `authorization` header -- so this is not redaction of a known
 * leak. It is that these urls are third-party strings this package never
 * constructs for ThePornDB (they arrive inside the scene payload), a signed
 * CDN url carries its signature in the query, and a log line is where a
 * future provider's would surface. `../engine.ts` has the same helper for
 * the same reason; it is private there and this package cannot import
 * `@pickarr/host`'s `redactUrl`.
 *
 * **The host's own net does not cover this, which is why the helper has to
 * be applied at every site rather than most of them.** `redactDetail`
 * (`host/src/clients/redact.ts`) walks a detail object and runs
 * `redactSecrets` over **string** values only -- its own docblock says so
 * and calls itself "the net under" the caller's rule, not a licence. So a
 * url that reaches a log inside any non-string value arrives untouched.
 */
function loggableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '(an unparseable url)';
  }
}

/**
 * A caught value as a log-safe string: its message, with every url inside
 * it put through {@link loggableUrl}.
 *
 * **Both halves are load-bearing and neither is ceremony.**
 *
 * The message rather than the error is the shape `../engine.ts`'s `logged`
 * already uses (`error instanceof Error ? error.message : String(error)`),
 * and here it is a correctness fix rather than a style match: `redactDetail`
 * is string-only, so an `Error` placed in a detail object passes through the
 * host's redaction entirely. Logging the error would have handed a raw
 * third-party string to a sink with nothing between.
 *
 * Rewriting the urls inside that message is the second half, because the
 * failure this most often carries is `ArtworkStore`'s own refusal, and that
 * message embeds the url **verbatim**: `host/src/artwork/store.ts` throws
 * `` `artwork store: bytes for ${url} could not be measured as an image` ``.
 * Sanitising only the separate `url` detail while the message beside it
 * repeated the same url with its query intact would be a guard that reads
 * as protection and is not.
 *
 * What this gives up, stated rather than hidden: the stack and the `cause`
 * chain. `ArtworkStore` attaches the `image-size` error as `cause` and only
 * the outer message survives here. That is the same trade `logged` makes,
 * and the diagnosis a reader needs -- which image, which url, which
 * failure -- is in the message and the two fields beside it.
 *
 * The match is deliberately coarse (`https?://` up to whitespace), so a url
 * followed immediately by punctuation keeps that punctuation on the end of
 * its path. Cosmetic: a query is still gone, which is the property this is
 * for.
 */
function loggableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, (found) => loggableUrl(found));
}

export interface ArtworkJobDeps {
  /** The same resolver the lookup client uses; each source asks for its own key. */
  resolveSecret: SecretResolver;
  /** Defaults to {@link DEFAULT_LANGUAGE}. */
  language?: string;
  /**
   * The registry to look a provider up in. Defaults to
   * `createArtworkSources`, which is what production wants; a test supplies
   * its own so that what it drives is *this* handler's behaviour rather than
   * TMDB's or ThePornDB's wire shape, both of which their own tests pin.
   */
  sources?: (deps: ArtworkSourceDeps) => ReadonlyMap<string, ArtworkSource>;
}

/**
 * The handler, closed over the state that has to outlive one job: which
 * providers have already been reported as unregistered, which have already
 * been reported as having no credential, and one registry per `HostFetch`.
 *
 * **All are per handler, not per job, and that is the point of the
 * factory.** A feed of a thousand adult releases on a host with no such
 * source registered -- or with one registered and no key for it -- must
 * produce one log line each, not a thousand; and TMDB's
 * source caches `/3/configuration` for its own lifetime, which is worth
 * nothing if a fresh source is built for every item. The registry is keyed
 * on `ctx.fetch` rather than built once at construction because a source
 * needs a `HostFetch` and the handler has none until a job arrives with a
 * `PluginContext`. Keyed rather than built on first use alone for the same
 * reason `../engine.ts` keys its Drizzle handles on the raw connection: the
 * cache stays correct if a second context ever shows up.
 */
export function createArtworkJob(deps: ArtworkJobDeps): JobHandler {
  const language = deps.language ?? DEFAULT_LANGUAGE;
  const createSources = deps.sources ?? createArtworkSources;
  const registries = new WeakMap<HostFetch, ReadonlyMap<string, ArtworkSource>>();
  const reportedUnregistered = new Set<string>();
  /**
   * Separate from `reportedUnregistered` because they are different facts
   * about a provider and an operator may need to be told either. They
   * cannot both happen for one provider today -- an unregistered provider
   * returns before a source is ever asked -- so one shared set would
   * behave identically now and silently swallow the second message the
   * day that stops being true.
   */
  const reportedNoCredential = new Set<string>();

  function sourcesFor(ctx: PluginContext): ReadonlyMap<string, ArtworkSource> {
    const existing = registries.get(ctx.fetch);
    if (existing !== undefined) return existing;
    const built = createSources({ fetch: ctx.fetch, resolveSecret: deps.resolveSecret });
    registries.set(ctx.fetch, built);
    return built;
  }

  /**
   * Downloads one image and stores it, or logs why it could not be.
   *
   * **Every failure here is contained to this one image**, and that is the
   * job's central behaviour rather than defensive habit. Three things can go
   * wrong per image and all three are ordinary: the CDN 404s a url the
   * provider gave us, the bytes exceed the cap, or `ArtworkStore` refuses
   * them because `image-size` cannot measure them -- which is what an html
   * error page served with status 200 looks like. None of those says
   * anything about the *other* images, so a bad poster must not cost the
   * backdrop or the cast.
   *
   * The failure is logged and not rethrown, so the job as a whole succeeds.
   * The cost is real and worth stating: an image lost to a transient blip is
   * not retried, and stays missing until the release is identified again.
   * Rethrowing would buy that retry at the price of re-downloading every
   * image that already succeeded, and of dead-lettering a job over one
   * permanently-unmeasurable url -- artwork is cosmetic and identification
   * is not, so the trade goes this way.
   */
  async function store(slot: Slot, ctx: PluginContext, signal?: AbortSignal): Promise<void> {
    try {
      // Two calls rather than one with `signal: undefined`:
      // `exactOptionalPropertyTypes` makes an absent key and an explicit
      // `undefined` different things, and `RequestInit.signal` is declared
      // `AbortSignal | null` with no `undefined` in it -- the same split
      // `../engine.ts`'s `clientFor` makes, for the same reason. The
      // dispatcher passes a real signal tied to its per-job ceiling, so
      // forwarding it is what lets a job downloading from a hung CDN be cut
      // off rather than holding a worker for the whole five minutes.
      const bytes = signal === undefined
        ? await ctx.fetch.bytes(slot.image.url)
        : await ctx.fetch.bytes(slot.image.url, { signal });
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        ctx.log('artwork: an image exceeded the size cap and was not stored', {
          what: slot.what,
          url: loggableUrl(slot.image.url),
          bytes: bytes.byteLength,
          cap: MAX_IMAGE_BYTES,
        });
        return;
      }
      await slot.attach(bytes);
    } catch (error) {
      ctx.log('artwork: one image could not be stored', {
        what: slot.what,
        url: loggableUrl(slot.image.url),
        // A string, not the `Error` -- see `loggableError`. The host's
        // `redactDetail` would walk past an object without looking inside.
        error: loggableError(error),
      });
    }
  }

  return async (job, ctx, signal) => {
    const payload = readArtworkPayload(job.payload);
    const source = sourcesFor(ctx).get(payload.provider);
    if (source === undefined) {
      // Once per provider for the life of this handler, counted rather than
      // hoped for: an unregistered provider is a property of the host's
      // configuration, so repeating it per item would turn one fact into a
      // line per release.
      if (!reportedUnregistered.has(payload.provider)) {
        reportedUnregistered.add(payload.provider);
        ctx.log('artwork: no source is registered for this provider, so its items get no artwork', {
          provider: payload.provider,
        });
      }
      return;
    }

    // Deliberately *not* caught. A source that throws has failed wholesale
    // -- a changed response shape, an unreadable secrets directory -- which
    // is not one image's problem and is worth a failed job that retries and
    // then dead-letters. Nothing has been written at this point, so the
    // media item is untouched and a retry costs one call.
    const answer = await source.imagesFor(
      payload.kind,
      payload.providerRef,
      payload.people.map((person) => person.providerRef),
      payload.parents,
    );

    // The design's "absent is not an error" rule, with the half that was
    // specified and missing: a host with no key for a provider "logs once
    // and fetches no artwork for it". Without this an operator with no
    // TMDB key gets blank cards and no diagnostic anywhere -- the sources
    // have no logger of their own, so the fact has to be reported here.
    // The provider is the only detail: which secret that provider wants
    // is the source's own business (`TMDB_TOKEN_SECRET`, `API_KEY_SECRET`)
    // and is written down for the operator in `README.md`'s Secrets
    // section. No credential value exists on this path to leak -- the
    // resolver rejected, so there is nothing resolved to log.
    if (answer.noCredential === true && !reportedNoCredential.has(payload.provider)) {
      reportedNoCredential.add(payload.provider);
      ctx.log('artwork: no credential is configured for this provider, so its items get no artwork', {
        provider: payload.provider,
      });
    }

    // The `ARTWORK_KEEP` best images of each kind, in `rankImages`' order:
    // an image's `rank` is its index, so the first poster is rank 0. The
    // same cut applies to each person's pictures, and anything past it is
    // never downloaded.
    //
    // `kept` collects the urls whose attach *succeeded*, because the keep
    // calls below delete every other row: a url whose download failed must
    // not be named, and a row an earlier run stored for it is dropped along
    // with the ones this run's ranking no longer includes.
    const slots: Slot[] = [];
    const kept = { poster: [] as string[], background: [] as string[], logo: [] as string[] };
    const people = new Map<number, string[]>();
    for (const [index, image] of rankImages(answer.media.posters, language).slice(0, ARTWORK_KEEP).entries()) {
      slots.push({
        what: `poster ${String(index)}`,
        image,
        attach: async (bytes) => {
          await ctx.media.attachPoster(payload.mediaItemId, imageInit(image, bytes, index));
          kept.poster.push(image.url);
        },
      });
    }
    for (const [index, image] of rankImages(answer.media.backgrounds, language).slice(0, ARTWORK_KEEP).entries()) {
      slots.push({
        what: `background ${String(index)}`,
        image,
        attach: async (bytes) => {
          await ctx.media.attachBackground(payload.mediaItemId, imageInit(image, bytes, index));
          kept.background.push(image.url);
        },
      });
    }
    for (const [index, image] of rankImages(answer.media.logos, language).slice(0, ARTWORK_KEEP).entries()) {
      slots.push({
        what: `logo ${String(index)}`,
        image,
        attach: async (bytes) => {
          await ctx.media.attachLogo(payload.mediaItemId, imageInit(image, bytes, index));
          kept.logo.push(image.url);
        },
      });
    }
    for (const person of payload.people) {
      // A source that found nothing for a person omits the key entirely --
      // ordinary, not an error, per `ArtworkAnswer.people`.
      const found = answer.people.get(person.providerRef);
      if (found === undefined) continue;
      const urls: string[] = [];
      people.set(person.personId, urls);
      for (const [index, image] of rankImages(found, language).slice(0, ARTWORK_KEEP).entries()) {
        slots.push({
          what: `person ${person.personId} ${String(index)}`,
          image,
          attach: async (bytes) => {
            await ctx.media.attachPersonImage(person.personId, imageInit(image, bytes, index));
            urls.push(image.url);
          },
        });
      }
    }

    // Concurrently, because `HostFetch` queues per hostname and decides how
    // many of a host's requests run at once -- one by default
    // (`host/src/fetch/queue.ts`). So this hands the host's own limiter a
    // list rather than firing a burst at whichever CDN these urls name.
    await Promise.all(slots.map((slot) => store(slot, ctx, signal)));

    // Once per kind, after every attach of that kind has settled -- `store`
    // never rejects, so the line above is a barrier, and a keep call that
    // ran earlier could delete a row an in-flight attach is about to name.
    // A kind with nothing stored is skipped rather than told to keep
    // nothing: naming no survivors deletes every image the item has, and
    // "the provider offered none" or "every download failed" is not a
    // reason to wipe what a previous run stored.
    if (kept.poster.length > 0) await ctx.media.keepArtwork('poster', payload.mediaItemId, kept.poster);
    if (kept.background.length > 0) await ctx.media.keepArtwork('background', payload.mediaItemId, kept.background);
    if (kept.logo.length > 0) await ctx.media.keepArtwork('logo', payload.mediaItemId, kept.logo);
    for (const [personId, urls] of people) {
      if (urls.length > 0) await ctx.media.keepPersonImages(personId, urls);
    }
  };
}
