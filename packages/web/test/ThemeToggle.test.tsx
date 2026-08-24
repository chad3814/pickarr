import { test, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ThemeToggle } from '../src/components/ThemeToggle.tsx';

/**
 * A fully typed stand-in, built on EventTarget so `addEventListener`,
 * `removeEventListener` and `dispatchEvent` come from the platform with their
 * real signatures. `implements MediaQueryList` then needs only the four members
 * EventTarget does not supply, and no cast is required anywhere.
 */
class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  matches: boolean;
  readonly media = '(prefers-color-scheme: light)';
  onchange = null;

  constructor(matches: boolean) {
    super();
    this.matches = matches;
  }

  addListener(): void {}
  removeListener(): void {}
}

let fake: FakeMediaQueryList;
let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  fake = new FakeMediaQueryList(false);
  originalMatchMedia = window.matchMedia;
  window.matchMedia = () => fake;
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  cleanup();
});

test('the control is a named group of three radios', () => {
  render(<ThemeToggle />);
  assert.ok(screen.getByRole('group', { name: /theme/i }));
  assert.ok(screen.getByRole('radio', { name: 'Auto' }));
  assert.ok(screen.getByRole('radio', { name: 'Light' }));
  assert.ok(screen.getByRole('radio', { name: 'Dark' }));
});

test('with nothing stored, Auto is checked and the OS decides the paint', () => {
  render(<ThemeToggle />);
  assert.equal(screen.getByRole<HTMLInputElement>('radio', { name: 'Auto' }).checked, true);
  // The fake says the OS is not light.
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
});

test('a stored preference is what is checked, and it beats the OS', () => {
  localStorage.setItem('pickarr.theme', 'light');
  render(<ThemeToggle />);
  assert.equal(screen.getByRole<HTMLInputElement>('radio', { name: 'Light' }).checked, true);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
});

test('choosing a theme repaints and persists it', () => {
  render(<ThemeToggle />);
  fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(localStorage.getItem('pickarr.theme'), 'light');
});

test('choosing Auto hands the decision back to the OS', () => {
  localStorage.setItem('pickarr.theme', 'light');
  render(<ThemeToggle />);
  fireEvent.click(screen.getByRole('radio', { name: 'Auto' }));
  assert.equal(localStorage.getItem('pickarr.theme'), null);
  // The fake still says not-light, so handing the decision back means dark.
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
});

test('an OS change is followed while the preference is Auto', () => {
  render(<ThemeToggle />);
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  fake.matches = true;
  fake.dispatchEvent(new Event('change'));
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
});

test('an OS change is ignored once the preference is explicit', () => {
  render(<ThemeToggle />);
  fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
  fake.matches = true;
  fake.dispatchEvent(new Event('change'));
  // Explicitly dark means dark, whatever the operating system starts saying.
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
});
