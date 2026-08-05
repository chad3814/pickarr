import { readFile } from 'node:fs/promises';
import type { JsonValue } from '../json.ts';
import { configSchema, type PickarrConfig } from './schema.ts';

const SECRET_PREFIX = 'file:';

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

export async function loadConfig(path: string): Promise<PickarrConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Could not read config file at ${path}`);
  }

  let json: JsonValue;
  try {
    json = JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new Error(`Config at ${path} is not valid JSON: ${(error as Error).message}`);
  }

  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Config at ${path} is invalid — ${detail}`);
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

  for (const client of config.downloadClients) {
    client.apiKey = await resolveSecret(client.apiKey, `downloadClients.${client.id}.apiKey`);
  }

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
