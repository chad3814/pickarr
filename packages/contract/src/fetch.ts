/**
 * The only way a plugin reaches the network.
 *
 * Requests are serialised per hostname — one active at a time — and the
 * hostname is derived from the url, so a plugin cannot opt out. That is what
 * makes "one at a time per host" a property of the system rather than a habit.
 */
export interface HostFetch {
  json<T>(url: string, init?: RequestInit): Promise<T>;
  bytes(url: string, init?: RequestInit): Promise<Uint8Array>;
}
