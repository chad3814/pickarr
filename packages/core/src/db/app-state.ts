import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export function getAppState(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  if (row === undefined) return null;
  return String((row as { value: unknown }).value);
}

export function setAppState(db: DatabaseSync, key: string, value: string, now: number): void {
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

/**
 * The `app_state` key holding this installation's label salt.
 *
 * **Write-once.** Nothing may `setAppState` this key after
 * `installLabelToken` has minted it, and nothing but `installLabelToken` may
 * write it at all. The value decides which client-side jobs are ours; the
 * `updated_at` behind it decides which downloads are old enough to still be
 * recognised by their unsalted pre-#28 label (`labelsFor` in
 * `db/downloads.ts`). Overwriting either would re-open #28 silently: a new
 * salt orphans every job already at the client, and a later `mintedAt` makes
 * every existing row legacy-eligible again, which is the collision the salt
 * exists to close.
 */
export const INSTALL_LABEL_TOKEN_KEY = 'install:label-token';

export interface InstallLabelToken {
  /** The salt folded into every label this installation mints. */
  readonly token: string;
  /**
   * When the token was first minted. Rows created before this predate the
   * salt and may still be recognised by their unsalted label; rows created
   * after it cannot, because they were submitted under a salted one.
   */
  readonly mintedAt: number;
}

/**
 * This installation's label salt, minted on first use and never changed.
 *
 * A `downloadLabel` used to be `pickarr-<id>` and nothing else, so its whole
 * namespace was one database's `downloads` rowid sequence. Two installations
 * sharing a SABnzbd category — or one installation whose database was deleted
 * and recreated — walk that sequence in lockstep from 1 and each recognise
 * the other's jobs as their own: adopting the ref, importing the other's
 * files, and asking the client to delete the other's job at cleanup (#28).
 * The salt is what gives the namespace a per-installation prefix, so a label
 * one installation minted can never be read as another's.
 *
 * Eight hex characters out of a v4 UUID, not the whole UUID: this is folded
 * into a job name the operator reads in SABnzbd's own queue, and 32 bits of
 * randomness is already far more than enough to separate the handful of
 * installations that can plausibly share one server. `randomUUID` rather than
 * anything hand-rolled because it is already this codebase's randomness
 * source (see `media/artwork.ts`).
 *
 * Minted lazily, from the caller's clock, rather than at `openDatabase`:
 * every call site is already a write path with a `now` in hand
 * (`pickRelease`, `reconcileClient`), and `openDatabase` has no clock and
 * should not grow one for this.
 */
export function installLabelToken(db: DatabaseSync, now: number): InstallLabelToken {
  const row = db
    .prepare('SELECT value, updated_at FROM app_state WHERE key = ?')
    .get(INSTALL_LABEL_TOKEN_KEY);
  if (row !== undefined) {
    const existing = row as { value: unknown; updated_at: unknown };
    return { token: String(existing.value), mintedAt: Number(existing.updated_at) };
  }

  const token = randomUUID().replaceAll('-', '').slice(0, 8);
  setAppState(db, INSTALL_LABEL_TOKEN_KEY, token, now);
  return { token, mintedAt: now };
}
