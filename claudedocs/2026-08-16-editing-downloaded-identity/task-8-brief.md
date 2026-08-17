### Task 8: HTTP — the plan route, and the digest rule on PATCH

**Files:**
- Modify: `packages/core/src/http/server.ts:987-1001` (`PATCH /api/groups/:id`), and add the new route beside it
- Modify: `packages/core/src/http/views.ts` (`GroupEditResponse`, plus a plan view type)
- Test: `packages/core/test/http/manual.test.ts` (extend)

**Interfaces:**
- Consumes: `planIdentityChange`, `IdentityPlan`, `editGroup` (Tasks 5-7).
- Produces: `POST /api/groups/:id/identity-plan` → `IdentityPlan`; `PATCH /api/groups/:id` accepting `{ values, planDigest? }` and returning `{ group, mergedInto, renamed, trashed, failed }`.

- [ ] **Step 1: Write the failing route tests**

Append to `packages/core/test/http/manual.test.ts`, following that file's existing `server.inject` style:

```ts
test('POST /api/groups/:id/identity-plan describes a merge without performing it', async () => {
  const { server, db } = await harness();
  seedTwoGroups(db);

  const response = await server.inject({
    method: 'POST',
    url: '/api/groups/1/identity-plan',
    payload: { values: { key: 'k2', title: 'A' } },
  });

  assert.equal(response.statusCode, 200);
  const plan = response.json();
  assert.equal(plan.kind, 'merge');
  assert.equal(plan.mergeInto.id, 2);
  assert.ok(typeof plan.digest === 'string' && plan.digest.length > 0);
  assert.notEqual(getGroup(db, 1), null, 'planning changed nothing');
});

test('POST /api/groups/:id/identity-plan is 404 for a group that does not exist', async () => {
  const { server } = await harness();

  const response = await server.inject({
    method: 'POST',
    url: '/api/groups/77/identity-plan',
    payload: { values: { key: 'k1' } },
  });

  assert.equal(response.statusCode, 404);
});

test('PATCH /api/groups/:id refuses a merge with no digest', async () => {
  const { server, db } = await harness();
  seedTwoGroups(db);

  const response = await server.inject({
    method: 'PATCH',
    url: '/api/groups/1',
    payload: { values: { key: 'k2', title: 'A' } },
  });

  assert.equal(response.statusCode, 409);
});

test('PATCH /api/groups/:id applies a merge with a matching digest', async () => {
  const { server, db } = await harness();
  seedTwoGroups(db);
  const plan = (
    await server.inject({
      method: 'POST',
      url: '/api/groups/1/identity-plan',
      payload: { values: { key: 'k2', title: 'A' } },
    })
  ).json();

  const response = await server.inject({
    method: 'PATCH',
    url: '/api/groups/1',
    payload: { values: { key: 'k2', title: 'A' }, planDigest: plan.digest },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.mergedInto, 2);
  assert.equal(body.renamed, 0);
  assert.deepEqual(body.failed, []);
});

test('PATCH /api/groups/:id still applies a display-only edit with no digest', async () => {
  const { server, db } = await harness();
  seedTwoGroups(db);

  const response = await server.inject({
    method: 'PATCH',
    url: '/api/groups/1',
    payload: { values: { key: 'k1', title: 'Renamed' } },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().mergedInto, null);
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npm run test:server -- --test-name-pattern="identity-plan|digest"`

Expected: FAIL — no such route; PATCH ignores `planDigest`.

- [ ] **Step 3: Add the route and extend the body schema**

In `server.ts`, beside the existing `valuesBodySchema`, add:

```ts
const editBodySchema = z.object({
  values: z.record(z.string(), z.string()),
  planDigest: z.string().optional(),
});
```

Then the new route, next to `PATCH /api/groups/:id`:

```ts
  /**
   * Everything an identity change would do, and nothing done. Writes nothing —
   * a POST only because the values are a form's worth of fields and belong in a
   * body, not because anything changes.
   *
   * The statuses are the operation's own, carried rather than re-derived, for
   * the reason the four routes above state.
   */
  server.post('/api/groups/:id/identity-plan', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const body = valuesBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'Invalid request' });
    }

    const result = await planIdentityChange(manual, params.data.id, body.data.values);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });
    return result.ok;
  });
```

and change the PATCH handler's body parse to `editBodySchema` and its call to

```ts
    const result = await editGroup(manual, params.data.id, body.data.values, body.data.planDigest);
    if (!('ok' in result)) return reply.code(result.status).send({ error: result.error });

    const group = groupAfter(result.ok.groupId);
    if (group === null) return reply.code(404).send({ error: 'No such group' });
    const response: GroupEditResponse = {
      group,
      mergedInto: result.ok.mergedInto,
      renamed: result.ok.renamed,
      trashed: result.ok.trashed,
      failed: result.ok.failed,
    };
    return response;
```

In `views.ts`, extend `GroupEditResponse` with `renamed: number; trashed: number; failed: readonly { path: string; error: string }[];`.

- [ ] **Step 4: Run and confirm they pass**

Run: `npm run test:server`

Expected: PASS.

- [ ] **Step 5: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/http/server.ts packages/core/src/http/views.ts \
        packages/core/test/http/manual.test.ts
```

---

