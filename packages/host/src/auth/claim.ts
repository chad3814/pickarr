import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { DatabaseSync } from 'node:sqlite';
import { CLAIM_TOKEN_KEY, clearHostStateValue, ensureGeneratedValue, readHostState } from '../db/host-state.ts';

/**
 * Who is allowed to create the one account this host has.
 *
 * The bind default is `0.0.0.0`, so between first boot and the owner
 * signing up, "the first user claims the install" would mean *anyone on the
 * network* can claim it. A token generated on first boot and printed to the
 * console the owner just started the process in closes that window with no
 * configuration step: the first sign-up must carry the token, and **spending
 * the token is what admits the account** -- matching it is a separate,
 * side-effect-free question asked first, and spending it is the single
 * atomic step that only one caller can win; see `matchesClaimToken` and
 * `spendClaimToken`.
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
 * survives, which is until `spendClaimToken` spends it.
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
 * Whether `offered` is the claim token on record. **Never spends it** --
 * matching is a question, not an action, and answering it has no
 * side-effect on `host_state` at all. Spending the token is
 * `spendClaimToken`'s job, and it happens later, at the point the account
 * is about to be created.
 *
 * **Two callers ahead of one another can both be told `true`**, and that is
 * not a defect here: this answers a question about a moment, and nothing
 * about the answer admits anybody. What decides which of two holders of the
 * same token gets the account is `spendClaimToken`, one statement, one
 * winner. This exists ahead of it so a *wrong* token is refused early, in
 * constant time, with the same words every other refusal uses -- and so the
 * SQL comparison behind `spendClaimToken` is never reached by a guess.
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
 */
export function matchesClaimToken(raw: DatabaseSync, offered: string): boolean {
  const stored = readHostState(raw, CLAIM_TOKEN_KEY);
  if (stored === null) return false;

  const offeredBytes = Buffer.from(offered, 'utf8');
  const storedBytes = Buffer.from(stored, 'utf8');
  if (offeredBytes.length !== storedBytes.length) return false;
  return timingSafeEqual(offeredBytes, storedBytes);
}

/**
 * Spends the claim token if `offered` is still the one on record, and
 * answers whether this call was the one that spent it.
 *
 * **This is what admits a sign-up.** Not `isClaimed`, and not
 * `matchesClaimToken`: both of those are reads, and two requests carrying
 * the same valid token both pass a read before either has written anything
 * -- measured, and it gave 200/200 and two accounts on an install whose §3
 * says one account claims it. `clearHostStateValue` is a single conditional
 * `DELETE`, so of two callers offering the same token exactly one sees a
 * change and the other sees none, and the one that sees none is refused.
 *
 * **Called at the point the account is about to be created**, from
 * `instance.ts`'s `databaseHooks.user.create.before`, and that placement is
 * the other half of the requirement. Spending it in the request's `before`
 * hook is what task 4 shipped and task 4b undid: that hook runs ahead of
 * Better Auth's own password-length and origin checks (measured against
 * 1.7.3), so a correct token with a mistyped password burnt the install's
 * only token and cost a restart to get another. Here there is nothing left
 * that can refuse the request: every validation has already passed, and the
 * next thing that happens is the `INSERT`. So spending the token and
 * creating the account are as close to one event as this library allows,
 * and a refused or failed sign-up never reaches this line at all.
 *
 * What remains, stated rather than hidden: if the `INSERT` itself fails
 * after this returns `true`, the token is spent and no account exists. The
 * install is then claimable again only after a restart, which mints and
 * prints a fresh token (`main.ts` re-offers on every boot while unclaimed).
 * Closing that would mean holding a transaction across a hook boundary the
 * library does not offer.
 */
export function spendClaimToken(raw: DatabaseSync, offered: string): boolean {
  return clearHostStateValue(raw, CLAIM_TOKEN_KEY, offered);
}
