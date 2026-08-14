# Re-key Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A startup pass that re-parses every scene group's release name with the live plugin and brings its identity key, display, search text and library filenames back into agreement with the parser.

**Architecture:** Not a numbered migration. Migration 7 creates one table (`app_state`) and nothing else; the pass itself lives in `packages/core/src/pipeline/` and runs from `main.ts` after the plugin registry is built. It re-parses `feed_items.raw_title` through the *live* plugin and the existing `validateIdentity`, so it cannot disagree with the parser by construction. Reads and writes are split: a pure planner produces a list of proposed changes, and a writer applies them one group per transaction. The planner alone is the always-on drift check.

**Tech Stack:** TypeScript 7 (`tsgo`), `node:sqlite`, `node:test` + tsx, `node:fs/promises`, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-14-rekey-scene-slugs-design.md`. Read it before Task 1.

## Global Constraints

- **Never** the `any` type. `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and `erasableSyntaxOnly` are on — the last rejects parameter properties.
- Node 24 required: `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`. On Node 22, `packages/core/test/clients/theporndb.test.ts` and `packages/core/test/media/artwork.test.ts` fail on `AbortSignal.timeout` under mock timers. Six agents on the parent plan reported those as defects; all six were wrong.
- **Async fs only** — `node:fs/promises`. This runs while a server is booting; a sync rename blocks the event loop.
- `PRAGMA foreign_keys = ON` is set in `db/open.ts:12` and there is **no `ON DELETE` clause anywhere in the schema**. This pass therefore **deletes no rows, ever**. Deleting a group that has ever been browsed fails the FK from the three metadata tables — the 500 in `docs/known-issues.md:478-482`.
- **The next free migration version is 7.** Versions have collided twice on this project (`migrations.ts:502-508`, `:516-518`); `assertUniqueVersions` (`migrate.ts:27-38`) will refuse a duplicate at startup.
- Comments carry reasoning and measured evidence, not restatements of the code. Match the density and voice of the file you are editing.
- A wrong answer is worse than no answer: skipping a group beats writing a key we are unsure of.
- Tests must not compute an expected value from the code under test.
- **Do not push. Do not merge.** Commit on the branch.

## Expected scale, measured against `pickarr-2026-08-14.db`

Task 7 asserts these. If your numbers differ, that is a finding — report it, do not adjust the code to match.

| | |
|---|---|
| scene groups | 945 |
| keys the pass moves | 60 |
| of those, with a live imported file to rename | 6 |
| hand-edited, skipped | 24 |
| `raw_title` no longer parses, skipped | 12 |
| full re-parse of all 945 | 8–16 ms |

## File Structure

- **Create** `packages/core/src/db/transaction.ts` — `inTransaction`, moved out of `manual/operations.ts` so two callers can share it.
- **Create** `packages/core/src/db/app-state.ts` — `getAppState` / `setAppState`, the only readers of the new table.
- **Create** `packages/core/src/pipeline/rekey.ts` — the planner and the writer. One file: they share types and are meaningless apart.
- **Modify** `packages/core/src/db/migrations.ts` — migration 7, `app_state` DDL.
- **Modify** `packages/core/src/manual/operations.ts` — import `inTransaction` instead of defining it.
- **Modify** `packages/core/src/main.ts` — call the pass after `loadPlugins`, before `server.listen`.
- **Test** `packages/core/test/pipeline/rekey.test.ts`, `packages/core/test/db/app-state.test.ts`, and additions to `packages/core/test/db/migrate.test.ts`.

---

### Task 1: Migration 7 and the `app_state` table

**Files:**
- Modify: `packages/core/src/db/migrations.ts`
- Create: `packages/core/src/db/app-state.ts`
- Create: `packages/core/test/db/app-state.test.ts`
- Modify: `packages/core/test/db/migrate.test.ts`

**Interfaces:**
- Produces: `getAppState(db, key): string | null`, `setAppState(db, key, value, now): void`

- [ ] **Step 1: Write the failing test** in `packages/core/test/db/app-state.test.ts`

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.ts';
import { getAppState, setAppState } from '../../src/db/app-state.ts';

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

test('an unset key reads as null rather than throwing', () => {
  assert.equal(getAppState(freshDb(), 'pass:nothing-ran'), null);
});

test('a value survives a write and reads back exactly', () => {
  const db = freshDb();
  setAppState(db, 'pass:rekey-scene-slugs', '60', 1_700_000_000_000);
  assert.equal(getAppState(db, 'pass:rekey-scene-slugs'), '60');
});

test('writing the same key twice replaces rather than throwing on the primary key', () => {
  const db = freshDb();
  setAppState(db, 'pass:rekey-scene-slugs', '60', 1_700_000_000_000);
  setAppState(db, 'pass:rekey-scene-slugs', '61', 1_700_000_000_001);
  assert.equal(getAppState(db, 'pass:rekey-scene-slugs'), '61');
  const rows = db.prepare('SELECT COUNT(*) AS n FROM app_state').get() as { n: number };
  assert.equal(rows.n, 1);
});
```

- [ ] **Step 2: Run it and watch it fail**

`npm run test -w @pickarr/core` — expect a module-not-found for `app-state.ts`, or `no such table: app_state`.

- [ ] **Step 3: Add migration 7**

In `packages/core/src/db/migrations.ts`, add the DDL as a module-level template string beside the others, then register it in the `migrations` array as `version: 7`. The comment is required and must state the admission rule, because a generic key-value table rots by accretion when there is no rule to point at:

```ts
/**
 * One small operational fact about this installation per row.
 *
 * A generic key-value table earns its keep only while it stays small, so the
 * rule is written here rather than left to taste: a row is a pass marker, a
 * cursor, a "when did this last run" — something singular, operational, and
 * never read in bulk. Not user data. Not anything joined against. Not anything
 * with enough structure to want columns; that earns a real table. Keys are
 * namespaced `subsystem:name` so a reader can tell at a glance who owns one.
 *
 * It exists because the re-key pass is deliberately not a migration — it runs
 * the live parser, so it has no place in `schema_migrations` — and it still
 * needs somewhere to record that it has run. See
 * docs/superpowers/specs/2026-08-14-rekey-scene-slugs-design.md.
 */
const APP_STATE = `
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
```

- [ ] **Step 4: Write `db/app-state.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';

export function getAppState(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  if (row === undefined) return null;
  return String((row as { value: unknown }).value);
}

export function setAppState(db: DatabaseSync, key: string, value: string, now: number): void {
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}
```

- [ ] **Step 5: Add a migration-numbering test** to `packages/core/test/db/migrate.test.ts`, following the shape of the existing tests there

```ts
test('app_state arrives at version 7 and takes no other version', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const applied = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => Number((row as { version: unknown }).version));
  assert.deepEqual(applied, [1, 2, 3, 4, 5, 6, 7]);
});
```

- [ ] **Step 6: Run the tests and confirm they pass**

- [ ] **Step 7: Break it on purpose.** Change migration 7's registered version to `6` and confirm `assertUniqueVersions` refuses with the "Duplicate migration version" error rather than silently skipping. Revert. Paste the output in your report.

- [ ] **Step 8: Commit.** `feat: add app_state for pass markers`

---

### Task 2: Move `inTransaction` so two callers can share it

**Files:**
- Create: `packages/core/src/db/transaction.ts`
- Modify: `packages/core/src/manual/operations.ts`

**Interfaces:**
- Produces: `inTransaction<T>(db: DatabaseSync, body: () => T): T`

Pure refactor. No test changes, and the existing suite is the proof.

- [ ] **Step 1: Read the current definition** at `packages/core/src/manual/operations.ts:60`. Move it verbatim — body, comment and all — into `packages/core/src/db/transaction.ts` and export it. Do not "improve" it while moving; a behaviour change hidden in a move is the hardest kind to review.

- [ ] **Step 2: Import it** in `operations.ts` and delete the local copy. Its four call sites (`:160`, `:203`, `:232`, and the merge branch) are unchanged.

- [ ] **Step 3: Run the full suite.** `npm run check` must be green with **no test edits**. If a test needed changing, you changed behaviour — stop and report.

- [ ] **Step 4: Commit.** `refactor: lift inTransaction into db/`

---

### Task 3: The planner — a pure read that proposes changes

**Files:**
- Create: `packages/core/src/pipeline/rekey.ts`
- Create: `packages/core/test/pipeline/rekey.test.ts`

**Interfaces:**
- Consumes: `validateIdentity` from `../ingest/commit.ts`; `PluginRegistry.byId` from `../plugins/registry.ts`; `knownSiteNames` from `../db/sites.ts`
- Produces:

```ts
export type RekeyOutcome =
  | { kind: 'unchanged' }
  | { kind: 'skipped-edited' }
  | { kind: 'skipped-unparsable'; reason: string }
  | { kind: 'skipped-collision'; withGroupId: number }
  | { kind: 'move'; identityKey: string; displayJson: string; searchText: string;
      displayChanged: boolean; renames: { fileId: number; from: string; to: string }[] };

export interface RekeyProposal {
  groupId: number;
  outcome: RekeyOutcome;
}

export function planRekey(db: DatabaseSync, registry: PluginRegistry): RekeyProposal[];
```

**This task writes nothing.** It is also the drift check of its own accord — Task 6 calls it on every boot and only counts.

- [ ] **Step 1: Write the failing tests.** Build each fixture by inserting rows directly, so the test states the database it means rather than driving ingest. A helper keeps them readable:

```ts
function groupWithRelease(db: DatabaseSync, opts: {
  rawTitle: string; identityKey: string; display: string; editedAt?: number;
}): number { /* insert feed_items, media_groups, releases; return group id */ }
```

Cases, each its own `test()`:

1. A group whose stored key already matches a fresh parse → `unchanged`.
2. A group whose title carries a trailing tag → `move`, with `identityKey` equal to what `plugin.parse` returns for that name (obtain it by calling the plugin in the test, not by hardcoding a slug — this is the one place reading the parser is correct, because the assertion is *agreement with the parser*, which is the property under test).
3. `edited_at` set → `skipped-edited`, even though its title would move.
4. `raw_title` that the parser refuses → `skipped-unparsable`, with the reason recorded.
5. A group with no reachable `raw_title` at all (no releases row) → `skipped-unparsable`.
6. Two groups whose new keys collide → **both** `skipped-collision`, each naming the other.
7. A group whose key is unchanged but whose display differs → `move` with `displayChanged: true`. This is the case that broke the metadata invariant the second time; it must not be classified `unchanged`.
8. A group belonging to a plugin id the registry does not know → `skipped-unparsable`, not a throw.
9. `renames` is empty for a group with no live imported files, and populated for one that has them; a `trashed_at IS NOT NULL` row contributes no rename.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement `planRekey`.**

Read the groups and their first release's raw title in one query:

```sql
SELECT g.id, g.plugin, g.identity_key, g.display, g.edited_at,
       (SELECT fi.raw_title
          FROM releases r JOIN feed_items fi ON fi.id = r.feed_item_id
         WHERE r.group_id = g.id ORDER BY r.id LIMIT 1) AS raw_title
  FROM media_groups g
 ORDER BY g.id
```

Notes that will otherwise cost you a debugging round:

- **`media_groups.plugin` holds `plugin.id`, not the package name.** Resolve with `registry.byId(row.plugin)`. Getting this wrong makes the pass silently enrich nothing, which is how an earlier feature on this project shipped broken.
- Parse with the site list the running instance has: `knownSiteNames(db)`. Multi-token sites resolve differently without it, and the identity key depends on the result.
- Go through `validateIdentity(parsed)` — never build `displayJson` or `searchText` yourself. `ingest/commit.ts:220-224` records that the one place `display` is serialized must stay the one place `searchText` is derived, and this pass is now a third writer of identity keys bound by `manual.ts:356-360`.
- `displayChanged` compares the serialized display, because a title correction can reduce to the same slug — the key survives while the question the display produces does not (`manual/operations.ts:333-334`).
- Collisions: build a map of proposed new key → group id **plus** every *unchanged* group's existing key, then mark any group whose target is already taken. A moved key colliding with a group that is not moving is just as real as two movers colliding.
- Fetch renames per group from `imported_files WHERE group_id = ? AND trashed_at IS NULL`, and compute the new destination with the plugin's own `planImport`, exactly as `pipeline/import.ts:324` does. Do not string-replace the old title inside the old path.

- [ ] **Step 4: Run the tests and confirm they pass.**

- [ ] **Step 5: Break it on purpose.** Make `displayChanged` always `false` and confirm case 7 fails. Resolve the plugin with a package name instead of `byId` and confirm every case degrades to `skipped-unparsable`. Revert both; paste both outputs.

- [ ] **Step 6: Commit.**

---

### Task 4: The writer — re-key and invalidate metadata, no files yet

**Files:**
- Modify: `packages/core/src/pipeline/rekey.ts`
- Modify: `packages/core/test/pipeline/rekey.test.ts`

**Interfaces:**
- Consumes: `updateGroupIdentity` (`db/groups.ts:486`), `clearGroupMetadata` (`db/metadata.ts:311`), `inTransaction` (Task 2)
- Produces: `export interface RekeyReport { moved: number; renamed: number; skippedEdited: number; skippedUnparsable: number; skippedCollision: number; failed: number }` and `export async function applyRekey(db, registry, deps): Promise<RekeyReport>`

- [ ] **Step 1: Write the failing tests**

1. A `move` proposal writes `identity_key`, `display` and `search_text` together.
2. **`clearGroupMetadata` runs in the same transaction** when `displayChanged` — assert the `group_metadata`, `metadata_queue` and `metadata_candidates` rows for that group are all gone.
3. A `move` with `displayChanged: false` (slug moved, display identical, if reachable — otherwise assert the condition is on display and say so) does **not** clear metadata.
4. An `unchanged` group is not written at all. Assert by leaving a sentinel: set `search_text` to a value the writer would overwrite, and confirm it survives. Comparing equal values would pass even if a write happened.
5. `skipped-*` groups are untouched, and each is counted in the report.
6. `edited_at` is **not** stamped by the pass, and `list_rank_at`, `created_at` and `picked_release_id` are unchanged. A pass is not a human; stamping `edited_at` would immunise every re-keyed group against the next pass (`migrations.ts:268-272`).
7. A group whose write throws is counted in `failed`, leaves that group at its old key, and **does not stop the pass** — a later group still moves.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement `applyRekey`.** One transaction **per group**, not one for the whole pass: a single poison row must not roll back 59 good ones. Catch per group, count, continue. Never delete a row.

- [ ] **Step 4: Run and confirm.**

- [ ] **Step 5: Break it on purpose.** Remove the `clearGroupMetadata` call and confirm test 2 fails — that is the invariant this project has broken twice. Widen the transaction to wrap the whole loop and confirm test 7 fails. Revert both; paste both outputs.

- [ ] **Step 6: Commit.**

---

### Task 5: File renames, inside the same transaction

**Files:**
- Modify: `packages/core/src/pipeline/rekey.ts`
- Modify: `packages/core/test/pipeline/rekey.test.ts`

**Interfaces:**
- Consumes: `rename` from `node:fs/promises`, injected through `deps` so tests can fail it on demand
- Produces: `renamed` populated in `RekeyReport`

Only `{titledots}` moves, so every rename is **within one directory** — that is what makes this safe, and it is worth a comment.

- [ ] **Step 1: Write the failing tests**, against a real temp dir from `node:fs/promises` `mkdtemp`

1. A moved group with a live file: the file exists at its new path, the old path is gone, and `imported_files.dest_path` holds the new one.
2. **A rename that throws leaves everything as it was** — old path intact, `dest_path` unchanged, `identity_key` unchanged, group counted in `failed`.
3. **A commit that fails after a successful rename renames back.** Inject a failing commit; assert the file is at its *original* path afterwards.
4. A destination that already exists on disk → skip the group, count it, rename nothing, and leave the key alone. Do not overwrite.
5. `trash_path` is never rewritten.
6. A group with two live files renames both, or neither if one fails.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** Order, per group, and it is load-bearing:

1. open the transaction
2. write the identity and every new `dest_path`
3. `await rename(...)` each file
4. commit

On a rename failure, roll back and re-rename anything already moved. On a commit failure, rename everything back. Doing the disk work inside the transaction window is what lets both failure directions end consistent; committing first would leave the database pointing at a path that does not exist, and `findLiveByDest` (`pipeline/import.ts:379`) and `trashLiveFiles` (`pipeline/upgrade.ts:102-138`) both trust that string to find a real file.

Use `fs/promises`. Check existence with a `stat` that tolerates `ENOENT` rather than an `existsSync`.

- [ ] **Step 4: Run and confirm.**

- [ ] **Step 5: Break it on purpose.** Move the commit before the renames and confirm test 3 fails. Drop the destination-exists check and confirm test 4 fails. Revert both; paste both outputs.

- [ ] **Step 6: Commit.**

---

### Task 6: Run it at startup

**Files:**
- Modify: `packages/core/src/main.ts`
- Modify: `packages/core/src/pipeline/rekey.ts`
- Modify: `packages/core/test/pipeline/rekey.test.ts`

- [ ] **Step 1: Write the failing tests**

1. With no marker, the pass applies and then writes `app_state['pass:rekey-scene-slugs']`.
2. With the marker present, the pass does **not** apply — assert via a sentinel as in Task 4, not by equal values.
3. The marker is written **in the same transaction as the final batch**, so an interrupted pass re-runs. Simulate a throw before the marker write and confirm a second run still moves the remaining groups.
4. The drift check runs whether or not the marker is set, writes nothing, touches no files, and reports the count.
5. **A pass that throws outright does not prevent startup.** The caller logs and continues.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Wire it into `main.ts`.** After `const registry = await loadPlugins(config);` (`main.ts:63`) and before `await server.listen(...)` (`:240`). `migrate` has already run inside `openDatabase` (`db/open.ts:14`).

The whole call must be inside a `try`/`catch` that logs and continues. `migrate`'s own runner rethrows and aborts startup by design (`db/migrate.ts:69-80`) — that is right for schema, and wrong for a pass over user data. A parser regression must not make the application unbootable.

Log one line with the report either way, and the drift count when it is non-zero.

- [ ] **Step 4: Run and confirm.**

- [ ] **Step 5: Break it on purpose.** Remove the `try`/`catch` and make the pass throw; confirm a startup test fails. Revert; paste the output.

- [ ] **Step 6: Commit.**

---

### Task 7: Verify against the owner's real database

**Files:** none — this task measures and reports.

The suite proves the logic; this proves the numbers.

- [ ] **Step 1: Copy the backup.** `cp /Users/cwalker/Projects/pickarr/pickarr-2026-08-14.db /tmp/rekey-check.db`. **Work only on the copy** — never open the owner's backup for writing.

- [ ] **Step 2: Run the planner alone** against the copy and report the outcome counts. Expected: **945 groups, 60 moves, 6 renames, 24 skipped-edited, 12 skipped-unparsable, 0 collisions.** A different number is a finding: report it with the reasoning, do not tune the code until it matches.

- [ ] **Step 3: Run the writer** against the copy, with a temp library root so no real file is touched. Confirm: 60 groups moved, every moved group's key equals a fresh `plugin.parse` of its raw title, no group deleted, no `edited_at` stamped, and `app_state` written once.

- [ ] **Step 4: Run it a second time** and confirm the second run is a no-op — 0 moves, 0 renames, no writes.

- [ ] **Step 5: Remove the marker and run again**, confirming it is a no-op *on its own merits* — the pass converges, so it should propose nothing even unmarked. If it proposes moves on a converged database, the planner disagrees with itself and that is a defect.

- [ ] **Step 6: Report timings.** The full re-parse of 945 groups should be tens of milliseconds. If the drift check costs more than ~100 ms, say so — it runs on every boot.

- [ ] **Step 7: `npm run check`** green, report counts (793 server / 92 web before this plan). Commit nothing but your report.

---

## Self-review

**Spec coverage.** §3 pass-not-migration → Task 3. §3 marker and startup → Tasks 1, 6. §4 hand-edited skip → Task 3 case 3, Task 4 test 6. §5 collisions reported → Task 3 case 6. §6 per-row writes and `clearGroupMetadata` → Task 4. §6a file renames and ordering → Task 5. §7 failure containment → Task 4 test 7, Task 6 test 5. §8 testing list → distributed across Tasks 3–6. §10 scale → Task 7. §11's two open questions are recorded, not implemented: `edited_at` becoming load-bearing, and the 12 unparsable groups.

**Type consistency.** `RekeyOutcome`, `RekeyProposal`, `RekeyReport` are declared once in Task 3/4 and referenced unchanged after. `PreparedIdentity` is `{identityKey, displayJson, searchText}` from `ingest/commit.ts:28-32` — `displayJson`, not `display`, and `updateGroupIdentity` takes it as its `display` field (`db/groups.ts:486-489`).

**Known gap.** Task 3 case 7 (key unchanged, display changed) may not be reachable through the scenes parser, since both derive from the same title. If it is not, the implementer should assert the *condition* is written against display rather than the key and say so, instead of forcing a fixture. The distinction is what broke the invariant the second time and must not be lost.
