import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { ManualForm } from '../src/components/ManualForm.tsx';
import { useIdentityPreview } from '../src/api/useIdentityPreview.ts';
import { api, type ManualField } from '../src/api/client.ts';
import { fetchStub } from './fetchStub.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM behind and every later `getBy*` sees two
// copies of the form, turning one real failure into a cascade of fake ones.
afterEach(cleanup);

const FIELDS: ManualField[] = [
  { name: 'site', label: 'Site', type: 'text', scope: 'identity', required: true },
  {
    name: 'anchorKind',
    label: 'Anchor kind',
    type: 'select',
    scope: 'identity',
    options: ['date', 'episode', 'none'],
    required: true,
  },
  { name: 'title', label: 'Title', type: 'text', scope: 'identity', required: true },
  { name: 'episodeNumber', label: 'Episode number', type: 'number', scope: 'identity' },
  {
    name: 'resolution',
    label: 'Resolution',
    type: 'select',
    scope: 'quality',
    options: ['', '2160p', '1080p'],
  },
];

function noop(): void {}

test('every field gets its own labelled control, typed as the schema says', () => {
  render(
    <ManualForm
      fields={FIELDS}
      values={{}}
      submitLabel="Save"
      onSubmit={noop}
      onCancel={noop}
    />,
  );

  for (const field of FIELDS) assert.ok(screen.getByLabelText(field.label), field.label);
  assert.equal(screen.getByLabelText('Site').getAttribute('type'), 'text');
  assert.equal(screen.getByLabelText('Episode number').getAttribute('type'), 'number');
  assert.equal(screen.getByLabelText('Anchor kind').tagName, 'SELECT');
});

test('a select offers exactly the options the field declares', () => {
  render(
    <ManualForm
      fields={FIELDS}
      values={{}}
      submitLabel="Save"
      onSubmit={noop}
      onCancel={noop}
    />,
  );

  const anchor = screen.getByLabelText('Anchor kind') as HTMLSelectElement;
  assert.deepEqual(
    [...anchor.options].map((option) => option.value),
    ['date', 'episode', 'none'],
  );

  // The empty option is how a plugin spells "unset"; dropping it would make an
  // optional select unclearable.
  const resolution = screen.getByLabelText('Resolution') as HTMLSelectElement;
  assert.deepEqual(
    [...resolution.options].map((option) => option.value),
    ['', '2160p', '1080p'],
  );
});

test('controls prefill from the values given', () => {
  render(
    <ManualForm
      fields={FIELDS}
      values={{ site: 'brazzers', anchorKind: 'episode', title: 'A Thing', resolution: '2160p' }}
      submitLabel="Save"
      onSubmit={noop}
      onCancel={noop}
    />,
  );

  assert.equal((screen.getByLabelText('Site') as HTMLInputElement).value, 'brazzers');
  assert.equal((screen.getByLabelText('Title') as HTMLInputElement).value, 'A Thing');
  assert.equal((screen.getByLabelText('Anchor kind') as HTMLSelectElement).value, 'episode');
  assert.equal((screen.getByLabelText('Resolution') as HTMLSelectElement).value, '2160p');
});

test('submit reports every field, including ones the prefill never mentioned', () => {
  // `suggestManualValues` answers sparsely — only the keys it could work out
  // from a name the parser refused. A form that submitted only the keys it was
  // handed would send a partial record and the plugin would see fields it has
  // no way to distinguish from deliberately-blank ones.
  const submitted: Record<string, string>[] = [];
  render(
    <ManualForm
      fields={FIELDS}
      values={{ site: 'brazzers' }}
      submitLabel="Save"
      onSubmit={(values) => submitted.push(values)}
      onCancel={noop}
    />,
  );

  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Thing' } });
  fireEvent.change(screen.getByLabelText('Anchor kind'), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  assert.deepEqual(submitted, [
    {
      site: 'brazzers',
      anchorKind: 'none',
      title: 'A Thing',
      episodeNumber: '',
      resolution: '',
    },
  ]);
});

test('onChange reports the whole map on every keystroke', () => {
  const seen: Record<string, string>[] = [];
  render(
    <ManualForm
      fields={FIELDS}
      values={{ site: 'brazzers', anchorKind: 'none' }}
      submitLabel="Save"
      onChange={(values) => seen.push(values)}
      onSubmit={noop}
      onCancel={noop}
    />,
  );

  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A' } });
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'AB' } });

  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.['title'], 'A');
  assert.equal(seen[1]?.['title'], 'AB');
  assert.equal(seen[1]?.['site'], 'brazzers');
});

test('an empty required field blocks submit and is named', () => {
  const submitted: Record<string, string>[] = [];
  render(
    <ManualForm
      fields={FIELDS}
      values={{ site: 'brazzers', anchorKind: 'none' }}
      submitLabel="Save"
      onSubmit={(values) => submitted.push(values)}
      onCancel={noop}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  assert.deepEqual(submitted, []);
  assert.ok(screen.getByText(/^Required: .*Title/));

  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'A Thing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  assert.equal(submitted.length, 1);
});

test('whitespace does not satisfy a required field', () => {
  const submitted: Record<string, string>[] = [];
  render(
    <ManualForm
      fields={FIELDS}
      values={{ site: '   ', anchorKind: 'none', title: 'A Thing' }}
      submitLabel="Save"
      onSubmit={(values) => submitted.push(values)}
      onCancel={noop}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  assert.deepEqual(submitted, []);
});

test('the preview and the submit label come from the caller', () => {
  render(
    <ManualForm
      fields={FIELDS}
      values={{}}
      preview="scenes:brazzers:2026-01-01:a-thing"
      submitLabel="Fix it"
      onSubmit={noop}
      onCancel={noop}
    />,
  );

  assert.ok(screen.getByText('scenes:brazzers:2026-01-01:a-thing'));
  assert.ok(screen.getByRole('button', { name: 'Fix it' }));
});

test('cancel does not submit', () => {
  const submitted: Record<string, string>[] = [];
  const cancels: number[] = [];
  render(
    <ManualForm
      fields={FIELDS}
      values={{ site: 'a', anchorKind: 'none', title: 'b' }}
      submitLabel="Save"
      onSubmit={(values) => submitted.push(values)}
      onCancel={() => cancels.push(1)}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
  assert.deepEqual(submitted, []);
  assert.equal(cancels.length, 1);
});

test('the failed list asks for dismissed items only when told to', async () => {
  const urls: string[] = [];
  globalThis.fetch = fetchStub(async (input) => {
    urls.push(input);
    return new Response(JSON.stringify({ items: [], nextCursor: null }), {
      headers: { 'content-type': 'application/json' },
    });
  });

  await api.failed(null, false);
  await api.failed('1700:42', true);

  assert.equal(urls[0], '/api/failed?');
  // The server reads the literal string '1', not truthiness: `z.coerce.boolean`
  // would have read 'false' as true, so it takes a string and compares.
  assert.equal(urls[1], '/api/failed?cursor=1700%3A42&includeDismissed=1');
});

test('a rejected preview is an answer, not a failure', async () => {
  // `/api/manual-preview` answers 200 with `{ error }` while the form is still
  // half-typed. Treating that as a thrown request would make every keystroke
  // before the last one an error.
  globalThis.fetch = fetchStub(async () =>
    new Response(JSON.stringify({ error: 'date must be YYYY-MM-DD' }), {
      headers: { 'content-type': 'application/json' },
    }));

  const result = await api.manualPreview('scenes', { date: '2026-0' });
  assert.deepEqual(result, { error: 'date must be YYYY-MM-DD' });
});

function Preview({ values }: { values: Record<string, string> }) {
  return <p>{useIdentityPreview('scenes', values)}</p>;
}

test('the preview hook debounces and shows the key, or the plugin complaint', async () => {
  const bodies: Record<string, string>[] = [];
  globalThis.fetch = fetchStub(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { values: Record<string, string> };
    bodies.push(body.values);
    return new Response(
      JSON.stringify(
        body.values['title'] === 'done'
          ? { identityKey: 'scenes:brazzers:--:done' }
          : { error: 'title is required' },
      ),
      { headers: { 'content-type': 'application/json' } },
    );
  });

  const { rerender } = render(<Preview values={{ title: 'do' }} />);
  rerender(<Preview values={{ title: 'don' }} />);
  rerender(<Preview values={{ title: 'done' }} />);

  // Comfortably inside the debounce window. Without a real delay — a bare
  // `void run()`, or a zero timeout — the first draft would already be on the
  // wire by now. Rerendering alone does not prove the delay: three synchronous
  // rerenders cancel even a zero-length timer before the macrotask can run.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(bodies, []);

  await waitFor(() => assert.ok(screen.getByText('scenes:brazzers:--:done')));
  // Debounced: the two intermediate drafts never reached the server.
  assert.deepEqual(bodies, [{ title: 'done' }]);

  rerender(<Preview values={{ title: '' }} />);
  await waitFor(() => assert.ok(screen.getByText('title is required')));
});

test('a re-render that changed no value costs no request', async () => {
  // The form's parent rebuilds the values object as it renders, so its identity
  // changes on renders that changed nothing — an error message appearing, a
  // sibling row updating. Keyed on the object rather than on its contents, the
  // hook would re-ask the server the same question on every one of them.
  let calls = 0;
  globalThis.fetch = fetchStub(async () => {
    calls += 1;
    return new Response(JSON.stringify({ identityKey: 'scenes:brazzers:--:done' }), {
      headers: { 'content-type': 'application/json' },
    });
  });

  const { rerender } = render(<Preview values={{ title: 'done' }} />);
  await waitFor(() => assert.ok(screen.getByText('scenes:brazzers:--:done')));

  rerender(<Preview values={{ title: 'done' }} />);
  rerender(<Preview values={{ title: 'done' }} />);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls, 1);
});

test('a slow earlier preview never overwrites a newer one', async () => {
  // The debounce coalesces keystrokes but does not order responses: once two
  // requests are in flight the earlier one can land last, and the field the
  // user is looking at would then describe values they have already replaced.
  const gate: { open(): void } = { open: () => {} };
  const held = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  let calls = 0;
  globalThis.fetch = fetchStub(async () => {
    calls += 1;
    // Captured before the await: by the time the held request resumes, `calls`
    // has moved on, and reading it there would answer both requests alike.
    const mine = calls;
    if (mine === 1) await held;
    return new Response(JSON.stringify({ identityKey: mine === 1 ? 'stale' : 'fresh' }), {
      headers: { 'content-type': 'application/json' },
    });
  });

  const { rerender } = render(<Preview values={{ title: 'a' }} />);
  await waitFor(() => assert.equal(calls, 1));
  rerender(<Preview values={{ title: 'b' }} />);
  await waitFor(() => assert.ok(screen.getByText('fresh')));

  gate.open();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(screen.getByText('fresh'));
});

test('a preview request that actually fails shows why', async () => {
  globalThis.fetch = fetchStub(async () =>
    new Response(JSON.stringify({ error: 'No plugin loaded for id scenes' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }));

  render(<Preview values={{ title: 'x' }} />);
  await waitFor(() => assert.ok(screen.getByText('No plugin loaded for id scenes')));
});
