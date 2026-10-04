/**
 * The view of a gathered media item that `@pickarr/plugin-ui`'s `Card`
 * components read, and the pick machinery a card's release list needs to
 * submit one.
 *
 * **`GatheredItemView`, `GatheredReleaseView` and `GatheredDownloadView`
 * mirror `GatheredItem`, `GatheredRelease` and `GatheredDownload` in
 * `web/src/store/gather.ts`, which stays the source.** `@pickarr/plugin-ui`
 * must not import web (web imports it), so the two shapes cannot be one
 * declaration -- `web/src/store/gather.ts`'s own compile-time check is what
 * keeps this file from drifting out of step with the shape it mirrors.
 *
 * **`PickOutcome` and `PickSubmit` mirror the types of the same name in
 * `web/src/library/postPick.ts`, for the same reason**: `postPick`'s real
 * implementation does network I/O and stays in web, but `ReleaseList`
 * neither imports web nor performs I/O of its own, so the shape it submits
 * through has to live somewhere both sides can reach. `postPick.ts`
 * re-exports these rather than holding a second declaration.
 */
import type {
  IdentifyReleaseRefusalCode,
  IdentifyRequest,
  NzbDownloadSyncRead,
  PersonSyncRead,
  RequestPickRefusalCode,
  RoleSyncRead,
  RssItemSyncRead,
  TorrentDownloadSyncRead,
} from '@pickarr/contract';

/** Mirrors `GatheredDownload` (`web/src/store/gather.ts`). */
export type GatheredDownloadView =
  | { readonly table: 'torrent_download'; readonly id: number; readonly row: TorrentDownloadSyncRead }
  | { readonly table: 'nzb_download'; readonly id: number; readonly row: NzbDownloadSyncRead };

/** Mirrors `GatheredRelease` (`web/src/store/gather.ts`). */
export interface GatheredReleaseView {
  readonly id: number;
  readonly row: RssItemSyncRead;
  readonly downloads: readonly GatheredDownloadView[];
}

/** Mirrors `GatheredImage` in `web/src/store/gather.ts`: one replicated artwork row and the url that serves it. */
export interface GatheredImageView {
  readonly id: number;
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly language: string | null;
  /** Position in the host's preference order, 0 best. */
  readonly rank: number;
}

/** Mirrors `GatheredArtwork` in `web/src/store/gather.ts`. Each list is best first and may be empty. */
export interface GatheredArtworkView {
  readonly posters: readonly GatheredImageView[];
  readonly backgrounds: readonly GatheredImageView[];
  readonly logos: readonly GatheredImageView[];
}

/** Mirrors `GatheredRole` in `web/src/store/gather.ts`. */
export interface GatheredRoleView {
  readonly id: number;
  readonly row: RoleSyncRead;
  /**
   * `undefined` while the person named by this role has not replicated --
   * log order is not group order, so a role can land before its person.
   */
  readonly person: PersonSyncRead | undefined;
  /**
   * This person's pictures, best first. Empty when the replica holds none,
   * and empty for a person `topBilled` would not place in the first
   * `CAST_LIMIT`: the gather reads pictures only for the people this card
   * shows (#110), so a role outside that cut carries none even when the
   * replica has them.
   */
  readonly images: readonly GatheredImageView[];
}

/**
 * The fields of `GatheredItem` (`web/src/store/gather.ts`) a card and its
 * detail section read.
 *
 * Deliberately narrower than `GatheredItem` itself: a plugin's `Card` gets a
 * media item's own fields from `CardProps.item` already (`plugin.ts`), so
 * this view promises only what nothing else on `CardProps` already does.
 * `GatheredItem` still carries more than this -- `mediaItem`, `pluginId`,
 * `feedIds` -- and stays assignable to this narrower shape precisely because
 * TypeScript's structural typing does not require the wider type to have no
 * more fields.
 */
export interface GatheredItemView {
  readonly releases: readonly GatheredReleaseView[];
  readonly roles: readonly GatheredRoleView[];
  readonly artwork: GatheredArtworkView;
}

/**
 * What a pick submission resolves to. Mirrors `PickOutcome`
 * (`web/src/library/postPick.ts`).
 */
export type PickOutcome =
  | { accepted: true }
  | { refusal: RequestPickRefusalCode }
  | { refusal: 'offline' | 'expired' | 'unrecognised' };

/**
 * The shape a plugin's `Card` takes its `submit` prop in: a release id in,
 * an outcome out. `web/src/library/postPick.ts`'s `postPick` is the only
 * production implementation; `web/src/shell/Shell.tsx` wires it in.
 */
export type PickSubmit = (rssItemId: number) => Promise<PickOutcome>;

/**
 * What every write path in the client says when the host answers 401: the
 * session behind the request is gone (issue #94).
 *
 * **Declared here, not in `@pickarr/contract` and not in web.** Web imports
 * this package and this package must not import web, and
 * {@link PICK_REFUSAL_MESSAGES} -- which `ReleaseList` reads -- needs it, so
 * web is ruled out. The contract is ruled out for a different reason: it is
 * the wire's vocabulary, codes and data, and never a sentence
 * (`contract/src/destinations.ts`: "It is never a sentence"); every sentence
 * an operator reads is the client's own. This package is the one place both
 * browser-side consumers already reach that already holds client sentences,
 * so one constant here serves every write path. Web's
 * `auth/sessionExpired.ts` re-exports it and every web path imports it from
 * there, so the copies in each path's message map cannot drift.
 */
export const SESSION_EXPIRED_MESSAGE = 'Your session expired. Sign in again.';

/**
 * A fixed sentence per non-accepted outcome -- never the server's own words
 * (Global Constraint). Moved from `web/src/library/postPick.ts` unchanged:
 * `ReleaseList` reads this map and must not import web, so this is now
 * where it lives, and `postPick.ts` re-exports it rather than holding a
 * second copy.
 */
export const PICK_REFUSAL_MESSAGES: Record<RequestPickRefusalCode | 'offline' | 'expired' | 'unrecognised', string> = {
  'unknown-release': 'Pickarr no longer has that release on file. Reload the page and try again.',
  'plugin-not-registered': 'No plugin in this Pickarr handles that kind of media, so nothing can fetch this release.',
  'no-client-of-type': 'No download client that can take this kind of release is set up. Add one under Settings.',
  'client-type-mismatch': 'The download client this release’s feed names cannot take this kind of release.',
  'already-submitted': 'This release has already been sent to a download client.',
  /** Distinct from every named refusal above, which are answers from the host -- this one means the submit never reached it. Worded exactly as `AddDownloadClient.tsx`'s own `offline`, because it is the same event and a second wording for it would be two sentences for one condition. */
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  /** A 401: the session expired. `postPick` never lands this in `unrecognised`, whose version-skew advice would send the operator after the wrong cause; the shell also returns to sign-in on the same answer. */
  expired: SESSION_EXPIRED_MESSAGE,
  /** `postPick`'s catch-all -- a parseable answer this build cannot read. Names no code and no status: those are exactly the server-authored detail the Global Constraint forbids rendering. */
  unrecognised:
    'Pickarr refused this pick, but did not say why. The host may be a different version than this page expects — reload and try again.',
};

/**
 * What an identify submission resolves to. `accepted` answers `requery` and
 * `name` (the lookup runs afterwards and arrives through the replica);
 * `linked` answers `media-item` (the release is already relinked).
 */
export type IdentifyOutcome =
  | { accepted: true }
  | { outcome: 'linked'; mediaItemId: number }
  | { refusal: IdentifyReleaseRefusalCode | 'offline' | 'expired' | 'unrecognised' };

/** One library title the combobox can offer. `year` is `null` when the title has none. */
export interface Candidate {
  mediaItemId: number;
  title: string;
  year: string | null;
}

/**
 * The seam a card's release list identifies a release through: `identify`
 * posts one request for one release, `suggest` lists library titles of one
 * plugin matching a typed term. Web supplies both; this package does no I/O.
 */
export interface IdentifySubmit {
  identify(rssItemId: number, request: IdentifyRequest): Promise<IdentifyOutcome>;
  suggest(pluginId: string, term: string): Promise<readonly Candidate[]>;
}

/** A fixed sentence per non-accepted identify outcome -- never the server's own words. */
export const IDENTIFY_REFUSAL_MESSAGES: Record<IdentifyReleaseRefusalCode | 'offline' | 'expired' | 'unrecognised', string> = {
  'unknown-release': 'Pickarr no longer has that release on file. Reload the page and try again.',
  'plugin-not-registered': 'No plugin in this Pickarr handles that kind of media, so nothing can identify this release.',
  'unknown-media-item': 'That title is no longer in the library. Pick another or look the release up by name.',
  'wrong-plugin': 'That title belongs to a different category than this release’s feed.',
  'already-linked': 'This release already belongs to that title.',
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  expired: SESSION_EXPIRED_MESSAGE,
  unrecognised:
    'Pickarr refused the change, but did not say why. The host may be a different version than this page expects — reload and try again.',
};

/** The two strings the Requery button renders. */
export const REQUERY_LABELS = { idle: 'Requery', pending: 'Requerying…' } as const;

/** How long the combobox waits after a keystroke before asking `suggest`. */
export const SUGGEST_DEBOUNCE_MS = 150;

/** The most library titles the combobox lists. */
export const SUGGEST_LIMIT = 8;
