import { useEffect, useRef } from 'react';
import { text } from '../api/format.ts';
import { groupTitle } from '../api/groupTitle.ts';
import type { BrowseItem } from '../api/client.ts';

/**
 * Addresses one row of the split view's list: which kind, and that kind's own
 * id. A bare id cannot do this alone — `media_groups.id` and `feed_items.id`
 * are unrelated namespaces minted by separate tables, so once a failed row
 * and a group row can both be on screen, `id === 7` names two different rows.
 */
export interface BrowseSelection {
  kind: 'group' | 'failed';
  id: number;
}

interface Props {
  items: readonly BrowseItem[];
  /** The selected row, or `null` for nothing selected. */
  selected: BrowseSelection | null;
  onSelect: (selected: BrowseSelection) => void;
}

/** The selection that addresses this row. */
function selectionFor(item: BrowseItem): BrowseSelection {
  return item.kind === 'group' ? { kind: 'group', id: item.group.id } : { kind: 'failed', id: item.item.id };
}

/**
 * Whether a selection addresses this row. Both halves, always — comparing
 * `id` alone would call a failed row and a group row the same row whenever
 * the two tables that mint their ids happen to agree on a number.
 */
export function matchesSelection(item: BrowseItem, selection: BrowseSelection | null): boolean {
  if (selection === null) return false;
  const own = selectionFor(item);
  return own.kind === selection.kind && own.id === selection.id;
}

/** A row's own content: title, and for a group its studio, release count and upgrade marker. */
function rowContent(item: BrowseItem) {
  if (item.kind === 'failed') {
    // No metadata, no releases, nothing else to show — the row exists so the
    // reader can pick the failed name, not to summarise it. `rawTitle` is
    // also its whole accessible name.
    return <span className="group-row-title">{item.item.rawTitle}</span>;
  }
  const group = item.group;
  // `text`, not a `!== undefined` check: `''` is a value the plugin-facing
  // `DisplayFields` contract allows, and it would render an empty span that
  // the sibling separator below then decorates, so the row reads
  // " · 1 release". The same helper `MediaCard` uses for the card's context
  // line, which is what makes the parity below real.
  const studio = text(group.display.subtitle);
  const count = `${group.releases.length} release${group.releases.length === 1 ? '' : 's'}`;
  return (
    <>
      <span className="group-row-title">{groupTitle(group)}</span>
      {/*
        * One span per part, with the ` · ` drawn by CSS between adjacent
        * siblings rather than joined here — the same treatment the card's
        * context line uses, and for the same reason: a group with no
        * studio must not render a leading separator.
        */}
      <span className="group-row-meta">
        {studio !== null && <span>{studio}</span>}
        <span>{count}</span>
      </span>
      {group.upgradeReleaseId !== null && (
        <span className="group-row-upgrade" aria-label="Upgrade available">↑</span>
      )}
    </>
  );
}

/**
 * The dense half of Browse's split view: one row per loaded item — a group or
 * a name the parser refused, interleaved in the order the server sent them —
 * selection and keyboard movement, and nothing else. No card, no paging, no
 * metadata — the paging sentinel is outside this list, after the whole split
 * row (spec §6), and the pane beside it is the route's business.
 *
 * A listbox rather than a list of buttons. Single selection out of many options
 * is what `role="listbox"` describes, and it brings the contract with it: the
 * selected option is announced as selected rather than merely styled, and the
 * arrows are the expected way to move. A column of buttons would announce
 * nothing about selection and would put every row in the tab order — hundreds
 * of stops on a paged list, between the search box and whatever follows.
 *
 * The roving `tabIndex` is what keeps the whole list one tab stop. With nothing
 * selected the first row carries it, so a reader arriving by keyboard reaches
 * the list rather than skipping it. Moving DOM focus onto the newly selected
 * row is the other half of that pattern, and it is what makes the announcement
 * actually happen — see the effect below. `aria-activedescendant` is the
 * alternative way to spell the same contract and it conflicts with a roving
 * `tabIndex`, so this component uses one of the two, not both.
 */
export function GroupList({ items, selected, onSelect }: Props) {
  const list = useRef<HTMLUListElement | null>(null);
  const selectedRow = useRef<HTMLLIElement | null>(null);

  // The selected row is scrolled into view and takes focus when selection
  // changes, which is what makes arrow movement usable on a list longer than
  // the window and what makes it audible at all. Not on every render: the route
  // re-renders this list whenever a metadata answer lands for any group on
  // screen, and scrolling or refocusing then would yank the page under a reader
  // who had not moved.
  //
  // Focus rather than `aria-activedescendant` (see the doc above): with a roving
  // `tabIndex` and no focus move, `aria-selected` changes on an element that is
  // neither focused nor pointed at, so there is no accessibility event and a
  // screen reader is told nothing — while a sighted keyboard reader gets two
  // disagreeing "you are here" marks, `:focus-visible`'s ring left on the row
  // they arrived at and `.group-row-selected`'s accent bar on the row the arrows
  // moved to.
  //
  // Only when the list already holds focus. Selection can change without the
  // reader being in the list — a row clicked with the pointer, or a future
  // caller setting `selected` itself — and pulling focus across the page for
  // that would be worse than saying nothing.
  useEffect(() => {
    const row = selectedRow.current;
    if (row === null) return;
    row.scrollIntoView({ block: 'nearest' });
    if (list.current?.contains(document.activeElement) === true) row.focus();
  }, [selected]);

  function step(by: number): void {
    const current = items.findIndex((item) => matchesSelection(item, selected));
    // Nothing selected yet: ArrowDown takes the first row, ArrowUp does
    // nothing. Starting at the last row for ArrowUp would move the reader to
    // the far end of a paged list on one keypress.
    if (current === -1) {
      if (by > 0) {
        const first = items[0];
        if (first !== undefined) onSelect(selectionFor(first));
      }
      return;
    }
    const next = current + by;
    // The bounds check is the index read, not a separate guard before it.
    // `noUncheckedIndexedAccess` types `items[next]` as possibly undefined, so
    // handling that *is* the clamp — and removing it is a compile error rather
    // than a `TypeError` thrown inside a keydown handler, which is what a
    // non-null assertion here would have hidden. Clamped rather than wrapped:
    // a list that grows by paging has no meaningful end to wrap to, and
    // arriving at the top from the bottom reads as a jump rather than a move.
    const target = items[next];
    if (target === undefined) return;
    onSelect(selectionFor(target));
  }

  const first = items[0];
  const tabStop = selected ?? (first !== undefined ? selectionFor(first) : null);

  return (
    <ul
      ref={list}
      className="group-list"
      role="listbox"
      aria-label="Groups and refused names"
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); step(1); }
        if (event.key === 'ArrowUp') { event.preventDefault(); step(-1); }
      }}
    >
      {items.map((item) => {
        const rowSelected = matchesSelection(item, selected);
        // Prefixed by kind: a group and a failed item can carry the same
        // numeric id, since the two are minted from separate tables, and both
        // kinds can land as siblings in this list.
        const key = item.kind === 'group' ? `group-${item.group.id}` : `failed-${item.item.id}`;
        return (
          <li
            key={key}
            ref={rowSelected ? selectedRow : null}
            className={rowSelected ? 'group-row group-row-selected' : 'group-row'}
            role="option"
            aria-selected={rowSelected}
            tabIndex={matchesSelection(item, tabStop) ? 0 : -1}
            onClick={() => onSelect(selectionFor(item))}
          >
            {rowContent(item)}
          </li>
        );
      })}
    </ul>
  );
}
