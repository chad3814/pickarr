/**
 * `POST /api/unmatched/:id/retry` -- asking the host to identify a release
 * again -- and the sentence this client answers each outcome with.
 *
 * **Modelled on `./postPick.ts`, which is the file to read first.** Three
 * of its decisions are inherited here rather than re-argued, each of which
 * cost an earlier slice a fix round:
 *
 * - **Never throws.** A rejected `fetch` and a body that fails to parse
 *   both answer `offline`; a 401 answers `expired` (issue #94); a body
 *   that parses but matches nothing known answers `unrecognised`. The
 *   first two are decided by `auth/sendJson.ts`, which makes the request
 *   for every write path. The caller invokes this from a click handler
 *   as `void retry()`, so a rejection would be swallowed and the button
 *   would sit disabled for ever -- exactly how the feeds slice wedged its
 *   form on five of six real host answers.
 * - **Branches on the body, never on `response.status`.** The route
 *   answers 202, 409 and 422 (`api/server.ts`'s `statusForRetryRefusal`);
 *   the codes are the stable contract and the statuses are not. The
 *   guard's 401 is the one status read, once, in `sendJson`.
 * - **The codes are imported, never spelled again.**
 *   `RETRY_LOOKUP_REFUSALS` is the contract's list; a second spelling
 *   drifts silently, because renaming one half reddens only that half's
 *   tests.
 *
 * **Why an unparseable body is `offline` rather than `unrecognised`.**
 * Every answer `api/server.ts` can produce under `/api` is JSON and its
 * catch-all is a JSON 404, so unparseable bytes came from something in
 * front of Pickarr and the request did not reach the host. Version skew,
 * by contrast, produces a *parseable* body -- which is what
 * `unrecognised` is for.
 *
 * `credentials: 'same-origin'` puts whatever session cookie the browser
 * already holds on the request; this module never reads, stores or
 * forwards the token itself (Global Constraint). Nothing here logs, and
 * `sendJson`'s `catch` inspects no error: a `TypeError` from a rejected
 * `fetch` names the url.
 */
import { RETRY_LOOKUP_REFUSALS, type RetryLookupRefusalCode } from '@pickarr/contract';
import { sendJson } from '../auth/sendJson.ts';
import { SESSION_EXPIRED_MESSAGE } from '../auth/sessionExpired.ts';

/** What a retry resolves to. Never a thrown error -- see this file's docblock. */
export type RetryOutcome =
  | { readonly accepted: true }
  | { readonly refusal: RetryLookupRefusalCode | 'offline' | 'expired' | 'unrecognised' };

/**
 * A fixed sentence per outcome this client can show -- never the server's
 * own words (Global Constraint).
 *
 * `already-matched` deliberately does not read like a failure, because it
 * is not one: the release was identified between the render and the
 * click, so the operator's page is merely stale and the thing they wanted
 * has already happened.
 */
export const RETRY_REFUSAL_MESSAGES: Record<RetryLookupRefusalCode | 'offline' | 'expired' | 'unrecognised', string> = {
  'unknown-release': 'Pickarr no longer has that release on file. Reload the page and try again.',
  'already-matched': 'That release has already been identified — reload to see what it matched.',
  'plugin-not-registered': 'No plugin in this Pickarr handles that kind of media, so nothing can identify this release.',
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  expired: SESSION_EXPIRED_MESSAGE,
  unrecognised:
    'Pickarr refused the retry, but did not say why. The host may be a different version than this page expects — reload and try again.',
};

/** The shape the card takes this in, so a test can hand it one that does no I/O. */
export type RetrySubmit = (rssItemId: number) => Promise<RetryOutcome>;

const REFUSAL_CODES: ReadonlySet<string> = new Set(RETRY_LOOKUP_REFUSALS);

function isRefusalCode(value: unknown): value is RetryLookupRefusalCode {
  return typeof value === 'string' && REFUSAL_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Asks for release `rssItemId` to be identified again. Never throws. */
export async function postRetry(rssItemId: number): Promise<RetryOutcome> {
  // The id is in the path and there is no body: this route acts on one
  // release and has nothing else to say about it, unlike `/api/picks`,
  // which takes `{ rssItemId }` because it is about picks in general.
  const result = await sendJson(`/api/unmatched/${String(rssItemId)}/retry`, { method: 'POST' });
  if (result.outcome !== 'answered') return { refusal: result.outcome };
  const { body } = result;
  if (isRecord(body) && body.accepted === true) return { accepted: true };
  if (isRecord(body) && isRefusalCode(body.refusal)) return { refusal: body.refusal };
  return { refusal: 'unrecognised' };
}
