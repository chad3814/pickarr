/**
 * The only way a plugin reaches the network.
 *
 * Requests are queued per hostname, and the hostname is derived from the
 * url, so a plugin cannot opt out of its queue. What is configurable is how
 * many requests to that hostname may run at once: a host-level setting that
 * defaults to one. That default is what keeps every existing plugin's
 * behaviour unchanged until something raises it.
 */
export interface HostFetch {
  json<T>(url: string, init?: RequestInit): Promise<T>;
  bytes(url: string, init?: RequestInit): Promise<Uint8Array>;
}

/**
 * `GET /api/fetch-hosts` and `PUT /api/fetch-hosts/:hostname`: how many
 * requests the host runs at once per hostname and how long one may take.
 * Design spec 2026-10-06 §3.
 */

/** Both values, as the default row holds them. */
export interface FetchPair {
  readonly concurrency: number;
  readonly timeoutMs: number;
}

/**
 * A `PUT` body. A field present replaces that field; absent leaves it;
 * `null` clears it back to inherited. The default row refuses `null`.
 */
export interface FetchHostPatch {
  readonly concurrency?: number | null;
  readonly timeoutMs?: number | null;
}

/** One row of the effective table, as `GET` lists it and `PUT` answers it. */
export interface FetchHostRead {
  readonly hostname: string;
  readonly concurrency: number;
  readonly timeoutMs: number;
  /** Which fields came from the default row rather than an entry or the lookup fallback. */
  readonly inherited: { readonly concurrency: boolean; readonly timeoutMs: boolean };
  /** Whether the config file has an entry for this hostname. */
  readonly configured: boolean;
}

export interface FetchHostsRead {
  readonly default: FetchPair;
  /** Configured hostnames and hostnames seen since boot, merged and sorted by hostname. */
  readonly hosts: readonly FetchHostRead[];
}

/** The reserved path segment that addresses the default pair. Never a hostname. */
export const FETCH_DEFAULT_HOST = 'default';

export const FETCH_CONCURRENCY_MIN = 1;
export const FETCH_CONCURRENCY_MAX = 64;
export const FETCH_TIMEOUT_MIN_MS = 1_000;
/**
 * Five minutes: the lookup service's own platform ceiling, and below the
 * host's `JOB_TIMEOUT_MS` (360 000) so a slow service fails as a timeout
 * naming the url rather than as a job killed for running long.
 */
export const FETCH_TIMEOUT_MAX_MS = 300_000;

export const FETCH_REFUSALS = [
  /** The body is not an object, or a field is neither a number nor null. */
  'invalid-shape',
  /** The hostname fails `isHostname`, or is the reserved `default` passed as a host. */
  'invalid-hostname',
  /** `concurrency` outside 1..64. */
  'invalid-concurrency',
  /** `timeoutMs` outside 1000..300000. */
  'invalid-timeout',
  /** `null` or an absent field on the default row. */
  'default-required',
] as const;

export type FetchRefusalCode = (typeof FETCH_REFUSALS)[number];

export interface FetchRefusalBody {
  readonly refusal: FetchRefusalCode;
}
