/**
 * The three writes the path-mappings screen makes -- `POST /api/mappings`,
 * `PATCH /api/mappings/:id` and `DELETE /api/mappings/:id` -- and the
 * sentence this client answers each of their outcomes with.
 *
 * **Modelled on `AddDownloadClient.tsx`'s `postDownloadClient`, which is
 * the file to read first.** Two of the decisions below each cost an
 * earlier slice a fix round and are inherited here rather than re-argued:
 * none of these three ever throws, and each branches on the body's own
 * field rather than on the HTTP status -- with one bounded exception for
 * the delete, argued at {@link deleteMapping}.
 *
 * **Never throws.** A rejected `fetch` and a body that fails to parse both
 * answer `{ refusal: 'offline' }`; a 401 answers `{ refusal: 'expired' }`
 * (issue #94); a body that parses but matches neither a success shape nor
 * a known refusal answers `{ refusal: 'unrecognised' }`. The first two are
 * decided by `auth/sendJson.ts`, which makes the request for every write
 * path.
 * The feeds slice shipped a sibling that threw, and because its caller
 * invoked it as `void handleSubmit(event)` the rejection was swallowed:
 * the pending flag never cleared and the form wedged on five of six real
 * host answers. `ClientMappings.tsx` invokes all three the same way, so it
 * would wedge the same way -- three times over, once per control.
 *
 * **Why an unparseable body is `offline` and not `unrecognised`.**
 * `postDownloadClient`'s docblock argues this at length and the argument
 * is about the route *layer*, not about one route: every answer
 * `api/server.ts` can produce under `/api` is JSON, `static-route.ts`
 * refuses every `/api` path before it reaches the filesystem, and the
 * catch-all is `json(404, { error: 'unknown route' })`. So unparseable
 * bytes came from something in front of Pickarr and the request did not
 * reach the host. Version skew, by contrast, produces a *parseable* body,
 * which is what `unrecognised` is for.
 *
 * `credentials: 'same-origin'` puts whatever session cookie the browser
 * already holds on each request; nothing here reads, stores or forwards
 * the token itself (Global Constraint). Nothing here logs, and `sendJson`'s
 * `catch` inspects no error: a `TypeError` from a rejected `fetch` names the url,
 * and a caught error's message is the classic way a request's detail
 * reaches a console.
 *
 * **The codes are imported, never spelled again.** The download-clients
 * review found them hand-copied and required exactly this fix: a second
 * spelling drifts silently, because renaming one half reddens only that
 * half's tests.
 *
 * **Both paths cross the wire exactly as typed.** Design spec §7: a
 * `from_path` may be `D:\Downloads`, and `clients/paths.ts` refuses
 * `node:path` because these are foreign paths from a machine that is not
 * this one. Nothing here trims, normalises or flips a separator -- a
 * writer stricter than the consumer refuses mappings that work.
 */
import {
  type AddMappingInput,
  type EditMappingInput,
  MAPPING_REFUSALS,
  type MappingRefusalCode,
} from '@pickarr/contract';
import { sendJson } from '../auth/sendJson.ts';
import { SESSION_EXPIRED_MESSAGE } from '../auth/sessionExpired.ts';

/**
 * Every way one of these three writes can fail to do what was asked.
 *
 * `offline` is this client's own outcome for a request that never reached
 * the host; `expired` its outcome for a 401, the session behind the request
 * having ended (issue #94 -- it used to share `unrecognised`, whose sentence
 * blamed version skew); and `unrecognised` its outcome for an answer it
 * cannot read -- a refusal code this build has never heard of, or a body
 * with no `refusal` key at all, as a 405, 413 and 500 answer. A client is
 * routinely older than its host, so none of these is a defect in either
 * side.
 */
export interface MappingRefusal {
  refusal: MappingRefusalCode | 'offline' | 'expired' | 'unrecognised';
}

/** An accepted add: the id the host gave the new row. */
export type AddMappingOutcome = { id: number } | MappingRefusal;

/** An accepted edit: the id that was addressed, answered back so an edit and an add have one success shape. */
export type EditMappingOutcome = { id: number } | MappingRefusal;

/** An accepted removal. There is no id to answer -- see {@link deleteMapping} on the 204 this reads. */
export type RemoveMappingOutcome = { removed: true } | MappingRefusal;

/**
 * The three verbs `ClientMappings` takes as one required prop.
 *
 * One object rather than three props, because all three are the same
 * seam -- the network -- and a screen that threads them separately would
 * carry five submit props through `Settings` for two sections. It is
 * **required and never defaulted to {@link mappingSubmit}**: a default that
 * performs network I/O is invisible at the call site, and a test that
 * forgets the prop would silently get a real `fetch` under jsdom, which
 * hangs rather than fails, with nothing pointing at the missing prop.
 */
export interface MappingSubmit {
  add: (input: AddMappingInput) => Promise<AddMappingOutcome>;
  edit: (id: number, input: EditMappingInput) => Promise<EditMappingOutcome>;
  remove: (id: number) => Promise<RemoveMappingOutcome>;
}

/** The codes this client recognises, built from the contract's list rather than spelled again here. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(MAPPING_REFUSALS);

function isRefusalCode(value: unknown): value is MappingRefusalCode {
  return typeof value === 'string' && REFUSAL_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `/api/mappings/:id`, with the id stringified once so no call site does it twice. */
function mappingUrl(id: number): string {
  return `/api/mappings/${String(id)}`;
}

/**
 * Reads an add's or an edit's answer: the id it accepted, a refusal it
 * named, or this client's own catch-all.
 *
 * Shared because the two routes answer the same two shapes -- `201 { id }`
 * and `200 { id }` -- and a second copy of this branch is a second place
 * for a code to be forgotten.
 */
function outcomeFromBody(body: unknown): AddMappingOutcome {
  if (isRecord(body) && typeof body.id === 'number') return { id: body.id };
  if (isRecord(body) && isRefusalCode(body.refusal)) return { refusal: body.refusal };
  return { refusal: 'unrecognised' };
}

/**
 * Adds a mapping to `input.downloadClientId`. See this file's docblock;
 * in particular, this never throws.
 *
 * `AddMappingInput` and `EditMappingInput` are `@pickarr/contract`'s now
 * (issue #88) -- that module's own doc has the full reasoning, including
 * why `EditMappingInput` requires both paths rather than a sparse patch.
 */
export async function postMapping(input: AddMappingInput): Promise<AddMappingOutcome> {
  const result = await sendJson('/api/mappings', { method: 'POST', body: input });
  if (result.outcome !== 'answered') return { refusal: result.outcome };
  return outcomeFromBody(result.body);
}

/** Replaces both of mapping `id`'s paths. Never throws; see this file's docblock. */
export async function patchMapping(id: number, input: EditMappingInput): Promise<EditMappingOutcome> {
  const result = await sendJson(mappingUrl(id), { method: 'PATCH', body: input });
  if (result.outcome !== 'answered') return { refusal: result.outcome };
  return outcomeFromBody(result.body);
}

/**
 * Removes mapping `id`. Never throws; see this file's docblock.
 *
 * **This is the one function here that reads `response.status`, and it has
 * to.** Its two siblings branch on the body because the codes are the
 * stable contract and the statuses are not -- but a successful delete has
 * no body to branch on at all. `api/server.ts` answers `NO_CONTENT`, and
 * its own doc says why that is not `json` with an absent body: a 204 must
 * carry no body and no `Content-Length`, and `writeJson` would throw
 * composing one. So `response.json()` on a success rejects, and an
 * unconditional parse would report the removal that just happened as
 * `offline` -- telling the operator to check their connection about a
 * mapping the host has already dropped. The status is the only evidence
 * there is. `sendJson` knows this too: it answers a 204 with no body
 * rather than trying to read one.
 *
 * What that costs, stated rather than glossed: a 204 from something in
 * front of Pickarr would read as a removal. That is a narrower exposure
 * than the parse-first alternative, which turns *every* successful delete
 * into a false `offline`, and the list is the check either way -- the row
 * leaves the screen when the tombstone replicates, not when this resolves.
 *
 * Every non-204 answer is read exactly as the other two read theirs.
 */
export async function deleteMapping(id: number): Promise<RemoveMappingOutcome> {
  const result = await sendJson(mappingUrl(id), { method: 'DELETE' });
  if (result.outcome !== 'answered') return { refusal: result.outcome };
  if (result.status === 204) return { removed: true };

  const { body } = result;
  if (isRecord(body) && isRefusalCode(body.refusal)) return { refusal: body.refusal };
  return { refusal: 'unrecognised' };
}

/**
 * The three real implementations as one value, which is what
 * `shell/Shell.tsx` wires into the settings screen.
 *
 * A module-level constant rather than a function returning one: there is
 * nothing in it that varies per render, and a fresh object each render
 * would be a new `submit` identity for every effect downstream to notice.
 */
export const mappingSubmit: MappingSubmit = {
  add: postMapping,
  edit: patchMapping,
  remove: deleteMapping,
};

/**
 * A fixed sentence per non-accepted outcome -- never the server's own
 * words (Global Constraint). One map covers all seven, `offline`,
 * `expired` and `unrecognised` included, so the three controls below have no special
 * case to get wrong between them and no two of them can word the same
 * outcome differently.
 *
 * **The keyed `Record` is load-bearing, not decoration.** Its key type is
 * the contract's four codes plus this client's own three, so a code added to
 * `MAPPING_REFUSALS` fails to compile here until someone writes the
 * sentence for it, and a code renamed there fails twice -- an unwritten
 * key and an unreachable one. The two tests at the top of
 * `postMapping.test.tsx` -- one pinning this object's key set against
 * `MAPPING_REFUSALS` *and* against a literal list, one pinning that no two
 * of its sentences are the same -- are the runtime half, and they exist
 * because `npm run test:web` does not typecheck.
 *
 * **No sentence quotes a path.** Each says which rule was broken and, where
 * there is one, the action that resolves it. A path the operator just
 * typed is already on screen in the field they typed it into, and an error
 * that repeats it adds nothing; a path they did *not* type is not this
 * client's to disclose.
 *
 * **`duplicate-from-path` is the one sentence two different actions share,
 * and it stays one sentence -- worded for both rather than for the add.**
 * The code is reachable from `postMapping` (a new mapping repeating a
 * `from_path`) and from `patchMapping` (an existing one edited onto
 * another row's `from_path`); both are migration 19's unique index on
 * `(download_client_id, from_path)` and there is only one thing wrong in
 * either case, so splitting them would mean a second key this `Record`'s
 * type cannot distinguish and two spellings of one rule. What was wrong
 * was the wording: it used to end "Edit the existing mapping instead",
 * which is an instruction to do the thing the operator is *already* doing
 * when the refusal arrives from the edit route. The conflict is always
 * with a *different* row on either route -- a row keeping its own
 * `from_path` collides with nothing, which
 * `packages/host/src/clients/mappings.ts`'s `editMapping` measures -- so
 * naming the other mapping, rather than "the existing" one, is true and
 * actionable from both forms.
 */
export const MAPPING_REFUSAL_MESSAGES: Record<MappingRefusalCode | 'offline' | 'expired' | 'unrecognised', string> = {
  'unknown-client': 'Pickarr no longer has that download client on file. Reload the page and try again.',
  'duplicate-from-path':
    'This download client already maps that client path. Change the mapping that already has it, or use a different client path.',
  'unknown-mapping': 'That path mapping is no longer on file. Reload the page to see what is.',
  'empty-path': 'Fill in both paths. Neither the client path nor the host path may be left blank.',
  /** Distinct from every named refusal above, which are answers from the host -- this one means the request never reached it. Worded exactly as `AddDownloadClient.tsx`'s own `offline`, because it is the same event and a second wording for it would be two sentences for one condition. */
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  /** A 401. One sentence shared by every write path (`auth/sessionExpired.ts`), so no two can word it differently. */
  expired: SESSION_EXPIRED_MESSAGE,
  /** The catch-all the three functions above share. Names no code and no status: those are exactly the server-authored detail the Global Constraint forbids rendering. */
  unrecognised:
    'Pickarr refused this path mapping, but did not say why. The host may be a different version than this page expects — reload and try again.',
};
