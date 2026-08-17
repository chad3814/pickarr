### Task 4: Give the manual operations a library to write to

The planner and applier need `trashDir` and an injectable `rename`. `ServerDeps` does not carry `trashDir` today; `config.trashDir` exists and `main.ts` is where it is read.

**Files:**
- Modify: `packages/core/src/manual/operations.ts:32-37` (`ManualDeps`)
- Modify: `packages/core/src/http/server.ts:63-90` (`ServerDeps`), `:320-325` (the `manual` object)
- Modify: `packages/core/src/main.ts:293-312` (the `buildServer` call)
- Test: `packages/core/test/manual/operations.test.ts:102-109` (`makeDeps`), `packages/core/test/http/server.test.ts` (its `buildServer` fixture)

**Interfaces:**
- Produces: `ManualDeps` gains `trashDir: string` and `rename?: RenameLike`; `ServerDeps` gains `trashDir: string`.

- [ ] **Step 1: Extend `ManualDeps`**

```ts
export interface ManualDeps {
  db: DatabaseSync;
  registry: PluginRegistry;
  pluginForFeed(feedId: string): MediaTypePlugin | null;
  now(): number;
  /**
   * Where a superseded pick's files go when an identity change merges two
   * groups. The same directory an upgrade import trashes into, and for the same
   * reason: one scene ends up with one owned file, and the other is recoverable
   * by hand rather than deleted.
   */
  trashDir: string;
  /** Injectable so a test can fail one rename mid-loop. Defaults to `fs.rename`. */
  rename?: RenameLike;
}
```

Add `import type { RenameLike } from '../pipeline/import.ts';`.

- [ ] **Step 2: Extend `ServerDeps` and the `manual` object**

In `server.ts`, add to `ServerDeps`:

```ts
  /**
   * `config.trashDir`, passed in rather than re-read here for the same reason
   * `artworkDir` is: this module has no other business knowing the config
   * document's shape, and a second read is how the two copies drift.
   */
  trashDir: string;
```

and to the `manual` object at line 320:

```ts
  const manual: ManualDeps = {
    db,
    registry: deps.registry,
    pluginForFeed: (feedId) => deps.pluginForFeed(feedId),
    now: () => deps.now(),
    trashDir: deps.trashDir,
  };
```

- [ ] **Step 3: Wire it in `main.ts`**

Add `trashDir: config.trashDir,` to the `buildServer({ … })` object, beside `artworkDir`.

- [ ] **Step 4: Update the two test fixtures**

In `packages/core/test/manual/operations.test.ts`, `makeDeps` gains `trashDir: '/trash'`. In `packages/core/test/http/server.test.ts`, the `buildServer` fixture gains `trashDir`. Use the temp directory the file already creates if it has one; otherwise `'/trash'` is fine, because no test in this task's scope reaches it.

- [ ] **Step 5: Confirm nothing broke**

Run: `npm run typecheck && npm run test`

Expected: PASS. This task adds no behaviour; a green suite is the whole assertion.

- [ ] **Step 6: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/manual/operations.ts packages/core/src/http/server.ts \
        packages/core/src/main.ts packages/core/test/manual/operations.test.ts \
        packages/core/test/http/server.test.ts
```

---

