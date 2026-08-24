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

export interface ClientDraftCommon {
  id: string;
  url: string;
  category: string;
  importMode: 'move' | 'copy';
  pathMappings: EditablePathMapping[];
}

export interface SabnzbdClientDraft extends ClientDraftCommon {
  type: 'sabnzbd';
  apiKey: SecretEdit;
}

export interface QbittorrentClientDraft extends ClientDraftCommon {
  type: 'qbittorrent';
  /** `null` for "this client does not use this credential" — mirrors `EditableQbittorrentClient`. */
  apiKey: SecretEdit | null;
  /** Plain text, not a `SecretEdit` — see `EditableQbittorrentClient.username`. */
  username: string | null;
  password: SecretEdit | null;
}

/**
 * The form's working copy of one download client. A discriminated union,
 * member for member with `EditableDownloadClient`/`SubmittedDownloadClient`,
 * so `type` travels with the row from load to submit without ever being
 * reconstructed from a lookup — see `toSubmission`'s comment on why that
 * lookup was the bug.
 */
export type ClientDraft = SabnzbdClientDraft | QbittorrentClientDraft;

/**
 * `'off'` sits in the same control as the two styles, so enabling backfill and
 * choosing how it pages is one decision rather than a checkbox plus a select
 * that can disagree with each other.
 */
export type BackfillStyleDraft = 'off' | 'newznab' | 'page';

export interface FeedDraft {
  id: string;
  url: string;
  plugin: string;
  /**
   * Which download client this feed's picks go to. Always a real id, never a
   * blank standing for "the first one": the server resolves the default before
   * the form ever sees it, so what is shown is what is in use.
   */
  downloadClient: string;
  intervalSeconds: string;
  backfillStyle: BackfillStyleDraft;
  /**
   * Kept while the style is `'off'` rather than cleared, so toggling backfill
   * off to look at something and back on again does not silently discard the
   * numbers that were typed. `toSubmission` ignores them when off.
   */
  backfillPageSize: string;
  backfillPagesPerPass: string;
  backfillMaxPages: string;
}

/**
 * `feedBackfillSchema`'s own defaults, so a row switched on here matches a block
 * written by hand with only `style` set.
 */
export const BACKFILL_DEFAULTS = {
  pageSize: '100',
  pagesPerPass: '2',
  maxPages: '100',
} as const;

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
    downloadClients: config.downloadClients.map((client): ClientDraft => {
      const common = {
        id: client.id,
        url: client.url,
        category: client.category,
        importMode: client.importMode,
        pathMappings: client.pathMappings.map((mapping) => ({ ...mapping })),
      };
      return client.type === 'sabnzbd'
        ? { ...common, type: 'sabnzbd', apiKey: keepOrPath(client.apiKey) }
        : {
            ...common,
            type: 'qbittorrent',
            apiKey: client.apiKey === null ? null : keepOrPath(client.apiKey),
            username: client.username,
            password: client.password === null ? null : keepOrPath(client.password),
          };
    }),
    feeds: config.feeds.map((feed) => ({
      id: feed.id,
      url: feed.url,
      plugin: feed.plugin,
      downloadClient: feed.downloadClient,
      intervalSeconds: String(feed.intervalSeconds),
      backfillStyle: feed.backfill?.style ?? 'off',
      // A feed that is not backfilling still shows the defaults, so switching it
      // on presents the same starting point as a freshly added row.
      backfillPageSize: String(feed.backfill?.pageSize ?? BACKFILL_DEFAULTS.pageSize),
      backfillPagesPerPass: String(feed.backfill?.pagesPerPass ?? BACKFILL_DEFAULTS.pagesPerPass),
      backfillMaxPages: String(feed.backfill?.maxPages ?? BACKFILL_DEFAULTS.maxPages),
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
 * A plugin setting's number, or the setting that failed.
 *
 * Deliberately not `asCount`: that one demands a *positive integer* because it
 * guards ports and intervals, while `configSchema` types a plugin setting as a
 * bare `z.number()`. A plugin is entitled to `0`, to a negative, and to a
 * fraction, so the only rule here is that the text names a finite number.
 *
 * The empty case is the one that matters. `Number('')` is `0`, so a cleared
 * field used to submit `0` — a value the user never typed, written into their
 * config and taken as intentional. Holding the raw text (rather than parsing
 * per keystroke) is what made clearing the field reachable at all, so this is
 * the check that has to catch it.
 */
function asPluginNumber(raw: string, field: string): number | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { error: `${field} must be a number` };
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : { error: `${field} must be a number` };
}

/**
 * The conversion `PluginSettingDraftValue`'s doc comment promises: a list's
 * raw text is split back into an array (dropping blank lines, exactly as
 * `configSchema` requires), a number's raw text is parsed and validated, and
 * text/boolean pass through unchanged since nothing converted them away from
 * their real type in the first place.
 */
function fromDraftValue(
  value: PluginSettingDraftValue,
  field: string,
): PluginSettingValue | { error: string } {
  if (typeof value !== 'object') return value;
  return 'list' in value ? fromLines(value.list) : asPluginNumber(value.number, field);
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

    if (feed.backfillStyle === 'off') {
      feeds.push({
        id: feed.id,
        url: feed.url,
        plugin: feed.plugin,
        downloadClient: feed.downloadClient,
        intervalSeconds,
        backfill: null,
      });
      continue;
    }

    const pageSize = asCount(feed.backfillPageSize, `feeds[${index}].backfill.pageSize`);
    if (typeof pageSize !== 'number') return pageSize;
    const pagesPerPass = asCount(feed.backfillPagesPerPass, `feeds[${index}].backfill.pagesPerPass`);
    if (typeof pagesPerPass !== 'number') return pagesPerPass;
    const maxPages = asCount(feed.backfillMaxPages, `feeds[${index}].backfill.maxPages`);
    if (typeof maxPages !== 'number') return maxPages;
    // Caught here as well as by `feedBackfillSchema`, because the floor is not
    // arbitrary: below two pages a pass there is no previous page to compare
    // against, so the walk cannot notice an indexer that ignores the pagination
    // parameter. Saying so in the form beats a 400 that only says "invalid".
    if (pagesPerPass < 2) {
      return {
        error: `feeds[${index}].backfill.pagesPerPass must be at least 2, so a pass can tell whether the indexer is paginating at all`,
      };
    }

    feeds.push({
      id: feed.id,
      url: feed.url,
      plugin: feed.plugin,
      downloadClient: feed.downloadClient,
      intervalSeconds,
      backfill: { style: feed.backfillStyle, pageSize, pagesPerPass, maxPages },
    });
  }

  // `client.type` is read from the draft itself, never re-derived by looking
  // an id up in `config`: a lookup keyed on id goes stale the moment an id is
  // renamed in this same edit, and a client whose type came from a fallback
  // rather than its own draft is exactly how a qBittorrent client gets
  // rewritten in SABnzbd's shape — the failure this form exists to prevent.
  const downloadClients: SubmittedDownloadClient[] = draft.downloadClients.map((client): SubmittedDownloadClient => {
    const common = {
      id: client.id,
      url: client.url,
      category: client.category,
      importMode: client.importMode,
      pathMappings: client.pathMappings.map((mapping) => ({ ...mapping })),
    };
    return client.type === 'sabnzbd'
      ? { ...common, type: 'sabnzbd', apiKey: client.apiKey }
      : {
          ...common,
          type: 'qbittorrent',
          apiKey: client.apiKey,
          username: client.username,
          password: client.password,
        };
  });

  const plugins: Record<string, Record<string, PluginSettingValue>> = {};
  for (const plugin of draft.plugins) {
    const settings: Record<string, PluginSettingValue> = {};
    for (const entry of plugin.settings) {
      // Named by plugin and key rather than by index: a plugin block can hold
      // a dozen settings, and "must be a number" is only actionable if it says
      // which one.
      const value = fromDraftValue(entry.value, `plugins["${plugin.name}"].${entry.key}`);
      // A list value is an object too, so the check is for the error shape
      // specifically rather than for objecthood — matching how `applyEdits`
      // and `manual/operations.ts` discriminate their own result unions.
      if (typeof value === 'object' && 'error' in value) return value;
      settings[entry.key] = value;
    }
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
        // From the draft rather than `config`, matching `pluginNames` beside
        // it: a client added or renamed in this same edit is choosable for a
        // feed before either has been saved.
        clientIds={draft.downloadClients.map((client) => client.id)}
        onChange={(feeds) => onChange({ ...draft, feeds })}
      />
      <PluginFields plugins={draft.plugins} onChange={(plugins) => onChange({ ...draft, plugins })} />
    </div>
  );
}
