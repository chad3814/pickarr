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

