### Task 5: Queue the search when a lookup settles

**Files:**
- Create: `packages/core/src/pipeline/performers.ts` (the enqueue half only; Task 6 adds the pass to this file)
- Modify: `packages/core/src/pipeline/metadata.ts` (inside `runMetadataPass`, after `outcome` is assigned)
- Test: `packages/core/test/pipeline/performers-enqueue.test.ts` (create)
- Test: `packages/core/test/pipeline/metadata.test.ts` (extend)

**Interfaces:**
- Consumes: `insertPerformerSearch`, `groupHasCast` from `../db/performer-queue.ts` (Task 2); `MediaTypePlugin.performerQuery` (Task 1).
- Produces, both consumed by Task 6:

```ts
export interface PerformerEnqueueDeps {
  db: DatabaseSync;
  pluginFor(pluginId: string): MediaTypePlugin | null;
  log(message: string): void;
}
/** The query for one group, or null when it is not worth asking about. */
export function performerQueryFor(deps: PerformerEnqueueDeps, groupId: number): string | null;
export function enqueuePerformerSearch(
  deps: PerformerEnqueueDeps,
  groupId: number,
  now: number,
): boolean;
```

`performerQueryFor` is exported because Task 6's pass needs the same query the enqueue decided on, and re-deriving it there from the plugin would be the rule spelled twice. Task 6 imports this, it does not reimplement it.

**A note on where the two refusals live.** The spec's §4 lists both refusals — already-has-a-cast, and plugin-yields-no-query — as `enqueuePerformerSearch`'s. They are, but the function lives here in the pipeline layer rather than in `db/`, because only this layer has the plugin registry. The castless half is a pure SQL question and stays in `db/performer-queue.ts` as `insertPerformerSearch`'s own guard, so it cannot be bypassed by a future caller. This mirrors `metadataAnswerability`, which likewise sits in `pipeline/metadata.ts` rather than in `db/`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/pipeline/performers-enqueue.test.ts`. Reuse the `seedGroup` / `giveCast` helpers from `packages/core/test/db/performer-queue.test.ts` by copying them in — the two files test different layers and a shared fixture module is not worth it for two helpers.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { GroupIdentity, MediaTypePlugin } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { duePerformerQueue } from '../../src/db/performer-queue.ts';
import {
  enqueuePerformerSearch,
  performerQueryFor,
  type PerformerEnqueueDeps,
} from '../../src/pipeline/performers.ts';

/** One picked group, titled so the two-word rule has something to cut. */
function seedGroup(db: DatabaseSync, id: number, title: string): void {
  db.prepare(
    `INSERT INTO feed_items (id, feed_id, guid, raw_title, link, first_seen_at)
     VALUES (?, 'f', ?, ?, ?, 1)`,
  ).run(id, `g${id}`, title, `https://indexer.invalid/${id}.nzb`);
  db.prepare(
    `INSERT INTO media_groups (id, plugin, identity_key, display, search_text, state,
                               created_at, list_rank_at)
     VALUES (?, 'test', ?, ?, ?, 'picked', 1, 1)`,
  ).run(id, `k${id}`, JSON.stringify({ title, subtitle: 'Some Site', fields: [] }), `g${id}`);
  db.prepare(
    `INSERT INTO releases (id, group_id, feed_item_id, quality, score, created_at)
     VALUES (?, ?, ?, '{}', 100, 1)`,
  ).run(id, id, id);
}

/** Gives the group a cast, the way a confirmed scene answer does. */
function giveCast(db: DatabaseSync, groupId: number): void {
  db.prepare(
    `INSERT INTO performers (id, source, source_uuid, slug, name, kind, fetched_at)
     VALUES (?, 'theporndb', ?, 'someone', 'Someone', 'performer', 1)`,
  ).run(groupId, `uuid-${groupId}`);
  db.prepare(
    'INSERT INTO group_performers (group_id, performer_id, position) VALUES (?, ?, 0)',
  ).run(groupId, groupId);
}

/**
 * A plugin whose `performerQuery` behaves as told. `undefined` stands for a
 * plugin that does not implement the method at all, which is how a media type
 * with no notion of performers opts out.
 */
function pluginWith(
  performerQuery: ((identity: GroupIdentity) => string | null) | undefined,
): MediaTypePlugin {
  // A real minimal plugin, the shape `metadata.test.ts:577` uses — not a cast
  // through `unknown`. If `MediaTypePlugin` gains a required member this fails to
  // typecheck, which is the signal you want; a cast would hide it.
  const plugin: MediaTypePlugin = {
    id: 'test',
    displayName: 'Test',
    parse: () => null,
    score: () => 0,
    planImport: () => null,
  };
  return performerQuery === undefined ? plugin : { ...plugin, performerQuery };
}

function depsWith(db: DatabaseSync, plugin: MediaTypePlugin | null): PerformerEnqueueDeps {
  return { db, pluginFor: () => plugin, log: () => {} };
}

test('a castless group with a query is queued', () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const deps = depsWith(db, pluginWith((identity) => identity.display.title.split(' ').slice(0, 2).join(' ')));

  assert.equal(performerQueryFor(deps, 1), 'Jessica Jaymes');
  assert.equal(enqueuePerformerSearch(deps, 1, 500), true);
  assert.deepEqual(duePerformerQueue(db, 500, 10).map((row) => row.groupId), [1]);
  db.close();
});

test('a group whose plugin offers no query is not queued', () => {
  // A one-word title is the real case: the plugin returns null rather than a
  // one-word query. Not queueing is a silent success — the caller is a pass
  // draining a queue, not a user action that can fail.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Solo');
  const deps = depsWith(db, pluginWith(() => null));

  assert.equal(performerQueryFor(deps, 1), null);
  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  db.close();
});

test('a plugin that does not implement performerQuery queues nothing', () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const deps = depsWith(db, pluginWith(undefined));

  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  db.close();
});

test('a group with a cast is not queued', () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  giveCast(db, 1);
  const deps = depsWith(db, pluginWith(() => 'Jessica Jaymes'));

  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  db.close();
});

test('a group whose plugin is no longer configured is not queued', () => {
  // `pluginFor` answering null is normal, not a bug: a plugin can be removed
  // from config after groups it created already exist.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const deps = depsWith(db, null);

  assert.equal(performerQueryFor(deps, 1), null);
  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  db.close();
});

test('a plugin that throws building the query does not take the caller down', () => {
  // The caller is a loop over settled rows inside `runMetadataPass`. A plugin
  // bug must cost this one group its search, not abort the metadata pass — the
  // same treatment `safeMetadataQuery` gives `metadataQuery` throwing.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  const logged: string[] = [];
  const deps: PerformerEnqueueDeps = {
    db,
    pluginFor: () => pluginWith(() => { throw new Error('plugin bug'); }),
    log: (message) => logged.push(message),
  };

  assert.equal(enqueuePerformerSearch(deps, 1, 500), false);
  assert.deepEqual(duePerformerQueue(db, 500, 10), []);
  assert.ok(logged.some((line) => line.includes('plugin bug')));
  db.close();
});

test('a missing group is silence rather than a throw', () => {
  // The caller has already resolved the group from a queue row it just read; a
  // row for an id that is gone has nothing to say.
  const db = openTestDatabase();
  const deps = depsWith(db, pluginWith(() => 'Jessica Jaymes'));

  assert.equal(enqueuePerformerSearch(deps, 9999, 500), false);
  db.close();
});
```

Then extend `packages/core/test/pipeline/metadata.test.ts`. Read that file's existing fixtures first and build these on them rather than re-seeding from scratch — it already constructs a `MetadataPassDeps` with a stub scene client, which is most of the work.

```ts
test('a confirmed scene that supplied a cast queues no performer search', async () => {
  // The confirmation already answered the question this queue exists to ask.
  // Nothing here checks that explicitly — `insertPerformerSearch` refuses a
  // group with a cast — which is exactly why including `confirmed` at the call
  // site is safe rather than a second rule to keep in step.
  // Arrange: a scene client returning one confirmable candidate with performers.
  // Act: runMetadataPass.
  // Assert: group_metadata is confirmed, group_performers is non-empty,
  //         duePerformerQueue is empty.
});

test('a confirmed scene that named nobody queues a performer search', async () => {
  // Same confirmation, `performers: []`. The group ends up picked, answered and
  // castless — which is precisely the gap this feature fills, and the case a
  // rule keyed only on `state = 'none'` would miss.
});

test('a settled-as-none lookup queues a performer search', async () => {
  // A search that ran and confirmed nothing. `answerUnaskable` / a 'none' answer
  // settles the row, and the group has no cast.
});

test('a deferred row queues nothing, because it has not settled', async () => {
  // A client that throws an ordinary error, so `deferOrGiveUp` defers rather
  // than answering. The row will be asked again: a group whose scene lookup is
  // still in flight has not yet *failed* to produce a cast, and queueing here
  // would spend a performer request on a question that is still open.
});
```

Fill in each `Arrange / Act / Assert` against the fixtures actually in that file. The four assertions that matter are: `duePerformerQueue(db, now, 10)` is empty in cases one and four, and holds the group in cases two and three.

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-enqueue.test.ts packages/core/test/pipeline/metadata.test.ts
```

- [ ] **Step 3: Implement the enqueue**

Create `packages/core/src/pipeline/performers.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import type { DisplayFields, MediaTypePlugin } from '@pickarr/plugin-api';
import { getGroup } from '../db/groups.ts';
import { insertPerformerSearch } from '../db/performer-queue.ts';

export interface PerformerEnqueueDeps {
  db: DatabaseSync;
  /**
   * Resolves the plugin a group's `plugin` column names. `null` for a plugin no
   * longer configured — a normal outcome, not a bug: a plugin can be removed
   * from config after groups it created already exist.
   */
  pluginFor(pluginId: string): MediaTypePlugin | null;
  log(message: string): void;
}

/**
 * What to search a performer directory for on behalf of one group, or `null`
 * when there is nothing worth asking.
 *
 * Exported because the pass needs the same answer the enqueue acted on, and a
 * pass re-deriving it from the plugin would be this rule spelled twice — the
 * duplication `deriveUpgradeReleaseId` exists in this codebase to prevent. Both
 * callers ask here.
 *
 * A plugin throwing is a log line and a `null`, never a throw of our own. The
 * caller is a loop over settled rows inside `runMetadataPass`, and a plugin bug
 * must cost one group its search rather than aborting a pass that has other rows
 * to answer — the same treatment `safeMetadataQuery` gives `metadataQuery`.
 */
export function performerQueryFor(deps: PerformerEnqueueDeps, groupId: number): string | null {
  const group = getGroup(deps.db, groupId);
  if (group === null) return null;

  const plugin = deps.pluginFor(group.plugin);
  if (plugin?.performerQuery === undefined) return null;

  try {
    const display = JSON.parse(group.display) as DisplayFields;
    const query = plugin.performerQuery({ identityKey: group.identityKey, display });
    return query === null || query.trim().length === 0 ? null : query;
  } catch (error) {
    deps.log(
      `performer enqueue: group ${groupId} skipped, plugin threw building the query: ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Queues one group, answering whether it queued.
 *
 * The two refusals the spec names are both here in effect, but only one is
 * enforced here: whether the plugin has anything to ask is this layer's question
 * because only this layer holds the registry, while "does the group already have
 * a cast" is pure SQL and stays inside `insertPerformerSearch`, where no future
 * caller can bypass it. `metadataAnswerability` sits on the same side of the
 * same line for the same reason.
 */
export function enqueuePerformerSearch(
  deps: PerformerEnqueueDeps,
  groupId: number,
  now: number,
): boolean {
  if (performerQueryFor(deps, groupId) === null) return false;
  return insertPerformerSearch(deps.db, groupId, now);
}
```

Note `plugin?.performerQuery === undefined` covers both a null plugin and a plugin that does not implement the method — one condition rather than two, because both mean the same thing here.

- [ ] **Step 4: Add the one call site**

In `runMetadataPass`, immediately after `outcome` is assigned (both the `try` result and the `catch` fallback have landed in it by then) and before the counters:

```ts
    // One call site, gated on having settled. `deferred` has not settled: the
    // row will be asked again, and a group whose scene lookup is still in
    // flight has not yet failed to produce a cast. A single site rather than
    // one per settle path for the reason `deriveUpgradeReleaseId` exists — an
    // invariant re-derived by whichever caller remembers is one that holds on
    // some paths. This is the only place a metadata row settles.
    if (outcome.kind !== 'deferred') {
      enqueuePerformerSearch({ db: deps.db, pluginFor: deps.pluginFor, log: deps.log }, row.groupId, now);
    }
```

`confirmed` needs no cast check here — `insertPerformerSearch` refuses a group that has one, which is what makes including `confirmed` safe rather than a second rule to keep in step.

- [ ] **Step 5: Run the tests**

```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-enqueue.test.ts packages/core/test/pipeline/metadata.test.ts
npm run check
```

- [ ] **Step 6: Prove the gate bites**

Change `outcome.kind !== 'deferred'` to an unconditional call and re-run: the deferred test must fail. Restore. Report it.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/pipeline/performers.ts packages/core/src/pipeline/metadata.ts \
        packages/core/test/pipeline/performers-enqueue.test.ts packages/core/test/pipeline/metadata.test.ts
git commit -m "Queue a performer search when a scene lookup settles castless"
```

---

