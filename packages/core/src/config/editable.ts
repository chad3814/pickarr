import { SECRET_REFERENCE_PREFIX, type PickarrConfig } from './schema.ts';

/**
 * What the browser is allowed to know about a secret-bearing field.
 *
 * A discriminated union rather than a redaction sentinel like `'********'`,
 * because a sentinel is a string a real config value could also hold — and the
 * day it does, "unchanged" and "set it to this" become the same request. There
 * is no value of `SecretEdit['kind']` a user can type into a text field.
 */
export type SecretView = { kind: 'file'; path: string } | { kind: 'set' };

/** What the browser may say about a secret-bearing field on the way back. */
export type SecretEdit =
  | { kind: 'keep' }
  | { kind: 'file'; path: string }
  | { kind: 'literal'; value: string };

export interface EditablePathMapping {
  from: string;
  to: string;
}

export interface EditableDownloadClient {
  id: string;
  type: 'sabnzbd';
  url: string;
  apiKey: SecretView;
  category: string;
  importMode: 'move' | 'copy';
  pathMappings: EditablePathMapping[];
}

export interface EditableFeed {
  id: string;
  url: string;
  plugin: string;
  intervalSeconds: number;
}

export interface EditableSiteLookup {
  type: 'theporndb';
  apiKey: SecretView;
  baseUrl: string;
}

/** `artworkDir` is `null` for absent, never `''` — see `applyEdits`. */
export interface EditableMetadata {
  enabled: boolean;
  intervalSeconds: number;
  perTick: number;
  artworkDir: string | null;
}

/** The four value types `configSchema`'s `plugins` record permits. */
export type PluginSettingValue = string | number | boolean | string[];

export interface EditableConfig {
  server: { port: number };
  database: { path: string };
  trashDir: string;
  plugins: Record<string, Record<string, PluginSettingValue>>;
  downloadClients: EditableDownloadClient[];
  feeds: EditableFeed[];
  /** `null` for absent, so the form can offer to add one. */
  siteLookup: EditableSiteLookup | null;
  metadata: EditableMetadata;
}

/**
 * A `file:` path is not a secret and being able to see and correct it is most of
 * the value of showing the field; a literal key is a secret and its bytes never
 * leave the process. This is the only function that decides which is which.
 */
function viewSecret(value: string): SecretView {
  return value.startsWith(SECRET_REFERENCE_PREFIX)
    ? { kind: 'file', path: value.slice(SECRET_REFERENCE_PREFIX.length) }
    : { kind: 'set' };
}

/**
 * Projects a *parsed* config — so the form shows effective values, defaults
 * included — into the shape `GET /api/config` returns.
 *
 * Must be given the config from `parseConfig`, never one that has been through
 * `resolveSecrets`: after resolution a `file:` reference has already become the
 * key it points at, and this function would project it as `{ kind: 'set' }`,
 * silently losing the path the user needs to see.
 */
export function toEditableConfig(config: PickarrConfig): EditableConfig {
  return {
    server: { port: config.server.port },
    database: { path: config.database.path },
    trashDir: config.trashDir,
    plugins: Object.fromEntries(
      Object.entries(config.plugins).map(([name, settings]) => [name, { ...settings }]),
    ),
    downloadClients: config.downloadClients.map((client) => ({
      id: client.id,
      type: client.type,
      url: client.url,
      apiKey: viewSecret(client.apiKey),
      category: client.category,
      importMode: client.importMode,
      pathMappings: client.pathMappings.map((mapping) => ({ from: mapping.from, to: mapping.to })),
    })),
    feeds: config.feeds.map((feed) => ({
      id: feed.id,
      url: feed.url,
      plugin: feed.plugin,
      intervalSeconds: feed.intervalSeconds,
    })),
    siteLookup:
      config.siteLookup === undefined
        ? null
        : {
            type: config.siteLookup.type,
            apiKey: viewSecret(config.siteLookup.apiKey),
            baseUrl: config.siteLookup.baseUrl,
          },
    metadata: {
      enabled: config.metadata.enabled,
      intervalSeconds: config.metadata.intervalSeconds,
      perTick: config.metadata.perTick,
      artworkDir: config.metadata.artworkDir ?? null,
    },
  };
}
