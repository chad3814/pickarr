import { Link } from 'react-router';
import type { DownloadView } from '../api/client.ts';
import { groupAnchorHref } from '../api/anchors.ts';

interface Props {
  download: DownloadView;
  onRetry(downloadId: number): void;
}

export function DownloadRow({ download, onRetry }: Props) {
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
      {download.status === 'failed' && (
        <button type="button" onClick={() => onRetry(download.id)}>
          Retry
        </button>
      )}
    </li>
  );
}
