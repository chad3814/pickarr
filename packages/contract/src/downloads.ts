/** Which item to hand to which configured client. */
export interface DownloadSubmission {
  rssItemId: number;
  downloadClientId: number;
}

/**
 * Handing an item to a download client.
 *
 * Deliberately takes ids rather than a url: an rss item's link lives on its
 * row, and the host resolves what to send. A plugin that had to supply the url
 * would need to read a column it does not own.
 *
 * The clients themselves — sab, qb, their filepath mappings — are a later
 * slice. This capability is in the contract now because `onDownloadRequest` is
 * a required entry point, and a contract missing what a required entry point
 * needs is the wrong thing for later slices to build against.
 */
export interface DownloadClients {
  /** Returns the client's own reference for the submitted job. */
  submit(submission: DownloadSubmission): Promise<string>;
}
