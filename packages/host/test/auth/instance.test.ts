import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { createAuth } from '../../src/auth/instance.ts';

/**
 * **No listener, on purpose.** Better Auth's instance exposes
 * `handler(Request) => Promise<Response>`, which is the same function
 * `toNodeHandler` wraps, so every property below is reachable without a
 * socket. That also sidesteps the ordering trap the design spec's §2 records
 * -- `baseURL` must match the origin the request arrives at, so a test that
 * bound port 0 would have to learn its port before constructing the instance.
 * A fixed `BASE_URL` and a `Request` built against it have no such ordering.
 *
 * **Every fixture here is an obviously synthetic placeholder.** The secret and
 * the password below are fixed strings that say so in their own text, no
 * assertion formats a session token into a message, and the only real
 * credentials any of these tests handle -- the session cookies the
 * round-trip and secret tests read off a response -- are passed straight
 * back as a header.
 */

/**
 * `192.0.2.10` is TEST-NET-1, reserved for documentation: it is neither
 * loopback nor private, so Better Auth's own trusted list (which always
 * contains `baseURL`'s origin) cannot be what makes any origin these tests
 * send acceptable. Every origin below is deliberately *not* this one, so a
 * pass means `createAuth`'s `trustedOrigins` placed it.
 */
const BASE_URL = 'http://192.0.2.10:8787';

const LOOPBACK_ORIGIN = 'http://127.0.0.1:8787';
const PUBLIC_URL = 'https://pickarr.example';

const PASSWORD = 'placeholder-not-a-real-password';
const SECRET = 'placeholder-not-a-real-signing-secret';

/** A log that drops every line, for the tests that assert on something else. */
const noop = (): void => {};

type Auth = ReturnType<typeof createAuth>;

interface Harness {
  raw: DatabaseSync;
  auth: Auth;
  /** Every message `createAuth` passed to `log`, in order. */
  lines: string[];
}

/** A migrated in-memory database and an instance over it, with the log captured. */
function harness(publicUrl: string | undefined): Harness {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const lines: string[] = [];
  const auth = createAuth({
    raw,
    db,
    secret: SECRET,
    baseURL: BASE_URL,
    publicUrl,
    log: (message) => {
      lines.push(message);
    },
  });
  return { raw, auth, lines };
}

function signUp(auth: Auth, origin: string, email: string): Promise<Response> {
  return auth.handler(new Request(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password: PASSWORD, name: 'Placeholder Owner' }),
  }));
}

function signIn(auth: Auth, origin: string, email: string): Promise<Response> {
  return auth.handler(new Request(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password: PASSWORD }),
  }));
}

/**
 * The `Cookie` header a browser would send back, built from a response's
 * `Set-Cookie` headers. Throws rather than returning an empty string when
 * there is nothing to send: a silently cookie-less request would be
 * indistinguishable from a session that failed to round-trip, which is the
 * one thing the test using this has to tell apart.
 */
function cookieHeader(response: Response): string {
  const pairs = response.headers.getSetCookie().map((value) => {
    const [pair] = value.split(';');
    if (pair === undefined) throw new Error('a Set-Cookie header with no name=value pair');
    return pair;
  });
  if (pairs.length === 0) throw new Error('the response set no cookie to send back');
  return pairs.join('; ');
}

/** The one `auth_user` row, as a plain record, or `undefined` when the table is empty. */
function userRow(raw: DatabaseSync): Record<string, unknown> | undefined {
  return raw.prepare('SELECT * FROM auth_user').get() as Record<string, unknown> | undefined;
}

test('a user signs up and the row lands in auth_user with snake_case columns', async () => {
  const { raw, auth } = harness(undefined);

  const response = await signUp(auth, LOOPBACK_ORIGIN, 'owner@example.invalid');

  assert.equal(response.status, 200);
  const row = userRow(raw);
  assert.ok(row, 'sign-up answered 200 but wrote no auth_user row');
  // Read back through `raw` with `SELECT *`, never through the adapter: the
  // adapter would answer with its own field names whatever the columns are
  // called, so only the keys SQLite reports can tell `email_verified` from
  // `emailVerified`. These are asserted, not assumed.
  assert.deepEqual(Object.keys(row).toSorted(), [
    'created_at',
    'email',
    'email_verified',
    'id',
    'image',
    'name',
    'updated_at',
  ]);
  assert.equal(row.email, 'owner@example.invalid');
  // Stored as SQLite's 0, not as a JS `false` or an ISO string: the adapter
  // hands Better Auth's boolean and Date values to Drizzle, and the column
  // modes in `db/schema.ts` are what turn them into integers.
  assert.equal(row.email_verified, 0);
  assert.equal(typeof row.created_at, 'number');
});

test('a session cookie round-trips to the user who signed up', async () => {
  const { auth } = harness(undefined);

  const signedUp = await signUp(auth, LOOPBACK_ORIGIN, 'owner@example.invalid');
  assert.equal(signedUp.status, 200);

  const session = await auth.handler(new Request(`${BASE_URL}/api/auth/get-session`, {
    headers: { cookie: cookieHeader(signedUp) },
  }));

  assert.equal(session.status, 200);
  const body = await session.json() as { user?: { email?: unknown } } | null;
  assert.equal(body?.user?.email, 'owner@example.invalid');
});

test('the secret the caller passed is the one the cookie is signed with', async () => {
  // Two instances over one database, the way a restart is two instances over
  // one file. The same secret has to accept the other's cookie -- that is
  // what `db/host-state.ts` persists a secret *for* -- and a different one
  // has to refuse it, which is the half that would fail if this module let
  // Better Auth fall back to `BETTER_AUTH_SECRET` or to its own hard-coded
  // default string instead of using `deps.secret`.
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const first = createAuth({ raw, db, secret: SECRET, baseURL: BASE_URL, publicUrl: undefined, log: noop });
  const restarted = createAuth({ raw, db, secret: SECRET, baseURL: BASE_URL, publicUrl: undefined, log: noop });
  const stranger = createAuth({
    raw,
    db,
    secret: 'placeholder-a-different-signing-secret',
    baseURL: BASE_URL,
    publicUrl: undefined,
    log: noop,
  });

  const signedUp = await signUp(first, LOOPBACK_ORIGIN, 'owner@example.invalid');
  assert.equal(signedUp.status, 200);
  const cookie = cookieHeader(signedUp);

  const accepted = await restarted.handler(new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie } }));
  const refused = await stranger.handler(new Request(`${BASE_URL}/api/auth/get-session`, { headers: { cookie } }));

  assert.equal((await accepted.json() as { user?: { email?: unknown } } | null)?.user?.email, 'owner@example.invalid');
  // 200 with a body of `null`, not 401 -- the design spec's §2 measured that,
  // and task 5's guard has to test for the session rather than for a status
  // code because of it. Asserted here so it is pinned rather than assumed.
  assert.equal(refused.status, 200);
  // `assert.ok` with a message of its own, not `assert.equal(body, null)`:
  // the body of a session that was wrongly accepted *is* a live session
  // token, and `assert.equal` would print it into the test output on the one
  // run where this fails.
  assert.ok(
    await refused.json() === null,
    'a cookie signed with a different secret resolved to a session',
  );
});

test('a loopback origin is trusted and a public one is not', async () => {
  const { raw, auth } = harness(undefined);

  const loopback = await signUp(auth, LOOPBACK_ORIGIN, 'owner@example.invalid');
  assert.equal(loopback.status, 200);

  const { raw: otherRaw, auth: other } = harness(undefined);
  const evil = await signUp(other, 'https://evil.example', 'attacker@example.invalid');

  assert.equal(evil.status, 403);
  // Refused before the write, not after: an attacker's origin that still
  // created an account would be a refusal in name only.
  assert.equal(userRow(otherRaw), undefined);
  assert.ok(userRow(raw), 'the loopback sign-up should still have landed');
});

test('a private-range origin is trusted', async () => {
  // The LAN case the `0.0.0.0` bind exists for: a browser on the owner's
  // network reaching the host by its private address.
  const { auth } = harness(undefined);

  const response = await signUp(auth, 'http://192.168.1.9:8787', 'owner@example.invalid');

  assert.equal(response.status, 200);
});

test('a link-local origin is trusted', async () => {
  // 169.254/16: what a host with no DHCP lease gives itself, so a direct
  // cable between a laptop and this machine still reaches it.
  const { auth } = harness(undefined);

  const response = await signUp(auth, 'http://169.254.10.5:8787', 'owner@example.invalid');

  assert.equal(response.status, 200);
});

test('the private block ends at 172.31, so 172.32 is refused', async () => {
  // 172.16/12 is 172.16.0.0-172.31.255.255. Reading it as "172.16.*" or as
  // "all of 172.*" are the two ways to get this wrong, and the second one
  // trusts 1,048,576 public addresses.
  const first = harness(undefined);
  const last = harness(undefined);
  const outside = harness(undefined);

  const inFirst = await signUp(first.auth, 'http://172.16.0.1:8787', 'owner@example.invalid');
  const inLast = await signUp(last.auth, 'http://172.31.255.254:8787', 'owner@example.invalid');
  const beyond = await signUp(outside.auth, 'http://172.32.0.1:8787', 'attacker@example.invalid');

  assert.equal(inFirst.status, 200);
  assert.equal(inLast.status, 200);
  assert.equal(beyond.status, 403);
  assert.equal(userRow(outside.raw), undefined);
});

test('a bracketed IPv6 loopback is trusted and a public IPv6 is not', async () => {
  // `new URL('http://[::1]:8787').hostname` keeps the brackets, so an
  // IPv6 origin is not four dot-separated numbers and never can be.
  const loopback = harness(undefined);
  const unique = harness(undefined);
  const global = harness(undefined);

  const loopbackResponse = await signUp(loopback.auth, 'http://[::1]:8787', 'owner@example.invalid');
  const uniqueResponse = await signUp(unique.auth, 'http://[fd12:3456::1]:8787', 'owner@example.invalid');
  const globalResponse = await signUp(global.auth, 'http://[2606:4700::1111]:8787', 'attacker@example.invalid');

  assert.equal(loopbackResponse.status, 200);
  // fc00::/7, the IPv6 equivalent of 10/8: `fd` is in the block, and the
  // block is the top seven bits rather than the first byte.
  assert.equal(uniqueResponse.status, 200);
  assert.equal(globalResponse.status, 403);
  assert.equal(userRow(global.raw), undefined);
});

test('a hostname other than localhost is refused, however it resolves', async () => {
  // The DNS-rebinding case: `pickarr.local` may well resolve to a private
  // address on this network, and trusting it because of that would mean any
  // name an attacker controls and points at 127.0.0.1 is trusted too.
  const { raw, auth } = harness(undefined);

  const response = await signUp(auth, 'http://pickarr.local:8787', 'attacker@example.invalid');

  assert.equal(response.status, 403);
  assert.equal(userRow(raw), undefined);
});

test('a configured public url is trusted even though it is public', async () => {
  const { auth } = harness(PUBLIC_URL);

  const response = await signUp(auth, PUBLIC_URL, 'owner@example.invalid');

  assert.equal(response.status, 200);
});

test('an unset public url logs once, not per request', async () => {
  const { auth, lines } = harness(undefined);

  assert.equal(lines.length, 1);
  const [first] = lines;
  assert.ok(first !== undefined);
  assert.match(first, /PICKARR_PUBLIC_URL/);

  // Two requests, neither of which can succeed -- no account exists -- so
  // what is being counted is the log line and not the outcome.
  await signIn(auth, LOOPBACK_ORIGIN, 'nobody@example.invalid');
  await signIn(auth, LOOPBACK_ORIGIN, 'nobody@example.invalid');

  assert.equal(lines.length, 1);
});

test('a configured public url logs nothing', async () => {
  const { auth, lines } = harness(PUBLIC_URL);

  await signIn(auth, LOOPBACK_ORIGIN, 'nobody@example.invalid');

  assert.deepEqual(lines, []);
});
