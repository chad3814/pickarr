### Task 6: Drain the queue

**Files:**
- Modify: `packages/core/src/pipeline/performers.ts` (add the pass beside the enqueue)
- Test: `packages/core/test/pipeline/performers-pass.test.ts` (create)

**Interfaces:**
- Consumes: `duePerformerQueue`, `deferPerformerSearch`, `removePerformerSearch`, `groupHasCast` (Task 2); `PerformerLookupClient` (Task 3); `pickPerformer` (Task 4); `upsertPerformers`, `setGroupPerformers` from `../db/performers.ts`.
- Produces:

```ts
export const MAX_PERFORMER_ATTEMPTS = 50;
/**
 * Extends the enqueue deps rather than restating them: the pass calls
 * `performerQueryFor`, which needs exactly `db`, `pluginFor` and `log`.
 */
export interface PerformerPassDeps extends PerformerEnqueueDeps {
  client: PerformerLookupClient | undefined;
  perTick: number;
  now: () => number;
}
export interface PerformerPassResult {
  looked: number;
  linked: number;
  unmatched: number;
  deferred: number;
  cooldownUntil: number | null;
}
export function runPerformerPass(deps: PerformerPassDeps): Promise<PerformerPassResult>;
export function createPerformerRunner(deps: PerformerPassDeps): () => Promise<void>;
```

`MAX_PERFORMER_ATTEMPTS` is 50 for the reason `MAX_METADATA_ATTEMPTS` documents: backoff (`backoffFor`, shared) ramps to a six-hour cap in nine attempts, so fifty spans roughly ten days past the ramp — long enough to survive a multi-day provider outage, short enough that a deterministically poisoned row stops consuming a `perTick` slot four times a day forever.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/pipeline/performers-pass.test.ts`. Copy `seedGroup`, `giveCast` and `pluginWith` in from `performers-enqueue.test.ts` — two small helpers duplicated across two test files is cheaper than a shared fixture module, and these files pin different layers.

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import type { MetadataPerformer } from '@pickarr/plugin-api';
import { openTestDatabase } from '../../src/db/open.ts';
import { RateLimited, type PerformerSearchPage } from '../../src/clients/theporndb.ts';
import { duePerformerQueue, insertPerformerSearch } from '../../src/db/performer-queue.ts';
import { performersForGroups } from '../../src/db/performers.ts';
import {
  MAX_PERFORMER_ATTEMPTS,
  createPerformerRunner,
  runPerformerPass,
  type PerformerPassDeps,
} from '../../src/pipeline/performers.ts';

// …seedGroup / giveCast / pluginWith copied from performers-enqueue.test.ts…

/** A search result carrying just the fields the match rule reads. */
function found(name: string, aliases: string[] = []): PerformerSearchPage['results'][number] {
  return {
    performer: {
      sourceUuid: `uuid-${name}`,
      slug: name.toLowerCase().replace(/\s+/g, '-'),
      name,
      kind: 'performer',
      faceUrl: null,
      imageUrl: null,
    } satisfies MetadataPerformer,
    aliases,
  };
}

/**
 * Deps whose client answers with `pages` in call order, or throws whatever is at
 * that position. One array rather than a stub object so a test can say "the first
 * call is rate limited, the second would have succeeded" and prove the second
 * never happened.
 */
function deps(
  db: DatabaseSync,
  answers: readonly (PerformerSearchPage | Error)[],
  overrides: Partial<PerformerPassDeps> = {},
): PerformerPassDeps & { calls: string[]; logged: string[] } {
  const calls: string[] = [];
  const logged: string[] = [];
  let index = 0;
  return {
    db,
    client: {
      source: 'theporndb',
      async searchPerformers(query: string) {
        calls.push(query);
        const answer = answers[index] ?? { results: [], truncated: false };
        index += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    pluginFor: () => pluginWith((identity) => identity.display.title.split(' ').slice(0, 2).join(' ')),
    perTick: 10,
    now: () => 1000,
    log: (message) => logged.push(message),
    calls,
    logged,
    ...overrides,
  };
}

function castOf(db: DatabaseSync, groupId: number): string[] {
  return (performersForGroups(db, [groupId]).get(groupId) ?? []).map((row) => row.name);
}

test('a single exact match is linked and the row is settled', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [{ results: [found('Jessica Jaymes')], truncated: false }]));

  assert.equal(result.linked, 1);
  assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('an alias-only match is linked, since that is what the filename carried', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessi Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  await runPerformerPass(deps(db, [
    { results: [found('Jessica Jaymes', ['Jessi Jaymes'])], truncated: false },
  ]));

  assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
  db.close();
});

test('no match settles the row without writing anything', async () => {
  // A search that ran and matched nothing IS an answer. Leaving the row queued
  // would spend one request per pass forever rediscovering the same silence.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [{ results: [found('Someone Else')], truncated: false }]));

  assert.equal(result.unmatched, 1);
  assert.deepEqual(castOf(db, 1), []);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM performers').get()?.['n'], 0);
  db.close();
});

test('an ambiguous result settles the row without writing anything', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  await runPerformerPass(deps(db, [
    { results: [found('Jessica Jaymes'), found('Jessica Jaymes')], truncated: false },
  ]));

  assert.deepEqual(castOf(db, 1), []);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('a cast that appeared between enqueue and drain is not clobbered', async () => {
  // The guard the spec calls out. `setGroupPerformers` deletes before it inserts,
  // so without the re-check inside the writing transaction a one-name guess
  // arriving a moment after a confirmed scene REPLACES the real cast. Queue
  // first, then attach the cast, then run — which is the real ordering, since a
  // metadata refetch can land at any point after the enqueue.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  giveCast(db, 1);

  await runPerformerPass(deps(db, [{ results: [found('Jessica Jaymes')], truncated: false }]));

  assert.deepEqual(castOf(db, 1), ['Someone'], 'the confirmed cast must survive');
  assert.deepEqual(duePerformerQueue(db, 9999, 10), [], 'and the row is still settled');
  db.close();
});

test('a 429 breaks the pass, leaving the rows behind it untouched', async () => {
  // A rate limit is a fact about the service, not about one row. Asking the rest
  // anyway would spend one request per row rediscovering a limit already known.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  seedGroup(db, 2, 'Someone Else Entirely');
  insertPerformerSearch(db, 1, 100);
  insertPerformerSearch(db, 2, 200);

  const passDeps = deps(db, [new RateLimited(120_000), { results: [found('Someone Else')], truncated: false }]);
  const result = await runPerformerPass(passDeps);

  assert.equal(result.looked, 1);
  assert.equal(result.cooldownUntil, 1000 + 120_000);
  assert.deepEqual(passDeps.calls, ['Jessica Jaymes'], 'the second row was never asked');
  assert.deepEqual(duePerformerQueue(db, 9999, 10).map((row) => row.groupId), [1, 2]);
  assert.equal(duePerformerQueue(db, 9999, 10)[0]?.attempts, 0, 'a 429 is not the row failing');
  db.close();
});

test('an ordinary failure defers the row with its message', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [new Error('returned HTTP 503 Service Unavailable')]));

  assert.equal(result.deferred, 1);
  const row = duePerformerQueue(db, 9_999_999_999, 10)[0];
  assert.equal(row?.attempts, 1);
  assert.ok(row?.lastError?.includes('503'));
  assert.ok(row !== undefined && row.nextAt > 1000, 'and it is pushed into the future');
  db.close();
});

test('a row that has failed too often is given up on rather than deferred forever', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  db.prepare('UPDATE performer_queue SET attempts = ? WHERE group_id = 1')
    .run(MAX_PERFORMER_ATTEMPTS - 1);

  await runPerformerPass(deps(db, [new Error('still broken')]));

  assert.deepEqual(duePerformerQueue(db, 9_999_999_999, 10), []);
  assert.deepEqual(castOf(db, 1), []);
  db.close();
});

test('a row whose own write throws still has its attempts bumped', async () => {
  // The poison-row defect `runMetadataPass` documents having had: rows drain in
  // (requested_at, group_id) order, so a row whose attempts never moved would
  // abort every pass on the same row and nothing behind it would ever be looked
  // at. The trigger is the same shape of failure a constraint or a full disk
  // produces — the search succeeded, the write cannot.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  seedGroup(db, 2, 'Someone Else Entirely');
  insertPerformerSearch(db, 1, 100);
  insertPerformerSearch(db, 2, 200);
  db.exec(`CREATE TRIGGER no_link BEFORE INSERT ON group_performers
           BEGIN SELECT RAISE(ABORT, 'link write refused'); END`);

  const passDeps = deps(db, [
    { results: [found('Jessica Jaymes')], truncated: false },
    { results: [found('Someone Else')], truncated: false },
  ]);
  const result = await runPerformerPass(passDeps);

  assert.equal(result.deferred, 1, 'the failing row deferred rather than throwing');
  assert.equal(duePerformerQueue(db, 9_999_999_999, 10).find((row) => row.groupId === 1)?.attempts, 1);
  // Group 2 was still reached in this same pass, and settled normally.
  assert.deepEqual(passDeps.calls, ['Jessica Jaymes', 'Someone Else']);
  db.close();
});

test('a query that has gone away settles the row rather than retrying forever', async () => {
  // The query is rebuilt each pass rather than stored, so a title corrected by
  // hand to a single word leaves nothing to ask. That is not a failure to retry.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  const passDeps = deps(db, [], { pluginFor: () => pluginWith(() => null) });

  await runPerformerPass(passDeps);

  assert.deepEqual(passDeps.calls, []);
  assert.deepEqual(duePerformerQueue(db, 9999, 10), []);
  db.close();
});

test('a truncated page is judged, and the truncation is logged rather than silent', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const passDeps = deps(db, [{ results: [found('Jessica Jaymes')], truncated: true }]);
  await runPerformerPass(passDeps);

  assert.deepEqual(castOf(db, 1), ['Jessica Jaymes']);
  assert.ok(passDeps.logged.some((line) => line.includes('one page')));
  db.close();
});

test('no client means no pass and no reads', async () => {
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);

  const result = await runPerformerPass(deps(db, [], { client: undefined }));

  assert.deepEqual(result, { looked: 0, linked: 0, unmatched: 0, deferred: 0, cooldownUntil: null });
  assert.deepEqual(duePerformerQueue(db, 9999, 10).map((row) => row.groupId), [1]);
  db.close();
});

test('createPerformerRunner makes no request inside a cooldown, and says so once', async () => {
  // A multi-hour cooldown at a five-second interval would otherwise write
  // thousands of identical lines.
  const db = openTestDatabase();
  seedGroup(db, 1, 'Jessica Jaymes Loves It');
  insertPerformerSearch(db, 1, 100);
  const passDeps = deps(db, [new RateLimited(120_000)]);
  const run = createPerformerRunner(passDeps);

  await run();
  await run();
  await run();

  assert.deepEqual(passDeps.calls, ['Jessica Jaymes'], 'only the first tick asked');
  assert.equal(passDeps.logged.filter((line) => line.includes('cooldown')).length, 1);
  db.close();
});
```

- [ ] **Step 2: Run and watch them fail**

```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
```

- [ ] **Step 3: Export `backoffFor`**

It is module-private in `metadata.ts:26`. Add `export` and import it here rather than writing a second copy: two backoff curves against one rate-limited service is two things to tune, and one of them will be forgotten. Add a line to its doc comment saying both passes share it.

- [ ] **Step 4: Implement the write**

Add to `packages/core/src/pipeline/performers.ts`. This is the part with the guard in it, so it goes in its own function:

```ts
/**
 * Records the outcome of one search: links the performer if there is one, and
 * removes the queue row either way, in one transaction.
 *
 * **The castless check is re-done here, inside the transaction that writes.**
 * `insertPerformerSearch` already refused a group with a cast, but that was at
 * enqueue time and a metadata refetch can attach a real cast in the interval —
 * and `setGroupPerformers` deletes the group's rows before inserting, so a
 * one-name guess arriving late would *replace* a confirmed cast rather than lose
 * to it. Re-checking under the writing transaction is what makes that impossible
 * rather than merely unlikely.
 *
 * The row's removal is in the same transaction as the link for the same reason
 * `failDownload` transacts its two statements: nothing here awaits, so no reader
 * can observe the gap, but a process dying between them would leave a linked cast
 * still queued — and the next pass would spend a request re-linking it.
 *
 * The row goes whether or not anything was linked. A search that ran and matched
 * nothing **is** an answer, the rule `resolve-sites.ts` and `runMetadataPass`
 * both state; leaving it queued would spend one request per pass forever
 * rediscovering the same silence.
 */
function recordPerformerOutcome(
  deps: PerformerPassDeps,
  groupId: number,
  performer: MetadataPerformer | null,
  now: number,
): 'linked' | 'unmatched' {
  deps.db.exec('BEGIN');
  try {
    let linked = false;
    if (performer !== null && !groupHasCast(deps.db, groupId)) {
      const ids = upsertPerformers(deps.db, 'theporndb', [performer], now);
      setGroupPerformers(deps.db, groupId, ids);
      linked = true;
    }
    removePerformerSearch(deps.db, groupId);
    deps.db.exec('COMMIT');
    return linked ? 'linked' : 'unmatched';
  } catch (error) {
    deps.db.exec('ROLLBACK');
    throw error;
  }
}
```

`upsertPerformers` and `setGroupPerformers` both document that they carry no transaction of their own and are meant to be called from inside one — this is that one.

- [ ] **Step 5: Implement the pass and runner**

Model these on `runMetadataPass` (`metadata.ts:222-275`) and `createMetadataRunner` (296 onward); read both first.

```ts
/**
 * Drains up to `perTick` due rows: builds each group's query, searches, decides,
 * and links on an unambiguous match.
 *
 * Sequential, not concurrent, mirroring `runMetadataPass` and
 * `resolveSitesForBatch`: simpler, self-rate-limiting, and a pass this small has
 * nothing to gain from concurrency.
 *
 * The rule throughout is the one `resolveSitesForBatch` documents: a search that
 * ran and matched nothing is an answer, but a search that could not be *made*
 * learned nothing and must not be recorded as one.
 */
export async function runPerformerPass(deps: PerformerPassDeps): Promise<PerformerPassResult> {
  const result: PerformerPassResult = {
    looked: 0, linked: 0, unmatched: 0, deferred: 0, cooldownUntil: null,
  };

  const client = deps.client;
  if (client === undefined) return result;

  const now = deps.now();
  const due = duePerformerQueue(deps.db, now, deps.perTick);
  if (due.length === 0) return result;

  for (const row of due) {
    result.looked += 1;
    const query = performerQueryFor(deps, row.groupId);

    // The query is rebuilt each pass rather than stored, so it can have gone
    // away since the row was written — a title corrected by hand to one word.
    // That is not a failure to retry; there is nothing left to ask.
    if (query === null) {
      removePerformerSearch(deps.db, row.groupId);
      result.unmatched += 1;
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- rows are answered one at a time, deliberately sequential
      const page = await client.searchPerformers(query);
      if (page.truncated) {
        deps.log(
          `performer pass: group ${row.groupId} judged "${query}" on one page of ` +
            `${page.results.length}; the provider reported more`,
        );
      }
      const outcome = recordPerformerOutcome(
        deps, row.groupId, pickPerformer(query, page.results), now,
      );
      if (outcome === 'linked') result.linked += 1;
      else result.unmatched += 1;
    } catch (error) {
      if (error instanceof RateLimited) {
        // A rate limit is a fact about the service, not about this row: the row
        // keeps its next_at and is picked up normally once the cooldown clears.
        // Asking the rest anyway would spend one request per row rediscovering a
        // limit already known.
        result.cooldownUntil = now + error.retryAfterMs;
        break;
      }
      result.deferred += 1;
      // `now` and the backoff are both computed from the pass's captured clock
      // and passed in, matching `metadata.ts`'s own `deferOrGiveUp` signature.
      // Reading `deps.now()` again inside would stamp `next_at` from a later
      // instant than the row was judged at.
      deferOrGiveUp(deps, row, (error as Error).message, now + backoffFor(row.attempts));
    }
  }

  deps.log(
    `performer pass: ${result.linked} linked, ${result.unmatched} unmatched, ` +
      `${result.deferred} deferred` +
      (result.cooldownUntil === null
        ? ''
        : `, cooldown until ${new Date(result.cooldownUntil).toISOString()}`),
  );

  return result;
}
```

And the deferral, which must commit even when the transaction that led here rolled back:

```ts
/**
 * Defers a row, unless it has now failed `MAX_PERFORMER_ATTEMPTS` times, in
 * which case the row is removed so it stops costing a `perTick` slot forever.
 *
 * A fresh statement, not nested inside whatever transaction the caller may just
 * have watched fail — so it commits even when that transaction rolled itself
 * back. This is what stops a poison row (a constraint its own data trips, a full
 * disk) from being permanently first in line: `duePerformerQueue` orders by
 * `(requested_at, group_id)`, so a row whose attempts never moved would abort
 * every pass on the same row and nothing behind it would ever be looked at.
 * `runMetadataPass` documents having had exactly that defect.
 */
function deferOrGiveUp(
  deps: PerformerPassDeps,
  row: PerformerQueueRow,
  message: string,
  nextAt: number,
): void {
  const attemptsAfter = row.attempts + 1;
  if (attemptsAfter >= MAX_PERFORMER_ATTEMPTS) {
    deps.log(
      `performer pass: group ${row.groupId} given up after ${attemptsAfter} attempts: ${message}`,
    );
    removePerformerSearch(deps.db, row.groupId);
    return;
  }
  deps.log(`performer pass: group ${row.groupId} deferred (attempt ${attemptsAfter}): ${message}`);
  deferPerformerSearch(deps.db, row.groupId, message, nextAt);
}
```

`createPerformerRunner` is `createMetadataRunner`'s shape exactly: hold `cooldownUntil` and a `loggedSkip` flag in the closure, return an async function that makes **no** provider request at all inside a cooldown — it never calls `runPerformerPass`, so `duePerformerQueue` is not even read — and logs the skip once per cooldown rather than once per tick, because a multi-hour cooldown at a five-second interval would otherwise write thousands of identical lines. Copy that function and change the names, the pass it calls and the log prefix; do not reinvent the bookkeeping.

`PerformerPassDeps` extends `PerformerEnqueueDeps` (it needs the same `db`, `pluginFor` and `log` for `performerQueryFor`), so declare it as `export interface PerformerPassDeps extends PerformerEnqueueDeps { … }` and drop the three duplicated fields from the signature given in the Interfaces block above.

- [ ] **Step 6: Run the tests**

```
node --import tsx --conditions development --test packages/core/test/pipeline/performers-pass.test.ts
npm run check
```

- [ ] **Step 7: Prove the clobber guard bites**

Remove the in-transaction `groupHasCast` re-check and re-run: test 4 must fail with the real cast replaced by the guess. Restore. Report it.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/pipeline/performers.ts packages/core/src/pipeline/metadata.ts \
        packages/core/test/pipeline/performers-pass.test.ts
git commit -m "Drain the performer queue, linking only an unambiguous match"
```

---

