export interface ClientQueueEntry {
  ref: string;
  name: string;
  percentage: number;
}

export interface ClientHistoryEntry {
  ref: string;
  name: string;
  /**
   * `completed` is the only success reading — that has not changed. What is
   * new is `in-progress`: SABnzbd's real history carries several transient
   * post-processing labels (Extracting, Moving, Repairing, Verifying,
   * Fetching, Running, Queued, Paused) for a job that has neither failed nor
   * finished. The previous two-way reading treated every one of those as a
   * terminal failure, so an ordinary multi-part download got marked failed
   * while SABnzbd was still unpacking it. `failed` is reserved for a status
   * that genuinely means the job is never coming back — see
   * `historyOutcome` in `clients/sabnzbd.ts` for exactly which statuses land
   * where, and why.
   */
  outcome: 'completed' | 'failed' | 'in-progress';
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
  /**
   * Adds a URL and returns the client's reference for it.
   *
   * `name` is what pickarr sends the client as the job's display name: the
   * release title, for legibility in the client's own UI, with a
   * caller-chosen marker appended (see `clientJobName` in `db/downloads.ts`).
   * The marker is stable across every attempt at submitting the same
   * download, independent of the release's own name, so a later poll can
   * recognize a job it already accepted by extracting the marker back out of
   * whatever name the client reports (`extractLabel`), rather than depending
   * on free-text matching against the release title.
   */
  addUrl(url: string, name: string): Promise<string>;
  /** One poll of everything in this client's configured category. */
  snapshot(): Promise<ClientSnapshot>;
  /** Translates a client-reported path into one Pickarr can open. */
  mapPath(clientPath: string): string;
}

export type FetchLike = (url: string) => Promise<Response>;
