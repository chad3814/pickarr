import type { BrowseView } from '../browseView.ts';

const OPTIONS: ReadonlyArray<{ value: BrowseView; label: string }> = [
  { value: 'list', label: 'List' },
  { value: 'split', label: 'Split' },
];

/**
 * Radios in a fieldset, the same shape `ThemeToggle` uses and for the reason it
 * states: a radio group gives one accessible group name and arrow-key movement
 * without any JavaScript of ours.
 *
 * Controlled, unlike `ThemeToggle`, which owns its own preference because it
 * also has to apply a theme to `<html>`. Here the route holds the view — it
 * decides what to render from it — so this component only reports a choice.
 */
export function ViewToggle({ view, onChange }: { view: BrowseView; onChange: (view: BrowseView) => void }) {
  return (
    <fieldset className="view-toggle">
      {/* The group's accessible name. Hidden visually because two labels
          reading List and Split already say what this is. */}
      <legend className="visually-hidden">View</legend>
      {OPTIONS.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name="browse-view"
            value={option.value}
            checked={view === option.value}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
