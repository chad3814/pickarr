import { useEffect, useRef } from 'react';

interface Props {
  src: string;
  alt: string;
  onClose: () => void;
}

/**
 * A full-size image over the page, closed by the X, a click outside, or
 * Escape.
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
 */
export function ImageModal({ src, alt, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (element === null || element.open) return;
    element.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="image-modal"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      // A click on the backdrop of a native modal targets the dialog itself;
      // a click on anything inside targets that child. Comparing the target
      // to the element is the whole of "clicked outside".
      onClick={(event) => { if (event.target === dialog.current) onClose(); }}
    >
      <button type="button" className="image-modal-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <img src={src} alt={alt} />
    </dialog>
  );
}
