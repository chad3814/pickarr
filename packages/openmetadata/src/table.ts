/**
 * The state table every plugin built on this engine owns, generated from its
 * prefix.
 *
 * Generated rather than written three times because `migratePlugin` rejects a
 * table without the plugin's own prefix, so the three cannot share one table --
 * and three hand-written copies of one DDL are three chances for them to drift
 * apart. One generator, one shape, by construction.
 */
import type { Migration } from '@pickarr/contract';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export function lookupTableName(pluginId: string): string {
  return `${pluginId}_lookup`;
}

/**
 * The Drizzle handle the engine writes through.
 *
 * No `.references()` anywhere: the foreign keys in the migration below point
 * at the *host's* tables, whose Drizzle objects a plugin has no business
 * importing.
 */
export function lookupTable(pluginId: string) {
  return sqliteTable(lookupTableName(pluginId), {
    id: integer('id').primaryKey(),
    rssItemId: integer('rss_item_id').notNull(),
    /** Null until a lookup resolves: nothing identifies the item before then. */
    mediaItemId: integer('media_item_id'),
    /** The job that will identify it -- the id `JobQueue.enqueue` returned. */
    lookupJobId: integer('lookup_job_id'),
    /** The service's own id for the lookup: what a poll asks about. */
    lookupId: text('lookup_id'),
    /** `provider:ref`, copied here once a claim settles. */
    providerRef: text('provider_ref'),
    /** The service's own score, recorded so a threshold can be measured rather than invented. */
    confidence: real('confidence'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  });
}

/**
 * Every plugin's migration 1.
 *
 * Keyed per rss item, not per media item: the dedup points two rss items at
 * one media item, and a per-media-item key would make the loser's row collide
 * with the winner's.
 */
export function lookupTableMigration(pluginId: string): Migration {
  const table = lookupTableName(pluginId);
  return {
    version: 1,
    up: (db) => db.exec(`
CREATE TABLE ${table} (
  id            INTEGER PRIMARY KEY,
  rss_item_id   INTEGER NOT NULL REFERENCES rss_item (id),
  media_item_id INTEGER REFERENCES media_item (id),
  lookup_job_id INTEGER,
  lookup_id     TEXT,
  provider_ref  TEXT,
  confidence    REAL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX ${table}_rss_item ON ${table} (rss_item_id);
`),
  };
}
