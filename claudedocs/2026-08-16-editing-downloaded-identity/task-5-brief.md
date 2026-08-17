### Task 5: The planner — classification, counts, and pick reconciliation

Database-only. `renames` and `trashing` come back empty until Task 6; `blockers` and `warnings` empty; the digest is already real.

**Files:**
- Create: `packages/core/src/manual/values.ts`
- Create: `packages/core/src/manual/identity-plan.ts`
- Modify: `packages/core/src/manual/operations.ts` (delete the four helpers now in `values.ts`, import them instead)
- Test: `packages/core/test/manual/identity-plan.test.ts` (create)

**Interfaces:**
- Consumes: `getGroup`, `findGroup`, `releasesForGroup`, `releaseScore` (existing db functions).
- Produces:
  - `values.ts`: `buildRelease`, `mergedValues`, `editHooks`, `mediaFor` — moved verbatim from `operations.ts`, plus
    `resolveIdentityFor(plugin: MediaTypePlugin, group: GroupRow, values: Record<string, string>): { identity: PreparedIdentity } | { error: string; status: 400 | 409 }`
  - `identity-plan.ts`: `IdentityPlan`, `PlannedRename`, `PlannedTrash`, and
    `planIdentityChange(deps: ManualDeps, groupId: number, values: Record<string, string>): Promise<ManualResult<IdentityPlan>>`

- [ ] **Step 1: Move the four helpers into `values.ts`**

Create `packages/core/src/manual/values.ts`. Move `buildRelease`, `mergedValues`, `editHooks` and `mediaFor` out of `operations.ts` **verbatim, comments and all** — they are not being rewritten, only relocated so two modules can share them. Add `export` to each. Then add:

```ts
/**
 * The identity a group would have if these values were saved.
 *
 * The three steps — prefill, merge, rebuild, validate — were inline in
 * `editGroup` when it was the only caller. The planner and the applier must
 * agree exactly about what a set of values *means*, and the cheapest way to
 * guarantee that is for there to be one function that decides.
 *
 * `mediaFor(group, '{}')` passes an empty quality deliberately: a group holds
 * none of its own — quality is release-level — and the plugin contract requires
 * a correct key and display from the identity-scoped values alone.
 */
export function resolveIdentityFor(
  plugin: MediaTypePlugin,
  group: GroupRow,
  values: Record<string, string>,
): { identity: PreparedIdentity } | { error: string; status: 400 | 409 } {
  const hooks = editHooks(plugin);
  if (hooks === null) {
    return { error: `plugin ${plugin.id} does not support manual editing`, status: 409 };
  }

  const merged = mergedValues(plugin, hooks.to, mediaFor(group, '{}'), values);
  if ('error' in merged) return { error: merged.error, status: 400 };

  const built = buildRelease(plugin, hooks.from, merged.values);
  if ('error' in built) return { error: built.error, status: 400 };

  const validated = validateIdentity(built.media);
  if ('error' in validated) return { error: validated.error, status: 400 };

  return { identity: validated.identity };
}
```

In `operations.ts`, import `buildRelease`, `mergedValues`, `editHooks`, `mediaFor` from `./values.ts` — `resolveFeedItem` and `editRelease` still use them.

- [ ] **Step 2: Run the suite to confirm the move changed nothing**

Run: `npm run test:server -- --test-name-pattern="editGroup|editRelease|resolve"`

Expected: PASS, unchanged. A pure relocation that breaks a test means it was not pure.

- [ ] **Step 3: Write the failing planner test**

Create `packages/core/test/manual/identity-plan.test.ts`. Reuse the `PLUGIN`, `registryFor` and `makeDeps` shapes from `operations.test.ts` — copy them in; a shared fixture module is not worth it for two files, and `operations.test.ts` already keeps its own.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { planIdentityChange } from '../../src/manual/identity-plan.ts';
// PLUGIN, makeDeps, ok, failure: copied from operations.test.ts

/**
 * Group 1 is keyed `k1`, picked on release 1 (1080). Group 2 is keyed `k2`,
 * state new, holding release 2 (2160). This is the reported scenario in
 * miniature: correcting group 1's key to `k2` must merge it into group 2.
 */
function seedTwoGroups(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               picked_release_id, created_at, list_rank_at)
     VALUES (1, 'test', 'k1', '{"title":"A","fields":[]}', 'a', 'picked', 1,    100, 100),
            (2, 'test', 'k2', '{"title":"B","fields":[]}', 'b', 'new',    NULL, 100, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (1, 'f', 'g1', 'T1', 'https://i.invalid/1.nzb', 100),
            (2, 'f', 'g2', 'T2', 'https://i.invalid/2.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (1, 1, 1, '{"resolution":1080}', 1080, 100),
            (2, 2, 2, '{"resolution":2160}', 2160, 100)`,
  ).run();
  db.prepare(
    `INSERT INTO downloads (id, release_id, group_id, client_id, kind, status,
                            created_at, updated_at)
     VALUES (1, 1, 1, 'sab', 'initial', 'imported', 100, 100)`,
  ).run();
}

test('an unchanged identity plans nothing', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k1', title: 'A' }));

  assert.equal(plan.kind, 'none');
  assert.equal(plan.mergeInto, null);
  assert.deepEqual(plan.renames, []);
});

test('a changed display alone is display-only', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k1', title: 'Renamed' }));

  assert.equal(plan.kind, 'display-only');
});

test('a key belonging to no group is a rekey', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k9', title: 'A' }));

  assert.equal(plan.kind, 'rekey');
  assert.equal(plan.mergeInto, null);
});

test('a key belonging to another group is a merge, and names it', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.equal(plan.kind, 'merge');
  assert.deepEqual(plan.mergeInto, { id: 2, title: 'B' });
  assert.equal(plan.releasesMoving, 1);
  assert.equal(plan.downloadsMoving, 1);
});

test('an unpicked target adopts the source pick', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.deepEqual(plan.pick.surviving, { releaseId: 1, score: 1080, side: 'source' });
  assert.equal(plan.pick.superseded, null);
});

test('when both sides have a pick the higher score wins', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.deepEqual(plan.pick.surviving, { releaseId: 2, score: 2160, side: 'target' });
  assert.deepEqual(plan.pick.superseded, { releaseId: 1, score: 1080 });
});

test('a tie between two picks goes to the target', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  db.prepare('UPDATE releases SET score = 1080 WHERE id = 2').run();
  db.prepare("UPDATE media_groups SET state = 'picked', picked_release_id = 2 WHERE id = 2").run();

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.deepEqual(plan.pick.surviving, { releaseId: 2, score: 1080, side: 'target' });
});

test('a pick naming a release the merged group will not hold counts as no pick', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);
  db.prepare('UPDATE media_groups SET picked_release_id = 999 WHERE id = 1').run();

  const plan = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.equal(plan.pick.surviving, null);
  assert.equal(plan.pick.superseded, null);
});

test('the digest changes when a displayed field changes', async () => {
  const db = openTestDatabase();
  seedTwoGroups(db);

  const first = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (3, 'f', 'g3', 'T3', 'https://i.invalid/3.nzb', 100)`,
  ).run();
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (3, 1, 3, '{"resolution":720}', 720, 100)`,
  ).run();
  const second = ok(await planIdentityChange(makeDeps(db), 1, { key: 'k2', title: 'A' }));

  assert.equal(second.releasesMoving, 2);
  assert.notEqual(first.digest, second.digest, 'one more release moving is a material change');
});

test('planning a group that does not exist is 404', async () => {
  const db = openTestDatabase();

  assert.equal(failure(await planIdentityChange(makeDeps(db), 77, { key: 'k1' })).status, 404);
});
```

- [ ] **Step 4: Run and confirm it fails**

Run: `npm run test:server -- --test-name-pattern="plan"`

Expected: FAIL — `identity-plan.ts` does not exist.

- [ ] **Step 5: Implement the planner's database half**

Create `packages/core/src/manual/identity-plan.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { findGroup, getGroup, type GroupRow } from '../db/groups.ts';
import { releasesForGroup } from '../db/releases.ts';
import type { ManualDeps, ManualResult } from './operations.ts';
import { resolveIdentityFor } from './values.ts';

/** One file to be moved because the identity that placed it has changed. */
export interface PlannedRename {
  importedFileId: number;
  from: string;
  to: string;
}

/** One file to be trashed because the release that owns it lost the pick. */
export interface PlannedTrash {
  importedFileId: number;
  path: string;
}

export interface IdentityPlan {
  groupId: number;
  identityKey: string;
  /**
   * `none` — the key and the display both survive the edit.
   * `display-only` — the key survives, the display does not.
   * `rekey` — the key changes and belongs to no other group.
   * `merge` — the key belongs to another group, which will absorb this one.
   */
  kind: 'none' | 'display-only' | 'rekey' | 'merge';
  mergeInto: { id: number; title: string } | null;
  releasesMoving: number;
  downloadsMoving: number;
  pick: {
    surviving: { releaseId: number; score: number; side: 'source' | 'target' } | null;
    superseded: { releaseId: number; score: number } | null;
  };
  renames: readonly PlannedRename[];
  trashing: readonly PlannedTrash[];
  /** Shown, and does not stop the apply. */
  warnings: readonly string[];
  /** Shown, and refuses the apply. */
  blockers: readonly string[];
  digest: string;
}

/**
 * `JSON.stringify` over an object built in a fixed key order, which is what
 * makes this stable — do not reorder the literal in `finish()` below, and do not
 * build it from a spread of something whose order is not fixed.
 *
 * `crypto.subtle`, not `createHash`: this runs on the request path, and the
 * async form is the house rule for anything that would otherwise block the
 * loop.
 */
async function digestOf(plan: Omit<IdentityPlan, 'digest'>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(plan));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function titleOf(group: GroupRow): string {
  const display = JSON.parse(group.display) as { title?: string };
  return display.title ?? group.identityKey;
}

function countDownloads(db: DatabaseSync, groupId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM downloads WHERE group_id = ?')
    .get(groupId) as { n: number } | undefined;
  return row === undefined ? 0 : Number(row.n);
}

/**
 * The pick the merged group ends up with, and the one it does not.
 *
 * Higher score wins; a tie goes to the target, matching migration 4's rule that
 * the survivor's pick stands. A pick naming a release the merged group will not
 * hold counts as no pick at all — `holds()` in `db/migrations.ts` makes the same
 * call, for the same reason: a dangling pick is already broken, and a merge is
 * the one moment it could be spread rather than merely tolerated.
 */
function reconcilePick(
  db: DatabaseSync,
  source: GroupRow,
  target: GroupRow | null,
): IdentityPlan['pick'] {
  const heldScore = (releaseId: number | null, groupId: number): number | null => {
    if (releaseId === null) return null;
    const row = db
      .prepare('SELECT score FROM releases WHERE id = ? AND group_id = ?')
      .get(releaseId, groupId) as { score: number } | undefined;
    return row === undefined ? null : Number(row.score);
  };

  const sourceScore = heldScore(source.pickedReleaseId, source.id);
  const targetScore = target === null ? null : heldScore(target.pickedReleaseId, target.id);

  if (sourceScore === null && targetScore === null) return { surviving: null, superseded: null };
  if (targetScore === null) {
    return {
      surviving: { releaseId: source.pickedReleaseId!, score: sourceScore!, side: 'source' },
      superseded: null,
    };
  }
  if (sourceScore === null) {
    return {
      surviving: { releaseId: target!.pickedReleaseId!, score: targetScore, side: 'target' },
      superseded: null,
    };
  }

  return sourceScore > targetScore
    ? {
        surviving: { releaseId: source.pickedReleaseId!, score: sourceScore, side: 'source' },
        superseded: { releaseId: target!.pickedReleaseId!, score: targetScore },
      }
    : {
        surviving: { releaseId: target!.pickedReleaseId!, score: targetScore, side: 'target' },
        superseded: { releaseId: source.pickedReleaseId!, score: sourceScore },
      };
}

/**
 * Everything an identity change would do, and nothing done.
 *
 * Reads the database and stats the filesystem; writes neither. Both the preview
 * route and the apply call this, which is the point: the plan a user confirms
 * and the plan that runs are the same computation, so they cannot drift.
 */
export async function planIdentityChange(
  deps: ManualDeps,
  groupId: number,
  values: Record<string, string>,
): Promise<ManualResult<IdentityPlan>> {
  const { db } = deps;
  const group = getGroup(db, groupId);
  if (group === null) return { error: `no such group: ${groupId}`, status: 404 };

  const plugin = deps.registry.byId(group.plugin);
  if (plugin === undefined) {
    return { error: `no plugin loaded for id ${group.plugin}`, status: 409 };
  }

  const resolved = resolveIdentityFor(plugin, group, values);
  if ('error' in resolved) return { error: resolved.error, status: resolved.status };
  const identity = resolved.identity;

  const target =
    identity.identityKey === group.identityKey
      ? null
      : findGroup(db, group.plugin, identity.identityKey);
  const merging = target !== null && target.id !== group.id;

  const kind: IdentityPlan['kind'] = merging
    ? 'merge'
    : identity.identityKey !== group.identityKey
      ? 'rekey'
      : identity.displayJson !== group.display
        ? 'display-only'
        : 'none';

  const pick = merging
    ? reconcilePick(db, group, target)
    : reconcilePick(db, group, null);

  const withoutDigest: Omit<IdentityPlan, 'digest'> = {
    groupId,
    identityKey: identity.identityKey,
    kind,
    mergeInto: merging ? { id: target.id, title: titleOf(target) } : null,
    releasesMoving: merging ? releasesForGroup(db, group.id).length : 0,
    downloadsMoving: merging ? countDownloads(db, group.id) : 0,
    pick,
    renames: [],
    trashing: [],
    warnings: [],
    blockers: [],
  };

  return { ok: { ...withoutDigest, digest: await digestOf(withoutDigest) } };
}
```

Note on the non-null assertions in `reconcilePick`: each is guarded by the `heldScore` result immediately above it — a non-null score can only have come from a non-null release id. If the reviewer prefers, restructure `heldScore` to return `{ releaseId, score } | null`; do **not** reach for `any` or `unknown` to silence it.

- [ ] **Step 6: Run and confirm it passes**

Run: `npm run test:server -- --test-name-pattern="plan"`

Expected: PASS, all eleven.

- [ ] **Step 7: Gate and stage**

```bash
npm run lint && npm run typecheck && npm run test && npm run build
git add packages/core/src/manual/values.ts packages/core/src/manual/identity-plan.ts \
        packages/core/src/manual/operations.ts packages/core/test/manual/identity-plan.test.ts
```

---

