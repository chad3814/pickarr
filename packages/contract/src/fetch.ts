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
