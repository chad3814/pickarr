import { readFile } from 'node:fs/promises';
import type { JsonValue } from '../json.ts';
import {
  configSchema,
  MIN_API_KEY_LENGTH,
  SECRET_REFERENCE_PREFIX as SECRET_PREFIX,
  type PickarrConfig,
} from './schema.ts';

/**
 * Resolves a `file:` indirection to the contents of that file, so secrets can
 * be supplied as Docker Compose secrets rather than environment variables.
 * The trailing newline is trimmed because compose secrets almost always have
 * one. The value is never logged.
 */
async function resolveSecret(value: string, field: string): Promise<string> {
  if (!value.startsWith(SECRET_PREFIX)) return value;
  const path = value.slice(SECRET_PREFIX.length);
  try {
    const contents = await readFile(path, 'utf8');
    return contents.replace(/\r?\n$/, '');
  } catch {
    throw new Error(`Could not read secret for ${field} from ${path}`);
  }
}

/**
 * The config file as a JSON document, with no schema or cross-field checks
 * applied yet.
 *
 * Exported so `GET`/`PUT /api/config` can read the same file `loadConfig`
 * would, and get the same two messages for the same two failures — an
 * unreadable file and invalid JSON — that `loadConfig` has always produced.
 * The Settings screen shows these verbatim, and a second, HTTP-layer copy of
 * this read-then-parse logic is exactly how the two would drift.
 */
export async function readConfigDocument(path: string): Promise<JsonValue> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Could not read config file at ${path}`);
  }
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new Error(`Config at ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Schema and cross-field validation, with no filesystem access at all.
 *
 * Separate from `loadConfig` because `PUT /api/config` has to apply exactly
 * these checks to a document it has not written yet. Two copies of this list
 * would be free to drift, and the one that drifted would be the one guarding
 * the file a Restart button then boots from.
 */
export function parseConfig(json: JsonValue, source: string): PickarrConfig {
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Config at ${source} is invalid — ${detail}`);
  }

  const config = parsed.data;

  const feedIds = new Set<string>();
  for (const feed of config.feeds) {
    if (feedIds.has(feed.id)) throw new Error(`Duplicate feed id: ${feed.id}`);
    feedIds.add(feed.id);
  }

  const clientIds = new Set<string>();
  for (const client of config.downloadClients) {
    if (clientIds.has(client.id)) throw new Error(`Duplicate download client id: ${client.id}`);
    clientIds.add(client.id);
  }

  for (const feed of config.feeds) {
    if (config.plugins[feed.plugin] === undefined) {
      throw new Error(`Feed ${feed.id} references plugin ${feed.plugin}, which is not configured`);
    }
  }

  return config;
}

/**
 * Resolves every `file:` reference in place and re-applies the length rules the
 * schema could not, because the schema saw a path rather than the key behind it.
 *
 * Callable on its own so that a save can *rehearse* it and throw the result
 * away: a config that parses but whose secret file is missing or empty fails at
 * boot, and boot is now something a button in the UI triggers.
 */
export async function resolveSecrets(config: PickarrConfig): Promise<void> {
  for (const client of config.downloadClients) {
    const field = `downloadClients.${client.id}.apiKey`;
    client.apiKey = await resolveSecret(client.apiKey, field);
    // The schema's length rule saw a `file:` path, not the key behind it, so
    // this is the check that actually binds the value the client is handed.
    // The message states the rule and never the value.
    if (client.apiKey.length < MIN_API_KEY_LENGTH) {
      throw new Error(
        `${field} resolves to fewer than ${MIN_API_KEY_LENGTH} characters; SABnzbd api keys are 32 hex characters`,
      );
    }
  }

  if (config.siteLookup !== undefined) {
    const field = 'siteLookup.apiKey';
    config.siteLookup.apiKey = await resolveSecret(config.siteLookup.apiKey, field);
    // As with the download clients, the schema's rule saw the `file:` path
    // rather than the key behind it, so an empty secret file would otherwise
    // reach the client and produce 401s that look like an outage. The message
    // states the rule and never the value.
    if (config.siteLookup.apiKey.length === 0) {
      throw new Error(`${field} resolves to an empty value`);
    }
  }
}

export async function loadConfig(path: string): Promise<PickarrConfig> {
  const json = await readConfigDocument(path);
  const config = parseConfig(json, path);
  await resolveSecrets(config);

  const portOverride = process.env['PICKARR_PORT'];
  if (portOverride !== undefined) {
    const port = Number.parseInt(portOverride, 10);
    if (Number.isNaN(port) || port <= 0) {
      throw new Error(`PICKARR_PORT is not a valid port: ${portOverride}`);
    }
    config.server.port = port;
  }

  return config;
}
