/**
 * A modal over one subject's images -- a media item's, or one person's.
 *
 * **It shows whatever list it is handed, not a fixed number of pictures.**
 * The artwork job keeps up to five posters, backgrounds and logos per media
 * item and up to five pictures per person, replicated as ranked lists
 * (`GatheredArtworkView`, issue #79). This component takes whatever list it
 * is handed, so widening what a gallery shows needs no change here.
 *
 * **A 404 is ordinary.** Most items have a poster and neither of the other
 * two, so an image that fails to load is dropped rather than shown broken,
 * the same way `MediaItemCard` drops its browse poster. A subject whose
 * every image fails asks to be closed: an empty frame under a caption
 * reads as a bug, and there is nothing to look at.
 */
import type { KeyboardEvent, ReactElement } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

/** One image and who it is of -- the attribution shown beneath it. */
export interface GalleryImage {
  readonly url: string;
  /** The media item's title, or the person's name. */
  readonly caption: string;
}

export interface GalleryProps {
  /**
   * Every image for one card, in the order they are walked: the media
   * item's own, then each cast member's.
   *
   * One list rather than one gallery per subject, because the attribution
   * is per image -- a card's gallery shows the title under its poster and
   * a person's name under theirs, which only means anything if both are
   * reachable from the same set of arrows.
   */
  readonly images: readonly GalleryImage[];
  /**
   * Which image to open on, by url. A url rather than an index because
   * images that fail to load leave the set, so an index taken before a
   * failure points somewhere else after one. A url that is not in
   * `images`, or has already failed, opens on the first surviving image.
   */
  readonly startUrl: string;
  readonly onClose: () => void;
}

/**
 * The url to show once `dead` is gone: the next image after it that has
 * not already failed, wrapping past the end.
 *
 * Walks `images` rather than the surviving subset so the answer is
 * positional in the list the caller built -- media slots then cast -- and
 * not in a list that is about to change shape. Answers `undefined` when
 * `dead` was the last survivor, which is the case the all-failed effect
 * closes on.
 */
function nextSurvivor(
  images: readonly GalleryImage[],
  failed: readonly string[],
  dead: string,
): string | undefined {
  const from = images.findIndex((image) => image.url === dead);
  for (let step = 1; step <= images.length; step += 1) {
    const candidate = images[(from + step + images.length) % images.length];
    if (candidate === undefined) continue;
    if (candidate.url !== dead && !failed.includes(candidate.url)) return candidate.url;
  }
  return undefined;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function Gallery({ images, startUrl, onClose }: GalleryProps): ReactElement | null {
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<readonly string[]>([]);
  const [currentUrl, setCurrentUrl] = useState(startUrl);

  const showing = images.filter((image) => !failed.includes(image.url));
  /**
   * Where in the surviving set the image on screen sits.
   *
   * **`-1` is handled by moving on, never by falling back to 0**, and the
   * difference is a reported bug. This used to be
   * `Math.max(0, findIndex(...))`, so the moment the current url left the
   * set -- which is exactly what stepping onto a missing image does, since
   * rendering it fires `error` -- the lookup answered `-1` and the gallery
   * snapped back to the first image. With a logo missing, walking forward
   * went poster, background, poster, background, losing one image per lap
   * and never reaching the cast. The failure handler now names the next
   * survivor before dropping the dead url, so `currentUrl` is always a url
   * that is still in the set and this only ever falls back on a `startUrl`
   * the caller got wrong.
   */
  const found = showing.findIndex((image) => image.url === currentUrl);
  const index = found === -1 ? 0 : found;
  const current = showing[index];

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
    if (images.length > 0 && showing.length === 0) onClose();
  }, [images.length, showing.length, onClose]);

  if (images.length === 0 || current === undefined) return null;

  /** Walks the surviving images, wrapping at both ends. */
  function step(by: number): void {
    const next = showing[(index + by + showing.length) % showing.length];
    if (next !== undefined) setCurrentUrl(next.url);
  }

  // Keeps Tab and Shift+Tab inside the dialog: leaving its focusable
  // elements at either end wraps to the other end instead of escaping to
  // the page behind the backdrop, which is also where the Escape handler
  // lives -- focus leaving the subtree would take Escape with it.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    // Arrow keys walk the set, the same way the buttons do. Without them
    // the only way through a gallery is the mouse, which is the gap the
    // focus trap above exists to avoid everywhere else.
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      step(event.key === 'ArrowRight' ? 1 : -1);
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
        <h2 id={headingId}>{current.caption}</h2>
        {/*
          One image, keyed by url so React swaps the element rather than
          reusing it: a reused `<img>` keeps painting the previous picture
          until the next decodes, which reads as the arrows not working.
        */}
        <img
          key={current.url}
          src={current.url}
          alt={current.caption}
          onError={() => {
            const dead = current.url;
            // Move first, drop second. The next survivor is chosen from
            // `images` -- the full list, in its original order -- rather
            // than from `showing`, because `showing` still contains the
            // dead url at this point and will not a render later. Picking
            // from the full list means the position survives the removal
            // instead of being re-derived from a set the current url has
            // just left.
            const next = nextSurvivor(images, failed, dead);
            if (next !== undefined) setCurrentUrl(next);
            setFailed((previous) => (previous.includes(dead) ? previous : [...previous, dead]));
          }}
        />
        <p className="gallery-controls">
          {/*
            Both arrows render whenever there is more than one image, and
            wrap rather than disabling at the ends -- a disabled control a
            keyboard user has tabbed to is a dead end with no announcement.
          */}
          {showing.length > 1 && (
            <button type="button" aria-label="Previous image" onClick={() => { step(-1); }}>←</button>
          )}
          <span>{index + 1} of {showing.length}</span>
          {showing.length > 1 && (
            <button type="button" aria-label="Next image" onClick={() => { step(1); }}>→</button>
          )}
        </p>
        <button type="button" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
