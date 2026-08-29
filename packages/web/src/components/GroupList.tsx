import { useEffect, useRef } from 'react';
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
 * route renders the sentinel after this list exactly as it does after the card
 * list, and the pane beside it is the route's business.
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
 * the list rather than skipping it.
 */
export function GroupList({ groups, selectedId, onSelect }: Props) {
  const selectedRow = useRef<HTMLLIElement | null>(null);

  // The selected row is scrolled into view when selection changes, which is
  // what makes arrow movement usable on a list longer than the window. Not on
  // every render: the route re-renders this list whenever a metadata answer
  // lands for any group on screen, and scrolling then would yank the page
  // under a reader who had not moved.
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  function step(by: number): void {
    if (groups.length === 0) return;
    const current = groups.findIndex((group) => group.id === selectedId);
    // Nothing selected yet: ArrowDown takes the first row, ArrowUp does
    // nothing. Starting at the last row for ArrowUp would move the reader to
    // the far end of a paged list on one keypress.
    if (current === -1) {
      if (by > 0) onSelect(groups[0]!.id);
      return;
    }
    const next = current + by;
    // Clamped rather than wrapped: a list that grows by paging has no
    // meaningful end to wrap to, and arriving at the top from the bottom reads
    // as a jump rather than a move.
    if (next < 0 || next >= groups.length) return;
    onSelect(groups[next]!.id);
  }

  const tabStopId = selectedId ?? groups[0]?.id ?? null;

  return (
    <ul
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
        const studio = group.display.subtitle;
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
              {studio !== undefined && <span>{studio}</span>}
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
