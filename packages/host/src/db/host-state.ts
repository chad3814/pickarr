import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * One row per fact, `host_state (key, value, created_at, updated_at)` --
 * created by migration 12. This module is the only one besides Better
 * Auth's own adapter permitted to name `host_state.value` in a SQL string
 * (`scripts/check-test-hygiene.ts`'s Rule 2 enforces that at build time),
 * because the two facts it currently holds -- the generated signing secret
 * and the first-boot claim token -- are both credentials.
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
 * The Better Auth signing secret, generating and persisting one on first
 * call. Stable across calls and across processes: Better Auth signs every
 * session cookie with this value, so a secret that changed on restart --
 * or that two racing callers disagreed on -- would invalidate sessions
 * with nothing in any log to explain why.
 */
export function ensureAuthSecret(raw: DatabaseSync, at: number): string {
  return ensureGeneratedValue(raw, AUTH_SECRET_KEY, at);
}
