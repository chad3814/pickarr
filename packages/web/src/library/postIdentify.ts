/**
 * `POST /api/releases/:id/identify` -- telling the host what one release is,
 * by asking it to look the release up again, by a typed name, or by a title
 * already in the library -- and the outcome this client reads out of each
 * answer.
 *
 * **Modelled on `./postRetry.ts`, whose docblock has the reasoning.** The
 * three decisions carry over unchanged: this never throws (a rejected
 * `fetch` and an unparseable body are `offline`, a 401 is `expired`, both
 * decided by `auth/sendJson.ts`); it branches on the body and never on
 * `response.status`, because the codes are the contract and the statuses
 * are not; and the refusal codes come from `@pickarr/contract`'s
 * `IDENTIFY_RELEASE_REFUSALS`, never respelled here.
 *
 * Three answers are success: `{ accepted: true }` (`requery` and `name`,
 * where the lookup runs afterwards and its result arrives through the
 * replica) and `{ outcome: 'linked', mediaItemId }` (`media-item`, where the
 * release is already relinked). Anything parseable that matches none of
 * them is `unrecognised`.
 *
 * The request body is sent as `sendJson` serialises it. This module never
 * reads, stores or forwards the session token, and nothing here logs.
 */
import { IDENTIFY_RELEASE_REFUSALS, type IdentifyReleaseRefusalCode, type IdentifyRequest } from '@pickarr/contract';
import type { IdentifyOutcome } from '@pickarr/plugin-ui';
import { sendJson } from '../auth/sendJson.ts';

const REFUSAL_CODES: ReadonlySet<string> = new Set(IDENTIFY_RELEASE_REFUSALS);

function isRefusalCode(value: unknown): value is IdentifyReleaseRefusalCode {
  return typeof value === 'string' && REFUSAL_CODES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Asks the host to identify release `rssItemId` as `request` says. Never throws. */
export async function postIdentify(rssItemId: number, request: IdentifyRequest): Promise<IdentifyOutcome> {
  const result = await sendJson(`/api/releases/${String(rssItemId)}/identify`, { method: 'POST', body: request });
  if (result.outcome !== 'answered') return { refusal: result.outcome };
  const { body } = result;
  if (isRecord(body) && body.accepted === true) return { accepted: true };
  if (isRecord(body) && body.outcome === 'linked' && typeof body.mediaItemId === 'number') {
    return { outcome: 'linked', mediaItemId: body.mediaItemId };
  }
  if (isRecord(body) && isRefusalCode(body.refusal)) return { refusal: body.refusal };
  return { refusal: 'unrecognised' };
}
