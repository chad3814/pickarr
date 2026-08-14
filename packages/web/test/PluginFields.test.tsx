import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { fromLines, PluginFields } from '../src/components/settings/PluginFields.tsx';
import type { PluginDraft } from '../src/components/settings/ConfigForm.tsx';

afterEach(cleanup);

function plugins(): PluginDraft[] {
  return [
    {
      name: '@pickarr/plugin-scenes',
      settings: [
        { key: 'libraryRoot', value: '/media/scenes' },
        { key: 'sites', value: { list: 'Vixen\nBangbros' } },
        { key: 'strict', value: true },
        { key: 'retries', value: { number: '3' } },
      ],
    },
  ];
}

/**
 * Every other test here uses `onChange={(value) => { next = value; }}`, which
 * never feeds the new value back into `plugins` — so nothing in this file
 * exercised a real controlled round trip, which is exactly how the Enter-key
 * and clear-to-empty bugs survived: both only show up once React re-renders
 * with the value the previous change produced.
 */
function Controlled({ initial }: { initial: PluginDraft[] }) {
  const [value, setValue] = useState(initial);
  return <PluginFields plugins={value} onChange={setValue} />;
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
  assert.deepEqual(next[0]?.settings[1]?.value, { list: 'Vixen\nTushy\n' });

  assert.equal(screen.getByLabelText('strict').getAttribute('type'), 'checkbox');
  assert.equal(screen.getByLabelText('retries').getAttribute('type'), 'number');
});

test('a number is held as raw text while typing, not converted on every keystroke', () => {
  // Converting on every keystroke (`Number(...)`, then redisplaying
  // `String(...)`) is exactly what made clearing the field snap back to `0`;
  // see the controlled round-trip test below for that failure mode directly.
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText('retries'), { target: { value: '5' } });
  assert.deepEqual(next[0]?.settings[3]?.value, { number: '5' });
});

test('a boolean stays a boolean rather than becoming a string', () => {
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByLabelText('strict'));
  assert.equal(next[0]?.settings[2]?.value, false);
  assert.equal(typeof next[0]?.settings[2]?.value, 'boolean');
});

test('a string stays a string rather than becoming some other type', () => {
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText('libraryRoot'), { target: { value: '/media/movies' } });
  assert.equal(next[0]?.settings[0]?.value, '/media/movies');
  assert.equal(typeof next[0]?.settings[0]?.value, 'string');
});

test('a list holds its raw text verbatim while typing, blank lines included', () => {
  // Dropping blank lines here (on every keystroke) is exactly what made
  // pressing Enter unable to start a new line. That guarantee still holds —
  // see `fromLines` below and `ConfigForm.test.tsx` — but only at submit.
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText('sites'), { target: { value: 'Vixen\n\n  \nTushy' } });
  assert.deepEqual(next[0]?.settings[1]?.value, { list: 'Vixen\n\n  \nTushy' });
});

test('fromLines drops blank lines rather than turning them into empty entries', () => {
  // `configSchema` types a list as `z.array(z.string())` and would accept
  // `['']` happily, leaving a plugin to treat an empty site name as real.
  assert.deepEqual(fromLines('Vixen\n\n  \nTushy'), ['Vixen', 'Tushy']);
});

test('typing Enter in a list textarea starts a new line instead of vanishing (controlled round trip)', () => {
  // The bug this pins: `fromLines('Vixen\n')` used to produce `['Vixen']`,
  // `toLines(['Vixen'])` redisplayed that as `'Vixen'`, and React overwrote
  // the DOM back to it — so the newline the user just typed disappeared and
  // the next character joined the previous line.
  render(
    <Controlled
      initial={[{ name: '@pickarr/plugin-scenes', settings: [{ key: 'sites', value: { list: 'Vixen' } }] }]}
    />,
  );
  const sites = screen.getByLabelText('sites') as HTMLTextAreaElement;
  fireEvent.change(sites, { target: { value: 'Vixen\n' } });
  assert.equal(sites.value, 'Vixen\n');
  fireEvent.change(sites, { target: { value: 'Vixen\nTushy' } });
  assert.equal(sites.value, 'Vixen\nTushy');
});

test('clearing a number input leaves it empty instead of snapping back to 0 (controlled round trip)', () => {
  // The bug this pins: `Number('')` used to produce `0`, `String(0)`
  // redisplayed that as `'0'`, and React overwrote the DOM back to it — so
  // the field could never be emptied.
  render(
    <Controlled
      initial={[{ name: '@pickarr/plugin-scenes', settings: [{ key: 'retries', value: { number: '3' } }] }]}
    />,
  );
  const retries = screen.getByLabelText('retries') as HTMLInputElement;
  fireEvent.change(retries, { target: { value: '' } });
  assert.equal(retries.value, '');
});

test('renaming a setting does not lose its value', () => {
  let next = plugins();
  render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  // The rename input carries its own current value as the input's text, so it
  // can be found without depending on any label, unlike the value control.
  fireEvent.change(screen.getByDisplayValue('sites'), { target: { value: 'places' } });
  assert.deepEqual(next[0]?.settings[1], { key: 'places', value: { list: 'Vixen\nBangbros' } });
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

test('adding a number setting defaults to raw text "0", not the number 0', () => {
  let next = plugins();
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText(/new setting type/i), { target: { value: 'number' } });
  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add setting/i }));
  assert.deepEqual(next[0]?.settings.at(-1), { key: '', value: { number: '0' } });
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

test('adding a list setting defaults to empty raw text', () => {
  let next = plugins();
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText(/new setting type/i), { target: { value: 'list' } });
  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add setting/i }));
  assert.deepEqual(next[0]?.settings.at(-1), { key: '', value: { list: '' } });
});

test('a newly-added setting can be found and edited by label before it has a key', () => {
  // A blank key would otherwise leave its value control's label empty (the
  // label is `setting.key`), so getByLabelText would have nothing to find.
  let next = plugins();
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.click(screen.getByRole('button', { name: /add setting/i }));
  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);
  fireEvent.change(screen.getByLabelText('New setting value'), { target: { value: 'hello' } });
  assert.equal(next[0]?.settings.at(-1)?.value, 'hello');
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

test('removing a plugin remaps pending "new setting type" selections for the plugins after it', () => {
  // `addAs` is keyed by array position. Without remapping on removal, a
  // selection made for the plugin that used to sit one slot further down
  // would silently attach itself to whichever plugin now occupies that slot.
  let next: PluginDraft[] = [
    { name: 'p0', settings: [] },
    { name: 'p1', settings: [] },
    { name: 'p2', settings: [] },
  ];
  const { rerender } = render(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);

  // Named by its own plugin rather than an index into the page's selects:
  // that index is exactly what remapping is meant to preserve, so a query
  // that relies on it could pass even if remapping silently broke.
  fireEvent.change(screen.getByLabelText('New setting type for p1'), { target: { value: 'list' } });

  fireEvent.click(screen.getByRole('button', { name: 'Remove plugin p0' }));
  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);

  // p1 has shifted into position 0; its pending selection should have moved
  // with it, not stayed pinned to whichever plugin now sits at position 1.
  fireEvent.click(screen.getByRole('button', { name: 'Add setting to p1' }));
  assert.deepEqual(next[0]?.settings.at(-1), { key: '', value: { list: '' } });
  rerender(<PluginFields plugins={next} onChange={(value) => { next = value; }} />);

  // p2 has shifted into position 1 and never had a selection of its own; it
  // must still default to text, not inherit p1's leftover "list" selection.
  fireEvent.click(screen.getByRole('button', { name: 'Add setting to p2' }));
  assert.deepEqual(next[1]?.settings.at(-1), { key: '', value: '' });
});
