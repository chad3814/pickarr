import { SECRET_REFERENCE_PREFIX, type DownloadClientConfig, type PickarrConfig } from './schema.ts';
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

/** Everything a download client carries whatever its type, and nothing else. */
interface EditableClientCommon {
  id: string;
  url: string;
  category: string;
  importMode: 'move' | 'copy';
  pathMappings: EditablePathMapping[];
}

export interface EditableSabnzbdClient extends EditableClientCommon {
  type: 'sabnzbd';
  /** Required, because `sabnzbdClientSchema` has no other way to authenticate. */
  apiKey: SecretView;
}

export interface EditableQbittorrentClient extends EditableClientCommon {
  type: 'qbittorrent';
  /**
   * `null` for absent rather than a missing key, the way `siteLookup` and
   * `artworkDir` say absent: exactly one of `apiKey`, or `username` and
   * `password` together, is configured, and the form has to render both
   * possibilities from one shape. `applyEdits` turns the `null` back into a
   * *deleted* key, because `qbittorrentClientSchema` marks these `.optional()`
   * and would refuse a literal null.
   */
  apiKey: SecretView | null;
  /**
   * In the clear, unlike the two beside it, and that is a decision rather than
   * an oversight.
   *
   * `SecretView`/`SecretEdit` is not a redaction mechanism in the abstract — it
   * is the browser-facing half of the `file:` indirection, and `resolveSecrets`
   * (config/load.ts) resolves a qBittorrent client's `apiKey` and `password`
   * and deliberately not its `username`. Projecting a username as a `SecretView`
   * would therefore report a username that genuinely begins `file:` as a path
   * to a file, and would let the form write a `file:` reference back that
   * nothing ever resolves — qBittorrent would be handed the literal string
   * `file:/run/secrets/...` as a login and answer 403.
   *
   * That it is also not confidential (qBittorrent's default is `admin`, and a
   * login is only as good as the password half) is the lesser argument; the
   * `file:` asymmetry is the one that would be a bug.
   */
  username: string | null;
  password: SecretView | null;
}

export type EditableDownloadClient = EditableSabnzbdClient | EditableQbittorrentClient;

/**
 * A feed's backfill settings as the form holds them, with `null` for "not
 * backfilling" rather than an object carrying a disabled flag — the same way
 * `siteLookup` and `artworkDir` express absence.
 */
export interface EditableFeedBackfill {
  style: 'newznab' | 'page';
  pageSize: number;
  pagesPerPass: number;
  maxPages: number;
}

export interface EditableFeed {
  id: string;
  url: string;
  plugin: string;
  intervalSeconds: number;
  /**
   * Which download client this feed's picks go to, always the *effective* one
   * — `toEditableConfig` resolves an absent value to `downloadClients[0].id`
   * rather than passing a blank through. A blank would read as "the first
   * one", which is a meaning the form has nowhere to display and which
   * `feedSchema`'s `.min(1)` would refuse the moment it was saved back.
   *
   * Modelled for exactly the reason `backfill` below is, and it is not
   * optional polish: an unmodelled field does not survive a rename, so
   * shipping `feeds[].downloadClient` without this would let an ordinary
   * Settings save silently send a feed's picks back to the first client.
   */
  downloadClient: string;
  /**
   * Modelled here rather than left as an unknown key the merge preserves, and
   * that is the whole point of modelling it: `applyEdits` matches feeds by id,
   * so a block it does not know about cannot survive a rename. Carrying it
   * through the form means a renamed feed keeps its walk position instead of
   * silently starting over.
   */
  backfill: EditableFeedBackfill | null;
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
 * Projects one configured client into the member of the editable union that
 * matches its type.
 *
 * A `switch` with a `never` default rather than a chain of `if`s, for the same
 * reason `resolveSecrets` and the client construction in `main.ts` are: a third
 * client type that fell through here would be projected as nothing at all, and
 * `applyEdits` rebuilds the list from what the form submits — so the first sign
 * of the omission would be the client having been deleted from `config.json`
 * by an unrelated save.
 */
function toEditableClient(client: DownloadClientConfig): EditableDownloadClient {
  const common: EditableClientCommon = {
    id: client.id,
    url: client.url,
    category: client.category,
    importMode: client.importMode,
    pathMappings: client.pathMappings.map((mapping) => ({ from: mapping.from, to: mapping.to })),
  };
  switch (client.type) {
    case 'sabnzbd':
      return { ...common, type: 'sabnzbd', apiKey: viewSecret(client.apiKey) };
    case 'qbittorrent':
      return {
        ...common,
        type: 'qbittorrent',
        apiKey: client.apiKey === undefined ? null : viewSecret(client.apiKey),
        username: client.username ?? null,
        password: client.password === undefined ? null : viewSecret(client.password),
      };
    default: {
      const unhandled: never = client;
      // The discriminant alone, never the object, for the reason spelled out
      // at the same arm in `resolveSecrets`: an unhandled client config holds
      // an apiKey or a password, and serialising it would print one into an
      // error message.
      const { type } = unhandled as { type: string };
      throw new Error(`Unhandled download client type: ${type}`);
    }
  }
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
  // What a feed naming no client actually resolves to at boot, resolved here
  // too so the form shows it rather than a blank. `configSchema` puts
  // `.min(1)` on `downloadClients`, so the `''` branch is unreachable for a
  // config that parsed; it exists because the index signature cannot say so.
  const defaultClientId = config.downloadClients[0]?.id ?? '';
  return {
    server: { port: config.server.port },
    database: { path: config.database.path },
    trashDir: config.trashDir,
    plugins: copyPluginSettings(config.plugins),
    downloadClients: config.downloadClients.map(toEditableClient),
    feeds: config.feeds.map((feed) => ({
      id: feed.id,
      url: feed.url,
      plugin: feed.plugin,
      intervalSeconds: feed.intervalSeconds,
      downloadClient: feed.downloadClient ?? defaultClientId,
      // Spread into a fresh object rather than passed through, so the editable
      // view never aliases the parsed config the caller still holds.
      backfill: feed.backfill === undefined ? null : { ...feed.backfill },
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

/** The way back, member for member with `EditableDownloadClient` above. */
interface SubmittedClientCommon {
  id: string;
  url: string;
  category: string;
  importMode: 'move' | 'copy';
  pathMappings: EditablePathMapping[];
}

export interface SubmittedSabnzbdClient extends SubmittedClientCommon {
  type: 'sabnzbd';
  apiKey: SecretEdit;
}

export interface SubmittedQbittorrentClient extends SubmittedClientCommon {
  type: 'qbittorrent';
  /**
   * `null` says "this client does not use this credential", and it has to be
   * sayable: switching a client from a login to an api key is a save that must
   * *remove* the username and password, not merely stop mentioning them. A
   * patch that only ever added keys would leave all three on disk and
   * `parseConfig`'s exactly-one rule would refuse the file the save just wrote.
   */
  apiKey: SecretEdit | null;
  /** Plain text on the way back too — see `EditableQbittorrentClient.username`. */
  username: string | null;
  password: SecretEdit | null;
}

export type SubmittedDownloadClient = SubmittedSabnzbdClient | SubmittedQbittorrentClient;

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
 *
 * `noun` is what to call the value in that refusal. `field` is the machine path,
 * which says *where* but not *what*, and a qBittorrent password refused with
 * "enter the key" sends the user to a control that client does not even have.
 */
function editedSecret(
  edit: SecretEdit,
  existing: string | undefined,
  field: string,
  noun: string,
): string | { error: string } {
  if (edit.kind === 'literal') return edit.value;
  if (edit.kind === 'file') return `${SECRET_REFERENCE_PREFIX}${edit.path}`;
  if (existing === undefined) {
    return {
      error: `${field}: asked to keep the existing ${noun}, but there is none on disk to keep. Enter the ${noun}.`,
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

/** The previous value of a secret-bearing key, for `editedSecret` to keep. */
function previousSecret(existing: JsonObject | undefined, key: string): string | undefined {
  const value = existing?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Folds one submitted client over its on-disk entry, or names what could not be
 * kept.
 *
 * Both members go through `mergeKnownFields`, which is what lets a key neither
 * the schema nor the form models survive inside a client — and which the
 * qBittorrent member would silently not have if it were built as a fresh
 * object beside the SABnzbd one.
 *
 * The patch is assembled in the schema's own field order, credentials in the
 * middle, so a *newly added* client is written out reading the way a
 * hand-written one does. An existing client's key order is already preserved by
 * the merge, whatever order the patch is in.
 */
function applyClientEdits(
  client: SubmittedDownloadClient,
  existing: JsonObject | undefined,
): { client: JsonObject } | { error: string } {
  const identity: JsonObject = { id: client.id, type: client.type, url: client.url };
  const settings: JsonObject = {
    category: client.category,
    importMode: client.importMode,
    pathMappings: client.pathMappings.map((mapping) => ({ from: mapping.from, to: mapping.to })),
  };

  switch (client.type) {
    case 'sabnzbd': {
      const apiKey = editedSecret(
        client.apiKey,
        previousSecret(existing, 'apiKey'),
        `downloadClients.${client.id}.apiKey`,
        'api key',
      );
      if (typeof apiKey !== 'string') return apiKey;
      return { client: mergeKnownFields(existing, { ...identity, apiKey, ...settings }) };
    }
    case 'qbittorrent': {
      const patch: JsonObject = { ...identity };
      if (client.apiKey !== null) {
        const apiKey = editedSecret(
          client.apiKey,
          previousSecret(existing, 'apiKey'),
          `downloadClients.${client.id}.apiKey`,
          'api key',
        );
        if (typeof apiKey !== 'string') return apiKey;
        patch['apiKey'] = apiKey;
      }
      // Not a secret, so it is carried as itself rather than resolved — see
      // `EditableQbittorrentClient.username` for why that asymmetry is right.
      if (client.username !== null) patch['username'] = client.username;
      if (client.password !== null) {
        const password = editedSecret(
          client.password,
          previousSecret(existing, 'password'),
          `downloadClients.${client.id}.password`,
          'password',
        );
        if (typeof password !== 'string') return password;
        patch['password'] = password;
      }
      Object.assign(patch, settings);

      const merged = mergeKnownFields(existing, patch);
      // The `artworkDir` rule, applied to a credential: absence is a *deleted*
      // key, both because `qbittorrentClientSchema` marks these `.optional()`
      // and would refuse a null, and because deleting after the merge rather
      // than omitting from the patch is the only way the merge cannot resurrect
      // what the submission removed. Without this, swapping a login for an api
      // key would leave all three on disk and `parseConfig`'s exactly-one rule
      // would refuse the file this save just wrote.
      if (client.apiKey === null) delete merged['apiKey'];
      if (client.username === null) delete merged['username'];
      if (client.password === null) delete merged['password'];
      return { client: merged };
    }
    default: {
      const unhandled: never = client;
      // The discriminant alone, never the object: it holds an api key or a
      // password, and serialising it would print one into an error message.
      const { type } = unhandled as { type: string };
      throw new Error(`Unhandled download client type: ${type}`);
    }
  }
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
    const merged = applyClientEdits(client, existingClient);
    if ('error' in merged) return merged;
    clients.push(merged.client);
  }

  next['server'] = mergeKnownFields(existing['server'], { port: submitted.server.port });
  next['database'] = mergeKnownFields(existing['database'], { path: submitted.database.path });
  next['trashDir'] = submitted.trashDir;
  next['plugins'] = copyPluginSettings(submitted.plugins);
  next['downloadClients'] = clients;
  // Absence deletes the key after the merge rather than being omitted from the
  // patch, for the reason spelled out for `artworkDir` below: omitting it would
  // let the merge resurrect whatever `backfill` block the file already had, so
  // turning backfill off in the form would not turn it off on disk.
  next['feeds'] = submitted.feeds.map((feed) => {
    const patch: JsonObject = {
      id: feed.id,
      url: feed.url,
      plugin: feed.plugin,
      intervalSeconds: feed.intervalSeconds,
    };
    // Written explicitly, including for a feed that had no `downloadClient` on
    // disk: the form showed the effective client, so saving it is saving what
    // the user was looking at. The empty case is the `''` `toEditableConfig`
    // cannot rule out by type, and it is deleted rather than written, because
    // `feedSchema` is `.min(1)` and an empty string would fail the very
    // `parseConfig` this document is about to be handed to.
    if (feed.downloadClient !== '') patch['downloadClient'] = feed.downloadClient;
    if (feed.backfill !== null) patch['backfill'] = { ...feed.backfill };
    const merged = mergeKnownFields(existingFeedsById.get(feed.id), patch);
    if (feed.downloadClient === '') delete merged['downloadClient'];
    if (feed.backfill === null) delete merged['backfill'];
    return merged;
  });

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
      'api key',
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
