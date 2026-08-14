import { useId, useState } from 'react';
import type { PluginDraft } from './ConfigForm.tsx';

export interface PluginFieldsProps {
  plugins: PluginDraft[];
  onChange(next: PluginDraft[]): void;
}

type SettingType = 'text' | 'number' | 'boolean' | 'list';

/**
 * A plugin setting's value as it lives in the draft, before submission.
 *
 * `text` and `boolean` are held as the value itself — a keystroke's meaning
 * cannot change under a control that just echoes back what was typed or
 * toggled. `number` and `list` are held as the *raw text* the control shows,
 * because both are otherwise converted on every keystroke (`Number(...)`,
 * `fromLines(...)`) and then redisplayed as the converted form: clearing a
 * number input round-trips `'' -> 0 -> "0"`, and pressing Enter in the list
 * textarea round-trips `"Vixen\n" -> ['Vixen'] -> "Vixen"` — in both cases
 * React puts back something other than what was typed, on a control the DOM
 * itself would otherwise have left alone. Converting only at submit (see
 * `toSubmission` in `ConfigForm.tsx`) is the same rule that file already
 * applies to `server.port` and the other numeric fields.
 */
export type PluginSettingDraftValue = string | boolean | { list: string } | { number: string };

/** The blank value for a newly-added setting of each type. */
const BLANK: Record<SettingType, PluginSettingDraftValue> = {
  text: '',
  number: { number: '0' },
  boolean: false,
  list: { list: '' },
};

const blankPlugin: PluginDraft = { name: '', settings: [] };

/**
 * A list is edited one value per line.
 *
 * Blank lines are dropped rather than becoming empty strings — but only here,
 * at submit: `configSchema` types this as `z.array(z.string())` and would
 * accept `['']` happily, leaving a plugin to treat an empty site name as a
 * real one. Dropping them while typing (on every keystroke) is what broke
 * pressing Enter to start a new line in the first place.
 */
export function toLines(value: string[]): string {
  return value.join('\n');
}

export function fromLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The `plugins` block: a record of plugin package names, each holding a
 * record of settings whose values may be a string, a number, a boolean or a
 * list of strings.
 *
 * The control is chosen from the value's *current* shape and cannot change
 * it. A single text input for everything would be smaller code, but every
 * save would rewrite `sites: ["Vixen"]` as `sites: "Vixen"` and `retries: 3`
 * as `retries: "3"` — and `plugins` is typed loosely enough in
 * `configSchema` (`z.union([...])`) that the file would still validate, so
 * the damage would only show up as a plugin misbehaving later.
 */
export function PluginFields({ plugins, onChange }: PluginFieldsProps) {
  const formId = useId();
  const [addAs, setAddAs] = useState<Record<number, SettingType>>({});

  function updatePlugin(index: number, next: PluginDraft) {
    onChange(plugins.map((plugin, i) => (i === index ? next : plugin)));
  }

  function removePlugin(index: number) {
    onChange(plugins.filter((_, i) => i !== index));
    // `addAs` is keyed by array position, so removing a plugin must shift
    // every later key down to match - otherwise the "new setting type"
    // pending for the plugin that used to sit one slot further down would
    // silently attach itself to whichever plugin now occupies that slot.
    setAddAs((current) => {
      const remapped: Record<number, SettingType> = {};
      for (const [key, type] of Object.entries(current)) {
        const at = Number(key);
        if (at < index) remapped[at] = type;
        else if (at > index) remapped[at - 1] = type;
      }
      return remapped;
    });
  }

  function addPlugin() {
    onChange([...plugins, { ...blankPlugin }]);
  }

  return (
    <fieldset>
      <legend>Plugins</legend>
      {plugins.map((plugin, index) => {
        function updateSetting(settingIndex: number, next: { key: string; value: PluginSettingDraftValue }) {
          updatePlugin(index, {
            ...plugin,
            settings: plugin.settings.map((setting, i) => (i === settingIndex ? next : setting)),
          });
        }

        function removeSetting(settingIndex: number) {
          updatePlugin(index, { ...plugin, settings: plugin.settings.filter((_, i) => i !== settingIndex) });
        }

        function addSetting() {
          const type = addAs[index] ?? 'text';
          updatePlugin(index, { ...plugin, settings: [...plugin.settings, { key: '', value: BLANK[type] }] });
        }

        return (
          <article className="settings-row" key={index}>
            <div className="manual-field">
              <label htmlFor={`${formId}-name-${index}`}>Package</label>
              <input
                id={`${formId}-name-${index}`}
                type="text"
                value={plugin.name}
                onChange={(event) => updatePlugin(index, { ...plugin, name: event.target.value })}
              />
            </div>

            <fieldset>
              <legend>Settings</legend>
              {plugin.settings.map((setting, settingIndex) => {
                const valueId = `${formId}-value-${index}-${settingIndex}`;
                // A newly-added setting has no key yet, so the label that
                // would otherwise identify its value control ("sites",
                // "retries", ...) is empty and getByLabelText finds nothing.
                // "New setting value" keeps the control reachable by label
                // until it is named.
                const valueLabel = setting.key.trim() === '' ? 'New setting value' : setting.key;

                return (
                  <article className="settings-row" key={settingIndex}>
                    <div className="manual-field">
                      <label htmlFor={`${formId}-key-${index}-${settingIndex}`}>Setting name</label>
                      <input
                        id={`${formId}-key-${index}-${settingIndex}`}
                        type="text"
                        value={setting.key}
                        onChange={(event) => updateSetting(settingIndex, { ...setting, key: event.target.value })}
                      />
                    </div>
                    <div className="manual-field">
                      <label htmlFor={valueId}>{valueLabel}</label>
                      {typeof setting.value === 'boolean' ? (
                        <input
                          id={valueId}
                          type="checkbox"
                          checked={setting.value}
                          onChange={(event) =>
                            updateSetting(settingIndex, { ...setting, value: event.target.checked })
                          }
                        />
                      ) : typeof setting.value === 'object' && 'list' in setting.value ? (
                        // Raw text, converted with `fromLines` only at submit
                        // (`ConfigForm.toSubmission`): converting on every
                        // keystroke is what made Enter unable to start a new
                        // line — `"Vixen\n"` becomes `['Vixen']` becomes
                        // `"Vixen"`, and React puts that back in the textarea.
                        <textarea
                          id={valueId}
                          value={setting.value.list}
                          onChange={(event) =>
                            updateSetting(settingIndex, { ...setting, value: { list: event.target.value } })
                          }
                        />
                      ) : typeof setting.value === 'object' && 'number' in setting.value ? (
                        // Raw text, converted with `Number` only at submit:
                        // converting on every keystroke is what made clearing
                        // the field snap back to `0` — `''` becomes `0`
                        // becomes `"0"`, and React puts that back in the input.
                        <input
                          id={valueId}
                          type="number"
                          value={setting.value.number}
                          onChange={(event) =>
                            updateSetting(settingIndex, { ...setting, value: { number: event.target.value } })
                          }
                        />
                      ) : (
                        <input
                          id={valueId}
                          type="text"
                          value={setting.value}
                          onChange={(event) =>
                            updateSetting(settingIndex, { ...setting, value: event.target.value })
                          }
                        />
                      )}
                    </div>
                    {/*
                      Named by its own key, the same reason "Remove download
                      client" and "Remove feed" are: several of these can
                      render per plugin, and reading order is not how every
                      user finds the right one. A row not yet given a key
                      (freshly added) reads as "(new)" rather than a blank
                      name.
                    */}
                    <div className="settings-row-actions">
                      <button
                        type="button"
                        aria-label={`Remove setting ${setting.key || '(new)'}`}
                        onClick={() => removeSetting(settingIndex)}
                      >
                        Remove setting
                      </button>
                    </div>
                  </article>
                );
              })}
              {/*
                Named by its own plugin, the same reason "Remove setting"
                above is: one of these renders per plugin, and a
                rotor/forms-mode list of controls would otherwise show
                identical "New setting type" entries with no way to tell them
                apart. Visible text is unchanged; only the accessible name
                carries the plugin's identity.
              */}
              <div className="manual-field">
                <label htmlFor={`${formId}-add-type-${index}`}>New setting type</label>
                <select
                  id={`${formId}-add-type-${index}`}
                  aria-label={`New setting type for ${plugin.name || '(new)'}`}
                  value={addAs[index] ?? 'text'}
                  onChange={(event) => setAddAs({ ...addAs, [index]: event.target.value as SettingType })}
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">Yes / no</option>
                  <option value="list">List of text</option>
                </select>
              </div>
              {/*
                Named by its own plugin, the same reason as above: one of
                these renders per plugin, and a rotor/forms-mode list of
                controls would otherwise show identical "Add setting" entries
                with no way to tell them apart.
              */}
              <div className="settings-row-actions">
                <button type="button" aria-label={`Add setting to ${plugin.name || '(new)'}`} onClick={addSetting}>
                  Add setting
                </button>
              </div>
            </fieldset>

            {/*
              Named by its own package name, the same reason "Remove
              setting" above is: several of these can render at once, and a
              rotor/forms-mode list of controls would otherwise show
              identical "Remove plugin" entries with no way to tell them
              apart. A row not yet given a name (freshly added) reads as
              "(new)".
            */}
            <div className="settings-row-actions">
              <button
                type="button"
                aria-label={`Remove plugin ${plugin.name || '(new)'}`}
                onClick={() => removePlugin(index)}
              >
                Remove plugin
              </button>
            </div>
          </article>
        );
      })}
      <div className="settings-row-actions">
        <button type="button" onClick={addPlugin}>
          Add plugin
        </button>
      </div>
    </fieldset>
  );
}
