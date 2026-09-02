import type { DatabaseSync } from 'node:sqlite';

/**
 * One schema change. The same shape 1.x uses, so a plugin author reading
 * either codebase sees one idea.
 *
 * `version` is per plugin, not global: two plugins may both have a version 1,
 * and the host tracks them separately (see `plugin_migrations`).
 */
export interface Migration {
  version: number;
  up(db: DatabaseSync): void;
}
