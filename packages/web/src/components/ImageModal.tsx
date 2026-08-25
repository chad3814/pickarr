import { useEffect, useRef, useState } from 'react';
import type { GroupImage } from '../api/groupImages.ts';

interface Props {
  images: readonly GroupImage[];
  /** Which image opens. The card slot passes 0; a performer avatar passes its own entry. */
  startIndex: number;
  onClose: () => void;
}

/**
 * A full-size image over the page, browsable when the group has more than one,
 * closed by the X, a click outside, or Escape.
 *
 * Built on a native `<dialog>` opened with `showModal()` rather than a
 * positioned div: that is what makes the rest of the page inert, traps focus
 * inside, restores it on close, and paints a backdrop — four things worth
 * having and none worth hand-rolling.
 *
 * Escape is the browser's, surfaced through `cancel` so the React state that
 * owns "which image is open" is updated rather than left describing a dialog
 * the DOM has already closed. Note that happy-dom does not implement it, so
 * this path is covered by a Playwright spec and not by the unit tests beside
 * this file.
 *
 * The browse index lives here rather than in the card. The card owns *which
 * list* is open and where it starts; how far through it the user has walked is
 * this component's own business, and putting it in the card would make every
 * arrow press a state update on an element that renders a whole article.
 */
export function ImageModal({ images, startIndex, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(startIndex);
  // Reset per image, not per modal: a frame that failed must not keep saying so
  // once the user has paged to a different image that loads perfectly well.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element === null || element.open) return;
    element.showModal();
  }, []);

  // A step that lands on an end disables the button that caused it (`hasNext`
  // or `hasPrevious` just went false) — and a focused control that becomes
  // disabled is blurred by the browser itself, per the HTML spec, to nothing
  // inside this dialog at all. `<body>` sits outside this `<dialog>`'s own
  // subtree, so the very next arrow-key press has nothing here for it to
  // bubble through and `onKeyDown` above never sees it: a mouse click that
  // reaches an end silently disables the keyboard from then on. Reclaiming
  // focus for the dialog itself whenever it has drifted outside keeps the
  // keyboard working exactly as far as a mouse does, which `step`'s clamping
  // promises but cannot deliver once focus has left the subtree it depends
  // on.
  //
  // Confirmed directly rather than assumed: happy-dom 16.8.1 does not blur a
  // focused element when it becomes `disabled` — `document.activeElement`
  // stays the button — so `ImageModal.test.tsx`'s `fireEvent.keyDown`, aimed
  // at the dialog node regardless of what is focused, could never have
  // observed this bug either way. A real browser's blur-on-disable is what
  // makes it real, and only a real browser (this Playwright spec) can catch
  // it.
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (document.activeElement === null || !element.contains(document.activeElement)) {
      element.focus();
    }
  }, [index]);

  const image = images[index];
  const hasPrevious = index > 0;
  const hasNext = index < images.length - 1;

  function step(by: number): void {
    // Clamped rather than wrapped, and clamped here rather than only in the
    // buttons' `disabled`: the arrow keys reach this too, and a keyboard user
    // must not be able to walk off an end a mouse user cannot.
    const next = Math.min(Math.max(index + by, 0), images.length - 1);
    if (next === index) return;
    setIndex(next);
    setFailed(false);
  }

  return (
    <dialog
      ref={dialog}
      // Not in the tab order (a user tabs into its buttons, never the dialog
      // chrome itself) but a valid target for the `element.focus()` call
      // above, which needs the dialog to be focusable at all.
      tabIndex={-1}
      className="image-modal"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      // A click on the backdrop of a native modal targets the dialog itself;
      // a click on anything inside targets that child. Comparing the target
      // to the element is the whole of "clicked outside".
      onClick={(event) => { if (event.target === dialog.current) onClose(); }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') step(1);
        if (event.key === 'ArrowLeft') step(-1);
      }}
    >
      <button type="button" className="image-modal-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      {/*
        * An image is always rendered, even when it failed, so that the dialog
        * keeps exactly one `img` for a caller to find and the failure is a
        * caption over it rather than a different tree. `alt` still describes
        * what was meant to be there, which is what a screen reader needs when
        * the bytes never arrived.
        */}
      {image !== undefined && (
        <img src={image.src} alt={image.alt} onError={() => setFailed(true)} />
      )}
      {failed && <p className="image-modal-failed">This image could not be loaded</p>}

      {/*
        * Chrome renders only for a list worth walking. One image means no
        * controls and no `1 of 1` — the same judgement the card makes for a
        * performer with a face but no full image: opening a control onto
        * nothing is worse than not offering it.
        */}
      {images.length > 1 && image !== undefined && (
        <div className="image-modal-browse">
          <button type="button" onClick={() => step(-1)} disabled={!hasPrevious} aria-label="Previous image">
            ‹
          </button>
          <p className="image-modal-caption">
            {image.label} · {index + 1} of {images.length}
          </p>
          <button type="button" onClick={() => step(1)} disabled={!hasNext} aria-label="Next image">
            ›
          </button>
        </div>
      )}
    </dialog>
  );
}
