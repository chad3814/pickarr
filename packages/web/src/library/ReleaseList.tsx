/**
 * One media item's releases -- filename, resolution, ranking score, and
 * each download's status and percentage (design spec §5) -- or no download
 * at all, since this slice is read-only and cannot pick one. A release with
 * no `torrent_download` or `nzb_download` row is not an edge case here; it
 * is the normal state of every release nobody has acted on yet, because
 * nobody can.
 *
 * Self-contained and driven entirely by props: `MediaItemCard` is this
 * component's only caller, and hands it `GatheredItem['releases']` straight
 * from `store/gather.ts` with no transformation of its own.
 */
import type { ReactElement } from 'react';
import type { GatheredDownload, GatheredItem, GatheredRelease } from '../store/gather.ts';

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

/**
 * One release's ranking score, or `undefined` when it has none.
 *
 * Design spec §5 names this alongside the resolution and the download
 * status; it was dropped in the spec-to-plan translation and every seat
 * downstream reviewed against the plan, so nothing caught it until the
 * whole-branch review read the spec directly.
 *
 * `=== null`, never a falsy check: `rankingScore` is `number | null` on the
 * wire and a score of **0** is a real answer a ranker can give, distinct
 * from "nothing has ranked this yet". A release with no score renders no
 * score at all, exactly as a release with no download renders no status --
 * this slice is read-only and both absences are the ordinary state of a
 * release nobody has acted on.
 */
function scoreText(row: GatheredRelease['row']): string | undefined {
  return row.rankingScore === null ? undefined : `Score: ${String(row.rankingScore)}`;
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
        const score = scoreText(release.row);
        return (
          <li key={release.id} aria-labelledby={filenameId}>
            <span id={filenameId}>{release.row.filename}</span> <span>{release.row.resolution}</span>
            {score !== undefined && <span> {score}</span>}
            {release.downloads.map((download) => (
              <span key={downloadKey(download)}> {statusText(download)}</span>
            ))}
          </li>
        );
      })}
    </ul>
  );
}
