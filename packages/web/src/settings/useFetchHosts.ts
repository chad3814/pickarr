import { useCallback, useEffect, useState } from 'react';
import type { FetchHostsRead } from '@pickarr/contract';
import { sendJson, type SendJsonResult } from '../auth/sendJson.ts';
import { SESSION_EXPIRED_MESSAGE } from '../auth/sessionExpired.ts';

export type FetchHostsLoader = () => Promise<SendJsonResult>;

export function fetchFetchHosts(): Promise<SendJsonResult> {
  return sendJson('/api/fetch-hosts', { method: 'GET' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRead(value: unknown): value is FetchHostsRead {
  return isRecord(value) && isRecord(value.default) && Array.isArray(value.hosts);
}

export interface FetchHostsState {
  data: FetchHostsRead | undefined;
  error: string | null;
  reload: () => void;
}

/** Loads on mount and whenever `reload` is called. `sendJson` already notifies the shell on 401; the message here is the row's own. */
export function useFetchHosts(load: FetchHostsLoader): FetchHostsState {
  const [data, setData] = useState<FetchHostsRead | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => { setGeneration((g) => g + 1); }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((result) => {
      if (cancelled) return;
      if (result.outcome === 'expired') { setError(SESSION_EXPIRED_MESSAGE); return; }
      if (result.outcome === 'offline' || !isRead(result.body)) { setError('Could not load fetch hosts.'); return; }
      setError(null);
      setData(result.body);
    });
    return () => { cancelled = true; };
  }, [load, generation]);

  return { data, error, reload };
}
