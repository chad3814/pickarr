/**
 * What became of an rss item's identification.
 *
 * `refused` and `unresolved` are different and neither is an error. A refusal
 * is the parser service successfully identifying a non-media file — a subtitle
 * or sidecar — and is terminal: retrying it forever, or showing it to a reader
 * as a problem, are both wrong. `unresolved` means the name was not
 * recognised, which is the state a human might fix.
 */
export type Resolution = 'pending' | 'resolved' | 'refused' | 'unresolved';

export interface MediaItemInit {
  /** Which plugin owns this item. */
  pluginId: string;
  title: string;
  releaseDate: string | null;
  description: string | null;
}

export interface PosterInit {
  title: string | null;
  language: string | null;
  url: string;
  width: number;
  height: number;
}

export interface BackgroundInit {
  title: string | null;
  description: string | null;
  language: string | null;
  url: string;
  width: number;
  height: number;
}

export interface PersonInit {
  name: string;
  /** The provider's own person id, for de-duplicating across lookups. */
  providerRef: string;
}

export interface RoleInit {
  personId: number;
  role: string;
  /** The character's name where the provider gives one. */
  name: string | null;
  billingOrder: number | null;
}

/** The outcome of claiming a provider reference. See `MediaWriter`. */
export interface ProviderClaim {
  /** The media item that now owns the reference. */
  kept: number;
  /** The caller's item, if it lost and must not be used again. */
  dropped: number | null;
}

/**
 * The only way a plugin writes shared rows.
 *
 * Plugins use Drizzle freely on their own tables; shared tables have exactly
 * one writer so that the two invariants below cannot drift between plugins.
 */
export interface MediaWriter {
  createMediaItem(init: MediaItemInit): Promise<number>;

  /**
   * Claims `(provider, ref)` for `mediaItemId`, or reports who already holds it.
   *
   * This is the dedup step, and it is a race whenever two rss items resolve to
   * the same reference at once. A unique index on `(provider, provider_ref)`
   * makes losing the race a constraint violation this method resolves, rather
   * than something four plugins each have to lose gracefully.
   */
  claimProviderRef(mediaItemId: number, provider: string, ref: string): Promise<ProviderClaim>;

  /** Repoints an rss item at a different media item. */
  relinkRssItem(rssItemId: number, mediaItemId: number): Promise<void>;

  /** Deletes a media item that lost a provider-ref claim. */
  dropMediaItem(mediaItemId: number): Promise<void>;

  attachPoster(mediaItemId: number, poster: PosterInit): Promise<void>;
  attachBackground(mediaItemId: number, background: BackgroundInit): Promise<void>;
  upsertPerson(person: PersonInit): Promise<number>;
  attachRole(mediaItemId: number, role: RoleInit): Promise<void>;
  setResolution(rssItemId: number, resolution: Resolution, detail: string | null): Promise<void>;
}
