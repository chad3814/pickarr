/**
 * One table: what a film has beyond the shared `media_item` row.
 *
 * Version 2, because version 1 is the engine's state table. The four columns
 * are the four keys the OpenAPI document specifies for `kind: 'movie'`;
 * `details_json` is everything it sends that those four do not name.
 */
import type { Migration } from '@pickarr/contract';

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
}];
