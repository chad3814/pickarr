import type { DatabaseSync } from 'node:sqlite';
import type { Transport } from '@pickarr/contract';

/** A feed's poll interval must be at least this many seconds. */
export const MIN_POLL_INTERVAL_S = 60;
/**
 * A feed's poll interval must be at most this many seconds -- a day. Not a
 * correctness bound the way the floor is (see `MIN_POLL_INTERVAL_S`'s
 * comment at its call site below); a ceiling exists so a typo'd interval
 * (a value meant as minutes, or hours) does not silently starve a feed for
 * days between polls, which would look identical to the feed being dead.
 */
export const MAX_POLL_INTERVAL_S = 86_400;

/** What `Host.addFeed` needs to create a feed. */
export interface AddFeedInput {
  pluginId: string;
  name: string;
  url: string;
  downloadType: Transport;
  pollIntervalS: number;
}

/**
 * Why `Host.addFeed` declined to create the row, returned as a value rather
 * than thrown -- see this module's top comment for why.
 */
export interface AddFeedRefusal {
  refusal: 'unknown-plugin' | 'duplicate-url' | 'bad-download-type' | 'bad-poll-interval';
}

/** `Transport`'s whole vocabulary, checked at runtime: a caller's `downloadType` arrives as unchecked input, not a value this module already knows is one of the two literals. */
const TRANSPORTS: ReadonlySet<string> = new Set<Transport>(['torrent', 'nzb']);

/**
 * SQLite's own code for a UNIQUE constraint failure -- verified against
 * `node:sqlite`. Mirrors `media/writer.ts`'s and `clients/downloads.ts`'s own
 * `isUniqueConstraintViolation` -- the same guard, kept here rather than
 * imported, since neither of those is exported and pulling either module in
 * for a two-line SQLite check would be the wrong dependency for this one to
 * take on.
 */
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/**
 * `node:sqlite` throws a plain `Error` carrying `code: 'ERR_SQLITE_ERROR'`
 * and SQLite's own numeric `errcode`, neither part of `@types/node`'s
 * declared `Error` shape, so this is a runtime check rather than something
 * the compiler already knows. Checking `code` alone would not do: a generic
 * logic error surfaces with the same `code` but a different `errcode`, and
 * treating that as a lost race would misreport a real bug as a duplicate
 * url.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  const errcode = (err as { errcode?: unknown }).errcode;
  return code === 'ERR_SQLITE_ERROR' && errcode === SQLITE_CONSTRAINT_UNIQUE;
}

/**
 * The invariants a new `rss_feed` row must satisfy, applied here rather than
 * in the route in front of it (a later task) or left to the table itself:
 * this is testable with no HTTP at all, the same way every other host
 * operation in this package is.
 *
 * Takes `isRegistered` rather than the host's own plugin map, so this module
 * never needs to import `host.ts` (which would be an import cycle -- `Host`
 * imports this module to build `addFeed`) or know that plugins are held in a
 * `Map` at all.
 *
 * Synchronous: every check here is either a lookup already in memory
 * (`isRegistered`) or one `INSERT` against the local database, so there is
 * nothing here to await. `Host.addFeed` wraps this in an `async` method only
 * because the interface promises one, matching `scheduleReconcile`'s own
 * `Promise` for an unrelated reason (see that method's doc comment).
 */
export function addFeed(
  deps: { raw: DatabaseSync; now: () => number; isRegistered: (pluginId: string) => boolean },
  input: AddFeedInput,
): { id: number } | AddFeedRefusal {
  if (!deps.isRegistered(input.pluginId)) {
    return { refusal: 'unknown-plugin' };
  }
  if (!TRANSPORTS.has(input.downloadType)) {
    return { refusal: 'bad-download-type' };
  }
  // The floor matters for more than tidiness: `host.ts`'s poll handler
  // reschedules at `now + seconds * 1000`, so an interval of zero or less
  // enqueues the next poll in the past, and the dispatcher runs it again the
  // instant it is armed -- spinning that feed's poll forever. The ceiling is
  // a typo guard, not a correctness bound; see `MAX_POLL_INTERVAL_S`.
  if (input.pollIntervalS < MIN_POLL_INTERVAL_S || input.pollIntervalS > MAX_POLL_INTERVAL_S) {
    return { refusal: 'bad-poll-interval' };
  }

  const at = deps.now();
  try {
    const result = deps.raw.prepare(`
      INSERT INTO rss_feed (plugin_id, name, url, download_type, poll_interval_s, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.pluginId, input.name, input.url, input.downloadType, input.pollIntervalS, at, at);
    return { id: Number(result.lastInsertRowid) };
  } catch (err) {
    // `rss_feed` carries a `uniqueIndex` on `url` (`db/schema.ts`), so a
    // second feed naming a url already on file raises here rather than at
    // some check run ahead of the insert -- a check-then-insert would leave
    // a window for two concurrent calls to both pass the check and race the
    // same constraint anyway. Whatever SQLite's message says, it is not
    // repeated: a feed url can carry a private tracker's passkey, and the
    // refusal below carries neither the url nor SQLite's own message, only
    // the fact of the collision.
    if (isUniqueConstraintViolation(err)) {
      return { refusal: 'duplicate-url' };
    }
    throw err;
  }
}
