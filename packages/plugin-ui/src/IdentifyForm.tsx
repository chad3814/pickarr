/**
 * The form that tells Pickarr what one release is: a combobox over the
 * library's own titles, with a final option that looks the release up by
 * whatever was typed instead.
 *
 * **Two ways to save, one request each.** Choosing a title and saving posts
 * `{ mode: 'media-item' }`, which relinks the release at once; saving the
 * typed text posts `{ mode: 'name' }`, which asks the lookup service.
 * Editing the text after choosing a title forgets the choice, so what is
 * saved is always what the input shows.
 *
 * **A response is only listed if nothing newer has been asked for since.**
 * Every keystroke advances `requestSeq`, and each request captures the value
 * it was issued at, so an answer for `du` that lands after the answer for
 * `dune` is dropped rather than overwriting it.
 *
 * The list closes when the input blurs. Options therefore use `onMouseDown`,
 * not `onClick`: the input's blur fires between the two, and a list that
 * closes on blur would be gone before the click landed. The option's
 * `mousedown` also calls `preventDefault()`, so the click does not move focus
 * out of the input in the first place.
 *
 * `aria-activedescendant` is present only while the list is open; a closed
 * list has no active option to name.
 */
import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactElement } from 'react';
import {
  IDENTIFY_REFUSAL_MESSAGES,
  SUGGEST_DEBOUNCE_MS,
  SUGGEST_LIMIT,
  type Candidate,
  type IdentifySubmit,
} from './types.ts';

export interface IdentifyFormProps {
  pluginId: string;
  rssItemId: number;
  identify: IdentifySubmit;
  /** Called once the host has accepted or linked; the caller closes the form. */
  onDone(): void;
  onCancel(): void;
}

function candidateLabel(candidate: Candidate): string {
  return candidate.year === null ? candidate.title : `${candidate.title} (${candidate.year})`;
}

export function IdentifyForm({ pluginId, rssItemId, identify, onDone, onCancel }: IdentifyFormProps): ReactElement {
  const [input, setInput] = useState('');
  const [chosen, setChosen] = useState<number | null>(null);
  const [options, setOptions] = useState<readonly Candidate[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestSeq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // `useId` keeps two open forms on one page apart; the release id makes the
  // markup readable.
  const uid = useId();
  const base = `identify-${String(rssItemId)}-${uid}`;
  const inputId = `${base}-input`;
  const labelId = `${base}-label`;
  const listboxId = `${base}-listbox`;
  const optionId = `${base}-option`;

  useEffect(
    () => () => {
      clearTimeout(debounce.current);
      requestSeq.current += 1;
    },
    [],
  );

  const trimmed = input.trim();
  const lookUpIndex = options.length;
  const optionCount = trimmed === '' ? 0 : options.length + 1;

  function onInput(event: ChangeEvent<HTMLInputElement>): void {
    const next = event.target.value;
    setInput(next);
    setChosen(null);
    setError(null);
    clearTimeout(debounce.current);
    requestSeq.current += 1;
    if (next.trim() === '') {
      setOptions([]);
      setOpen(false);
      return;
    }
    debounce.current = setTimeout(() => {
      requestSeq.current += 1;
      const seq = requestSeq.current;
      void identify
        .suggest(pluginId, next.trim())
        .catch((): readonly Candidate[] => [])
        .then((found) => {
          if (seq !== requestSeq.current) return;
          setOptions(found.slice(0, SUGGEST_LIMIT));
          setHighlight(0);
          setOpen(true);
        });
    }, SUGGEST_DEBOUNCE_MS);
  }

  function choose(index: number): void {
    // A choice settles the question: drop a lookup still waiting on its
    // timer and ignore one already in flight, so neither reopens the list.
    clearTimeout(debounce.current);
    debounce.current = undefined;
    requestSeq.current += 1;
    const candidate = options[index];
    if (candidate === undefined) {
      // The look-up option: keep the text, save it by name.
      setChosen(null);
    } else {
      setChosen(candidate.mediaItemId);
      setInput(candidateLabel(candidate));
    }
    setOpen(false);
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      // Closes the list only; the form and the typed text stay.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (optionCount === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : optionCount - 1;
      setHighlight((current) => (current + step) % optionCount);
      return;
    }
    if (event.key === 'Enter' && open) {
      event.preventDefault();
      choose(highlight);
    }
  }

  async function save(): Promise<void> {
    if (pending || trimmed === '') return;
    setPending(true);
    setError(null);
    let finished = false;
    try {
      const outcome = await identify.identify(
        rssItemId,
        chosen !== null ? { mode: 'media-item', mediaItemId: chosen } : { mode: 'name', name: trimmed },
      );
      if ('refusal' in outcome) {
        setError(IDENTIFY_REFUSAL_MESSAGES[outcome.refusal]);
        return;
      }
      finished = true;
      onDone();
    } catch {
      setError(IDENTIFY_REFUSAL_MESSAGES.offline);
    } finally {
      if (!finished) setPending(false);
    }
  }

  // Built conditionally rather than passing `undefined`: under
  // `exactOptionalPropertyTypes` an absent attribute and an undefined one
  // are different things.
  const activeProps = open ? { 'aria-activedescendant': `${optionId}-${String(highlight)}` } : {};

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label id={labelId} htmlFor={inputId}>Title</label>
      <input
        id={inputId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        autoComplete="off"
        value={input}
        onChange={onInput}
        onKeyDown={onKey}
        onBlur={() => {
          setOpen(false);
        }}
        {...activeProps}
      />
      <ul id={listboxId} role="listbox" aria-labelledby={labelId} hidden={!open}>
        {options.map((candidate, index) => (
          <li
            key={candidate.mediaItemId}
            id={`${optionId}-${String(index)}`}
            role="option"
            aria-selected={index === highlight}
            onMouseDown={(event) => {
              event.preventDefault();
              choose(index);
            }}
          >
            {candidateLabel(candidate)}
          </li>
        ))}
        {trimmed !== '' && (
          <li
            id={`${optionId}-${String(lookUpIndex)}`}
            role="option"
            aria-selected={highlight === lookUpIndex}
            onMouseDown={(event) => {
              event.preventDefault();
              choose(lookUpIndex);
            }}
          >
            Look up as "{trimmed}"
          </li>
        )}
      </ul>
      <button type="submit" disabled={trimmed === '' || pending}>
        Save
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error !== null && (
        <div role="alert">
          <span>{error}</span>
        </div>
      )}
    </form>
  );
}
