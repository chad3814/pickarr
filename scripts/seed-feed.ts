/**
 * Inserts one `rss_feed` row.
 *
 * There is deliberately no config surface in this slice (see the plan's
 * §1.2) -- a fresh host install polls nothing until a feed exists, and this
 * is how one gets created before that surface exists.
 *
 *   npm run seed-feed -- --database=/config/pickarr.db --plugin=double \
 *     --name="Example feed" --url=https://example.test/feed.xml \
 *     --type=torrent --interval=900
 *
 * `--type` is `torrent` or `usenet` (default `torrent`); `--interval` is the
 * poll interval in seconds (default 900, `rss_feed.poll_interval_s`'s own
 * default).
 *
 * Runs `migrateHost` first, so this also works against a database file that
 * has never been opened by the host process -- seeding is meant to happen
 * before the first boot, not only after it.
 *
 * `rss_feed.url` carries a `UNIQUE` index (see `db/schema.ts`), so re-seeding
 * a url already on file fails loudly, naming the existing row's id, rather
 * than silently overwriting its plugin, name, type or interval -- a feed a
 * script mutates without being asked is a worse surprise than a script that
 * refuses. Delete the row first, or point this invocation at a different
 * url, to reseed it.
 */
import type { DatabaseSync } from 'node:sqlite';
// Reached by path rather than by package name, exactly as the other scripts
// under this directory reach `@pickarr/core`: `@pickarr/host` exports only
// its application entry point, and widening that for repo-local tooling
// would add production surface nothing ships against.
import { migrateHost } from '../packages/host/src/db/migrate.ts';
import { openDatabase } from '../packages/host/src/db/open.ts';

type DownloadType = 'torrent' | 'usenet';

interface Options {
  databasePath: string;
  pluginId: string;
  name: string;
  url: string;
  downloadType: DownloadType;
  pollIntervalS: number;
}

function isDownloadType(value: string): value is DownloadType {
  return value === 'torrent' || value === 'usenet';
}

function usage(): never {
  throw new Error(
    'Usage: npm run seed-feed -- --database=<path> --plugin=<id> --name=<name> --url=<url> ' +
      '[--type=torrent|usenet] [--interval=<seconds>]',
  );
}

function parseArgs(argv: readonly string[]): Options {
  let databasePath: string | undefined;
  let pluginId: string | undefined;
  let name: string | undefined;
  let url: string | undefined;
  let downloadType: string | undefined;
  let pollIntervalS = 900;

  for (const arg of argv) {
    if (arg.startsWith('--database=')) databasePath = arg.slice('--database='.length);
    else if (arg.startsWith('--plugin=')) pluginId = arg.slice('--plugin='.length);
    else if (arg.startsWith('--name=')) name = arg.slice('--name='.length);
    else if (arg.startsWith('--url=')) url = arg.slice('--url='.length);
    else if (arg.startsWith('--type=')) downloadType = arg.slice('--type='.length);
    else if (arg.startsWith('--interval=')) pollIntervalS = Number(arg.slice('--interval='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (
    databasePath === undefined || databasePath.length === 0
    || pluginId === undefined || pluginId.length === 0
    || name === undefined || name.length === 0
    || url === undefined || url.length === 0
  ) {
    usage();
  }
  if (downloadType !== undefined && !isDownloadType(downloadType)) {
    throw new Error(`--type must be "torrent" or "usenet", got "${downloadType}"`);
  }
  if (!Number.isInteger(pollIntervalS) || pollIntervalS <= 0) {
    throw new Error(`--interval must be a positive integer of seconds, got "${pollIntervalS}"`);
  }

  return {
    databasePath,
    pluginId,
    name,
    url,
    downloadType: downloadType ?? 'torrent',
    pollIntervalS,
  };
}

/** The id of the feed already on file at `url`, if any. */
function existingFeedId(raw: DatabaseSync, url: string): number | undefined {
  const row = raw.prepare('SELECT id FROM rss_feed WHERE url = ?').get(url);
  if (row === undefined) return undefined;
  return Number((row as { id: unknown }).id);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const { raw } = openDatabase(options.databasePath);
  migrateHost(raw);

  const existing = existingFeedId(raw, options.url);
  if (existing !== undefined) {
    raw.close();
    throw new Error(
      `a feed with url ${options.url} already exists (id ${existing}) -- delete it first, or point ` +
        'this invocation at a different url, to reseed it',
    );
  }

  const now = Date.now();
  const result = raw.prepare(`
    INSERT INTO rss_feed (plugin_id, name, url, download_type, poll_interval_s, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(options.pluginId, options.name, options.url, options.downloadType, options.pollIntervalS, now, now);
  raw.close();

  console.log(
    `seeded rss_feed id ${Number(result.lastInsertRowid)}: "${options.name}" (${options.url}), ` +
      `plugin ${options.pluginId}, ${options.downloadType}, every ${options.pollIntervalS}s`,
  );
}

main().catch((error: Error) => {
  console.error(`seed-feed: ${error.message}`);
  process.exit(1);
});
