/**
 * Re-identifying a release after the fact (design spec 2026-10-02): run the
 * lookup again, run it under a corrected name, or link the release to a
 * media item the library already has.
 *
 * Codes only. `invalid-shape` is not here because the route decides it
 * before the host is asked, as `/api/picks` does. The browser maps each
 * code to its own sentence (`@pickarr/plugin-ui`'s
 * `IDENTIFY_REFUSAL_MESSAGES`) and never re-spells one.
 */
export const IDENTIFY_RELEASE_REFUSALS = [
  'unknown-release',
  'plugin-not-registered',
  'unknown-media-item',
  'wrong-plugin',
  'already-linked',
] as const;

export type IdentifyReleaseRefusalCode = (typeof IDENTIFY_RELEASE_REFUSALS)[number];

export type IdentifyRequest =
  | { readonly mode: 'requery' }
  | { readonly mode: 'name'; readonly name: string }
  | { readonly mode: 'media-item'; readonly mediaItemId: number };

export type IdentifyReleaseOutcome =
  | { readonly accepted: true }
  | { readonly outcome: 'linked'; readonly mediaItemId: number }
  | { readonly refusal: IdentifyReleaseRefusalCode };
