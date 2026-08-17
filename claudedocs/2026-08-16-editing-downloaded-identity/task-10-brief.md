### Task 10: Wire Browse and Picks

**Files:**
- Modify: `packages/web/src/routes/Browse.tsx:100-116` (route through the hook), and its render
- Modify: `packages/web/src/routes/Picks.tsx` (fetch fields, pass the edit handlers, render the confirmation)
- Test: `packages/web/test/Picks.test.tsx` (extend), `packages/web/test/Browse.test.tsx` (extend)

**Interfaces:**
- Consumes: `useIdentityChange`, `IdentityChangeConfirm` (Task 9).
- Produces: no new exports.

- [ ] **Step 1: Write the failing Picks tests**

Append to `packages/web/test/Picks.test.tsx`, following that file's existing fetch-stub pattern:

```tsx
test('a picked group offers an edit form', async () => {
  stubApi({ picks: [PICKED_GROUP], manualFields: { test: FIELDS } });
  render(<Picks />);

  assert.ok(await screen.findByRole('button', { name: /edit/i }));
});

test('a display-only edit saves without a confirmation', async () => {
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { test: FIELDS },
    identityPlan: { ...PLAN_NO_MOVES },
  });
  render(<Picks />);

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fixed' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));

  await waitFor(() => assert.equal(stub.patched.length, 1));
  assert.equal(stub.patched[0]?.planDigest, undefined);
  assert.equal(screen.queryByRole('dialog'), null);
});

test('a merge shows the confirmation and only saves once confirmed', async () => {
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { test: FIELDS },
    identityPlan: PLAN_MERGE,
  });
  render(<Picks />);

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'k2' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));

  const dialog = await screen.findByRole('dialog');
  assert.ok(dialog);
  assert.equal(stub.patched.length, 0, 'nothing is saved before confirmation');

  fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

  await waitFor(() => assert.equal(stub.patched.length, 1));
  assert.equal(stub.patched[0]?.planDigest, PLAN_MERGE.digest);
});

test('a merge reloads the list rather than patching it', async () => {
  const stub = stubApi({
    picks: [PICKED_GROUP],
    manualFields: { test: FIELDS },
    identityPlan: PLAN_MERGE,
  });
  render(<Picks />);

  fireEvent.click(await screen.findByRole('button', { name: /edit/i }));
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'k2' } });
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));

  // Two: the initial load, then the reload after the merge. Which list a group
  // belongs to after a merge is the server's answer, not one to reconstruct.
  await waitFor(() => assert.equal(stub.pickCalls, 2));
});
```

Define `PLAN_NO_MOVES` (`kind: 'display-only'`, empty `renames`/`trashing`) and `PLAN_MERGE` (as in Task 9) at the top of the file.

- [ ] **Step 2: Run and confirm they fail**

Run: `npm run test:web -- --test-name-pattern="picked group offers|display-only edit saves|merge shows|reloads the list"`

Expected: FAIL — Picks renders no edit affordance.

- [ ] **Step 3: Wire Picks**

```tsx
  const [fields, setFields] = useState<Record<string, readonly ManualField[]>>({});

  useEffect(() => {
    void (async () => {
      try {
        setFields(await api.manualFields());
      } catch (cause) {
        setError((cause as Error).message);
      }
    })();
  }, []);

  /**
   * Reloads rather than patching the list, unlike Browse. A merge can take a
   * group off Picks entirely — when the survivor holds no pick — or bring one
   * onto it, and which list a group belongs to is the server's answer to give.
   */
  async function applyEdit(
    groupId: number,
    values: Record<string, string>,
    planDigest?: string,
  ): Promise<boolean> {
    try {
      const { failed } = await api.editGroup(groupId, values, planDigest);
      await reload();
      setError(
        failed.length === 0
          ? null
          : `Saved, but ${failed.length} file(s) could not be moved: ${failed
              .map((entry) => `${entry.path} (${entry.error})`)
              .join('; ')}`,
      );
      return true;
    } catch (cause) {
      setError((cause as Error).message);
      return false;
    }
  }

  const identityChange = useIdentityChange(applyEdit, setError);
```

Then in the render, pass `fields={fields[group.plugin]}`, `onEditGroup={(values) => identityChange.begin(group.id, values)}` and `onEditRelease={…}` to `MediaCard`, and render the confirmation when there is one:

```tsx
      {identityChange.plan !== null && (
        <IdentityChangeConfirm
          plan={identityChange.plan}
          onConfirm={() => void identityChange.confirm()}
          onCancel={identityChange.cancel}
          busy={identityChange.busy}
        />
      )}
```

Add an `editRelease` mirroring Browse's, reloading instead of patching for the same reason.

- [ ] **Step 4: Route Browse through the same hook**

In `Browse.tsx`, rename the existing `editGroup` to `applyEdit`, give it the third `planDigest` parameter and pass it to `api.editGroup`, keep its existing list-patching body and its merge notice, and surface `failed` the way Picks does. Then `const identityChange = useIdentityChange(applyEdit, setError);`, change the card's `onEditGroup` to `identityChange.begin`, and render `IdentityChangeConfirm` as above.

Add one Browse test asserting a merge still shows its "Releases moved into …" notice after confirmation, so the existing behaviour is pinned.

- [ ] **Step 5: Run the web suite**

Run: `npm run test:web`

Expected: PASS.

- [ ] **Step 6: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/web/src/routes/Picks.tsx packages/web/src/routes/Browse.tsx \
        packages/web/test/Picks.test.tsx packages/web/test/Browse.test.tsx
```

---

