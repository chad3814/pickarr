import { useState } from 'react';
import type { FailedItemView, ManualField } from '../api/client.ts';
import { useIdentityPreview } from '../api/useIdentityPreview.ts';
import { ManualForm, seed } from './ManualForm.tsx';

interface FixProps {
  item: FailedItemView;
  fields: ManualField[];
  onSubmit(values: Record<string, string>): void;
  onCancel(): void;
}

/**
 * The form for one refused item, with the plugin's live reading of it.
 *
 * It is separate from the card so that the draft the preview watches is state
 * of the form's own, mounted and discarded with it. Rendering it inside the
 * card also settles the seeding problem for free: `ManualForm` seeds once and
 * never again, so a single form moved between cards would go on showing the
 * first card's suggestions.
 */
export function FixForm({ item, fields, onSubmit, onCancel }: FixProps) {
  // Seeded here as well as inside the form, and handed the *prefill* rather
  // than this draft, so that both callers of `ManualForm` pass it the same kind
  // of thing: the raw values, which it seeds for itself. This copy exists only
  // to give the preview the draft the form will submit — it is not what seeds
  // the rendered inputs. That is `values={item.suggestedValues}` below: `seed`
  // there is `ManualForm`'s own, called on its own `values` prop, and mutating
  // *this* `draft` initialiser is a false lead — the inputs never read it.
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

interface Props {
  item: FailedItemView;
  /** Absent when the plugin has no manual hooks, or its feed has left configuration. */
  fields?: ManualField[] | undefined;
  onFix(values: Record<string, string>): void;
  onDismiss(): void;
}

/**
 * One name the parser refused, in the same frame `MediaCard` renders a group
 * in, so the two interleave into one list without a reader ever seeing two
 * card heights alternate.
 *
 * Owns only whether its own form is open — resolving or dismissing the item is
 * the caller's job (an API call, a notice, dropping this card from the list),
 * the same division `MediaCard` keeps with `onEditGroup`/`onPick`.
 */
export function FailedCard({ item, fields, onFix, onDismiss }: Props) {
  const [editing, setEditing] = useState(false);

  return (
    <article className="failed-card">
      <div className="card-head">
        {/*
         * A failed item has no artwork of its own — there is nothing to have
         * parsed a poster from. An empty frame at `.card-artwork img`'s own
         * geometry (`card.css`) keeps this card the same height as the media
         * cards around it, so an interleaved list does not alternate between
         * two card heights depending on which kind of row landed where.
         */}
        <div className="failed-poster" aria-hidden="true" />
        <div className="card-head-main">
          <header>
            <h2>{item.rawTitle}</h2>
          </header>
          <p className="failed-reason">{item.parseError}</p>
          <p className="failed-feed">Feed: {item.feedId}</p>

          <div className="failed-actions">
            {fields !== undefined && !editing && (
              <button type="button" onClick={() => setEditing(true)}>
                Fix…
              </button>
            )}
            {item.dismissedAt === null ? (
              <button type="button" onClick={onDismiss}>
                Dismiss
              </button>
            ) : (
              // Dismissing it again is a 409; it is listed at all only because
              // showing it is how it stays fixable.
              <span className="badge">Dismissed</span>
            )}
          </div>

          {fields !== undefined && editing && (
            <FixForm item={item} fields={fields} onSubmit={onFix} onCancel={() => setEditing(false)} />
          )}
        </div>
      </div>
    </article>
  );
}
