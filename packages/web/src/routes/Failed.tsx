import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type FailedItemView,
  type ManualField,
  type ManualFieldsResponse,
} from '../api/client.ts';
import { ManualForm, seed } from '../components/ManualForm.tsx';
import { useIdentityPreview } from '../api/useIdentityPreview.ts';

interface FixProps {
  item: FailedItemView;
  fields: ManualField[];
  onSubmit(values: Record<string, string>): void;
  onCancel(): void;
}

/**
 * The form for one refused item, with the plugin's live reading of it.
 *
 * It is separate from the row so that the draft the preview watches is state of
 * the form's own, mounted and discarded with it. Rendering it inside the row
 * also settles the seeding problem for free: `ManualForm` seeds once and never
 * again, so a single form moved between rows would go on showing the first
 * row's suggestions.
 */
function FixForm({ item, fields, onSubmit, onCancel }: FixProps) {
  // Seeded here as well as inside the form, and handed the *prefill* rather
  // than this draft, so that both callers of `ManualForm` pass it the same kind
  // of thing: the raw values, which it seeds for itself. This copy exists only
  // to give the preview the draft the form will submit.
  const [draft, setDraft] = useState(() => seed(fields, item.suggestedValues));
  const preview = useIdentityPreview(item.plugin, draft);

  return (
    <ManualForm
      fields={fields}
      values={item.suggestedValues}
      preview={preview}
      submitLabel="Save"
      onChange={setDraft}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

/**
 * The names the parser refused, each with the reason and a way to describe it
 * by hand or to say it is never wanted.
 */
export function Failed() {
  const [items, setItems] = useState<FailedItemView[]>([]);
  const [fields, setFields] = useState<ManualFieldsResponse>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [includeDismissed, setIncludeDismissed] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (from: string | null, dismissed: boolean, replace: boolean): Promise<void> => {
      try {
        const page = await api.failed(from, dismissed);
        setItems((previous) => (replace ? page.items : [...previous, ...page.items]));
        setCursor(page.nextCursor);
        setDone(page.nextCursor === null);
        setError(null);
      } catch (cause) {
        setError((cause as Error).message);
      }
    },
    [],
  );

  useEffect(() => {
    void loadPage(null, includeDismissed, true);
  }, [loadPage, includeDismissed]);

  // The schemas are configuration, one map for every row on every page, so they
  // are fetched once for the screen rather than per item.
  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const next = await api.manualFields();
        if (!cancelled) setFields(next);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Drop the one row that was resolved. Refetching the first page instead would
   * discard every page loaded past it — the bug Browse had, where acting on a
   * row after "Load more" snapped the list back to its original length.
   */
  async function fix(itemId: number, values: Record<string, string>): Promise<void> {
    try {
      const { group, joinedExisting } = await api.resolveFeedItem(itemId, values);
      setItems((previous) => previous.filter((existing) => existing.id !== itemId));
      setEditing(null);
      setNotice(
        `${group.display.title} ${joinedExisting ? 'joined an existing group' : 'became a new group'}`,
      );
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  /**
   * Drop the row, or flip it to its dismissed state when dismissed rows are
   * being shown.
   *
   * Which of the two is right is exactly the question "Show dismissed" answers:
   * with it off the row no longer belongs on the list, and with it on it does —
   * reloading the page would bring it straight back, so filtering it out here
   * makes the screen disagree with a refresh, and puts the row's own `Dismissed`
   * badge out of reach on the only path that can produce it. The stamp is taken
   * from the response rather than invented locally, so the row carries the time
   * the server recorded.
   */
  async function dismiss(itemId: number): Promise<void> {
    try {
      const { dismissedAt } = await api.dismissFeedItem(itemId);
      setItems((previous) =>
        includeDismissed
          ? previous.map((existing) =>
              existing.id === itemId ? { ...existing, dismissedAt } : existing,
            )
          : previous.filter((existing) => existing.id !== itemId),
      );
      setNotice(null);
      setError(null);
    } catch (cause) {
      setNotice(null);
      setError((cause as Error).message);
    }
  }

  return (
    <section>
      <h1>Failed</h1>
      <label>
        <input
          type="checkbox"
          checked={includeDismissed}
          onChange={(event) => setIncludeDismissed(event.target.checked)}
        />
        Show dismissed
      </label>
      {notice !== null && <p className="notice">{notice}</p>}
      {error !== null && <p className="error">{error}</p>}

      <ul className="failed">
        {items.map((item) => {
          // A plugin with no manual hooks is *absent* from the map, and an item
          // whose feed has left configuration reports no plugin at all. Either
          // way there is no form to offer — but dismissing is core's own
          // bookkeeping, so it stays available.
          const schema = fields[item.plugin];
          return (
            <li key={item.id} className="failed-row">
              <h2>{item.rawTitle}</h2>
              <p className="failed-reason">{item.parseError}</p>
              <p className="failed-feed">Feed: {item.feedId}</p>

              <div className="failed-actions">
                {schema !== undefined && editing !== item.id && (
                  <button type="button" onClick={() => setEditing(item.id)}>
                    Fix…
                  </button>
                )}
                {item.dismissedAt === null ? (
                  <button type="button" onClick={() => void dismiss(item.id)}>
                    Dismiss
                  </button>
                ) : (
                  // Dismissing it again is a 409; it is listed at all only
                  // because "show dismissed" is how it stays fixable.
                  <span className="badge">Dismissed</span>
                )}
              </div>

              {schema !== undefined && editing === item.id && (
                <FixForm
                  item={item}
                  fields={schema}
                  onSubmit={(values) => void fix(item.id, values)}
                  onCancel={() => setEditing(null)}
                />
              )}
            </li>
          );
        })}
      </ul>

      {done && items.length === 0 && <p>Nothing failed to parse.</p>}

      {!done && (
        <button type="button" onClick={() => void loadPage(cursor, includeDismissed, false)}>
          Load more
        </button>
      )}
    </section>
  );
}
