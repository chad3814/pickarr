## Task 1 — `requeueMetadata` in `packages/core/src/db/metadata.ts`

Add a function beside `enqueueMetadata`:

```ts
export function requeueMetadata(
  db: DatabaseSync,
  groupIds: readonly number[],
  now: number,
): number;
```

It returns how many groups will be asked again.

Behaviour, and how it differs from `enqueueMetadata`:

- **No `answered` guard.** Being answered is this function's precondition, not a
  refusal. `enqueueMetadata` must keep its guard untouched — the lazy trigger still
  needs it.
- **An existing queue row is reset, not skipped.** The insert is
  `ON CONFLICT (group_id) DO UPDATE SET requested_at = excluded.requested_at,
  attempts = 0, next_at = excluded.next_at`, so a row sitting in backoff — or one
  that has accumulated attempts toward `MAX_METADATA_ATTEMPTS` — becomes due
  immediately. A user pressing a button is a fresh request, not a continuation of a
  failing one.
- One transaction for the batch, matching `enqueueMetadata`'s `BEGIN`/`COMMIT` and
  its rollback-on-throw.
- It does not read or write `group_metadata`, and it does not touch
  `group_performers`.

A group id with no `media_groups` row must not reach the insert — `metadata_queue`'s
foreign key would reject it and take the whole batch down. Filtering missing ids is
Task 2's job at the endpoint, so this function may assume its ids exist; say so in
its doc comment rather than checking twice.

Tests in `packages/core/test/db/metadata.test.ts`:

- Queues a group whose metadata has already settled — the case `enqueueMetadata`
  refuses.
- Resets `attempts` to 0 and `next_at` to `now` on a row already in the queue with
  attempts accumulated and a `next_at` far in the future.
- Leaves the group's `group_metadata` row exactly as it was.
- Returns the count of groups queued, and an empty id list is a no-op returning 0.

