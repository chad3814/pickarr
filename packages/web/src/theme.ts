/**
 * The theme, as two separate pieces of state.
 *
 * The *preference* is what the user chose and is one of three values, persisted
 * per browser. The *resolved theme* is what gets painted and is one of two, held
 * in `<html data-theme>` where `tokens.css` keys the palettes on it.
 *
 * Resolution lives here rather than in CSS on purpose. Doing it with
 * `@media (prefers-color-scheme: light)` for the automatic case and
 * `:root[data-theme="light"]` for the manual one needs the light palette written
 * out twice, and two places to edit every colour is a defect waiting for whoever
 * edits one of them.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/**
 * The key the preference persists under, exported for the same reason as
 * {@link LIGHT_QUERY}.
 *
 * `index.html`'s pre-paint script copies this value rather than importing it,
 * and says in its own comment that both contract values are "stated in one
 * place" here. That was half true while this was private: the key was written
 * out in two files with nothing comparing them, and renaming it here would
 * have failed nothing while quietly discarding the stored preference of every
 * existing browser. `theme.test.tsx` now reads both values from this module
 * and looks for them in the html, so the copy cannot drift unnoticed.
 */
export const STORAGE_KEY = 'pickarr.theme';

/**
 * The query `tokens.css` keys its light palette on, and the one
 * `index.html`'s pre-paint script asks before React exists. Exported so the
 * module, that script and the tests all name it in one place.
 *
 * 1.x's `ThemeToggle` was a third caller; 2.0 has no toggle component yet, so
 * `applyTheme` currently has no production caller either -- the pre-paint
 * script is what paints the theme today. This module is the canonical
 * statement of the contract regardless of who is calling it this week.
 */
export const LIGHT_QUERY = '(prefers-color-scheme: light)';

/**
 * Anything other than the two explicit values reads as `system`, which covers a
 * missing key, a value written by a future version, and a hand-edited one. The
 * alternative is putting an unrecognised string into `data-theme`, where it
 * selects neither palette block.
 */
export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    // `localStorage` does not merely return null in some privacy
    // configurations, it throws on access. The degradation is a themed session
    // that forgets, not an unstyled one.
    return 'system';
  }
}

/**
 * `system` removes the key rather than storing the string. A browser with
 * nothing stored and one explicitly set to Auto are then the same state, and
 * "no preference" has one code path instead of two.
 */
export function writePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // As above: a browser that refuses storage still themes this session.
    return;
  }
}

export function systemPrefersLight(): boolean {
  return window.matchMedia(LIGHT_QUERY).matches;
}

/**
 * Pure, and it takes the OS reading as an argument rather than fetching it, so
 * the interesting half is testable without a DOM and the caller decides when to
 * re-read.
 */
export function resolve(preference: ThemePreference, systemLight: boolean): ResolvedTheme {
  if (preference !== 'system') return preference;
  return systemLight ? 'light' : 'dark';
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', theme);
}
