# Task 1 report — `requeueMetadata`

## What was implemented

Added `requeueMetadata(db, groupIds, now): number` to
`packages/core/src/db/metadata.ts`, placed immediately after `enqueueMetadata`
(before `queuedMetadataNextAt`), matching the brief's exact signature and SQL:

```ts
export function requeueMetadata(
  db: DatabaseSync,
  groupIds: readonly number[],
  now: number,
): number
```

- Empty `groupIds` short-circuits to `0`, no transaction opened — matches
  `enqueueMetadata`'s style.
- One prepared statement:
  ```sql
  INSERT INTO metadata_queue (group_id, requested_at, attempts, next_at)
  VALUES (?, ?, 0, ?)
  ON CONFLICT (group_id) DO UPDATE SET
    requested_at = excluded.requested_at, attempts = 0, next_at = excluded.next_at
  ```
  run once per id inside `BEGIN`/`COMMIT`, with `ROLLBACK` and rethrow on any
  error, mirroring `enqueueMetadata`'s transaction shape exactly.
- No `answered` guard (unlike `enqueueMetadata` — untouched, still guards the
  lazy trigger).
- No read or write of `group_metadata`, no touch of `group_performers`.
- Returns `groupIds.length` — every id in a non-empty list always lands as
  either an insert or an update, so the count queued is always the length of
  the input.
- Doc comment names why it differs from `enqueueMetadata` (different trigger,
  answered-ness as precondition not refusal), why `DO UPDATE` not `DO
  NOTHING` (a stale backoff/attempt count is not the user's fresh request),
  and why it doesn't defensively check `media_groups` existence (Task 2 already
  does, and a second copy would just be a second place for that check to drift
  from the first) — following the codebase's convention of naming the
  rejected alternative and its cost.

## Tests written (`packages/core/test/db/metadata.test.ts`)

Added four tests, plus imported `requeueMetadata`:

1. `requeueMetadata queues a group whose metadata has already settled` —
   answers a group, confirms `enqueueMetadata` would refuse it
   (`alreadyAnswered: 1`), then confirms `requeueMetadata` queues it anyway and
   it shows up in `dueMetadataQueue`.
2. `requeueMetadata resets an in-flight row's attempts and next_at` — enqueues
   a group, defers it twice (attempts=2, next_at=120_000), then requeues at
   `now=5_000`. Asserts the row is *not* due at `4_999` (proves `next_at`
   actually moved, not just that some row exists) and *is* due at `5_000` with
   `attempts: 0`.
3. `requeueMetadata never touches group_metadata` — answers a group with a
   confirmed candidate, snapshots `getGroupMetadata`, requeues, and asserts the
   snapshot is unchanged (`deepEqual`).
4. `requeueMetadata returns the count queued, and an empty id list is a no-op`
   — `requeueMetadata(db, ids, ...)` for 2 ids returns `2`; `requeueMetadata(db,
   [], ...)` returns `0`.

These map onto the four bullet points in the brief's test list.

## Verification run

- `node --import tsx --conditions development --test "packages/core/test/db/metadata.test.ts"`
  → 20/20 pass (16 pre-existing + 4 new).
- `npm run lint` → exits 0; only pre-existing warnings elsewhere in the repo,
  none touching the changed files.
- `npm run typecheck` → exits 0 across all workspaces.
- `npm test` (full suite) → first run showed 1 failure in
  `packages/web/test/Browse.test.tsx` ("picking costs one request, not a
  refetch"), unrelated to any file this task touched. Confirmed pre-existing
  and flaky/timing-dependent: stashing my changes and rerunning the full suite
  on the base commit passed 192/192; re-running the full suite twice more
  *with* my changes also passed 192/192. My change touches only
  `packages/core/src/db/metadata.ts` and its test file, neither of which the
  web Browse test exercises, so this is not attributable to this task.

## Decisions not settled by the brief

- **Return value for a list with duplicate ids.** The brief doesn't say
  whether `groupIds` can contain duplicates or what the count should be if it
  does. I return `groupIds.length` unconditionally rather than deduping,
  since (a) the brief's own wording — "returns the count of groups queued" —
  reads naturally as "count of ids processed" given `ON CONFLICT DO UPDATE`
  guarantees every id succeeds, and (b) Task 2's endpoint is responsible for
  producing a clean id list (it already has to dedupe/filter for the
  foreign-key concern), so a duplicate reaching this function would be a
  caller bug this function has no reason to paper over.
- **Placement in the file.** Put `requeueMetadata` directly after
  `enqueueMetadata` rather than near the end of the file, since the two are a
  matched pair and the brief itself introduces it as "beside
  `enqueueMetadata`."

## Uncertainties / things worth a second look

- I did not add a test for a mix of already-queued-and-answered groups (i.e.
  calling `requeueMetadata` with a batch containing both fresh answered
  groups and groups already in backoff) since the brief's four bullets are
  each covered by a single-group test and the SQL applies uniformly per row
  regardless of batch composition — but a reviewer may want a explicit
  multi-row batch test if they want that generalization pinned.
- The doc comment states Task 2's endpoint is responsible for filtering
  missing `media_groups` ids before calling this function, per the brief. I
  have not seen Task 2's brief/implementation, only referenced what this
  task's brief told me about the division of responsibility.
