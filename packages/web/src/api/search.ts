import type { DisplayFields } from './client.ts';

/**
 * Everything about a group a search term is allowed to match, as one string.
 *
 * A deliberate mirror of `searchTextFor` in `packages/core/src/ingest/commit.ts`
 * — the function that fills the `search_text` column `/api/browse?q=` matches
 * against. Same four parts (title, subtitle, date, every field *value*), same
 * order, same lowercasing, and notably no labels: `Site` being a field's label
 * must not make every group with a Site field a hit for "site".
 *
 * The mirror is the point. Picks filters what it already holds rather than
 * asking the server — `/api/picks` answers everything picked in one response,
 * so there is nothing off-screen for a query to reach and a round trip per
 * keystroke would buy nothing — and this is what keeps one term from finding a
 * group on Browse and missing it on Picks.
 *
 * Core additionally guards each part with a `typeof === 'string'` check because
 * it is reading raw plugin output, where a field's `value` may be anything. By
 * the time a `DisplayFields` has been serialized into a `GroupView` and back it
 * has already been through that, so the optional keys are the only absences
 * left to skip here.
 */
export function groupSearchText(display: DisplayFields): string {
  const parts = [display.title];
  if (display.subtitle !== undefined) parts.push(display.subtitle);
  if (display.date !== undefined) parts.push(display.date);
  for (const field of display.fields) parts.push(field.value);
  return parts.join(' ').toLowerCase();
}

/**
 * Whether `text` satisfies what the reader typed. An empty term — or one that
 * is only whitespace, which is what a half-deleted query leaves behind — matches
 * everything, so an empty box is not a filter and clearing one restores the
 * whole list.
 *
 * A plain substring test: `%` and `_` mean themselves. The server matches the
 * same way — `/api/browse?q=` goes through SQLite's `instr` rather than a
 * `LIKE` pattern (issue #32) — so a term containing either character finds the
 * same groups on Browse as it does here. Picks and Downloads filter in the
 * client for the reason given above, that `/api/picks` answers everything
 * picked in one response, not to dodge a difference in matching.
 *
 * `text` is lowercased here rather than only in `groupSearchText`, because not
 * every caller has one: Downloads passes a download's title and an untracked
 * entry's name straight in. Lowercasing an already-lowercased haystack costs
 * nothing and means neither caller has to remember which side does it.
 */
export function matchesTerm(term: string, text: string): boolean {
  const needle = term.trim().toLowerCase();
  return needle.length === 0 || text.toLowerCase().includes(needle);
}
