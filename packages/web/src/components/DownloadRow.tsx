import type { DownloadView } from '../api/client.ts';

interface Props {
  download: DownloadView;
  onRetry(downloadId: number): void;
}

export function DownloadRow({ download, onRetry }: Props) {
  return (
    <li className={`download-row status-${download.status}`}>
      <span className="download-title">{download.title}</span>
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
