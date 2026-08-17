# Re-key Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A startup pass that re-parses every scene group's release name with the live plugin and brings its identity key, display, search text and library filenames back into agreement with the parser.

**Architecture:** Not a numbered migration. Migration 8 creates one table (`app_state`) and nothing else; the pass itself lives in `packages/core/src/pipeline/` and runs from `main.ts` after the plugin registry is built. It re-parses `feed_items.raw_title` through the *live* plugin and the existing `validateIdentity`, so it cannot disagree with the parser by construction. Reads and writes are split: a pure planner produces a list of proposed changes, and a writer applies them one group per transaction. The planner alone is the always-on drift check.

**Tech Stack:** TypeScript 7 (`tsgo`), `node:sqlite`, `node:test` + tsx, `node:fs/promises`, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-14-rekey-scene-slugs-design.md`. Read it before Task 1.

## Global Constraints

- **Never** the `any` type. `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and `erasableSyntaxOnly` are on — the last rejects parameter properties.
- Node 24.19.0 **exactly**: `export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`. Below it, `packages/core/test/clients/theporndb.test.ts` and `packages/core/test/media/artwork.test.ts` fail on `AbortSignal.timeout` under mock timers. Six agents on the parent plan reported those as defects; all six were wrong. The ledger blamed Node 22, but the real floor is higher — **24.15.0 also fails**, measured on this machine; `mock.timers.enable({apis: ['AbortSignal.timeout']})` throws `ERR_INVALID_ARG_VALUE` there. Probe it in one line before believing any failure in those two files.
- **Async fs only** — `node:fs/promises`. This runs while a server is booting; a sync rename blocks the event loop.
- `PRAGMA foreign_keys = ON` is set in `db/open.ts:12` and there is **no `ON DELETE` clause anywhere in the schema**. The pass therefore deletes **exactly one kind of row**: a group it merges away, and only via the ordering `manual/operations.ts:296-323` already proves correct (releases move, flag re-derives, `clearGroupMetadata`, then `deleteGroup`). Nothing else, ever. Deleting a group that has ever been browsed fails the FK from the four metadata tables — the 500 in `docs/known-issues.md:478-482`.
- **The next free migration version is 8.** The plan originally said 7; `main` has since landed 7 (the `performers` table), and the owner's 2026-08-16 database already reports `schema_migrations = [1..7]`. Versions have collided twice on this project (`migrations.ts:502-508`, `:516-518`) — this would have been the third. `assertUniqueVersions` (`migrate.ts:27-38`) refuses a duplicate at startup.
- Comments carry reasoning and measured evidence, not restatements of the code. Match the density and voice of the file you are editing.
- A wrong answer is worse than no answer: skipping a group beats writing a key we are unsure of.
- Tests must not compute an expected value from the code under test.
- **Do not push. Do not merge.** Commit on the branch.

## Expected scale, measured against `pickarr-2026-08-16.db`

Task 7 asserts these. If your numbers differ, that is a finding — report it, do not adjust the code to match.

Re-measured 2026-08-16 after rebasing onto `main`, against the owner's current backup. The
08-14 column is kept because a number that moved is worth seeing move: the library grew ~29% in
two days, so treat the *ratios* as stable and the absolutes as a snapshot.

| | 08-14 (original) | **08-16 (assert these)** |
|---|---|---|
| scene groups | 945 | **1222** |
| keys the pass moves | 60 | **63** |
| of those, with a live imported file to rename | 6 | **6** |
| display/search moves, key unchanged | *believed unreachable* | **31** |
| hand-edited, skipped | 24 | **33** |
| `raw_title` no longer parses, skipped | 12 | **0** |
| collisions | 0 | **1** (mergeable — see Task 4a) |
| full re-parse, cold | 8–16 ms | **~120 ms** |
| full re-parse, warm | — | **~80 ms** |

Two of these rows are findings in their own right, not just bigger numbers:

**The 31 display moves are real, and the parser is not their cause.** The plan's original
self-review guessed this class "may not be reachable, since both derive from the same title." It
is reachable, and the cause is the *site list*: these groups were ingested before their site was
confirmed, so a re-parse now resolves the display spelling — `JulesJordan` → `Jules Jordan`,
`OhMyHoles` → `Oh! My Holes`, `MyPervyFamily` → `My Pervy Family`. Same key, corrected display.
Owner's ruling: **in scope, and `clearGroupMetadata` fires for them**, because the metadata was
matched against the old spelling and a stored answer is settled only while the question is fixed.
Budget 31 metadata refetches on the boot after the pass. A real fixture is therefore available for
Task 3 case 7 — **do not weaken that test to an assertion about the condition**.

**The drift check is over its budget and grows linearly.** ~120 ms cold for 1222 titles against
the plan's "~100 ms, say so" line, and the library is growing. Recorded, not fixed: Task 6 should
report the measurement rather than optimise it, but if this doubles again it wants a cheaper
trigger than every boot.

## File Structure

- **Create** `packages/core/src/db/transaction.ts` — `inTransaction`, moved out of `manual/operations.ts` so two callers can share it.
- **Create** `packages/core/src/db/app-state.ts` — `getAppState` / `setAppState`, the only readers of the new table.
- **Create** `packages/core/src/pipeline/rekey.ts` — the planner and the writer. One file: they share types and are meaningless apart.
- **Modify** `packages/core/src/db/migrations.ts` — migration **8**, `app_state` DDL.
- **Modify** `packages/core/src/manual/operations.ts` — import `inTransaction` instead of defining it, and export the merge body so the pass reuses it rather than reimplementing it (Task 4a).
- **Modify** `packages/core/src/main.ts` — call the pass after `loadPlugins`, before `server.listen`.
- **Test** `packages/core/test/pipeline/rekey.test.ts`, `packages/core/test/db/app-state.test.ts`, and additions to `packages/core/test/db/migrate.test.ts`.

---

### Task 1: Migration 8 and the `app_state` table

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

- [ ] **Step 3: Add migration 8**

In `packages/core/src/db/migrations.ts`, add the DDL as a module-level template string beside the others, then register it in the `migrations` array as `version: 8` — **not 7, which `main` took for the `performers` table**. The comment is required and must state the admission rule, because a generic key-value table rots by accretion when there is no rule to point at:

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
test('app_state arrives at version 8 and takes no other version', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const applied = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((row) => Number((row as { version: unknown }).version));
  assert.deepEqual(applied, [1, 2, 3, 4, 5, 6, 7, 8]);
});
```

- [ ] **Step 6: Run the tests and confirm they pass**

- [ ] **Step 7: Break it on purpose.** Change migration 8's registered version to `7` — the collision that nearly happened for real — and confirm `assertUniqueVersions` refuses with the "Duplicate migration version" error rather than silently skipping. Revert. Paste the output in your report.

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
  | { kind: 'skipped-collision'; withGroupId: number; reason: string }
  | { kind: 'merge'; intoGroupId: number }
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
6. Two groups whose new keys collide, **both carrying history** → both `skipped-collision`, each naming the other, each with a `reason` a human can act on.
6a. A collision where the *mover* has no history at all → `merge`, naming the group it merges into. See Task 4a for the direction rule and why the owner overruled the spec here.
6b. A collision where the mover has history but the holder does not → still `skipped-collision`, **not** a merge in the other direction. The pass never deletes a group that has files or downloads recorded against it, and reversing the direction to dodge that is exactly the cleverness that turns a repair into data loss.
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
- Produces: `export interface RekeyReport { moved: number; renamed: number; merged: number; skippedEdited: number; skippedUnparsable: number; skippedCollision: number; failed: number }` and `export async function applyRekey(db, registry, deps): Promise<RekeyReport>`. `merged` stays 0 until Task 4a fills it; declaring it here keeps the report shape from changing under a test written in Task 4.

- [ ] **Step 1: Write the failing tests**

1. A `move` proposal writes `identity_key`, `display` and `search_text` together.
2. **`clearGroupMetadata` runs in the same transaction** when `displayChanged` — assert the `group_metadata`, `metadata_queue`, `metadata_candidates` **and `group_performers`** rows for that group are all gone. `group_performers` is the fourth such table and the newest, added on `main` by `e229966` after this plan was written; the original plan named only three, so a test copied from it would pass while missing the one most likely to be forgotten. Assert all four by enumerating the tables, not by naming three and trusting the list stays short.
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

### Task 4a: Merge a collision that is provably one scene

**Files:**
- Modify: `packages/core/src/manual/operations.ts`, `packages/core/src/pipeline/rekey.ts`
- Modify: `packages/core/test/pipeline/rekey.test.ts`

**This task narrows a spec decision, on the owner's ruling and on evidence. It does not overturn
it.** Read this before writing anything, and read spec §5 with it — the distinction below is the
whole task, and an implementer who misses it will either merge too much or merge nothing.

Spec §5 argues collisions are reported and never merged. Its reasoning is *specific to the class
it analysed*: the accepted collision of two genuinely **different** scenes that differ only in
tokens this branch drops — `Suki.Sin.Solo.42466` and `Suki.Sin.Hardcore.42467` colliding on
`pornmegaload:2026-08-05:suki-sin` (`known-issues.md:281-314`). For that class the spec is still
right and this task changes nothing: fusing two scenes a user may hold separate files for is
exactly the wrong answer, and it stays reported.

What the spec did not contemplate is a **second class**, which is what the owner's database
actually contains: the same scene in two groups at two encodes. That is migration 4's shape, where
merging is pure repair rather than fusion.

```
group  106  ClubSweethearts.26.08.07.Foxy.Dreams.Solo.XXX.1080p.MP4-WRB   moves, loses "Solo"
group 1137  ClubSweethearts.2026.08.07.Foxy.Dreams.720p.x265              already holds the key
```

```
group  106  ClubSweethearts.26.08.07.Foxy.Dreams.Solo.XXX.1080p.MP4-WRB   moves, loses "Solo"
group 1137  ClubSweethearts.2026.08.07.Foxy.Dreams.720p.x265              already holds the key
```

One scene, two encodes, two groups. Measured history:

| | group 106 | group 1137 |
|---|---|---|
| releases | 3 | 1 |
| downloads | 0 | **1** |
| imported files | 0 | **1** |
| metadata rows | 0 | **1** |
| picked release | none | 1535 |

So the merge direction is not a judgement call — 106 has *no history whatsoever*, and merging it
into 1137 hands the user a 1080p WRB release next to the 720p x265 they already downloaded, which
today they cannot see because the two groups are separate.

**How to tell the classes apart, mechanically.** Do not try to decide "is this the same scene?"
semantically — that is a guess, and a wrong guess here deletes a group. Use history as the proxy,
because it is what the user would lose: a mover with no downloads, no imported files (live *or*
trashed) and no metadata has nothing that merging can destroy, so merging it is recoverable by
re-ingest. Anything else is reported. This deliberately declines to merge some genuine duplicates;
that is the right direction to err, and spec §5's "a wrong answer is worse than no answer" is the
reason.

Note that this rule is not new to the project: migration 4 already chose a survivor by
"live imported file, then any download, then lowest id" (spec §5, `migrations.ts:254-260`). Task
4a's rule is that precedent restricted to the case where the *loser* has none of those.

**Rewrite spec §5 in this task's commit** — not to say "we merge now", but to name the two classes
and give each its answer. Leaving a spec that reads as a blanket prohibition is how the next
reader "corrects" this code back out.

**Reuse the existing merge. Do not write a second one.** `manual/operations.ts:296-323` already
performs this exact operation with the ordering the foreign keys demand — releases move,
`refreshUpgradeFlag`/`flagUpgrade` re-derives over them, `clearGroupMetadata`, then `deleteGroup`
last as the one statement that can throw. It is tested and its comments carry the reasoning. Lift
that body into a named function both callers share, exactly as Task 2 lifts `inTransaction`, and
move it verbatim — a behaviour change hidden in a move is the hardest kind to review.

- [ ] **Step 1: Write the failing tests**

1. Mover with no history, holder with history → the mover is gone, its releases are on the holder, and the holder keeps its own key, pick and imported file.
2. **Mover with a download → no merge.** `skipped-collision`, both groups intact. Same for a mover with an imported file, including a trashed one — `groupHistory` counts trashed rows as history and so must this.
3. **Direction is decided by history, never by which group is moving.** Give the mover history and the holder none, and assert the pass refuses rather than merging the holder away.
4. Both groups have history → `skipped-collision`, named in the report.
5. Neither has history → merge, with a stated deterministic tiebreak (lower `id` survives). Assert the tiebreak, so the choice is pinned rather than incidental to row order.
6. **`edited_at` is not stamped on the survivor.** The existing merge calls `markGroupEdited`, and its comment justifies that by the user having named the scene — *a pass is not a user*. Stamping would immunise the survivor against every future pass, which Task 4 test 6 forbids. This is the one deliberate divergence from the lifted body; it must be a parameter, and the comment must say why.
7. A failed merge is counted in `failed` and does not stop the pass.

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement.** One transaction per merge, as Task 4. `RekeyReport` gains `merged`.

- [ ] **Step 4: Run and confirm.**

- [ ] **Step 5: Break it on purpose.** Move `deleteGroup` before `clearGroupMetadata` and confirm the FK fires rather than passing quietly — that is the 500 in `known-issues.md:478-482`, reproduced deliberately. Then drop the `groupHistory` guard and confirm test 2 fails. Revert both; paste both outputs.

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

- [ ] **Step 1: Copy the backup.** `cp /home/chad/Projects/pickarr/pickarr-2026-08-16.db /tmp/rekey-check.db`. **Work only on the copy** — never open the owner's backup for writing. (The path is Linux now; the original plan's `/Users/cwalker/...` was written on a different machine.)

- [ ] **Step 2: Run the planner alone** against the copy and report the outcome counts. Expected: **1222 groups, 63 moves, 6 renames, 31 display-only moves, 33 skipped-edited, 0 skipped-unparsable, 1 collision (mergeable).** A different number is a finding: report it with the reasoning, do not tune the code until it matches. Parse with `knownSiteNames(db)` — 74 names in this database — because the 31 display moves exist *only* under a site list and vanish without one.

- [ ] **Step 3: Run the writer** against the copy, with a temp library root so no real file is touched. Confirm: 63 groups moved, 1 merged, every moved group's key equals a fresh `plugin.parse` of its raw title, **exactly one group deleted and it is group 106**, no `edited_at` stamped anywhere, and `app_state` written once.

- [ ] **Step 4: Run it a second time** and confirm the second run is a no-op — 0 moves, 0 renames, no writes.

- [ ] **Step 5: Remove the marker and run again**, confirming it is a no-op *on its own merits* — the pass converges, so it should propose nothing even unmarked. If it proposes moves on a converged database, the planner disagrees with itself and that is a defect.

- [ ] **Step 6: Report timings.** Already measured and **already over budget**: ~120 ms cold, ~80 ms warm, for 1222 titles. Confirm it against your implementation and report the number; the cold figure is the one that matters, because a boot-time check only ever runs cold. Do not optimise it under this plan — record it, and say whether it grew.

- [ ] **Step 7: `npm run check`** green, report counts. **Baseline after the rebase onto `main` is 899 server / 165 web** — not the 793/92 this plan was written against, which predated 66 commits of `main`. Commit nothing but your report.

---

## Self-review

**Spec coverage.** §3 pass-not-migration → Task 3. §3 marker and startup → Tasks 1, 6. §4 hand-edited skip → Task 3 case 3, Task 4 test 6. §5 collisions → Task 3 case 6 **and Task 4a, which overrules the spec's never-merge rule; §5 must be rewritten in Task 4a's commit**. §6 per-row writes and `clearGroupMetadata` → Task 4. §6a file renames and ordering → Task 5. §7 failure containment → Task 4 test 7, Task 4a test 7, Task 6 test 5. §8 testing list → distributed across Tasks 3–6. §10 scale → Task 7. §11's two open questions: `edited_at` becoming load-bearing is recorded, not implemented; **the "12 unparsable groups" question is closed — there are now 0**.

**Type consistency.** `RekeyOutcome`, `RekeyProposal`, `RekeyReport` are declared once in Task 3/4 and referenced unchanged after. `PreparedIdentity` is `{identityKey, displayJson, searchText}` from `ingest/commit.ts:28-32` — `displayJson`, not `display`, and `updateGroupIdentity` takes it as its `display` field (`db/groups.ts:486-489`).

**~~Known gap~~ — CLOSED, and the guess was wrong.** This said Task 3 case 7 (key unchanged, display changed) "may not be reachable through the scenes parser, since both derive from the same title," and licensed the implementer to weaken the test to an assertion about the condition. **That licence is withdrawn.** The case is reachable 31 times in the owner's current database, because the display does *not* derive from the title alone — it derives from the title *and the site list*, and the site list learns. `JulesJordan` becomes `Jules Jordan` once the site is confirmed, with the key untouched. Build the real fixture: insert a group whose stored display carries the unresolved spelling, parse with a site list that knows the resolved one, and assert the move. This is the distinction that broke the metadata invariant the second time, and it now has evidence behind it rather than a caveat.
