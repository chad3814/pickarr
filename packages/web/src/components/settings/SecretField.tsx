import { useId } from 'react';
import type { SecretEdit, SecretView } from '../../api/client.ts';

export interface SecretFieldProps {
  label: string;
  /** What the server said is on disk. Fixed for the life of the form. */
  view: SecretView;
  /** What will be submitted for this field. */
  value: SecretEdit;
  onChange(next: SecretEdit): void;
}

/**
 * The one control for a write-only field.
 *
 * A `file:` reference is a path, so it is an ordinary editable text input. A
 * literal key is a secret the server never sent, so there is nothing to put in
 * an input at all: the field says only that a key is set, and replacing it is a
 * deliberate act that starts from empty. Leaving it alone submits
 * `{ kind: 'keep' }`, which the server resolves against the file.
 *
 * Stateless: every keystroke and button click is reported to `onChange`
 * rather than held here, so the caller's draft is the only copy of the value.
 */
export function SecretField({ label, view, value, onChange }: SecretFieldProps) {
  const controlId = useId();

  if (value.kind === 'file') {
    return (
      <div className="manual-field">
        <label htmlFor={controlId}>{label}</label>
        <input
          id={controlId}
          type="text"
          value={value.path}
          onChange={(event) => onChange({ kind: 'file', path: event.target.value })}
        />
      </div>
    );
  }

  if (value.kind === 'literal') {
    return (
      <div className="manual-field">
        <label htmlFor={controlId}>{label}</label>
        <input
          id={controlId}
          type="text"
          value={value.value}
          onChange={(event) => onChange({ kind: 'literal', value: event.target.value })}
        />
        {/*
          Offered only when there is something on disk to go back to, per
          `view` rather than `value`: a client just added in this form has no
          key on disk, so `keep` would be refused by the server with a 400 —
          offering the button there would be offering a guaranteed failure.
        */}
        {view.kind === 'set' && (
          <button type="button" onClick={() => onChange({ kind: 'keep' })}>
            Keep existing
          </button>
        )}
      </div>
    );
  }

  // value.kind === 'keep': a key is held on disk and the server never sent
  // it, so there is nothing here that could be read back as the key — only a
  // marker and a button that starts a deliberate replacement from empty.
  // There is no input for the label to point to here, and pointing `htmlFor`
  // at the button would replace the button's own accessible name ("Replace")
  // with the label's, which is wrong for a button whose text already says
  // what it does. So this label carries no `htmlFor`: it stays a real
  // `<label>` (the CSS column width is keyed off the tag, not the attribute)
  // but, deliberately, an unconnected one rather than a dangling one.
  return (
    <div className="manual-field">
      <label>{label}</label>
      <span className="secret-set">A key is set.</span>
      <button type="button" onClick={() => onChange({ kind: 'literal', value: '' })}>
        Replace
      </button>
    </div>
  );
}
