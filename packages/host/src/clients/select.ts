import type { DatabaseSync } from 'node:sqlite';

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
 * Only `id` and `type` -- never `api_key`, `username` or `password`. Those
 * columns exist on `download_client` but nothing here compares against
 * them, so nothing here selects them.
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

/** The client a feed's picks go to. Throws when the choice is ambiguous or absent. */
export function selectClientForFeed(raw: DatabaseSync, feedId: number): number {
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
      throw new Error(
        `feed ${feed.id} (${feed.name}) names download client ${client.id} of type ` +
        `${JSON.stringify(client.type)}, but its download_type is ${JSON.stringify(feed.downloadType)}`,
      );
    }
    return client.id;
  }

  const candidates = readCandidateClientIds(raw, feed.downloadType);

  if (candidates.length === 0) {
    throw new Error(
      `feed ${feed.id} (${feed.name}) has no download client of type ${JSON.stringify(feed.downloadType)}: ` +
      `create one, or set the feed's download_client_id`,
    );
  }

  if (candidates.length > 1) {
    // A SOLE match is safe to use because it is unambiguous by
    // construction -- there is exactly one client that type could mean. A
    // FIRST match would not be: it is exactly the 1.x bug wearing a better
    // name. 1.x sent every pick to `downloadClients[0]` regardless of how
    // anything was configured, so a second client of the same type could
    // receive nothing at all, forever, with no error. When two candidates
    // exist there is no correct silent answer, so this refuses loudly,
    // naming the feed and the candidates, instead of guessing one.
    throw new Error(
      `feed ${feed.id} (${feed.name}) matches ${candidates.length} download clients of type ` +
      `${JSON.stringify(feed.downloadType)} (ids ${candidates.join(', ')}): set the feed's ` +
      `download_client_id to choose one`,
    );
  }

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
