/**
 * Which item to hand over. **Not which client** -- there is no field for
 * that, and the omission is the point.
 *
 * It was a required `number`, which gave a plugin no way to say "the host
 * decides": a plugin that did not want to invent host policy had to read
 * `rss_feed.download_client_id` itself, and had nothing to send when that
 * column was `NULL` -- which is every feed created through the settings UI.
 * Making it optional fixed that half and left the other half broken. The
 * host resolves the client either way, so a supplied id could only be
 * *checked* against that resolution, and where a feed named no client and
 * several matched, the resolution is a draw: a submission naming a valid
 * candidate was refused two times in three (measured: 2010 of 3000).
 *
 * Validating the id against the candidate set instead would have been
 * worse. It says what to check and never what to *use* -- the row would
 * still be written against a fresh draw, so a submission naming client 1
 * could be recorded against client 3 with nothing raised. A loud refusal is
 * visible; silent misrouting is the failure nobody reports.
 *
 * So the field is gone, which makes both unrepresentable. This was already
 * what the interface below said: "the host resolves a submission to the
 * client that received it ... that resolution and the wiring behind it live
 * in `@pickarr/host`." A plugin naming the client contradicted that
 * sentence.
 */
export interface DownloadSubmission {
  rssItemId: number;
}

/**
 * Handing an item to a download client.
 *
 * Deliberately takes an id rather than a url: an rss item's link lives on its
 * row, and the host resolves what to send. A plugin that had to supply the url
 * would need to read a column it does not own -- and the same is true of the
 * client, which is why `DownloadSubmission` names one no more than it names
 * the other.
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
