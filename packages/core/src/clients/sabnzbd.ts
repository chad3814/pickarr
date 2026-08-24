import type { SabnzbdClientConfig } from '../config/schema.ts';
import {
  asJsonArray as asArray,
  asJsonObject as asRecord,
  asText as text,
  type JsonValue,
} from '../json.ts';
import { applyPathMappings } from './path-mappings.ts';
import type {
  ClientHistoryEntry,
  ClientQueueEntry,
  ClientSnapshot,
  DownloadClient,
  FetchLike,
} from './types.ts';

const TIMEOUT_MS = 20_000;

/**
 * The `limit` passed on each history page request. Far above any realistic
 * installation's history size, so the common case is a single request and
 * paging only actually happens against a client either abnormally large or
 * (see the incident regression test) one that silently caps its response
 * regardless of what was asked for.
 */
const HISTORY_PAGE_SIZE = 500;

/**
 * The most history pages `snapshot()` will request before giving up and
 * reporting the snapshot incomplete. 20 pages of `HISTORY_PAGE_SIZE` is
 * 10,000 entries — far past any real installation — so this bounds a
 * pathological or misbehaving client rather than a real one; a genuine
 * install never gets close.
 */
const MAX_HISTORY_PAGES = 20;

/**
 * Statuses SABnzbd's history reports that mean a job is genuinely never
 * coming back. `Failed` is the obvious one. `Deleted` belongs here too: it
 * means a person removed the job at the client, and unlike every status in
 * `IN_PROGRESS_STATUSES` nothing is going to move it out of that state later
 * — the entry just sits in history as `Deleted` forever. Reading it as
 * in-progress would make reconcile wait on it indefinitely, because reconcile
 * only ever observes *absence* from queue/history, and a deleted job that
 * still sits in history is never absent.
 */
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'deleted']);

/**
 * Transient post-processing statuses a real SABnzbd history slot can carry
 * for a job that has neither failed nor finished. Every one of these used to
 * be read as a terminal failure, which is the reported bug: a normal
 * multi-part download got marked failed while SABnzbd was still unpacking
 * it.
 */
const IN_PROGRESS_STATUSES = new Set([
  'extracting',
  'moving',
  'repairing',
  'verifying',
  'fetching',
  'running',
  'queued',
  'paused',
]);

/**
 * The three-way read of a history slot's status.
 *
 * A status this client has never seen is read as a failure, not as
 * in-progress, deliberately the less forgiving of the two wrong guesses.
 * In-progress means "wait and poll again," and there is no mechanism that
 * ever revisits that guess: the job is present in history, so reconcile never
 * records it as absent, and it stays present indefinitely if the unrecognized
 * label is itself a terminal state SABnzbd introduced that this client does
 * not enumerate yet. A wrong failure is visible immediately and fixable by
 * extending this list; a wrong "still working" can hang forever with no
 * signal that anything is wrong.
 */
function historyOutcome(status: string): 'completed' | 'failed' | 'in-progress' {
  if (status === 'completed') return 'completed';
  if (TERMINAL_FAILURE_STATUSES.has(status)) return 'failed';
  if (IN_PROGRESS_STATUSES.has(status)) return 'in-progress';
  return 'failed';
}

/** Whether `status` is one this client actually enumerates, in any bucket. */
function isRecognizedStatus(status: string): boolean {
  return status === 'completed' || TERMINAL_FAILURE_STATUSES.has(status) || IN_PROGRESS_STATUSES.has(status);
}

/**
 * Whether the process has already emitted the "unrecognized history status"
 * warning below. Defaulting an unrecognized status to `failed` (see
 * `historyOutcome`) is deliberate, but silently, it produces a failure record
 * indistinguishable from a genuine one — the exact failure class this whole
 * three-way outcome exists to fix. The warning is what makes the next
 * occurrence name itself instead of reproducing that bug invisibly. Global-
 * once rather than once per tick, same rationale as `warnedLabelMismatch` in
 * `pipeline/reconcile.ts`: a short poll interval would otherwise flood the
 * log with the same fact restated every few seconds.
 */
let warnedUnrecognizedHistoryStatus = false;

/**
 * Test-only escape hatch, mirroring
 * `resetReconcileWarningsForTests` in `pipeline/reconcile.ts`: node:test
 * runs every test in one file inside a single process/module instance, so
 * the "once per process" flag above persists across tests unless a test
 * resets it first.
 */
export function resetUnrecognizedHistoryStatusWarningForTests(): void {
  warnedUnrecognizedHistoryStatus = false;
}

/**
 * Whether the process has already emitted the "dropped slot" warning below.
 * Same once-per-process rationale as `warnedUnrecognizedHistoryStatus`.
 */
let warnedDroppedSlot = false;

/** Test-only escape hatch, mirroring `resetUnrecognizedHistoryStatusWarningForTests`. */
export function resetDroppedSlotWarningForTests(): void {
  warnedDroppedSlot = false;
}

function warnDroppedSlotOnce(kind: 'queue' | 'history', dropped: number): void {
  if (warnedDroppedSlot) return;
  warnedDroppedSlot = true;
  console.warn(
    `pickarr: SABnzbd ${kind} reported ${dropped} slot(s) this client could not read an ` +
      'nzo_id from; the snapshot is being treated as incomplete rather than risking an ' +
      'absence mark for a job the client actually holds.',
  );
}

function warnUnrecognizedStatusOnce(ref: string, rawStatus: string): void {
  if (warnedUnrecognizedHistoryStatus) return;
  warnedUnrecognizedHistoryStatus = true;
  console.warn(
    `pickarr: SABnzbd history entry ${ref} has status '${rawStatus}', which this client does ` +
      'not recognize; treating it as failed rather than waiting on it indefinitely. If this is ' +
      'actually a transient state, add it to IN_PROGRESS_STATUSES in clients/sabnzbd.ts.',
  );
}

/**
 * What a string becomes when redaction cannot produce a version of it that is
 * *provably* free of the api key.
 *
 * This is the load-bearing idea in this file. Rewriting a secret out of text
 * somebody else wrote is a blocklist, and a blocklist has to anticipate every
 * shape the secret might take; three previous attempts at this each closed one
 * shape and left another open. So the rewrite is no longer trusted on its own:
 * whatever it produces is checked, and text that still yields the key under
 * routine decoding is dropped whole rather than emitted. Failing to anticipate
 * an encoding then costs a diagnostic, not the key.
 */
const WITHHELD = '[withheld: carried the api key in a form this client will not rewrite]';

/**
 * How many rounds of decoding a consumer is assumed to be willing to apply.
 * Each round can percent-decode and/or form-decode, so this covers
 * multiply-encoded text; four is far past anything a real client or log
 * pipeline does and the search terminates as soon as decoding stops changing
 * the string, which is after one round for ordinary text.
 */
const MAX_DECODE_ROUNDS = 4;

/**
 * Strips the value of an `apikey` query parameter wherever one appears in a
 * string, regardless of how the value itself is encoded. This is what keeps
 * the common case (a URL echoed back at us) legible, because it keys off the
 * structural delimiters (`?`/`&` before, `&`/whitespace/end-of-string after)
 * rather than the literal value. It is not, on its own, a safety guarantee —
 * it only fires where those delimiters survive.
 */
function redactApiKeyParam(message: string): string {
  return message.replace(/([?&]apikey=)[^&\s]*/gi, '$1***');
}

/**
 * Decodes each maximal run of `%XX` escapes, leaving anything undecodable
 * alone. Deliberately not a plain `decodeURIComponent` on the whole string:
 * that throws on a lone `%` (routine in stack traces and Windows paths), and a
 * check that can be switched off by prefixing one `%` is not a check.
 */
function percentDecode(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Every reading of `value` that a consumer could arrive at with routine
 * decoding — repeated percent-decoding, `+`-for-space form decoding (which
 * `decodeURIComponent` does not do, and which `URLSearchParams` produces for
 * any key containing a space), and any interleaving of the two.
 *
 * This is the definition of "recoverable" the safety check below is stated
 * against. It does not cover an actively hostile peer that re-encodes the key
 * in a scheme of its own invention (base64, a cipher); no in-band filter can.
 */
function decodings(value: string): Set<string> {
  const views = new Set<string>([value]);
  let frontier = [value];
  for (let round = 0; round < MAX_DECODE_ROUNDS && frontier.length > 0; round += 1) {
    const next: string[] = [];
    for (const view of frontier) {
      for (const candidate of [percentDecode(view), view.replaceAll('+', ' ')]) {
        if (!views.has(candidate)) {
          views.add(candidate);
          next.push(candidate);
        }
      }
    }
    frontier = next;
  }
  return views;
}

export function createSabnzbdClient(
  config: SabnzbdClientConfig,
  fetchImpl: FetchLike = (url) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
): DownloadClient {
  const base = config.url.replace(/\/+$/, '');

  /** Never include the built URL in an error — it carries the api key. */
  function endpoint(params: Record<string, string>): string {
    const query = new URLSearchParams({ ...params, apikey: config.apiKey, output: 'json' });
    return `${base}/api?${query.toString()}`;
  }

  /**
   * The spellings of the key this client knows how to rewrite in place: as
   * written, percent-encoded, and form-encoded (which differs from
   * percent-encoding for a key containing a space — `+` versus `%20`, and
   * `URLSearchParams` emits the former). Anything outside this set is caught
   * by carriesSecret and costs the whole string, so this list exists for
   * legibility, not for safety. An empty key is not a secret and is filtered
   * out, which also stops `replaceAll('', ...)` splicing `***` between every
   * character.
   */
  const spellings = [
    ...new Set([
      config.apiKey,
      encodeURIComponent(config.apiKey),
      new URLSearchParams({ apikey: config.apiKey }).toString().slice('apikey='.length),
    ]),
  ].filter((spelling) => spelling.length > 0);

  /**
   * Rewrites the spellings above wherever they appear, including outside a
   * query string — inside an error's `name`, a bracketed URL, a sentence.
   */
  function redactKnownSpellings(message: string): string {
    let out = message;
    for (const spelling of spellings) out = out.replaceAll(spelling, '***');
    return out;
  }

  /**
   * The safety predicate: can the key be read out of this text by anyone
   * willing to decode it? Everything the client emits is checked against this
   * *after* rewriting, so the guarantee does not depend on the rewrite having
   * anticipated the right encoding.
   */
  function carriesSecret(message: string): boolean {
    if (config.apiKey.length === 0) return false;
    for (const view of decodings(message)) {
      if (view.includes(config.apiKey)) return true;
    }
    return false;
  }

  /**
   * The one door every string the client did not write itself passes through
   * before it can reach a message, a return value, or a caller's log. Rewrite
   * first for legibility, then verify; withhold if verification fails.
   */
  function redact(message: string): string {
    const rewritten = redactKnownSpellings(redactApiKeyParam(message));
    return carriesSecret(rewritten) ? WITHHELD : rewritten;
  }

  /** `asText`, but nothing comes out of a response body unredacted. */
  function safeText(value: JsonValue | undefined): string {
    return redact(text(value));
  }

  /**
   * Reads a slot's category through `safeText` (a category is server text
   * like any other) and maps "no category" to `null`. SABnzbd spells that
   * two different ways depending on which endpoint answered: a queue slot
   * with no category is the literal string `"None"`, never an absent field;
   * a history slot with no category is the empty string. Both must collapse
   * to `null`, or a local filter comparing against a real category name
   * (see the reconcile design) would treat "None" as a category nobody
   * configured.
   */
  function readCategory(value: JsonValue | undefined): string | null {
    const raw = safeText(value);
    return raw === '' || raw === 'None' ? null : raw;
  }

  /**
   * Wraps an error from an injectable dependency (fetchImpl itself, or a
   * Response's .json()) so nothing it says can leak the api key. The
   * property must hold regardless of how a caller ends up logging or
   * inspecting the resulting error — via .message, String(error),
   * error.cause, or util.inspect — so the original is never attached
   * verbatim as `cause`; a redacted stand-in is attached instead. Both
   * `.message` and `.name` are redacted: nothing copied off an untrusted
   * error may skip the redactor, since either field can carry the key.
   */
  function sanitize(prefix: string, error: Error): Error {
    const sanitizedCause = new Error(redact(error.message));
    sanitizedCause.name = redact(error.name);
    return new Error(prefix, { cause: sanitizedCause });
  }

  async function call(mode: string, params: Record<string, string>): Promise<JsonValue> {
    const url = endpoint({ mode, ...params });
    let response: Response;
    try {
      response = await fetchImpl(url);
    } catch (error) {
      // fetchImpl is an injectable seam; some implementations (instrumented or
      // proxying fetch wrappers) embed the request URL in their thrown error,
      // and some may not throw an Error at all — coerce rather than assume.
      throw sanitize(`SABnzbd ${mode} request failed`, error instanceof Error ? error : new Error(String(error)));
    }
    if (!response.ok) {
      throw new Error(`SABnzbd ${mode} returned HTTP ${response.status}`);
    }
    try {
      return (await response.json()) as JsonValue;
    } catch (error) {
      // Same seam as above: a Response implementation's .json() can throw
      // whatever it likes, including a message that echoes the request URL.
      throw sanitize(
        `SABnzbd ${mode} returned an unparsable response`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  return {
    id: config.id,
    importMode: config.importMode,
    category: config.category,

    // `label` is deliberately unused: SABnzbd carries the marker inside `name`,
    // which it echoes back as `nzbname`. Named rather than dropped from the
    // signature so the interface's third parameter is visibly accounted for.
    async addUrl(url, name, _label) {
      const body = asRecord(
        await call('addurl', { name: url, cat: config.category, nzbname: name }),
      );
      if (body === null || body['status'] !== true) {
        // `error` is SABnzbd's own wording and routinely quotes the request it
        // rejected — request that SABnzbd built no part of, and whose query
        // string is ours, api key included.
        const reason =
          body === null ? 'malformed response' : safeText(body['error']) || 'unknown error';
        throw new Error(`SABnzbd rejected the download: ${reason}`);
      }

      const ids = asArray(body['nzo_ids']);
      const first = ids[0];
      if (typeof first !== 'string' || first.length === 0) {
        throw new Error('SABnzbd accepted the download but returned no nzo id');
      }
      return redact(first);
    },

    async snapshot(): Promise<ClientSnapshot> {
      // No `category` on either call. We match entries to downloads on
      // `nzo_id` with the `[pickarr-<token>-<id>]` label as a fallback
      // (reconcile.ts), not on the client's category, and asking SABnzbd to
      // filter for us would break the completeness check below: queue_info's
      // `noofslots` is the size of the *whole* queue regardless of what was
      // requested, so comparing a filtered result's length against it would
      // report every snapshot incomplete forever. Filtering, if any is
      // wanted, is the caller's job on data that is provably everything.
      //
      // `limit=0` is passed explicitly rather than omitted, even though
      // queue_info already treats a missing limit as unlimited: the two
      // endpoints read a missing `limit` differently, and relying on that
      // difference silently is what caused this incident.
      //
      // Not awaited here: the history loop below awaits real network calls
      // (real event-loop turns) before this promise is examined again, and
      // an unawaited promise with no handler attached by the end of a turn
      // is what Node considers unhandled — by default, terminating the
      // process (a `Promise.all` of both calls, as this used to be, didn't
      // have this problem, because `Promise.all` attaches its own handler to
      // both promises synchronously). `queueFailed` below is that handler:
      // attaching it here, not at the `await queuePromise` further down, is
      // what keeps a queue-side rejection from ever being unhandled, and
      // lets the loop notice and stop paging rather than running to the cap
      // against a client that has already told us it is unreachable.
      const queuePromise = call('queue', { limit: '0' });
      let queueFailed = false;
      queuePromise.catch(() => {
        queueFailed = true;
      });

      // History has no "unlimited" equivalent, so it must be paged: request
      // HISTORY_PAGE_SIZE at a time, starting after whatever has already
      // been collected, until the response's own `noofslots` says there is
      // nothing left, a page comes back with no slots, or MAX_HISTORY_PAGES
      // is hit. Sequential, not parallel — each page's `start` depends on
      // how much the previous page actually returned.
      const historySlots: JsonValue[] = [];
      let historyComplete = false;
      for (let page = 0; page < MAX_HISTORY_PAGES && !queueFailed; page += 1) {
        const historyBody = await call('history', {
          start: String(historySlots.length),
          limit: String(HISTORY_PAGE_SIZE),
        });
        const historyRecord = asRecord(asRecord(historyBody)?.['history']);
        const pageSlots = asArray(historyRecord?.['slots']);
        historySlots.push(...pageSlots);

        // Read defensively: `noofslots` is a number in every real response,
        // but a value that is missing or not a number must not throw — it
        // means "cannot verify", which is exactly the false-`complete` case,
        // not a crash.
        //
        // Ruling: when it is unreadable, stop after this one page rather
        // than paging on to MAX_HISTORY_PAGES as the brief's literal text
        // says. `complete` is false either way once `noofslots` cannot be
        // read — nothing past this page can turn it true — so the other 19
        // requests a genuinely unresponsive `noofslots` client would
        // otherwise cost, every single tick, buy nothing. This deliberately
        // supersedes the brief for this one case; do not restore the loop
        // to "fix" it back.
        const noofslots = historyRecord?.['noofslots'];
        if (typeof noofslots !== 'number') break;
        if (historySlots.length >= noofslots) {
          historyComplete = true;
          break;
        }
        // An empty page before reaching the reported total means the total
        // was wrong — more paging will not help, so stop rather than loop to
        // the cap for nothing.
        if (pageSlots.length === 0) break;
      }

      // Everything below reads through safeText, never asText. These strings
      // are *returned* rather than thrown, so none of the error-path defences
      // apply to them, and a caller logging a snapshot would print them
      // straight off the wire. SABnzbd's fail_message in particular quotes
      // the failing request.
      //
      // Still awaited unconditionally, whether or not the loop above exited
      // early on `queueFailed`: this is what actually surfaces the rejection
      // to `snapshot()`'s caller. The `.catch` above only ever silences the
      // *unhandled*-rejection bookkeeping; it never resolves or swallows the
      // failure itself, so this line rejects with the original error exactly
      // as it did before `Promise.all` was replaced.
      const queueBody = await queuePromise;
      const queueRecord = asRecord(asRecord(queueBody)?.['queue']);
      const queueSlots = asArray(queueRecord?.['slots']);
      const queueNoofslots = queueRecord?.['noofslots'];

      const queue: ClientQueueEntry[] = [];
      for (const raw of queueSlots) {
        const slot = asRecord(raw);
        if (slot === null) continue;
        const ref = safeText(slot['nzo_id']);
        if (ref === '') continue;
        queue.push({
          ref,
          name: safeText(slot['filename']),
          percentage: Number.parseInt(safeText(slot['percentage']), 10) || 0,
          category: readCategory(slot['cat']),
        });
      }

      // The naive reading is that comparing `queueSlots.length` (every slot the
      // client sent, before we could key any of it) against `noofslots` (the
      // client's own count) is enough to know the snapshot is whole. It is not:
      // a slot with an unreadable `nzo_id` is dropped above rather than kept
      // under a key we cannot trust, so it never reaches `queue`, but it was
      // still counted in `queueSlots.length` — the length test would pass while
      // a job we actually hold at the client silently fails to appear in
      // `queue`. Property (b) (an incomplete snapshot must never imply
      // absence) then breaks for exactly that job. Comparing the accepted count
      // against the raw count closes that: dropping anything makes the
      // snapshot incomplete.
      const droppedQueueSlots = queueSlots.length - queue.length;
      if (droppedQueueSlots > 0) warnDroppedSlotOnce('queue', droppedQueueSlots);
      const queueComplete =
        typeof queueNoofslots === 'number' &&
        queueSlots.length >= queueNoofslots &&
        droppedQueueSlots === 0;

      const history: ClientHistoryEntry[] = [];
      for (const raw of historySlots) {
        const slot = asRecord(raw);
        if (slot === null) continue;
        const ref = safeText(slot['nzo_id']);
        if (ref === '') continue;

        const rawStatus = safeText(slot['status']);
        const status = rawStatus.toLowerCase();
        const outcome = historyOutcome(status);
        const storage = safeText(slot['storage']);
        const failMessage = safeText(slot['fail_message']);

        // An unrecognized status defaults to `failed` (see historyOutcome),
        // but without this, that record is indistinguishable from a genuine
        // failure — exactly the failure class this whole change exists to
        // fix. Naming the raw status in the message, and warning once, is
        // what makes the next occurrence visible instead of silent.
        let effectiveFailMessage = failMessage === '' ? null : failMessage;
        if (outcome === 'failed' && !isRecognizedStatus(status)) {
          warnUnrecognizedStatusOnce(ref, rawStatus);
          const note = `unrecognized SABnzbd status '${rawStatus}'`;
          effectiveFailMessage =
            effectiveFailMessage === null ? note : `${note}: ${effectiveFailMessage}`;
        }

        history.push({
          ref,
          name: safeText(slot['name']),
          outcome,
          storagePath: outcome === 'completed' && storage !== '' ? storage : null,
          failMessage: effectiveFailMessage,
          category: readCategory(slot['category']),
        });
      }

      // Same reasoning as `droppedQueueSlots` above, applied to history: a slot
      // with an unreadable `nzo_id` is dropped rather than kept, but it was
      // still counted toward `historySlots.length`, which is what the paging
      // loop above compared against `noofslots`. The naive reading is that the
      // page-total check is enough on its own; it is not, because it only ever
      // sees the raw count, never the count we could actually key entries by.
      // Requiring the accepted count to match the raw count here catches a
      // drop even though the page-total check already passed.
      //
      // This distinction matters more here than for the queue because each
      // history page's `start` is derived from `historySlots.length` — the raw
      // count, not the accepted one — so the two were always going to diverge
      // whenever a drop happens mid-page, not just at the end. Tracking them
      // separately, rather than folding "accepted" into the paging arithmetic,
      // is what keeps the paging math correct and still lets a drop surface.
      const droppedHistorySlots = historySlots.length - history.length;
      if (droppedHistorySlots > 0) warnDroppedSlotOnce('history', droppedHistorySlots);
      const historyIsComplete = historyComplete && droppedHistorySlots === 0;

      return { queue, history, complete: queueComplete && historyIsComplete };
    },

    async remove(ref: string, deleteFiles: boolean): Promise<void> {
      // `del_files` is what reclaims the download directory; without it
      // SABnzbd forgets the job and leaves its files behind forever.
      await call('history', {
        name: 'delete',
        value: ref,
        del_files: deleteFiles ? '1' : '0',
      });
    },

    mapPath(clientPath) {
      return applyPathMappings(config.pathMappings, clientPath);
    },
  };
}
