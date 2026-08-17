### Task 9: The web client, the hook, and the confirmation

**Files:**
- Modify: `packages/web/src/api/client.ts` (`editGroup`, add `identityPlan`, add the plan types)
- Create: `packages/web/src/api/useIdentityChange.ts`
- Create: `packages/web/src/components/IdentityChangeConfirm.tsx`
- Test: `packages/web/test/IdentityChangeConfirm.test.tsx` (create)

**Interfaces:**
- Produces:
  - `api.identityPlan(groupId: number, values: Record<string, string>): Promise<IdentityPlanView>`
  - `api.editGroup(groupId: number, values: Record<string, string>, planDigest?: string): Promise<GroupEditResponse>`
  - `useIdentityChange(apply: (groupId: number, values: Record<string, string>, digest?: string) => Promise<boolean>)` returning `{ begin, plan, confirm, cancel, busy }`
  - `<IdentityChangeConfirm plan={…} onConfirm={…} onCancel={…} />`

- [ ] **Step 1: Add the client calls and types**

In `packages/web/src/api/client.ts`, mirror the server's `IdentityPlan` as `IdentityPlanView` (same field names and types; no `any`), then:

```ts
  async identityPlan(groupId: number, values: Record<string, string>): Promise<IdentityPlanView> {
    return request<IdentityPlanView>(`/api/groups/${groupId}/identity-plan`, {
      method: 'POST',
      body: JSON.stringify({ values }),
    });
  },
```

and give `editGroup` a third optional `planDigest`, included in the body only when defined.

Follow whatever `request`/fetch helper the file already uses rather than introducing a second one.

- [ ] **Step 2: Write the failing confirmation test**

Create `packages/web/test/IdentityChangeConfirm.test.tsx`, following the render/assert style of `packages/web/test/ManualForm.test.tsx`:

```tsx
const MERGE: IdentityPlanView = {
  groupId: 1,
  identityKey: 'site:2026-08-14:title',
  kind: 'merge',
  mergeInto: { id: 2, title: 'Title Of Scene' },
  releasesMoving: 1,
  downloadsMoving: 1,
  pick: { surviving: { releaseId: 1, score: 1080, side: 'source' }, superseded: null },
  renames: [{ importedFileId: 1, from: '/library/Old/a.mp4', to: '/library/New/a.mp4' }],
  trashing: [],
  warnings: [],
  blockers: [],
  digest: 'abc',
};

test('it names the group being merged into and every file that moves', () => {
  render(<IdentityChangeConfirm plan={MERGE} onConfirm={() => {}} onCancel={() => {}} />);

  assert.ok(screen.getByText(/Title Of Scene/));
  assert.ok(screen.getByText('/library/Old/a.mp4'));
  assert.ok(screen.getByText('/library/New/a.mp4'));
});

test('it reports which pick survives and which is superseded', () => {
  render(
    <IdentityChangeConfirm
      plan={{
        ...MERGE,
        pick: {
          surviving: { releaseId: 2, score: 2160, side: 'target' },
          superseded: { releaseId: 1, score: 1080 },
        },
        trashing: [{ importedFileId: 1, path: '/library/Old/a.mp4' }],
        renames: [],
      }}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(screen.getByText(/2160/));
  assert.ok(screen.getByText(/1080/));
  assert.ok(screen.getByText('/library/Old/a.mp4'));
});

test('confirm is disabled while the plan has blockers', () => {
  render(
    <IdentityChangeConfirm
      plan={{ ...MERGE, blockers: ['/library/New/a.mp4 is occupied'] }}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

  const confirm = screen.getByRole('button', { name: /confirm/i });
  assert.equal((confirm as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText(/is occupied/));
});

test('cancel calls back without confirming', () => {
  let confirmed = false;
  let cancelled = false;
  render(
    <IdentityChangeConfirm
      plan={MERGE}
      onConfirm={() => {
        confirmed = true;
      }}
      onCancel={() => {
        cancelled = true;
      }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

  assert.equal(cancelled, true);
  assert.equal(confirmed, false);
});
```

- [ ] **Step 3: Run and confirm it fails**

Run: `npm run test:web -- --test-name-pattern="merged into|superseded|blockers|cancel calls"`

Expected: FAIL — the component does not exist.

- [ ] **Step 4: Implement the component**

Create `packages/web/src/components/IdentityChangeConfirm.tsx`. Full `from → to` paths are rendered rather than basenames: a plan the user cannot read is a guess with extra steps.

```tsx
import type { IdentityPlanView } from '../api/client.ts';

interface Props {
  plan: IdentityPlanView;
  onConfirm(): void;
  onCancel(): void;
  busy?: boolean;
}

export function IdentityChangeConfirm({ plan, onConfirm, onCancel, busy = false }: Props) {
  const blocked = plan.blockers.length > 0;

  return (
    <div className="confirm" role="dialog" aria-label="Confirm identity change">
      {plan.mergeInto !== null ? (
        <p>
          This will merge into <strong>{plan.mergeInto.title}</strong>, moving{' '}
          {plan.releasesMoving} release(s) and {plan.downloadsMoving} download(s).
        </p>
      ) : (
        <p>
          This will re-key the group to <code>{plan.identityKey}</code>.
        </p>
      )}

      {plan.pick.surviving !== null && (
        <p>
          Picked release: {plan.pick.surviving.releaseId} (score {plan.pick.surviving.score}
          {plan.pick.surviving.side === 'target' ? ', already picked here' : ', moved in'}).
        </p>
      )}
      {plan.pick.superseded !== null && (
        <p className="warning">
          Release {plan.pick.superseded.releaseId} (score {plan.pick.superseded.score}) is no
          longer picked; its files are trashed below.
        </p>
      )}

      {plan.renames.length > 0 && (
        <>
          <h3>Files renamed</h3>
          <ul>
            {plan.renames.map((move) => (
              <li key={move.importedFileId}>
                <code>{move.from}</code> → <code>{move.to}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {plan.trashing.length > 0 && (
        <>
          <h3>Files trashed</h3>
          <ul>
            {plan.trashing.map((entry) => (
              <li key={entry.importedFileId}>
                <code>{entry.path}</code>
              </li>
            ))}
          </ul>
        </>
      )}

      {plan.warnings.map((warning) => (
        <p className="warning" key={warning}>
          {warning}
        </p>
      ))}
      {plan.blockers.map((blocker) => (
        <p className="error" key={blocker}>
          {blocker}
        </p>
      ))}

      <button type="button" onClick={onConfirm} disabled={blocked || busy}>
        Confirm
      </button>
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Implement the hook**

Create `packages/web/src/api/useIdentityChange.ts`:

```ts
import { useState } from 'react';
import { api, type IdentityPlanView } from './client.ts';

interface Pending {
  plan: IdentityPlanView;
  values: Record<string, string>;
  resolve(saved: boolean): void;
}

/**
 * The plan → confirm → apply sequence, in one place so Browse and Picks cannot
 * disagree about it.
 *
 * `begin` fulfils `MediaCard`'s `onEditGroup(values) => Promise<boolean>`
 * contract, so the card stays presentational — the same reason
 * `useIdentityPreview` was factored out of it. Not to be confused with that
 * hook: it previews the identity *key* per keystroke and knows nothing about a
 * group.
 *
 * A plan that moves nothing resolves without ever showing a confirmation, which
 * is what keeps a typo fix a one-click save.
 */
export function useIdentityChange(
  apply: (groupId: number, values: Record<string, string>, digest?: string) => Promise<boolean>,
  onError: (message: string) => void,
) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin(groupId: number, values: Record<string, string>): Promise<boolean> {
    let plan: IdentityPlanView;
    try {
      plan = await api.identityPlan(groupId, values);
    } catch (cause) {
      onError((cause as Error).message);
      return false;
    }

    const moves =
      plan.kind === 'merge' || plan.renames.length > 0 || plan.trashing.length > 0;
    if (!moves) return apply(groupId, values, undefined);

    return new Promise<boolean>((resolve) => {
      setPending({ plan, values, resolve });
    });
  }

  async function confirm(): Promise<void> {
    if (pending === null) return;
    setBusy(true);
    const saved = await apply(pending.plan.groupId, pending.values, pending.plan.digest);
    setBusy(false);
    // A stale digest comes back 409 and `apply` reports it. Re-plan in place so
    // the user reads what changed instead of losing their position.
    if (!saved) {
      try {
        const fresh = await api.identityPlan(pending.plan.groupId, pending.values);
        setPending({ ...pending, plan: fresh });
        return;
      } catch (cause) {
        onError((cause as Error).message);
      }
    }
    pending.resolve(saved);
    setPending(null);
  }

  function cancel(): void {
    if (pending === null) return;
    pending.resolve(false);
    setPending(null);
  }

  return { begin, plan: pending?.plan ?? null, confirm, cancel, busy };
}
```

- [ ] **Step 6: Run the web suite**

Run: `npm run test:web`

Expected: PASS.

- [ ] **Step 7: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/web/src/api/client.ts packages/web/src/api/useIdentityChange.ts \
        packages/web/src/components/IdentityChangeConfirm.tsx \
        packages/web/test/IdentityChangeConfirm.test.tsx
```

---

