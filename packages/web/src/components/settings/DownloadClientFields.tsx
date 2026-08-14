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

const blankClient: ClientDraft = {
  id: '',
  url: '',
  // An empty literal, not `keep`: there is no key on disk for a client that
  // does not exist there yet, and the server refuses a `keep` it cannot match.
  apiKey: { kind: 'literal', value: '' },
  category: '',
  importMode: 'move',
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

  function addClient() {
    // Not `blankClient` itself: pushing the module-level object means every
    // added row shares the exact same `pathMappings` array reference, so
    // adding a mapping to one added client would silently add it to every
    // other added client too. `PluginFields` spreads its blank plugin and
    // `FeedFields` builds a fresh literal for the same reason.
    onChange([...clients, { ...blankClient, pathMappings: [] }]);
  }

  return (
    <fieldset>
      <legend>Download clients</legend>
      {clients.map((client, index) => {
        // No entry means this row is new: there is no key on disk, so
        // nothing to keep, and the fallback correctly suppresses the "Keep
        // existing" button in SecretField.
        const view = onDisk.find((entry) => entry.id === client.id)?.apiKey;

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
            <SecretField
              label="API key"
              view={view ?? { kind: 'file', path: '' }}
              value={client.apiKey}
              onChange={(apiKey) => updateClient(index, { ...client, apiKey })}
            />
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
        <button type="button" onClick={addClient}>
          Add download client
        </button>
      </div>
    </fieldset>
  );
}
