/**
 * What `GET /api/activity` answers: the host's own work, as an operator
 * reads it (design spec 2026-10-02 §1).
 *
 * **Never a payload.** A job's arguments are ids, and the artwork job's
 * carry people's names; the page has no use for either. `ActivityJob`
 * therefore has no payload field, and the route's `SELECT` never names
 * `payload_json`.
 *
 * **`target` is not a URL.** It is `redactUrl`'s output with the query
 * string removed -- origin and path, passkeys masked -- the same trust
 * level as the host's own log lines, which is the only reason a path
 * may appear in a response body at all.
 */
export interface ActivityRequest { readonly method: string; readonly target: string; }

export interface ActivityHost {
  readonly hostname: string; readonly limit: number;
  readonly inFlight: readonly ActivityRequest[]; readonly waiting: readonly ActivityRequest[];
}

export interface ActivityJob {
  readonly id: number; readonly pluginId: string; readonly kind: string;
  readonly attempts: number; readonly maxAttempts: number;
  readonly runAt: number; readonly startedAt: number | null; readonly updatedAt: number;
  readonly lastError: string | null;
}

export interface ActivityRead {
  readonly jobs: {
    readonly running: readonly ActivityJob[]; readonly waiting: readonly ActivityJob[];
    readonly dead: readonly ActivityJob[]; readonly recent: readonly ActivityJob[];
  };
  readonly fetches: readonly ActivityHost[];
}

export const ACTIVITY_RECENT_LIMIT = 50;
