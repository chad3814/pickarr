/**
 * Version 2, one table: what a film has beyond the shared `media_item` row.
 * Version 3 is the placement table `placementTableMigration` generates,
 * recording which entries of a download this plugin has already put in its
 * library. Version 4 is `videoResolutionBackfillMigration` (issue #98),
 * marking every release this plugin already resolved and queuing one job to
 * backfill the resolution it was identified without.
 *
 * Version 2, because version 1 is the engine's state table. The four columns
 * are the four keys the OpenAPI document specifies for `kind: 'movie'`;
 * `details_json` is everything it sends that those four do not name. The
 * literal `'movie'` is repeated here rather than imported from `index.ts`,
 * which imports this file.
 */
import type { Migration } from '@pickarr/contract';
import { placementTableMigration, videoResolutionBackfillMigration } from '@pickarr/openmetadata';

export const MOVIE_MIGRATIONS: readonly Migration[] = [{
  version: 2,
  up: (db) => db.exec(`
CREATE TABLE movie_detail (
  id              INTEGER PRIMARY KEY,
  media_item_id   INTEGER NOT NULL REFERENCES media_item (id),
  runtime_minutes INTEGER,
  imdb_id         TEXT,
  tagline         TEXT,
  collection_name TEXT,
  details_json    TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX movie_detail_media_item ON movie_detail (media_item_id);
`),
}, placementTableMigration('movie', 3), videoResolutionBackfillMigration('movie', 4)];
