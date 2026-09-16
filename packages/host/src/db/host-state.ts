import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * One row per fact, `host_state (key, value, created_at, updated_at)` --
 * created by migration 12. This module is the only one besides Better
 * Auth's own adapter permitted to name `host_state.value` in a SQL string
 * (`scripts/check-test-hygiene.ts`'s Rule 2 enforces that at build time),
 * because two of the facts it holds -- the generated signing secret and the
 * first-boot claim token -- are credentials.
 *
 * **Not every fact here is one.** `sync/log.ts` records one
 * `sync.seeded.<table>` key per synced table, holding the timestamp its log
 * seed ran at, which is neither secret nor read by anything; and
 * `SYNC_GENERATION_KEY` below holds a value that is deliberately *published*,
 * on all three sync responses. The rule is about the *column*, not about the
 * row: a caller cannot name `value` in SQL of its own whatever it stores
 * there, so it goes through the readers and writers below and this module
 * stays the one place that statement is written.
 *
 * **Nothing here may log a value.** `value` can hold the Better Auth
 * signing secret; a log line naming it would put that secret in the
 * journal, so no function below takes a logger.
 */

/** Key under which the generated Better Auth signing secret is stored. */
export const AUTH_SECRET_KEY = 'auth.secret';

/** Key under which the first-boot claim token is stored. */
export const CLAIM_TOKEN_KEY = 'auth.claimToken';

/**
 * Key under which this database's sync generation is stored.
 *
 * **This value is deliberately public, and it is the only one of the three
 * keys this module declares that is.** It goes out on the body of
 * `GET /api/sync`, `/api/sync/backfill` and `/api/sync/bootstrap` -- guarded
 * routes, but a client reads it, stores it and keeps it. The other two are
 * credentials
 * (`AUTH_SECRET_KEY` is what Better Auth signs cookies with,
 * `CLAIM_TOKEN_KEY` is a one-shot ownership grant), and the module doc above
 * explains why `host_state.value` is a credential column and why this is the
 * one module allowed to name it. So: nothing about *this* key generalises to
 * those, and a later change that exposes them "for consistency" has this
 * comment to read first. What makes the difference is what the value is for,
 * not where it is stored -- an opaque random token that says which database
 * you are talking to tells a session holder nothing it could not learn by
 * syncing, whereas either of the others is an escalation.
 *
 * It is **not** on `/api/health`, which is the one open route: an install
 * fingerprint reachable without a session lets a scanner tell two hosts
 * apart, and fingerprint a rebuild, for free.
 */
export const SYNC_GENERATION_KEY = 'sync.generation';

/**
 * `randomBytes` reads this many bytes; base64url of 32 bytes is 43
 * characters, well past Better Auth's own 32-character minimum for the
 * signing secret. The claim token is generated the same way and at the same
 * size: it is typed once, by the owner, off the console it was printed to,
 * so there is nothing to be gained by making it shorter to type and 256
 * bits to be lost.
 */
const SECRET_BYTES = 32;

/**
 * The value stored under `key`, or `null` for an absent key -- a valid
 * state this function returns rather than throws, since callers (this
 * module's own `ensureAuthSecret` included) need to tell "never set" apart
 * from an actual empty string.
 */
export function readHostState(raw: DatabaseSync, key: string): string | null {
  const row = raw.prepare('SELECT value FROM host_state WHERE key = ?').get(key);
  if (!row) return null;
  return String((row as { value: unknown }).value);
}

/**
 * Upserts `key` to `value`, moving `updated_at` to `at` whether the row is
 * new or already existed. `created_at` is set only on insert -- the
 * `ON CONFLICT` branch never touches it, so a value that already had a row
 * keeps its original creation time across every later write.
 */
export function writeHostState(raw: DatabaseSync, key: string, value: string, at: number): void {
  raw.prepare(`
    INSERT INTO host_state (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, at, at);
}

/** Removes `key` entirely. A no-op, not an error, when it was already absent. */
export function clearHostState(raw: DatabaseSync, key: string): void {
  raw.prepare('DELETE FROM host_state WHERE key = ?').run(key);
}

/**
 * Removes `key`, but only while it still holds `value`, and answers whether
 * **this** call was the one that removed it.
 *
 * **One statement, so exactly one of two racing callers can win it.** SQLite
 * reports `changes` for the statement it just ran, and `node:sqlite` is
 * synchronous, so two callers in one process cannot interleave *inside* the
 * `DELETE`: whichever runs it first matches the row, removes it and sees a
 * change; the second matches nothing and sees none. A read followed by a
 * write cannot answer this question at all -- both callers can pass the read
 * before either has written -- which is the whole reason this exists rather
 * than a `readHostState` and a `clearHostState` next to each other. It is the
 * same compare-and-set shape as `clients/rows.ts`'s
 * `UPDATE ... WHERE id = ? AND status = ?`, for the same reason.
 *
 * The value is compared **in SQL**, because that is what makes matching it
 * and removing it one step rather than two. That comparison is not
 * constant-time and does not need to be: its one caller
 * (`auth/claim.ts`'s `spendClaimToken`) is reached only by a request whose
 * token has already been compared with `timingSafeEqual`, so a wrong value
 * never gets this far. See `matchesClaimToken`.
 */
export function clearHostStateValue(raw: DatabaseSync, key: string, value: string): boolean {
  const result = raw.prepare('DELETE FROM host_state WHERE key = ? AND value = ?').run(key, value);
  return result.changes > 0;
}

/**
 * A random value under `key`, generating and persisting one on first call
 * and handing back whatever is already on record on every call after.
 *
 * **Generates exactly once, even under a race**, and the shape of this
 * function is why: it always generates a candidate, always attempts the
 * same `INSERT ... ON CONFLICT (key) DO NOTHING`, and always returns
 * whatever `readHostState` finds afterward -- never the candidate it just
 * generated. Two processes racing this on the same file both attempt the
 * insert; the `PRIMARY KEY` on `key` is what lets only one of the two
 * competing inserts actually land; and the read-back after is what hands
 * the *loser* the winner's stored value instead of the candidate it
 * generated and failed to persist. A version that generated, checked
 * `readHostState() === null`, and only then wrote would look identical for
 * a single caller but not close that window: two processes can each pass
 * the `=== null` check before either has written.
 *
 * **This lives here rather than beside either caller** because the
 * `INSERT` names `host_state.value`, and `scripts/check-test-hygiene.ts`
 * allows that column to be named only by this module and by Better Auth's
 * own adapter. Widening the allow-list so `auth/claim.ts` could issue its
 * own copy of this statement would spend the rule to save a delegation.
 *
 * The key is a parameter rather than two near-identical functions because
 * the two facts stored this way -- the signing secret and the claim token
 * -- want exactly the same race behaviour and exactly the same generator.
 * What differs between them is only what the value *means*, which is what
 * `ensureAuthSecret` below and `auth/claim.ts` each document.
 */
export function ensureGeneratedValue(raw: DatabaseSync, key: string, at: number): string {
  const candidate = randomBytes(SECRET_BYTES).toString('base64url');
  raw.prepare(`
    INSERT INTO host_state (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO NOTHING
  `).run(key, candidate, at, at);
  const stored = readHostState(raw, key);
  if (stored === null) {
    throw new Error(`ensureGeneratedValue: nothing on record under ${key} immediately after inserting it`);
  }
  return stored;
}

/**
 * This database's sync generation, generating and persisting one on first
 * call -- which is the whole mechanism, and the reason there is no migration
 * behind it.
 *
 * **What it answers.** 2.0 starts on an empty database and rebuilds from
 * feeds, so deleting `pickarr.db` is a routine operation. Nothing else on the
 * sync wire says which database a client is talking to, and the failure is
 * silent in both directions: a client holding `since = 5000` against a
 * rebuilt log whose max id is 80 asks for ops above 5000, receives nothing
 * for as long as that install exists, and shows the old library with no
 * error; at a lower cursor it is worse, because new rows arrive at ids that
 * collide with the stale replica's keys and two libraries merge into one. A
 * client compares this value against the one it stored and discards its
 * replica when they differ.
 *
 * **Lazily minted rather than written by a migration**, and that is what
 * makes it correct rather than merely cheap. A rebuilt database has no
 * `host_state` row under this key, so the first call after the rebuild mints
 * a fresh value by construction -- which is exactly the signal wanted. A
 * migration would have to choose a value at migration time and would then
 * need a second mechanism to notice a rebuild; `ensureGeneratedValue` already
 * is that mechanism, for the same reason it serves the signing secret.
 *
 * Stable across restarts of the same file, because a restart is not a rebuild
 * and a host that re-minted on every boot would order every client to resync
 * on every boot.
 *
 * **Public, unlike its two siblings.** See `SYNC_GENERATION_KEY`.
 */
export function ensureSyncGeneration(raw: DatabaseSync, at: number): string {
  return ensureGeneratedValue(raw, SYNC_GENERATION_KEY, at);
}

/**
 * The Better Auth signing secret, generating and persisting one on first
 * call. Stable across calls and across processes: Better Auth signs every
 * session cookie with this value, so a secret that changed on restart --
 * or that two racing callers disagreed on -- would invalidate sessions
 * with nothing in any log to explain why.
 */
export function ensureAuthSecret(raw: DatabaseSync, at: number): string {
  return ensureGeneratedValue(raw, AUTH_SECRET_KEY, at);
}
