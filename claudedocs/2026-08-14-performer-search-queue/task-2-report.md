# Task 2 Report: The queue table, and the row that must be cleared

## What I implemented

Followed the brief's 8 steps in order, using its SQL, signatures, and comments verbatim.

1. `packages/core/test/db/performer-queue.test.ts` — created with the brief's 7 tests, verbatim.
2. `packages/core/src/db/migrations.ts` — appended migration `version: 8`, creating `performer_queue`
   (PK `group_id` referencing `media_groups`, `requested_at`, `attempts`, `next_at`, `last_error`) and
   index `performer_queue_due` on `next_at`. Confirmed no existing `version: 8` before adding (highest
   was 7, the `performers` table).
3. `packages/core/src/db/performer-queue.ts` — created with the five functions the brief specifies:
   `groupHasCast`, `insertPerformerSearch`, `duePerformerQueue`, `deferPerformerSearch`,
   `removePerformerSearch`, plus the `PerformerQueueRow` interface. Verbatim from the brief, including
   its long why-comments.
4. `packages/core/src/db/metadata.ts` — added `DELETE FROM performer_queue WHERE group_id = ?` inside
   `clearGroupMetadata`, after the existing `group_performers` delete. Extended the function's doc
   comment ("four tables" → "five tables", named the new queued-performer-search entry) and added a
   comment on the new delete explaining the no-cascade defect this closes (docs/known-issues.md records
   it shipping twice via the four tables already handled there).
5. `packages/core/test/db/migrate.test.ts` — one-line change, not in the brief's file list but required:
   `migration 6 is idempotent across a second run` hardcodes the full list of applied migration
   versions (`[1, 2, 3, 4, 5, 6, 7]`). Every migration before mine required the identical bump to this
   array (visible in the file's own history/comments about prior collisions); I extended it to
   `[1, 2, 3, 4, 5, 6, 7, 8]`. Without this, `npm run check` regresses one pre-existing test purely as a
   mechanical consequence of adding a real migration — not a functional change.

## TDD evidence

### RED

Command:
```
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
node --import tsx --conditions development --test packages/core/test/db/performer-queue.test.ts
```

Output (before creating `performer-queue.ts`):
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'.../packages/core/src/db/performer-queue.ts' imported from
'.../packages/core/test/db/performer-queue.test.ts'
...
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

Expected and correct: the test file imports a module that does not exist yet.

### GREEN

Same command, after Steps 3-5:
```
✔ a queued group comes back due once its next_at has passed (8.8ms)
✔ inserting twice keeps the first request rather than jumping the line (4.4ms)
✔ a group that already has a cast is not queued (4.1ms)
✔ deferring bumps attempts and pushes next_at out (6.0ms)
✔ removing takes the row out for good (4.1ms)
✔ the limit is honoured, and it is the oldest request that survives it (4.5ms)
✔ clearGroupMetadata removes the queue row, so deleting the group cannot fail the foreign key (4.2ms)
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

Full suite, `npm run check` (oxlint && typecheck && tests), after also fixing the `migrate.test.ts`
version-list bump:
```
core: ℹ tests 843 / ℹ pass 843 / ℹ fail 0
web:  ℹ tests 165 / ℹ pass 165 / ℹ fail 0
```
843 = 836 baseline + 7 new. 165 web unchanged. `npm run lint` exits 0; all warnings shown are
pre-existing and in files this task did not touch (`pipeline/reconcile.ts`, `theporndb.ts`,
`import.ts`, etc. — none in `performer-queue.ts`, `metadata.ts`, or `migrations.ts`).

## Step 7: mutation evidence

Commented out the new delete line in `clearGroupMetadata`:
```ts
  // db.prepare('DELETE FROM performer_queue WHERE group_id = ?').run(groupId);
```

Re-ran:
```
node --import tsx --conditions development --test packages/core/test/db/performer-queue.test.ts
```

Result: 6 pass, 1 fail —
```
✖ clearGroupMetadata removes the queue row, so deleting the group cannot fail the foreign key (8.7ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  + [ { attempts: 0, groupId: 1, lastError: null, nextAt: 100, requestedAt: 100 } ]
  - []
      at .../performer-queue.test.ts:135:10
```

This fails at the `assert.deepEqual(duePerformerQueue(db, 9999, 10), [])` line — one statement
*before* the `DELETE FROM media_groups` line the brief's Step 7 names, because that assertion runs
first in the test and the leftover row is caught there. I did not want to report "fails at the FK
line" without checking that the FK path itself was real, so I isolated it: I wrote a throwaway script
(not committed, deleted after) that ran the same sequence — seed, `insertPerformerSearch`,
`clearGroupMetadata` (with the delete still commented out), then `DELETE FROM releases` followed by
`DELETE FROM media_groups` — with no intervening assertion. That reproduced exactly the FK failure the
brief describes:
```
Error: FOREIGN KEY constraint failed
    code: 'ERR_SQLITE_ERROR', errcode: 787, errstr: 'constraint failed'
```
So the schema-level defect the test guards against is real and exactly as described; the committed
test simply catches it one line sooner via its own-row check, which is a stronger signal, not a
weaker one.

Restored the delete line, re-ran the same command: back to 7/7 passing (shown above under GREEN).

## Files changed

- `packages/core/src/db/migrations.ts` (migration `version: 8`)
- `packages/core/src/db/performer-queue.ts` (new)
- `packages/core/src/db/metadata.ts` (`clearGroupMetadata` + its doc comment)
- `packages/core/test/db/performer-queue.test.ts` (new)
- `packages/core/test/db/migrate.test.ts` (one-line version-list bump, not in brief's file list but
  required to keep the pre-existing idempotency test green)

Commit: `f11f545` — "Add the performer search queue table and clear it with the rest"

## Self-review

- Completeness: all five exported functions match the brief's signatures exactly; migration matches
  verbatim; `clearGroupMetadata` delete and doc-comment update both done; test file matches verbatim.
- Quality: comments kept in the brief's why-register; no restating of code. Followed existing patterns
  (`SqlRow`, `num`, `maybeStr` from `row.ts`; `.ts` import extensions; two-space indent; no `any`, no
  bare `unknown`).
- Discipline: touched only the files the brief named, plus the one unavoidable test-count fix in
  `migrate.test.ts`, which is the same one-line adjustment every prior migration required (visible in
  that file's own comments about past migration-number collisions). No pipeline wiring, no matching
  logic, no provider calls — those remain out of scope for tasks 3-6.
- Testing: all 7 new tests assert behavior (queue ordering, dedup-on-insert, cast eligibility, defer
  state, removal, limit ordering, cross-table deletion), not implementation details. TDD order followed:
  test written and confirmed failing before any implementation existed. Test output is pristine — no
  stray warnings in the affected files.

## Concerns

None on correctness. One judgment call worth flagging explicitly: extending `migrate.test.ts` beyond
the brief's stated file list. I believe this was correct and necessary — the brief's own Step 6
baseline correction anticipated "pre-existing tests stay green," and leaving this test broken would
violate that while the fix itself is a mechanical, pattern-following one-liner, not new behavior. Happy
to revert if this should have been raised before touching it.
