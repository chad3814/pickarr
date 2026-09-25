/**
 * A modal over one subject's images -- a media item's, or one person's.
 *
 * **It holds fewer pictures than the name suggests, and that is known.**
 * The artwork job stores one poster, one background and one logo per media
 * item and one picture per person, so a media gallery is at most three
 * images and a person's is exactly one. Storing every image a provider
 * returns is issue #79; this component is built so that widening storage
 * needs no change here.
 *
 * **A 404 is ordinary.** Most items have a poster and neither of the other
 * two, so an image that fails to load is dropped rather than shown broken,
 * the same way `MediaItemCard` drops its browse poster. A subject whose
 * every image fails asks to be closed: an empty frame under a caption
 * reads as a bug, and there is nothing to look at.
 */
import type { KeyboardEvent, ReactElement } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

export interface GalleryProps {
  readonly urls: readonly string[];
  /** The media item's title or the person's name, shown as the heading. */
  readonly caption: string;
  readonly onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Gallery({ urls, caption, onClose }: GalleryProps): ReactElement | null {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<readonly string[]>([]);

  const showing = urls.filter((url) => !failed.includes(url));

  // Focus moves in on open so Escape and Tab reach the dialog rather than
  // the page behind it, and back out on close: to the control that opened
  // it, not the top of the document.
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus();
      }
    };
  }, []);

  // Every image failed: there is nothing to show. Asked for in an effect
  // rather than during render, because calling a parent's setter while
  // rendering is a React error.
  useEffect(() => {
    if (urls.length > 0 && showing.length === 0) onClose();
  }, [urls.length, showing.length, onClose]);

  if (urls.length === 0) return null;

  // Keeps Tab and Shift+Tab inside the dialog: leaving its focusable
  // elements at either end wraps to the other end instead of escaping to
  // the page behind the backdrop, which is also where the Escape handler
  // lives -- focus leaving the subtree would take Escape with it.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !dialog.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="gallery-backdrop" onClick={onClose}>
      <div
        className="gallery"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={handleKeyDown}
        // The backdrop closes on click; a click on the dialog itself must
        // not bubble up to it and close the thing being looked at.
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <h2 id={headingId}>{caption}</h2>
        {showing.map((url) => (
          <img
            key={url}
            src={url}
            alt={caption}
            onError={() => {
              setFailed((previous) => (previous.includes(url) ? previous : [...previous, url]));
            }}
          />
        ))}
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
