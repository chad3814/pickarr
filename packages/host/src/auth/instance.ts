import type { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { HostDb } from '../db/open.ts';
import { authSchema } from './schema.ts';

/**
 * Better Auth over the Drizzle handle the host already opened.
 *
 * **The schema goes to `drizzleAdapter` and nowhere else.**
 * `drizzle-orm@1.0.0-rc.4` types SQLite's config as
 * `Omit<DrizzleConfig, 'schema'>`, so `db/open.ts` builds its handle with
 * `relations` and *cannot* be handed a `schema` -- see the comment there.
 * The adapter takes its own, and that is enough: the spike measured a handle
 * built that way signing a user up and writing the row.
 *
 * **Nothing here may reach for `host.ts` or `src/api`.** The route guard is
 * to be written in `src/api` and will import this module; an import back
 * would be a cycle.
 */

/** What `createAuth` needs, and nothing else it could reach for. */
export interface AuthDeps {
  /**
   * **Not read by this module, and no code reads it yet.** It is on
   * `AuthDeps` because the sign-up hook that closes the install to a second
   * account has to count `auth_user` rows per request, and deps assembled
   * twice -- once for the instance, once for the hook -- would be free to
   * name two different databases. Nothing below touches it.
   */
  raw: DatabaseSync;
  db: HostDb;
  /**
   * The signing secret. Persisted by `db/host-state.ts` so it survives a
   * restart; **never logged**, here or anywhere this value travels.
   */
  secret: string;
  /**
   * The origin this instance answers at. Better Auth trusts it implicitly and
   * refuses a state-changing request whose `Origin` is neither this nor one
   * of the origins `trustedOrigins` returns, so it must be the address the
   * browser actually reached -- which is why the caller has to know its bound
   * port before constructing this.
   */
  baseURL: string;
  /** `PICKARR_PUBLIC_URL`: the externally reachable origin, when behind a proxy. */
  publicUrl: string | undefined;
  log: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/**
 * Whether a dotted-quad host is one this network can place: loopback
 * (`127.0.0.0/8`), or one of the private and link-local blocks
 * (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`).
 *
 * `172.16/12` is the one that gets misread: it is `172.16.0.0` through
 * `172.31.255.255`, so neither "`172.16.*`" (too narrow by sixteen /16s) nor
 * "all of `172.*`" (too wide by a million public addresses) is it.
 */
function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    // Digits only, at most three of them. The URL parser has already
    // canonicalized anything IPv4-shaped (`127.1` and `0x7f.0.0.1` both
    // arrive here as `127.0.0.1`), so what this rejects is a *name* whose
    // labels happen to be four of something -- and `Number` alone would not,
    // since it reads '0x7f', ' 10' and '1e2' as numbers.
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    if (octet > 255) return false;
    octets.push(octet);
  }
  const [first, second] = octets;
  // `noUncheckedIndexedAccess`: the length was checked above, but the compiler
  // types these as possibly-absent and an assertion would be a claim rather
  // than a check.
  if (first === undefined || second === undefined) return false;
  if (first === 127) return true;
  if (first === 10) return true;
  if (first === 172) return second >= 16 && second <= 31;
  if (first === 192) return second === 168;
  if (first === 169) return second === 254;
  return false;
}

/**
 * Whether a bracketed IPv6 host is one this network can place: `::1`, or
 * unique-local (`fc00::/7`).
 *
 * The brackets are how it arrives -- `new URL('http://[::1]:8787').hostname`
 * is `'[::1]'`, not `'::1'` -- and the address inside is already canonical,
 * because the URL parser lower-cases every hextet and compresses the longest
 * run of zeroes. So `[0:0:0:0:0:0:0:1]` reaches here as `[::1]` and the
 * literal comparison below is the whole of the loopback case.
 *
 * `fc00::/7` is the top **seven** bits, which is every address whose first
 * hextet is `fc00`-`fdff`. In practice only `fd00::/8` is ever assigned, but
 * matching the block rather than the half of it in use is what keeps this
 * from being a rule that has to be revisited.
 *
 * An IPv4-mapped address (`::ffff:7f00:1`) is deliberately **not** trusted:
 * no browser forms an origin that way, so accepting it would widen the rule
 * for nothing.
 */
function isPrivateIPv6(hostname: string): boolean {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return false;
  const address = hostname.slice(1, -1);
  if (address === '::1') return true;
  // A leading `::` means the first hextet is zero, and splitting on ':' would
  // otherwise hand back the empty string before it.
  if (address.startsWith('::')) return false;
  const [firstHextet] = address.split(':');
  if (firstHextet === undefined || !/^[\da-f]{1,4}$/.test(firstHextet)) return false;
  const value = Number.parseInt(firstHextet, 16);
  return value >= 0xfc_00 && value <= 0xfd_ff;
}

/**
 * Whether an `Origin` header names a host on a network this machine is
 * actually on -- the question `trustedOrigins` exists to answer.
 *
 * **Only `localhost` is trusted by name.** Every other host must be an IP
 * literal this function can place itself, because a name proves nothing: an
 * attacker's domain can resolve to `127.0.0.1` (DNS rebinding), so trusting
 * `Origin: http://evil.example` on the strength of what it resolves to would
 * hand the attacker's page a trusted origin. What a name resolves to is also
 * not knowable from the header alone, and resolving it here would put a DNS
 * round trip on the CSRF check.
 *
 * The scheme must be `http`/`https`: a custom-scheme origin (`myapp://...`)
 * belongs to an app this host does not serve, and Better Auth matches those
 * by a different rule than the exact-origin comparison this returns for.
 */
function isPlaceableOrigin(origin: string): boolean {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.hostname === 'localhost') return true;
  if (url.hostname.startsWith('[')) return isPrivateIPv6(url.hostname);
  return isPrivateIPv4(url.hostname);
}

/**
 * `publicUrl` as an origin, so a value with a path or a trailing slash still
 * matches: Better Auth compares a pattern against `new URL(origin).origin`,
 * and `https://pickarr.example/` would never equal `https://pickarr.example`.
 *
 * A value that will not parse, or that parses to the opaque origin `'null'`
 * (which is what a non-special scheme like `myapp://host` gives, and which is
 * also what a sandboxed iframe sends as its `Origin`), is passed through
 * untouched rather than normalized: putting the literal string `'null'` into
 * the trusted list would name the one origin no list may contain. Better Auth
 * refuses a `null` origin before it matches anything, so this is the second
 * of two locks rather than the only one.
 */
function publicOrigin(publicUrl: string): string {
  if (!URL.canParse(publicUrl)) return publicUrl;
  const origin = new URL(publicUrl).origin;
  return origin === 'null' ? publicUrl : origin;
}

/**
 * The origins this request may be driven from.
 *
 * **The request's own `Origin` is echoed back only after being placed.** The
 * easy version -- return the header -- trusts an attacker's page because it
 * said so, which disables CSRF protection entirely rather than configuring
 * it. Everything returned here has either been parsed and found to be on a
 * network this host is on, or was configured by the operator.
 *
 * Called with no request at all when Better Auth builds the static half of
 * its trusted list, which is why `request` is optional and why the result is
 * just `publicUrl` in that case.
 */
function trustedOriginsFor(publicUrl: string | undefined, request?: Request): string[] {
  const trusted: string[] = [];
  if (publicUrl !== undefined) trusted.push(publicOrigin(publicUrl));
  const origin = request?.headers.get('origin');
  if (origin !== null && origin !== undefined && isPlaceableOrigin(origin)) {
    trusted.push(new URL(origin).origin);
  }
  return trusted;
}

/**
 * The instance. One per host; `baseURL` and the secret are fixed at
 * construction, so a host that changes either has to build a new one.
 *
 * **`disableSignUp` is deliberately not set.** It is read once, here, and a
 * host started with zero users would then keep sign-up open until it
 * restarted -- the exact window this slice exists to close. Closing it is a
 * `before` hook on the sign-up route, evaluated per request, and is not in
 * this module yet.
 */
export function createAuth(deps: AuthDeps) {
  const { publicUrl } = deps;
  if (publicUrl === undefined) {
    // Once, at construction, and not from inside `trustedOrigins`: that
    // function runs on every request, so a line there would be a line per
    // poll for as long as the host runs.
    deps.log(
      'no public url configured: a deployment behind a reverse proxy must set '
      + 'PICKARR_PUBLIC_URL, or requests from its origin will be refused',
    );
  }
  return betterAuth({
    baseURL: deps.baseURL,
    secret: deps.secret,
    database: drizzleAdapter(deps.db, { provider: 'sqlite', schema: authSchema }),
    emailAndPassword: { enabled: true },
    // Not `async`: there is nothing to await, and the option's type accepts a
    // plain return.
    trustedOrigins: (request) => trustedOriginsFor(publicUrl, request),
    // Off is already the default; saying so means a later default keeps this
    // host from reporting its configuration to a third party. `enabled` is
    // *not* the whole switch -- `BETTER_AUTH_TELEMETRY=1` in the environment
    // turns it back on, and nothing here overrides that.
    telemetry: { enabled: false },
  });
}
