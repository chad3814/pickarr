import type { DatabaseSync } from 'node:sqlite';
import { assertSecretName } from './names.ts';

/**
 * The `secret` table's two operations, and the only place in
 * `packages/host/src` that names `secret.value` in SQL.
 *
 * That exclusivity is enforced at build time: this file's path is the reason
 * it is on `CREDENTIAL_ALLOW_LIST` in `scripts/check-test-hygiene.ts`. A
 * second reader is a build failure, not a review note.
 *
 * Synchronous because `node:sqlite` is -- the repo's documented exception to
 * preferring an async API. Nothing here awaits, so nothing is gained by
 * wrapping it in a promise.
 *
 * Both functions validate the name. `readSecretValue` does not build a path,
 * so traversal is not its risk; it validates anyway so that an illegal name
 * fails the same way wherever it enters, rather than silently reading null
 * here and throwing three links later.
 */
export function readSecretValue(raw: DatabaseSync, name: string): string | null {
  assertSecretName(name);
  const row = raw.prepare('SELECT value FROM secret WHERE name = ?').get(name);
  if (!row) return null;
  return String((row as { value: unknown }).value);
}

/** Inserts, or updates the value and `updated_at` of an existing row. */
export function writeSecretValue(raw: DatabaseSync, name: string, value: string, at: number): void {
  assertSecretName(name);
  raw.prepare(`
    INSERT INTO secret (name, value, created_at, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(name, value, at, at);
}
