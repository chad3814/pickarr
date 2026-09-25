/**
 * The first icons in this codebase.
 *
 * Inline SVG rather than image files: no asset pipeline changes, no
 * second network request per card, and `currentColor` means both themes
 * are handled by the stylesheet that already sets text colour.
 *
 * **Provider marks are lettermarks, not the companies' logos.** The real
 * marks are trademarks with usage rules, and a row of link affordances is
 * recognisable without them. The Movie Database's attribution requirement
 * is met by the `data provided by` line `MediaDetails` renders.
 *
 * Every glyph carries `role="img"` and a `<title>`, referenced by
 * `aria-labelledby`, because an unlabelled `<svg>` announces nothing.
 */
import type { ReactElement } from 'react';
import { useId } from 'react';

/** A downward arrow into a tray -- a download, whatever the transport. */
const DOWNLOAD_PATH = 'M12 3v10m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2';

/** A magnet, for a torrent. */
const MAGNET_PATH = 'M6 4v7a6 6 0 0012 0V4h-4v7a2 2 0 01-4 0V4H6z';

/**
 * The glyph for a release's transport. An unrecognised value still
 * renders, named for itself: `download_type` comes from the replica and
 * is not a closed set this component can rely on.
 */
export function DownloadTypeIcon({ type }: { type: string }): ReactElement {
  const titleId = useId();
  return (
    <svg className="icon" viewBox="0 0 24 24" role="img" aria-labelledby={titleId}
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <title id={titleId}>{type}</title>
      <path d={type === 'torrent' ? MAGNET_PATH : DOWNLOAD_PATH} />
    </svg>
  );
}

/** A provider's lettermark, as text so it is legible and selectable. */
export function ProviderBadge({ label }: { label: string }): ReactElement {
  return <span className="badge">{label}</span>;
}

/** A picture glyph for an image slot with nothing in it. */
export function ImagePlaceholder({ label }: { label: string }): ReactElement {
  const titleId = useId();
  return (
    <svg className="placeholder" viewBox="0 0 24 24" role="img" aria-labelledby={titleId}
      fill="none" stroke="currentColor" strokeWidth="1.5">
      <title id={titleId}>{label}</title>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="M21 16l-5-5-4 4-2-2-7 7" />
    </svg>
  );
}
