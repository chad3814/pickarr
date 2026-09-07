/**
 * The real `DownloadClients`: resolves a plugin's submission to the client
 * that owns its feed, hands it to that client's adapter, and records what
 * happened in `torrent_download` or `nzb_download` -- whichever table
 * matches the *client's* type, not necessarily the feed's (see
 * `tableKindFor` below).
 *
 * The row is written before the adapter is ever called. That ordering is
 * the entire reason `client_ref` is nullable on both tables: a submission
 * that dies between the request and the response leaves a `submitting` row
 * behind rather than nothing at all, and a later attempt (or a human) has
 * something to reconcile. Every update back onto that row is conditional on
 * `status = 'submitting'`, so a slow response that finally arrives after
 * something else has already decided the row's fate cannot clobber it --
 * the same shape as the previous slice's blocking bug, guarded the same
 * way.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DownloadClients, DownloadSubmission } from '@pickarr/contract';
import type { QueuedFetch } from '../fetch/queue.ts';
import { readClientConfig } from './config.ts';
import type { ClientConfig } from './config.ts';
import { createQbittorrentClient, infohashFromMagnet } from './qbittorrent.ts';
import { redactUrl } from './redact.ts';
import { createSabnzbdClient } from './sabnzbd.ts';
import { selectClientForFeed } from './select.ts';
import type { SubmitResult } from './types.ts';

/** SQLite's own code for a UNIQUE constraint failure -- verified against `node:sqlite`. */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * `node:sqlite` throws a plain `Error` carrying `code: 'ERR_SQLITE_ERROR'`
 * and SQLite's own numeric `errcode`, neither part of `@types/node`'s
 * declared `Error` shape, so this is a runtime check rather than something
 * the compiler already knows. Checking `code` alone would not do: a generic
 * logic error surfaces with the same `code` but a different `errcode`, and
 * treating that as a lost race would misreport a real bug as a duplicate
 * reference. Mirrors `media/writer.ts`'s own `isUniqueConstraintViolation`
 * -- the same guard, kept here rather than imported, since that one is not
 * exported and pulling in the media module for a two-line SQLite check
 * would be the wrong dependency for this one to take on.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  const errcode = (err as { errcode?: unknown }).errcode;
  return code === 'ERR_SQLITE_ERROR' && errcode === SQLITE_CONSTRAINT_UNIQUE;
}

/** The columns `createDownloadClients` needs off one `rss_item` row. */
interface DownloadItem {
  id: number;
  feedId: number;
  link: string;
  filename: string;
}

function readDownloadItem(raw: DatabaseSync, rssItemId: number): DownloadItem {
  const row = raw.prepare('SELECT id, feed_id, link, filename FROM rss_item WHERE id = ?').get(rssItemId);
  if (!row) {
    throw new Error(`rss item ${rssItemId} not found`);
  }
  return {
    id: Number((row as { id: unknown }).id),
    feedId: Number((row as { feed_id: unknown }).feed_id),
    link: String((row as { link: unknown }).link),
    filename: String((row as { filename: unknown }).filename),
  };
}

function insertTorrentRow(
  raw: DatabaseSync,
  params: { rssItemId: number; downloadClientId: number; infohash: string | null; at: number },
): number {
  const result = raw.prepare(`
    INSERT INTO torrent_download (rss_item_id, download_client_id, infohash, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, 'submitting', 0, ?, ?)
  `).run(params.rssItemId, params.downloadClientId, params.infohash, params.at, params.at);
  return Number(result.lastInsertRowid);
}

function insertNzbRow(
  raw: DatabaseSync,
  params: { rssItemId: number; downloadClientId: number; at: number },
): number {
  const result = raw.prepare(`
    INSERT INTO nzb_download (rss_item_id, download_client_id, status, attempts, created_at, updated_at)
    VALUES (?, ?, 'submitting', 0, ?, ?)
  `).run(params.rssItemId, params.downloadClientId, params.at, params.at);
  return Number(result.lastInsertRowid);
}

// Four tiny, table-specific functions rather than one parameterised by a
// table-name string: every other query in this codebase names its table as
// a literal, and building one from a variable here -- even a variable this
// module fully controls -- would be the only query anywhere that does not.
//
// Every one of these guards `AND status = 'submitting'`: a settle that
// arrives after something else already decided the row (a newer attempt,
// or -- in a test -- a simulated late update) must not overwrite it.

function markTorrentSubmitted(raw: DatabaseSync, id: number, ref: string, at: number): void {
  raw.prepare(`
    UPDATE torrent_download SET status = 'submitted', client_ref = ?, updated_at = ?
    WHERE id = ? AND status = 'submitting'
  `).run(ref, at, id);
}

function markTorrentFailed(raw: DatabaseSync, id: number, lastError: string, at: number): void {
  raw.prepare(`
    UPDATE torrent_download SET status = 'failed', last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'submitting'
  `).run(lastError, at, id);
}

function markNzbSubmitted(raw: DatabaseSync, id: number, ref: string, at: number): void {
  raw.prepare(`
    UPDATE nzb_download SET status = 'submitted', client_ref = ?, updated_at = ?
    WHERE id = ? AND status = 'submitting'
  `).run(ref, at, id);
}

function markNzbFailed(raw: DatabaseSync, id: number, lastError: string, at: number): void {
  raw.prepare(`
    UPDATE nzb_download SET status = 'failed', last_error = ?, updated_at = ?
    WHERE id = ? AND status = 'submitting'
  `).run(lastError, at, id);
}

/** One client's adapter, narrowed to the one method this module calls. */
interface Adapter {
  submit(link: string, name: string): Promise<SubmitResult>;
}

/**
 * What `config.kind` decides: which table this submission's row belongs in,
 * and which adapter talks to the client. Built from `config.kind` alone --
 * never from `rss_feed.download_type` or `rss_item.download_type` -- so the
 * table a row lands in is always the one the *client* that received it
 * actually is. `selectClientForFeed` refuses a feed/client type mismatch
 * before this ever runs, so today the two always agree; reading the feed's
 * column here instead would only fail the moment that stops being true,
 * silently, by writing to the wrong table.
 */
interface Plan {
  tableKind: 'torrent' | 'nzb';
  adapter: Adapter;
  markSubmitted(raw: DatabaseSync, id: number, ref: string, at: number): void;
  markFailed(raw: DatabaseSync, id: number, lastError: string, at: number): void;
}

function buildPlan(config: ClientConfig, fetch: QueuedFetch): Plan {
  const kind = config.kind;
  switch (kind) {
    case 'sabnzbd':
      return {
        tableKind: 'nzb',
        adapter: createSabnzbdClient(config, fetch),
        markSubmitted: markNzbSubmitted,
        markFailed: markNzbFailed,
      };
    case 'qbittorrent-bearer':
    case 'qbittorrent-login':
      return {
        tableKind: 'torrent',
        adapter: createQbittorrentClient(config, fetch),
        markSubmitted: markTorrentSubmitted,
        markFailed: markTorrentFailed,
      };
    default: {
      // Unreachable given today's three-member `ClientConfig['kind']` union
      // -- kept so a fourth kind added without a case here fails to
      // compile instead of falling through silently. Never the config
      // itself here, only the discriminant: `config` carries `apiKey`,
      // `username` and `password`.
      const impossible: never = kind;
      throw new Error(`download client has unknown kind ${JSON.stringify(String(impossible))}`);
    }
  }
}

/**
 * Builds the host's real `DownloadClients`, in place of `main.ts`'s former
 * stub. See the module doc above for the write-before-call ordering and the
 * conditional-update guard; this function's own body is the sequence the
 * module doc describes, one step per line:
 *
 * 1. Read the rss item to find its feed.
 * 2. `selectClientForFeed` picks the client the feed actually uses, and the
 *    submission's own `downloadClientId` is checked against it -- naming a
 *    different client is refused before anything is written.
 * 3. `readClientConfig` decides the auth strategy, which decides the table
 *    and the adapter (`buildPlan`).
 * 4. The `submitting` row is inserted, with the infohash already known when
 *    the link is a magnet.
 * 5. The adapter runs. A real reference marks the row `submitted`; `null`
 *    (the unresolved `.torrent` case) leaves it `submitting`, with no
 *    error, for a later attempt to resolve; a throw marks it `failed` with
 *    a redacted `last_error` and rethrows.
 */
export function createDownloadClients(deps: {
  raw: DatabaseSync;
  fetch: QueuedFetch;
  now: () => number;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}): DownloadClients {
  const { raw, fetch, now, log } = deps;

  return {
    async submit(submission: DownloadSubmission): Promise<string | null> {
      const item = readDownloadItem(raw, submission.rssItemId);
      const selectedClientId = selectClientForFeed(raw, item.feedId);
      if (selectedClientId !== submission.downloadClientId) {
        throw new Error(
          `download submission names client ${submission.downloadClientId}, but feed ${item.feedId} ` +
          `uses client ${selectedClientId} for its picks`,
        );
      }

      const config = readClientConfig(raw, submission.downloadClientId);
      const plan = buildPlan(config, fetch);

      const insertedAt = now();
      const rowId = plan.tableKind === 'torrent'
        ? insertTorrentRow(raw, {
          rssItemId: submission.rssItemId,
          downloadClientId: submission.downloadClientId,
          infohash: infohashFromMagnet(item.link),
          at: insertedAt,
        })
        : insertNzbRow(raw, {
          rssItemId: submission.rssItemId,
          downloadClientId: submission.downloadClientId,
          at: insertedAt,
        });

      const logDetail = {
        rssItemId: submission.rssItemId,
        downloadClientId: submission.downloadClientId,
        kind: config.kind,
      };
      log('download submission recorded', logDetail);

      try {
        const result = await plan.adapter.submit(item.link, item.filename);
        if (result.ref !== null) {
          plan.markSubmitted(raw, rowId, result.ref, now());
          log('download submitted', logDetail);
        } else {
          log('download submission unresolved, awaiting confirmation', logDetail);
        }
        return result.ref;
      } catch (err) {
        // A second submission of an item whose first attempt already
        // recorded a ref hits the partial unique index on
        // (download_client_id, client_ref) -- `plan.markSubmitted`'s own
        // `UPDATE`, above. Left as SQLite's raw message, `last_error` would
        // read `UNIQUE constraint failed: torrent_download.download_
        // client_id, torrent_download.client_ref`, naming neither the item
        // nor the client. Replaced with a new error (rather than just a
        // different `message` written to this row) so the same clear
        // wording also reaches `jobs.last_error` once this rethrows into
        // `run-job.ts` -- the raw SQLite message would otherwise still get
        // there unchanged.
        const failure = isUniqueConstraintViolation(err)
          ? new Error(
            `rss item ${submission.rssItemId} could not be recorded against download client ` +
            `${submission.downloadClientId}: this client already has a recorded download using ` +
            'the same reference',
            { cause: err },
          )
          : err;
        const message = failure instanceof Error ? failure.message : String(failure);
        plan.markFailed(raw, rowId, redactUrl(message), now());
        log('download submission failed', logDetail);
        throw failure;
      }
    },
  };
}
