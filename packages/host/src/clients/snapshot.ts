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
 */
export interface ClientSnapshot {
  queue: ClientQueueEntry[];
  history: ClientHistoryEntry[];
  complete: boolean;
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
export function normalizeClientCategory(category: string | null | undefined): string | null {
  return category === null || category === undefined || category === '' || category === 'None'
    ? null
    : category;
}
