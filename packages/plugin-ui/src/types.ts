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
  NzbDownloadSyncRead,
  RequestPickRefusalCode,
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

/**
 * The one field of `GatheredItem` (`web/src/store/gather.ts`) a card's
 * release list reads.
 *
 * Deliberately narrower than `GatheredItem` itself: a plugin's `Card` gets a
 * media item's own fields from `CardProps.item` already (`plugin.ts`), so
 * this view promises only what nothing else on `CardProps` already does.
 * `GatheredItem` carries more than this -- `roles`, `artwork`, `feedIds` --
 * and stays assignable to this narrower shape precisely because TypeScript's
 * structural typing does not require the wider type to have no more fields.
 */
export interface GatheredItemView {
  readonly releases: readonly GatheredReleaseView[];
}

/**
 * What a pick submission resolves to. Mirrors `PickOutcome`
 * (`web/src/library/postPick.ts`).
 */
export type PickOutcome =
  | { accepted: true }
  | { refusal: RequestPickRefusalCode }
  | { refusal: 'offline' | 'unrecognised' };

/**
 * The shape a plugin's `Card` takes its `submit` prop in: a release id in,
 * an outcome out. `web/src/library/postPick.ts`'s `postPick` is the only
 * production implementation; `web/src/shell/Shell.tsx` wires it in.
 */
export type PickSubmit = (rssItemId: number) => Promise<PickOutcome>;

/**
 * A fixed sentence per non-accepted outcome -- never the server's own words
 * (Global Constraint). Moved from `web/src/library/postPick.ts` unchanged:
 * `ReleaseList` reads this map and must not import web, so this is now
 * where it lives, and `postPick.ts` re-exports it rather than holding a
 * second copy.
 */
export const PICK_REFUSAL_MESSAGES: Record<RequestPickRefusalCode | 'offline' | 'unrecognised', string> = {
  'unknown-release': 'Pickarr no longer has that release on file. Reload the page and try again.',
  'plugin-not-registered': 'No plugin in this Pickarr handles that kind of media, so nothing can fetch this release.',
  'no-client-of-type': 'No download client that can take this kind of release is set up. Add one under Settings.',
  'client-type-mismatch': 'The download client this release’s feed names cannot take this kind of release.',
  'already-submitted': 'This release has already been sent to a download client.',
  /** Distinct from every named refusal above, which are answers from the host -- this one means the submit never reached it. Worded exactly as `AddDownloadClient.tsx`'s own `offline`, because it is the same event and a second wording for it would be two sentences for one condition. */
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  /** `postPick`'s catch-all. Names no code and no status: those are exactly the server-authored detail the Global Constraint forbids rendering. */
  unrecognised:
    'Pickarr refused this pick, but did not say why. The host may be a different version than this page expects — reload and try again.',
};
