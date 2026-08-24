import { useId } from 'react';
import { SecretField } from './SecretField.tsx';
import type { ClientDraft } from './ConfigForm.tsx';
import type { EditableDownloadClient, EditablePathMapping } from '../../api/client.ts';

export interface DownloadClientFieldsProps {
  clients: ClientDraft[];
  /** What the server said is on disk, matched to a draft row by id. */
  onDisk: EditableDownloadClient[];
  onChange(next: ClientDraft[]): void;
}

// One blank per client type, and a button per blank. A `<select>` beside a
// single Add button would scale better to a third type, but with two it costs a
// piece of local state and a second click to say what two labels already say.
const blankSabnzbdClient: ClientDraft = {
  id: '',
  type: 'sabnzbd',
  url: '',
  // An empty literal, not `keep`: there is no key on disk for a client that
  // does not exist there yet, and the server refuses a `keep` it cannot match.
  apiKey: { kind: 'literal', value: '' },
  category: '',
  importMode: 'move',
  pathMappings: [],
};

/**
 * Two fields differ from the SABnzbd blank for reasons the server enforces, so
 * getting either wrong means a new row is rejected on save over something the
 * operator never chose.
 *
 * `importMode` is `copy` because `parseConfig` refuses `move` for a torrent
 * client — moving the file out from under a torrent stops it seeding.
 *
 * Exactly one credential, because `parseConfig` refuses both-or-neither. The
 * api key is the default rather than a login because it is one field instead of
 * two; it needs qBittorrent v5.2.0, and the Authentication selector on the row
 * switches to a username and password for anything older.
 */
const blankQbittorrentClient: ClientDraft = {
  id: '',
  type: 'qbittorrent',
  url: '',
  apiKey: { kind: 'literal', value: '' },
  username: null,
  password: null,
  category: '',
  importMode: 'copy',
  pathMappings: [],
};

const blankPathMapping: EditablePathMapping = { from: '', to: '' };

/**
 * The add/remove editor for `ConfigDraft.downloadClients`. Stateless like
 * `SecretField`: every edit is reported through `onChange` as a whole new
 * array, and the caller's draft is the only copy of the value.
 */
export function DownloadClientFields({ clients, onDisk, onChange }: DownloadClientFieldsProps) {
  const formId = useId();

  function updateClient(index: number, next: ClientDraft) {
    onChange(clients.map((client, i) => (i === index ? next : client)));
  }

  function removeClient(index: number) {
    onChange(clients.filter((_, i) => i !== index));
  }

  function addClient(blank: ClientDraft) {
    // Not the blank itself: pushing the module-level object means every added
    // row shares the exact same `pathMappings` array reference, so adding a
    // mapping to one added client would silently add it to every other added
    // client too. `PluginFields` spreads its blank plugin and `FeedFields`
    // builds a fresh literal for the same reason.
    onChange([...clients, { ...blank, pathMappings: [] }]);
  }

  return (
    <fieldset>
      <legend>Download clients</legend>
      {clients.map((client, index) => {
        // No entry means this row is new: there is no key on disk, so
        // nothing to keep, and the fallback correctly suppresses the "Keep
        // existing" button in SecretField. Matched on type as well as id: a
        // client whose on-disk entry is the other type (an in-place type
        // change made earlier in this same edit) has nothing of this shape on
        // disk to keep either.
        const onDiskEntry = onDisk.find((entry) => entry.id === client.id);
        const sabnzbdApiKeyView =
          client.type === 'sabnzbd' && onDiskEntry?.type === 'sabnzbd' ? onDiskEntry.apiKey : undefined;
        const qbittorrentOnDisk =
          client.type === 'qbittorrent' && onDiskEntry?.type === 'qbittorrent' ? onDiskEntry : undefined;

        function updatePathMapping(mappingIndex: number, next: EditablePathMapping) {
          updateClient(index, {
            ...client,
            pathMappings: client.pathMappings.map((mapping, i) => (i === mappingIndex ? next : mapping)),
          });
        }

        function removePathMapping(mappingIndex: number) {
          updateClient(index, {
            ...client,
            pathMappings: client.pathMappings.filter((_, i) => i !== mappingIndex),
          });
        }

        function addPathMapping() {
          updateClient(index, { ...client, pathMappings: [...client.pathMappings, { ...blankPathMapping }] });
        }

        return (
          <article className="settings-row" key={index}>
            <div className="manual-field">
              <label htmlFor={`${formId}-id-${index}`}>Id</label>
              <input
                id={`${formId}-id-${index}`}
                type="text"
                value={client.id}
                onChange={(event) => updateClient(index, { ...client, id: event.target.value })}
              />
            </div>
            <div className="manual-field">
              <label htmlFor={`${formId}-url-${index}`}>URL</label>
              <input
                id={`${formId}-url-${index}`}
                type="text"
                value={client.url}
                onChange={(event) => updateClient(index, { ...client, url: event.target.value })}
              />
            </div>
            {client.type === 'sabnzbd' ? (
              <SecretField
                label="API key"
                view={sabnzbdApiKeyView ?? { kind: 'file', path: '' }}
                value={client.apiKey}
                onChange={(apiKey) => updateClient(index, { ...client, apiKey })}
              />
            ) : (
              <>
                <div className="manual-field">
                  <label htmlFor={`${formId}-auth-mode-${index}`}>Authentication</label>
                  <select
                    id={`${formId}-auth-mode-${index}`}
                    value={client.apiKey !== null ? 'apiKey' : 'login'}
                    onChange={(event) =>
                      updateClient(
                        index,
                        event.target.value === 'apiKey'
                          ? { ...client, apiKey: { kind: 'literal', value: '' }, username: null, password: null }
                          : { ...client, apiKey: null, username: '', password: { kind: 'literal', value: '' } },
                      )
                    }
                  >
                    <option value="apiKey">API key</option>
                    <option value="login">Username &amp; password</option>
                  </select>
                </div>
                {client.apiKey !== null ? (
                  <SecretField
                    label="API key"
                    view={qbittorrentOnDisk?.apiKey ?? { kind: 'file', path: '' }}
                    value={client.apiKey}
                    onChange={(apiKey) => updateClient(index, { ...client, apiKey })}
                  />
                ) : (
                  <>
                    <div className="manual-field">
                      <label htmlFor={`${formId}-username-${index}`}>Username</label>
                      <input
                        id={`${formId}-username-${index}`}
                        type="text"
                        value={client.username ?? ''}
                        onChange={(event) => updateClient(index, { ...client, username: event.target.value })}
                      />
                    </div>
                    <SecretField
                      label="Password"
                      view={qbittorrentOnDisk?.password ?? { kind: 'file', path: '' }}
                      value={client.password ?? { kind: 'literal', value: '' }}
                      onChange={(password) => updateClient(index, { ...client, password })}
                    />
                  </>
                )}
              </>
            )}
            <div className="manual-field">
              <label htmlFor={`${formId}-category-${index}`}>Category</label>
              <input
                id={`${formId}-category-${index}`}
                type="text"
                value={client.category}
                onChange={(event) => updateClient(index, { ...client, category: event.target.value })}
              />
            </div>
            <div className="manual-field">
              <label htmlFor={`${formId}-import-mode-${index}`}>Import mode</label>
              <select
                id={`${formId}-import-mode-${index}`}
                value={client.importMode}
                onChange={(event) =>
                  updateClient(index, { ...client, importMode: event.target.value as 'move' | 'copy' })
                }
              >
                <option value="move">move</option>
                <option value="copy">copy</option>
              </select>
            </div>

            <fieldset>
              <legend>Path mappings</legend>
              {client.pathMappings.map((mapping, mappingIndex) => (
                <article className="settings-row" key={mappingIndex}>
                  <div className="manual-field">
                    <label htmlFor={`${formId}-mapping-from-${index}-${mappingIndex}`}>From</label>
                    <input
                      id={`${formId}-mapping-from-${index}-${mappingIndex}`}
                      type="text"
                      value={mapping.from}
                      onChange={(event) => updatePathMapping(mappingIndex, { ...mapping, from: event.target.value })}
                    />
                  </div>
                  <div className="manual-field">
                    <label htmlFor={`${formId}-mapping-to-${index}-${mappingIndex}`}>To</label>
                    <input
                      id={`${formId}-mapping-to-${index}-${mappingIndex}`}
                      type="text"
                      value={mapping.to}
                      onChange={(event) => updatePathMapping(mappingIndex, { ...mapping, to: event.target.value })}
                    />
                  </div>
                  {/*
                    Named by its own from/to, the same reason as "Remove
                    download client" below: several of these can render per
                    client, and reading order is not how every user finds the
                    right one.
                  */}
                  <div className="settings-row-actions">
                    <button
                      type="button"
                      aria-label={`Remove path mapping ${mapping.from || '(new)'} to ${mapping.to || '(new)'}`}
                      onClick={() => removePathMapping(mappingIndex)}
                    >
                      Remove path mapping
                    </button>
                  </div>
                </article>
              ))}
              {/*
                Named by its own client, the same reason "Remove path
                mapping" above is: one of these renders per download client,
                and a rotor/forms-mode list of controls would otherwise show
                identical "Add path mapping" entries with no way to tell them
                apart.
              */}
              <div className="settings-row-actions">
                <button
                  type="button"
                  aria-label={`Add path mapping to ${client.id || '(new)'}`}
                  onClick={addPathMapping}
                >
                  Add path mapping
                </button>
              </div>
            </fieldset>

            {/*
              Named by its own id, the same reason `SecretField` names
              "Replace" and "Keep existing" per field (Task 9): one of these
              renders per client, and a rotor/forms-mode list of controls
              would otherwise show identical "Remove download client"
              entries with no way to tell them apart. A row not yet given an
              id (freshly added) reads as "(new)" rather than a blank name.
            */}
            <div className="settings-row-actions">
              <button
                type="button"
                aria-label={`Remove download client ${client.id || '(new)'}`}
                onClick={() => removeClient(index)}
              >
                Remove download client
              </button>
            </div>
          </article>
        );
      })}
      <div className="settings-row-actions">
        <button type="button" onClick={() => addClient(blankSabnzbdClient)}>
          Add SABnzbd client
        </button>
        <button type="button" onClick={() => addClient(blankQbittorrentClient)}>
          Add qBittorrent client
        </button>
      </div>
    </fieldset>
  );
}
