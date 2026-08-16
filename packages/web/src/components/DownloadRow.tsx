import { Link } from 'react-router';
import type { DownloadView } from '../api/client.ts';
import { groupAnchorHref } from '../api/anchors.ts';
import { formatElapsed } from '../api/format.ts';

interface Props {
  download: DownloadView;
  onRetry(downloadId: number): void;
}

export function DownloadRow({ download, onRetry }: Props) {
  // Retry must accept exactly what the API accepts (failed, or absent) — a
  // wider or narrower offer here just turns into a 409 on click.
  const retryable = download.status === 'failed' || download.absentSince !== null;

  return (
    <li className={`download-row status-${download.status}`}>
      {/*
       * The title is the way back to the group. This screen used to name a
       * download and stop there: a failure here left the group holding the
       * untried alternatives somewhere in the Picks list with nothing pointing
       * at it. Every row links, not just failed ones — "what is this a
       * download of?" is a fair question about a healthy row too, and a link
       * that appears only on failure reads as an error affordance rather than
       * navigation.
       */}
      <Link className="download-title" to={groupAnchorHref(download.groupId)}>
        {download.title}
      </Link>
      <span className="download-kind">{download.kind}</span>
      <span className="download-status">{download.status}</span>
      {download.error !== null && <span className="download-error">{download.error}</span>}
      {/*
       * Absence is never a verdict on its own — reconcile leaves a row
       * `downloading` for as long as the client just doesn't mention it, which
       * is what makes "never auto-fail" safe (see the reconcile tick). But an
       * invisible stuck row is exactly what let 35 healthy downloads sit
       * unnoticed for a day: this is that state's only other window onto the
       * screen, so it has to say so plainly.
       */}
      {download.absentSince !== null && (
        <span className="download-absent">
          missing from client for {formatElapsed(Date.now() - download.absentSince)}
        </span>
      )}
      {retryable && (
        <button type="button" onClick={() => onRetry(download.id)}>
          Retry
        </button>
      )}
    </li>
  );
}
