/**
 * Inserts one `download_client` row.
 *
 * There is deliberately no config surface in this slice (see the plan's
 * §1.2) -- a fresh host install has no download client until one is
 * created, and this is how one gets created before a feed can submit
 * anything to it.
 *
 *   PICKARR_CLIENT_API_KEY=... npm run seed-client -- --database=/config/pickarr.db \
 *     --name="My qBittorrent" --type=torrent --implementation=qbittorrent \
 *     --url=http://qbt.example.com:8080 --category=pickarr --import-mode=copy
 *
 *   PICKARR_CLIENT_PASSWORD=... npm run seed-client -- --database=/config/pickarr.db \
 *     --name="My qBittorrent (legacy)" --type=torrent --implementation=qbittorrent \
 *     --url=http://qbt.example.com:8080 --category=pickarr --import-mode=copy --username=admin
 *
 *   PICKARR_CLIENT_API_KEY=... npm run seed-client -- --database=/config/pickarr.db \
 *     --name="My SABnzbd" --type=nzb --implementation=sabnzbd \
 *     --url=http://sab.example.com:8080 --category=pickarr --import-mode=copy
 *
 * `--type` is `torrent` or `nzb`; `--implementation` is `qbittorrent` or
 * `sabnzbd` and must agree with `--type` the way `readClientConfig`
 * requires (torrent/qbittorrent, nzb/sabnzbd). `--import-mode` is `move` or
 * `copy`.
 *
 * The credential never travels as an argument: `--username` (not a secret
 * on its own) is the only credential-adjacent flag this script accepts, and
 * it selects qBittorrent's legacy login strategy. The api key (SABnzbd, or
 * qBittorrent's modern bearer strategy) and the password (qBittorrent's
 * legacy strategy, alongside `--username`) are read from
 * `PICKARR_CLIENT_API_KEY` and `PICKARR_CLIENT_PASSWORD` instead -- an
 * argument is visible in `ps` output and in shell history for as long as
 * that history is kept, and an environment variable handed to one process
 * is neither.
 *
 * Runs `migrateHost` first, so this also works against a database file
 * that has never been opened by the host process -- seeding is meant to
 * happen before the first boot, not only after it.
 *
 * `download_client.name` carries a `UNIQUE` index (see `db/schema.ts`), so
 * re-seeding a name already on file fails loudly, naming the existing
 * row's id, rather than silently overwriting its url, credential or
 * category -- a client a script mutates without being asked is a worse
 * surprise than a script that refuses. Delete the row first, or choose a
 * different name, to reseed it.
 */
import type { DatabaseSync } from 'node:sqlite';
// Reached by path rather than by package name, exactly as `seed-feed.ts`
// reaches `@pickarr/host`: `@pickarr/host` exports only its application
// surface, and widening that for repo-local tooling would add production
// surface nothing ships against.
import { migrateHost } from '../packages/host/src/db/migrate.ts';
import { openDatabase } from '../packages/host/src/db/open.ts';

type ClientType = 'torrent' | 'nzb';
type Implementation = 'qbittorrent' | 'sabnzbd';

interface Options {
  databasePath: string;
  name: string;
  type: ClientType;
  implementation: Implementation;
  baseUrl: string;
  category: string;
  importMode: 'move' | 'copy';
  username: string | null;
}

function isClientType(value: string): value is ClientType {
  return value === 'torrent' || value === 'nzb';
}

function isImplementation(value: string): value is Implementation {
  return value === 'qbittorrent' || value === 'sabnzbd';
}

function isImportMode(value: string): value is 'move' | 'copy' {
  return value === 'move' || value === 'copy';
}

function usage(): never {
  throw new Error(
    'Usage: npm run seed-client -- --database=<path> --name=<name> --type=torrent|nzb ' +
      '--implementation=qbittorrent|sabnzbd --url=<url> --category=<category> ' +
      '--import-mode=move|copy [--username=<name>]\n' +
      'Credential: set PICKARR_CLIENT_API_KEY (sabnzbd, or qbittorrent without --username) or ' +
      'PICKARR_CLIENT_PASSWORD (qbittorrent with --username) in the environment -- never as an argument.',
  );
}

function parseArgs(argv: readonly string[]): Options {
  let databasePath: string | undefined;
  let name: string | undefined;
  let type: string | undefined;
  let implementation: string | undefined;
  let baseUrl: string | undefined;
  let category: string | undefined;
  let importMode: string | undefined;
  let username: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith('--database=')) databasePath = arg.slice('--database='.length);
    else if (arg.startsWith('--name=')) name = arg.slice('--name='.length);
    else if (arg.startsWith('--type=')) type = arg.slice('--type='.length);
    else if (arg.startsWith('--implementation=')) implementation = arg.slice('--implementation='.length);
    else if (arg.startsWith('--url=')) baseUrl = arg.slice('--url='.length);
    else if (arg.startsWith('--category=')) category = arg.slice('--category='.length);
    else if (arg.startsWith('--import-mode=')) importMode = arg.slice('--import-mode='.length);
    else if (arg.startsWith('--username=')) username = arg.slice('--username='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (
    databasePath === undefined || databasePath.length === 0
    || name === undefined || name.length === 0
    || type === undefined
    || implementation === undefined
    || baseUrl === undefined || baseUrl.length === 0
    || category === undefined || category.length === 0
    || importMode === undefined
  ) {
    usage();
  }
  if (!isClientType(type)) {
    throw new Error(`--type must be "torrent" or "nzb", got "${type}"`);
  }
  if (!isImplementation(implementation)) {
    throw new Error(`--implementation must be "qbittorrent" or "sabnzbd", got "${implementation}"`);
  }
  if (!isImportMode(importMode)) {
    throw new Error(`--import-mode must be "move" or "copy", got "${importMode}"`);
  }
  if (implementation === 'sabnzbd' && type !== 'nzb') {
    throw new Error('--implementation=sabnzbd requires --type=nzb');
  }
  if (implementation === 'qbittorrent' && type !== 'torrent') {
    throw new Error('--implementation=qbittorrent requires --type=torrent');
  }
  if (implementation === 'sabnzbd' && username !== undefined) {
    throw new Error('--username has no effect on --implementation=sabnzbd, which always authenticates with an api key');
  }

  return {
    databasePath,
    name,
    type,
    implementation,
    baseUrl,
    category,
    importMode,
    username: username ?? null,
  };
}

/** Which credential this client needs, and which environment variable it comes from. */
interface Credential {
  apiKey: string | null;
  password: string | null;
}

const API_KEY_ENV_VAR = 'PICKARR_CLIENT_API_KEY';
const PASSWORD_ENV_VAR = 'PICKARR_CLIENT_PASSWORD';

/**
 * Reads whichever credential this client's strategy needs straight from
 * the environment -- never from `argv`, which is visible in `ps` output
 * and shell history. Never echoed back, on success or failure: a missing
 * variable's error names the variable, not any value it might have held.
 */
function readCredential(options: Options): Credential {
  // qBittorrent's legacy login strategy: a username (given, not secret) and
  // a password (from the environment).
  if (options.implementation === 'qbittorrent' && options.username !== null) {
    const password = process.env[PASSWORD_ENV_VAR];
    if (password === undefined || password === '') {
      throw new Error(
        `--username was given, so ${PASSWORD_ENV_VAR} must be set in the environment to seed a login-strategy ` +
          'qbittorrent client',
      );
    }
    return { apiKey: null, password };
  }

  // SABnzbd always authenticates with an api key; qBittorrent without
  // --username uses its modern bearer strategy, which does too.
  const apiKey = process.env[API_KEY_ENV_VAR];
  if (apiKey === undefined || apiKey === '') {
    throw new Error(`${API_KEY_ENV_VAR} must be set in the environment to seed this client`);
  }
  return { apiKey, password: null };
}

/** The id of the `download_client` row already on file with this name, if any. */
function existingClientId(raw: DatabaseSync, name: string): number | undefined {
  const row = raw.prepare('SELECT id FROM download_client WHERE name = ?').get(name);
  if (row === undefined) return undefined;
  return Number((row as { id: unknown }).id);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const credential = readCredential(options);

  const { raw } = openDatabase(options.databasePath);
  migrateHost(raw);

  const existing = existingClientId(raw, options.name);
  if (existing !== undefined) {
    raw.close();
    throw new Error(
      `a download client named "${options.name}" already exists (id ${existing}) -- delete it first, or choose ` +
        'a different name, to reseed it',
    );
  }

  const now = Date.now();
  const result = raw.prepare(`
    INSERT INTO download_client
      (name, type, implementation, url, api_key, username, password, category, import_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.name,
    options.type,
    options.implementation,
    options.baseUrl,
    credential.apiKey,
    options.username,
    credential.password,
    options.category,
    options.importMode,
    now,
    now,
  );
  raw.close();

  // Never the credential: only the metadata a maintainer needs to confirm
  // which row was created.
  console.log(
    `seeded download_client id ${Number(result.lastInsertRowid)}: "${options.name}" (${options.baseUrl}), ` +
      `${options.implementation}/${options.type}, category "${options.category}", import mode ${options.importMode}`,
  );
}

main().catch((error: Error) => {
  console.error(`seed-client: ${error.message}`);
  process.exit(1);
});
