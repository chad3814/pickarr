/**
 * `POST /api/unmatched/retry-all`: every unresolved release re-asked about
 * at once. The host answers how many it handed to a plugin; nothing is
 * finished when it does, the lookups are queued, which is why the page
 * shows "Requeued" and not "Identified".
 */
import { sendJson } from '../auth/sendJson.ts';
import { SESSION_EXPIRED_MESSAGE } from '../auth/sessionExpired.ts';

export type RetryAllOutcome =
  | { readonly accepted: number }
  | { readonly refusal: 'offline' | 'expired' | 'unrecognised' };

export type RetryAllSubmit = () => Promise<RetryAllOutcome>;

export const RETRY_ALL_REFUSAL_MESSAGES: Record<'offline' | 'expired' | 'unrecognised', string> = {
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  expired: SESSION_EXPIRED_MESSAGE,
  unrecognised:
    'Pickarr did not say how many releases it requeued. The host may be a different version than this page expects — reload and try again.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function postRetryAll(): Promise<RetryAllOutcome> {
  const result = await sendJson('/api/unmatched/retry-all', { method: 'POST' });
  if (result.outcome !== 'answered') return { refusal: result.outcome };
  const { body } = result;
  if (isRecord(body) && typeof body.accepted === 'number') return { accepted: body.accepted };
  return { refusal: 'unrecognised' };
}

export const retryAllSubmit: RetryAllSubmit = postRetryAll;
