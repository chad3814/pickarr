/**
 * The lookup API's wire shapes, mirrored from `openmetadata.json` (OpenAPI
 * 3.1) rather than inferred from a response. Where the document says a field
 * is required, it is required here; where it says `type: [x, "null"]`, it is
 * nullable here. Nothing is optional: the document marks every field of every
 * schema below as required, so an absent one is a service that changed and
 * `validate.ts` is where that is caught.
 */

/** `POST /api/v1/lookup`'s `category`. Note `movies`, plural, against the contract's `movie`. */
export type LookupCategory = 'tv' | 'movies' | 'books' | 'xxx';

export type LookupState = 'resolved' | 'unresolved' | 'pending';

export type MediaKind = 'movie' | 'series' | 'season' | 'episode' | 'book' | 'scene';

/** What `details` may hold: the document's `additionalProperties` is exactly this union. */
export type DetailValue = string | number | null;

/** An ancestor of a media record: the same fields as `Media` minus the four it does not carry. */
export interface MediaParent {
  readonly id: string;
  readonly kind: MediaKind;
  readonly title: string;
  /** ISO date, provider-supplied. */
  readonly releaseDate: string | null;
  readonly year: number | null;
  readonly provider: string;
  readonly providerRef: string;
}

export interface MediaPerson {
  readonly providerRef: string;
  readonly name: string;
  /** The service's own vocabulary -- `cast`, `director`, and whatever else it sends. */
  readonly role: string;
  readonly characterName: string | null;
  readonly billingOrder: number | null;
}

export interface Media extends MediaParent {
  readonly overview: string | null;
  /**
   * Whichever detail table matches `kind`, flattened. Keys differ by kind and
   * the document specifies them for `scene` and `movie` only, which is why
   * every plugin stores this object verbatim alongside the keys it reads.
   */
  readonly details: Readonly<Record<string, DetailValue>>;
  /** Nearest first: an episode's are its season, then its series. */
  readonly parents: readonly MediaParent[];
  readonly people: readonly MediaPerson[];
}

export interface SuggestedName {
  readonly name: string;
  readonly providerRef: string;
}

/** Present only when `state` is `unresolved`, and only for a name we part-recognise. */
export interface MediaSuggestions {
  readonly site: SuggestedName | null;
  readonly performers: readonly SuggestedName[];
}

export interface LookupEnvelope {
  readonly lookupId: string;
  readonly state: LookupState;
  /** The lookup ran out of time; a background job will finish it. Read before `state`. */
  readonly partial: boolean;
  readonly cached: boolean;
  /** 0 to 1. Null when nothing was scored. */
  readonly confidence: number | null;
  /** Why this name is not a media file. A refusal is a successful answer. */
  readonly refusal: string | null;
  /**
   * The parse behind the answer. Carried through unvalidated beyond "object or
   * null": nothing in this tree reads it, and the document gives it no shape.
   */
  readonly parsed: Readonly<Record<string, unknown>> | null;
  readonly media: Media | null;
  readonly suggestions: MediaSuggestions | null;
}

/** One entry of a batch answer: an envelope plus the status it would have had alone. */
export interface LookupBatchEntry extends LookupEnvelope {
  readonly status: number;
}

/**
 * A batch answer: one entry per item, **in the order the items were sent**,
 * carrying no echoed name. That is why `engine.ts` matches by position.
 */
export interface LookupBatchResponse {
  readonly results: readonly LookupBatchEntry[];
}

/**
 * How a credential is obtained. Structurally identical to the host's own
 * `ResolveSecret` (`packages/host/src/secrets.ts`) by design -- this package
 * must not import from `@pickarr/host`, and structural typing is what lets the
 * host pass its resolver in without either side depending on the other.
 *
 * Async and per-request rather than a resolved string: a store that rotates a
 * credential can, where a value read once at boot cannot.
 */
export type SecretResolver = (key: string) => Promise<string>;

/** The logical key the three plugins ask for. The host maps it to a variable. */
export const API_KEY_SECRET = 'openmetadata-api-key';
