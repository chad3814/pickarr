import type { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { HostDb } from '../db/open.ts';
import { isClaimed, matchesClaimToken, spendClaimToken } from './claim.ts';
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

/**
 * The instance `createAuth` returns, for the modules that have to hold one.
 *
 * **Inferred, deliberately** -- `betterAuth`'s return type carries the
 * endpoint types its options imply, so `auth.api.getSession` keeps its precise
 * result type at the guard rather than widening to the library's generic
 * `Auth`. Naming the inference rather than restating it is what keeps a
 * consumer from having to say `ReturnType<typeof createAuth>` at every turn.
 */
export type Auth = ReturnType<typeof createAuth>;

/** What `createAuth` needs, and nothing else it could reach for. */
export interface AuthDeps {
  /**
   * The same database `db` wraps, as the `node:sqlite` handle. The two hooks
   * below ask it, per request, whether the install is claimed and whether the
   * offered claim token is the one on record -- and then spend that token, in
   * the hook that runs immediately before the account row is written. Taking
   * it on `AuthDeps` rather than assembling a second set of deps for the
   * hooks is what keeps the two from ever naming different databases.
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
 *
 * **What that scheme test actually catches is `ws:`, `wss:` and `ftp:`, not
 * `myapp:`** -- measured, by deleting the line and re-running both shapes.
 * Those three are WHATWG *special* schemes, so `new URL('ws://127.0.0.1:8787')`
 * reports hostname `127.0.0.1` (which `isPrivateIPv4` places) *and* a real
 * tuple origin, and without the test this function would hand that origin
 * back as trusted: a sign-up carrying `Origin: ws://127.0.0.1:8787` answers
 * 200 and writes a row. A custom scheme cannot get that far -- its `.origin`
 * is the opaque string `'null'`, which Better Auth refuses outright before
 * matching anything, so `myapp://127.0.0.1:8787` is refused with the test and
 * without it. The isolating case is pinned by
 * `test/auth/instance.test.ts`'s `ws:` test, and it is the only thing in the
 * suite that notices: with this line deleted, 1936 of 1937 still pass and
 * that one test is the single failure.
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
 *
 * **This reads `Origin` and only `Origin`, where the library falls back to
 * `origin || referer`.** So a state-changing request that omits `Origin` and
 * carries a `Referer` is checked against the referring *url*, and nothing
 * here places it: measured, a sign-up with only
 * `Referer: http://127.0.0.1:8787/x` is refused `403 INVALID_ORIGIN` even
 * though the same request with that value as `Origin` is accepted. A
 * `Referer`-only request gets through only when the referring page's origin
 * is already in the trusted list for some other reason -- `baseURL`'s, which
 * Better Auth adds implicitly, or `publicUrl`, which this function returns
 * whether or not a request asked for it. Both of those were measured too.
 *
 * Known behaviour rather than a defect: it fails *closed*, and a
 * `Referer`-only cross-site POST is exactly what the check exists to refuse.
 * Recorded here so the next person to meet a form that submits without an
 * `Origin` finds the reason written down instead of diagnosing it as a bug.
 * Widening this to the referrer would mean trusting a header that names a
 * page rather than an origin, on the request shape least able to prove
 * anything about itself.
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
 * The route the sign-up hook applies to, spelled the way `ctx.path` reports
 * it: Better Auth strips the `/api/auth` mount prefix before a hook sees it,
 * so matching on the full request path would match nothing and the hook
 * would silently never fire.
 */
const SIGN_UP_PATH = '/sign-up/email';

/** The sign-up body field the claim token arrives in. */
const CLAIM_TOKEN_FIELD = 'claimToken';

/**
 * What every refusal from the sign-up hook says, and it is deliberately the
 * *same* sentence for both reasons it can fire.
 *
 * A claimed install and a wrong token are the two states an attacker most
 * wants to tell apart: "the claim token is wrong" would confirm the install
 * is still unclaimed and therefore still worth attacking, and the attacker
 * learns that by offering a garbage token rather than by guessing a real
 * one. One message for both is what makes that probe answer nothing. It
 * costs an owner who mistypes the token a more specific error, which is the
 * cheaper half of the trade: the token is on the console in front of them.
 *
 * **What the two refusals do share is byte-identical, and measured.** Status
 * 403, one header (`content-type: application/json`), a 31-byte body of
 * `{"message":"sign-up is closed"}`, and no `Set-Cookie` on either. Nothing
 * a caller reads off the response distinguishes them.
 *
 * **Timing does, slightly.** The unclaimed-and-wrong-token path runs one
 * extra prepared `host_state` read plus a 43-byte `timingSafeEqual` that the
 * claimed path never reaches, because the hook throws the moment `isClaimed`
 * answers `true`. (43 bytes: base64url of `randomBytes(32)`.) Measured
 * interleaved over 6000 samples each, twice: a median of ~138 us for a
 * claimed install against ~142 us for an unclaimed one offered a wrong token
 * of the right length -- a reproducible ~5 us, ~3% of the whole request. An
 * unclaimed install offered *no* token is indistinguishable from the claimed
 * case (-0.2 us), because `offeredClaimToken` returns `null` before the
 * `host_state` read happens.
 *
 * Recorded rather than closed. Equalising it would mean doing the read and
 * the compare on the claimed path too, against noise that is already an
 * order of magnitude larger than the signal (p90 is 370-405 us on both),
 * over a network that adds more. What a reader should know is that the
 * identical response is deliberate and that the residual channel is timing,
 * so nobody re-derives the whole argument from the fact that the two paths
 * have different shapes. (An earlier review measured the same direction at
 * 296 us against 346 us; the absolute figures did not reproduce here, the
 * ordering and the mechanism did.)
 */
const SIGN_UP_REFUSED = 'sign-up is closed';

/**
 * The claim token a sign-up body offers, or `null` when it offers none.
 *
 * `body` is `unknown` on purpose. Better Auth hands the hook whatever was
 * parsed off the request, and `claimToken` is not part of the sign-up
 * schema, so nothing has checked its type. That an unknown field reaches
 * the hook at all -- rather than being stripped by the endpoint's own
 * validation, or rejected outright -- was measured against 1.7.3 while
 * writing this, not read anywhere. The `in` narrowing is what reads the
 * field without a cast.
 */
function offeredClaimToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  if (!(CLAIM_TOKEN_FIELD in body)) return null;
  const offered: unknown = body[CLAIM_TOKEN_FIELD];
  return typeof offered === 'string' ? offered : null;
}

/**
 * The instance. One per host; `baseURL` and the secret are fixed at
 * construction, so a host that changes either has to build a new one.
 *
 * **`disableSignUp` is deliberately not set.** It is read once, here, and a
 * host started with zero users would then keep sign-up open until it
 * restarted -- the exact window this slice exists to close. What closes it
 * is the `before` hook below, which asks `isClaimed` on every request that
 * reaches the sign-up route, so the install shuts the moment the first
 * account exists and without anything being restarted.
 *
 * **The `before` hook runs ahead of Better Auth's own origin check and
 * ahead of its password-length check**, measured against 1.7.3 rather than
 * assumed. That ordering is why `before` only *verifies* the token and
 * never spends it: an early version consumed it on the match itself, so a
 * sign-up carrying the right token but a password Better Auth went on to
 * reject spent the token anyway -- on an install with exactly one token and
 * no second account to fall back to, that cost a restart to get another
 * token.
 *
 * **What admits a sign-up is spending the token, in
 * `databaseHooks.user.create.before`.** Everything `before` does is a read,
 * and two requests carrying the same valid token both pass a read before
 * either has written: measured, `Promise.all` of two sign-ups with one token
 * answered 200/200 and left two accounts on an install whose §3 says one
 * account claims it. The database hook is the last thing that runs before
 * the `INSERT` -- past the origin check, past the password check, past every
 * validation that could still refuse the request (measured, 1.7.3) -- so
 * spending the token there is both atomic against a second caller and
 * unreachable by a sign-up that was going to fail. `spendClaimToken` is one
 * conditional `DELETE`: of two callers offering the same token exactly one
 * sees a change, and the other is refused in the same words as everybody
 * else.
 *
 * **The database hook is deliberately not narrowed to the sign-up route.**
 * Any path that creates a user must spend the token; one that carries no
 * token is refused. Nothing but sign-up creates a user today, so this
 * changes no behaviour -- it decides what happens to a path that does not
 * exist yet, and fail-closed is the answer that does not need revisiting.
 *
 * ---
 *
 * **What is measured about these hooks, and not documented anywhere by the
 * library.** All of it read off an instrumented 1.7.3 instance, most recently
 * while moving the token's consumption here:
 *
 * - `before` runs ahead of the origin check *and* ahead of the
 *   password-length check. So a request that reaches it has passed nothing
 *   yet, and anything `before` spends is spent before Better Auth has decided
 *   whether to serve the request at all.
 * - `databaseHooks.user.create.before` runs after both, immediately before
 *   the row is written; `user.create.after` and then the request-level `after`
 *   follow it. An `APIError` thrown from it answers 403 with this module's own
 *   message and leaves `auth_user` empty.
 * - **There is no `after` hook here, and that is deliberate.** The request's
 *   `after` runs on every path where `before` did not throw -- a refused
 *   origin, a too-short password, a missing field, a duplicate email, all
 *   measured -- but it does **not** run when `before` throws: a `before` that
 *   throws gives 403 with `after` never firing. So an `after` that reacted to
 *   a refusal at the hook could not see one, and a comment in this file used
 *   to claim the opposite ("whether or not that request threw"), which is
 *   exactly the sentence a reader would consult before deciding some guard was
 *   redundant. Task 4b established the fact by tracing a mutation whose
 *   predicted kill landed on a different test, recorded it in its report, and
 *   it never reached this file until now.
 */
export function createAuth(deps: AuthDeps) {
  const { publicUrl, raw } = deps;
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
    hooks: {
      // `async` with nothing awaited, because `createAuthMiddleware` types
      // its handler as returning a promise and `node:sqlite` is
      // synchronous, so there is genuinely nothing here to wait for.
      before: createAuthMiddleware(async (ctx) => {
        // Every route's hook, so everything but sign-up passes straight
        // through. Sign-in in particular: an install with an account has to
        // stay reachable by the person who owns it.
        if (ctx.path !== SIGN_UP_PATH) return;
        if (isClaimed(raw)) throw new APIError('FORBIDDEN', { message: SIGN_UP_REFUSED });
        const offered = offeredClaimToken(ctx.body);
        // Verifies only. Nothing here spends the token: this hook runs ahead
        // of Better Auth's own validation, so a sign-up refused after this
        // point must leave the token usable. Spending it is
        // `databaseHooks.user.create.before`'s, below.
        if (offered === null || !matchesClaimToken(raw, offered)) {
          throw new APIError('FORBIDDEN', { message: SIGN_UP_REFUSED });
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // The seam where the token is spent, and where a second holder of
          // the same token is refused. `async` with nothing awaited, because
          // the option types the hook as returning a promise and
          // `node:sqlite` is synchronous.
          //
          // `context` is `GenericEndpointContext | null` -- the library
          // allows a user to be created with no request behind it -- and a
          // creation this cannot read a token off is refused, which is the
          // same answer as a creation offering the wrong one.
          //
          // Returning nothing admits the creation; the library reads a
          // returned object as a replacement for the row and `false` as a
          // silent refusal, and neither is wanted here. A thrown `APIError`
          // is what answers the caller, measured against 1.7.3: 403, this
          // module's own message, and no `auth_user` row.
          before: async (_user, context) => {
            const body: unknown = context?.body;
            const offered = offeredClaimToken(body);
            if (offered === null || !spendClaimToken(raw, offered)) {
              throw new APIError('FORBIDDEN', { message: SIGN_UP_REFUSED });
            }
          },
        },
      },
    },
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
