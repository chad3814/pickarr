export interface ClientQueueEntry {
  ref: string;
  name: string;
  percentage: number;
}

export interface ClientHistoryEntry {
  ref: string;
  name: string;
  outcome: 'completed' | 'failed';
  storagePath: string | null;
  failMessage: string | null;
}

export interface ClientSnapshot {
  queue: ClientQueueEntry[];
  history: ClientHistoryEntry[];
}

export interface DownloadClient {
  readonly id: string;
  readonly importMode: 'move' | 'copy';
  /** Adds a URL and returns the client's reference for it. */
  addUrl(url: string): Promise<string>;
  /** One poll of everything in this client's configured category. */
  snapshot(): Promise<ClientSnapshot>;
  /** Translates a client-reported path into one Pickarr can open. */
  mapPath(clientPath: string): string;
}

export type FetchLike = (url: string) => Promise<Response>;
