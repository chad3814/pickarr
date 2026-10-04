/**
 * A modal dialog: a backdrop that closes on click, a panel with
 * `role="dialog"` and `aria-modal`, focus moved in on open and returned to
 * the opener on close, Escape, and a Tab trap. Lifted out of `Gallery`
 * (design spec 2026-10-04 §2.3) so the gallery and the grid's item dialog
 * share one implementation rather than two drifting copies.
 *
 * The caller styles the panel through `className` -- `library.css` has a
 * rule per dialog kind -- and the backdrop is always `dialog-backdrop`, the
 * one rule they share. A dialog that is merely in the accessibility tree
 * renders as an unstyled block (CLAUDE.md's IdentityChangeConfirm entry),
 * which is why the class is part of the contract and not decoration.
 */
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

export interface DialogProps {
  readonly label?: string;
  readonly labelledBy?: string;
  readonly className: string;
  readonly onClose: () => void;
  /** Receives every key except Escape and Tab, which the dialog handles itself. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Dialog({ label, labelledBy, className, onClose, onKeyDown, children }: DialogProps): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus moves in on open so Escape and Tab reach the dialog rather than
  // the page behind the backdrop, and goes back to the opener on close if
  // the opener is still in the document.
  useEffect(() => {
    const opener = document.activeElement;
    panelRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') {
      onKeyDown?.(event);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={handleKeyDown}
        onClick={(event) => { event.stopPropagation(); }}
      >
        {children}
      </div>
    </div>
  );
}
