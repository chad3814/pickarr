import { useEffect, useId, useRef, useState } from 'react';
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
 * inside, and paints a backdrop — three things worth having and none worth
 * hand-rolling.
 *
 * Focus restoration is the one it does *not* deliver here, and this doc claimed
 * it did until somebody checked. Handing focus back to whatever opened the
 * dialog is a step of the close algorithm, and no dismissal below reaches that
 * algorithm: the X and the backdrop call `onClose` and React unmounts the
 * element, and Escape's `onCancel` calls `preventDefault()` before the default
 * close can run. Removing a dialog from the document is not closing it, so
 * focus is left on `<body>` — measured, and pinned by
 * `metadata-modal.spec.ts`. Fixing it means dismissing through `close()` and
 * letting the native `close` event drive `onClose`, which is a change to
 * dismissal behaviour rather than a comment fix; the assertion there fails
 * when someone makes it.
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
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousButton = useRef<HTMLButtonElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  // Generated rather than a literal: `aria-describedby` needs a document-unique
  // id, and nothing stops two cards from each holding modal state.
  const failureId = useId();
  const [index, setIndex] = useState(startIndex);
  // Reset per image, not per modal: a frame that failed must not keep saying so
  // once the user has paged to a different image that loads perfectly well.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element === null || element.open) return;
    element.showModal();
  }, []);

  const image = images[index];
  const hasPrevious = index > 0;
  const hasNext = index < images.length - 1;

  // A step that lands on an end disables the button that caused it (`hasNext`
  // or `hasPrevious` just went false) — and a focused control that becomes
  // disabled is blurred by the browser itself, per the HTML spec, to nothing
  // inside this dialog at all. `<body>` sits outside this `<dialog>`'s own
  // subtree, so the very next arrow-key press has nothing here for it to
  // bubble through and `onKeyDown` below never sees it: a mouse click that
  // reaches an end silently disables the keyboard from then on.
  //
  // Confirmed directly rather than assumed: happy-dom 16.8.1 does not blur a
  // focused element when it becomes `disabled` — `document.activeElement`
  // stays the button — so `ImageModal.test.tsx`'s `fireEvent.keyDown`, aimed
  // at the dialog node regardless of what is focused, could never have
  // observed this bug either way. A real browser's blur-on-disable is what
  // makes it real, and only a real browser (this Playwright spec) can catch
  // it.
  //
  // The reclaim target is the *other* button, not the dialog itself, when
  // there is one to give it to: a keyboard user who just walked to an end
  // still has one button meaningfully left to reach (the one that steps back
  // the way they came), and parking focus elsewhere would cost them an extra
  // Tab to get there. Only a one-image list — which renders no browse chrome
  // at all and so has neither button — reaches the fallback, and that list
  // cannot step either way, so there is nothing to reach regardless of where
  // focus lands.
  //
  // The fallback is the close button rather than the dialog, and that choice
  // is what keeps this effect from needing anything of the `<dialog>` element
  // at all. `.image-modal-close` is always rendered and is focusable in every
  // engine with no `tabindex` on it, where a `<dialog>` is only reliably
  // focusable where an engine chooses to treat an open modal one that way —
  // which was previously papered over with `tabIndex={-1}` on the element and
  // a comment conceding no engine but Chromium had been measured.
  // `preventScroll` is inert today (`.image-modal` is `position: fixed;
  // inset: 0; overflow: hidden`, so nothing here can scroll), kept so this
  // does not start depending on that staying true.
  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (document.activeElement !== null && element.contains(document.activeElement)) return;
    const target = !hasNext ? previousButton.current : !hasPrevious ? nextButton.current : null;
    (target ?? closeButton.current)?.focus({ preventScroll: true });
  }, [index, hasNext, hasPrevious]);

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
      <button
        type="button"
        ref={closeButton}
        className="image-modal-close"
        onClick={onClose}
        aria-label="Close"
      >
        ×
      </button>

      {/*
        * An image is always rendered, even when it failed, so that the dialog
        * keeps exactly one `img` for a caller to find and the failure is a
        * caption over it rather than a different tree.
        *
        * `alt` keeps describing what was meant to be there, and emptying it
        * while failed is not on offer: an `<img>` with an empty alt is not
        * exposed as an `img` at all, and finding this element by that role is
        * how both suites reach it (`dialog.getByRole('img')` in
        * `metadata-modal.spec.ts`, `shown()` in `ImageModal.test.tsx`).
        *
        * Which leaves an `alt` that, on its own, reads to a screen reader as a
        * positive claim the picture arrived. The failure text is what corrects
        * it, and it needs both attributes below to do so: `role="status"`
        * because it appears on `onError` with no user action to prompt a
        * re-read, so nothing else would ever announce it, and
        * `aria-describedby` because an announcement is gone the moment it is
        * made — the description is what is still there for anyone who arrives
        * at, or comes back to, the image afterwards.
        */}
      {image !== undefined && (
        <img
          src={image.src}
          alt={image.alt}
          aria-describedby={failed ? failureId : undefined}
          onError={() => setFailed(true)}
        />
      )}
      {failed && (
        <p className="image-modal-failed" id={failureId} role="status">
          This image could not be loaded
        </p>
      )}

      {/*
        * Chrome renders only for a list worth walking. One image means no
        * controls and no `1 of 1` — the same judgement the card makes for a
        * performer with a face but no full image: opening a control onto
        * nothing is worse than not offering it.
        */}
      {images.length > 1 && image !== undefined && (
        <div className="image-modal-browse">
          <button
            type="button"
            ref={previousButton}
            onClick={() => step(-1)}
            disabled={!hasPrevious}
            aria-label="Previous image"
          >
            ‹
          </button>
          {/*
            * `role="status"` for the same reason the failure text above has
            * one, arrived at from the other direction: a step that lands on an
            * end reclaims focus to the opposite button (see the effect above),
            * so a screen-reader user is not necessarily anywhere near this
            * text at the moment it changes — and it is the only thing on
            * screen that says which image is now shown.
            */}
          <p className="image-modal-caption" role="status">
            {image.label} · {index + 1} of {images.length}
          </p>
          <button
            type="button"
            ref={nextButton}
            onClick={() => step(1)}
            disabled={!hasNext}
            aria-label="Next image"
          >
            ›
          </button>
        </div>
      )}
    </dialog>
  );
}
