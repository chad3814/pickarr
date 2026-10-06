import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import type { FetchHostPatch, FetchHostsRead } from '@pickarr/contract';
import type { SendJsonResult } from '../../src/auth/sendJson.ts';
import { Fetching } from '../../src/settings/Fetching.tsx';
import type { FetchHostOutcome } from '../../src/settings/putFetchHost.ts';

afterEach(cleanup);

const READ: FetchHostsRead = {
  default: { concurrency: 1, timeoutMs: 30000 },
  hosts: [
    { hostname: 'cdn.example', concurrency: 3, timeoutMs: 30000, inherited: { concurrency: false, timeoutMs: true }, configured: true },
    { hostname: 'tracker.example', concurrency: 1, timeoutMs: 30000, inherited: { concurrency: true, timeoutMs: true }, configured: false },
  ],
};

function loaderOf(reads: FetchHostsRead[]): { load: () => Promise<SendJsonResult>; calls: () => number } {
  let calls = 0;
  return {
    load: async () => {
      calls += 1;
      const body = reads[Math.min(calls, reads.length) - 1];
      return { outcome: 'answered', status: 200, body };
    },
    calls: () => calls,
  };
}

function submitRecording(outcome: FetchHostOutcome): { submit: (hostname: string, patch: FetchHostPatch) => Promise<FetchHostOutcome>; sent: { hostname: string; patch: FetchHostPatch }[] } {
  const sent: { hostname: string; patch: FetchHostPatch }[] = [];
  return {
    submit: async (hostname, patch) => { sent.push({ hostname, patch }); return outcome; },
    sent,
  };
}

function row(name: string): HTMLElement {
  return screen.getByRole('listitem', { name });
}

test('inherited values render as placeholders in empty inputs; pinned values render as values', async () => {
  const { load } = loaderOf([READ]);
  render(<Fetching load={load} submit={submitRecording(READ.hosts[0]!).submit} />);
  const cdn = await screen.findByRole('listitem', { name: 'cdn.example' });
  const inFlight = within(cdn).getByLabelText('In flight') as HTMLInputElement;
  const timeout = within(cdn).getByLabelText('Timeout (s)') as HTMLInputElement;
  assert.equal(inFlight.value, '3');
  assert.equal(timeout.value, '');
  assert.equal(timeout.placeholder, '30');

  const tracker = row('tracker.example');
  assert.equal((within(tracker).getByLabelText('In flight') as HTMLInputElement).value, '');
  assert.equal((within(tracker).getByLabelText('In flight') as HTMLInputElement).placeholder, '1');

  const def = row('Any other host');
  assert.equal((within(def).getByLabelText('In flight') as HTMLInputElement).value, '1');
  assert.equal((within(def).getByLabelText('Timeout (s)') as HTMLInputElement).value, '30');
});

test('Save is disabled until a field changes, sends seconds as milliseconds, and reloads', async () => {
  const after: FetchHostsRead = { ...READ, hosts: [{ ...READ.hosts[1]!, timeoutMs: 60000, inherited: { concurrency: true, timeoutMs: false }, configured: true }, READ.hosts[0]!] };
  const { load, calls } = loaderOf([READ, after]);
  const { submit, sent } = submitRecording(after.hosts[0]!);
  render(<Fetching load={load} submit={submit} />);
  const tracker = await screen.findByRole('listitem', { name: 'tracker.example' });
  const save = within(tracker).getByRole('button', { name: /^Save/ }) as HTMLButtonElement;
  assert.equal(save.disabled, true);

  fireEvent.change(within(tracker).getByLabelText('Timeout (s)'), { target: { value: '60' } });
  assert.equal(save.disabled, false);
  fireEvent.click(save);

  await waitFor(() => { assert.equal(sent.length, 1); });
  assert.deepEqual(sent[0], { hostname: 'tracker.example', patch: { timeoutMs: 60000 } });
  await waitFor(() => { assert.equal(calls(), 2, 'reloaded after the save'); });
});

test('clearing a pinned field sends null; Revert to default sends both as null and shows only on configured rows', async () => {
  const { load } = loaderOf([READ]);
  const { submit, sent } = submitRecording(READ.hosts[0]!);
  render(<Fetching load={load} submit={submit} />);
  const cdn = await screen.findByRole('listitem', { name: 'cdn.example' });
  fireEvent.change(within(cdn).getByLabelText('In flight'), { target: { value: '' } });
  fireEvent.click(within(cdn).getByRole('button', { name: /^Save/ }));
  await waitFor(() => { assert.equal(sent.length, 1); });
  assert.deepEqual(sent[0]?.patch, { concurrency: null });

  fireEvent.click(within(cdn).getByRole('button', { name: /^Revert to default/ }));
  await waitFor(() => { assert.equal(sent.length, 2); });
  assert.deepEqual(sent[1]?.patch, { concurrency: null, timeoutMs: null });

  assert.ok(!within(row('tracker.example')).queryByRole('button', { name: /^Revert to default/ }), 'an unconfigured row has nothing to revert');
  assert.ok(!within(row('Any other host')).queryByRole('button', { name: /^Revert to default/ }));
});

test('a refusal renders as an alert naming the field, and a fractional second never leaves the page', async () => {
  const { load } = loaderOf([READ]);
  const { submit, sent } = submitRecording({ refusal: 'invalid-concurrency' });
  render(<Fetching load={load} submit={submit} />);
  const cdn = await screen.findByRole('listitem', { name: 'cdn.example' });

  fireEvent.change(within(cdn).getByLabelText('Timeout (s)'), { target: { value: '1.5' } });
  fireEvent.click(within(cdn).getByRole('button', { name: /^Save/ }));
  assert.equal(within(cdn).getByRole('alert').textContent, 'Timeout must be a whole number of seconds from 1 to 3600.');
  assert.equal(sent.length, 0);

  fireEvent.change(within(cdn).getByLabelText('Timeout (s)'), { target: { value: '45' } });
  fireEvent.change(within(cdn).getByLabelText('In flight'), { target: { value: '99' } });
  fireEvent.click(within(cdn).getByRole('button', { name: /^Save/ }));
  await waitFor(() => {
    assert.equal(within(cdn).getByRole('alert').textContent, 'In flight must be a whole number from 1 to 64.');
  });
});

test('loading and empty states', async () => {
  const { load } = loaderOf([{ default: { concurrency: 1, timeoutMs: 30000 }, hosts: [] }]);
  render(<Fetching load={load} submit={submitRecording({ refusal: 'offline' }).submit} />);
  assert.ok(screen.getByText('Loading…'));
  await screen.findByText('No hosts fetched yet');
  assert.ok(screen.getByRole('listitem', { name: 'Any other host' }), 'the default row is always there');
});
