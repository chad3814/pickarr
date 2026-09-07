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
 * The host resolves a submission to the client that received it — sab, qb,
 * their filepath mappings — and calls it; that resolution and the wiring
 * behind it live in `@pickarr/host`.
 */
export interface DownloadClients {
  /**
   * Returns the client's own reference for the submitted job, or `null`
   * when the submission was accepted but that reference is not yet known.
   *
   * `null` is not a failure: a `.torrent` submission can register with a
   * client before the client can answer what its own reference is (design
   * spec §7), and the row behind it stays reconcilable — recoverable by a
   * later attempt — rather than lost. A caller that needs the reference
   * immediately has none to read yet; one that only needs the submission to
   * have happened can treat `null` and a real reference alike.
   */
  submit(submission: DownloadSubmission): Promise<string | null>;
}
