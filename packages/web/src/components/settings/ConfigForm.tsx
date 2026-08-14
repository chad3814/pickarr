import { useId } from 'react';
import { DownloadClientFields } from './DownloadClientFields.tsx';
import { FeedFields } from './FeedFields.tsx';
import { fromLines, PluginFields, toLines, type PluginSettingDraftValue } from './PluginFields.tsx';
import { SecretField } from './SecretField.tsx';
import type {
  EditableConfig,
  EditableFeed,
  EditablePathMapping,
  PluginSettingValue,
  SecretEdit,
  SecretView,
  SubmittedConfig,
  SubmittedDownloadClient,
  SubmittedSiteLookup,
} from '../../api/client.ts';

/** The form's working copy: every numeric field is text while being typed. */
export interface ConfigDraft {
  port: string;
  databasePath: string;
  trashDir: string;
  metadata: { enabled: boolean; intervalSeconds: string; perTick: string; artworkDir: string };
  siteLookup: { present: boolean; apiKey: SecretEdit; baseUrl: string };
  downloadClients: ClientDraft[];
  feeds: FeedDraft[];
  plugins: PluginDraft[];
}

export interface ClientDraft {
  id: string;
  url: string;
  apiKey: SecretEdit;
  category: string;
  importMode: 'move' | 'copy';
  pathMappings: EditablePathMapping[];
}

export interface FeedDraft {
  id: string;
  url: string;
  plugin: string;
  intervalSeconds: string;
}

export interface PluginDraft {
  name: string;
  settings: { key: string; value: PluginSettingDraftValue }[];
}

/** `''` means "leave it out of the file"; see `metadata.artworkDir` in the spec. */
export function toDraft(config: EditableConfig): ConfigDraft {
  return {
    port: String(config.server.port),
    databasePath: config.database.path,
    trashDir: config.trashDir,
    metadata: {
      enabled: config.metadata.enabled,
      intervalSeconds: String(config.metadata.intervalSeconds),
      perTick: String(config.metadata.perTick),
      artworkDir: config.metadata.artworkDir ?? '',
    },
    siteLookup:
      config.siteLookup === null
        ? { present: false, apiKey: { kind: 'literal', value: '' }, baseUrl: 'https://api.theporndb.net' }
        : {
            present: true,
            apiKey: keepOrPath(config.siteLookup.apiKey),
            baseUrl: config.siteLookup.baseUrl,
          },
    downloadClients: config.downloadClients.map((client) => ({
      id: client.id,
      url: client.url,
      apiKey: keepOrPath(client.apiKey),
      category: client.category,
      importMode: client.importMode,
      pathMappings: client.pathMappings.map((mapping) => ({ ...mapping })),
    })),
    feeds: config.feeds.map((feed) => ({
      id: feed.id,
      url: feed.url,
      plugin: feed.plugin,
      intervalSeconds: String(feed.intervalSeconds),
    })),
    plugins: Object.entries(config.plugins).map(([name, settings]) => ({
      name,
      settings: Object.entries(settings).map(([key, value]) => ({
        key,
        // A list becomes raw text (`toLines`) and a number becomes raw text
        // of itself; see `PluginSettingDraftValue`'s doc comment in
        // `PluginFields.tsx` for why the draft cannot hold either as its
        // real type while the control for it is being typed into.
        value: Array.isArray(value)
          ? { list: toLines(value) }
          : typeof value === 'number'
            ? { number: String(value) }
            : value,
      })),
    })),
  };
}

/**
 * The starting edit for a field the server described. A `file:` path is
 * editable text and starts as itself; a literal key was never sent, so the only
 * honest starting point is "keep whatever is on disk".
 */
function keepOrPath(view: SecretView): SecretEdit {
  return view.kind === 'file' ? { kind: 'file', path: view.path } : { kind: 'keep' };
}

/** A positive integer, or the field name that failed, so the form can say which. */
function asCount(raw: string, field: string): number | { error: string } {
  if (!/^\d+$/.test(raw.trim())) return { error: `${field} must be a whole number` };
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : { error: `${field} must be a whole number` };
}

/**
 * The conversion `PluginSettingDraftValue`'s doc comment promises: a list's
 * raw text is split back into an array (dropping blank lines, exactly as
 * `configSchema` requires), a number's raw text is parsed, and text/boolean
 * pass through unchanged since nothing converted them away from their real
 * type in the first place.
 */
function fromDraftValue(value: PluginSettingDraftValue): PluginSettingValue {
  if (typeof value !== 'object') return value;
  return 'list' in value ? fromLines(value.list) : Number(value.number);
}

/**
 * Converts the draft into what `PUT /api/config` expects, or the first
 * validation error the draft contains.
 *
 * `config` supplies the `type` literals (`'sabnzbd'`, `'theporndb'`), which the
 * draft never carries, and is matched by id since that is what a `keep`
 * secret edit resolves against on the server.
 */
export function toSubmission(draft: ConfigDraft, config: EditableConfig): SubmittedConfig | { error: string } {
  const port = asCount(draft.port, 'server.port');
  if (typeof port !== 'number') return port;

  const metadataIntervalSeconds = asCount(draft.metadata.intervalSeconds, 'metadata.intervalSeconds');
  if (typeof metadataIntervalSeconds !== 'number') return metadataIntervalSeconds;

  const metadataPerTick = asCount(draft.metadata.perTick, 'metadata.perTick');
  if (typeof metadataPerTick !== 'number') return metadataPerTick;

  const feeds: EditableFeed[] = [];
  for (const [index, feed] of draft.feeds.entries()) {
    const intervalSeconds = asCount(feed.intervalSeconds, `feeds[${index}].intervalSeconds`);
    if (typeof intervalSeconds !== 'number') return intervalSeconds;
    feeds.push({ id: feed.id, url: feed.url, plugin: feed.plugin, intervalSeconds });
  }

  const downloadClients: SubmittedDownloadClient[] = draft.downloadClients.map((client) => {
    const original = config.downloadClients.find((entry) => entry.id === client.id);
    return {
      id: client.id,
      type: original?.type ?? 'sabnzbd',
      url: client.url,
      apiKey: client.apiKey,
      category: client.category,
      importMode: client.importMode,
      pathMappings: client.pathMappings.map((mapping) => ({ ...mapping })),
    };
  });

  const plugins: Record<string, Record<string, PluginSettingValue>> = {};
  for (const plugin of draft.plugins) {
    const settings: Record<string, PluginSettingValue> = {};
    for (const entry of plugin.settings) settings[entry.key] = fromDraftValue(entry.value);
    plugins[plugin.name] = settings;
  }

  const siteLookup: SubmittedSiteLookup | null = draft.siteLookup.present
    ? {
        type: config.siteLookup?.type ?? 'theporndb',
        apiKey: draft.siteLookup.apiKey,
        baseUrl: draft.siteLookup.baseUrl,
      }
    : null;

  return {
    server: { port },
    database: { path: draft.databasePath },
    trashDir: draft.trashDir,
    plugins,
    downloadClients,
    feeds,
    siteLookup,
    metadata: {
      enabled: draft.metadata.enabled,
      intervalSeconds: metadataIntervalSeconds,
      perTick: metadataPerTick,
      artworkDir: draft.metadata.artworkDir === '' ? null : draft.metadata.artworkDir,
    },
  };
}

export interface ConfigFormProps {
  config: EditableConfig;
  draft: ConfigDraft;
  /** What `PICKARR_PORT` pins the running process to, or `null` if it is unset. */
  portOverride: number | null;
  onChange(next: ConfigDraft): void;
}

/**
 * The scalar half of the settings form: server, database, trash directory,
 * metadata, and site lookup. `DownloadClientFields`, `FeedFields` and
 * `PluginFields` render below this, over the same draft.
 */
export function ConfigForm({ config, draft, portOverride, onChange }: ConfigFormProps) {
  const formId = useId();

  // Nothing on disk to keep for a site lookup that does not exist yet: `view`
  // must not be `{ kind: 'set' }`, or `SecretField` would offer a "Keep
  // existing" button whose `keep` the server would refuse with a 400.
  const siteLookupView: SecretView = config.siteLookup === null ? { kind: 'file', path: '' } : config.siteLookup.apiKey;

  return (
    <div className="config-form">
      <fieldset>
        <legend>Server</legend>
        <div className="manual-field">
          <label htmlFor={`${formId}-port`}>Port</label>
          <input
            id={`${formId}-port`}
            type="text"
            value={draft.port}
            onChange={(event) => onChange({ ...draft, port: event.target.value })}
          />
        </div>
        {portOverride !== null && (
          <span className="manual-help">
            PICKARR_PORT is overriding this at runtime; this process is listening on {portOverride}.
          </span>
        )}
      </fieldset>

      <fieldset>
        <legend>Storage</legend>
        <div className="manual-field">
          <label htmlFor={`${formId}-database-path`}>Database path</label>
          <input
            id={`${formId}-database-path`}
            type="text"
            value={draft.databasePath}
            onChange={(event) => onChange({ ...draft, databasePath: event.target.value })}
          />
        </div>
        <div className="manual-field">
          <label htmlFor={`${formId}-trash-dir`}>Trash directory</label>
          <input
            id={`${formId}-trash-dir`}
            type="text"
            value={draft.trashDir}
            onChange={(event) => onChange({ ...draft, trashDir: event.target.value })}
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Metadata</legend>
        <div className="manual-field">
          <label htmlFor={`${formId}-metadata-enabled`}>Enabled</label>
          <input
            id={`${formId}-metadata-enabled`}
            type="checkbox"
            checked={draft.metadata.enabled}
            onChange={(event) =>
              onChange({ ...draft, metadata: { ...draft.metadata, enabled: event.target.checked } })
            }
          />
        </div>
        <div className="manual-field">
          <label htmlFor={`${formId}-metadata-interval`}>Check interval (seconds)</label>
          <input
            id={`${formId}-metadata-interval`}
            type="text"
            value={draft.metadata.intervalSeconds}
            onChange={(event) =>
              onChange({ ...draft, metadata: { ...draft.metadata, intervalSeconds: event.target.value } })
            }
          />
        </div>
        <div className="manual-field">
          <label htmlFor={`${formId}-metadata-per-tick`}>Groups per tick</label>
          <input
            id={`${formId}-metadata-per-tick`}
            type="text"
            value={draft.metadata.perTick}
            onChange={(event) =>
              onChange({ ...draft, metadata: { ...draft.metadata, perTick: event.target.value } })
            }
          />
        </div>
        <div className="manual-field">
          <label htmlFor={`${formId}-metadata-artwork-dir`}>Artwork directory</label>
          <input
            id={`${formId}-metadata-artwork-dir`}
            type="text"
            placeholder="artwork/ beside the database"
            value={draft.metadata.artworkDir}
            onChange={(event) =>
              onChange({ ...draft, metadata: { ...draft.metadata, artworkDir: event.target.value } })
            }
          />
        </div>
      </fieldset>

      <fieldset>
        <legend>Site lookup</legend>
        <div className="manual-field">
          <label htmlFor={`${formId}-site-lookup-present`}>Enable site lookup</label>
          <input
            id={`${formId}-site-lookup-present`}
            type="checkbox"
            checked={draft.siteLookup.present}
            onChange={(event) =>
              onChange({ ...draft, siteLookup: { ...draft.siteLookup, present: event.target.checked } })
            }
          />
        </div>
        {draft.siteLookup.present && (
          <>
            <SecretField
              label="Site lookup API key"
              view={siteLookupView}
              value={draft.siteLookup.apiKey}
              onChange={(next) => onChange({ ...draft, siteLookup: { ...draft.siteLookup, apiKey: next } })}
            />
            <div className="manual-field">
              <label htmlFor={`${formId}-site-lookup-base-url`}>Base URL</label>
              <input
                id={`${formId}-site-lookup-base-url`}
                type="text"
                value={draft.siteLookup.baseUrl}
                onChange={(event) =>
                  onChange({ ...draft, siteLookup: { ...draft.siteLookup, baseUrl: event.target.value } })
                }
              />
            </div>
          </>
        )}
      </fieldset>

      <DownloadClientFields
        clients={draft.downloadClients}
        onDisk={config.downloadClients}
        onChange={(downloadClients) => onChange({ ...draft, downloadClients })}
      />
      <FeedFields
        feeds={draft.feeds}
        pluginNames={draft.plugins.map((plugin) => plugin.name)}
        onChange={(feeds) => onChange({ ...draft, feeds })}
      />
      <PluginFields plugins={draft.plugins} onChange={(plugins) => onChange({ ...draft, plugins })} />
    </div>
  );
}
