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

/**
 * What a caller hands `attachPoster`, `attachBackground` and `attachLogo`.
 *
 * `width` and `height` are not here: `MediaWriter` measures the bytes itself
 * and caches them beside the row (see `createArtworkStore` in
 * `@pickarr/host`), so a caller cannot supply a dimension that disagrees
 * with the file it came with. `background`'s old `description` field has no
 * home here and stays unwritten -- no caller ever filled it.
 */
export interface ImageInit {
  /** Where it came from, kept so a re-fetch is possible. */
  url: string;
  title: string | null;
  language: string | null;
  /** Measured by the writer; never supplied. */
  bytes: Uint8Array;
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
 *
 * **Nothing here is scoped to the calling plugin -- do not infer symmetry
 * with `MediaReader`.** Unlike the reader, which the host builds once *per
 * plugin* around that plugin's id, there is one writer shared by every
 * plugin context and it closes over no plugin id at all: ten of its eleven
 * methods are handed none, and `createMediaItem` stores the `pluginId` in
 * `MediaItemInit` without checking it against the plugin doing the writing.
 * So every method acts on the bare row id it is given, whoever wrote that
 * row: `setResolution` on another plugin's rss item, `updateMediaItem` and
 * `dropMediaItem` on another plugin's media item, all succeed. Verified by
 * execution against the real writer, not inferred.
 * `MediaReader` next door scopes every one of its four methods, and the
 * asymmetry is deliberate for now rather than an oversight: a read side
 * honest about ownership is worth having on its own, and closing the write
 * side touches every caller of these methods, which is a later slice's
 * change. Until it happens, a plugin can change and delete rows it does not
 * own, and the host does not stop it.
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

  /**
   * Repoints an rss item at a different media item, or at nothing when
   * `mediaItemId` is `null`. The unlink is what lets a media item created
   * before a lookup answers be dropped again when the answer is a refusal:
   * `dropMediaItem` throws while any rss item still points at the row, and
   * without a way to unlink, that link could never be broken. Throws if
   * `rssItemId` does not exist.
   */
  relinkRssItem(rssItemId: number, mediaItemId: number | null): Promise<void>;

  /** Deletes a media item that lost a provider-ref claim. */
  dropMediaItem(mediaItemId: number): Promise<void>;

  /**
   * Attaches a poster, keyed on its url: attaching the same url twice leaves
   * one row and one cached file, so a handler re-run by crash recovery does
   * not double-write or double-fetch.
   *
   * The writer measures the bytes, so a caller cannot supply a wrong width or
   * height -- it cannot supply one at all. Artwork is a shared row and now a
   * shared file, and both have one writer for the same reason: a row and a
   * file written by different hands can disagree, and 1.x needed a repair
   * script because they did.
   */
  attachPoster(mediaItemId: number, poster: ImageInit): Promise<void>;
  /** As `attachPoster`, for a backdrop. */
  attachBackground(mediaItemId: number, background: ImageInit): Promise<void>;
  /** As `attachPoster`, for a logo -- the artwork slot slice A left with no writer. */
  attachLogo(mediaItemId: number, logo: ImageInit): Promise<void>;
  upsertPerson(person: PersonInit): Promise<number>;
  /**
   * Attaches one person's part in one item, keyed on
   * `(mediaItemId, personId, role)`: re-attaching the same part updates that
   * row rather than adding a second, so a handler is safe to run twice and a
   * dedup that re-attaches the loser's cast onto the winner cannot duplicate
   * the people the two answers shared.
   */
  attachRole(mediaItemId: number, role: RoleInit): Promise<void>;
  /**
   * Records what became of a release's identification.
   *
   * `lookupJson` is the service's own answer, or `null` to clear one --
   * **a required parameter, never defaulted.** A default would let a
   * branch that resolves a release forget to clear the answer that failed
   * it, which is the one mistake that makes this column grow without
   * bound (`RssItemSyncRead.lookupJson`).
   */
  setResolution(
    rssItemId: number,
    resolution: Resolution,
    detail: string | null,
    lookupJson: string | null,
  ): Promise<void>;
}

/**
 * Which of the two download tables a row came from, and which kind of thing
 * an rss item is fetched as. A union, not an enum: `erasableSyntaxOnly` is on
 * and these two values are the whole vocabulary a *reader* is ever handed.
 * The columns behind them are TEXT and one of them can still hold a third
 * value -- see `downloadTypeOf` in `@pickarr/host`'s `api/reads.ts` for which,
 * and for what happens to it.
 */
export type Transport = 'torrent' | 'nzb';

/** A media item as a reader sees it. */
export interface MediaItemRead {
  id: number;
  title: string;
  releaseDate: string | null;
  description: string | null;
  provider: string | null;
  providerRef: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * An rss item as a reader sees it. No `updatedAt`: the column exists and is
 * what a paged read is ordered by, but it is the *cursor's* business rather
 * than a fact about the item, and the cursor already carries it.
 */
export interface RssItemRead {
  id: number;
  feedId: number;
  filename: string;
  link: string;
  mediaItemId: number | null;
  resolution: string;
  resolutionDetail: string | null;
  downloadType: Transport;
  deliveredAt: number | null;
}

/**
 * A download as a reader sees it, from either table. `status` is `string`
 * rather than the host's own union: the vocabulary is the host's and will
 * grow, and a plugin pinned to today's values would break on the next one.
 *
 * `infohash` exists on `torrent_download` alone and reads `null` for an nzb
 * row -- one shape for both transports, rather than a field that is present
 * or absent depending on which table answered.
 */
export interface DownloadRead {
  id: number;
  rssItemId: number;
  downloadClientId: number;
  transport: Transport;
  status: string;
  clientRef: string | null;
  infohash: string | null;
  percentage: number | null;
  absentSince: number | null;
  deliveredAt: number | null;
  lastError: string | null;
}

/**
 * The typed counterpart to `MediaWriter`: how a plugin reads the shared rows
 * it wrote, instead of improvising SQL against tables it has never seen.
 * Plain data, not Drizzle rows, for the same reason `MediaWriter` takes plain
 * data -- a typed row would couple every plugin to the host's migrations.
 *
 * The intended way a plugin reads those rows, **not the only way** -- the
 * caveat `MediaWriter` opens with applies here word for word:
 * `PluginContext.db` is the same raw connection the shared tables live in,
 * so a plugin can select any plugin's `media_item`, `rss_item` or download
 * rows directly and the host does not stop it. The scoping below is a
 * boundary this interface keeps, not one the host enforces on a plugin.
 *
 * **Every method here is scoped to the calling plugin -- all four, not just
 * the two that name a media item.** The host builds one of these per plugin,
 * closed over that plugin's id, so a plugin cannot ask about another's.
 * `mediaItem` and `mediaItemByProviderRef` filter on that id directly;
 * `rssItemsFor` and `downloadsFor` reach it one join further on, because an
 * rss item belongs to a feed and a feed names its plugin. Someone else's
 * media item answers `null` and someone else's feed answers `[]` -- the same
 * answer each read gives for a row that does not exist, and not an error:
 * telling those two apart would report the existence of the other plugin's
 * rows, which is the first half of reading them.
 *
 * The scoping is this interface's, not `MediaWriter`'s. See that interface
 * for what a plugin can still change without owning it.
 *
 * `mediaItemByProviderRef` reads `media_item.provider` / `provider_ref` --
 * the pair `MediaWriter.claimProviderRef` writes and the unique index dedups
 * on -- and **not** the separate `external_reference` table, which has no
 * writer anywhere in the tree. An earlier draft called this
 * `mediaItemByExternalReference`, which named the table it does not consult.
 *
 * Every method returns a `Promise` to match `MediaWriter`'s shape, even
 * though `node:sqlite` answers synchronously: a plugin awaits both halves of
 * the contract the same way, and the host is free to put a read behind
 * something that really does yield without changing this interface.
 */
export interface MediaReader {
  mediaItem(id: number): Promise<MediaItemRead | null>;
  mediaItemByProviderRef(provider: string, ref: string): Promise<MediaItemRead | null>;
  /**
   * Every rss item pointing at this media item **from a feed this plugin
   * owns**, in discovery order.
   *
   * The scope is not implied by the media item id, and the difference is
   * reachable: `MediaWriter.relinkRssItem` is unscoped, so another plugin
   * can point an rss item in *its* feed at *your* media item, and that item
   * is not returned here. Asking about a media item you own can therefore
   * answer `[]` while an rss item pointing at it exists. Returning it is the
   * alternative and it is worse -- it would hand you a filename and a link
   * out of a feed you do not own -- so the read stays scoped and the gap
   * belongs to `relinkRssItem`.
   */
  rssItemsFor(mediaItemId: number): Promise<RssItemRead[]>;
  /**
   * Every download for this rss item, from both tables, oldest change first
   * -- and only when that rss item is in a feed this plugin owns, scoped
   * through the same feed join as `rssItemsFor` one step further on. An rss
   * item id belonging to another plugin's feed answers `[]`, whatever rows
   * that item really has.
   */
  downloadsFor(rssItemId: number): Promise<DownloadRead[]>;
}
