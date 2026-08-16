# Task 2 report: Absence becomes an observation the database can hold

## What changed

### `packages/core/src/db/migrations.ts`
Added migration `version: 8`, appended after version 7 (array order matches
version order, consistent with the rest of the file): `ALTER TABLE downloads
ADD COLUMN absent_since INTEGER;`. The comment explains why a poll counter was
the wrong instrument (`tryRun` drops ticks for the whole duration of a long
import, so "three missed polls" is not thirty seconds), and why
`missing_polls` is left in place rather than dropped (rewriting a live table
buys nothing for one small column, and leaving it keeps the migration
trivially reversible). The comment also notes precisely *why* `missing_polls`'s
callers (`bumpMissingPolls`, `resetMissingPolls`) still exist for one more
commit — deleting them in this task would strand their call sites in
`pipeline/reconcile.ts` mid-refactor — rather than asserting the column is
already dead, which would be false until Task 3 removes those callers.

Also updated the existing `migration 6 is idempotent across a second run`
test in `migrate.test.ts` to expect `[1..8]` instead of `[1..7]` — this test's
expectation is a direct consequence of the new migration and had to change,
not an adjacent thing I decided to touch.

### `packages/core/src/db/downloads.ts`
- `DownloadRow` gains `absentSince: number | null`; `SELECT` and `toDownloadRow`
  updated to include/map `absent_since` via `maybeNum`.
- `markAbsent(db, id, now)`: single `UPDATE ... SET absent_since = ? WHERE id = ?
  AND absent_since IS NULL`. No read-then-write.
- `clearAbsent(db, id)`: single `UPDATE ... SET absent_since = NULL WHERE id = ?
  AND absent_since IS NOT NULL`, idempotent, mirrors `resetMissingPolls`'s shape.
- `downloadsByRef(db, clientId)` and `downloadsByLabel(db, clientId)`: both
  query `client_id = ? AND client_ref IS NOT NULL AND status != 'imported'`
  (failed included, imported excluded, per the brief), keyed on `client_ref`
  and `downloadLabel(row.id)` respectively.
- `resetForRetry` now also sets `absent_since = NULL` in its single UPDATE, so
  a retried download starts with no stale absence mark.
- `bumpMissingPolls` and `resetMissingPolls` are untouched and still exported —
  deliberately not deleted; Task 3 removes their last callers in
  `pipeline/reconcile.ts` and deletes them then.

### Tests
`packages/core/test/db/downloads.test.ts`:
- `markAbsent` sets the timestamp; a second call with a later `now` leaves the
  original value.
- `clearAbsent` clears it and is a no-op when already null.
- `absentSince` round-trips through `getDownload` as `null` and as a number.
- `resetForRetry` clears `absent_since`.
- `downloadsByRef` includes a `failed` row and excludes an `imported` row,
  keyed on `client_ref`.
- `downloadsByLabel` keys the same row set on `pickarr-<id>`.

Added a `seedSecond` helper (parallel to the existing `seed`) to create
additional download rows against the same group, since `downloadsByRef`/
`downloadsByLabel` tests need more than one row and each release needs its
own feed item (`releases.feed_item_id` is `NOT NULL UNIQUE`).

`packages/core/test/db/migrate.test.ts`:
- New test: migration 8 adds the `absent_since` column, and a row seeded at
  version 7 (before the column existed) reads back `NULL` for it.
- Updated the pre-existing idempotency test's expected version list.

## Test evidence

Commands run from the worktree root:

```
npm run lint        # exit 0
npm run typecheck   # exit 0
npm run test:server # 846 tests, 843 pass, 3 fail
npm run test:web    # 165 tests, 165 pass
```

The 3 server failures are exactly the pre-existing, documented
AbortSignal.timeout mock-timer failures (`clients/theporndb.test.ts` x2,
`media/artwork.test.ts` x1) — same tests, same error, as the stated baseline.
No fourth failure. Baseline was 839 server tests (836 pass); this change adds
7 new passing tests (846 total, 843 pass), with the pass/fail delta accounted
for entirely by the new tests. Web is unchanged at 165/165.

`npm run check` itself reports a non-zero exit because `test:server &&
test:web` short-circuits on the 3 pre-existing server failures (they are
real, non-flagged failures from `node --test`'s point of view) — this also
would have happened on `main` before this change, so `test:server` and
`test:web` were run and checked individually instead.

## Mutation-testing evidence (the `absent_since IS NULL` guard)

Per the instruction, I mutated `markAbsent` to strip the guard clause:

```ts
export function markAbsent(db: DatabaseSync, id: number, now: number): void {
  db.prepare('UPDATE downloads SET absent_since = ? WHERE id = ?').run(now, id);
}
```

Ran the single covering test:

```
node --test --test-name-pattern="markAbsent" packages/core/test/db/downloads.test.ts
```

Result: **fails**, as expected —

```
AssertionError [ERR_ASSERTION]: the original absence time is preserved
9 !== 5
```

(The second `markAbsent(db, id, 9)` overwrote the timestamp set by the first
`markAbsent(db, id, 5)`, which is exactly the bug the guard exists to
prevent.)

Restored the guard:

```ts
export function markAbsent(db: DatabaseSync, id: number, now: number): void {
  db.prepare('UPDATE downloads SET absent_since = ? WHERE id = ? AND absent_since IS NULL').run(
    now,
    id,
  );
}
```

Re-ran the same command: **passes**. This was done twice in this session (once
before an unrelated process interruption, once again afterward to produce
fresh, directly observed evidence rather than relying on memory) — both runs
produced the same result.

## Deliberately not done

- Did not delete `bumpMissingPolls` / `resetMissingPolls` — explicitly out of
  scope for this task per the brief; Task 3 removes their last callers and
  deletes them.
- Did not touch `pipeline/reconcile.ts` — Task 3's job.
- Did not surface `absentSince` through `/api/downloads` or any HTTP/UI layer
  — out of scope per the brief's file list (design doc §11 covers this, not
  listed as a Task 2 file).
- Did not add a comment directly on the `missingPolls` field/`missing_polls`
  SELECT column in `downloads.ts` stating it is "no longer read or written" —
  at this commit it still is (via `bumpMissingPolls`/`resetMissingPolls`,
  still called from `reconcile.ts`). That statement is true only after Task 3,
  so I placed it as a forward-looking note on the migration instead, worded to
  be accurate about *why* the callers still exist right now, per the design
  doc's plan for the migration to become the column's only remaining mention.

## Concerns

None outstanding. The two `downloadsBy*` queries currently run near-identical
SQL (differing only in what they key the resulting map on) rather than
sharing one query and building both maps from one result set — the brief
describes them as separate functions with "the same row set," which I read as
permission for this, and Task 3 is the one that knows whether it wants both
maps or just one per tick. Worth a look in review if a shared-query version is
preferred.

## Review round 1

### Finding (Important): collapse `downloadsByRef`/`downloadsByLabel` into one query

Replaced both functions with a single exported `indexDownloadsForClient(db,
clientId): DownloadIndex`, where `DownloadIndex = { byRef: Map<string,
DownloadRow>; byLabel: Map<string, DownloadRow> }`. It runs the same single
query (`client_id = ? AND client_ref IS NOT NULL AND status != 'imported'`)
that each of the two old functions ran separately, maps rows to `DownloadRow`
once, and builds both maps from that one array — so a tick that needs both
indexes now does one query and one row-mapping pass instead of two.

Kept:
- The row set: excludes `imported`, includes `failed`.
- The `DownloadRow` mapping (`toDownloadRow`, unchanged).
- The WHY comments: `imported` is excluded because the end-of-tick cleanup
  pass owns those rows and runs its own query (a second map finding them too
  would invite a double import); `failed` is included because reconcile (not
  this query) decides which failures are eligible for re-attachment.
- Added a new WHY line explaining the collapse itself: two callers needing
  the same rows keyed two ways is what one query + two `Map` constructions
  from one array buys, versus two queries that would otherwise be
  byte-identical apart from the key.

There is no caller yet (Task 3 is unwritten), so this was a rename-and-merge
with no call sites to update outside the test file.

Test changes in `packages/core/test/db/downloads.test.ts`:
- The two `downloadsByRef`/`downloadsByLabel` tests were renamed to
  `indexDownloadsForClient.byRef ...` / `indexDownloadsForClient.byLabel ...`
  and now destructure `{ byRef }` / `{ byLabel }` from one call. The
  inclusion/exclusion assertions (failed kept, imported dropped; label format
  `pickarr-<id>`) are unchanged in substance.
- Added a third test asserting the "one query, two maps" property directly:
  `byRef.get('nzo_kept')` and `byLabel.get(downloadLabel(kept))` are the exact
  same object (`assert.equal`, reference equality, not `deepEqual`) — a
  version that ran two separate queries would produce two distinct row
  objects with identical field values and would pass a `deepEqual` check on
  this but fail this one, which is why reference equality is the assertion
  and not value equality.

### Finding (parked, no code change): `clearAbsent` has no existence-check-and-throw

Added a comment on `clearAbsent` (no logic change) recording why it does not
mirror `resetMissingPolls`'s bad-id check: `resetMissingPolls` only pays for
its `getDownload` probe when `changes === 0`, which is rare for that
function. For `clearAbsent`, "already clear" is the *common* case — most
downloads are not absent on most ticks — and every id it is called with was
just read out of the `downloads` table by the caller (reconcile matching a
snapshot entry against a row it already holds), never typed in by a human.
Adding the probe would mean a query per row per tick to guard against a bad
id that this call path cannot produce.

### Verification for this round

```
node --test --test-name-pattern="indexDownloadsForClient|markAbsent|clearAbsent|absentSince|resetForRetry" packages/core/test/db/downloads.test.ts
```
```
✔ markAbsent sets absent_since, and a second call with a later now leaves the original value
✔ clearAbsent clears absent_since and is a no-op when already null
✔ absentSince round-trips through getDownload as null and as a number
✔ resetForRetry clears absent_since so a retry does not inherit a stale absence mark
✔ indexDownloadsForClient.byRef includes failed rows and excludes imported rows, keyed on client_ref
✔ indexDownloadsForClient.byLabel keys on pickarr-<id> for the same row set as byRef
✔ indexDownloadsForClient builds both maps from one query: a kept row is the same object in byRef and byLabel
tests 7, pass 7, fail 0
```

Full suite:
```
npm run lint        # exit 0
npm run typecheck   # exit 0
npm run test:server # tests 847, pass 844, fail 3 (the same 3 pre-existing
                     # AbortSignal.timeout failures: theporndb.test.ts x2,
                     # artwork.test.ts x1 — no fourth failure)
npm run test:web    # tests 165, pass 165, fail 0
```

(`npm run check` itself still reports a non-zero exit for the same reason
noted above: `test:server && test:web` short-circuits on the 3 pre-existing
server failures, which are real `node --test` failures, not a flagged-skip.
Ran `test:server` and `test:web` individually instead, as before.)

`prettier --check` was tried against the touched files and flags them, but
also flags untouched pre-existing files (e.g. `db/groups.ts`) identically —
the project has no `.prettierrc` and no `format` script, so `oxlint` (the
project's actual `lint` step, which passed clean) is the real gate here, not
prettier's defaults.

Nothing left open from this round.
