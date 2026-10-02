/**
 * The downloads in progress, read from the replica alone -- the host does
 * no work for this list. Re-read on a change to either download table, and
 * after a replica reset: a reset rebuilds every table in one commit, and a
 * list that kept its pre-reset rows would show downloads the new generation
 * never had.
 */
import { useEffect, useState } from 'react';
import type { Store } from '../store/index.ts';
import type { ActiveDownload } from '../store/rows.ts';

export interface ActiveDownloadsSource {
  activeDownloads: Store['activeDownloads'];
  subscribeTable: Store['subscribeTable'];
  subscribeReset: Store['subscribeReset'];
}

/** Whether `err` is IndexedDB's complaint that the connection is already closed -- see `settings/useDownloadClients.ts`. Anything else is rethrown. */
function isStoreClosed(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'InvalidStateError';
}

/** `undefined` until the first read resolves, which is distinct from an empty list. */
export function useActiveDownloads(source: ActiveDownloadsSource): readonly ActiveDownload[] | undefined {
  const [downloads, setDownloads] = useState<readonly ActiveDownload[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      const rows = await source.activeDownloads();
      if (cancelled) return;
      setDownloads(rows);
    }

    function safeRefresh(): void {
      refresh().catch((err: unknown) => {
        if (isStoreClosed(err)) return;
        throw err;
      });
    }

    safeRefresh();
    const offs = [
      source.subscribeTable('torrent_download', safeRefresh),
      source.subscribeTable('nzb_download', safeRefresh),
      source.subscribeReset(safeRefresh),
    ];
    return () => {
      cancelled = true;
      for (const off of offs) off();
    };
  }, [source]);

  return downloads;
}
