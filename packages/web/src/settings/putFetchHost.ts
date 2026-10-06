import {
  FETCH_REFUSALS,
  type FetchHostPatch,
  type FetchHostRead,
  type FetchPair,
  type FetchRefusalCode,
} from '@pickarr/contract';
import { sendJson } from '../auth/sendJson.ts';
import { SESSION_EXPIRED_MESSAGE } from '../auth/sessionExpired.ts';

export type FetchRefusalOutcome = { refusal: FetchRefusalCode | 'offline' | 'expired' | 'unrecognised' };
export type FetchHostOutcome = FetchHostRead | FetchPair | FetchRefusalOutcome;
export type FetchHostSubmit = (hostname: string, patch: FetchHostPatch) => Promise<FetchHostOutcome>;

const REFUSAL_CODES: ReadonlySet<string> = new Set(FETCH_REFUSALS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRefusalCode(value: unknown): value is FetchRefusalCode {
  return typeof value === 'string' && REFUSAL_CODES.has(value);
}

function isPair(value: Record<string, unknown>): value is Record<string, unknown> & FetchPair {
  return typeof value.concurrency === 'number' && typeof value.timeoutMs === 'number';
}

export async function putFetchHost(hostname: string, patch: FetchHostPatch): Promise<FetchHostOutcome> {
  const result = await sendJson(`/api/fetch-hosts/${encodeURIComponent(hostname)}`, { method: 'PUT', body: patch });
  if (result.outcome !== 'answered') return { refusal: result.outcome };
  const { body } = result;
  if (!isRecord(body)) return { refusal: 'unrecognised' };
  if (isRefusalCode(body.refusal)) return { refusal: body.refusal };
  if (isPair(body)) {
    // A host row carries `hostname`; the default pair does not.
    if (typeof body.hostname === 'string' && isRecord(body.inherited) && typeof body.configured === 'boolean') {
      return body as unknown as FetchHostRead;
    }
    return { concurrency: body.concurrency, timeoutMs: body.timeoutMs };
  }
  return { refusal: 'unrecognised' };
}

export const fetchHostSubmit: FetchHostSubmit = putFetchHost;

export const FETCH_REFUSAL_MESSAGES: Record<FetchRefusalCode | 'offline' | 'expired' | 'unrecognised', string> = {
  'invalid-shape': 'Pickarr did not understand that value. Enter whole numbers only.',
  'invalid-hostname': 'Pickarr does not know that host. Reload the page to see the hosts it has fetched.',
  'invalid-concurrency': 'In flight must be a whole number from 1 to 64.',
  'invalid-timeout': 'Timeout must be a whole number of seconds from 1 to 300.',
  'default-required': 'The default row needs both values; it has nothing to inherit from.',
  offline: 'Could not reach Pickarr. Check your connection and try again.',
  expired: SESSION_EXPIRED_MESSAGE,
  unrecognised: 'Could not save. Pickarr answered with something this page did not understand; check the host log.',
};
