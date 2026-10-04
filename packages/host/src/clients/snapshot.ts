/**
 * One entry from a client's active queue: still downloading, identified by
 * the same `ref` a `SubmitResult` handed back. `percentage` is whatever the
 * client reports toward completion; nothing here claims it is monotonic or
 * even accurate, only that it is the client's own number for this entry.
 */
export interface ClientQueueEntry {
  ref: string;
  name: string;
  percentage: number;
  category: string | null;
}

/**
 * One entry from a client's history: no longer queued, either because it
 * finished, failed, or -- for a client that reports a row while it is still
 * moving into place -- is still `in-progress` by the client's own account.
 * `storagePath` is set only for `completed`; `failMessage` only for
 * `failed`. Neither is asserted against the other, because a client is free
 * to report neither (a `failed` entry with no message text, or a
 * `completed` entry that omits the path) without that meaning something
 * else went wrong.
 */
export interface ClientHistoryEntry {
  ref: string;
  name: string;
  category: string | null;
  outcome: 'completed' | 'failed' | 'in-progress';
  storagePath: string | null;
  failMessage: string | null;
}

/**
 * What one poll of a download client returned: its queue, its history, and
 * whether that pair is the client's *whole* picture right now.
 *
 * `complete` is the load-bearing field here. It is `false` when a page of a
 * paginated response could not be fetched, or when the client reported more
 * entries existed than it actually returned -- any situation where this
 * snapshot might be missing rows the client actually holds. **A `false`
 * snapshot may still be used to advance rows it *contains*: an entry that
 * is present is present, regardless of whether its neighbors are. It may
 * **never** be used to conclude something is *absent*** -- a row missing
 * from an incomplete snapshot might simply be on a page that failed to
 * load, not gone from the client. Only a `complete: true` snapshot licenses
 * "this ref is not here, therefore treat it as gone."
 *
 * **Complete relative to the {@link SnapshotAsk} the caller made (#107).**
 * An adapter that pages may stop once every ref the caller asked about has
 * been seen, and answer `complete: true` for a history it did not read to
 * the end. That is still the licence above, for the refs that were asked
 * about: each one is present, so none is being called absent. What it is
 * *not* is a census of the client -- an entry nobody asked about may sit on
 * a page that was never requested, so `untracked` and `foreign` counts
 * taken over a snapshot cover the pages read, not the client. Every
 * consumer that reads absence from `complete` asks about exactly the rows
 * `reconcile-job.ts` puts in the ask, and `reconcile.ts`'s three gates say
 * so beside their checks.
 */
export interface ClientSnapshot {
  queue: ClientQueueEntry[];
  history: ClientHistoryEntry[];
  complete: boolean;
  /**
   * Every status or state value the adapter could not interpret, one entry
   * per distinct value, empty when it understood all of them.
   *
   * This exists because the two adapters guess differently about an
   * unrecognised value and one of those guesses is expensive: SABnzbd's
   * unknown *history* status reads as `failed` (see `historyOutcome` in
   * `sabnzbd.ts` for why that is the right guess), which turns a download
   * into a failure on the strength of a label this codebase has never seen.
   * Its comment claims that mistake is "visible immediately" -- and it only
   * is if something says so. This is that something: the caller logs these,
   * so a status SABnzbd added after this code was written shows up as a
   * named value to add to a list rather than as unexplained failures.
   *
   * Reported rather than logged here on purpose. An adapter in this package
   * does not own a logger -- `console` use is confined to `bin.ts`,
   * `main.ts` and `host.ts`'s default -- and threading one in to warn would
   * put process-wide mutable "already warned" state inside a client, which
   * is what forces 1.x to export a test-only reset hatch
   * (`resetQbittorrentWarningsForTests`). Returning the values keeps the
   * adapter pure and makes this testable without a console spy.
   */
  unreadable: string[];
}

/**
 * `''` and the literal `'None'` both read as "no category"; anything else
 * -- including a real category that merely *contains* `'None'`, like
 * `'None-Of-The-Above'` -- comes back unchanged. `'None'` is matched by
 * equality only, never substring, for exactly that reason.
 *
 * Takes `string | null | undefined` because a client may omit the field
 * from an entry entirely; `undefined` reads the same as `''`, no category.
 *
 * This is the read half of the trap `qbittorrent.ts`'s own
 * `normalizeCategory` fixes on the send side; the two are deliberately not
 * merged. That one normalises `config.category`, a config value that is
 * always present, so it takes `string` alone -- adding `undefined`
 * handling there would be handling a case that path can never produce.
 * This one reads a field a client's own response may or may not include,
 * so it has to.
 */
/**
 * What one `snapshot` call is for: the refs the caller will ask the answer
 * about, and whether it needs the client's whole list regardless.
 *
 * `refs` are the `client_ref`s of this client's non-terminal rows -- the
 * set `sweepAbsent` checks and the walk advances. `everything` is set when
 * some row of that set has no ref yet: `recoverRefs` matches such a row by
 * category and name against the *whole* snapshot and needs "exactly one
 * match" to be provable, which no early stop can give it.
 *
 * SABnzbd's adapter pages its history until every ref in `refs` has been
 * seen, then stops (#107); with `everything` it pages to the end as it
 * always did. qBittorrent's reads its whole list in one request and ignores
 * the ask. The default, {@link ASK_EVERYTHING}, is the pre-#107 behaviour,
 * so a caller that does not say what it wants pays for the whole picture
 * rather than silently getting less than it needs.
 */
export interface SnapshotAsk {
  readonly refs: ReadonlySet<string>;
  readonly everything: boolean;
}

/** The ask that reads the client's whole list -- what every `snapshot` did before #107. */
export const ASK_EVERYTHING: SnapshotAsk = { refs: new Set(), everything: true };

export function normalizeClientCategory(category: string | null | undefined): string | null {
  return category === null || category === undefined || category === '' || category === 'None'
    ? null
    : category;
}
