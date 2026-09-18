/**
 * One media item's releases, each with whatever download it has -- or none,
 * since this slice is read-only and cannot pick one. A release with no
 * `torrent_download` or `nzb_download` row is not an edge case here; it is
 * the normal state of every release nobody has acted on yet, because nobody
 * can.
 *
 * Self-contained and driven entirely by props: `MediaItemCard` is this
 * component's only caller, and hands it `GatheredItem['releases']` straight
 * from `store/gather.ts` with no transformation of its own.
 */
import type { ReactElement } from 'react';
import type { GatheredDownload, GatheredItem } from '../store/gather.ts';

export interface ReleaseListProps {
  releases: GatheredItem['releases'];
}

/**
 * One download's visible status text, e.g. `Status: downloading (42%)`.
 */
function statusText(download: GatheredDownload): string {
  const { status, percentage } = download.row;
  return percentage === null ? `Status: ${status}` : `Status: ${status} (${String(percentage)}%)`;
}

/**
 * A stable key for one download, since a release can carry more than one
 * (a torrent and an nzb submitted for the same release) and neither table's
 * `id` alone is unique across both.
 */
function downloadKey(download: GatheredDownload): string {
  return `${download.table}:${String(download.id)}`;
}

export function ReleaseList({ releases }: ReleaseListProps): ReactElement {
  return (
    <ul aria-label="releases">
      {releases.map((release) => {
        // `listitem` is not named from its own contents (measured: an
        // unlabelled `<li>` reads with an empty accessible name even when
        // full of visible text), so this points `aria-labelledby` at the
        // filename span rather than duplicating it into an `aria-label` --
        // one visible string, not two that could drift apart.
        const filenameId = `release-${String(release.id)}-filename`;
        return (
          <li key={release.id} aria-labelledby={filenameId}>
            <span id={filenameId}>{release.row.filename}</span> <span>{release.row.resolution}</span>
            {release.downloads.map((download) => (
              <span key={downloadKey(download)}> {statusText(download)}</span>
            ))}
          </li>
        );
      })}
    </ul>
  );
}
