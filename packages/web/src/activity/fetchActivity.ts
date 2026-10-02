/**
 * The real I/O behind the Activities page: one authenticated `GET`
 * through `auth/sendJson.ts`, which never throws and fires the
 * session-expired signal on a 401. `Shell.tsx` wires this in, the way it
 * wires the other real write functions, so `Activities` itself performs no
 * network I/O of its own.
 */
import { sendJson, type SendJsonResult } from '../auth/sendJson.ts';

export function fetchActivity(): Promise<SendJsonResult> {
  return sendJson('/api/activity', { method: 'GET' });
}
