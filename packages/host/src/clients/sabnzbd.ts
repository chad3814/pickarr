import type { SabnzbdConfig } from './config.ts';
import type { QueuedFetch } from '../fetch/queue.ts';
import type { ClientHistoryEntry, ClientQueueEntry, ClientSnapshot } from './snapshot.ts';
import { normalizeClientCategory } from './snapshot.ts';
import { redactUrl } from './redact.ts';
import type { SubmitResult } from './types.ts';

/**
 * The shape `addurl` answers with -- both shapes, because SABnzbd answers a
 * rejection with HTTP 200 and a body saying otherwise: `{ status: false,
 * error: '...' }`, no `nzo_ids` at all. `fetch.json<T>` is an unchecked
 * cast, so declaring `nzo_ids` as always-present would not make it present;
 * it would only move the failure from a named refusal here to a bare
 * `TypeError` on a missing property. 1.x learned this in production
 * (`packages/core/src/clients/sabnzbd.ts` checks `status !== true` before it
 * reads any id) and this adapter follows it.
 *
 * Every field is therefore optional, and `nzo_ids`'s element type stays
 * `string` so `noUncheckedIndexedAccess` still makes `nzo_ids?.[0]` a
 * `string | undefined` that `submit` has to look at rather than assert past.
 */
interface AddUrlResponse {
  status?: boolean;
  error?: string;
  nzo_ids?: string[];
}

/**
 * Builds the `addurl` request url, query parameters in the order SABnzbd's
 * own docs list them. Order has no effect on the server, but it does on
 * this codebase's tests: they assert against the url as a literal string,
 * not against this function's own output, so a stable order is what makes
 * that assertion meaningful rather than circular.
 *
 * The api key travels here, in the query, exactly as SABnzbd requires --
 * and every caller of this function that might let the built url reach an
 * error message must run it through `redactUrl` first. This function does
 * not redact its own output: it is called once per submission and its
 * result is handed straight to `fetch.json`, which redacts on its own
 * error paths already (see `queue.ts`); only code in *this* module that
 * builds a further error around that url has to remember to do the same.
 */
function buildAddUrlUrl(config: SabnzbdConfig, link: string, name: string): string {
  const query = new URLSearchParams();
  query.set('mode', 'addurl');
  query.set('name', link);
  // Sent exactly as configured, never normalised -- unlike qBittorrent's
  // adapter, which folds `''` and the literal `'None'` to "no category"
  // before sending or comparing (see `qbittorrent.ts`'s `normalizeCategory`
  // for its own reasoning, and why the two adapters disagree on purpose). A
  // qBittorrent config can accidentally hold the text `'None'`, which is not
  // a real category name there; SABnzbd has no such accident to guard
  // against on the way *out* -- `config.category` here is whatever an
  // operator configured, and `"None"` is not a spelling qBittorrent's
  // config form or this one would produce by accident. SABnzbd's own use of
  // `"None"` is on the way *back*: it is the literal text the server itself
  // answers with for a queue slot that has no category (1.x's
  // `readCategory`, `packages/core/src/clients/sabnzbd.ts`, ~line 296) --
  // this adapter never reads a slot's category back at all, so that
  // reasoning has nothing to apply to here.
  query.set('cat', config.category);
  query.set('nzbname', name);
  query.set('apikey', config.apiKey);
  query.set('output', 'json');
  return `${config.baseUrl}/api?${query.toString()}`;
}

/**
 * The `limit` passed on each history page request. Far above any realistic
 * installation's history size, so the common case is a single request and
 * paging only actually happens against a client either abnormally large or
 * one that silently caps its response regardless of what was asked for.
 */
const HISTORY_PAGE_SIZE = 500;

/**
 * The most history pages `snapshot` will request before giving up and
 * reporting the snapshot incomplete. 20 pages of `HISTORY_PAGE_SIZE` is
 * 10,000 entries -- far past any real installation -- so this bounds a
 * pathological or misbehaving client rather than a real one.
 */
const MAX_HISTORY_PAGES = 20;

/**
 * Statuses SABnzbd's history reports that mean a job is genuinely never
 * coming back. `failed` is the obvious one. `deleted` belongs here too: it
 * means a person removed the job at the client, and unlike every status in
 * `IN_PROGRESS_STATUSES` nothing is going to move it out of that state
 * later -- the entry just sits in history as `deleted` forever.
 */
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'deleted']);

/**
 * Transient post-processing statuses a real SABnzbd history slot can carry
 * for a job that has neither failed nor finished. Every one of these used
 * to be read as a terminal failure, which was a reported 1.x bug: a normal
 * multi-part download got marked failed while SABnzbd was still unpacking
 * it.
 */
const IN_PROGRESS_STATUSES = new Set([
  'extracting', 'moving', 'repairing', 'verifying', 'fetching', 'running', 'queued', 'paused',
]);

/**
 * The three-way read of a history slot's status. `status` must already be
 * lowercased by the caller -- SABnzbd's own casing (`Extracting`) would
 * otherwise never match either set below.
 *
 * An unrecognised status reads as `failed`, deliberately the less
 * forgiving of the two wrong guesses this function can make. In-progress
 * means "wait and poll again," and nothing ever revisits that guess: the
 * job stays present in history, so it is never read as absent, and it
 * would wait forever with no signal at all if the unrecognised label
 * turned out to be a terminal state this list simply does not enumerate
 * yet. A wrong `failed` is visible immediately and fixed by adding the
 * status to `IN_PROGRESS_STATUSES`; a wrong "still working" has no such
 * feedback loop.
 *
 * `qbittorrent.ts` (Task 4) defaults the opposite way for an unrecognised
 * torrent *state* -- not a bug, a different endpoint shape. SABnzbd's
 * history holds only jobs that have already left the queue, so an
 * unrecognised status there is more likely a terminal one this list
 * hasn't caught up with. qBittorrent's `torrents/info` spans a torrent's
 * whole lifecycle, including active downloading, so an unrecognised state
 * there is more likely still in progress. Both defaults are correct for
 * the endpoint they read; neither is a mistake copied from the other.
 */
function historyOutcome(status: string): 'completed' | 'failed' | 'in-progress' {
  if (status === 'completed') return 'completed';
  if (TERMINAL_FAILURE_STATUSES.has(status)) return 'failed';
  if (IN_PROGRESS_STATUSES.has(status)) return 'in-progress';
  return 'failed';
}

/**
 * Whether this status is one of the ones enumerated above, in any bucket.
 * Separate from `historyOutcome` because the two answer different
 * questions: that one says what to *do* with a slot, this one says whether
 * the answer was informed. A status reaching the `failed` default is
 * reported through `ClientSnapshot.unreadable` so the guess is visible as a
 * named value rather than as unexplained failures -- see that field's own
 * comment.
 */
function isRecognizedStatus(status: string): boolean {
  return status === 'completed'
    || TERMINAL_FAILURE_STATUSES.has(status)
    || IN_PROGRESS_STATUSES.has(status);
}

/**
 * One `queue` slot as SABnzbd's `mode=queue` answers it. Every field
 * optional for the same reason `AddUrlResponse`'s are: `fetch.json<T>` is
 * an unchecked cast, so declaring a field always-present would not make it
 * present.
 */
interface QueueSlot {
  nzo_id?: string;
  filename?: string;
  percentage?: string | number;
  cat?: string;
}

interface QueueResponse {
  queue?: {
    noofslots?: number;
    slots?: QueueSlot[];
  };
}

/** One `history` slot as SABnzbd's `mode=history` answers it. */
interface HistorySlot {
  nzo_id?: string;
  name?: string;
  category?: string;
  status?: string;
  storage?: string;
  fail_message?: string;
}

interface HistoryResponse {
  history?: {
    noofslots?: number;
    slots?: HistorySlot[];
  };
}

/**
 * Builds the `queue` request url. No `cat` filter: `queue.noofslots` is the
 * size of the *whole* queue regardless of what was requested, so a
 * filtered result's length compared against it would report every
 * snapshot incomplete forever. Filtering, if any is wanted, is the
 * caller's job on data this call has already made provably complete.
 *
 * `limit=0` is passed explicitly rather than omitted, even though `queue`
 * already treats a missing `limit` as unlimited: `history` reads a
 * missing `limit` differently (see `buildHistoryUrl`), and 1.x's own
 * comment on this records that relying on that difference silently caused
 * an incident.
 */
function buildQueueUrl(config: SabnzbdConfig): string {
  const query = new URLSearchParams();
  query.set('mode', 'queue');
  query.set('limit', '0');
  query.set('apikey', config.apiKey);
  query.set('output', 'json');
  return `${config.baseUrl}/api?${query.toString()}`;
}

/**
 * Builds one `history` page request url, again with no `cat` filter (see
 * `buildQueueUrl`). Unlike `queue`, `history` has no "unlimited" reading of
 * `limit`, which is why it must be paged at `HISTORY_PAGE_SIZE` at a time
 * rather than asked for everything in one request.
 */
function buildHistoryUrl(config: SabnzbdConfig, start: number): string {
  const query = new URLSearchParams();
  query.set('mode', 'history');
  query.set('start', String(start));
  query.set('limit', String(HISTORY_PAGE_SIZE));
  query.set('apikey', config.apiKey);
  query.set('output', 'json');
  return `${config.baseUrl}/api?${query.toString()}`;
}

/** Builds the `history` delete request url that removes a job and its files. */
function buildHistoryDeleteUrl(config: SabnzbdConfig, ref: string): string {
  const query = new URLSearchParams();
  query.set('mode', 'history');
  query.set('name', 'delete');
  query.set('value', ref);
  query.set('del_files', '1');
  query.set('apikey', config.apiKey);
  query.set('output', 'json');
  return `${config.baseUrl}/api?${query.toString()}`;
}

/**
 * SABnzbd reports a queue slot's `percentage` as a numeric-looking string
 * (occasionally a bare number, depending on version). Anything that does
 * not parse to a finite number reads as `0` rather than `NaN` --
 * `ClientQueueEntry.percentage` is documented as always the client's own
 * number, never a sentinel for "could not read it".
 */
function parsePercentage(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Converts one queue slot to a `ClientQueueEntry`, or `null` if it has no
 * usable `nzo_id` -- there is nothing later could ever match such a slot
 * back to a submitted row, so it is dropped rather than kept under a
 * reference that cannot resolve to anything.
 */
function toQueueEntry(slot: QueueSlot): ClientQueueEntry | null {
  const ref = slot.nzo_id;
  if (ref === undefined || ref === '') return null;
  return {
    ref,
    name: slot.filename ?? '',
    percentage: parsePercentage(slot.percentage),
    category: normalizeClientCategory(slot.cat),
  };
}

/**
 * Converts one history slot to a `ClientHistoryEntry`, or `null` for the
 * same unmatchable-reference reason as `toQueueEntry`. `storagePath` is
 * only ever populated for a `completed` outcome and `failMessage` only for
 * a `failed` one, matching `ClientHistoryEntry`'s own doc comment.
 */
function toHistoryEntry(
  slot: HistorySlot,
  unreadable: Set<string>,
): ClientHistoryEntry | null {
  const ref = slot.nzo_id;
  if (ref === undefined || ref === '') return null;
  const status = (slot.status ?? '').toLowerCase();
  if (!isRecognizedStatus(status)) unreadable.add(status);
  const outcome = historyOutcome(status);
  const storage = slot.storage;
  const failMessage = slot.fail_message;
  return {
    ref,
    name: slot.name ?? '',
    category: normalizeClientCategory(slot.category),
    outcome,
    storagePath: outcome === 'completed' && storage !== undefined && storage !== '' ? storage : null,
    failMessage: outcome === 'failed' && failMessage !== undefined && failMessage !== '' ? failMessage : null,
  };
}

/**
 * Requests one history page at a time, starting after whatever
 * `collected` already holds, until the response's own `noofslots` is
 * satisfied, a page comes back with no slots at all, or `MAX_HISTORY_PAGES`
 * is reached.
 *
 * Recursive rather than a `for`/`while` loop with an `await` in its body:
 * each page's `start` genuinely depends on how much the previous page
 * actually returned, so the pages cannot be parallelised -- a `Promise.all`
 * here would ask every page to start at the same offset, which is exactly
 * the bug this shape avoids. A recursive call keeps that one-await-per-step
 * sequencing without a loop construct for a lint rule to (correctly) flag
 * as a candidate for parallelising, which this genuinely is not.
 */
async function fetchHistoryPages(
  config: SabnzbdConfig,
  fetch: QueuedFetch,
  collected: HistorySlot[],
  page: number,
): Promise<{ slots: HistorySlot[]; complete: boolean }> {
  if (page >= MAX_HISTORY_PAGES) {
    // The cap means "cannot verify the rest," never "this is everything" --
    // see `ClientSnapshot.complete`'s own doc comment.
    return { slots: collected, complete: false };
  }

  let body: HistoryResponse;
  try {
    body = await fetch.json<HistoryResponse>(buildHistoryUrl(config, collected.length));
  } catch {
    // A page that fails to load is exactly as uninformative as hitting the
    // cap: the pages after it are unknown, so the snapshot is incomplete.
    return { slots: collected, complete: false };
  }

  const pageSlots = body.history?.slots ?? [];
  const next = [...collected, ...pageSlots];
  const noofslots = body.history?.noofslots;

  if (typeof noofslots !== 'number') return { slots: next, complete: false };
  if (next.length >= noofslots) return { slots: next, complete: true };
  // An empty page before reaching the reported total means the total was
  // wrong -- another request will not fix that, so stop rather than page
  // on to the cap for nothing.
  if (pageSlots.length === 0) return { slots: next, complete: false };

  return fetchHistoryPages(config, fetch, next, page + 1);
}

/**
 * SABnzbd's adapter: `addurl` is a single request that both submits the
 * nzb link and answers with the reference to remember it by, so there is
 * no separate "confirm" step the way there might be for a client whose
 * submit and lookup are two different endpoints.
 */
export function createSabnzbdClient(
  config: SabnzbdConfig,
  fetch: QueuedFetch,
): {
  submit(link: string, name: string): Promise<SubmitResult>;
  snapshot(): Promise<ClientSnapshot>;
  remove(ref: string): Promise<void>;
} {
  return {
    async submit(link: string, name: string): Promise<SubmitResult> {
      const url = buildAddUrlUrl(config, link, name);
      const body = await fetch.json<AddUrlResponse>(url);

      if (body.status !== true) {
        // SABnzbd rejects with HTTP 200 and `status: false`, so nothing in
        // the transport notices; this is the only place the rejection can be
        // turned into a real failure. `error` is SABnzbd's own wording and
        // routinely quotes back the request it rejected -- a request whose
        // query string is ours, api key included -- so it goes through
        // `redactUrl` exactly like a url would.
        const reason = body.error === undefined || body.error === ''
          ? 'no reason given'
          : redactUrl(body.error);
        throw new Error(`sabnzbd client ${config.id} rejected the submission: ${reason}`);
      }

      const first = body.nzo_ids?.[0];
      if (first === undefined || first === '') {
        // A submission with no id is unrecognisable later -- nothing could
        // ever match a downloads row back to a job in SABnzbd's queue or
        // history. Writing '' as the ref would not fail loudly here; it
        // would instead record a row that looks submitted and can never be
        // reconciled, which is worse than refusing outright. An empty-string
        // id is refused for the same reason as a missing one: it is not a
        // reference to anything, and 1.x rejects it too.
        throw new Error(
          `sabnzbd client ${config.id} submitted ${redactUrl(url)} but got no nzo id back`,
        );
      }
      return { ref: first };
    },

    async snapshot(): Promise<ClientSnapshot> {
      const queuePromise = fetch.json<QueueResponse>(buildQueueUrl(config));
      // Attached immediately, not at the `await queuePromise` further down:
      // the history paging below runs several real awaits (real event-loop
      // turns) before this promise is looked at again, and an unawaited
      // promise with no handler by the end of a turn is what Node considers
      // unhandled -- by default, terminating the process. This handler does
      // not swallow the failure; it only stops the rejection from ever being
      // *unhandled*. `await queuePromise` below still rejects with the same
      // error and is what actually routes it into `queueBody = null`.
      queuePromise.catch(() => {});

      const { slots: historySlots, complete: historyComplete } = await fetchHistoryPages(
        config,
        fetch,
        [],
        0,
      );

      let queueBody: QueueResponse | null;
      try {
        queueBody = await queuePromise;
      } catch {
        // A queue call that fails must not read as an empty client -- see
        // `ClientSnapshot.complete`'s own doc comment. `queue` stays empty
        // below and `complete` is forced false: that combination is what
        // tells a caller "do not conclude absence from this," not "this
        // client holds nothing."
        queueBody = null;
      }

      const queueSlots = queueBody?.queue?.slots ?? [];
      const queueNoofslots = queueBody?.queue?.noofslots;
      const queue: ClientQueueEntry[] = [];
      for (const slot of queueSlots) {
        const entry = toQueueEntry(slot);
        if (entry !== null) queue.push(entry);
      }
      // No separate `queueBody !== null` check: the `?.` chains above
      // already make `queueNoofslots` `undefined` whenever `queueBody` is
      // null, and `typeof undefined === 'number'` is false, so a failed
      // queue call is already excluded here without restating it.
      const queueComplete = typeof queueNoofslots === 'number' && queueSlots.length >= queueNoofslots;

      const history: ClientHistoryEntry[] = [];
      // Collected in a set so a status appears once however many slots carry
      // it, and sorted on the way out so a caller's log line is stable rather
      // than ordered by whichever slot happened to arrive first.
      const unreadable = new Set<string>();
      for (const slot of historySlots) {
        const entry = toHistoryEntry(slot, unreadable);
        if (entry !== null) history.push(entry);
      }

      return {
        queue,
        history,
        complete: queueComplete && historyComplete,
        unreadable: [...unreadable].toSorted(),
      };
    },

    async remove(ref: string): Promise<void> {
      // `del_files=1` is what reclaims the download directory; without it
      // SABnzbd forgets the job and leaves its files behind forever.
      const url = buildHistoryDeleteUrl(config, ref);
      await fetch.json<unknown>(url);
    },
  };
}
