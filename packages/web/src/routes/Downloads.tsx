import { useEffect, useState } from 'react';
import { api, type DownloadsResponse } from '../api/client.ts';
import { matchesTerm } from '../api/search.ts';
import { DownloadRow } from '../components/DownloadRow.tsx';
import { SearchBox } from '../components/SearchBox.tsx';

const POLL_MS = 3000;

/**
 * Polls while mounted. Deliberately not SSE: a useEffect beats a subscription
 * protocol, a reconnect story, and a broadcast bus for one screen.
 */
export function Downloads() {
  const [data, setData] = useState<DownloadsResponse>({ tracked: [], untracked: [] });
  const [search, setSearch] = useState('');
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

  /**
   * The rows the box leaves on screen, both halves of the list.
   *
   * Filtered here rather than by asking the server. `/api/downloads` returns
   * every row unpaginated (issue #31) and this screen re-polls all of it every
   * `POLL_MS`, so there is nothing off-screen for a term to reach — and a term
   * the server had to be told about would put a request behind every keystroke
   * on the one screen already making one every three seconds.
   *
   * Derived on each render, from the term and the latest `data` together, rather
   * than stored: the poll replaces `data` wholesale while the reader is still
   * reading, and a filtered copy in state would either need re-deriving inside
   * `poll` and `retry` both, or would go stale at whichever one forgot. It is
   * also what makes a row that *arrives* under a term get filtered by it.
   *
   * A download matches on its title, and an untracked entry on its name —
   * nothing else. Both are the row's own headline text and the only part of it a
   * reader would think to type; matching `status` as well would mean the term
   * "failed" quietly behaves like a state filter, which is a different feature
   * with a different control.
   */
  const tracked = data.tracked.filter((download) => matchesTerm(search, download.title));
  const untracked = data.untracked.filter((entry) => matchesTerm(search, entry.name));

  return (
    <section>
      <h1>Downloads</h1>
      <SearchBox label="Search downloads" value={search} onChange={setSearch} />
      {error !== null && <p className="error">{error}</p>}

      <ul className="downloads">
        {tracked.map((download) => (
          <DownloadRow key={download.id} download={download} onRetry={(id) => void retry(id)} />
        ))}
      </ul>

      {/*
        The heading goes with the rows it labels. It is the whole of what says
        these downloads are not Pickarr's, so leaving it standing over an empty
        list once a term has excluded every one of them would read as Pickarr
        having lost track of something.
      */}
      {untracked.length > 0 && (
        <>
          <h2>Not managed by Pickarr</h2>
          <ul className="downloads untracked">
            {untracked.map((entry) => (
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
