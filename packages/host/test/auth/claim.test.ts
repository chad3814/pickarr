import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, openTestDatabase } from '../../src/db/open.ts';
import { migrateHost } from '../../src/db/migrate.ts';
import { CLAIM_TOKEN_KEY, readHostState } from '../../src/db/host-state.ts';
import { createAuth } from '../../src/auth/instance.ts';
import { ensureClaimToken, isClaimed, matchesClaimToken } from '../../src/auth/claim.ts';

/**
 * **No listener, on purpose**, for the reason `instance.test.ts` gives: the
 * instance's `handler(Request) => Promise<Response>` is the same function
 * `toNodeHandler` wraps, and a fixed `baseURL` with requests built against
 * it has none of the ordering problem a port-0 listener would introduce.
 *
 * **No test below prints the claim token.** It is a credential for as long
 * as it exists, and `node:assert`'s equality helpers format *both* operands
 * into a failure message -- so the two places a token is compared use
 * `assert.ok(a === b, '<message>')`, which formats nothing. Every other
 * assertion here is on a status code, a row count, or a refusal message.
 *
 * **One property here has no isolating mutation and is not pretended to
 * have one.** `matchesClaimToken` compares with `crypto.timingSafeEqual`
 * rather than `===`; both return the same answer to every input, so no
 * assertion in this file can tell them apart, and a test that timed the two
 * would be a flake rather than a proof. The property is pinned by the
 * comment on `matchesClaimToken` and by reading the code, which is stated
 * plainly instead of being covered by a test that does not really test it.
 */

/**
 * TEST-NET-1, as in `instance.test.ts`: neither loopback nor private, so
 * Better Auth's implicit trust of `baseURL`'s own origin cannot be what
 * lets any request below through.
 */
const BASE_URL = 'http://192.0.2.10:7676';

const LOOPBACK_ORIGIN = 'http://127.0.0.1:7676';

const PASSWORD = 'placeholder-not-a-real-password';
const SECRET = 'placeholder-not-a-real-signing-secret';

/**
 * Below Better Auth's default eight-character minimum, so a sign-up
 * carrying it is refused *after* the claim hook has already run. That
 * ordering was measured, not assumed, and it is what lets one test offer a
 * valid token on an attempt that then creates no user.
 */
const TOO_SHORT_PASSWORD = 'short';

/** A log that drops every line; nothing in this file asserts on one. */
const noop = (): void => {};

type Auth = ReturnType<typeof createAuth>;

interface Harness {
  raw: DatabaseSync;
  auth: Auth;
  /** The token this unclaimed install will accept, exactly once. */
  claimToken: string;
}

/** A migrated in-memory database, a claim token, and one instance over both. */
function harness(): Harness {
  const { raw, db } = openTestDatabase();
  migrateHost(raw);
  const claimToken = ensureClaimToken(raw, 1_000);
  const auth = createAuth({ raw, db, secret: SECRET, baseURL: BASE_URL, publicUrl: undefined, log: noop });
  return { raw, auth, claimToken };
}

/**
 * A sign-up attempt. `claimToken` of `null` offers no token *field at all*,
 * which is the shape a caller who has never heard of the claim sends.
 */
function signUp(auth: Auth, email: string, claimToken: string | null, password = PASSWORD): Promise<Response> {
  const credentials = { email, password, name: 'Placeholder Owner' };
  return auth.handler(new Request(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: LOOPBACK_ORIGIN },
    body: JSON.stringify(claimToken === null ? credentials : { ...credentials, claimToken }),
  }));
}

/**
 * The same token with its **last** character changed, so it is exactly as
 * long as the real one and differs from it.
 *
 * Same length on purpose: a comparison that only checked the length would
 * accept this, so it is what proves a comparison of the bytes happens at
 * all. The last character rather than the first because that is the
 * position a comparison reaches last, so a check that gave up early -- a
 * prefix test, say -- would also be caught here.
 */
function withLastCharacterChanged(token: string): string {
  const last = token.at(-1);
  if (last === undefined) throw new Error('the claim token is empty, so it cannot be altered');
  // The token is base64url, so both replacements are in its alphabet and
  // the result is a token-shaped string rather than an obvious reject.
  return token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
}

/** How many accounts exist. A test may count; `isClaimed` may not, and does not. */
function userCount(raw: DatabaseSync): number {
  const row = raw.prepare('SELECT count(*) AS total FROM auth_user').get();
  return Number((row as { total: unknown }).total);
}

/** A refusal's `message`, which carries no token and is safe to format into a failure. */
async function refusalMessage(response: Response): Promise<unknown> {
  const body = await response.json() as { message?: unknown } | null;
  return body?.message;
}

/** Whether a claim token is still on record. Answers a boolean so no caller can print the token. */
function tokenIsOnRecord(raw: DatabaseSync): boolean {
  return readHostState(raw, CLAIM_TOKEN_KEY) !== null;
}

test('the first sign-up succeeds with the claim token', async () => {
  const { raw, auth, claimToken } = harness();
  assert.equal(isClaimed(raw), false);

  const response = await signUp(auth, 'owner@example.invalid', claimToken);

  assert.equal(response.status, 200);
  assert.equal(userCount(raw), 1);
  assert.equal(isClaimed(raw), true);
  // Spent by the sign-up that used it, not left lying in `host_state` for
  // the next caller.
  assert.equal(tokenIsOnRecord(raw), false);
});

test('the first sign-up is refused without it', async () => {
  const { raw, auth } = harness();

  const response = await signUp(auth, 'attacker@example.invalid', null);

  assert.equal(response.status, 403);
  assert.equal(userCount(raw), 0);
  // The owner's token survives someone else's attempt to sign up without
  // one. A refusal that burned it would let anyone on the network lock the
  // owner out of their own install by sending one empty request.
  assert.equal(tokenIsOnRecord(raw), true);
});

test('the first sign-up is refused with a wrong token of the same length', async () => {
  // Same length on purpose: a length check alone would pass this.
  const { raw, auth, claimToken } = harness();

  const response = await signUp(auth, 'attacker@example.invalid', withLastCharacterChanged(claimToken));

  assert.equal(response.status, 403);
  assert.equal(userCount(raw), 0);
  assert.equal(tokenIsOnRecord(raw), true);
});

test('a wrong token of a different length is refused, not a 500', async () => {
  // `timingSafeEqual` throws on unequal lengths, so an unguarded call turns
  // this into an unhandled error: a 500, which both fails to refuse
  // politely and tells the caller their guess was the wrong length. The
  // offered value is the real token one character short -- a correct prefix
  // -- so nothing but the length guard can be what refuses it.
  const { raw, auth, claimToken } = harness();

  const response = await signUp(auth, 'attacker@example.invalid', claimToken.slice(0, -1));

  assert.equal(response.status, 403);
  assert.equal(userCount(raw), 0);
  assert.equal(tokenIsOnRecord(raw), true);
});

test('sign-up is refused once a user exists, without restarting', async () => {
  // The whole point of a hook over `disableSignUp`. One server, two
  // attempts, and no restart between them.
  const { raw, auth, claimToken } = harness();

  const claimedIt = await signUp(auth, 'owner@example.invalid', claimToken);
  assert.equal(claimedIt.status, 200);

  // A freshly minted, genuinely valid token, offered to the *same running
  // instance*. Without this the second attempt would be refused merely for
  // having no token left to offer -- which an implementation that read
  // `isClaimed` once at construction would also refuse, so the test would
  // pass against the very bug it exists to rule out. With a valid token in
  // hand, only a per-request `isClaimed` can be what refuses.
  const reminted = ensureClaimToken(raw, 2_000);
  const second = await signUp(auth, 'stranger@example.invalid', reminted);

  assert.equal(second.status, 403);
  assert.equal(userCount(raw), 1);
});

test('a rejected sign-up leaves the token usable', async () => {
  // The first attempt offers the right token but a password Better Auth
  // refuses outright, so no account is created and the install is still
  // unclaimed. Task 4 shipped a hook that spent the token the moment it
  // matched, regardless of what happened next -- so this exact rejection
  // used to burn the owner's only token, and the install was then claimable
  // only after a restart, which mints and prints a fresh one. The token is
  // verified in `before` and spent in `databaseHooks.user.create.before`,
  // which the request never reaches when validation refuses it first.
  const { raw, auth, claimToken } = harness();

  const rejected = await signUp(auth, 'owner@example.invalid', claimToken, TOO_SHORT_PASSWORD);
  assert.equal(rejected.status, 400);
  assert.equal(userCount(raw), 0);
  assert.equal(isClaimed(raw), false);
  // The token is still on record: Better Auth's own validation refused this
  // request before anything was about to create a user, so the hook that
  // spends the token never ran.
  assert.equal(tokenIsOnRecord(raw), true);

  const retried = await signUp(auth, 'owner@example.invalid', claimToken);

  assert.equal(retried.status, 200);
  assert.equal(userCount(raw), 1);
  assert.equal(isClaimed(raw), true);
  assert.equal(tokenIsOnRecord(raw), false);
});

test('a sign-up refused by the hook itself does not clear the token', async () => {
  // A wrong token never matches, so the request hook throws before Better
  // Auth's own validation ever runs and the real token is never touched by
  // this attempt at all. Distinct from the test above: that one shows a
  // rejection *downstream* of a match leaves the token alone; this one shows
  // a rejection *at* the hook -- for a token that never matched in the first
  // place -- does too.
  const { raw, auth, claimToken } = harness();

  const refused = await signUp(auth, 'attacker@example.invalid', withLastCharacterChanged(claimToken));
  assert.equal(refused.status, 403);
  assert.equal(userCount(raw), 0);
  assert.equal(tokenIsOnRecord(raw), true);

  const claimedIt = await signUp(auth, 'owner@example.invalid', claimToken);

  assert.equal(claimedIt.status, 200);
  assert.equal(userCount(raw), 1);
  assert.equal(isClaimed(raw), true);
  assert.equal(tokenIsOnRecord(raw), false);
});

test('two concurrent sign-ups with one token create one account', async () => {
  // Both requests carry the *same valid token* and land on one running
  // instance, which is what a double-submitted form is. The check that used to
  // admit a sign-up -- `isClaimed` in the `before` hook -- is a read, and two
  // reads both see an unclaimed install before either handler writes, so this
  // used to answer 200/200 and leave two accounts on an install whose whole
  // design is one. What admits a sign-up now is the *consumption* of the
  // token, which is a single conditional delete only one caller can win.
  const { raw, auth, claimToken } = harness();

  const [first, second] = await Promise.all([
    signUp(auth, 'owner@example.invalid', claimToken),
    signUp(auth, 'stranger@example.invalid', claimToken),
  ]);

  assert.deepEqual(
    [first.status, second.status].toSorted((a, b) => a - b),
    [200, 403],
    'exactly one of two concurrent sign-ups with one token may succeed',
  );
  assert.equal(userCount(raw), 1);
  assert.equal(isClaimed(raw), true);
  assert.equal(tokenIsOnRecord(raw), false);

  // The loser is refused in the same words as every other refusal, so losing
  // a race tells a caller no more than offering a wrong token does.
  const loser = first.status === 200 ? second : first;
  const unclaimed = harness();
  const wrongToken = await signUp(
    unclaimed.auth,
    'attacker@example.invalid',
    withLastCharacterChanged(unclaimed.claimToken),
  );
  assert.deepEqual(await refusalMessage(loser), await refusalMessage(wrongToken));
});

test('an unclaimed install re-offers the same token across two boots', async () => {
  // Two connections to one file, which is what a restart is.
  const dir = await mkdtemp(join(tmpdir(), 'pickarr-claim-'));
  try {
    const path = join(dir, 'pickarr.db');

    const first = openDatabase(path);
    migrateHost(first.raw);
    const booted = ensureClaimToken(first.raw, 1_000);
    first.raw.close();

    const second = openDatabase(path);
    const rebooted = ensureClaimToken(second.raw, 2_000);
    second.raw.close();

    assert.ok(booted.length > 0, 'the first boot generated no claim token');
    // `assert.ok` with a message rather than `assert.equal`: both operands
    // are live claim tokens and `assert.equal` would format them into the
    // failure output on the one run where this breaks.
    assert.ok(rebooted === booted, 'the second boot offered a different claim token than the first');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a claimed install and a wrong token are refused in the same words', async () => {
  // Two different messages would be an enumeration oracle: an attacker who
  // sends a garbage token and is told the token is wrong has learned the
  // install is still unclaimed, and therefore still worth attacking. They
  // learn it without guessing anything.
  const claimed = harness();
  const claimedIt = await signUp(claimed.auth, 'owner@example.invalid', claimed.claimToken);
  assert.equal(claimedIt.status, 200);
  const refusedAsClaimed = await signUp(claimed.auth, 'attacker@example.invalid', null);

  const unclaimed = harness();
  const refusedAsWrongToken = await signUp(
    unclaimed.auth,
    'attacker@example.invalid',
    withLastCharacterChanged(unclaimed.claimToken),
  );

  assert.equal(refusedAsClaimed.status, refusedAsWrongToken.status);
  // The messages carry no token, so formatting them into a failure is safe.
  assert.deepEqual(await refusalMessage(refusedAsClaimed), await refusalMessage(refusedAsWrongToken));
});

test('matchesClaimToken answers false rather than throwing when no token is on record', () => {
  // The state every claimed install is in. `readHostState` returns `null`
  // here, and a version that handed that straight to `Buffer.from` would
  // throw instead of refusing -- a 500 on the hook's path, for the most
  // ordinary request an install ever sees.
  const { raw } = openTestDatabase();
  migrateHost(raw);

  assert.equal(matchesClaimToken(raw, 'placeholder-offered-token'), false);
});

test('the owner can still sign in once the install is claimed', async () => {
  // The hook runs on *every* route and refuses only sign-up. A version that
  // forgot to narrow by path would lock the owner out of the install they
  // had just claimed, permanently: there is no second account to fall back
  // to and no reset path in this slice.
  const { auth, claimToken } = harness();
  const claimedIt = await signUp(auth, 'owner@example.invalid', claimToken);
  assert.equal(claimedIt.status, 200);

  const signedIn = await auth.handler(new Request(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: LOOPBACK_ORIGIN },
    body: JSON.stringify({ email: 'owner@example.invalid', password: PASSWORD }),
  }));

  assert.equal(signedIn.status, 200);
  // Only the email is read off the body. It also carries a live session
  // token, which no assertion here goes anywhere near.
  const body = await signedIn.json() as { user?: { email?: unknown } } | null;
  assert.equal(body?.user?.email, 'owner@example.invalid');
});
