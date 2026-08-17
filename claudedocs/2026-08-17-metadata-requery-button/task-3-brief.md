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
