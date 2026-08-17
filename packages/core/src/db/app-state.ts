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
