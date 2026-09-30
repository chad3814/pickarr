/**
 * `POST /api/picks` -- the one write the browse screens make -- and the
 * sentence this client answers each of its outcomes with.
 *
 * **Modelled on `settings/AddDownloadClient.tsx`'s `postDownloadClient`,
 * which is the file to read first.** Two of the decisions below each cost
 * that slice a fix round and are inherited here rather than re-argued:
 * this function never throws, and it branches on the body's own field
 * rather than on the HTTP status.
 *
 * **Never throws.** A rejected `fetch` and a body that fails to parse both
 * answer `{ refusal: 'offline' }`; a 401 -- an expired session -- answers
 * `{ refusal: 'expired' }` (issue #94: it used to land in `unrecognised`,
 * whose sentence blamed version skew); a body that parses but matches
 * neither `{ accepted: true }` nor a known refusal answers
 * `{ refusal: 'unrecognised' }`. The first two are decided by
 * `auth/sendJson.ts`, which makes the request for every write path. The feeds slice shipped a sibling that
 * threw, and because its caller invoked it as `void handleSubmit(event)`
 * the rejection was swallowed: the pending flag never cleared and the form
 * wedged on five of six real host answers. `ReleaseList`'s button is
 * clicked the same way, so it would wedge the same way.
 *
 * **Branches on the body, never on `response.status`.** The route answers
 * 202 for an accepted pick, 409 for `already-submitted`, 422 for the other
 * four and 400 for the two envelope refusals (`api/server.ts`'s
 * `statusForPickRefusal`); the codes are the stable contract and the
 * statuses are not. The status is never read here; the one status that
 * does mean something on its own, the guard's 401, is read once in
 * `sendJson` for every write path.
 *
 * **Why an unparseable body is `offline` and not `unrecognised`.**
 * `postDownloadClient`'s docblock argues this at length and the argument is
 * about the route *layer*, not about that one route: every answer
 * `api/server.ts` can produce under `/api` is JSON, `static-route.ts`
 * refuses every `/api` path before it reaches the filesystem, and the
 * catch-all is `json(404, { error: 'unknown route' })`. So unparseable
 * bytes came from something in front of Pickarr and the submit did not
 * reach the host. Version skew, by contrast, produces a *parseable* body,
 * which is what `unrecognised` is for.
 *
 * `credentials: 'same-origin'` puts whatever session cookie the browser
 * already holds on the request; this function never reads, stores or
 * forwards the token itself (Global Constraint). Nothing here logs, and
 * `sendJson`'s `catch` inspects no error: a `TypeError` from a rejected
 * `fetch` names the url.
 *
 * **The codes are imported, never spelled again.** The download-clients
 * review found them hand-copied and required exactly this fix: a second
 * spelling drifts silently, because renaming one half reddens only that
 * half's tests.
 */
import { REQUEST_PICK_REFUSALS, type RequestPickRefusalCode } from '@pickarr/contract';
import { PICK_REFUSAL_MESSAGES, type PickOutcome, type PickSubmit } from '@pickarr/plugin-ui';
import { sendJson } from '../auth/sendJson.ts';

/**
 * `PickOutcome`, `PickSubmit` and `PICK_REFUSAL_MESSAGES` all now live in
 * `@pickarr/plugin-ui`, re-exported here rather than declared twice:
 * `ReleaseList` reads all three and must not import web, so the seam moved
 * the declaration, not just a reference to it. This module keeps every
 * other import site -- `Category.tsx`, `MediaItemCard.tsx`,
 * `postPick.test.tsx` -- unchanged.
 */
export { PICK_REFUSAL_MESSAGES };
export type { PickOutcome, PickSubmit };

/** The codes this client recognises, built from the contract's list rather than spelled again here. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(REQUEST_PICK_REFUSALS);

function isRefusalCode(value: unknown): value is RequestPickRefusalCode {
  return typeof value === 'string' && REFUSAL_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Submits a pick for release `rssItemId`. See this file's docblock; in particular, this never throws. */
export async function postPick(rssItemId: number): Promise<PickOutcome> {
  const result = await sendJson('/api/picks', { method: 'POST', body: { rssItemId } });
  if (result.outcome !== 'answered') return { refusal: result.outcome };
  const { body } = result;
  if (isRecord(body) && body.accepted === true) return { accepted: true };
  if (isRecord(body) && isRefusalCode(body.refusal)) return { refusal: body.refusal };
  return { refusal: 'unrecognised' };
}
