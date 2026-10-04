/**
 * The category page's picked filter and search box (design spec 2026-10-02
 * §3.2). Controlled: `useBrowseQuery` owns the state and the URL. No class
 * attributes -- `styles/library.css` reaches this form by structure.
 */
import type { ReactElement } from 'react';
import type { PickedFilter } from '../store/catalog.ts';
import type { BrowseView } from './useBrowseQuery.ts';

export interface BrowseControlsProps {
  filter: PickedFilter;
  input: string;
  onFilter(f: PickedFilter): void;
  onInput(v: string): void;
  view: BrowseView;
  onView(v: BrowseView): void;
}

const OPTIONS: ReadonlyArray<{ value: PickedFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'picked', label: 'Picked' },
  { value: 'unpicked', label: 'Unpicked' },
];

const VIEWS: ReadonlyArray<{ value: BrowseView; label: string }> = [
  { value: 'list', label: 'List' },
  { value: 'grid', label: 'Grid' },
];

export function BrowseControls({ filter, input, onFilter, onInput, view, onView }: BrowseControlsProps): ReactElement {
  return (
    <form
      role="search"
      aria-label="Filter and search"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <fieldset>
        <legend>Show</legend>
        {OPTIONS.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name="filter"
              value={option.value}
              checked={filter === option.value}
              onChange={() => {
                onFilter(option.value);
              }}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>View</legend>
        {VIEWS.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name="view"
              value={option.value}
              checked={view === option.value}
              onChange={() => {
                onView(option.value);
              }}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <label>
        Search
        <input
          type="search"
          autoComplete="off"
          value={input}
          onChange={(event) => {
            onInput(event.currentTarget.value);
          }}
        />
      </label>
    </form>
  );
}
