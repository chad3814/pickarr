export interface ClientQueueEntry {
  ref: string;
  name: string;
  percentage: number;
  /**
   * The client's own category for this slot, or `null` when the slot carries
   * none. A queue slot with no category is the literal string `"None"`, not
   * an absent field — the client is responsible for mapping that (and the
   * empty string) to `null` before this entry is built, so every consumer
   * can compare against a real category name without knowing the client's
   * spelling of "no category".
   */
  category: string | null;
}

export interface ClientHistoryEntry {
  ref: string;
  name: string;
  /** See `ClientQueueEntry.category`. */
  category: string | null;
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
  /**
   * Whether this snapshot is the client's whole picture. False when a page
   * could not be retrieved or the client reported more entries than it
   * returned. A false snapshot may still be used to advance rows it *does*
   * contain; it may never be used to conclude something is absent.
   */
  complete: boolean;
}

export interface DownloadClient {
  readonly id: string;
  readonly importMode: 'move' | 'copy';
  /**
   * The category this client submits Pickarr's jobs under, exposed because
   * `snapshot()` no longer filters by it: the snapshot is everything the
   * server holds, so a caller that wants to say which of those entries are
   * *ours* needs the same category `addUrl` uses. Read off the client rather
   * than passed alongside it so the two can never disagree — a filter
   * comparing against a category nothing was submitted under would report
   * every job on the server as a stranger's.
   */
  readonly category: string;
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
  /**
   * One poll of everything the client knows about — queue and history,
   * unfiltered by category. See `ClientSnapshot.complete` for why: asking
   * the client to filter costs the ability to verify the result is whole.
   */
  snapshot(): Promise<ClientSnapshot>;
  /**
   * Drops a finished job from the client, and its leftover files with it.
   *
   * Called once the import has been recorded, so the file Pickarr wanted is
   * already in the library and what remains under the client's storage path is
   * spent: par2 volumes, samples, and in move mode an empty directory. Nothing
   * else reclaims that space, and nothing else stops the client's history
   * growing for the lifetime of the installation.
   *
   * The client is asked to delete rather than Pickarr doing it, because those
   * paths are the client's own. Pickarr sees them only through `mapPath`, and
   * a recursive delete aimed through a path mapping is the wrong place to
   * discover the mapping is wrong.
   */
  remove(ref: string, deleteFiles: boolean): Promise<void>;

  /** Translates a client-reported path into one Pickarr can open. */
  mapPath(clientPath: string): string;
}

export type FetchLike = (url: string) => Promise<Response>;
