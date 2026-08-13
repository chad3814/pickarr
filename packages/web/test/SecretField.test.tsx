import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SecretField } from '../src/components/settings/SecretField.tsx';
import type { SecretEdit } from '../src/api/client.ts';

afterEach(cleanup);

test('a key held on disk shows as set and offers no value to read', () => {
  render(
    <SecretField label="API key" view={{ kind: 'set' }} value={{ kind: 'keep' }} onChange={() => {}} />,
  );
  assert.ok(screen.getByText(/set/i));
  assert.ok(screen.getByRole('button', { name: /replace/i }));
  // Nothing on screen can be read back as the key.
  assert.equal(screen.queryByRole('textbox'), null);
});

test('Replace switches to an empty literal the user types into', () => {
  const edits: SecretEdit[] = [];
  const { rerender } = render(
    <SecretField
      label="API key"
      view={{ kind: 'set' }}
      value={{ kind: 'keep' }}
      onChange={(next) => edits.push(next)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /replace/i }));
  assert.deepEqual(edits[0], { kind: 'literal', value: '' });

  rerender(
    <SecretField
      label="API key"
      view={{ kind: 'set' }}
      value={{ kind: 'literal', value: '' }}
      onChange={(next) => edits.push(next)}
    />,
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abcd1234abcd1234' } });
  assert.deepEqual(edits[1], { kind: 'literal', value: 'abcd1234abcd1234' });
});

test('a file: reference is editable as a path, because a path is not a secret', () => {
  const edits: SecretEdit[] = [];
  render(
    <SecretField
      label="API key"
      view={{ kind: 'file', path: '/run/secrets/key' }}
      value={{ kind: 'file', path: '/run/secrets/key' }}
      onChange={(next) => edits.push(next)}
    />,
  );
  const input = screen.getByRole('textbox');
  assert.equal(input.getAttribute('value'), '/run/secrets/key');
  assert.equal(screen.getByLabelText('API key'), input);
  fireEvent.change(input, { target: { value: '/run/secrets/other' } });
  assert.deepEqual(edits[0], { kind: 'file', path: '/run/secrets/other' });
});

test('a replacement can be abandoned, returning to keeping what is on disk', () => {
  const edits: SecretEdit[] = [];
  render(
    <SecretField
      label="API key"
      view={{ kind: 'set' }}
      value={{ kind: 'literal', value: 'half-typed' }}
      onChange={(next) => edits.push(next)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /keep existing/i }));
  assert.deepEqual(edits[0], { kind: 'keep' });
});

test('a download client added in this form has nothing on disk to keep, so no keep button is offered', () => {
  render(
    <SecretField
      label="API key"
      view={{ kind: 'file', path: '' }}
      value={{ kind: 'literal', value: 'typing' }}
      onChange={() => {}}
    />,
  );
  assert.equal(screen.queryByRole('button', { name: /keep existing/i }), null);
});

test('Replace is named per field, so a page with several secret fields does not read as several identical buttons', () => {
  render(
    <>
      <SecretField label="API key" view={{ kind: 'set' }} value={{ kind: 'keep' }} onChange={() => {}} />
      <SecretField label="Site lookup key" view={{ kind: 'set' }} value={{ kind: 'keep' }} onChange={() => {}} />
    </>,
  );
  assert.ok(screen.getByRole('button', { name: /replace api key/i }));
  assert.ok(screen.getByRole('button', { name: /replace site lookup key/i }));
});

test('Keep existing is named per field too, for the same reason', () => {
  render(
    <>
      <SecretField label="API key" view={{ kind: 'set' }} value={{ kind: 'literal', value: 'x' }} onChange={() => {}} />
      <SecretField
        label="Site lookup key"
        view={{ kind: 'set' }}
        value={{ kind: 'literal', value: 'y' }}
        onChange={() => {}}
      />
    </>,
  );
  assert.ok(screen.getByRole('button', { name: /keep existing api key/i }));
  assert.ok(screen.getByRole('button', { name: /keep existing site lookup key/i }));
});
