### Task 7: Wire it into the running process

**Files:**
- Modify: `packages/core/src/main.ts:92-96` (client type), `:127-156` (runner construction), `:167-169` (scheduler options)
- Test: `packages/core/test/main.test.ts` (extend)

**Interfaces consumed:** `createPerformerRunner`, `PerformerPassDeps` (Task 6); `PerformerLookupClient` (Task 3).

- [ ] **Step 1: Write the failing test**

Extend `packages/core/test/main.test.ts` following its existing style — read how that file builds a config and stubs the scheduler before writing these, and reuse those fixtures.

```ts
test('one metadata tick runs the scene pass and then the performer pass', async () => {
  // Order matters and is the reason this is asserted rather than assumed: a
  // performer search is the fallback for a scene lookup that settled without a
  // cast, so the pass that produces those rows has to run before the pass that
  // drains them. Asserting the *sequence* — not just that both ran — is what
  // pins it.
  // Arrange: a config with metadata.enabled true and a siteLookup apiKey, and a
  //   fetch stub recording each request path in order.
  // Act: start the process far enough to obtain the scheduler's `runMetadata`,
  //   and await one invocation.
  // Assert: the recorded paths are ['/scenes…', '/performers…'] — scenes first.
});

test('metadata disabled runs neither pass', async () => {
  // `runMetadata` stays undefined and the scheduler registers no timer at all,
  // which is already how an absent metadata client is expressed. Adding a second
  // pass must not turn that into a partially-registered tick.
  // Assert: the scheduler received no `runMetadata`, and no request was made.
});

test('no provider client runs neither pass, without throwing', async () => {
  // metadata.enabled true but siteLookup unconfigured. The existing code logs and
  // leaves `runMetadata` undefined; the performer runner must not be built from an
  // undefined client and then invoked.
});
```

Fill in each `Arrange / Act / Assert` against the fixtures in that file. If `main.test.ts` has no seam that exposes the scheduler's options, do not invent one for this — assert instead on the request paths the fetch stub recorded, which is the observable that actually matters.

- [ ] **Step 2: Run and watch it fail**

```
node --import tsx --conditions development --test packages/core/test/main.test.ts
```

- [ ] **Step 3: Implement**

`createTpdbClient` now returns `PerformerLookupClient` too, so widen the `tpdbClient` declaration at line 92 to `(SiteLookupClient & SceneLookupClient & PerformerLookupClient) | undefined`.

Inside the same `else` branch that builds `runMetadata` (line 136 onward), build a performer runner from the same client and `config.metadata.perTick`, and compose the two into the single `runMetadata` closure the scheduler already receives:

```ts
    // One tick drives both passes, in order. No second interval: a second knob
    // is a second thing to tune wrong, and both passes talk to the same
    // rate-limited service, so sharing one cadence is what keeps the combined
    // request rate predictable. Scenes first — a performer search is the
    // fallback for a scene lookup that settled without a cast, so the pass that
    // produces those rows runs before the pass that drains them. A row enqueued
    // this tick is therefore searched on the next one, which is correct: the
    // enqueue and the search are separate decisions.
    const runScenes = createMetadataRunner({
      db,
      client,
      pluginFor,
      artwork,
      perTick: config.metadata.perTick,
      now: () => Date.now(),
      log,
    });
    const runPerformers = createPerformerRunner({
      db,
      client,
      pluginFor,
      perTick: config.metadata.perTick,
      now: () => Date.now(),
      log,
    });
    runMetadata = async () => {
      await runScenes();
      await runPerformers();
    };
```

Copy the `createMetadataRunner` argument list from what is already at that call site rather than from the sketch above — it is written from lines 147-155 and the surrounding code may have moved. `client` satisfies both `SceneLookupClient` and `PerformerLookupClient`, so the same value is passed to both without a cast.

`await` both in sequence rather than `Promise.all`: they talk to one rate-limited service, and running them concurrently would double the instantaneous request rate that `perTick` exists to bound.

Extend the existing "metadata: enabled, every Ns, N per tick" log line to say the performer pass shares the tick, so an operator reading the log knows both are running.

- [ ] **Step 4: Verify everything**

```
npm run check
npm run build
```

Expected: green lint, green typecheck, all tests passing, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/main.ts packages/core/test/main.test.ts
git commit -m "Run the performer pass on the metadata tick"
```

---

## Notes for the controller

- **Nothing pushes.** Seven commits land on `feature/performer-search-queue`; the repo owner approves any push and any merge.
- **The endpoint is the one unverifiable piece.** Task 3's tests stub `fetch`, so they prove the reader and the error handling, not that TPDB answers this shape. The response example in the spec came from the repo owner. If the live API disagrees on a field name, Task 3's reader is the only place to change.
- **Expect this to link almost nothing at first,** and do not treat that as a bug to fix mid-plan. The spec's §12 says so deliberately: two words of a scene title are a guess, and the tiered rule is built so a wrong guess writes nothing. If the linking rate is disappointing, §12 lists the follow-ups in cost order — all additive, none in this plan.
- **Task 3 Step 3 is a refactor of shipped code.** The existing scene-metadata tests are its safety net; if they do not all pass before you move to Step 4, stop rather than continuing forward.
- **Two places this plan refines the spec, both deliberate and both argued at the point of use.** First, the spec puts both enqueue refusals in one function; the plan splits them, keeping the castless check in `db/` where no caller can bypass it and the plugin question in `pipeline/` where the registry lives (Task 5's Interfaces note). Second, the spec has the *client* log a truncated page; the client has no `log` dependency and giving it one to say this would be the wrong seam, so `searchPerformers` returns `truncated` and the pass logs it (Task 3's `PerformerSearchPage` comment, Task 6's truncation test). Neither changes observable behaviour. If a reviewer disagrees with either, they are cheap to move.
