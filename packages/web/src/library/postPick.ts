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
 * answer `{ refusal: 'offline' }`; a body that parses but matches neither
 * `{ accepted: true }` nor a known refusal answers
 * `{ refusal: 'unrecognised' }`. The feeds slice shipped a sibling that
 * threw, and because its caller invoked it as `void handleSubmit(event)`
 * the rejection was swallowed: the pending flag never cleared and the form
 * wedged on five of six real host answers. `ReleaseList`'s button is
 * clicked the same way, so it would wedge the same way.
 *
 * **Branches on the body, never on `response.status`.** The route answers
 * 202 for an accepted pick, 409 for `already-submitted`, 422 for the other
 * four and 400 for the two envelope refusals (`api/server.ts`'s
 * `statusForPickRefusal`); the codes are the stable contract and the
 * statuses are not. `response.status` is never read here.
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
 * forwards the token itself (Global Constraint). Nothing here logs, and the
 * `catch` inspects no error: a `TypeError` from a rejected `fetch` names
 * the url.
 *
 * **The codes are imported, never spelled again.** The download-clients
 * review found them hand-copied and required exactly this fix: a second
 * spelling drifts silently, because renaming one half reddens only that
 * half's tests.
 */
import { REQUEST_PICK_REFUSALS, type RequestPickRefusalCode } from '@pickarr/contract';

/**
 * What a pick submission resolves to.
 *
 * `offline` is this client's own outcome for a submit that never reached
 * the host, and `unrecognised` its outcome for an answer it cannot read --
 * a refusal code this build has never heard of, or a body with no
 * `refusal` key at all. That last shape is the most ordinary real failure
 * there is: a 401 from an expired session answers `{ error }`, as do 405,
 * 413 and 500, and none of them carries a `refusal`. A client is routinely
 * older than its host, so neither of these two is a defect in either side.
 */
export type PickOutcome =
  | { accepted: true }
  | { refusal: RequestPickRefusalCode }
  | { refusal: 'offline' | 'unrecognised' };

/**
 * The shape `ReleaseList` takes its `submit` prop in: a release id in, an
 * outcome out. {@link postPick} is the only production implementation;
 * `shell/Shell.tsx` wires it in explicitly, through `Category` and
 * `MediaItemCard`.
 */
export type PickSubmit = (rssItemId: number) => Promise<PickOutcome>;

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
  let body: unknown;
  try {
    const response = await fetch('/api/picks', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rssItemId }),
    });
    body = await response.json();
  } catch {
    return { refusal: 'offline' };
  }
  if (isRecord(body) && body.accepted === true) return { accepted: true };
  if (isRecord(body) && isRefusalCode(body.refusal)) return { refusal: body.refusal };
  return { refusal: 'unrecognised' };
}

/**
 * A fixed sentence per non-accepted outcome -- never the server's own words
 * (Global Constraint). One map covers all seven, `offline` and
 * `unrecognised` included, so the button below has no special case to get
 * wrong between them.
 *
 * **The keyed `Record` is load-bearing, not decoration.** Its key type is
 * the contract's five codes plus this client's own two, so a code added to
 * `REQUEST_PICK_REFUSALS` fails to compile here until someone writes the
 * sentence for it, and a code renamed there fails twice -- an unwritten key
 * and an unreachable one. `postPick.test.tsx`'s two `refusal codes` tests
 * are the runtime half, and they exist because `npm run test:web` does not
 * typecheck.
 *
 * **No sentence names a release, a feed, a client or an address.** Each
 * says which rule was broken and, where there is one, the action that
 * resolves it. That is the same discipline `contract/src/picks.ts` keeps on
 * the other side of the wire.
 */
export const PICK_REFUSAL_MESSAGES: Record<RequestPickRefusalCode | 'offline' | 'unrecognised', string> = {
  'unknown-release': 'Pickarr no longer has that release on file. Reload the page and try again.',
  'plugin-not-registered': 'No plugin in this Pickarr handles that kind of media, so nothing can fetch this release.',
  'no-client-of-type': 'No download client that can take this kind of release is set up. Add one under Settings.',
  'client-type-mismatch': 'The download client this release’s feed names cannot take this kind of release.',
  'already-submitted': 'This release has already been sent to a download client.',
  /** Distinct from every named refusal above, which are answers from the host -- this one means the submit never reached it. Worded exactly as `AddDownloadClient.tsx`'s own `offline`, because it is the same event and a second wording for it would be two sentences for one condition. */
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  /** {@link postPick}'s catch-all. Names no code and no status: those are exactly the server-authored detail the Global Constraint forbids rendering. */
  unrecognised:
    'Pickarr refused this pick, but did not say why. The host may be a different version than this page expects — reload and try again.',
};
