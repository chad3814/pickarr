import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { useIdentityChange, type ApplyOutcome } from '../src/api/useIdentityChange.ts';
import { IdentityChangeConfirm } from '../src/components/IdentityChangeConfirm.tsx';
import type { IdentityPlanView } from '../src/api/client.ts';

// Unmount between tests rather than at the end of each one: a test that fails
// mid-way otherwise leaves its DOM behind and every later `getBy*` sees two
// copies of the probe, turning one real failure into a cascade of fake ones.
afterEach(cleanup);

function plan(overrides: Partial<IdentityPlanView> = {}): IdentityPlanView {
  return {
    groupId: 1,
    identityKey: 'site:2026-08-14:title',
    kind: 'display-only',
    mergeInto: null,
    releasesMoving: 0,
    downloadsMoving: 0,
    pick: { surviving: null, superseded: null },
    renames: [],
    trashing: [],
    warnings: [],
    blockers: [],
    digest: 'digest-1',
    ...overrides,
  };
}

/**
 * Serves `plans`, one per call to `POST /api/groups/:id/identity-plan`, in
 * order — `begin`'s initial plan first, then `confirm`'s re-plan on a stale
 * digest, if the test drives that far. `calls` lets a test prove *how many*
 * times the hook re-planned, not just that it eventually showed the right
 * thing.
 */
function mockIdentityPlanFetch(plans: readonly IdentityPlanView[]): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    const served = plans[state.calls];
    state.calls += 1;
    if (served === undefined) throw new Error(`no planned response for call ${state.calls}`);
    return new Response(JSON.stringify(served), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return state;
}

type Apply = (
  groupId: number,
  values: Record<string, string>,
  digest?: string,
) => Promise<ApplyOutcome>;

/**
 * Drives `useIdentityChange` the way `MediaCard` would: a button starts
 * `begin`, and `plan` (when non-null) renders the same confirmation component
 * a real page would. `result` makes `begin`'s eventual boolean visible to the
 * test without needing the hook to expose anything it does not already.
 */
function Probe({ apply, onError = () => {} }: { apply: Apply; onError?: (message: string) => void }) {
  const { begin, plan: pending, confirm, cancel, busy, stale } = useIdentityChange(apply, onError);
  const [result, setResult] = useState('pending');

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void begin(1, { title: 'x' }).then((saved) => setResult(String(saved)));
        }}
      >
        Begin
      </button>
      <p>result:{result}</p>
      {pending !== null && (
        <IdentityChangeConfirm
          plan={pending}
          onConfirm={() => void confirm()}
          onCancel={cancel}
          busy={busy}
          stale={stale}
        />
      )}
    </div>
  );
}

test('a plan that moves nothing applies immediately, with no dialog and no digest', async () => {
  mockIdentityPlanFetch([plan({ kind: 'display-only' })]);
  const digests: (string | undefined)[] = [];
  const apply: Apply = async (_groupId, _values, digest) => {
    digests.push(digest);
    return { saved: true };
  };

  render(<Probe apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));

  await waitFor(() => assert.ok(screen.getByText('result:true')));
  assert.deepEqual(digests, [undefined]);
  assert.equal(screen.queryByRole('dialog'), null);
});

test('a merge shows the confirmation, calls apply not at all until confirmed, then with the plan digest', async () => {
  mockIdentityPlanFetch([
    plan({ kind: 'merge', mergeInto: { id: 2, title: 'Target' }, digest: 'merge-digest' }),
  ]);
  const digests: (string | undefined)[] = [];
  const apply: Apply = async (_groupId, _values, digest) => {
    digests.push(digest);
    return { saved: true };
  };

  render(<Probe apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));

  await waitFor(() => assert.ok(screen.getByRole('dialog')));
  assert.deepEqual(digests, []);

  fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

  await waitFor(() => assert.ok(screen.getByText('result:true')));
  assert.deepEqual(digests, ['merge-digest']);
});

test('a plan with kind "none" but a pending rename still requires confirmation', async () => {
  // The interrupted-rename retry: the key and display already match what
  // `values` describes, so the planner reports `kind: 'none'`, but a file
  // from an earlier, half-applied edit still needs to move. A check that
  // trusted `kind` alone would wrongly treat this as the one-click case and
  // apply it with no digest at all.
  mockIdentityPlanFetch([
    plan({ kind: 'none', renames: [{ importedFileId: 1, from: '/a', to: '/b' }] }),
  ]);
  let applyCalls = 0;
  const apply: Apply = async () => {
    applyCalls += 1;
    return { saved: true };
  };

  render(<Probe apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));

  await waitFor(() => assert.ok(screen.getByRole('dialog')));
  assert.equal(applyCalls, 0);
});

test('a blocked plan with no renames or trashing still requires confirmation', async () => {
  // The bug this guards: `renames: []`, `trashing: []`, but `blockers`
  // non-empty (the one file this rekey would touch is occupied by something
  // foreign) is exactly the shape `kind`/`renames`/`trashing` alone read as
  // "nothing to confirm" — sending it straight to `apply`, which refuses 409
  // and is reported by this hook's own contract as a stale digest, not as the
  // blocker text the dialog would have shown.
  mockIdentityPlanFetch([
    plan({ kind: 'rekey', blockers: ['/lib/k2/1080.mp4 is occupied by something foreign'] }),
  ]);
  let applyCalls = 0;
  const apply: Apply = async () => {
    applyCalls += 1;
    return { saved: true };
  };

  render(<Probe apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));

  await waitFor(() => assert.ok(screen.getByRole('dialog')));
  assert.equal(applyCalls, 0);
  assert.ok(screen.getByText(/occupied by something foreign/));
});

test('cancel resolves false and calls apply never', async () => {
  mockIdentityPlanFetch([plan({ kind: 'merge', mergeInto: { id: 2, title: 'Target' } })]);
  let applyCalls = 0;
  const apply: Apply = async () => {
    applyCalls += 1;
    return { saved: true };
  };

  render(<Probe apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));
  await waitFor(() => assert.ok(screen.getByRole('dialog')));

  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

  await waitFor(() => assert.ok(screen.getByText('result:false')));
  assert.equal(applyCalls, 0);
});

test('a stale digest re-plans in place and keeps the dialog open', async () => {
  const fetchState = mockIdentityPlanFetch([
    plan({ kind: 'merge', mergeInto: { id: 2, title: 'Target' }, digest: 'stale-digest' }),
    plan({ kind: 'merge', mergeInto: { id: 2, title: 'Target Renamed' }, digest: 'fresh-digest' }),
  ]);
  const apply: Apply = async () => ({ saved: false, stale: true });

  render(<Probe apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));
  await waitFor(() => assert.ok(screen.getByRole('dialog')));

  fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

  // The dialog stays open, showing the re-fetched plan rather than the stale
  // one that was rejected — and `begin`'s promise has not resolved, because
  // the user still has a decision to make.
  await waitFor(() => assert.ok(screen.getByText(/Target Renamed/)));
  assert.equal(fetchState.calls, 2);
  assert.ok(screen.getByRole('dialog'));
  assert.ok(screen.getByText('result:pending'));
});

test('a stale re-plan says why, not just what', async () => {
  // §8: a stale digest "replaces the plan in place and says why" — this is
  // the "says why" half. Without it, the dialog swaps the plan under the
  // user with no signal, and a second Confirm click confirms a plan they may
  // never have noticed changed.
  mockIdentityPlanFetch([
    plan({ kind: 'merge', mergeInto: { id: 2, title: 'Target' }, digest: 'stale-digest' }),
    plan({ kind: 'merge', mergeInto: { id: 2, title: 'Target Renamed' }, digest: 'fresh-digest' }),
  ]);
  const apply: Apply = async () => ({ saved: false, stale: true });

  render(<Probe apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));
  await waitFor(() => assert.ok(screen.getByRole('dialog')));

  assert.equal(screen.queryByText(/changed since you opened it/), null);
  fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

  await waitFor(() => assert.ok(screen.getByText(/changed since you opened it/)));
});

test('a non-stale failure resolves false and closes the dialog rather than re-planning', async () => {
  const fetchState = mockIdentityPlanFetch([
    plan({ kind: 'merge', mergeInto: { id: 2, title: 'Target' } }),
  ]);
  const apply: Apply = async () => ({ saved: false, stale: false });

  render(<Probe apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));
  await waitFor(() => assert.ok(screen.getByRole('dialog')));

  fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

  await waitFor(() => assert.ok(screen.getByText('result:false')));
  assert.equal(screen.queryByRole('dialog'), null);
  // Only the one plan fetch happened — the failure did not trigger a re-plan.
  assert.equal(fetchState.calls, 1);
});

test('the no-confirmation fast path going stale opens the confirmation with the re-planned plan, and does not resolve until answered', async () => {
  // The plan looked display-only, so `begin` applied with no digest — but the
  // apply came back 409 anyway (a concurrent change made this a merge on the
  // server). This must not be a silent no-op: it lands the user exactly where
  // a merge plan would have, holding `begin`'s promise open.
  mockIdentityPlanFetch([
    plan({ kind: 'display-only', digest: 'display-digest' }),
    plan({ kind: 'merge', mergeInto: { id: 2, title: 'Target' }, digest: 'merge-digest' }),
  ]);
  let applyCalls = 0;
  const digests: (string | undefined)[] = [];
  const apply: Apply = async (_groupId, _values, digest) => {
    applyCalls += 1;
    digests.push(digest);
    // The first apply is the fast path's no-digest attempt; only it goes
    // stale. The second is the confirmed merge, which lands.
    return applyCalls === 1 ? { saved: false, stale: true } : { saved: true };
  };

  render(<Probe apply={apply} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));

  await waitFor(() => assert.ok(screen.getByRole('dialog')));
  assert.ok(screen.getByText(/Target/));
  assert.ok(screen.getByText('result:pending'));
  assert.deepEqual(digests, [undefined]);

  fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

  await waitFor(() => assert.ok(screen.getByText('result:true')));
  assert.deepEqual(digests, [undefined, 'merge-digest']);
});

test('a failing re-plan after a stale fast-path apply reports via onError and resolves false', async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify(plan({ kind: 'display-only' })), {
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('network down');
  }) as unknown as typeof fetch;

  let applyCalls = 0;
  const apply: Apply = async () => {
    applyCalls += 1;
    return { saved: false, stale: true };
  };
  const errors: string[] = [];

  render(<Probe apply={apply} onError={(message) => errors.push(message)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));

  await waitFor(() => assert.ok(screen.getByText('result:false')));
  assert.deepEqual(errors, ['network down']);
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(applyCalls, 1);
  assert.equal(fetchCalls, 2);
});

test('a re-plan that still needs no confirmation, then goes stale again, surfaces an error rather than looping', async () => {
  // Two identical races back to back: the first stale apply re-plans, the
  // fresh plan still reads as display-only, and the one permitted retry goes
  // stale too. This must be reported, not retried a third time.
  const fetchState = mockIdentityPlanFetch([
    plan({ kind: 'display-only', digest: 'd1' }),
    plan({ kind: 'display-only', digest: 'd2' }),
  ]);
  let applyCalls = 0;
  const apply: Apply = async () => {
    applyCalls += 1;
    return { saved: false, stale: true };
  };
  const errors: string[] = [];

  render(<Probe apply={apply} onError={(message) => errors.push(message)} />);
  fireEvent.click(screen.getByRole('button', { name: 'Begin' }));

  await waitFor(() => assert.ok(screen.getByText('result:false')));
  assert.equal(errors.length, 1);
  assert.equal(screen.queryByRole('dialog'), null);
  // Exactly one retry: two plan fetches, two applies, not a third of either.
  assert.equal(fetchState.calls, 2);
  assert.equal(applyCalls, 2);
});
