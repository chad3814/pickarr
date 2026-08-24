import { useEffect, useState } from 'react';
import {
  LIGHT_QUERY,
  applyTheme,
  readPreference,
  resolve,
  systemPrefersLight,
  writePreference,
  type ThemePreference,
} from '../theme.ts';

/**
 * Radios rather than a two-state switch, because "follow the OS" is what the app
 * did before there was any control at all, and a switch that can only say light
 * or dark removes a behaviour instead of adding one. Radios rather than three
 * buttons because a radio group inside a fieldset gives one accessible group
 * name and arrow-key movement without any JavaScript of ours.
 */
const OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);

  useEffect(() => {
    applyTheme(resolve(preference, systemPrefersLight()));

    // The listener is only meaningful while the OS is what decides. An explicit
    // preference is an answer, and an operating system that switches on a
    // schedule must not overrule it.
    if (preference !== 'system') return;

    const query = window.matchMedia(LIGHT_QUERY);
    const onChange = (): void => {
      applyTheme(resolve('system', query.matches));
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [preference]);

  function choose(next: ThemePreference): void {
    writePreference(next);
    setPreference(next);
  }

  return (
    <fieldset className="theme-toggle">
      {/* The group's accessible name. Hidden visually because the three labels
          already say what this is to anyone who can see it. */}
      <legend className="visually-hidden">Theme</legend>
      {OPTIONS.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={preference === option.value}
            onChange={() => choose(option.value)}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
