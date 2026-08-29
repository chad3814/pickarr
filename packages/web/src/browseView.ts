/**
 * Which of Browse's two views the reader chose, persisted per browser.
 *
 * The same shape as `theme.ts`, and for the same reason that file gives: this is
 * a per-browser preference, not an installation setting. Making it one would
 * mean a config field, a migration, and a round trip before first paint.
 */

export type BrowseView = 'list' | 'split';

const STORAGE_KEY = 'pickarr.browseView';

/**
 * Anything other than `'split'` reads as `'list'`, which covers a missing key, a
 * value written by a future version, and a hand-edited one — and makes the card
 * list what a fresh browser gets, so nobody's Browse changes shape without them
 * asking.
 */
export function readView(): BrowseView {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'split' ? 'split' : 'list';
  } catch {
    // `localStorage` does not merely return null in some privacy
    // configurations, it throws on access — see `theme.ts`, which found this
    // first. The degradation is a Browse that forgets, not one that fails.
    return 'list';
  }
}

/** `'list'` removes the key, so "nothing stored" and "chose the default" are one state. */
export function writeView(view: BrowseView): void {
  try {
    if (view === 'list') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, view);
  } catch {
    return;
  }
}
