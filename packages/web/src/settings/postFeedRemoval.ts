/**
 * Removing a feed, and pausing or resuming one.
 *
 * **Two verbs, because removal has two outcomes.** A feed that produced no
 * releases is deleted; one that produced some is disabled and keeps them,
 * because `rss_item.feed_id` is `NOT NULL` and those items own the download
 * rows that say where a library file came from. The host decides which; this
 * module's job is to carry the answer back so the operator is told what
 * actually happened rather than "done".
 *
 * **Nothing here throws.** The same rule `postFeed` and `postMapping`
 * already follow: a rejection from a submit handler is swallowed by
 * `void handleSubmit(event)` and leaves a control stuck pending forever.
 * Every path returns an outcome instead. The request itself is
 * `auth/sendJson.ts`'s, which is where a rejected `fetch`, an unreadable
 * body and a 401 are told apart for every write path.
 */
import { sendJson } from '../auth/sendJson.ts';
import { SESSION_EXPIRED_MESSAGE } from '../auth/sessionExpired.ts';

/** What the host did, or why it would not. */
export type RemoveFeedOutcome =
  | { readonly outcome: 'deleted' }
  | { readonly outcome: 'disabled'; readonly items: number }
  | { readonly outcome: 'refused'; readonly refusal: FeedRefusalCode };

export type SetFeedDisabledOutcome =
  | { readonly outcome: 'disabled' }
  | { readonly outcome: 'enabled' }
  | { readonly outcome: 'refused'; readonly refusal: FeedRefusalCode };

/**
 * Every way these two routes can refuse.
 *
 * `unknown-feed` is the host's; `unreachable`, `expired` and `unexpected`
 * are this module's -- for a request that never reached the host (a failed
 * network, or bytes Pickarr's route layer could not have sent), for a 401
 * from a session that has ended (issue #94: it used to read as
 * `unexpected`), and for a parseable answer it cannot read. Spelled as a
 * union rather than `string` so a new code has to be handled here before it
 * can reach a sentence.
 */
export type FeedRefusalCode = 'unknown-feed' | 'unreachable' | 'expired' | 'unexpected';

/** The sentence an operator reads for each. The client owns every one. */
export const FEED_REFUSAL_MESSAGES: Record<FeedRefusalCode, string> = {
  'unknown-feed': 'That feed is already gone.',
  unreachable: 'Could not reach Pickarr. Check your connection and try again.',
  expired: SESSION_EXPIRED_MESSAGE,
  unexpected: 'Pickarr gave an answer this page did not understand.',
};

/**
 * What to tell an operator after a successful removal.
 *
 * A function rather than a template at the call site, because "deleted" and
 * "disabled" are genuinely different news and the count is the reason for
 * the second: an operator who asked to remove something and got "disabled"
 * is owed why.
 */
export function removalMessage(outcome: RemoveFeedOutcome): string {
  switch (outcome.outcome) {
    case 'deleted':
      return 'Feed removed.';
    case 'disabled':
      return outcome.items === 1
        ? 'Feed stopped. Its 1 release was kept, so the feed was disabled rather than deleted.'
        : `Feed stopped. Its ${String(outcome.items)} releases were kept, so the feed was disabled rather than deleted.`;
    case 'refused':
      return FEED_REFUSAL_MESSAGES[outcome.refusal];
  }
}

export interface FeedRemovalSubmit {
  /** `DELETE /api/feeds/:id` -- deletes or disables, and says which. */
  remove: (id: number) => Promise<RemoveFeedOutcome>;
  /** `PATCH /api/feeds/:id` -- pauses or resumes, removing nothing. */
  setDisabled: (id: number, disabled: boolean) => Promise<SetFeedDisabledOutcome>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `/api/feeds/:id`, stringified once so no call site does it twice. */
function feedUrl(id: number): string {
  return `/api/feeds/${String(id)}`;
}

/**
 * Reads a refusal body, or `unexpected` when it is not one this page knows.
 *
 * `unknown-feed` is the only code either route answers today. A body naming
 * anything else is a host this client does not match, which is exactly what
 * `unexpected` is for.
 */
function refusalFrom(body: unknown): FeedRefusalCode {
  if (isRecord(body) && body['refusal'] === 'unknown-feed') return 'unknown-feed';
  return 'unexpected';
}

/**
 * Whether `status` is a 2xx -- `Response.ok`'s own test, spelled out because
 * `sendJson` hands back the status rather than the `Response`.
 */
function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * `sendJson`'s two non-answers in this module's vocabulary. `offline` is
 * named `unreachable` here, and now also covers an unparseable body, which
 * this module used to call `unexpected` -- the same event every other write
 * path already called offline, for the reason `sendJson`'s docblock gives.
 */
function refusalFor(outcome: 'offline' | 'expired'): FeedRefusalCode {
  return outcome === 'offline' ? 'unreachable' : 'expired';
}

export async function removeFeed(id: number): Promise<RemoveFeedOutcome> {
  const result = await sendJson(feedUrl(id), { method: 'DELETE' });
  if (result.outcome !== 'answered') return { outcome: 'refused', refusal: refusalFor(result.outcome) };

  const { body } = result;
  if (!isOk(result.status)) return { outcome: 'refused', refusal: refusalFrom(body) };

  if (isRecord(body) && body['outcome'] === 'deleted') return { outcome: 'deleted' };
  if (isRecord(body) && body['outcome'] === 'disabled' && typeof body['items'] === 'number') {
    return { outcome: 'disabled', items: body['items'] };
  }
  // A 200 this page cannot read is still a change the host made, so the
  // list will show the truth on its next wake -- but the operator is told
  // the page did not understand, rather than a confident wrong sentence.
  return { outcome: 'refused', refusal: 'unexpected' };
}

export async function setFeedDisabled(id: number, disabled: boolean): Promise<SetFeedDisabledOutcome> {
  const result = await sendJson(feedUrl(id), { method: 'PATCH', body: { disabled } });
  if (result.outcome !== 'answered') return { outcome: 'refused', refusal: refusalFor(result.outcome) };
  if (!isOk(result.status)) return { outcome: 'refused', refusal: refusalFrom(result.body) };
  return disabled ? { outcome: 'disabled' } : { outcome: 'enabled' };
}

/** The real seam, for `Shell.tsx`. Injected rather than defaulted -- see this file's doc. */
export const feedRemovalSubmit: FeedRemovalSubmit = { remove: removeFeed, setDisabled: setFeedDisabled };
