import { useId } from 'react';
import { BACKFILL_DEFAULTS, type BackfillStyleDraft, type FeedDraft } from './ConfigForm.tsx';

export interface FeedFieldsProps {
  feeds: FeedDraft[];
  /** The plugins the file already configures; a feed's plugin must be one of these. */
  pluginNames: string[];
  /**
   * The download clients the draft configures; a feed's client must be one of
   * these. Taken as a prop the same way `pluginNames` is, and from the same
   * place — the draft, not the on-disk config — so a client added or renamed
   * in this same edit is offered here before it has been saved.
   */
  clientIds: string[];
  onChange(next: FeedDraft[]): void;
}

/**
 * The add/remove editor for `ConfigDraft.feeds`. Stateless like
 * `DownloadClientFields`: every edit is a whole new array reported through
 * `onChange`, never a mutation of the array passed in.
 */
export function FeedFields({ feeds, pluginNames, clientIds, onChange }: FeedFieldsProps) {
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
      // The first configured client, for the same reason as `plugin` above:
      // `parseConfig` refuses a feed naming a client `downloadClients` does
      // not carry, and it is also what an omitted `downloadClient` resolves
      // to at boot — so a row added here matches a row written by hand
      // without one.
      downloadClient: clientIds[0] ?? '',
      // `feedSchema`'s own default, so a row added here matches a row omitted
      // from the file.
      intervalSeconds: '900',
      // Off, matching `backfill` being optional: adding a feed must not quietly
      // start walking an indexer's history.
      backfillStyle: 'off',
      backfillPageSize: BACKFILL_DEFAULTS.pageSize,
      backfillPagesPerPass: BACKFILL_DEFAULTS.pagesPerPass,
      backfillMaxPages: BACKFILL_DEFAULTS.maxPages,
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
            <label htmlFor={`${formId}-client-${index}`}>Download client</label>
            <select
              id={`${formId}-client-${index}`}
              value={feed.downloadClient}
              onChange={(event) => updateFeed(index, { ...feed, downloadClient: event.target.value })}
            >
              {/*
                The same stand-in the plugin select carries above, for the same
                case: a client renamed in this same draft leaves the feed
                holding an id `clientIds` no longer offers, and without an
                option for it the control would show nothing selected while the
                draft still submitted the old name.
              */}
              {!clientIds.includes(feed.downloadClient) && (
                <option value={feed.downloadClient} disabled>
                  {feed.downloadClient || '(none)'}
                </option>
              )}
              {clientIds.map((id) => (
                <option key={id} value={id}>
                  {id}
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
          <div className="manual-field">
            <label htmlFor={`${formId}-backfill-${index}`}>Backfill history</label>
            <select
              id={`${formId}-backfill-${index}`}
              value={feed.backfillStyle}
              onChange={(event) =>
                updateFeed(index, {
                  ...feed,
                  backfillStyle: event.target.value as BackfillStyleDraft,
                })
              }
            >
              {/*
                The styles are named by what they send rather than by jargon.
                Pickarr cannot detect which an indexer speaks — nothing in an RSS
                document says — and guessing wrong is the silent failure, so this
                control has no "auto" and the wording has to be enough for someone
                to match it against their indexer's docs.
              */}
              <option value="off">Off</option>
              <option value="newznab">Newznab (offset &amp; limit)</option>
              <option value="page">Page number</option>
            </select>
          </div>
          {/*
            The numbers only mean anything once a style is chosen, and showing
            three disabled boxes beside an "Off" selector is noise. The values
            survive in the draft while hidden, so switching off and back on does
            not lose what was typed.
          */}
          {feed.backfillStyle !== 'off' && (
            <>
              <div className="manual-field">
                <label htmlFor={`${formId}-backfill-size-${index}`}>Items per page</label>
                <input
                  id={`${formId}-backfill-size-${index}`}
                  type="text"
                  value={feed.backfillPageSize}
                  onChange={(event) =>
                    updateFeed(index, { ...feed, backfillPageSize: event.target.value })
                  }
                />
              </div>
              <div className="manual-field">
                <label htmlFor={`${formId}-backfill-per-pass-${index}`}>Pages per pass</label>
                <input
                  id={`${formId}-backfill-per-pass-${index}`}
                  type="text"
                  value={feed.backfillPagesPerPass}
                  onChange={(event) =>
                    updateFeed(index, { ...feed, backfillPagesPerPass: event.target.value })
                  }
                />
              </div>
              <div className="manual-field">
                <label htmlFor={`${formId}-backfill-max-${index}`}>Maximum pages</label>
                <input
                  id={`${formId}-backfill-max-${index}`}
                  type="text"
                  value={feed.backfillMaxPages}
                  onChange={(event) =>
                    updateFeed(index, { ...feed, backfillMaxPages: event.target.value })
                  }
                />
              </div>
            </>
          )}
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
