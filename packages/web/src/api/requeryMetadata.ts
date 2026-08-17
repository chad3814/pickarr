import { api, type MetadataRequeryResponse } from './client.ts';

/**
 * Why a one-id `POST /api/metadata/requery` requeued nothing, as a sentence
 * for the card to show — or `null` when it did requeue the group.
 *
 * The route answers 200 with an honest partition of the ids it was sent, so
 * "the call succeeded" and "the group will be asked again" are two different
 * facts. `{ requeued: 0, unavailable: 1 }` is the single most likely refusal
 * (no metadata provider configured), and reading only the HTTP status would
 * report it to the user as success and then never produce a new answer.
 *
 * Exactly one counter is non-zero for a one-id request — every id lands in
 * exactly one bucket, and the route dedups — so the order below is a
 * formality rather than a precedence. The final fallback exists only for a
 * server whose counters do not add up, which would be a bug there rather
 * than something a user could cause; it says so plainly instead of pretending
 * to know which case it was.
 */
function refusalOf(outcome: MetadataRequeryResponse): string | null {
  if (outcome.requeued > 0) return null;
  if (outcome.unavailable > 0) {
    return 'Metadata lookups are unavailable: no metadata provider is configured.';
  }
  if (outcome.unaskable > 0) {
    return 'This group cannot be looked up: its plugin builds no metadata query for it.';
  }
  if (outcome.missing > 0) return 'This group no longer exists.';
  return 'The server requeued nothing and gave no reason why.';
}

/**
 * The whole of what a route's `onRequeryMetadata` does: ask the server to
 * re-queue one group, and — only if it agreed to — tell `useGroupMetadata` to
 * watch that id again.
 *
 * Shared by Browse and Picks rather than written out in each. The two had
 * identical copies, which is one implementation too many for a function whose
 * whole job is a two-step ordering that has to be right (the rearm must not
 * happen for a request the server refused, or the hook polls for an answer
 * that is never coming). One copy means one place to test it.
 *
 * It stays a function the *route* calls, not something `MediaCard` reaches
 * for and not a second poller of its own: the card takes a prop, exactly as
 * it does for `onPick`/`onEditGroup`/`onEditRelease`, and `rearm` is
 * `useGroupMetadata`'s own handle, which only the route that mounted the hook
 * holds.
 *
 * Throwing is how a refusal reaches the user: the card's `requery` catches it
 * and renders the message, the same channel a network failure already used.
 */
export async function requeryOneGroup(
  groupId: number,
  rearm: (groupId: number) => void,
): Promise<void> {
  const refusal = refusalOf(await api.requeryMetadata([groupId]));
  if (refusal !== null) throw new Error(refusal);
  rearm(groupId);
}
