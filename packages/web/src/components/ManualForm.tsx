import { useId, useState } from 'react';
import type { ManualField } from '../api/client.ts';

interface Props {
  fields: ManualField[];
  values: Record<string, string>;
  /** Rendered under the fields. The caller supplies it; the form does no fetching. */
  preview?: string;
  submitLabel: string;
  onChange?(values: Record<string, string>): void;
  onSubmit(values: Record<string, string>): void;
  onCancel(): void;
}

/**
 * Every field the schema declares, with the given values laid over the top.
 *
 * Seeding from the *field list* rather than from `values` is the point:
 * `suggestManualValues` answers sparsely — only the keys it could work out from
 * a name the parser already refused — so a draft built from `values` alone
 * would omit the fields the human most needs to fill in, and would submit a
 * partial record where the plugin expects the whole form.
 *
 * Exported because the two callers that show an identity preview have to watch
 * the draft this form will submit, not the prefill they were handed. A private
 * copy in each of them is a copy that can drift, and the day it does the
 * preview describes a different record than Save sends — in precisely the case
 * where the user typed nothing and is trusting the preview (§11).
 */
export function seed(
  fields: ManualField[],
  values: Record<string, string>,
): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const field of fields) draft[field.name] = values[field.name] ?? '';
  return draft;
}

/**
 * The form for describing a release by hand, rendered from a plugin's schema.
 *
 * Presentational by design: no fetching, and no knowledge of feed items,
 * groups or releases. The identity-key preview is a caller-supplied string
 * (see `useIdentityPreview`) so that both callers get the debounce without this
 * component learning which of the three forms it is.
 */
export function ManualForm({
  fields,
  values,
  preview,
  submitLabel,
  onChange,
  onSubmit,
  onCancel,
}: Props) {
  // Seeded once. Re-seeding when `values` changes identity would overwrite what
  // the user is typing on every parent render, since callers build the prefill
  // inline; a caller reusing this form for a different record remounts it.
  const [draft, setDraft] = useState(() => seed(fields, values));
  const [missing, setMissing] = useState<string[]>([]);
  const formId = useId();

  function set(name: string, value: string): void {
    const next = { ...draft, [name]: value };
    setDraft(next);
    onChange?.(next);
  }

  function submit(): void {
    const empty = fields
      .filter((field) => field.required === true && (draft[field.name] ?? '').trim() === '')
      .map((field) => field.label);
    setMissing(empty);
    if (empty.length > 0) return;
    onSubmit(draft);
  }

  return (
    <form
      className="manual-form"
      // Our own validation rather than the browser's: the messages have to name
      // the plugin's own labels, and a blocked native submit would never reach
      // the handler that renders them.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {fields.map((field) => {
        const controlId = `${formId}-${field.name}`;
        const helpId = `${controlId}-help`;
        const value = draft[field.name] ?? '';
        return (
          <div key={field.name} className="manual-field">
            <label htmlFor={controlId}>{field.label}</label>
            {field.type === 'select' ? (
              <select
                id={controlId}
                value={value}
                aria-required={field.required === true}
                aria-describedby={field.help === undefined ? undefined : helpId}
                onChange={(event) => set(field.name, event.target.value)}
              >
                {(field.options ?? []).map((option) => (
                  // An empty option renders blank on purpose: that is how a
                  // plugin spells "unset", and inventing a label for it would
                  // put a word of core's choosing in a plugin's vocabulary.
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={controlId}
                type={field.type}
                value={value}
                placeholder={field.placeholder}
                aria-required={field.required === true}
                aria-describedby={field.help === undefined ? undefined : helpId}
                onChange={(event) => set(field.name, event.target.value)}
              />
            )}
            {field.help !== undefined && (
              <span id={helpId} className="manual-help">
                {field.help}
              </span>
            )}
          </div>
        );
      })}

      {/*
        Empty is treated as nothing to show, not as something to show blankly.
        `useIdentityPreview` returns '' until its first response lands, so
        rendering on `!== undefined` alone puts an empty paragraph under every
        form for as long as the debounce lasts — and makes every caller
        responsible for converting '' to undefined to avoid it.
      */}
      {preview !== undefined && preview.length > 0 && (
        <p className="manual-preview">{preview}</p>
      )}

      {missing.length > 0 && <p className="error">Required: {missing.join(', ')}</p>}

      <div className="manual-actions">
        <button type="submit">{submitLabel}</button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
