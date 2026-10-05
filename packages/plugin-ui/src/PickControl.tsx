/**
 * The Pick button and its refusal line, shared by a card's release rows
 * (`ReleaseList.tsx`) and the unmatched page's cards
 * (`web/src/library/Unmatched.tsx`), so the two cannot drift in what they
 * say or when they say it.
 *
 * **What it does and does not know.** It knows how to ask (`submit`), what
 * the button says while asking (`PICK_LABELS`), and what each refusal
 * reads as (`PICK_REFUSAL_MESSAGES`). It does not know whether a pick has
 * landed: an accepted pick leaves the button at `Picking…` and disabled,
 * and the caller stops rendering this control once the download row
 * replicates and a status takes its place -- which is why acceptance is
 * never reported here. A refusal, or a submit that rejects outright,
 * re-enables the button and announces one sentence.
 *
 * **Named by two strings that are both on screen.** `aria-labelledby`
 * points at this button's own id and at the caller's `labelledBy` -- the
 * release's filename span -- so the button announces as `Pick <filename>`
 * while reading as `Pick`. The refusal is real text in a real element, not
 * an `aria-label`, for `CLAUDE.md`'s reason: the announced string and the
 * visible one are the same string.
 */
import { useState, type ReactElement } from 'react';
import { PICK_REFUSAL_MESSAGES, type PickSubmit } from './types.ts';

export const PICK_LABELS = { idle: 'Pick', pending: 'Picking…' } as const;

export interface PickControlProps {
  /** The release to pick. */
  readonly rssItemId: number;
  /** This button's own id, so a caller's other controls can be named alongside it. */
  readonly id: string;
  /** The id of the on-screen element naming the release, which the button is labelled with. */
  readonly labelledBy: string;
  readonly submit: PickSubmit;
}

export function PickControl({ rssItemId, id, labelledBy, submit }: PickControlProps): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(): Promise<void> {
    setPending(true);
    setError(null);
    let accepted = false;
    try {
      const outcome = await submit(rssItemId);
      if ('accepted' in outcome) {
        accepted = true;
        return;
      }
      setError(PICK_REFUSAL_MESSAGES[outcome.refusal]);
    } catch {
      setError(PICK_REFUSAL_MESSAGES.offline);
    } finally {
      if (!accepted) setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        id={id}
        aria-labelledby={`${id} ${labelledBy}`}
        disabled={pending}
        onClick={() => {
          void pick();
        }}
      >
        {pending ? PICK_LABELS.pending : PICK_LABELS.idle}
      </button>
      {error !== null && (
        <div role="alert">
          <span>{error}</span>
        </div>
      )}
    </>
  );
}
