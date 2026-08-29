import { useEffect, useRef } from 'react';
import { text } from '../api/format.ts';
import { groupTitle } from '../api/groupTitle.ts';
import type { GroupView } from '../api/client.ts';

interface Props {
  groups: readonly GroupView[];
  /** The selected group's id, or `null` for nothing selected. */
  selectedId: number | null;
  onSelect: (groupId: number) => void;
}

/**
 * The dense half of Browse's split view: one row per group, selection and
 * keyboard movement, and nothing else. No card, no paging, no metadata — the
 * paging sentinel is outside this list, after the whole split row (spec §6),
 * and the pane beside it is the route's business.
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
export function GroupList({ groups, selectedId, onSelect }: Props) {
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
  // caller setting `selectedId` itself — and pulling focus across the page for
  // that would be worse than saying nothing.
  useEffect(() => {
    const row = selectedRow.current;
    if (row === null) return;
    row.scrollIntoView({ block: 'nearest' });
    if (list.current?.contains(document.activeElement) === true) row.focus();
  }, [selectedId]);

  function step(by: number): void {
    const current = groups.findIndex((group) => group.id === selectedId);
    // Nothing selected yet: ArrowDown takes the first row, ArrowUp does
    // nothing. Starting at the last row for ArrowUp would move the reader to
    // the far end of a paged list on one keypress.
    if (current === -1) {
      if (by > 0) {
        const first = groups[0];
        if (first !== undefined) onSelect(first.id);
      }
      return;
    }
    const next = current + by;
    // The bounds check is the index read, not a separate guard before it.
    // `noUncheckedIndexedAccess` types `groups[next]` as possibly undefined, so
    // handling that *is* the clamp — and removing it is a compile error rather
    // than a `TypeError` thrown inside a keydown handler, which is what a
    // non-null assertion here would have hidden. Clamped rather than wrapped:
    // a list that grows by paging has no meaningful end to wrap to, and
    // arriving at the top from the bottom reads as a jump rather than a move.
    const target = groups[next];
    if (target === undefined) return;
    onSelect(target.id);
  }

  const tabStopId = selectedId ?? groups[0]?.id ?? null;

  return (
    <ul
      ref={list}
      className="group-list"
      role="listbox"
      aria-label="Groups"
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); step(1); }
        if (event.key === 'ArrowUp') { event.preventDefault(); step(-1); }
      }}
    >
      {groups.map((group) => {
        const selected = group.id === selectedId;
        // `text`, not a `!== undefined` check: `''` is a value the
        // plugin-facing `DisplayFields` contract allows, and it would render an
        // empty span that the sibling separator below then decorates, so the
        // row reads " · 1 release". The same helper `MediaCard` uses for the
        // card's context line, which is what makes the parity below real.
        const studio = text(group.display.subtitle);
        const count = `${group.releases.length} release${group.releases.length === 1 ? '' : 's'}`;
        return (
          <li
            key={group.id}
            ref={selected ? selectedRow : null}
            className={selected ? 'group-row group-row-selected' : 'group-row'}
            role="option"
            aria-selected={selected}
            tabIndex={group.id === tabStopId ? 0 : -1}
            onClick={() => onSelect(group.id)}
          >
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
          </li>
        );
      })}
    </ul>
  );
}
