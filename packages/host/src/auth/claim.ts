import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { DatabaseSync } from 'node:sqlite';
import { CLAIM_TOKEN_KEY, clearHostState, ensureGeneratedValue, readHostState } from '../db/host-state.ts';

/**
 * Who is allowed to create the one account this host has.
 *
 * The bind default is `0.0.0.0`, so between first boot and the owner
 * signing up, "the first user claims the install" would mean *anyone on the
 * network* can claim it. A token generated on first boot and printed to the
 * console the owner just started the process in closes that window with no
 * configuration step: the first sign-up must carry the token, and the token
 * is spent the moment it matches.
 *
 * **Nothing here logs, and nothing here takes a logger.** The token is a
 * credential for as long as it exists; the one place it is ever printed is
 * the host's boot log, deliberately and in one place.
 *
 * **Nothing here may reach for `host.ts` or `src/api`.** Same rule as
 * `instance.ts`, which imports this module: an import back would be a cycle.
 */

/**
 * Whether this install already has an account, which is the whole of
 * "claimed".
 *
 * `SELECT 1 ... LIMIT 1`, never `COUNT(*)`: the question is whether *a* row
 * exists, and `COUNT(*)` answers it by reading every row in the table. The
 * difference is nothing on a table with one row in it -- and this table is
 * meant to hold exactly one -- but the query runs on every sign-up attempt,
 * including every attempt by someone who should not be making one.
 */
export function isClaimed(raw: DatabaseSync): boolean {
  return raw.prepare('SELECT 1 FROM auth_user LIMIT 1').get() !== undefined;
}

/**
 * The claim token, generating and persisting one on first call and
 * re-offering that same one on every call after -- for as long as the row
 * survives, which is until `consumeClaimToken` spends it.
 *
 * The generate-once-under-a-race shape is `ensureGeneratedValue`'s and the
 * reason is written there: two hosts started against one database file must
 * offer one token, not two, or the token printed to the console is not the
 * token that works.
 *
 * **This says nothing about whether the install is already claimed**, which
 * is why it can return `string` rather than `string | null`. A token minted
 * on a claimed install opens nothing -- the sign-up hook asks `isClaimed`
 * first and refuses whatever token is offered -- so the callers that care
 * ask `isClaimed` themselves: the hook, to refuse, and the boot log, to
 * print a token only while there is still something to claim.
 */
export function ensureClaimToken(raw: DatabaseSync, at: number): string {
  return ensureGeneratedValue(raw, CLAIM_TOKEN_KEY, at);
}

/**
 * Whether `offered` is the claim token on record, spending it if it is.
 *
 * **Compared with `timingSafeEqual`, not `===`.** A byte-at-a-time
 * comparison that stops at the first difference takes measurably longer the
 * more of the token a caller already has right, which turns guessing a
 * 43-character secret from one unreachable problem into 43 reachable ones.
 * Nothing observable distinguishes the two here -- both answer the same
 * question with the same value -- so there is no test below that can fail
 * if this line is changed, and that is stated in the test file rather than
 * papered over with a timing assertion, which would be a flake.
 *
 * **The length is compared first, and that guard is load-bearing.**
 * `timingSafeEqual` *throws* on buffers of different byte length, so an
 * unguarded call turns a wrong-length token into an unhandled error: a 500
 * rather than a refusal, and a 500 whose mere shape tells the caller their
 * guess was the wrong length -- which is the one thing about the token a
 * refusal must not reveal. Comparing lengths in `!==` leaks the length too,
 * but the length is not the secret and it cannot be hidden: the correct
 * token always compares in constant time, and only a wrong-length one takes
 * the early exit.
 *
 * **Spent on a match, before the caller knows whether the sign-up that
 * offered it went on to succeed.** That is deliberate: a token still valid
 * after a failed attempt is a token that can be retried, and the window
 * this exists to close is measured in the number of attempts an attacker
 * gets. The cost is that an owner whose first sign-up is rejected for some
 * later reason -- a password Better Auth thinks too short, an origin it
 * does not trust -- has burned the token and must restart the host to be
 * given a new one.
 */
export function consumeClaimToken(raw: DatabaseSync, offered: string): boolean {
  const stored = readHostState(raw, CLAIM_TOKEN_KEY);
  if (stored === null) return false;

  const offeredBytes = Buffer.from(offered, 'utf8');
  const storedBytes = Buffer.from(stored, 'utf8');
  if (offeredBytes.length !== storedBytes.length) return false;
  if (!timingSafeEqual(offeredBytes, storedBytes)) return false;

  clearHostState(raw, CLAIM_TOKEN_KEY);
  return true;
}
