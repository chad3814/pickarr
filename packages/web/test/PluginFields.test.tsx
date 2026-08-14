import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PluginFields } from '../src/components/settings/PluginFields.tsx';
import type { PluginDraft } from '../src/components/settings/ConfigForm.tsx';

afterEach(cleanup);

function plugins(): PluginDraft[] {
  return [
    {
      name: '@pickarr/plugin-scenes',
      settings: [
        { key: 'libraryRoot', value: '/media/scenes' },
        { key: 'sites', value: ['Vixen', 'Bangbros'] },
        { key: 'strict', value: true },
        { key: 'retries', value: 3 },
      ],
    },
  ];
}

test('each value type gets a control that cannot change its type', () => {
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);

  // Exact matches, not /sites/i: getByLabelText also matches any element's
  // aria-label attribute against the query, and "Remove setting sites"
  // would otherwise collide with this lookup.
  const sites = screen.getByLabelText('sites');
  assert.equal(sites.tagName, 'TEXTAREA');
  fireEvent.change(sites, { target: { value: 'Vixen\nTushy\n' } });
  const sitesValue = next[0]?.settings[1]?.value;
  assert.ok(Array.isArray(sitesValue));
  assert.deepEqual(sitesValue, ['Vixen', 'Tushy']);
  assert.ok(sitesValue.every((entry) => typeof entry === 'string'));

  assert.equal(screen.getByLabelText('strict').getAttribute('type'), 'checkbox');
  assert.equal(screen.getByLabelText('retries').getAttribute('type'), 'number');
});

test('a number stays a number rather than becoming a string', () => {
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText('retries'), { target: { value: '5' } });
  assert.equal(next[0]?.settings[3]?.value, 5);
  assert.equal(typeof next[0]?.settings[3]?.value, 'number');
});

test('blank lines in a list are dropped rather than becoming empty entries', () => {
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText('sites'), { target: { value: 'Vixen\n\n  \nTushy' } });
  assert.deepEqual(next[0]?.settings[1]?.value, ['Vixen', 'Tushy']);
});

test('renaming a setting does not lose its value', () => {
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  // The rename input carries its own current value as the input's text, so it
  // can be found without depending on any label, unlike the value control.
  fireEvent.change(screen.getByDisplayValue('sites'), { target: { value: 'places' } });
  assert.deepEqual(next[0]?.settings[1], { key: 'places', value: ['Vixen', 'Bangbros'] });
});

test('adding a text setting defaults to an empty string', () => {
  let next = plugins();
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText(/new setting type/i), { target: { value: 'text' } });
  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add setting/i }));
  assert.deepEqual(next[0]?.settings.at(-1), { key: '', value: '' });
  assert.equal(typeof next[0]?.settings.at(-1)?.value, 'string');
});

test('adding a number setting defaults to 0, not the string "0"', () => {
  let next = plugins();
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText(/new setting type/i), { target: { value: 'number' } });
  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add setting/i }));
  assert.deepEqual(next[0]?.settings.at(-1), { key: '', value: 0 });
  assert.equal(typeof next[0]?.settings.at(-1)?.value, 'number');
});

test('adding a boolean setting defaults to false', () => {
  let next = plugins();
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText(/new setting type/i), { target: { value: 'boolean' } });
  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add setting/i }));
  assert.deepEqual(next[0]?.settings.at(-1), { key: '', value: false });
  assert.equal(typeof next[0]?.settings.at(-1)?.value, 'boolean');
});

test('adding a list setting defaults to an empty list', () => {
  let next = plugins();
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText(/new setting type/i), { target: { value: 'list' } });
  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add setting/i }));
  assert.deepEqual(next[0]?.settings.at(-1), { key: '', value: [] });
});

test('removing a setting drops exactly that row, leaving the others in order', () => {
  // Three rows so a bug that always drops the first or last row, regardless
  // of which button was clicked, cannot pass by accident: the middle row is
  // the one under test here.
  let next: PluginDraft[] = [
    {
      name: '@pickarr/plugin-scenes',
      settings: [
        { key: 'a', value: 'one' },
        { key: 'b', value: 'two' },
        { key: 'c', value: 'three' },
      ],
    },
  ];
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  // Named by its own key rather than /remove setting/i: several "Remove
  // setting" buttons render on this page, and this query would fail to
  // resolve to a single element - failing the test - if the per-row
  // aria-label were ever removed.
  fireEvent.click(screen.getByRole('button', { name: 'Remove setting b' }));
  assert.deepEqual(next[0]?.settings.map((setting) => setting.key), ['a', 'c']);
});

test('the remove-setting button falls back to "(new)" when the setting has no key yet', () => {
  let next: PluginDraft[] = [{ name: '@pickarr/plugin-scenes', settings: [{ key: '', value: '' }] }];
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove setting (new)' }));
  assert.deepEqual(next[0]?.settings, []);
});

test('a plugin can be added and removed', () => {
  let next = plugins();
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add plugin/i }));
  assert.equal(next.length, 2);
  assert.deepEqual(next[1], { name: '', settings: [] });

  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getAllByRole('button', { name: /remove plugin/i })[1]!);
  assert.deepEqual(next.map((plugin) => plugin.name), ['@pickarr/plugin-scenes']);
});

test('removing a plugin drops exactly that row, leaving the others in order', () => {
  // Three rows so a bug that always drops the first or last row, regardless
  // of which button was clicked, cannot pass by accident: the middle row is
  // the one under test here.
  let next: PluginDraft[] = [
    { name: 'p1', settings: [] },
    { name: 'p2', settings: [] },
    { name: 'p3', settings: [] },
  ];
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  // Named by its own package name rather than /remove plugin/i: several
  // "Remove plugin" buttons render on this page, and this query would fail
  // to resolve to a single element - failing the test - if the per-row
  // aria-label were ever removed.
  fireEvent.click(screen.getByRole('button', { name: 'Remove plugin p2' }));
  assert.deepEqual(next.map((plugin) => plugin.name), ['p1', 'p3']);
});

test('the remove-plugin button falls back to "(new)" when the plugin has no name yet', () => {
  let next: PluginDraft[] = [{ name: '', settings: [] }];
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove plugin (new)' }));
  assert.deepEqual(next, []);
});
