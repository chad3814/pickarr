import type { DatabaseSync } from 'node:sqlite';
import { ClientTypeMismatchError, NoClientOfTypeError } from '../errors.ts';

/**
 * The `rss_feed` columns `selectClientForFeed` needs, narrowed the way
 * `config.ts`'s `readRow` narrows a `download_client` row: each field pulled
 * through its own `unknown`-typed accessor, never a wholesale cast.
 */
interface FeedRow {
  id: number;
  name: string;
  downloadClientId: number | null;
  downloadType: string;
}

function readFeedRow(raw: DatabaseSync, feedId: number): FeedRow {
  const row = raw.prepare(
    'SELECT id, name, download_client_id, download_type FROM rss_feed WHERE id = ?',
  ).get(feedId);
  if (!row) {
    throw new Error(`rss feed ${feedId} not found`);
  }
  const downloadClientId = (row as { download_client_id: unknown }).download_client_id;
  return {
    id: Number((row as { id: unknown }).id),
    name: String((row as { name: unknown }).name),
    downloadClientId: downloadClientId === null || downloadClientId === undefined
      ? null
      : Number(downloadClientId),
    downloadType: String((row as { download_type: unknown }).download_type),
  };
}

/**
 * Only `id` and `type` -- never `api_key_secret_name`, `username` or
 * `password_secret_name`. Those columns exist on `download_client` but
 * nothing here compares against them, so nothing here selects them. Since
 * migration 14 the first and last name a `secret` rather than holding a
 * credential, which does not widen what this module may read: resolving a
 * name is `readClientConfig`'s job alone.
 */
interface ClientTypeRow {
  id: number;
  type: string;
}

function readClientType(raw: DatabaseSync, clientId: number): ClientTypeRow | undefined {
  const row = raw.prepare('SELECT id, type FROM download_client WHERE id = ?').get(clientId);
  if (!row) return undefined;
  return {
    id: Number((row as { id: unknown }).id),
    type: String((row as { type: unknown }).type),
  };
}

/** The ids of every `download_client` row of `downloadType`, lowest id first. */
function readCandidateClientIds(raw: DatabaseSync, downloadType: string): number[] {
  const rows = raw.prepare('SELECT id FROM download_client WHERE type = ? ORDER BY id').all(downloadType);
  return rows.map((row) => Number((row as { id: unknown }).id));
}

/**
 * How `selectClientForFeed` breaks a tie: given the number of candidates,
 * answers which one, as an index into the candidate list. Injected rather
 * than called directly for the reason `now` is -- a test that cannot fix
 * the answer can only assert a probability.
 */
export type ChooseIndex = (count: number) => number;

/**
 * The chooser production passes. `random` is a parameter, defaulted to
 * `Math.random`, purely so the mapping from a draw to an index can be
 * pinned exactly; nothing outside a test ever supplies it.
 */
export function randomIndex(count: number, random: () => number = Math.random): number {
  return Math.floor(random() * count);
}

/**
 * The client a feed's picks go to. Throws when there is no client it could
 * mean; where several could, `chooseIndex` settles it -- see that branch for
 * why a draw replaced the refusal that used to stand there.
 */
export function selectClientForFeed(raw: DatabaseSync, feedId: number, chooseIndex: ChooseIndex): number {
  const feed = readFeedRow(raw, feedId);

  if (feed.downloadClientId !== null) {
    const client = readClientType(raw, feed.downloadClientId);
    if (!client) {
      // Ordinarily unreachable: `rss_feed.download_client_id` is a foreign
      // key, and with `PRAGMA foreign_keys = ON` (set in `open.ts`) SQLite
      // refuses both the insert that would create this row and the delete
      // that would leave it dangling. Kept anyway so a caller that somehow
      // reaches it gets a message naming the feed and the id, not a crash
      // reading `.type` off `undefined`.
      throw new Error(
        `feed ${feed.id} (${feed.name}) names download client ${feed.downloadClientId}, which does not exist`,
      );
    }
    if (client.type !== feed.downloadType) {
      // An explicit choice can still be wrong: naming an nzb client on a
      // torrent feed cannot work, and refusing it here -- when the feed is
      // read -- puts the failure next to its cause instead of at the far
      // end of a submit call, where a magnet handed to SABnzbd fails with
      // an opaque error that says nothing about the feed that caused it.
      //
      // A class rather than a bare `Error`, like the no-candidates branch
      // below: `clients/pick.ts` turns this into the `client-type-mismatch`
      // refusal and that one into `no-client-of-type`, and prose is all
      // that told the two apart otherwise -- see `../errors.ts`.
      throw new ClientTypeMismatchError(feed, client);
    }
    return client.id;
  }

  const candidates = readCandidateClientIds(raw, feed.downloadType);

  if (candidates.length === 0) {
    throw new NoClientOfTypeError(feed);
  }

  if (candidates.length > 1) {
    // This branch used to refuse. The reasoning it refused with is kept,
    // because it is still true of what it was aimed at:
    //
    //   A SOLE match is safe to use because it is unambiguous by
    //   construction -- there is exactly one client that type could mean. A
    //   FIRST match would not be: it is exactly the 1.x bug wearing a better
    //   name. 1.x sent every pick to `downloadClients[0]` regardless of how
    //   anything was configured, so a second client of the same type could
    //   receive nothing at all, forever, with no error.
    //
    // What changed is that several candidates are now settled by a draw
    // rather than by a refusal, and that objection does not reach a draw.
    // It is an objection to a *fixed* index: the 1.x failure was a
    // configured client that never received anything, and a draw over the
    // candidates gives every one of them work. The two are not the same
    // answer written differently -- `select.test.ts` fails the fixed one
    // and passes the drawn one, which is the whole point of that test.
    //
    // Refusing was the right answer while nothing could call
    // `requestDownload`; a refusal nobody could trigger cost nothing and
    // kept the question open. Now that a pick reaches here, refusing would
    // fail a pick on an install whose two clients are both able to take it.
    //
    // Health is not consulted, because no health state exists to consult:
    // `download_client` has no status column, no `last_seen` and no failure
    // counter, and nothing records one per client. So a draw can land on a
    // client that is down, and will keep doing so one time in N rather than
    // routing around it. Filed as #93 rather than solved here; an install
    // with one client of a type -- nearly all of them -- never reaches this
    // branch at all.
    const index = chooseIndex(candidates.length);
    const chosen = candidates[index];
    if (chosen === undefined) {
      // Reachable, unlike the two guards around it: `chooseIndex` is
      // injected, so an answer outside the range is a caller's bug and this
      // is what makes it read as one instead of as an `undefined` client id
      // surfacing somewhere further down the submit path.
      throw new Error(
        `feed ${feed.id} (${feed.name}): the download client chooser answered ${index}, which is ` +
        `not one of the ${candidates.length} candidates of type ${JSON.stringify(feed.downloadType)}`,
      );
    }
    return chosen;
  }

  // A sole candidate is taken without consulting `chooseIndex` at all: it
  // is unambiguous by construction, so there is nothing to draw, and the
  // case that describes nearly every install stays independent of whatever
  // chooser a caller supplied.
  const only = candidates[0];
  if (only === undefined) {
    // Unreachable: `candidates.length` is checked to be exactly 1 above, so
    // index 0 exists. Written this way, rather than a non-null assertion,
    // because `noUncheckedIndexedAccess` is on.
    throw new Error(
      `feed ${feed.id} (${feed.name}) has no download client of type ${JSON.stringify(feed.downloadType)}`,
    );
  }
  return only;
}
