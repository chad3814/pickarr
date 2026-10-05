/**
 * The one line a download row reads as, and its React key -- moved out of
 * `ReleaseList.tsx` so the unmatched page's cards (`web/src/library/Unmatched.tsx`)
 * say exactly what a release row says.
 */
import type { GatheredDownloadView } from './types.ts';

/**
 * One download's visible status text, e.g. `Status: downloading (42%)`.
 *
 * **The percentage only while `downloading`.** The host writes it from the
 * client's queue and nothing clears it once the download leaves the queue
 * (`host/src/clients/reconcile.ts`'s `walkQueueEntry` is its only writer),
 * so a row that left at 97% still says 97 through `completed` and
 * `delivered`. Before `downloading` there is nothing to show either.
 */
export function downloadStatusText(download: GatheredDownloadView): string {
  const { status, percentage } = download.row;
  return status === 'downloading' && percentage !== null
    ? `Status: ${status} (${String(percentage)}%)`
    : `Status: ${status}`;
}

/**
 * A stable key for one download, since a release can carry more than one
 * (a torrent and an nzb submitted for the same release) and neither table's
 * `id` alone is unique across both.
 */
export function downloadKey(download: GatheredDownloadView): string {
  return `${download.table}:${String(download.id)}`;
}
