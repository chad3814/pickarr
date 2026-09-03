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

/**
 * The fields a lookup answer can revise on an existing media item.
 *
 * Deliberately not `pluginId`, `provider` or `providerRef`: ownership does
 * not change after `createMediaItem`, and the provider reference is
 * `claimProviderRef`'s to write -- a second writer for it would race with
 * the unique index that method relies on. A full replacement, not a partial
 * patch, because `exactOptionalPropertyTypes` makes an absent field
 * ambiguous between "leave it" and "set it null", and a lookup answers with
 * all three fields anyway.
 */
export interface MediaItemUpdate {
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
 * The intended way a plugin writes shared rows, not the only way: a plugin's
 * `PluginContext.db` is the same raw connection the shared tables live in, so
 * nothing stops a plugin from writing to `media_item`, `role` and the rest
 * directly instead. The two invariants below hold only for writes that go
 * through this interface.
 */
export interface MediaWriter {
  createMediaItem(init: MediaItemInit): Promise<number>;

  /**
   * Replaces `title`, `releaseDate` and `description` on an existing media
   * item -- the fields a lookup answer fills in, so a row can be created
   * when an rss item arrives and completed once the lookup answers, rather
   * than waiting on the answer to create it at all. Throws if `mediaItemId`
   * does not exist, and bumps `updated_at` from the injected clock like
   * every other mutating method here.
   */
  updateMediaItem(mediaItemId: number, update: MediaItemUpdate): Promise<void>;

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

  /**
   * Attaches a poster, keyed on its url: attaching the same url twice leaves
   * one row, so a handler re-run by crash recovery does not double-write.
   *
   * Nothing calls this yet. The image slice is where posters are fetched and
   * chosen; the method is here because a media item's artwork is a shared row
   * and shared rows have one writer.
   */
  attachPoster(mediaItemId: number, poster: PosterInit): Promise<void>;
  /** As `attachPoster`, for a backdrop. Also uncalled until the image slice. */
  attachBackground(mediaItemId: number, background: BackgroundInit): Promise<void>;
  upsertPerson(person: PersonInit): Promise<number>;
  /**
   * Attaches one person's part in one item, keyed on
   * `(mediaItemId, personId, role)`: re-attaching the same part updates that
   * row rather than adding a second, so a handler is safe to run twice and a
   * dedup that re-attaches the loser's cast onto the winner cannot duplicate
   * the people the two answers shared.
   */
  attachRole(mediaItemId: number, role: RoleInit): Promise<void>;
  setResolution(rssItemId: number, resolution: Resolution, detail: string | null): Promise<void>;
}
