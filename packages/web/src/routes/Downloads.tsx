import { useEffect, useState } from 'react';
import { api, type DownloadsResponse } from '../api/client.ts';
import { DownloadRow } from '../components/DownloadRow.tsx';

const POLL_MS = 3000;

/**
 * Polls while mounted. Deliberately not SSE: a useEffect beats a subscription
 * protocol, a reconnect story, and a broadcast bus for one screen.
 */
export function Downloads() {
  const [data, setData] = useState<DownloadsResponse>({ tracked: [], untracked: [] });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const next = await api.downloads();
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /**
   * A rejection here used to go nowhere: the call site is `void retry(id)`, so
   * a refused retry (409 on a row that is no longer `failed`, a 404, a dropped
   * connection) left the button looking like it had done nothing at all.
   *
   * A retry that is *accepted* and then fails again on the next reconcile tick
   * still looks like nothing happened — the row returns to `failed` inside one
   * poll interval. That is the retry working and the underlying fault
   * repeating, and the row's error message is where it says so.
   */
  async function retry(downloadId: number): Promise<void> {
    try {
      await api.retry(downloadId);
      setData(await api.downloads());
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }

  return (
    <section>
      <h1>Downloads</h1>
      {error !== null && <p className="error">{error}</p>}

      <ul className="downloads">
        {data.tracked.map((download) => (
          <DownloadRow key={download.id} download={download} onRetry={(id) => void retry(id)} />
        ))}
      </ul>

      {data.untracked.length > 0 && (
        <>
          <h2>Not managed by Pickarr</h2>
          <ul className="downloads untracked">
            {data.untracked.map((entry) => (
              <li key={entry.ref} className="download-row untracked">
                <span className="download-title">{entry.name}</span>
                <span className="download-status">{entry.state}</span>
                {entry.percentage !== null && <span>{entry.percentage}%</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
