### Task 3: Expose the file mover for reuse inside the library

The rename must not grow a second file mover — `transfer` already handles the atomic rename, the EXDEV fallback, and the real-path containment check.

**Files:**
- Modify: `packages/core/src/pipeline/import.ts:137` (`resolveDestination`), `:272` (`transfer`)
- Test: `packages/core/test/pipeline/import.test.ts` (extend)

**Interfaces:**
- Produces:
  - `export function resolveDestination(libraryRoot: string, destination: string): string` (add `export` to the existing function)
  - `export async function moveWithinLibrary(from: string, to: string, libraryRootReal: string, renameImpl?: RenameLike): Promise<void>`
  - `export type RenameLike` (already defined in this file; add `export` if absent)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/pipeline/import.test.ts`:

```ts
test('moveWithinLibrary moves a file and keeps it inside the library root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickarr-move-'));
  const libraryRoot = join(root, 'library');
  await mkdir(join(libraryRoot, 'Old'), { recursive: true });
  await writeFile(join(libraryRoot, 'Old', 'scene.mp4'), 'data');
  const libraryRootReal = await realpath(libraryRoot);

  await moveWithinLibrary(
    join(libraryRoot, 'Old', 'scene.mp4'),
    join(libraryRoot, 'New', '2026-08-14 - Title.mp4'),
    libraryRootReal,
  );

  assert.equal(await readFile(join(libraryRoot, 'New', '2026-08-14 - Title.mp4'), 'utf8'), 'data');
  assert.equal(await lstatOrNull(join(libraryRoot, 'Old', 'scene.mp4')), null);
});

test('moveWithinLibrary falls back to copy when rename reports EXDEV', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickarr-move-'));
  const libraryRoot = join(root, 'library');
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(join(libraryRoot, 'a.mp4'), 'data');
  const libraryRootReal = await realpath(libraryRoot);

  await moveWithinLibrary(
    join(libraryRoot, 'a.mp4'),
    join(libraryRoot, 'b.mp4'),
    libraryRootReal,
    () => Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' })),
  );

  assert.equal(await readFile(join(libraryRoot, 'b.mp4'), 'utf8'), 'data');
  assert.equal(await lstatOrNull(join(libraryRoot, 'a.mp4')), null, 'the source is removed');
});

test('moveWithinLibrary refuses a destination outside the library root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pickarr-move-'));
  const libraryRoot = join(root, 'library');
  await mkdir(libraryRoot, { recursive: true });
  await writeFile(join(libraryRoot, 'a.mp4'), 'data');
  const libraryRootReal = await realpath(libraryRoot);

  await assert.rejects(
    moveWithinLibrary(join(libraryRoot, 'a.mp4'), join(root, 'escaped.mp4'), libraryRootReal),
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run test:server -- --test-name-pattern="moveWithinLibrary"`

Expected: FAIL — not exported.

- [ ] **Step 3: Add `export` and the named wrapper**

In `packages/core/src/pipeline/import.ts`, add `export` to `resolveDestination` and to the `RenameLike` type if it is not already exported. Then, immediately after `transfer`:

```ts
/**
 * Moves a file from one place in the library to another.
 *
 * A thin, named wrapper over `transfer` in `'move'` mode, and named because the
 * caller's intent matters: an identity change relocates a file that is *already*
 * in the library, so the mode is never a configuration question. `importMode`
 * decides how a file arrives from the download volume; copying inside the
 * library would leave two copies of one file and a record of one.
 */
export async function moveWithinLibrary(
  from: string,
  to: string,
  libraryRootReal: string,
  renameImpl: RenameLike = rename,
): Promise<void> {
  await transfer(from, to, 'move', renameImpl, libraryRootReal);
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm run test:server -- --test-name-pattern="moveWithinLibrary"`

Expected: PASS (all three).

- [ ] **Step 5: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/pipeline/import.ts packages/core/test/pipeline/import.test.ts
```

---

