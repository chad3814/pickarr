import { SECRET_REFERENCE_PREFIX, type PickarrConfig } from './schema.ts';
import { asJsonArray, asJsonObject, type JsonObject, type JsonValue } from '../json.ts';

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
 * Deep-copies plugin settings, properly handling array values.
 *
 * This file is the single authority on `PluginSettingValue`, so a future
 * variant of that type must not be handled in one copy and missed in the other.
 */
function copyPluginSettings(
  plugins: Record<string, Record<string, PluginSettingValue>>,
): Record<string, Record<string, PluginSettingValue>> {
  return Object.fromEntries(
    Object.entries(plugins).map(([name, settings]) => [
      name,
      Object.fromEntries(
        Object.entries(settings).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
      ),
    ]),
  );
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
    plugins: copyPluginSettings(config.plugins),
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

export interface SubmittedDownloadClient {
  id: string;
  type: 'sabnzbd';
  url: string;
  apiKey: SecretEdit;
  category: string;
  importMode: 'move' | 'copy';
  pathMappings: EditablePathMapping[];
}

export interface SubmittedSiteLookup {
  type: 'theporndb';
  apiKey: SecretEdit;
  baseUrl: string;
}

export interface SubmittedConfig {
  server: { port: number };
  database: { path: string };
  trashDir: string;
  plugins: Record<string, Record<string, PluginSettingValue>>;
  downloadClients: SubmittedDownloadClient[];
  feeds: EditableFeed[];
  siteLookup: SubmittedSiteLookup | null;
  metadata: EditableMetadata;
}

/**
 * The literal a `SecretEdit` should be written to the file as, or an error
 * naming what could not be kept.
 *
 * `{ kind: 'keep' }` is resolved against the value already on disk, and a
 * missing one is refused rather than guessed. The alternative — falling back to
 * an empty string, or to the nearest entry — turns "I renamed a client" into
 * "my download client silently lost its api key", which surfaces later as 401s
 * that look like an outage.
 */
function editedSecret(edit: SecretEdit, existing: string | undefined, field: string): string | { error: string } {
  if (edit.kind === 'literal') return edit.value;
  if (edit.kind === 'file') return `${SECRET_REFERENCE_PREFIX}${edit.path}`;
  if (existing === undefined) {
    return {
      error: `${field}: asked to keep the existing api key, but there is none on disk to keep. Enter the key.`,
    };
  }
  return existing;
}

/**
 * Merges a patch of the fields this form knows about over a structured clone
 * of whatever object (if any) already sat at this key, so a key this form
 * does not model — a setting a newer Pickarr understands, a block someone
 * added by hand — survives *inside* that block, not only alongside it.
 * `existing` may be absent, or not even an object (a stray scalar or array
 * from hand-editing); either way there is nothing to preserve and the patch
 * stands alone.
 */
function mergeKnownFields(existing: JsonValue | undefined, patch: JsonObject): JsonObject {
  const base = asJsonObject(existing);
  return base === null ? patch : { ...structuredClone(base), ...patch };
}

/**
 * Folds a submission over the document that is currently on disk, returning a
 * new document to write.
 *
 * A structured copy of the *on-disk* object is mutated rather than a fresh
 * object being built, and that is the point: key order is preserved, and any key
 * this form does not model — a setting a newer Pickarr understands, a block
 * someone added by hand — survives the save instead of being silently dropped.
 * That guarantee is applied at every level `mergeKnownFields` touches
 * (`server`, `database`, `metadata`, each download client, each feed,
 * `siteLookup`), not just to keys sitting beside these blocks: an unknown key
 * *inside* one of them survives too, as long as the block itself is not
 * newly added (there is nothing on disk yet to merge a new one with) and, for
 * a download client or feed, its `id` did not change in this same submission
 * (a changed id has no existing entry to match, for the same reason `keep`
 * refuses one — see `editedSecret`). `plugins` is not merged this way: the
 * form already treats every one of a plugin's settings as something it
 * models, add/remove included, so there is no "unknown key" concept left
 * inside that block for a merge to preserve.
 */
export function applyEdits(
  document: JsonValue,
  submitted: SubmittedConfig,
): { document: JsonObject } | { error: string } {
  const existing = asJsonObject(document);
  if (existing === null) return { error: 'config.json does not hold a JSON object' };

  const next = structuredClone(existing);

  // Matched by id, which is what a `keep` refers to and what a merge merges
  // with. A client whose id changed in the same submission has no entry
  // here, and `editedSecret` refuses it.
  const existingClientsById = new Map<string, JsonObject>();
  for (const entry of asJsonArray(existing['downloadClients'])) {
    const client = asJsonObject(entry);
    const id = client?.['id'];
    if (client !== null && typeof id === 'string') existingClientsById.set(id, client);
  }

  const existingFeedsById = new Map<string, JsonObject>();
  for (const entry of asJsonArray(existing['feeds'])) {
    const feed = asJsonObject(entry);
    const id = feed?.['id'];
    if (feed !== null && typeof id === 'string') existingFeedsById.set(id, feed);
  }

  const clients: JsonValue[] = [];
  for (const client of submitted.downloadClients) {
    const existingClient = existingClientsById.get(client.id);
    const previousApiKey = existingClient?.['apiKey'];
    const apiKey = editedSecret(
      client.apiKey,
      typeof previousApiKey === 'string' ? previousApiKey : undefined,
      `downloadClients.${client.id}.apiKey`,
    );
    if (typeof apiKey !== 'string') return apiKey;
    clients.push(
      mergeKnownFields(existingClient, {
        id: client.id,
        type: client.type,
        url: client.url,
        apiKey,
        category: client.category,
        importMode: client.importMode,
        pathMappings: client.pathMappings.map((mapping) => ({ from: mapping.from, to: mapping.to })),
      }),
    );
  }

  next['server'] = mergeKnownFields(existing['server'], { port: submitted.server.port });
  next['database'] = mergeKnownFields(existing['database'], { path: submitted.database.path });
  next['trashDir'] = submitted.trashDir;
  next['plugins'] = copyPluginSettings(submitted.plugins);
  next['downloadClients'] = clients;
  next['feeds'] = submitted.feeds.map((feed) =>
    mergeKnownFields(existingFeedsById.get(feed.id), {
      id: feed.id,
      url: feed.url,
      plugin: feed.plugin,
      intervalSeconds: feed.intervalSeconds,
    }),
  );

  // Absence is expressed by deleting the key, never by writing `null` or `''`:
  // `metadataSchema.artworkDir` is `.min(1).optional()`, so an empty string is a
  // validation failure rather than a way of saying "use the default". Deleted
  // after the merge, not omitted from the patch, because omitting it from the
  // patch would let the merge resurrect whatever `artworkDir` the on-disk
  // block already had.
  const metadataPatch: JsonObject = {
    enabled: submitted.metadata.enabled,
    intervalSeconds: submitted.metadata.intervalSeconds,
    perTick: submitted.metadata.perTick,
  };
  if (submitted.metadata.artworkDir !== null) metadataPatch['artworkDir'] = submitted.metadata.artworkDir;
  const metadata = mergeKnownFields(existing['metadata'], metadataPatch);
  if (submitted.metadata.artworkDir === null) delete metadata['artworkDir'];
  next['metadata'] = metadata;

  if (submitted.siteLookup === null) {
    delete next['siteLookup'];
  } else {
    const existingSiteLookup = asJsonObject(existing['siteLookup']);
    const previous = existingSiteLookup?.['apiKey'];
    const apiKey = editedSecret(
      submitted.siteLookup.apiKey,
      typeof previous === 'string' ? previous : undefined,
      'siteLookup.apiKey',
    );
    if (typeof apiKey !== 'string') return apiKey;
    next['siteLookup'] = mergeKnownFields(existingSiteLookup, {
      type: submitted.siteLookup.type,
      apiKey,
      baseUrl: submitted.siteLookup.baseUrl,
    });
  }

  return { document: next };
}
