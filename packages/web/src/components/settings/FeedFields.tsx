import { useId } from 'react';
import type { FeedDraft } from './ConfigForm.tsx';

export interface FeedFieldsProps {
  feeds: FeedDraft[];
  /** The plugins the file already configures; a feed's plugin must be one of these. */
  pluginNames: string[];
  onChange(next: FeedDraft[]): void;
}

/**
 * The add/remove editor for `ConfigDraft.feeds`. Stateless like
 * `DownloadClientFields`: every edit is a whole new array reported through
 * `onChange`, never a mutation of the array passed in.
 */
export function FeedFields({ feeds, pluginNames, onChange }: FeedFieldsProps) {
  const formId = useId();

  function updateFeed(index: number, next: FeedDraft) {
    onChange(feeds.map((feed, i) => (i === index ? next : feed)));
  }

  function removeFeed(index: number) {
    onChange(feeds.filter((_, i) => i !== index));
  }

  function addFeed() {
    const blankFeed: FeedDraft = {
      id: '',
      url: '',
      // The first configured plugin rather than an empty option: `feedSchema`
      // requires a plugin that `plugins` also configures, so an empty value
      // is never valid and offering it only produces a 400.
      plugin: pluginNames[0] ?? '',
      // `feedSchema`'s own default, so a row added here matches a row omitted
      // from the file.
      intervalSeconds: '900',
    };
    onChange([...feeds, blankFeed]);
  }

  return (
    <fieldset>
      <legend>Feeds</legend>
      {feeds.map((feed, index) => (
        <article className="settings-row" key={index}>
          <div className="manual-field">
            <label htmlFor={`${formId}-id-${index}`}>Id</label>
            <input
              id={`${formId}-id-${index}`}
              type="text"
              value={feed.id}
              onChange={(event) => updateFeed(index, { ...feed, id: event.target.value })}
            />
          </div>
          <div className="manual-field">
            <label htmlFor={`${formId}-url-${index}`}>URL</label>
            <input
              id={`${formId}-url-${index}`}
              type="text"
              value={feed.url}
              onChange={(event) => updateFeed(index, { ...feed, url: event.target.value })}
            />
          </div>
          <div className="manual-field">
            <label htmlFor={`${formId}-plugin-${index}`}>Plugin</label>
            <select
              id={`${formId}-plugin-${index}`}
              value={feed.plugin}
              onChange={(event) => updateFeed(index, { ...feed, plugin: event.target.value })}
            >
              {/*
                A feed's plugin can be a name the `plugins` block used to
                configure but no longer does — most commonly because a plugin
                was renamed in this same draft. `value` above is still that
                old name, but `pluginNames` no longer contains it, so without
                this option the `<select>` would render with nothing selected
                while `feed.plugin` still held the stale name — the form would
                show one thing and submit another, which the server then
                refuses with a 400 rather than the plugin lookup that
                `configSchema` requires.
              */}
              {!pluginNames.includes(feed.plugin) && (
                <option value={feed.plugin} disabled>
                  {feed.plugin || '(none)'}
                </option>
              )}
              {pluginNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="manual-field">
            <label htmlFor={`${formId}-interval-${index}`}>Interval (seconds)</label>
            <input
              id={`${formId}-interval-${index}`}
              type="text"
              value={feed.intervalSeconds}
              onChange={(event) => updateFeed(index, { ...feed, intervalSeconds: event.target.value })}
            />
          </div>
          {/*
            Named by its own id, the same reason as "Remove download client"
            in `DownloadClientFields`: one of these renders per feed, and a
            rotor/forms-mode list of controls would otherwise show identical
            "Remove feed" entries with no way to tell them apart. A row not
            yet given an id (freshly added) reads as "(new)".
          */}
          <div className="settings-row-actions">
            <button
              type="button"
              aria-label={`Remove feed ${feed.id || '(new)'}`}
              onClick={() => removeFeed(index)}
            >
              Remove feed
            </button>
          </div>
        </article>
      ))}
      <div className="settings-row-actions">
        <button type="button" onClick={addFeed}>
          Add feed
        </button>
      </div>
    </fieldset>
  );
}
