# Metadata requery button

Approved in chat on 2026-08-17. Bounded change: a per-card button that re-asks the
metadata provider about a group whose metadata has already settled.

## Why

`POST /api/metadata/request` is the lazy, client-driven trigger for groups that have
*not* settled; it counts an already-answered group as `alreadyAnswered` and refuses to
queue it. There is therefore no way to re-ask about a group once it has an answer — a
bad confirmation is permanent, and a group that settled `none` before a later
improvement shipped never gets a second look.

This is also what makes the performer search queue reachable on an existing database.
`enqueuePerformerSearch` is called from exactly one place, the per-row settle path in
`runMetadataPass` (`pipeline/metadata.ts`). On a database whose `metadata_queue` has
long since drained, nothing settles again, so nothing is ever enqueued — the queue is
correct and permanently idle. A requery makes a group settle again, which feeds the
performer queue through the path that already exists.

## Global Constraints

- **`requeueMetadata` does not touch `group_performers`.** Narrowed on 2026-08-17
  from "the cast is never unlinked", which the code does not guarantee end to end.
  What holds: the requeue itself only writes `metadata_queue`, so pressing the button
  never unlinks anything, and a group whose re-answer carries the same cast keeps it
  and stays out of the performer queue via `insertPerformerSearch`'s unchanged
  `groupHasCast` guard. A castless group has nothing to clear, and its re-settle feeds
  the queue.

  What does **not** hold: a re-answer that is *written* replaces the cast wholesale
  through the pre-existing settle path (`recordMetadataAnswer`'s `written.changes > 0`
  branch calling `setGroupPerformers`), and `setGroupPerformers` with an empty list is
  a DELETE — so a confirmed re-answer carrying an empty performer list drops the cast,
  and the now-castless group is then queued for a performer search. That is
  pre-existing behaviour of the shared settle path, which every ordinary metadata pass
  goes through; this branch only makes it user-triggerable on demand. Guarding it
  would change the metadata pass for every group and is deliberately out of this
  branch's scope. The behaviour is pinned by "a requery re-confirmed with an empty
  cast replaces the cast, through the pre-existing settle path" in
  `packages/core/test/pipeline/metadata.test.ts`.
- **The old answer stays visible until a new one lands.** Nothing deletes a
  `group_metadata` row. The existing settle upsert in `db/metadata.ts` is guarded by
  `WHERE excluded.state = 'confirmed' OR group_metadata.state <> 'confirmed'`, so a
  requery that comes back empty cannot overwrite a confirmed answer. Do not weaken or
  duplicate that guard.
- **The id cap is 100**, the same cap `POST /api/metadata/request` and
  `GET /api/metadata` use. Reuse the existing constant rather than restating `100`.
- **Counters sum to the number of ids sent**, the convention
  `MetadataRequestResponse` documents. A caller must be able to tell accepted from
  discarded.
- No new dependency, in either package.
- `npm run lint`, `npm run typecheck` and `npm test` all pass at every commit.

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
  attempts = 0, next_at = excluded.next_at, last_error = NULL`, so a row sitting in
  backoff — or one that has accumulated attempts toward `MAX_METADATA_ATTEMPTS` —
  becomes due immediately. A user pressing a button is a fresh request, not a
  continuation of a failing one.

  The `last_error = NULL` clause supersedes the SQL this plan originally dictated
  (added 2026-08-17): `dueMetadataQueue` reads `last_error` into
  `MetadataQueueRow.lastError`, so `attempts = 0` beside a stale `ECONNRESET` is a row
  that claims to have both never been tried and already failed.
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
- Resets `attempts` to 0, `next_at` to `now` and `last_error` to NULL on a row already
  in the queue with attempts accumulated and a `next_at` far in the future.
- Leaves the group's `group_metadata` row exactly as it was.
- Returns the count of groups queued, and an empty id list is a no-op returning 0.

## Task 2 — `POST /api/metadata/requery` in `packages/core/src/http/server.ts`

Add the route next to `POST /api/metadata/request`, reusing that route's body schema
shape and its id cap.

Response type, exported alongside `MetadataRequestResponse`:

```ts
export interface MetadataRequeryResponse {
  requeued: number;
  missing: number;
  unavailable: number;
  unaskable: number;
}
```

Per id, in this order — the first match wins, and every id lands in exactly one
counter:

1. `getGroup` returns null → `missing`. The group cannot be queued, and there is
   nothing to re-ask.
2. `!deps.metadataAvailable` → `unavailable`. No worker would ever drain the row.
   Follow the reasoning `POST /api/metadata/request` already records: this is a fact
   about how Pickarr is configured rather than a fact about the group, so it is never
   written to `group_metadata`.
3. `metadataAnswerability(plugin, group) === 'unaskable'` → `unaskable`. A re-ask
   cannot produce anything the worker would keep. Unlike the lazy trigger, do **not**
   call `answerUnaskable` here: the group is already settled, so there is nothing to
   answer, and calling it would rewrite `fetched_at` for no reason.
4. Otherwise → collect the id, and pass the collected ids to `requeueMetadata` in one
   call. `requeued` is its return value.

A malformed body, or more than the cap, is a 400 with the same shape
`POST /api/metadata/request` returns.

Tests in the existing http test file for the metadata routes:

- A settled group is requeued and its `group_metadata` row is untouched.
- Each of `missing`, `unavailable` and `unaskable` is counted, and the four counters
  sum to the ids sent in a request that mixes all four cases.
- Over-cap and malformed bodies are 400.
- **The end-to-end proof:** a group that settled `none` with no cast, when requeued
  and then run through `runMetadataPass` with a stubbed client, ends up with a row in
  `performer_queue`. This is the behaviour the whole change exists for; assert on the
  queue row, not on a log line.
- A group that already has a cast, requeried and passed, does **not** gain a
  `performer_queue` row — `groupHasCast` still refuses it, and the cast is still
  linked afterwards.

## Task 3 — the button

`packages/web/src/api/client.ts`: add `MetadataRequeryResponse` mirroring the server
interface, and a call function following the existing `/api/metadata/request` call in
the same file. Mirror the neighbouring types' comment convention about tolerating an
older server's response.

`packages/web/src/components/MediaCard.tsx`: a "Requery metadata" button beside the
existing Edit button.

- Rendered **only** when the group has settled metadata. An unsettled group is
  already covered by the lazy trigger, and a button that duplicates it would be two
  paths to one outcome.
- While the request is in flight: disabled, with in-flight text. The card keeps
  rendering the metadata it already has — no blanking.
- On success, refetch that group's metadata so a fast answer appears without a
  reload.
- On failure, surface the error on the card, leave the existing metadata in place,
  and re-enable the button so it can be retried.

`packages/web/src/styles.css`: match the existing card action styling. No new layout
system.

Tests in `packages/web/test/`, following the conventions already there:

- The button is absent for a group with no settled metadata and present for a settled
  one.
- Clicking disables it and shows the in-flight text.
- The card still shows its existing title and cast while the request is in flight.
- A rejected request re-enables the button and shows the error, and the existing
  metadata is still on screen.

## Out of scope

- **A bulk requery.** Deliberately not built. 523 groups at one click each is not a
  realistic way to clear the backlog, and the user chose per-card. A bulk action
  would reuse `requeueMetadata` and this endpoint unchanged.
- Clearing a group's cast, under any circumstance.
- The `answerUnaskable` asymmetry `pipeline/metadata.ts` documents, where the
  server's own settle path does not enqueue a performer search. Unchanged here.
